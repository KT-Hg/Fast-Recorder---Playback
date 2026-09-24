import { state, persistCsvState, clearCsvState } from './state.js';
import { getScenarios, getVariables } from './storage.js';
import {
  updateBadge, sendCompletionNotification, sendAlertNotification,
  resolveRandomVars, interpolateAction, runScriptViaCdp, openDropdownViaCdp,
  getActiveTabId, tabMsg, getTabUrl, waitForTabLoad, setFileInputViaCdp, setFileDropZoneViaCdp,
} from './utils.js';
import {
  takeVisibleScreenshot, takeFullPageScreenshot, takeElementScreenshot,
} from './screenshot.js';
import { ssWrite, ssClear, csvResultWrite, csvResultClear } from './idb-screenshots.js';
import { beginDbGuard, endDbGuard } from './dbguard.js';

/* ── SW keep-alive ──────────────────────────────────────────────────────────── */

// Chrome MV3 terminates idle Service Workers after ~30 s. A playback that sits in
// a long wait() action makes no extension API calls, so nothing resets that timer
// and the run would be killed mid-flight.
//
// Two mechanisms, because neither is sufficient alone:
//
//   - The alarm survives a worker that has already been torn down, and is what
//     brings it back. It asks for 20 s but Chrome clamps alarms to a 30 s floor,
//     landing exactly on the idle deadline — too close to rely on by itself.
//   - The interval below makes a cheap API call every 20 s. Each one resets the
//     idle timer from inside, so the worker never reaches the deadline in the
//     first place. It dies with the worker, which is why the alarm is still needed.

const KEEPALIVE_ALARM = 'playback-keepalive';
const KEEPALIVE_MS    = 20_000;

let _keepaliveTimer = null;

function _startKeepalive() {
  chrome.alarms.create(KEEPALIVE_ALARM, { when: Date.now() + KEEPALIVE_MS });
  if (_keepaliveTimer) clearInterval(_keepaliveTimer);
  _keepaliveTimer = setInterval(() => {
    // Any extension API call resets the idle countdown; this is among the cheapest.
    chrome.runtime.getPlatformInfo(() => { void chrome.runtime.lastError; });
  }, KEEPALIVE_MS);
}

function _stopKeepalive() {
  chrome.alarms.clear(KEEPALIVE_ALARM);
  if (_keepaliveTimer) { clearInterval(_keepaliveTimer); _keepaliveTimer = null; }
}

/* ── Concurrency Guard ──────────────────────────────────────────────────────── */

function _isAnyPlaybackActive() {
  return state.playback.active || state.sequencePlayback.active || state.csvPlayback.active;
}

function _notifyAlreadyRunning() {
  chrome.runtime.sendMessage({ type: 'PLAYBACK_ALREADY_RUNNING' }).catch(() => {});
  sendAlertNotification('⚠ Already Running', 'Playback is already running — stop it first', 'already_running');
}

/* ── Recording ⇄ Playback mutual exclusion ──────────────────────────────────────
 * Recording and playback drive the same tab, and the recorder cannot tell a
 * synthesized event from a human one. Whichever mode started first wins; the
 * second request is refused rather than queued, because the two cannot be
 * interleaved without corrupting the scenario being recorded.
 *
 * Both refusals notify as well as return, because most callers cannot surface a
 * rejection themselves: the popup closes its own window right after dispatching,
 * the hotkey path in content.js sends without a callback, and scheduled playback
 * fires from an alarm with no response channel at all.
 * ────────────────────────────────────────────────────────────────────────────── */

/**
 * Refuse to start playback while a recording is in progress. Called from every
 * playback entry point, not just the message router, so the scheduled-alarm path
 * is covered too.
 *
 * @returns {boolean} true if the request was refused — the caller must return.
 */
export function refuseIfRecording() {
  if (!state.recording) return false;
  chrome.runtime.sendMessage({ type: 'PLAYBACK_BLOCKED_RECORDING' }).catch(() => {});
  sendAlertNotification(
    '⚠ Recording Active',
    'Cannot start playback while recording — stop recording first',
    'blocked_recording',
  );
  return true;
}

/**
 * Refuse to start recording while any playback is running — the mirror of
 * refuseIfRecording(). Lives in this module because it owns the playback-active
 * state; the START_RECORD handler calls it.
 *
 * @returns {boolean} true if the request was refused — the caller must return.
 */
export function refuseRecordingIfPlaying() {
  if (!_isAnyPlaybackActive()) return false;
  chrome.runtime.sendMessage({ type: 'RECORD_BLOCKED_PLAYBACK' }).catch(() => {});
  sendAlertNotification(
    '⚠ Playback Active',
    'Cannot start recording while playback is running — stop it first',
    'blocked_playback',
  );
  return true;
}

/** " — n action(s) failed", or nothing at all for a clean run. */
function _failSuffix(failedActions) {
  const n = failedActions?.length || 0;
  return n ? ` — ${n} action${n === 1 ? '' : 's'} failed` : '';
}

function _notifyActionFailed(index, action, reason, { toPopup = true } = {}) {
  const r = reason || 'element not found';
  if (toPopup) chrome.runtime.sendMessage({ type: 'ACTION_FAILED', index, action, reason: r }).catch(() => {});
  if (!state.csvPlayback.active) {
    const label = action?.label || action?.type || '';
    // Stable id: playback continues past a failed action, so without one a run
    // with many failures buries the notification centre under a separate entry
    // per action. Re-using the id keeps a single, always-current "latest failure".
    sendAlertNotification(
      `⚠ Action ${index + 1} Failed`,
      label ? `${label}: ${r}` : r,
      'action_failed',
    );
  }
}

/* ── Failed-action prompt ───────────────────────────────────────────────────────
 * A failed action pauses the run and asks, in a popup on the page being played,
 * whether to run it again, skip it or stop. The content script holds the message
 * open until a button is clicked, so the answer comes back as its response.
 * ────────────────────────────────────────────────────────────────────────────── */

const FAIL_RETRY = 'retry';
const FAIL_SKIP  = 'skip';
const FAIL_STOP  = 'stop';

/** One attempt at showing the prompt: resolves to { choice } or { error }. */
function _promptInPage(tabId, info) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (res) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      resolve(res);
    };
    // A stop from the popup or a hotkey, or the tab closing, ends the run while
    // the prompt is still up; the loop must not keep waiting for a click then.
    const poll = setInterval(() => {
      if (!state.playback.active) settle({ choice: FAIL_STOP, external: true });
    }, 250);
    chrome.tabs.sendMessage(tabId, { type: 'ACTION_FAILED_PROMPT', ...info }, { frameId: 0 }, (res) => {
      const err = chrome.runtime.lastError?.message;
      settle(err || !res?.choice ? { error: err || 'no answer' } : { choice: res.choice });
    });
  });
}

/**
 * Pause on a failed action until the user picks retry / skip / stop in the page.
 * Returns null when no page could show the prompt (restricted URL, no content
 * script), and the caller falls back to notifying and moving on.
 */
async function _askOnFailure(tabId, info) {
  state.playback.failPrompt = true;
  updateBadge();
  try {
    // Several tries: the failure is often the page being between documents, and
    // a reload under an open prompt drops it — both are shown again once the new
    // document has loaded.
    for (let attempt = 0; attempt < 3 && state.playback.active; attempt++) {
      const res = await _promptInPage(tabId, info);
      if (res.choice) {
        if (res.external) tabMsg(tabId, { type: 'ACTION_FAILED_PROMPT_CLOSE' }, 2_000);
        return res.choice;
      }
      await waitForTabLoad(tabId, 10_000);
      await new Promise(r => setTimeout(r, 300)); // let content.js register
    }
    return state.playback.active ? null : FAIL_STOP;
  } finally {
    state.playback.failPrompt = false;
    updateBadge();
  }
}

/**
 * Every failed action goes through here. Retry leaves nothing behind; skip and
 * stop record the failure, and stop ends the run the way STOP_PLAYBACK does.
 */
async function _onActionFailed(tabId, i, actions, action, reason, failedActions, record = reason) {
  const r = reason || 'element not found';
  chrome.runtime.sendMessage({ type: 'ACTION_FAILED', index: i, action, reason: r }).catch(() => {});

  const csv = state.csvPlayback.active;
  const choice = await _askOnFailure(tabId, {
    index: i, total: actions.length, reason: r,
    actionType: action?.type || '', label: action?.label || '',
    scenarioName: state.playback.scenarioName || '',
    row: csv ? state.csvPlayback.currentRow + 1 : null,
    rows: csv ? state.csvPlayback.rows?.length || 0 : null,
  });

  if (choice === FAIL_RETRY) return FAIL_RETRY;
  if (!choice) _notifyActionFailed(i, action, r, { toPopup: false });
  if (failedActions) {
    failedActions.push({ index: i + 1, type: action?.type || 'unknown', label: action?.label || '', reason: record || r });
  }
  if (choice === FAIL_STOP) {
    state.playback.active         = false;
    state.sequencePlayback.active = false;
    state.csvPlayback.active      = false;
    updateBadge();
    return FAIL_STOP;
  }
  return FAIL_SKIP;
}

/* ── Screenshot settings cache ──────────────────────────────────────────────── */

// Cached per playback run so repeated screenshot actions don't each issue a
// storage read.  Reset at the start of each public entry point.
let _ssSettings = null;

async function _getSsSettings() {
  if (!_ssSettings) {
    _ssSettings = await new Promise(r => chrome.storage.sync.get(['screenshotSaveMode', 'screenshotPrefix'], r));
  }
  return _ssSettings;
}

/* ── Playback Core ──────────────────────────────────────────────────────────── */

// Switch case target meaning "the scenario currently playing": the case jumps to
// its startAt action in place instead of running a nested scenario.
const SWITCH_SELF    = '__self__';
const MAX_SELF_JUMPS = 1000;

export async function playActionsOnTab(
  tabId, actions, vars = null, screenshotsResult = null,
  forceAutoSave = false, skipDownload = false, startFromIndex = 0,
  failedActions = null, _depth = 0,
) {
  if (_depth > 10) {
    console.error('[PLAYBACK] Max switch/nested-scenario depth (10) exceeded — aborting branch');
    _notifyActionFailed(startFromIndex, null, 'Max nested scenario depth exceeded (possible infinite loop in switch)');
    return vars || {};
  }

  const resolvedVars = resolveRandomVars(vars !== null ? vars : await getVariables());

  let _tabClosed = false;
  const _onTabRemoved = (removedTabId) => {
    if (removedTabId === tabId) { _tabClosed = true; state.playback.active = false; }
  };
  chrome.tabs.onRemoved.addListener(_onTabRemoved);

  let _selfJumps = 0; // Switch → "this scenario" hops taken in this run

  // Pauses on the in-page prompt. Each call site steps i back on FAIL_RETRY and
  // breaks on FAIL_STOP; FAIL_SKIP falls through to the action's usual tail.
  const fail = (i, action, reason, record) =>
    _onActionFailed(tabId, i, actions, action, reason, failedActions, record);

  try {
    for (let i = startFromIndex; i < actions.length; i++) {
      if (!state.playback.active || _tabClosed) break;

      state.playback.actionIndex = i;
      updateBadge();

      // Persist a checkpoint after every action so the popup can offer resume
      // if the tab reloads mid-playback (e.g. from a navigate action).
      if (state.playback.scenarioId) {
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
          let initialTabUrl = null;
          try {
            const t = await new Promise(r => chrome.tabs.get(tabId, r));
            initialTabUrl = t?.url || null;
          } catch (_) {}
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
              setTimeout(resolve, 500); // brief settle time after status=complete
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

            // SPA fallback: some single-page apps never fire status='complete' on
            // in-app navigation.  Poll the tab URL every 200 ms instead.
            // Only accept an exact or prefix match in the target→current direction
            // to avoid false-positives when the current URL is a prefix of the
            // target (e.g. current="/", target="/checkout").
            const spaPoller = setInterval(async () => {
              if (resolved) { clearInterval(spaPoller); return; }
              try {
                const tab = await new Promise(r => chrome.tabs.get(tabId, r));
                if (tab?.url && targetUrl && tab.url !== initialTabUrl && (
                  tab.url === targetUrl ||
                  tab.url.startsWith(targetUrl)
                )) done(true);
              } catch (_) {}
            }, 200);

            const navTimeout = setTimeout(() => done(false), 30_000);
          });

          if (!navSuccess) {
            const next = await fail(i, action, 'Navigation timed out or tab was closed', 'Navigation timed out');
            if (next === FAIL_RETRY) { i--; continue; }
            if (next === FAIL_STOP) break;
          }
          if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
          continue;
        }

        /* ── Wait ── */
        if (action.type === 'wait') {
          // `delay` first, the same order the popup's preview and editor and both
          // exporters read it in. Only old actions (and "save sequence as
          // scenario" ones) keep the duration in `value`; one carrying both used
          // to show one duration and wait another.
          const ms = parseInt(action.delay || action.value || 500, 10);
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

        /* ── Script — CDP execution (bypasses page CSP) ── */
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
            const next = await fail(i, action, result.error);
            if (next === FAIL_RETRY) { i--; continue; }
            if (next === FAIL_STOP) break;
          }
          if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
          continue;
        }

        /* ── Screenshot → Variable (CSV mode) ── */
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
            const next = await fail(i, action, e.message);
            if (next === FAIL_RETRY) { i--; continue; }
            if (next === FAIL_STOP) break;
          }
          if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
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
            const next = await fail(i, action, result.error);
            if (next === FAIL_RETRY) { i--; continue; }
            if (next === FAIL_STOP) break;
          }
          if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
          continue;
        }

        /* ── Read DOM value → variable ── */
        if (action.type === 'readdom') {
          const rdResult = await tabMsg(tabId, { type: 'PLAY_ACTION', action }, Math.max(10_000, (action.timeout || 0) + 2_000), action.frameId);
          if (rdResult?.value !== undefined && action.varName) {
            resolvedVars[action.varName] = rdResult.value;
          } else if (rdResult?.failed) {
            const next = await fail(i, action, rdResult.error || null);
            if (next === FAIL_RETRY) { i--; continue; }
            if (next === FAIL_STOP) break;
          }
          if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
          continue;
        }

        /* ── Condition (if / skip-N) ── */
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
            // Guard against misconfigured skipCount=0 which would create an
            // infinite loop (condition re-evaluates itself every iteration).
            if (rawSkip === 0) console.warn('[PLAYBACK] Condition skipCount=0 would cause infinite loop; treating as 1');
            i += skip;
          }
          if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
          continue;
        }

        /* ── Switch (variable → scenario branch) ── */
        if (action.type === 'switch') {
          const switchVal = action.switchVar || '';
          const cases     = action.cases || [];
          let matched     = cases.find(c => c.value === switchVal);
          if (!matched) matched = cases.find(c => c.value === '__default__');
          // 1-based "start at action #N" on the case; absent on older cases = 1.
          const startIdx  = Math.max(0, (parseInt(matched?.startAt, 10) || 1) - 1);
          if (matched?.scenarioId === SWITCH_SELF) {
            // Jump within the scenario being played: no nested run, just move i.
            // A backward jump is a loop, so cap the hops — a case that always
            // matches would otherwise spin forever.
            if (startIdx >= actions.length) {
              const next = await fail(i, action, `Switch: action #${startIdx + 1} does not exist (scenario has ${actions.length})`, 'Jump target out of range');
              if (next === FAIL_RETRY) { i--; continue; }
              if (next === FAIL_STOP) break;
            } else if (++_selfJumps > MAX_SELF_JUMPS) {
              const next = await fail(i, action, `Switch: more than ${MAX_SELF_JUMPS} jumps — possible infinite loop, continuing without jumping`, 'Jump limit exceeded');
              if (next === FAIL_RETRY) { i--; continue; }
              if (next === FAIL_STOP) break;
            } else {
              if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
              i = startIdx - 1; // the loop's i++ lands on startIdx
              continue;
            }
          } else if (matched?.scenarioId) {
            const scenarios      = await getScenarios();
            const targetScenario = scenarios[matched.scenarioId];
            if (targetScenario?.actions?.length && startIdx >= targetScenario.actions.length) {
              const next = await fail(i, action, `Switch: "${targetScenario.name || matched.scenarioId}" has no action #${startIdx + 1} (only ${targetScenario.actions.length})`, 'Switch start action out of range');
              if (next === FAIL_RETRY) { i--; continue; }
              if (next === FAIL_STOP) break;
            } else if (targetScenario?.actions?.length) {
              const caseLabel    = matched.value === '__default__' ? 'default' : matched.value;
              const switchedName = targetScenario.name || matched.scenarioId;
              const parentName   = state.playback.scenarioName;
              const parentTotal  = state.playback.totalActions;
              state.playback.scenarioName  = switchedName;
              state.playback.actionIndex   = startIdx;
              state.playback.totalActions  = targetScenario.actions.length;
              chrome.runtime.sendMessage({ type: 'SWITCH_SCENARIO', scenarioName: switchedName, caseLabel }).catch(() => {});
              if (!state.csvPlayback.active) {
                // Same reasoning as action_failed: a scenario can switch many times
                // in one run, and only the most recent hop is worth showing.
                sendAlertNotification('🔀 Scenario Switched', `[${caseLabel}] → "${switchedName}"`, 'scenario_switched');
              }
              // Pass a copy of vars so the nested scenario cannot mutate the parent's
              // variable map; merge returned vars back after completion.
              //
              // failedActions, by contrast, is shared with the nested run rather than
              // dropped: a failure is a failure whichever scenario it happened in.
              // Passing null here meant a switch branch could fail every one of its
              // actions and still be reported as a clean run — a CSV row with only
              // nested failures counted as passed, and its exported `failures` list
              // came back empty.
              const nestedVars = await playActionsOnTab(
                tabId, targetScenario.actions, { ...resolvedVars },
                screenshotsResult, forceAutoSave, skipDownload, startIdx, failedActions, _depth + 1,
              );
              Object.assign(resolvedVars, nestedVars);
              // Back in this scenario: progress counts its actions again, not the branch's.
              state.playback.scenarioName = parentName;
              state.playback.totalActions = parentTotal;
            } else {
              const next = await fail(i, action, `Switch: scenario "${matched.scenarioName || matched.scenarioId}" not found or has no actions`);
              if (next === FAIL_RETRY) { i--; continue; }
              if (next === FAIL_STOP) break;
            }
          } else {
            const next = await fail(i, action, `Switch: no case matched value "${switchVal}" and no default case set`);
            if (next === FAIL_RETRY) { i--; continue; }
            if (next === FAIL_STOP) break;
          }
          if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
          continue;
        }

        /* ── Upload File — CDP DOM.setFileInputFiles ── */
        if (action.type === 'uploadFile') {
          const cssSel = action.selectors?.css
            || (action.selectors?.id ? `#${CSS.escape(action.selectors.id)}` : null)
            || action.selector || '';
          const folder = (action.folderPath || '').replace(/[/\\]+$/, '');
          // backward-compat: old actions store a single fileName string
          const rawNames = Array.isArray(action.fileNames) && action.fileNames.length
            ? action.fileNames
            : action.fileName ? [action.fileName] : [];

          if (!cssSel || !folder || !rawNames.length) {
            const next = await fail(i, action, 'uploadFile: missing selector, folderPath, or file name(s)');
            if (next === FAIL_RETRY) { i--; continue; }
            if (next === FAIL_STOP) break;
          } else {
            const sep       = folder.includes('\\') ? '\\' : '/';
            const filePaths = rawNames.map(n => `${folder}${sep}${n}`);
            try {
              if (action.uploadMode === 'dropzone') {
                await setFileDropZoneViaCdp(tabId, cssSel, filePaths);
              } else {
                await setFileInputViaCdp(tabId, cssSel, filePaths);
              }
            } catch (e) {
              const next = await fail(i, action, e.message);
              if (next === FAIL_RETRY) { i--; continue; }
              if (next === FAIL_STOP) break;
            }
          }
          if (action.delay && action.delay > 0) await new Promise(r => setTimeout(r, action.delay));
          continue;
        }

        /* ── All other actions → content script ── */
        const _isClickLike  = action.type === 'click' || action.type === 'select';
        const preActionUrl  = _isClickLike ? await getTabUrl(tabId).catch(() => null) : null;

        const result = await tabMsg(tabId, { type: 'PLAY_ACTION', action }, Math.max(10_000, (action.timeout || 0) + 2_000), action.frameId);

        // Sticky fallback resolution: if the content script resolved a {fallback:...}
        // variable, persist the winning value into resolvedVars so every subsequent
        // action in this run uses the same value (not A→B→C again from scratch).
        if (result?.resolvedFallbacks && typeof result.resolvedFallbacks === 'object') {
          for (const [spec, resolvedVal] of Object.entries(result.resolvedFallbacks)) {
            for (const varName of Object.keys(resolvedVars)) {
              if (resolvedVars[varName] === spec) resolvedVars[varName] = resolvedVal;
            }
          }
        }

        // If a click/select caused an immediate navigation, the content script may
        // have become unreachable before it could send a response.  Detect this by
        // comparing the URL before and after — if it changed, treat the action as
        // successful and wait for the new page to finish loading.
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
          const next = await fail(i, action, reason);
          if (next === FAIL_RETRY) { i--; continue; }
          if (next === FAIL_STOP) break;
        }

        // For succeeded click/select, also check for post-action navigation
        // (e.g. form submit that navigates rather than using AJAX).
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
        const next = await fail(i, actions[i], err?.message || null, err?.message || 'unknown error');
        if (next === FAIL_RETRY) { i--; continue; }
        if (next === FAIL_STOP) break;
      }
    }
  } finally {
    chrome.tabs.onRemoved.removeListener(_onTabRemoved);
    if (_tabClosed) {
      chrome.runtime.sendMessage({ type: 'PLAYBACK_TAB_CLOSED', tabId }).catch(() => {});
      sendAlertNotification('⚠ Playback Stopped', 'Tab was closed — playback stopped', 'tab_closed');
    }
  }
  return resolvedVars;
}

/* ── Single Scenario Playback ───────────────────────────────────────────────── */

/** Resume a scenario from a saved checkpoint after a tab reload mid-playback. */
export async function startPlaybackFromCheckpoint(scenarioId, fromIndex, tabId) {
  if (refuseIfRecording()) return;
  // Guard: never start a checkpoint resume while CSV (or any other) playback is
  // active.  CSV has its own per-row resume path; running startPlaybackFromCheckpoint
  // on top of an active CSV run would bypass forceAutoSave/skipDownload and cause
  // screenshot save-as dialogs instead of accumulating results for the zip.
  if (_isAnyPlaybackActive()) { _notifyAlreadyRunning(); return; }
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
  chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  await _startKeepalive();
  // Collected so the completion notification can say whether "finished" means
  // "finished cleanly". Sequence and CSV runs already reported their failure
  // counts; single and resumed runs claimed success no matter how many actions
  // had failed along the way — playback does not stop at the first one.
  const failedActions = [];
  try {
    await playActionsOnTab(tabId, actions, null, null, false, false, fromIndex, failedActions);
  } finally {
    await _stopKeepalive();
    chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
    state.playback.active = false;
    updateBadge();
    chrome.storage.local.remove('playbackCheckpoint');
    await sendCompletionNotification(
      'Playback complete',
      `"${scenario.name}" resumed & finished${_failSuffix(failedActions)}`,
    );
  }
}

export async function startPlayback(scenarioId, loopCount = 1, loopDelay = 0) {
  if (refuseIfRecording()) return;
  if (_isAnyPlaybackActive()) { _notifyAlreadyRunning(); return; }
  _ssSettings = null; // reset screenshot settings cache for this run

  const scenarios = await getScenarios();
  const scenario  = scenarios[scenarioId];
  if (!scenario) return;

  const tabId = await getActiveTabId();
  if (!tabId) {
    chrome.runtime.sendMessage({ type: 'PLAYBACK_NO_TAB' }).catch(() => {});
    sendAlertNotification('⚠ No Active Tab', 'No active tab found — open a tab and try again', 'no_tab');
    return;
  }

  // Wrapped in a DB test session when that is switched on — see bg/dbguard.js.
  const dbGuard = await beginDbGuard(scenario.name || scenarioId);
  if (dbGuard && dbGuard.refused) return;

  const actions = scenario.actions || [];
  const loops   = Math.max(1, Math.floor(loopCount));
  state.playback = {
    active: true, tabId, scenarioId, scenarioName: scenario.name || scenarioId,
    originalScenarioName: scenario.name || scenarioId,
    actionIndex: 0, totalActions: actions.length, loopCurrent: 1, loopTotal: loops,
  };
  updateBadge();
  chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  await _startKeepalive();

  // Accumulates across every loop iteration, so a 10-loop run reports the total.
  const failedActions = [];
  try {
    // Pass resolved vars from one loop to the next so readdom variables
    // accumulate across loop iterations.
    let loopVars = null;
    for (let loop = 0; loop < loops; loop++) {
      if (!state.playback.active) break;
      state.playback.loopCurrent = loop + 1;
      state.playback.actionIndex = 0;
      updateBadge();
      loopVars = await playActionsOnTab(tabId, actions, loopVars, null, false, false, 0, failedActions);
      if (loop < loops - 1 && loopDelay > 0) await new Promise(r => setTimeout(r, loopDelay));
    }
  } finally {
    await _stopKeepalive();
    chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
    state.playback.active = false;
    updateBadge();
    chrome.storage.local.remove('playbackCheckpoint');
    await sendCompletionNotification(
      'Playback complete',
      `"${scenario.name}" finished${loops > 1 ? ` (${loops} loops)` : ''}${_failSuffix(failedActions)}`,
    );
    await endDbGuard(dbGuard);
  }
}

/* ── Sequence Playback ──────────────────────────────────────────────────────── */

export async function startSequence(runList) {
  if (refuseIfRecording()) return;
  if (_isAnyPlaybackActive()) { _notifyAlreadyRunning(); return; }
  _ssSettings = null;

  state.sequencePlayback = { active: true, runList, currentIndex: 0 };
  updateBadge();
  const tabId = await getActiveTabId();
  if (!tabId) {
    state.sequencePlayback.active = false;
    updateBadge();
    chrome.runtime.sendMessage({ type: 'PLAYBACK_NO_TAB' }).catch(() => {});
    sendAlertNotification('⚠ No Active Tab', 'No active tab found — open a tab and try again', 'no_tab');
    return;
  }

  const scenarios = await getScenarios();

  const dbGuard = await beginDbGuard(`Sequence · ${runList.length}`);
  if (dbGuard && dbGuard.refused) {
    state.sequencePlayback.active = false;
    updateBadge();
    return;
  }

  let _seqTabClosed = false;
  const _onSeqTabRemoved = (removedId) => {
    if (removedId === tabId) { _seqTabClosed = true; state.sequencePlayback.active = false; }
  };
  chrome.tabs.onRemoved.addListener(_onSeqTabRemoved);
  chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  await _startKeepalive();

  let _seqCompleted = 0, _seqFailed = 0;

  try {
    for (let i = 0; i < runList.length; i++) {
      if (!state.sequencePlayback.active || _seqTabClosed) break;
      state.sequencePlayback.currentIndex = i;
      updateBadge();

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
      const _seqItemFailed = [];
      await playActionsOnTab(tabId, actions, null, null, false, false, 0, _seqItemFailed);
      state.playback.active = false;
      _seqCompleted++;
      if (_seqItemFailed.length > 0) _seqFailed++;

      if (i < runList.length - 1 && item.delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, item.delay));
      }
    }
    if (_seqTabClosed) {
      chrome.runtime.sendMessage({ type: 'PLAYBACK_TAB_CLOSED', tabId }).catch(() => {});
      sendAlertNotification('⚠ Sequence Stopped', 'Tab was closed — sequence playback stopped', 'tab_closed');
    } else {
      const _seqMsg = _seqFailed > 0
        ? `${_seqCompleted - _seqFailed} ✓ · ${_seqFailed} ✗ of ${_seqCompleted} scenarios`
        : `${_seqCompleted} scenario(s) done`;
      await sendCompletionNotification('Sequence complete', _seqMsg);
    }
  } catch (err) {
    console.error('[SEQUENCE] Error during sequence playback:', err);
  } finally {
    chrome.tabs.onRemoved.removeListener(_onSeqTabRemoved);
    await _stopKeepalive();
    chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
    state.sequencePlayback.active = false;
    state.playback.active = false;
    updateBadge();
    await endDbGuard(dbGuard);
  }
}

/* ── CSV Playback ───────────────────────────────────────────────────────────── */

/**
 * Variable names a scenario actually touches. Only these are kept in the per-row
 * IndexedDB record, which is what the CSV/XLSX/HTML export turns into columns.
 *
 * The field list must stay in step with interpolateAction() in bg/utils.js — a
 * field that gets variables substituted but is not scanned here silently loses
 * its column. folderPath, fileName, fileNames and the idContains/classContains
 * conditions were missing, so a scenario uploading `${docFolder}/${invoiceFile}`
 * ran correctly but exported neither value.
 */
function collectRelevantKeys(actions) {
  const keys   = new Set();
  const VAR_RE = /\$\{([^}]+)\}/g;
  const FIELDS = [
    'selector', 'value', 'url', 'code', 'expectedValue', 'switchVar',
    'folderPath', 'fileName',
  ];
  const C_FIELDS = ['valueEquals', 'textContains', 'idContains', 'classContains'];

  const scan = (v) => {
    if (typeof v !== 'string') return;
    let m; VAR_RE.lastIndex = 0;
    while ((m = VAR_RE.exec(v)) !== null) keys.add(m[1]);
  };

  for (const a of actions) {
    for (const f of FIELDS) scan(a[f]);
    if (Array.isArray(a.fileNames)) a.fileNames.forEach(scan);
    if (a.conditions && typeof a.conditions === 'object') {
      for (const f of C_FIELDS) scan(a.conditions[f]);
    }
    // readdom and screenshot_tovar produce variables that are also "relevant".
    if ((a.type === 'readdom' || a.type === 'screenshot_tovar') && a.varName) keys.add(a.varName);
  }
  return keys;
}

// Results go to IndexedDB one row at a time (O(1)/row vs the previous O(n²) array-rewrite approach).
export async function startCsvPlayback(scenarioId, rows, delayBetween, exportFormat = 'csv', startRowIndex = 0) {
  if (refuseIfRecording()) return;
  if (_isAnyPlaybackActive()) { _notifyAlreadyRunning(); return; }
  _ssSettings = null;

  // xlsx/html/zip formats post-process screenshots client-side — skip downloading
  // individual files during the run to avoid the browser download dialog.
  const skipDownload = exportFormat === 'xlsx' || exportFormat === 'html' || exportFormat === 'zip';
  // A run picking up from a checkpoint must keep everything the earlier rows wrote.
  const isResume = startRowIndex > 0;
  state.csvPlayback = {
    active: true, rows, currentRow: startRowIndex, scenarioId, delayBetween,
    stopAfterRow: false,
  };
  state.csvInterrupted = null;
  updateBadge();

  let tabId         = null;
  let scenario      = null;
  let completedRows = 0;
  let failedRows    = 0;
  let runError      = null;
  let keepaliveOn   = false;
  let dbGuard       = null;

  // The whole run lives inside try/catch/finally, matching startPlayback and
  // startSequence. A throw anywhere — an IndexedDB quota error while writing a
  // row, a rejected CDP command, a tab closing mid-action — otherwise leaves
  // csvPlayback.active stuck true: the keep-alive alarm then re-arms itself every
  // 20 s for the life of the worker, and every later Play is refused with
  // "already running" for a run that is not running. The only escape was
  // disabling the extension.
  try {
    // Rows are not re-saved here: the popup wrote them to csvSessionData before
    // dispatching START_CSV_PLAYBACK, and restoreCsvState() reads that record.
    await persistCsvState(scenarioId, startRowIndex, delayBetween, exportFormat);

    const [scenarios, baseVars] = await Promise.all([getScenarios(), getVariables()]);
    scenario = scenarios[scenarioId];
    if (!scenario) return;

    tabId = await getActiveTabId();
    if (!tabId) {
      chrome.runtime.sendMessage({ type: 'PLAYBACK_NO_TAB' }).catch(() => {});
      sendAlertNotification('⚠ No Active Tab', 'No active tab found — open a tab and try again', 'no_tab');
      return;
    }

    dbGuard = await beginDbGuard(`${scenario.name || scenarioId} · CSV`);
    if (dbGuard && dbGuard.refused) return;

    const actions      = scenario.actions || [];
    const relevantKeys = collectRelevantKeys(actions);

    // Collect screenshot varNames in action order, including nested scenarios
    // reached via Switch, so XLSX/HTML column headers match the full action sequence.
    function _collectSsVars(acts, visited) {
      const out = [];
      for (const a of acts) {
        if (a.type === 'screenshot_tovar' && a.varName && !visited.has('var:' + a.varName)) {
          visited.add('var:' + a.varName);
          out.push(a.varName);
        }
        if (a.type === 'switch' && a.cases) {
          for (const c of a.cases) {
            if (c.scenarioId && !visited.has('sc:' + c.scenarioId)) {
              visited.add('sc:' + c.scenarioId);
              const nested = scenarios[c.scenarioId];
              if (nested?.actions) out.push(..._collectSsVars(nested.actions, visited));
            }
          }
        }
      }
      return out;
    }
    const ssVarOrder = _collectSsVars(actions, new Set(['sc:' + scenarioId]));
    chrome.storage.local.set({ csvSsVarOrder: ssVarOrder });

    // Clear the previous run's results and screenshots — a fresh run must never
    // show stale data from the prior one.
    //
    // Skipped on resume. startRowIndex > 0 means rows 0..startRowIndex-1 already
    // ran and their results are the entire point of resuming; clearing here wiped
    // them, so a run resumed at row 120 of 200 exported only the last 80 rows.
    if (!isResume) {
      await Promise.all([
        new Promise(r => chrome.storage.local.remove('csvRunResults', r)),
        ssClear(),
        csvResultClear(),
      ]);
    }
    // Always dropped: a leftover single-scenario checkpoint would trigger a false
    // OFFER_RESUME on top of the CSV run.
    await new Promise(r => chrome.storage.local.remove('playbackCheckpoint', r));

    chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
    await _startKeepalive();
    keepaliveOn = true;

    for (let i = startRowIndex; i < rows.length; i++) {
      if (!state.csvPlayback.active) break;
      state.csvPlayback.currentRow = i;
      updateBadge();

      await persistCsvState(scenarioId, i, delayBetween, exportFormat);

      // Merge base variables with row data; CSV columns override base vars when
      // names collide so per-row data always takes precedence.
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

      // Only store variables that are actually referenced by the scenario to
      // keep IDB records lean.
      // Screenshot vars are placed last in action-capture order so that XLSX/HTML
      // column headers match the scenario's action sequence rather than the order
      // the vars were defined (CSV column order or baseVars order).
      const filteredVarsRaw = Object.fromEntries(
        Object.entries(finalVars).filter(([k]) => relevantKeys.has(k)),
      );
      const ssKeys = new Set(Object.keys(screenshotsResult));
      const filteredVars = {};
      for (const [k, v] of Object.entries(filteredVarsRaw)) {
        if (!ssKeys.has(k)) filteredVars[k] = v;
      }
      for (const k of Object.keys(screenshotsResult)) {
        if (k in filteredVarsRaw) filteredVars[k] = filteredVarsRaw[k];
      }

      await csvResultWrite(i, { rowIndex: i, vars: filteredVars, failures: failedActions });

      for (const [vn, b64] of Object.entries(screenshotsResult)) {
        await ssWrite(i, vn, b64);
      }

      // "Stop after this row" was requested while this row was running. The row
      // is complete and its result is written, so leaving now is the graceful
      // exit the button promises — as opposed to STOP_CSV_PLAYBACK, which clears
      // `active` and abandons the row mid-action.
      const gracefulStop = state.csvPlayback.stopAfterRow === true;
      const isLast = gracefulStop || i === rows.length - 1;
      chrome.runtime.sendMessage({
        type: 'CSV_ROW_DONE', rowIndex: i, total: rows.length,
        failRows: failedRows, isLast, delayBetween,
      }).catch(() => {});

      if (gracefulStop) break;

      if (!isLast && delayBetween > 0) {
        await new Promise((r) => setTimeout(r, delayBetween));
      }
    }
  } catch (err) {
    runError = err;
    console.error('[CSV] Run aborted by an unexpected error:', err);
  } finally {
    if (keepaliveOn) _stopKeepalive();
    if (tabId != null) chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
    state.csvPlayback.active = false;
    state.playback.active    = false;
    await Promise.all([
      clearCsvState(),
      new Promise(r => chrome.storage.local.remove('playbackCheckpoint', r)),
    ]).catch(() => {});
    updateBadge();
    await endDbGuard(dbGuard);
  }

  // Report the crash rather than letting the run end in silence. Results written
  // before the throw stay in IndexedDB, so the export button still works.
  if (runError) {
    const msg = runError?.message || String(runError);
    sendAlertNotification('⚠ CSV Run Failed', `Stopped after ${completedRows} row(s): ${msg}`, 'csv_error');
    chrome.runtime.sendMessage({
      type: 'CSV_RUN_ERROR', error: msg, total: completedRows, failRows: failedRows,
    }).catch(() => {});
    return;
  }

  // Nothing ran: missing scenario or no eligible tab, both already reported above.
  if (!scenario || tabId == null) return;

  const _csvMsg = failedRows > 0
    ? `${completedRows - failedRows} ✓ · ${failedRows} ✗ of ${completedRows} rows — "${scenario.name}"`
    : `${completedRows} rows done — "${scenario.name}"`;
  await sendCompletionNotification('CSV Run complete', _csvMsg);
  chrome.runtime.sendMessage({
    type: 'CSV_RUN_DONE',
    total: completedRows,
    failRows: failedRows,
    scenarioName: scenario.name || scenarioId,
  }).catch(() => {});
}
