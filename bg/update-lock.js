/**
 * bg/update-lock.js — Grace-period math for the "update or lose the features" rule.
 *
 * Pure functions only, no chrome.* calls, so the service worker and the popup can
 * both import it and can never disagree about whether the extension is locked.
 *
 * Two ways to end up locked:
 *
 *   overdue  — the Web Store has a newer version and the user let the grace period
 *              run out. Deadline is `lastUpdateAt + GRACE_MS`.
 *   critical — the remote config (bg/remote-config.js) declares the running version
 *              below `minVersion` with `hardLock`, e.g. a security fix. No grace.
 *
 * MIN_GRACE_MS exists because the ordinary deadline is anchored to the last
 * *install*, not to the release: someone who has been sitting on the newest build
 * for two months would otherwise be locked out the moment a new version ships,
 * with no warning window at all. The deadline is therefore the later of "30 days
 * since you last updated" and "7 days since there was anything to update to".
 */

export const DAY_MS       = 24 * 60 * 60 * 1000;
export const GRACE_MS     = 30 * DAY_MS; // since the user's last install/update
export const MIN_GRACE_MS =  7 * DAY_MS; // floor, measured from first sighting
export const WARN_MS      =  5 * DAY_MS; // countdown banner turns urgent

/** Shown wherever a blocked action needs to explain itself. */
export const LOCK_MESSAGE =
  'Update required — install the latest version to use recording, playback and screenshots again.';

export const CRITICAL_LOCK_MESSAGE =
  'Critical update required — install the latest version to use recording, playback and screenshots again.';

/** Numeric dotted-version compare. Returns 1 / 0 / -1 for a newer / same / older than b. */
export function compareVersions(a, b) {
  const pa = String(a || '').split('.');
  const pb = String(b || '').split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * @param {Object}  o
 * @param {number} [o.lastUpdateAt]   ms — when this install last changed version
 * @param {number} [o.availableSince] ms — when a pending update was first seen
 * @param {boolean}[o.hardLock]       remote config demands this version be replaced now
 * @param {number} [o.now]
 * @returns {{pending: boolean, locked: boolean, warning: boolean, critical: boolean,
 *            daysLeft: number|null, deadline: number|null}}
 */
export function computeLockState({ lastUpdateAt, availableSince, hardLock = false, now = Date.now() } = {}) {
  // No confirmed pending update — nothing to enforce, and deliberately not even
  // for a hard lock: if Chrome cannot see a newer version on the store, locking
  // would strand the user with no way out. It is also the only thing standing
  // between a bad (or tampered-with) config file and every install going dark.
  // This is not a real limit on the kill-switch: a critical release is on the
  // store by definition, so requestUpdateCheck() reports it.
  // Unpacked/dev builds never get here either — they cannot be version-checked.
  if (!availableSince) {
    return { pending: false, locked: false, warning: false, critical: false, daysLeft: null, deadline: null };
  }

  if (hardLock) {
    return { pending: true, locked: true, warning: false, critical: true, daysLeft: 0, deadline: availableSince };
  }

  const anchor   = lastUpdateAt || availableSince;
  const deadline = Math.max(anchor + GRACE_MS, availableSince + MIN_GRACE_MS);
  const msLeft   = deadline - now;

  return {
    pending:  true,
    locked:   msLeft <= 0,
    warning:  msLeft > 0 && msLeft <= WARN_MS,
    critical: false,
    daysLeft: Math.max(0, Math.ceil(msLeft / DAY_MS)),
    deadline,
  };
}

/**
 * Decide whether a cached remote config still demands a hard lock.
 *
 * Separate from computeLockState so both the worker and the popup reach the same
 * verdict from the same stored record. Everything about this function is
 * fail-open: an absent, malformed, expired or satisfied config means no lock.
 *
 * @param {Object|null} config  as stored by bg/remote-config.js
 * @param {string} runningVersion
 * @param {number} [staleMs] treat a config not refreshed within this window as expired
 * @returns {{hardLock: boolean, message: string}}
 */
export function evaluateRemoteConfig(config, runningVersion, staleMs = 7 * DAY_MS, now = Date.now()) {
  const none = { hardLock: false, message: '' };
  if (!config || config.hardLock !== true || !config.minVersion) return none;

  // A config that has not refreshed in a week is treated as abandoned rather than
  // eternal — otherwise taking the file down would never lift the lock.
  if (!config.fetchedAt || now - config.fetchedAt > staleMs) return none;

  if (compareVersions(runningVersion, config.minVersion) >= 0) return none;

  return { hardLock: true, message: config.message || CRITICAL_LOCK_MESSAGE };
}
