/** storage.js — Chrome storage CRUD helpers for scenarios, folders, variables */

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
        console.error('[STORAGE] setScenarios failed:', chrome.runtime.lastError.message);
        chrome.runtime.sendMessage({ type: 'STORAGE_ERROR', msg: chrome.runtime.lastError.message }).catch(() => {});
      } else {
        // Warn at 85 % capacity — below the hard limit but early enough to act.
        // chrome.storage.local quota is 5 MB by default; QUOTA_BYTES is not
        // always defined in all Chrome versions so we fall back to the spec value.
        chrome.storage.local.getBytesInUse(null, (bytes) => {
          const limit = chrome.storage.local.QUOTA_BYTES || 5242880;
          if (bytes > limit * 0.85) {
            chrome.runtime.sendMessage({ type: 'STORAGE_WARNING', bytes, limit }).catch(() => {});
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
 * In-memory per-scenario stacks persisted to chrome.storage.session so they
 * survive SW suspend within the same browser session.
 *
 * Capacity limits:
 *   _UNDO_MAX_SCENARIOS — LRU eviction; avoids unbounded Map growth across many tabs.
 *   50 per stack          — keeps session storage impact predictable.
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
    // LRU eviction — drop the oldest tracked scenario when the cap is reached.
    if (_undoOrder.length >= _UNDO_MAX_SCENARIOS) {
      const evicted = _undoOrder.shift();
      delete undoStacks[evicted];
    }
    undoStacks[key] = { undo: [], redo: [] };
    _undoOrder.push(key);
  } else {
    // Promote to MRU position.
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

/**
 * Atomically fetch a scenario, push its current actions onto the undo stack,
 * apply the updater, and persist — all within a single async transaction.
 * Throws if scenarioId is not found.
 *
 * @param {string}   scenarioId
 * @param {Function} updater  (prevActions: Array) => nextActions: Array
 * @returns {Promise<Array>} The updated actions array
 */
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
