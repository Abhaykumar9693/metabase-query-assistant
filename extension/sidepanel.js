import { validateSql, suggestFix } from "./validator.js";
import {
  generateFromConversation,
  listProviderModels,
  buildSystemPrompt,
  PROVIDERS,
} from "./providers.js";

const METABASE_HOST = "metabase.flobiz.in";
const CONVO_SESSION_KEY = "mbbqa:conversation";
// Messages per turn = user ask + assistant SQL. Cap history to keep prompts small.
const MAX_TURNS = 12;
// Automatic retry when validator rejects — gives the model one more chance.
const AUTO_VALIDATOR_RETRY = true;

const state = {
  schema: null,
  dbKey: null,
  dbDisplay: null,
  dbKeyForSystemPrompt: null, // tracks which DB the conversation was opened against
  conversation: [], // [{ role: 'user' | 'assistant', content: string, sql?: string, validation?: obj, timestamp: number }]
};

// --- schema load + settings ------------------------------------------------

async function loadSchema() {
  const res = await fetch(chrome.runtime.getURL("schema.json"));
  state.schema = await res.json();
  const meta = document.getElementById("schemaMeta");
  const fb = Object.keys(state.schema.databases.flobooks.tables).length;
  const pp = Object.keys(state.schema.databases.phonepe.tables).length;
  meta.textContent = `schema ${state.schema.source_sha256} · ${fb} + ${pp} tables`;
}

function defaultSettings() {
  const models = {};
  const apiKeys = {};
  const modelLists = {};
  for (const [id, p] of Object.entries(PROVIDERS)) {
    models[id] = { default: p.defaultModel, fast: p.defaultFast };
    apiKeys[id] = "";
    modelLists[id] = null; // filled by "Load available models"
  }
  return {
    provider: "gemini",
    apiKeys,
    models,
    modelLists,
    customBaseUrl: "",
    extraFlobooksDbs: "",
  };
}

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (items) => {
      const fresh = defaultSettings();
      if (items.apiKey && !items.apiKeys) {
        fresh.apiKeys.gemini = items.apiKey;
      }
      resolve({
        provider: items.provider || fresh.provider,
        apiKeys: { ...fresh.apiKeys, ...(items.apiKeys || {}) },
        models: { ...fresh.models, ...(items.models || {}) },
        modelLists: { ...fresh.modelLists, ...(items.modelLists || {}) },
        customBaseUrl: items.customBaseUrl || "",
        extraFlobooksDbs: items.extraFlobooksDbs || "",
      });
    });
  });
}

function setSettings(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}

// --- conversation persistence ---------------------------------------------
// Use chrome.storage.session when available so reopening the side panel
// keeps the chat. session resets when the browser closes.

async function loadConversation() {
  try {
    if (chrome.storage?.session) {
      const items = await new Promise((r) => chrome.storage.session.get([CONVO_SESSION_KEY], r));
      if (Array.isArray(items[CONVO_SESSION_KEY])) return items[CONVO_SESSION_KEY];
    }
  } catch {
    /* fall through */
  }
  return [];
}

async function saveConversation() {
  try {
    if (chrome.storage?.session) {
      await new Promise((r) =>
        chrome.storage.session.set({ [CONVO_SESSION_KEY]: state.conversation }, r),
      );
    }
  } catch {
    /* ignore */
  }
}

async function clearConversation() {
  state.conversation = [];
  state.dbKeyForSystemPrompt = null;
  await saveConversation();
  renderConversation();
}

// --- tabs ------------------------------------------------------------------

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

// --- DB detection ----------------------------------------------------------

async function getActiveTabInfo() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "getActiveTabId" }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response);
    });
  });
}

async function forceInjectContentScript(tabId) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      { target: { tabId }, files: ["content.js"] },
      () => {
        const err = chrome.runtime.lastError;
        resolve({ ok: !err, detail: err ? err.message : "injected" });
      },
    );
  });
}

async function sendToTabOnce(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (r) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, detail: chrome.runtime.lastError.message });
      } else {
        resolve(r);
      }
    });
  });
}

async function detectSelectedDb() {
  if (!state.schema) {
    return { dbKey: null, dbDisplay: null, reason: "not-detected", debugDetail: "schema not loaded yet" };
  }
  const settings = await getSettings();
  const extra = settings.extraFlobooksDbs
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const candidates = new Set([...Object.keys(state.schema.metabase_db_map), ...extra]);

  const tab = await getActiveTabInfo();
  if (!tab?.url || !tab.url.includes(METABASE_HOST)) {
    return { dbKey: null, dbDisplay: null, reason: "not-on-metabase" };
  }

  const msg = { type: "mbbqa:whichDb", dbCandidates: Array.from(candidates) };
  let resp = await sendToTabOnce(tab.tabId, msg);
  if (!resp?.ok && /Receiving end does not exist|Could not establish connection/i.test(resp?.detail || "")) {
    const injection = await forceInjectContentScript(tab.tabId);
    if (injection.ok) {
      await new Promise((r) => setTimeout(r, 150));
      resp = await sendToTabOnce(tab.tabId, msg);
    } else {
      return { dbKey: null, dbDisplay: null, reason: "not-detected", debugDetail: `inject-failed: ${injection.detail}` };
    }
  }
  if (!resp?.ok || !resp.detail) {
    return { dbKey: null, dbDisplay: null, reason: "not-detected", debugDetail: resp?.detail || "no response" };
  }

  const display = resp.detail;
  const mapped = state.schema.metabase_db_map[display];
  const dbKey = mapped || (extra.includes(display) ? "flobooks" : null);
  return { dbKey, dbDisplay: display, reason: dbKey ? "ok" : "out-of-schema" };
}

async function refreshDbStatus() {
  const badge = document.getElementById("dbStatus");
  badge.className = "badge badge-unknown";
  badge.textContent = "detecting…";
  const { dbKey, dbDisplay, reason, debugDetail } = await detectSelectedDb();
  state.dbKey = dbKey;
  state.dbDisplay = dbDisplay;
  if (reason === "not-on-metabase") {
    badge.className = "badge badge-warn";
    badge.textContent = "not on metabase.flobiz.in";
  } else if (reason === "not-detected") {
    badge.className = "badge badge-warn";
    badge.textContent = "can't detect DB";
    badge.title = debugDetail || "";
    setGenStatus(`DB detect: ${debugDetail || "no detail"}`, true);
  } else if (reason === "out-of-schema") {
    badge.className = "badge badge-warn";
    badge.textContent = `${dbDisplay} — out of schema`;
  } else {
    badge.className = "badge badge-ok";
    badge.textContent = `${dbDisplay} → ${dbKey}`;
    badge.title = "";
  }
}

document.getElementById("refreshDb").addEventListener("click", refreshDbStatus);

// --- conversation rendering ------------------------------------------------

function setGenStatus(text, isError) {
  const el = document.getElementById("generateStatus");
  if (!text) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  el.classList.toggle("error", !!isError);
  el.textContent = text;
}

function renderConversation() {
  const container = document.getElementById("conversation");
  container.innerHTML = "";
  for (let i = 0; i < state.conversation.length; i++) {
    const m = state.conversation[i];
    if (m.role === "user") {
      const div = document.createElement("div");
      div.className = "turn turn-user";
      div.textContent = m.content;
      container.appendChild(div);
    } else {
      const turn = document.createElement("div");
      turn.className = "turn turn-assistant";

      const header = document.createElement("div");
      header.className = "turn-header";
      const meta = document.createElement("div");
      meta.className = "meta";
      const badge = document.createElement("span");
      badge.className = "validation-badge " + (m.validation?.ok ? "ok" : "fail");
      badge.textContent = m.validation?.ok ? "✓ schema-verified" : "✗ validation failed";
      meta.appendChild(badge);
      const modelLabel = document.createElement("span");
      modelLabel.textContent = m.modelLabel || "";
      meta.appendChild(modelLabel);
      header.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "actions";
      const copyBtn = document.createElement("button");
      copyBtn.className = "btn-secondary";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", () => copySql(m.sql, copyBtn));
      const insertBtn = document.createElement("button");
      insertBtn.className = "btn-primary";
      if (m.validation?.ok) {
        insertBtn.textContent = "Insert";
        insertBtn.addEventListener("click", () => insertSqlIntoMetabase(m.sql));
      } else {
        // Block insert on validation failure. A "force insert" escape hatch
        // appears on click for the rare case where the user wants to edit
        // the SQL manually in Metabase.
        insertBtn.textContent = "⚠ Insert (blocked)";
        insertBtn.classList.add("blocked");
        insertBtn.title = "Validation failed — schema mismatch likely. Click twice to force.";
        let armed = false;
        insertBtn.addEventListener("click", () => {
          if (!armed) {
            armed = true;
            insertBtn.textContent = "⚠ Force insert?";
            setTimeout(() => {
              armed = false;
              insertBtn.textContent = "⚠ Insert (blocked)";
            }, 3000);
            return;
          }
          insertSqlIntoMetabase(m.sql);
        });
      }
      actions.appendChild(copyBtn);
      actions.appendChild(insertBtn);
      header.appendChild(actions);
      turn.appendChild(header);

      const pre = document.createElement("pre");
      pre.className = "sql-output";
      const code = document.createElement("code");
      code.textContent = m.sql || m.content;
      pre.appendChild(code);
      turn.appendChild(pre);

      if (m.validation && !m.validation.ok && m.validation.errors?.length) {
        const errBox = document.createElement("div");
        errBox.className = "turn-errors";
        errBox.innerHTML = "<b>Validation errors:</b>";
        const ul = document.createElement("ul");
        for (const e of m.validation.errors) {
          const li = document.createElement("li");
          li.textContent = e;
          ul.appendChild(li);
        }
        errBox.appendChild(ul);
        turn.appendChild(errBox);
      }

      container.appendChild(turn);
    }
  }
  container.scrollTop = container.scrollHeight;
}

async function copySql(sql, btn) {
  if (!sql) return;
  try {
    await navigator.clipboard.writeText(sql);
    const orig = btn.textContent;
    btn.textContent = "✓ Copied";
    setTimeout(() => (btn.textContent = orig), 1200);
  } catch {
    setGenStatus("Clipboard write failed.", true);
  }
}

// --- generate (chat) -------------------------------------------------------

document.getElementById("generateBtn").addEventListener("click", sendTurn);
document.getElementById("requestInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendTurn();
  }
});
document.getElementById("newConvoBtn").addEventListener("click", clearConversation);

async function sendTurn() {
  const input = document.getElementById("requestInput");
  const text = input.value.trim();
  if (!text) return;

  const settings = await getSettings();
  const providerId = settings.provider;
  const apiKey = settings.apiKeys[providerId];
  if (!apiKey) {
    setGenStatus(`Add your ${PROVIDERS[providerId].label} API key in Settings.`, true);
    return;
  }
  if (!state.dbKey) {
    setGenStatus(
      state.dbDisplay
        ? `"${state.dbDisplay}" is not covered by the schema reference. Switch to Flobooks or Phone Pe.`
        : "Select a database in Metabase first, then click ↻.",
      true,
    );
    return;
  }

  // If the DB changed since the last turn, reset the conversation so the
  // system prompt reflects the new schema slice.
  if (state.dbKeyForSystemPrompt && state.dbKeyForSystemPrompt !== state.dbKey) {
    await clearConversation();
  }
  state.dbKeyForSystemPrompt = state.dbKey;

  const useFlash = document.getElementById("useFlash").checked;
  const mc = settings.models[providerId] || {};
  const model = useFlash ? mc.fast || mc.default : mc.default || mc.fast;
  if (!model) {
    setGenStatus(`No model set for ${PROVIDERS[providerId].label}. Add one in Settings.`, true);
    return;
  }

  // Append user turn, render, clear input.
  state.conversation.push({ role: "user", content: text, timestamp: Date.now() });
  input.value = "";
  renderConversation();
  await saveConversation();

  const systemText = buildSystemPrompt(state.schema, state.dbKey);

  // Build message history for the LLM. Truncate to MAX_TURNS most recent.
  const msgs = state.conversation
    .slice(-MAX_TURNS * 2)
    .map((m) => ({ role: m.role, content: m.role === "assistant" ? m.sql || m.content : m.content }));

  const btn = document.getElementById("generateBtn");
  btn.disabled = true;

  try {
    setGenStatus(`Asking ${providerId}:${model}…`);
    let sql = await generateFromConversation({
      provider: providerId,
      apiKey,
      model,
      baseUrl: settings.customBaseUrl,
      systemText,
      messages: msgs,
    });

    if (sql.startsWith("-- CANNOT_ANSWER")) {
      state.conversation.push({
        role: "assistant",
        content: sql,
        sql,
        validation: { ok: false, errors: ["Model declined to answer."] },
        modelLabel: `${providerId}:${model}`,
        timestamp: Date.now(),
      });
      renderConversation();
      await saveConversation();
      setGenStatus("");
      return;
    }

    let validation = validateSql(sql, state.schema, state.dbKey);

    // Up to two retries with escalating feedback before giving up. Each retry
    // carries the previous SQL and the specific validator errors, so the model
    // has no excuse to repeat the same mistake.
    const MAX_RETRIES = 2;
    for (let attempt = 1; attempt <= MAX_RETRIES && !validation.ok; attempt++) {
      setGenStatus(
        `Validation failed (${validation.errors.length} issue${
          validation.errors.length === 1 ? "" : "s"
        }). Retry ${attempt}/${MAX_RETRIES}…`,
      );
      const retryUser = buildRetryUserMessage(sql, validation.errors, attempt === MAX_RETRIES);
      const retryMsgs = [...msgs, { role: "assistant", content: sql }, { role: "user", content: retryUser }];
      const retried = await generateFromConversation({
        provider: providerId,
        apiKey,
        model,
        baseUrl: settings.customBaseUrl,
        systemText,
        messages: retryMsgs,
        temperature: 0.05,
      });
      const revalid = validateSql(retried, state.schema, state.dbKey);
      sql = retried;
      validation = revalid;
    }

    // Add fuzzy-match suggestions to errors so the user has something to act on.
    if (!validation.ok) {
      const db = state.schema.databases[state.dbKey];
      const allTables = Object.keys(db.tables);
      const extraHints = [];
      for (const t of validation.unknownTables || []) {
        const fix = suggestFix(t, allTables);
        if (fix) extraHints.push(`Did you mean table "${fix}" instead of "${t}"?`);
      }
      if (extraHints.length) validation.errors = [...validation.errors, ...extraHints];
    }

    state.conversation.push({
      role: "assistant",
      content: sql,
      sql,
      validation,
      modelLabel: `${providerId}:${model}`,
      timestamp: Date.now(),
    });
    renderConversation();
    await saveConversation();
    setGenStatus("");
  } catch (err) {
    setGenStatus(err.message || String(err), true);
  } finally {
    btn.disabled = false;
  }
}

function buildRetryUserMessage(previousSql, errors, lastChance) {
  const emphasis = lastChance
    ? "This is your LAST retry. If you cannot fix all issues using only the schema JSON, output exactly: -- CANNOT_ANSWER: <reason>. Do not emit SQL that references non-existent tables or columns."
    : "Fix all issues using only the schema JSON. Output SQL only.";
  return `Your previous SQL failed the schema validator:

\`\`\`sql
${previousSql}
\`\`\`

Issues:
${errors.map((e) => "  - " + e).join("\n")}

${emphasis}`;
}

// --- MAIN-world inserter ---------------------------------------------------

function mainWorldInsert(sql) {
  const cm5El = document.querySelector(".CodeMirror");
  if (cm5El && cm5El.CodeMirror) {
    try {
      cm5El.CodeMirror.setValue(sql);
      cm5El.CodeMirror.focus();
      return { ok: true, detail: "cm5" };
    } catch (e) {
      /* fall through */
    }
  }

  const cm6El = document.querySelector(".cm-editor");
  if (cm6El) {
    let view = null;
    for (const key of Object.getOwnPropertyNames(cm6El)) {
      const v = cm6El[key];
      if (v && typeof v === "object" && v.state && typeof v.dispatch === "function" && v.state.doc) {
        view = v;
        break;
      }
    }
    if (view) {
      try {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: sql } });
        if (typeof view.focus === "function") view.focus();
        return { ok: true, detail: "cm6-view" };
      } catch (e) {
        /* fall through */
      }
    }
    const content = cm6El.querySelector(".cm-content");
    if (content) {
      content.focus();
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(content);
        sel.removeAllRanges();
        sel.addRange(range);
        if (document.execCommand("insertText", false, sql)) {
          return { ok: true, detail: "cm6-insertText" };
        }
      } catch (e) {
        /* fall through */
      }
    }
  }

  if (window.ace) {
    const aceNodes = document.querySelectorAll(".ace_editor");
    for (const n of aceNodes) {
      const editor = window.ace.edit(n);
      if (editor) {
        editor.setValue(sql, -1);
        editor.focus();
        return { ok: true, detail: "ace" };
      }
    }
  }

  const guess =
    document.querySelector('[contenteditable="true"]') ||
    document.querySelector("textarea.QueryBuilder, textarea");
  if (guess) {
    guess.focus();
    if (guess.tagName === "TEXTAREA") {
      const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
      proto?.set?.call(guess, sql);
      guess.dispatchEvent(new Event("input", { bubbles: true }));
      return { ok: true, detail: "textarea" };
    }
    try {
      document.execCommand("selectAll");
      if (document.execCommand("insertText", false, sql)) {
        return { ok: true, detail: "contenteditable-insertText" };
      }
    } catch (e) {
      /* fall through */
    }
  }

  const diag = {
    cm5: !!document.querySelector(".CodeMirror"),
    cm5Instance: !!document.querySelector(".CodeMirror")?.CodeMirror,
    cm6: !!document.querySelector(".cm-editor"),
    cm6Content: !!document.querySelector(".cm-content"),
    ace: document.querySelectorAll(".ace_editor").length,
    monaco: !!document.querySelector(".monaco-editor"),
    contentEditables: document.querySelectorAll('[contenteditable="true"]').length,
    textareas: document.querySelectorAll("textarea").length,
    nearGutterSamples: Array.from(document.querySelectorAll('[class*="editor"], [class*="Editor"]'))
      .slice(0, 6)
      .map((el) => el.className?.toString().slice(0, 80))
      .filter(Boolean),
  };
  return { ok: false, detail: "no-editor-found · " + JSON.stringify(diag) };
}

async function insertSqlIntoMetabase(sql) {
  if (!sql) return;
  const tab = await getActiveTabInfo();
  if (!tab?.url || !tab.url.includes(METABASE_HOST)) {
    setGenStatus("Open metabase.flobiz.in in the active tab.", true);
    return;
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.tabId },
      world: "MAIN",
      func: mainWorldInsert,
      args: [sql],
    });
    const result = results?.[0]?.result;
    if (result?.ok) {
      setGenStatus(`Inserted (${result.detail}).`);
      setTimeout(() => setGenStatus(""), 1500);
    } else {
      setGenStatus(`Injection failed: ${result?.detail || "unknown"}`, true);
    }
  } catch (err) {
    setGenStatus(`Injection error: ${err.message || err}`, true);
  }
}

// --- explore tab -----------------------------------------------------------

function renderExplore(query) {
  const q = query.trim().toLowerCase();
  const container = document.getElementById("exploreResults");
  container.innerHTML = "";

  // A column is considered a match if the query substring appears in its
  // name, its enum keys (e.g. "silver" -> subscription_type), its FK target
  // table (e.g. "companies" -> all columns FKing to companies), or its notes.
  const colMatches = (colName, info) => {
    if (!q) return true;
    if (colName.includes(q)) return true;
    if (info.enum && Object.keys(info.enum).some((k) => k.toLowerCase().includes(q))) return true;
    if (info.fk?.table && info.fk.table.toLowerCase().includes(q)) return true;
    if (info.notes && info.notes.toLowerCase().includes(q)) return true;
    return false;
  };

  const matches = [];
  for (const [dbKey, db] of Object.entries(state.schema.databases)) {
    for (const [tableName, table] of Object.entries(db.tables)) {
      const tableNameMatches = !q || tableName.includes(q);
      const allCols = Object.entries(table.columns);
      // If the table name matches, show every column. Otherwise only the
      // columns that themselves match — so searching "silver" shows just
      // subscription_type, not the whole subscriptions table.
      const cols = tableNameMatches ? allCols : allCols.filter(([c, i]) => colMatches(c, i));
      if (tableNameMatches || cols.length) {
        matches.push({ dbKey, db, tableName, table, cols, tableNameMatches });
      }
    }
  }

  matches.sort((a, b) => {
    const ae = a.tableName === q ? 0 : a.tableNameMatches && q ? 1 : 2;
    const be = b.tableName === q ? 0 : b.tableNameMatches && q ? 1 : 2;
    if (ae !== be) return ae - be;
    return b.cols.length - a.cols.length;
  });

  const limited = matches.slice(0, 25);

  for (const { dbKey, db, tableName, table, cols } of limited) {
    const div = document.createElement("div");
    div.className = "explore-item";
    const header = document.createElement("div");
    header.className = "explore-item-header";
    header.innerHTML = `<span>${tableName}</span><span class="db-tag">${db.display}</span>`;
    div.appendChild(header);

    const tbl = document.createElement("table");
    const shownCols = cols.length ? cols : Object.entries(table.columns);
    for (const [col, info] of shownCols.slice(0, 40)) {
      const tr = document.createElement("tr");
      const tdName = document.createElement("td");
      tdName.textContent = col;
      const tdType = document.createElement("td");
      tdType.textContent = info.type || "";
      const tdNotes = document.createElement("td");
      const bits = [];
      if (info.primary_key) bits.push("PK");
      if (info.fk) bits.push(`FK→${info.fk.table}${info.fk.note ? ` (${info.fk.note})` : ""}`);
      if (info.polymorphic_type) bits.push("poly type");
      if (info.polymorphic_id) bits.push("poly id");
      if (info.soft_delete) bits.push("soft delete");
      if (info.indexed) bits.push("indexed");
      tdNotes.textContent = bits.join(" · ");
      if (info.enum) {
        const wrap = document.createElement("div");
        wrap.style.marginTop = "2px";
        for (const [k, v] of Object.entries(info.enum)) {
          const pill = document.createElement("span");
          pill.className = "enum-pill";
          pill.textContent = `${k}=${v}`;
          wrap.appendChild(pill);
        }
        tdNotes.appendChild(wrap);
      }
      tr.append(tdName, tdType, tdNotes);
      tbl.appendChild(tr);
    }
    div.appendChild(tbl);
    container.appendChild(div);
  }

  if (!limited.length) {
    container.innerHTML = `<p class="helper">No matches. Try a table name like <code>invoices</code> or a column like <code>invoice_type</code>.</p>`;
  }
}

document.getElementById("exploreSearch").addEventListener("input", (e) => renderExplore(e.target.value));

// --- settings tab ----------------------------------------------------------

function populateModelDatalist(providerId, settings) {
  const p = PROVIDERS[providerId];
  const fromCache = settings.modelLists?.[providerId];
  const suggestions = fromCache?.length ? fromCache : p.fallbackSuggestions;
  const dl = document.getElementById("modelSuggestions");
  dl.innerHTML = "";
  for (const s of suggestions) {
    const opt = document.createElement("option");
    opt.value = s;
    dl.appendChild(opt);
  }
  // Tell the user whether they're seeing live-fetched or fallback options.
  const statusEl = document.getElementById("loadModelsStatus");
  if (statusEl && !statusEl.textContent) {
    statusEl.textContent = fromCache?.length
      ? `${fromCache.length} live models`
      : `${p.fallbackSuggestions.length} fallback suggestions`;
  }
}

function updateProviderUi(providerId, settings) {
  const p = PROVIDERS[providerId];
  const keyInput = document.getElementById("apiKeyInput");
  keyInput.placeholder = p.keyHint || "";
  keyInput.value = settings.apiKeys[providerId] || "";

  const help = document.getElementById("providerHelp");
  if (p.keyUrl) {
    help.innerHTML = `Get a key at <a href="${p.keyUrl}" target="_blank">${p.keyUrl.replace(
      /^https?:\/\//,
      "",
    )}</a>. Stored locally in <code>chrome.storage.local</code>.`;
  } else {
    help.textContent = "Stored locally in chrome.storage.local.";
  }

  populateModelDatalist(providerId, settings);

  const mc = settings.models[providerId] || {};
  document.getElementById("defaultModelInput").value = mc.default || p.defaultModel || "";
  document.getElementById("fastModelInput").value = mc.fast || p.defaultFast || "";

  document.getElementById("customBaseUrlRow").classList.toggle("hidden", providerId !== "custom");
  document.getElementById("customBaseUrlInput").value = settings.customBaseUrl || "";
}

async function hydrateSettings() {
  const s = await getSettings();
  document.getElementById("extraFlobooksDbs").value = s.extraFlobooksDbs;
  document.getElementById("providerSelect").value = s.provider;
  updateProviderUi(s.provider, s);
}

document.getElementById("providerSelect").addEventListener("change", async (e) => {
  const current = await getSettings();
  current.provider = e.target.value;
  await setSettings(current);
  updateProviderUi(current.provider, current);
  // If there's an API key but no cached model list for this provider,
  // auto-fetch so the datalist is fully dynamic.
  if (current.apiKeys[current.provider] && !current.modelLists[current.provider]?.length) {
    triggerLoadModels();
  }
});

async function triggerLoadModels() {
  document.getElementById("loadModelsBtn").click();
}

document.getElementById("loadModelsBtn").addEventListener("click", async () => {
  const statusEl = document.getElementById("loadModelsStatus");
  const btn = document.getElementById("loadModelsBtn");
  const current = await getSettings();
  const providerId = document.getElementById("providerSelect").value;
  const apiKey = document.getElementById("apiKeyInput").value.trim() || current.apiKeys[providerId];
  const baseUrl = document.getElementById("customBaseUrlInput").value.trim() || current.customBaseUrl;
  if (!apiKey && providerId !== "openrouter") {
    statusEl.textContent = "Enter the API key first.";
    return;
  }
  btn.disabled = true;
  statusEl.textContent = "loading…";
  try {
    const list = await listProviderModels({ provider: providerId, apiKey, baseUrl });
    if (!list.length) {
      statusEl.textContent = "no models returned";
      return;
    }
    current.modelLists = { ...(current.modelLists || {}), [providerId]: list };
    await setSettings(current);
    populateModelDatalist(providerId, current);
    statusEl.textContent = `✓ ${list.length} models`;
    setTimeout(() => (statusEl.textContent = ""), 2000);
  } catch (err) {
    statusEl.textContent = `failed: ${(err.message || String(err)).slice(0, 120)}`;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("saveSettings").addEventListener("click", async () => {
  const current = await getSettings();
  const providerId = document.getElementById("providerSelect").value;
  const newKey = document.getElementById("apiKeyInput").value.trim();
  const keyChanged = current.apiKeys[providerId] !== newKey;
  current.provider = providerId;
  current.apiKeys = { ...current.apiKeys, [providerId]: newKey };
  current.models = {
    ...current.models,
    [providerId]: {
      default: document.getElementById("defaultModelInput").value.trim(),
      fast: document.getElementById("fastModelInput").value.trim(),
    },
  };
  current.customBaseUrl = document.getElementById("customBaseUrlInput").value.trim();
  current.extraFlobooksDbs = document.getElementById("extraFlobooksDbs").value.trim();
  // If API key changed, invalidate the cached model list so next load is fresh.
  if (keyChanged) {
    current.modelLists = { ...(current.modelLists || {}), [providerId]: null };
  }
  await setSettings(current);
  const s = document.getElementById("saveStatus");
  s.textContent = "✓ saved";
  setTimeout(() => (s.textContent = ""), 1500);
  // Refresh the list automatically with the new key.
  if (keyChanged && newKey) triggerLoadModels();
});

// --- init ------------------------------------------------------------------

(async () => {
  try {
    await loadSchema();
    await hydrateSettings();
    await refreshDbStatus();
    state.conversation = await loadConversation();
    renderConversation();
    renderExplore("");
  } catch (err) {
    console.error("MBB Query Assistant init failed:", err);
    setGenStatus(`Init failed: ${err.message || err}. Try reloading the extension.`, true);
  }
})();
