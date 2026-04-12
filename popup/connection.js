/** connection.js — Content script connection check & status indicator */

import { safeSendTabMessage, isEligibleTab } from './utils.js';
import { state } from './state.js';

/* === Constants === */

const MAX_CONNECTION_RETRIES = 5;

/* === Module-level Variables === */

let _lastActiveState = false;
let statusInterval = null;

/* === Connection Check === */

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

/* === Start Connection Polling === */

export function startConnectionCheck() {
  if (state.connectionCheckInterval) clearInterval(state.connectionCheckInterval);
  state.connectionRetryCount = 0;
  checkContentScriptConnection();
  state.connectionCheckInterval = setInterval(checkContentScriptConnection, 2000);
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

/* === Adaptive Polling (private) === */

function _scheduleNextPoll(isActive) {
  if (isActive === _lastActiveState) return;
  _lastActiveState = isActive;
  if (statusInterval) clearInterval(statusInterval);
  statusInterval = setInterval(updateStatusIndicator, isActive ? 500 : 2000);
}

/* === Status Indicator === */

export function updateStatusIndicator() {
  const statusDot = document.getElementById('statusDot');
  const statusIndicator = document.getElementById('statusIndicator');
  const statusText = document.getElementById('statusText');
  const connectionStatus = document.getElementById('connectionStatus');
  const recordingBadge = document.getElementById('recordingBadge');
  const scenarioList = document.getElementById('scenarioList');
  const recordingTopBar = document.getElementById('recordingTopBar');

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
      _setProgress(false, 0, 0);
      _scheduleNextPoll(true);
    } else if (status.sequencePlaying) {
      statusIndicator.classList.add('active', 'sequence');
      statusIndicator.classList.remove('recording', 'playing');
      const progress = `${status.currentScenarioIndex + 1}/${status.totalScenarios}`;
      if (statusText) statusText.textContent = `▶▶ Seq ${progress}`;
      if (statusDot) statusDot.className = 'status-dot active';
      if (recordingBadge) recordingBadge.classList.remove('show');
      if (recordingTopBar) recordingTopBar.classList.remove('show');
      _setProgress(true, status.currentScenarioIndex + 1, status.totalScenarios);
      _scheduleNextPoll(true);
    } else if (status.playing) {
      statusIndicator.classList.add('active', 'playing');
      statusIndicator.classList.remove('recording', 'sequence');
      const progress = `${status.actionIndex + 1}/${status.totalActions}`;
      if (statusText) statusText.textContent = `▶ ${progress}`;
      if (statusDot) statusDot.className = 'status-dot active';
      if (recordingBadge) recordingBadge.classList.remove('show');
      if (recordingTopBar) recordingTopBar.classList.remove('show');
      _setProgress(true, status.actionIndex + 1, status.totalActions);
      _scheduleNextPoll(true);
    } else {
      statusIndicator.classList.remove('active', 'recording', 'playing', 'sequence');
      if (statusText) statusText.textContent = '';
      if (recordingBadge) recordingBadge.classList.remove('show');
      if (recordingTopBar) recordingTopBar.classList.remove('show');
      _setProgress(false, 0, 0);
      _scheduleNextPoll(false);
    }
  });
}

/* === Init === */

const _statusIndicator = document.getElementById('statusIndicator');
if (_statusIndicator) {
  updateStatusIndicator();
  statusInterval = setInterval(updateStatusIndicator, 2000);
}
