/**
 * utils.js — Shared helpers for the background service worker
 * Exports: updateBadge, sendCompletionNotification,
 *          applyVars, interpolateAction,
 *          runScriptViaCdp, getActiveTabId, tabMsg
 */

import { state } from './state.js';

/* === BADGE === */

export function updateBadge() {
  let text = "";
  let color = "#6b7280"; // gray — idle

  if (state.pickMode) {
    text = "PICK";
    color = "#6366f1"; // indigo
  } else if (state.recording) {
    text = "REC";
    color = "#ef4444"; // red
  } else if (state.csvPlayback.active) {
    text = "CSV";
    color = "#3b82f6"; // blue
  } else if (state.sequencePlayback.active) {
    text = "SEQ";
    color = "#f97316"; // orange
  } else if (state.playback.active) {
    text = "▶";
    color = "#22c55e"; // green
  }

  chrome.action.setBadgeText({ text });
  if (text) chrome.action.setBadgeBackgroundColor({ color });
}

/* === NOTIFICATIONS === */

const _NOTIF_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAbElEQVR42mNkYGBg+E8BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPhhFAABAAD//wMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+gBkAAAAAAASUVORK5CYII=";

export async function sendCompletionNotification(title, message) {
  const res = await new Promise((r) => chrome.storage.sync.get(["notifyOnComplete"], r));
  if (!res.notifyOnComplete) return;
  chrome.notifications.create("completion_" + Date.now(), {
    type: "basic",
    iconUrl: _NOTIF_ICON,
    title: title || "Playback complete",
    message: message || "",
  }, () => { void chrome.runtime.lastError; });
}

/* === VARIABLE INTERPOLATION === */

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
  if (typeof str !== "string" || !vars) return str;
  return str.replace(/\$\{([^}]+)\}/g, (_, k) => (k in vars ? vars[k] : `\${${k}}`));
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
    if (a.conditions.valueEquals  != null) a.conditions.valueEquals  = applyVars(String(a.conditions.valueEquals),  vars);
    if (a.conditions.textContains != null) a.conditions.textContains = applyVars(String(a.conditions.textContains), vars);
    if (a.conditions.idContains   != null) a.conditions.idContains   = applyVars(String(a.conditions.idContains),   vars);
    if (a.conditions.classContains != null) a.conditions.classContains = applyVars(String(a.conditions.classContains), vars);
  }
  return a;
}

/* === CDP SCRIPT EXECUTION (bypasses page CSP) === */

// Detach debugger if attached (silently ignores if not attached)
export function tryDetachDebugger(tabId) {
  chrome.debugger.detach({ tabId }, () => { chrome.runtime.lastError; /* suppress */ });
}

// Open a dropdown via CDP.
// For native <select>: focuses the tab window first (extension popup closing drops window focus
// which causes the native dropdown to close), then sends mousePressed only (no mouseReleased,
// no detach — detach synthesizes mouseReleased and closes the dropdown).
// For custom dropdowns: full click then detach normally.
export function openDropdownViaCdp(tabId, selector) {
  return new Promise((resolve) => {
    // Focus the tab's window so the native select popup doesn't close due to lost window focus
    chrome.tabs.get(tabId, (tab) => {
      const focusAndOpen = () => {
        chrome.debugger.attach({ tabId }, "1.3", () => {
          const alreadyAttached = !!chrome.runtime.lastError;
          const done = () => { if (!alreadyAttached) chrome.debugger.detach({ tabId }, () => {}); resolve(); };

          // If freshly attached, the "started debugging" banner appears after a short delay
          // and steals window focus, closing any native dropdown we already opened.
          // Wait for the banner to settle before sending the mouse event.
          const delay = alreadyAttached ? 0 : 700;

          setTimeout(() => chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
            expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' }); const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width/2, y: r.top + r.height/2, isSelect: el.tagName === 'SELECT' }); })()`,
            returnByValue: true,
          }, (rectRes) => {
            let info = null;
            try { info = JSON.parse(rectRes?.result?.value); } catch (_) {}
            if (!info) { done(); return; }

            const x = Math.round(info.x);
            const y = Math.round(info.y);

            if (info.isSelect) {
              // Native <select>: mousePressed only, no mouseReleased, no detach.
              // mouseReleased or detach both cause Chrome to close the popup.
              chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent",
                { type: "mousePressed", x, y, button: "left", clickCount: 1, modifiers: 0 },
                resolve
              );
            } else {
              // Custom dropdown: full click then detach
              chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent",
                { type: "mousePressed", x, y, button: "left", clickCount: 1, modifiers: 0 },
                () => chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent",
                  { type: "mouseReleased", x, y, button: "left", clickCount: 1, modifiers: 0 },
                  done
                )
              );
            }
          }), delay);
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
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) {
        // Already attached — evaluate directly without detaching
        chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
          expression, awaitPromise: false,
        }, () => resolve());
        return;
      }
      chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression, awaitPromise: false,
      }, () => {
        chrome.debugger.detach({ tabId }, () => resolve());
      });
    });
  });
}

/* === TAB HELPERS === */

export function getActiveTabId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0]?.id || null);
    });
  });
}

export function tabMsg(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(res);
    });
  });
}
