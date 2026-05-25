/** cdp-session.js — Native-select CDP session tracker */

const _openSessions = new Set();

export function markSessionOpen(tabId)   { _openSessions.add(tabId); }
export function markSessionClosed(tabId) { _openSessions.delete(tabId); }
export function isSessionOpen(tabId)     { return _openSessions.has(tabId); }

// Clean up when a tab is closed so the set doesn't accumulate stale entries.
chrome.tabs.onRemoved.addListener((tabId) => {
  _openSessions.delete(tabId);
});
