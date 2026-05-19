/**
 * content.js — content script for recording and executing actions.
 * Notes:
 * - Handles select/input correctly.
 * - Dispatches both input and change events.
 * - Waits for cascade dropdowns.
 * - Safe to run in SPAs.
 */

// Safe wrapper — suppresses "Extension context invalidated" errors after extension reload
function safeSend(msg) {
  try {
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch (_) {}
}

// Guard against multiple injections
if (window.__actionRecorderInjected) {
  console.log("[CONTENT] Already injected, sending CONTENT_READY");
  // Still notify ready so playback can proceed
  safeSend({ type: "CONTENT_READY" });
} else {
  window.__actionRecorderInjected = true;

/* === State === */
let pickerMode = false;

/* === Utilities === */

function log(...args) {
  console.log("[CONTENT]", ...args);
}

/**
 * Build a simple CSS selector for an element.
 */
function getCssSelector(el) {
  if (!el) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;

  const path = [];
  let current = el;
  while (current && current.nodeType === 1 && current !== document.body) {
    let selector = current.tagName.toLowerCase();

    // For input elements, add [type] and [name]/[value] for specificity
    if (current.tagName === 'INPUT' && current.type) {
      selector += `[type="${CSS.escape(current.type)}"]`;
      if (current.name) selector += `[name="${CSS.escape(current.name)}"]`;
      if (current.type === 'radio' && current.value) {
        selector += `[value="${CSS.escape(current.value)}"]`;
      }
    } else if (current.className && typeof current.className === 'string') {
      const cls = current.className.split(" ").filter(Boolean)[0];
      if (cls) selector += `.${CSS.escape(cls)}`;
    }

    // Add :nth-child if the selector alone matches siblings
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
  return path.join(" > ");
}

/**
 * Build XPath for an element (shorter version using IDs when possible)
 */
function getXPath(el) {
  if (!el) return null;
  if (el.id) return `//*[@id="${el.id}"]`;
  
  const parts = [];
  let current = el;
  
  while (current && current.nodeType === 1) {
    if (current === document.body) {
      parts.unshift('/html/body');
      break;
    }
    
    // If element has ID, use it as anchor
    if (current.id) {
      parts.unshift(`//*[@id="${current.id}"]`);
      break;
    }
    
    let index = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    
    const tagName = current.tagName.toLowerCase();
    parts.unshift(`${tagName}[${index}]`);
    current = current.parentElement;
  }
  
  return parts.join('/');
}

/**
 * Build full XPath from root (most reliable but verbose)
 */
function getFullXPath(el) {
  if (!el) return null;
  
  const parts = [];
  let current = el;
  
  while (current && current.nodeType === 1) {
    if (current === document.documentElement) {
      parts.unshift('/html');
      break;
    }
    
    let index = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    
    const tagName = current.tagName.toLowerCase();
    parts.unshift(`${tagName}[${index}]`);
    current = current.parentElement;
  }
  
  return parts.join('/');
}

/**
 * Get all possible selectors for an element
 */
function getAllSelectors(el) {
  if (!el) return null;
  
  const selectors = {
    css: getCssSelector(el),
    xpath: getXPath(el),
    fullXpath: getFullXPath(el),
  };
  
  // Add ID if exists
  if (el.id) {
    selectors.id = el.id;
  }
  
  // Add name attribute if exists
  if (el.name) {
    selectors.name = el.name;
  }
  
  // Add text content for links/buttons (trimmed, max 50 chars)
  const textContent = (el.textContent || '').trim();
  if (textContent && textContent.length <= 50 && 
      ['A', 'BUTTON', 'SPAN', 'LABEL', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(el.tagName)) {
    selectors.text = textContent;
    selectors.textTag = el.tagName.toLowerCase();
  }
  
  // Add data-testid or data-id if exists
  if (el.dataset?.testid) {
    selectors.testId = el.dataset.testid;
  }
  if (el.dataset?.id) {
    selectors.dataId = el.dataset.id;
  }
  
  return selectors;
}


/**
 * Find element using multiple selector strategies with fallback
 */
function findElementWithFallback(selectors, timeout = 5000) {
  return new Promise((resolve, reject) => {
    // Handle legacy string selector
    if (typeof selectors === 'string') {
      selectors = { css: selectors };
    }

    const strategies = [];

    // Priority order: most specific/unique first, most ambiguous last.
    // fullXpath is absolute position-based — always unique, try first.
    if (selectors.fullXpath) {
      strategies.push({
        type: 'fullXpath',
        fn: () => document.evaluate(selectors.fullXpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
      });
    }
    // id is unique by spec — second most reliable.
    if (selectors.id) {
      strategies.push({ type: 'id', fn: () => document.getElementById(selectors.id) });
    }
    // xpath with id-anchors — reliable but may have non-unique IDs on broken pages.
    if (selectors.xpath) {
      strategies.push({
        type: 'xpath',
        fn: () => document.evaluate(selectors.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
      });
    }
    // css — specific if selector includes nth-child/type/value attributes.
    if (selectors.css) {
      strategies.push({ type: 'css', fn: () => document.querySelector(selectors.css) });
    }
    // testId / dataId — framework-specific, generally unique.
    if (selectors.testId) {
      strategies.push({ type: 'testId', fn: () => document.querySelector(`[data-testid="${CSS.escape(selectors.testId)}"]`) });
    }
    if (selectors.dataId) {
      strategies.push({ type: 'dataId', fn: () => document.querySelector(`[data-id="${CSS.escape(selectors.dataId)}"]`) });
    }
    // name — ambiguous, multiple elements can share the same name.
    if (selectors.name) {
      strategies.push({ type: 'name', fn: () => document.querySelector(`[name="${CSS.escape(selectors.name)}"]`) });
    }
    // text — most ambiguous, last resort.
    if (selectors.text && selectors.textTag) {
      strategies.push({
        type: 'text',
        fn: () => [...document.querySelectorAll(selectors.textTag)].find(el => el.textContent.trim() === selectors.text)
      });
    }
    
    // Try each strategy
    const tryStrategies = () => {
      for (const strategy of strategies) {
        try {
          const el = strategy.fn();
          if (el) {
            log(`Found element using ${strategy.type}`);
            return el;
          }
        } catch (e) {
          // Strategy failed, try next
        }
      }
      return null;
    };
    
    // Immediate check
    const el = tryStrategies();
    if (el) return resolve(el);

    // Wait with MutationObserver
    let found = false;
    const observer = new MutationObserver(() => {
      if (found) return;
      const el = tryStrategies();
      if (el) {
        found = true;
        observer.disconnect();
        resolve(el);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    setTimeout(() => {
      if (found) return;
      observer.disconnect();
      reject(`Timeout: Element not found with any selector strategy`);
    }, timeout);
  });
}

/**
 * Find a descendant of `root` matching conditions.
 *
 * conditions: {
 *   matchMode    : "any" | "all"  — default "any" (OR). "all" = AND across filled fields.
 *   valueEquals  : string  — matches el.value === value
 *   textContains : string  — matches el's own text nodes include text (case-insensitive)
 *   idContains   : string  — matches el.id includes string (case-insensitive)
 *   classContains: string  — matches el.className includes string (case-insensitive)
 *   typeEquals   : string  — matches el.type === value (exact)
 * }
 *
 * Returns the first matching element in DOM order, or null.
 */
function findElementByCondition(root, conditions) {
  if (!root || !conditions) return null;
  const { matchMode = "any", valueEquals, textContains, idContains, classContains, typeEquals } = conditions;
  const normalize = (s) => (s ?? "").toString().trim().toLowerCase();

  // Build list of active checks (only fields that were filled)
  const checks = [];

  if (valueEquals !== undefined && valueEquals !== "") {
    checks.push(el => el.value !== undefined && String(el.value) === String(valueEquals));
  }

  if (textContains != null && textContains !== "") {
    const needle = normalize(textContains);
    checks.push(el => {
      const ownText = normalize(
        Array.from(el.childNodes)
          .filter(n => n.nodeType === Node.TEXT_NODE)
          .map(n => n.textContent)
          .join("")
      );
      if (ownText.includes(needle)) return true;
      return normalize(el.textContent).includes(needle);
    });
  }

  if (idContains != null && idContains !== "") {
    const needle = normalize(idContains);
    checks.push(el => normalize(el.id).includes(needle));
  }

  if (classContains != null && classContains !== "") {
    const needle = normalize(classContains);
    checks.push(el => normalize(el.className).includes(needle));
  }

  if (typeEquals != null && typeEquals !== "") {
    checks.push(el => el.type === typeEquals);
  }

  if (checks.length === 0) return null;

  const test = matchMode === "all"
    ? (el) => checks.every(fn => fn(el))
    : (el) => checks.some(fn => fn(el));

  const candidates = root.querySelectorAll("*");
  for (const el of candidates) {
    if (test(el)) return el;
  }
  return null;
}

/**
 * Wait for element to appear in DOM (for cascade dropdowns)
 */
function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);

    let resolved = false;
    const observer = new MutationObserver(() => {
      if (resolved) return;
      const el = document.querySelector(selector);
      if (el) {
        resolved = true;
        observer.disconnect();
        resolve(el);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      observer.disconnect();
      reject(new Error(`Timeout waiting for ${selector}`));
    }, timeout);
  });
}

/* === Recording === */

document.addEventListener("click", (event) => {
  if (pickerMode) return; // Skip recording while in pick mode

  const selectors = getAllSelectors(event.target);
  if (!selectors) return;

  safeSend({
    type: "RECORDED_ACTION",
    action: {
      type: "click",
      selector: selectors.css,
      selectors: selectors
    }
  });
}, true);

// Fix #1: debounce input events so only the final value per element is recorded
const _inputDebounceTimers = new Map();

document.addEventListener("input", (event) => {
  const el = event.target;
  const selectors = getAllSelectors(el);
  if (!selectors) return;

  clearTimeout(_inputDebounceTimers.get(el));
  _inputDebounceTimers.set(el, setTimeout(() => {
    _inputDebounceTimers.delete(el);
    safeSend({
      type: "RECORDED_ACTION",
      action: {
        type: "input",
        selector: selectors.css,
        selectors: selectors,
        value: el.value,
      }
    });
  }, 400));
}, true);

/* === Playback === */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "PLAY_ACTION") return;

  (async () => {
    const action = msg.action;
    log("PLAY_ACTION", action);

    // Run custom script
    // Read DOM value and return it as a variable
    if (action.type === "readdom") {
      const actionTimeout = (action.timeout && action.timeout > 0) ? action.timeout : 5000;
      try {
        let el;
        if (action.selectors && typeof action.selectors === "object") {
          el = await findElementWithFallback(action.selectors, actionTimeout);
        } else if (action.selector) {
          el = await findElementWithFallback({ css: action.selector }, actionTimeout);
        }
        if (!el) { sendResponse({ failed: true }); return; }
        const value = action.readFrom === "value" ? (el.value ?? "")
                    : action.readFrom === "attr"  ? (el.getAttribute(action.attrName || "") ?? "")
                    : (el.textContent?.trim() ?? "");
        sendResponse({ value });
      } catch (e) {
        sendResponse({ failed: true });
      }
      return;
    }

    // Script actions are now handled in background via CDP (bypasses page CSP).
    // This branch is a fallback for edge cases only — strip javascript: prefix.
    if (action.type === "script") {
      try {
        const code = (action.code || "").replace(/^javascript:/i, "").trim();
        const fn = new Function("window", "document", code);
        fn.call(window, window, document);
      } catch (err) {
        log("Script error:", err);
      }
      sendResponse();
      return;
    }

    // Wait for element using fallback strategies
    // Fix #15: respect per-action timeout if provided, else default 5000ms
    const actionTimeout = (action.timeout && action.timeout > 0) ? action.timeout : 5000;
    let target;
    try {
      if (action.conditions && action.selector) {
        // Condition-based matching: resolve parent element first, then search children
        const parent = await findElementWithFallback(
          action.selectors && typeof action.selectors === 'object'
            ? action.selectors
            : { css: action.selector },
          actionTimeout
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
      log(e);
      // Fix #6: report failure so background can notify popup
      sendResponse({ failed: true });
      return;
    }

    if (!target) {
      // Fix #6: report failure so background can notify popup
      sendResponse({ failed: true });
      return;
    }

    target.scrollIntoView({ behavior: "auto", block: "center" });
    target.focus();

    // HOVER
    if (action.type === "hover") {
      const rect = target.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
      target.dispatchEvent(new MouseEvent("mouseover",  opts));
      target.dispatchEvent(new MouseEvent("mouseenter", { ...opts, bubbles: false }));
      target.dispatchEvent(new MouseEvent("mousemove",  opts));
      sendResponse();
      return;
    }

    // DRAG & DROP
    if (action.type === "dragdrop") {
      let dropEl = null;
      if (action.targetSelector) {
        const ts = (action.targetSelectors && typeof action.targetSelectors === "object")
          ? action.targetSelectors : { css: action.targetSelector };
        dropEl = await findElementWithFallback(ts, actionTimeout).catch(() => null);
      }
      if (!dropEl) { sendResponse({ failed: true }); return; }
      const srcRect = target.getBoundingClientRect();
      const dstRect = dropEl.getBoundingClientRect();
      const sx = srcRect.left + srcRect.width / 2, sy = srcRect.top + srcRect.height / 2;
      const dx = dstRect.left + dstRect.width / 2, dy = dstRect.top + dstRect.height / 2;
      const dt = new DataTransfer();
      const fireM = (el, t, x, y, extra = {}) =>
        el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, ...extra }));
      const fireD = (el, t, x, y) =>
        el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
      fireM(target, "mousedown", sx, sy, { button: 0 });
      fireD(target, "dragstart", sx, sy);
      fireD(dropEl, "dragenter", dx, dy);
      fireD(dropEl, "dragover",  dx, dy);
      fireD(dropEl, "drop",      dx, dy);
      fireD(target, "dragend",   dx, dy);
      fireM(target, "mouseup",   dx, dy);
      sendResponse();
      return;
    }

    // CLICK
    if (action.type === "click") {
      // Native click() handles checkbox/radio toggle + event dispatch correctly
      target.click();
      sendResponse();
      return;
    }

    // OPEN DROPDOWN — handled via CDP in background; this is a fallback only
    if (action.type === "dropdown") {
      target.click();
      sendResponse();
      return;
    }

    // INPUT / SELECT
    if (action.type === "input") {
      // Handle SELECT correctly
      if (target.tagName === "SELECT") {
        // Set value directly on select element
        target.value = action.value;
        
        // If direct value assignment didn't work, find and select the option
        if (target.value !== action.value) {
          const option = [...target.options].find(
            o => o.value === action.value || o.text === action.value
          );
          if (option) {
            option.selected = true;
            target.value = option.value;
          }
        }
        
        // Dispatch events in the correct order for frameworks (React/Vue/Angular)
        target.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
        target.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
        
        // Some frameworks need additional events
        target.dispatchEvent(new Event("blur", { bubbles: true }));
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      } else {
        target.value = action.value ?? "";
        
        // Fire both input and change for frameworks
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        
        // Dispatch blur to trigger async operations (API calls, etc.)
        target.dispatchEvent(new Event("blur", { bubbles: true }));
      }

      // If action specifies an element to wait for (e.g., loading indicator), wait for it
      if (action.waitForElement) {
        (async () => {
          try {
            await waitForElement(action.waitForElement, 5000);
            log("Waited for element:", action.waitForElement);
          } catch (e) {
            log("Element wait timeout, continuing anyway");
          }
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

/* === Element Picker === */

function showPickerBar() {
  if (document.getElementById('__picker_bar')) return;
  const bar = document.createElement('div');
  bar.id = '__picker_bar';
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:rgba(79,70,229,0.95);color:#fff;font:13px/1.4 system-ui,sans-serif;text-align:center;padding:8px 16px;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
  bar.textContent = '🎯 Click an element to select it. Press ESC to cancel.';
  document.documentElement.appendChild(bar);
}
function hidePickerBar() {
  document.getElementById('__picker_bar')?.remove();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "START_PICK_MODE") {
    pickerMode = true;
    document.body.style.cursor = "crosshair";
    showPickerBar();
  }

  if (msg.type === "STOP_PICK_MODE") {
    pickerMode = false;
    clearPickerUI();
  }
});

let _pickerTarget = null; // element currently highlighted by mouseover

function _updatePickerOverlay(el) {
  _pickerTarget = el;
  let overlay = document.getElementById('__picker_overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = '__picker_overlay';
    overlay.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      'z-index:2147483646',
      'box-sizing:border-box',
      'border:2px solid #4f46e5',
      'background:rgba(79,70,229,0.08)',
      'transition:none',
    ].join(';');
    document.documentElement.appendChild(overlay);
  }
  const r = el.getBoundingClientRect();
  overlay.style.left   = r.left   + 'px';
  overlay.style.top    = r.top    + 'px';
  overlay.style.width  = r.width  + 'px';
  overlay.style.height = r.height + 'px';
  overlay.style.display = '';

  // Update picker bar to show which element is highlighted
  const bar = document.getElementById('__picker_bar');
  if (bar) {
    const tag  = el.tagName.toLowerCase();
    const id   = el.id   ? `#${el.id}`   : '';
    const cls  = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/)[0] : '';
    bar.textContent = `🎯 ${tag}${id || cls}  —  Click to select. ESC to cancel.`;
  }
}

function _removePickerOverlay() {
  _pickerTarget = null;
  document.getElementById('__picker_overlay')?.remove();
}

document.addEventListener("mouseover", (event) => {
  if (!pickerMode) return;
  _updatePickerOverlay(event.target);
}, true);

document.addEventListener("click", (event) => {
  if (!pickerMode) return;

  event.preventDefault();
  event.stopImmediatePropagation(); // Prevent recording listener from also firing

  // Use the last highlighted element from mouseover, not event.target.
  // event.target on click can differ (e.g. cursor drifts to sibling label during click).
  const el = _pickerTarget || event.target;
  const selectors = getAllSelectors(el);
  if (!selectors) return;

  // Compute bounding rect synchronously (no async) so background can use it immediately
  const _cr = el.getBoundingClientRect();
  const pickedRect = {
    x:      Math.round(_cr.left + window.scrollX),
    y:      Math.round(_cr.top  + window.scrollY),
    width:  Math.round(_cr.width),
    height: Math.round(_cr.height),
  };

  // Save to storage so popup can access it even if closed
  chrome.storage.local.set({
    lastPickedSelector: selectors.css,
    lastPickedSelectors: selectors
  });

  safeSend({
    type: "ELEMENT_PICKED",
    selector: selectors.css,
    selectors: selectors,
    rect: pickedRect,
  });

  pickerMode = false;
  clearPickerUI();
}, true);

function clearPickerUI() {
  document.body.style.cursor = "auto";
  hidePickerBar();
  _removePickerOverlay();
}

/* === Full Page Screenshot Helper === */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_PAGE_DIMENSIONS") {
    const body = document.body;
    const html = document.documentElement;
    const fullHeight = Math.max(
      body.scrollHeight, body.offsetHeight,
      html.clientHeight, html.scrollHeight, html.offsetHeight
    );
    const fullWidth = Math.max(
      body.scrollWidth, body.offsetWidth,
      html.clientWidth, html.scrollWidth, html.offsetWidth
    );
    sendResponse({
      fullWidth,
      fullHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio || 1,
    });
    return true;
  }

  // Get element bounding rect (absolute page coordinates) for element screenshot
  if (msg.type === "GET_ELEMENT_RECT") {
    try {
      let el = null;

      // Prefer fullXpath (exact, index-based) when available — CSS selectors can be ambiguous
      // when multiple elements share the same tag+class combination.
      const s = msg.selectors;
      if (s?.fullXpath) {
        el = document.evaluate(s.fullXpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      }
      if (!el && s?.xpath) {
        el = document.evaluate(s.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      }
      if (!el && s?.id) {
        el = document.getElementById(s.id);
      }
      if (!el && msg.selector) {
        el = document.querySelector(msg.selector);
      }

      if (!el) { sendResponse({ error: "Element not found" }); return true; }
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) { sendResponse({ error: "Element has no size" }); return true; }
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

  // Check condition for conditional actions
  if (msg.type === "CHECK_CONDITION") {
    const { conditionType, selector, expectedValue } = msg;
    let result = false;
    
    try {
      switch (conditionType) {
        case 'elementExists': {
          // Check if element exists in DOM
          const el = document.querySelector(selector);
          result = !!el;
          break;
        }
        case 'elementNotExists': {
          // Check if element does NOT exist
          const el = document.querySelector(selector);
          result = !el;
          break;
        }
        case 'elementVisible': {
          // Check if element exists and is visible
          const el = document.querySelector(selector);
          if (el) {
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            result = style.display !== 'none' && 
                     style.visibility !== 'hidden' && 
                     style.opacity !== '0' &&
                     rect.width > 0 && rect.height > 0;
          }
          break;
        }
        case 'elementHidden': {
          // Check if element is hidden or doesn't exist
          const el = document.querySelector(selector);
          if (!el) {
            result = true;
          } else {
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            result = style.display === 'none' || 
                     style.visibility === 'hidden' || 
                     style.opacity === '0' ||
                     rect.width === 0 || rect.height === 0;
          }
          break;
        }
        case 'textContains': {
          // Check if element contains expected text
          const el = document.querySelector(selector);
          if (el) {
            result = el.textContent.includes(expectedValue);
          }
          break;
        }
        case 'textEquals': {
          // Check if element text equals expected value
          const el = document.querySelector(selector);
          if (el) {
            result = el.textContent.trim() === expectedValue.trim();
          }
          break;
        }
        case 'valueEquals': {
          // Check if input value equals expected value
          const el = document.querySelector(selector);
          if (el && 'value' in el) {
            result = el.value === expectedValue;
          }
          break;
        }
        case 'valueContains': {
          // Check if input value contains expected value
          const el = document.querySelector(selector);
          if (el && 'value' in el) {
            result = el.value.includes(expectedValue);
          }
          break;
        }
        case 'urlContains': {
          // Check if current URL contains expected value
          result = window.location.href.includes(expectedValue);
          break;
        }
        case 'urlEquals': {
          // Check if current URL equals expected value
          result = window.location.href === expectedValue;
          break;
        }
        case 'hasClass': {
          // Check if element has specific class
          const el = document.querySelector(selector);
          if (el) {
            result = el.classList.contains(expectedValue);
          }
          break;
        }
        case 'hasAttribute': {
          // Check if element has specific attribute (supports "attr" or "attr=value" format)
          const el = document.querySelector(selector);
          if (el) {
            if (expectedValue.includes('=')) {
              const eqIdx = expectedValue.indexOf('=');
              const attrName = expectedValue.slice(0, eqIdx);
              const attrVal = expectedValue.slice(eqIdx + 1);
              result = el.hasAttribute(attrName) && el.getAttribute(attrName) === attrVal;
            } else {
              result = el.hasAttribute(expectedValue);
            }
          }
          break;
        }
        default:
          result = true; // Unknown condition type, continue
      }
    } catch (e) {
      log('CHECK_CONDITION error:', e);
      result = true; // Continue on error
    }
    
    sendResponse({ result });
    return true;
  }
});

/* === Hotkeys === */

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

/* === Visible Screenshot Countdown === */

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
  hint.textContent = 'Mở dropdown…';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '✕';
  cancelBtn.title = 'Hủy (ESC)';
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
  // Two rAF frames ensure overlay is fully removed from the rendered frame before capture
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

// Handle countdown request from popup (button click)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'START_VISIBLE_COUNTDOWN') {
    _startVisibleCountdown(msg.seconds || 3, !!msg.crop);
  }
});

document.addEventListener('keydown', (e) => {
  // ESC cancels countdown overlay first, then picker mode
  if (e.key === 'Escape' && _countdownActive) {
    e.preventDefault();
    _cancelCountdown();
    return;
  }

  if (pickerMode && e.key === 'Escape') {
    e.preventDefault();
    pickerMode = false;
    clearPickerUI();
    safeSend({ type: 'STOP_PICK_MODE' });
    return;
  }

  // Skip when user is typing in a form field
  const tag = document.activeElement?.tagName;
  if (['INPUT', 'TEXTAREA'].includes(tag)) return;
  if (document.activeElement?.isContentEditable) return;

  const combo = getKeyCombo(e);

  if (combo === activeHotkeys.startRecord || combo === activeHotkeys.stopRecord) {
    e.preventDefault();
    chrome.runtime.sendMessage({ type: 'IS_TAB_ACTIVATED' }, (res) => {
      if (!res?.activated) return;
      if (combo === activeHotkeys.startRecord) {
        safeSend({ type: 'START_RECORD' });
        log('Hotkey: START_RECORD');
      } else {
        safeSend({ type: 'STOP_RECORD' });
        log('Hotkey: STOP_RECORD');
      }
    });
  } else if (combo === activeHotkeys.screenshot) {
    e.preventDefault();
    chrome.storage.local.get(['screenshotCountdownEnabled', 'screenshotCountdownSeconds'], (res) => {
      if (res.screenshotCountdownEnabled) {
        _startVisibleCountdown(res.screenshotCountdownSeconds || 3, true);
      } else {
        safeSend({ type: 'TAKE_SCREENSHOT', crop: true });
      }
    });
    log('Hotkey: TAKE_SCREENSHOT');
  } else if (combo === activeHotkeys.screenshotFull) {
    e.preventDefault();
    safeSend({ type: 'TAKE_SCREENSHOT_FULL', crop: true });
    log('Hotkey: TAKE_SCREENSHOT_FULL');
  } else if (activeHotkeys.screenshotScrollV && combo === activeHotkeys.screenshotScrollV) {
    e.preventDefault();
    safeSend({ type: 'TAKE_SCREENSHOT_SCROLL_V' });
    log('Hotkey: TAKE_SCREENSHOT_SCROLL_V');
  } else if (activeHotkeys.screenshotScrollH && combo === activeHotkeys.screenshotScrollH) {
    e.preventDefault();
    safeSend({ type: 'TAKE_SCREENSHOT_SCROLL_H' });
    log('Hotkey: TAKE_SCREENSHOT_SCROLL_H');
  } else if (activeHotkeys.segV && combo === activeHotkeys.segV) {
    e.preventDefault();
    safeSend({ type: 'HOTKEY_SEG_START', dir: 'vertical' });
    log('Hotkey: SEG_START vertical');
  } else if (activeHotkeys.segH && combo === activeHotkeys.segH) {
    e.preventDefault();
    safeSend({ type: 'HOTKEY_SEG_START', dir: 'horizontal' });
    log('Hotkey: SEG_START horizontal');
  } else if (activeHotkeys.segStop && combo === activeHotkeys.segStop) {
    e.preventDefault();
    // Trigger the stop button if segment capture is active
    if (_segCapture) {
      document.querySelector('#__ext_seg_bar_stop')?.click();
    }
    log('Hotkey: SEG_STOP');
  } else if (activeHotkeys.screenshotElement && combo === activeHotkeys.screenshotElement) {
    e.preventDefault();
    safeSend({ type: 'HOTKEY_SCREENSHOT_ELEMENT' });
    log('Hotkey: SCREENSHOT_ELEMENT');
  }
}, true);

/* === Full-page screenshot stitching === */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "STITCH_SCREENSHOTS") return;

  const { segments, fullWidth, fullHeight, devicePixelRatio: dpr, horizontal } = msg;

  const canvasW = Math.round(fullWidth  * dpr);
  const canvasH = Math.round(fullHeight * dpr);

  // Chrome canvas hard limit — beyond this toDataURL returns empty string
  const MAX_DIM = 16384;
  if (canvasW > MAX_DIM || canvasH > MAX_DIM) {
    console.warn(`[STITCH] Canvas too large (${canvasW}x${canvasH}), max ${MAX_DIM}. Stitching should be done in service worker.`);
    sendResponse({ error: `Canvas dimension ${Math.max(canvasW, canvasH)}px exceeds limit` });
    return true;
  }

  const canvas = document.createElement("canvas");
  canvas.width  = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext("2d");

  // Load and draw each segment using pre-computed src/dest values
  (async () => {
    for (const seg of segments) {
      await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          if (horizontal) {
            // srcY→srcX, srcH→srcW, destY→destX for horizontal stitching
            if (seg.srcH > 0) {
              ctx.drawImage(img, seg.srcY, 0, seg.srcH, img.height, seg.destY, 0, seg.srcH, img.height);
            }
          } else {
            if (seg.srcH > 0) {
              ctx.drawImage(img, 0, seg.srcY, img.width, seg.srcH, 0, seg.destY, img.width, seg.srcH);
            }
          }
          resolve();
        };
        img.onerror = resolve;
        img.src = seg.dataUrl;
      });
    }
    sendResponse({ dataUrl: canvas.toDataURL("image/png") });
  })();

  return true; // async
});

/* === Ping/Pong for connection check === */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "PING") {
    sendResponse({ type: "PONG", ready: true, timestamp: Date.now() });
    return true;
  }
});

/* === Segment Capture Overlay === */

let _segCapture = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "START_SEGMENT_TAB") return;

  // Remove any existing overlay
  if (_segCapture) {
    _segCapture.cleanup();
  }

  const dir = msg.dir;
  const isVert = dir === "vertical";
  const startX = window.scrollX;
  const startY = window.scrollY;

  const bar = document.createElement("div");
  bar.style.cssText = [
    "position:fixed",
    "top:0",
    "left:0", "right:0",
    "background:rgba(20,20,20,0.92)",
    "color:#fff",
    "font:13px/1.4 sans-serif",
    "padding:8px 14px",
    "display:flex",
    "align-items:center",
    "gap:12px",
    "z-index:2147483647",
    "box-shadow:0 2px 8px rgba(0,0,0,0.5)",
  ].join(";");

  const lblStart = document.createElement("span");
  lblStart.textContent = `\uD83D\uDCCD B\u1eaft \u0111\u1ea7u: X = ${startX}px, Y = ${startY}px`;

  const lblCurrent = document.createElement("span");
  lblCurrent.style.flex = "1";

  const updateLbl = () => {
    const endX = window.scrollX + window.innerWidth;
    const endY = window.scrollY + window.innerHeight;

    const distX = Math.abs(endX - startX);
    const distY = Math.abs(endY - startY);
    lblCurrent.textContent = `\u0110\u1ebfn: X=${endX}px, Y=${endY}px (W=${distX}px, H=${distY}px)`;
  };
  updateLbl();

  const btnCancel = document.createElement("button");
  btnCancel.textContent = "\u2716 H\u1ee7y";
  btnCancel.style.cssText = "background:#555;color:#fff;border:none;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:12px;";

  const btnStop = document.createElement("button");
  btnStop.id = "__ext_seg_bar_stop";
  btnStop.textContent = "\u23F9 D\u1eebng & Ch\u1ee5p";
  btnStop.style.cssText = "background:#e74c3c;color:#fff;border:none;padding:5px 12px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;";

  bar.append(lblStart, lblCurrent, btnCancel, btnStop);
  document.documentElement.appendChild(bar);

  /* --- Auto-scroll loop (speed from storage, default 2px/frame) --- */
  let rafId = null;
  let scrollStopped = false;
  let scrollStep = 2;
  const speedKey = isVert ? "segScrollSpeedV" : "segScrollSpeedH";
  chrome.storage.sync.get([speedKey], (res) => {
    scrollStep = Math.min(10, Math.max(0.1, parseFloat(res[speedKey]) || 2));
  });

  const scrollLoop = () => {
    if (scrollStopped) return;
    const before = isVert ? window.scrollY : window.scrollX;
    if (isVert) window.scrollBy(0, scrollStep);
    else        window.scrollBy(scrollStep, 0);
    const after = isVert ? window.scrollY : window.scrollX;
    updateLbl();
    // Auto-stop when page end is reached
    if (after === before) {
      scrollStopped = true;
      btnStop.textContent = "\u23F9 Ch\u1ee5p (cu\u1ed1i trang)";
      return;
    }
    rafId = requestAnimationFrame(scrollLoop);
  };
  rafId = requestAnimationFrame(scrollLoop);

  const cleanup = () => {
    scrollStopped = true;
    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
    bar.remove();
    _segCapture = null;
  };

  btnCancel.addEventListener("click", () => {
    cleanup();
    chrome.runtime.sendMessage({ type: "CANCEL_SEGMENT_CAPTURE" });
  });

  btnStop.addEventListener("click", () => {
    const endX = window.scrollX + window.innerWidth;
    const endY = window.scrollY + window.innerHeight;
    cleanup();

    // Scroll back to start position before capture so screenshot.js tiles from the correct origin
    window.scrollTo(startX, startY);

    requestAnimationFrame(() => requestAnimationFrame(() => {
      const payload = {
        type: "CAPTURE_SEGMENT",
        xStart: Math.min(startX, endX),
        yStart: Math.min(startY, endY),
        xEnd: Math.max(startX, endX),
        yEnd: Math.max(startY, endY)
      };
      chrome.runtime.sendMessage(payload);
    }));
  });

  _segCapture = { cleanup };
  sendResponse({ ok: true });
  return true;
});

/* === Notify ready === */

safeSend({ type: "CONTENT_READY" });
log("Content script READY");

} // End of injection guard
