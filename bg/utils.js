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
  return a;
}

/* === CDP SCRIPT EXECUTION (bypasses page CSP) === */

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
