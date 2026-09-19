/**
 * content-main.js — the part that runs inside an Adminer tab.
 *
 * It does four things: settle whatever the previous page left behind, put the
 * panel up, watch the page for writes, and run a rollback when asked.
 *
 * ── Why a change is "pending" first ───────────────────────────────────────────
 * Adminer navigates on every save, so the page that makes a change is never the
 * page that finds out whether it worked. A capture is therefore parked in storage
 * on submit and committed by whichever page loads next, once it can see whether
 * Adminer rendered an error. A change that failed is dropped instead of being
 * recorded as something to roll back — a rollback that undoes a write which never
 * happened is worse than no rollback at all.
 *
 * ── Why the submit is intercepted ────────────────────────────────────────────
 * Writing to `chrome.storage` is asynchronous, and a navigation cancels it. So
 * the submit is held, the capture is written, and the form is then submitted
 * again through `requestSubmit(submitter)` so Adminer still receives the exact
 * button that was pressed. Every path out of that is wrapped: a failure to
 * capture must never stop somebody's edit from going through, and a watchdog
 * submits anyway if the capture is slow.
 */

import { parseAdminerUrl, connKey } from './params.js';
import * as adminer from './adapters/adminer.js';
import * as store from './session.js';
import { engineOf, joinStatements } from './sqlquote.js';
import { blockingReason, undoStatements } from './undo.js';
import { runRollback } from './rollback.js';
import { selectRows, readRow, discoverKeyCols } from './executor.js';
import { splitStatements, describeStatement, prefetchSelect, isDestructiveDdl } from './sqlcapture.js';
import { mountPanel } from './panel.js';
import { t, setLang } from './i18n.js';

const SUBMIT_WATCHDOG_MS = 8000;
const PENDING_TTL_MS = 2 * 60 * 1000;
const READ_BATCH = 5;

const state = {
  ctx: null,
  settings: null,
  session: null,
  panel: null,
};

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function pick(obj, keys) {
  const out = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) out[key] = obj[key];
  }
  return out;
}

/* === Boot ════════════════════════════════════════════════════════════════ */

export async function boot() {
  const found = adminer.detect(document);
  if (!found.ok) return;

  const settings = await store.getSettings();
  if (!settings.enabled) return;
  setLang(settings.lang);

  const info = parseAdminerUrl(location.href);
  state.settings = settings;
  state.ctx = {
    base: info.base,
    origin: info.origin,
    conn: info.conn,
    key: connKey(info.origin, info.conn),
    engine: settings.engineOverride || engineOf(info.conn.driver),
    adminerVersion: found.version,
  };

  state.panel = mountPanel({
    onStart: startSession,
    onStop: stopSession,
    onView: openManager,
    onExportSql: exportSql,
    onRollbackAll: () => rollback({}),
  });

  await refresh();
  await settlePending();

  if (info.page === 'edit') wireEditPage(info);
  if (info.page === 'sql') wireSqlPage();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.dbtoolsSessions || changes.dbtoolsActive) refresh();
    // Settings are read once at boot; without this an Adminer tab left open would
    // keep the old row cap and drift setting until it is reloaded.
    if (changes.dbtoolsSettings) {
      store.getSettings().then((next) => {
        state.settings = next;
        setLang(next.lang);
        state.panel.render({ session: state.session, engine: state.ctx.engine });
      });
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'dbtools-run-rollback') return undefined;
    // The manager page cannot run this itself: its fetches would be cross-site and
    // Adminer's session cookie would not be sent. It asks the tab instead.
    rollback({ sessionId: msg.sessionId, changeIds: msg.changeIds })
      .then((report) => sendResponse({ ok: true, report }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  });
}

async function refresh() {
  state.session = await store.activeSession(state.ctx.key);
  state.panel.render({ session: state.session, engine: state.ctx.engine });

  const pendingCount = (state.session?.changes || []).filter((c) => !c.undone).length;
  if (state.session && state.session.closedAt && pendingCount) {
    state.panel.log(t('panel.unsaved', { name: state.session.name, n: pendingCount }), 'warn');
  }
  return state.session;
}

/* === Session controls ════════════════════════════════════════════════════ */

async function startSession() {
  const name = window.prompt(t('panel.promptName'), `${t('panel.defaultName')} ${new Date().toLocaleString()}`);
  if (name === null) return;
  await store.startSession({
    name: name.trim() || t('panel.defaultName'),
    conn: state.ctx.conn,
    origin: state.ctx.origin,
    base: state.ctx.base,
    key: state.ctx.key,
  });
  await refresh();
  state.panel.expand();
}

async function stopSession() {
  if (!state.session) return;
  await store.closeSession(state.session.id);
  await refresh();
}

function openManager() {
  chrome.runtime.sendMessage({ type: 'dbtools-open-manager', sessionId: state.session?.id || '' });
}

/* === Recording ═══════════════════════════════════════════════════════════ */

/** Park a capture until the next page can confirm it. */
async function park(changes) {
  if (!changes.length) return;
  await store.setPending(state.ctx.key, { at: Date.now(), changes });
}

/**
 * Commit or drop what the previous page parked.
 *
 * An error on this page means Adminer refused the write, so the capture goes in
 * the bin. No error and no message is treated as success but flagged
 * `verified: false`, because the only other explanation — the response never
 * rendered — is indistinguishable from here.
 */
async function settlePending() {
  const pending = await store.takePending(state.ctx.key);
  if (!pending) return;

  if (Date.now() - pending.at > PENDING_TTL_MS) {
    state.panel.log(`${t('panel.captureFailed', { reason: 'stale' })}`, 'warn');
    return;
  }

  const errors = adminer.readErrors(document);
  if (errors.length) {
    state.panel.log(`${t('panel.captureFailed', { reason: errors[0] })}`, 'warn');
    return;
  }

  const session = state.session || (await store.activeSession(state.ctx.key));
  if (!session) return;
  const verified = adminer.readMessages(document).length > 0;

  for (const change of pending.changes) {
    await store.appendChange(session.id, { ...change, verified });
    const reason = blockingReason(change);
    if (reason) {
      state.panel.log(t('panel.notUndoable', { reason: t(`reason.${reason}`) }), 'warn');
    } else {
      state.panel.log(
        t('panel.recorded', { op: t(`op.${change.op}`), table: change.table, n: change.rows.length }),
        'ok',
      );
    }
  }
  await refresh();
}

/**
 * Submit the form again after the capture has been stored.
 * `requestSubmit` is used so Adminer still sees which button was pressed.
 */
function resubmit(form, submitter) {
  form.dataset.frpDbtools = 'go';
  try {
    if (submitter && typeof form.requestSubmit === 'function') {
      form.requestSubmit(submitter);
      return;
    }
  } catch { /* fall through to the plain submit below */ }

  if (submitter && submitter.name) {
    const hidden = document.createElement('input');
    hidden.type = 'hidden';
    hidden.name = submitter.name;
    hidden.value = submitter.value ?? '';
    form.append(hidden);
  }
  form.submit();
}

/**
 * Wrap a form submit in an async capture, with a watchdog so a slow or broken
 * capture can never hold somebody's edit hostage.
 */
function interceptSubmit(form, capture) {
  form.addEventListener('submit', (event) => {
    if (form.dataset.frpDbtools === 'go') return;   // our own re-submit
    const submitter = event.submitter || null;
    if (!state.session || state.session.closedAt) return;

    event.preventDefault();
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      resubmit(form, submitter);
    };
    const watchdog = setTimeout(go, SUBMIT_WATCHDOG_MS);

    Promise.resolve()
      .then(() => capture(submitter))
      .catch((err) => state.panel.log(t('panel.captureFailed', { reason: String(err && err.message || err) }), 'err'))
      .finally(() => { clearTimeout(watchdog); go(); });
  }, true);
}

/* === The row edit page ═══════════════════════════════════════════════════ */

function wireEditPage(info) {
  const form = adminer.findEditForm(document);
  if (!form) return;

  const snapshot = adminer.readEditForm(document, form);
  if (!snapshot.ok) {
    state.panel.log(t('panel.captureFailed', { reason: snapshot.reason }), 'warn');
    return;
  }

  const keyCols = Object.keys(info.where);
  const isInsert = keyCols.length === 0;
  const before = snapshot.values;

  interceptSubmit(form, async (submitter) => {
    const isDelete = Boolean(submitter && /delete/i.test(`${submitter.name || ''} ${submitter.value || ''}`));
    const now = adminer.readEditForm(document, form);
    const after = now.ok ? now.values : {};

    let change = null;
    if (isDelete) {
      change = {
        id: newId('ch'),
        at: new Date().toISOString(),
        op: 'delete',
        table: info.table,
        keyCols,
        rows: [{ where: info.where, before, after: null }],
        source: 'edit-form',
        warnings: snapshot.flags,
        unreadableCols: snapshot.unreadable,
      };
    } else if (isInsert) {
      // An insert cannot name the row it is about to create, so it is recorded
      // for the log and openly marked as not automatically undoable.
      change = {
        id: newId('ch'),
        at: new Date().toISOString(),
        op: 'insert',
        table: info.table,
        keyCols: [],
        rows: [{ where: {}, before: null, after }],
        source: 'edit-form',
        warnings: [...snapshot.flags, 'insert-key-unknown'],
        unreadableCols: snapshot.unreadable,
      };
    } else {
      const row = { where: info.where, before, after };
      change = {
        id: newId('ch'),
        at: new Date().toISOString(),
        op: 'update',
        table: info.table,
        keyCols,
        rows: [row],
        source: 'edit-form',
        warnings: snapshot.flags,
        unreadableCols: snapshot.unreadable,
      };
      // Nothing actually changed — Adminer will happily "save" it, but there is
      // nothing to put back, and a no-op entry only makes the changeset harder
      // to read.
      if (!undoStatements(change, state.ctx.engine).length) change = null;
    }

    if (change) await park([change]);
  });
}

/* === The SQL command page ════════════════════════════════════════════════ */

function wireSqlPage() {
  const found = adminer.findSqlForm(document);
  if (!found) return;

  interceptSubmit(found.form, async () => {
    if (!state.settings.captureSqlPage) return;
    const sql = adminer.readSqlQuery(found);

    // Put the text where Adminer expects to find it. Adminer copies the
    // highlighter's content into the hidden textarea from its own submit
    // handler, and holding the submit and re-issuing it is not guaranteed to run
    // that copy a second time — when it does not, the statement posts with an
    // empty `query` and comes back "No commands to execute". Writing it
    // ourselves makes the re-submit independent of that ordering; if Adminer's
    // copy does run again it writes the identical text.
    if (sql && found.textarea.value !== sql) found.textarea.value = sql;

    const statements = splitStatements(sql);

    const captures = [];
    for (const text of statements) {
      if (isDestructiveDdl(text)) {
        state.panel.log(t('panel.notUndoable', { reason: text.split(/\s+/)[0].toUpperCase() }), 'err');
        continue;
      }
      const desc = describeStatement(text);
      if (desc.kind !== 'update' && desc.kind !== 'delete' && desc.kind !== 'insert') continue;

      state.panel.log(t('panel.capturing'));
      const change = await captureStatement(desc);
      if (change) captures.push(change);
    }
    await park(captures);
  });
}

/**
 * Snapshot the rows one hand-written statement is about.
 *
 * Always returns a change, even when it could not snapshot anything: a statement
 * that ran and was not recorded is exactly the thing a person needs to be told
 * about, so it goes into the changeset carrying its own reason.
 */
async function captureStatement(desc) {
  const base = {
    id: newId('ch'),
    at: new Date().toISOString(),
    op: desc.kind,
    table: desc.table,
    schema: desc.schema,
    source: 'sql-page',
    statement: desc.sql,
    keyCols: [],
    rows: [],
    warnings: [],
  };

  if (!desc.capturable) {
    base.warnings.push(desc.reason);
    state.panel.log(t('panel.notUndoable', { reason: t(`reason.${desc.reason}`) }), 'warn');
    return base;
  }

  const keyCols = await keyColsFor(desc.table);
  if (!keyCols) {
    base.warnings.push('no-key');
    state.panel.log(t('panel.notUndoable', { reason: t('reason.no-key') }), 'warn');
    return base;
  }
  base.keyCols = keyCols;
  if (desc.kind === 'update') base.restoreCols = desc.setCols;

  const limit = state.settings.prefetchLimit;
  const sql = prefetchSelect(desc, state.ctx.engine, limit, keyCols);
  let found;
  try {
    found = await selectRows(state.ctx, sql);
  } catch (err) {
    found = { ok: false, errors: [String(err && err.message || err)] };
  }
  if (!found.ok) {
    base.warnings.push(`prefetch-failed:${found.errors[0] || ''}`);
    state.panel.log(t('panel.captureFailed', { reason: found.errors[0] || '' }), 'err');
    return base;
  }
  if (found.rows.length > limit) {
    base.warnings.push('too-many-rows');
    state.panel.log(t('panel.tooManyRows', { n: limit }), 'err');
    return base;
  }

  // The grid gave us which rows; each row's real values come from its edit form,
  // where Adminer abbreviates nothing.
  const keys = found.rows.map((row) => pick(normaliseRow(row), keyCols));
  base.rows = await readRows(desc.table, keys);
  if (!base.rows.length && keys.length) base.warnings.push('no-before');
  return base;
}

/** Result-grid headers can carry sort links and padding; the values do not. */
function normaliseRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[String(key).trim()] = typeof value === 'string' ? value.trim() : value;
  }
  return out;
}

/** Read each row's full values through its edit form, a few at a time. */
async function readRows(table, keys) {
  const rows = [];
  for (let i = 0; i < keys.length; i += READ_BATCH) {
    const slice = keys.slice(i, i + READ_BATCH);
    const read = await Promise.all(slice.map(async (where) => {
      try {
        const res = await readRow(state.ctx, table, where);
        return res.ok ? { where, before: res.values, after: {} } : null;
      } catch {
        return null;
      }
    }));
    for (const row of read) if (row) rows.push(row);
  }
  return rows;
}

/** Key columns for a table, discovered once and cached per connection. */
async function keyColsFor(table) {
  const cached = await store.getKeyCols(state.ctx.key, table);
  if (cached) return cached.length ? cached : null;
  let cols = null;
  try {
    cols = await discoverKeyCols(state.ctx, table);
  } catch {
    cols = null;
  }
  await store.setKeyCols(state.ctx.key, table, cols || []);
  return cols;
}

/* === Rollback ════════════════════════════════════════════════════════════ */

async function exportSql() {
  const session = state.session || (await refresh());
  if (!session) return;
  const dry = await runRollback(state.ctx, session, { dryRun: true });
  if (!dry.statements.length) {
    state.panel.log(t('rollback.nothing'), 'warn');
    return;
  }
  const sql = joinStatements(dry.statements);
  const go = await state.panel.preview({
    title: t('rollback.title'),
    sql,
    note: dry.skipped ? t('rollback.blocked', { n: dry.skipped }) : '',
    confirmLabel: t('rollback.copy'),
  });
  if (!go) return;
  try {
    await navigator.clipboard.writeText(sql);
    state.panel.log(t('rollback.copied'), 'ok');
  } catch {
    state.panel.log(t('rollback.copied'), 'warn');
  }
}

async function rollback({ sessionId, changeIds } = {}) {
  const session = sessionId ? await store.getSession(sessionId) : (state.session || (await refresh()));
  if (!session) return { total: 0, ok: 0, failed: 0, skipped: 0, statements: [], details: [] };

  const dry = await runRollback(state.ctx, session, { dryRun: true, changeIds });
  if (!dry.statements.length) {
    state.panel.log(t('rollback.nothing'), 'warn');
    state.panel.expand();
    return dry;
  }

  const go = await state.panel.preview({
    title: t('rollback.title'),
    sql: joinStatements(dry.statements),
    note: dry.skipped ? t('rollback.blocked', { n: dry.skipped }) : '',
    confirmLabel: t('rollback.confirm', { n: dry.statements.length }),
  });
  if (!go) return dry;

  const report = await runRollback(state.ctx, session, {
    changeIds,
    driftCheck: state.settings.driftCheck,
    onDrift: askAboutDrift,
    onProgress: ({ i, n }) => state.panel.log(t('rollback.running', { i, n })),
  });
  state.panel.log(t('rollback.done', { ok: report.ok, fail: report.failed }), report.failed ? 'err' : 'ok');
  await refresh();
  return report;
}

/**
 * Ask what to do about rows that moved since they were recorded.
 * Asked per change, at the moment that change is about to be undone.
 */
async function askAboutDrift(change, drifted) {
  const lines = [];
  for (const entry of drifted) {
    const where = Object.entries(entry.row.where || {})
      .map(([col, value]) => `${col}=${value === null ? 'NULL' : value}`).join(', ');
    if (entry.missing || entry.present) {
      lines.push(t('rollback.driftMissing', { table: change.table, where }));
    } else {
      for (const diff of entry.diffs) {
        lines.push(t('rollback.driftRow', {
          table: change.table, where, col: diff.col,
          actual: diff.actual, expected: diff.expected,
        }));
      }
    }
  }
  const force = await state.panel.preview({
    title: t('rollback.driftTitle'),
    sql: lines.join('\n'),
    note: t('rollback.driftSkip'),
    confirmLabel: t('rollback.driftForce'),
  });
  return force ? 'force' : 'skip';
}
