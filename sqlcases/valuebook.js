/**
 * valuebook.js — the one place the sample values used by the generator live.
 *
 * The generator invents values constantly: the neighbour of a boundary, a
 * filler for a column no predicate mentions, a stand-in for a bind parameter
 * it cannot see the value of. Every one of those is a guess, and a tester who
 * knows the system usually knows better — the account that actually exists in
 * the test environment, the amount the API really sends, an email that will
 * pass the login.
 *
 * This module holds those answers. It is a small keyed store of user overrides
 * plus the arithmetic for reading a typed value back out of the text a person
 * typed. Two kinds of key exist:
 *
 *   param:<name>        a bind parameter (`:amount`, `?1`) given a value
 *   col:<table>.<col>   the sample value to use for a column
 *
 * Column keys are built from the table *name*, never its alias, so renaming
 * `users u` to `users usr` does not orphan the values a tester filled in.
 *
 * Reading the book is a global lookup rather than an argument threaded through
 * every technique. That is deliberate and matches what is already there:
 * generation resolves its prose against the global language (`i18n.t`), and
 * the value book is the same kind of input — one setting, read at the few
 * points that need it, applied to a whole run. `useTables()` is refreshed at
 * the start of every `analyze()`, so alias lookups always describe the query
 * being generated and never the previous one.
 *
 * Nothing here imports anything: the store has to be readable from `analyze`,
 * which sits at the bottom of the module graph.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

const NUMERIC_TYPES = new Set(['integer', 'decimal']);
const TEXTUAL_TYPES = new Set(['string', 'email']);

/** key → the raw text the user typed, exactly as typed. */
const overrides = new Map();

/** Alias → table name for the query being generated, from `useTables()`. */
let tableIndex = new Map();
let singleTable = null;

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * Key for a bind parameter.
 *
 * Named parameters key by name, so `:amount` used three times is one entry.
 * Anonymous `?` markers have nothing to key by but their position, so the
 * tokenizer numbers them and the ordinal becomes part of the key.
 */
export function paramKey(name, ordinal) {
  const n = String(name || '').trim();
  return n === '?' ? `param:?${ordinal || 1}` : `param:${n.toLowerCase()}`;
}

/** Display name for a parameter slot — `?` alone is ambiguous, `?2` is not. */
export function paramLabel(name, ordinal) {
  const n = String(name || '').trim();
  return n === '?' ? `?${ordinal || 1}` : n;
}

export function columnKey(table, column) {
  return `col:${String(table || '').toLowerCase()}.${String(column || '').toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** Set (or, with blank text, clear) one entry. Returns true if anything moved. */
export function setOverride(key, raw) {
  const text = String(raw ?? '');
  if (!text.trim()) return clearOverride(key);
  if (overrides.get(key) === text) return false;
  overrides.set(key, text);
  return true;
}

export function clearOverride(key) {
  return overrides.delete(key);
}

export function clearAll() {
  const had = overrides.size > 0;
  overrides.clear();
  return had;
}

/** The raw text for a key, or '' — what the input field shows. */
export function rawOverride(key) {
  return overrides.get(key) ?? '';
}

export function hasOverride(key) {
  return overrides.has(key);
}

export function overrideCount() {
  return overrides.size;
}

/** Plain object for persistence; `load` is its inverse. */
export function toJSON() {
  return Object.fromEntries(overrides);
}

export function load(obj) {
  overrides.clear();
  if (!obj || typeof obj !== 'object') return;
  Object.entries(obj).forEach(([k, v]) => {
    if (typeof v === 'string' && v.trim()) overrides.set(k, v);
  });
}

/**
 * Register the tables of the query being generated, so a column reference
 * written as an alias can be resolved back to the table it names.
 */
export function useTables(tables) {
  tableIndex = new Map();
  singleTable = null;
  const real = (tables || []).filter(tb => !tb.isSubquery);
  real.forEach(tb => {
    [tb.label, tb.alias, tb.name].forEach(k => {
      if (k) tableIndex.set(String(k).toLowerCase(), tb.name);
    });
  });
  // An unqualified column is only unambiguous when there is one table to own it.
  if (real.length === 1) singleTable = real[0].name;
}

/** Table name behind a reference that may be an alias, a name, or nothing. */
export function resolveTable(ref) {
  if (!ref) return singleTable;
  return tableIndex.get(String(ref).toLowerCase()) || String(ref);
}

// ---------------------------------------------------------------------------
// Reading a value out of typed text
// ---------------------------------------------------------------------------

/** Whether a parsed value is the kind of thing the column can hold. */
function fits(literalKind, value, typeHint) {
  if (!typeHint || typeHint === 'unknown' || literalKind === 'null') return true;
  if (typeHint === 'integer') return literalKind === 'number' && Number.isInteger(value);
  if (typeHint === 'decimal') return literalKind === 'number';
  if (typeHint === 'boolean') return literalKind === 'boolean';
  if (typeHint === 'date') return literalKind === 'string' && DATE_RE.test(value);
  if (typeHint === 'datetime') return literalKind === 'string' && (DATETIME_RE.test(value) || DATE_RE.test(value));
  if (typeHint === 'time') return literalKind === 'string' && TIME_RE.test(value);
  if (typeHint === 'email') return literalKind === 'string' && /.+@.+/.test(value);
  return true;
}

/**
 * Turn typed text into an SQL literal plus the JS value behind it.
 *
 * The JS value matters as much as the SQL: boundary arithmetic steps along it,
 * so `:amount` bound to `500` gives a real `499`/`501` pair, while a value that
 * only survived as a string would collapse the case back to a placeholder.
 *
 * @param {string} raw — what the user typed
 * @param {string} [typeHint] — the inferred column type, when there is one
 * @returns {{sql:string, value:*, literalKind:string, valid:boolean, raw:string}|null}
 *   null for blank text. `valid:false` means the value was still accepted but
 *   does not look like the column's type — the UI flags it rather than
 *   silently dropping what the user asked for.
 */
export function parseValue(raw, typeHint) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  const done = (sql, value, literalKind) =>
    ({ sql, value, literalKind, valid: fits(literalKind, value, typeHint), raw: text });

  if (/^null$/i.test(text)) return done('NULL', null, 'null');

  // Already written as SQL. Taken verbatim, which is the only way to say
  // "'0123' is a string, not the number 123" or to enter an empty string.
  const quoted = /^'([\s\S]*)'$/.exec(text);
  if (quoted) return done(text, quoted[1].replace(/''/g, "'"), 'string');

  if (/^(true|false)$/i.test(text) && !TEXTUAL_TYPES.has(typeHint)) {
    return done(text.toUpperCase(), /^true$/i.test(text), 'boolean');
  }

  // A bare number stays a number unless the column is textual, where `0123`
  // and `+84...` are values people really do type and must not be mangled.
  if (/^-?(\d+\.?\d*|\.\d+)$/.test(text) && !TEXTUAL_TYPES.has(typeHint)) {
    return done(text, Number(text), 'number');
  }

  return done(`'${text.replace(/'/g, "''")}'`, text, 'string');
}

/** The parsed value for a key, or null when it carries no override. */
export function valueFor(key, typeHint) {
  if (!overrides.has(key)) return null;
  return parseValue(overrides.get(key), typeHint);
}

/**
 * The value bound to a parameter, if any.
 *
 * This is the hook `analyze.describeOperand` uses: a bound parameter stops
 * being an opaque marker and becomes an ordinary literal, which is what lets
 * every technique downstream produce concrete values without knowing the value
 * book exists.
 */
export function boundParam(name, ordinal) {
  return valueFor(paramKey(name, ordinal), null);
}

/**
 * The sample value chosen for a column, if any.
 *
 * @param {string|null} tableRef — table name, alias, or null for unqualified
 * @param {string} columnName
 * @param {string} [typeHint]
 */
export function columnSample(tableRef, columnName, typeHint) {
  const table = resolveTable(tableRef);
  if (!table || !columnName) return null;
  return valueFor(columnKey(table, columnName), typeHint);
}

/**
 * Every parameter in the model that currently carries a value.
 * Used to report, above the results, that some case values did not come from
 * the query text.
 */
export function boundParams(model) {
  return (model?.params || [])
    .map(p => ({ label: p.label, bound: boundParam(p.name, p.ordinal) }))
    .filter(p => p.bound)
    .map(p => ({ label: p.label, sql: p.bound.sql }));
}
