/**
 * dbguard.js — run a Record & Playback run inside a DB test session.
 *
 * A scenario that drives the application under test changes its master data, and
 * putting that back by hand is the step that gets skipped. With the guard on
 * (Test sessions & rollback → Settings), every run is wrapped:
 *
 *   before  an Adminer tab on the chosen database opens a session named after
 *           the run and snapshots the chosen tables;
 *   after   the session is closed and, if asked, rolled back — the change log for
 *           anything done through Adminer, the snapshots for everything else.
 *
 * The worker cannot do any of that itself. Adminer's session cookie belongs to
 * the Adminer tab, and a request from the extension's origin is cross-site, so
 * the work is asked of the tab — the same arrangement the manager page uses.
 *
 * If no Adminer tab on that database is open, the run is refused rather than
 * started unprotected: the person turned this on because the run changes data,
 * and a run that changes it with no way back is the thing they asked to avoid.
 */

import { t, setLang } from '../dbtools/i18n.js';
import { sendAlertNotification, sendCompletionNotification } from './utils.js';

const SETTINGS_KEY = 'dbtoolsSettings';

async function readGuard() {
  const res = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = res[SETTINGS_KEY] || {};
  setLang(settings.langChosen ? settings.lang : 'en');
  // With the Adminer integration switched off there is no tab that would answer,
  // so the guard is off too — the run goes ahead unprotected rather than being
  // refused for a session nothing could have opened.
  if (settings.enabled === false) return null;
  const guard = settings.guard;
  return guard && guard.enabled && guard.key && guard.origin ? guard : null;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask whichever Adminer tab on `origin` is connected to the right database.
 * A tab on another database of the same host answers `wrongConn` and is passed
 * over; a tab caught mid-navigation does not answer at all, hence the retries.
 */
async function askAdminer(origin, message, attempts) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const tabs = await chrome.tabs.query({ url: `${origin}/*` });
    for (const tab of tabs) {
      let answer;
      try {
        answer = await chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
      } catch {
        continue;
      }
      if (answer && !answer.wrongConn) return { tabId: tab.id, answer };
    }
    if (attempt < attempts - 1) await pause(1500);
  }
  return null;
}

/**
 * Open the session before a run. Returns null when the guard is off, a handle to
 * pass to endDbGuard, or `{ refused: true }` when the run must not start.
 */
export async function beginDbGuard(label) {
  const guard = await readGuard();
  if (!guard) return null;

  const reply = await askAdminer(guard.origin, {
    type: 'dbtools-guard-begin',
    key: guard.key,
    name: `▶ ${label}`,
    tables: guard.tables || [],
  }, 2);

  if (!reply) {
    sendAlertNotification('⚠ DB', t('guard.noTab', { label: guard.label || guard.origin }), 'db_guard');
    return { refused: true };
  }
  if (!reply.answer.ok) {
    sendAlertNotification('⚠ DB', t('guard.failed', { reason: reply.answer.error || '' }), 'db_guard');
    return { refused: true };
  }
  const failed = reply.answer.errors || [];
  if (failed.length) {
    // A table that could not be snapshotted is not protected; say which, but let
    // the run go on — the others are.
    sendAlertNotification('⚠ DB', failed.map((e) => `${e.table}: ${e.reason}`).join('\n'), 'db_guard');
  }
  return { guard, sessionId: reply.answer.sessionId };
}

/** Close the run's session and, if asked, roll it back. Never throws. */
export async function endDbGuard(handle) {
  if (!handle || handle.refused) return;
  try {
    const reply = await askAdminer(handle.guard.origin, {
      type: 'dbtools-guard-end',
      key: handle.guard.key,
      sessionId: handle.sessionId,
      autoRollback: handle.guard.autoRollback !== false,
    }, 5);
    if (!reply || !reply.answer.ok) {
      sendAlertNotification('⚠ DB', t('guard.noTab', { label: handle.guard.label || handle.guard.origin }), 'db_guard');
      return;
    }
    const a = reply.answer;
    if (a.kept) {
      await sendCompletionNotification('DB', t('guard.kept', { name: a.name }), 'db_guard');
      return;
    }
    const text = t('guard.rolledBack', { ok: a.changes || 0, snaps: a.tables || 0, fail: a.failed || 0 });
    if (a.failed || (a.snapshotErrors || []).length) {
      const extra = (a.snapshotErrors || []).map((e) => `${e.table}: ${e.reason}`).join('\n');
      sendAlertNotification('⚠ DB', extra ? `${text}\n${extra}` : text, 'db_guard');
    } else {
      await sendCompletionNotification('DB', text, 'db_guard');
    }
  } catch (err) {
    console.error('[DB guard] end failed:', err);
  }
}
