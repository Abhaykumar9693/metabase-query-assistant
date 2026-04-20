#!/usr/bin/env node
// Parses DATABASE_SCHEMA_REFERENCE.md → extension/schema.json
// The .md is the single source of truth. Everything the extension
// emits MUST resolve against the output of this parser.

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SRC = process.argv[2] || "/Users/vairagi/Downloads/DATABASE_SCHEMA_REFERENCE (1).md";
const OUT = resolve(__dirname, "../extension/schema.json");

const raw = readFileSync(SRC, "utf8");
const sha256 = createHash("sha256").update(raw).digest("hex").slice(0, 12);
const lines = raw.split("\n");

// --- helpers ---------------------------------------------------------------

const stripBackticks = (s) => s.replace(/`/g, "").trim();

// Parses "enum: name=0, name2=1, ..." → { name: 0, name2: 1 }
// Handles quoted keys: "payout_link.issued"=0
function parseInlineEnum(notes) {
  const m = notes.match(/enum:\s*(.+?)(?:\s*$|,\s*default:|,\s*not null|\s*—)/);
  if (!m) return null;
  const body = m[1];
  const out = {};
  const pairRe = /"([^"]+)"\s*=\s*(-?\d+)|([A-Za-z_][\w.]*)\s*=\s*(-?\d+)/g;
  let match;
  while ((match = pairRe.exec(body)) !== null) {
    const key = match[1] || match[3];
    const val = parseInt(match[2] || match[4], 10);
    if (key) out[key] = val;
  }
  return Object.keys(out).length ? out : null;
}

// Parses "enum (SOURCES constant — see Section 5)" → "SOURCES"
function parseEnumRef(notes) {
  const m = notes.match(/enum\s*\(([A-Z_][A-Z0-9_]*)\s*constant/);
  if (m) return m[1];
  const m2 = notes.match(/enum\s+\(([A-Z_][A-Z0-9_]*)\)/);
  return m2 ? m2[1] : null;
}

// Parses "FK→companies" / "FK→companies (contact)" / "FK→users (self-ref)"
function parseFk(notes) {
  const m = notes.match(/FK→\s*([a-z_]+)(?:\s*\(([^)]+)\))?/);
  if (!m) return null;
  return { table: m[1], note: (m[2] || "").trim() || null };
}

function parseDefault(notes) {
  const m = notes.match(/default:\s*([^|,]+?)(?:\s*,|\s*$)/);
  return m ? m[1].trim() : null;
}

function isMarkdownSeparator(line) {
  return /^\|[\s-|]+\|\s*$/.test(line);
}

function isColumnHeader(line) {
  return /^\|\s*Column\s*\|\s*Type\s*\|\s*Notes\s*\|/i.test(line);
}

function splitRow(line) {
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((s) => s.trim());
  return cells;
}

// --- parse tables (Section 3) ---------------------------------------------

const tables = {}; // name -> {columns, phonepe}

let currentSection = null;
let currentTable = null;
let inColumnTable = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  // Section marker (## N. ...)
  const secM = line.match(/^##\s+(\d+)\./);
  if (secM) {
    currentSection = parseInt(secM[1], 10);
    currentTable = null;
    inColumnTable = false;
    continue;
  }

  // Table heading (### table_name or ### PhonePe DB: table)
  const tblM = line.match(/^###\s+(?:PhonePe DB:\s*)?([a-z_][a-z0-9_]*)\s*(?:\(PaperTrail\))?\s*$/i);
  if (tblM && currentSection === 3) {
    const name = tblM[1].toLowerCase();
    const isPhonepe = /PhonePe DB:/i.test(line);
    tables[name] = { name, phonepe: isPhonepe, columns: {} };
    currentTable = tables[name];
    inColumnTable = false;
    continue;
  }

  // Horizontal rule ends any current table
  if (line.startsWith("---")) {
    currentTable = null;
    inColumnTable = false;
    continue;
  }

  if (!currentTable) continue;

  if (isColumnHeader(line)) {
    inColumnTable = true;
    continue;
  }
  if (isMarkdownSeparator(line)) continue;
  if (!inColumnTable) continue;
  if (!line.startsWith("|")) {
    inColumnTable = false;
    continue;
  }

  const cells = splitRow(line);
  if (cells.length < 2) continue;
  let [colName, colType, notes = ""] = cells;
  colName = stripBackticks(colName);

  // Skip rows that are actually index annotations inside the table
  if (/^\*\*Index/i.test(colName) || /^\*\*Unique Index/i.test(colName)) continue;
  if (!colName || colName.startsWith("*")) continue;

  // Handle "created_at/updated_at" style combined rows
  const names = colName.split("/").map((s) => s.trim()).filter(Boolean);
  for (const n of names) {
    const col = {
      type: colType || null,
      notes: notes || "",
    };
    if (/\bPK\b/.test(notes)) col.primary_key = true;
    if (/\bindexed\b/.test(notes)) col.indexed = true;
    if (/soft delete/i.test(notes)) col.soft_delete = true;
    if (/not null/i.test(notes)) col.not_null = true;
    if (/polymorphic type/i.test(notes)) col.polymorphic_type = true;
    if (/polymorphic FK/i.test(notes)) col.polymorphic_id = true;
    const fk = parseFk(notes);
    if (fk) col.fk = fk;
    const inlineEnum = parseInlineEnum(notes);
    if (inlineEnum) col.enum = inlineEnum;
    const enumRef = parseEnumRef(notes);
    if (enumRef) col.enum_ref = enumRef;
    const def = parseDefault(notes);
    if (def !== null) col.default = def;

    currentTable.columns[n] = col;
  }
}

// --- parse Section 4: explicit enum definitions ---------------------------
// Format:
//   **ModelName.column_name**
//   | Value | Integer |
//   |---|---|
//   | amount | 0 |
//
// Some headers list multiple columns: **BankAccount.suspicion_level / KycDetail.suspicion_level**

const modelColumnEnums = {}; // "modelname.column" -> {name: int}
{
  let i = 0;
  // Find section 4
  const sec4 = lines.findIndex((l) => /^##\s+4\./.test(l));
  const sec5 = lines.findIndex((l) => /^##\s+5\./.test(l));
  if (sec4 !== -1 && sec5 !== -1) {
    for (i = sec4; i < sec5; i++) {
      const line = lines[i];
      const hdr = line.match(/^\*\*(.+?)\*\*\s*$/);
      if (!hdr) continue;
      const targets = hdr[1]
        .split("/")
        .map((s) => s.trim())
        .filter((s) => /^[A-Z][A-Za-z]+\.[a-z_][a-z0-9_]*$/.test(s));
      if (!targets.length) continue;

      // Walk forward: find "| Value | Integer |" header, then parse rows
      let j = i + 1;
      while (j < sec5 && !/^\|\s*Value\s*\|\s*Integer/i.test(lines[j])) j++;
      if (j >= sec5) continue;
      j += 2; // skip header + separator
      const vals = {};
      while (j < sec5 && lines[j].startsWith("|")) {
        const cells = splitRow(lines[j]);
        if (cells.length >= 2) {
          const k = stripBackticks(cells[0]);
          const v = parseInt(cells[1], 10);
          if (k && Number.isFinite(v)) vals[k] = v;
        }
        j++;
      }
      for (const t of targets) {
        modelColumnEnums[t.toLowerCase()] = vals;
      }
    }
  }
}

// --- parse Section 5: shared constants ------------------------------------
const constants = {};
{
  const sec5 = lines.findIndex((l) => /^##\s+5\./.test(l));
  const sec6 = lines.findIndex((l) => /^##\s+6\./.test(l));
  if (sec5 !== -1 && sec6 !== -1) {
    for (let i = sec5; i < sec6; i++) {
      const m = lines[i].match(/^###\s+([A-Z_][A-Z0-9_]*)/);
      if (!m) continue;
      const name = m[1];
      let j = i + 1;
      while (j < sec6 && !/^\|\s*Value\s*\|\s*Integer/i.test(lines[j])) {
        // give up if we hit another ### or ---
        if (/^###\s+/.test(lines[j]) || /^---/.test(lines[j])) break;
        j++;
      }
      if (j >= sec6 || !/^\|\s*Value\s*\|\s*Integer/i.test(lines[j])) continue;
      j += 2;
      const vals = {};
      while (j < sec6 && lines[j].startsWith("|")) {
        const cells = splitRow(lines[j]);
        if (cells.length >= 2 && !cells[0].includes("...")) {
          const k = stripBackticks(cells[0]);
          const v = parseInt(cells[1], 10);
          if (k && Number.isFinite(v)) vals[k] = v;
        }
        j++;
      }
      if (Object.keys(vals).length) constants[name] = vals;
    }
  }
}

// --- parse Section 7: polymorphic associations ----------------------------
const polymorphic = {}; // name -> { owner, types: [...] }
{
  const sec7 = lines.findIndex((l) => /^##\s+7\./.test(l));
  const sec8 = lines.findIndex((l) => /^##\s+8\./.test(l));
  if (sec7 !== -1 && sec8 !== -1) {
    for (let i = sec7; i < sec8; i++) {
      const line = lines[i];
      if (!line.startsWith("|")) continue;
      if (/^\|\s*Polymorphic Name/i.test(line)) continue;
      if (isMarkdownSeparator(line)) continue;
      const cells = splitRow(line);
      if (cells.length < 3) continue;
      const rawName = stripBackticks(cells[0]).replace(/\s*\(.+\)$/, "");
      const owner = cells[1];
      const types = cells[2]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!rawName) continue;
      polymorphic[rawName] = { owner, types };
    }
  }
}

// --- cross-link: attach enum_ref / modelColumnEnums into columns ----------
// If a column has enum_ref (e.g., SOURCES), resolve to the constant's values
// so the extension doesn't have to. Keep the raw ref too.
for (const tbl of Object.values(tables)) {
  // Rails model name from table: singularize + PascalCase. We do the common cases.
  const modelName = railsModelName(tbl.name);
  for (const [colName, col] of Object.entries(tbl.columns)) {
    if (col.enum_ref && constants[col.enum_ref] && !col.enum) {
      col.enum = constants[col.enum_ref];
    }
    const key = `${modelName}.${colName}`.toLowerCase();
    if (!col.enum && modelColumnEnums[key]) {
      col.enum = modelColumnEnums[key];
    }
  }
}

function railsModelName(tableName) {
  // minimal singularizer for the tables we care about
  const irregulars = {
    companies: "Company",
    addresses: "Address",
    categories: "Category",
    ledger_categories: "LedgerCategory",
    item_categories: "ItemCategory",
    campaign_templates_categories: "CampaignTemplatesCategory",
    campaign_templates: "CampaignTemplate",
    campaign_recipients: "CampaignRecipient",
    item_infos: "ItemInfo",
    item_serial_nos: "ItemSerialNo",
    item_unit_conversions: "ItemUnitConversion",
    sub_inventory_items: "SubInventoryItem",
    inventory_items: "InventoryItem",
    inventory_txns: "InventoryTxn",
    bank_accounts: "BankAccount",
    bank_statements: "BankStatement",
    bank_statement_txns: "BankStatementTxn",
    bank_statement_vouchers: "BankStatementVoucher",
    mbb_pay_transactions: "MbbPayTransaction",
    mbb_pay_settlements: "MbbPaySettlement",
    virtual_accounts: "VirtualAccount",
    voucher_prefixes: "VoucherPrefix",
    voucher_source_links: "VoucherSourceLink",
    payment_records: "PaymentRecord",
    recurring_invoices: "RecurringInvoice",
    subscription_payments: "SubscriptionPayment",
    consumable_credits: "ConsumableCredit",
    consumable_transactions: "ConsumableTransaction",
    ledgers: "Ledger",
    ledger_types: "LedgerType",
    txn_ledgers: "TxnLedger",
    source_taxes: "SourceTax",
    login_activities: "LoginActivity",
    reward_rules: "RewardRule",
    loyalty_transactions: "LoyaltyTransaction",
    loyalties: "Loyalty",
    godown_links: "GodownLink",
    godown_transactions: "GodownTransaction",
    godowns: "Godown",
    party_links: "PartyLink",
    company_settings: "CompanySetting",
    company_tncs: "CompanyTnc",
    coupons: "Coupon",
    referrals: "Referral",
    payouts: "Payout",
    kyc_entities: "KycEntity",
    kyc_details: "KycDetail",
    ocr_mappings: "OcrMapping",
    bulk_uploads: "BulkUpload",
    tally_exports: "TallyExport",
    tally_export_files: "TallyExportFile",
    qr_codes: "QrCode",
    pmp_merchants: "PmpMerchant",
    pmp_qrs: "PmpQr",
    versions: "Version",
    campaigns: "Campaign",
    vouchers: "Voucher",
    users: "User",
    roles: "Role",
    payments: "Payment",
    invoices: "Invoice",
    items: "Item",
    discounts: "Discount",
    additional_charges: "AdditionalCharge",
    offers: "Offer",
    offer_links: "OfferLink",
    wallets: "Wallet",
    documents: "Document",
    messages: "Message",
    rewards: "Reward",
    subscriptions: "Subscription",
  };
  if (irregulars[tableName]) return irregulars[tableName];
  // generic fallback: strip trailing 's', camelize
  const base = tableName.endsWith("s") ? tableName.slice(0, -1) : tableName;
  return base
    .split("_")
    .map((s) => s[0]?.toUpperCase() + s.slice(1))
    .join("");
}

// --- split tables by database (Flobooks vs Phone Pe) ----------------------
const flobooks = {};
const phonepe = {};
for (const [name, t] of Object.entries(tables)) {
  if (t.phonepe) phonepe[name] = t;
  else flobooks[name] = t;
}

// --- output ----------------------------------------------------------------
const out = {
  source_sha256: sha256,
  generated_at: new Date().toISOString(),
  metabase_db_map: {
    Flobooks: "flobooks",
    "flobooksMetabase": "flobooks",
    "production-issue-replica": "flobooks",
    "Phone Pe": "phonepe",
  },
  databases: {
    flobooks: { display: "Flobooks", tables: flobooks },
    phonepe: { display: "Phone Pe", tables: phonepe },
  },
  constants,
  polymorphic,
};

writeFileSync(OUT, JSON.stringify(out, null, 2));

const fbTables = Object.keys(flobooks).length;
const ppTables = Object.keys(phonepe).length;
const totalCols = Object.values(tables).reduce((n, t) => n + Object.keys(t.columns).length, 0);
const totalEnumCols = Object.values(tables).reduce(
  (n, t) => n + Object.values(t.columns).filter((c) => c.enum).length,
  0,
);
console.log(`schema.json written → ${OUT}`);
console.log(`  source sha256: ${sha256}`);
console.log(`  flobooks: ${fbTables} tables`);
console.log(`  phonepe:  ${ppTables} tables`);
console.log(`  total columns: ${totalCols}`);
console.log(`  columns with enum values: ${totalEnumCols}`);
console.log(`  shared constants: ${Object.keys(constants).length}`);
console.log(`  polymorphic associations: ${Object.keys(polymorphic).length}`);
