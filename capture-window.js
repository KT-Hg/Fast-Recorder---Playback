/**
 * capture-window.js — Window capture page.
 *
 * Runs in its own window because both halves of the desktop-capture flow have
 * requirements a service worker or an offscreen document cannot meet:
 *
 *   1. `chrome.permissions.request` needs a user gesture, and the action popup
 *      dies the moment the permission prompt takes focus — so the grant has to
 *      happen in a window that survives losing focus.
 *   2. Chrome registers a desktop stream against the *render frame* that called
 *      `chooseDesktopMedia`. Handing the streamId to any other context (offscreen
 *      document included) fails with "AbortError: Error starting tab capture",
 *      so `getUserMedia` must run in this very frame.
 *
 * The captured PNG goes to the service worker (WINDOW_CAPTURE_RESULT), which
 * reuses the normal watermark + naming + save/crop path.
 */

const statusEl    = document.getElementById('status');
const actionEl    = document.getElementById('action');
const modeEl      = document.getElementById('mode');
const countdownEl = document.getElementById('countdown');
const cardEl      = document.getElementById('card');

/* ── Request context ────────────────────────────────────────────────────────────
 * Carried in the URL rather than held in the worker, so a worker suspend between
 * the click and the finished capture cannot lose it. Echoed back with the image.
 * ────────────────────────────────────────────────────────────────────────────── */

const CROP = new URLSearchParams(location.search).get('crop') === '1';

modeEl.textContent = CROP ? '✂ Opens in the editor' : '⬇ Saves straight to disk';

/** Paint one of the page's states. Pass no label to hide the button. */
function setState(text, buttonLabel, onClick, tone = '') {
  statusEl.textContent = text;
  statusEl.className = tone;
  if (buttonLabel) {
    actionEl.hidden = false;
    actionEl.disabled = false;
    actionEl.textContent = buttonLabel;
    actionEl.onclick = onClick;
  } else {
    actionEl.hidden = true;
    actionEl.onclick = null;
  }
}

/* ── Theme ──────────────────────────────────────────────────────────────────── */

chrome.storage.local.get(['popupTheme'], (res) => {
  document.documentElement.setAttribute('data-theme', res?.popupTheme === 'dark' ? 'dark' : 'light');
});

/* ── Permission state ───────────────────────────────────────────────────────── */

/**
 * `desktopCapture` is optional, and while it is ungranted the whole
 * `chrome.desktopCapture` object is absent — not merely throwing on use. So the
 * `typeof` check is the state test, not a defensive extra.
 */
function hasApi() {
  return typeof chrome.desktopCapture !== 'undefined'
      && typeof chrome.desktopCapture.chooseDesktopMedia === 'function';
}

function showNeedsPermission(message) {
  setState(
    message || 'This capture needs the "desktopCapture" permission so Chrome can show you the window picker.',
    'Grant permission',
    requestPermission,
  );
}

function showReady(message) {
  setState(message || 'Ready.', 'Choose a window to capture', startCapture);
}

/** Must be called straight from the click handler — the request needs the gesture. */
function requestPermission() {
  actionEl.disabled = true;
  chrome.permissions.request({ permissions: ['desktopCapture'] }, (granted) => {
    void chrome.runtime.lastError;
    if (!granted) { showNeedsPermission('Permission denied. Nothing else in the extension is affected.'); return; }
    // The API binding is normally injected the moment the grant lands, but a
    // reload is the only guarantee — and this page holds no state worth keeping.
    if (!hasApi()) { location.reload(); return; }
    showReady();
  });
}

/* ── Capture ────────────────────────────────────────────────────────────────── */

/** Resolve with the chosen stream id, or '' when the user cancels the picker. */
function chooseWindow() {
  // 'screen' is deliberately not offered: capturing a whole screen would put this
  // very window into the shot, and it cannot be hidden without also stopping the
  // frame delivery this page depends on.
  return new Promise((resolve) => chrome.desktopCapture.chooseDesktopMedia(['window'], resolve));
}

/**
 * Wait for the next presented frame, with a ceiling.
 *
 * requestVideoFrameCallback only fires while the compositor is presenting the
 * element, and a desktop stream that has not warmed up yet presents nothing at
 * all — so an unbounded wait here hangs the capture instead of retrying it.
 */
function nextFrame(video) {
  return new Promise((resolve) => {
    if (!video.requestVideoFrameCallback) {
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 60)));
      return;
    }
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    video.requestVideoFrameCallback(done);
    setTimeout(done, 250);
  });
}

const PROBE = 32;

/**
 * True once the stream carries an actual picture.
 *
 * The first frames off a desktop capturer are uniform black: the window is
 * enumerated before its content has been composited into the shared surface.
 * Drawing then yields a black PNG with no error raised anywhere, so the frame
 * has to be inspected rather than trusted. Downscaling to 32x32 keeps this cheap
 * enough to run once per frame.
 */
function frameHasContent(video, probeCtx) {
  probeCtx.drawImage(video, 0, 0, PROBE, PROBE);
  const { data } = probeCtx.getImageData(0, 0, PROBE, PROBE);
  let min = 255, max = 0;
  for (let i = 0; i < data.length; i += 4) {
    const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
    if (lum < min) min = lum;
    if (lum > max) max = lum;
  }
  // Any non-black pixel, or any variation at all, means real content arrived.
  return max > 16 || max - min > 4;
}

/* ── Countdown ──────────────────────────────────────────────────────────────── */

/** Seconds to count down before the shot, or 0. Shares the visible-capture setting. */
function countdownSeconds() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['screenshotCountdownEnabled', 'screenshotCountdownSeconds'], (res) => {
      resolve(res?.screenshotCountdownEnabled ? (res.screenshotCountdownSeconds || 3) : 0);
    });
  });
}

/* The count is shown in two places because neither one alone is reliable: the
 * whole point of the countdown is that the user goes and arranges the target
 * window, which raises it over this one. A maximised target hides this window
 * entirely, and the toolbar badge is the only surface left; conversely the badge
 * only exists on Chrome windows, so a non-browser target has nothing but this
 * window. Extensions cannot ask for an always-on-top window, or one would do. */

const SMALL_W = 260, SMALL_H = 180;
const FULL_W  = 960, FULL_H  = 720;
const BADGE_COLOR = '#3b82f6';

let _shrunk = false;

/** Shrink to a screen corner so the count stays beside, not behind, the target. */
async function shrinkToCorner() {
  try {
    const win = await chrome.windows.getCurrent();
    const left = Math.max(0, (screen.availLeft || 0) + screen.availWidth  - SMALL_W - 24);
    const top  = Math.max(0, (screen.availTop  || 0) + screen.availHeight - SMALL_H - 24);
    await chrome.windows.update(win.id, { left, top, width: SMALL_W, height: SMALL_H });
    _shrunk = true;
  } catch (_) { /* geometry is a nicety — never fail a capture over it */ }
}

/** Grow back, so an error message and its Try again button have room to land. */
async function restoreSize() {
  if (!_shrunk) return;
  _shrunk = false;
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.windows.update(win.id, { width: FULL_W, height: FULL_H });
  } catch (_) {}
}

function setBadge(text) {
  try {
    chrome.action.setBadgeText({ text });
    if (text) chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  } catch (_) {}
}

/**
 * Hand the badge back to the worker, which recomputes it from REC / playback
 * state — clearing it here directly would wipe a running recording's badge.
 */
function releaseBadge() {
  chrome.runtime.sendMessage({ type: 'RESTORE_BADGE' }).catch(() => {});
}

/**
 * Count down so the user can arrange the target first — open a menu, hover a
 * control, bring the right window forward.
 */
function runCountdown(seconds) {
  return new Promise((resolve) => {
    cardEl.classList.add('counting');
    let left = seconds;
    const paint = () => { countdownEl.textContent = String(left); setBadge(String(left)); };
    paint();
    const timer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(timer);
        cardEl.classList.remove('counting');
        resolve();
        return;
      }
      paint();
    }, 1000);
  });
}

/* ── Frame grab ─────────────────────────────────────────────────────────────── */

/**
 * Grab a single frame off the desktop stream as a PNG data URL.
 *
 * `beforeShot` runs once the stream is confirmed to be delivering real frames
 * and just before the pixel copy — that is where the countdown goes, so the
 * image reflects the target at the end of the count, not the start. The stream
 * is opened first regardless, both to keep the picker's streamId from going
 * stale and so the capturer is warm when the count runs out.
 */
async function grabFrame(streamId, beforeShot) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId } },
  });
  // The video must live in the document: Chrome does not composite a detached
  // element, so rVFC reports a presentation that never happened and every
  // capture comes out black. Kept effectively invisible rather than
  // display:none, which would suppress presentation just the same.
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:.01;pointer-events:none;z-index:-1';
  document.body.appendChild(video);
  try {
    video.srcObject = stream;
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('Video stream failed to load'));
    });
    await video.play();

    const probe = document.createElement('canvas');
    probe.width = probe.height = PROBE;
    const probeCtx = probe.getContext('2d', { willReadFrequently: true });

    // ~20 x 250 ms worst case. A window that never yields a picture at all is
    // almost always one that is minimised.
    let ready = false;
    for (let i = 0; i < 20 && !ready; i++) {
      await nextFrame(video);
      if (video.videoWidth && video.videoHeight) ready = frameHasContent(video, probeCtx);
    }
    if (!video.videoWidth || !video.videoHeight) throw new Error('Captured frame was empty');
    if (!ready) {
      throw new Error('That window only produced blank frames. Restore it if it is minimised, '
                    + 'make sure it is visible on screen, then try again.');
    }

    if (beforeShot) {
      await beforeShot();
      // One more presented frame, so what lands on the canvas is the target as it
      // stands now rather than whatever was decoded before the countdown ran.
      await nextFrame(video);
    }

    // videoWidth/videoHeight are *physical* pixels: a 1200x800 window at 128%
    // DPI yields 1544x1032. Never assume CSS pixels downstream.
    const canvas = document.createElement('canvas');
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    return canvas.toDataURL('image/png');
  } finally {
    video.srcObject = null;
    video.remove();
    // Stop early so Chrome's "sharing your screen" indicator does not linger.
    stream.getTracks().forEach((t) => t.stop());
  }
}

/**
 * Hand the image over.
 *
 * This window does NOT close itself afterwards — the worker closes it, and only
 * then starts the save. Chrome parents the "Save file as" dialog to the focused
 * browser window, which is this one; closing it on our own schedule tore that
 * dialog down before the user could choose a folder. Saving is reported by
 * notification instead, since nothing of ours is left on screen by then.
 */
function deliver(dataUrl) {
  return chrome.runtime.sendMessage({ type: 'WINDOW_CAPTURE_RESULT', dataUrl, crop: CROP })
    .catch(() => null);
}

async function startCapture() {
  actionEl.disabled = true;
  if (!hasApi()) { showNeedsPermission('Permission was revoked. Grant it again to capture.'); return; }

  let streamId;
  try {
    streamId = await chooseWindow();
  } catch (e) {
    setState(`Could not open the window picker: ${e.message}`, 'Try again', startCapture, 'error');
    return;
  }
  if (!streamId) { window.close(); return; } // user cancelled the picker

  const secs = await countdownSeconds();
  setState('Capturing… waiting for the window to produce a frame.', null, null);
  let dataUrl;
  try {
    dataUrl = await grabFrame(streamId, secs > 0 ? async () => {
      await shrinkToCorner();
      setState('Switch to the window and set it up.', null, null);
      await runCountdown(secs);
      setState('Capturing…', null, null);
      // Clear the badge *before* the shot. When the target is a Chrome window the
      // badge sits in its own toolbar and would be photographed; the pause gives
      // that toolbar time to repaint before the frame is taken.
      releaseBadge();
      await new Promise((r) => setTimeout(r, 300));
    } : null);
  } catch (e) {
    await restoreSize();
    releaseBadge();
    // A revoked permission surfaces here as a getUserMedia rejection.
    if (!hasApi()) { showNeedsPermission('Permission was revoked mid-capture. Grant it again to continue.'); return; }
    setState(`Capture failed: ${e.message || e.name}`, 'Try again', startCapture, 'error');
    return;
  }

  setState(CROP ? 'Opening the editor…' : 'Handing the image over…', null, null);
  await deliver(dataUrl);
  // Backstop only, for a worker that died between taking the image and closing
  // this window. The normal path is closed from the worker within a moment.
  setTimeout(() => window.close(), 30_000);
}

/* ── Boot ───────────────────────────────────────────────────────────────────── */

// Advertise the countdown up front so the picker step is not a surprise. The
// value is read again when the capture actually runs, in case it changed since.
countdownSeconds().then((secs) => {
  if (secs > 0) document.getElementById('stepCountdown').hidden = false;
});

if (hasApi()) showReady();
else showNeedsPermission();
