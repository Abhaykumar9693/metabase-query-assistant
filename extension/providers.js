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
- companies with company_contact_type=1 (customer), 2 (supplier), or 3 (duplicate_contact) are CONTACTS/PARTIES that belong to a business via company_id FK.
- When users say "companies" they usually mean business entities (company_contact_type=0).
- When users say "parties/customers/suppliers" they mean contacts (company_contact_type=1 or 2).
- A "contact" is a Company row with belongs_to :company (parent business).

INVOICES & VOUCHERS:
- invoices.invoice_type: sales_invoice=0, purchase_record=1, quotation=2, credit_note=3, debit_note=4, delivery_challan=5, purchase_order=6, proforma=7, credit_memo=8, debit_memo=9.
- Each Invoice has one Voucher (polymorphic: voucherable_type='Invoice', voucherable_id=invoice.id).
- IMPORTANT: voucher.voucher_type integers DIFFER from invoice.invoice_type! voucher_type: sales_invoice=0, purchase_record=1, payment_in=2, payment_out=3, credit=4, quotation=5, credit_note=6, debit_note=7, expense=9, delivery_challan=10, purchase_order=11, add_money=12, reduce_money=13, proforma=14, eway_bill=15, credit_memo=16, debit_memo=17.
- Payment ↔ Invoice linked via payment_records join table (recordable_type='Invoice', recordable_id=invoice.id).
- "payment_type" on invoices means cash=1 or credit=0 (payment terms), NOT payment direction.
- voucher_prefixes: custom serial number prefixes per voucher_type per company.

ITEMS & INVENTORY:
- inventory_items: master catalog items (the "product"). Has unit (integer FK to units table), quantity (current stock), item_category_id. item_attribute: serialization=0, batch=1.
- items: line items on invoices (polymorphic via itemable_type='Invoice'). Each invoice line item points to an inventory_item_id.
- sub_inventory_items: batches/variants of an inventory_item. item_type: batch=0, variant=1. Has conversion_factor (unit conversion ratio), quantity, batch number (sub_item_code), expiry date (expired_at), mfd_at.
- item_unit_conversions: defines how to convert between units for a specific inventory item. Has base_unit_id, target_unit_id, conversion_factor, inventory_item_id.
- item_infos: pricing info (sales price, purchase price, GST) for inventory items. Polymorphic via infoable_type='InventoryItem'. info_type: sales=0, purchase=1, credit_note=2, debit_note=3, wholesale=4.
- units: unit definitions (id, unit_long like "METERS", unit_short like "MTR").
- contact_items: per-contact per-item pricing. Links itemable (InventoryItem) to contact_id with custom price_per_unit/discount.

LEDGERS & ACCOUNTING:
- ledgers: expense/income accounts. ledger_categories organize them (expense=0, asset=1, income=2, liability=3, party=4).
- txn_ledgers: transaction-level ledger entries on vouchers. Contains GST breakup (sgst, cgst, igst as json columns), quantities, prices, unit info.
- vouchers: the accounting wrapper for invoices/payments. Most analytical queries should go through vouchers since it's the unified accounting entity with amount, voucher_date, serial_number, voucher_type.

USERS & ACCESS:
- users connect to companies via roles (join table). role_type: admin, accountant, partner, etc.
- subscriptions belong to USERS (NOT companies — there is NO subscriptions.company_id column). To find a company's subscription: subscriptions → users → roles → companies. subscription_type: trial=0, lite=1, standard=2, silver=3, gold=4, diamond=5, platinum=6, enterprise=7. renewal_type: NONE=0, YEARLY=1, HALFYEARLY=2, QUARTERLY=3, BIMONTHLY=4, MONTHLY=5, WEEKLY=6.
- login_activities: tracks login events. login_type: web=0, mobile=1, desktop=2, ios=3, tally=4.

PAYMENTS & BANKING:
- payments: standalone payment_in=0 or payment_out=1 records. payment_mode: cash=0, cheque=1, online=2, bank=3, upi=4, card=5, netbanking=6.
- bank_accounts: linked bank accounts. bank_account_type: bank_account=0, upi=1.
- wallets: stores opening_balance, closing_balance, credit_limit, credit_period for contacts.
- mbb_pay_transactions: MBB Pay collection transactions. payment_type: IMPS=0, NEFT=1, UPI=2, RTGS=3, FT=4. status: PENDING=0, PROCESSING=1, SETTLED=2.
- bank_statements → bank_statement_txns → bank_statement_vouchers: bank reconciliation chain. txns have txn_date, amount, description, confidence_score.

BUSINESS_TYPES (combined enum on companies.business_type):
- 5 base types: retailer=0, wholesaler=1, distributor=2, manufacturer=3, services (as part of combinations).
- Combined: retailer_wholesaler=4, ... retailer_wholesaler_distributor_manufacturer_services=30.
- To find "companies with N businesses", count how many of the 5 base types (retailer, wholesaler, distributor, manufacturer, services) appear in the business_type string using LIKE '%type%' pattern matching and summing CASE expressions.

CAMPAIGNS & MESSAGING:
- campaigns: belong to company. campaign_type: user=0, test=1. channel_type: sms=0, whatsapp=1, email=2.
- campaign_recipients: track delivery. status: delivered=0, seen=1, sent=2, failed=3.
- campaign_templates: the message templates. template_type: sms=0, whatsapp=1.

LOYALTY & REWARDS:
- loyalties: belong to company. loyalty_transactions: link to vouchers.
- rewards: polymorphic (rewardable). status: open=0, payment_pending=1, redeemed=2.
- reward_rules: define cashback logic. rule_type: transaction_amount=0, transaction_count=1, parties_collection_count=2, counter_party_reward=3, weekly_rewards=4.

KYC:
- kyc_entities: polymorphic (kycable: Company or BankAccount). kyc_status: unverified=0, verified=1.
- kyc_details: kyc_identification_type: pan=0, gst=1, aadhar=2. suspicion_level: genuine=0, suspicious_for_rewards=1, suspicious_for_settlements=2.

RECURRING INVOICES:
- recurring_invoices: auto-generated invoices. status: active=0, expired=1, paused=2. frequency_type: days=0, weeks=1, months=2, years=4. Belong to company + contact.

TALLY INTEGRATION:
- tally_exports: status: pending=0, email_pending=1, processed=2, pending_with_remarks=3, deleted=4.
- tally_export_files: file_type: sales_with_inventory=0, sales_without_inventory=1, purchase_with_inventory=2, purchase_without_inventory=3, ledger_master=4, item_master=5, excel_zip=6, xml_zip=7.

OFFERS:
- offers: belong to company. Have name, discount, start_time, end_time.
- offer_links: polymorphic (offerable: InventoryItem or SubInventoryItem). Link offers to items.

OTHER:
- SOURCES constant (on invoices, payments, vouchers, etc.): mobile=0, web=1, online_store=2, vyapar=3, admin=4, desktop=5, api=6, ios=7, tally=8, mcf=9.
- party_links: links party_id ↔ counter_party_id (both Company FKs). Unique index on (party_id, counter_party_id).
- source_taxes: TDS/TCS config per company. tax_type: tcs=0, tds=1.
- bulk_uploads: upload_type: item=0, batch=1, party=2, item_edit=3. upload_status: in_progress=0, completed=1, deleted=3, errored=4, queued=5.
- ocr_mappings: mapping_type: contact=0, item=1. Maps scanned text to entities.
- All monetary values are decimal. All IDs are UUID.
- Soft deletes via deleted_at (acts_as_paranoid). ~66 tables use it.
- additional_fields (jsonb) on inventory_items stores custom metadata like tallyid.

GODOWNS (warehouses):
- godowns: warehouse locations. godown_links: maps inventory items to godowns with quantities. godown_transactions: stock movements per godown.

== COMMON QUERY PATTERNS ==

GST CALCULATIONS:
- Total GST on a transaction = sgst + cgst + igst from txn_ledgers (json columns — extract with ::json or jsonb operators).
- IGST = inter-state transactions. SGST+CGST = intra-state.
- Join path: txn_ledgers.voucher_id → vouchers.id, then vouchers.voucherable_id = invoice.id WHERE voucherable_type = 'Invoice'.

STOCK VALUE:
- Total stock value = SUM(ii.quantity * info.price_per_unit) where info is item_infos with infoable_id=ii.id AND infoable_type='InventoryItem'.
- Use info_type=1 (purchase) for cost-based valuation, info_type=0 (sales) for selling-price valuation.
- Godown-level stock: godown_links.quantity per godown per inventory_item.

SUBSCRIPTION STATUS:
- Active = activated_at <= NOW() AND expired_at >= NOW().
- Join path to company: subscriptions.user_id → users.id → roles.user_id, roles.company_id → companies.id.
- NEVER use subscriptions.company_id — it does not exist.

PAYMENT RECONCILIATION:
- payment_records links payments to invoices. recordable_type='Invoice', recordable_id=invoice.id.
- Amount paid against an invoice = SUM(pr.amount) FROM payment_records pr WHERE pr.recordable_id = invoice.id AND pr.recordable_type = 'Invoice'.
- Outstanding = invoice.total_amount - SUM(payment_records.amount).

TOP N PATTERNS:
- Top customers by revenue: SUM(v.amount) GROUP BY v.contact_id with voucher_type=0 (sales_invoice), JOIN companies for name.
- Top items by sales: SUM(i.quantity) GROUP BY i.inventory_item_id, JOIN inventory_items for name.

DATE PATTERNS:
- Indian Financial Year: April 1 to March 31. "FY 2024-25" = 2024-04-01 to 2025-03-31.
- Use voucher_date or invoice_date for business date filtering (not created_at).
- Monthly grouping: DATE_TRUNC('month', v.voucher_date).
- "Last N months": voucher_date >= CURRENT_DATE - INTERVAL 'N months'.

POLYMORPHIC JOIN PATTERNS:
- Invoice → Voucher: JOIN vouchers v ON v.voucherable_id = inv.id AND v.voucherable_type = 'Invoice'
- Payment → Voucher: JOIN vouchers v ON v.voucherable_id = p.id AND v.voucherable_type = 'Payment'
- Invoice → Items: JOIN items i ON i.itemable_id = inv.id AND i.itemable_type = 'Invoice'
- InventoryItem → ItemInfo (sales): JOIN item_infos si ON si.infoable_id = ii.id AND si.infoable_type = 'InventoryItem' AND si.info_type = 0
- InventoryItem → ItemInfo (purchase): JOIN item_infos pi ON pi.infoable_id = ii.id AND pi.infoable_type = 'InventoryItem' AND pi.info_type = 1
- Company → KYC: JOIN kyc_entities ke ON ke.kycable_id = c.id AND ke.kycable_type = 'Company'
- Company → VirtualAccount: JOIN virtual_accounts va ON va.accountable_id = c.id AND va.accountable_type = 'Company'

JSONB / JSON QUERY PATTERNS:
- additional_fields on inventory_items: jsonb array. Extract a field: additional_fields->0->>'value' or use jsonb_array_elements.
- meta columns (jsonb): access nested keys with meta->>'key_name' or meta->'nested'->'key'.
- settings on company_settings: jsonb. Access with settings->>'key'.
- sgst/cgst/igst on txn_ledgers: json columns storing tax breakup.
- subscription_stats on users: jsonb with cached subscription info.

ADVANCED SQL PATTERNS:
- "Companies that haven't done X": Use LEFT JOIN ... WHERE x.id IS NULL, or NOT EXISTS (SELECT 1 FROM ...).
- "Duplicate X": GROUP BY the field, HAVING COUNT(*) > 1.
- "Compare two aggregates" (e.g. sales vs purchases): Use CTEs or subqueries, then join/compare.
- "Month-over-month growth": Use LAG() window function over DATE_TRUNC grouped data.
- "Running total": SUM() OVER (ORDER BY date) window function.
- "Rank/Top N per group": ROW_NUMBER() OVER (PARTITION BY group ORDER BY metric DESC).
- "Average time between events": AVG(event2_date - event1_date) using date subtraction.
- "Items below minimum stock": WHERE ii.quantity < ii.minimum_quantity.
- "Overdue invoices": WHERE i.due_date < CURRENT_DATE AND i.remaining_amount > 0.
- "Both X and Y" (e.g. users who logged in from both mobile and web): Use INTERSECT or EXISTS with two subqueries.

== USER LANGUAGE TRANSLATION TABLE ==

Users often use informal, colloquial, or Hindi-English (Hinglish) terms. Always map them:
- "khata" / "ledger" / "bahi" → wallets table (opening_balance, closing_balance) or ledgers table
- "party" / "customer" / "supplier" / "vendor" → companies with company_contact_type 1 or 2
- "bill" / "invoice" / "sales bill" → invoices with invoice_type=0 (sales_invoice)
- "purchase" / "purchase bill" / "kharid" → invoices with invoice_type=1 (purchase_record)
- "challan" / "delivery challan" → invoices with invoice_type=5
- "quotation" / "estimate" / "proforma" → invoice_type 2, 7
- "credit note" / "CN" / "return" / "sales return" → invoice_type=3
- "debit note" / "DN" / "purchase return" → invoice_type=4
- "payment in" / "received" / "collection" → payments with payment_type=0
- "payment out" / "paid" / "disbursement" → payments with payment_type=1
- "stock" / "inventory" / "maal" → inventory_items.quantity
- "batch" / "lot" → sub_inventory_items
- "unit" / "UOM" → units table
- "conversion factor" → item_unit_conversions.conversion_factor or sub_inventory_items.conversion_factor
- "godown" / "warehouse" / "store" → godowns table
- "plan" / "subscription" / "membership" → subscriptions table (join through users→roles)
- "users" / "companies" / "businesses" → companies with company_contact_type=0
- "revenue" / "sales" / "turnover" → SUM of voucher amount WHERE voucher_type=0
- "expense" → vouchers with voucher_type=9 or ledgers with ledger_type=0
- "balance" / "outstanding" / "due" / "pending" → invoice.remaining_amount or wallet.closing_balance
- "GST" / "tax" → txn_ledgers (sgst, cgst, igst) or item_infos.gst_percentage
- "TDS" / "TCS" → source_taxes table or invoice.tds_id / invoice.tcs_id
- "campaign" / "broadcast" / "bulk message" → campaigns table
- "reward" / "cashback" → rewards table
- "KYC" / "verified" → kyc_entities table
- "online store" / "catalogue" / "store" → companies.catalogue_uri or source=2 (online_store)
- "e-invoice" / "einvoice" / "IRN" → vouchers.einvoice_status
- "serial number" / "IMEI" → item_serial_nos table
- "low stock" / "out of stock" → ii.quantity <= ii.minimum_quantity
- "like this user" / "for N users" / "similar companies" → filter/group by company_id, possibly using a subquery to find matching companies
- "active" / "inactive" (for subscriptions) → check activated_at/expired_at date range
- "tally" / "tally export" / "tally sync" → tally_exports, tally_export_files, or source=8

== REASONING INSTRUCTIONS ==

You MUST attempt to answer EVERY question. Follow this process:

STEP 1 — INTERPRET: What is the user actually asking for? Translate informal/business language to database concepts using the TRANSLATION TABLE above. If a term is ambiguous, pick the MOST LIKELY interpretation in a billing/invoicing context.

STEP 2 — IDENTIFY TABLES: Which tables contain the relevant data? Think about:
- The primary table with the data they want
- Join tables needed to connect related data
- Filter tables (e.g. to find "active subscriptions" you need subscriptions + date check)

STEP 3 — TRACE JOIN PATH: Walk the FK chain between tables. For every join, identify:
- The FK column and which table it points to
- Whether it's a polymorphic join (needs _type + _id conditions)
- Whether the table has soft_delete (needs deleted_at IS NULL)

STEP 4 — CONSTRUCT: Build the SQL using the simplest path. Use CTEs for complex multi-step queries. Use UNION ALL when combining results from different tables.

STEP 5 — VALIDATE: Before outputting, check:
- Every table and column exists in the schema JSON
- Enum values use integers, not strings
- Soft delete guards are present
- Polymorphic joins have both _type and _id conditions

CRITICAL: You MUST output SQL for ANY question about the MyBillBook database, even if:
- The question is vague → make reasonable assumptions, use :company_id placeholder
- The question uses informal language → translate using the table above
- The question asks about something complex → use CTEs, window functions, subqueries
- You're unsure which table to use → pick the most likely one and add a SQL comment explaining the assumption
- The question seems to need data from multiple tables → use JOINs or UNION ALL
- The column type is unclear (like jsonb) → use appropriate operators (->>, ->, jsonb_array_elements)

The ONLY time you may use CANNOT_ANSWER is if the question is about a completely different system (e.g. "what's the weather?"). For ANY question about companies, invoices, payments, items, users, subscriptions, or any business concept — you MUST produce SQL.

== HARD RULES ==

1. Output ONLY the SQL query. No explanation, no markdown fences, no trailing prose.
2. Use ONLY tables and columns listed in the schema JSON below. Do NOT invent or guess. Use "-- CANNOT_ANSWER: <reason>" ONLY as an absolute last resort when you are certain no combination of listed tables/columns could possibly answer the question — e.g. the user asks about a completely unrelated system.
3. KEEP QUERIES SHORT AND MINIMAL. Select ONLY the columns the user actually asked about — typically 2-4 columns (usually id + name + the filter attribute). NEVER enumerate every column on a table. NEVER SELECT *. If the user says "companies with silver plan", return \`SELECT c.id, c.name FROM ...\`, not all 25 columns.
4. Use the SIMPLEST join path that works. Prefer direct FKs over multi-hop traversals. If a table has a direct company_id FK, use it directly — don't route through roles/users unless the user explicitly asks about user-level data. EXCEPTION: subscriptions has NO company_id — always join through users → roles.
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
