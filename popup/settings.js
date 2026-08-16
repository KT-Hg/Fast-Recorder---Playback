import { showToast } from './utils.js';
import { computeLockState, evaluateRemoteConfig } from '../bg/update-lock.js';

const DEFAULT_HOTKEYS = {
  startRecord:       'Alt+R',
  stopRecord:        'Alt+S',
  screenshot:        'Alt+P',
  screenshotFull:    'Alt+Shift+F',
  screenshotScrollV: 'Alt+V',
  screenshotScrollH: 'Alt+H',
  segV:              'Alt+Shift+V',
  segH:              'Alt+Shift+H',
  segStop:           'Alt+X',
  screenshotElement: 'Alt+E',
};

// Non-null while a hotkey "Set" button is active and awaiting a keydown.
// Acts as a mutex: starting a new capture implicitly cancels any prior one.
let capturingHotkey = null; // { id: string, btn: HTMLElement }

export function updateRangeFill(slider) {
  const min = parseFloat(slider.min) || 0;
  const max = parseFloat(slider.max) || 100;
  const pct = ((parseFloat(slider.value) - min) / (max - min)) * 100;
  slider.style.setProperty('--pct', pct.toFixed(2) + '%');
}

export function loadScreenshotSettings() {
  chrome.storage.local.get(['screenshotCountdownEnabled', 'screenshotCountdownSeconds'], (res) => {
    const cb  = document.getElementById('screenshotCountdownEnabled');
    const sel = document.getElementById('screenshotCountdownSeconds');
    const row = document.getElementById('screenshotCountdownRow');
    if (cb)  cb.checked = !!res.screenshotCountdownEnabled;
    if (sel) sel.value  = String(res.screenshotCountdownSeconds || 3);
    if (row) row.style.display = res.screenshotCountdownEnabled ? 'flex' : 'none';
  });
  chrome.storage.local.get(['watermarkEnabled', 'watermarkFormat', 'watermarkFontSize'], (wm) => {
    const cb = document.getElementById('watermarkEnabled');
    const fmt = document.getElementById('watermarkFormat');
    const fontSize = wm.watermarkFontSize ?? 13;
    const sliderFS = document.getElementById('watermarkFontSize');
    const numFS = document.getElementById('watermarkFontSizeNum');
    if (cb)  cb.checked = !!wm.watermarkEnabled;
    if (fmt) fmt.value  = wm.watermarkFormat || '';
    if (sliderFS) { sliderFS.value = fontSize; updateRangeFill(sliderFS); }
    if (numFS) numFS.value = fontSize;
  });
  chrome.storage.sync.get(['screenshotSaveMode', 'screenshotPrefix', 'segScrollSpeedV', 'segScrollSpeedH'], (res) => {
    const mode   = res.screenshotSaveMode || 'auto';
    const prefix = res.screenshotPrefix   || 'screenshot';
    const speedV = res.segScrollSpeedV    ?? 2;
    const speedH = res.segScrollSpeedH    ?? 2;
    const autoRadio   = document.getElementById('saveModeAuto');
    const askRadio    = document.getElementById('saveModeAsk');
    const prefixInput = document.getElementById('screenshotPrefix');
    const sliderV = document.getElementById('segScrollSpeedV');
    const numV    = document.getElementById('segScrollSpeedVNum');
    const sliderH = document.getElementById('segScrollSpeedH');
    const numH    = document.getElementById('segScrollSpeedHNum');
    if (autoRadio)   autoRadio.checked = mode === 'auto';
    if (askRadio)    askRadio.checked  = mode === 'ask';
    if (prefixInput) prefixInput.value = prefix;
    if (sliderV) { sliderV.value = speedV; updateRangeFill(sliderV); }
    if (numV) numV.value = speedV;
    if (sliderH) { sliderH.value = speedH; updateRangeFill(sliderH); }
    if (numH) numH.value = speedH;
  });
}

// Modifier-only keypresses (e.g. just Alt) return '' — no non-modifier key is pushed.
export function formatKeyEvent(e) {
  const parts = [];
  if (e.ctrlKey)  parts.push('Ctrl');
  if (e.altKey)   parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey)  parts.push('Meta');
  const key = e.key;
  if (!['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
    parts.push(key.length === 1 ? key.toUpperCase() : key);
  }
  return parts.join('+');
}

// Setting id → the element that displays its current combo.
const HOTKEY_LABEL_IDS = {
  startRecord:       'hotkeyStartRecord',
  stopRecord:        'hotkeyStopRecord',
  screenshot:        'hotkeyScreenshot',
  screenshotFull:    'hotkeyScreenshotFull',
  screenshotScrollV: 'hotkeyScreenshotScrollV',
  screenshotScrollH: 'hotkeyScreenshotScrollH',
  segV:              'hotkeySegV',
  segH:              'hotkeySegH',
  segStop:           'hotkeySegStop',
  screenshotElement: 'hotkeyScreenshotElement',
};

export function loadHotkeySettings() {
  chrome.storage.sync.get(['hotkeys'], (res) => {
    const h = { ...DEFAULT_HOTKEYS, ...(res.hotkeys || {}) };
    // Guarded lookups: a renamed or removed element used to throw straight out of
    // initSettings(), which aborted the rest of the popup bootstrap in init.js.
    for (const [key, id] of Object.entries(HOTKEY_LABEL_IDS)) {
      const el = document.getElementById(id);
      if (el) el.textContent = h[key] || '—';
    }
  });
}

export function cancelHotkeyCapture() {
  if (!capturingHotkey) return;
  capturingHotkey.btn.textContent = 'Set';
  capturingHotkey.btn.classList.remove('capturing');
  capturingHotkey = null;
}

/**
 * Read the completion-notification toggle from storage into the checkbox.
 *
 * Load only — the change listener is bound once in initSettings(). This function
 * runs again on every visit to the Settings tab (reloadSettings), and it used to
 * attach a fresh listener each time. Ten tab switches meant one click writing
 * chrome.storage.sync eleven times, against a hard quota of 120 writes/minute.
 */
export function loadNotificationSetting() {
  chrome.storage.sync.get(['notifyOnComplete'], (res) => {
    const cb = document.getElementById('notifyOnComplete');
    if (cb) cb.checked = !!res.notifyOnComplete;
  });
}

/* === Version / update card === */

function formatWhen(ts) {
  if (!ts) return 'never';
  return new Date(ts).toLocaleString();
}

export function loadUpdateInfo() {
  const cur = document.getElementById('updateInfoCurrent');
  if (!cur) return;
  cur.textContent = chrome.runtime.getManifest().version;

  chrome.storage.local.get(['updateStatus', 'updateAvailableSince', 'lastUpdateAt', 'remoteConfig'], (res) => {
    const st   = res?.updateStatus;
    const hard = evaluateRemoteConfig(res?.remoteConfig, chrome.runtime.getManifest().version);
    const lock = computeLockState({
      lastUpdateAt:   res?.lastUpdateAt,
      availableSince: res?.updateAvailableSince,
      hardLock:       hard.hardLock,
    });

    const latestEl   = document.getElementById('updateInfoLatest');
    const checkedEl  = document.getElementById('updateInfoChecked');
    const deadlineEl = document.getElementById('updateInfoDeadline');
    const rowEl      = document.getElementById('updateInfoDeadlineRow');
    const noteEl     = document.getElementById('updateInfoNote');

    if (latestEl) {
      // "unavailable" means Chrome could not ask the store at all — an unpacked
      // build, or a failed check. Saying "up to date" there would be a lie.
      latestEl.textContent = st?.state === 'unavailable'
        ? 'unknown (not installed from the Web Store)'
        : (st?.latestVersion || '—');
    }
    if (checkedEl) checkedEl.textContent = formatWhen(st?.checkedAt);

    if (rowEl) rowEl.hidden = !lock.pending;
    if (deadlineEl && lock.pending) {
      deadlineEl.textContent = lock.critical
        ? 'none — critical update'
        : lock.locked
          ? 'passed — features locked'
          : `${formatWhen(lock.deadline)} (${lock.daysLeft} day${lock.daysLeft === 1 ? '' : 's'} left)`;
    }
    if (noteEl) {
      noteEl.textContent = lock.critical
        ? (hard.message || 'A critical update is required.')
        : lock.locked
          ? 'Recording, playback and screenshots are locked until the update is installed.'
          : lock.pending
            ? 'Recording, playback and screenshots lock if the update is not installed by the deadline.'
            : 'Checked automatically once a day.';
    }
  });
}

export function initSettings() {
  /* --- Manual update check --- */
  document.getElementById('checkForUpdateNow')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    chrome.runtime.sendMessage({ type: 'CHECK_FOR_UPDATE' }, (res) => {
      btn.disabled = false;
      btn.textContent = 'Check for updates';
      loadUpdateInfo();
      if (chrome.runtime.lastError) { showToast('Could not reach the update service.', 'error'); return; }
      const st = res?.updateStatus;
      if (st?.state === 'available') showToast(`Version ${st.latestVersion || ''} is available`.trim(), 'warn');
      else if (st?.state === 'current') showToast('You are on the latest version', 'success');
      else showToast('Update check unavailable for this install', 'info');
    });
  });

  /* --- Slider ↔ number sync --- */
  const sliderV  = document.getElementById('segScrollSpeedV');
  const numV     = document.getElementById('segScrollSpeedVNum');
  const sliderH  = document.getElementById('segScrollSpeedH');
  const numH     = document.getElementById('segScrollSpeedHNum');
  const sliderFS = document.getElementById('watermarkFontSize');
  const numFS    = document.getElementById('watermarkFontSizeNum');

  sliderV ?.addEventListener('input', () => { if (numV)  numV.value  = sliderV.value;  updateRangeFill(sliderV); });
  numV    ?.addEventListener('input', () => { if (sliderV) { sliderV.value = numV.value;   updateRangeFill(sliderV); } });
  sliderH ?.addEventListener('input', () => { if (numH)  numH.value  = sliderH.value;  updateRangeFill(sliderH); });
  numH    ?.addEventListener('input', () => { if (sliderH) { sliderH.value = numH.value;   updateRangeFill(sliderH); } });
  sliderFS?.addEventListener('input', () => { if (numFS) numFS.value = sliderFS.value; updateRangeFill(sliderFS); });
  numFS   ?.addEventListener('input', () => { if (sliderFS) { sliderFS.value = numFS.value; updateRangeFill(sliderFS); } });

  /* --- Countdown checkbox toggles delay row visibility --- */
  document.getElementById('screenshotCountdownEnabled')?.addEventListener('change', (e) => {
    const row = document.getElementById('screenshotCountdownRow');
    if (row) row.style.display = e.target.checked ? 'flex' : 'none';
  });

  /* --- Save screenshot settings --- */
  document.getElementById('saveScreenshotSettings')?.addEventListener('click', () => {
    const mode   = document.querySelector('input[name="screenshotSaveMode"]:checked')?.value || 'auto';
    const prefix = document.getElementById('screenshotPrefix')?.value?.trim() || 'screenshot';
    const speedV = Math.min(10, Math.max(0.1, parseFloat(document.getElementById('segScrollSpeedVNum')?.value) || 2));
    const speedH = Math.min(10, Math.max(0.1, parseFloat(document.getElementById('segScrollSpeedHNum')?.value) || 2));
    const watermarkEnabled  = !!document.getElementById('watermarkEnabled')?.checked;
    const watermarkFormat   = document.getElementById('watermarkFormat')?.value?.trim() || '';
    const watermarkFontSize = Math.min(48, Math.max(8, parseInt(document.getElementById('watermarkFontSizeNum')?.value, 10) || 13));
    const countdownEnabled  = !!document.getElementById('screenshotCountdownEnabled')?.checked;
    const countdownSeconds  = parseInt(document.getElementById('screenshotCountdownSeconds')?.value, 10) || 3;
    chrome.storage.local.set({ watermarkEnabled, watermarkFormat, watermarkFontSize, screenshotCountdownEnabled: countdownEnabled, screenshotCountdownSeconds: countdownSeconds });
    chrome.storage.sync.set({ screenshotSaveMode: mode, screenshotPrefix: prefix, segScrollSpeedV: speedV, segScrollSpeedH: speedH }, () => {
      const btn = document.getElementById('saveScreenshotSettings');
      if (btn) {
        btn.textContent = 'Saved';
        setTimeout(() => { btn.textContent = 'Save Settings'; }, 1500);
      }
    });
  });

  /* --- Hotkey capture via keydown --- */
  document.addEventListener('keydown', (e) => {
    if (!capturingHotkey) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') { cancelHotkeyCapture(); return; }

    const MODS = ['Control', 'Alt', 'Shift', 'Meta'];
    if (MODS.includes(e.key)) return;

    const combo = formatKeyEvent(e);
    const { id } = capturingHotkey;
    cancelHotkeyCapture();

    chrome.storage.sync.get(['hotkeys'], (res) => {
      const hotkeys = { ...DEFAULT_HOTKEYS, ...(res.hotkeys || {}) };
      hotkeys[id] = combo;
      chrome.storage.sync.set({ hotkeys }, loadHotkeySettings);
    });
  }, true);

  /* --- Hotkey set buttons --- */
  document.querySelectorAll('.hotkey-set-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (capturingHotkey?.id === btn.dataset.hotkey) {
        cancelHotkeyCapture();
      } else {
        cancelHotkeyCapture();
        capturingHotkey = { id: btn.dataset.hotkey, btn };
        btn.textContent = 'Press key…';
        btn.classList.add('capturing');
      }
    });
  });

  /* --- Reset hotkeys --- */
  document.getElementById('resetHotkeys')?.addEventListener('click', () => {
    chrome.storage.sync.set({ hotkeys: DEFAULT_HOTKEYS }, loadHotkeySettings);
  });

  /* --- Completion notification toggle ---
   * Bound here, exactly once. reloadSettings() only refreshes values. */
  document.getElementById('notifyOnComplete')?.addEventListener('change', (e) => {
    chrome.storage.sync.set({ notifyOnComplete: e.target.checked });
  });

  /* --- Load initial state --- */
  loadScreenshotSettings();
  loadHotkeySettings();
  loadNotificationSetting();
  loadUpdateInfo();
}

export function reloadSettings() {
  loadScreenshotSettings();
  loadHotkeySettings();
  loadNotificationSetting();
  loadUpdateInfo();
}
