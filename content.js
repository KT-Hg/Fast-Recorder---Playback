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

// Detects {fallback:A|B|C} format stored in a condition field value.
const _FALLBACK_RE = /^\{fallback:(.+)\}$/;
function _parseFallbackSpec(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(_FALLBACK_RE);
  return m ? m[1].split('|').map(s => s.trim()).filter(Boolean) : null;
}

// Core single-value child search.  Used by findElementByCondition for both the
// direct path (no fallback) and each iteration of the fallback path.
function _findElementSingle(root, conditions, normalize) {
  const { matchMode = 'any', valueEquals, textContains, idContains, classContains, typeEquals } = conditions;
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
  const test = matchMode === 'all' ? el => checks.every(fn => fn(el)) : el => checks.some(fn => fn(el));
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) { if (test(node)) return node; node = walker.nextNode(); }
  return null;
}

/**
 * Search a container's subtree for the first child element matching `conditions`.
 *
 * Supports {fallback:A|B|C} in condition string fields:
 *   Tries value A first; if no child matches, tries B, then C.
 *   The first value that finds a match is returned along with which spec it came
 *   from (resolvedFallbacks), so the caller can persist it for sticky resolution.
 *
 * Returns { el: Element|null, resolvedFallbacks: { spec: resolvedValue } }.
 */
function findElementByCondition(root, conditions) {
  if (!root || !conditions) return { el: null, resolvedFallbacks: {} };

  const normalize = (s) => (s ?? '').toString().trim().toLowerCase();
  const resolvedFallbacks = {};

  // Detect the first condition field that contains a fallback spec.
  const FALLBACK_FIELDS = ['valueEquals', 'textContains', 'idContains', 'classContains', 'typeEquals'];
  let fbField = null, fbVals = null;
  for (const f of FALLBACK_FIELDS) {
    const vals = _parseFallbackSpec(conditions[f]);
    if (vals) { fbField = f; fbVals = vals; break; }
  }

  if (!fbField) {
    // No fallback — single-value search.
    const el = _findElementSingle(root, conditions, normalize);
    return { el, resolvedFallbacks };
  }

  // Fallback path: try each value in order, stop on first match.
  const originalSpec = conditions[fbField];
  for (const val of fbVals) {
    const resolved = { ...conditions, [fbField]: val };
    const el = _findElementSingle(root, resolved, normalize);
    if (el) {
      resolvedFallbacks[originalSpec] = val; // record which value succeeded
      return { el, resolvedFallbacks };
    }
  }
  return { el: null, resolvedFallbacks };
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

    // Accumulates fallback resolutions from findElementByCondition calls in this
    // action.  Sent back in every success response so playback.js can persist
    // sticky values into resolvedVars for the rest of the run.
    const _rf = {};
    const _ok = (data = {}) => sendResponse({ ...data, resolvedFallbacks: _rf });

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
        _ok({ value });
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
      _ok();
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
        if (parent) {
          const { el, resolvedFallbacks } = findElementByCondition(parent, action.conditions);
          target = el;
          Object.assign(_rf, resolvedFallbacks);
        }
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
            const { el: rechild, resolvedFallbacks: rf2 } = findElementByCondition(requeried, action.conditions);
            if (rechild) { target = rechild; Object.assign(_rf, rf2); }
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
      _ok();
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
      _ok();
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
      _ok();
      return;
    }

    /* ── DROPDOWN fallback ── */
    if (action.type === 'dropdown') {
      target.click();
      _ok();
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
        _ok();
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
          _ok();
        })();
        return;
      }
      _ok();
      return;
    }

    _ok();
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

  try { chrome.storage.local.set({ lastPickedSelector: selectors.css, lastPickedSelectors: selectors }); } catch (_) {}
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

try {
  chrome.storage.sync.get(['hotkeys'], (res) => {
    try { void chrome.runtime.lastError; if (res?.hotkeys) activeHotkeys = { ...activeHotkeys, ...res.hotkeys }; } catch (_) {}
  });
} catch (_) {}
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.hotkeys) {
      activeHotkeys = { ...activeHotkeys, ...changes.hotkeys.newValue };
    }
  });
} catch (_) {}

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
    try {
      if (!chrome.runtime?.id) return;
      chrome.runtime.sendMessage({ type: 'IS_TAB_ACTIVATED' }, (res) => {
        if (chrome.runtime.lastError) return;
        if (!res?.activated) return;
        if (combo === activeHotkeys.startRecord) { safeSend({ type: 'START_RECORD' }); }
        else                                     { safeSend({ type: 'STOP_RECORD'  }); }
      });
    } catch (_) {}
  } else if (combo === activeHotkeys.screenshot) {
    e.preventDefault();
    try {
      if (!chrome.runtime?.id) return;
      chrome.storage.local.get(['screenshotCountdownEnabled', 'screenshotCountdownSeconds'], (res) => {
        try {
          void chrome.runtime.lastError;
          if (res.screenshotCountdownEnabled) _startVisibleCountdown(res.screenshotCountdownSeconds || 3, true);
          else safeSend({ type: 'TAKE_SCREENSHOT', crop: true });
        } catch (_) {}
      });
    } catch (_) {}
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
  try {
    chrome.storage.sync.get([speedKey], (res) => {
      try { void chrome.runtime.lastError; scrollStep = Math.min(10, Math.max(0.1, parseFloat(res?.[speedKey]) || 2)); } catch (_) {}
    });
  } catch (_) {}

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
    safeSend({ type: 'CANCEL_SEGMENT_CAPTURE' });
  });

  btnStop.addEventListener('click', () => {
    const endX = window.scrollX + window.innerWidth;
    const endY = window.scrollY + window.innerHeight;
    cleanup();
    window.scrollTo(startX, startY);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      safeSend({
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
   HIGHLIGHT ENGINE
───────────────────────────────────────────────────────────────────────────── */

const _HL_KEY = 'hl_v1';

const _HL_COLORS = {
  yellow: { light: '#fde047', dark: 'rgba(253,224,71,0.75)'  },
  green:  { light: '#86efac', dark: 'rgba(74,222,128,0.70)'  },
  pink:   { light: '#f9a8d4', dark: 'rgba(244,114,182,0.72)' },
  blue:   { light: '#93c5fd', dark: 'rgba(147,197,253,0.72)' },
  orange: { light: '#fdba74', dark: 'rgba(251,146,60,0.75)'  },
};

function _hlBg(color) {
  const bg = window.getComputedStyle(document.body).backgroundColor;
  const m = bg.match(/\d+/g);
  const isDark = m ? (Number(m[0]) * 0.299 + Number(m[1]) * 0.587 + Number(m[2]) * 0.114) < 100 : false;
  return isDark ? (_HL_COLORS[color]?.dark ?? _HL_COLORS.yellow.dark)
                : (_HL_COLORS[color]?.light ?? _HL_COLORS.yellow.light);
}

function _hlCtxOk() { return !!chrome.runtime?.id; }

// ── Toggle / enabled state ──
let _hlEnabled      = true;
let _hlObserver     = null;
let _hlRestoreTimer = null;
let _hlStyleEl      = null;

// Override user-select:none so text in any element can be selected for highlighting.
// Uses high-specificity selector (0,1,2) to beat site rules like h1.class (0,1,1).
function _hlInjectStyle() {
  if (_hlStyleEl) return;
  _hlStyleEl = document.createElement('style');
  _hlStyleEl.setAttribute('data-hl-ui', '1');
  _hlStyleEl.textContent = 'html body * { user-select: text !important; -webkit-user-select: text !important; }';
  (document.head || document.documentElement).appendChild(_hlStyleEl);
}

function _hlRemoveStyle() {
  _hlStyleEl?.remove();
  _hlStyleEl = null;
}

function _hlSetEnabled(on) {
  _hlEnabled = on;
  if (on) {
    _hlInjectStyle();
    if (!_hlObserver) {
      _hlObserver = new MutationObserver(() => {
        clearTimeout(_hlRestoreTimer);
        _hlRestoreTimer = setTimeout(() => { if (_hlCtxOk()) _hlRestore(); }, 600);
      });
      _hlObserver.observe(document.documentElement, { childList: true, subtree: true });
      _hlRestore();
    }
  } else {
    _hlRemoveStyle();
    if (_hlObserver) {
      _hlObserver.disconnect();
      _hlObserver = null;
      _hlHideTip();
    }
    _hlHideNotePop();
  }
}

// ── URL pattern normalisation ──
const _HL_PATTERNS_KEY = 'hl_patterns_v1';
let _hlPatterns = [];

function _hlMatchPattern(url, pattern) {
  const strip = s => s.replace(/^https?:\/\//, '');
  const escaped = strip(pattern)
    .replace(/[.+?^${}()|[\]\\]/g, c => '\\' + c)
    .replace(/\*/g, '[^/]+');
  try { return new RegExp('^' + escaped + '(/.*)?$').test(strip(url)); }
  catch (_) { return false; }
}

function _hlNormalizeUrl(url) {
  for (const p of _hlPatterns) {
    if (_hlMatchPattern(url, p)) return p;
  }
  return url;
}

// ── Bootstrap: load patterns + enabled state, then start observer ──
function _hlInit() {
  try {
    if (!_hlCtxOk()) { _hlSetEnabled(true); return; }
    chrome.storage.local.get(['hl_enabled', _HL_PATTERNS_KEY, 'popupTheme'], res => {
      try {
        void chrome.runtime.lastError;
        _hlPatterns = res[_HL_PATTERNS_KEY] || [];
        _hlTheme = res.popupTheme === 'dark' ? 'dark' : 'light';
        _hlApplyTipTheme();
        _hlSetEnabled(res.hl_enabled !== false);
      } catch (_) { _hlSetEnabled(true); }
    });
  } catch (_) { _hlSetEnabled(true); }
}

// Keep patterns + theme in sync when popup changes them
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[_HL_PATTERNS_KEY]) {
      _hlPatterns = changes[_HL_PATTERNS_KEY].newValue || [];
    }
    if (area === 'local' && changes.popupTheme) {
      _hlTheme = changes.popupTheme.newValue === 'dark' ? 'dark' : 'light';
      _hlApplyTipTheme();
    }
  });
} catch (_) {}

function _hlGetAll(cb) {
  try {
    if (!_hlCtxOk()) return;
    chrome.storage.local.get(_HL_KEY, res => {
      try {
        void chrome.runtime.lastError;
        cb(res[_HL_KEY] || {});
      } catch (_) {}
    });
  } catch (_) {}
}

function _hlSavePage(list, cb) {
  _hlGetAll(all => {
    const key = _hlNormalizeUrl(location.href);
    all[key] = list;
    try {
      if (!_hlCtxOk()) { cb?.(); return; }
      chrome.storage.local.set({ [_HL_KEY]: all }, () => {
        try {
          void chrome.runtime.lastError;
          safeSend({ type: 'HL_UPDATED', url: key });
          cb?.();
        } catch (_) { cb?.(); }
      });
    } catch (_) { cb?.(); }
  });
}

function _hlGetPage(cb) {
  _hlGetAll(all => cb(all[_hlNormalizeUrl(location.href)] || []));
}

// ── Tooltip ──
let _hlTip = null;
let _hlRange = null;
let _hlAnchor = '';
let _hlParentSel = '';

// Tooltip mode: 'create' (from text selection) or 'edit' (hovering an existing
// highlight).  Both share one tooltip element — colour swatches + a note field.
let _hlTipMode    = 'create';
let _hlTipEditId  = null;
let _hlColorBtns  = {};     // color → swatch button
let _hlNoteWrap   = null;
let _hlNoteInput  = null;
let _hlNoteSaveBtn = null;
let _hlNoteHint   = null;
let _hlDelBtn     = null;
let _hlNoteBtn    = null;
let _hlTipLabel   = null;
let _hlNotePop    = null;   // small bubble showing a highlight's note on hover

// Tooltip colour palettes — mirror the popup's light / dark theme.
const _HL_TIP_THEMES = {
  dark:  { bg:'#1e1e2e', border:'rgba(255,255,255,0.12)', text:'#cdd6f4', sub:'rgba(205,214,244,0.55)', taBg:'#11111b', btnBorder:'rgba(255,255,255,0.18)' },
  light: { bg:'#ffffff', border:'rgba(0,0,0,0.14)',       text:'#1e1e2e', sub:'rgba(60,60,70,0.6)',      taBg:'#f4f4f7', btnBorder:'rgba(0,0,0,0.18)' },
};
let _hlTheme = 'dark';

function _hlTipEl() {
  if (_hlTip) return _hlTip;
  const d = document.createElement('div');
  d.setAttribute('data-hl-ui', '1');
  d.style.cssText = [
    'all:initial', 'position:fixed', 'z-index:2147483647',
    'display:none', 'flex-direction:column', 'gap:4px',
    'background:#1e1e2e', 'border:1px solid rgba(255,255,255,0.12)',
    'border-radius:10px', 'padding:6px 8px',
    'box-shadow:0 4px 24px rgba(0,0,0,0.45)',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'font-size:11px', 'color:#cdd6f4',
    'pointer-events:auto', 'user-select:none',
  ].join(';');

  const lbl = document.createElement('div');
  lbl.textContent = 'Highlight color:';
  lbl.style.cssText = 'font-size:10px;color:rgba(205,214,244,0.55);font-family:inherit;line-height:1;';
  _hlTipLabel = lbl;
  d.appendChild(lbl);

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;align-items:center;font-family:inherit;line-height:0;';

  const DOTS = { yellow:'#fde047', green:'#86efac', pink:'#f9a8d4', blue:'#93c5fd', orange:'#fdba74' };
  const LABELS = { yellow:'Yellow', green:'Green', pink:'Pink', blue:'Blue', orange:'Orange' };
  _hlColorBtns = {};
  Object.keys(DOTS).forEach(color => {
    const btn = document.createElement('button');
    btn.style.cssText = [
      'all:initial', 'display:inline-block',
      `background:${DOTS[color]}`,
      'width:22px', 'height:22px', 'border-radius:50%',
      'cursor:pointer', 'border:2px solid transparent',
      'box-sizing:border-box',
      'transition:transform 0.1s,border-color 0.1s',
    ].join(';');
    btn.title = LABELS[color];
    btn.addEventListener('mouseenter', () => { btn.style.transform = 'scale(1.25)'; btn.style.borderColor = 'rgba(255,255,255,0.7)'; });
    btn.addEventListener('mouseleave', () => { btn.style.transform = ''; btn.style.borderColor = btn.dataset.sel === '1' ? 'rgba(255,255,255,0.9)' : 'transparent'; });
    btn.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (_hlTipMode === 'edit') _hlEditSetColor(color);
      else _hlApply(color);
    });
    _hlColorBtns[color] = btn;
    row.appendChild(btn);
  });

  // Note toggle button — placed after the orange swatch.
  const noteBtn = document.createElement('button');
  noteBtn.textContent = '📝';
  noteBtn.title = 'Note';
  noteBtn.style.cssText = [
    'all:initial', 'cursor:pointer', 'font-size:16px', 'line-height:1',
    'width:24px', 'height:24px', 'border-radius:6px', 'text-align:center',
    'border:1px solid rgba(255,255,255,0.18)', 'box-sizing:border-box',
    'margin-left:2px', 'transition:background 0.1s',
  ].join(';');
  noteBtn.addEventListener('mouseenter', () => { noteBtn.style.background = 'rgba(255,255,255,0.12)'; });
  noteBtn.addEventListener('mouseleave', () => { noteBtn.style.background = 'transparent'; });
  noteBtn.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
  noteBtn.addEventListener('click', e => {
    e.stopPropagation();
    const open = _hlNoteWrap.style.display !== 'none';
    _hlNoteWrap.style.display = open ? 'none' : 'flex';
    if (!open) _hlNoteInput.focus();
  });
  _hlNoteBtn = noteBtn;
  row.appendChild(noteBtn);

  // Delete button — shown only in edit mode (existing highlight).
  // Solid red with a white SVG icon so it stays clearly visible in both themes
  // (the 🗑 emoji renders dark and gets lost on the dark tooltip).
  const delBtn = document.createElement('button');
  delBtn.title = 'Delete highlight';
  delBtn.innerHTML = [
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff"',
    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
    '<polyline points="3 6 5 6 21 6"></polyline>',
    '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>',
    '<line x1="10" y1="11" x2="10" y2="17"></line>',
    '<line x1="14" y1="11" x2="14" y2="17"></line>',
    '<path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>',
    '</svg>',
  ].join('');
  delBtn.style.cssText = [
    'all:initial', 'cursor:pointer', 'line-height:0',
    'display:none', 'align-items:center', 'justify-content:center',
    'width:26px', 'height:26px', 'border-radius:6px',
    'background:#ef4444', 'border:1px solid #ef4444',
    'box-sizing:border-box', 'margin-left:auto', 'transition:background 0.1s',
  ].join(';');
  delBtn.addEventListener('mouseenter', () => { delBtn.style.background = '#dc2626'; });
  delBtn.addEventListener('mouseleave', () => { delBtn.style.background = '#ef4444'; });
  delBtn.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
  delBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (_hlTipMode === 'edit' && _hlTipEditId) {
      _hlRemove(_hlTipEditId);
      _hlHideTip();
    }
  });
  row.appendChild(delBtn);
  d.appendChild(row);

  // Note editor (collapsible).
  const nw = document.createElement('div');
  nw.style.cssText = 'display:none;flex-direction:column;gap:4px;margin-top:2px;font-family:inherit;';

  const ta = document.createElement('textarea');
  ta.placeholder = 'Add a note…';
  ta.rows = 2;
  ta.style.cssText = [
    'all:initial', 'box-sizing:border-box', 'width:180px', 'resize:vertical',
    'min-height:38px', 'padding:5px 6px', 'border-radius:6px',
    'border:1px solid rgba(255,255,255,0.18)', 'background:#11111b',
    'color:#cdd6f4', 'font-family:inherit', 'font-size:11px', 'line-height:1.4',
  ].join(';');
  ta.addEventListener('mousedown', e => e.stopPropagation());
  ta.addEventListener('mouseup',   e => e.stopPropagation());
  ta.addEventListener('click',     e => e.stopPropagation());
  ta.addEventListener('keydown',   e => e.stopPropagation());
  nw.appendChild(ta);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;font-family:inherit;';

  const hint = document.createElement('span');
  hint.style.cssText = 'font-size:10px;color:rgba(205,214,244,0.55);font-family:inherit;';

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save note';
  saveBtn.style.cssText = [
    'all:initial', 'cursor:pointer', 'font-family:inherit', 'font-size:11px',
    'padding:3px 10px', 'border-radius:6px', 'color:#fff',
    'background:#4f46e5', 'border:1px solid rgba(255,255,255,0.15)',
  ].join(';');
  saveBtn.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
  saveBtn.addEventListener('click', e => { e.stopPropagation(); if (_hlTipMode === 'edit') _hlEditSaveNote(); });

  actions.appendChild(hint);
  actions.appendChild(saveBtn);
  nw.appendChild(actions);
  d.appendChild(nw);

  document.documentElement.appendChild(d);
  _hlTip = d;
  _hlNoteWrap = nw;
  _hlNoteInput = ta;
  _hlNoteSaveBtn = saveBtn;
  _hlNoteHint = hint;
  _hlDelBtn = delBtn;
  _hlApplyTipTheme();
  return d;
}

// ── Apply the current theme's palette to the tooltip + note bubble ──
function _hlApplyTipTheme() {
  const t = _HL_TIP_THEMES[_hlTheme] || _HL_TIP_THEMES.dark;
  if (_hlTip) {
    _hlTip.style.background  = t.bg;
    _hlTip.style.borderColor = t.border;
    _hlTip.style.color       = t.text;
    _hlTip.style.boxShadow   = _hlTheme === 'light'
      ? '0 4px 24px rgba(0,0,0,0.18)' : '0 4px 24px rgba(0,0,0,0.45)';
  }
  if (_hlTipLabel)  _hlTipLabel.style.color = t.sub;
  if (_hlNoteHint)  _hlNoteHint.style.color = t.sub;
  if (_hlNoteInput) {
    _hlNoteInput.style.background  = t.taBg;
    _hlNoteInput.style.color       = t.text;
    _hlNoteInput.style.borderColor = t.btnBorder;
  }
  if (_hlNoteBtn) _hlNoteBtn.style.borderColor = t.btnBorder;
  if (_hlNotePop) {
    _hlNotePop.style.background  = t.bg;
    _hlNotePop.style.borderColor = t.border;
    _hlNotePop.style.color       = t.text;
    _hlNotePop.style.boxShadow   = _hlTheme === 'light'
      ? '0 6px 22px rgba(0,0,0,0.18)' : '0 6px 22px rgba(0,0,0,0.45)';
    if (_hlNotePop._arrow) {
      const arrow = _hlNotePop._arrow;
      arrow.style.background = t.bg;
      // Stash the themed border shorthand for _hlPositionNotePop's two sides.
      arrow._border = `1px solid ${t.border}`;
    }
  }
}

function _hlPositionTip(rect) {
  const tt = _hlTip;
  const tw = tt.offsetWidth || 200, th = tt.offsetHeight || 80;
  let top  = rect.top - th - 10;
  let left = rect.left + rect.width / 2 - tw / 2;
  if (top < 8) top = rect.bottom + 10;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  tt.style.top  = top  + 'px';
  tt.style.left = left + 'px';
}

// Configure swatch selection rings; pass null to clear all (create mode).
function _hlSetSwatchSel(color) {
  Object.entries(_hlColorBtns).forEach(([c, b]) => {
    const sel = c === color;
    b.dataset.sel = sel ? '1' : '';
    b.style.borderColor = sel ? 'rgba(255,255,255,0.9)' : 'transparent';
  });
}

// ── Show tooltip for a fresh selection (create mode) ──
function _hlShowTip(rect) {
  _hlTipEl();
  _hlTipMode   = 'create';
  _hlTipEditId = null;
  _hlNoteInput.value      = '';
  _hlNoteWrap.style.display = 'none';
  _hlNoteHint.textContent = 'Pick a color to apply';
  _hlNoteSaveBtn.style.display = 'none';
  _hlDelBtn.style.display = 'none';
  _hlHideNotePop();
  _hlSetSwatchSel(null);
  _hlTip.style.display = 'flex';
  _hlPositionTip(rect);
}

// ── Show tooltip for an existing highlight (edit mode) — opened by clicking it ──
function _hlShowEditTipFor(mark) {
  const id = mark.dataset.hlId;
  if (!id) return;
  _hlGetPage(list => {
    const h = list.find(x => x.id === id);
    if (!h) return;
    _hlTipEl();
    _hlTipMode   = 'edit';
    _hlTipEditId = id;
    _hlNoteInput.value        = h.note || '';
    _hlNoteWrap.style.display = h.note ? 'flex' : 'none';
    _hlNoteHint.textContent   = '';
    _hlNoteSaveBtn.style.display = '';
    _hlDelBtn.style.display   = 'inline-flex';
    _hlSetSwatchSel(h.color);
    _hlHideNotePop();
    _hlTip.style.display = 'flex';
    _hlPositionTip(mark.getBoundingClientRect());
  });
}

// ── Edit-mode actions ──
function _hlEditSetColor(color) {
  if (!_hlTipEditId) return;
  const id = _hlTipEditId;
  document.querySelectorAll(`[data-hl-id="${id}"]`).forEach(m => {
    m.dataset.hlColor = color;
    if (!m.dataset.hlHidden) m.style.setProperty('background-color', _hlBg(color), 'important');
  });
  _hlSetSwatchSel(color);
  _hlGetPage(list => {
    const item = list.find(h => h.id === id);
    if (item) { item.color = color; _hlSavePage(list); }
  });
}

function _hlEditSaveNote() {
  if (!_hlTipEditId) return;
  const id = _hlTipEditId;
  const note = (_hlNoteInput.value || '').trim();
  _hlApplyNote(id, note);
  _hlGetPage(list => {
    const item = list.find(h => h.id === id);
    if (item) { item.note = note; _hlSavePage(list, () => _hlHideTip()); }
    else _hlHideTip();
  });
}

function _hlHideTip() {
  if (_hlTip) _hlTip.style.display = 'none';
  _hlRange = null;
  _hlAnchor = '';
  _hlParentSel = '';
  _hlTipMode   = 'create';
  _hlTipEditId = null;
}

document.addEventListener('mouseup', e => {
  setTimeout(() => {
    if (!_hlEnabled) return;
    if (e.target?.closest?.('[data-hl-ui]')) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { _hlHideTip(); return; }
    const text = sel.toString().trim();
    if (!text) { _hlHideTip(); return; }
    const range = sel.getRangeAt(0);
    if (e.target?.closest?.('[data-hl-ui]')) return;
    _hlRange = range.cloneRange();
    _hlAnchor = _hlGetFlatCtx(range);
    _hlParentSel = _hlGetParentSel(range);
    _hlShowTip(range.getBoundingClientRect());
  }, 10);
}, true);

document.addEventListener('mousedown', e => {
  if (!e.target?.closest?.('[data-hl-ui]')) _hlHideTip();
}, true);

/* ── Note hover bubble — shows ONLY the note text (not the edit tooltip) ──
   Features: fade in/out, hover-intent delay, an arrow pointing at the mark,
   and an interactive body (hover in to select/copy text or click links). */
const _HL_NOTE_SHOW_DELAY = 280;   // ms of hover before the bubble appears
const _HL_NOTE_HIDE_DELAY = 200;   // ms grace to cross the gap into the bubble
let _hlNotePopMark = null;          // mark the bubble is currently showing for
let _hlNotePopShowT = null;
let _hlNotePopHideT = null;

function _hlNotePopEl() {
  if (_hlNotePop) return _hlNotePop;
  const d = document.createElement('div');
  d.setAttribute('data-hl-ui', '1');
  d.style.cssText = [
    'all:initial', 'box-sizing:border-box', 'position:fixed',
    'z-index:2147483646', 'display:none', 'opacity:0',
    'transform:translateY(4px)',
    'transition:opacity 0.14s ease, transform 0.14s ease',
    'max-width:300px', 'background:#1e1e2e',
    'border:1px solid rgba(255,255,255,0.12)', 'border-radius:9px',
    'padding:7px 10px 8px', 'box-shadow:0 6px 22px rgba(0,0,0,0.45)',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'color:#cdd6f4', 'pointer-events:auto',
  ].join(';');

  // Header label "📝 Note"
  const head = document.createElement('div');
  head.textContent = '📝 Note';
  head.style.cssText = [
    'all:initial', 'display:block', 'font-family:inherit',
    'font-size:10px', 'font-weight:600', 'letter-spacing:0.4px',
    'text-transform:uppercase', 'opacity:0.55', 'margin:0 0 4px',
    'user-select:none', 'pointer-events:none',
  ].join(';');

  // Scrollable body holding the note text (and any linkified URLs)
  const body = document.createElement('div');
  body.style.cssText = [
    'all:initial', 'display:block', 'font-family:inherit',
    'white-space:pre-wrap', 'word-break:break-word', 'font-size:12.5px',
    'line-height:1.5', 'color:inherit', 'max-height:200px',
    'overflow-y:auto', 'user-select:text', 'cursor:text',
  ].join(';');

  // Arrow pointing at the highlighted mark (a rotated square)
  const arrow = document.createElement('div');
  arrow.style.cssText = [
    'all:initial', 'position:absolute', 'width:9px', 'height:9px',
    'background:#1e1e2e', 'transform:rotate(45deg)', 'pointer-events:none',
  ].join(';');

  d.appendChild(head);
  d.appendChild(body);
  d.appendChild(arrow);
  d._body = body;
  d._arrow = arrow;

  // Keep the bubble open while the pointer is inside it.
  d.addEventListener('mouseenter', () => { clearTimeout(_hlNotePopHideT); });
  d.addEventListener('mouseleave', _hlScheduleHideNotePop);

  document.documentElement.appendChild(d);
  _hlNotePop = d;
  _hlApplyTipTheme();
  return d;
}

function _hlPositionNotePop(pop, mark) {
  const r  = mark.getBoundingClientRect();
  const pw = pop.offsetWidth || 220, ph = pop.offsetHeight || 48;
  const markCx = r.left + r.width / 2;

  let above = true;
  let top = r.top - ph - 9;
  if (top < 8) { top = r.bottom + 9; above = false; }
  let left = Math.max(8, Math.min(markCx - pw / 2, window.innerWidth - pw - 8));
  pop.style.top  = top  + 'px';
  pop.style.left = left + 'px';

  // Point the arrow at the mark's centre, clamped to the bubble's edges.
  const arrow = pop._arrow;
  const border = arrow._border || '1px solid rgba(255,255,255,0.12)';
  const ax = Math.max(10, Math.min(markCx - left - 4.5, pw - 19));
  arrow.style.left = ax + 'px';
  if (above) {
    arrow.style.top = '';
    arrow.style.bottom = '-5px';
    arrow.style.borderRight  = border;
    arrow.style.borderBottom = border;
    arrow.style.borderTop = arrow.style.borderLeft = 'none';
  } else {
    arrow.style.bottom = '';
    arrow.style.top = '-5px';
    arrow.style.borderLeft = border;
    arrow.style.borderTop  = border;
    arrow.style.borderBottom = arrow.style.borderRight = 'none';
  }
}

// Turn bare URLs in the note text into clickable links; everything else
// stays as plain text. Returns a DocumentFragment safe to insert.
function _hlLinkifyNote(text) {
  const frag = document.createDocumentFragment();
  const re = /(https?:\/\/[^\s]+)/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement('a');
    a.href = m[0];
    a.textContent = m[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.style.cssText = 'color:#89b4fa;text-decoration:underline;word-break:break-all';
    frag.appendChild(a);
    last = re.lastIndex;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

function _hlShowNotePop(mark) {
  const note = mark.dataset.hlNoteText;
  if (!note) return;
  const pop = _hlNotePopEl();
  _hlNotePopMark = mark;
  pop._body.textContent = '';
  pop._body.appendChild(_hlLinkifyNote(note));
  pop.style.display = 'block';
  _hlPositionNotePop(pop, mark);
  // Trigger the fade/slide-in on the next frame.
  requestAnimationFrame(() => {
    pop.style.opacity = '1';
    pop.style.transform = 'translateY(0)';
  });
}

// Show after a short hover so a quick mouse pass doesn't flicker the bubble.
function _hlScheduleShowNotePop(mark) {
  clearTimeout(_hlNotePopHideT);
  if (_hlNotePopMark === mark && _hlNotePop?.style.display === 'block') return;
  clearTimeout(_hlNotePopShowT);
  _hlNotePopShowT = setTimeout(() => _hlShowNotePop(mark), _HL_NOTE_SHOW_DELAY);
}

function _hlScheduleHideNotePop() {
  clearTimeout(_hlNotePopShowT);
  clearTimeout(_hlNotePopHideT);
  _hlNotePopHideT = setTimeout(_hlHideNotePop, _HL_NOTE_HIDE_DELAY);
}

function _hlHideNotePop() {
  clearTimeout(_hlNotePopShowT);
  clearTimeout(_hlNotePopHideT);
  _hlNotePopMark = null;
  if (!_hlNotePop) return;
  const pop = _hlNotePop;
  pop.style.opacity = '0';
  pop.style.transform = 'translateY(4px)';
  setTimeout(() => { if (pop.style.opacity === '0') pop.style.display = 'none'; }, 150);
}

// Hover a highlight that has a note → show the note bubble (unless the edit
// tooltip is already open for it).
document.addEventListener('mouseover', e => {
  if (!_hlEnabled) return;
  const mark = e.target?.closest?.('mark[data-hl-note="1"]');
  if (!mark) return;
  if (_hlTipMode === 'edit' && _hlTip?.style.display === 'flex' &&
      _hlTipEditId === mark.dataset.hlId) return;
  _hlScheduleShowNotePop(mark);
}, true);

document.addEventListener('mouseout', e => {
  const from = e.target?.closest?.('mark[data-hl-note="1"]');
  if (!from) return;
  const to = e.relatedTarget?.closest?.('mark[data-hl-note="1"]');
  if (to && to === from) return;   // still within the same mark's children
  // Moving into the bubble itself? Its own mouseenter keeps it open.
  if (e.relatedTarget && _hlNotePop?.contains(e.relatedTarget)) return;
  // Also cancels any pending show, so a quick pass never flickers the bubble.
  _hlScheduleHideNotePop();
}, true);

// ── Build CSS selector for the element containing the selection ──
// Stored alongside each highlight so restore can pinpoint the exact element
// instead of relying on flat-text anchor matching alone (which fails for
// common words like "HTML" that appear hundreds of times on a page).
function _hlGetParentSel(range) {
  const sc = range.startContainer;
  const el = sc.nodeType === Node.TEXT_NODE ? sc.parentElement : sc;
  if (!el || el === document.body || el === document.documentElement) return '';

  const path = [];
  let cur = el;
  while (cur && cur !== document.body && path.length < 5) {
    let part = cur.tagName.toLowerCase();
    if (cur.id && !_isDynamicId(cur.id)) {
      // Stable ID found — use as anchor and stop walking up
      path.unshift(`#${CSS.escape(cur.id)}`);
      break;
    }
    if (cur.className && typeof cur.className === 'string') {
      const cls = cur.className.split(/\s+/)
        .filter(c => c.length > 2 && !_DYNAMIC_ID_RE.test(c))
        .slice(0, 2);
      if (cls.length) part += cls.map(c => '.' + CSS.escape(c)).join('');
    }
    path.unshift(part);
    cur = cur.parentElement;
  }

  const sel = path.join(' > ');
  try { if (sel && document.querySelector(sel)) return sel; } catch (_) {}
  return '';
}

// ── Find a Range for text within a specific root element ──
function _hlFindRangeIn(root, text) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      return n.parentElement?.closest('mark[data-hl-id]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  let node;
  while ((node = walker.nextNode())) nodes.push(node);

  let pos = 0;
  const offsets = nodes.map(n => { const s = pos; pos += n.textContent.length; return s; });
  const flat = nodes.map(n => n.textContent).join('');

  const idx = flat.indexOf(text);
  if (idx < 0) return null;

  const end = idx + text.length;
  let startNode, startOff, endNode, endOff;
  for (let i = 0; i < nodes.length; i++) {
    const s = offsets[i], e = s + nodes[i].textContent.length;
    if (!startNode && idx < e) { startNode = nodes[i]; startOff = idx - s; }
    if (end <= e)               { endNode   = nodes[i]; endOff   = end - s; break; }
  }
  if (!startNode || !endNode) return null;

  const range = document.createRange();
  range.setStart(startNode, startOff);
  range.setEnd(endNode, endOff);
  return range;
}

// ── Build 50-char context window around a range in the page's flat text ──
// Used to disambiguate identical text appearing multiple times on a page.
function _hlGetFlatCtx(range) {
  const nodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      return n.parentElement?.closest('mark[data-hl-id]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  let pos = 0;
  const offsets = nodes.map(nd => { const s = pos; pos += nd.textContent.length; return s; });
  const flat    = nodes.map(nd => nd.textContent).join('');
  const sc = range.startContainer;
  if (sc.nodeType !== Node.TEXT_NODE) return '';
  const si = nodes.indexOf(sc);
  if (si < 0) return '';
  const start = offsets[si] + range.startOffset;
  return flat.slice(Math.max(0, start - 10), start + range.toString().length + 40);
}

// ── Apply highlight — wraps each text node individually to handle complex DOM ──
function _hlApply(color) {
  if (!_hlRange) return;
  const text = _hlRange.toString().trim();
  if (!text) return;

  const id        = 'hl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const anchor    = _hlAnchor;
  const parentSel = _hlParentSel;
  const note      = (_hlNoteInput?.value || '').trim();

  const _anchorNode = _hlRange.commonAncestorContainer;
  const _containerEl = _anchorNode.nodeType === Node.TEXT_NODE ? _anchorNode.parentElement : _anchorNode;
  const containerSelectors = (_containerEl && _containerEl !== document.body && _containerEl !== document.documentElement)
    ? getAllSelectors(_containerEl)
    : null;

  let segments = _hlGetTextNodes(_hlRange);

  // Range có thể bị stale nếu trang thay đổi DOM sau khi user chọn text.
  // Fallback: tìm lại text trong DOM hiện tại.
  if (!segments.length) {
    const fresh = _hlFindRange(text, anchor, parentSel);
    if (fresh) segments = _hlGetTextNodes(fresh);
  }

  if (!segments.length) { _hlHideTip(); return; }

  segments.forEach(({ node, start, end }) => {
    const mark = _hlMark(id, color, note);
    if (end < node.length) node.splitText(end);
    const target = start > 0 ? node.splitText(start) : node;
    if (!target.parentNode) return;
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
  });

  window.getSelection().removeAllRanges();

  _hlGetPage(list => {
    list.push({ id, text, color, note, createdAt: Date.now(), anchor, parentSel, containerSelectors });
    _hlSavePage(list);
  });

  // Keep the tooltip open in edit mode on the highlight just created, so the
  // user can add a note if they want — but leave the note field collapsed until
  // they click the 📝 button.
  _hlRange = null;
  _hlAnchor = '';
  _hlParentSel = '';
  _hlTipMode   = 'edit';
  _hlTipEditId = id;
  _hlNoteWrap.style.display    = 'none';
  _hlNoteHint.textContent      = '';
  _hlNoteSaveBtn.style.display = '';
  _hlDelBtn.style.display      = 'inline-flex';
  _hlSetSwatchSel(color);
  const newMark = document.querySelector(`[data-hl-id="${id}"]`);
  if (newMark) _hlPositionTip(newMark.getBoundingClientRect());
}

// ── Collect text nodes within a Range, skipping existing highlights/UI ──
function _hlGetTextNodes(range) {
  const nodes = [];
  const ancestor = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
    ? range.commonAncestorContainer.parentNode
    : range.commonAncestorContainer;
  const walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      return n.parentElement?.closest('mark[data-hl-id]')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  let node;
  while ((node = walker.nextNode())) {
    if (!range.intersectsNode(node)) continue;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end   = node === range.endContainer   ? range.endOffset   : node.length;
    if (start < end) nodes.push({ node, start, end });
  }
  return nodes;
}

function _hlMark(id, color, note) {
  const m = document.createElement('mark');
  m.setAttribute('data-hl-id', id);
  m.setAttribute('data-hl-color', color);
  m.setAttribute('data-hl-ui', '1');
  let css = `background-color:${_hlBg(color)} !important;background-image:none !important;color:inherit !important;border-radius:2px;padding:0 !important;margin:0 !important;cursor:pointer;`;
  // A note is surfaced as a dotted underline; the text shows in a hover bubble.
  if (note) {
    css += 'text-decoration:underline dotted !important;text-underline-offset:2px;';
    m.dataset.hlNote = '1';
    m.dataset.hlNoteText = note;
  }
  m.style.cssText = css;
  // Click an existing highlight → open the edit tooltip (colour / note / delete).
  m.addEventListener('click', (e) => {
    if (!_hlEnabled) return;
    e.preventDefault();
    e.stopPropagation();
    _hlShowEditTipFor(m);
  });
  return m;
}

// ── Apply / clear a note's visual cue on all marks of one highlight ──
// Note text lives in data-hl-note-text and is shown via a hover bubble.
function _hlApplyNote(id, note) {
  document.querySelectorAll(`[data-hl-id="${id}"]`).forEach(m => {
    if (note) {
      m.dataset.hlNote = '1';
      m.dataset.hlNoteText = note;
      m.style.setProperty('text-decoration', 'underline dotted', 'important');
      m.style.setProperty('text-underline-offset', '2px');
    } else {
      delete m.dataset.hlNote;
      delete m.dataset.hlNoteText;
      m.style.removeProperty('text-decoration');
      m.style.removeProperty('text-underline-offset');
    }
  });
}

// ── Remove — handles multiple marks from text-node wrapping ──
function _hlRemove(id) {
  document.querySelectorAll(`[data-hl-id="${id}"]`).forEach(mark => {
    const p = mark.parentNode;
    if (!p) return;
    while (mark.firstChild) p.insertBefore(mark.firstChild, mark);
    p.removeChild(mark);
    p.normalize();
  });
  _hlGetPage(list => _hlSavePage(list.filter(h => h.id !== id)));
}

// ── Clear page ──
function _hlClear() {
  document.querySelectorAll('[data-hl-id]').forEach(m => {
    const p = m.parentNode;
    if (!p) return;
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    p.removeChild(m);
  });
  document.body?.normalize();
  _hlSavePage([]);
}

// ── Find a Range for text that may span across element boundaries (e.g. <a> tags) ──
// parentSel: CSS selector of the parent element — try first for precise lookup.
// anchor: fallback 50-char context string for disambiguation across full page.
function _hlFindRange(text, anchor = '', parentSel = '') {
  if (!text) return null;

  // Primary strategy: narrow search to the element identified by parentSel.
  // This handles common words (e.g. "HTML") that appear hundreds of times on a page.
  if (parentSel) {
    try {
      const roots = document.querySelectorAll(parentSel);
      for (const root of roots) {
        const r = _hlFindRangeIn(root, text);
        if (r) return r;
      }
    } catch (_) {}
  }

  const nodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      return n.parentElement?.closest('mark[data-hl-id]')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  let node;
  while ((node = walker.nextNode())) nodes.push(node);

  let pos = 0;
  const offsets = nodes.map(n => { const s = pos; pos += n.textContent.length; return s; });
  const flat = nodes.map(n => n.textContent).join('');

  // Determine best occurrence using anchor context (suffix + prefix scoring)
  const anchorTextIdx = anchor ? anchor.indexOf(text) : -1;
  let idx = flat.indexOf(text);
  if (idx < 0) return null;

  if (anchor && anchorTextIdx >= 0) {
    const anchorPrefix = anchor.slice(0, anchorTextIdx);
    const anchorSuffix = anchor.slice(anchorTextIdx + text.length);
    let searchFrom = 0;
    let bestScore  = -1;
    while (true) {
      const cand = flat.indexOf(text, searchFrom);
      if (cand < 0) break;
      // Count matching chars in suffix (from start) — heavily weighted
      const candSfx = flat.slice(cand + text.length, cand + text.length + anchorSuffix.length);
      let sfxMatch = 0;
      while (sfxMatch < candSfx.length && candSfx[sfxMatch] === anchorSuffix[sfxMatch]) sfxMatch++;
      // Count matching chars in prefix (from right end)
      const candPfx = flat.slice(Math.max(0, cand - anchorPrefix.length), cand);
      let pfxMatch = 0;
      for (let k = 1; k <= Math.min(candPfx.length, anchorPrefix.length); k++) {
        if (candPfx[candPfx.length - k] === anchorPrefix[anchorPrefix.length - k]) pfxMatch++;
        else break;
      }
      const score = sfxMatch * 100 + pfxMatch;
      if (score > bestScore) { bestScore = score; idx = cand; }
      searchFrom = cand + 1;
    }
  }

  const end = idx + text.length;
  let startNode, startOff, endNode, endOff;
  for (let i = 0; i < nodes.length; i++) {
    const s = offsets[i], e = s + nodes[i].textContent.length;
    if (!startNode && idx < e) { startNode = nodes[i]; startOff = idx - s; }
    if (end <= e)               { endNode   = nodes[i]; endOff   = end - s; break; }
  }
  if (!startNode || !endNode) return null;

  const range = document.createRange();
  range.setStart(startNode, startOff);
  range.setEnd(endNode, endOff);
  return range;
}

// ── Restore one highlight — tries containerSelectors first, falls back to parentSel / anchor ──
const _hlRestoringIds = new Set();

async function _hlRestoreOne(h) {
  if (document.querySelector(`[data-hl-id="${h.id}"]`)) return;
  if (_hlRestoringIds.has(h.id)) return;
  _hlRestoringIds.add(h.id);

  try {
    let range = null;

    // Strategy 1: element-finder with stored selectors (fullXpath → id → xpath → css …)
    if (h.containerSelectors) {
      try {
        const el = await findElementWithFallback(h.containerSelectors, 2000);
        if (el) range = _hlFindRangeIn(el, h.text);
      } catch (_) {}
    }

    // Strategy 2: parentSel + anchor (legacy / fallback)
    if (!range) range = _hlFindRange(h.text, h.anchor || '', h.parentSel || '');
    if (!range) return;

    const segments = _hlGetTextNodes(range);
    if (!segments.length) return;
    segments.forEach(({ node, start, end }) => {
      const mark = _hlMark(h.id, h.color, h.note);
      if (end < node.length) node.splitText(end);
      const target = start > 0 ? node.splitText(start) : node;
      if (!target.parentNode) return;
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
    });
  } finally {
    _hlRestoringIds.delete(h.id);
  }
}

// ── Restore all highlights for the current page ──
function _hlRestore() {
  _hlGetPage(list => { list.forEach(h => _hlRestoreOne(h)); });
}

// ── Scroll to ──
function _hlScrollTo(id) {
  const m = document.querySelector(`[data-hl-id="${id}"]`);
  if (!m) return false;
  m.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const prev = m.style.outline;
  m.style.outline = '2.5px solid #6366f1';
  m.style.outlineOffset = '2px';
  setTimeout(() => { m.style.outline = prev; m.style.outlineOffset = ''; }, 1200);
  return true;
}

// ── Bootstrap: loads settings then starts MutationObserver + restore ──
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _hlInit);
} else {
  _hlInit();
}

// ── Message handler ──
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'HL_GET_PAGE') {
    _hlGetAll(all => sendResponse({ url: location.href, data: all }));
    return true;
  }
  if (msg.type === 'HL_REMOVE') {
    _hlRemove(msg.id);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'HL_CLEAR') {
    _hlClear();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'HL_SCROLL_TO') {
    sendResponse({ found: _hlScrollTo(msg.id) });
    return false;
  }
  if (msg.type === 'HL_SET_ENABLED') {
    _hlSetEnabled(msg.enabled);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'HL_PATTERNS_UPDATED') {
    _hlPatterns = msg.patterns || [];
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'HL_SET_HIDDEN') {
    document.querySelectorAll(`[data-hl-id="${msg.id}"]`).forEach(m => {
      m.style.setProperty('background-color', 'transparent', 'important');
      m.dataset.hlHidden = '1';
    });
    sendResponse({ ok: true }); return false;
  }
  if (msg.type === 'HL_RESTORE') {
    document.querySelectorAll(`[data-hl-id="${msg.id}"]`).forEach(m => {
      delete m.dataset.hlHidden;
      m.style.setProperty('background-color', _hlBg(m.dataset.hlColor), 'important');
    });
    sendResponse({ ok: true }); return false;
  }
  if (msg.type === 'HL_UPDATE_COLOR') {
    document.querySelectorAll(`[data-hl-id="${msg.id}"]`).forEach(m => {
      m.dataset.hlColor = msg.color;
      if (!m.dataset.hlHidden) m.style.setProperty('background-color', _hlBg(msg.color), 'important');
    });
    sendResponse({ ok: true }); return false;
  }
  if (msg.type === 'HL_UPDATE_NOTE') {
    _hlApplyNote(msg.id, msg.note);
    sendResponse({ ok: true }); return false;
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   NOTIFY READY
───────────────────────────────────────────────────────────────────────────── */

safeSend({ type: 'CONTENT_READY' });

} // End of injection guard
