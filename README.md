# MyBillBook Metabase Query Assistant

Chrome extension that generates SQL for Metabase's native query editor (`metabase.flobiz.in`) using LLMs (Gemini, OpenAI, Claude, OpenRouter), strictly grounded in the MyBillBook database schema. Every identifier is validated against the parsed schema — hallucinated tables, columns, or enum values are rejected before they reach you.

## Features

- **Multi-provider LLM support** — Google Gemini (default), OpenAI, Anthropic Claude, OpenRouter, or any OpenAI-compatible endpoint
- **Deep domain knowledge** — system prompt encodes the full MyBillBook business domain: dual-purpose companies table, polymorphic vouchers, subscription join paths, GST calculations, Indian FY dates, Hinglish term translation, and more
- **Anti-hallucination validator** — every generated SQL is checked against `schema.json` for valid tables, columns, and enum values
- **Auto-retry** — validation failures are fed back to the model for automatic correction (up to 2 retries)
- **Schema explorer** — full-text search across 77+ tables, columns, FK relationships, and enum values
- **Multi-turn conversations** — context-aware follow-ups ("now group by month", "that errored — fix it")
- **Direct SQL insertion** — injects SQL into Metabase's CodeMirror 6 editor with one click
- **Copy query results** — captures full API response data (bypasses Metabase's virtualized grid)

## How anti-hallucination works

1. `DATABASE_SCHEMA_REFERENCE.md` is parsed once into `extension/schema.json` — the single source of truth bundled inside the extension (currently **77 Flobooks + 2 PhonePe tables**, **790 columns**, **104 enum columns**).
2. The LLM receives a rich system prompt with domain knowledge, common query patterns, user language translation table, and the compact schema JSON. Hard rules enforce: no invention, SQL output only, integer enums, `deleted_at IS NULL` guards.
3. Every returned SQL goes through the schema validator:
   - Tables in `FROM`/`JOIN` checked against schema (with CTE name awareness)
   - Dotted column references (`alias.col`) resolved and verified
   - Bare column references validated on single-table queries (with subquery/window function awareness)
   - Enum literals checked against permitted values
   - `EXTRACT(... FROM ...)` and `FILTER(WHERE ...)` correctly handled (not confused with real FROM/WHERE)
   - SELECT aliases tracked and excluded from validation
4. On validation failure, the extension retries up to **2 times** with specific errors fed back. If still failing, fuzzy-match suggestions (Levenshtein distance) are shown.

## Supported SQL patterns

The validator correctly handles all of these without false positives:

| Category | Patterns |
|---|---|
| Aggregates | `COUNT(*)`, `COUNT(DISTINCT x)`, `SUM(CASE WHEN)`, `string_agg`, `array_agg`, `FILTER(WHERE)` |
| Window functions | `ROW_NUMBER`, `RANK`, `DENSE_RANK`, `NTILE`, `LAG`/`LEAD`, `SUM() OVER`, `PARTITION BY` |
| Subqueries | Scalar in SELECT, derived tables in FROM, `EXISTS`, `NOT EXISTS`, `IN`, `NOT IN` |
| CTEs | Single, multiple, inter-referencing CTEs |
| Joins | Self-joins, 3-4 way joins, `LEFT JOIN ... IS NULL` |
| Type casting | `::text`, `::date`, `CAST()`, `COALESCE`, `NULLIF`, `GREATEST`/`LEAST` |
| Date/Time | `DATE_TRUNC`, `EXTRACT`, `AGE()`, `NOW() - INTERVAL`, `TO_CHAR`, `CURRENT_DATE` |
| String functions | `LOWER`, `UPPER`, `CONCAT`, `\|\|`, `TRIM`, `LENGTH`, `SUBSTRING`, `ILIKE`, regex `~` |
| JSON/JSONB | `->>`, `->`, `@>` containment, `jsonb_array_elements` |
| Set operations | `UNION ALL`, `INTERSECT`, `EXCEPT` |
| Grouping | `GROUP BY` ordinals, `HAVING`, `DISTINCT ON` |
| Advanced | Window functions with `OVER(PARTITION BY ... ORDER BY)`, `LATERAL`, `generate_series` |

## Domain intelligence

The system prompt includes deep MyBillBook domain knowledge so models understand business context:

**Key concepts encoded:**
- Companies table dual-purpose (business entities vs contacts/parties)
- `voucher_type` integers differ from `invoice_type` integers (a common source of wrong queries)
- Subscriptions belong to Users, NOT Companies — correct join path through `users → roles`
- Polymorphic join patterns for all associations (Invoice→Voucher, Item→Invoice, KYC→Company, etc.)
- JSONB query patterns for `additional_fields`, `meta`, `settings`, `subscription_stats`

**Common query patterns:**
- GST calculations (sgst + cgst + igst from txn_ledgers)
- Stock value (quantity × price from item_infos)
- Payment reconciliation (outstanding = total - SUM(payment_records))
- Subscription status (active = date range check)
- Top N customers by revenue
- Indian Financial Year date ranges (April–March)

**User language translation (40+ terms):**
- Hindi/Hinglish: `khata` → wallets, `maal` → inventory, `kharid` → purchase invoices
- Business terms: `CN/DN` → credit/debit notes, `challan` → delivery_challan, `low stock` → quantity < minimum
- Informal: `like this user` → filter by company_id, `balance` → remaining_amount or closing_balance

## One-time setup

```bash
cd metabase-query-assistant

# 1. Build schema.json from the reference .md
node scripts/build-schema.mjs "/path/to/DATABASE_SCHEMA_REFERENCE.md"

# 2. Run validator tests (10 standard + 64 stress tests)
node scripts/test-validator.mjs
node scripts/stress-test.mjs
```

## Load the extension in Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `metabase-query-assistant/extension` folder
4. The extension icon appears in your toolbar. Pin it for convenience.

## Configure

1. Click the extension icon → side panel opens
2. Go to **Settings** tab
3. Select your LLM provider (Gemini, OpenAI, Claude, OpenRouter, or Custom)
4. Paste your API key
5. Choose models:
   - **Default model** — used for normal generation (e.g. `gemini-2.5-pro`, `claude-sonnet-4-6`, `gpt-4o`)
   - **Fast model** — used when "fast" checkbox is ticked (e.g. `gemini-2.5-flash-lite`, `claude-haiku-4-5-20251001`, `gpt-4o-mini`)
6. Click **Load available models** to see all models your API key has access to
7. Optionally add extra Metabase DB names that share the Flobooks schema
8. Save

## Use it

1. Open `https://metabase.flobiz.in/question` and pick **Flobooks** or **Phone Pe** from the DB dropdown
2. Open the extension side panel
3. Type your request in natural language, e.g.:
   - `"no. of parties in this company"` (with company ID)
   - `"top 10 customers by revenue in FY 2024-25"`
   - `"companies with three businesses"`
   - `"what they save as a conversion factor in their unit, both item and sub-item"`
   - `"unpaid invoices older than 30 days with GST breakup"`
   - `"month-over-month sales growth for last 12 months"`
   - `"companies with gold plan that haven't created any invoice"`
4. Review the output (green **✓ schema-verified** or red **✗ validation failed** with specific errors)
5. Click **Insert** to inject SQL into Metabase's editor, or **Copy** to clipboard

## Out-of-schema databases

The schema reference covers two databases: **Flobooks** (primary, 77 tables) and **Phone Pe** (phonepe_db, 2 tables). If you select any other Metabase database (e.g. `credit_prod`, `flo-mcf`), the extension refuses to generate — intentionally, to prevent hallucination.

## Updating the schema

When `DATABASE_SCHEMA_REFERENCE.md` changes:

```bash
node scripts/build-schema.mjs "/path/to/updated/DATABASE_SCHEMA_REFERENCE.md"
# Then reload the extension at chrome://extensions (click ↻ on the extension card)
```

The side panel header shows the 12-char SHA of the current schema (e.g. `fd60aa4e73b3`) so you can verify which version is loaded.

## Project layout

```
metabase-query-assistant/
├── scripts/
│   ├── build-schema.mjs       # parses DATABASE_SCHEMA_REFERENCE.md → schema.json
│   ├── test-validator.mjs     # 10 core validator smoke tests
│   └── stress-test.mjs        # 64 comprehensive SQL pattern tests
└── extension/
    ├── manifest.json          # MV3 manifest, host-locked to metabase.flobiz.in
    ├── background.js          # service worker (side-panel behavior, message relay)
    ├── content.js             # content script (DB detection, SQL injection, result capture)
    ├── metabase-interceptor.js # MAIN-world fetch/XHR interceptor for query results
    ├── sidepanel.html         # side panel UI
    ├── sidepanel.css          # styles
    ├── sidepanel.js           # UI controller (conversation, tabs, settings, validation loop)
    ├── providers.js           # multi-provider LLM interface + system prompt + schema context
    ├── validator.js           # schema-grounded SQL validator (anti-hallucination)
    └── schema.json            # generated from .md (DO NOT edit manually)
```

## Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌────────────────┐
│   sidepanel.js  │────▸│ providers.js │────▸│  LLM API       │
│   (UI + logic)  │     │ (system prompt│     │  (Gemini/GPT/  │
│                 │     │  + API calls) │     │   Claude/etc.) │
│    ┌────────┐   │     └──────────────┘     └────────────────┘
│    │validate│◂──│──── validator.js ◂── schema.json
│    └────────┘   │
│        │        │
│    ┌───▼────┐   │     ┌──────────────┐     ┌────────────────┐
│    │ Insert │───│────▸│  content.js  │────▸│   Metabase     │
│    └────────┘   │     │ (DOM bridge) │     │   CodeMirror   │
└─────────────────┘     └──────────────┘     └────────────────┘
```

**Flow:** User prompt → system prompt + schema JSON sent to LLM → SQL returned → validator checks every table/column/enum → retry if invalid → display with ✓/✗ → insert into Metabase editor.
