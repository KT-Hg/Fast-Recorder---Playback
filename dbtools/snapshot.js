/**
 * snapshot.js — the second and third layers of protection: a copy of the whole
 * table, taken before a test, and the statements that put the table back to it.
 *
 * The change log (undo.js) only knows about writes made *through Adminer*. A test
 * that drives the application under test changes master data behind Adminer's
 * back — the application's own saves, triggers, a colleague — and none of that is
 * in the log. A snapshot does not care how the data changed: it compares the
 * table as it was with the table as it is, row by row on the key, and emits
 *
 *   DELETE  for a row that exists now and did not then,
 *   UPDATE  for a row whose values moved (only the columns that moved),
 *   INSERT  for a row that existed then and is gone now,
 *
 * in that order, so a deleted row frees its unique values before an update or an
 * insert needs them back.
 *
 * The third layer is a backup table in the database itself — `CREATE TABLE
 * m_generic_bak_… AS SELECT * FROM m_generic` — which outlives the browser and
 * the extension. It can be restored the same way, by diffing the backup against
 * the table, or wholesale when the table is too large to diff here.
 *
 * Pure functions over plain objects, like undo.js: rows are `{ column: value }`
 * with values as strings or `null`, exactly as the result grid reader produces
 * them. No DOM, no storage — selftest.mjs covers all of it.
 */

import { quoteTable, quoteIdent, buildUpdate, buildInsert, buildDelete } from './sqlquote.js';
import { sameValue } from './undo.js';

/* === Reading a table ═════════════════════════════════════════════════════ */

/**
 * Add a row limit in the engine's own dialect. `limit` is asked for one over the
 * cap by the callers, so that a table which is too large is noticed instead of
 * silently cut short.
 */
function limited(select, engine, limit) {
  if (!limit) return select;
  if (engine === 'mssql') return select.replace(/^SELECT /, `SELECT TOP ${limit} `);
  if (engine === 'oracle') return `${select} FETCH FIRST ${limit} ROWS ONLY`;
  return `${select} LIMIT ${limit}`;
}

function orderBy(cols, engine) {
  return cols && cols.length ? ` ORDER BY ${cols.map((c) => quoteIdent(c, engine)).join(', ')}` : '';
}

/** `SELECT * FROM t ORDER BY <key>` — ordered so two snapshots of one table read alike. */
export function snapshotSelect(table, engine = 'mysql', schema = '', limit = 0, keyCols = []) {
  return limited(`SELECT * FROM ${quoteTable(table, engine, schema)}${orderBy(keyCols, engine)}`, engine, limit);
}

/** Only the key columns: what finding newly inserted rows by difference needs. */
export function keysSelect(table, keyCols, engine = 'mysql', schema = '', limit = 0) {
  const cols = keyCols.map((c) => quoteIdent(c, engine)).join(', ');
  return limited(`SELECT ${cols} FROM ${quoteTable(table, engine, schema)}${orderBy(keyCols, engine)}`, engine, limit);
}

/** The identity of a row as one comparable string. */
export function keyOf(row, keyCols) {
  return JSON.stringify(keyCols.map((c) => (row[c] === undefined ? null : row[c])));
}

/** `{ col: value }` for the key columns of a row — an undo predicate. */
export function keyWhere(row, keyCols) {
  const out = {};
  for (const col of keyCols) out[col] = row[col] === undefined ? null : row[col];
  return out;
}

/**
 * Rows whose key was not in `beforeKeys` — the rows an INSERT created, found by
 * comparing the table's keys before and after it ran.
 */
export function newRows(beforeKeys, afterRows, keyCols) {
  const seen = new Set(beforeKeys);
  return afterRows.filter((row) => !seen.has(keyOf(row, keyCols)));
}

/* === Comparing ═══════════════════════════════════════════════════════════ */

/**
 * What it takes to turn `current` back into `snap`.
 *
 *   snap    { keyCols, columns, rows, unreadable }
 *   current { columns, rows, unreadable }
 *
 * Only columns present on both sides and readable on both are compared; the
 * rest are listed in `skippedCols` so the preview can say so. A key that is not
 * unique on either side makes the comparison meaningless — which row would be
 * restored into which? — so it is refused with a reason instead.
 */
export function diffSnapshot(snap, current) {
  const keyCols = snap.keyCols || [];
  const out = { deletes: [], updates: [], inserts: [], skippedCols: [], reason: '' };
  if (!keyCols.length) { out.reason = 'no-key'; return out; }

  // A table with no rows is read back as "No rows." with no header, so an empty
  // side has no column list of its own; it borrows the other side's. Otherwise a
  // table that was empty when snapshotted could never be emptied again.
  const snapCols = listed(snap, current);
  const nowCols = listed(current, { columns: snapCols });
  const unreadable = new Set([...(snap.unreadable || []), ...(current.unreadable || [])]);
  const currentCols = new Set(nowCols);
  const cols = snapCols.filter((c) => currentCols.has(c) && !unreadable.has(c));
  out.skippedCols = [...new Set([
    ...snapCols.filter((c) => !cols.includes(c)),
    ...nowCols.filter((c) => !cols.includes(c)),
  ])];
  if (keyCols.some((k) => !cols.includes(k))) { out.reason = 'key-not-compared'; return out; }

  const index = (rows) => {
    const map = new Map();
    for (const row of rows) {
      const key = keyOf(row, keyCols);
      if (map.has(key)) return null;
      map.set(key, row);
    }
    return map;
  };
  const was = index(snap.rows || []);
  const now = index(current.rows || []);
  if (!was || !now) { out.reason = 'duplicate-key'; return out; }

  for (const [key, row] of now) {
    if (!was.has(key)) out.deletes.push({ where: keyWhere(row, keyCols), current: row });
  }
  for (const [key, old] of was) {
    const row = now.get(key);
    if (!row) {
      const values = {};
      for (const col of cols) values[col] = old[col];
      out.inserts.push({ row: values, incomplete: (snap.unreadable || []).length > 0 });
      continue;
    }
    const set = {};
    for (const col of cols) {
      if (!sameValue(old[col], row[col])) set[col] = old[col];
    }
    if (Object.keys(set).length) out.updates.push({ where: keyWhere(old, keyCols), set, current: row });
  }
  return out;
}

function listed(side, other) {
  if (side.columns && side.columns.length) return side.columns;
  return (side.rows || []).length ? [] : (other.columns || []);
}

/** Nothing to do? */
export function diffIsEmpty(diff) {
  return !diff.deletes.length && !diff.updates.length && !diff.inserts.length;
}

/** The statements, in the order that keeps unique values free: DELETE, UPDATE, INSERT. */
export function restoreStatements(diff, table, engine = 'mysql', schema = '') {
  return [
    ...diff.deletes.map((d) => buildDelete(table, d.where, engine, schema)),
    ...diff.updates.map((u) => buildUpdate(table, u.set, u.where, engine, schema)),
    ...diff.inserts.map((i) => buildInsert(table, i.row, engine, schema)),
  ];
}

/* === Backup tables ═══════════════════════════════════════════════════════ */

/** Identifier length limits that bite in practice. */
const MAX_NAME = { mysql: 64, pgsql: 63, oracle: 30, mssql: 128, sqlite: 128 };

function stamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * `<table>_bak_<yyyymmdd_hhmmss>`, shortened from the table name's end when the
 * engine's identifier limit would cut the timestamp off — the timestamp is what
 * tells two backups of one table apart.
 */
export function backupName(table, date = new Date(), engine = 'mysql') {
  const suffix = `_bak_${stamp(date)}`;
  const max = MAX_NAME[engine] || 64;
  return String(table).slice(0, Math.max(1, max - suffix.length)) + suffix;
}

export function backupCreateSql(table, backup, engine = 'mysql', schema = '') {
  const src = quoteTable(table, engine, schema);
  const dst = quoteTable(backup, engine, schema);
  if (engine === 'mssql') return `SELECT * INTO ${dst} FROM ${src}`;
  return `CREATE TABLE ${dst} AS SELECT * FROM ${src}`;
}

/**
 * Wholesale restore: empty the table and copy the backup back in. For a table
 * too large to diff here. It fires DELETE triggers and cascades, and an identity
 * column in SQL Server refuses explicit values — the preview says so.
 */
export function backupRestoreSql(table, backup, engine = 'mysql', schema = '') {
  const src = quoteTable(backup, engine, schema);
  const dst = quoteTable(table, engine, schema);
  return [`DELETE FROM ${dst}`, `INSERT INTO ${dst} SELECT * FROM ${src}`];
}

export function backupDropSql(backup, engine = 'mysql', schema = '') {
  return `DROP TABLE ${quoteTable(backup, engine, schema)}`;
}
