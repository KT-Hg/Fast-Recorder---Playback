/**
 * bg/update-lock.js — Grace-period math for the "update or lose the features" rule.
 *
 * Pure functions only, no chrome.* calls, so the service worker and the popup can
 * both import it and can never disagree about whether the extension is locked.
 *
 * The rule: once the Web Store has a newer version, the user gets until
 * `lastUpdateAt + GRACE_MS` to install it. After that, capture / recording /
 * playback refuse to start until the update is applied.
 *
 * MIN_GRACE_MS exists because the deadline is anchored to the last *install*,
 * not to the release: someone who has been sitting on the newest build for
 * two months would otherwise be locked out the moment a new version ships,
 * with no warning window at all. The deadline is therefore the later of
 * "30 days since you last updated" and "7 days since there was anything to
 * update to".
 */

export const DAY_MS       = 24 * 60 * 60 * 1000;
export const GRACE_MS     = 30 * DAY_MS; // since the user's last install/update
export const MIN_GRACE_MS =  7 * DAY_MS; // floor, measured from first sighting
export const WARN_MS      =  5 * DAY_MS; // countdown banner turns urgent

/** Shown wherever a blocked action needs to explain itself. */
export const LOCK_MESSAGE =
  'Update required — install the latest version to use recording, playback and screenshots again.';

/**
 * @param {Object}  o
 * @param {number} [o.lastUpdateAt]   ms — when this install last changed version
 * @param {number} [o.availableSince] ms — when a pending update was first seen
 * @param {number} [o.now]
 * @returns {{pending: boolean, locked: boolean, warning: boolean,
 *            daysLeft: number|null, deadline: number|null}}
 */
export function computeLockState({ lastUpdateAt, availableSince, now = Date.now() } = {}) {
  // No confirmed pending update — nothing to enforce. This is also the state of
  // every unpacked/dev build, which can never be version-checked.
  if (!availableSince) {
    return { pending: false, locked: false, warning: false, daysLeft: null, deadline: null };
  }

  const anchor   = lastUpdateAt || availableSince;
  const deadline = Math.max(anchor + GRACE_MS, availableSince + MIN_GRACE_MS);
  const msLeft   = deadline - now;

  return {
    pending:  true,
    locked:   msLeft <= 0,
    warning:  msLeft > 0 && msLeft <= WARN_MS,
    daysLeft: Math.max(0, Math.ceil(msLeft / DAY_MS)),
    deadline,
  };
}
