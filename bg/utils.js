/**
 * utils.js — Shared helpers for the background service worker.
 * Exports: updateBadge, sendCompletionNotification,
 *          applyVars, interpolateAction, resolveRandomVars,
 *          runScriptViaCdp, openDropdownViaCdp, tryDetachDebugger,
 *          getActiveTabId, getTabUrl, waitForTabLoad, tabMsg
 */

import { state } from './state.js';
import { markSessionOpen, markSessionClosed } from './cdp-session.js';

/* ── Badge ─────────────────────────────────────────────────────────────────── */

export function updateBadge() {
  let text = '';
  let color = '#6b7280';

  if (state.pickMode)              { text = 'PICK'; color = '#6366f1'; }
  else if (state.recording)        { text = 'REC';  color = '#ef4444'; }
  else if (state.csvPlayback.active)      { text = 'CSV';  color = '#3b82f6'; }
  else if (state.sequencePlayback.active) { text = 'SEQ';  color = '#f97316'; }
  else if (state.playback.active)  { text = '▶';    color = '#22c55e'; }

  chrome.action.setBadgeText({ text });
  if (text) chrome.action.setBadgeBackgroundColor({ color });
}

/* ── Notifications ──────────────────────────────────────────────────────────── */

const _NOTIF_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAbElEQVR42mNkYGBg+E8BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPhhFAABAAD//wMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+gBkAAAAAAASUVORK5CYII=';

export async function sendCompletionNotification(title, message) {
  const res = await new Promise((r) => chrome.storage.sync.get(['notifyOnComplete'], r));
  if (!res.notifyOnComplete) return;
  chrome.notifications.create('completion_' + Date.now(), {
    type: 'basic', iconUrl: _NOTIF_ICON,
    title: title || 'Playback complete',
    message: message || '',
  }, () => { void chrome.runtime.lastError; });
}

/* ── Variable Interpolation ─────────────────────────────────────────────────── */

const _RANDOM_CHARSETS = {
  alpha:        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  numeric:      '0123456789',
  alphanumeric: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
};

export function resolveRandomVars(vars) {
  const result = {};
  for (const [k, v] of Object.entries(vars)) {
    const m = typeof v === 'string' && v.match(/^\{random:(\w+):(\d+)\}$/);
    if (m) {
      const charset = _RANDOM_CHARSETS[m[1]] || _RANDOM_CHARSETS.alphanumeric;
      const len = Math.min(parseInt(m[2], 10), 512);
      result[k] = Array.from({ length: len }, () => charset[Math.floor(Math.random() * charset.length)]).join('');
    } else {
      result[k] = v;
    }
  }
  return result;
}

export function applyVars(str, vars) {
  if (typeof str !== 'string' || !vars) return str;
  return str.replace(/\$\{([^}]+)\}/g, (_, k) => (k in vars ? vars[k] : `\${${k}}`));
}

/**
 * Safe code-field substitution — escapes the variable value so it cannot break
 * out of any JS string context (single-quoted, double-quoted, or template literal).
 * Backslash must be escaped first to avoid double-escaping.
 */
function _applyVarsToCode(code, vars) {
  if (typeof code !== 'string' || !vars) return code;
  return code.replace(/\$\{([^}]+)\}/g, (match, k) => {
    if (!(k in vars)) return match;
    return String(vars[k])
      .replace(/\\/g,  '\\\\')
      .replace(/"/g,   '\\"')
      .replace(/'/g,   "\\'")
      .replace(/`/g,   '\\`')
      .replace(/\$\{/g, '\\${')
      .replace(/\n/g,  '\\n')
      .replace(/\r/g,  '\\r');
  });
}

export function interpolateAction(action, vars) {
  if (!vars || !Object.keys(vars).length) return action;
  const a = { ...action };
  if (a.selector)      a.selector      = applyVars(a.selector, vars);
  if (a.value)         a.value         = applyVars(a.value, vars);
  if (a.url)           a.url           = applyVars(a.url, vars);
  if (a.code)          a.code          = _applyVarsToCode(a.code, vars);
  if (a.expectedValue) a.expectedValue = applyVars(a.expectedValue, vars);
  if (a.switchVar)     a.switchVar     = applyVars(a.switchVar, vars);
  if (a.conditions && typeof a.conditions === 'object') {
    a.conditions = { ...a.conditions };
    if (a.conditions.valueEquals   != null) a.conditions.valueEquals   = applyVars(String(a.conditions.valueEquals),   vars);
    if (a.conditions.textContains  != null) a.conditions.textContains  = applyVars(String(a.conditions.textContains),  vars);
    if (a.conditions.idContains    != null) a.conditions.idContains    = applyVars(String(a.conditions.idContains),    vars);
    if (a.conditions.classContains != null) a.conditions.classContains = applyVars(String(a.conditions.classContains), vars);
  }
  return a;
}

/* ── CDP Script Execution ───────────────────────────────────────────────────── */

export function tryDetachDebugger(tabId) {
  chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; });
}

/**
 * Open a dropdown via CDP trusted click.
 *
 * For native <select>: sends mousePressed only (no mouseReleased, no detach —
 * detaching synthesizes mouseReleased and closes the OS native dropdown popup).
 * For custom dropdowns: full click then detach.
 *
 * A 10-second safety timeout ensures the returned Promise always resolves even
 * if chrome.debugger.attach never fires (e.g. on a crashed renderer).
 */
export function openDropdownViaCdp(tabId, selector) {
  return new Promise((resolve) => {
    // Safety net: always resolve within 10 s regardless of CDP state.
    const _safetyTimer = setTimeout(resolve, 10_000);
    const _safeResolve = () => { clearTimeout(_safetyTimer); resolve(); };

    chrome.tabs.get(tabId, (tab) => {
      const focusAndOpen = () => {
        chrome.debugger.attach({ tabId }, '1.3', () => {
          const alreadyAttached = !!chrome.runtime.lastError;

          let _doneCalled = false;
          const done = () => {
            if (_doneCalled) return;
            _doneCalled = true;
            if (!alreadyAttached) {
              chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; });
            }
            _safeResolve();
          };

          const delay = alreadyAttached ? 0 : 700;

          setTimeout(() => {
            try {
              chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
                expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' }); const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width/2, y: r.top + r.height/2, isSelect: el.tagName === 'SELECT' }); })()`,
                returnByValue: true,
              }, (rectRes) => {
                try {
                  let info = null;
                  try { info = JSON.parse(rectRes?.result?.value); } catch (_) {}
                  if (!info) { done(); return; }

                  const x = Math.round(info.x);
                  const y = Math.round(info.y);

                  if (info.isSelect) {
                    chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent',
                      { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers: 0 },
                      () => {
                        if (chrome.runtime.lastError) { done(); return; }
                        markSessionOpen(tabId);
                        _safeResolve();
                        _doneCalled = true;
                      },
                    );
                  } else {
                    markSessionClosed(tabId);
                    chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent',
                      { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers: 0 },
                      () => {
                        if (chrome.runtime.lastError) { done(); return; }
                        chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent',
                          { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers: 0 },
                          () => done(),
                        );
                      },
                    );
                  }
                } catch (innerErr) {
                  console.error('[CDP] openDropdownViaCdp inner error:', innerErr);
                  done();
                }
              });
            } catch (outerErr) {
              console.error('[CDP] openDropdownViaCdp outer error:', outerErr);
              done();
            }
          }, delay);
        });
      };

      if (tab?.windowId) {
        chrome.windows.update(tab.windowId, { focused: true }, focusAndOpen);
      } else {
        focusAndOpen();
      }
    });
  });
}

export async function runScriptViaCdp(tabId, code) {
  const expression = code.replace(/^javascript:/i, '').trim();
  return new Promise((resolve) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression, awaitPromise: false,
        }, () => { void chrome.runtime.lastError; resolve(); });
        return;
      }
      chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression, awaitPromise: false,
      }, () => {
        void chrome.runtime.lastError;
        chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; resolve(); });
      });
    });
  });
}

/* ── Tab Helpers ────────────────────────────────────────────────────────────── */

/**
 * Get the active tab ID with multi-layer fallback:
 *  1. Focused window active tab
 *  2. Any window's active non-chrome tab
 *  3. Session-stored last-known tab
 */
export function getActiveTabId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs?.[0]?.id) {
        const id = tabs[0].id;
        chrome.storage.session?.set({ _lastActiveTabId: id }).catch?.(() => {});
        return resolve(id);
      }

      chrome.tabs.query({ active: true }, (allTabs) => {
        const eligible = (allTabs || []).filter(t =>
          t.id && t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'),
        );
        if (eligible[0]?.id) {
          const id = eligible[0].id;
          chrome.storage.session?.set({ _lastActiveTabId: id }).catch?.(() => {});
          return resolve(id);
        }

        if (chrome.storage.session) {
          chrome.storage.session.get(['_lastActiveTabId'], (res) => {
            const id = res?._lastActiveTabId || null;
            if (id) console.warn('[UTILS] getActiveTabId: using last-known tab', id);
            resolve(id);
          });
        } else {
          resolve(null);
        }
      });
    });
  });
}

/** Get the current URL of a tab (returns null on error). */
export function getTabUrl(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) { resolve(null); return; }
      resolve(tab.url || null);
    });
  });
}

/** Wait until tab status = 'complete' or timeout. Resolves true on success, false otherwise. */
export function waitForTabLoad(tabId, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (ok) => {
      if (resolved) return;
      resolved = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
      resolve(ok);
    };

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) { finish(false); return; }
      if (tab?.status === 'complete') { finish(true); return; }
    });

    const onUpdated = (updatedId, changeInfo) => {
      if (updatedId === tabId && changeInfo.status === 'complete') finish(true);
    };
    const onRemoved = (removedId) => {
      if (removedId === tabId) finish(false);
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

/**
 * Send a message to the content script on a tab with a hard timeout.
 *
 * @param {number}  tabId
 * @param {object}  msg
 * @param {number}  [timeout=10_000]
 * @param {number}  [frameId]  When provided, message is delivered only to that
 *                             specific frame. Omit to target the main frame.
 */
export function tabMsg(tabId, msg, timeout = 10_000, frameId = undefined) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };

    const timer = setTimeout(() => {
      settle({ failed: true, _noContentScript: true, error: 'tabMsg timeout' });
    }, timeout);

    const opts = (frameId != null) ? { frameId } : {};

    chrome.tabs.sendMessage(tabId, msg, opts, (res) => {
      if (chrome.runtime.lastError) {
        settle({ failed: true, _noContentScript: true, error: chrome.runtime.lastError.message });
      } else {
        settle(res);
      }
    });
  });
}
