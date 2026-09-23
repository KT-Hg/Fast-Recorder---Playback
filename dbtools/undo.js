/**
 * undo.js — a recorded change → the SQL that puts it back, or applies it again.
 *
 * One shape carries every kind of change, because the rollback page has to treat
 * them alike: a change is a table plus a list of rows, and each row holds the
 * predicate that identifies it, the values it had (`before`) and the values it
 * was given (`after`). An UPDATE has both; a DELETE has only `before`, which is
 * the whole row; an INSERT has only `after`.
 *
 *   { op, table, schema, keyCols, rows: [ { where, before, after } ], warnings }
 *
 * Two rules here are the ones that keep an undo honest.
 *
 * First, the predicate. `where` is what Adminer used to *reach* the row, so it
 * holds the values from before the edit. If the edit changed a key column, that
 * predicate no longer matches anything — the undo has to look the row up by its
 * new key and set the old one back. `undoWhere()` does that swap, and only for
 * columns that are actually part of the key.
 *
 * Second, what is not undoable. A table with no key gives an empty predicate,
 * which would make an undo statement hit every row in the table. That is never
 * emitted silently: the change is marked `undoable: false` with the reason, and
 * the caller decides whether to offer the LIMIT 1 variant. The same goes for an
 * INSERT whose new key was never observed, and for a column the capture could
 * not read (a BLOB, a file input).
 *
 * The redo half is the mirror image: it writes `after` where the undo writes
 * `before`, and it reaches the row by the predicate Adminer recorded — which is
 * what the row holds again once the change has been rolled back. It needs values
 * the capture actually read back, so a statement typed on the SQL page, whose
 * `after` was never read, is refused rather than guessed at.
 *
 * Pure functions over plain objects — no DOM, no storage, no chrome API.
 */

import { buildUpdate, buildInsert, buildDelete, engineOf } from './sqlquote.js';

export const UNDOABLE_OPS = new Set(['update', 'delete', 'insert']);

/**
 * The predicate to use when undoing one row: the recorded `where`, with any key
 * column the change itself modified swapped to the value it now holds.
 */
export function undoWhere(row, keyCols = []) {
  const where = { ...(row.where || {}) };
  const keys = new Set(keyCols);
  for (const [col, value] of Object.entries(row.after || {})) {
    if (keys.has(col) && Object.prototype.hasOwnProperty.call(where, col)) where[col] = value;
  }
  return where;
}

/**
 * Which columns an undo has to write back.
 *
 * Normally that is whatever actually differs between before and after. A change
 * captured from the SQL command page has no reliable "after" — the statement may
 * have set a column from an expression we did not evaluate — so it names the
 * columns it wrote on the change itself, and those are restored from `before`.
 */
export function columnsToRestore(change, row) {
  if (change && change.restoreCols && change.restoreCols.length) {
    const before = row.before || {};
    return change.restoreCols.filter((col) => Object.prototype.hasOwnProperty.call(before, col));
  }
  return changedColumns(row);
}

/** Columns whose value actually differs between before and after. */
export function changedColumns(row) {
  const before = row.before || {};
  const after = row.after || {};
  return Object.keys(after).filter((col) => {
    if (!Object.prototype.hasOwnProperty.call(before, col)) return false;
    return !sameValue(before[col], after[col]);
  });
}

/** NULL is not the empty string, and a number typed as text is still that text. */
export function sameValue(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return String(a) === String(b);
}

/**
 * Why a change cannot be rolled back automatically, or '' when it can.
 * Reported as a stable code; the UI translates it.
 */
export function blockingReason(change) {
  if (!UNDOABLE_OPS.has(change.op)) return 'unsupported-op';
  if (!change.table) return 'no-table';
  if (!change.rows || !change.rows.length) return 'no-rows';
  for (const row of change.rows) {
    const where = undoWhere(row, change.keyCols);
    if (!Object.keys(where).length) return change.op === 'insert' ? 'insert-key-unknown' : 'no-key';
    if (change.op === 'update' && !columnsToRestore(change, row).length) return 'nothing-to-restore';
    if (change.op === 'delete' && !Object.keys(row.before || {}).length) return 'no-before';
  }
  if ((change.unreadableCols || []).length) return 'unreadable-columns';
  return '';
}

/**
 * Why a change cannot be applied again, or '' when it can.
 *
 * Same shape as `blockingReason`, with one reason of its own. A redo writes the
 * values the capture read back after the write; a change that has none — a bulk
 * statement typed on the SQL page, an INSERT whose row could not be read — is
 * refused as `redo-no-after` instead of being re-applied as an empty statement.
 */
export function redoBlockingReason(change) {
  if (!UNDOABLE_OPS.has(change.op)) return 'unsupported-op';
  if (!change.table) return 'no-table';
  if (!change.rows || !change.rows.length) return 'no-rows';
  for (const row of change.rows) {
    // The predicate is the recorded one: a redo runs against a row that has been
    // put back, so the key it was reached by is the key it has again. An INSERT
    // needs one too — without it the original row was never removed by the
    // rollback either, and inserting it again would duplicate it.
    if (!Object.keys(row.where || {}).length) return change.op === 'insert' ? 'insert-key-unknown' : 'no-key';
    if (change.op === 'update' && !changedColumns(row).length) return 'redo-no-after';
    if (change.op === 'insert' && !Object.keys(row.after || {}).length) return 'redo-no-after';
  }
  if ((change.unreadableCols || []).length) return 'unreadable-columns';
  return '';
}

/**
 * The statements that apply one change again — the mirror of `undoStatements`.
 *
 * An UPDATE sets the values it set the first time, a DELETE removes the row it
 * removed, an INSERT puts back the row it created, keeping the key it was given
 * so that rolling it back a second time still finds it.
 */
export function redoStatements(change, engine = 'mysql', opts = {}) {
  const eng = ENGINE_ALIASES[engine] || engine;
  const schema = change.schema || '';
  const out = [];

  for (const row of change.rows || []) {
    const where = row.where || {};
    const keyless = !Object.keys(where).length;

    if (change.op === 'update') {
      const sets = {};
      for (const col of changedColumns(row)) sets[col] = row.after[col];
      if (!Object.keys(sets).length) continue;
      out.push(buildUpdate(change.table, sets, where, eng, schema));
    } else if (change.op === 'delete') {
      out.push(buildDelete(change.table, where, eng, schema, opts.limitGuard && keyless ? 1 : 0));
    } else if (change.op === 'insert') {
      // Nothing recorded to put back: `redoBlockingReason` says so, and an empty
      // INSERT would not parse anyway.
      if (!row.after || !Object.keys(row.after).length) continue;
      out.push(buildInsert(change.table, row.after, eng, schema));
    }
  }
  return out;
}

/**
 * The statements that undo one change, newest row first.
 *
 * `opts.limitGuard` adds LIMIT 1 to a DELETE built for a keyless table — only
 * meaningful when the caller has decided to go ahead despite `blockingReason`.
 */
export function undoStatements(change, engine = 'mysql', opts = {}) {
  const eng = ENGINE_ALIASES[engine] || engine;
  const schema = change.schema || '';
  const out = [];

  for (const row of change.rows || []) {
    const where = undoWhere(row, change.keyCols);
    const keyless = !Object.keys(where).length;

    if (change.op === 'update') {
      const sets = {};
      for (const col of columnsToRestore(change, row)) sets[col] = row.before[col];
      // A row that the capture recorded but nothing actually changed in needs no
      // statement — emitting `SET` with an empty list would not even parse.
      if (!Object.keys(sets).length) continue;
      out.push(buildUpdate(change.table, sets, where, eng, schema));
    } else if (change.op === 'delete') {
      out.push(buildInsert(change.table, row.before, eng, schema));
    } else if (change.op === 'insert') {
      out.push(buildDelete(change.table, where, eng, schema, opts.limitGuard && keyless ? 1 : 0));
    }
  }
  return out;
}

const ENGINE_ALIASES = { server: 'mysql', mariadb: 'mysql', postgres: 'pgsql', postgresql: 'pgsql' };

/** Every statement for a whole session, newest change first (LIFO). */
export function sessionUndoScript(session, opts = {}) {
  const engine = engineOf(session.conn && session.conn.driver);
  const changes = [...(session.changes || [])]
    .filter((c) => !c.undone)
    .sort((a, b) => b.seq - a.seq);
  const out = [];
  for (const change of changes) {
    if (blockingReason(change) && !opts.includeBlocked) continue;
    out.push(...undoStatements(change, engine, opts));
  }
  return out;
}

/**
 * Is the row still where the run about to touch it expects it to be?
 *
 * `current` is the row as it is right now, read back through the same edit-form
 * parser that captured it. Only the columns this change wrote are compared —
 * a colleague editing a different column of the same row is not a conflict.
 *
 * Which values it should hold depends on the direction. An undo expects the
 * change's own "after": anything else means someone wrote over it. A redo runs
 * on a row that was rolled back, so it expects "before" instead.
 *
 * Values the capture never recorded cannot be compared at all; that is reported
 * as `unknown` rather than as "no drift", because the two would lead a user to
 * opposite decisions.
 */
export function driftOf(change, row, current, dir = 'undo') {
  if (!current) return { missing: true, unknown: false, diffs: [] };
  const want = dir === 'redo' ? row.before : row.after;
  if (!want || !Object.keys(want).length) return { missing: false, unknown: true, diffs: [] };

  const diffs = [];
  for (const col of columnsToRestore(change, row)) {
    if (!Object.prototype.hasOwnProperty.call(current, col)) continue;
    if (!Object.prototype.hasOwnProperty.call(want, col)) continue;
    if (!sameValue(current[col], want[col])) {
      diffs.push({ col, expected: want[col], actual: current[col] });
    }
  }
  return { missing: false, unknown: false, diffs };
}
