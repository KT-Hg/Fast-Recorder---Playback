/**
 * snapstore.js — where the rows of a table snapshot are kept.
 *
 * Not in `chrome.storage.local`: that area is capped at 10 MB and shared with the
 * scenarios, so a few snapshots of a mid-sized table would leave the next recorded
 * scenario unable to save. IndexedDB in the extension's own origin has room for
 * them without the `unlimitedStorage` permission.
 *
 * The extension's origin is the catch. The panel runs as a content script on the
 * Adminer page, where `indexedDB` is Adminer's database, not ours. So only the
 * extension's own pages and the service worker open the database; a content
 * script asks the service worker, which answers through `serveSnapshots()`.
 */

const DB_NAME = 'FastRecorder_DbtoolsSnapshots';
const DB_VER  = 1;
const STORE   = 'snaps';
const MESSAGE = 'dbtools-snap';

/* === Direct access (extension origin) ════════════════════════════════════ */

let _db = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      _db = req.result;
      // Another page upgrading the database, or the browser closing it, leaves
      // this handle unusable; the next call opens a fresh one.
      _db.onversionchange = () => { _db.close(); _db = null; };
      _db.onclose = () => { _db = null; };
      resolve(_db);
    };
    req.onerror = () => reject(req.error || new Error('snapshot-db-open-failed'));
    req.onblocked = () => reject(new Error('snapshot-db-blocked'));
  });
}

/**
 * One transaction over the store; resolves with `fn`'s request result once it
 * commits. A handle the browser closed behind our back (the service worker was
 * idle) throws InvalidStateError — reopened and tried once more.
 */
async function run(mode, fn, retry = true) {
  const db = _db || await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error || new Error('snapshot-db-failed'));
      tx.onabort = () => reject(tx.error || new Error('snapshot-db-aborted'));
    });
  } catch (err) {
    if (!retry || !err || err.name !== 'InvalidStateError') throw err;
    _db = null;
    return run(mode, fn, false);
  }
}

const direct = {
  put: (id, data) => run('readwrite', (store) => store.put(data, id)).then(() => true),
  get: (id) => run('readonly', (store) => store.get(id)).then((data) => data || null),
  remove: (ids) => run('readwrite', (store) => { for (const id of ids) store.delete(id); }).then(() => true),
};

/* === Through the service worker (content script) ═════════════════════════ */

function ask(op, args) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: MESSAGE, op, ...args }, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else if (!res || !res.ok) reject(new Error((res && res.error) || 'snapshot-store-unavailable'));
      else resolve(res.value);
    });
  });
}

function inExtensionOrigin() {
  return typeof location !== 'undefined' && location.origin === new URL(chrome.runtime.getURL('/')).origin;
}

/* === API ═════════════════════════════════════════════════════════════════ */

export function putSnapshotRows(id, data) {
  return inExtensionOrigin() ? direct.put(id, data) : ask('put', { id, data });
}

export function getSnapshotRows(id) {
  return inExtensionOrigin() ? direct.get(id) : ask('get', { id });
}

export function removeSnapshotRows(ids) {
  if (!ids.length) return Promise.resolve(true);
  return inExtensionOrigin() ? direct.remove(ids) : ask('remove', { ids });
}

/** Service worker: answer the content scripts' requests. Call once at startup. */
export function serveSnapshots() {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== MESSAGE) return undefined;
    const op = msg.op === 'put' ? direct.put(msg.id, msg.data)
      : msg.op === 'get' ? direct.get(msg.id)
      : msg.op === 'remove' ? direct.remove([].concat(msg.ids || []))
      : Promise.reject(new Error(`unknown op: ${msg.op}`));
    op.then(
      (value) => sendResponse({ ok: true, value }),
      (err) => sendResponse({ ok: false, error: String((err && err.message) || err) }),
    );
    return true;
  });
}
