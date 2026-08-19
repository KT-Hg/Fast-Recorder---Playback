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

const statusEl = document.getElementById('status');
const actionEl = document.getElementById('action');
const modeEl   = document.getElementById('mode');

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

/* The count is never drawn in this window. By the time it runs the user has been
 * told to go and arrange the target, which raises that window over this one — so
 * the count only lives where it stays visible afterwards: a Document
 * Picture-in-Picture window, the one always-on-top window Chrome grants a page
 * (chrome.windows has no such option), and the toolbar badge, which rides on the
 * target itself whenever the target is a Chrome window. */

const BADGE_COLOR = '#3b82f6';

/* ── Cancellation ───────────────────────────────────────────────────────────────
 * Once the picker's Share is pressed the capture is committed: the stream is
 * live, the countdown is running, and until now the only ways out were killing
 * the window or letting the shot happen. Cancelling is checked at the points
 * where the flow already waits — the frame-ready loop and the countdown — so an
 * abort never has to interrupt a draw half-done.
 * ────────────────────────────────────────────────────────────────────────────── */

class CaptureCancelled extends Error {
  constructor() { super('Capture cancelled'); this.name = 'CaptureCancelled'; }
}

let _cancelled = false;
/** Set while something is waiting; cuts that wait short so the abort lands at once. */
let _wake = null;

function requestCancel() {
  _cancelled = true;
  const wake = _wake;
  _wake = null;
  wake?.();
}

function abortIfCancelled() {
  if (_cancelled) throw new CaptureCancelled();
}

// Esc anywhere in this window is the keyboard route out.
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') requestCancel(); });

/**
 * Open an always-on-top box to hold the count.
 *
 * Document PiP needs transient user activation, so this must be called while the
 * click that started the capture is still fresh — the picker below burns seconds
 * of real time and the activation would be long gone by the time the count runs.
 * Returns null when unavailable — the badge then carries the count alone.
 */
async function openFloatingCounter() {
  if (!window.documentPictureInPicture) return null;
  try {
    const pip = await documentPictureInPicture.requestWindow({ width: 200, height: 165 });
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const doc  = pip.document;
    doc.body.style.cssText =
      'margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;gap:8px;text-align:center;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      `background:${dark ? '#0d1829' : '#ffffff'};color:${dark ? '#f5f7fa' : '#111827'}`;

    const num = doc.createElement('div');
    num.id = 'n';
    num.textContent = '·';
    num.style.cssText = 'font-size:74px;font-weight:700;line-height:1;' +
      `font-variant-numeric:tabular-nums;letter-spacing:-.04em;color:${dark ? '#60a5fa' : '#3b82f6'}`;

    const cap = doc.createElement('div');
    cap.id = 'c';
    cap.textContent = 'Pick a window to capture';
    cap.style.cssText = 'font-size:11px;line-height:1.45;opacity:.7;padding:0 12px';

    const btn = doc.createElement('button');
    btn.textContent = 'Cancel';
    btn.style.cssText = 'margin-top:4px;padding:5px 16px;border-radius:6px;cursor:pointer;' +
      'font:inherit;font-size:11.5px;font-weight:600;background:transparent;' +
      `border:1px solid ${dark ? '#2d4157' : '#e5e7eb'};color:${dark ? '#f87171' : '#ef4444'}`;
    btn.addEventListener('click', requestCancel);
    // The floating window owns the user's attention during the count, so it has to
    // own the way out too — this is the surface they are actually looking at.
    doc.addEventListener('keydown', (e) => { if (e.key === 'Escape') requestCancel(); });

    doc.body.append(num, cap, btn);
    return pip;
  } catch (_) {
    return null; // unsupported, blocked, or the activation had already expired
  }
}

/** Close the floating box, tolerating one the user already dismissed. */
function closeFloater(pip) {
  try { pip?.close(); } catch (_) {}
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
function runCountdown(seconds, pip) {
  return new Promise((resolve) => {
    const pipNum = pip?.document.getElementById('n');
    const pipCap = pip?.document.getElementById('c');
    if (pipCap) pipCap.textContent = 'Set up the window now';
    let left = seconds;
    const paint = () => {
      if (pipNum) pipNum.textContent = String(left);
      setBadge(String(left));
    };
    paint();
    const timer = setInterval(() => {
      left -= 1;
      if (left <= 0) { finish(); return; }
      paint();
    }, 1000);
    const finish = () => { clearInterval(timer); _wake = null; resolve(); };
    // A cancel during the count ends the wait immediately; the caller checks the
    // flag straight afterwards and throws.
    _wake = finish;
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
      abortIfCancelled();
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

  _cancelled = false;
  _wake = null;

  // Both of these run before the picker, while this click still counts as
  // transient activation — requestWindow needs it, and the picker takes seconds
  // of wall-clock time that would leave nothing of the gesture behind.
  const secs = await countdownSeconds();
  const pip  = secs > 0 ? await openFloatingCounter() : null;

  let streamId;
  try {
    streamId = await chooseWindow();
  } catch (e) {
    closeFloater(pip);
    setState(`Could not open the window picker: ${e.message}`, 'Try again', startCapture, 'error');
    return;
  }
  if (!streamId) { closeFloater(pip); window.close(); return; } // user cancelled the picker

  setState('Capturing… waiting for the window to produce a frame.', 'Cancel', requestCancel);
  actionEl.classList.add('danger');
  let dataUrl;
  try {
    dataUrl = await grabFrame(streamId, secs > 0 ? async () => {
      setState('Counting down — switch to the window you are capturing.', 'Cancel', requestCancel);
      await runCountdown(secs, pip);
      abortIfCancelled();
      setState('Capturing…', null, null);
      // Clear the badge *before* the shot. When the target is a Chrome window the
      // badge sits in its own toolbar and would be photographed; the pause gives
      // that toolbar time to repaint before the frame is taken.
      closeFloater(pip);
      releaseBadge();
      await new Promise((r) => setTimeout(r, 300));
    } : null);
  } catch (e) {
    closeFloater(pip);
    releaseBadge();
    actionEl.classList.remove('danger');
    // Cancelling is not a failure: offer the picker again rather than an error
    // and a Try again that reads like something broke.
    if (e instanceof CaptureCancelled) { showReady('Capture cancelled. Nothing was saved.'); return; }
    // A revoked permission surfaces here as a getUserMedia rejection.
    if (!hasApi()) { showNeedsPermission('Permission was revoked mid-capture. Grant it again to continue.'); return; }
    setState(`Capture failed: ${e.message || e.name}`, 'Try again', startCapture, 'error');
    return;
  }
  actionEl.classList.remove('danger');

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
