/**
 * background.js — Service Worker (ES module entry point).
 *
 * Acts as the message router and alarm scheduler; delegates all heavy logic
 * to the bg/ modules.  Responsibilities here:
 *   - Schedule alarm registration / teardown
 *   - Single chrome.runtime.onMessage handler (recording, CRUD, playback dispatch)
 */

import { state, persistRecordingState, restoreRecordingState, restoreCsvState, clearCsvState } from './bg/state.js';
import {
  getScenarios, setScenarios, getFolders, setFolders,
  getVariables, generateId, getStack, pushUndo, mutateScenarioActions,
} from './bg/storage.js';
import { updateBadge } from './bg/utils.js';
import {
  startPlayback, startPlaybackFromCheckpoint, startSequence, startCsvPlayback,
  refuseIfRecording, refuseRecordingIfPlaying,
} from './bg/playback.js';
import {
  takeFullPageScreenshot, takeElementScreenshot, compareScreenshots, downloadDataUrl,
  openCropUI, buildScreenshotFilename, getPendingCrop,
} from './bg/screenshot.js';
import { ssReadAll, ssClear, csvResultReadAll, csvResultClear } from './bg/idb-screenshots.js';
// Side-effect import: registers the window-capture listener.
import './bg/screenshot-window.js';
import {
  UPDATE_ALARM, AUTO_APPLY_ALARM, runUpdateCheck, ensureUpdateAlarm, scheduleCatchUpCheck,
  initUpdateAvailableListener, applyUpdate, markInstalledVersion,
  reconcileUpdateState, initLockWatcher, ensureLockState, notifyLocked,
  setBusyProbe, maybeAutoApply,
} from './bg/update-check.js';

/* === SCHEDULING (per-schedule chrome.alarms) === */

const ALARM_PREFIX = "sched_";

/**
 * Compute milliseconds until the next wall-clock occurrence of a "HH:MM" string.
 * If the time has already passed today, the result is for tomorrow's occurrence.
 *
 * Returns null for anything that is not a real time of day. A malformed value
 * used to produce NaN, which chrome.alarms.create rejects — leaving a schedule
 * that showed as "enabled" in the list but had no alarm behind it and never fired.
 */
function _msUntilTime(timeStr) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr ?? '').trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  const now = new Date();
  const next = new Date(now);
  next.setHours(hh, mm, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function registerScheduleAlarm(schedule) {
  if (!schedule?.enabled) return false;
  const ms = _msUntilTime(schedule.time);
  if (ms === null) {
    console.warn(`[SCHEDULE] Ignoring schedule ${schedule.id}: invalid time "${schedule.time}"`);
    return false;
  }
  const name = ALARM_PREFIX + schedule.id;
  const delayInMinutes = ms / 60000;
  if (schedule.repeat) {
    chrome.alarms.create(name, { delayInMinutes, periodInMinutes: 24 * 60 });
  } else {
    chrome.alarms.create(name, { delayInMinutes });
  }
  return true;
}

function unregisterScheduleAlarm(id) {
  chrome.alarms.clear(ALARM_PREFIX + id);
}

/* === RECORDING STATE FAN-OUT === */

/**
 * Tell every content script whether a recording is running.
 *
 * The recorder's click/input listeners in content.js are attached unconditionally
 * on every page and in every frame, so they need to know when to stay quiet.
 * Broadcast to all tabs rather than only state.recordingTabId: a recorded
 * navigation can land the session on a different tab, and a stale "recording"
 * flag left behind in some other tab would keep that tab chattering after the
 * session ends. Tabs with no content script (chrome://, the Web Store) simply
 * reject the message; lastError is read to keep it out of the console.
 */
function broadcastRecordingState(recording) {
  chrome.tabs.query({}, (tabs) => {
    void chrome.runtime.lastError;
    for (const t of tabs || []) {
      if (t.id == null) continue;
      chrome.tabs.sendMessage(t.id, { type: 'RECORDING_STATE', recording },
        () => { void chrome.runtime.lastError; });
    }
  });
}

// Set defaults on first install only — do not overwrite user settings on extension update.
chrome.runtime.onInstalled.addListener((details) => {
  // Restart the 30-day update clock. Runs on "install" too, so a fresh install
  // isn't judged against a deadline it was never around for.
  if (details?.reason === 'install' || details?.reason === 'update') markInstalledVersion();

  chrome.storage.local.get(['screenshotCountdownEnabled', 'screenshotCountdownSeconds'], (res) => {
    const defaults = {};
    if (res.screenshotCountdownEnabled === undefined) defaults.screenshotCountdownEnabled = true;
    if (res.screenshotCountdownSeconds === undefined) defaults.screenshotCountdownSeconds = 3;
    if (Object.keys(defaults).length) chrome.storage.local.set(defaults);
  });
});

// On SW startup: re-register alarms that were cleared when the SW was terminated.
// chrome.alarms are persistent but the in-memory alarm list is lost on SW restart.
chrome.storage.local.get(["schedules"], (res) => {
  const schedules = res.schedules || [];
  schedules.forEach((s) => {
    if (s.enabled) registerScheduleAlarm(s);
  });
});

// Daily Web Store version check + update-lock bookkeeping (see bg/update-check.js).
// The busy probe must be set before anything can decide to auto-apply an update:
// chrome.runtime.reload() takes the recording/playback down with the worker.
setBusyProbe(() => state.recording || state.playback.active ||
                   state.sequencePlayback.active || state.csvPlayback.active);
ensureUpdateAlarm();
scheduleCatchUpCheck();
initUpdateAvailableListener();
initLockWatcher();
reconcileUpdateState();

// Restore an in-progress recording if the SW was suspended mid-session.
// The re-broadcast covers content scripts that loaded while the worker was down
// and got `recording: false` from REGISTER_FRAME.
restoreRecordingState().then(() => {
  if (state.recording) { updateBadge(); broadcastRecordingState(true); }
});

// Detect an interrupted CSV run and cache it so the popup can offer resume.
restoreCsvState().then((csvPending) => {
  if (!csvPending) return;
  state.csvInterrupted = {
    scenarioId:   csvPending.scenarioId,
    totalRows:    csvPending.rows?.length ?? 0,
    resumeRow:    csvPending.currentRow ?? 0,
    delayBetween: csvPending.delayBetween,
    exportFormat: csvPending.exportFormat,
  };
  chrome.runtime.sendMessage({
    type: 'CSV_RUN_INTERRUPTED',
    pending: state.csvInterrupted,
  }).catch(() => {});
}).catch(() => {});

chrome.alarms.onAlarm.addListener((alarm) => {
  // Renew the playback keep-alive alarm while any playback is still running.
  if (alarm.name === 'playback-keepalive') {
    if (state.playback.active || state.sequencePlayback.active || state.csvPlayback.active) {
      chrome.alarms.create('playback-keepalive', { when: Date.now() + 20_000 });
    }
    return;
  }
  if (alarm.name === UPDATE_ALARM) { runUpdateCheck(); return; }
  // A critical update whose install was postponed because a run was in progress.
  if (alarm.name === AUTO_APPLY_ALARM) { maybeAutoApply(); return; }
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  const id = alarm.name.slice(ALARM_PREFIX.length);
  chrome.storage.local.get(["schedules"], (res) => {
    const schedules = res.schedules || [];
    const s = schedules.find((x) => x.id === id);
    if (!s || !s.enabled) return;
    // A locked extension must not run unattended either — skip the slot and say
    // why, but leave the schedule enabled so it resumes after the update.
    ensureLockState().then((lock) => {
      if (lock.locked) { notifyLocked(); return; }
      startPlayback(s.scenarioId);
      // A one-shot schedule burns itself only when it actually ran; a slot skipped
      // by the lock stays armed for the next occurrence.
      if (!s.repeat) {
        s.enabled = false;
        chrome.storage.local.set({ schedules });
        unregisterScheduleAlarm(id);
      }
    });
  });
});

/* === MAIN MESSAGE HANDLER === */

/**
 * Actions refused while the update lock is on: anything that *starts* capture,
 * recording or playback. Deliberately absent — every GET_*, every STOP_*, and the
 * export/backup paths, so a locked user can still watch a run finish, stop it, and
 * get their scenarios out. Screenshot messages are guarded in bg/screenshot.js and
 * bg/screenshot-window.js, which own their own listeners.
 */
const LOCKED_MESSAGE_TYPES = new Set([
  'START_RECORD',
  'START_PLAYBACK_SCENARIO', 'START_SEQUENCE_PLAYBACK',
  'START_CSV_PLAYBACK', 'RESUME_CSV_PLAYBACK', 'RESUME_PLAYBACK',
  'HOTKEY_SEG_START', 'HOTKEY_SCREENSHOT_ELEMENT',
  'START_SEGMENT_CAPTURE', 'CAPTURE_SEGMENT',
  'COMPARE_SCREENSHOTS',
]);

/**
 * Message types that start playback. Refused while a recording is in progress —
 * see the mutual-exclusion block in bg/playback.js for why the two modes cannot
 * overlap. Listed here so the router can answer with an error instead of letting
 * the request fall through and report `started: true` for a run that never began.
 */
const PLAYBACK_START_TYPES = new Set([
  'START_PLAYBACK_SCENARIO', 'START_SEQUENCE_PLAYBACK',
  'START_CSV_PLAYBACK', 'RESUME_CSV_PLAYBACK', 'RESUME_PLAYBACK',
]);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!LOCKED_MESSAGE_TYPES.has(request?.type)) {
    return handleMessage(request, sender, sendResponse);
  }
  // Must await: a hotkey wakes the service worker and its message can arrive
  // before the cached lock state has been read back from storage.
  ensureLockState().then((lock) => {
    if (lock.locked) {
      notifyLocked(lock.message);
      sendResponse({ locked: true, started: false, error: lock.message });
      return;
    }
    handleMessage(request, sender, sendResponse);
  });
  return true; // keep the channel open across the storage read
});

function handleMessage(request, sender, sendResponse) {
  const { type } = request;

  // Screenshot messages have their own dedicated listeners in bg/screenshot.js
  // and bg/screenshot-window.js. Returning undefined here (not `true`) tells
  // Chrome this handler did not handle the message, so they can take over.
  if (["TAKE_SCREENSHOT", "TAKE_SCREENSHOT_FULL",
       "TAKE_SCREENSHOT_SCROLL_V", "TAKE_SCREENSHOT_SCROLL_H",
       "TAKE_SCREENSHOT_ELEMENT",
       "OPEN_WINDOW_CAPTURE", "WINDOW_CAPTURE_RESULT", "RESTORE_BADGE"].includes(type)) return;

  // Refuse before dispatch so the caller is told the run did not start. The
  // guard is repeated inside each playback entry point for the callers that
  // never reach this router (scheduled alarms).
  if (PLAYBACK_START_TYPES.has(type) && refuseIfRecording()) {
    sendResponse({ started: false, error: 'Cannot start playback while recording is active' });
    return;
  }

  /* --- Forward recorded actions to popup --- */
  if (type === "RECORDED_ACTION") {
    // Both the store and the forward are gated. content.js now stays silent when
    // no session is running, but a frame injected before the gate existed (or one
    // that missed the RECORDING_STATE broadcast) can still send; re-broadcasting
    // its payload would put page input values on the message bus for no reason.
    if (!state.recording || state.pickMode) { sendResponse({ received: false }); return; }
    const snapshot = [...state.currentActions];
    const act = request.action;
    if (act.delay == null) act.delay = 500;
    state.currentActions.push(act);
    pushUndo("current", snapshot);
    persistRecordingState(); // persist across SW suspend
    chrome.runtime.sendMessage(request).catch(() => {});
    sendResponse({ received: true });
    return;
  }

  if (type === "CONTENT_READY") {
    const tabId = sender.tab?.id;
    chrome.storage.local.get(["playbackCheckpoint"], ({ playbackCheckpoint: cp }) => {
      // If a playback checkpoint exists for this tab and is less than 60 s old,
      // the page likely reloaded mid-playback — offer to resume from the last step.
      // Do NOT offer single-scenario resume when a CSV run is active: CSV has its
      // own resume mechanism and startPlaybackFromCheckpoint would run outside CSV
      // context (forceAutoSave=false, skipDownload=false), causing screenshot
      // save-as dialogs and skipping IDB accumulation for the zip.
      if (cp && tabId === cp.tabId && Date.now() - cp.timestamp < 60_000 && !state.csvPlayback.active) {
        chrome.runtime.sendMessage({ type: "OFFER_RESUME", checkpoint: cp }).catch(() => {});
      }
    });
    sendResponse({ received: true });
    return;
  }

  /* --- Web Store update check --- */
  if (type === "CHECK_FOR_UPDATE") {
    runUpdateCheck().then(() => chrome.storage.local.get(["updateStatus"], (res) => {
      sendResponse({ updateStatus: res?.updateStatus || null });
    }));
    return true;
  }

  if (type === "APPLY_UPDATE") {
    const busy = state.recording || state.playback.active ||
                 state.sequencePlayback.active || state.csvPlayback.active;
    applyUpdate({ busy }).then(sendResponse);
    return true;
  }

  // Content script needs its own frameId to tag recorded actions for correct
  // iframe targeting during playback.  sender.frameId is only available on the
  // background side; content scripts cannot access it directly.
  // `recording` rides along so a script injected mid-session (tab activation,
  // reconnect after a crash) starts gated correctly instead of waiting for the
  // next RECORDING_STATE broadcast.
  if (type === "REGISTER_FRAME") {
    sendResponse({ frameId: sender.frameId ?? 0, recording: state.recording });
    return;
  }

  if (type === "RESUME_PLAYBACK") {
    const { scenarioId, actionIndex, tabId } = request;
    chrome.storage.local.remove("playbackCheckpoint");
    startPlaybackFromCheckpoint(scenarioId, actionIndex + 1, tabId);
    sendResponse({ started: true });
    return;
  }

  if (type === "DISMISS_RESUME") {
    chrome.storage.local.remove("playbackCheckpoint");
    sendResponse({ ok: true });
    return;
  }

  /* --- Extension status --- */
  if (type === "GET_EXTENSION_STATUS") {
    sendResponse({
      recording: state.recording,
      recordingScenarioId: state.recordingScenarioId,
      playing: state.playback.active && !state.sequencePlayback.active,
      sequencePlaying: state.sequencePlayback.active,
      csvPlaying: state.csvPlayback.active,
      csvCurrentRow: state.csvPlayback.currentRow,
      csvTotalRows: state.csvPlayback.rows.length,
      csvScenarioName: state.csvPlayback.active ? (state.playback.scenarioName || null) : null,
      actionIndex: state.playback.actionIndex,
      totalActions: state.playback.totalActions,
      loopCurrent: state.playback.loopCurrent || 1,
      loopTotal: state.playback.loopTotal || 1,
      scenarioName: state.playback.scenarioName || null,
      originalScenarioName: state.playback.originalScenarioName || null,
      currentScenarioIndex: state.sequencePlayback.currentIndex,
      totalScenarios: state.sequencePlayback.runList.length,
      csvInterrupted: state.csvInterrupted,
    });
    return;
  }

  /* --- Recording --- */
  if (type === "START_RECORD") {
    if (refuseRecordingIfPlaying()) {
      sendResponse({ started: false, error: 'Cannot start recording while playback is active' });
      return;
    }
    const tabId = request.tabId || sender.tab?.id || null;
    const startRecording = (scenarioId) => {
      state.recording = true;
      state.recordingTabId = tabId;
      state.recordingScenarioId = scenarioId || null;
      state.currentActions = [];
      getStack("current").undo = [];
      getStack("current").redo = [];
      updateBadge();
      broadcastRecordingState(true);
      sendResponse({ started: true });
    };
    if (request.scenarioId) {
      startRecording(request.scenarioId);
    } else {
      // Hotkey-triggered recording: no scenarioId in request, so we fall back to
      // the last selected scenario from the popup (async storage read).
      chrome.storage.local.get(["lastSelectedScenario"], (res) => {
        startRecording(res?.lastSelectedScenario || null);
      });
      return true;
    }
    return;
  }

  if (type === "STOP_RECORD") {
    state.recording = false;
    const sid = state.recordingScenarioId;
    state.recordingScenarioId = null;
    updateBadge();
    broadcastRecordingState(false);
    // Remove session-storage snapshot — persisted only to survive SW suspend
    // during recording, no longer needed after stop.
    chrome.storage.session?.remove?.(['rec_recording','rec_scenarioId','rec_actions','rec_timestamp'], () => {});
    if (sid) {
      const newActions = [...state.currentActions];
      state.currentActions = [];
      getScenarios().then(async (scenarios) => {
        if (scenarios[sid]) {
          const existing = scenarios[sid].actions || [];
          pushUndo(sid, [...existing]);
          scenarios[sid].actions = [...existing, ...newActions];
          await setScenarios(scenarios);
          chrome.storage.local.set({ pendingRecordScenarioId: sid });
          sendResponse({ actions: scenarios[sid].actions, scenarioId: sid });
        } else {
          sendResponse({ actions: newActions });
        }
      });
      return true;
    }
    sendResponse({ actions: state.currentActions });
    return;
  }

  /* --- Preview / undo-redo --- */
  if (type === "GET_PREVIEW_ACTIONS") {
    if (request.scenarioId) {
      getScenarios().then((scenarios) => {
        sendResponse({ actions: scenarios[request.scenarioId]?.actions || [] });
      });
      return true;
    }
    sendResponse({ actions: state.currentActions });
    return;
  }

  if (type === "GET_UNDO_REDO_STATE") {
    const key = request.scenarioId || "current";
    const s = getStack(key);
    sendResponse({ canUndo: s.undo.length > 0, canRedo: s.redo.length > 0 });
    return;
  }

  if (type === "UNDO_ACTION") {
    const key = request.scenarioId || "current";
    const s = getStack(key);
    if (!s.undo.length) { sendResponse({ success: false }); return; }
    if (request.scenarioId) {
      getScenarios().then(async (scenarios) => {
        const current = scenarios[request.scenarioId]?.actions || [];
        s.redo.push(JSON.parse(JSON.stringify(current)));
        scenarios[request.scenarioId].actions = s.undo.pop();
        await setScenarios(scenarios);
        sendResponse({ success: true });
      });
      return true;
    } else {
      s.redo.push(JSON.parse(JSON.stringify(state.currentActions)));
      state.currentActions = s.undo.pop();
      sendResponse({ success: true });
      return;
    }
  }

  if (type === "REDO_ACTION") {
    const key = request.scenarioId || "current";
    const s = getStack(key);
    if (!s.redo.length) { sendResponse({ success: false }); return; }
    if (request.scenarioId) {
      getScenarios().then(async (scenarios) => {
        const current = scenarios[request.scenarioId]?.actions || [];
        s.undo.push(JSON.parse(JSON.stringify(current)));
        scenarios[request.scenarioId].actions = s.redo.pop();
        await setScenarios(scenarios);
        sendResponse({ success: true });
      });
      return true;
    } else {
      s.undo.push(JSON.parse(JSON.stringify(state.currentActions)));
      state.currentActions = s.redo.pop();
      sendResponse({ success: true });
      return;
    }
  }

  /* --- Manual action editing --- */
  if (type === "ADD_MANUAL_ACTION") {
    if (!request.action || typeof request.action !== 'object') {
      sendResponse({ success: false });
      return;
    }
    if (request.scenarioId) {
      mutateScenarioActions(request.scenarioId, (a) => [...a, request.action])
        .then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: false }));
      return true;
    }
    pushUndo("current", [...state.currentActions]);
    state.currentActions.push(request.action);
    sendResponse({ success: true });
    return;
  }

  /**
   * Index sanity check for the action-mutation handlers.
   *
   * These indices come from list positions the popup captured before an async
   * round-trip, so a fast second click or a concurrent edit could deliver one
   * that no longer exists. Writing past the end produced a sparse array holding
   * `undefined`, which then rendered as a shorter list for no visible reason and
   * threw during playback at interpolateAction(undefined).
   */
  const _validIndex = (i, len) => Number.isInteger(i) && i >= 0 && i < len;

  if (type === "UPDATE_ACTION") {
    if (request.scenarioId) {
      mutateScenarioActions(request.scenarioId, (a) => {
        if (!_validIndex(request.index, a.length)) throw new Error("index out of range");
        const next = [...a];
        next[request.index] = request.action;
        return next;
      }).then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: false }));
      return true;
    }
    if (!_validIndex(request.index, state.currentActions.length)) { sendResponse({ success: false }); return; }
    pushUndo("current", [...state.currentActions]);
    state.currentActions[request.index] = request.action;
    sendResponse({ success: true });
    return;
  }

  if (type === "REMOVE_ACTION") {
    if (request.scenarioId) {
      mutateScenarioActions(request.scenarioId, (a) => {
        if (!_validIndex(request.index, a.length)) throw new Error("index out of range");
        return a.filter((_, i) => i !== request.index);
      }).then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: false }));
      return true;
    }
    if (!_validIndex(request.index, state.currentActions.length)) { sendResponse({ success: false }); return; }
    pushUndo("current", [...state.currentActions]);
    state.currentActions.splice(request.index, 1);
    sendResponse({ success: true });
    return;
  }

  if (type === "TOGGLE_ACTION_DISABLED") {
    if (request.scenarioId) {
      mutateScenarioActions(request.scenarioId, (a) => {
        if (request.index < 0 || request.index >= a.length) throw new Error("out of range");
        const next = [...a];
        next[request.index] = { ...next[request.index], disabled: !next[request.index].disabled };
        return next;
      }).then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: false }));
      return true;
    }
    if (request.index < 0 || request.index >= state.currentActions.length) { sendResponse({ success: false }); return; }
    pushUndo("current", [...state.currentActions]);
    state.currentActions[request.index].disabled = !state.currentActions[request.index].disabled;
    sendResponse({ success: true });
    return;
  }

  if (type === "REORDER_ACTIONS") {
    // A reorder must be a permutation of the existing indices. Anything else —
    // a duplicate, a gap, a stale index from a racing drag — silently dropped or
    // cloned actions, so it is refused outright rather than half-applied.
    const _isPermutation = (order, len) =>
      Array.isArray(order) && order.length === len &&
      new Set(order).size === len &&
      order.every((i) => _validIndex(i, len));

    if (request.scenarioId) {
      mutateScenarioActions(request.scenarioId, (a) => {
        if (!_isPermutation(request.newOrder, a.length)) throw new Error("invalid reorder");
        return request.newOrder.map((i) => a[i]);
      }).then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: false }));
      return true;
    }
    if (!_isPermutation(request.newOrder, state.currentActions.length)) { sendResponse({ success: false }); return; }
    pushUndo("current", [...state.currentActions]);
    state.currentActions = request.newOrder.map((i) => state.currentActions[i]);
    sendResponse({ success: true });
    return;
  }

  /* --- Scenario CRUD --- */
  if (type === "GET_SCENARIOS") {
    getScenarios().then((scenarios) => sendResponse({ scenarios }));
    return true;
  }

  if (type === "SAVE_SCENARIO") {
    getScenarios().then(async (scenarios) => {
      const id = generateId();
      const now = Date.now();
      scenarios[id] = {
        name: request.name,
        actions: [...state.currentActions],
        folderId: request.folderId || null,
        createdAt: request.originalCreatedAt || now,
        updatedAt: now,
      };
      state.currentActions = [];
      getStack("current").undo = [];
      getStack("current").redo = [];
      await setScenarios(scenarios);
      sendResponse({ success: true, id });
    });
    return true;
  }

  if (type === "START_NEW_SCENARIO") {
    state.currentActions = [];
    getStack("current").undo = [];
    getStack("current").redo = [];
    sendResponse({ success: true });
    return;
  }

  if (type === "DELETE_SCENARIO") {
    getScenarios().then(async (scenarios) => {
      delete scenarios[request.scenarioId];
      await setScenarios(scenarios);
      sendResponse({ success: true });
    });
    return true;
  }

  if (type === "RENAME_SCENARIO") {
    getScenarios().then(async (scenarios) => {
      if (scenarios[request.scenarioId]) {
        scenarios[request.scenarioId].name = request.newName;
        await setScenarios(scenarios);
      }
      sendResponse({ success: true });
    });
    return true;
  }

  if (type === "DUPLICATE_SCENARIO") {
    getScenarios().then(async (scenarios) => {
      const original = scenarios[request.scenarioId];
      if (!original) { sendResponse({ success: false }); return; }
      const id = generateId();
      scenarios[id] = {
        ...original,
        name: original.name + " (copy)",
        actions: JSON.parse(JSON.stringify(original.actions || [])),
        createdAt: Date.now(),
      };
      await setScenarios(scenarios);
      sendResponse({ success: true, id });
    });
    return true;
  }

  if (type === "MOVE_TO_FOLDER") {
    getScenarios().then(async (scenarios) => {
      if (scenarios[request.scenarioId]) {
        scenarios[request.scenarioId].folderId = request.folderId || null;
        await setScenarios(scenarios);
      }
      sendResponse({ success: true });
    });
    return true;
  }

  if (type === "EXPORT_SCENARIO") {
    getScenarios().then((scenarios) => {
      sendResponse({ scenario: scenarios[request.scenarioId] || null });
    });
    return true;
  }

  /**
   * Shape check shared by both import paths. Previously anything JSON-shaped was
   * accepted, so a folder export (or any unrelated .json) became a scenario with
   * no actions — see IMPORT_FOLDER.
   */
  const _isScenarioShaped = (s) =>
    !!s && typeof s === 'object' && !Array.isArray(s) && Array.isArray(s.actions);

  if (type === "IMPORT_SCENARIO") {
    if (!_isScenarioShaped(request.scenario)) {
      sendResponse({ success: false, error: 'Not a scenario: expected an object with an "actions" array' });
      return true;
    }
    getScenarios().then(async (scenarios) => {
      const id = generateId();
      // folderId is dropped: it refers to a folder id from the exporting profile
      // that almost certainly does not exist here, which would hide the scenario
      // behind a folder filter that matches nothing.
      const { folderId: _ignored, ...rest } = request.scenario;
      scenarios[id] = { ...rest, folderId: null, createdAt: Date.now() };
      await setScenarios(scenarios);
      // Flag script actions in imported scenarios so the popup can warn the user —
      // imported code runs with the extension's elevated CSP privileges.
      const hasScriptActions = (request.scenario.actions || []).some(a => a?.type === 'script');
      sendResponse({ success: true, id, hasScriptActions });
    });
    return true;
  }

  /**
   * Import a file produced by EXPORT_FOLDER: { name, createdAt, scenarios: {…} }.
   *
   * That shape was never importable — the popup treated the whole object as one
   * scenario, producing an empty entry named after the folder while the real
   * scenarios were discarded. Recreating the folder here keeps the export
   * meaningful and preserves the grouping the user set up.
   */
  if (type === "IMPORT_FOLDER") {
    const payload = request.folder;
    const entries = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? Object.values(payload.scenarios || {})
      : [];
    const valid = entries.filter(_isScenarioShaped);
    if (!valid.length) {
      sendResponse({ success: false, error: 'Folder export contains no valid scenarios' });
      return true;
    }
    Promise.all([getFolders(), getScenarios()]).then(async ([folders, scenarios]) => {
      const folderId = generateId();
      folders[folderId] = { name: payload.name || 'Imported folder', createdAt: Date.now() };
      let hasScriptActions = false;
      for (const src of valid) {
        const { folderId: _ignored, ...rest } = src;
        scenarios[generateId()] = { ...rest, folderId, createdAt: Date.now() };
        if ((src.actions || []).some(a => a?.type === 'script')) hasScriptActions = true;
      }
      await Promise.all([setFolders(folders), setScenarios(scenarios)]);
      sendResponse({
        success: true, folderId, count: valid.length,
        skipped: entries.length - valid.length,
        folderName: folders[folderId].name,
        hasScriptActions,
      });
    });
    return true;
  }

  /* --- Folder CRUD --- */
  if (type === "GET_FOLDERS") {
    getFolders().then((folders) => sendResponse({ folders }));
    return true;
  }

  if (type === "CREATE_FOLDER") {
    getFolders().then(async (folders) => {
      const id = generateId();
      folders[id] = { name: request.name, createdAt: Date.now() };
      await setFolders(folders);
      sendResponse({ success: true, id });
    });
    return true;
  }

  if (type === "RENAME_FOLDER") {
    getFolders().then(async (folders) => {
      if (folders[request.folderId]) {
        folders[request.folderId].name = request.name;
        await setFolders(folders);
      }
      sendResponse({ success: true });
    });
    return true;
  }

  if (type === "DELETE_FOLDER") {
    Promise.all([getFolders(), getScenarios()]).then(async ([folders, scenarios]) => {
      delete folders[request.folderId];
      Object.values(scenarios).forEach((s) => {
        if (s.folderId === request.folderId) s.folderId = null;
      });
      await Promise.all([setFolders(folders), setScenarios(scenarios)]);
      sendResponse({ success: true });
    });
    return true;
  }

  if (type === "EXPORT_FOLDER") {
    Promise.all([getFolders(), getScenarios()]).then(([folders, scenarios]) => {
      const folder = folders[request.folderId];
      if (!folder) { sendResponse({ folder: null }); return; }
      const folderScenarios = Object.entries(scenarios)
        .filter(([, s]) => s.folderId === request.folderId)
        .reduce((acc, [id, s]) => { acc[id] = s; return acc; }, {});
      sendResponse({ folder: { ...folder, scenarios: folderScenarios } });
    });
    return true;
  }

  /* --- Backup / Restore All Data ---
   *
   * The backup file is the whole chrome.storage.local snapshot with the
   * chrome.storage.sync settings nested under BACKUP_SYNC_KEY. Both areas are
   * needed: scenarios, folders, variables and highlights live in `local`, while
   * hotkeys, screenshot save mode/prefix, segment scroll speed and the completion
   * notification toggle live in `sync`. Backing up only `local` silently lost the
   * whole second half.
   *
   * Restore filters by *deny*list rather than allowlist. The old allowlist had to
   * be extended by hand for every new feature and had fallen behind: highlights
   * (hl_v1), highlight URL patterns, the highlight on/off toggle, the tab order
   * and the screenshot countdown settings were all written by the app, captured
   * in the backup file, and then dropped on the way back in — while the toast
   * still said "Data restored". A denylist only has to name things that are
   * genuinely not portable, and those change far less often.
   */
  if (type === "GET_ALL_DATA") {
    Promise.all([
      new Promise(r => chrome.storage.local.get(null, r)),
      new Promise(r => chrome.storage.sync.get(null, r)),
    ]).then(([local, sync]) => {
      sendResponse({ data: local || {}, sync: sync || {} });
    });
    return true;
  }

  if (type === "RESTORE_ALL_DATA") {
    const data = request.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      sendResponse({ success: false, error: "Invalid backup format: expected an object" });
      return true;
    }

    // Keys deliberately NOT carried across a restore.
    const DENIED_KEYS = new Set([
      // Machine-local and session-local: tab ids from another profile point at
      // unrelated tabs, and a stale checkpoint pops a false "resume?" banner.
      "activatedTabs", "playbackCheckpoint",
      // Bulk transient run data — large, and meaningless once the run is over.
      "_csvRows", "csvSessionData", "csvRunResults", "csvSsVarOrder",
      // Half-finished popup interactions.
      "pendingEdit", "manualFormDraft", "pendingRecordScenarioId",
      "elemShotPickPending", "elemShotPickCrop",
      "lastPickedSelector", "lastPickedSelectors",
      "dragdropTargetPickPending", "dragdropTargetPickState",
      // Update bookkeeping belongs to this install, not to the backup. Importing
      // another machine's grace-period anchors could lock this one out.
      "updateStatus", "updateAvailableSince", "lastUpdateAt", "remoteConfig",
      "autoApplyAt", "autoApplyTries", "updateBannerDismissed",
      // Dead key from builds that wrote an unreadable rollback snapshot.
      "_preRestoreBackup",
    ]);

    const BACKUP_SYNC_KEY = "__sync";
    const syncPayload = data[BACKUP_SYNC_KEY];
    const sanitized = {};
    for (const [k, v] of Object.entries(data)) {
      if (k === BACKUP_SYNC_KEY || DENIED_KEYS.has(k)) continue;
      sanitized[k] = v;
    }

    const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
    if (sanitized.scenarios !== undefined && !isPlainObject(sanitized.scenarios)) {
      sendResponse({ success: false, error: "Invalid backup: scenarios must be an object" }); return true;
    }
    if (sanitized.folders !== undefined && !isPlainObject(sanitized.folders)) {
      sendResponse({ success: false, error: "Invalid backup: folders must be an object" }); return true;
    }
    if (sanitized.schedules !== undefined && !Array.isArray(sanitized.schedules)) {
      sendResponse({ success: false, error: "Invalid backup: schedules must be an array" }); return true;
    }

    // Merge (not clear+set) to avoid data loss if the browser crashes mid-write.
    // No rollback snapshot is stored: the one this used to write was never read
    // by anything, and it doubled storage usage on every restore. The popup warns
    // to take a backup first instead.
    const writeLocal = new Promise((resolve) => {
      chrome.storage.local.set(sanitized, () => resolve(chrome.runtime.lastError?.message || null));
    });
    // Backups made before sync settings were included simply have no __sync block.
    const writeSync = isPlainObject(syncPayload)
      ? new Promise((resolve) => {
          chrome.storage.sync.set(syncPayload, () => resolve(chrome.runtime.lastError?.message || null));
        })
      : Promise.resolve(null);

    Promise.all([writeLocal, writeSync]).then(([localErr, syncErr]) => {
      if (localErr) { sendResponse({ success: false, error: localErr }); return; }
      state.recording = false;
      state.currentActions = [];
      broadcastRecordingState(false);
      // A sync failure (quota, sync disabled) must not fail the whole restore —
      // the scenarios are already in. Report it so the user can redo the settings.
      sendResponse({
        success: true,
        restoredSync: !!isPlainObject(syncPayload) && !syncErr,
        warning: syncErr ? `Settings could not be restored: ${syncErr}` : null,
      });
    });
    return true;
  }

  /* --- Variables --- */
  if (type === "GET_VARIABLES") {
    getVariables().then((variables) => sendResponse({ variables }));
    return true;
  }

  if (type === "SAVE_VARIABLES") {
    chrome.storage.local.set({ variables: request.variables }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  /* --- Playback dispatch --- */
  if (type === "START_PLAYBACK_SCENARIO") {
    startPlayback(request.scenarioId, request.loopCount || 1, request.loopDelay || 0);
    sendResponse({ started: true });
    return;
  }

  if (type === "STOP_PLAYBACK") {
    state.playback.active = false;
    state.csvPlayback.active = false;
    state.sequencePlayback.active = false;
    updateBadge();
    sendResponse({ stopped: true });
    return;
  }

  if (type === "START_SEQUENCE_PLAYBACK") {
    startSequence(request.runList);
    sendResponse({ started: true });
    return;
  }

  if (type === "STOP_SEQUENCE_PLAYBACK") {
    state.sequencePlayback.active = false;
    state.playback.active = false;
    updateBadge();
    sendResponse({ stopped: true });
    return;
  }

  /* --- CSV Playback --- */
  if (type === "START_CSV_PLAYBACK") {
    state.csvInterrupted = null;
    startCsvPlayback(request.scenarioId, request.rows, request.delayBetween || 500, request.exportFormat || "csv");
    sendResponse({ started: true });
    return;
  }

  // Resume an interrupted CSV run from the last persisted checkpoint.
  // The full rows array is reloaded from local storage (not session) because it
  // may exceed the session-storage quota.  startRowIndex is passed to
  // startCsvPlayback so result records keep their original row indices.
  if (type === "RESUME_CSV_PLAYBACK") {
    restoreCsvState().then((csvPending) => {
      if (!csvPending) { sendResponse({ error: 'No pending CSV state' }); return; }
      const { scenarioId, rows, currentRow, delayBetween, exportFormat } = csvPending;
      state.csvInterrupted = null;
      startCsvPlayback(scenarioId, rows, delayBetween || 500, exportFormat || 'csv', currentRow);
      sendResponse({ started: true, resumedFrom: currentRow });
    });
    return true;
  }

  if (type === "DISMISS_CSV_RESUME") {
    state.csvInterrupted = null;
    import('./bg/state.js').then(m => m.clearCsvState()).catch(() => {});
    sendResponse({ ok: true });
    return;
  }

  // Hard stop: abandons the row in flight, so its result is never written.
  if (type === "STOP_CSV_PLAYBACK") {
    state.csvPlayback.active = false;
    state.csvPlayback.stopAfterRow = false;
    state.playback.active = false;
    updateBadge();
    // Discard the checkpoint so a user-stopped run is never offered as resumable.
    clearCsvState().catch(() => {});
    sendResponse({ stopped: true });
    return;
  }

  // Graceful stop: let the current row finish and be recorded, then end the run.
  // Previously the "After row" button sent STOP_CSV_PLAYBACK too, so it behaved
  // identically to "Now" and silently dropped the row that was mid-flight.
  if (type === "STOP_CSV_AFTER_ROW") {
    if (!state.csvPlayback.active) { sendResponse({ pending: false, alreadyStopped: true }); return; }
    state.csvPlayback.stopAfterRow = true;
    sendResponse({ pending: true, currentRow: state.csvPlayback.currentRow });
    return;
  }

  if (type === "GET_CSV_STATUS") {
    sendResponse({
      active: state.csvPlayback.active,
      currentRow: state.csvPlayback.currentRow,
      totalRows: state.csvPlayback.rows.length,
    });
    return;
  }

  if (type === "GET_CSV_RUN_RESULTS") {
    csvResultReadAll()
      .then(results => sendResponse({ results }))
      .catch(e => { console.error('[CSV] IDB read failed:', e); sendResponse({ results: [] }); });
    return true;
  }

  if (type === "GET_CSV_SCREENSHOTS") {
    ssReadAll()
      .then(screenshots => {
        chrome.storage.local.get('csvSsVarOrder', res => {
          sendResponse({ screenshots, ssVarOrder: res.csvSsVarOrder || [] });
        });
      })
      .catch(e => { console.error('[CSV] IDB read failed:', e); sendResponse({ screenshots: {}, ssVarOrder: [] }); });
    return true;
  }

  if (type === "CLEAR_CSV_SCREENSHOTS") {
    ssClear().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (type === "CLEAR_CSV_RESULTS") {
    csvResultClear().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }

  /* --- Schedules --- */
  if (type === "GET_SCHEDULES") {
    chrome.storage.local.get(["schedules"], (res) => {
      sendResponse({ schedules: res.schedules || [] });
    });
    return true;
  }

  if (type === "SAVE_SCHEDULE") {
    chrome.storage.local.get(["schedules"], (res) => {
      const schedules = res.schedules || [];
      const idx = schedules.findIndex((s) => s.id === request.schedule.id);
      if (idx >= 0) schedules[idx] = request.schedule;
      else schedules.push(request.schedule);
      chrome.storage.local.set({ schedules }, () => {
        // Always unregister first — ensures a time change takes effect immediately
        // rather than firing at the old time.
        unregisterScheduleAlarm(request.schedule.id);
        const armed = registerScheduleAlarm(request.schedule);
        // Reported so the popup can tell the user their schedule will not run,
        // instead of showing it as enabled with no alarm behind it.
        sendResponse({ success: true, armed, invalidTime: request.schedule.enabled && !armed });
      });
    });
    return true;
  }

  if (type === "DELETE_SCHEDULE") {
    chrome.storage.local.get(["schedules"], (res) => {
      const schedules = (res.schedules || []).filter((s) => s.id !== request.id);
      chrome.storage.local.set({ schedules }, () => {
        unregisterScheduleAlarm(request.id);
        sendResponse({ success: true });
      });
    });
    return true;
  }

  if (type === "SAVE_SEQUENCE_AS_SCENARIO") {
    getScenarios().then(async (scenarios) => {
      const allActions = [];
      for (let i = 0; i < request.runList.length; i++) {
        const item = request.runList[i];
        const s = scenarios[item.id];
        if (s?.actions) allActions.push(...s.actions);
        if (i < request.runList.length - 1 && item.delay > 0) {
          allActions.push({ type: "wait", value: String(item.delay) });
        }
      }
      const id = generateId();
      scenarios[id] = { name: request.name, actions: allActions, folderId: null, createdAt: Date.now() };
      await setScenarios(scenarios);
      sendResponse({ success: true, id });
    });
    return true;
  }

  /* --- Activation check (for content.js hotkey guard) --- */
  if (type === "IS_TAB_ACTIVATED") {
    const tabId = sender.tab?.id;
    chrome.storage.local.get(["activatedTabs"], (res) => {
      const activated = tabId != null && (res.activatedTabs || []).includes(tabId);
      sendResponse({ activated });
    });
    return true;
  }

  /* --- Image Editor (from clipboard / file in popup) --- */
  if (type === "OPEN_IMAGE_EDITOR") {
    const { dataUrl, sourceFileName } = request;
    let downloadPath;
    if (sourceFileName) {
      // Uploaded / dropped file: "{baseName}_edited_YYYY-MM-DD_HH-MM-SS.png"
      const baseName = sourceFileName.replace(/\.[^.]+$/, '');
      downloadPath = buildScreenshotFilename(baseName + '_edited', null);
    } else {
      // Paste / clipboard: use same configurable prefix as auto screenshots
      chrome.storage.sync.get(["screenshotPrefix"], (settings) => {
        const prefix = settings.screenshotPrefix || "screenshot";
        const path = buildScreenshotFilename(prefix, null);
        openCropUI(dataUrl, path, false);
      });
      sendResponse({ ok: true });
      return;
    }
    openCropUI(dataUrl, downloadPath, false);
    sendResponse({ ok: true });
    return;
  }

  /* --- Crop UI ---
   * Keyed by the token in the editor window's URL, and deliberately NOT consumed
   * on read: the entry lives until that window closes, so reloading the editor
   * re-loads the same image instead of finding an empty slot and closing. */
  if (type === "GET_PENDING_CROP") {
    sendResponse({ crop: getPendingCrop(request.token) });
    return;
  }

  if (type === "SAVE_CROPPED") {
    downloadDataUrl(request.dataUrl, request.downloadPath, request.saveAs).then((id) => {
      if (id == null) { sendResponse({ error: "Download failed" }); return; }
      let responded = false;
      const respond = (r) => { if (!responded) { responded = true; sendResponse(r); } };

      // Cleanup removes listener AND clears timeout to prevent leaks.
      const cleanup = (result) => {
        clearTimeout(timeoutHandle);
        chrome.downloads.onChanged.removeListener(onChanged);
        respond(result);
      };

      const onChanged = (delta) => {
        if (delta.id !== id) return;
        const st = delta.state?.current;
        if (st === 'complete')         cleanup({ success: true });
        else if (st === 'interrupted') cleanup({ error: 'Cancelled' });
      };

      // 60 s hard timeout removes the listener even on hung/stalled downloads,
      // preventing a permanent listener leak in the service worker.
      const timeoutHandle = setTimeout(() => cleanup({ error: 'Download timeout' }), 60_000);

      chrome.downloads.onChanged.addListener(onChanged);
      // Race guard: the download may have already completed between the download()
      // call and the listener registration.  Poll current state to catch that window.
      chrome.downloads.search({ id }, (items) => {
        if (!items?.length) return;
        const st = items[0].state;
        if (st === 'complete')         cleanup({ success: true });
        else if (st === 'interrupted') cleanup({ error: 'Cancelled' });
      });
    });
    return true;
  }

  /* --- Element picker passthrough --- */
  if (type === "START_PICK_MODE" || type === "STOP_PICK_MODE") {
    state.pickMode = (type === "START_PICK_MODE");
    updateBadge();
    const tabId = request.tabId || sender.tab?.id;
    if (tabId) chrome.tabs.sendMessage(tabId, request);
    sendResponse({ sent: true });
    return;
  }

  /* --- Element picked → reopen popup or trigger element screenshot --- */
  if (type === "ELEMENT_PICKED") {
    state.pickMode = false;
    updateBadge();
    // Minimal 1×1 transparent PNG — same rationale as _NOTIF_ICON in bg/utils.js.
    const _ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAbElEQVR42mNkYGBg+E8BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPhhFAABAAD//wMAA+gBkAAAAAAASUVORK5CYII=";
    const _elemShotErr = (msg) => chrome.notifications.create(
      "elemshot_err_" + Date.now(),
      { type: "basic", iconUrl: _ICON, title: "Element Screenshot", message: msg },
      () => { void chrome.runtime.lastError; },
    );
    chrome.storage.local.get(["elemShotPickPending", "elemShotPickCrop"], (flags) => {
      // The "could not get a selector" case is checked here, before the branch.
      // It used to sit *inside* a branch already guarded by `request.selector`,
      // so it could never run — a pick that yielded no selector fell through to
      // the else and reopened the popup, giving no clue why nothing was captured.
      if (flags.elemShotPickPending && !request.selector && !request.selectors) {
        chrome.storage.local.remove(["elemShotPickPending", "elemShotPickCrop"]);
        _elemShotErr("Could not get a selector for that element — try picking a different one");
        sendResponse({ received: true });
        return;
      }
      if (flags.elemShotPickPending && request.selector) {
        chrome.storage.local.remove(["elemShotPickPending", "elemShotPickCrop", "lastPickedSelector", "lastPickedSelectors"]);
        const crop = !!flags.elemShotPickCrop;
        const tabId = request.tabId || sender.tab?.id;
        if (!tabId) { _elemShotErr("Lost track of the tab — try the capture again"); return; }
        {
          chrome.storage.sync.get(["screenshotSaveMode", "screenshotPrefix"], (settings) => {
            const saveMode = settings.screenshotSaveMode || "auto";
            const prefix   = settings.screenshotPrefix   || "screenshot";
            // Use takeElementScreenshot so zoom normalization and coordinate re-query run inside CDP session
            takeElementScreenshot(tabId, request.selector, saveMode, prefix, crop, false, false, request.selectors)
              .then((result) => {
                chrome.runtime.sendMessage({ type: "SCREENSHOT_RESULT", result }).catch(() => {});
                const _notif = (msg) => chrome.notifications.create("elemshot_" + Date.now(), { type: "basic", iconUrl: _ICON, title: "Element Screenshot", message: msg }, () => { void chrome.runtime.lastError; });
                if (result.error) _notif("Error: " + result.error);
                else if (!crop)   _notif("Saved: " + (result.filename || "screenshot"));
              })
              .catch((e) => _elemShotErr("Error: " + e.message));
          });
        }
      } else {
        chrome.action.openPopup().catch(() => {
          // openPopup() requires a user gesture in MV3 — it fails silently when
          // triggered programmatically (e.g. after an async flow).  Fall back to
          // a badge so the user knows to click the extension icon manually.
          chrome.action.setBadgeText({ text: "✓" });
          chrome.action.setBadgeBackgroundColor({ color: "#22c55e" });
        });
      }
    });
    sendResponse({ received: true });
    return;
  }

  /* --- Image diff --- */
  if (type === "COMPARE_SCREENSHOTS") {
    compareScreenshots(request.dataUrlA, request.dataUrlB, request.threshold ?? 10)
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  /* --- Hotkey: start segment capture from content script --- */
  if (type === "HOTKEY_SEG_START") {
    const tabId = sender.tab?.id;
    if (!tabId) return;
    // Reset to 100% for the whole session, same as the popup-initiated path below.
    chrome.tabs.getZoom(tabId, (origZoom) => {
      void chrome.runtime.lastError;
      const needReset = typeof origZoom === 'number' && Math.abs(origZoom - 1) > 0.01;
      state.segmentCapture = { active: true, tabId, dir: request.dir, crop: false, origZoom: needReset ? origZoom : null };
      const startSelection = () => chrome.tabs.sendMessage(tabId, { type: "START_SEGMENT_TAB", dir: request.dir });
      if (needReset) chrome.tabs.setZoom(tabId, 1, () => { void chrome.runtime.lastError; setTimeout(startSelection, 300); });
      else startSelection();
    });
    sendResponse({ ok: true });
    return;
  }

  /* --- Hotkey: element screenshot — start pick mode --- */
  if (type === "HOTKEY_SCREENSHOT_ELEMENT") {
    const tabId = sender.tab?.id;
    if (!tabId) return;
    chrome.storage.local.set({ elemShotPickPending: true, elemShotPickCrop: false });
    state.pickMode = true;
    updateBadge();
    chrome.tabs.sendMessage(tabId, { type: "START_PICK_MODE" });
    sendResponse({ ok: true });
    return;
  }

  /* --- Segment capture: start --- */
  if (type === "START_SEGMENT_CAPTURE") {
    const segTabId = request.tabId;
    // Reset browser zoom to 100% for the WHOLE segment session before the on-page
    // selection starts. The selection rect is recorded from scrollX/Y + innerWidth/Height
    // (CSS px at the current zoom), so it must be selected AND captured at the same zoom.
    // Resetting up-front means both happen at 100% — the segment image then matches the
    // Full/Scroll/Element captures. origZoom is restored when the session ends.
    chrome.tabs.getZoom(segTabId, (origZoom) => {
      void chrome.runtime.lastError;
      const needReset = typeof origZoom === 'number' && Math.abs(origZoom - 1) > 0.01;
      state.segmentCapture = { active: true, tabId: segTabId, dir: request.dir, crop: !!request.crop, origZoom: needReset ? origZoom : null };
      const startSelection = () => chrome.tabs.sendMessage(segTabId, { type: "START_SEGMENT_TAB", dir: request.dir });
      if (needReset) {
        chrome.tabs.setZoom(segTabId, 1, () => { void chrome.runtime.lastError; setTimeout(startSelection, 300); });
      } else {
        startSelection();
      }
    });
    sendResponse({ ok: true });
    return;
  }

  /* --- Segment capture: stop & capture --- */
  if (type === "CAPTURE_SEGMENT") {
    const { tabId, dir, crop, origZoom } = state.segmentCapture;
    state.segmentCapture = { active: false, tabId: null, dir: null, crop: false };
    // Restore the user's zoom once the capture settles (success or error).
    const restoreZoom = () => { if (origZoom != null && tabId != null) chrome.tabs.setZoom(tabId, origZoom, () => { void chrome.runtime.lastError; }); };
    chrome.storage.sync.get(["screenshotSaveMode", "screenshotPrefix"], (settings) => {
      const saveMode = settings.screenshotSaveMode || "auto";
      const prefix   = settings.screenshotPrefix   || "screenshot";
      const { yStart, yEnd, xStart, xEnd } = request;
      const segClip = { x: xStart, y: yStart, width: xEnd - xStart, height: yEnd - yStart };
      takeFullPageScreenshot(tabId, saveMode, prefix, null, crop, 'full', false, false, segClip, dir)
        .then(result => {
          chrome.runtime.sendMessage({ type: "SCREENSHOT_RESULT", result }).catch(() => {});
        })
        .catch(e => {
          chrome.runtime.sendMessage({ type: "SCREENSHOT_RESULT", result: { error: e.message } }).catch(() => {});
        })
        .finally(restoreZoom);
    });
    sendResponse({ ok: true });
    return;
  }

  /* --- Segment capture: cancel --- */
  if (type === "CANCEL_SEGMENT_CAPTURE") {
    const { tabId, origZoom } = state.segmentCapture;
    if (origZoom != null && tabId != null) chrome.tabs.setZoom(tabId, origZoom, () => { void chrome.runtime.lastError; });
    state.segmentCapture = { active: false, tabId: null, dir: null };
    sendResponse({ ok: true });
    return;
  }
}

