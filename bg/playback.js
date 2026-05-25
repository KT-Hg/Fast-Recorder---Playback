/**
 * playback.js — Scenario playback engine (single, loop, sequence, CSV).
 * Exports: playActionsOnTab, startPlayback, startPlaybackFromCheckpoint,
 *          startSequence, startCsvPlayback
 */

import { state, persistCsvState, clearCsvState, saveCsvRows } from './state.js';
import { getScenarios, getVariables } from './storage.js';
import {
  updateBadge, sendCompletionNotification,
  resolveRandomVars, interpolateAction, runScriptViaCdp, openDropdownViaCdp,
  getActiveTabId, tabMsg, getTabUrl, waitForTabLoad,
} from './utils.js';
import {
  takeVisibleScreenshot, takeFullPageScreenshot, takeElementScreenshot,
} from './screenshot.js';
import { ssWrite, ssClear, csvResultWrite, csvResultClear } from './idb-screenshots.js';

/* ── Concurrency Guard ──────────────────────────────────────────────────────── */

function _isAnyPlaybackActive() {
  return state.playback.active || state.sequencePlayback.active || state.csvPlayback.active;
}

function _notifyAlreadyRunning() {
  chrome.runtime.sendMessage({ type: 'PLAYBACK_ALREADY_RUNNING' }).catch(() => {});
}

/* ── Module-level screenshot settings cache ─────────────────────────────────── */
// Reset at the start of each public playback function so stale settings are never used.
let _ssSettings = null;

async function _getSsSettings() {
  if (!_ssSettings) {
    _ssSettings = await new Promise(r => chrome.storage.sync.get(['screenshotSaveMode', 'screenshotPrefix'], r));
  }
  return _ssSettings;
}

/* ── Playback Core ──────────────────────────────────────────────────────────── */

/**
 * Execute an action list on a tab.
 *
 * @param {number}  tabId
 * @param {Array}   actions
 * @param {object}  vars              Resolved variable map (null → load from storage)
 * @param {object}  screenshotsResult Accumulator for base64 screenshots
 * @param {boolean} forceAutoSave     Override saveMode to "auto"
 * @param {boolean} skipDownload      Skip file download (CSV/export mode)
 * @param {number}  startFromIndex    Resume from this action index
 * @param {Array}   failedActions     Accumulator for failure records
 * @param {number}  _depth            Recursion depth counter (switch scenario guard)
 */
export async function playActionsOnTab(
  tabId, actions, vars = null, screenshotsResult = null,
  forceAutoSave = false, skipDownload = false, startFromIndex = 0,
  failedActions = null, _depth = 0,
) {
  if (_depth > 10) {
    console.error('[PLAYBACK] Max switch/nested-scenario depth (10) exceeded — aborting branch');
    chrome.runtime.sendMessage({
      type: 'ACTION_FAILED', index: startFromIndex, action: null,
      reason: 'Max nested scenario depth exceeded (possible infinite loop in switch)',
    }).catch(() => {});
    return vars || {};
  }

  const resolvedVars = resolveRandomVars(vars !== null ? vars : await getVariables());

  let _tabClosed = false;
  const _onTabRemoved = (removedTabId) => {
    if (removedTabId === tabId) { _tabClosed = true; state.playback.active = false; }
  };
  chrome.tabs.onRemoved.addListener(_onTabRemoved);

  try {
    for (let i = startFromIndex; i < actions.length; i++) {
      if (!state.playback.active || _tabClosed) break;

      state.playback.actionIndex = i;

      // Save checkpoint every 5 actions to allow resume after tab reload.
      if (state.playback.scenarioId && i % 5 === 0) {
        chrome.storage.local.set({
          playbackCheckpoint: {
            scenarioId: state.playback.scenarioId,
            actionIndex: i, tabId,
            timestamp: Date.now(),
          },
        });
      }

      try {
        const action = interpolateAction(actions[i], resolvedVars);
        if (action.disabled) continue;

        /* ── Navigate ── */
        if (action.type === 'navigate') {
          let navSuccess = true;
          const targetUrl = action.value || action.url;
          await new Promise((resolve) => {
            let resolved = false;
            const done = (success = true) => {
              if (resolved) return;
              resolved = true;
              navSuccess = success;
              chrome.tabs.onUpdated.removeListener(listener);
              chrome.tabs.onRemoved.removeListener(removedListener);
              clearInterval(spaPoller);
              clearTimeout(navTimeout);
              setTimeout(resolve, 500);
            };

            const listener = (updatedTabId, changeInfo) => {
              if (!state.playback.active) { done(false); return; }
              if (updatedTabId === tabId && changeInfo.status === 'complete') done(true);
            };
            const removedListener = (removedTabId) => { if (removedTabId === tabId) done(false); };
            chrome.tabs.onUpdated.addListener(listener);
            chrome.tabs.onRemoved.addListener(removedListener);

            try { chrome.tabs.update(tabId, { url: targetUrl }); }
            catch (e) { done(false); return; }

            // SPA fallback: poll URL every 200 ms. Using strict equality and startsWith(targetUrl)
            // only (not the reverse) to avoid false-positives when the current URL is a prefix
            // of the target URL (e.g. current = "/", target = "/checkout").
            const spaPoller = setInterval(async () => {
              if (resolved) { clearInterval(spaPoller); return; }
              try {
                const tab = await new Promise(r => chrome.tabs.get(tabId, r));
                if (tab?.url && targetUrl && (
                  tab.url === targetUrl ||
                  tab.url.startsWith(targetUrl)
                )) done(true);
              } catch (_) {}
            }, 200);

            const navTimeout = setTimeout(() => done(false), 30_000);
          });

          if (!navSuccess) {
            chrome.runtime.sendMessage({ type: 'ACTION_FAILED', index: i, action, reason: 'Navigation timed out or tab was closed' }).catch(() => {});
            if (failedActions) failedActions.push({ index: i + 1, type: action.type, label: action.label || '', reason: 'Navigation timed out' });
          }
          continue;
        }

        /* ── Wait ── */
        if (action.type === 'wait') {
          const ms = parseInt(action.value || action.delay || 500, 10);
          await new Promise((resolve) => setTimeout(resolve, isNaN(ms) ? 500 : ms));
          continue;
        }

        /* ── Dropdown — CDP trusted click ── */
        if (action.type === 'dropdown') {
          const cssSel = action.selectors?.css
            || (action.selectors?.id ? `#${CSS.escape(action.selectors.id)}` : null)
            || action.selector || '';
          if (cssSel) await openDropdownViaCdp(tabId, cssSel);
          if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
          continue;
        }

        /* ── Script — CDP execution ── */
        if (action.type === 'script') {
          await runScriptViaCdp(tabId, action.code || '');
          if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
          continue;
        }

        /* ── Element screenshot ── */
        if (action.type === 'screenshot_element') {
          const settings = await _getSsSettings();
          const saveMode = forceAutoSave ? 'auto' : (settings.screenshotSaveMode || 'auto');
          const prefix   = settings.screenshotPrefix || 'screenshot';
          const result   = await takeElementScreenshot(tabId, action.selector, saveMode, prefix, false, false, skipDownload, action.selectors)
            .catch(e => ({ error: e.message }));
          if (result?.error) {
            chrome.runtime.sendMessage({ type: 'ACTION_FAILED', index: i, action }).catch(() => {});
            if (failedActions) failedActions.push({ index: i + 1, type: action.type, label: action.label || '' });
          }
          continue;
        }

        /* ── Screenshot → Variable ── */
        if (action.type === 'screenshot_tovar') {
          const settings = await _getSsSettings();
          try {
            const saveMode = forceAutoSave ? 'auto' : (settings.screenshotSaveMode || 'auto');
            const prefix   = settings.screenshotPrefix || 'screenshot';
            let res;
            if (action.target === 'element' && action.selector) {
              res = await takeElementScreenshot(tabId, action.selector, saveMode, prefix, false, true, skipDownload);
            } else if (action.target === 'full') {
              res = await takeFullPageScreenshot(tabId, saveMode, prefix, null, false, 'full', true, skipDownload);
            } else {
              res = await takeVisibleScreenshot(tabId, saveMode, prefix, null, false, true, skipDownload);
            }
            if (res?.error) throw new Error(res.error);
            if (res && action.varName) {
              resolvedVars[action.varName] = res.filename || '';
              if (screenshotsResult && res.base64) screenshotsResult[action.varName] = res.base64;
            }
          } catch (e) {
            console.error('[PLAYBACK] screenshot_tovar failed:', e);
            chrome.runtime.sendMessage({ type: 'ACTION_FAILED', index: i, action, reason: e.message }).catch(() => {});
            if (failedActions) failedActions.push({ index: i + 1, type: action.type, label: action.label || '', reason: e.message });
          }
          continue;
        }

        /* ── Screenshot (visible / full) ── */
        if (action.type === 'screenshot' || action.type === 'screenshot_full') {
          const settings = await _getSsSettings();
          const saveMode = forceAutoSave ? 'auto' : (settings.screenshotSaveMode || 'auto');
          const prefix   = settings.screenshotPrefix || 'screenshot';
          const task     = action.type === 'screenshot_full'
            ? takeFullPageScreenshot(tabId, saveMode, prefix, action.value || null, false, 'full', false, skipDownload)
            : takeVisibleScreenshot(tabId, saveMode, prefix, action.value || null, false, false, skipDownload);
          const result = await task.catch(e => ({ error: e.message }));
          if (result?.error) {
            chrome.runtime.sendMessage({ type: 'ACTION_FAILED', index: i, action }).catch(() => {});
            if (failedActions) failedActions.push({ index: i + 1, type: action.type, label: action.label || '' });
          }
          continue;
        }

        /* ── Read DOM value → variable ── */
        if (action.type === 'readdom') {
          const rdResult = await tabMsg(tabId, { type: 'PLAY_ACTION', action }, 10_000, action.frameId);
          if (rdResult?.value !== undefined && action.varName) {
            resolvedVars[action.varName] = rdResult.value;
          } else if (rdResult?.failed) {
            chrome.runtime.sendMessage({ type: 'ACTION_FAILED', index: i, action }).catch(() => {});
            if (failedActions) failedActions.push({ index: i + 1, type: action.type, label: action.label || '' });
          }
          if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
          continue;
        }

        /* ── Condition (if) ── */
        if (action.type === 'condition') {
          const condResult = await tabMsg(tabId, {
            type: 'CHECK_CONDITION',
            conditionType: action.conditionType || 'elementExists',
            selector: action.selector || '',
            selectors: action.selectors || null,
            expectedValue: action.expectedValue || '',
          }, 10_000, action.frameId);
          const passed = !!condResult?.result;
          if (!passed) {
            const rawSkip = parseInt(action.skipCount || action.conditionSkipCount || 1, 10);
            const skip    = Math.max(1, isNaN(rawSkip) ? 1 : rawSkip);
            if (rawSkip === 0) console.warn('[PLAYBACK] Condition skipCount=0 would cause infinite loop; treating as 1');
            i += skip;
          }
          if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
          continue;
        }

        /* ── Switch ── */
        if (action.type === 'switch') {
          const switchVal = action.switchVar || '';
          const cases     = action.cases || [];
          let matched     = cases.find(c => c.value === switchVal);
          if (!matched) matched = cases.find(c => c.value === '__default__');
          if (matched?.scenarioId) {
            const scenarios    = await getScenarios();
            const targetScenario = scenarios[matched.scenarioId];
            if (targetScenario?.actions?.length) {
              const caseLabel    = matched.value === '__default__' ? 'default' : matched.value;
              const switchedName = targetScenario.name || matched.scenarioId;
              state.playback.scenarioName  = switchedName;
              state.playback.actionIndex   = 0;
              state.playback.totalActions  = targetScenario.actions.length;
              chrome.runtime.sendMessage({ type: 'SWITCH_SCENARIO', scenarioName: switchedName, caseLabel }).catch(() => {});
              const nestedVars = await playActionsOnTab(
                tabId, targetScenario.actions, { ...resolvedVars },
                screenshotsResult, forceAutoSave, skipDownload, 0, null, _depth + 1,
              );
              Object.assign(resolvedVars, nestedVars);
            } else {
              chrome.runtime.sendMessage({
                type: 'ACTION_FAILED', index: i, action,
                reason: `Switch: scenario "${matched.scenarioName || matched.scenarioId}" not found or has no actions`,
              }).catch(() => {});
            }
          } else {
            chrome.runtime.sendMessage({
              type: 'ACTION_FAILED', index: i, action,
              reason: `Switch: no case matched value "${switchVal}" and no default case set`,
            }).catch(() => {});
          }
          if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
          continue;
        }

        /* ── All other actions → content script ── */
        const _isClickLike  = action.type === 'click' || action.type === 'select';
        const preActionUrl  = _isClickLike ? await getTabUrl(tabId).catch(() => null) : null;

        const result = await tabMsg(tabId, { type: 'PLAY_ACTION', action }, 10_000, action.frameId);

        // If a click/select caused an immediate navigation, the content script may have
        // become unreachable before it could respond.  Check for URL change and, if it
        // happened, treat the click as successful rather than failed.
        if (_isClickLike && result?._noContentScript && preActionUrl !== null) {
          const postClickUrl = await getTabUrl(tabId).catch(() => null);
          if (postClickUrl !== null && postClickUrl !== preActionUrl) {
            await waitForTabLoad(tabId, 15_000);
            if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
            continue;
          }
        }

        if (result?.failed) {
          const reason = result._noContentScript ? 'Content script not reachable' : (result.error || 'Action failed');
          chrome.runtime.sendMessage({ type: 'ACTION_FAILED', index: i, action, reason }).catch(() => {});
          if (failedActions) failedActions.push({ index: i + 1, type: action.type, label: action.label || '', reason });
        }

        // For non-failed click/select, check if the action triggered a navigation.
        if (preActionUrl !== null && !result?.failed) {
          const postActionUrl = await getTabUrl(tabId).catch(() => null);
          if (postActionUrl !== null && postActionUrl !== preActionUrl) {
            await waitForTabLoad(tabId, 15_000);
          }
        }

        if (action.delay && action.delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, action.delay));
        }
      } catch (err) {
        console.error(`[PLAYBACK] Action ${i} failed:`, err);
        chrome.runtime.sendMessage({ type: 'ACTION_FAILED', index: i, action: actions[i] }).catch(() => {});
        if (failedActions) failedActions.push({ index: i + 1, type: actions[i]?.type || 'unknown', label: actions[i]?.label || '' });
      }
    }
  } finally {
    chrome.tabs.onRemoved.removeListener(_onTabRemoved);
    if (_tabClosed) {
      chrome.runtime.sendMessage({ type: 'PLAYBACK_TAB_CLOSED', tabId }).catch(() => {});
    }
  }
  return resolvedVars;
}

/* ── Single Scenario Playback ───────────────────────────────────────────────── */

export async function startPlaybackFromCheckpoint(scenarioId, fromIndex, tabId) {
  const scenarios = await getScenarios();
  const scenario  = scenarios[scenarioId];
  if (!scenario) return;
  const actions = scenario.actions || [];
  state.playback = {
    active: true, tabId, scenarioId, scenarioName: scenario.name || scenarioId,
    originalScenarioName: scenario.name || scenarioId,
    actionIndex: fromIndex, totalActions: actions.length, loopCurrent: 1, loopTotal: 1,
  };
  updateBadge();
  try {
    await playActionsOnTab(tabId, actions, null, null, false, false, fromIndex);
  } finally {
    state.playback.active = false;
    updateBadge();
    chrome.storage.local.remove('playbackCheckpoint');
    sendCompletionNotification('Playback complete', `"${scenario.name}" resumed & finished`);
  }
}

export async function startPlayback(scenarioId, loopCount = 1, loopDelay = 0) {
  if (_isAnyPlaybackActive()) { _notifyAlreadyRunning(); return; }
  _ssSettings = null; // reset screenshot settings cache for this run

  const scenarios = await getScenarios();
  const scenario  = scenarios[scenarioId];
  if (!scenario) return;

  const tabId = await getActiveTabId();
  if (!tabId) {
    chrome.runtime.sendMessage({ type: 'PLAYBACK_NO_TAB' }).catch(() => {});
    return;
  }

  const actions = scenario.actions || [];
  const loops   = Math.max(1, Math.floor(loopCount));
  state.playback = {
    active: true, tabId, scenarioId, scenarioName: scenario.name || scenarioId,
    originalScenarioName: scenario.name || scenarioId,
    actionIndex: 0, totalActions: actions.length, loopCurrent: 1, loopTotal: loops,
  };
  updateBadge();

  try {
    let loopVars = null;
    for (let loop = 0; loop < loops; loop++) {
      if (!state.playback.active) break;
      state.playback.loopCurrent = loop + 1;
      state.playback.actionIndex = 0;
      loopVars = await playActionsOnTab(tabId, actions, loopVars);
      if (loop < loops - 1 && loopDelay > 0) await new Promise(r => setTimeout(r, loopDelay));
    }
  } finally {
    state.playback.active = false;
    updateBadge();
    chrome.storage.local.remove('playbackCheckpoint');
    sendCompletionNotification('Playback complete', `"${scenario.name}" finished${loops > 1 ? ` (${loops} loops)` : ''}`);
  }
}

/* ── Sequence Playback ──────────────────────────────────────────────────────── */

export async function startSequence(runList) {
  if (_isAnyPlaybackActive()) { _notifyAlreadyRunning(); return; }
  _ssSettings = null;

  state.sequencePlayback = { active: true, runList, currentIndex: 0 };
  updateBadge();
  const tabId = await getActiveTabId();
  if (!tabId) {
    state.sequencePlayback.active = false;
    updateBadge();
    chrome.runtime.sendMessage({ type: 'PLAYBACK_NO_TAB' }).catch(() => {});
    return;
  }

  const scenarios = await getScenarios();

  let _seqTabClosed = false;
  const _onSeqTabRemoved = (removedId) => {
    if (removedId === tabId) { _seqTabClosed = true; state.sequencePlayback.active = false; }
  };
  chrome.tabs.onRemoved.addListener(_onSeqTabRemoved);

  try {
    for (let i = 0; i < runList.length; i++) {
      if (!state.sequencePlayback.active || _seqTabClosed) break;
      state.sequencePlayback.currentIndex = i;

      const item     = runList[i];
      if (item.disabled) continue;
      const scenario = scenarios[item.id];
      if (!scenario) continue;

      const actions = scenario.actions || [];
      state.playback = {
        active: true, tabId, scenarioId: item.id,
        scenarioName: scenario.name || item.id,
        originalScenarioName: scenario.name || item.id,
        actionIndex: 0, totalActions: actions.length,
      };
      await playActionsOnTab(tabId, actions);
      state.playback.active = false;

      if (i < runList.length - 1 && item.delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, item.delay));
      }
    }
    if (_seqTabClosed) {
      chrome.runtime.sendMessage({ type: 'PLAYBACK_TAB_CLOSED', tabId }).catch(() => {});
    } else {
      sendCompletionNotification('Sequence complete', `${runList.length} scenario(s) finished`);
    }
  } catch (err) {
    console.error('[SEQUENCE] Error during sequence playback:', err);
  } finally {
    chrome.tabs.onRemoved.removeListener(_onSeqTabRemoved);
    state.sequencePlayback.active = false;
    state.playback.active = false;
    updateBadge();
  }
}

/* ── CSV Playback ───────────────────────────────────────────────────────────── */

/** Collect variable keys actually referenced or produced by a scenario's actions. */
function collectRelevantKeys(actions) {
  const keys    = new Set();
  const VAR_RE  = /\$\{([^}]+)\}/g;
  const FIELDS  = ['selector', 'value', 'url', 'code', 'expectedValue', 'switchVar'];
  const C_FIELDS = ['valueEquals', 'textContains'];
  for (const a of actions) {
    for (const f of FIELDS) {
      if (typeof a[f] === 'string') {
        let m; VAR_RE.lastIndex = 0;
        while ((m = VAR_RE.exec(a[f])) !== null) keys.add(m[1]);
      }
    }
    if (a.conditions && typeof a.conditions === 'object') {
      for (const f of C_FIELDS) {
        if (typeof a.conditions[f] === 'string') {
          let m; VAR_RE.lastIndex = 0;
          while ((m = VAR_RE.exec(a.conditions[f])) !== null) keys.add(m[1]);
        }
      }
    }
    if ((a.type === 'readdom' || a.type === 'screenshot_tovar') && a.varName) keys.add(a.varName);
  }
  return keys;
}

/**
 * CSV playback entry point.
 *
 * Results are written to IndexedDB one row at a time via csvResultWrite — O(1) per row.
 * This replaces the previous approach of accumulating all results in a JS array and
 * re-writing the entire array to chrome.storage.local every batch (was O(n²) in total
 * bytes written).
 *
 * @param {number} startRowIndex  Resume from this row (for interrupted run resume).
 */
export async function startCsvPlayback(scenarioId, rows, delayBetween, exportFormat = 'csv', startRowIndex = 0) {
  if (_isAnyPlaybackActive()) { _notifyAlreadyRunning(); return; }
  _ssSettings = null;

  const skipDownload = exportFormat === 'xlsx' || exportFormat === 'html' || exportFormat === 'zip';
  state.csvPlayback = { active: true, rows, currentRow: startRowIndex, scenarioId, delayBetween };
  state.csvInterrupted = null; // clear any previous interrupt once a new run starts
  updateBadge();

  await saveCsvRows(rows);
  await persistCsvState(scenarioId, startRowIndex, delayBetween, exportFormat);

  const [scenarios, baseVars] = await Promise.all([getScenarios(), getVariables()]);
  const scenario = scenarios[scenarioId];
  if (!scenario) {
    state.csvPlayback.active = false;
    await clearCsvState();
    updateBadge();
    return;
  }

  const tabId = await getActiveTabId();
  if (!tabId) {
    state.csvPlayback.active = false;
    await clearCsvState();
    updateBadge();
    chrome.runtime.sendMessage({ type: 'PLAYBACK_NO_TAB' }).catch(() => {});
    return;
  }

  const actions       = scenario.actions || [];
  const relevantKeys  = collectRelevantKeys(actions);

  // Clear previous run's results and screenshots before starting a new run.
  await Promise.all([
    new Promise(r => chrome.storage.local.remove('csvRunResults', r)),
    ssClear(),
    csvResultClear(),
  ]);

  let completedRows = 0;
  let failedRows    = 0;

  for (let i = startRowIndex; i < rows.length; i++) {
    if (!state.csvPlayback.active) break;
    state.csvPlayback.currentRow = i;

    await persistCsvState(scenarioId, i, delayBetween, exportFormat);

    const rowVars = { ...baseVars, ...rows[i] };
    state.playback = {
      active: true, tabId, scenarioId,
      scenarioName: scenario.name || scenarioId,
      originalScenarioName: scenario.name || scenarioId,
      actionIndex: 0, totalActions: actions.length,
    };
    const screenshotsResult = {};
    const failedActions     = [];
    const finalVars = await playActionsOnTab(
      tabId, actions, rowVars, screenshotsResult, true, skipDownload, 0, failedActions,
    );
    state.playback.active = false;

    completedRows++;
    if (failedActions.length > 0) failedRows++;

    const filteredVars = Object.fromEntries(
      Object.entries(finalVars).filter(([k]) => relevantKeys.has(k)),
    );

    // Write result directly to IDB — no in-memory accumulation.
    await csvResultWrite(i, { rowIndex: i, vars: filteredVars, failures: failedActions });

    for (const [vn, b64] of Object.entries(screenshotsResult)) {
      await ssWrite(i, vn, b64);
    }

    const isLast = i === rows.length - 1;
    chrome.runtime.sendMessage({
      type: 'CSV_ROW_DONE', rowIndex: i, total: rows.length,
      failRows: failedRows, isLast, delayBetween,
    }).catch(() => {});

    if (!isLast && delayBetween > 0) {
      await new Promise((r) => setTimeout(r, delayBetween));
    }
  }

  state.csvPlayback.active = false;
  await clearCsvState();
  updateBadge();

  sendCompletionNotification('CSV Run complete', `${completedRows} / ${rows.length} rows for "${scenario.name}"`);
  chrome.runtime.sendMessage({
    type: 'CSV_RUN_DONE',
    total: completedRows,
    failRows: failedRows,
    scenarioName: scenario.name || scenarioId,
  }).catch(() => {});
}
