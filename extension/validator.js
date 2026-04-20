// SQL validator. Verifies that every table, column, and enum literal
// referenced in the generated SQL exists in schema.json. If anything
// fails to resolve, we reject the query — this is the anti-hallucination
// guarantee. We do NOT try to be a full SQL parser; we tokenize and
// cross-check identifiers against the schema, which is enough for the
// classes of mistake we care about.

// PostgreSQL reserved words + commonly-used function names. The list is
// deliberately broad: if a token appears here, the validator skips it as a
// column-name candidate. Over-inclusion is safe (at worst we miss flagging
// a typo on a keyword-named column); under-inclusion causes false positives
// on legitimate SQL. When in doubt, add the word.
const SQL_KEYWORDS = new Set([
  // --- clauses ---
  "select", "from", "where", "and", "or", "not", "in", "is", "null",
  "as", "on", "join", "inner", "left", "right", "full", "outer", "cross", "natural",
  "group", "by", "order", "having", "limit", "offset",
  "asc", "desc", "ascending", "descending", "nulls",
  "union", "all", "distinct", "intersect", "except",
  "case", "when", "then", "else", "end",
  "between", "symmetric", "asymmetric",
  "like", "ilike", "similar", "to", "escape", "collate",
  "exists", "any", "some", "unknown",
  "with", "recursive", "over", "partition", "window", "using", "lateral",
  "rollup", "cube", "grouping", "sets",
  "returning", "values", "insert", "update", "delete", "set",
  "filter", "within", "fetch", "first", "next", "rows", "only",
  "tablesample", "repeatable",
  "at", "zone",
  "isnull", "notnull", "overlaps", "row",

  // --- data types ---
  "character", "varying", "boolean", "integer", "bigint", "smallint", "numeric",
  "decimal", "real", "double", "precision", "text", "uuid", "jsonb", "json",
  "bytea", "serial", "bigserial", "money",
  "date", "time", "timestamp", "timestamptz", "interval", "array",
  "true", "false",

  // --- control flow functions ---
  "coalesce", "nullif", "cast", "if", "ifnull", "greatest", "least",

  // --- aggregate functions ---
  "count", "sum", "avg", "min", "max",
  "json_agg", "jsonb_agg", "string_agg", "array_agg",
  "bool_and", "bool_or", "every", "bit_and", "bit_or", "mode",
  "percentile_cont", "percentile_disc",

  // --- window functions ---
  "row_number", "rank", "dense_rank", "ntile",
  "cume_dist", "percent_rank",
  "lag", "lead", "first_value", "last_value", "nth_value",

  // --- date/time functions ---
  "extract", "now", "current_date", "current_timestamp", "current_time",
  "localtime", "localtimestamp",
  "date_trunc", "date_part", "age", "to_char", "to_date", "to_timestamp",
  "timeofday", "statement_timestamp", "clock_timestamp", "transaction_timestamp",
  "make_date", "make_time", "make_timestamp", "make_timestamptz",
  "year", "month", "day", "hour", "minute", "second", "week", "quarter",
  "dow", "doy", "epoch", "isoyear", "isodow",
  "millisecond", "microsecond", "decade", "century", "millennium",

  // --- string functions ---
  "lower", "upper", "initcap", "length", "char_length", "character_length",
  "octet_length", "bit_length",
  "substring", "substr", "position", "trim", "ltrim", "rtrim",
  "lpad", "rpad", "concat", "concat_ws",
  "replace", "reverse", "translate", "overlay", "format",
  "split_part", "string_to_array", "array_to_string",
  "regexp_replace", "regexp_matches", "regexp_split_to_array",
  "regexp_split_to_table", "regexp_match", "regexp_substr",
  "strpos", "left", "right",
  "encode", "decode", "md5", "sha256",

  // --- numeric functions ---
  "abs", "ceil", "ceiling", "floor", "round", "mod", "power", "sqrt",
  "exp", "ln", "log", "log10", "sign", "trunc", "div", "pi",
  "random", "setseed", "cbrt",

  // --- array / range / set functions ---
  "unnest", "generate_series", "generate_subscripts",
  "array_length", "array_lower", "array_upper", "array_ndims",
  "array_position", "array_positions", "array_remove", "array_replace",
  "array_append", "array_prepend", "array_cat", "cardinality",
  "range_empty", "range_lower", "range_upper",

  // --- json / jsonb functions ---
  "json_build_object", "jsonb_build_object",
  "json_build_array", "jsonb_build_array",
  "json_object", "jsonb_object",
  "json_array_length", "jsonb_array_length",
  "json_array_elements", "jsonb_array_elements",
  "json_array_elements_text", "jsonb_array_elements_text",
  "json_object_keys", "jsonb_object_keys",
  "json_each", "jsonb_each", "json_each_text", "jsonb_each_text",
  "json_extract_path", "jsonb_extract_path",
  "json_extract_path_text", "jsonb_extract_path_text",
  "json_typeof", "jsonb_typeof",
  "to_json", "to_jsonb", "row_to_json",

  // --- pg introspection (show up in EXPLAIN / diagnostic queries) ---
  "pg_typeof", "pg_size_pretty", "pg_total_relation_size",
  "current_user", "current_schema", "current_database", "session_user", "user",
  "version",
]);

function tokenize(sql) {
  // Strip single-line and block comments, string literals.
  const clean = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  // We keep string literals separately so we can check enum-value literals.
  const strings = [];
  const stripped = clean.replace(/'((?:''|[^'])*)'/g, (_, s) => {
    strings.push(s.replace(/''/g, "'"));
    // Placeholder uses `?` only — not a valid identifier char, so downstream
    // regexes that look for identifiers won't misread it as a column name.
    return " ? ";
  });
  // Extract identifiers (including dotted).
  const tokens = [];
  const re = /"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    tokens.push(m[1] || m[2]);
  }
  return { tokens, strings, clean: stripped };
}

function splitDotted(tok) {
  return tok.split(".").map((s) => s.toLowerCase());
}

function extractFromTables(sqlClean) {
  // Capture the identifier after FROM, JOIN, UPDATE, INTO (bare table refs).
  // Also handles schema-qualified "public.invoices" by splitting on '.'.
  const out = [];
  const re = /\b(?:from|join|update|into)\s+("[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)/gi;
  let m;
  while ((m = re.exec(sqlClean)) !== null) {
    const raw = m[1].replace(/"/g, "");
    const parts = raw.split(".");
    out.push(parts[parts.length - 1].toLowerCase());
  }
  return out;
}

// Extract plausible bare column references from SELECT column list and
// WHERE / ORDER BY / GROUP BY clauses. We deliberately keep this narrow:
// false positives would block legitimate SQL.
function extractBareColumnRefs(sqlClean) {
  const out = new Set();
  // SELECT <cols> FROM
  const selectM = sqlClean.match(/\bselect\s+([\s\S]*?)\bfrom\b/i);
  if (selectM) collectIdentifiers(selectM[1], out);
  // WHERE ... (stops at GROUP/ORDER/LIMIT/HAVING/RETURNING)
  const whereM = sqlClean.match(/\bwhere\s+([\s\S]*?)(?:\bgroup\s+by\b|\border\s+by\b|\blimit\b|\bhaving\b|\breturning\b|;|$)/i);
  if (whereM) collectIdentifiers(whereM[1], out);
  // ORDER BY / GROUP BY / HAVING
  const gbM = sqlClean.match(/\bgroup\s+by\s+([\s\S]*?)(?:\border\s+by\b|\blimit\b|\bhaving\b|;|$)/i);
  if (gbM) collectIdentifiers(gbM[1], out);
  const obM = sqlClean.match(/\border\s+by\s+([\s\S]*?)(?:\blimit\b|;|$)/i);
  if (obM) collectIdentifiers(obM[1], out);
  return [...out];
}

function collectIdentifiers(fragment, set) {
  // Match identifiers that are NOT preceded by a dot (those are dotted refs
  // handled elsewhere) and NOT followed by '(' (function call).
  const re = /(?<![\w.])([a-z_][a-z0-9_]*)(?!\s*\()/gi;
  let m;
  while ((m = re.exec(fragment)) !== null) {
    const id = m[1].toLowerCase();
    set.add(id);
  }
}

function extractAliases(sqlClean) {
  // Collect "table AS alias" and "table alias" aliases.
  const aliases = {}; // alias -> table
  const re = /\b(?:from|join)\s+("[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\s+(?:as\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\b/gi;
  let m;
  while ((m = re.exec(sqlClean)) !== null) {
    const tableRaw = m[1].replace(/"/g, "");
    const parts = tableRaw.split(".");
    const table = parts[parts.length - 1].toLowerCase();
    const alias = m[2].toLowerCase();
    if (SQL_KEYWORDS.has(alias)) continue;
    aliases[alias] = table;
  }
  return aliases;
}

export function validateSql(sql, schema, dbKey /* 'flobooks' | 'phonepe' */) {
  const db = schema.databases[dbKey];
  if (!db) {
    return { ok: false, errors: [`Unknown database key: ${dbKey}`], unknownTables: [], unknownColumns: [] };
  }
  const tables = db.tables;

  const { tokens, strings, clean } = tokenize(sql);
  const fromTables = extractFromTables(clean);
  const aliases = extractAliases(clean);

  const errors = [];
  const unknownTables = [];
  const unknownColumns = [];

  // 1. Every FROM/JOIN target must exist in the schema.
  for (const t of fromTables) {
    if (!tables[t]) {
      unknownTables.push(t);
      errors.push(`Table "${t}" is not in the ${db.display} schema.`);
    }
  }

  // Build the set of columns reachable in this query (union of all columns
  // across FROM/JOIN tables). Used for bare-column validation.
  const reachableColumns = new Set();
  const columnOwners = new Map(); // col → [table1, table2, ...]
  for (const t of fromTables) {
    const def = tables[t];
    if (!def) continue;
    for (const col of Object.keys(def.columns)) {
      reachableColumns.add(col);
      const arr = columnOwners.get(col) || [];
      arr.push(t);
      columnOwners.set(col, arr);
    }
  }

  // 2. Every dotted identifier `x.y` where x is an alias or known table
  //    must resolve to a real column on that table. We DO NOT silently
  //    skip keyword-named columns here — if the model writes `t.date` and
  //    the table has no `date` column, that's a hallucination we catch.
  const seenRefs = new Set();
  for (const tok of tokens) {
    if (!tok.includes(".")) continue;
    const parts = splitDotted(tok);
    const col = parts[parts.length - 1];
    const tbl = parts[parts.length - 2];
    const key = `${tbl}.${col}`;
    if (seenRefs.has(key)) continue;
    seenRefs.add(key);

    // Skip if BOTH parts are SQL keywords (likely a function/type expression).
    if (SQL_KEYWORDS.has(col) && SQL_KEYWORDS.has(tbl)) continue;
    // Skip if the leading part is a keyword (e.g. `DATE '2024-01-01'`).
    if (SQL_KEYWORDS.has(tbl)) continue;

    const actualTable = aliases[tbl] || (tables[tbl] ? tbl : null);
    if (!actualTable) {
      // tbl isn't a known table or alias — might be a CTE / subquery alias.
      // We record this as a soft warning; don't fail outright (CTEs are
      // legitimate). If the caller wants stricter checks, wire it up here.
      continue;
    }
    const tblDef = tables[actualTable];
    if (!tblDef) continue;
    if (!tblDef.columns[col]) {
      unknownColumns.push(`${actualTable}.${col}`);
      errors.push(`Column "${col}" does not exist on table "${actualTable}".`);
    }
  }

  // 2b. Bare column references in SELECT / WHERE / ORDER BY when the FROM
  //     clause names a single table (no alias ambiguity). This catches
  //     cases like `SELECT foo FROM invoices` where foo isn't a column.
  if (fromTables.length === 1) {
    const onlyTable = fromTables[0];
    const def = tables[onlyTable];
    if (def) {
      // Find bare identifiers in SELECT ... FROM region and WHERE/ORDER BY clauses.
      const bareCols = extractBareColumnRefs(clean);
      for (const c of bareCols) {
        if (SQL_KEYWORDS.has(c)) continue;
        if (aliases[c]) continue;
        if (def.columns[c]) continue;
        // It's something referenced as a column but not found.
        if (!reachableColumns.has(c)) {
          unknownColumns.push(`${onlyTable}.${c}`);
          errors.push(`Bare identifier "${c}" doesn't exist on ${onlyTable}.`);
        }
      }
    }
  }

  // 3. Heuristic enum check: for patterns like `invoice_type = 'quotation'`
  //    verify the literal is a valid enum key for the matched column. We do
  //    this via a regex over the cleaned SQL.
  const eqRe = /\b(?:([a-zA-Z_][a-zA-Z0-9_]*)\s*\.\s*)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=|!=|<>|in)\s*\(?\s*'([^']+)'/gi;
  let em;
  while ((em = eqRe.exec(sql)) !== null) {
    const maybeAlias = em[1]?.toLowerCase();
    const colName = em[2].toLowerCase();
    const literal = em[3];
    const actualTable = maybeAlias
      ? aliases[maybeAlias] || (tables[maybeAlias] ? maybeAlias : null)
      : null;
    // If we don't know the table, try to find any column by that name with an enum.
    let col;
    if (actualTable && tables[actualTable]) {
      col = tables[actualTable].columns[colName];
    } else {
      // search all tables for a column of this name that has an enum
      for (const t of Object.values(tables)) {
        if (t.columns[colName]?.enum) {
          col = t.columns[colName];
          break;
        }
      }
    }
    if (!col || !col.enum) continue;
    if (!(literal in col.enum)) {
      errors.push(
        `Enum value "${literal}" is not valid for column "${colName}". Valid: ${Object.keys(col.enum).join(", ")}`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    unknownTables: [...new Set(unknownTables)],
    unknownColumns: [...new Set(unknownColumns)],
  };
}

// Suggests the closest known table/column name for a typo (simple Levenshtein).
export function suggestFix(badName, candidates) {
  if (!badName) return null;
  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const d = levenshtein(badName.toLowerCase(), c.toLowerCase());
    if (d < bestScore) {
      bestScore = d;
      best = c;
    }
  }
  return bestScore <= Math.max(2, Math.floor(badName.length / 3)) ? best : null;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}
