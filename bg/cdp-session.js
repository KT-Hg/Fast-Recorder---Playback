/**
 * cdp-session.js — Tracks open CDP (debugger) sessions per tab.
 *
 * A native <select> dropdown requires a special CDP sequence: mousePressed but
 * NOT mouseReleased (detaching the debugger synthesizes mouseReleased which
 * closes the OS native popup).  This tracker lets other modules know whether
 * a session is in that half-open state so they can avoid premature detach.
 */

const _openSessions = new Set();

export function markSessionOpen(tabId)   { _openSessions.add(tabId); }
export function markSessionClosed(tabId) { _openSessions.delete(tabId); }
export function isSessionOpen(tabId)     { return _openSessions.has(tabId); }

// Evict stale entries on tab close; prevents the Set growing unbounded in
// long-running sessions where many tabs are opened and closed.
chrome.tabs.onRemoved.addListener((tabId) => {
  _openSessions.delete(tabId);
});
