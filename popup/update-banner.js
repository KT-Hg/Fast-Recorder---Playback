/**
 * update-banner.js — "New version available" bar at the top of the popup.
 *
 * Pure renderer for the `updateStatus` record that bg/update-check.js writes on
 * its weekly alarm; it never runs the version check itself, so opening the popup
 * costs nothing. Sits inside .sticky-header so initHeaderSpacer() re-measures
 * and the content below is never covered.
 */

import { showToast } from './utils.js';

const DISMISS_KEY = 'updateBannerDismissed'; // version the user waved off

/**
 * Published Web Store item ID. Pinned rather than read from chrome.runtime.id:
 * a store install has the same value, but an unpacked build gets a random local
 * ID that 404s on the store. Falls back to the running ID if ever cleared.
 */
const STORE_ITEM_ID = 'hghkokkjbpedgjbpohpkgmejkeobocam';
const STORE_URL = `https://chromewebstore.google.com/detail/${STORE_ITEM_ID || chrome.runtime.id}`;

let _latest = ''; // latest version currently on screen, for the dismiss key

/** Numeric dotted-version compare. Returns 1 / 0 / -1 for a newer / same / older than b. */
function compareVersions(a, b) {
  const pa = String(a || '').split('.');
  const pb = String(b || '').split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function render() {
  const banner = document.getElementById('updateBanner');
  if (!banner) return;

  chrome.storage.local.get(['updateStatus', DISMISS_KEY], (res) => {
    const st      = res?.updateStatus;
    const running = chrome.runtime.getManifest().version;
    const latest  = st?.latestVersion || '';

    // Already on (or past) the version we were told about — the update landed,
    // so drop the stale record instead of showing a banner for it forever.
    if (st?.state === 'available' && latest && compareVersions(running, latest) >= 0) {
      chrome.storage.local.remove(['updateStatus', DISMISS_KEY]);
      banner.hidden = true;
      return;
    }

    const dismissKey = latest || 'any';
    if (st?.state !== 'available' || res[DISMISS_KEY] === dismissKey) {
      banner.hidden = true;
      return;
    }

    _latest = latest;
    const headline = document.getElementById('updateBannerHeadline');
    const sub      = document.getElementById('updateBannerSub');
    if (headline) {
      headline.textContent = latest
        ? `Version ${latest} is available`
        : 'A new version is available';
    }
    if (sub) sub.textContent = `— you have ${running}`;
    banner.hidden = false;
  });
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

  render();

  // The weekly check runs in the service worker, possibly while the popup is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.updateStatus || changes[DISMISS_KEY])) render();
  });
}
