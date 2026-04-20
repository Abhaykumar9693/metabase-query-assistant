// Smoke test for the validator. Ensures it accepts real SQL and
// rejects hallucinated identifiers / wrong enum values.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(resolve(__dirname, "../extension/schema.json"), "utf8"));
const { validateSql } = await import(resolve(__dirname, "../extension/validator.js"));

function run(label, sql, expectOk, expectHas) {
  const res = validateSql(sql, schema, "flobooks");
  const pass = res.ok === expectOk && (expectHas ? res.errors.some((e) => e.includes(expectHas)) : true);
  console.log(`${pass ? "PASS" : "FAIL"} — ${label}`);
  if (!pass) {
    console.log("  got:", JSON.stringify(res, null, 2));
  }
}

// valid
run(
  "basic select",
  `SELECT id, invoice_number FROM invoices WHERE status = 1 AND deleted_at IS NULL;`,
  true,
);

run(
  "join with alias",
  `SELECT i.id, c.name FROM invoices i JOIN companies c ON c.id = i.contact_id WHERE i.invoice_type = 0;`,
  true,
);

run(
  "enum integer value",
  `SELECT id FROM invoices WHERE invoice_type = 2 AND status = 1;`,
  true,
);

// invalid
run(
  "hallucinated table",
  `SELECT * FROM invoice_lines WHERE id = 1;`,
  false,
  'Table "invoice_lines"',
);

run(
  "hallucinated column",
  `SELECT i.fake_column FROM invoices i WHERE i.id = '1';`,
  false,
  'Column "fake_column"',
);

run(
  "enum literal mismatch",
  `SELECT id FROM invoices WHERE invoice_type = 'not_a_real_type';`,
  false,
  'Enum value "not_a_real_type"',
);

// Literal that IS in the enum set (as a string — even though we expect int
// in Rails, the validator should accept the literal because it's a valid enum key).
run(
  "valid enum literal key (string form)",
  `SELECT id FROM invoices WHERE invoice_type = 'sales_invoice';`,
  true,
);

// Bare-column validation: single FROM table, column doesn't exist.
run(
  "bare column hallucination on single table",
  `SELECT fake_col FROM invoices WHERE status = 1;`,
  false,
  'Bare identifier "fake_col"',
);

// Bare-column validation: column genuinely exists, should pass.
run(
  "bare column that exists",
  `SELECT id, status FROM invoices WHERE status = 1;`,
  true,
);

// Keyword-named column that doesn't exist on the table — should now be flagged
// (previously we silently skipped because `date` is a SQL keyword).
run(
  "keyword-named column that doesn't exist",
  `SELECT i.date FROM invoices i WHERE i.id = '123';`,
  false,
  'Column "date" does not exist',
);
