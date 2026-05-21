/**
 * idb-screenshots.js — IndexedDB wrapper for CSV run screenshots
 * Exports: ssWrite, ssReadAll, ssClear
 *
 * Replaces chrome.storage.local for screenshot data (which silently fails at ~10MB).
 * Uses lazy reconnect pattern so MV3 service worker kill/restart is safe.
 */

const DB_NAME = 'FastRecorder_CsvScreenshots';
const STORE   = 'shots';
const DB_VER  = 1;

let _db = null;

function _openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => e.target.result.createObjectStore(STORE);
    req.onsuccess  = e => { _db = e.target.result; resolve(_db); };
    req.onerror    = e => reject(new Error(`IDB open failed: ${e.target.error}`));
    req.onblocked  = () => console.warn('[IDB] Open blocked by older version');
  });
}

async function _getDb() {
  if (_db) return _db;
  return _openDb();
}

async function _withDb(fn) {
  try {
    return await fn(await _getDb());
  } catch (e) {
    if (e.name === 'InvalidStateError') {
      _db = null;
      return fn(await _getDb());
    }
    throw e;
  }
}

export function ssWrite(rowIdx, varName, base64) {
  return _withDb(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(base64, `${rowIdx}:${varName}`);
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  }));
}

export function ssReadAll() {
  return _withDb(db => new Promise((resolve, reject) => {
    const result = {};
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).openCursor();
    req.onsuccess = e => {
      const c = e.target.result;
      if (c) { result[c.key] = c.value; c.continue(); }
      else resolve(result);
    };
    req.onerror = e => reject(e.target.error);
  }));
}

export function ssClear() {
  return _withDb(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  }));
}
