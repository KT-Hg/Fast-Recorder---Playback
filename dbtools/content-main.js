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
 * The one save that does not navigate is "Save and continue editing", which
 * Adminer sends over AJAX; wireAjaxSave handles it on the page it came from.
 *
 * ── Why the submit is intercepted ────────────────────────────────────────────
 * Writing to `chrome.storage` is asynchronous, and a navigation cancels it. So
 * the submit is held, the capture is written, and the form is then submitted
 * again through `requestSubmit(submitter)` so Adminer still receives the exact
 * button that was pressed. Every path out of that is wrapped: a failure to
 * capture must never stop somebody's edit from going through, and a watchdog
 * submits anyway if the capture is slow.
 */

import { parseAdminerUrl, connKey, connLabel, parseRowIdf } from './params.js';
import * as adminer from './adapters/adminer.js';
import * as store from './session.js';
import { engineOf, joinStatements } from './sqlquote.js';
import { blockingReason, undoStatements, undoWhere } from './undo.js';
import { runRollback } from './rollback.js';
import {
  selectRows, readRow, readRowByIdf, discoverKeyCols, selectFull, gridIdfs, runSql,
} from './executor.js';
import {
  splitStatements, describeStatement, prefetchSelect, isDestructiveDdl, literalInsertKeys,
} from './sqlcapture.js';
import {
  snapshotSelect, keysSelect, keyOf, keyWhere, newRows, diffSnapshot, restoreStatements,
  backupName, backupCreateSql, backupRestoreSql, backupDropSql,
} from './snapshot.js';
import { mountPanel } from './panel.js';
import { t, setLang } from './i18n.js';

const SUBMIT_WATCHDOG_MS = 8000;
const AJAX_SAVE_TIMEOUT_MS = 30 * 1000;
const PENDING_TTL_MS = 2 * 60 * 1000;
const READ_BATCH = 5;

const state = {
  ctx: null,
  info: null,
  settings: null,
  session: null,
  panel: null,
  on: false,      // is the integration switched on right now?
  wired: false,   // have this page's forms been hooked?
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
  setLang(settings.lang);
  state.panel = silentPanel();

  const info = parseAdminerUrl(location.href);
  state.info = info;
  state.settings = settings;
  state.ctx = {
    base: info.base,
    origin: info.origin,
    conn: info.conn,
    key: connKey(info.origin, info.conn),
    engine: settings.engineOverride || engineOf(info.conn.driver),
    adminerVersion: found.version,
  };

  // The switch in the popup (and in the manager's settings) has to take effect on
  // the Adminer tabs that are already open, not only on the next page load — so
  // everything below is arranged to be turned on and off, and the listeners are
  // registered whether it is on or not.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.dbtoolsSessions || changes.dbtoolsActive) refresh();
    // Settings are read once at boot; without this an Adminer tab left open would
    // keep the old row cap and drift setting until it is reloaded.
    if (changes.dbtoolsSettings) {
      store.getSettings().then((next) => {
        const was = state.settings.enabled;
        state.settings = next;
        setLang(next.lang);
        if (next.enabled && !was) start();
        else if (!next.enabled && was) stop();
        else if (next.enabled) state.panel.render({ session: state.session, engine: state.ctx.engine });
      });
    }
  });

  if (settings.enabled) await start();

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const handler = msg && MESSAGES[msg.type];
    if (!handler) return undefined;
    // The manager page and the background cannot do any of this themselves: their
    // fetches would be cross-site and Adminer's session cookie would not be sent.
    // They ask the tab instead — and only a tab on the right database may answer,
    // because every statement runs against whatever this tab is connected to.
    Promise.resolve()
      .then(async () => {
        const key = msg.key || (msg.sessionId ? (await store.getSession(msg.sessionId) || {}).key : '');
        if (key && key !== state.ctx.key) return { ok: false, wrongConn: true };
        // Switched off, this tab runs nothing: a rollback needs the preview, and
        // there is no panel to show it in.
        if (!state.on && msg.type !== 'dbtools-ping') return { ok: false, error: 'integration-off' };
        return handler(msg);
      })
      .then((answer) => sendResponse(answer))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  });
}

/**
 * Put the panel up and start watching this page.
 *
 * Safe to call twice: the panel is replaced, but a page is only wired once — the
 * submit hooks would otherwise capture the same edit as many times as the switch
 * has been flipped. A page that loaded while the feature was off is wired here,
 * the first time it is turned on.
 */
async function start() {
  state.on = true;
  state.panel = mountPanel({
    onStart: guarded(startSession),
    onStop: guarded(stopSession),
    onView: guarded(openManager),
    onExportSql: guarded(exportSql),
    onRollbackAll: guarded(() => rollback({})),
    onSnapshot: guarded(promptSnapshot),
    onBackup: guarded(promptBackup),
  });

  await refresh();
  await rememberConnection();

  if (state.wired) return;
  state.wired = true;
  await settlePending();
  const { info } = state;
  if (info.page === 'edit') wireEditPage(info);
  if (info.page === 'select') wireSelectPage(info);
  if (info.page === 'sql') wireSqlPage();
}

/**
 * Take the panel down and stop recording.
 *
 * The page's hooks cannot be unhooked — they are closures around forms that are
 * still on screen — so they ask `state.on` before capturing anything, and the
 * panel is replaced by one that swallows what they say instead of throwing.
 */
function stop() {
  state.on = false;
  if (state.panel && state.panel.destroy) state.panel.destroy();
  state.panel = silentPanel();
}

/**
 * A panel button must never fail silently.
 *
 * Every one of them ends in a write to `chrome.storage.local`, and a write that
 * fails — the quota is the one that happens in practice, once a long test run has
 * filled it — rejects a promise nobody was awaiting. The button then looks
 * broken: pressing "End" does nothing at all, with no way to tell why. So the
 * reason is put in the panel's own log, where the person pressing the button is
 * already looking.
 */
function guarded(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      const reason = String((err && err.message) || err);
      state.panel.log(/quota/i.test(reason) ? t('panel.storageFull') : t('panel.actionFailed', { reason }), 'err');
      state.panel.expand();
    }
  };
}

/** Stand-in for the panel while the feature is off. */
function silentPanel() {
  return {
    render() {}, log() {}, expand() {}, destroy() {},
    preview: async () => false,   // nothing may run without someone to confirm it
    ask: async () => null,
  };
}

/** What the manager page and the background may ask an Adminer tab to do. */
const MESSAGES = {
  'dbtools-ping': async () => ({ ok: true, key: state.ctx.key, on: state.on }),
  'dbtools-run-rollback': async (msg) => ({
    ok: true,
    report: await rollback({
      sessionId: msg.sessionId, changeIds: msg.changeIds, includeUndone: msg.includeUndone,
    }),
  }),
  'dbtools-snapshot-restore': async (msg) => {
    const session = await store.getSession(msg.sessionId);
    return { ok: true, report: await restoreSnapshots(session, { snapIds: msg.snapIds }) };
  },
  'dbtools-backup-restore': async (msg) =>
    ({ ok: true, report: await restoreBackup(await store.getSession(msg.sessionId), msg.backupId) }),
  'dbtools-backup-drop': async (msg) =>
    ({ ok: true, report: await dropBackup(await store.getSession(msg.sessionId), msg.backupId) }),
  'dbtools-guard-begin': guardBegin,
  'dbtools-guard-end': guardEnd,
};

/**
 * Keep a list of the databases this browser has opened in Adminer, for the
 * manager's "protect Playback" setting to choose from. Written once per
 * connection, not on every page load.
 */
async function rememberConnection() {
  const res = await new Promise((resolve) => chrome.storage.local.get(['dbtoolsConns'], resolve));
  const conns = (res && res.dbtoolsConns) || {};
  if (conns[state.ctx.key]) return;
  conns[state.ctx.key] = {
    key: state.ctx.key, origin: state.ctx.origin, base: state.ctx.base,
    conn: state.ctx.conn, label: `${state.ctx.origin} · ${connLabel(state.ctx.conn)}`,
  };
  await new Promise((resolve) => chrome.storage.local.set({ dbtoolsConns: conns }, resolve));
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
  const name = await state.panel.ask({
    title: t('panel.startTitle'),
    label: t('panel.promptName'),
    value: `${t('panel.defaultName')} ${new Date().toLocaleString()}`,
    confirmLabel: t('panel.start'),
  });
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
    state.panel.log(`${t('panel.saveFailed', { reason: errors[0] })}`, 'warn');
    return;
  }

  const session = state.session || (await store.activeSession(state.ctx.key));
  if (!session) return;
  const verified = adminer.readMessages(document).length > 0;

  for (const parked of pending.changes) {
    let change = parked;
    try {
      change = await finalizeChange(parked, pending.changes);
    } catch (err) {
      state.panel.log(t('panel.captureFailed', { reason: String(err && err.message || err) }), 'warn');
    }
    if (!change) continue;
    await store.appendChange(session.id, { ...change, verified });
    logRecorded(change);
  }
  await refresh();
}

/**
 * The part of a capture that can only be done once the write has happened.
 *
 * An edit made in the grid or through a mass edit is recorded with what was
 * typed, but what the database stored can differ — a blank number becomes NULL,
 * a function is applied — so each row is read back and that is the "after". A
 * row that did not actually change is dropped.
 *
 * An INSERT is where this matters most: the new row's key did not exist when the
 * form was submitted. It is found here — from the values that were typed, from
 * Adminer's "Item 42 has been inserted", or by comparing the table's keys with
 * the ones taken before the statement ran — and then the row is read.
 */
async function finalizeChange(change, batch = []) {
  if (change.insertProbe) return finalizeInsert(change, batch);
  if (change.readAfter) return finalizeAfter(change);
  return change;
}

async function finalizeAfter(change) {
  let allRead = true;
  const rows = [];
  for (const row of change.rows) {
    let after = row.after;
    try {
      const read = await readRow(state.ctx, change.table, undoWhere(row, change.keyCols));
      if (read.ok) after = read.values; else allRead = false;
    } catch {
      allRead = false;
    }
    rows.push({ ...row, after });
  }
  const next = { ...change, rows };
  delete next.readAfter;
  // With the rows read back, "what changed" is known exactly; the list of edited
  // columns is only kept as the fallback for rows that could not be read.
  if (allRead) delete next.restoreCols;
  next.rows = rows.filter((row) => undoStatements({ ...next, rows: [row] }, state.ctx.engine).length);
  return next.rows.length ? next : null;
}

async function finalizeInsert(change, batch = []) {
  const probe = change.insertProbe;
  const next = { ...change };
  delete next.insertProbe;
  const table = change.table;
  const engine = state.ctx.engine;

  let keyCols = change.keyCols && change.keyCols.length ? change.keyCols : await keyColsFor(table);
  let wheres = [];
  if (keyCols) {
    if (probe.strategy === 'literal') {
      wheres = probe.wheres;
    } else if (probe.strategy === 'form') {
      // Typed into the form: the key is whatever was typed, unless a key column
      // was left for the database to fill — then Adminer names it in its message.
      const typed = probe.typed || {};
      const functions = probe.functions || {};
      const complete = keyCols.every((col) => typed[col] !== undefined && typed[col] !== null
        && typed[col] !== '' && !functions[col]);
      if (complete) {
        wheres = [keyWhere(typed, keyCols)];
      } else if (keyCols.length === 1) {
        const id = adminer.insertedId(document);
        if (id) wheres = [{ [keyCols[0]]: id }];
      }
    } else if (probe.strategy === 'keys' || probe.strategy === 'rows') {
      const limit = state.settings.keyScanLimit;
      const sql = probe.strategy === 'keys'
        ? keysSelect(table, keyCols, engine, change.schema || '', limit + 1)
        : snapshotSelect(table, engine, change.schema || '', limit + 1);
      const now = await selectFull(state.ctx, sql);
      if (now.ok && now.rows.length <= limit) {
        const beforeKeys = probe.strategy === 'keys'
          ? probe.beforeKeys
          : probe.beforeRows.map((row) => JSON.stringify(row));
        const found = probe.strategy === 'keys'
          ? newRows(beforeKeys, now.rows, keyCols)
          : now.rows.filter((row) => !beforeKeys.includes(JSON.stringify(row)));
        // An INSERT in the same batch that named its keys outright owns those rows;
        // counting them here too would record them twice.
        const claimed = new Set(batch
          .filter((other) => other !== change && other.table === table && other.insertProbe
            && other.insertProbe.strategy === 'literal')
          .flatMap((other) => other.insertProbe.wheres.map((w) => keyOf(w, keyCols))));
        wheres = found.filter((row) => !claimed.has(keyOf(row, keyCols))).map((row) => keyWhere(row, keyCols));
      }
    }
  }

  if (!wheres.length) {
    next.keyCols = keyCols || [];
    next.warnings = [...(next.warnings || []), 'insert-key-unknown'];
    next.rows = [{ where: {}, before: null, after: (change.rows[0] && change.rows[0].after) || null }];
    return next;
  }

  const cap = state.settings.prefetchLimit;
  if (wheres.length > cap) next.warnings = [...(next.warnings || []), 'too-many-rows'];
  const rows = [];
  for (const where of wheres) {
    let after = null;
    if (rows.length < cap) {
      try {
        const read = await readRow(state.ctx, table, where);
        if (read.ok) after = read.values;
      } catch { /* the key is enough to undo it; the values are for reading */ }
    }
    rows.push({ where, before: null, after });
  }
  next.keyCols = keyCols;
  next.rows = rows;
  return next;
}

function logRecorded(change) {
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
    if (!state.on) return;
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

  // The row's identity, as Adminer put it in the URL. A long text key arrives as a
  // hash, which finds the row but cannot go into an undo statement; its real value
  // is in the form, so it is taken from there.
  const ident = parseRowIdf(location.search);
  for (const col of ident.hashed) {
    if (Object.prototype.hasOwnProperty.call(snapshot.values, col)) ident.where[col] = snapshot.values[col];
  }
  info = { ...info, where: ident.where };
  const keyCols = Object.keys(info.where);
  const isInsert = keyCols.length === 0 && !ident.hashed.length;
  // What the row holds right now. It starts as what the form showed at load and
  // moves forward after every "Save and continue editing", which writes without
  // leaving the page — so a later save's "before" is the row as that save found
  // it, not as the page first did.
  const baseline = { values: snapshot.values };

  const buildChange = (submitter, { keepNoop = false } = {}) => {
    const before = baseline.values;
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
      // The new row has no key yet. What was typed is kept, and the key is settled
      // on the next page — see finalizeInsert.
      change = {
        id: newId('ch'),
        at: new Date().toISOString(),
        op: 'insert',
        table: info.table,
        keyCols: [],
        rows: [{ where: {}, before: null, after }],
        source: 'edit-form',
        warnings: snapshot.flags,
        unreadableCols: [],
        insertProbe: { strategy: 'form', typed: after, functions: now.ok ? now.functions : {} },
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
      // to read. The AJAX save keeps it and decides once it has read the row back,
      // since a function like now() changes the row without changing the form.
      if (!keepNoop && !undoStatements(change, state.ctx.engine).length) change = null;
    }
    return change;
  };

  interceptSubmit(form, async (submitter) => {
    const change = buildChange(submitter);
    if (change) await park([change]);
  });

  if (!isInsert) wireAjaxSave(info, form, baseline, buildChange);
}

/**
 * "Save and continue editing" — the one save on the edit page that never submits.
 *
 * Adminer sends it with XMLHttpRequest from the button's click handler and cancels
 * the submit, so the page stays where it is and interceptSubmit never hears of it.
 * What it does leave is two writes into `#ajaxstatus`: its "Saving…" line,
 * synchronously inside the click, and later whatever the server answered. So the
 * change is built at the click and committed or dropped when the answer lands.
 *
 * Whether Adminer really took that path is only known once the click has run —
 * with a file chosen it falls back to a normal submit, and behind a plugin there
 * may be no handler at all. A click that wrote nothing into `#ajaxstatus` is left
 * to interceptSubmit.
 *
 * The listeners go on the form in the capture phase: 4.x puts its handler on the
 * button and 5.x delegates it from `document`, and this has to run before either.
 */
function wireAjaxSave(info, form, baseline, buildChange) {
  const status = document.getElementById('ajaxstatus');
  if (!status) return;

  let probe = null;       // a click whose outcome is not known yet
  const inflight = [];    // saves Adminer has sent and not heard back about

  new MutationObserver(() => {
    if (probe) {
      probe.writes++;
      return;
    }
    const save = inflight[0];
    if (!save || status.innerHTML === save.saving) return;
    inflight.shift();
    const errors = adminer.readErrors(status);
    settleAjaxSave(save, errors.length
      ? { error: errors[0] }
      : { verified: adminer.readMessages(status).length > 0 });
  }).observe(status, { childList: true });

  form.addEventListener('submit', () => { probe = null; }, true);

  form.addEventListener('click', (event) => {
    const button = event.target && event.target.closest ? event.target.closest('[type="submit"]') : null;
    if (!button || button.name !== 'insert' || button.form !== form) return;
    if (!state.on) return;
    const change = buildChange(button, { keepNoop: true });
    if (!change) return;

    // Followed even with no session recording, so the baseline keeps up: a
    // session started later on this same page must not take a row that was saved
    // in the meantime for the one it replaced.
    const recording = Boolean(state.session && !state.session.closedAt);
    const current = { change, sessionId: recording ? state.session.id : null, writes: 0 };
    probe = current;
    setTimeout(() => {
      if (probe !== current) return;   // it submitted normally; interceptSubmit has it
      probe = null;
      if (!current.writes) return;     // nothing was sent
      current.saving = status.innerHTML;
      current.before = baseline.values;
      current.after = change.rows[0].after;
      // Moved now rather than when the answer arrives, so a second save sent
      // before the first one is answered does not record the first one's edit
      // again.
      baseline.values = current.after;
      current.timer = setTimeout(() => {
        const at = inflight.indexOf(current);
        if (at < 0) return;
        inflight.splice(at, 1);
        settleAjaxSave(current, { verified: false });
      }, AJAX_SAVE_TIMEOUT_MS);
      inflight.push(current);
    }, 0);
  }, true);

  async function settleAjaxSave(save, outcome) {
    clearTimeout(save.timer);
    if (outcome.error) {
      if (baseline.values === save.after) baseline.values = save.before;
      if (save.sessionId) state.panel.log(t('panel.saveFailed', { reason: outcome.error }), 'warn');
      return;
    }

    // The form shows what was typed; the row holds what the database made of it —
    // now() or md5() applied, a CHAR trimmed, a number reformatted. The page is
    // still here, so read the row back and record that as the "after": the drift
    // check compares against it, and a typed value would report drift that is not
    // there. The next save starts from it too, unless another one has moved the
    // baseline in the meantime.
    let after = save.after;
    try {
      const read = await readRow(state.ctx, info.table, info.where);
      if (read.ok && read.values) after = read.values;
    } catch { /* keep what was typed; the drift check still guards the rollback */ }
    if (baseline.values === save.after) baseline.values = after;
    if (!save.sessionId) return;

    const change = { ...save.change, rows: [{ ...save.change.rows[0], after }], verified: outcome.verified };
    if (!undoStatements(change, state.ctx.engine).length) return;
    await store.appendChange(save.sessionId, change);
    logRecorded(change);
    await refresh();
  }
}

/* === The select page: the grid, and the mass edit ════════════════════════ */

/**
 * The `?select=` URL shows one of two things: the data grid, or — after "Edit" or
 * "Clone" on ticked rows — an edit form that applies to all of them.
 *
 * The grid writes three ways, all through one form and one full-page submit:
 *   - a cell edited in place (Ctrl+click, double-click, or `&modify=1`), saved
 *     with "Save": an UPDATE per row, of the edited columns;
 *   - "Delete" on ticked rows, or on the whole result;
 *   - "Import" of a CSV, which is not captured and says so.
 *
 * Nothing on screen can be trusted as the old value — the grid shortens long text
 * and formats what it shows — so every affected row is read through its own edit
 * form before the submit is let go, the same way a hand-written statement's rows
 * are.
 */
function wireSelectPage(info) {
  const editForm = adminer.findEditForm(document);
  if (editForm) {
    wireMassEdit(info, editForm);
    return;
  }
  const grid = adminer.findGridForm(document);
  if (grid) wireGrid(info, grid);
}

function wireGrid(info, form) {
  interceptSubmit(form, async (submitter) => {
    const name = (submitter && submitter.name) || '';
    if (name === 'delete') {
      const selection = adminer.readGridSelection(form);
      const change = await captureRowsDelete(info.table, selection.checked, selection.all, 'grid-delete');
      if (change) await park([change]);
      return;
    }
    if (name === 'import') {
      state.panel.log(t('panel.notUndoable', { reason: t('reason.import-not-captured') }), 'warn');
      return;
    }
    if (name) return;   // edit / clone / export: nothing is written from this page

    const edits = adminer.readGridEdits(form);
    if (!edits.length) return;
    const change = await captureGridEdits(info.table, edits);
    if (change) await park([change]);
  });
}

function wireMassEdit(info, form) {
  interceptSubmit(form, async (submitter) => {
    const target = adminer.readMassEditTarget(form);
    const name = (submitter && submitter.name) || '';
    let change = null;
    if (name === 'delete') {
      change = await captureRowsDelete(info.table, target.checked, target.all, 'mass-delete');
    } else if (target.clone) {
      change = await captureInsertByDifference(info.table, 'grid-clone', '');
    } else {
      const cols = adminer.massEditColumns(form);
      if (!cols.length) return;
      const typed = adminer.readEditForm(document, form);
      change = await captureRowsUpdate(info.table, target.checked, target.all, cols,
        typed.ok ? typed.values : {}, 'mass-edit');
    }
    if (change) await park([change]);
  });
}

/** Which rows an action on the grid applies to: the ticked ones, or everything the search matches. */
async function targetIdfs(checked, all) {
  if (!all) return { idfs: checked, tooMany: false };
  const cap = state.settings.prefetchLimit;
  const idfs = await gridIdfs(location.href, cap + 1);
  return { idfs, tooMany: idfs.length > cap };
}

/**
 * Read rows through their edit forms, by grid identity. A hashed key column is
 * filled in from the row itself, so the predicate holds the real value.
 */
async function readRowsByIdf(table, idfs) {
  const rows = [];
  for (let i = 0; i < idfs.length; i += READ_BATCH) {
    const slice = idfs.slice(i, i + READ_BATCH);
    const read = await Promise.all(slice.map(async (idf) => {
      const ident = parseRowIdf(idf);
      try {
        const res = await readRowByIdf(state.ctx, table, idf);
        if (!res.ok) return null;
        for (const col of ident.hashed) ident.where[col] = res.values[col];
        return { idf, where: ident.where, before: res.values, unreadable: res.unreadable || [] };
      } catch {
        return null;
      }
    }));
    for (const row of read) if (row) rows.push(row);
  }
  return rows;
}

function baseChange(op, table, source) {
  return { id: newId('ch'), at: new Date().toISOString(), op, table, source, keyCols: [], rows: [], warnings: [] };
}

async function captureRowsDelete(table, checked, all, source) {
  const change = baseChange('delete', table, source);
  const target = await targetIdfs(checked, all);
  if (target.tooMany) {
    change.warnings.push('too-many-rows');
    state.panel.log(t('panel.tooManyRows', { n: state.settings.prefetchLimit }), 'err');
    return change;
  }
  if (!target.idfs.length) return null;
  state.panel.log(t('panel.capturing'));
  const rows = await readRowsByIdf(table, target.idfs);
  change.keyCols = rows.length ? Object.keys(rows[0].where) : [];
  change.unreadableCols = [...new Set(rows.flatMap((r) => r.unreadable))];
  change.rows = rows.map((r) => ({ where: r.where, before: r.before, after: null }));
  if (rows.length < target.idfs.length) change.warnings.push('no-before');
  return change;
}

async function captureRowsUpdate(table, checked, all, cols, typed, source) {
  const change = baseChange('update', table, source);
  const target = await targetIdfs(checked, all);
  if (target.tooMany) {
    change.warnings.push('too-many-rows');
    state.panel.log(t('panel.tooManyRows', { n: state.settings.prefetchLimit }), 'err');
    return change;
  }
  if (!target.idfs.length) return null;
  state.panel.log(t('panel.capturing'));
  const rows = await readRowsByIdf(table, target.idfs);
  change.keyCols = rows.length ? Object.keys(rows[0].where) : [];
  change.restoreCols = cols;
  change.readAfter = true;
  change.rows = rows.map((r) => {
    const after = { ...r.before };
    for (const col of cols) if (Object.prototype.hasOwnProperty.call(typed, col)) after[col] = typed[col];
    return { where: r.where, before: r.before, after };
  });
  return change;
}

/** Cells edited in the grid, grouped into one UPDATE change with a row per grid row. */
async function captureGridEdits(table, edits) {
  const byRow = new Map();
  for (const edit of edits) {
    if (!byRow.has(edit.idf)) byRow.set(edit.idf, {});
    byRow.get(edit.idf)[edit.col] = edit.value;
  }
  const change = baseChange('update', table, 'grid-inline');
  if (byRow.size > state.settings.prefetchLimit) {
    change.warnings.push('too-many-rows');
    return change;
  }
  state.panel.log(t('panel.capturing'));
  const idfs = [...byRow.keys()];
  const rows = await readRowsByIdf(table, idfs);
  const cols = new Set();
  change.rows = rows.map((r) => {
    const typed = byRow.get(r.idf) || {};
    Object.keys(typed).forEach((c) => cols.add(c));
    return { where: r.where, before: r.before, after: { ...r.before, ...typed } };
  });
  change.keyCols = rows.length ? Object.keys(rows[0].where) : [];
  change.restoreCols = [...cols];
  change.readAfter = true;
  return change.rows.length ? change : null;
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
    // Every statement's rows are read before any of them runs, so two INSERTs into
    // one table found by comparing keys would both find each other's rows. They
    // share one change instead — see captureInsert.
    const byTable = new Map();
    for (const text of statements) {
      if (isDestructiveDdl(text)) {
        state.panel.log(t('panel.notUndoable', { reason: text.split(/\s+/)[0].toUpperCase() }), 'err');
        continue;
      }
      const desc = describeStatement(text);
      if (desc.kind !== 'update' && desc.kind !== 'delete' && desc.kind !== 'insert') continue;

      const shared = desc.kind === 'insert' ? byTable.get(desc.table.toLowerCase()) : null;
      if (shared && shared.insertProbe && shared.insertProbe.strategy !== 'literal') {
        shared.statement = `${shared.statement};
${desc.sql}`;
        continue;
      }
      state.panel.log(t('panel.capturing'));
      const change = await captureStatement(desc);
      if (!change) continue;
      captures.push(change);
      if (change.op === 'insert') byTable.set(desc.table.toLowerCase(), change);
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

  if (desc.kind === 'insert') return captureInsert(desc, base);

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

/**
 * An INSERT typed on the SQL page. Its rows do not exist yet, so what is taken
 * now is whatever will let them be found afterwards:
 *
 *   - the keys themselves, when the statement spells every key column out as a
 *     literal — nothing to read, nothing to guess;
 *   - otherwise the table's keys as they are now, to compare with the keys after
 *     it ran; the new ones are the inserted rows;
 *   - and when the table's key is not known yet (an empty table has no edit links
 *     to learn it from), whole rows, compared the same way.
 *
 * The comparison also counts rows someone else inserted in the same moment. The
 * window is one page load, and the change says it was found this way.
 */
async function captureInsert(desc, base) {
  const keyCols = await keyColsFor(desc.table);
  const literal = keyCols ? literalInsertKeys(desc, keyCols) : null;
  if (literal) {
    base.keyCols = keyCols;
    base.insertProbe = { strategy: 'literal', wheres: literal };
    return base;
  }
  return captureInsertByDifference(desc.table, 'sql-page', desc.schema || '', base);
}

async function captureInsertByDifference(table, source, schema, base = null) {
  const change = base || baseChange('insert', table, source);
  const keyCols = await keyColsFor(table);
  const limit = state.settings.keyScanLimit;
  const engine = state.ctx.engine;
  const sql = keyCols
    ? keysSelect(table, keyCols, engine, schema, limit + 1)
    : snapshotSelect(table, engine, schema, limit + 1);
  let found;
  try {
    found = await selectFull(state.ctx, sql);
  } catch (err) {
    found = { ok: false, errors: [String(err && err.message || err)], rows: [] };
  }
  if (!found.ok || found.rows.length > limit) {
    change.warnings.push(found.ok ? 'too-many-rows' : `prefetch-failed:${found.errors[0] || ''}`);
    change.warnings.push('insert-key-unknown');
    state.panel.log(t('panel.notUndoable', { reason: t('reason.insert-key-unknown') }), 'warn');
    return change;
  }
  change.keyCols = keyCols || [];
  change.warnings.push('insert-found-by-difference');
  change.insertProbe = keyCols
    ? { strategy: 'keys', beforeKeys: found.rows.map((row) => keyOf(row, keyCols)) }
    : { strategy: 'rows', beforeRows: found.rows };
  return change;
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
  if (cached && cached.length) return cached;
  let cols = null;
  try {
    cols = await discoverKeyCols(state.ctx, table);
  } catch {
    cols = null;
  }
  // Only an answer is cached. An empty table has no edit links to learn its key
  // from, and remembering that as "no key" would outlive the first INSERT into it.
  if (cols) await store.setKeyCols(state.ctx.key, table, cols);
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

/**
 * Roll a session back: the recorded changes first, newest first, then any table
 * snapshots for whatever the change log could not see.
 *
 * `auto` is the Playback guard running this unattended: the person asked for it
 * up front, so there is no preview to confirm, and a row that someone else moved
 * in the meantime is skipped rather than asked about — never overwritten.
 * Snapshots are only restored for a whole-session rollback, not for a hand-picked
 * set of changes.
 *
 * A session is not used up by one rollback. When everything in it has already
 * been undone, the same changes are offered again — the test can be run a second
 * time, or the data can have moved since — and the preview says that is what this
 * is. Rolling the same changes back twice is harmless: each one writes the values
 * it recorded, and the drift check still asks before overwriting anything that no
 * longer holds what it expects.
 */
async function rollback({ sessionId, changeIds, auto = false, includeUndone = false } = {}) {
  let session = sessionId ? await store.getSession(sessionId) : (state.session || (await refresh()));
  const report = { total: 0, ok: 0, failed: 0, skipped: 0, statements: [], details: [], snapshots: null };
  if (!session) return report;

  const snaps = session.snapshots || [];
  const pending = (session.changes || []).some((c) => !c.undone) || snaps.some((s) => !s.restoredAt);
  const again = includeUndone || (!pending && Boolean((session.changes || []).length || snaps.length));

  const dry = await runRollback(state.ctx, session, { dryRun: true, changeIds, includeUndone: again });
  const hasSnapshots = !changeIds && snaps.some((s) => again || !s.restoredAt);
  if (!dry.statements.length && !hasSnapshots) {
    state.panel.log(t('rollback.nothing'), 'warn');
    state.panel.expand();
    return dry;
  }

  if (dry.statements.length) {
    const notes = [
      again ? t('rollback.againNote') : '',
      dry.skipped ? t('rollback.blocked', { n: dry.skipped }) : '',
    ].filter(Boolean);
    const go = auto || await state.panel.preview({
      title: again ? t('rollback.againTitle') : t('rollback.title'),
      sql: joinStatements(dry.statements),
      note: notes.join('\n'),
      confirmLabel: t('rollback.confirm', { n: dry.statements.length }),
    });
    if (!go) return dry;

    Object.assign(report, await runRollback(state.ctx, session, {
      changeIds,
      includeUndone: again,
      driftCheck: state.settings.driftCheck,
      onDrift: auto ? async () => 'skip' : askAboutDrift,
      // Only the run itself; the drift check reports the same position and would
      // print every line twice.
      onProgress: ({ phase, i, n }) => {
        if (phase === 'run') state.panel.log(t('rollback.running', { i, n }));
      },
    }));
    state.panel.log(t('rollback.done', { ok: report.ok, fail: report.failed }), report.failed ? 'err' : 'ok');
    // A change that failed leaves the tables in between states; restoring the
    // snapshots over that would hide where it stopped.
    if (report.failed) {
      await refresh();
      return report;
    }
  }

  if (hasSnapshots) {
    session = await store.getSession(session.id);
    report.snapshots = await restoreSnapshots(session, { auto, includeRestored: again });
  }
  await refresh();
  return report;
}

/* === Snapshots and backup tables ═════════════════════════════════════════ */

function splitTables(text) {
  return String(text || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

/** A snapshot failure reason in words, or the database's own message as it came. */
function snapReason(reason) {
  const key = `snap.reason.${reason}`;
  const text = t(key);
  return text === key ? reason : text;
}

async function promptSnapshot() {
  if (!state.session || state.session.closedAt) return;
  const already = (state.session.snapshots || []).map((s) => s.table);
  const suggestion = state.info.table && !already.includes(state.info.table) ? state.info.table : '';
  const answer = await state.panel.ask({
    title: t('panel.snapshot'),
    label: t('panel.promptTables'),
    value: suggestion,
    placeholder: 'm_generic, m_config',
    confirmLabel: t('panel.snapshot'),
  });
  if (answer === null) return;
  const tables = splitTables(answer);
  if (!tables.length) return;
  state.panel.expand();
  await takeSnapshots(state.session.id, tables);
  await refresh();
}

/** Copy whole tables into the session. Each table succeeds or fails on its own. */
async function takeSnapshots(sessionId, tables) {
  const taken = [];
  const errors = [];
  for (const table of tables) {
    try {
      const meta = await snapshotTable(sessionId, table);
      taken.push(meta);
      state.panel.log(t('panel.snapTaken', { table, n: meta.rowCount }), 'ok');
    } catch (err) {
      const reason = String(err && err.message || err);
      errors.push({ table, reason });
      state.panel.log(t('panel.snapFailed', { table, reason: snapReason(reason) }), 'err');
    }
  }
  return { taken, errors };
}

async function snapshotTable(sessionId, table) {
  const keyCols = await keyColsFor(table);
  const limit = state.settings.snapshotLimit;
  const res = await selectFull(state.ctx, snapshotSelect(table, state.ctx.engine, '', limit + 1, keyCols || []));
  if (!res.ok) throw new Error(res.errors[0] || 'read-failed');
  if (res.rows.length > limit) throw new Error('too-large');
  const meta = {
    id: newId('sn'),
    table,
    takenAt: new Date().toISOString(),
    keyCols,
    rowCount: res.rows.length,
    columns: res.columns,
    unreadable: res.unreadable,
  };
  await store.addSnapshot(sessionId, meta, { columns: res.columns, rows: res.rows, unreadable: res.unreadable });
  return meta;
}

/** What restoring one snapshot would take, without running it. */
async function planSnapshot(snap) {
  const plan = { snap, statements: [], reason: '', skippedCols: [] };
  const data = await store.getSnapshotData(snap.id);
  if (!data) { plan.reason = 'snapshot-missing'; return plan; }
  const keyCols = snap.keyCols && snap.keyCols.length ? snap.keyCols : await keyColsFor(snap.table);
  const limit = state.settings.snapshotLimit;
  const now = await selectFull(state.ctx, snapshotSelect(snap.table, state.ctx.engine, '', limit + 1, keyCols || []));
  if (!now.ok) { plan.reason = 'read-failed'; plan.error = now.errors[0] || ''; return plan; }
  if (now.rows.length > limit) { plan.reason = 'too-large'; return plan; }
  const diff = diffSnapshot({ keyCols: keyCols || [], ...data }, now);
  plan.reason = diff.reason;
  plan.skippedCols = diff.skippedCols;
  if (!diff.reason) plan.statements = restoreStatements(diff, snap.table, state.ctx.engine);
  return plan;
}

/**
 * Put snapshotted tables back as they were. Tables with nothing to do are
 * marked restored straight away; the others are shown first unless `auto`.
 */
async function restoreSnapshots(session, { snapIds = null, auto = false, includeRestored = false } = {}) {
  const out = { tables: 0, ok: 0, failed: 0, statements: [], errors: [] };
  if (!session) return out;
  // A snapshot can be restored again: it is a copy of the table, and putting the
  // table back to it a second time is the same operation. `snapIds` names one
  // outright, which is always an explicit request.
  const snaps = (session.snapshots || [])
    .filter((s) => (includeRestored || snapIds || !s.restoredAt) && (!snapIds || snapIds.includes(s.id)));
  if (!snaps.length) return out;

  const plans = [];
  for (const snap of snaps) plans.push(await planSnapshot(snap));
  const notes = [];
  for (const plan of plans) {
    if (plan.reason) notes.push(`${plan.snap.table}: ${snapReason(plan.reason)}`);
    if (plan.skippedCols.length) {
      notes.push(t('snap.skippedCols', { table: plan.snap.table, cols: plan.skippedCols.join(', ') }));
    }
  }
  const work = plans.filter((p) => !p.reason && p.statements.length);
  for (const plan of plans.filter((p) => !p.reason && !p.statements.length)) {
    await store.updateSnapshot(session.id, plan.snap.id, { restoredAt: new Date().toISOString() });
  }
  out.errors = plans.filter((p) => p.reason).map((p) => ({ table: p.snap.table, reason: p.reason }));
  if (!work.length) {
    state.panel.log(notes.length ? notes.join(' · ') : t('snap.nothing'), notes.length ? 'warn' : 'ok');
    return out;
  }

  const statements = work.flatMap((p) => p.statements);
  const go = auto || await state.panel.preview({
    title: t('snap.title'),
    sql: joinStatements(statements),
    note: [t('snap.note'), ...notes].join('\n'),
    confirmLabel: t('snap.confirm', { n: statements.length }),
  });
  if (!go) return out;

  for (const plan of work) {
    out.tables++;
    let result;
    try {
      result = await runSql(state.ctx, joinStatements(plan.statements));
    } catch (err) {
      result = { ok: false, errors: [String(err && err.message || err)] };
    }
    if (result.ok) {
      out.ok++;
      out.statements.push(...plan.statements);
      await store.updateSnapshot(session.id, plan.snap.id, { restoredAt: new Date().toISOString() });
    } else {
      out.failed++;
      out.errors.push({ table: plan.snap.table, reason: result.errors[0] || '' });
      state.panel.log(t('snap.failed', { table: plan.snap.table, reason: result.errors[0] || '' }), 'err');
      break;
    }
  }
  if (out.ok) state.panel.log(t('snap.done', { n: out.ok }), 'ok');
  return out;
}

async function promptBackup() {
  if (!state.session) return;
  const answer = await state.panel.ask({
    title: t('panel.backup'),
    label: t('panel.promptBackup'),
    value: state.info.table || '',
    note: t('backup.createNote'),
    confirmLabel: t('backup.create'),
  });
  if (answer === null) return;
  state.panel.expand();
  for (const table of splitTables(answer)) await createBackup(state.session, table);
  await refresh();
}

async function createBackup(session, table, { auto = false } = {}) {
  const engine = state.ctx.engine;
  const name = backupName(table, new Date(), engine);
  const sql = backupCreateSql(table, name, engine);
  const go = auto || await state.panel.preview({
    title: t('backup.createTitle'),
    sql,
    note: t('backup.createNote'),
    confirmLabel: t('backup.create'),
  });
  if (!go) return null;
  const result = await runSql(state.ctx, joinStatements([sql]));
  if (!result.ok) {
    state.panel.log(t('panel.backupFailed', { reason: result.errors[0] || '' }), 'err');
    return null;
  }
  const meta = { id: newId('bk'), table, backup: name, createdAt: new Date().toISOString(), engine };
  await store.addBackup(session.id, meta);
  state.panel.log(t('panel.backupDone', { name }), 'ok');
  return meta;
}

/**
 * Restore a table from its backup table. When both fit under the snapshot limit
 * the backup is diffed against the table like a snapshot, so only the rows that
 * moved are written; otherwise it falls back to emptying the table and copying
 * the backup in, and the preview says what that implies.
 */
async function restoreBackup(session, backupId) {
  const backup = session && (session.backups || []).find((b) => b.id === backupId);
  if (!backup) return { ok: false, error: 'no-backup' };
  const engine = state.ctx.engine;
  const keyCols = await keyColsFor(backup.table);
  const limit = state.settings.snapshotLimit;

  let statements = [];
  let note = '';
  const [saved, now] = keyCols
    ? await Promise.all([
      selectFull(state.ctx, snapshotSelect(backup.backup, engine, '', limit + 1, keyCols)),
      selectFull(state.ctx, snapshotSelect(backup.table, engine, '', limit + 1, keyCols)),
    ])
    : [null, null];
  const comparable = saved && now && saved.ok && now.ok
    && saved.rows.length <= limit && now.rows.length <= limit;
  const diff = comparable
    ? diffSnapshot({ keyCols, columns: saved.columns, rows: saved.rows, unreadable: saved.unreadable }, now)
    : null;
  if (diff && !diff.reason) {
    statements = restoreStatements(diff, backup.table, engine);
    if (diff.skippedCols.length) {
      note = t('snap.skippedCols', { table: backup.table, cols: diff.skippedCols.join(', ') });
    }
  } else {
    statements = backupRestoreSql(backup.table, backup.backup, engine);
    note = t('backup.wholesale');
  }
  if (!statements.length) {
    state.panel.log(t('snap.nothing'), 'ok');
    await store.updateBackup(session.id, backup.id, { restoredAt: new Date().toISOString() });
    return { ok: true, statements: [] };
  }

  const go = await state.panel.preview({
    title: t('backup.restoreTitle', { table: backup.table, backup: backup.backup }),
    sql: joinStatements(statements),
    note,
    confirmLabel: t('snap.confirm', { n: statements.length }),
  });
  if (!go) return { ok: false, cancelled: true };
  const result = await runSql(state.ctx, joinStatements(statements));
  if (!result.ok) {
    state.panel.log(t('snap.failed', { table: backup.table, reason: result.errors[0] || '' }), 'err');
    return { ok: false, error: result.errors[0] || '' };
  }
  await store.updateBackup(session.id, backup.id, { restoredAt: new Date().toISOString() });
  state.panel.log(t('backup.restored', { table: backup.table, backup: backup.backup }), 'ok');
  return { ok: true, statements };
}

async function dropBackup(session, backupId) {
  const backup = session && (session.backups || []).find((b) => b.id === backupId);
  if (!backup) return { ok: false, error: 'no-backup' };
  const sql = backupDropSql(backup.backup, state.ctx.engine);
  const go = await state.panel.preview({
    title: t('backup.dropTitle', { backup: backup.backup }),
    sql,
    note: '',
    confirmLabel: t('mgr.drop'),
  });
  if (!go) return { ok: false, cancelled: true };
  const result = await runSql(state.ctx, joinStatements([sql]));
  if (!result.ok) return { ok: false, error: result.errors[0] || '' };
  await store.updateBackup(session.id, backup.id, { droppedAt: new Date().toISOString() });
  state.panel.log(t('backup.dropped', { backup: backup.backup }), 'ok');
  return { ok: true };
}

/** Reopen the session a Playback run set aside, if it is still closed. */
async function resumeSetAside(session) {
  const previous = session.resumeId ? await store.getSession(session.resumeId) : null;
  if (previous && previous.closedAt) await store.reopenSession(previous.id);
  await refresh();
}

/* === Playback guard ══════════════════════════════════════════════════════
 * Asked for by the background around a Record & Playback run: open a session and
 * snapshot the chosen tables before the run, then close it and — when the person
 * asked for that — roll it back once the run is over. The run itself usually
 * drives the application under test, not Adminer, so it is the snapshots that
 * catch its writes; anything it does through Adminer lands in the change log as
 * usual.
 * ═══════════════════════════════════════════════════════════════════════════ */

async function guardBegin(msg) {
  // A session someone was recording by hand is set aside, not merged: the run is
  // rolled back as a whole afterwards, and their own changes must not go with it.
  // It is reopened when the run's session ends.
  let resumeId = '';
  if (state.session && !state.session.closedAt) {
    resumeId = state.session.id;
    await store.closeSession(resumeId);
    state.panel.log(t('panel.guardSetAside', { name: state.session.name }), 'warn');
  }
  const session = await store.startSession({
    name: msg.name || t('panel.defaultName'),
    conn: state.ctx.conn,
    origin: state.ctx.origin,
    base: state.ctx.base,
    key: state.ctx.key,
    guard: true,
    resumeId,
  });
  const snaps = await takeSnapshots(session.id, msg.tables || []);
  await refresh();
  state.panel.log(t('panel.guardStarted', { name: msg.name || '' }), 'ok');
  return { ok: true, sessionId: session.id, taken: snaps.taken.length, errors: snaps.errors };
}

async function guardEnd(msg) {
  const session = await store.getSession(msg.sessionId);
  if (!session) return { ok: false, error: 'no-session' };
  if (!session.closedAt) await store.closeSession(session.id);
  if (!msg.autoRollback) {
    await resumeSetAside(session);
    return { ok: true, kept: true, name: session.name };
  }
  const report = await rollback({ sessionId: session.id, auto: true });
  await resumeSetAside(session);
  const snaps = report.snapshots || { ok: 0, failed: 0, errors: [] };
  return {
    ok: true,
    name: session.name,
    changes: report.ok || 0,
    failed: (report.failed || 0) + snaps.failed,
    tables: snaps.ok,
    snapshotErrors: snaps.errors,
  };
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
