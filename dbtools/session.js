/**
 * session.js — where a test session and its changeset live.
 *
 * A session is one lap of manual testing: "start", then every write made through
 * Adminer is appended to it, then either a rollback or a close. It is stored in
 * `chrome.storage.local` rather than in the page, because the whole point is to
 * survive the navigation that Adminer performs on every save — and to still be
 * there tomorrow morning when someone remembers they never rolled back.
 *
 * Sessions are keyed by connection (`params.connKey`), never merged across them.
 * A changeset recorded against staging must not be offered on production even if
 * the two Adminer installs look identical.
 *
 * Appends are serialised through one promise chain and re-read storage inside the
 * critical section, so two Adminer tabs saving at the same moment cannot drop
 * each other's change. That closes the common case; it is not a lock, and the
 * comment on `appendChange` says what is still possible.
 */

import { putSnapshotRows, getSnapshotRows, removeSnapshotRows } from './snapstore.js';

const K_SESSIONS = 'dbtoolsSessions';
const K_ACTIVE   = 'dbtoolsActive';
// The session the panel shows for a connection when none is recording: the one
// last ended, resumed or started there. Without it, "End" made the session vanish
// from the panel, and getting back to it meant the manager page.
const K_FOCUS    = 'dbtoolsFocus';
const K_PENDING  = 'dbtoolsPending';
const K_KEYCOLS  = 'dbtoolsKeyCols';
const K_SETTINGS = 'dbtoolsSettings';

export const DEFAULT_SETTINGS = {
  enabled: true,          // master switch for the whole Adminer integration
  autoExecute: true,      // allow the panel to run rollback SQL itself (phase 2)
  driftCheck: true,       // read each row back before undoing it
  captureSqlPage: true,   // prefetch rows before a hand-written UPDATE/DELETE
  prefetchLimit: 200,     // refuse to snapshot more rows than this in one statement
  snapshotLimit: 5000,    // largest table a whole-table snapshot will copy
  keyScanLimit: 10000,    // largest table whose keys are compared to find inserted rows
  engineOverride: '',     // '' = infer from Adminer's driver parameter
  lang: 'en',
  // Wrap every Record & Playback run in a test session on this connection:
  // snapshot `tables` first, and roll the session back once the run ends.
  guard: { enabled: false, key: '', origin: '', label: '', tables: [], autoRollback: true },
};

/* === Raw storage helpers ══════════════════════════════════════════════════ */

function get(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, (res) => resolve(res || {})));
}

function set(obj) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(obj, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

function remove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, () => {
    void chrome.runtime.lastError;
    resolve();
  }));
}

/** One writer at a time within this page. */
let chain = Promise.resolve();
function serialize(fn) {
  const next = chain.then(fn, fn);
  // Keep the chain alive after a rejection so one failed write does not wedge
  // every later one.
  chain = next.catch(() => {});
  return next;
}

/* === Settings ════════════════════════════════════════════════════════════ */

export async function getSettings() {
  const res = await get([K_SETTINGS]);
  const stored = res[K_SETTINGS] || {};
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  // The language used to be saved along with every other setting, Vietnamese by
  // default, so a stored `lang` does not mean anyone chose it. Only a language
  // picked with the 🌐 switch (`langChosen`) overrides the English default.
  if (!stored.langChosen) settings.lang = DEFAULT_SETTINGS.lang;
  return settings;
}

export async function setSettings(patch) {
  return serialize(async () => {
    const current = await getSettings();
    const next = { ...current, ...patch };
    await set({ [K_SETTINGS]: next });
    return next;
  });
}

/* === Sessions ════════════════════════════════════════════════════════════ */

export async function allSessions() {
  const res = await get([K_SESSIONS]);
  return res[K_SESSIONS] || {};
}

export async function getSession(id) {
  if (!id) return null;
  const all = await allSessions();
  return all[id] || null;
}

export async function activeSessionId(key) {
  const res = await get([K_ACTIVE]);
  return (res[K_ACTIVE] || {})[key] || '';
}

export async function activeSession(key) {
  return getSession(await activeSessionId(key));
}

/** Every session recorded against one connection, newest first. */
export async function sessionsFor(key) {
  const all = await allSessions();
  return Object.values(all)
    .filter((s) => s.key === key)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

/**
 * The session the panel shows: the one recording, else the one last ended or
 * resumed here, else the newest on this connection. The panel always has
 * something to roll back and something to resume for as long as the database
 * has any session at all.
 */
export async function panelSession(key) {
  const res = await get([K_SESSIONS, K_ACTIVE, K_FOCUS]);
  const sessions = res[K_SESSIONS] || {};
  const id = (res[K_ACTIVE] || {})[key] || (res[K_FOCUS] || {})[key] || '';
  if (id && sessions[id]) return sessions[id];
  return Object.values(sessions)
    .filter((s) => s.key === key)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0] || null;
}

/**
 * One recording session per connection. Starting or resuming another ends
 * whichever was recording — it used to be left open and unpointed-at, recording
 * nothing, yet listed as "Open" on the manager page from then on.
 */
function endRecording(sessions, active, key, except) {
  const current = active[key];
  if (current && current !== except && sessions[current] && !sessions[current].closedAt) {
    sessions[current].closedAt = new Date().toISOString();
  }
}

export async function startSession({ name, conn, origin, base, key, guard = false, resumeId = '' }) {
  return serialize(async () => {
    const res = await get([K_SESSIONS, K_ACTIVE, K_FOCUS]);
    const sessions = res[K_SESSIONS] || {};
    const active = res[K_ACTIVE] || {};
    const focus = res[K_FOCUS] || {};
    const id = `ts_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    endRecording(sessions, active, key, id);
    sessions[id] = {
      id,
      name: name || new Date().toLocaleString(),
      conn,
      origin,
      base,
      key,
      guard,
      resumeId,
      startedAt: new Date().toISOString(),
      closedAt: null,
      nextSeq: 1,
      changes: [],
    };
    active[key] = id;
    focus[key] = id;
    await set({ [K_SESSIONS]: sessions, [K_ACTIVE]: active, [K_FOCUS]: focus });
    return sessions[id];
  });
}

export async function closeSession(id) {
  return serialize(async () => {
    const res = await get([K_SESSIONS, K_ACTIVE, K_FOCUS]);
    const sessions = res[K_SESSIONS] || {};
    const active = res[K_ACTIVE] || {};
    const session = sessions[id];
    if (!session) return null;
    session.closedAt = new Date().toISOString();
    if (active[session.key] === id) delete active[session.key];
    // Ended, not gone: the panel keeps showing it, so rolling it back or picking
    // it up again is one click away rather than a trip to the manager page.
    // Only when nothing else is recording there — ending a session another tab
    // has since replaced must not pull the panel off the one being recorded.
    const focus = res[K_FOCUS] || {};
    if (!active[session.key]) focus[session.key] = id;
    await set({ [K_SESSIONS]: sessions, [K_ACTIVE]: active, [K_FOCUS]: focus });
    return session;
  });
}

export async function reopenSession(id) {
  return serialize(async () => {
    const res = await get([K_SESSIONS, K_ACTIVE, K_FOCUS]);
    const sessions = res[K_SESSIONS] || {};
    const active = res[K_ACTIVE] || {};
    const focus = res[K_FOCUS] || {};
    const session = sessions[id];
    if (!session) return null;
    endRecording(sessions, active, session.key, id);
    session.closedAt = null;
    active[session.key] = id;
    focus[session.key] = id;
    await set({ [K_SESSIONS]: sessions, [K_ACTIVE]: active, [K_FOCUS]: focus });
    return session;
  });
}

export async function deleteSession(id) {
  return serialize(async () => {
    const res = await get([K_SESSIONS, K_ACTIVE, K_FOCUS]);
    const sessions = res[K_SESSIONS] || {};
    const active = res[K_ACTIVE] || {};
    const focus = res[K_FOCUS] || {};
    const session = sessions[id];
    delete sessions[id];
    if (session && active[session.key] === id) delete active[session.key];
    if (session && focus[session.key] === id) delete focus[session.key];
    await set({ [K_SESSIONS]: sessions, [K_ACTIVE]: active, [K_FOCUS]: focus });
    const snaps = (session && session.snapshots) || [];
    if (snaps.length) await dropSnapshotRows(snaps.map((s) => s.id));
  });
}

export async function renameSession(id, name) {
  return serialize(async () => {
    const res = await get([K_SESSIONS]);
    const sessions = res[K_SESSIONS] || {};
    if (!sessions[id]) return null;
    sessions[id].name = name;
    await set({ [K_SESSIONS]: sessions });
    return sessions[id];
  });
}

/* === Changes ═════════════════════════════════════════════════════════════ */

/**
 * Append one change to a session.
 *
 * Storage is re-read inside the critical section so a concurrent append from
 * another tab is not overwritten. What this does *not* protect against is two
 * tabs entering `chrome.storage.local.set` at the same instant — the API has no
 * compare-and-swap. `id` makes that survivable: a duplicate append is dropped
 * rather than stored twice, so the worst case is a lost change, never a change
 * that gets rolled back twice.
 */
export async function appendChange(sessionId, change) {
  return serialize(async () => {
    const res = await get([K_SESSIONS]);
    const sessions = res[K_SESSIONS] || {};
    const session = sessions[sessionId];
    if (!session) return null;
    if (session.changes.some((c) => c.id === change.id)) return session;
    const stored = { ...change, seq: session.nextSeq++, undone: false };
    session.changes.push(stored);
    await set({ [K_SESSIONS]: sessions });
    return stored;
  });
}

export async function updateChange(sessionId, changeId, patch) {
  return serialize(async () => {
    const res = await get([K_SESSIONS]);
    const sessions = res[K_SESSIONS] || {};
    const session = sessions[sessionId];
    if (!session) return null;
    const change = session.changes.find((c) => c.id === changeId);
    if (!change) return null;
    Object.assign(change, patch);
    await set({ [K_SESSIONS]: sessions });
    return change;
  });
}

export async function removeChange(sessionId, changeId) {
  return serialize(async () => {
    const res = await get([K_SESSIONS]);
    const sessions = res[K_SESSIONS] || {};
    const session = sessions[sessionId];
    if (!session) return null;
    session.changes = session.changes.filter((c) => c.id !== changeId);
    await set({ [K_SESSIONS]: sessions });
    return session;
  });
}

/* === Snapshots and backup tables ═════════════════════════════════════════
 * A snapshot's rows are not stored inside the session: every append rewrites the
 * whole sessions map, and dragging a few thousand rows through each of those
 * writes would make an ordinary edit slow. The session keeps only the
 * description — table, key, row count, when — and the rows go to IndexedDB
 * (snapstore.js), out of the 10 MB that `chrome.storage.local` shares with the
 * scenarios.
 *
 * A backup table lives in the database; the session records its name and how to
 * restore or drop it.
 * ═══════════════════════════════════════════════════════════════════════════ */

// Where snapshot rows were kept before they moved to IndexedDB. Still read, and
// cleared on delete, so a session from before the move can be restored.
const SNAP_PREFIX = 'dbtoolsSnap_';

async function dropSnapshotRows(snapIds) {
  await removeSnapshotRows(snapIds).catch((err) => console.warn('[dbtools] snapshot rows not removed:', err));
  await remove(snapIds.map((id) => SNAP_PREFIX + id));
}

function sessionList(session, field) {
  if (!Array.isArray(session[field])) session[field] = [];
  return session[field];
}

export async function addSnapshot(sessionId, meta, data) {
  await putSnapshotRows(meta.id, data);
  return serialize(async () => {
    const res = await get([K_SESSIONS]);
    const sessions = res[K_SESSIONS] || {};
    const session = sessions[sessionId];
    if (!session) return null;
    sessionList(session, 'snapshots').push(meta);
    await set({ [K_SESSIONS]: sessions });
    return meta;
  });
}

export async function getSnapshotData(snapId) {
  const data = await getSnapshotRows(snapId);
  if (data) return data;
  const res = await get([SNAP_PREFIX + snapId]);
  return res[SNAP_PREFIX + snapId] || null;
}

async function patchListItem(sessionId, field, itemId, patch) {
  return serialize(async () => {
    const res = await get([K_SESSIONS]);
    const sessions = res[K_SESSIONS] || {};
    const session = sessions[sessionId];
    if (!session) return null;
    const item = sessionList(session, field).find((x) => x.id === itemId);
    if (!item) return null;
    Object.assign(item, patch);
    await set({ [K_SESSIONS]: sessions });
    return item;
  });
}

async function dropListItem(sessionId, field, itemId) {
  return serialize(async () => {
    const res = await get([K_SESSIONS]);
    const sessions = res[K_SESSIONS] || {};
    const session = sessions[sessionId];
    if (!session) return null;
    session[field] = sessionList(session, field).filter((x) => x.id !== itemId);
    await set({ [K_SESSIONS]: sessions });
    return session;
  });
}

export function updateSnapshot(sessionId, snapId, patch) {
  return patchListItem(sessionId, 'snapshots', snapId, patch);
}

export async function removeSnapshot(sessionId, snapId) {
  await dropSnapshotRows([snapId]);
  return dropListItem(sessionId, 'snapshots', snapId);
}

export async function addBackup(sessionId, meta) {
  return serialize(async () => {
    const res = await get([K_SESSIONS]);
    const sessions = res[K_SESSIONS] || {};
    const session = sessions[sessionId];
    if (!session) return null;
    sessionList(session, 'backups').push(meta);
    await set({ [K_SESSIONS]: sessions });
    return meta;
  });
}

export function updateBackup(sessionId, backupId, patch) {
  return patchListItem(sessionId, 'backups', backupId, patch);
}

export function removeBackup(sessionId, backupId) {
  return dropListItem(sessionId, 'backups', backupId);
}

/* === Pending change ══════════════════════════════════════════════════════
 * Adminer navigates away on save, so a change cannot be confirmed in the page
 * that made it. The capture is parked here on submit and committed — or dropped —
 * by whichever page loads next, once it can see whether Adminer reported an error.
 * ═══════════════════════════════════════════════════════════════════════════ */

export async function setPending(key, change) {
  const res = await get([K_PENDING]);
  const pending = res[K_PENDING] || {};
  pending[key] = change;
  await set({ [K_PENDING]: pending });
}

export async function takePending(key) {
  return serialize(async () => {
    const res = await get([K_PENDING]);
    const pending = res[K_PENDING] || {};
    const change = pending[key];
    if (!change) return null;
    delete pending[key];
    await set({ [K_PENDING]: pending });
    return change;
  });
}

/* === Key-column cache ════════════════════════════════════════════════════
 * Which columns identify a row is asked once per table and reused: it is read by
 * fetching a page from Adminer, and doing that on every capture would make an
 * ordinary edit noticeably slower.
 * ═══════════════════════════════════════════════════════════════════════════ */

export async function getKeyCols(key, table) {
  const res = await get([K_KEYCOLS]);
  const all = res[K_KEYCOLS] || {};
  return all[`${key}|${table}`] || null;
}

export async function setKeyCols(key, table, cols) {
  return serialize(async () => {
    const res = await get([K_KEYCOLS]);
    const all = res[K_KEYCOLS] || {};
    all[`${key}|${table}`] = cols;
    await set({ [K_KEYCOLS]: all });
  });
}
