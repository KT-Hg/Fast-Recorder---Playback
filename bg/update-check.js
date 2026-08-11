/**
 * bg/update-check.js — Daily Chrome Web Store version check + update enforcement.
 *
 * Uses chrome.runtime.requestUpdateCheck(), the official API that makes Chrome
 * compare the installed version against the one published on the Web Store.
 * No extra host permission, no scraping of the store listing HTML.
 *
 * It only works for store-installed builds: an unpacked/dev install throws, and
 * that is recorded as state "unavailable" so the popup simply stays quiet
 * instead of nagging about an update it cannot verify.
 *
 * Storage (all chrome.storage.local):
 *   updateStatus         { state: "available" | "current" | "unavailable",
 *                          currentVersion, latestVersion?, checkedAt, downloaded?, reason? }
 *   updateAvailableSince ms — first sighting of the pending update. Doubles as the
 *                          "is an update pending" flag for the lock, deliberately
 *                          kept outside updateStatus: updateStatus is overwritten on
 *                          every check, so one offline check would otherwise reset
 *                          the grace clock and hand out a trivial bypass.
 *   lastUpdateAt         ms — when this install last changed version. Anchor for the
 *                          30-day deadline; written by onInstalled.
 */

import { computeLockState, LOCK_MESSAGE } from './update-lock.js';

export const UPDATE_ALARM = "updateCheckDaily";

/** Pre-1.0.9 alarm name — cleared once so it can't linger as a zombie. */
const LEGACY_ALARM = "updateCheckWeekly";

const CHECK_PERIOD_MINUTES = 24 * 60;
const CHECK_PERIOD_MS = CHECK_PERIOD_MINUTES * 60 * 1000;

function currentVersion() {
  return chrome.runtime.getManifest().version;
}

/** Numeric dotted-version compare. Returns 1 / 0 / -1 for a newer / same / older than b. */
export function compareVersions(a, b) {
  const pa = String(a || "").split(".");
  const pb = String(b || "").split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Ask Chrome whether a newer version is on the store and record the answer.
 * Never throws — every failure mode ends up in updateStatus.
 */
export async function runUpdateCheck() {
  const current = currentVersion();
  const checkedAt = Date.now();

  let result;
  try {
    result = await chrome.runtime.requestUpdateCheck();
  } catch (e) {
    // Dev install or API failure. updateAvailableSince is left alone on purpose:
    // going offline must not clear a grace clock that already started.
    await chrome.storage.local.set({
      updateStatus: { state: "unavailable", currentVersion: current, checkedAt, reason: String(e?.message || e) },
    });
    await refreshLockState();
    return;
  }

  // MV3 resolves to { status, version }; the legacy callback form passed a bare status string.
  const status  = typeof result === "string" ? result : result?.status;
  const version = typeof result === "string" ? "" : (result?.version || "");

  // Throttled: Chrome refused to ask the store this soon. Leave checkedAt
  // untouched so the startup catch-up retries instead of waiting a full day.
  if (status === "throttled") return;

  if (status === "update_available") {
    await chrome.storage.local.set({
      updateStatus: { state: "available", currentVersion: current, latestVersion: version, checkedAt },
    });
    await markUpdatePending();
    return;
  }

  await chrome.storage.local.set({
    updateStatus: { state: "current", currentVersion: current, latestVersion: current, checkedAt },
  });
  await clearUpdatePending();
}

/* === Grace-period bookkeeping === */

function localGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, (res) => resolve(res || {})));
}

/** Start the grace clock on first sighting only — later releases must not reset it. */
async function markUpdatePending() {
  const { updateAvailableSince } = await localGet(['updateAvailableSince']);
  if (!updateAvailableSince) {
    await chrome.storage.local.set({ updateAvailableSince: Date.now() });
  }
  await refreshLockState();
}

/** The user is on the newest version — stop the clock and drop the dismissal. */
async function clearUpdatePending() {
  await new Promise((r) => chrome.storage.local.remove(['updateAvailableSince', 'updateBannerDismissed'], r));
  await refreshLockState();
}

/**
 * Record that this install just changed version. Called from onInstalled, which
 * fires before any store check would — so applying an update lifts the lock
 * immediately instead of a day later.
 */
export async function markInstalledVersion() {
  await chrome.storage.local.set({ lastUpdateAt: Date.now() });
  await clearUpdatePending();
}

/**
 * Seed lastUpdateAt for installs that predate it, and drop a stale pending flag
 * when the running version has already caught up (an update applied while the
 * extension was not looking still has to lift the lock).
 */
export async function reconcileUpdateState() {
  const res = await localGet(['lastUpdateAt', 'updateAvailableSince', 'updateStatus']);
  if (!res.lastUpdateAt) {
    // Unknown install date — start the clock now rather than at epoch 0, which
    // would lock every existing user the moment they load this build.
    await chrome.storage.local.set({ lastUpdateAt: Date.now() });
  }
  const latest = res.updateStatus?.latestVersion;
  if (res.updateAvailableSince && latest && compareVersions(currentVersion(), latest) >= 0) {
    await clearUpdatePending();
    return;
  }
  await refreshLockState();
}

/* === Lock state === */

/**
 * Only the two timestamps are cached, never the derived verdict: the deadline can
 * pass while a long-running playback keeps the worker alive, and a cached verdict
 * would stay stale until the next storage write.
 */
let _anchors = null;
let _anchorsPromise = null;

async function loadAnchors() {
  const { lastUpdateAt, updateAvailableSince } = await localGet(['lastUpdateAt', 'updateAvailableSince']);
  _anchors = { lastUpdateAt, availableSince: updateAvailableSince };
  return _anchors;
}

/** Re-read the anchors from storage and return the current verdict. */
export async function refreshLockState() {
  _anchorsPromise = loadAnchors();
  await _anchorsPromise;
  return computeLockState(_anchors);
}

/**
 * Lock state for the message guards. The first call after a service-worker spawn
 * hits storage — guards must await this rather than read a cache, or a hotkey
 * that wakes the worker would slip through before the anchors are loaded.
 */
export function ensureLockState() {
  if (!_anchorsPromise) _anchorsPromise = loadAnchors();
  return _anchorsPromise.then(() => computeLockState(_anchors));
}

/** Pick up writes from another extension context (or from the popup's cleanup). */
export function initLockWatcher() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.updateAvailableSince || changes.lastUpdateAt) _anchorsPromise = loadAnchors();
  });
}

/* === Notification for blocked actions === */

let _lastLockNotice = 0;

/**
 * Tell the user why nothing happened. The popup shows a toast when it is open;
 * hotkey-triggered actions have no UI at all, hence the notification. Rate-limited
 * so a held-down hotkey can't spam the notification centre.
 */
export function notifyLocked() {
  chrome.runtime.sendMessage({ type: 'UPDATE_LOCK_BLOCKED', message: LOCK_MESSAGE }).catch(() => {});
  if (Date.now() - _lastLockNotice < 10_000) return;
  _lastLockNotice = Date.now();
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Fast Recorder & Playback — update required',
      message: LOCK_MESSAGE,
      priority: 2,
    }, () => { void chrome.runtime.lastError; });
  } catch (_) { /* notifications unavailable — the toast still fires */ }
}

/* === Alarm === */

/**
 * Create the daily alarm, replacing one left over from an older build.
 * chrome.alarms are persistent, so an install upgrading from the weekly schedule
 * already has an alarm and a plain "create if missing" check would leave it on
 * its old 7-day period forever.
 */
export function ensureUpdateAlarm() {
  chrome.alarms.clear(LEGACY_ALARM, () => { void chrome.runtime.lastError; });
  chrome.alarms.get(UPDATE_ALARM, (alarm) => {
    if (!alarm || alarm.periodInMinutes !== CHECK_PERIOD_MINUTES) {
      chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: CHECK_PERIOD_MINUTES });
    }
  });
}

/**
 * Alarms don't fire while Chrome is closed, so a browser that stays shut for a
 * day would never check. Catch up on service-worker startup instead — the
 * checkedAt stamp keeps this to at most one check per day.
 */
export function scheduleCatchUpCheck() {
  chrome.storage.local.get(["updateStatus"], (res) => {
    const last = res?.updateStatus?.checkedAt || 0;
    if (Date.now() - last >= CHECK_PERIOD_MS) runUpdateCheck();
  });
}

/** Chrome downloaded an update but can't swap it in while the extension runs. */
export function initUpdateAvailableListener() {
  chrome.runtime.onUpdateAvailable.addListener((details) => {
    chrome.storage.local.set({
      updateStatus: {
        state: "available",
        currentVersion: currentVersion(),
        latestVersion: details?.version || "",
        checkedAt: Date.now(),
        downloaded: true,
      },
    });
    markUpdatePending();
  });
}

/**
 * Apply a pending update by restarting the extension. Refused mid-run, because
 * reload() tears down recording/playback along with the service worker.
 */
export async function applyUpdate({ busy } = {}) {
  if (busy) return { success: false, error: "Finish the current recording or playback first." };
  // Nudge Chrome to fetch the CRX if it hasn't already; reload installs it.
  try { await chrome.runtime.requestUpdateCheck(); } catch { /* dev install — reload anyway */ }
  chrome.runtime.reload();
  return { success: true };
}
