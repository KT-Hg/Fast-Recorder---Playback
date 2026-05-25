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

/* ── Per-tab screenshot serialization queue (P0-E fix) ──────────────────────── */

const _screenshotQueues = new Map();

/**
 * Run fn() after any previous screenshot on the same tab finishes.
 * If the previous call fails, fn() still runs so the queue never stalls.
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

/* ── Utilities ──────────────────────────────────────────────────────────────── */

export function uint8ToBase64(u8) {
  const CHUNK = 8192;
  const parts = [];
  for (let i = 0; i < u8.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(''));
}

/* ── Image Diff ─────────────────────────────────────────────────────────────── */

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
 * Discard first frame (may contain compositor artifacts), wait one vsync cycle,
 * then capture the stable second frame.
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
  s.textContent = '::-webkit-scrollbar{display:none!important}*{scrollbar-width:none!important}';
  document.documentElement.appendChild(s);
};

const _showScrollbarFn = () => { document.getElementById('__ext_no_scroll')?.remove(); };

export function scriptingExec(tabId, fn) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript({ target: { tabId }, func: fn }, () => resolve());
  });
}

/* ── CDP Helpers ────────────────────────────────────────────────────────────── */

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
    s.textContent='::-webkit-scrollbar{display:none!important}*{scrollbar-width:none!important}';
    document.documentElement.appendChild(s);
  }
})()`;

const CDP_SHOW_SCROLLBAR = `document.getElementById('__ext_no_scroll')?.remove()`;

// Capped at 3 000 elements: on DOM-heavy SPAs (10 000+ nodes) the unbounded
// querySelectorAll + getComputedStyle blocks the main thread for 1-2 s per call.
const CDP_HIDE_FIXED = `(function(){
  const els = document.querySelectorAll('*');
  const limit = Math.min(els.length, 3000);
  for (let i = 0; i < limit; i++) {
    const el = els[i];
    const p = getComputedStyle(el).position;
    if ((p === 'fixed' || p === 'sticky') && !el.hasAttribute('data-fxhide')) {
      el.setAttribute('data-fxhide', el.style.visibility);
      el.style.visibility = 'hidden';
    }
  }
})()`;

const CDP_SHOW_FIXED = `document.querySelectorAll('[data-fxhide]').forEach(el=>{
  el.style.visibility=el.getAttribute('data-fxhide');
  el.removeAttribute('data-fxhide');
})`;

/* ── Download & Crop ────────────────────────────────────────────────────────── */

export function downloadDataUrl(dataUrl, filename, saveAs) {
  return new Promise((resolve) => {
    chrome.downloads.download({ url: dataUrl, filename, saveAs }, (id) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(id);
    });
  });
}

export async function openCropUI(dataUrl, downloadPath, saveAs) {
  state.pendingCrop = { dataUrl, downloadPath, saveAs };
  const url = chrome.runtime.getURL('editor.html');
  chrome.windows.create({ url, type: 'popup', width: 1280, height: 820 });
  return { success: true, cropping: true };
}

/* ── Visible Screenshot ─────────────────────────────────────────────────────── */

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
    const downloadPath = saveMode === 'auto' ? `screenshots/${filename}` : filename;
    return openCropUI(dataUrl, downloadPath, saveMode === 'ask');
  }
  if (!skipDownload) {
    const downloadPath = saveMode === 'auto' ? `screenshots/${filename}` : filename;
    const id = await downloadDataUrl(dataUrl, downloadPath, saveMode === 'ask');
    if (id == null) return { error: 'Download failed' };
  }
  const r = { success: true, filename };
  if (returnBase64) r.base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
  return r;
}

/* ── Full Page / Segment Screenshot ─────────────────────────────────────────── */

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

  if (!segmentClip && scrollDir === 'full') {
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
  if (!dims) return { error: 'Could not get page dimensions' };

  const { fullWidth, fullHeight, viewportWidth, viewportHeight, scrollX, scrollY, devicePixelRatio: dpr } = dims;

  // OOM guard — most GPU drivers cap OffscreenCanvas at 16 384 px per side.
  const _MAX_CANVAS_DIM = 16_384;
  const _targetW = segmentClip ? segmentClip.width  : (scrollDir === 'full' ? fullWidth  : fullWidth  - scrollX);
  const _targetH = segmentClip ? segmentClip.height : (scrollDir === 'full' ? fullHeight : fullHeight - scrollY);
  const _physW   = Math.round(_targetW * dpr);
  const _physH   = Math.round(_targetH * dpr);
  if (_physW > _MAX_CANVAS_DIM || _physH > _MAX_CANVAS_DIM) {
    return {
      error: `Page is too large to capture in one shot (${_physW}×${_physH} px at DPR ${dpr}). ` +
             `Try a viewport or region capture instead, or reduce browser zoom.`,
    };
  }

  try {
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

    await new Promise(r => setTimeout(r, 1200));

    await new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
        width: viewportWidth, height: viewportHeight, deviceScaleFactor: dpr, mobile: false,
      }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });

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

    let clipX, clipY, clipWidth, clipHeight;
    if (segmentClip) {
      ({ x: clipX, y: clipY, width: clipWidth, height: clipHeight } = segmentClip);
    } else {
      clipX      = scrollDir === 'full' ? 0 : scrollX;
      clipY      = scrollDir === 'full' ? 0 : scrollY;
      clipWidth  = scrollDir === 'vertical'   ? viewportWidth  : scrollDir === 'horizontal' ? fullWidth  - scrollX : fullWidth;
      clipHeight = scrollDir === 'horizontal' ? viewportHeight : scrollDir === 'vertical'   ? fullHeight - scrollY : fullHeight;
    }

    const MAX_CAPTURE_DIM = 4000;
    const needsStitch = (clipWidth * dpr > MAX_CAPTURE_DIM) || (clipHeight * dpr > MAX_CAPTURE_DIM);

    let result;

    if (!needsStitch) {
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

      await cdpEval(tabId, CDP_HIDE_FIXED);
      await cdpRafLocal();

      const chunkW = Math.min(4000, viewportWidth);
      const chunkH = Math.min(4000, viewportHeight);
      const tiles  = [];

      await cdpEval(tabId, `window.scrollTo(0, 0)`);
      await cdpRafLocal();

      let rowY = 0;
      while (rowY < clipHeight) {
        const tileH  = Math.min(chunkH, clipHeight - rowY);
        const rowTiles = [];
        let colX = 0;
        while (colX < clipWidth) {
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
        tiles.push(rowTiles);
        rowY += tileH;
      }

      await cdpEval(tabId, `document.documentElement.style.transform=''`);
      await cdpEval(tabId, `window.scrollTo(${scrollX}, ${scrollY})`);
      await cdpEval(tabId, CDP_SHOW_FIXED);

      // Stitch in 4000 px bands to keep OffscreenCanvas under GPU memory limits.
      // Process strips sequentially — release each GPU texture after drawing.
      const BAND_H    = 4000;
      const allTiles  = tiles.flat();
      const bandSections = [];
      let bandY = 0;

      while (bandY < clipHeight) {
        const bandH   = Math.min(BAND_H, clipHeight - bandY);
        const bandEnd = bandY + bandH;
        const bandTiles = allTiles.filter(t => t.dy < bandEnd && (t.dy + t.tileH) > bandY);

        if (bandTiles.length > 0) {
          const canvas = new OffscreenCanvas(Math.round(clipWidth * dpr), Math.round(bandH * dpr));
          const ctx    = canvas.getContext('2d');

          for (const tile of bandTiles) {
            const bmp = await createImageBitmap(await fetch(tile.dataUrl).then(r => r.blob()));
            const srcYStart = Math.max(0, bandY - tile.dy);
            const srcYEnd   = Math.min(tile.tileH, bandEnd - tile.dy);
            const srcH      = srcYEnd - srcYStart;
            if (srcH <= 0) { bmp.close(); continue; }
            const destY = Math.max(0, tile.dy - bandY);
            ctx.drawImage(bmp,
              0, Math.round(srcYStart * dpr), Math.round(tile.tileW * dpr), Math.round(srcH * dpr),
              Math.round(tile.dx * dpr), Math.round(destY * dpr), Math.round(tile.tileW * dpr), Math.round(srcH * dpr));
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
        const finalCanvas = new OffscreenCanvas(Math.round(clipWidth * dpr), Math.round(clipHeight * dpr));
        const finalCtx    = finalCanvas.getContext('2d');
        let yPos = 0;
        for (const band of bandSections) {
          const bmp = await createImageBitmap(await fetch(`data:image/png;base64,${band.data}`).then(r => r.blob()));
          finalCtx.drawImage(bmp, 0, Math.round(yPos * dpr));
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

    if (!result?.data) return { error: 'CDP capture returned no data' };

    let dataUrl = `data:image/png;base64,${result.data}`;
    dataUrl = await applyWatermark(dataUrl, tabId);
    const downloadPath = saveMode === 'auto' ? `screenshots/${filename}` : filename;
    if (crop) return openCropUI(dataUrl, downloadPath, saveMode === 'ask');
    if (!skipDownload) {
      const id = await downloadDataUrl(dataUrl, downloadPath, saveMode === 'ask');
      if (id == null) return { error: 'Download failed' };
    }
    const r = { success: true, filename };
    if (returnBase64) r.base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
    return r;

  } catch (e) {
    await cdpEval(tabId, `document.documentElement.style.transform=''`).catch(() => {});
    await cdpEval(tabId, CDP_SHOW_FIXED).catch(() => {});
    await cdpEval(tabId, CDP_SHOW_SCROLLBAR).catch(() => {});
    await new Promise((resolve) => {
      chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride', {}, resolve);
    }).catch(() => {});
    await new Promise((resolve) => chrome.debugger.detach({ tabId }, resolve)).catch(() => {});
    return { error: e.message || 'Screenshot failed' };
  }
}

/* ── Element Screenshot ─────────────────────────────────────────────────────── */

export function takeElementScreenshot(tabId, selector, saveMode, prefix, crop = false, returnBase64 = false, skipDownload = false, selectors = null) {
  return _queueScreenshot(tabId, () => _takeElementScreenshot(tabId, selector, saveMode, prefix, crop, returnBase64, skipDownload, selectors));
}

async function _takeElementScreenshot(tabId, selector, saveMode, prefix, crop, returnBase64, skipDownload, selectors) {
  const filename = buildScreenshotFilename(prefix + '_elem', null);

  const rect0 = await tabMsg(tabId, { type: 'GET_ELEMENT_RECT', selector, selectors });
  if (!rect0 || rect0.error) return { error: rect0?.error || 'Could not get element rect' };

  const dims = await tabMsg(tabId, { type: 'GET_PAGE_DIMENSIONS' });
  if (!dims) return { error: 'Could not get page dimensions' };
  const { viewportHeight, scrollX: origScrollX = 0, scrollY: origScrollY = 0 } = dims;

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
    const downloadPath = saveMode === 'auto' ? `screenshots/${filename}` : filename;
    if (crop) return openCropUI(dataUrl, downloadPath, saveMode === 'ask');
    if (!skipDownload) {
      const id = await downloadDataUrl(dataUrl, downloadPath, saveMode === 'ask');
      if (id == null) return { error: 'Download failed' };
    }
    const r = { success: true, filename };
    if (returnBase64) r.base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
    return r;

  } catch (e) {
    await cdpEval(tabId, CDP_SHOW_FIXED).catch(() => {});
    await cdpEval(tabId, CDP_SHOW_SCROLLBAR).catch(() => {});
    await new Promise((r) => chrome.debugger.detach({ tabId }, r)).catch(() => {});
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
    const task = FULL_TYPES.includes(request.type)
      ? takeFullPageScreenshot(tabId, saveMode, prefix, request.filename, crop, dirMap[request.type])
      : takeVisibleScreenshot(tabId, saveMode, prefix, request.filename, crop);
    task.then((result) => {
      sendResponse(result);
      chrome.runtime.sendMessage({ type: 'SCREENSHOT_RESULT', result }).catch(() => {});
    }).catch(e => sendResponse({ error: e.message }));
  });

  return true;
});
