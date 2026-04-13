/**
 * screenshot.js — Screenshot capture, CDP, watermark, image diff
 * Exports: takeVisibleScreenshot, takeFullPageScreenshot, takeElementScreenshot,
 *          compareScreenshots, applyWatermark, downloadDataUrl, openCropUI,
 *          buildScreenshotFilename, uint8ToBase64, scriptingExec, cdpEval,
 *          captureTab, captureTabDouble
 */

import { state } from './state.js';
import { tabMsg } from './utils.js';

/* === UTIL === */

export function uint8ToBase64(u8) {
  const CHUNK = 8192;
  const parts = [];
  for (let i = 0; i < u8.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(''));
}

/* === IMAGE DIFF === */

export async function compareScreenshots(dataUrlA, dataUrlB, threshold) {
  const toBitmap = async (url) => {
    const blob = await fetch(url).then(r => r.blob());
    return createImageBitmap(blob);
  };
  const [bmA, bmB] = await Promise.all([toBitmap(dataUrlA), toBitmap(dataUrlB)]);
  const w = Math.max(bmA.width,  bmB.width);
  const h = Math.max(bmA.height, bmB.height);

  const read = (bm) => {
    const c = new OffscreenCanvas(w, h); const x = c.getContext("2d");
    x.drawImage(bm, 0, 0); return x.getImageData(0, 0, w, h);
  };
  const [dA, dB] = [read(bmA), read(bmB)];

  const out = new OffscreenCanvas(w, h);
  const ctx = out.getContext("2d");
  const img = ctx.createImageData(w, h);
  let changed = 0;
  for (let i = 0; i < dA.data.length; i += 4) {
    const dr = Math.abs(dA.data[i]   - dB.data[i]);
    const dg = Math.abs(dA.data[i+1] - dB.data[i+1]);
    const db = Math.abs(dA.data[i+2] - dB.data[i+2]);
    const diff = (dr + dg + db) / 3;
    if (diff > threshold) {
      img.data[i]=255; img.data[i+1]=0; img.data[i+2]=220; img.data[i+3]=255; // magenta
      changed++;
    } else {
      img.data[i]=dA.data[i]*0.4; img.data[i+1]=dA.data[i+1]*0.4;
      img.data[i+2]=dA.data[i+2]*0.4; img.data[i+3]=dA.data[i+3];
    }
  }
  ctx.putImageData(img, 0, 0);
  const blob = await out.convertToBlob({ type: "image/png" });
  const ab = await blob.arrayBuffer();
  const u8 = new Uint8Array(ab);
  const diffUrl = "data:image/png;base64," + uint8ToBase64(u8);
  const total = (w * h);
  return { diffUrl, changed, total, pct: ((changed / total) * 100).toFixed(2) };
}

/* === WATERMARK === */

export async function applyWatermark(dataUrl, tabId) {
  const settings = await new Promise(r => chrome.storage.local.get(["watermarkEnabled","watermarkFormat","watermarkFontSize"], r));
  if (!settings.watermarkEnabled) return dataUrl;
  try {
    let pageUrl = "";
    try { const t = await chrome.tabs.get(tabId); pageUrl = t.url || ""; } catch(_) {}
    const text = (settings.watermarkFormat || "{url}  {datetime}")
      .replace("{url}", pageUrl)
      .replace("{datetime}", new Date().toLocaleString());
    const fontSize = Math.min(48, Math.max(8, settings.watermarkFontSize || 13));
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const barH = Math.round(fontSize * 2.2);
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, bitmap.height - barH, bitmap.width, barH);
    ctx.fillStyle = "#ffffff";
    ctx.font = `${fontSize}px sans-serif`;
    ctx.fillText(text, 8, bitmap.height - Math.round(fontSize * 0.6), bitmap.width - 16);
    const outBlob = await canvas.convertToBlob({ type: "image/png" });
    const ab = await outBlob.arrayBuffer();
    const u8 = new Uint8Array(ab);
    return "data:image/png;base64," + uint8ToBase64(u8);
  } catch (e) {
    console.warn("[WATERMARK] Failed:", e);
    return dataUrl;
  }
}

/* === FILENAME BUILDER === */

export function buildScreenshotFilename(prefix, requestedName) {
  if (requestedName) return requestedName.endsWith(".png") ? requestedName : `${requestedName}.png`;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const datePart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `${prefix}_${datePart}_${timePart}.png`;
}

/* === TAB CAPTURE === */

export function captureTab() {
  return new Promise((resolve) => {
    chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(dataUrl);
    });
  });
}

export async function captureTabDouble() {
  return captureTab();
}

/* === DOM HELPER FUNCTIONS (injected via scripting) === */

const _hideScrollbarFn = () => {
  if (document.getElementById('__ext_no_scroll')) return;
  const s = document.createElement('style');
  s.id = '__ext_no_scroll';
  s.textContent = '::-webkit-scrollbar{display:none!important}*{scrollbar-width:none!important}';
  document.documentElement.appendChild(s);
};

const _showScrollbarFn = () => {
  document.getElementById('__ext_no_scroll')?.remove();
};

export function scriptingExec(tabId, fn) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript({ target: { tabId }, func: fn }, () => resolve());
  });
}

/* === CDP HELPERS === */

export function cdpEval(tabId, expression) {
  return new Promise((resolve) => {
    chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
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

const CDP_HIDE_FIXED = `(function(){
  [...document.querySelectorAll('*')].forEach(el=>{
    const p=getComputedStyle(el).position;
    if((p==='fixed'||p==='sticky')&&!el.hasAttribute('data-fxhide')){
      el.setAttribute('data-fxhide',el.style.visibility);
      el.style.visibility='hidden';
    }
  });
})()`;

const CDP_SHOW_FIXED = `document.querySelectorAll('[data-fxhide]').forEach(el=>{
  el.style.visibility=el.getAttribute('data-fxhide');
  el.removeAttribute('data-fxhide');
})`;

/* === DOWNLOAD & CROP === */

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
  const url = chrome.runtime.getURL("editor.html");
  chrome.windows.create({ url, type: "popup", width: 1280, height: 820 });
  return { success: true, cropping: true };
}

/* === VISIBLE SCREENSHOT === */

export async function takeVisibleScreenshot(tabId, saveMode, prefix, requestedFilename, crop = false, returnBase64 = false, skipDownload = false) {
  const filename = buildScreenshotFilename(prefix, requestedFilename);

  await scriptingExec(tabId, _hideScrollbarFn);
  let dataUrl = await captureTabDouble();
  await scriptingExec(tabId, _showScrollbarFn);

  if (!dataUrl) return { error: "Capture failed" };
  dataUrl = await applyWatermark(dataUrl, tabId);
  if (crop) {
    const downloadPath = saveMode === "auto" ? `screenshots/${filename}` : filename;
    return openCropUI(dataUrl, downloadPath, saveMode === "ask");
  }
  if (!skipDownload) {
    const downloadPath = saveMode === "auto" ? `screenshots/${filename}` : filename;
    const id = await downloadDataUrl(dataUrl, downloadPath, saveMode === "ask");
    if (id == null) return { error: "Download failed" };
  }
  const r = { success: true, filename };
  if (returnBase64) r.base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
  return r;
}

/* === FULL PAGE / SEGMENT SCREENSHOT (CDP + tiling) ===
 * scrollDir: 'full' | 'vertical' | 'horizontal'
 * segmentClip: optional { x, y, width, height } in CSS pixels for a user-defined region.
 *   When provided, scrollDir is ignored and segmentDir drives the suffix.
 */
export async function takeFullPageScreenshot(tabId, saveMode, prefix, requestedFilename, crop = false, scrollDir = 'full', returnBase64 = false, skipDownload = false, segmentClip = null, segmentDir = null) {
  const suffixMap = { full: '_full', vertical: '_scrollV', horizontal: '_scrollH', segV: '_segV', segH: '_segH', elem: '_elem' };
  const effectiveDir = segmentClip
    ? (segmentDir === 'horizontal' ? 'segH' : segmentDir === 'elem' ? 'elem' : 'segV')
    : scrollDir;
  const suffix = requestedFilename ? '' : suffixMap[effectiveDir] || '_full';
  const filename = buildScreenshotFilename(prefix + suffix, requestedFilename);

  // For full-page mode: reset transform and scroll to origin BEFORE attaching debugger
  // so the page is in a clean state and the user can see it happen.
  if (!segmentClip && scrollDir === 'full') {
    await scriptingExec(tabId, () => {
      document.documentElement.style.transform = '';
      document.documentElement.style.transformOrigin = '';
      document.body.style.transform = '';
      document.body.style.transformOrigin = '';
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.documentElement.scrollLeft = 0;
    });
    // Wait one frame for the DOM/scroll to settle before measuring
    await new Promise(r => setTimeout(r, 100));
  }

  const dims = await tabMsg(tabId, { type: "GET_PAGE_DIMENSIONS" });
  if (!dims) return { error: "Could not get page dimensions" };

  const { fullWidth, fullHeight, viewportWidth, viewportHeight, scrollX, scrollY, devicePixelRatio: dpr } = dims;

  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });

    // Wait for the "started debugging" infobar and compositor flush
    await new Promise(r => setTimeout(r, 1200));

    await new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
        width: viewportWidth, height: viewportHeight, deviceScaleFactor: dpr, mobile: false,
      }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });

    // Double rAF to ensure compositor buffer is fully updated
    await new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
        awaitPromise: true, timeout: 5000,
      }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });

    await cdpEval(tabId, CDP_HIDE_SCROLLBAR);

    // Re-apply reset inside debugger session in case setDeviceMetricsOverride caused reflow/re-scroll
    if (effectiveDir === 'full') {
      await cdpEval(tabId, `document.documentElement.style.transform='';document.body.style.transform='';window.scrollTo(0,0);`);
    }

    await new Promise((resolve) => {
      chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
        awaitPromise: true, timeout: 3000,
      }, () => resolve());
    });
    await new Promise(r => setTimeout(r, 300));

    // Determine clip region
    let clipX, clipY, clipWidth, clipHeight;
    if (segmentClip) {
      ({ x: clipX, y: clipY, width: clipWidth, height: clipHeight } = segmentClip);
    } else {
      clipX      = scrollDir === 'full' ? 0 : scrollX;
      clipY      = scrollDir === 'full' ? 0 : scrollY;
      clipWidth  = scrollDir === 'vertical'   ? viewportWidth
                 : scrollDir === 'horizontal'  ? fullWidth - scrollX
                 : fullWidth;
      clipHeight = scrollDir === 'horizontal'  ? viewportHeight
                 : scrollDir === 'vertical'    ? fullHeight - scrollY
                 : fullHeight;
    }

    // GPU texture limit — use tiling for oversized captures
    const MAX_CAPTURE_DIM = 10000;
    const needsStitch = (clipWidth * dpr > MAX_CAPTURE_DIM) || (clipHeight * dpr > MAX_CAPTURE_DIM);

    let result;

    if (!needsStitch) {
      result = await new Promise((resolve, reject) => {
        chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
          format: "png", captureBeyondViewport: true,
          clip: { x: clipX, y: clipY, width: clipWidth, height: clipHeight, scale: 1 },
        }, (res) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(res);
        });
      });
    } else {
      /* === 2-D tile-and-stitch to avoid GPU texture limit === */
      const cdpRafLocal = () => new Promise((resolve) => {
        chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
          expression: "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
          awaitPromise: true, timeout: 5000,
        }, () => resolve());
      });

      await cdpEval(tabId, CDP_HIDE_FIXED);
      await cdpRafLocal();

      const chunkW = Math.min(4000, viewportWidth);
      const chunkH = Math.min(4000, viewportHeight);
      const tiles = [];

      await cdpEval(tabId, `window.scrollTo(0, 0)`);
      await cdpRafLocal();

      let rowY = 0;
      while (rowY < clipHeight) {
        const tileH = Math.min(chunkH, clipHeight - rowY);
        const rowTiles = [];
        let colX = 0;
        while (colX < clipWidth) {
          const tileW = Math.min(chunkW, clipWidth - colX);
          const tx = -(clipX + colX);
          const ty = -(clipY + rowY);
          await cdpEval(tabId, `document.documentElement.style.transform='translate(${tx}px,${ty}px)'`);
          await cdpRafLocal();
          await new Promise(r => setTimeout(r, 30));

          const cap = await new Promise((resolve) => {
            chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
              format: "png", captureBeyondViewport: false,
              clip: { x: 0, y: 0, width: tileW, height: tileH, scale: 1 },
            }, (res) => resolve(res));
          });

          if (cap?.data) {
            rowTiles.push({ dataUrl: `data:image/png;base64,${cap.data}`, dx: colX, dy: rowY, tileW, tileH });
          }
          colX += tileW;
        }
        tiles.push(rowTiles);
        rowY += tileH;
      }

      await cdpEval(tabId, `document.documentElement.style.transform=''`);
      await cdpEval(tabId, `window.scrollTo(${scrollX}, ${scrollY})`);
      await cdpEval(tabId, CDP_SHOW_FIXED);

      // Stitch bands of ~4000px to keep OffscreenCanvas under memory limit
      const BAND_H = 4000;
      const allTiles = tiles.flat();
      const bandSections = [];
      let bandY = 0;

      while (bandY < clipHeight) {
        const bandH = Math.min(BAND_H, clipHeight - bandY);
        const bandEnd = bandY + bandH;
        const bandTiles = allTiles.filter(t => t.dy < bandEnd && (t.dy + t.tileH) > bandY);

        if (bandTiles.length > 0) {
          const canvas = new OffscreenCanvas(Math.round(clipWidth * dpr), Math.round(bandH * dpr));
          const ctx = canvas.getContext("2d");

          for (const tile of bandTiles) {
            const blob = await fetch(tile.dataUrl).then(r => r.blob());
            const bmp = await createImageBitmap(blob);
            const srcYStart = Math.max(0, bandY - tile.dy);
            const srcYEnd   = Math.min(tile.tileH, bandEnd - tile.dy);
            const srcH = srcYEnd - srcYStart;
            if (srcH <= 0) continue;
            const destY = Math.max(0, tile.dy - bandY);
            ctx.drawImage(bmp,
              0, Math.round(srcYStart * dpr), Math.round(tile.tileW * dpr), Math.round(srcH * dpr),
              Math.round(tile.dx * dpr), Math.round(destY * dpr), Math.round(tile.tileW * dpr), Math.round(srcH * dpr));
          }

          const sectionBlob = await canvas.convertToBlob({ type: "image/png" });
          const sectionU8 = new Uint8Array(await sectionBlob.arrayBuffer());
          bandSections.push({ data: uint8ToBase64(sectionU8), h: bandH });
        }
        bandY += bandH;
      }

      if (bandSections.length === 1) {
        result = { data: bandSections[0].data };
      } else {
        const finalCanvas = new OffscreenCanvas(Math.round(clipWidth * dpr), Math.round(clipHeight * dpr));
        const finalCtx = finalCanvas.getContext("2d");
        let yPos = 0;
        for (const band of bandSections) {
          const blob = await fetch(`data:image/png;base64,${band.data}`).then(r => r.blob());
          const bmp = await createImageBitmap(blob);
          finalCtx.drawImage(bmp, 0, Math.round(yPos * dpr));
          yPos += band.h;
        }
        const finalBlob = await finalCanvas.convertToBlob({ type: "image/png" });
        const finalU8 = new Uint8Array(await finalBlob.arrayBuffer());
        result = { data: uint8ToBase64(finalU8) };
      }
    }

    await cdpEval(tabId, CDP_SHOW_SCROLLBAR);
    await new Promise((resolve) => {
      chrome.debugger.sendCommand({ tabId }, "Emulation.clearDeviceMetricsOverride", {}, resolve);
    });
    await new Promise((resolve) => chrome.debugger.detach({ tabId }, resolve));

    if (!result?.data) return { error: "CDP capture returned no data" };

    let dataUrl = `data:image/png;base64,${result.data}`;
    dataUrl = await applyWatermark(dataUrl, tabId);
    const downloadPath = saveMode === "auto" ? `screenshots/${filename}` : filename;
    if (crop) return openCropUI(dataUrl, downloadPath, saveMode === "ask");
    if (!skipDownload) {
      const id = await downloadDataUrl(dataUrl, downloadPath, saveMode === "ask");
      if (id == null) return { error: "Download failed" };
    }
    const r = { success: true, filename };
    if (returnBase64) r.base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
    return r;

  } catch (e) {
    await cdpEval(tabId, `document.documentElement.style.transform=''`).catch(() => {});
    await cdpEval(tabId, CDP_SHOW_FIXED).catch(() => {});
    await cdpEval(tabId, CDP_SHOW_SCROLLBAR).catch(() => {});
    await new Promise((resolve) => {
      chrome.debugger.sendCommand({ tabId }, "Emulation.clearDeviceMetricsOverride", {}, resolve);
    }).catch(() => {});
    await new Promise((resolve) => chrome.debugger.detach({ tabId }, resolve)).catch(() => {});
    return { error: e.message || "Screenshot failed" };
  }
}

/* === ELEMENT SCREENSHOT (CDP + transform tile-and-stitch + warm-up) === */

export async function takeElementScreenshot(tabId, selector, saveMode, prefix, crop = false, returnBase64 = false, skipDownload = false, selectors = null) {
  const filename = buildScreenshotFilename(prefix + "_elem", null);

  const rect0 = await tabMsg(tabId, { type: "GET_ELEMENT_RECT", selector, selectors });
  if (!rect0 || rect0.error) return { error: rect0?.error || "Could not get element rect" };

  const dims = await tabMsg(tabId, { type: "GET_PAGE_DIMENSIONS" });
  if (!dims) return { error: "Could not get page dimensions" };
  const { viewportHeight, devicePixelRatio: dpr, scrollX: origScrollX = 0, scrollY: origScrollY = 0 } = dims;

  const cdpRaf = () => new Promise((resolve) => {
    chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
      awaitPromise: true, timeout: 5000,
    }, () => resolve());
  });

  // Get element rect via CDP (scroll-safe: reads scrollX/Y separately from getBoundingClientRect)
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
      return { x: r.left + sx, y: r.top + sy, width: r.width, height: r.height };
    })()`;
    chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: expr, returnByValue: true,
    }, (res) => resolve(res?.result?.value || null));
  });

  // Stitch vertical strips into one canvas
  const stitchStrips = async (strips, totalWidth, totalHeight, dprVal) => {
    const canvas = new OffscreenCanvas(Math.round(totalWidth * dprVal), Math.round(totalHeight * dprVal));
    const ctx = canvas.getContext("2d");
    for (const { dataUrl, dy, clipH } of strips) {
      const blob = await fetch(dataUrl).then(r => r.blob());
      const bmp  = await createImageBitmap(blob);
      ctx.drawImage(bmp,
        0, 0, bmp.width, Math.round(clipH * dprVal),
        0, Math.round(dy * dprVal), bmp.width, Math.round(clipH * dprVal));
    }
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  };

  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });

    // Do NOT call setDeviceMetricsOverride — it resets window.scrollX/Y to 0
    await cdpRaf();

    await cdpEval(tabId, CDP_HIDE_SCROLLBAR);
    await cdpRaf();

    // Remove picker UI so it doesn't appear in capture
    await cdpEval(tabId, `document.getElementById('__picker_bar')?.remove(); document.getElementById('__picker_overlay')?.remove();`);
    await cdpRaf();

    // Re-query rect after scrollbar hide (scroll-safe method)
    const rect = await cdpGetRect(selector, selectors) || rect0;

    // Warm-up pass: scroll through element to force GPU rasterization
    {
      let warmY = rect.y;
      while (warmY < rect.y + rect.height) {
        await cdpEval(tabId, `window.scrollTo(${rect.x}, ${warmY})`);
        await cdpRaf();
        warmY += viewportHeight;
      }
      await cdpEval(tabId, `window.scrollTo(0, 0)`);
      await cdpRaf();
      await new Promise(r => setTimeout(r, 200));
    }

    // Hide fixed/sticky elements OUTSIDE the capture rect
    const hideFixedOutside = `(function(rx,ry,rw,rh){
      [...document.querySelectorAll('*')].forEach(el=>{
        const p=getComputedStyle(el).position;
        if((p==='fixed'||p==='sticky')&&!el.hasAttribute('data-fxhide')){
          const b=el.getBoundingClientRect();
          const sx=document.documentElement.scrollLeft||document.body.scrollLeft||0;
          const sy=document.documentElement.scrollTop||document.body.scrollTop||0;
          const ex=b.left+sx, ey=b.top+sy;
          const overlaps=ex<rx+rw&&ex+b.width>rx&&ey<ry+rh&&ey+b.height>ry;
          if(!overlaps){
            el.setAttribute('data-fxhide',el.style.visibility);
            el.style.visibility='hidden';
          }
        }
      });
    })(${rect.x},${rect.y},${rect.width},${rect.height})`;
    await cdpEval(tabId, hideFixedOutside);
    await cdpRaf();

    // Tile-and-stitch using CSS transform (works for both short and tall elements)
    const strips = [];
    let remaining = rect.height;
    let offsetY   = 0;

    while (remaining > 0) {
      const chunkH = Math.min(remaining, viewportHeight);
      const tx = -rect.x;
      const ty = -(rect.y + offsetY);
      await cdpEval(tabId, `document.documentElement.style.transform='translate(${tx}px,${ty}px)'`);
      await cdpRaf();
      await new Promise(r => setTimeout(r, 100));

      const cap = await new Promise((resolve) => {
        chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
          format: "png", captureBeyondViewport: false,
          clip: { x: 0, y: 0, width: rect.width, height: chunkH, scale: 1 },
        }, (res) => resolve(res));
      });

      if (cap?.data) {
        strips.push({ dataUrl: `data:image/png;base64,${cap.data}`, dy: offsetY, clipH: chunkH });
      }

      offsetY   += chunkH;
      remaining -= chunkH;
    }

    await cdpEval(tabId, `document.documentElement.style.transform=''`);
    await cdpEval(tabId, `window.scrollTo(${origScrollX}, ${origScrollY})`);
    await cdpEval(tabId, CDP_SHOW_FIXED);

    let dataUrl = await stitchStrips(strips, rect.width, rect.height, dpr);

    await cdpEval(tabId, CDP_SHOW_SCROLLBAR);
    await new Promise((r) => chrome.debugger.detach({ tabId }, r));

    dataUrl = await applyWatermark(dataUrl, tabId);
    const downloadPath = saveMode === "auto" ? `screenshots/${filename}` : filename;
    if (crop) return openCropUI(dataUrl, downloadPath, saveMode === "ask");
    if (!skipDownload) {
      const id = await downloadDataUrl(dataUrl, downloadPath, saveMode === "ask");
      if (id == null) return { error: "Download failed" };
    }
    const r = { success: true, filename };
    if (returnBase64) r.base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
    return r;

  } catch (e) {
    await cdpEval(tabId, `document.documentElement.style.transform=''`).catch(() => {});
    await cdpEval(tabId, CDP_SHOW_FIXED).catch(() => {});
    await cdpEval(tabId, CDP_SHOW_SCROLLBAR).catch(() => {});
    await new Promise((r) => chrome.debugger.detach({ tabId }, r)).catch(() => {});
    return { error: e.message || "Screenshot failed" };
  }
}

/* === SCREENSHOT MESSAGE HANDLER === */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const FULL_TYPES = ["TAKE_SCREENSHOT_FULL", "TAKE_SCREENSHOT_SCROLL_V", "TAKE_SCREENSHOT_SCROLL_H"];
  const ALL_SS_TYPES = [...FULL_TYPES, "TAKE_SCREENSHOT", "TAKE_SCREENSHOT_ELEMENT"];
  if (!ALL_SS_TYPES.includes(request.type)) return;

  const tabId = request.tabId || sender.tab?.id;
  if (!tabId) { sendResponse({ error: "No tab ID" }); return true; }

  if (request.type === "TAKE_SCREENSHOT_ELEMENT") {
    chrome.storage.sync.get(["screenshotSaveMode", "screenshotPrefix"], (settings) => {
      const saveMode = settings.screenshotSaveMode || "auto";
      const prefix   = settings.screenshotPrefix   || "screenshot";
      takeElementScreenshot(tabId, request.selector, saveMode, prefix, !!request.crop, false, false, request.selectors)
        .then((result) => {
          sendResponse(result);
          chrome.runtime.sendMessage({ type: "SCREENSHOT_RESULT", result }).catch(() => {});
        }).catch(e => sendResponse({ error: e.message }));
    });
    return true;
  }

  chrome.storage.sync.get(["screenshotSaveMode", "screenshotPrefix"], (settings) => {
    const saveMode = settings.screenshotSaveMode || "auto";
    const prefix   = settings.screenshotPrefix   || "screenshot";
    const crop = !!request.crop;
    const dirMap = {
      TAKE_SCREENSHOT_FULL:     'full',
      TAKE_SCREENSHOT_SCROLL_V: 'vertical',
      TAKE_SCREENSHOT_SCROLL_H: 'horizontal',
    };
    const task = FULL_TYPES.includes(request.type)
      ? takeFullPageScreenshot(tabId, saveMode, prefix, request.filename, crop, dirMap[request.type])
      : takeVisibleScreenshot(tabId, saveMode, prefix, request.filename, crop);

    task.then((result) => {
      sendResponse(result);
      chrome.runtime.sendMessage({ type: "SCREENSHOT_RESULT", result }).catch(() => {});
    }).catch(e => sendResponse({ error: e.message }));
  });

  return true;
});
