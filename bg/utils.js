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

// Minimal 1×1 transparent PNG — satisfies chrome.notifications iconUrl requirement
// without a real asset file.  The MV3 service worker cannot access extension
// assets via relative URLs at notification-creation time.
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

/** Resolve {random:type:len} and {pick:val1|val2|val3} placeholders at run start. */
export function resolveRandomVars(vars) {
  const result = {};
  for (const [k, v] of Object.entries(vars)) {
    const m = typeof v === 'string' && v.match(/^\{random:(\w+):(\d+)\}$/);
    if (m) {
      const charset = _RANDOM_CHARSETS[m[1]] || _RANDOM_CHARSETS.alphanumeric;
      const len = Math.min(parseInt(m[2], 10), 512); // 512-char cap prevents DoS via huge random values
      result[k] = Array.from({ length: len }, () => charset[Math.floor(Math.random() * charset.length)]).join('');
    } else {
      // {pick:val1|val2|val3} — randomly pick one value from the pipe-separated list.
      // In CSV runs, CSV column values override baseVars before resolveRandomVars is called,
      // so this branch only fires when the CSV file has no column matching this variable name.
      const pm = typeof v === 'string' && v.match(/^\{pick:(.+)\}$/);
      if (pm) {
        const vals = pm[1].split('|').map(s => s.trim()).filter(Boolean);
        result[k] = vals.length ? vals[Math.floor(Math.random() * vals.length)] : '';
      } else {
        result[k] = v;
      }
    }
  }
  return result;
}

/** Substitute ${varName} placeholders in plain string fields. */
export function applyVars(str, vars) {
  if (typeof str !== 'string' || !vars) return str;
  return str.replace(/\$\{([^}]+)\}/g, (_, k) => (k in vars ? vars[k] : `\${${k}}`));
}

/**
 * Substitute ${varName} placeholders in script/code fields.
 *
 * Separate from applyVars because variable values injected into code strings
 * must be escaped to prevent breaking out of any JS string context
 * (single-quoted, double-quoted, or template literal).
 * Backslash must be escaped first to avoid double-escaping downstream.
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
  if (a.code)          a.code          = applyVars(a.code, vars);
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
 * Open a dropdown via a CDP trusted click.
 *
 * Native <select>: sends mousePressed only (no mouseReleased, no detach).
 * Detaching synthesizes a mouseReleased event which closes the OS native
 * dropdown popup before the user can interact with it.
 *
 * Custom dropdowns: full press+release then detach.
 *
 * A 10-second safety timeout ensures the returned Promise always resolves even
 * if chrome.debugger.attach never fires (e.g. on a crashed renderer).
 */
export function openDropdownViaCdp(tabId, selector) {
  return new Promise((resolve) => {
    const _safetyTimer = setTimeout(resolve, 10_000);
    const _safeResolve = () => { clearTimeout(_safetyTimer); resolve(); };

    chrome.tabs.get(tabId, (tab) => {
      // Do NOT call chrome.windows.update({ focused: true }) here.
      // Focusing the window would interrupt the user if they are on another tab
      // while CSV runs in the background.  CDP mousePressed works without focus
      // for most custom dropdowns; native <select> OS pickers may not open but
      // the element still receives the trusted click event.
      void tab; // tab retained for potential future use (e.g. windowId checks)
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

          // Allow a brief stabilisation period when attaching fresh; skip
          // if a session was already open to avoid visible flicker.
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
                    // Native <select>: send only mousePressed — do NOT detach here.
                    // Detaching would synthesize mouseReleased and close the popup.
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
                    // Custom dropdown: full click sequence then detach.
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

      focusAndOpen();
    });
  });
}

/** Execute arbitrary JavaScript in the page via CDP Runtime.evaluate. */
export async function runScriptViaCdp(tabId, code) {
  const expression = code.replace(/^javascript:/i, '').trim();
  return new Promise((resolve) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        // Already attached from a previous operation — reuse the session.
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
 * Get the active tab ID with a multi-layer fallback to handle edge cases where
 * no focused window is available (e.g. popup opened via keyboard shortcut):
 *  1. Focused window's active tab
 *  2. Any window's active tab on an eligible (non-chrome://) URL
 *  3. Session-stored last-known tab (survives SW suspend)
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

/** Get the current URL of a tab. Returns null on error or missing tab. */
export function getTabUrl(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) { resolve(null); return; }
      resolve(tab.url || null);
    });
  });
}

/**
 * Wait until a tab reaches status='complete' or the timeout elapses.
 * Resolves true on success, false on timeout or tab removal.
 */
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

    // Handle the case where the tab has already completed loading.
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
 * Returns a failure object on timeout so callers can distinguish
 * "no content script" from actual action failures.
 *
 * @param {number}  tabId
 * @param {object}  msg
 * @param {number}  [timeout=10_000]
 * @param {number}  [frameId]  Target a specific iframe; omit for main frame.
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

    // Default to main frame (0) when no frameId specified — prevents sub-frame
    // content scripts (all_frames: true) from racing to respond before the main frame.
    const opts = { frameId: frameId ?? 0 };

    chrome.tabs.sendMessage(tabId, msg, opts, (res) => {
      if (chrome.runtime.lastError) {
        settle({ failed: true, _noContentScript: true, error: chrome.runtime.lastError.message });
      } else {
        settle(res);
      }
    });
  });
}
