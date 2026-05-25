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

/* === Undo Stacks ===
 * Tracks up to _UNDO_MAX_SCENARIOS scenarios with LRU eviction.
 * Each stack is capped at 50 entries.
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
  s.redo = [];
  _persistUndoStacks();
}

/**
 * Fetch a scenario, push undo, apply updater(actions) → newActions, and save.
 * Throws if scenarioId is not found.
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
