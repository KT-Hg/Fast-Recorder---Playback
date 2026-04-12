/**
 * playback.js — Scenario playback engine (single, loop, sequence, CSV)
 * Exports: playActionsOnTab, startPlayback, startSequence, startCsvPlayback
 */

import { state } from './state.js';
import { getScenarios, getVariables } from './storage.js';
import {
  updateBadge, sendCompletionNotification,
  interpolateAction, runScriptViaCdp, getActiveTabId, tabMsg,
} from './utils.js';
import {
  takeVisibleScreenshot, takeFullPageScreenshot, takeElementScreenshot,
} from './screenshot.js';

/* === PLAYBACK CORE === */

export async function playActionsOnTab(tabId, actions, vars = null, screenshotsResult = null, forceAutoSave = false, skipDownload = false, startFromIndex = 0) {
  const resolvedVars = vars !== null ? vars : await getVariables();

  for (let i = startFromIndex; i < actions.length; i++) {
    if (!state.playback.active) break;

    state.playback.actionIndex = i;

    // Save checkpoint after each action so we can resume if the tab crashes/reloads
    if (state.playback.scenarioId) {
      chrome.storage.local.set({
        playbackCheckpoint: {
          scenarioId: state.playback.scenarioId,
          actionIndex: i,
          tabId,
          timestamp: Date.now(),
        },
      });
    }
    try {
      const action = interpolateAction(actions[i], resolvedVars);

      if (action.disabled) continue;

      // Navigate
      if (action.type === "navigate") {
        await new Promise((resolve) => {
          let resolved = false;
          const done = () => { if (resolved) return; resolved = true; chrome.tabs.onUpdated.removeListener(listener); setTimeout(resolve, 500); };
          const listener = (updatedTabId, changeInfo) => {
            if (updatedTabId === tabId && changeInfo.status === "complete") done();
          };
          chrome.tabs.onUpdated.addListener(listener);
          chrome.tabs.update(tabId, { url: action.value || action.url });
          setTimeout(done, 30000);
        });
        continue;
      }

      // Wait
      if (action.type === "wait") {
        const ms = parseInt(action.value || action.delay || 500, 10);
        await new Promise((resolve) => setTimeout(resolve, isNaN(ms) ? 500 : ms));
        continue;
      }

      // Script (run via CDP to bypass page CSP)
      if (action.type === "script") {
        await runScriptViaCdp(tabId, action.code || "");
        if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
        continue;
      }

      // Element screenshot
      if (action.type === "screenshot_element") {
        await new Promise((resolve) => {
          chrome.storage.sync.get(["screenshotSaveMode", "screenshotPrefix"], (settings) => {
            const saveMode = forceAutoSave ? "auto" : (settings.screenshotSaveMode || "auto");
            const prefix = settings.screenshotPrefix || "screenshot";
            takeElementScreenshot(tabId, action.selector, saveMode, prefix, false, false, skipDownload)
              .then(resolve).catch(resolve);
          });
        });
        continue;
      }

      // Screenshot → Variable
      if (action.type === "screenshot_tovar") {
        await new Promise((resolve) => {
          chrome.storage.sync.get(["screenshotSaveMode", "screenshotPrefix"], async (settings) => {
            try {
              const saveMode = forceAutoSave ? "auto" : (settings.screenshotSaveMode || "auto");
              const prefix   = settings.screenshotPrefix || "screenshot";
              let res;
              if (action.target === "element" && action.selector) {
                res = await takeElementScreenshot(tabId, action.selector, saveMode, prefix, false, true, skipDownload);
              } else if (action.target === "full") {
                res = await takeFullPageScreenshot(tabId, saveMode, prefix, null, false, 'full', true, skipDownload);
              } else {
                res = await takeVisibleScreenshot(tabId, saveMode, prefix, null, false, true, skipDownload);
              }
              if (res && action.varName) {
                resolvedVars[action.varName] = res.filename || "";
                if (screenshotsResult && res.base64) {
                  screenshotsResult[action.varName] = res.base64;
                }
              }
            } catch (_) {}
            resolve();
          });
        });
        continue;
      }

      // Screenshot (visible or full page)
      if (action.type === "screenshot" || action.type === "screenshot_full") {
        await new Promise((resolve) => {
          chrome.storage.sync.get(["screenshotSaveMode", "screenshotPrefix"], (settings) => {
            const saveMode = forceAutoSave ? "auto" : (settings.screenshotSaveMode || "auto");
            const prefix = settings.screenshotPrefix || "screenshot";
            const task = action.type === "screenshot_full"
              ? takeFullPageScreenshot(tabId, saveMode, prefix, action.value || null, false, 'full', false, skipDownload)
              : takeVisibleScreenshot(tabId, saveMode, prefix, action.value || null, false, false, skipDownload);
            task.then(resolve).catch(resolve);
          });
        });
        continue;
      }

      // Read DOM value → store in resolvedVars
      if (action.type === "readdom") {
        const rdResult = await tabMsg(tabId, { type: "PLAY_ACTION", action });
        if (rdResult?.value !== undefined && action.varName) {
          resolvedVars[action.varName] = rdResult.value;
        } else if (rdResult?.failed) {
          chrome.runtime.sendMessage({ type: "ACTION_FAILED", index: i, action }).catch(() => {});
        }
        if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
        continue;
      }

      // Condition (if) — skip N actions if false
      if (action.type === "condition") {
        const condResult = await tabMsg(tabId, {
          type: "CHECK_CONDITION",
          conditionType: action.conditionType || "elementExists",
          selector: action.selector || "",
          expectedValue: action.expectedValue || "",
        });
        const passed = !!condResult?.result;
        if (!passed) {
          const skip = parseInt(action.skipCount || action.conditionSkipCount || 1, 10);
          i += skip;
        }
        if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
        continue;
      }

      // Switch — resolve variable, find matching case, run its scenario
      if (action.type === "switch") {
        const switchVal = action.switchVar || "";
        const cases = action.cases || [];
        let matched = cases.find(c => c.value === switchVal);
        if (!matched) matched = cases.find(c => c.value === "__default__");
        if (matched?.scenarioId) {
          const scenarios = await getScenarios();
          const targetScenario = scenarios[matched.scenarioId];
          if (targetScenario?.actions?.length) {
            await playActionsOnTab(tabId, targetScenario.actions, { ...resolvedVars }, screenshotsResult, forceAutoSave, skipDownload);
          }
        }
        if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
        continue;
      }

      // All other actions — send to content script
      const result = await tabMsg(tabId, { type: "PLAY_ACTION", action });

      if (result?.failed) {
        chrome.runtime.sendMessage({ type: "ACTION_FAILED", index: i, action }).catch(() => {});
      }

      if (action.delay && action.delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, action.delay));
      }
    } catch (err) {
      console.error(`[PLAYBACK] Action ${i} failed:`, err);
      chrome.runtime.sendMessage({ type: "ACTION_FAILED", index: i, action: actions[i] }).catch(() => {});
    }
  }
  return resolvedVars;
}

/* === SINGLE SCENARIO PLAYBACK === */

export async function startPlaybackFromCheckpoint(scenarioId, fromIndex, tabId) {
  const scenarios = await getScenarios();
  const scenario = scenarios[scenarioId];
  if (!scenario) return;
  const actions = scenario.actions || [];
  state.playback = { active: true, tabId, scenarioId, actionIndex: fromIndex, totalActions: actions.length, loopCurrent: 1, loopTotal: 1 };
  updateBadge();
  try {
    await playActionsOnTab(tabId, actions, null, null, false, false, fromIndex);
  } finally {
    state.playback.active = false;
    updateBadge();
    chrome.storage.local.remove("playbackCheckpoint");
    sendCompletionNotification("Playback complete", `"${scenario.name}" resumed & finished`);
  }
}

export async function startPlayback(scenarioId, loopCount = 1, loopDelay = 0) {
  const scenarios = await getScenarios();
  const scenario = scenarios[scenarioId];
  if (!scenario) return;

  const tabId = await getActiveTabId();
  if (!tabId) return;

  const actions = scenario.actions || [];
  const loops = Math.max(1, Math.floor(loopCount));
  state.playback = { active: true, tabId, scenarioId, actionIndex: 0, totalActions: actions.length, loopCurrent: 1, loopTotal: loops };
  updateBadge();

  try {
    for (let loop = 0; loop < loops; loop++) {
      if (!state.playback.active) break;
      state.playback.loopCurrent = loop + 1;
      state.playback.actionIndex = 0;
      await playActionsOnTab(tabId, actions);
      if (loop < loops - 1 && loopDelay > 0) {
        await new Promise(r => setTimeout(r, loopDelay));
      }
    }
  } finally {
    state.playback.active = false;
    updateBadge();
    chrome.storage.local.remove("playbackCheckpoint");
    const loopMsg = loops > 1 ? ` (${loops} loops)` : "";
    sendCompletionNotification("Playback complete", `"${scenario.name}" finished${loopMsg}`);
  }
}

/* === SEQUENCE PLAYBACK === */

export async function startSequence(runList) {
  state.sequencePlayback = { active: true, runList, currentIndex: 0 };
  updateBadge();
  const tabId = await getActiveTabId();
  if (!tabId) { state.sequencePlayback.active = false; updateBadge(); return; }

  const scenarios = await getScenarios();

  try {
    for (let i = 0; i < runList.length; i++) {
      if (!state.sequencePlayback.active) break;
      state.sequencePlayback.currentIndex = i;

      const item = runList[i];
      if (item.disabled) continue;
      const scenario = scenarios[item.id];
      if (!scenario) continue;

      const actions = scenario.actions || [];
      state.playback = { active: true, tabId, scenarioId: item.id, actionIndex: 0, totalActions: actions.length };
      await playActionsOnTab(tabId, actions);
      state.playback.active = false;

      if (i < runList.length - 1 && item.delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, item.delay));
      }
    }
    sendCompletionNotification("Sequence complete", `${runList.length} scenario(s) finished`);
  } catch (err) {
    console.error("[SEQUENCE] Error during sequence playback:", err);
  } finally {
    state.sequencePlayback.active = false;
    state.playback.active = false;
    updateBadge();
  }
}

/* === CSV PLAYBACK === */

export async function startCsvPlayback(scenarioId, rows, delayBetween, exportFormat = "csv") {
  const skipDownload = exportFormat === "xlsx" || exportFormat === "html";
  state.csvPlayback = { active: true, rows, currentRow: 0, scenarioId, delayBetween };
  updateBadge();

  const [scenarios, baseVars] = await Promise.all([getScenarios(), getVariables()]);
  const scenario = scenarios[scenarioId];
  if (!scenario) { state.csvPlayback.active = false; updateBadge(); return; }

  const tabId = await getActiveTabId();
  if (!tabId) { state.csvPlayback.active = false; updateBadge(); return; }

  const actions = scenario.actions || [];
  const runResults = [];

  await new Promise(r => chrome.storage.local.remove(["csvRunResults", "csvScreenshots"], r));
  let allScreenshots = {};

  for (let i = 0; i < rows.length; i++) {
    if (!state.csvPlayback.active) break;
    state.csvPlayback.currentRow = i;
    const rowVars = { ...baseVars, ...rows[i] };
    state.playback = { active: true, tabId, scenarioId, actionIndex: 0, totalActions: actions.length };
    const screenshotsResult = {};
    const finalVars = await playActionsOnTab(tabId, actions, rowVars, screenshotsResult, true, skipDownload);
    state.playback.active = false;

    runResults.push({ rowIndex: i, vars: { ...finalVars } });

    if (Object.keys(screenshotsResult).length > 0) {
      Object.entries(screenshotsResult).forEach(([vn, b64]) => {
        allScreenshots[`${i}:${vn}`] = b64;
      });
      await new Promise(r => chrome.storage.local.set({ csvScreenshots: allScreenshots }, r));
    }

    await new Promise(r => chrome.storage.local.set({ csvRunResults: runResults }, r));
    chrome.runtime.sendMessage({ type: "CSV_ROW_DONE", rowIndex: i, total: rows.length }).catch(() => {});

    if (i < rows.length - 1 && delayBetween > 0) {
      await new Promise((r) => setTimeout(r, delayBetween));
    }
  }

  state.csvPlayback.active = false;
  updateBadge();
  sendCompletionNotification("CSV Run complete", `${runResults.length} / ${rows.length} rows for "${scenario.name}"`);
  chrome.runtime.sendMessage({ type: "CSV_RUN_DONE", total: runResults.length }).catch(() => {});
}
