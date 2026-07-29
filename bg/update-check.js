/**
 * bg/update-check.js — Weekly Chrome Web Store version check.
 *
 * Uses chrome.runtime.requestUpdateCheck(), the official API that makes Chrome
 * compare the installed version against the one published on the Web Store.
 * No extra host permission, no scraping of the store listing HTML.
 *
 * It only works for store-installed builds: an unpacked/dev install throws, and
 * that is recorded as state "unavailable" so the popup simply stays quiet
 * instead of nagging about an update it cannot verify.
 *
 * The single source of truth is chrome.storage.local.updateStatus:
 *   { state: "available" | "current" | "unavailable",
 *     currentVersion, latestVersion?, checkedAt, downloaded?, reason? }
 */

export const UPDATE_ALARM = "updateCheckWeekly";

const CHECK_PERIOD_MINUTES = 7 * 24 * 60;
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
    await chrome.storage.local.set({
      updateStatus: { state: "unavailable", currentVersion: current, checkedAt, reason: String(e?.message || e) },
    });
    return;
  }

  // MV3 resolves to { status, version }; the legacy callback form passed a bare status string.
  const status  = typeof result === "string" ? result : result?.status;
  const version = typeof result === "string" ? "" : (result?.version || "");

  // Throttled: Chrome refused to ask the store this soon. Leave checkedAt
  // untouched so the startup catch-up retries instead of waiting a full week.
  if (status === "throttled") return;

  if (status === "update_available") {
    await chrome.storage.local.set({
      updateStatus: { state: "available", currentVersion: current, latestVersion: version, checkedAt },
    });
    return;
  }

  await chrome.storage.local.set({
    updateStatus: { state: "current", currentVersion: current, latestVersion: current, checkedAt },
  });
}

/** Create the weekly alarm once; recreating it would reset its period every SW start. */
export function ensureUpdateAlarm() {
  chrome.alarms.get(UPDATE_ALARM, (alarm) => {
    if (!alarm) chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: CHECK_PERIOD_MINUTES });
  });
}

/**
 * Alarms don't fire while Chrome is closed, so a browser that stays shut for a
 * week would never check. Catch up on service-worker startup instead — the
 * checkedAt stamp keeps this to at most one check per week.
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
