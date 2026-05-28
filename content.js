/**
 * content.js — Content script injected into every eligible tab.
 * Handles action recording (click, input events), action playback, element
 * picker UI, screenshot helpers, hotkeys, and segment-capture overlay.
 */

// Suppress "Extension context invalidated" errors thrown after an extension
// reload or update while old content scripts are still alive in open tabs.
function safeSend(msg) {
  try {
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch (_) {}
}

// Guard against multiple injections — chrome.scripting.executeScript can be
// called more than once on a tab (e.g. reconnect after content script crash).
if (window.__actionRecorderInjected) {
  safeSend({ type: 'CONTENT_READY' });
} else {
  window.__actionRecorderInjected = true;

/* ─────────────────────────────────────────────────────────────────────────────
   STATE
───────────────────────────────────────────────────────────────────────────── */

let pickerMode = false;

// Background has access to sender.frameId; content scripts do not.  We ask for
// it on load so every recorded action can embed the frameId and be replayed in
// the correct iframe.  Defaults to 0 (main frame) on error.
let _myFrameId = 0;
try {
  chrome.runtime.sendMessage({ type: 'REGISTER_FRAME' }, (res) => {
    if (!chrome.runtime.lastError && res?.frameId != null) {
      _myFrameId = res.frameId;
    }
  });
} catch (_) {}

/* ─────────────────────────────────────────────────────────────────────────────
   DYNAMIC ID DETECTION
   Identifies auto-generated IDs that are unstable across page loads and
   therefore unsafe to use as selectors.
───────────────────────────────────────────────────────────────────────────── */

const _DYNAMIC_ID_RE = new RegExp([
  /^[:]./,                             // React fiber IDs (":r0:", ":ra:") — start with colon
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, // full UUID v4
].map(r => r.source).join('|'), 'i');

function _isDynamicId(id) {
  if (!id) return true;
  return _DYNAMIC_ID_RE.test(id);
}

/* ─────────────────────────────────────────────────────────────────────────────
   SELECTOR BUILDERS
───────────────────────────────────────────────────────────────────────────── */

function getCssSelector(el) {
  if (!el) return null;
  if (el.id && !_isDynamicId(el.id)) return `#${CSS.escape(el.id)}`;

  const path = [];
  let current = el;
  while (current && current.nodeType === 1 && current !== document.body) {
    let selector = current.tagName.toLowerCase();

    if (current.tagName === 'INPUT' && current.type) {
      selector += `[type="${CSS.escape(current.type)}"]`;
      if (current.name) selector += `[name="${CSS.escape(current.name)}"]`;
      if (current.type === 'radio' && current.value) {
        // Radio buttons with the same name share the same selector without value.
        selector += `[value="${CSS.escape(current.value)}"]`;
      }
    } else if (current.className && typeof current.className === 'string') {
      // Combine up to 3 stable classes for a more unique selector without being
      // fragile (more than 3 classes increases the chance of version-churn).
      const stableClasses = current.className.split(/\s+/).filter(Boolean)
        .filter(c => !_DYNAMIC_ID_RE.test(c))
        .slice(0, 3);
      if (stableClasses.length > 0) {
        selector += stableClasses.map(c => `.${CSS.escape(c)}`).join('');
      }
    }

    if (current.parentElement) {
      const siblings = current.parentElement.querySelectorAll(`:scope > ${selector}`);
      if (siblings.length > 1) {
        const idx = Array.from(current.parentElement.children).indexOf(current) + 1;
        selector += `:nth-child(${idx})`;
      }
    }

    path.unshift(selector);
    current = current.parentElement;
  }
  return path.join(' > ');
}

/**
 * Build an XPath expression that targets an element by its id attribute,
 * safely handling IDs that contain double-quote characters.
 *
 * XPath attribute values must be quoted; a literal " inside a double-quoted
 * string is invalid XPath.  The workaround is XPath's concat() function to
 * join the parts around the embedded quote character.
 */
function _xpathId(id) {
  if (!id.includes('"')) return `//*[@id="${id}"]`;
  const parts = id.split('"').map(p => `"${p}"`).join(', \'"\', ');
  return `//*[@id=concat(${parts})]`;
}

function getXPath(el) {
  if (!el) return null;
  if (el.id && !_isDynamicId(el.id)) return _xpathId(el.id);

  const parts = [];
  let current = el;

  while (current && current.nodeType === 1) {
    if (current === document.body) { parts.unshift('/html/body'); break; }

    if (current.id && !_isDynamicId(current.id)) {
      parts.unshift(_xpathId(current.id));   // anchor on stable ID
      break;
    }

    let index = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);
    current = current.parentElement;
  }
  return parts.join('/');
}

function getFullXPath(el) {
  if (!el) return null;
  const parts = [];
  let current = el;
  while (current && current.nodeType === 1) {
    if (current === document.documentElement) { parts.unshift('/html'); break; }
    let index = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);
    current = current.parentElement;
  }
  return parts.join('/');
}

function getAllSelectors(el) {
  if (!el) return null;
  const selectors = {
    css:       getCssSelector(el),
    xpath:     getXPath(el),
    fullXpath: getFullXPath(el),
  };
  if (el.id && !_isDynamicId(el.id)) selectors.id = el.id;
  if (el.name) selectors.name = el.name;

  const textContent = (el.textContent || '').trim();
  if (textContent && textContent.length <= 50 &&
      ['A', 'BUTTON', 'SPAN', 'LABEL', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(el.tagName)) {
    selectors.text    = textContent;
    selectors.textTag = el.tagName.toLowerCase();
  }
  if (el.dataset?.testid) selectors.testId = el.dataset.testid;
  if (el.dataset?.id)     selectors.dataId = el.dataset.id;

  return selectors;
}

/* ─────────────────────────────────────────────────────────────────────────────
   SHADOW DOM PIERCE
   Web components (LitElement, Stencil, etc.) render into shadow roots that are
   opaque to document.querySelector.  This recursive walk traverses open shadow
   roots so CSS selectors can resolve across component boundaries.
───────────────────────────────────────────────────────────────────────────── */

function querySelectorDeep(selector, root = document) {
  try {
    const el = root.querySelector(selector);
    if (el) return el;
  } catch (_) { return null; }
  const hosts = root.querySelectorAll('*');
  for (const host of hosts) {
    if (host.shadowRoot) {
      const found = querySelectorDeep(selector, host.shadowRoot);
      if (found) return found;
    }
  }
  return null;
}

/* ─────────────────────────────────────────────────────────────────────────────
   ELEMENT FINDER
───────────────────────────────────────────────────────────────────────────── */

function findElementWithFallback(selectors, timeout = 5000) {
  return new Promise((resolve, reject) => {
    if (typeof selectors === 'string') selectors = { css: selectors };

    // Priority: fullXpath first (absolute position — most precise for recorded actions),
    // then id (unique by spec), xpath (id-anchored), css, shadow DOM pierce,
    // testId/dataId, name, text (most ambiguous).
    const strategies = [];
    if (selectors.fullXpath) strategies.push({ type: 'fullXpath', fn: () => document.evaluate(selectors.fullXpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue });
    if (selectors.id)       strategies.push({ type: 'id',       fn: () => document.getElementById(selectors.id) });
    if (selectors.xpath)    strategies.push({ type: 'xpath',    fn: () => document.evaluate(selectors.xpath,    document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue });
    if (selectors.css)      strategies.push({ type: 'css',      fn: () => document.querySelector(selectors.css) });
    if (selectors.css)      strategies.push({ type: 'cssShadow', fn: () => querySelectorDeep(selectors.css) });
    if (selectors.testId)   strategies.push({ type: 'testId',   fn: () => document.querySelector(`[data-testid="${CSS.escape(selectors.testId)}"]`) });
    if (selectors.dataId)   strategies.push({ type: 'dataId',   fn: () => document.querySelector(`[data-id="${CSS.escape(selectors.dataId)}"]`) });
    if (selectors.name)     strategies.push({ type: 'name',     fn: () => document.querySelector(`[name="${CSS.escape(selectors.name)}"]`) });
    if (selectors.text && selectors.textTag) {
      strategies.push({
        type: 'text',
        fn: () => [...document.querySelectorAll(selectors.textTag)].find(el => el.textContent.trim() === selectors.text),
      });
    }

    const tryStrategies = () => {
      for (const strategy of strategies) {
        try {
          const el = strategy.fn();
          if (el) { return el; }
        } catch (_) {}
      }
      return null;
    };

    const el = tryStrategies();
    if (el) return resolve(el);

    // MutationObserver with rAF debounce: coalesces burst DOM mutations (common
    // in React renders) into at most one check per animation frame.
    // childList+subtree only — omitting "attributes" prevents firing on every
    // CSS class/style update which would make this very hot.
    let found = false;
    let rafQueued = false;

    const observer = new MutationObserver(() => {
      if (found || rafQueued) return;
      rafQueued = true;
      requestAnimationFrame(() => {
        rafQueued = false;
        if (found) return;
        const el = tryStrategies();
        if (el) {
          found = true;
          observer.disconnect();
          clearTimeout(timer);
          resolve(el);
        }
      });
    });

    // document.body is null during early HTML parsing; fall back to <html>.
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

    const timer = setTimeout(() => {
      if (found) return;
      observer.disconnect();
      reject(new Error(`Timeout: Element not found with any selector strategy`));
    }, timeout);
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
   CONDITION-BASED ELEMENT FIND
   Walks a container's subtree with a TreeWalker for O(n) early-exit rather
   than building a full NodeList with querySelectorAll("*").
───────────────────────────────────────────────────────────────────────────── */

function findElementByCondition(root, conditions) {
  if (!root || !conditions) return null;
  const { matchMode = 'any', valueEquals, textContains, idContains, classContains, typeEquals } = conditions;
  const normalize = (s) => (s ?? '').toString().trim().toLowerCase();

  const checks = [];
  if (valueEquals  !== undefined && valueEquals  !== '') checks.push(el => el.value !== undefined && String(el.value) === String(valueEquals));
  if (textContains != null && textContains !== '') {
    const needle = normalize(textContains);
    checks.push(el => {
      const ownText = normalize(
        Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(''),
      );
      return ownText.includes(needle) || normalize(el.textContent).includes(needle);
    });
  }
  if (idContains    != null && idContains    !== '') { const n = normalize(idContains);    checks.push(el => normalize(el.id).includes(n)); }
  if (classContains != null && classContains !== '') { const n = normalize(classContains); checks.push(el => normalize(el.className).includes(n)); }
  if (typeEquals    != null && typeEquals    !== '') checks.push(el => el.type === typeEquals);
  if (checks.length === 0) return null;

  const test = matchMode === 'all'
    ? (el) => checks.every(fn => fn(el))
    : (el) => checks.some(fn => fn(el));

  // TreeWalker with early-exit — avoids building a full NodeList.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    if (test(node)) return node;
    node = walker.nextNode();
  }
  return null;
}

function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);

    let resolved = false;
    let rafQueued = false;
    const observer = new MutationObserver(() => {
      if (resolved || rafQueued) return;
      rafQueued = true;
      requestAnimationFrame(() => {
        rafQueued = false;
        if (resolved) return;
        const el = document.querySelector(selector);
        if (el) { resolved = true; observer.disconnect(); clearTimeout(t); resolve(el); }
      });
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    const t = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      observer.disconnect();
      reject(new Error(`Timeout waiting for ${selector}`));
    }, timeout);
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
   RECORDING
───────────────────────────────────────────────────────────────────────────── */

document.addEventListener('click', (event) => {
  if (pickerMode) return;

  // Flush pending debounced input before recording the click.
  const activeEl = document.activeElement;
  if (activeEl && _inputDebounceTimers.has(activeEl)) {
    clearTimeout(_inputDebounceTimers.get(activeEl));
    _inputDebounceTimers.delete(activeEl);
    const pendingSelectors = getAllSelectors(activeEl);
    if (pendingSelectors) {
      safeSend({
        type: 'RECORDED_ACTION',
        action: { type: 'input', selector: pendingSelectors.css, selectors: pendingSelectors, value: activeEl.value, frameId: _myFrameId },
      });
    }
  }

  const selectors = getAllSelectors(event.target);
  if (!selectors) return;
  safeSend({ type: 'RECORDED_ACTION', action: { type: 'click', selector: selectors.css, selectors, frameId: _myFrameId } });
}, true);

// WeakMap keyed by element so timers are GC'd when their element is removed
// from the DOM without needing an explicit cleanup step.
const _inputDebounceTimers = new WeakMap();

document.addEventListener('input', (event) => {
  const el = event.target;
  const selectors = getAllSelectors(el);
  if (!selectors) return;

  // 400 ms debounce: records the final value after typing pauses rather than
  // one action per keystroke.  This keeps the action list readable and reduces
  // the number of recorded actions for long inputs.
  if (_inputDebounceTimers.has(el)) clearTimeout(_inputDebounceTimers.get(el));
  _inputDebounceTimers.set(el, setTimeout(() => {
    _inputDebounceTimers.delete(el);
    safeSend({
      type: 'RECORDED_ACTION',
      action: { type: 'input', selector: selectors.css, selectors, value: el.value, frameId: _myFrameId },
    });
  }, 400));
}, true);

/* ─────────────────────────────────────────────────────────────────────────────
   PLAYBACK
───────────────────────────────────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'PLAY_ACTION') return;

  (async () => {
    const action = msg.action;

    /* ── readdom ── */
    if (action.type === 'readdom') {
      const actionTimeout = (action.timeout && action.timeout > 0) ? action.timeout : 5000;
      try {
        let el;
        if (action.selectors && typeof action.selectors === 'object') {
          el = await findElementWithFallback(action.selectors, actionTimeout);
        } else if (action.selector) {
          el = await findElementWithFallback({ css: action.selector }, actionTimeout);
        }
        if (!el) { sendResponse({ failed: true }); return; }
        const value = action.readFrom === 'value' ? (el.value ?? '')
                    : action.readFrom === 'attr'  ? (el.getAttribute(action.attrName || '') ?? '')
                    : (el.textContent?.trim() ?? '');
        sendResponse({ value });
      } catch (_) {
        sendResponse({ failed: true });
      }
      return;
    }

    /* ── script — content-script fallback (CDP is preferred; used when debugger unavailable) ── */
    if (action.type === 'script') {
      try {
        const code = (action.code || '').replace(/^javascript:/i, '').trim();
        const fn = new Function('window', 'document', code);
        fn.call(window, window, document);
      } catch (err) {
        console.error('[CONTENT] Script error:', err);
      }
      sendResponse();
      return;
    }

    /* ── Resolve target element ── */
    const actionTimeout = (action.timeout && action.timeout > 0) ? action.timeout : 5000;
    let target;
    try {
      if (action.conditions && action.selector) {
        const parent = await findElementWithFallback(
          action.selectors && typeof action.selectors === 'object'
            ? action.selectors : { css: action.selector },
          actionTimeout,
        );
        target = parent ? findElementByCondition(parent, action.conditions) : null;
      } else if (action.selectors && typeof action.selectors === 'object') {
        target = await findElementWithFallback(action.selectors, actionTimeout);
      } else if (action.selector) {
        target = await findElementWithFallback({ css: action.selector }, actionTimeout);
      } else {
        target = null;
      }
    } catch (e) {
      console.error('[CONTENT] Element find error:', e);
      sendResponse({ failed: true, error: e.message });
      return;
    }

    if (!target) { sendResponse({ failed: true }); return; }

    // scrollIntoView first, then re-query on the next rAF.
    // Virtualized lists (React-Window, AG-Grid) unmount and remount rows during
    // scroll — the original `target` reference may be stale after scrolling.
    target.scrollIntoView({ behavior: 'auto', block: 'center' });
    await new Promise(r => requestAnimationFrame(r));
    if (action.selectors && typeof action.selectors === 'object') {
      try {
        const requeried = await findElementWithFallback(action.selectors, 500);
        if (requeried) {
          if (action.conditions) {
            const rechild = findElementByCondition(requeried, action.conditions);
            if (rechild) target = rechild;
          } else {
            target = requeried;
          }
        }
      } catch (_) { /* keep original target */ }
    }
    target.focus();

    /* ── HOVER ── */
    if (action.type === 'hover') {
      const rect = target.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top  + rect.height / 2;
      const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
      target.dispatchEvent(new MouseEvent('mouseover',  opts));
      target.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
      target.dispatchEvent(new MouseEvent('mousemove',  opts));
      sendResponse();
      return;
    }

    /* ── DRAG & DROP ── */
    if (action.type === 'dragdrop') {
      let dropEl = null;
      if (action.targetSelector) {
        const ts = (action.targetSelectors && typeof action.targetSelectors === 'object')
          ? action.targetSelectors : { css: action.targetSelector };
        dropEl = await findElementWithFallback(ts, actionTimeout).catch(() => null);
      }
      if (!dropEl) { sendResponse({ failed: true }); return; }
      const srcRect = target.getBoundingClientRect();
      const dstRect = dropEl.getBoundingClientRect();
      const sx = srcRect.left + srcRect.width  / 2, sy = srcRect.top  + srcRect.height / 2;
      const dx = dstRect.left + dstRect.width  / 2, dy = dstRect.top  + dstRect.height / 2;
      const dt = new DataTransfer();
      const fireM = (el, t, x, y, extra = {}) => el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, ...extra }));
      const fireD = (el, t, x, y) => el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
      fireM(target, 'mousedown', sx, sy, { button: 0 });
      fireD(target, 'dragstart', sx, sy);
      fireD(dropEl, 'dragenter', dx, dy);
      fireD(dropEl, 'dragover',  dx, dy);
      fireD(dropEl, 'drop',      dx, dy);
      fireD(target, 'dragend',   dx, dy);
      fireM(target, 'mouseup',   dx, dy);
      sendResponse();
      return;
    }

    /* ── CLICK ── */
    if (action.type === 'click') {
      // Fire the full mousedown → mouseup → click sequence with realistic
      // clientX/Y coordinates.  Some frameworks (jQuery UI, custom widgets)
      // require mousedown/mouseup to fire their internal handlers; target.click()
      // alone only fires "click" and misses those.
      const rect = target.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top  + rect.height / 2;
      const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 };
      target.dispatchEvent(new MouseEvent('mousedown', opts));
      target.dispatchEvent(new MouseEvent('mouseup',   opts));
      target.click(); // fires 'click' event + follows links/submits forms
      sendResponse();
      return;
    }

    /* ── DROPDOWN fallback ── */
    if (action.type === 'dropdown') {
      target.click();
      sendResponse();
      return;
    }

    /* ── INPUT / SELECT ── */
    if (action.type === 'input') {
      if (target.isContentEditable) {
        // Rich-text editors (Quill, Draft.js, Tiptap) manage state via mutation
        // observers on contenteditable.  Direct .textContent assignment bypasses
        // those observers; document.execCommand fires the correct mutation events.
        target.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, action.value ?? '');
        target.dispatchEvent(new Event('input',  { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        sendResponse();
        return;
      } else if (target.tagName === 'SELECT') {
        target.value = action.value;
        if (target.value !== action.value) {
          const option = [...target.options].find(
            o => o.value === action.value || o.text === action.value,
          );
          if (option) { option.selected = true; target.value = option.value; }
        }
        target.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
        target.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        target.dispatchEvent(new Event('blur',   { bubbles: true }));
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      } else {
        // Walk the prototype chain to find the native HTMLInputElement value setter.
        // React/Vue override .value to track their internal fiber state — direct
        // property assignment (el.value = x) bypasses that override and breaks
        // controlled components.  The native setter triggers the synthetic event
        // system (SyntheticInputEvent) correctly.
        let nativeSetter = null;
        let proto = Object.getPrototypeOf(target);
        while (proto && proto !== Object.prototype) {
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc?.set) { nativeSetter = desc.set; break; }
          proto = Object.getPrototypeOf(proto);
        }
        if (nativeSetter) {
          nativeSetter.call(target, action.value ?? '');
        } else {
          target.value = action.value ?? '';
        }
        target.dispatchEvent(new Event('input',  { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        target.dispatchEvent(new Event('blur',   { bubbles: true }));
      }

      if (action.waitForElement) {
        (async () => {
          try { await waitForElement(action.waitForElement, 5000); }
          catch (_) { /* element wait timeout — continue */ }
          sendResponse();
        })();
        return;
      }
      sendResponse();
      return;
    }

    sendResponse();
  })();

  return true; // async
});

/* ─────────────────────────────────────────────────────────────────────────────
   ELEMENT PICKER
───────────────────────────────────────────────────────────────────────────── */

function showPickerBar() {
  if (document.getElementById('__picker_bar')) return;
  const bar = document.createElement('div');
  bar.id = '__picker_bar';
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:rgba(79,70,229,0.95);color:#fff;font:13px/1.4 system-ui,sans-serif;text-align:center;padding:8px 16px;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
  bar.textContent = '🎯 Click an element to select it. Press ESC to cancel.';
  document.documentElement.appendChild(bar);
}
function hidePickerBar() { document.getElementById('__picker_bar')?.remove(); }

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'START_PICK_MODE') {
    pickerMode = true;
    document.body.style.cursor = 'crosshair';
    showPickerBar();
  }
  if (msg.type === 'STOP_PICK_MODE') {
    pickerMode = false;
    clearPickerUI();
  }
});

let _pickerTarget = null;

function _updatePickerOverlay(el) {
  _pickerTarget = el;
  let overlay = document.getElementById('__picker_overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = '__picker_overlay';
    overlay.style.cssText = [
      'position:fixed', 'pointer-events:none', 'z-index:2147483646', 'box-sizing:border-box',
      'border:2px solid #4f46e5', 'background:rgba(79,70,229,0.08)', 'transition:none',
    ].join(';');
    document.documentElement.appendChild(overlay);
  }
  const r = el.getBoundingClientRect();
  overlay.style.left   = r.left   + 'px';
  overlay.style.top    = r.top    + 'px';
  overlay.style.width  = r.width  + 'px';
  overlay.style.height = r.height + 'px';
  overlay.style.display = '';

  const bar = document.getElementById('__picker_bar');
  if (bar) {
    const tag = el.tagName.toLowerCase();
    const id  = el.id   ? `#${el.id}`   : '';
    const cls = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/)[0] : '';
    bar.textContent = `🎯 ${tag}${id || cls}  —  Click to select. ESC to cancel.`;
  }
}

function _removePickerOverlay() {
  _pickerTarget = null;
  document.getElementById('__picker_overlay')?.remove();
}

document.addEventListener('mouseover', (event) => {
  if (!pickerMode) return;
  _updatePickerOverlay(event.target);
}, true);

document.addEventListener('click', (event) => {
  if (!pickerMode) return;
  event.preventDefault();
  event.stopImmediatePropagation();

  const el = _pickerTarget || event.target;
  const selectors = getAllSelectors(el);
  if (!selectors) return;

  const _cr = el.getBoundingClientRect();
  const pickedRect = {
    x:      Math.round(_cr.left + window.scrollX),
    y:      Math.round(_cr.top  + window.scrollY),
    width:  Math.round(_cr.width),
    height: Math.round(_cr.height),
  };

  chrome.storage.local.set({ lastPickedSelector: selectors.css, lastPickedSelectors: selectors });
  safeSend({ type: 'ELEMENT_PICKED', selector: selectors.css, selectors, rect: pickedRect });
  pickerMode = false;
  clearPickerUI();
}, true);

function clearPickerUI() {
  document.body.style.cursor = 'auto';
  hidePickerBar();
  _removePickerOverlay();
}

/* ─────────────────────────────────────────────────────────────────────────────
   FULL PAGE SCREENSHOT HELPER
───────────────────────────────────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_PAGE_DIMENSIONS') {
    const body = document.body;
    const html = document.documentElement;
    const fullHeight = Math.max(body.scrollHeight, body.offsetHeight, html.clientHeight, html.scrollHeight, html.offsetHeight);
    const fullWidth  = Math.max(body.scrollWidth,  body.offsetWidth,  html.clientWidth,  html.scrollWidth,  html.offsetWidth);
    sendResponse({
      fullWidth, fullHeight,
      viewportWidth:   window.innerWidth,
      viewportHeight:  window.innerHeight,
      scrollX:         window.scrollX,
      scrollY:         window.scrollY,
      devicePixelRatio: window.devicePixelRatio || 1,
    });
    return true;
  }

  if (msg.type === 'GET_ELEMENT_RECT') {
    try {
      let el = null;
      const s = msg.selectors;
      if (s?.fullXpath) el = document.evaluate(s.fullXpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (!el && s?.xpath) el = document.evaluate(s.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (!el && s?.id)    el = document.getElementById(s.id);
      if (!el && msg.selector) el = document.querySelector(msg.selector);

      if (!el) { sendResponse({ error: 'Element not found' }); return true; }
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) { sendResponse({ error: 'Element has no size' }); return true; }
      sendResponse({
        x: rect.left + window.scrollX,
        y: rect.top  + window.scrollY,
        width:  rect.width,
        height: rect.height,
        devicePixelRatio: window.devicePixelRatio || 1,
      });
    } catch (e) {
      sendResponse({ error: e.message });
    }
    return true;
  }

  /* ── CHECK_CONDITION ── */
  if (msg.type === 'CHECK_CONDITION') {
    const { conditionType, selector, selectors: selectorMap, expectedValue } = msg;

    // Synchronous element lookup matching 22/05 behaviour — conditions evaluate
    // the DOM at the current moment, no waiting. Uses full selector map when
    // available (fullXpath → id → xpath → css) for accuracy.
    const getEl = () => {
      const s = selectorMap;
      if (s && typeof s === 'object') {
        let el = null;
        try { if (s.fullXpath) el = document.evaluate(s.fullXpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch(_) {}
        if (!el && s.id) el = document.getElementById(s.id);
        try { if (!el && s.xpath) el = document.evaluate(s.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch(_) {}
        if (!el && s.css) { try { el = document.querySelector(s.css); } catch(_) {} }
        return el || null;
      }
      if (selector) { try { return document.querySelector(selector); } catch(_) {} }
      return null;
    };

    let result = false;
    try {
      switch (conditionType) {
        case 'elementExists': {
          result = !!getEl();
          break;
        }
        case 'elementNotExists': {
          result = !getEl();
          break;
        }
        case 'elementVisible': {
          const el = getEl();
          if (el) {
            const style = getComputedStyle(el);
            const rect  = el.getBoundingClientRect();
            result = style.display !== 'none' && style.visibility !== 'hidden' &&
                     style.opacity !== '0' && rect.width > 0 && rect.height > 0;
          }
          break;
        }
        case 'elementHidden': {
          const el = getEl();
          if (!el) {
            result = true;
          } else {
            const style = getComputedStyle(el);
            const rect  = el.getBoundingClientRect();
            result = style.display === 'none' || style.visibility === 'hidden' ||
                     style.opacity === '0' || rect.width === 0 || rect.height === 0;
          }
          break;
        }
        case 'textContains': {
          const el = getEl();
          if (el) result = el.textContent.includes(expectedValue);
          break;
        }
        case 'textEquals': {
          const el = getEl();
          if (el) result = el.textContent.trim() === (expectedValue || '').trim();
          break;
        }
        case 'valueEquals': {
          const el = getEl();
          if (el && 'value' in el) result = el.value === expectedValue;
          break;
        }
        case 'valueContains': {
          const el = getEl();
          if (el && 'value' in el) result = el.value.includes(expectedValue);
          break;
        }
        case 'urlContains': result = window.location.href.includes(expectedValue); break;
        case 'urlEquals':   result = window.location.href === expectedValue; break;
        case 'hasClass': {
          const el = getEl();
          if (el) result = el.classList.contains(expectedValue);
          break;
        }
        case 'hasAttribute': {
          const el = getEl();
          if (el) {
            if ((expectedValue || '').includes('=')) {
              const eqIdx    = expectedValue.indexOf('=');
              const attrName = expectedValue.slice(0, eqIdx);
              const attrVal  = expectedValue.slice(eqIdx + 1);
              result = el.hasAttribute(attrName) && el.getAttribute(attrName) === attrVal;
            } else {
              result = el.hasAttribute(expectedValue);
            }
          }
          break;
        }
        default:
          result = true; // unknown type → pass
      }
    } catch (e) {
      console.error('[CONTENT] CHECK_CONDITION error:', e);
      result = true; // error → pass (match 22/05 behaviour)
    }
    sendResponse({ result });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   HOTKEYS
───────────────────────────────────────────────────────────────────────────── */

let activeHotkeys = {
  startRecord:         'Alt+R',
  stopRecord:          'Alt+S',
  screenshot:          'Alt+P',
  screenshotFull:      'Alt+Shift+F',
  screenshotScrollV:   'Alt+V',
  screenshotScrollH:   'Alt+H',
  segV:                'Alt+Shift+V',
  segH:                'Alt+Shift+H',
  segStop:             'Alt+X',
  screenshotElement:   'Alt+E',
};

chrome.storage.sync.get(['hotkeys'], (res) => {
  if (res.hotkeys) activeHotkeys = { ...activeHotkeys, ...res.hotkeys };
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.hotkeys) {
    activeHotkeys = { ...activeHotkeys, ...changes.hotkeys.newValue };
  }
});

function getKeyCombo(e) {
  const parts = [];
  if (e.ctrlKey)  parts.push('Ctrl');
  if (e.altKey)   parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey)  parts.push('Meta');
  const key = e.key;
  if (!key) return parts.join('+');
  if (!['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
    parts.push(key.length === 1 ? key.toUpperCase() : key);
  }
  return parts.join('+');
}

/* ─────────────────────────────────────────────────────────────────────────────
   VISIBLE SCREENSHOT COUNTDOWN
───────────────────────────────────────────────────────────────────────────── */

let _countdownActive = false;
let _countdownTimer  = null;

function _startVisibleCountdown(seconds, crop) {
  if (_countdownActive) return;
  _countdownActive = true;
  let remaining = seconds;

  const overlay = document.createElement('div');
  overlay.id = '__screenshot_countdown';
  overlay.style.cssText = [
    'position:fixed', 'top:12px', 'right:12px', 'z-index:2147483647',
    'display:flex', 'align-items:center', 'gap:8px',
    'background:rgba(30,30,30,0.82)', 'color:#fff',
    'padding:6px 12px 6px 10px', 'border-radius:10px',
    'font:13px system-ui,sans-serif', 'pointer-events:all',
    'box-shadow:0 2px 10px rgba(0,0,0,0.4)',
  ].join(';');

  const numEl = document.createElement('span');
  numEl.style.cssText = 'font:bold 20px system-ui,sans-serif;min-width:18px;text-align:center;';
  numEl.textContent = remaining;

  const hint = document.createElement('span');
  hint.style.cssText = 'font:12px system-ui,sans-serif;color:rgba(255,255,255,0.75);';
  hint.textContent = 'Open dropdown…';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '✕';
  cancelBtn.title = 'Cancel (ESC)';
  cancelBtn.style.cssText = [
    'margin-left:4px', 'padding:1px 5px', 'border:none',
    'background:rgba(255,255,255,0.15)', 'color:#fff', 'border-radius:4px',
    'cursor:pointer', 'font:12px system-ui,sans-serif', 'line-height:1.4',
  ].join(';');
  cancelBtn.addEventListener('click', _cancelCountdown);

  overlay.appendChild(numEl);
  overlay.appendChild(hint);
  overlay.appendChild(cancelBtn);
  document.documentElement.appendChild(overlay);

  const tick = () => {
    remaining--;
    if (remaining <= 0) { _fireVisibleCapture(crop); return; }
    numEl.textContent = remaining;
    _countdownTimer = setTimeout(tick, 1000);
  };
  _countdownTimer = setTimeout(tick, 1000);
}

function _fireVisibleCapture(crop) {
  document.getElementById('__screenshot_countdown')?.remove();
  _countdownActive = false;
  _countdownTimer  = null;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    safeSend({ type: 'TAKE_SCREENSHOT', crop: !!crop });
  }));
}

function _cancelCountdown() {
  clearTimeout(_countdownTimer);
  document.getElementById('__screenshot_countdown')?.remove();
  _countdownActive = false;
  _countdownTimer  = null;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'START_VISIBLE_COUNTDOWN') {
    _startVisibleCountdown(msg.seconds || 3, !!msg.crop);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _countdownActive) { e.preventDefault(); _cancelCountdown(); return; }
  if (pickerMode && e.key === 'Escape') {
    e.preventDefault(); pickerMode = false; clearPickerUI();
    safeSend({ type: 'STOP_PICK_MODE' }); return;
  }

  const tag = document.activeElement?.tagName;
  if (['INPUT', 'TEXTAREA'].includes(tag)) return;
  if (document.activeElement?.isContentEditable) return;

  const combo = getKeyCombo(e);

  if (combo === activeHotkeys.startRecord || combo === activeHotkeys.stopRecord) {
    e.preventDefault();
    chrome.runtime.sendMessage({ type: 'IS_TAB_ACTIVATED' }, (res) => {
      if (!res?.activated) return;
      if (combo === activeHotkeys.startRecord) { safeSend({ type: 'START_RECORD' }); }
      else                                     { safeSend({ type: 'STOP_RECORD'  }); }
    });
  } else if (combo === activeHotkeys.screenshot) {
    e.preventDefault();
    chrome.storage.local.get(['screenshotCountdownEnabled', 'screenshotCountdownSeconds'], (res) => {
      if (res.screenshotCountdownEnabled) _startVisibleCountdown(res.screenshotCountdownSeconds || 3, true);
      else safeSend({ type: 'TAKE_SCREENSHOT', crop: true });
    });
  } else if (combo === activeHotkeys.screenshotFull)   { e.preventDefault(); safeSend({ type: 'TAKE_SCREENSHOT_FULL', crop: true }); }
  else if (activeHotkeys.screenshotScrollV && combo === activeHotkeys.screenshotScrollV) { e.preventDefault(); safeSend({ type: 'TAKE_SCREENSHOT_SCROLL_V' }); }
  else if (activeHotkeys.screenshotScrollH && combo === activeHotkeys.screenshotScrollH) { e.preventDefault(); safeSend({ type: 'TAKE_SCREENSHOT_SCROLL_H' }); }
  else if (activeHotkeys.segV && combo === activeHotkeys.segV)   { e.preventDefault(); safeSend({ type: 'HOTKEY_SEG_START', dir: 'vertical'   }); }
  else if (activeHotkeys.segH && combo === activeHotkeys.segH)   { e.preventDefault(); safeSend({ type: 'HOTKEY_SEG_START', dir: 'horizontal' }); }
  else if (activeHotkeys.segStop && combo === activeHotkeys.segStop) {
    e.preventDefault();
    if (_segCapture) document.querySelector('#__ext_seg_bar_stop')?.click();
  } else if (activeHotkeys.screenshotElement && combo === activeHotkeys.screenshotElement) {
    e.preventDefault(); safeSend({ type: 'HOTKEY_SCREENSHOT_ELEMENT' });
  }
}, true);

/* ─────────────────────────────────────────────────────────────────────────────
   PING / PONG
───────────────────────────────────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ type: 'PONG', ready: true, timestamp: Date.now() });
    return true;
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   SEGMENT CAPTURE OVERLAY
───────────────────────────────────────────────────────────────────────────── */

let _segCapture = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'START_SEGMENT_TAB') return;

  if (_segCapture) _segCapture.cleanup();

  const dir    = msg.dir;
  const isVert = dir === 'vertical';
  const startX = window.scrollX;
  const startY = window.scrollY;

  const bar = document.createElement('div');
  bar.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0',
    'background:rgba(20,20,20,0.92)', 'color:#fff',
    'font:13px/1.4 sans-serif', 'padding:8px 14px',
    'display:flex', 'align-items:center', 'gap:12px',
    'z-index:2147483647', 'box-shadow:0 2px 8px rgba(0,0,0,0.5)',
  ].join(';');

  const lblStart   = document.createElement('span');
  lblStart.textContent = `📍 Start: X = ${startX}px, Y = ${startY}px`;

  const lblCurrent = document.createElement('span');
  lblCurrent.style.flex = '1';

  const updateLbl = () => {
    const endX = window.scrollX + window.innerWidth;
    const endY = window.scrollY + window.innerHeight;
    lblCurrent.textContent = `To: X=${endX}px, Y=${endY}px (W=${Math.abs(endX - startX)}px, H=${Math.abs(endY - startY)}px)`;
  };
  updateLbl();

  const btnCancel = document.createElement('button');
  btnCancel.textContent = '✖ Cancel';
  btnCancel.style.cssText = 'background:#555;color:#fff;border:none;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:12px;';

  const btnStop = document.createElement('button');
  btnStop.id = '__ext_seg_bar_stop';
  btnStop.textContent = '⏹ Stop & Capture';
  btnStop.style.cssText = 'background:#e74c3c;color:#fff;border:none;padding:5px 12px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;';

  bar.append(lblStart, lblCurrent, btnCancel, btnStop);
  document.documentElement.appendChild(bar);

  let rafId = null, scrollStopped = false, scrollStep = 2;
  const speedKey = isVert ? 'segScrollSpeedV' : 'segScrollSpeedH';
  chrome.storage.sync.get([speedKey], (res) => {
    scrollStep = Math.min(10, Math.max(0.1, parseFloat(res[speedKey]) || 2));
  });

  const scrollLoop = () => {
    if (scrollStopped) return;
    const before = isVert ? window.scrollY : window.scrollX;
    if (isVert) window.scrollBy(0, scrollStep); else window.scrollBy(scrollStep, 0);
    const after = isVert ? window.scrollY : window.scrollX;
    updateLbl();
    if (after === before) { scrollStopped = true; btnStop.textContent = '⏹ Capture (end of page)'; return; }
    rafId = requestAnimationFrame(scrollLoop);
  };
  rafId = requestAnimationFrame(scrollLoop);

  const cleanup = () => {
    scrollStopped = true;
    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
    bar.remove();
    _segCapture = null;
  };

  btnCancel.addEventListener('click', () => {
    cleanup();
    chrome.runtime.sendMessage({ type: 'CANCEL_SEGMENT_CAPTURE' });
  });

  btnStop.addEventListener('click', () => {
    const endX = window.scrollX + window.innerWidth;
    const endY = window.scrollY + window.innerHeight;
    cleanup();
    window.scrollTo(startX, startY);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      chrome.runtime.sendMessage({
        type: 'CAPTURE_SEGMENT',
        xStart: Math.min(startX, endX), yStart: Math.min(startY, endY),
        xEnd:   Math.max(startX, endX), yEnd:   Math.max(startY, endY),
      });
    }));
  });

  _segCapture = { cleanup };
  sendResponse({ ok: true });
  return true;
});

/* ─────────────────────────────────────────────────────────────────────────────
   NOTIFY READY
───────────────────────────────────────────────────────────────────────────── */

safeSend({ type: 'CONTENT_READY' });

} // End of injection guard
