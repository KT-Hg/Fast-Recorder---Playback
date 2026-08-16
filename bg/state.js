/**
 * state.js — Shared background service worker state.
 *
 * Recording and CSV playback state is persisted to chrome.storage.session so it
 * survives SW suspend/restart within the same browser session.
 * CSV rows are stored in chrome.storage.local (not session) to avoid the 10 MB
 * session-storage quota on large CSV files.
 */

export const state = {
  recording: false,
  recordingTabId: null,
  recordingScenarioId: null,
  pickMode: false,
  // pendingCrop moved to a per-window token map in bg/screenshot.js — a single
  // slot could not survive an editor reload or two crops opened back to back.
  currentActions: [],
  undoStack: [],
  redoStack: [],

  // Populated at SW startup when a CSV run was interrupted mid-session.
  // Exposed via GET_EXTENSION_STATUS so the popup can offer resume even if
  // it was not open when the SW restarted.
  csvInterrupted: null,

  playback: {
    active: false,
    tabId: null,
    scenarioId: null,
    scenarioName: null,
    originalScenarioName: null, // tracks pre-switch name for UI breadcrumb
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
    // Graceful stop: set by STOP_CSV_AFTER_ROW. The row in flight runs to the end
    // and its result is written before the loop exits, unlike STOP_CSV_PLAYBACK
    // which clears `active` and drops the partial row.
    stopAfterRow: false,
  },
  segmentCapture: { active: false, tabId: null, dir: null },
};

/* === CSV Playback State Persistence ===
 *
 * Row data is NOT duplicated here. The popup already writes the parsed CSV to
 * chrome.storage.local under `csvSessionData` — it needs it after the run to
 * build the result export — and this module used to write a second full copy to
 * `_csvRows`, doubling the footprint of every CSV in local storage for no gain.
 * Both now read the one record; only the lightweight row-index checkpoint lives
 * in session storage.
 */

const CSV_SESSION_KEY = 'csvSessionData';

/**
 * Persist a lightweight CSV checkpoint (row index only — rows live in local
 * storage).  Called before run starts, after each row, and on stop so an
 * interrupted run can always be resumed from the last completed row.
 */
export async function persistCsvState(scenarioId, currentRow, delayBetween, exportFormat) {
  if (!chrome.storage?.session) return;
  try {
    await chrome.storage.session.set({
      csv_pending: { scenarioId, currentRow, delayBetween, exportFormat, timestamp: Date.now() },
    });
  } catch (_) {}
}

/**
 * Drop the run checkpoint.
 *
 * `csvSessionData` is deliberately left in place: the popup reads it to build the
 * result CSV/XLSX after the run, so clearing it here would break the download.
 */
export async function clearCsvState() {
  if (!chrome.storage?.session) return;
  await chrome.storage.session.remove('csv_pending').catch(() => {});
}

/**
 * Attempt to restore a CSV run from a previous SW session.
 *
 * Returns null if:
 *  - No session storage available (< Chrome 102)
 *  - No checkpoint exists
 *  - Checkpoint is older than 30 minutes (stale — user likely closed the browser)
 *  - The parsed CSV is missing from local storage
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
    const localRes = await new Promise(r => chrome.storage.local.get([CSV_SESSION_KEY], r));
    const rows = localRes?.[CSV_SESSION_KEY]?.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      console.warn('[STATE] restoreCsvState: checkpoint found but CSV data missing — discarding');
      await clearCsvState();
      return null;
    }
    return { ...cp, rows };
  } catch (_) {}
  return null;
}

/* === Recording State Persistence === */

/**
 * Snapshot current recording state to session storage so in-progress
 * recordings survive the SW being suspended between user interactions.
 */
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

/**
 * Restore a recording session from the previous SW lifecycle.
 * Notifies the popup via RECORDING_RESTORED so it can re-render the action list.
 * Snapshots older than 30 minutes are silently discarded.
 */
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
