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

const K_SESSIONS = 'dbtoolsSessions';
const K_ACTIVE   = 'dbtoolsActive';
const K_PENDING  = 'dbtoolsPending';
const K_KEYCOLS  = 'dbtoolsKeyCols';
const K_SETTINGS = 'dbtoolsSettings';

export const DEFAULT_SETTINGS = {
  enabled: true,          // master switch for the whole Adminer integration
  autoExecute: true,      // allow the panel to run rollback SQL itself (phase 2)
  driftCheck: true,       // read each row back before undoing it
  captureSqlPage: true,   // prefetch rows before a hand-written UPDATE/DELETE
  prefetchLimit: 200,     // refuse to snapshot more rows than this in one statement
  engineOverride: '',     // '' = infer from Adminer's driver parameter
  lang: 'vi',
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
  return { ...DEFAULT_SETTINGS, ...(res[K_SETTINGS] || {}) };
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

export async function startSession({ name, conn, origin, base, key }) {
  return serialize(async () => {
    const res = await get([K_SESSIONS, K_ACTIVE]);
    const sessions = res[K_SESSIONS] || {};
    const active = res[K_ACTIVE] || {};
    const id = `ts_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    sessions[id] = {
      id,
      name: name || new Date().toLocaleString(),
      conn,
      origin,
      base,
      key,
      startedAt: new Date().toISOString(),
      closedAt: null,
      nextSeq: 1,
      changes: [],
    };
    active[key] = id;
    await set({ [K_SESSIONS]: sessions, [K_ACTIVE]: active });
    return sessions[id];
  });
}

export async function closeSession(id) {
  return serialize(async () => {
    const res = await get([K_SESSIONS, K_ACTIVE]);
    const sessions = res[K_SESSIONS] || {};
    const active = res[K_ACTIVE] || {};
    const session = sessions[id];
    if (!session) return null;
    session.closedAt = new Date().toISOString();
    if (active[session.key] === id) delete active[session.key];
    await set({ [K_SESSIONS]: sessions, [K_ACTIVE]: active });
    return session;
  });
}

export async function reopenSession(id) {
  return serialize(async () => {
    const res = await get([K_SESSIONS, K_ACTIVE]);
    const sessions = res[K_SESSIONS] || {};
    const active = res[K_ACTIVE] || {};
    const session = sessions[id];
    if (!session) return null;
    session.closedAt = null;
    active[session.key] = id;
    await set({ [K_SESSIONS]: sessions, [K_ACTIVE]: active });
    return session;
  });
}

export async function deleteSession(id) {
  return serialize(async () => {
    const res = await get([K_SESSIONS, K_ACTIVE]);
    const sessions = res[K_SESSIONS] || {};
    const active = res[K_ACTIVE] || {};
    const session = sessions[id];
    delete sessions[id];
    if (session && active[session.key] === id) delete active[session.key];
    await set({ [K_SESSIONS]: sessions, [K_ACTIVE]: active });
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
