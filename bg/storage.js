import { sendAlertNotification } from './utils.js';

/* === Storage health notifications ═══════════════════════════════════════════
 * A failed write means the scenario the user just recorded was NOT saved, and a
 * near-full quota means the next one probably won't be either. Both used to be
 * reported only as a popup toast — which nobody sees, because a save is normally
 * the last thing done before closing the popup.
 *
 * Rate-limited per kind rather than per call: setScenarios() runs on every edit,
 * and a user at 90 % capacity would otherwise be notified on every keystroke-level
 * save. The fixed notification ids mean a repeat updates the existing entry.
 * ═══════════════════════════════════════════════════════════════════════════ */

const STORAGE_NOTICE_COOLDOWN_MS = 10 * 60 * 1000;
const _lastStorageNotice = { warn: 0, error: 0 };

function _notifyStorage(kind, title, message) {
  const now = Date.now();
  if (now - _lastStorageNotice[kind] < STORAGE_NOTICE_COOLDOWN_MS) return;
  _lastStorageNotice[kind] = now;
  sendAlertNotification(title, message, `storage_${kind}`);
}

function _mb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/* === Scenarios === */

export function getScenarios() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['scenarios'], (res) => resolve(res.scenarios || {}));
  });
}

export function setScenarios(scenarios) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ scenarios }, () => {
      if (chrome.runtime.lastError) {
        const err = chrome.runtime.lastError.message;
        console.error('[STORAGE] setScenarios failed:', err);
        chrome.runtime.sendMessage({ type: 'STORAGE_ERROR', msg: err }).catch(() => {});
        _notifyStorage('error', '⚠ Save failed', `Your scenarios were not saved: ${err}`);
      } else {
        // Warn at 85 % capacity — below the hard limit but early enough to act.
        // chrome.storage.local quota is 5 MB by default; QUOTA_BYTES is not
        // always defined in all Chrome versions so we fall back to the spec value.
        chrome.storage.local.getBytesInUse(null, (bytes) => {
          const limit = chrome.storage.local.QUOTA_BYTES || 5242880;
          if (bytes > limit * 0.85) {
            chrome.runtime.sendMessage({ type: 'STORAGE_WARNING', bytes, limit }).catch(() => {});
            _notifyStorage(
              'warn',
              '⚠ Storage almost full',
              `${_mb(bytes)} of ${_mb(limit)} used (${Math.round(bytes / limit * 100)}%). ` +
              'Export and delete old scenarios before saves start failing.',
            );
          }
        });
      }
      resolve();
    });
  });
}

/* === Folders === */

export function getFolders() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['folders'], (res) => resolve(res.folders || {}));
  });
}

export function setFolders(folders) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ folders }, resolve);
  });
}

/* === Variables === */

export function getVariables() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['variables'], (res) => resolve(res.variables || {}));
  });
}

/* === ID Generation === */

export function generateId() {
  return crypto.randomUUID();
}

/* === Undo / Redo Stacks ===
 * In-memory stacks persisted to chrome.storage.session (survives SW suspend).
 * LRU-capped at _UNDO_MAX_SCENARIOS scenarios; 50 entries per stack.
 */
const _UNDO_MAX_SCENARIOS = 20;

export const undoStacks = {};

const _undoOrder = [];

if (chrome.storage.session) {
  chrome.storage.session.get(['undoStacks'], (res) => {
    if (res?.undoStacks) {
      Object.assign(undoStacks, res.undoStacks);
      _undoOrder.push(...Object.keys(res.undoStacks));
    }
  });
}

// Debounce writes to session storage — undo operations can fire rapidly
// (e.g. holding Ctrl+Z), and each write has non-trivial IPC cost.
let _persistTimer = null;

function _persistUndoStacks() {
  if (chrome.storage.session) {
    clearTimeout(_persistTimer);
    _persistTimer = setTimeout(() => {
      chrome.storage.session.set({ undoStacks }).catch(() => {});
    }, 500);
  }
}

export function getStack(key) {
  if (!undoStacks[key]) {
    if (_undoOrder.length >= _UNDO_MAX_SCENARIOS) {
      const evicted = _undoOrder.shift();
      delete undoStacks[evicted];
    }
    undoStacks[key] = { undo: [], redo: [] };
    _undoOrder.push(key);
  } else {
    const idx = _undoOrder.indexOf(key);
    if (idx !== -1) { _undoOrder.splice(idx, 1); _undoOrder.push(key); }
  }
  return undoStacks[key];
}

export function pushUndo(key, snapshot) {
  const s = getStack(key);
  s.undo.push(JSON.parse(JSON.stringify(snapshot)));
  if (s.undo.length > 50) s.undo.shift();
  s.redo = []; // any new mutation invalidates the redo branch
  _persistUndoStacks();
}

export async function mutateScenarioActions(scenarioId, updater) {
  const scenarios = await getScenarios();
  if (!scenarios[scenarioId]) throw new Error(`Scenario "${scenarioId}" not found`);
  const prev = scenarios[scenarioId].actions ?? [];
  const next = updater(prev);
  pushUndo(scenarioId, prev);
  scenarios[scenarioId].actions = next;
  await setScenarios(scenarios);
  return next;
}
