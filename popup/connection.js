/**
 * connection.js — Content script connectivity check and popup status indicator.
 *
 * Responsibilities:
 *  - PING the content script on the active tab and auto-reinject on failure.
 *  - Drive the "Now Playing" bar, mini panel, and progress bar based on
 *    background playback/recording state polled via GET_EXTENSION_STATUS.
 *  - Throttle the poll rate: 150 ms while active, 2 000 ms when idle.
 */

import { safeSendTabMessage, isEligibleTab } from './utils.js';
import { state } from './state.js';

const MAX_CONNECTION_RETRIES = 5;

let _lastActiveState = false;
let statusInterval = null;

/**
 * PING the content script on the current tab and update the connection badge.
 * On failure, re-injects content.js up to MAX_CONNECTION_RETRIES times before
 * marking the tab as disconnected and removing it from activatedTabs.
 */
export function checkContentScriptConnection() {
  const connectionStatus = document.getElementById('connectionStatus');
  const activateTab = document.getElementById('activateTab');
  const deactivateTab = document.getElementById('deactivateTab');

  if (!state.currentTabId || !state.activatedTabs.has(state.currentTabId)) {
    if (connectionStatus) {
      connectionStatus.textContent = '';
    }
    return;
  }

  chrome.tabs.sendMessage(state.currentTabId, { type: 'PING' }, (response) => {
    if (chrome.runtime.lastError || !response || !response.ready) {
      state.connectionRetryCount++;

      if (state.connectionRetryCount >= MAX_CONNECTION_RETRIES) {
        if (connectionStatus) {
          connectionStatus.textContent = 'Lost';
          connectionStatus.style.color = 'var(--danger)';
        }
        if (activateTab) activateTab.style.display = 'block';
        if (deactivateTab) deactivateTab.style.display = 'none';
        state.activatedTabs.delete(state.currentTabId);
        chrome.storage.local.set({ activatedTabs: Array.from(state.activatedTabs) });
      } else {
        if (connectionStatus) {
          connectionStatus.textContent = `Retry ${state.connectionRetryCount}/${MAX_CONNECTION_RETRIES}`;
          connectionStatus.style.color = 'var(--warning, #f59e0b)';
        }
        chrome.scripting.executeScript({
          target: { tabId: state.currentTabId },
          files: ['content.js']
        }).catch(() => {});
      }
    } else {
      state.connectionRetryCount = 0;
      if (connectionStatus) {
        connectionStatus.textContent = 'Connected';
        connectionStatus.style.color = 'var(--success)';
      }
    }
  });
}

/** Start (or restart) the 2 s connection health-check interval. */
export function startConnectionCheck() {
  if (state.connectionCheckInterval) clearInterval(state.connectionCheckInterval);
  state.connectionRetryCount = 0;
  checkContentScriptConnection();
  state.connectionCheckInterval = setInterval(checkContentScriptConnection, 2000);
}

let _panelOpen = false;
// Guards the "done" bar hold period: while true, the idle branch of
// updateStatusIndicator must not call _setNowPlaying(false) and clear the bar.
let _csvDoneActive = false;
let _csvDoneTimeout = null;

function _setNowPlaying(show, { icon = '▶', name = '', step = '', switched = false } = {}) {
  const bar      = document.getElementById('nowPlayingBar');
  const iconEl   = document.getElementById('nowPlayingIcon');
  const nameEl   = document.getElementById('nowPlayingName');
  const stepEl   = document.getElementById('nowPlayingStep');
  const thinBar  = document.getElementById('playbackProgressWrap');
  if (!bar) return;
  if (!show) {
    bar.style.display = 'none';
    if (thinBar) thinBar.style.display = '';
    _setPanelOpen(false);
    return;
  }
  bar.style.display = '';
  if (thinBar) thinBar.style.display = 'none'; // hidden — step shown in Now Playing bar
  bar.classList.toggle('switched', switched);
  if (iconEl) iconEl.textContent = icon;
  if (nameEl) nameEl.textContent = name;
  if (stepEl) stepEl.textContent = step;
}

function _setPanelOpen(open) {
  _panelOpen = open;
  const panel = document.getElementById('playbackPanel');
  const bar   = document.getElementById('nowPlayingBar');
  const caret = document.getElementById('nowPlayingCaret');
  if (panel) panel.style.display = open ? 'block' : 'none';
  if (bar)   bar.setAttribute('aria-expanded', String(open));
  if (caret) caret.style.transform = open ? 'rotate(180deg)' : '';
}

function _updatePanel({ name = '', origName = '', progress = '', pct = 0, csvRow = 0, csvTotal = 0 } = {}) {
  const nameEl   = document.getElementById('pbPanelName');
  const origRow  = document.getElementById('pbPanelSwitchedRow');
  const origEl   = document.getElementById('pbPanelOrigName');
  const progEl   = document.getElementById('pbPanelProgress');
  const fill     = document.getElementById('pbPanelFill');
  const csvRowEl = document.getElementById('pbPanelCsvRow');
  const csvFill  = document.getElementById('pbPanelCsvFill');
  const csvRowWrap = document.getElementById('pbPanelCsvRowWrap');
  if (nameEl) nameEl.textContent = name;
  const isSwitched = origName && origName !== name;
  if (origRow) origRow.style.display = isSwitched ? 'flex' : 'none';
  if (origEl)  origEl.textContent = origName;
  if (progEl)  progEl.textContent = progress;
  if (fill)    fill.style.width = Math.round(pct) + '%';
  // CSV row progress
  const csvPrgWrap = document.getElementById('pbPanelCsvProgressWrap');
  if (csvRowWrap)  csvRowWrap.style.display  = csvTotal > 0 ? 'flex'  : 'none';
  if (csvPrgWrap)  csvPrgWrap.style.display  = csvTotal > 0 ? 'block' : 'none';
  if (csvRowEl && csvTotal > 0) csvRowEl.textContent = `${csvRow}/${csvTotal}`;
  if (csvFill && csvTotal > 0)  csvFill.style.width = Math.round(csvRow / csvTotal * 100) + '%';
}

/* === Progress Bar (private) === */

function _setProgress(show, current, total) {
  const playbackProgressWrap = document.getElementById('playbackProgressWrap');
  const playbackProgressFill = document.getElementById('playbackProgressFill');

  if (!playbackProgressWrap || !playbackProgressFill) return;
  if (show && total > 0) {
    playbackProgressWrap.classList.add('show');
    playbackProgressFill.style.width = Math.round((current / total) * 100) + '%';
    const progressLabel = document.getElementById('playbackProgressLabel');
    if (progressLabel) progressLabel.textContent = `Action ${current}/${total}`;
  } else {
    playbackProgressWrap.classList.remove('show');
    playbackProgressFill.style.width = '0%';
    const progressLabel = document.getElementById('playbackProgressLabel');
    if (progressLabel) progressLabel.textContent = '';
  }
}

/**
 * Switch the status-poll interval based on whether the extension is active.
 * 150 ms while recording/playing keeps the progress bar and step counter
 * visually smooth. 2 000 ms when idle avoids unnecessary background CPU usage.
 * Rate changes are applied only when the state actually transitions so we don't
 * reset a running interval on every poll tick.
 */
function _scheduleNextPoll(isActive) {
  if (isActive === _lastActiveState) return;
  _lastActiveState = isActive;
  if (statusInterval) clearInterval(statusInterval);
  statusInterval = setInterval(updateStatusIndicator, isActive ? 150 : 2000);
}

/**
 * Poll GET_EXTENSION_STATUS once and sync all UI elements to the response:
 * status dot, text badge, "Now Playing" bar, detail panel, and progress bar.
 * Called on a recurring interval managed by `_scheduleNextPoll`.
 */
export function updateStatusIndicator() {
  const statusDot = document.getElementById('statusDot');
  const statusIndicator = document.getElementById('statusIndicator');
  const statusText = document.getElementById('statusText');
  const connectionStatus = document.getElementById('connectionStatus');
  const recordingBadge = document.getElementById('recordingBadge');
  const scenarioList = document.getElementById('scenarioList');
  const recordingTopBar = document.getElementById('recordingTopBar');
  const nowPlayingBar = document.getElementById('nowPlayingBar');
  const nowPlayingIcon = document.getElementById('nowPlayingIcon');
  const nowPlayingName = document.getElementById('nowPlayingName');
  const nowPlayingStep = document.getElementById('nowPlayingStep');

  chrome.runtime.sendMessage({ type: 'GET_EXTENSION_STATUS' }, (status) => {
    if (chrome.runtime.lastError || !status) {
      if (statusIndicator) {
        statusIndicator.classList.remove('active', 'recording', 'playing', 'sequence');
      }
      if (statusText) statusText.textContent = '';
      _setProgress(false, 0, 0);
      _scheduleNextPoll(false);
      return;
    }

    if (status.recording) {
      statusIndicator.classList.add('active', 'recording');
      statusIndicator.classList.remove('playing', 'sequence');
      if (statusText) statusText.textContent = '● REC';
      if (statusDot) statusDot.className = 'status-dot recording';
      if (recordingBadge) recordingBadge.classList.add('show');
      if (recordingTopBar) recordingTopBar.classList.add('show');
      if (status.recordingScenarioId && scenarioList && !scenarioList.value) {
        scenarioList.value = status.recordingScenarioId;
      }
      _setNowPlaying(false);
      _setProgress(false, 0, 0);
      _scheduleNextPoll(true);
    } else if (status.sequencePlaying) {
      statusIndicator.classList.add('active', 'sequence');
      statusIndicator.classList.remove('recording', 'playing');
      const seqProgress = `${status.currentScenarioIndex + 1}/${status.totalScenarios}`;
      if (statusText) statusText.textContent = '▶▶';
      if (statusDot) statusDot.className = 'status-dot active';
      if (recordingBadge) recordingBadge.classList.remove('show');
      if (recordingTopBar) recordingTopBar.classList.remove('show');
      _setNowPlaying(true, { icon: '▶▶', name: status.scenarioName || 'Sequence', step: `seq ${seqProgress}` });
      _updatePanel({
        name: status.scenarioName || 'Sequence',
        origName: '',
        progress: seqProgress,
        pct: status.totalScenarios > 0 ? (status.currentScenarioIndex + 1) / status.totalScenarios * 100 : 0,
      });
      _setProgress(true, status.currentScenarioIndex + 1, status.totalScenarios);
      _scheduleNextPoll(true);
    } else if (status.playing) {
      statusIndicator.classList.add('active', 'playing');
      statusIndicator.classList.remove('recording', 'sequence');
      const stepProgress = `${status.actionIndex + 1}/${status.totalActions}`;
      // CSV: show row context in step
      const csvStep = status.csvPlaying
        ? `row ${status.csvCurrentRow + 1}/${status.csvTotalRows} · ${stepProgress}`
        : stepProgress;
      if (statusText) statusText.textContent = '▶';
      if (statusDot) statusDot.className = 'status-dot active';
      if (recordingBadge) recordingBadge.classList.remove('show');
      if (recordingTopBar) recordingTopBar.classList.remove('show');
      const isSwitched = !!(status.originalScenarioName && status.scenarioName !== status.originalScenarioName);
      _setNowPlaying(true, {
        icon: '▶',
        name: status.scenarioName || '',
        step: csvStep,
        switched: isSwitched,
      });
      _updatePanel({
        name: status.scenarioName || '',
        origName: isSwitched ? status.originalScenarioName : '',
        progress: csvStep,
        pct: status.totalActions > 0 ? (status.actionIndex + 1) / status.totalActions * 100 : 0,
        csvRow: status.csvPlaying ? status.csvCurrentRow + 1 : 0,
        csvTotal: status.csvPlaying ? status.csvTotalRows : 0,
      });
      _setProgress(true, status.actionIndex + 1, status.totalActions);
      _scheduleNextPoll(true);
    } else if (status.csvPlaying) {
      // Between CSV rows (delay phase) — keep bar visible
      statusIndicator.classList.add('active', 'playing');
      statusIndicator.classList.remove('recording', 'sequence');
      if (statusText) statusText.textContent = '▶';
      if (statusDot) statusDot.className = 'status-dot active';
      if (recordingBadge) recordingBadge.classList.remove('show');
      if (recordingTopBar) recordingTopBar.classList.remove('show');
      const betweenStep = `row ${status.csvCurrentRow + 1}/${status.csvTotalRows} · waiting…`;
      _setNowPlaying(true, { icon: '⏸', name: status.csvScenarioName || '', step: betweenStep });
      _updatePanel({
        name: status.csvScenarioName || '',
        origName: '',
        progress: betweenStep,
        pct: status.csvTotalRows > 0 ? status.csvCurrentRow / status.csvTotalRows * 100 : 0,
        csvRow: status.csvCurrentRow + 1,
        csvTotal: status.csvTotalRows,
      });
      _setProgress(true, status.csvCurrentRow, status.csvTotalRows);
      _scheduleNextPoll(true);
    } else {
      statusIndicator.classList.remove('active', 'recording', 'playing', 'sequence');
      if (statusText) statusText.textContent = '';
      if (recordingBadge) recordingBadge.classList.remove('show');
      if (recordingTopBar) recordingTopBar.classList.remove('show');
      if (!_csvDoneActive) _setNowPlaying(false);
      _setProgress(false, 0, 0);
      _scheduleNextPoll(false);
    }
  });
}

/**
 * Show the "CSV run complete" bar and hold it for 3 minutes.
 *
 * The 3-minute hold gives users time to read the summary, click into the
 * results panel, or copy data before the bar auto-dismisses. It is intentionally
 * longer than the active-playback poll interval (150 ms) — without the
 * `_csvDoneActive` flag the idle branch of `updateStatusIndicator` would clear
 * the bar on the very next poll tick.
 *
 * @param {string} scenarioName - Scenario label shown in the bar.
 * @param {string} summary      - Short result string (e.g. "12 ok · 1 fail").
 */
export function setCsvDoneBar(scenarioName, summary) {
  _csvDoneActive = true;
  clearTimeout(_csvDoneTimeout);
  _setNowPlaying(true, { icon: '✓', name: scenarioName, step: summary });
  _updatePanel({ name: scenarioName, progress: summary, pct: 100 });
  const bar = document.getElementById('nowPlayingBar');
  if (bar) bar.classList.add('csv-done');
  _csvDoneTimeout = setTimeout(() => {
    _csvDoneActive = false;
    _csvDoneTimeout = null;
    const b = document.getElementById('nowPlayingBar');
    if (b) b.classList.remove('csv-done');
    _setNowPlaying(false);
  }, 3 * 60 * 1000);
}

/** Imperatively dismiss the CSV done bar (e.g. when a new run starts or format is changed). */
export function clearCsvDoneBar() {
  _csvDoneActive = false;
  clearTimeout(_csvDoneTimeout);
  _csvDoneTimeout = null;
  const bar = document.getElementById('nowPlayingBar');
  if (bar) bar.classList.remove('csv-done');
  _setNowPlaying(false);
}

export function openPbPanel() { _setPanelOpen(true); }

// Bootstrap: run an immediate poll and start the idle (2 s) interval.
// The interval is later tightened to 150 ms by _scheduleNextPoll when playback
// or recording is detected.
const _statusIndicator = document.getElementById('statusIndicator');
if (_statusIndicator) {
  updateStatusIndicator();
  statusInterval = setInterval(updateStatusIndicator, 2000);
}

document.getElementById('nowPlayingBar')?.addEventListener('click', () => {
  _setPanelOpen(!_panelOpen);
});

document.getElementById('pbPanelStop')?.addEventListener('click', (e) => {
  e.stopPropagation();
  chrome.runtime.sendMessage({ type: 'STOP_PLAYBACK' });
  chrome.runtime.sendMessage({ type: 'STOP_SEQUENCE' });
  chrome.runtime.sendMessage({ type: 'STOP_CSV_PLAYBACK' });
  _setPanelOpen(false);
});
