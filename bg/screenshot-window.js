/**
 * screenshot-window.js — Window capture.
 *
 * The only capture path that photographs a whole OS window rather than a page:
 * Chrome with DevTools docked, but equally VS Code, a terminal, Figma, or any
 * other application. It goes through the OS compositor (`desktopCapture` +
 * `getUserMedia`) instead of `Page.captureScreenshot`, which by design never sees
 * anything outside the page viewport.
 *
 * The worker cannot do the capture itself: `chooseDesktopMedia` has no window to
 * anchor its picker to and bails with an empty streamId, and the resulting stream
 * is bound to the render frame that asked for it. So all this module does is open
 * capture-window.html and receive the finished PNG back from it.
 *
 * Owns its own onMessage listener for the same reason bg/screenshot.js does —
 * see the note on LOCKED_MESSAGE_TYPES in background.js.
 */

import {
  openCropUI, buildScreenshotFilename, buildDateFolder, applyWatermark,
} from './screenshot.js';
import { ensureLockState, notifyLocked } from './update-check.js';
import { sendAlertNotification, updateBadge } from './utils.js';

/**
 * Big enough for Chrome's window picker to fit inside.
 *
 * The picker is a dialog owned by the window whose frame called
 * chooseDesktopMedia, and Chrome shrinks it to fit that window — at the original
 * 460x260 the thumbnail grid ate the whole dialog and the Share button was
 * clipped off the bottom, unreachable unless the user maximised the window first.
 */
const WINDOW_W = 960;
const WINDOW_H = 720;

/** Id of the open capture window, or null. Guards against opening a second one. */
let _captureWindowId = null;

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === _captureWindowId) _captureWindowId = null;
});

/**
 * Focus the existing capture window if there still is one.
 * The remembered id is verified rather than trusted: onRemoved can be missed
 * while the worker is suspended, which would otherwise wedge the feature shut.
 */
function focusExistingWindow() {
  return new Promise((resolve) => {
    if (_captureWindowId == null) { resolve(false); return; }
    chrome.windows.update(_captureWindowId, { focused: true }, () => {
      if (chrome.runtime.lastError) { _captureWindowId = null; resolve(false); return; }
      resolve(true);
    });
  });
}

/**
 * Open the capture page, carrying the request's context in its URL.
 *
 * The crop flag rides in the query string rather than in a module variable so a
 * worker suspend between the click and the capture cannot lose it — the page
 * echoes it back with the finished image.
 */
function openCaptureWindow(crop) {
  return new Promise((resolve) => {
    chrome.windows.create({
      url: chrome.runtime.getURL(`capture-window.html?crop=${crop ? 1 : 0}`),
      type: 'popup',
      width: WINDOW_W,
      height: WINDOW_H,
    }, (win) => {
      if (chrome.runtime.lastError || !win?.id) {
        resolve({ error: chrome.runtime.lastError?.message || 'Could not open the capture window' });
        return;
      }
      _captureWindowId = win.id;
      resolve({ success: true });
    });
  });
}

/**
 * Close the capture window and resolve only once it is really gone.
 *
 * Ordering matters: with save mode "ask", the next thing that happens is a
 * "Save file as" dialog, and Chrome parents that dialog to the focused browser
 * window — the capture window. Tearing it down afterwards took the dialog with
 * it, so the user never got to pick a folder. The capture path with the crop
 * editor was unaffected, which is why only saving appeared broken.
 */
function closeCaptureWindow(windowId) {
  return new Promise((resolve) => {
    const id = windowId ?? _captureWindowId;
    if (id == null) { resolve(); return; }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.windows.onRemoved.removeListener(onRemoved);
      if (id === _captureWindowId) _captureWindowId = null;
      // A beat for focus to land on a real browser window before the dialog opens.
      setTimeout(resolve, 150);
    };
    const onRemoved = (wid) => { if (wid === id) finish(); };
    chrome.windows.onRemoved.addListener(onRemoved);
    setTimeout(finish, 2000); // never block the save on a window that will not go
    chrome.windows.remove(id, () => { void chrome.runtime.lastError; });
  });
}

/**
 * Watermark, name and save the frame the capture window produced — the same
 * settings and the same date-foldered path as every other capture mode.
 *
 * The watermark stamps the timestamp only. Its {url} token is dropped rather
 * than filled: this mode photographs whatever window the user picked, which is
 * frequently not a tab and often not even a browser, so no URL describes it
 * honestly.
 */
async function handleCaptureResult({ dataUrl, crop }) {
  const settings = await chrome.storage.sync.get(['screenshotSaveMode', 'screenshotPrefix']);
  const saveMode = settings.screenshotSaveMode || 'auto';
  const prefix   = settings.screenshotPrefix   || 'screenshot';
  const filename = buildScreenshotFilename(`${prefix}_window`, null);
  const downloadPath = saveMode === 'auto' ? `screenshots/${buildDateFolder()}/${filename}` : filename;

  const stamped = await applyWatermark(dataUrl, null, '');
  if (crop) return openCropUI(stamped, downloadPath, saveMode === 'ask');

  const res = await saveDataUrl(stamped, downloadPath, saveMode === 'ask');
  if (res.cancelled) return { cancelled: true };
  if (res.error) return { error: res.error };
  return { success: true, filename };
}

/**
 * Save, telling a cancelled Save As dialog apart from a real failure.
 *
 * The shared downloadDataUrl collapses both into null, which is fine where a
 * toast reports the outcome. Here the only channel left is a notification, and
 * telling someone their capture "failed" because they closed the dialog
 * themselves is worse than saying nothing at all.
 */
function saveDataUrl(dataUrl, filename, saveAs) {
  return new Promise((resolve) => {
    chrome.downloads.download({ url: dataUrl, filename, saveAs }, (id) => {
      const err = chrome.runtime.lastError?.message || '';
      if (id != null) { resolve({ ok: true }); return; }
      resolve(/cancel/i.test(err) ? { cancelled: true } : { error: err || 'Download failed' });
    });
  });
}

const WINDOW_CAPTURE_TYPES = ['OPEN_WINDOW_CAPTURE', 'WINDOW_CAPTURE_RESULT', 'RESTORE_BADGE'];

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!WINDOW_CAPTURE_TYPES.includes(request?.type)) return;

  if (request.type === 'RESTORE_BADGE') {
    // The capture page drives the badge itself while counting down, but only the
    // worker knows what belongs there afterwards — a REC or playback badge must
    // come back rather than be cleared.
    updateBadge();
    sendResponse({ ok: true });
    return;
  }

  if (request.type === 'WINDOW_CAPTURE_RESULT') {
    // No lock check: the shot has already been taken, and refusing here would
    // only throw the user's image away.
    sendResponse({ received: true });
    (async () => {
      await closeCaptureWindow(sender.tab?.windowId);
      const result = await handleCaptureResult({
        dataUrl: request.dataUrl,
        crop:    !!request.crop,
      }).catch((e) => ({ error: e.message || 'Saving the capture failed' }));

      chrome.runtime.sendMessage({ type: 'SCREENSHOT_RESULT', result }).catch(() => {});
      // The capture window is gone and the popup was closed on click, so a
      // notification is the only place left to report a straight-to-disk save.
      // A cancelled Save As dialog is silent — the user already knows.
      if (result.error) sendAlertNotification('Window capture failed', result.error);
      else if (result.filename) sendAlertNotification('Window capture saved', result.filename);
    })();
    return; // answered synchronously above
  }

  // Awaited rather than read from cache: this message often arrives on a freshly
  // woken worker, before the cached lock state has been read back from storage.
  ensureLockState().then(async (lock) => {
    if (lock.locked) {
      notifyLocked(lock.message);
      sendResponse({ error: lock.message, locked: true });
      return;
    }
    if (await focusExistingWindow()) { sendResponse({ success: true, alreadyOpen: true }); return; }
    sendResponse(await openCaptureWindow(request.crop));
  });
  return true; // keep the channel open across the storage read
});
