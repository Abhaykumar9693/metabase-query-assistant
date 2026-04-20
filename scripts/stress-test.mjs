import { validateSql } from '../extension/validator.js';
import { readFileSync } from 'fs';
const schema = JSON.parse(readFileSync(decodeURIComponent(new URL('../extension/schema.json', import.meta.url).pathname), 'utf8'));

const tests = [
  // === AGGREGATE FUNCTIONS ===
  ['COUNT(*)', `SELECT count(*) FROM invoices WHERE deleted_at IS NULL`, true],
  ['COUNT(DISTINCT col)', `SELECT count(DISTINCT contact_id) FROM invoices WHERE deleted_at IS NULL`, true],
  ['SUM(CASE WHEN)', `SELECT SUM(CASE WHEN invoice_type = 0 THEN total_amount ELSE 0 END) AS sales, SUM(CASE WHEN invoice_type = 1 THEN total_amount ELSE 0 END) AS purchases FROM invoices WHERE deleted_at IS NULL`, true],
  ['string_agg', `SELECT string_agg(name, ', ') FROM companies WHERE company_contact_type = 1 AND deleted_at IS NULL LIMIT 10`, true],
  ['array_agg', `SELECT array_agg(DISTINCT invoice_type) FROM invoices WHERE company_id = 'abc' AND deleted_at IS NULL`, true],
  ['FILTER on aggregate', `SELECT count(*) FILTER (WHERE invoice_type = 0) AS sales_count FROM invoices WHERE deleted_at IS NULL`, true],

  // === WINDOW FUNCTIONS ===
  ['RANK()', `SELECT c.id, c.name, RANK() OVER (ORDER BY w.closing_balance DESC) AS rnk FROM companies c JOIN wallets w ON w.company_id = c.id WHERE c.deleted_at IS NULL`, true],
  ['DENSE_RANK + PARTITION', `SELECT contact_id, total_amount, DENSE_RANK() OVER (PARTITION BY contact_id ORDER BY total_amount DESC) FROM invoices WHERE deleted_at IS NULL`, true],
  ['SUM OVER window', `SELECT id, total_amount, SUM(total_amount) OVER (ORDER BY invoice_date) AS running_total FROM invoices WHERE deleted_at IS NULL`, true],
  ['LAG/LEAD', `SELECT id, total_amount, LAG(total_amount, 1) OVER (ORDER BY invoice_date) AS prev_amount FROM invoices WHERE deleted_at IS NULL`, true],
  ['NTILE', `SELECT id, NTILE(4) OVER (ORDER BY total_amount) AS quartile FROM invoices WHERE deleted_at IS NULL`, true],

  // === SUBQUERIES ===
  ['scalar subquery in SELECT', `SELECT c.name, (SELECT count(*) FROM invoices i WHERE i.contact_id = c.id AND i.deleted_at IS NULL) AS inv_count FROM companies c WHERE c.company_contact_type = 1 AND c.deleted_at IS NULL`, true],
  ['derived table in FROM', `SELECT sub.contact_id, sub.total FROM (SELECT contact_id, SUM(total_amount) AS total FROM invoices WHERE deleted_at IS NULL GROUP BY contact_id) sub ORDER BY sub.total DESC LIMIT 10`, true],
  ['EXISTS', `SELECT c.id, c.name FROM companies c WHERE EXISTS (SELECT 1 FROM invoices i WHERE i.contact_id = c.id AND i.deleted_at IS NULL) AND c.deleted_at IS NULL`, true],
  ['NOT EXISTS', `SELECT c.id, c.name FROM companies c WHERE NOT EXISTS (SELECT 1 FROM invoices i WHERE i.contact_id = c.id AND i.deleted_at IS NULL) AND c.company_contact_type = 1 AND c.deleted_at IS NULL`, true],
  ['IN subquery', `SELECT name FROM companies WHERE id IN (SELECT contact_id FROM invoices WHERE invoice_type = 0 AND deleted_at IS NULL) AND deleted_at IS NULL`, true],
  ['NOT IN subquery', `SELECT name FROM companies WHERE id NOT IN (SELECT contact_id FROM payments WHERE deleted_at IS NULL) AND company_contact_type = 1 AND deleted_at IS NULL`, true],

  // === CTEs ===
  ['CTE + main query', `WITH sales AS (SELECT contact_id, SUM(total_amount) AS rev FROM invoices WHERE invoice_type = 0 AND deleted_at IS NULL GROUP BY contact_id) SELECT c.name, s.rev FROM sales s JOIN companies c ON c.id = s.contact_id ORDER BY s.rev DESC LIMIT 10`, true],
  ['multiple CTEs', `WITH s AS (SELECT contact_id, count(*) AS cnt FROM invoices WHERE invoice_type = 0 AND deleted_at IS NULL GROUP BY contact_id), p AS (SELECT contact_id, count(*) AS cnt FROM payments WHERE deleted_at IS NULL GROUP BY contact_id) SELECT c.name, s.cnt AS invoices, p.cnt AS payments FROM companies c LEFT JOIN s ON s.contact_id = c.id LEFT JOIN p ON p.contact_id = c.id WHERE c.company_contact_type = 1 AND c.deleted_at IS NULL`, true],
  ['CTE referencing CTE', `WITH base AS (SELECT id, name FROM companies WHERE company_contact_type = 0 AND deleted_at IS NULL), enriched AS (SELECT b.id, b.name, count(i.id) AS inv_count FROM base b LEFT JOIN invoices i ON i.company_id = b.id AND i.deleted_at IS NULL GROUP BY b.id, b.name) SELECT * FROM enriched WHERE inv_count > 0`, true],

  // === JOINS ===
  ['self-join', `SELECT c1.name AS company, c2.name AS customer FROM companies c1 JOIN companies c2 ON c2.company_id = c1.id WHERE c1.company_contact_type = 0 AND c2.company_contact_type = 1 AND c1.deleted_at IS NULL AND c2.deleted_at IS NULL LIMIT 20`, true],
  ['3-way join', `SELECT c.name, i.invoice_number, v.serial_number FROM companies c JOIN invoices i ON i.company_id = c.id JOIN vouchers v ON v.voucherable_id = i.id AND v.voucherable_type = 'Invoice' WHERE c.deleted_at IS NULL AND i.deleted_at IS NULL AND v.deleted_at IS NULL LIMIT 10`, true],
  ['4-way join (subscription path)', `SELECT c.name, s.subscription_type FROM subscriptions s JOIN users u ON u.id = s.user_id JOIN roles r ON r.user_id = u.id JOIN companies c ON c.id = r.company_id WHERE s.deleted_at IS NULL AND c.deleted_at IS NULL`, true],
  ['LEFT JOIN + IS NULL (no match)', `SELECT c.id, c.name FROM companies c LEFT JOIN bank_accounts ba ON ba.company_id = c.id AND ba.deleted_at IS NULL WHERE ba.id IS NULL AND c.company_contact_type = 0 AND c.deleted_at IS NULL`, true],

  // === TYPE CASTING & OPERATORS ===
  ['::text cast', `SELECT id, total_amount::text FROM invoices WHERE deleted_at IS NULL LIMIT 5`, true],
  ['::date cast', `SELECT id, created_at::date FROM companies WHERE deleted_at IS NULL LIMIT 5`, true],
  ['CAST()', `SELECT CAST(total_amount AS integer) FROM invoices WHERE deleted_at IS NULL LIMIT 5`, true],
  ['COALESCE multi-arg', `SELECT COALESCE(email, mobile_number, 'no-contact') AS contact FROM companies WHERE deleted_at IS NULL LIMIT 10`, true],
  ['NULLIF', `SELECT NULLIF(remaining_amount, 0) FROM invoices WHERE deleted_at IS NULL LIMIT 10`, true],
  ['GREATEST/LEAST', `SELECT GREATEST(total_amount, invoice_amount) FROM invoices WHERE deleted_at IS NULL LIMIT 5`, true],

  // === DATE/TIME ===
  ['NOW() - INTERVAL', `SELECT id, name FROM companies WHERE created_at >= NOW() - INTERVAL '30 days' AND deleted_at IS NULL`, true],
  ['DATE_TRUNC + GROUP BY', `SELECT DATE_TRUNC('month', invoice_date) AS month, count(*) FROM invoices WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 1`, true],
  ['EXTRACT in WHERE', `SELECT id FROM invoices WHERE EXTRACT(year FROM invoice_date) = 2025 AND deleted_at IS NULL`, true],
  ['AGE()', `SELECT id, AGE(NOW(), created_at) AS account_age FROM companies WHERE deleted_at IS NULL LIMIT 10`, true],
  ['date arithmetic', `SELECT id FROM invoices WHERE due_date < CURRENT_DATE AND remaining_amount > 0 AND deleted_at IS NULL`, true],
  ['TO_CHAR date format', `SELECT TO_CHAR(invoice_date, 'YYYY-MM') AS month, count(*) FROM invoices WHERE deleted_at IS NULL GROUP BY 1`, true],

  // === STRING FUNCTIONS ===
  ['LOWER/UPPER', `SELECT LOWER(name) FROM companies WHERE deleted_at IS NULL LIMIT 5`, true],
  ['CONCAT', `SELECT CONCAT(first_name, ' ', last_name) AS full_name FROM users WHERE deleted_at IS NULL LIMIT 10`, true],
  ['|| concatenation', `SELECT first_name || ' ' || last_name AS full_name FROM users WHERE deleted_at IS NULL LIMIT 10`, true],
  ['TRIM', `SELECT TRIM(name) FROM companies WHERE deleted_at IS NULL LIMIT 5`, true],
  ['LENGTH', `SELECT name, LENGTH(name) FROM companies WHERE deleted_at IS NULL LIMIT 10`, true],
  ['SUBSTRING', `SELECT SUBSTRING(gst_number FROM 1 FOR 2) AS state_code FROM companies WHERE gst_number IS NOT NULL AND deleted_at IS NULL LIMIT 10`, true],
  ['LIKE pattern', `SELECT name FROM companies WHERE name ILIKE '%textile%' AND deleted_at IS NULL`, true],
  ['regex ~', `SELECT name FROM companies WHERE name ~ '^[A-Z]' AND deleted_at IS NULL LIMIT 10`, true],

  // === JSON/JSONB ===
  ['jsonb ->> operator', `SELECT id, additional_fields->0->>'value' AS tally_id FROM inventory_items WHERE additional_fields IS NOT NULL AND deleted_at IS NULL LIMIT 10`, true],
  ['jsonb -> operator', `SELECT id, meta->'key' FROM vouchers WHERE meta IS NOT NULL AND deleted_at IS NULL LIMIT 5`, true],
  ['jsonb @> containment', `SELECT id FROM inventory_items WHERE additional_fields @> '[{"key":"tallyid"}]' AND deleted_at IS NULL LIMIT 10`, true],
  ['settings jsonb', `SELECT id, settings->>'key' FROM company_settings WHERE deleted_at IS NULL LIMIT 5`, true],

  // === BOOLEAN & NULL ===
  ['IS NOT NULL', `SELECT id, name FROM companies WHERE gst_number IS NOT NULL AND deleted_at IS NULL LIMIT 10`, true],
  ['boolean column', `SELECT id FROM inventory_items WHERE excel_imported = true AND deleted_at IS NULL LIMIT 10`, true],
  ['BETWEEN', `SELECT id FROM invoices WHERE total_amount BETWEEN 1000 AND 50000 AND deleted_at IS NULL`, true],

  // === SET OPERATIONS ===
  ['UNION ALL', `SELECT 'sales' AS type, count(*) FROM invoices WHERE invoice_type = 0 AND deleted_at IS NULL UNION ALL SELECT 'purchase' AS type, count(*) FROM invoices WHERE invoice_type = 1 AND deleted_at IS NULL`, true],
  ['INTERSECT', `SELECT contact_id FROM invoices WHERE invoice_type = 0 AND deleted_at IS NULL INTERSECT SELECT contact_id FROM payments WHERE deleted_at IS NULL`, true],
  ['EXCEPT', `SELECT contact_id FROM invoices WHERE deleted_at IS NULL EXCEPT SELECT contact_id FROM payments WHERE deleted_at IS NULL`, true],

  // === HAVING ===
  ['GROUP BY + HAVING', `SELECT contact_id, count(*) AS cnt FROM invoices WHERE deleted_at IS NULL GROUP BY contact_id HAVING count(*) > 10 ORDER BY cnt DESC`, true],
  ['HAVING with SUM', `SELECT company_id, SUM(total_amount) AS total FROM invoices WHERE deleted_at IS NULL GROUP BY company_id HAVING SUM(total_amount) > 100000`, true],

  // === MISC COMPLEX ===
  ['GROUP BY ordinal', `SELECT invoice_type, count(*) FROM invoices WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC`, true],
  ['DISTINCT ON', `SELECT DISTINCT ON (contact_id) contact_id, id, invoice_date FROM invoices WHERE deleted_at IS NULL ORDER BY contact_id, invoice_date DESC`, true],
  ['LIMIT + OFFSET', `SELECT id, name FROM companies WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 50 OFFSET 100`, true],
  ['multi-line complex real-world', `SELECT
  c.id,
  c.name,
  COUNT(DISTINCT i.id) AS invoice_count,
  SUM(i.total_amount) AS total_revenue,
  MAX(i.invoice_date) AS last_invoice
FROM companies c
JOIN invoices i
  ON i.contact_id = c.id
  AND i.invoice_type = 0
  AND i.deleted_at IS NULL
WHERE c.company_contact_type = 1
  AND c.company_id = 'e5779c83-4d5b-43c8-a909-84d6dbf3a7a4'
  AND c.deleted_at IS NULL
GROUP BY c.id, c.name
HAVING SUM(i.total_amount) > 0
ORDER BY total_revenue DESC
LIMIT 20;`, true],

  // === MUST-FAIL (hallucinations) ===
  ['fake table', `SELECT id FROM totally_fake_table`, false],
  ['fake column on real table', `SELECT nonexistent_col FROM companies`, false],
  ['fake dotted column', `SELECT c.nonexistent FROM companies c WHERE c.deleted_at IS NULL`, false],
  ['wrong enum literal', `SELECT id FROM invoices WHERE invoice_type = 'sales'`, false],
];

let pass = 0, fail = 0;
const failures = [];
for (const [label, sql, expectOk] of tests) {
  const r = validateSql(sql, schema, 'flobooks');
  const ok = r.ok === expectOk;
  if (ok) { pass++; }
  else { fail++; failures.push([label, expectOk, r.ok, r.errors]); }
}

console.log(`\n${pass}/${tests.length} tests passed\n`);
if (failures.length) {
  console.log('FAILURES:');
  for (const [label, expected, got, errors] of failures) {
    console.log(`  ✗ ${label} — expected ${expected}, got ${got}`);
    for (const e of errors) console.log(`    → ${e}`);
  }
}
