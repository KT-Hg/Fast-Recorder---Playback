/**
 * sqlquote.js — turning captured values back into SQL text.
 *
 * An undo statement is only as trustworthy as its quoting, and the quoting rules
 * are the one thing that genuinely differs between the engines Adminer drives.
 * MySQL identifiers are backticked and a backslash is an escape character;
 * PostgreSQL identifiers are double-quoted and — with `standard_conforming_strings`
 * on, which it has been by default for many years — a backslash is just a
 * backslash, so doubling it there would corrupt the value being restored.
 *
 * Values captured from an edit form are always strings (or `null`). That loses
 * the column's type, which does not matter as much as it looks: an unquoted-type
 * literal `'42'` is coerced to the column type by every engine here. Numbers are
 * still emitted unquoted where it is unambiguous, because a quoted literal can
 * defeat an index on a numeric column in MySQL — but never for text that merely
 * looks numeric (`007`, `1e5`, `+1`), where unquoting would change the value.
 *
 * Everything here is pure string arithmetic, so it runs the same under Node as
 * it does in the page and is covered by dbtools/selftest.mjs.
 */

export const ENGINES = ['mysql', 'pgsql', 'mssql', 'sqlite', 'oracle'];

/** Adminer's driver name → the quoting family to use. */
export function engineOf(driver) {
  const d = String(driver || '').toLowerCase();
  if (!d || d === 'server' || d === 'mysql' || d === 'mariadb') return 'mysql';
  if (d === 'pgsql' || d === 'postgres' || d === 'postgresql') return 'pgsql';
  if (d === 'mssql' || d === 'sqlsrv' || d === 'dblib') return 'mssql';
  if (d === 'sqlite' || d === 'sqlite2') return 'sqlite';
  if (d === 'oracle' || d === 'oci8') return 'oracle';
  return 'mysql';
}

/** Quote one identifier. A quote character inside a name is doubled, never stripped. */
export function quoteIdent(name, engine = 'mysql') {
  const raw = String(name);
  switch (engine) {
    case 'mysql':  return '`' + raw.replace(/`/g, '``') + '`';
    case 'mssql':  return '[' + raw.replace(/]/g, ']]') + ']';
    default:       return '"' + raw.replace(/"/g, '""') + '"';
  }
}

/** A qualified table name, with the schema kept when Adminer gave us one. */
export function quoteTable(table, engine = 'mysql', schema = '') {
  const t = quoteIdent(table, engine);
  return schema ? `${quoteIdent(schema, engine)}.${t}` : t;
}

/**
 * Safe to emit without quotes?
 *
 * Deliberately narrow: an optional minus, digits, an optional fractional part,
 * and no leading zero unless the value *is* zero. `007` stays a string because
 * the column it came from may well be text, and `1e5`/`+1`/` 1 ` are rejected
 * for the same reason.
 */
export function looksNumeric(text) {
  return /^-?(0|[1-9]\d*)(\.\d+)?$/.test(text);
}

/** One value → a SQL literal. `null` and `undefined` both become NULL. */
export function quoteValue(value, engine = 'mysql') {
  if (value === null || value === undefined) return 'NULL';
  const raw = String(value);
  if (looksNumeric(raw)) return raw;

  // Single quotes are doubled everywhere. Backslash is an escape only in MySQL
  // (and SQLite treats it literally, like PostgreSQL).
  let body = raw.replace(/'/g, "''");
  if (engine === 'mysql') body = body.replace(/\\/g, '\\\\');
  return `'${body}'`;
}

/** `col = value`, or `col IS NULL` — the distinction an undo predicate lives on. */
function eqOrIsNull(col, value, engine) {
  const ident = quoteIdent(col, engine);
  return value === null || value === undefined
    ? `${ident} IS NULL`
    : `${ident} = ${quoteValue(value, engine)}`;
}

/** WHERE body from a { column: value } map. An empty map yields ''. */
export function whereClause(where, engine = 'mysql') {
  const parts = Object.entries(where || {}).map(([col, value]) => eqOrIsNull(col, value, engine));
  return parts.join(' AND ');
}

export function buildUpdate(table, setMap, where, engine = 'mysql', schema = '') {
  const sets = Object.entries(setMap)
    .map(([col, value]) => `${quoteIdent(col, engine)} = ${quoteValue(value, engine)}`)
    .join(', ');
  const cond = whereClause(where, engine);
  return `UPDATE ${quoteTable(table, engine, schema)} SET ${sets}` + (cond ? ` WHERE ${cond}` : '');
}

export function buildInsert(table, row, engine = 'mysql', schema = '') {
  const cols = Object.keys(row);
  const names = cols.map((c) => quoteIdent(c, engine)).join(', ');
  const values = cols.map((c) => quoteValue(row[c], engine)).join(', ');
  return `INSERT INTO ${quoteTable(table, engine, schema)} (${names}) VALUES (${values})`;
}

export function buildDelete(table, where, engine = 'mysql', schema = '', limit = 0) {
  const cond = whereClause(where, engine);
  let sql = `DELETE FROM ${quoteTable(table, engine, schema)}` + (cond ? ` WHERE ${cond}` : '');
  // Only MySQL and SQLite accept LIMIT on DELETE, and it is only ever added as a
  // guard for a table with no key — see undo.js.
  if (limit && (engine === 'mysql' || engine === 'sqlite')) sql += ` LIMIT ${limit}`;
  return sql;
}

export function buildSelect(columns, table, where, engine = 'mysql', schema = '') {
  const cols = columns && columns.length
    ? columns.map((c) => quoteIdent(c, engine)).join(', ')
    : '*';
  const cond = whereClause(where, engine);
  return `SELECT ${cols} FROM ${quoteTable(table, engine, schema)}` + (cond ? ` WHERE ${cond}` : '');
}

/** Statement terminator: what the SQL page needs between statements. */
export function joinStatements(list) {
  return list.map((s) => (s.trim().endsWith(';') ? s.trim() : s.trim() + ';')).join('\n');
}
