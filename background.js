/**
 * background.js — Service Worker (ES module entry point)
 * Orchestrates all bg/ modules. Contains only:
 *   - Schedule / alarm setup
 *   - Main chrome.runtime.onMessage handler (recording, CRUD, dispatch)
 */

import { state } from './bg/state.js';
import {
  getScenarios, setScenarios, getFolders, setFolders,
  getVariables, generateId, getStack, pushUndo, mutateScenarioActions,
} from './bg/storage.js';
import { updateBadge } from './bg/utils.js';
import { startPlayback, startPlaybackFromCheckpoint, startSequence, startCsvPlayback } from './bg/playback.js';
import {
  takeFullPageScreenshot, compareScreenshots, downloadDataUrl,
} from './bg/screenshot.js';

/* === SCHEDULING (per-schedule chrome.alarms) === */

const ALARM_PREFIX = "sched_";

/** Milliseconds until the next occurrence of "HH:MM" */
function _msUntilTime(timeStr) {
  const [hh, mm] = timeStr.split(":").map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(hh, mm, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function registerScheduleAlarm(schedule) {
  if (!schedule?.enabled) return;
  const name = ALARM_PREFIX + schedule.id;
  const delayInMinutes = _msUntilTime(schedule.time) / 60000;
  if (schedule.repeat) {
    chrome.alarms.create(name, { delayInMinutes, periodInMinutes: 24 * 60 });
  } else {
    chrome.alarms.create(name, { delayInMinutes });
  }
}

function unregisterScheduleAlarm(id) {
  chrome.alarms.clear(ALARM_PREFIX + id);
}

/** On service worker startup — sync alarms with stored schedules */
chrome.storage.local.get(["schedules"], (res) => {
  const schedules = res.schedules || [];
  schedules.forEach((s) => {
    if (s.enabled) registerScheduleAlarm(s);
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  const id = alarm.name.slice(ALARM_PREFIX.length);
  chrome.storage.local.get(["schedules"], (res) => {
    const schedules = res.schedules || [];
    const s = schedules.find((x) => x.id === id);
    if (!s || !s.enabled) return;
    startPlayback(s.scenarioId);
    if (!s.repeat) {
      s.enabled = false;
      chrome.storage.local.set({ schedules });
      unregisterScheduleAlarm(id);
    }
  });
});

/* === MAIN MESSAGE HANDLER === */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { type } = request;

  // Screenshot messages are handled by their own listener in bg/screenshot.js
  if (["TAKE_SCREENSHOT", "TAKE_SCREENSHOT_FULL",
       "TAKE_SCREENSHOT_SCROLL_V", "TAKE_SCREENSHOT_SCROLL_H",
       "TAKE_SCREENSHOT_ELEMENT"].includes(type)) return;

  /* --- Forward recorded actions to popup --- */
  if (type === "RECORDED_ACTION") {
    if (state.recording && !state.pickMode) {
      const snapshot = [...state.currentActions];
      const act = request.action;
      if (act.delay == null) act.delay = 500;
      state.currentActions.push(act);
      pushUndo("current", snapshot);
    }
    chrome.runtime.sendMessage(request).catch(() => {});
    sendResponse({ received: true });
    return;
  }

  if (type === "CONTENT_READY") {
    const tabId = sender.tab?.id;
    chrome.storage.local.get(["playbackCheckpoint"], ({ playbackCheckpoint: cp }) => {
      if (cp && tabId === cp.tabId && Date.now() - cp.timestamp < 60_000) {
        // Tab reloaded mid-playback — offer resume to popup
        chrome.runtime.sendMessage({ type: "OFFER_RESUME", checkpoint: cp }).catch(() => {});
      }
    });
    sendResponse({ received: true });
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
    });
    return;
  }

  /* --- Recording --- */
  if (type === "START_RECORD") {
    const tabId = request.tabId || sender.tab?.id || null;
    const startRecording = (scenarioId) => {
      state.recording = true;
      state.recordingTabId = tabId;
      state.recordingScenarioId = scenarioId || null;
      state.currentActions = [];
      getStack("current").undo = [];
      getStack("current").redo = [];
      updateBadge();
      sendResponse({ started: true });
    };
    if (request.scenarioId) {
      startRecording(request.scenarioId);
    } else {
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

  if (type === "UPDATE_ACTION") {
    if (request.scenarioId) {
      mutateScenarioActions(request.scenarioId, (a) => {
        const next = [...a];
        next[request.index] = request.action;
        return next;
      }).then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: false }));
      return true;
    }
    pushUndo("current", [...state.currentActions]);
    state.currentActions[request.index] = request.action;
    sendResponse({ success: true });
    return;
  }

  if (type === "REMOVE_ACTION") {
    if (request.scenarioId) {
      mutateScenarioActions(request.scenarioId, (a) => a.filter((_, i) => i !== request.index))
        .then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: false }));
      return true;
    }
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
    if (request.scenarioId) {
      mutateScenarioActions(request.scenarioId, (a) => request.newOrder.map((i) => a[i]))
        .then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: false }));
      return true;
    }
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

  if (type === "IMPORT_SCENARIO") {
    getScenarios().then(async (scenarios) => {
      const id = generateId();
      scenarios[id] = { ...request.scenario, createdAt: Date.now() };
      await setScenarios(scenarios);
      sendResponse({ success: true, id });
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

  /* --- Backup / Restore All Data --- */
  if (type === "GET_ALL_DATA") {
    chrome.storage.local.get(null, (items) => {
      sendResponse({ data: items });
    });
    return true;
  }

  if (type === "RESTORE_ALL_DATA") {
    const data = request.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      sendResponse({ success: false, error: "Invalid backup format: expected an object" });
      return true;
    }
    const ALLOWED_KEYS = new Set([
      "scenarios", "folders", "variables", "schedules", "activatedTabs",
      "collapsibleStates", "popupTheme", "advancedMode", "lastSelectedScenario",
      "pendingRecordScenarioId", "condHelpLang", "screenshotExpanded",
      "watermarkEnabled", "watermarkFormat", "watermarkFontSize",
      "csvRunResults", "csvScreenshots", "csvSessionData",
    ]);
    const sanitized = {};
    for (const [k, v] of Object.entries(data)) {
      if (ALLOWED_KEYS.has(k)) sanitized[k] = v;
    }
    if (sanitized.scenarios && typeof sanitized.scenarios !== "object") {
      sendResponse({ success: false, error: "Invalid backup: scenarios must be an object" }); return true;
    }
    if (sanitized.folders && typeof sanitized.folders !== "object") {
      sendResponse({ success: false, error: "Invalid backup: folders must be an object" }); return true;
    }
    chrome.storage.local.clear(() => {
      chrome.storage.local.set(sanitized, () => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true });
        }
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
    startCsvPlayback(request.scenarioId, request.rows, request.delayBetween || 500, request.exportFormat || "csv");
    sendResponse({ started: true });
    return;
  }

  if (type === "STOP_CSV_PLAYBACK") {
    state.csvPlayback.active = false;
    state.playback.active = false;
    updateBadge();
    sendResponse({ stopped: true });
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
    chrome.storage.local.get(["csvRunResults"], (res) => {
      sendResponse({ results: res.csvRunResults || [] });
    });
    return true;
  }

  if (type === "GET_CSV_SCREENSHOTS") {
    chrome.storage.local.get(["csvScreenshots"], (res) => {
      sendResponse({ screenshots: res.csvScreenshots || {} });
    });
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
        // Re-register alarm with updated settings
        unregisterScheduleAlarm(request.schedule.id);
        registerScheduleAlarm(request.schedule);
        sendResponse({ success: true });
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

  /* --- Crop UI --- */
  if (type === "GET_PENDING_CROP") {
    sendResponse({ crop: state.pendingCrop });
    state.pendingCrop = null;
    return;
  }

  if (type === "SAVE_CROPPED") {
    downloadDataUrl(request.dataUrl, request.downloadPath, request.saveAs).then((id) => {
      sendResponse(id != null ? { success: true } : { error: "Download failed" });
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
    const _ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAbElEQVR42mNkYGBg+E8BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPhhFAABAAD//wMAA+gBkAAAAAAASUVORK5CYII=";
    chrome.storage.local.get(["elemShotPickPending", "elemShotPickCrop"], (flags) => {
      if (flags.elemShotPickPending && request.selector) {
        chrome.storage.local.remove(["elemShotPickPending", "elemShotPickCrop", "lastPickedSelector", "lastPickedSelectors"]);
        const crop = !!flags.elemShotPickCrop;
        const tabId = request.tabId || sender.tab?.id;
        if (tabId) {
          const rect = request.rect;
          if (!rect || !rect.width || !rect.height) {
            chrome.notifications.create("elemshot_err_" + Date.now(), { type: "basic", iconUrl: _ICON, title: "Chụp Element", message: "Không thể lấy vị trí element" }, () => { void chrome.runtime.lastError; });
            return;
          }
          chrome.storage.sync.get(["screenshotSaveMode", "screenshotPrefix"], (settings) => {
            const saveMode = settings.screenshotSaveMode || "auto";
            const prefix   = settings.screenshotPrefix   || "screenshot";
            takeFullPageScreenshot(tabId, saveMode, prefix, null, crop, 'full', false, false, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, 'elem')
              .then((result) => {
                chrome.runtime.sendMessage({ type: "SCREENSHOT_RESULT", result }).catch(() => {});
                const _notif = (msg) => chrome.notifications.create("elemshot_" + Date.now(), { type: "basic", iconUrl: _ICON, title: "Chụp Element", message: msg }, () => { void chrome.runtime.lastError; });
                if (result.error) _notif("Lỗi: " + result.error);
                else if (!crop)   _notif("Đã lưu: " + (result.filename || "screenshot"));
              })
              .catch((e) => chrome.notifications.create("elemshot_err_" + Date.now(), { type: "basic", iconUrl: _ICON, title: "Chụp Element", message: "Lỗi: " + e.message }, () => { void chrome.runtime.lastError; }));
          });
        }
      } else {
        chrome.action.openPopup().catch(() => {
          // openPopup() fails in MV3 when not triggered by user gesture.
          // Show a badge so the user knows to click the extension icon.
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
    state.segmentCapture = { active: true, tabId, dir: request.dir, crop: false };
    chrome.tabs.sendMessage(tabId, { type: "START_SEGMENT_TAB", dir: request.dir });
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
    state.segmentCapture = { active: true, tabId: request.tabId, dir: request.dir, crop: !!request.crop };
    chrome.tabs.sendMessage(request.tabId, { type: "START_SEGMENT_TAB", dir: request.dir });
    sendResponse({ ok: true });
    return;
  }

  /* --- Segment capture: stop & capture --- */
  if (type === "CAPTURE_SEGMENT") {
    const { tabId, dir, crop } = state.segmentCapture;
    state.segmentCapture = { active: false, tabId: null, dir: null, crop: false };
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
        });
    });
    sendResponse({ ok: true });
    return;
  }

  /* --- Segment capture: cancel --- */
  if (type === "CANCEL_SEGMENT_CAPTURE") {
    state.segmentCapture = { active: false, tabId: null, dir: null };
    sendResponse({ ok: true });
    return;
  }
});

console.log("[BACKGROUND] Service Worker loaded");
