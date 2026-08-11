/**
 * bg/remote-config.js — Kill-switch channel for critical releases.
 *
 * A rule baked into the extension can never reach the build that needs it: users
 * on the broken version would have to update to learn they must update. So the
 * floor lives outside the extension, in a small JSON file fetched alongside the
 * daily version check:
 *
 *   { "minVersion": "1.0.9", "hardLock": true, "message": "..." }
 *
 * Published from docs/update-config.json in this repo via GitHub Pages — see
 * docs/update-config.README.md for the operational side.
 *
 * Every failure mode is fail-open. A file that is missing, unreachable, malformed
 * or stale must never lock anyone: the whole point of the switch is to protect
 * users, and a hosting outage that bricked every install would do the opposite.
 * The last good config is cached so a brief outage doesn't drop an active lock,
 * but bounded by the staleness window in evaluateRemoteConfig().
 */

import { evaluateRemoteConfig } from './update-lock.js';

const CONFIG_URL = 'https://kt-hg.github.io/Fast-Recorder---Playback/update-config.json';

const FETCH_TIMEOUT_MS = 8000;
const MAX_MESSAGE_LEN  = 240;
const VERSION_RE = /^\d{1,5}(\.\d{1,5}){0,3}$/;

/**
 * Accept only the exact shape we expect. The response is remote input that can
 * disable the extension, so anything unrecognised is dropped rather than coerced.
 */
function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const minVersion = typeof raw.minVersion === 'string' ? raw.minVersion.trim() : '';
  if (!VERSION_RE.test(minVersion)) return null;

  const message = typeof raw.message === 'string'
    ? raw.message.trim().slice(0, MAX_MESSAGE_LEN)
    : '';

  return {
    minVersion,
    hardLock: raw.hardLock === true, // strictly boolean true, never "true"/1
    message,
    fetchedAt: Date.now(),
  };
}

/**
 * Refresh the cached config. Resolves to the config in force after the attempt —
 * the freshly fetched one, or the previous cache if the fetch failed.
 */
export async function fetchRemoteConfig() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    // no-store: GitHub Pages serves a 10-minute cache header, which would blunt
    // the point of a switch meant to take effect within hours.
    const res = await fetch(CONFIG_URL, { cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const config = sanitize(await res.json());
    if (!config) throw new Error('malformed config');

    await chrome.storage.local.set({ remoteConfig: config });
    return config;
  } catch (e) {
    // Keep whatever was cached; never escalate a network error into a lock.
    console.debug('[UPDATE] remote config fetch failed:', e?.message || e);
    return getCachedConfig();
  } finally {
    clearTimeout(timer);
  }
}

export function getCachedConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['remoteConfig'], (res) => resolve(res?.remoteConfig || null));
  });
}

/** Convenience wrapper: is the running build below a hard-locked floor right now? */
export async function getHardLock() {
  const config = await getCachedConfig();
  return evaluateRemoteConfig(config, chrome.runtime.getManifest().version);
}
