/**
 * update-banner.js — "New version available" bar at the top of the popup, and the
 * popup half of the update lock.
 *
 * Pure renderer for the `updateStatus` / `updateAvailableSince` / `lastUpdateAt`
 * records that bg/update-check.js writes on its daily alarm; it never runs the
 * version check itself, so opening the popup costs nothing. Sits inside
 * .sticky-header so initHeaderSpacer() re-measures and the content below is never
 * covered.
 *
 * Three escalating states, driven by computeLockState():
 *   normal   — dismissible, the user can wave it off until the next release
 *   warning  — last few days before the deadline, dismissal no longer honoured
 *   locked   — past the deadline; capture / recording / playback are refused
 *
 * The lock is enforced in the service worker; the click guard here only saves the
 * user a round-trip and explains why a button did nothing.
 */

import { showToast } from './utils.js';
import {
  computeLockState, evaluateRemoteConfig, compareVersions, LOCK_MESSAGE,
} from '../bg/update-lock.js';

const DISMISS_KEY = 'updateBannerDismissed'; // version the user waved off

/**
 * Published Web Store item ID. Pinned rather than read from chrome.runtime.id:
 * a store install has the same value, but an unpacked build gets a random local
 * ID that 404s on the store. Falls back to the running ID if ever cleared.
 */
const STORE_ITEM_ID = 'hghkokkjbpedgjbpohpkgmejkeobocam';
const STORE_URL = `https://chromewebstore.google.com/detail/${STORE_ITEM_ID || chrome.runtime.id}`;

/** Everything that starts a capture, a recording or a playback run. */
const LOCKED_CONTROLS = [
  '#startRecord',
  '#playScenario', '#startSequence', '#startCsvRun',
  '.cap-save-btn', '.cap-edit-btn',
  '#diffScreenshots',
].join(',');

let _latest = '';      // latest version currently on screen, for the dismiss key
let _locked = false;   // mirrors the service worker's lock state
let _lockMessage = LOCK_MESSAGE;

/** True while the extension is locked for being out of date. */
export function isUpdateLocked() {
  return _locked;
}

function render() {
  const banner = document.getElementById('updateBanner');
  if (!banner) return;

  chrome.storage.local.get(
    ['updateStatus', 'updateAvailableSince', 'lastUpdateAt', 'remoteConfig', DISMISS_KEY],
    (res) => {
      const st      = res?.updateStatus;
      const running = chrome.runtime.getManifest().version;
      const latest  = st?.latestVersion || '';

      // Already on (or past) the version we were told about — the update landed,
      // so drop the stale record instead of showing a banner for it forever.
      if (latest && compareVersions(running, latest) >= 0 && (st?.state === 'available' || res.updateAvailableSince)) {
        chrome.storage.local.remove(['updateStatus', 'updateAvailableSince', DISMISS_KEY]);
        applyLocked(false);
        banner.hidden = true;
        return;
      }

      const hard = evaluateRemoteConfig(res.remoteConfig, running);
      const lock = computeLockState({
        lastUpdateAt:   res.lastUpdateAt,
        availableSince: res.updateAvailableSince,
        hardLock:       hard.hardLock,
      });
      _lockMessage = lock.critical ? hard.message : LOCK_MESSAGE;
      applyLocked(lock.locked);

      const dismissKey = latest || 'any';
      const dismissed  = res[DISMISS_KEY] === dismissKey;
      // Dismissal is a courtesy for the calm state only; once the countdown or the
      // lock is on, the banner is the only thing explaining what is happening.
      if (!lock.pending || (dismissed && !lock.warning && !lock.locked)) {
        banner.hidden = true;
        return;
      }

      _latest = latest;
      const headline = document.getElementById('updateBannerHeadline');
      const sub      = document.getElementById('updateBannerSub');
      const dismiss  = document.getElementById('updateBannerDismiss');
      const apply    = document.getElementById('updateBannerApply');

      banner.classList.toggle('is-warning', lock.warning);
      banner.classList.toggle('is-locked', lock.locked);
      if (dismiss) dismiss.hidden = lock.warning || lock.locked;
      if (apply) apply.textContent = lock.locked ? 'Update now' : 'Update';

      if (lock.critical) {
        if (headline) headline.textContent = 'Critical update required';
        // Operator-supplied copy, so textContent only — never innerHTML.
        if (sub) sub.textContent = `— ${hard.message}`;
      } else if (lock.locked) {
        if (headline) headline.textContent = 'Features locked — update required';
        if (sub) sub.textContent = latest
          ? `— recording, playback and screenshots stay off until ${latest} is installed`
          : '— recording, playback and screenshots stay off until you update';
      } else if (lock.warning) {
        const d = lock.daysLeft;
        if (headline) headline.textContent = `Update within ${d} day${d === 1 ? '' : 's'}`;
        if (sub) sub.textContent = '— after that, recording, playback and screenshots are locked';
      } else {
        if (headline) {
          headline.textContent = latest
            ? `Version ${latest} is available`
            : 'A new version is available';
        }
        if (sub) sub.textContent = `— you have ${running}`;
      }

      banner.hidden = false;
    },
  );
}

/** Flip the popup into (or out of) its locked skin. */
function applyLocked(locked) {
  _locked = locked;
  document.body.classList.toggle('update-locked', locked);
}

/**
 * Swallow clicks on locked features. Capture phase, so it runs before the feature
 * modules' own listeners — CSS pointer-events alone would be bypassed by anything
 * that triggers those handlers without a real click.
 */
function initClickGuard() {
  document.addEventListener('click', (e) => {
    if (!_locked) return;
    const target = e.target.closest(LOCKED_CONTROLS);
    if (!target) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    showToast(_lockMessage, 'error');
  }, true);
}

export function initUpdateBanner() {
  const banner = document.getElementById('updateBanner');
  if (!banner) return;

  document.getElementById('updateBannerWhatsNew')?.addEventListener('click', () => {
    chrome.tabs.create({ url: STORE_URL });
  });

  document.getElementById('updateBannerApply')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'APPLY_UPDATE' }, (res) => {
      // On success the extension restarts and this popup is torn down with it.
      if (chrome.runtime.lastError || res?.success) return;
      showToast(res?.error || 'Could not apply the update right now.', 'error');
    });
  });

  document.getElementById('updateBannerDismiss')?.addEventListener('click', () => {
    // Keyed by version, so the next release shows the banner again.
    chrome.storage.local.set({ [DISMISS_KEY]: _latest || 'any' });
    banner.hidden = true;
  });

  initClickGuard();

  // The service worker blocks the real work; this is how the popup finds out.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'UPDATE_LOCK_BLOCKED') {
      applyLocked(true);
      render();
      showToast(msg.message || LOCK_MESSAGE, 'error');
    }
  });

  render();

  // The daily check runs in the service worker, possibly while the popup is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.updateStatus || changes.updateAvailableSince || changes.lastUpdateAt ||
        changes.remoteConfig || changes[DISMISS_KEY]) render();
  });
}
