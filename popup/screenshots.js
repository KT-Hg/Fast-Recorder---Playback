/**
 * screenshots.js — Screenshot capture, segment capture, element picker, image diff
 * Exports: initScreenshots
 */

import { showToast, safeSendTabMessage, isEligibleTab } from './utils.js';
import { updateRangeFill } from './settings.js';

/* === Screenshot Capture === */

function takeScreenshotWithCrop(msgType, crop = false) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    if (!tabId) { showToast('No active tab', 'error'); return; }
    const toastMap = {
      TAKE_SCREENSHOT:          'Capturing…',
      TAKE_SCREENSHOT_FULL:     'Capturing full page…',
      TAKE_SCREENSHOT_SCROLL_V: 'Capturing vertical scroll…',
      TAKE_SCREENSHOT_SCROLL_H: 'Capturing horizontal scroll…',
    };
    showToast(toastMap[msgType] || 'Capturing…', 'info');
    chrome.runtime.sendMessage({ type: msgType, tabId, crop }, (res) => {
      void chrome.runtime.lastError;
      if (res?.error) showToast('✗ ' + res.error, 'error');
      else if (res?.cropping) showToast('Opening editor…', 'info');
      else showToast('✓ Saved: ' + (res?.filename || 'screenshot'), 'success');
    });
  });
}

/* === Segment Capture === */

function startSegmentCapture(dir, crop = false) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    if (!tabId) { showToast('No active tab', 'error'); return; }
    chrome.runtime.sendMessage({ type: 'START_SEGMENT_CAPTURE', tabId, dir, crop });
    window.close();
  });
}

/* === Element Screenshot Pick === */

function startElemShotPick(crop) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.id || !isEligibleTab(tab)) { showToast('Invalid tab for pick mode', 'error'); return; }
    chrome.storage.local.set({ elemShotPickPending: true, elemShotPickCrop: !!crop });
    safeSendTabMessage(tab.id, { type: 'START_PICK_MODE' });
    chrome.runtime.sendMessage({ type: 'START_PICK_MODE', tabId: tab.id });
    window.close();
  });
}

/* === Image Diff === */

function initDiff() {
  const modal     = document.getElementById('diffModal');
  const openBtn   = document.getElementById('diffScreenshots');
  const closeBtn  = document.getElementById('diffClose');
  const runBtn    = document.getElementById('diffRun');
  const slider    = document.getElementById('diffThreshold');
  const sliderVal = document.getElementById('diffThresholdVal');
  const result    = document.getElementById('diffResult');
  const stats     = document.getElementById('diffStats');
  const preview   = document.getElementById('diffPreview');
  const dlBtn     = document.getElementById('diffDownload');
  if (!modal) return;

  slider?.addEventListener('input', () => { if (sliderVal) sliderVal.textContent = slider.value; updateRangeFill(slider); });
  if (slider) updateRangeFill(slider);

  openBtn?.addEventListener('click', () => modal.classList.add('show'));
  closeBtn?.addEventListener('click', () => modal.classList.remove('show'));

  const readFile = (input) => new Promise((resolve, reject) => {
    const f = input?.files?.[0];
    if (!f) { reject(new Error('No file selected')); return; }
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(f);
  });

  runBtn?.addEventListener('click', async () => {
    try {
      runBtn.disabled = true; runBtn.textContent = 'Processing…';
      const [a, b] = await Promise.all([
        readFile(document.getElementById('diffFileA')),
        readFile(document.getElementById('diffFileB')),
      ]);
      const threshold = parseInt(slider?.value || '10', 10);
      const res = await chrome.runtime.sendMessage({ type: 'COMPARE_SCREENSHOTS', dataUrlA: a, dataUrlB: b, threshold });
      if (res?.error) { showToast('✗ ' + res.error, 'error'); return; }
      result.style.display = '';
      stats.textContent = `Diff: ${res.changed.toLocaleString()} px (${res.pct}% of total area)`;
      preview.src = res.diffUrl;
      dlBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = res.diffUrl; a.download = `diff_${Date.now()}.png`; a.click();
      };
    } catch (e) {
      showToast('✗ ' + e.message, 'error');
    } finally {
      runBtn.disabled = false; runBtn.textContent = '▶ Compare';
    }
  });
}

/* === Init === */

export function initScreenshots() {
  /* Screenshot buttons */
  document.getElementById('screenshotVisible') ?.addEventListener('click', () => takeScreenshotWithCrop('TAKE_SCREENSHOT'));
  document.getElementById('screenshotFull')    ?.addEventListener('click', () => takeScreenshotWithCrop('TAKE_SCREENSHOT_FULL'));
  document.getElementById('cropVisible')       ?.addEventListener('click', () => takeScreenshotWithCrop('TAKE_SCREENSHOT', true));
  document.getElementById('cropFull')          ?.addEventListener('click', () => takeScreenshotWithCrop('TAKE_SCREENSHOT_FULL', true));
  document.getElementById('screenshotScrollV') ?.addEventListener('click', () => takeScreenshotWithCrop('TAKE_SCREENSHOT_SCROLL_V'));
  document.getElementById('screenshotScrollH') ?.addEventListener('click', () => takeScreenshotWithCrop('TAKE_SCREENSHOT_SCROLL_H'));
  document.getElementById('cropScrollV')       ?.addEventListener('click', () => takeScreenshotWithCrop('TAKE_SCREENSHOT_SCROLL_V', true));
  document.getElementById('cropScrollH')       ?.addEventListener('click', () => takeScreenshotWithCrop('TAKE_SCREENSHOT_SCROLL_H', true));

  /* Segment capture buttons */
  document.getElementById('segmentScrollV')    ?.addEventListener('click', () => startSegmentCapture('vertical'));
  document.getElementById('segmentScrollH')    ?.addEventListener('click', () => startSegmentCapture('horizontal'));
  document.getElementById('cropSegmentScrollV')?.addEventListener('click', () => startSegmentCapture('vertical', true));
  document.getElementById('cropSegmentScrollH')?.addEventListener('click', () => startSegmentCapture('horizontal', true));

  /* Element screenshot */
  document.getElementById('screenshotElement')    ?.addEventListener('click', () => startElemShotPick(false));
  document.getElementById('cropScreenshotElement')?.addEventListener('click', () => startElemShotPick(true));


  /* Image diff */
  initDiff();
}
