/**
 * rollback.js — running a changeset backwards, or forwards again.
 *
 * The order is the only interesting part: newest change first. A test that
 * inserted a parent row and then updated it has to have the update undone before
 * the insert, or the update's predicate no longer matches anything. A redo runs
 * the same changeset the other way round — oldest first — for the same reason:
 * the row has to exist again before the edit that followed it can be re-applied.
 *
 * Each change is run as its own submission rather than one big script, so a
 * failure half way leaves an accurate record: everything before it is marked
 * undone, everything after is still pending, and the report says which statement
 * stopped it. A single script would leave the session lying about its own state.
 *
 * Drift is checked per row, not per change. If one row of a twenty-row bulk
 * update was edited by someone else in the meantime, that row is left alone and
 * the other nineteen are still restored — refusing the whole change would make
 * the common case (one stale row) unnecessarily painful.
 *
 * And it is checked immediately before each change is undone, never up front for
 * the whole session. A session that edited one row and then ran a bulk statement
 * over it has changed that row twice; scanning everything before starting would
 * see the bulk statement's value sitting where the row edit's value should be and
 * call it a conflict, when in fact the very next statement of this rollback puts
 * it back. By the time the earlier change's turn comes, the later one has already
 * been undone and there is nothing to report.
 */

import {
  blockingReason, redoBlockingReason, undoStatements, redoStatements, driftOf, undoWhere,
} from './undo.js';
import { engineOf, joinStatements } from './sqlquote.js';
import { runSql, readRow } from './executor.js';
import { updateChange } from './session.js';

const noop = () => {};

/**
 * Check every row of a change and report the ones that moved under us.
 * A value the capture never recorded cannot be checked and is reported as such.
 */
export async function checkDrift(ctx, change, dir = 'undo') {
  const redo = dir === 'redo';
  const out = [];
  for (const row of change.rows || []) {
    const where = redo ? (row.where || {}) : undoWhere(row, change.keyCols);
    let current = null;
    try {
      const read = await readRow(ctx, change.table, where);
      current = read.ok ? read.values : null;
    } catch (err) {
      out.push({ row, error: String(err && err.message || err) });
      continue;
    }

    // The statement that puts a row back — an undone DELETE, a redone INSERT —
    // has nothing to compare: finding the row already there is the conflict.
    if (redo ? change.op === 'insert' : change.op === 'delete') {
      if (current) out.push({ row, present: true, diffs: [] });
      continue;
    }
    const drift = driftOf(change, row, current, dir);
    if (drift.missing) out.push({ row, missing: true, diffs: [] });
    else if (drift.diffs.length) out.push({ row, diffs: drift.diffs });
  }
  return out;
}

/**
 * Roll back part or all of a session.
 *
 * `opts.changeIds` limits it to specific changes, `opts.force` runs rows that
 * drifted regardless, `opts.dryRun` produces the statements without sending any
 * of them — which is what the preview shows, so the preview and the run are built
 * by one code path and cannot disagree. `opts.onDrift(change, drifted)` is asked
 * what to do about a row that moved, and answers 'force' or 'skip'; without it,
 * drifted rows are skipped.
 *
 * `opts.includeUndone` runs changes that were already rolled back once. A session
 * is not spent after one rollback: the same test can be run again, or the data put
 * back a second time after someone changed it, and the undo statements are built
 * from the recorded before/after either way.
 */
export function runRollback(ctx, session, opts = {}) {
  return runChanges(ctx, session, opts, 'undo');
}

/**
 * Apply part or all of a session again, after it was rolled back.
 *
 * The test that was undone, run a second time without redoing it by hand: the
 * same rows are given the same values, in the order they were given them.
 *
 * It considers the changes that were rolled back; `opts.includeApplied` takes in
 * the ones still applied as well, which writes their recorded values over
 * whatever is there now. Every other option means what it does for a rollback.
 */
export function runRedo(ctx, session, opts = {}) {
  return runChanges(ctx, session, opts, 'redo');
}

async function runChanges(ctx, session, opts, dir) {
  const redo = dir === 'redo';
  const onProgress = opts.onProgress || noop;
  const engine = ctx.engine || engineOf(session.conn && session.conn.driver);

  const wanted = new Set(opts.changeIds || []);
  const changes = [...(session.changes || [])]
    .filter((c) => (redo ? (opts.includeApplied || c.undone) : (opts.includeUndone || !c.undone)))
    .filter((c) => !wanted.size || wanted.has(c.id))
    .sort((a, b) => (redo ? a.seq - b.seq : b.seq - a.seq));

  const report = { total: changes.length, ok: 0, failed: 0, skipped: 0, statements: [], details: [] };

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    const reason = redo ? redoBlockingReason(change) : blockingReason(change);
    if (reason) {
      report.skipped++;
      report.details.push({ change: change.id, skipped: reason });
      continue;
    }

    let rows = change.rows || [];
    if (opts.driftCheck && !opts.dryRun) {
      onProgress({ phase: 'drift', i: i + 1, n: changes.length, change });
      const drifted = await checkDrift(ctx, change, dir);
      if (drifted.length) {
        const answer = opts.force
          ? 'force'
          : (opts.onDrift ? await opts.onDrift(change, drifted) : 'skip');
        if (answer !== 'force') {
          const bad = new Set(drifted.map((d) => d.row));
          rows = rows.filter((r) => !bad.has(r));
        }
        report.details.push({ change: change.id, drifted: drifted.length, answer });
      }
    }

    if (!rows.length) {
      report.skipped++;
      report.details.push({ change: change.id, skipped: 'all-rows-drifted' });
      continue;
    }

    const statements = redo
      ? redoStatements({ ...change, rows }, engine, opts)
      : undoStatements({ ...change, rows }, engine, opts);
    if (!statements.length) {
      report.skipped++;
      report.details.push({ change: change.id, skipped: redo ? 'redo-no-after' : 'nothing-to-restore' });
      continue;
    }
    report.statements.push(...statements);

    if (opts.dryRun) {
      report.ok++;
      continue;
    }

    onProgress({ phase: 'run', i: i + 1, n: changes.length, change });
    let result;
    try {
      result = await runSql(ctx, joinStatements(statements));
    } catch (err) {
      result = { ok: false, errors: [String(err && err.message || err)] };
    }

    if (result.ok) {
      report.ok++;
      const fully = rows.length === (change.rows || []).length;
      const at = new Date().toISOString();
      // A redo puts the change back among the pending ones even when only some of
      // its rows went through: what is in the database is the test's value again,
      // and a rollback has to know that.
      await updateChange(session.id, change.id, redo
        ? { undone: false, redoneAt: at, partialRedo: !fully }
        : { undone: fully, undoneAt: at, partialUndo: !fully });
      report.details.push({ change: change.id, ok: true, partial: !fully });
    } else {
      report.failed++;
      report.details.push({ change: change.id, ok: false, errors: result.errors });
      // Stop at the first real failure: the statements after it were built on the
      // assumption that this one landed.
      break;
    }
  }

  return report;
}
