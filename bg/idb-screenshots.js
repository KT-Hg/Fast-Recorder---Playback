/**
 * idb-screenshots.js — IndexedDB wrapper for CSV run screenshots and results.
 *
 * Stores:
 *  "shots"   — per-row screenshots (base64), keyed by "${rowIdx}:${varName}"
 *  "results" — per-row CSV run results, keyed by rowIdx (integer)
 *
 * Both stores share a single DB so they open/close together.
 * DB version was bumped to 2 to add the "results" store.
 *
 * Screenshot write cap: SS_MAX_ENTRIES (5 000) — ~100 MB at 20 KB/screenshot average.
 * ssReadAll caps at 5 000 entries by default; use ssReadPage() for paginated access.
 */

const SS_MAX_ENTRIES = 5_000;

const DB_NAME  = 'FastRecorder_CsvScreenshots';
const DB_VER   = 2;
const STORE    = 'shots';
const RESULTS_STORE = 'results';

let _db = null;

function _openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE))         db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(RESULTS_STORE)) db.createObjectStore(RESULTS_STORE);
    };
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

/* ── Screenshots ─────────────────────────────────────────────────────────── */

export function ssWrite(rowIdx, varName, base64) {
  return _withDb(db => new Promise((resolve, reject) => {
    const tx      = db.transaction(STORE, 'readwrite');
    const store   = tx.objectStore(STORE);
    const countReq = store.count();

    countReq.onsuccess = () => {
      if (countReq.result >= SS_MAX_ENTRIES) {
        console.warn(
          `[IDB] ssWrite: store has ${countReq.result} entries (cap: ${SS_MAX_ENTRIES}). ` +
          `Screenshot for row ${rowIdx} / var "${varName}" dropped. Call ssClear() to reclaim space.`,
        );
        tx.abort();
        resolve();
        return;
      }
      store.put(base64, `${rowIdx}:${varName}`);
    };

    tx.oncomplete = resolve;
    tx.onerror    = e => {
      if (e.target.error?.name === 'AbortError') { resolve(); return; }
      reject(e.target.error);
    };
  }));
}

export function ssReadAll(maxEntries = 5_000) {
  return _withDb(db => new Promise((resolve, reject) => {
    const result = {};
    let count    = 0;
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).openCursor();
    req.onsuccess = e => {
      const c = e.target.result;
      if (c && (maxEntries === 0 || count < maxEntries)) {
        result[c.key] = c.value;
        count++;
        c.continue();
      } else {
        if (c) console.warn(`[IDB] ssReadAll: capped at ${maxEntries} — use ssReadPage() for full data.`);
        resolve(result);
      }
    };
    req.onerror = e => reject(e.target.error);
  }));
}

export function ssReadPage(offset = 0, limit = 500) {
  return _withDb(db => new Promise((resolve, reject) => {
    const result  = {};
    let skipped   = 0;
    let collected = 0;
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).openCursor();
    req.onsuccess = e => {
      const c = e.target.result;
      if (!c) { resolve(result); return; }
      if (skipped < offset) { skipped++; c.continue(); return; }
      if (collected < limit) { result[c.key] = c.value; collected++; c.continue(); }
      else resolve(result);
    };
    req.onerror = e => reject(e.target.error);
  }));
}

export function ssCount() {
  return _withDb(db => new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).count();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
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

/* ── CSV Run Results ──────────────────────────────────────────────────────── */

/**
 * Write a single row result — O(1) per row, no accumulation in memory.
 * Replaces the chrome.storage.local batch-write approach that was O(n²) in total bytes written.
 */
export function csvResultWrite(rowIdx, result) {
  return _withDb(db => new Promise((resolve, reject) => {
    const tx = db.transaction(RESULTS_STORE, 'readwrite');
    tx.objectStore(RESULTS_STORE).put(result, rowIdx);
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  }));
}

/** Read all results as an array sorted by rowIndex. */
export function csvResultReadAll() {
  return _withDb(db => new Promise((resolve, reject) => {
    const results = [];
    const tx  = db.transaction(RESULTS_STORE, 'readonly');
    const req = tx.objectStore(RESULTS_STORE).openCursor();
    req.onsuccess = e => {
      const c = e.target.result;
      if (c) { results.push(c.value); c.continue(); }
      else resolve(results.sort((a, b) => a.rowIndex - b.rowIndex));
    };
    req.onerror = e => reject(e.target.error);
  }));
}

export function csvResultClear() {
  return _withDb(db => new Promise((resolve, reject) => {
    const tx = db.transaction(RESULTS_STORE, 'readwrite');
    tx.objectStore(RESULTS_STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  }));
}
