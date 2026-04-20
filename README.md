# MyBillBook Metabase Query Assistant

Chrome extension that writes SQL into Metabase's native query editor (`metabase.flobiz.in`) using Gemini, strictly grounded in the MyBillBook database schema reference. Every identifier the extension emits is validated against the parsed schema — hallucinated tables, columns, or enum values are rejected before they reach you.

## How anti-hallucination works

1. `DATABASE_SCHEMA_REFERENCE.md` is parsed once into `extension/schema.json` — the single source of truth bundled inside the extension.
2. Gemini receives the schema as system context with hard rules: no invention, output SQL only, translate enum symbols to integers, add `deleted_at IS NULL` guards.
3. Every returned SQL goes through a schema validator: tables referenced in `FROM`/`JOIN`, columns referenced as `alias.col`, and enum literals are each checked against `schema.json`.
4. On validation failure, the extension retries once with the specific errors fed back to Gemini. If retry still fails, the user sees the errors inline.

## One-time setup

```bash
cd metabase-query-assistant

# 1. Build schema.json from the reference .md
node scripts/build-schema.mjs "/Users/vairagi/Downloads/DATABASE_SCHEMA_REFERENCE (1).md"    or "https://flobiz.atlassian.net/wiki/spaces/QA/pages/2910289955/Comprehensive+Database+Schema+Relationships+Enums+Reference?atlOrigin=eyJpIjoiZTYyMTM4YTEwMjdlNGU0ZDhiMzJmYjQ1OWM2NTI0MmEiLCJwIjoiY29uZmx1ZW5jZS1jaGF0cy1pbnQifQ"

# 2. (Optional) Run validator smoke tests
node scripts/test-validator.mjs
```

## Load the extension in Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `metabase-query-assistant/extension` folder
4. The extension icon appears in your toolbar. Pin it for convenience.

## Configure

1. Click the extension icon → side panel opens
2. Go to **Settings** tab
3. Paste your Gemini API key (get one at https://aistudio.google.com/apikey)
4. Choose default model: `gemini-2.5-pro` (default, smarter) or `gemini-2.5-flash` (faster, cheaper)
5. Optionally add extra Metabase DB names that share the Flobooks schema
6. Save

## Use it

1. Open `https://metabase.flobiz.in/question` and pick **Flobooks** or **Phone Pe** from the DB dropdown
2. Open the extension side panel
3. Type your request in plain English, e.g.:
   - "all final sales invoices for company_id :company_id in the last 30 days with remaining_amount > 0"
   - "count of payments by payment_mode for the last quarter"
   - "contacts of a company with their outstanding balance from wallets"
4. Click **Generate SQL**
5. Review the output (it carries a green ✓ when validated, red ✗ with errors otherwise)
6. Click **Insert into Metabase** — the SQL is written directly into the editor at the cursor

## Out-of-schema databases

The schema reference only covers two of the ~14 databases exposed in Metabase: `Flobooks` (primary) and `Phone Pe` (phonepe_db). If you select any other (e.g. `credit_prod`, `flo-mcf`), the extension refuses to generate — intentionally, to prevent hallucination.

## Updating the schema

When `DATABASE_SCHEMA_REFERENCE.md` changes:

```bash
node scripts/build-schema.mjs "/path/to/updated/DATABASE_SCHEMA_REFERENCE.md"
# Reload the extension at chrome://extensions
```

The side panel header shows the 12-char SHA of the current schema so you can see which version is loaded.

## Project layout

```
metabase-query-assistant/
├── scripts/
│   ├── build-schema.mjs       # parses .md → schema.json
│   └── test-validator.mjs     # validator smoke tests
└── extension/
    ├── manifest.json          # MV3 manifest, host-locked to metabase.flobiz.in
    ├── background.js          # service worker (message relay, side-panel behavior)
    ├── content.js             # content + page-context bridge for Metabase editor
    ├── sidepanel.html         # UI entry point
    ├── sidepanel.css
    ├── sidepanel.js           # UI wiring
    ├── gemini.js              # Gemini API calls (generate + retry)
    ├── validator.js           # schema-grounded SQL validator
    └── schema.json            # generated
```
