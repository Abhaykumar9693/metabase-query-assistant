// Runs on metabase.flobiz.in. Everything here lives in the content-script
// isolated world — which is fine, because the DOM is shared and that's all
// we need. The previous inline page-bridge approach was blocked by
// Metabase's Content-Security-Policy; dropping it removes that failure mode.

// --- DB detection ----------------------------------------------------------

function findSelectedDbName(candidates) {
  if (!candidates?.length) return { match: null, scanned: 0, sample: [] };
  const candidateSet = new Set(candidates);
  const lowerMap = new Map();
  for (const c of candidates) lowerMap.set(c.toLowerCase(), c);

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const t = node.nodeValue;
      if (!t || !t.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let scanned = 0;
  const sample = [];
  let node;
  while ((node = walker.nextNode())) {
    scanned++;
    const raw = node.nodeValue || "";
    const trimmed = raw.trim();
    if (trimmed.length > 80) continue;
    if (sample.length < 40 && trimmed.length >= 3) sample.push(trimmed);

    if (candidateSet.has(trimmed) && isVisibleText(node)) {
      return { match: trimmed, scanned, sample };
    }
  }
  // Case-insensitive fallback.
  for (const t of sample) {
    const c = lowerMap.get(t.toLowerCase());
    if (c) return { match: c, scanned, sample };
  }
  return { match: null, scanned, sample };
}

function isVisibleText(textNode) {
  let el = textNode.parentElement;
  while (el) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    el = el.parentElement;
  }
  const r = textNode.parentElement?.getBoundingClientRect();
  return !!(r && (r.width > 0 || r.height > 0));
}

// --- SQL insertion ---------------------------------------------------------

function insertViaCm6(sql) {
  const cmEl = document.querySelector(".cm-editor");
  if (!cmEl) return false;
  const contentEl = cmEl.querySelector(".cm-content");
  if (!contentEl) return false;
  contentEl.focus();
  const dt = new DataTransfer();
  dt.setData("text/plain", sql);
  // Replace existing content: select all first.
  document.execCommand("selectAll");
  const ev = new ClipboardEvent("paste", {
    clipboardData: dt,
    bubbles: true,
    cancelable: true,
  });
  contentEl.dispatchEvent(ev);
  return true;
}

function insertViaInputEvent(sql) {
  // Fallback: dispatch a beforeinput event on the focused editor. CM6 and
  // most modern editors listen for this.
  const target = document.querySelector(".cm-content") || document.activeElement;
  if (!target) return false;
  target.focus();
  const ev = new InputEvent("beforeinput", {
    inputType: "insertReplacementText",
    data: sql,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(ev);
  return true;
}

async function insertSql(sql) {
  // Modern Metabase uses CodeMirror 6. If a future/older Metabase version
  // ships ACE, we'd need a chrome.scripting.executeScript MAIN-world path;
  // not needed right now and dropping it keeps this file CSP-safe.
  if (insertViaCm6(sql)) return { ok: true, detail: "cm6" };
  if (insertViaInputEvent(sql)) return { ok: true, detail: "input-event" };
  return { ok: false, detail: "no-editor-found" };
}

// --- message handler -------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "mbbqa:whichDb") {
    const res = findSelectedDbName(msg.dbCandidates || []);
    if (res.match) {
      sendResponse({ ok: true, detail: res.match });
    } else {
      sendResponse({
        ok: false,
        detail: `no-match · scanned ${res.scanned} · sample: ${res.sample.slice(0, 10).join(" | ") || "(empty)"}`,
      });
    }
    return false; // sync
  }
  if (msg?.type === "mbbqa:insertSql") {
    insertSql(msg.sql).then((r) => sendResponse(r));
    return true; // async
  }
});

// --- Copy results button ---------------------------------------------------

const COPY_BTN_ID = "__mbbqa-copy-results";
const COPY_BTN_VERSION = "v4";
const COPY_BTN_DEFAULT_TEXT = `Copy results (${COPY_BTN_VERSION})`;
console.log(`[mbbqa] content.js ${COPY_BTN_VERSION} loaded`);

// Holds the most recent query result captured by metabase-interceptor.js
// (via postMessage from the MAIN world). This is the preferred source for
// "Copy results" because it contains the full row set, not just whatever
// the virtualized grid happens to have rendered to the DOM.
let lastInterceptedResult = null;

window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data || e.data.__mbbqa !== "data-ready") return;
  lastInterceptedResult = e.data.payload;
});

function extractVisibleTable() {
  // Strategy 1 — direct data-testid queries (most reliable across Metabase
  // versions; the virtualized grid doesn't have a single stable container).
  const headerCells = document.querySelectorAll(
    '[data-testid="header-cell"], [data-testid="column-header-cell"], .TableInteractive-headerCellData',
  );
  const cellData = document.querySelectorAll(
    '[data-testid="cell-data"], .cellData, .TableInteractive-cellWrapper .cellData',
  );
  if (headerCells.length && cellData.length && cellData.length % headerCells.length === 0) {
    const ncols = headerCells.length;
    const rows = [[...headerCells].map((c) => c.innerText.trim())];
    for (let i = 0; i < cellData.length; i += ncols) {
      const row = [];
      for (let j = 0; j < ncols && i + j < cellData.length; j++) {
        row.push(cellData[i + j].innerText.trim());
      }
      rows.push(row);
    }
    return rows;
  }

  // Strategy 2 — a real <table> (pivot / object detail / small result sets).
  const tableEl = document.querySelector(
    '.Visualization table, [data-testid="visualization-root"] table, table',
  );
  if (tableEl) {
    const r = tableFromHtmlTable(tableEl);
    if (r) return r;
  }

  // Strategy 3 — role=grid with role=row / role=gridcell.
  const grid = document.querySelector('[role="grid"]');
  if (grid) {
    const r = tableFromRoleGrid(grid);
    if (r) return r;
  }

  // Strategy 4 — headerCells-only (very rare: zero-row result).
  if (headerCells.length) {
    return [[...headerCells].map((c) => c.innerText.trim())];
  }

  return null;
}

function tableFromHtmlTable(tbl) {
  const rows = [];
  const headRow = tbl.querySelector("thead tr");
  if (headRow) rows.push([...headRow.querySelectorAll("th,td")].map((c) => c.innerText.trim()));
  for (const tr of tbl.querySelectorAll("tbody tr")) {
    rows.push([...tr.querySelectorAll("th,td")].map((c) => c.innerText.trim()));
  }
  return rows.length ? rows : null;
}

function tableFromRoleGrid(grid) {
  const rows = [];
  const headers = grid.querySelectorAll('[role="columnheader"]');
  if (headers.length) rows.push([...headers].map((h) => h.innerText.trim()));
  const rowEls = grid.querySelectorAll('[role="row"]');
  for (const r of rowEls) {
    const cells = r.querySelectorAll('[role="gridcell"]');
    if (!cells.length) continue;
    rows.push([...cells].map((c) => c.innerText.trim()));
  }
  return rows.length ? rows : null;
}

function tableFromTableInteractive(root) {
  const rows = [];
  const headerCells = root.querySelectorAll(
    '[data-testid="header-cell"], .TableInteractive-headerCellData',
  );
  if (headerCells.length) rows.push([...headerCells].map((c) => c.innerText.trim()));
  const cellRows = root.querySelectorAll('[data-testid="cell-data"]');
  if (cellRows.length && rows[0]) {
    const ncols = rows[0].length;
    for (let i = 0; i < cellRows.length; i += ncols) {
      const row = [];
      for (let j = 0; j < ncols && i + j < cellRows.length; j++) {
        row.push(cellRows[i + j].innerText.trim());
      }
      rows.push(row);
    }
  }
  return rows.length ? rows : null;
}

function toTsv(rows) {
  return rows
    .map((r) => r.map((c) => c.replace(/\t/g, "    ").replace(/\r?\n/g, " ")).join("\t"))
    .join("\n");
}

async function copyResults(btn) {
  // Prefer intercepted API data (full row set) over DOM scraping.
  if (lastInterceptedResult?.cols?.length) {
    const { cols, rows } = lastInterceptedResult;
    const all = [cols, ...rows];
    const tsv = toTsv(all);
    try {
      await navigator.clipboard.writeText(tsv);
      btn.textContent = `✓ Copied ${rows.length} rows`;
    } catch {
      btn.textContent = "Copy failed";
    }
    setTimeout(() => (btn.textContent = COPY_BTN_DEFAULT_TEXT), 1800);
    return;
  }

  const rows = extractVisibleTable();
  if (!rows || rows.length === 0) {
    // Report what we DID find so we can extend selectors.
    const diag = {
      headerCells: document.querySelectorAll('[data-testid="header-cell"]').length,
      cellData: document.querySelectorAll('[data-testid="cell-data"]').length,
      htmlTables: document.querySelectorAll("table").length,
      roleGrids: document.querySelectorAll('[role="grid"]').length,
      tableInteractive: document.querySelectorAll(".TableInteractive").length,
    };
    btn.textContent = "Can't parse table";
    btn.title = JSON.stringify(diag);
    setTimeout(() => {
      btn.textContent = COPY_BTN_DEFAULT_TEXT;
      btn.title = "";
    }, 2500);
    return;
  }
  if (rows.length === 1) {
    btn.textContent = "No data rows (only headers)";
    setTimeout(() => (btn.textContent = COPY_BTN_DEFAULT_TEXT), 1800);
    return;
  }
  const tsv = toTsv(rows);
  try {
    await navigator.clipboard.writeText(tsv);
    btn.textContent = `✓ Copied ${rows.length - 1} rows`;
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = COPY_BTN_DEFAULT_TEXT), 1800);
}

function ensureCopyButton() {
  if (document.getElementById(COPY_BTN_ID)) return;
  const resultsPresent = document.querySelector(
    "[data-testid='visualization-root'], [data-testid='cell-data'], [data-testid='header-cell'], .Visualization table, [role='grid'], .TableInteractive, table",
  );
  if (!resultsPresent) return;

  const btn = document.createElement("button");
  btn.id = COPY_BTN_ID;
  btn.textContent = COPY_BTN_DEFAULT_TEXT;
  Object.assign(btn.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    zIndex: 99999,
    padding: "8px 14px",
    background: "#1a73e8",
    color: "#fff",
    border: "none",
    borderRadius: "20px",
    fontFamily: "inherit",
    fontSize: "13px",
    fontWeight: "500",
    cursor: "pointer",
    boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
  });
  btn.addEventListener("click", () => copyResults(btn));
  document.body.appendChild(btn);
}

function removeCopyButtonIfNoResults() {
  const btn = document.getElementById(COPY_BTN_ID);
  if (!btn) return;
  const resultsPresent = document.querySelector(
    "[data-testid='visualization-root'], [data-testid='cell-data'], [data-testid='header-cell'], .Visualization table, [role='grid'], .TableInteractive, table",
  );
  if (!resultsPresent) btn.remove();
}

const mo = new MutationObserver(() => {
  ensureCopyButton();
  removeCopyButtonIfNoResults();
});
mo.observe(document.documentElement, { childList: true, subtree: true });
ensureCopyButton();
