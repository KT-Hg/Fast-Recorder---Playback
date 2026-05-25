/**
 * state.js — Shared background service worker state.
 *
 * Recording and CSV playback state is persisted to chrome.storage.session so it
 * survives SW suspend/restart within the same browser session.
 * CSV rows are stored in chrome.storage.local (not session) to avoid the 10 MB
 * session-storage quota on large CSVs.
 */

export const state = {
  recording: false,
  recordingTabId: null,
  recordingScenarioId: null,
  pickMode: false,
  pendingCrop: null,
  currentActions: [],
  undoStack: [],
  redoStack: [],

  // Set at SW startup when a CSV run was interrupted mid-session.
  // Exposed via GET_EXTENSION_STATUS so the popup can offer resume even if it
  // was not open at the moment the SW restarted.
  csvInterrupted: null,

  playback: {
    active: false,
    tabId: null,
    scenarioId: null,
    scenarioName: null,
    originalScenarioName: null,
    actionIndex: 0,
    totalActions: 0,
  },
  sequencePlayback: {
    active: false,
    runList: [],
    currentIndex: 0,
  },
  csvPlayback: {
    active: false,
    rows: [],
    currentRow: 0,
    scenarioId: null,
    delayBetween: 500,
  },
  segmentCapture: { active: false, tabId: null, dir: null },
};

/* === CSV Rows Storage === */

/** Save the full rows array to local storage so restoreCsvState can reload them after SW restart. */
export function saveCsvRows(rows) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ _csvRows: rows }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[STATE] saveCsvRows failed:', chrome.runtime.lastError.message);
      }
      resolve();
    });
  });
}

/* === CSV Playback State Persistence === */

/**
 * Persist a lightweight CSV checkpoint (row index only — rows live in local storage).
 * Called before run starts, after each row, and on stop.
 */
export async function persistCsvState(scenarioId, currentRow, delayBetween, exportFormat) {
  if (!chrome.storage?.session) return;
  try {
    await chrome.storage.session.set({
      csv_pending: { scenarioId, currentRow, delayBetween, exportFormat, timestamp: Date.now() },
    });
  } catch (_) {}
}

/** Clear both the session checkpoint and the local-stored rows. */
export async function clearCsvState() {
  const tasks = [];
  if (chrome.storage?.session) {
    tasks.push(chrome.storage.session.remove('csv_pending').catch(() => {}));
  }
  tasks.push(new Promise(r => chrome.storage.local.remove('_csvRows', r)));
  await Promise.all(tasks);
}

/**
 * Restore a CSV run from a previous SW session.
 * Returns null if no valid checkpoint exists, if rows are missing, or if the
 * checkpoint is older than 30 minutes (stale).
 */
export async function restoreCsvState() {
  if (!chrome.storage?.session) return null;
  try {
    const res = await chrome.storage.session.get(['csv_pending']);
    const cp  = res.csv_pending;
    if (!cp || !cp.timestamp || Date.now() - cp.timestamp >= 1_800_000) {
      if (cp) await clearCsvState();
      return null;
    }
    const localRes = await new Promise(r => chrome.storage.local.get(['_csvRows'], r));
    const rows = localRes._csvRows;
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      console.warn('[STATE] restoreCsvState: checkpoint found but rows missing — discarding');
      await clearCsvState();
      return null;
    }
    return { ...cp, rows };
  } catch (_) {}
  return null;
}

/* === Recording State Persistence === */

export async function persistRecordingState() {
  if (!chrome.storage?.session) return;
  try {
    await chrome.storage.session.set({
      rec_recording:  state.recording,
      rec_scenarioId: state.recordingScenarioId,
      rec_actions:    state.currentActions,
      rec_timestamp:  Date.now(),
    });
  } catch (_) {}
}

export async function restoreRecordingState() {
  if (!chrome.storage?.session) return;
  try {
    const res = await chrome.storage.session.get([
      'rec_recording', 'rec_scenarioId', 'rec_actions', 'rec_timestamp',
    ]);
    if (res.rec_recording && res.rec_timestamp && Date.now() - res.rec_timestamp < 1_800_000) {
      state.recording = true;
      state.recordingScenarioId = res.rec_scenarioId || null;
      state.currentActions = res.rec_actions || [];
      chrome.runtime.sendMessage({
        type: 'RECORDING_RESTORED',
        count: state.currentActions.length,
      }).catch(() => {});
    }
  } catch (_) {}
}
