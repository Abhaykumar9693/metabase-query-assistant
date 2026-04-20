// Unified LLM provider interface. Supports Gemini, OpenAI, Anthropic,
// OpenRouter, and a user-configured OpenAI-compatible endpoint.
//
// Each provider exposes:
//   call({ apiKey, model, baseUrl, systemText, messages, temperature })
//     → string response text
//   listModels({ apiKey, baseUrl })
//     → string[] of model IDs usable as the `model` param
//
// The "compact schema + strict system prompt + validate-then-retry" loop is
// identical across providers — only the HTTP calls differ.

export const PROVIDERS = {
  gemini: {
    label: "Google Gemini",
    keyHint: "AIza…",
    keyUrl: "https://aistudio.google.com/apikey",
    defaultModel: "gemini-2.5-pro",
    defaultFast: "gemini-2.5-flash",
    fallbackSuggestions: [
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.0-flash",
    ],
    call: callGemini,
    listModels: listGeminiModels,
  },
  openai: {
    label: "OpenAI",
    keyHint: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
    defaultModel: "gpt-4o",
    defaultFast: "gpt-4o-mini",
    fallbackSuggestions: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o4-mini"],
    call: callOpenAICompatible("https://api.openai.com/v1"),
    listModels: listOpenAIModels("https://api.openai.com/v1"),
  },
  anthropic: {
    label: "Anthropic (Claude)",
    keyHint: "sk-ant-…",
    keyUrl: "https://console.anthropic.com/settings/keys",
    defaultModel: "claude-sonnet-4-6",
    defaultFast: "claude-haiku-4-5-20251001",
    fallbackSuggestions: [
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-7",
      "claude-3-7-sonnet-latest",
    ],
    call: callAnthropic,
    listModels: listAnthropicModels,
  },
  openrouter: {
    label: "OpenRouter",
    keyHint: "sk-or-…",
    keyUrl: "https://openrouter.ai/keys",
    defaultModel: "anthropic/claude-sonnet-4.6",
    defaultFast: "google/gemini-2.5-flash",
    fallbackSuggestions: [
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-haiku-4.5",
      "google/gemini-2.5-pro",
      "google/gemini-2.5-flash",
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
    ],
    call: callOpenAICompatible("https://openrouter.ai/api/v1"),
    listModels: listOpenAIModels("https://openrouter.ai/api/v1"),
  },
  custom: {
    label: "Custom (OpenAI-compatible)",
    keyHint: "your API key",
    keyUrl: null,
    defaultModel: "",
    defaultFast: "",
    fallbackSuggestions: [],
    call: callOpenAICompatibleCustom,
    listModels: async ({ apiKey, baseUrl }) => {
      const url = (baseUrl || "").replace(/\/+$/, "");
      if (!url) throw new Error("Custom provider needs a base URL first.");
      return listOpenAIModels(url)({ apiKey });
    },
  },
};

// --- system prompt + schema context ---------------------------------------

export function compactSchema(schema, dbKey) {
  const db = schema.databases[dbKey];
  if (!db) return {};
  const out = {};
  for (const [tableName, table] of Object.entries(db.tables)) {
    const cols = {};
    for (const [colName, col] of Object.entries(table.columns)) {
      const entry = { type: col.type };
      if (col.primary_key) entry.pk = true;
      if (col.fk) entry.fk = col.fk;
      if (col.enum) entry.enum = col.enum;
      if (col.polymorphic_type) entry.poly_type = true;
      if (col.polymorphic_id) entry.poly_id = true;
      if (col.soft_delete) entry.soft_delete = true;
      // Preserve notes for domain context (FK targets, business meaning).
      if (col.notes) entry.notes = col.notes;
      cols[colName] = entry;
    }
    out[tableName] = cols;
  }
  return out;
}

const SYSTEM_PROMPT_HEAD = `You are an expert PostgreSQL query writer for the MyBillBook (Flo-Invoice) Rails app database. You deeply understand the business domain and can reason through complex questions.

== DOMAIN KNOWLEDGE (use this to interpret user questions) ==

MyBillBook is an Indian invoicing/billing app for SMBs. Key domain concepts:

COMPANIES TABLE (dual-purpose — THE most important concept):
- companies with company_contact_type=0 (user) are BUSINESS ENTITIES (the actual companies using the app).
- companies with company_contact_type=1 (customer) or 2 (supplier) are CONTACTS/PARTIES that belong to a business via company_id FK.
- When users say "companies" they usually mean business entities (company_contact_type=0).
- When users say "parties/customers/suppliers" they mean contacts (company_contact_type=1 or 2).
- A "contact" is a Company row with belongs_to :company (parent business).

INVOICES & VOUCHERS:
- invoices: sales_invoice=0, purchase_record=1, quotation=2, credit_note=3, debit_note=4, delivery_challan=5, purchase_order=6, proforma=7, credit_memo=8, debit_memo=9.
- Each Invoice has one Voucher (polymorphic via voucherable). Voucher stores the voucher_type, serial_number, payment info.
- Payment ↔ Invoice linked via payment_records join table.
- "payment_type" on invoices means cash=1 or credit=0 (payment terms), NOT payment direction.

ITEMS & INVENTORY:
- inventory_items: master catalog items (the "product"). Has unit (integer FK to units table), quantity (current stock), item_category_id.
- items: line items on invoices (polymorphic via itemable). Each invoice line item points to an inventory_item_id.
- sub_inventory_items: batches/variants of an inventory_item. Has conversion_factor (unit conversion ratio), quantity, batch number, expiry date.
- item_unit_conversions: defines how to convert between units for a specific inventory item. Has base_unit_id, target_unit_id, conversion_factor, inventory_item_id.
- item_infos: pricing info (sales price, purchase price, GST) for inventory items. Polymorphic via infoable. info_type: sales=0, purchase=1, credit_note=2, debit_note=3, wholesale=4.
- units: unit definitions (id, unit_long like "METERS", unit_short like "MTR").

LEDGERS & ACCOUNTING:
- ledgers: expense/income accounts. ledger_categories organize them (expense=0, asset=1, income=2, liability=3, party=4).
- txn_ledgers: transaction-level ledger entries on vouchers. Contains GST breakup (sgst, cgst, igst), quantities, prices.
- vouchers: the accounting wrapper for invoices/payments. Has voucher_type matching VOUCHER_TYPES constant.

USERS & ACCESS:
- users connect to companies via roles (join table). role_type: admin, accountant, partner, etc.
- subscriptions belong to users (NOT companies). subscription_type: trial=0, lite=1, standard=2, silver=3, gold=4, diamond=5, platinum=6, enterprise=7.
- login_activities: tracks login events. login_type: web=0, mobile=1, desktop=2, ios=3, tally=4.

PAYMENTS & BANKING:
- payments: standalone payment_in=0 or payment_out=1 records. payment_mode: cash=0, cheque=1, online=2, bank=3, upi=4, card=5, netbanking=6.
- bank_accounts: linked bank accounts. bank_account_type: bank_account=0, upi=1.
- wallets: stores opening_balance, closing_balance, credit_limit, credit_period for contacts.
- mbb_pay_transactions: MBB Pay collection transactions.

BUSINESS_TYPES (combined enum on companies.business_type):
- Single: retailer=0, wholesaler=1, distributor=2, manufacturer=3.
- Combined: retailer_wholesaler=4, ... retailer_wholesaler_distributor_manufacturer_services=30.
- To find "companies with N businesses", count how many base types (retailer, wholesaler, distributor, manufacturer, services) appear in the business_type string using LIKE '%type%' pattern matching.

GODOWNS (warehouses):
- godowns: warehouse locations. godown_links: maps inventory items to godowns with quantities. godown_transactions: stock movements per godown.

OTHER:
- All monetary values are decimal. All IDs are UUID.
- Soft deletes via deleted_at (acts_as_paranoid). ~66 tables use it.
- additional_fields (jsonb) on inventory_items stores custom metadata like tallyid.
- contact_items: maps specific pricing/config per contact per inventory item.

== REASONING INSTRUCTIONS ==

When a question seems ambiguous or complex:
1. THINK about which tables contain the data the user is asking about. Map user language to table/column names.
2. TRACE the join path: identify FKs that connect the needed tables.
3. If the user uses a business term (e.g. "conversion factor", "sub-item", "party"), MAP it to the schema using the domain knowledge above.
4. If a column name doesn't exist but a related concept does, USE the closest matching column/table.
5. If the question mentions "like this user" or "for 200 users", they want data filtered/grouped by user or company context — use JOINs through roles or direct company_id FKs.
6. When the question asks about BOTH items and sub-items, query BOTH inventory_items and sub_inventory_items tables (UNION or separate columns).
7. NEVER decline with CANNOT_ANSWER if there is ANY reasonable interpretation that maps to existing tables/columns. Prefer a best-effort query over declining.

== HARD RULES ==

1. Output ONLY the SQL query. No explanation, no markdown fences, no trailing prose.
2. Use ONLY tables and columns listed in the schema JSON below. Do NOT invent or guess. Use "-- CANNOT_ANSWER: <reason>" ONLY as an absolute last resort when you are certain no combination of listed tables/columns could possibly answer the question — e.g. the user asks about a completely unrelated system.
3. KEEP QUERIES SHORT AND MINIMAL. Select ONLY the columns the user actually asked about — typically 2-4 columns (usually id + name + the filter attribute). NEVER enumerate every column on a table. NEVER SELECT *. If the user says "companies with silver plan", return \`SELECT c.id, c.name FROM ...\`, not all 25 columns.
4. Use the SIMPLEST join path that works. Prefer direct FKs over multi-hop traversals. If a table has a direct FK to what you need (e.g. subscriptions.company_id), use it directly — don't route through roles/users unless the user explicitly asks about user-level data.
5. Enum columns store INTEGERS. Every enum column's JSON entry has an "enum" field mapping symbol -> integer. Use the integer in WHERE clauses. Translate user language to the integer (e.g. "silver plan" -> subscription_type=3, "customer" -> company_contact_type=1).
6. For every table with \`soft_delete: true\`, add \`<alias>.deleted_at IS NULL\` unless the user asks for deleted rows.
7. The \`companies\` table is dual-purpose (see DOMAIN KNOWLEDGE above).
8. snake_case, lowercase. Short aliases. Explicit JOINs. End with a semicolon.
9. FORMAT across multiple lines: each SELECT column on its own indented line, each FROM/JOIN/WHERE/GROUP BY/ORDER BY/LIMIT on its own line, ON clause indented under its JOIN, each AND/OR on its own indented line. Do NOT output one long line.

CONVERSATION CONTEXT: The user may send follow-ups ("now group by month", "that errored — fix it"). Treat the message history as the thread. When they paste a Postgres error, diagnose it against the schema and emit corrected SQL.

If the request is ambiguous (e.g. no company_id), use :company_id as a placeholder.

Schema JSON (authoritative — nothing outside this exists):
`;

export function buildSystemPrompt(schema, dbKey) {
  return SYSTEM_PROMPT_HEAD + "\n" + JSON.stringify(compactSchema(schema, dbKey));
}

export function extractSql(text) {
  if (!text) return "";
  let t = text.trim();
  t = t.replace(/^```(?:sql|postgres|postgresql)?\s*\n?/i, "");
  t = t.replace(/\n?```\s*$/, "");
  t = t.trim();
  // Safety-net reformat: if the model returned single-line SQL anyway,
  // break at clause boundaries so it renders cleanly. We only do this
  // when the SQL is already one logical line (<= 2 newlines) so we don't
  // mess up already well-formatted output.
  const lineCount = t.split("\n").length;
  if (lineCount <= 2 && t.length > 80) {
    t = reformatSql(t);
  }
  return t;
}

function reformatSql(sql) {
  // Break at top-level clause keywords in a SINGLE pass so multi-word
  // clauses (LEFT JOIN, GROUP BY) aren't split across lines. Alternation
  // order matters — put longer variants first.
  const CLAUSE_RE =
    /\s+(LEFT\s+OUTER\s+JOIN|RIGHT\s+OUTER\s+JOIN|FULL\s+OUTER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN|FULL\s+JOIN|CROSS\s+JOIN|JOIN|GROUP\s+BY|ORDER\s+BY|UNION\s+ALL|SELECT|FROM|WHERE|HAVING|LIMIT|OFFSET|UNION|INTERSECT|EXCEPT|RETURNING|ON)\b/gi;
  const normalize = (kw) => kw.replace(/\s+/g, " ").toUpperCase();
  let out = sql.replace(CLAUSE_RE, (_m, kw) => `\n${normalize(kw)}`);

  // Indent after SELECT: each column on its own line, 2-space indent.
  const finalLines = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (/^SELECT\b/i.test(trimmed)) {
      const body = trimmed.replace(/^SELECT\s*/i, "");
      if (body) {
        const parts = splitTopLevel(body, ",");
        finalLines.push("SELECT");
        parts.forEach((p, i) => {
          finalLines.push("  " + p.trim() + (i < parts.length - 1 ? "," : ""));
        });
      } else {
        finalLines.push("SELECT");
      }
    } else if (/^ON\b/i.test(trimmed)) {
      // ON goes under the JOIN with extra indent for readability.
      finalLines.push("  " + trimmed);
    } else if (/^WHERE\b/i.test(trimmed)) {
      // Break AND / OR in WHERE onto indented lines.
      const body = trimmed.replace(/^WHERE\s*/i, "");
      const parts = body.split(/\s+(AND|OR)\s+/i);
      finalLines.push("WHERE " + (parts[0] || "").trim());
      for (let i = 1; i < parts.length; i += 2) {
        finalLines.push("  " + parts[i].toUpperCase() + " " + (parts[i + 1] || "").trim());
      }
    } else {
      finalLines.push(trimmed);
    }
  }
  return finalLines.filter((l) => l !== "").join("\n").trim();
}

function splitTopLevel(s, sep) {
  const out = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === sep && depth === 0) {
      out.push(s.slice(last, i));
      last = i + 1;
    }
  }
  out.push(s.slice(last));
  return out;
}

// --- public entry points ---------------------------------------------------

// Generate SQL from a multi-turn conversation. `messages` is an array of
// { role: 'user' | 'assistant', content: string }. The provider adapters
// translate this into whatever shape their API needs.
export async function generateFromConversation({
  provider,
  apiKey,
  model,
  baseUrl,
  systemText,
  messages,
  temperature = 0.1,
}) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown provider: ${provider}`);
  const raw = await p.call({ apiKey, model, baseUrl, systemText, messages, temperature });
  return extractSql(raw);
}

export async function listProviderModels({ provider, apiKey, baseUrl }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown provider: ${provider}`);
  if (!p.listModels) return p.fallbackSuggestions;
  return p.listModels({ apiKey, baseUrl });
}

// --- provider implementations: call() --------------------------------------

async function callGemini({ apiKey, model, systemText, messages, temperature }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;
  // Gemini uses role "user" / "model" (not "assistant").
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents,
    generationConfig: { temperature, topP: 0.9, maxOutputTokens: 2048 },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 500)}`);
  }
  const json = await res.json();
  return json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

function callOpenAICompatible(baseUrlFixed) {
  return async function ({ apiKey, model, systemText, messages, temperature }) {
    const res = await fetch(`${baseUrlFixed}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature,
        messages: [{ role: "system", content: systemText }, ...messages],
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`API error ${res.status}: ${errText.slice(0, 500)}`);
    }
    const json = await res.json();
    return json?.choices?.[0]?.message?.content ?? "";
  };
}

async function callOpenAICompatibleCustom({ apiKey, model, baseUrl, systemText, messages, temperature }) {
  const url = (baseUrl || "").replace(/\/+$/, "");
  if (!url) throw new Error("Custom provider needs a base URL (Settings).");
  if (!model) throw new Error("Custom provider needs a model name (Settings).");
  return callOpenAICompatible(url)({ apiKey, model, systemText, messages, temperature });
}

async function callAnthropic({ apiKey, model, systemText, messages, temperature }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      temperature,
      system: systemText,
      messages,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errText.slice(0, 500)}`);
  }
  const json = await res.json();
  const parts = json?.content || [];
  return parts.map((p) => p.text || "").join("");
}

// --- provider implementations: listModels ---------------------------------

// Sort so newer/likely-more-capable models surface first. This is purely
// cosmetic — every returned model stays in the list.
function sortByVersionDesc(models) {
  return models.sort((a, b) => {
    // Extract a comparable version key: collapse numbers so "3" > "2.5" > "2".
    const score = (id) => {
      // Prefer flash-lite > flash > pro ordering per version, but newest first.
      let s = 0;
      const m = id.match(/(\d+)(?:\.(\d+))?/);
      if (m) s = parseInt(m[1]) * 100 + parseInt(m[2] || 0);
      return s;
    };
    const d = score(b) - score(a);
    return d !== 0 ? d : b.localeCompare(a);
  });
}

async function listGeminiModels({ apiKey }) {
  // Paginate via pageToken. Don't filter — return every model the account
  // can see. The UI already surfaces them via a datalist; the user picks.
  const all = [];
  let pageToken = "";
  // Hard cap at 20 pages to avoid runaway on a misbehaving API.
  for (let i = 0; i < 20; i++) {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Gemini list-models ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const json = await res.json();
    for (const m of json.models || []) {
      const id = (m.name || "").replace(/^models\//, "");
      if (!id) continue;
      // Keep only models that expose a generation method — excludes embedding,
      // tts, and retrieval endpoints. If the `supportedGenerationMethods`
      // field is missing (newer preview models sometimes omit it), include.
      const methods = m.supportedGenerationMethods;
      if (
        !methods ||
        methods.length === 0 ||
        methods.some((x) => /generateContent|generateAnswer|chat/i.test(x))
      ) {
        all.push(id);
      }
    }
    pageToken = json.nextPageToken || "";
    if (!pageToken) break;
  }
  return sortByVersionDesc([...new Set(all)]);
}

function listOpenAIModels(baseUrlFixed) {
  return async function ({ apiKey }) {
    // OpenAI's /v1/models isn't paginated per se, but the response can still
    // be large. OpenRouter responds with the full catalog in one shot.
    const res = await fetch(`${baseUrlFixed}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`List-models ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    const ids = (json.data || []).map((m) => m.id).filter(Boolean);

    // Only filter when we're sure we can — drop embedding/audio/image models
    // from OpenAI proper. For OpenRouter and custom endpoints, don't guess
    // (they host arbitrary models).
    let filtered = ids;
    if (baseUrlFixed.includes("api.openai.com")) {
      const excludePat = /embedding|tts|whisper|dall-e|image|moderation/i;
      filtered = ids.filter((id) => !excludePat.test(id));
    }
    return sortByVersionDesc([...new Set(filtered)]);
  };
}

async function listAnthropicModels({ apiKey }) {
  // Anthropic's models endpoint is cursor-paginated. Walk all pages.
  const all = [];
  let afterId = "";
  for (let i = 0; i < 20; i++) {
    const url = new URL("https://api.anthropic.com/v1/models");
    url.searchParams.set("limit", "1000");
    if (afterId) url.searchParams.set("after_id", afterId);
    const res = await fetch(url.toString(), {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
    });
    if (!res.ok) throw new Error(`Anthropic list-models ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    for (const m of json.data || []) if (m.id) all.push(m.id);
    if (!json.has_more || !json.last_id) break;
    afterId = json.last_id;
  }
  return sortByVersionDesc([...new Set(all)]);
}
