/**
 * screenshot.js — Screenshot capture, CDP, watermark, image diff.
 * Exports: takeVisibleScreenshot, takeFullPageScreenshot, takeElementScreenshot,
 *          compareScreenshots, applyWatermark, downloadDataUrl, openCropUI,
 *          buildScreenshotFilename, uint8ToBase64, scriptingExec, cdpEval,
 *          captureTab, captureTabDouble
 *
 * All three public capture functions go through _queueScreenshot(tabId, fn) so
 * concurrent requests on the same tab are serialized — preventing debugger-session
 * corruption when two captures race on the same tab.
 */

import { state } from './state.js';
import { tabMsg } from './utils.js';
import { isSessionOpen, markSessionClosed } from './cdp-session.js';

/* ── Per-tab screenshot serialization queue ─────────────────────────────────────
 * Chrome's CDP debugger is attached/detached around every CDP capture. If two
 * captures race on the same tab, the second attach fires while the first session
 * is still open, producing "Another debugger is already attached" errors and
 * leaving the debugger in an indeterminate state. Serializing per-tab prevents
 * this without blocking captures on different tabs.
 * ────────────────────────────────────────────────────────────────────────────── */

const _screenshotQueues = new Map();

/**
 * Run fn() only after any in-progress screenshot on the same tab resolves.
 * Uses a promise chain so failures in fn() still allow the next queued call
 * to run — the queue never deadlocks even if a capture throws.
 */
function _queueScreenshot(tabId, fn) {
  const prev = _screenshotQueues.get(tabId) ?? Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  _screenshotQueues.set(tabId, next.catch(() => {}));
  return next;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  _screenshotQueues.delete(tabId);
});

/* ── Cancellation ───────────────────────────────────────────────────────────────
 * A full-page capture can be aborted two ways, both of which must end the SAME
 * way — a clean "cancelled" result, page restored, no error toast:
 *
 *   1. ESC on the page → content script sends CANCEL_FULL_SCREENSHOT → the capture
 *      loop checks this set at safe points and throws _CaptureCancelled.
 *   2. The debugger detaches mid-capture — most commonly the user pressing ESC /
 *      clicking "Cancel" on Chrome's "is debugging this browser" banner, which
 *      steals focus so ESC dismisses the banner instead of reaching the page.
 *      onDetach marks the tab cancelled too, so the in-flight CDP command's
 *      rejection is treated as a cancel rather than surfaced as an error.
 *
 * Membership is cleared at the start of every capture, so a stray mark left when
 * no capture is running is harmless.
 * ────────────────────────────────────────────────────────────────────────────── */
const _cancelledCaptures = new Set();

class _CaptureCancelled extends Error {
  constructor() { super('Capture cancelled'); this.name = 'CaptureCancelled'; }
}

chrome.runtime.onMessage.addListener((request, sender) => {
  if (request?.type !== 'CANCEL_FULL_SCREENSHOT') return;
  const tabId = request.tabId || sender.tab?.id;
  if (tabId != null) _cancelledCaptures.add(tabId);
});

/* ── Debugger detach safety net ─────────────────────────────────────────────────
 * When the debugger detaches for a reason outside our control (banner Cancel,
 * DevTools opening), the capture's cdpEval-based restore can no longer reach the
 * page — the scrollbar-hide style, documentElement transform, and hidden fixed
 * elements would stay applied, leaving the tab scaled and unscrollable. Restore via
 * chrome.scripting, which doesn't need the debugger, and mark the capture cancelled
 * so it resolves cleanly (see the Cancellation block above).
 *
 * Skipped when the tab itself is gone (nothing left to restore). Does not fire for
 * our own end-of-capture detach() calls, so it only triggers on real interruptions.
 * ────────────────────────────────────────────────────────────────────────────── */
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId == null) return;
  markSessionClosed(source.tabId);
  if (reason === 'target_closed') return;
  _cancelledCaptures.add(source.tabId);
  restorePageDom(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => { _cancelledCaptures.delete(tabId); });

/* ── Utilities ──────────────────────────────────────────────────────────────── */

/**
 * Convert a Uint8Array to a base64 string.
 *
 * `String.fromCharCode.apply(null, largeArray)` throws a call-stack overflow
 * for arrays larger than ~65 000 elements. Chunking at 8 192 bytes stays well
 * under that limit while still amortising the per-call overhead.
 */
export function uint8ToBase64(u8) {
  const CHUNK = 8192;
  const parts = [];
  for (let i = 0; i < u8.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(''));
}

/* ── Image Diff ─────────────────────────────────────────────────────────────── */

/**
 * Pixel-diff two screenshots and return a highlighted diff image.
 *
 * Pixels whose per-channel average deviation exceeds `threshold` (0–255) are
 * painted magenta; unchanged pixels are dimmed to 40% to make differences
 * stand out visually. Both bitmaps are normalised to the same (max) dimensions
 * so images from different viewport sizes can still be compared.
 *
 * @param {string} dataUrlA   - Base image (data URL).
 * @param {string} dataUrlB   - Comparison image (data URL).
 * @param {number} threshold  - Per-channel average diff that counts as "changed".
 * @returns {{ diffUrl: string, changed: number, total: number, pct: string }}
 */
export async function compareScreenshots(dataUrlA, dataUrlB, threshold) {
  const toBitmap = async (url) => {
    const blob = await fetch(url).then(r => r.blob());
    return createImageBitmap(blob);
  };
  const [bmA, bmB] = await Promise.all([toBitmap(dataUrlA), toBitmap(dataUrlB)]);
  const w = Math.max(bmA.width,  bmB.width);
  const h = Math.max(bmA.height, bmB.height);

  const read = (bm) => {
    const c = new OffscreenCanvas(w, h); const x = c.getContext('2d');
    x.drawImage(bm, 0, 0); return x.getImageData(0, 0, w, h);
  };
  const [dA, dB] = [read(bmA), read(bmB)];

  const out = new OffscreenCanvas(w, h);
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(w, h);
  let changed = 0;
  for (let i = 0; i < dA.data.length; i += 4) {
    const diff = (Math.abs(dA.data[i]-dB.data[i]) + Math.abs(dA.data[i+1]-dB.data[i+1]) + Math.abs(dA.data[i+2]-dB.data[i+2])) / 3;
    if (diff > threshold) {
      img.data[i]=255; img.data[i+1]=0; img.data[i+2]=220; img.data[i+3]=255;
      changed++;
    } else {
      img.data[i]=dA.data[i]*0.4; img.data[i+1]=dA.data[i+1]*0.4;
      img.data[i+2]=dA.data[i+2]*0.4; img.data[i+3]=dA.data[i+3];
    }
  }
  ctx.putImageData(img, 0, 0);
  const blob = await out.convertToBlob({ type: 'image/png' });
  const ab = await blob.arrayBuffer();
  const diffUrl = 'data:image/png;base64,' + uint8ToBase64(new Uint8Array(ab));
  return { diffUrl, changed, total: w * h, pct: ((changed / (w * h)) * 100).toFixed(2) };
}

/* ── Watermark ──────────────────────────────────────────────────────────────── */

/**
 * Stamp a semi-transparent text bar at the bottom of a screenshot.
 * Returns the original dataUrl unchanged if watermarking is disabled or fails —
 * a watermark failure must never block the capture result.
 *
 * @param {string} dataUrl - PNG data URL to stamp.
 * @param {number} tabId   - Used to read the page URL for the {url} token.
 * @returns {Promise<string>} Data URL, watermarked or original on error.
 */
export async function applyWatermark(dataUrl, tabId) {
  const settings = await new Promise(r => chrome.storage.local.get(['watermarkEnabled','watermarkFormat','watermarkFontSize'], r));
  if (!settings.watermarkEnabled) return dataUrl;
  try {
    let pageUrl = '';
    try { const t = await chrome.tabs.get(tabId); pageUrl = t.url || ''; } catch(_) {}
    const now  = new Date().toLocaleString();
    const text = (settings.watermarkFormat || '{url}  {datetime}')
      .replace(/\{url\}/g,      () => pageUrl)
      .replace(/\{datetime\}/g, () => now);
    const fontSize = Math.min(48, Math.max(8, settings.watermarkFontSize || 13));
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const barH = Math.round(fontSize * 2.2);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, bitmap.height - barH, bitmap.width, barH);
    ctx.fillStyle = '#ffffff';
    ctx.font = `${fontSize}px sans-serif`;
    ctx.fillText(text, 8, bitmap.height - Math.round(fontSize * 0.6), bitmap.width - 16);
    const outBlob = await canvas.convertToBlob({ type: 'image/png' });
    return 'data:image/png;base64,' + uint8ToBase64(new Uint8Array(await outBlob.arrayBuffer()));
  } catch (e) {
    console.warn('[WATERMARK] Failed:', e);
    return dataUrl;
  }
}

/* ── Filename Builder ───────────────────────────────────────────────────────── */

/** Returns today's date as "YYYY-MM-DD" for use as a subfolder name. */
function _buildDateFolder() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Resolve the final .png filename for a screenshot.
 * If `requestedName` is provided it is used as-is (`.png` appended if absent).
 * Otherwise a timestamped name is generated: `{prefix}_YYYY-MM-DD_HH-MM-SS.png`.
 *
 * @param {string} prefix        - Fallback prefix (e.g. "screenshot", "screenshot_full").
 * @param {string|null} requestedName - Caller-supplied override, or null for auto-name.
 * @returns {string} Resolved filename.
 */
export function buildScreenshotFilename(prefix, requestedName) {
  if (requestedName) return requestedName.endsWith('.png') ? requestedName : `${requestedName}.png`;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const d = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  const t = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `${prefix}_${d}_${t}.png`;
}

/* ── Tab Capture ────────────────────────────────────────────────────────────── */

/**
 * Capture the visible tab with a one-shot rate-limit retry.
 * Chrome throttles captureVisibleTab to ~1 call/second.
 */
export function captureTab(_retried = false) {
  return new Promise((resolve) => {
    chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        const msg = chrome.runtime.lastError.message || '';
        if (!_retried && /rate/i.test(msg)) {
          setTimeout(() => resolve(captureTab(true)), 1100);
        } else {
          resolve(null);
        }
      } else {
        resolve(dataUrl);
      }
    });
  });
}

/**
 * Capture the tab twice and return only the second frame.
 *
 * When CSS transitions or compositor animations are in-flight, the first
 * `captureVisibleTab` call may catch a partial composite pass — the result
 * looks like a torn or half-rendered frame. Discarding the first capture and
 * waiting ~80 ms (roughly five 60 Hz vsync cycles) lets the compositor finish
 * before the second — stable — frame is taken.
 */
export async function captureTabDouble() {
  await captureTab();
  await new Promise(r => setTimeout(r, 80));
  return captureTab();
}

/* ── DOM Helper Functions (injected via scripting) ──────────────────────────── */

const _hideScrollbarFn = () => {
  if (document.getElementById('__ext_no_scroll')) return;
  const s = document.createElement('style');
  s.id = '__ext_no_scroll';
  s.textContent = '::-webkit-scrollbar{display:none!important}*:not(textarea):not(input):not(select){scrollbar-width:none!important}';
  document.documentElement.appendChild(s);
};

const _showScrollbarFn = () => { document.getElementById('__ext_no_scroll')?.remove(); };

/**
 * Undo every DOM mutation a CDP capture applies to the page — hidden scrollbar,
 * documentElement/body transforms (tile-stitch shift), and hidden fixed/sticky
 * elements. Runs via chrome.scripting, so it works even after the debugger has
 * detached (when cdpEval can no longer reach the page). See _restorePageDom.
 */
const _restoreDomFn = () => {
  document.getElementById('__ext_no_scroll')?.remove();
  document.documentElement.style.transform = '';
  document.documentElement.style.transformOrigin = '';
  document.body.style.transform = '';
  document.body.style.transformOrigin = '';
  document.querySelectorAll('[data-fxhide]').forEach((el) => {
    el.style.visibility = el.getAttribute('data-fxhide') || '';
    el.removeAttribute('data-fxhide');
  });
};

/**
 * Restore the page to its pre-capture state via the Scripting API.
 *
 * Unlike the cdpEval-based restore in the capture functions, this does NOT need
 * an attached debugger — essential when the user presses ESC (or clicks Cancel
 * on Chrome's "is debugging this browser" banner) mid-capture, which force-detaches
 * the session and would otherwise leave the page transformed / unscrollable.
 */
export function restorePageDom(tabId) {
  return scriptingExec(tabId, _restoreDomFn);
}

/**
 * Inject and run `fn` in the tab's main-frame context via the Scripting API.
 * Errors are swallowed — callers that need the result should use `tabMsg` instead.
 */
export function scriptingExec(tabId, fn) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript({ target: { tabId }, func: fn }, () => resolve());
  });
}

/* ── CDP Helpers ────────────────────────────────────────────────────────────── */

/**
 * Fire-and-forget `Runtime.evaluate` via the CDP debugger.
 * Used during an already-attached CDP session to run DOM manipulation scripts
 * (hide scrollbars, reset transforms, etc.) without needing the return value.
 */
export function cdpEval(tabId, expression) {
  return new Promise((resolve) => {
    chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression, awaitPromise: false,
    }, () => resolve());
  });
}

const CDP_HIDE_SCROLLBAR = `(function(){
  if(!document.getElementById('__ext_no_scroll')){
    const s=document.createElement('style');
    s.id='__ext_no_scroll';
    s.textContent='::-webkit-scrollbar{display:none!important}*:not(textarea):not(input):not(select){scrollbar-width:none!important}';
    document.documentElement.appendChild(s);
  }
})()`;

const CDP_SHOW_SCROLLBAR = `document.getElementById('__ext_no_scroll')?.remove()`;

// Restores fixed/sticky elements hidden by the element-capture path (it tags them
// `data-fxhide`). The full-page tile-stitch path no longer hides anything — see the
// tiling loop for why fixed/sticky render correctly there on their own.
const CDP_SHOW_FIXED = `document.querySelectorAll('[data-fxhide]').forEach(el=>{
  el.style.visibility=el.getAttribute('data-fxhide');
  el.removeAttribute('data-fxhide');
})`;

/* ── Download & Crop ────────────────────────────────────────────────────────── */

/**
 * Trigger a browser download from a data URL.
 * Returns the download ID on success, or null if the download API reported an
 * error (e.g. invalid filename, disk full).
 */
export function downloadDataUrl(dataUrl, filename, saveAs) {
  return new Promise((resolve) => {
    chrome.downloads.download({ url: dataUrl, filename, saveAs }, (id) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(id);
    });
  });
}

/**
 * Open the crop editor window and stash the pending crop data in session state.
 * The editor reads `state.pendingCrop` on load, so the data must be written
 * before the window is created to avoid a race with the editor's LOAD message.
 */
export async function openCropUI(dataUrl, downloadPath, saveAs) {
  state.pendingCrop = { dataUrl, downloadPath, saveAs };
  const url = chrome.runtime.getURL('editor.html');
  chrome.windows.create({ url, type: 'popup' }, (win) => {
    chrome.windows.update(win.id, { state: 'maximized' });
  });
  return { success: true, cropping: true };
}

/* ── Visible Screenshot ─────────────────────────────────────────────────────── */

/**
 * Capture the current viewport of a tab (no scrolling, no CDP attachment).
 *
 * @param {number}  tabId             - Target tab.
 * @param {string}  saveMode          - "auto" (downloads folder) | "ask" (Save As dialog).
 * @param {string}  prefix            - Filename prefix when auto-naming.
 * @param {string|null} requestedFilename - Override filename, or null for auto.
 * @param {boolean} crop              - Open crop UI instead of saving directly.
 * @param {boolean} returnBase64      - Include raw base64 in the result object.
 * @param {boolean} skipDownload      - Capture without saving (e.g. for CSV tovar).
 * @returns {Promise<{success?: boolean, filename?: string, base64?: string, error?: string}>}
 */
export function takeVisibleScreenshot(tabId, saveMode, prefix, requestedFilename, crop = false, returnBase64 = false, skipDownload = false) {
  return _queueScreenshot(tabId, () => _takeVisibleScreenshot(tabId, saveMode, prefix, requestedFilename, crop, returnBase64, skipDownload));
}

async function _takeVisibleScreenshot(tabId, saveMode, prefix, requestedFilename, crop, returnBase64, skipDownload) {
  const filename = buildScreenshotFilename(prefix, requestedFilename);
  await scriptingExec(tabId, _hideScrollbarFn);
  let dataUrl = await captureTabDouble();
  await scriptingExec(tabId, _showScrollbarFn);
  if (!dataUrl) return { error: 'Capture failed' };
  dataUrl = await applyWatermark(dataUrl, tabId);
  if (crop) {
    const downloadPath = saveMode === 'auto' ? `screenshots/${_buildDateFolder()}/${filename}` : filename;
    return openCropUI(dataUrl, downloadPath, saveMode === 'ask');
  }
  if (!skipDownload) {
    const downloadPath = saveMode === 'auto' ? `screenshots/${_buildDateFolder()}/${filename}` : filename;
    const id = await downloadDataUrl(dataUrl, downloadPath, saveMode === 'ask');
    if (id == null) return { error: 'Download failed' };
  }
  const r = { success: true, filename };
  if (returnBase64) r.base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
  return r;
}

/* ── Full Page / Segment Screenshot ─────────────────────────────────────────── */

/**
 * Capture a full-page or partial-scroll screenshot using the CDP Debugger API.
 *
 * Uses `Emulation.setDeviceMetricsOverride` to expand the virtual viewport to
 * the full page size, then `Page.captureScreenshot` with `captureBeyondViewport`.
 * For regions exceeding 4 000 px per side (the practical CDP capture limit),
 * the page is tiled via CSS `transform: translate()` and the tiles are stitched.
 *
 * @param {number}  tabId           - Target tab.
 * @param {string}  saveMode        - "auto" | "ask".
 * @param {string}  prefix          - Auto-name prefix.
 * @param {string|null} requestedFilename - Override filename.
 * @param {boolean} crop            - Open crop UI.
 * @param {string}  scrollDir       - "full" | "vertical" | "horizontal".
 * @param {boolean} returnBase64    - Embed base64 in result.
 * @param {boolean} skipDownload    - Capture without saving.
 * @param {object|null} segmentClip - {x,y,width,height} clip rect for segment capture.
 * @param {string|null} segmentDir  - "vertical" | "horizontal" | "elem" for segment suffix.
 * @returns {Promise<{success?: boolean, filename?: string, base64?: string, error?: string}>}
 */
export function takeFullPageScreenshot(tabId, saveMode, prefix, requestedFilename, crop = false, scrollDir = 'full', returnBase64 = false, skipDownload = false, segmentClip = null, segmentDir = null) {
  return _queueScreenshot(tabId, () => _takeFullPageScreenshot(tabId, saveMode, prefix, requestedFilename, crop, scrollDir, returnBase64, skipDownload, segmentClip, segmentDir));
}

async function _takeFullPageScreenshot(tabId, saveMode, prefix, requestedFilename, crop, scrollDir, returnBase64, skipDownload, segmentClip, segmentDir) {
  const suffixMap = { full: '_full', vertical: '_scrollV', horizontal: '_scrollH', segV: '_segV', segH: '_segH', elem: '_elem' };
  const effectiveDir = segmentClip
    ? (segmentDir === 'horizontal' ? 'segH' : segmentDir === 'elem' ? 'elem' : 'segV')
    : scrollDir;
  const suffix   = requestedFilename ? '' : suffixMap[effectiveDir] || '_full';
  const filename = buildScreenshotFilename(prefix + suffix, requestedFilename);

  // Clear any stale cancel request from a prior capture, then expose a checker the
  // capture loop calls at safe points to abort cooperatively on ESC.
  _cancelledCaptures.delete(tabId);
  const _checkCancel = () => { if (_cancelledCaptures.has(tabId)) throw new _CaptureCancelled(); };

  // Full/scroll captures are normalised to 100% zoom before measuring so the saved
  // image is the standard desktop layout (and so the page dimensions read below are not
  // distorted by the zoom factor). The user's zoom is restored in both the success and
  // catch paths. Mirrors the element-capture path. Declared out here so catch can see it.
  //
  // Skipped for segment captures: the segmentClip rect was measured at the current zoom,
  // so resetting zoom (which reflows the layout) would make the clip point at the wrong
  // content. Segments instead keep the zoom and capture faithfully via the tile path
  // (see the needsStitch note below).
  const origZoom = await new Promise(r => chrome.tabs.getZoom(tabId, r));
  const zoomAdjusted = !segmentClip && Math.abs(origZoom - 1) > 0.01;
  if (zoomAdjusted) {
    // setZoom resolves as soon as the change is QUEUED, not when the renderer has
    // reflowed at the new zoom. If we measure too early the viewport is still the zoomed
    // (narrow) one. Poll getZoom until the reset has actually taken effect before measuring.
    await new Promise(r => chrome.tabs.setZoom(tabId, 1, r));
    for (let i = 0; i < 25; i++) {
      const z = await new Promise(r => chrome.tabs.getZoom(tabId, r));
      if (Math.abs(z - 1) < 0.01) break;
      await new Promise(r => setTimeout(r, 100));
    }
    // A little extra settle time for the post-reset layout reflow.
    await new Promise(r => setTimeout(r, 250));
  }

  if (!segmentClip && scrollDir === 'full') {
    // Clear any leftover transforms from a previous interrupted tile-stitch pass.
    // A non-zero scroll position or a residual translateX/Y would offset the
    // coordinates reported by GET_PAGE_DIMENSIONS, causing the capture clip to
    // be calculated against a shifted layout.
    await scriptingExec(tabId, () => {
      document.documentElement.style.transform = '';
      document.documentElement.style.transformOrigin = '';
      document.body.style.transform = '';
      document.body.style.transformOrigin = '';
      window.scrollTo(0, 0);
      document.documentElement.scrollTop  = 0;
      document.documentElement.scrollLeft = 0;
    });
    await new Promise(r => setTimeout(r, 100));
  }

  const dims = await tabMsg(tabId, { type: 'GET_PAGE_DIMENSIONS' });
  if (!dims || dims.failed) return { error: 'Could not get page dimensions' };

  const { viewportWidth, viewportHeight, scrollX, scrollY, devicePixelRatio: dpr = 1 } = dims;
  // Mutable: the full content size from the content script is only a fallback. Once the
  // debugger is attached we replace it with CDP's own Page.getLayoutMetrics value, which
  // is authoritative and zoom-safe (see below).
  let { fullWidth, fullHeight } = dims;

  try {
    // Always detach before attaching — Chrome rejects a second attach with
    // "Another debugger is already attached" even for a session from a prior
    // capture that ended normally. If our own session tracker says it is open,
    // update the tracker; otherwise probe silently (stale external session).
    if (isSessionOpen(tabId)) {
      await new Promise(r => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; r(); }));
      markSessionClosed(tabId);
      await new Promise(r => setTimeout(r, 300));
    } else {
      let staleCleaned = false;
      await new Promise(r => chrome.debugger.detach({ tabId }, () => {
        staleCleaned = !chrome.runtime.lastError; void chrome.runtime.lastError; r();
      }));
      if (staleCleaned) await new Promise(r => setTimeout(r, 300));
    }

    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });

    // Wait for the browser to acknowledge the new debugger session before sending
    // commands. Sending commands immediately after attach can silently fail on
    // slow machines or when the tab is mid-navigation.
    await new Promise(r => setTimeout(r, 1200));
    _checkCancel();

    // NOTE: we deliberately do NOT call Emulation.setDeviceMetricsOverride here.
    // The override establishes its own emulated viewport, but it does NOT cancel the
    // tab's browser zoom — the two compound, so on a zoomed page the emulated layout
    // viewport shrank (width ÷ zoom), flipping the site into its narrow/mobile
    // responsive layout and throwing the tile coordinates off (overlapping strips).
    // captureBeyondViewport already renders the full page beyond the visible area on
    // its own, so the override was never needed. Capturing at the page's natural
    // devicePixelRatio keeps the clip math and the rendered pixels in agreement at any
    // zoom — the same approach the element-capture path uses successfully.

    await new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
        awaitPromise: true, timeout: 5000,
      }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });

    await cdpEval(tabId, CDP_HIDE_SCROLLBAR);

    if (effectiveDir === 'full') {
      await cdpEval(tabId, `document.documentElement.style.transform='';document.body.style.transform='';window.scrollTo(0,0);`);
    }

    await new Promise((resolve) => {
      chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
        awaitPromise: true, timeout: 3000,
      }, () => resolve());
    });
    await new Promise(r => setTimeout(r, 300));

    // Authoritative full-page size, straight from CDP. The content-script
    // window.scrollHeight/innerWidth read earlier can lag the zoom reset, so a zoomed
    // page may report a smaller content box than Page.captureScreenshot actually
    // renders — the clip then cuts the page short. Page.getLayoutMetrics.cssContentSize
    // reports the exact CSS-px content box the capture will produce, so the clip can
    // never disagree with the rendered pixels. Falls back to the content-script dims if
    // the command is unavailable. Only the full-page size is taken from here; the
    // viewport (used for per-tile clips) stays the content-script value.
    // Effective capture viewport, measured AFTER attach. The content-script innerWidth/
    // innerHeight read before attaching does not account for the "...is debugging this
    // browser" info-bar Chrome shows once the debugger is attached, which shaves ~40px
    // off the top of the page. Tiling the page against that taller pre-attach height made
    // every captureBeyondViewport:false tile clip exceed the real viewport, leaving a
    // blank band at each row seam. cssVisualViewport is the true visible box.
    let vpW = viewportWidth, vpH = viewportHeight;
    try {
      const lm = await new Promise((resolve, reject) => {
        chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics', {}, (res) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(res);
        });
      });
      const vv = lm?.cssVisualViewport || lm?.visualViewport;
      if (vv && vv.clientWidth > 0 && vv.clientHeight > 0) {
        vpW = Math.floor(vv.clientWidth);
        vpH = Math.floor(vv.clientHeight);
      }
      // Authoritative full-page box (segment captures supply their own clip instead).
      if (!segmentClip) {
        const cs = lm?.cssContentSize || lm?.contentSize;
        if (cs && cs.width > 0 && cs.height > 0) {
          fullWidth  = Math.ceil(cs.width);
          fullHeight = Math.ceil(cs.height);
        }
      }
    } catch (_) { /* keep the content-script dims */ }

    let clipX, clipY, clipWidth, clipHeight;
    if (segmentClip) {
      ({ x: clipX, y: clipY, width: clipWidth, height: clipHeight } = segmentClip);
    } else {
      clipX      = scrollDir === 'full' ? 0 : scrollX;
      clipY      = scrollDir === 'full' ? 0 : scrollY;
      clipWidth  = scrollDir === 'vertical'   ? viewportWidth  : scrollDir === 'horizontal' ? fullWidth  - scrollX : fullWidth;
      clipHeight = scrollDir === 'horizontal' ? viewportHeight : scrollDir === 'vertical'   ? fullHeight - scrollY : fullHeight;
    }

    // CDP Page.captureScreenshot with captureBeyondViewport silently corrupts or
    // returns empty data for regions whose physical pixel dimension exceeds ~4 000.
    // Exceeding regions must be tiled and stitched instead.
    //
    // Segment captures additionally ALWAYS take the tile path, even for small regions.
    // The one-shot path uses captureBeyondViewport:true, which makes Chrome re-render
    // the page against its default layout viewport — on a zoomed page that reflows the
    // site into its narrow/mobile layout. The tile path uses captureBeyondViewport:false
    // and shifts the page with a CSS transform, so it captures exactly what is rendered
    // on screen at the current zoom — the "keep zoom, capture faithfully" behaviour.
    const MAX_CAPTURE_DIM = 4000;
    const needsStitch = !!segmentClip
      || (clipWidth * dpr > MAX_CAPTURE_DIM) || (clipHeight * dpr > MAX_CAPTURE_DIM);

    let result;
    // Set when a tiled capture is cancelled partway: we keep the rows captured so
    // far and save that partial image instead of discarding the whole capture.
    let partialCapture = false;

    if (!needsStitch) {
      _checkCancel();
      result = await new Promise((resolve, reject) => {
        chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
          format: 'png', captureBeyondViewport: true,
          clip: { x: clipX, y: clipY, width: clipWidth, height: clipHeight, scale: 1 },
        }, (res) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(res);
        });
      });
    } else {
      const cdpRafLocal = () => new Promise((resolve) => {
        chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
          awaitPromise: true, timeout: 5000,
        }, () => resolve());
      });

      const chunkW = Math.min(4000, vpW);
      const chunkH = Math.min(4000, vpH);
      const tiles  = [];

      await cdpEval(tabId, `window.scrollTo(0, 0)`);
      await cdpRafLocal();

      // Tile the page by shifting `documentElement` with CSS transform rather than
      // scrolling. Scrolling would reposition fixed/sticky elements on each tile; the
      // transform approach keeps the layout static so each tile aligns when stitched.
      //
      // Fixed and sticky elements are deliberately NOT hidden here. A transform on
      // documentElement makes it the containing block for its fixed descendants, so a
      // fixed header is positioned relative to (and translates with) the page — it
      // renders once at the top instead of repeating per tile. Sticky elements never
      // enter their stuck state at scroll 0, so they likewise render once in flow.
      // Hiding either would simply drop them from the screenshot (e.g. a site's main
      // header losing its background bar).
      let rowY = 0;
      let aborted = false;
      while (rowY < clipHeight) {
        const tileH  = Math.min(chunkH, clipHeight - rowY);
        const rowTiles = [];
        let colX = 0;
        while (colX < clipWidth) {
          // On cancel — ESC on the page, or an external detach (banner Cancel →
          // onDetach marks the tab) — stop and keep the rows captured so far rather
          // than discarding everything. Breaking before the current (incomplete) row
          // is pushed keeps the partial image a clean rectangle.
          if (_cancelledCaptures.has(tabId)) { aborted = true; break; }
          const tileW = Math.min(chunkW, clipWidth - colX);
          await cdpEval(tabId, `document.documentElement.style.transform='translate(${-(clipX+colX)}px,${-(clipY+rowY)}px)'`);
          await cdpRafLocal();
          await new Promise(r => setTimeout(r, 30));

          const cap = await new Promise((resolve) => {
            chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
              format: 'png', captureBeyondViewport: false,
              clip: { x: 0, y: 0, width: tileW, height: tileH, scale: 1 },
            }, (res) => resolve(res));
          });

          if (cap?.data) rowTiles.push({ dataUrl: `data:image/png;base64,${cap.data}`, dx: colX, dy: rowY, tileW, tileH });
          colX += tileW;
        }
        if (aborted) break;
        tiles.push(rowTiles);
        rowY += tileH;
      }

      // Height actually captured: the full clip, or how far we got before a cancel.
      // If nothing was captured (cancelled on the very first row), there is no partial
      // image to keep — fall back to a clean cancel via the catch.
      const captHeight = aborted ? rowY : clipHeight;
      if (aborted) {
        partialCapture = true;
        if (captHeight === 0) throw new _CaptureCancelled();
      }

      await cdpEval(tabId, `document.documentElement.style.transform=''`);
      await cdpEval(tabId, `window.scrollTo(${scrollX}, ${scrollY})`);
      await cdpEval(tabId, CDP_SHOW_FIXED);

      // Stitch in 4000 px bands to keep OffscreenCanvas under GPU memory limits.
      // Process strips sequentially — release each GPU texture after drawing.
      const BAND_H    = 4000;
      const allTiles  = tiles.flat();

      // Derive the real device-pixel scale from an actual captured tile rather than
      // trusting window.devicePixelRatio. Without setDeviceMetricsOverride the CDP
      // screenshot renders at the monitor's native scale, which on a browser-zoomed
      // page differs from window.devicePixelRatio (= display scale × browser zoom).
      // Using the reported dpr would size the stitch canvas too wide (or too narrow) and
      // leave half the image blank. Measuring the captured pixels keeps canvas and tiles
      // in lockstep at any zoom — the same approach the element-capture path uses.
      let stitchDpr = dpr;
      if (allTiles.length > 0 && allTiles[0].tileW > 0) {
        const probe = await createImageBitmap(await fetch(allTiles[0].dataUrl).then(r => r.blob()));
        if (probe.width > 0) stitchDpr = probe.width / allTiles[0].tileW;
        probe.close();
      }

      const bandSections = [];
      let bandY = 0;

      while (bandY < captHeight) {
        const bandH   = Math.min(BAND_H, captHeight - bandY);
        const bandEnd = bandY + bandH;
        const bandTiles = allTiles.filter(t => t.dy < bandEnd && (t.dy + t.tileH) > bandY);

        if (bandTiles.length > 0) {
          const canvas = new OffscreenCanvas(Math.round(clipWidth * stitchDpr), Math.round(bandH * stitchDpr));
          const ctx    = canvas.getContext('2d');

          for (const tile of bandTiles) {
            const bmp = await createImageBitmap(await fetch(tile.dataUrl).then(r => r.blob()));
            const srcYStart = Math.max(0, bandY - tile.dy);
            const srcYEnd   = Math.min(tile.tileH, bandEnd - tile.dy);
            const srcH      = srcYEnd - srcYStart;
            if (srcH <= 0) { bmp.close(); continue; }
            const destY = Math.max(0, tile.dy - bandY);
            ctx.drawImage(bmp,
              0, Math.round(srcYStart * stitchDpr), Math.round(tile.tileW * stitchDpr), Math.round(srcH * stitchDpr),
              Math.round(tile.dx * stitchDpr), Math.round(destY * stitchDpr), Math.round(tile.tileW * stitchDpr), Math.round(srcH * stitchDpr));
            bmp.close();
          }

          const sectionBlob = await canvas.convertToBlob({ type: 'image/png' });
          bandSections.push({ data: uint8ToBase64(new Uint8Array(await sectionBlob.arrayBuffer())), h: bandH });
        }
        bandY += bandH;
      }

      if (bandSections.length === 1) {
        result = { data: bandSections[0].data };
      } else {
        const finalCanvas = new OffscreenCanvas(Math.round(clipWidth * stitchDpr), Math.round(captHeight * stitchDpr));
        const finalCtx    = finalCanvas.getContext('2d');
        let yPos = 0;
        for (const band of bandSections) {
          const bmp = await createImageBitmap(await fetch(`data:image/png;base64,${band.data}`).then(r => r.blob()));
          finalCtx.drawImage(bmp, 0, Math.round(yPos * stitchDpr));
          bmp.close();
          yPos += band.h;
        }
        const finalBlob = await finalCanvas.convertToBlob({ type: 'image/png' });
        result = { data: uint8ToBase64(new Uint8Array(await finalBlob.arrayBuffer())) };
      }
    }

    await cdpEval(tabId, CDP_SHOW_SCROLLBAR);
    await new Promise((resolve) => {
      chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride', {}, resolve);
    });
    await new Promise((resolve) => chrome.debugger.detach({ tabId }, resolve));
    await new Promise(r => setTimeout(r, 300));

    // Restore the user's browser zoom now that the CDP capture (which required 100%)
    // is done. Detach has run, so this can no longer affect the screenshot.
    if (zoomAdjusted) {
      await new Promise(r => chrome.tabs.setZoom(tabId, origZoom, r));
    }

    if (!result?.data) return { error: 'CDP capture returned no data' };

    let dataUrl = `data:image/png;base64,${result.data}`;
    dataUrl = await applyWatermark(dataUrl, tabId);
    const downloadPath = saveMode === 'auto' ? `screenshots/${_buildDateFolder()}/${filename}` : filename;
    if (crop) return openCropUI(dataUrl, downloadPath, saveMode === 'ask');
    if (!skipDownload) {
      const id = await downloadDataUrl(dataUrl, downloadPath, saveMode === 'ask');
      if (id == null) return { error: 'Download failed' };
    }
    const r = { success: true, filename };
    if (partialCapture) r.partial = true;
    if (returnBase64) r.base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
    return r;

  } catch (e) {
    // Cancelled either cooperatively (ESC on page → _CaptureCancelled) or by an
    // external debugger detach (banner Cancel → onDetach marks _cancelledCaptures,
    // and the in-flight CDP call rejects into here). Both resolve as a clean cancel.
    const cancelled = e instanceof _CaptureCancelled || _cancelledCaptures.has(tabId);
    // On a cooperative cancel the debugger is still attached, so undo the page
    // mutations via CDP first (clean path). These cdpEval/sendCommand calls are
    // best-effort no-ops if the debugger already went away (e.g. ESC dismissed
    // Chrome's banner); restorePageDom via chrome.scripting is then the guaranteed
    // path that resets transform / scrollbar / hidden fixed elements without it.
    await cdpEval(tabId, `document.documentElement.style.transform='';document.body.style.transform='';`).catch(() => {});
    await cdpEval(tabId, CDP_SHOW_FIXED).catch(() => {});
    await cdpEval(tabId, CDP_SHOW_SCROLLBAR).catch(() => {});
    await cdpEval(tabId, `window.scrollTo(${scrollX}, ${scrollY})`).catch(() => {});
    await new Promise((resolve) => {
      chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride', {}, () => { void chrome.runtime.lastError; resolve(); });
    });
    await new Promise((resolve) => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; resolve(); }));
    markSessionClosed(tabId);
    await restorePageDom(tabId);
    if (zoomAdjusted) {
      await new Promise(r => chrome.tabs.setZoom(tabId, origZoom, r)).catch(() => {});
    }
    return cancelled ? { cancelled: true } : { error: e.message || 'Screenshot failed' };
  }
}

/* ── Element Screenshot ─────────────────────────────────────────────────────── */

/**
 * Capture a specific DOM element, scrolling in strips if it is taller than the
 * viewport. Uses CDP for precise clip coordinates so the result excludes
 * surrounding page content.
 *
 * @param {number}      tabId         - Target tab.
 * @param {string}      selector      - CSS selector fallback.
 * @param {string}      saveMode      - "auto" | "ask".
 * @param {string}      prefix        - Auto-name prefix.
 * @param {boolean}     crop          - Open crop UI.
 * @param {boolean}     returnBase64  - Embed base64 in result.
 * @param {boolean}     skipDownload  - Capture without saving.
 * @param {object|null} selectors     - Preferred locator set {fullXpath, xpath, id}.
 * @returns {Promise<{success?: boolean, filename?: string, base64?: string, error?: string}>}
 */
export function takeElementScreenshot(tabId, selector, saveMode, prefix, crop = false, returnBase64 = false, skipDownload = false, selectors = null) {
  return _queueScreenshot(tabId, () => _takeElementScreenshot(tabId, selector, saveMode, prefix, crop, returnBase64, skipDownload, selectors));
}

async function _takeElementScreenshot(tabId, selector, saveMode, prefix, crop, returnBase64, skipDownload, selectors) {
  const filename = buildScreenshotFilename(prefix + '_elem', null);

  const rect0 = await tabMsg(tabId, { type: 'GET_ELEMENT_RECT', selector, selectors });
  if (!rect0 || rect0.error) return { error: rect0?.error || 'Could not get element rect' };

  const dims = await tabMsg(tabId, { type: 'GET_PAGE_DIMENSIONS' });
  if (!dims || dims.failed) return { error: 'Could not get page dimensions' };
  const { viewportHeight, scrollX: origScrollX = 0, scrollY: origScrollY = 0 } = dims;

  // Non-1 browser zoom scales the viewport layout, which shifts getBoundingClientRect
  // values and makes clip coordinates mismatch the actual pixel positions in the
  // CDP screenshot. Reset to 100% for capture, then restore afterward.
  const origZoom = await new Promise(r => chrome.tabs.getZoom(tabId, r));
  if (Math.abs(origZoom - 1) > 0.01) {
    await new Promise(r => chrome.tabs.setZoom(tabId, 1, r));
    await new Promise(r => setTimeout(r, 300));
  }

  const cdpRaf = () => new Promise((resolve) => {
    chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
      awaitPromise: true, timeout: 5000,
    }, () => resolve());
  });

  const cdpGetRect = (sel, sels) => new Promise((resolve) => {
    const expr = `(function(){
      let el = null;
      ${sels?.fullXpath ? `try{ el = document.evaluate(${JSON.stringify(sels.fullXpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; }catch(e){}` : ''}
      ${sels?.xpath    ? `if(!el) try{ el = document.evaluate(${JSON.stringify(sels.xpath)},     document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; }catch(e){}` : ''}
      ${sels?.id       ? `if(!el) el = document.getElementById(${JSON.stringify(sels.id)});` : ''}
      if(!el) el = document.querySelector(${JSON.stringify(sel || '')});
      if(!el) return null;
      const r   = el.getBoundingClientRect();
      const sx  = document.documentElement.scrollLeft || document.body.scrollLeft || 0;
      const sy  = document.documentElement.scrollTop  || document.body.scrollTop  || 0;
      return { x: r.left + sx, y: r.top + sy, width: r.width, height: r.height,
               dpr: window.devicePixelRatio || 1, vpH: window.innerHeight };
    })()`;
    chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: expr, returnByValue: true,
    }, (res) => resolve(res?.result?.value || null));
  });

  // Process strips sequentially — release each GPU texture immediately after drawing
  // to prevent OOM on tall elements that need many strips.
  const stitchStrips = async (strips, totalWidth, totalHeight) => {
    if (!strips.length) return null;
    const firstBlob = await fetch(strips[0].dataUrl).then(r => r.blob());
    const firstBmp  = await createImageBitmap(firstBlob);
    const physDpr   = firstBmp.width / totalWidth;
    const canvas    = new OffscreenCanvas(Math.round(totalWidth * physDpr), Math.round(totalHeight * physDpr));
    const ctx       = canvas.getContext('2d');
    ctx.drawImage(firstBmp, 0, 0, firstBmp.width, firstBmp.height,
      0, Math.round(strips[0].dy * physDpr), firstBmp.width, firstBmp.height);
    firstBmp.close();
    for (let i = 1; i < strips.length; i++) {
      const bmp = await createImageBitmap(await fetch(strips[i].dataUrl).then(r => r.blob()));
      ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height,
        0, Math.round(strips[i].dy * physDpr), bmp.width, bmp.height);
      bmp.close();
    }
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  };

  try {
    // Same detach-before-attach guard as _takeFullPageScreenshot — see that function
    // for the rationale (stale sessions cause "Another debugger is already attached").
    if (isSessionOpen(tabId)) {
      await new Promise(r => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; r(); }));
      markSessionClosed(tabId);
      await new Promise(r => setTimeout(r, 300));
    } else {
      let staleCleaned = false;
      await new Promise(r => chrome.debugger.detach({ tabId }, () => {
        staleCleaned = !chrome.runtime.lastError; void chrome.runtime.lastError; r();
      }));
      if (staleCleaned) await new Promise(r => setTimeout(r, 300));
    }

    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });

    await cdpRaf();
    await cdpEval(tabId, CDP_HIDE_SCROLLBAR);
    await cdpRaf();
    await cdpEval(tabId, `document.getElementById('__picker_bar')?.remove(); document.getElementById('__picker_overlay')?.remove();`);
    await cdpRaf();

    const rect = await cdpGetRect(selector, selectors) || rect0;
    const effectiveVpH = rect.vpH || viewportHeight;

    const scrollToY = Math.max(0, rect.y - Math.max(0, (effectiveVpH - rect.height) / 2));
    await cdpEval(tabId, `window.scrollTo(${rect.x}, ${scrollToY})`);
    await cdpRaf();
    await new Promise(r => setTimeout(r, 150));

    // Hide fixed/sticky elements that fall outside the capture rect (capped at 3 000).
    const hideFixedOutside = `(function(rx,ry,rw,rh){
      const els=document.querySelectorAll('*');
      const limit=Math.min(els.length,3000);
      for(let i=0;i<limit;i++){
        const el=els[i];
        const p=getComputedStyle(el).position;
        if((p==='fixed'||p==='sticky')&&!el.hasAttribute('data-fxhide')){
          const b=el.getBoundingClientRect();
          const sx=document.documentElement.scrollLeft||document.body.scrollLeft||0;
          const sy=document.documentElement.scrollTop||document.body.scrollTop||0;
          const ex=b.left+sx,ey=b.top+sy;
          const overlaps=ex<rx+rw&&ex+b.width>rx&&ey<ry+rh&&ey+b.height>ry;
          if(!overlaps){el.setAttribute('data-fxhide',el.style.visibility);el.style.visibility='hidden';}
        }
      }
    })(${rect.x},${rect.y},${rect.width},${rect.height})`;
    await cdpEval(tabId, hideFixedOutside);
    await cdpRaf();

    const strips  = [];
    let remaining = rect.height;
    let offsetY   = 0;

    while (remaining > 0) {
      const chunkH = Math.min(remaining, effectiveVpH);
      const clipX  = rect.x, clipY = rect.y + offsetY;
      await cdpEval(tabId, `window.scrollTo(${clipX}, ${clipY})`);
      await cdpRaf();
      await new Promise(r => setTimeout(r, 100));

      const cap = await new Promise((resolve) => {
        chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
          format: 'png', captureBeyondViewport: true,
          clip: { x: clipX, y: clipY, width: rect.width, height: chunkH, scale: 1 },
        }, (res) => resolve(res));
      });

      if (cap?.data) strips.push({ dataUrl: `data:image/png;base64,${cap.data}`, dy: offsetY, clipH: chunkH });
      offsetY   += chunkH;
      remaining -= chunkH;
    }

    await cdpEval(tabId, `window.scrollTo(${origScrollX}, ${origScrollY})`);
    await cdpEval(tabId, CDP_SHOW_FIXED);

    let dataUrl = await stitchStrips(strips, rect.width, rect.height);

    await cdpEval(tabId, CDP_SHOW_SCROLLBAR);
    await new Promise((r) => chrome.debugger.detach({ tabId }, r));
    await new Promise(r => setTimeout(r, 300));

    if (Math.abs(origZoom - 1) > 0.01) {
      await new Promise(r => chrome.tabs.setZoom(tabId, origZoom, r));
    }

    dataUrl = await applyWatermark(dataUrl, tabId);
    const downloadPath = saveMode === 'auto' ? `screenshots/${_buildDateFolder()}/${filename}` : filename;
    if (crop) return openCropUI(dataUrl, downloadPath, saveMode === 'ask');
    if (!skipDownload) {
      const id = await downloadDataUrl(dataUrl, downloadPath, saveMode === 'ask');
      if (id == null) return { error: 'Download failed' };
    }
    const r = { success: true, filename };
    if (returnBase64) r.base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
    return r;

  } catch (e) {
    // See _takeFullPageScreenshot's catch: restore via chrome.scripting so the
    // page recovers even if the debugger detached mid-capture (e.g. ESC / banner).
    await new Promise((r) => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; r(); }));
    markSessionClosed(tabId);
    await restorePageDom(tabId);
    if (Math.abs(origZoom - 1) > 0.01) {
      await new Promise(r => chrome.tabs.setZoom(tabId, origZoom, r)).catch(() => {});
    }
    return { error: e.message || 'Screenshot failed' };
  }
}

/* ── Screenshot Message Handler ─────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const FULL_TYPES   = ['TAKE_SCREENSHOT_FULL', 'TAKE_SCREENSHOT_SCROLL_V', 'TAKE_SCREENSHOT_SCROLL_H'];
  const ALL_SS_TYPES = [...FULL_TYPES, 'TAKE_SCREENSHOT', 'TAKE_SCREENSHOT_ELEMENT'];
  if (!ALL_SS_TYPES.includes(request.type)) return;

  const tabId = request.tabId || sender.tab?.id;
  if (!tabId) { sendResponse({ error: 'No tab ID' }); return true; }

  if (request.type === 'TAKE_SCREENSHOT_ELEMENT') {
    chrome.storage.sync.get(['screenshotSaveMode', 'screenshotPrefix'], (settings) => {
      const saveMode = settings.screenshotSaveMode || 'auto';
      const prefix   = settings.screenshotPrefix   || 'screenshot';
      takeElementScreenshot(tabId, request.selector, saveMode, prefix, !!request.crop, false, false, request.selectors)
        .then((result) => {
          sendResponse(result);
          chrome.runtime.sendMessage({ type: 'SCREENSHOT_RESULT', result }).catch(() => {});
        }).catch(e => sendResponse({ error: e.message }));
    });
    return true;
  }

  chrome.storage.sync.get(['screenshotSaveMode', 'screenshotPrefix'], (settings) => {
    const saveMode = settings.screenshotSaveMode || 'auto';
    const prefix   = settings.screenshotPrefix   || 'screenshot';
    const crop     = !!request.crop;
    const dirMap   = {
      TAKE_SCREENSHOT_FULL:     'full',
      TAKE_SCREENSHOT_SCROLL_V: 'vertical',
      TAKE_SCREENSHOT_SCROLL_H: 'horizontal',
    };
    const isFull = FULL_TYPES.includes(request.type);
    // Tell the page a cancellable capture is running so ESC can abort it. Toggled
    // off when the task settles — done at this single choke point so every exit
    // path (success, error, cancel) clears it.
    if (isFull) tabMsg(tabId, { type: 'FULL_CAPTURE_STATE', active: true }).catch(() => {});
    const task = isFull
      ? takeFullPageScreenshot(tabId, saveMode, prefix, request.filename, crop, dirMap[request.type])
      : takeVisibleScreenshot(tabId, saveMode, prefix, request.filename, crop);
    task.then((result) => {
      sendResponse(result);
      chrome.runtime.sendMessage({ type: 'SCREENSHOT_RESULT', result }).catch(() => {});
    }).catch(e => sendResponse({ error: e.message }))
      .finally(() => { if (isFull) tabMsg(tabId, { type: 'FULL_CAPTURE_STATE', active: false }).catch(() => {}); });
  });

  return true;
});
