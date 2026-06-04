/**
 * export-bookmarklet.js — Convert a recorded scenario into a standalone JS bookmarklet.
 *
 * The generated code is a self-contained `javascript:(async () => { … })()` IIFE
 * that reproduces click/input/hover/navigate/wait/script/condition actions using
 * only browser APIs — no extension required at run time. Screenshot and switch
 * actions are skipped with a comment because they depend on the Extension API.
 *
 * Variable interpolation is handled in the generated code: static variables become
 * `const` declarations; `{random:type:len}` variables become inline generators that
 * produce a fresh value on each bookmark click.
 *
 * Exports: generateBookmarklet, initExportBookmarklet
 */

import { showToast, lockScroll, unlockScroll, trapFocus, escHtml, getUsedVarNames } from './utils.js';

// ─────────────────────────────────────────────────────────────────────────────
// GENERATOR CORE
// ─────────────────────────────────────────────────────────────────────────────

const SKIPPED_TYPES = new Set([
  'screenshot', 'screenshot_full', 'screenshot_element', 'screenshot_tovar', 'switch'
]);

function _activeVal(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'activeType' in v) {
    const t = v.activeType || 's';
    if (t === 'r' && v.r) return `{random:${v.r.type}:${v.r.length}}`;
    if (t === 'p') { const vals = (v.p || []).filter(Boolean); return vals.length ? `{pick:${vals.join('|')}}` : ''; }
    if (t === 'f') { const vals = (v.f || []).filter(Boolean); return vals.length ? `{fallback:${vals.join('|')}}` : ''; }
    return v.s || '';
  }
  return '';
}

function parseRandomSpec(val) {
  const m = _activeVal(val).match(/^\{random:(\w+):(\d+)\}$/);
  return m ? { type: m[1], length: parseInt(m[2]) } : null;
}

function parsePickSpec(val) {
  const m = _activeVal(val).match(/^\{pick:(.+)\}$/);
  return m ? m[1].split('|').map(s => s.trim()).filter(Boolean) : null;
}

function makeRandomFn(type, length) {
  if (type === 'alpha')
    return `() => Array.from({length:${length}},()=>'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random()*52)]).join('')`;
  if (type === 'numeric')
    return `() => Array.from({length:${length}},()=>String(Math.floor(Math.random()*10))).join('')`;
  return `() => Array.from({length:${length}},()=>'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random()*62)]).join('')`;
}

export function previewRandom(type, length) {
  const c = {
    alpha: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
    numeric: '0123456789',
    alphanumeric: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  };
  const ch = c[type] || c.alphanumeric;
  return Array.from({ length }, () => ch[Math.floor(Math.random() * ch.length)]).join('');
}

/**
 * Sanitize a string into a valid JS identifier.
 * Prevents code injection when variable names from user input are embedded in generated code.
 */
function _sanitizeVarName(name) {
  return (name || 'var').replace(/[^a-zA-Z0-9_$]/g, '_').replace(/^\d/, '_');
}

function getBestSel(action) {
  const s = action.selectors || {};
  return s.css
    || action.selector
    || (s.id ? '#' + s.id : '')
    || s.xpath
    || s.fullXpath
    || '';
}

// Returns a JS expression string representing the value.
// ${varName} references are intentionally left unescaped so they interpolate
// the declared JS variables (static consts or random generators) at run time.
function valueToJS(val) {
  if (val == null) return "''";
  const s = String(val);
  if (/\$\{/.test(s)) {
    const escaped = s
      .replace(/\\/g, '\\\\')   // backslash first
      .replace(/`/g, '\\`');    // backtick — ${varName} is kept to reference declared vars
    return '`' + escaped + '`';
  }
  return JSON.stringify(s);
}

function indentLines(lines, spaces) {
  return lines.map(l => (l === '' ? '' : spaces + l));
}

// Serializes a conditions object into a JS object literal, interpolating
// ${varName} references via valueToJS(). {fallback:...} specs are passed as
// JSON string literals — the runtime _findChild handles iteration.
function _conditionsToJS(cond) {
  if (!cond) return '{}';
  const parts = [];
  if (cond.matchMode) parts.push(`matchMode: ${JSON.stringify(cond.matchMode)}`);
  const strFields = ['valueEquals', 'textContains', 'idContains', 'classContains', 'typeEquals'];
  const FALLBACK_RE = /^\{fallback:(.+)\}$/;
  for (const f of strFields) {
    if (cond[f] != null && cond[f] !== '') {
      const v = String(cond[f]);
      // {fallback:...} is passed as a plain string literal — _findChild iterates at runtime.
      // ${varName} references are interpolated via template literals as usual.
      parts.push(`${f}: ${FALLBACK_RE.test(v) ? JSON.stringify(v) : valueToJS(v)}`);
    }
  }
  return `{${parts.join(', ')}}`;
}

// Generates the "if (condExpr) {" header for a condition action
function condHeader(action, stepNum) {
  const sel = getBestSel(action);
  const s = JSON.stringify(sel);
  const exp = valueToJS(action.expectedValue);
  const lbl = action.label ? ` — ${action.label}` : '';

  const exprMap = {
    elementExists:    `_qsel(${s}) !== null`,
    elementNotExists: `_qsel(${s}) === null`,
    elementVisible:   `(() => { const _e=_qsel(${s}); return !!_e && _e.offsetParent!==null; })()`,
    elementHidden:    `(() => { const _e=_qsel(${s}); return !_e || _e.offsetParent===null; })()`,
    textContains:     `(_qsel(${s})?.textContent||'').includes(${exp})`,
    textEquals:       `(_qsel(${s})?.textContent||'').trim()===${exp}`,
    valueEquals:      `(_qsel(${s})?.value||'')===${exp}`,
    valueContains:    `(_qsel(${s})?.value||'').includes(${exp})`,
    urlContains:      `window.location.href.includes(${exp})`,
    urlEquals:        `window.location.href===${exp}`,
    hasClass:         `(_qsel(${s})?.classList.contains(${exp})??false)`,
    hasAttribute:     `(_qsel(${s})?.hasAttribute(${exp})??false)`,
  };

  const expr = exprMap[action.conditionType] || `true /* unknown: ${action.conditionType} */`;
  return [
    `// Step ${stepNum}: condition — ${action.conditionType}${lbl}`,
    `if (${expr}) {`
  ];
}

// Generates JS lines for a single non-condition action
function actionLines(action, stepNum, stepDelay, elTimeout) {
  const lbl = action.label ? ` — ${action.label}` : '';
  const delay = action.delay != null ? action.delay : stepDelay;
  const sel = getBestSel(action);
  const v = `_el${stepNum}`;

  if (SKIPPED_TYPES.has(action.type)) {
    return [`// Step ${stepNum}: [SKIPPED] ${action.type} — requires Chrome Extension API`];
  }

  const out = [];
  switch (action.type) {
    case 'click':
      out.push(`// Step ${stepNum}: click${lbl}`);
      if (action.conditions) {
        out.push(`const ${v}_p = await getEl(${JSON.stringify(sel)}, ${elTimeout});`);
        out.push(`const ${v} = _findChild(${v}_p, ${_conditionsToJS(action.conditions)});`);
        out.push(`if (!${v}) throw new Error('Child condition not matched (step ${stepNum})');`);
      } else {
        out.push(`const ${v} = await getEl(${JSON.stringify(sel)}, ${elTimeout});`);
      }
      out.push(`${v}.click();`);
      if (delay > 0) out.push(`await sleep(${delay});`);
      break;

    case 'input':
      out.push(`// Step ${stepNum}: input${lbl}`);
      if (action.conditions) {
        out.push(`const ${v}_p = await getEl(${JSON.stringify(sel)}, ${elTimeout});`);
        out.push(`const ${v} = _findChild(${v}_p, ${_conditionsToJS(action.conditions)});`);
        out.push(`if (!${v}) throw new Error('Child condition not matched (step ${stepNum})');`);
      } else {
        out.push(`const ${v} = await getEl(${JSON.stringify(sel)}, ${elTimeout});`);
      }
      out.push(`setInput(${v}, ${valueToJS(action.value)});`);
      if (delay > 0) out.push(`await sleep(${delay});`);
      break;

    case 'hover':
      out.push(`// Step ${stepNum}: hover${lbl}`);
      if (action.conditions) {
        out.push(`const ${v}_p = await getEl(${JSON.stringify(sel)}, ${elTimeout});`);
        out.push(`const ${v} = _findChild(${v}_p, ${_conditionsToJS(action.conditions)});`);
        out.push(`if (!${v}) throw new Error('Child condition not matched (step ${stepNum})');`);
      } else {
        out.push(`const ${v} = await getEl(${JSON.stringify(sel)}, ${elTimeout});`);
      }
      out.push(`${v}.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));`);
      out.push(`${v}.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));`);
      if (delay > 0) out.push(`await sleep(${delay});`);
      break;

    case 'dropdown':
      out.push(`// Step ${stepNum}: open dropdown (freeze)${lbl}`);
      out.push(`const ${v} = await getEl(${JSON.stringify(sel)}, ${elTimeout});`);
      out.push(`${v}.click();`);
      if (delay > 0) out.push(`await sleep(${delay});`);
      break;

    case 'dragdrop': {
      const tgt = action.targetSelectors?.css || action.targetSelector || '';
      out.push(`// Step ${stepNum}: dragdrop${lbl}`);
      out.push(`const ${v}_s = await getEl(${JSON.stringify(sel)}, ${elTimeout});`);
      out.push(`const ${v}_t = await getEl(${JSON.stringify(tgt)}, ${elTimeout});`);
      out.push(`const _sr${stepNum} = ${v}_s.getBoundingClientRect(), _tr${stepNum} = ${v}_t.getBoundingClientRect();`);
      out.push(`${v}_s.dispatchEvent(new MouseEvent('mousedown', { bubbles:true, clientX:_sr${stepNum}.x+_sr${stepNum}.width/2, clientY:_sr${stepNum}.y+_sr${stepNum}.height/2 }));`);
      out.push(`await sleep(50);`);
      out.push(`${v}_t.dispatchEvent(new MouseEvent('mousemove', { bubbles:true, clientX:_tr${stepNum}.x+_tr${stepNum}.width/2, clientY:_tr${stepNum}.y+_tr${stepNum}.height/2 }));`);
      out.push(`${v}_s.dispatchEvent(new MouseEvent('mouseup',   { bubbles:true, clientX:_tr${stepNum}.x+_tr${stepNum}.width/2, clientY:_tr${stepNum}.y+_tr${stepNum}.height/2 }));`);
      if (delay > 0) out.push(`await sleep(${delay});`);
      break;
    }

    case 'navigate':
      out.push(`// Step ${stepNum}: navigate${lbl}`);
      out.push(`// ⚠ Page will reload — steps after this will not execute unless injected on next load`);
      out.push(`window.location.href = ${valueToJS(action.url)};`);
      out.push(`await sleep(1000);`);
      break;

    case 'wait': {
      const ms = action.delay != null ? action.delay : (parseInt(action.value) || 1000);
      out.push(`// Step ${stepNum}: wait${lbl}`);
      out.push(`await sleep(${ms});`);
      break;
    }

    case 'script':
      // Wrap in async IIFE so the user's code cannot leak variables or
      // 'return' statements into the outer bookmarklet closure, and so that
      // top-level 'await' works inside the script without syntax errors.
      out.push(`// Step ${stepNum}: script${lbl}`);
      out.push(`await (async () => {`);
      out.push(`  // [USER SCRIPT BEGIN]`);
      for (const line of (action.code || action.value || '').split('\n')) out.push(`  ${line}`);
      out.push(`  // [USER SCRIPT END]`);
      out.push(`})();`);
      if (delay > 0) out.push(`await sleep(${delay});`);
      break;

    case 'readdom': {
      const varName = _sanitizeVarName((action.varName || 'domVar').replace(/^\$\{|\}$/g, ''));
      out.push(`// Step ${stepNum}: readdom → "${varName}"${lbl}`);
      out.push(`const ${v} = await getEl(${JSON.stringify(sel)}, ${elTimeout});`);
      if (action.readFrom === 'value')        out.push(`${varName} = ${v}.value || '';`);
      else if (action.readFrom === 'attr')    out.push(`${varName} = ${v}.getAttribute(${JSON.stringify(action.attrName || '')}) || '';`);
      else                                    out.push(`${varName} = ${v}.textContent.trim();`);
      if (delay > 0) out.push(`await sleep(${delay});`);
      break;
    }

    default:
      out.push(`// Step ${stepNum}: ${action.type}${lbl} — [unsupported type, skipped]`);
  }

  return out;
}

// Recursively processes an action array, grouping condition blocks
// Disabled actions are skipped inline so skipCount stays aligned with the original array.
function processActions(actions, baseIdx, stepDelay, elTimeout) {
  const out = [];
  let i = 0;

  while (i < actions.length) {
    const action = actions[i];

    if (action.disabled) {
      i++;
      continue;
    }

    const stepNum = baseIdx + i + 1;

    if (action.type === 'condition') {
      const skipCount = Math.max(1, action.skipCount || 1);
      out.push(...condHeader(action, stepNum));
      const body = actions.slice(i + 1, i + 1 + skipCount);
      const bodyLines = processActions(body, baseIdx + i + 1, stepDelay, elTimeout);
      out.push(...indentLines(bodyLines, '  '));
      out.push('}');
      out.push('');
      i += 1 + skipCount;
    } else {
      out.push(...actionLines(action, stepNum, stepDelay, elTimeout));
      out.push('');
      i++;
    }
  }

  return out;
}

/**
 * Generate a self-contained JS bookmarklet string for the given scenario.
 *
 * @param {string}   scenarioName - Human-readable name embedded as a comment.
 * @param {object[]} actions      - Scenario action array (disabled actions are skipped).
 * @param {object}   variables    - Key/value pairs; random specs are expanded inline.
 * @param {object}   opts
 * @param {number}   opts.stepDelay  - Default inter-step delay in ms (default 300).
 * @param {number}   opts.elTimeout  - Element wait timeout in ms (default 5000).
 * @returns {{ code: string, stats: { total, supported, skipped, hasNavigate, staticVarCount, randomVarCount } }}
 */
export function generateBookmarklet(scenarioName, actions, variables, opts = {}) {
  const { stepDelay = 300, elTimeout = 5000 } = opts;

  const staticVars = {}, randomSpecs = {}, pickSpecs = {}, readdomVars = new Set();

  for (const [k, v] of Object.entries(variables || {})) {
    const str  = _activeVal(v);
    const spec = parseRandomSpec(str);
    const pick = parsePickSpec(str);
    if (spec)      randomSpecs[k] = spec;
    else if (pick) pickSpecs[k]   = pick;
    else           staticVars[k]  = str;
  }

  const enabled = (actions || []).filter(a => !a.disabled);

  for (const a of enabled) {
    if (a.type === 'readdom' && a.varName) {
      readdomVars.add(_sanitizeVarName(a.varName.replace(/^\$\{|\}$/g, '')));
    }
  }

  let skipped = 0, supported = 0, hasNavigate = false;
  for (const a of enabled) {
    if (SKIPPED_TYPES.has(a.type)) skipped++;
    else supported++;
    if (a.type === 'navigate') hasNavigate = true;
  }

  const out = [];

  out.push('javascript:(async () => {');
  out.push(`  // ============================`);
  out.push(`  // BOOKMARKLET: ${scenarioName}`);
  out.push(`  // ============================`);
  out.push('');
  out.push('  // --- HELPER FUNCTIONS ---');
  out.push('  const sleep = ms => new Promise(r => setTimeout(r, ms));');
  out.push('');
  out.push('  const _qsel = sel => (sel.startsWith(\'/\') || sel.startsWith(\'(\'))');
  out.push('    ? document.evaluate(sel, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue');
  out.push('    : document.querySelector(sel);');
  out.push('');
  out.push(`  const getEl = (sel, timeout = ${elTimeout}) => new Promise((res, rej) => {`);
  out.push('    const el = _qsel(sel);');
  out.push('    if (el) return res(el);');
  out.push('    const obs = new MutationObserver(() => {');
  out.push('      const found = _qsel(sel);');
  out.push('      if (found) { obs.disconnect(); res(found); }');
  out.push('    });');
  out.push('    obs.observe(document.body, { childList: true, subtree: true });');
  // This string is single-quoted so `${sel}` is NOT template-interpolated by our
  // generator — it is emitted verbatim. In the generated bookmarklet, `sel` will be
  // a real JS variable, and the backtick template literal will work correctly at run time.
  out.push('    setTimeout(() => { obs.disconnect(); rej(new Error(`Timeout: ${sel}`)); }, timeout);');
  out.push('  });');
  out.push('');
  out.push('  const setInput = (el, value) => {');
  out.push('    el.focus();');
  out.push('    let nv = null, p = Object.getPrototypeOf(el);');
  out.push('    while (p && p !== Object.prototype) {');
  out.push("      const d = Object.getOwnPropertyDescriptor(p, 'value');");
  out.push('      if (d?.set) { nv = d.set; break; }');
  out.push('      p = Object.getPrototypeOf(p);');
  out.push('    }');
  out.push('    if (nv) nv.call(el, value); else el.value = value;');
  out.push("    el.dispatchEvent(new Event('input', { bubbles: true }));");
  out.push("    el.dispatchEvent(new Event('change', { bubbles: true }));");
  out.push('  };');
  out.push('');
  // _findChild supports {fallback:A|B|C} in condition fields — tries each value
  // in order and returns the first matching child element.
  out.push('  const _findChild = (parent, cond) => {');
  out.push("    const _fbRe = /^\\{fallback:(.+)\\}$/;");
  out.push("    const _fbField = ['valueEquals','textContains','idContains','classContains','typeEquals'].find(f => cond[f] != null && _fbRe.test(String(cond[f])));");
  out.push("    const _fbVals  = _fbField ? String(cond[_fbField]).match(_fbRe)[1].split('|').map(s=>s.trim()).filter(Boolean) : null;");
  out.push("    const _tryFind = (c) => {");
  out.push("      const mode = c.matchMode || 'any';");
  out.push("      const norm = s => (s == null ? '' : String(s).trim().toLowerCase());");
  out.push('      const checks = [];');
  out.push("      if (c.valueEquals   != null && c.valueEquals   !== '') checks.push(el => el.value !== undefined && String(el.value) === String(c.valueEquals));");
  out.push("      if (c.textContains  != null && c.textContains  !== '') { const n = norm(c.textContains);  checks.push(el => norm(el.textContent).includes(n)); }");
  out.push("      if (c.idContains    != null && c.idContains    !== '') { const n = norm(c.idContains);    checks.push(el => norm(el.id).includes(n)); }");
  out.push("      if (c.classContains != null && c.classContains !== '') { const n = norm(c.classContains); checks.push(el => norm(el.className).includes(n)); }");
  out.push("      if (c.typeEquals    != null && c.typeEquals    !== '') checks.push(el => el.type === c.typeEquals);");
  out.push("      if (!checks.length) return null;");
  out.push("      const test = mode === 'all' ? el => checks.every(fn => fn(el)) : el => checks.some(fn => fn(el));");
  out.push('      const walker = document.createTreeWalker(parent, NodeFilter.SHOW_ELEMENT);');
  out.push('      let node = walker.nextNode();');
  out.push('      while (node) { if (test(node)) return node; node = walker.nextNode(); }');
  out.push('      return null;');
  out.push('    };');
  out.push("    if (_fbField && _fbVals) {");
  out.push("      for (const _fv of _fbVals) { const el = _tryFind({...cond, [_fbField]: _fv}); if (el) return el; }");
  out.push("      return null;");
  out.push("    }");
  out.push('    return _tryFind(cond);');
  out.push('  };');

  if (Object.keys(randomSpecs).length > 0) {
    out.push('');
    out.push('  // --- RANDOM VARIABLE GENERATORS ---');
    for (const [k, spec] of Object.entries(randomSpecs)) {
      const safe = _sanitizeVarName(k);
      out.push(`  const _gen_${safe} = ${makeRandomFn(spec.type, spec.length)};`);
    }
  }

  const hasVars = Object.keys(staticVars).length > 0
    || Object.keys(randomSpecs).length > 0
    || Object.keys(pickSpecs).length > 0
    || readdomVars.size > 0;

  if (hasVars) {
    out.push('');
    out.push('  // --- VARIABLES ---');
    for (const [k, v] of Object.entries(staticVars)) {
      out.push(`  const ${_sanitizeVarName(k)} = ${JSON.stringify(v)};`);
    }
    for (const k of Object.keys(randomSpecs)) {
      const safe = _sanitizeVarName(k);
      out.push(`  const ${safe} = _gen_${safe}();`);
    }
    for (const [k, vals] of Object.entries(pickSpecs)) {
      const safe    = _sanitizeVarName(k);
      const jsArray = '[' + vals.map(v => JSON.stringify(v)).join(', ') + ']';
      out.push(`  const ${safe} = ${jsArray}[Math.floor(Math.random() * ${vals.length})];`);
    }
    for (const k of readdomVars) {
      out.push(`  let ${k} = '';`);
    }
  }

  out.push('');
  out.push('  // --- MAIN FLOW ---');
  out.push('  try {');
  out.push('');

  for (const line of processActions(actions || [], 0, stepDelay, elTimeout)) {
    out.push(line === '' ? '' : '    ' + line);
  }

  out.push("    console.log('✅ Bookmarklet completed successfully.');");
  out.push('');
  out.push('  } catch (err) {');
  out.push("    console.error('❌ Bookmarklet error:', err);");
  out.push("    alert('Error: ' + err.message);");
  out.push('  }');
  out.push('');
  out.push('})();');

  return {
    code: out.join('\n'),
    stats: {
      total: enabled.length, supported, skipped, hasNavigate,
      staticVarCount: Object.keys(staticVars).length,
      randomVarCount: Object.keys(randomSpecs).length
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// UI MODULE
// ─────────────────────────────────────────────────────────────────────────────

let _currentCode         = '';
let _currentScenarioName = '';
let _currentActions      = [];
let _releaseFocus        = null;

/** Wire the export-bookmarklet modal trigger and all modal-internal buttons. */
export function initExportBookmarklet() {
  const triggerBtn = document.getElementById('exportBookmarklet');
  if (!triggerBtn) return;

  triggerBtn.addEventListener('click', _onTrigger);
  document.getElementById('exportBmClose')?.addEventListener('click', _close);
  document.getElementById('exportBmCancel')?.addEventListener('click', _close);
  document.getElementById('exportBmCopy')?.addEventListener('click', _copy);
  document.getElementById('exportBmDownload')?.addEventListener('click', _download);
  document.getElementById('exportBmRegenerate')?.addEventListener('click', _regenerate);

  document.getElementById('exportBmWrapBtn')?.addEventListener('click', () => {
    const code = document.getElementById('exportBmCode');
    if (code) code.style.whiteSpace = code.style.whiteSpace === 'pre-wrap' ? 'pre' : 'pre-wrap';
  });

  document.getElementById('exportBmSelectAllBtn')?.addEventListener('click', () => {
    const code = document.querySelector('#exportBmCode code');
    if (!code) return;
    const range = document.createRange();
    range.selectNodeContents(code);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });

  document.querySelectorAll('.export-bm-tab').forEach(btn => {
    btn.addEventListener('click', () => _switchTab(btn.dataset.tab));
  });

  document.getElementById('exportBmModal')?.addEventListener('click', e => {
    if (e.target.id === 'exportBmModal') _close();
  });

  document.getElementById('exportBmModal')?.addEventListener('keydown', e => {
    if (e.key === 'Escape') _close();
  });
}

function _onTrigger() {
  const sel = document.getElementById('exportCodeSelect');
  const scenarioId = sel?.value;
  if (!scenarioId) { showToast('Please select a scenario first', 'error'); return; }

  const scenarioName = sel.options[sel.selectedIndex]?.text || 'Scenario';
  _currentScenarioName = scenarioName;

  chrome.runtime.sendMessage({ type: 'GET_SCENARIOS' }, res => {
    const scenario = (res?.scenarios || {})[scenarioId];
    const actions = scenario?.actions || [];
    _currentActions = actions;
    chrome.runtime.sendMessage({ type: 'GET_VARIABLES' }, varRes => {
      const allVariables = varRes?.variables || {};
      const usedNames = getUsedVarNames(actions);
      const variables = Object.fromEntries(
        Object.entries(allVariables).filter(([k]) => usedNames.has(k))
      );
      _openModal(scenarioName, actions, variables);
    });
  });
}

function _openModal(scenarioName, actions, variables) {
  const modal = document.getElementById('exportBmModal');
  if (!modal) return;

  const delay   = parseInt(document.getElementById('exportBmStepDelay')?.value) || 300;
  const timeout = parseInt(document.getElementById('exportBmElTimeout')?.value)  || 5000;

  const result = generateBookmarklet(scenarioName, actions, variables, { stepDelay: delay, elTimeout: timeout });
  _currentCode = result.code;

  _renderModal(scenarioName, result, variables);
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  lockScroll();
  _switchTab('preview');
  _releaseFocus = trapFocus(modal);
}

function _renderModal(scenarioName, result, variables) {
  const safe = scenarioName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const filename = `${safe}_bookmarklet.js`;

  // Header
  document.getElementById('exportBmTitle').textContent = `Export JS — ${scenarioName}`;
  document.getElementById('exportBmSub').textContent = `${filename} · ${result.stats.supported} steps`;
  document.getElementById('exportBmCodeLabel').textContent = filename;

  // Code preview
  const codeEl = document.querySelector('#exportBmCode code');
  if (codeEl) codeEl.textContent = result.code;

  // Warning bar
  const warning = document.getElementById('exportBmWarning');
  const skipMsg = document.getElementById('exportBmSkipMsg');
  if (result.stats.skipped > 0) {
    skipMsg.textContent = `${result.stats.skipped} action(s) skipped (screenshot/switch — requires Extension API)`;
    warning.style.display = '';
  } else {
    warning.style.display = 'none';
  }

  // Variables — row layout
  const vars = Object.entries(variables || {});
  document.getElementById('exportBmVarCount').textContent = vars.length;

  const noVarsEl = document.getElementById('exportBmNoVars');
  const listEl   = document.getElementById('exportBmVarList');

  if (vars.length === 0) {
    noVarsEl.style.display = '';
    listEl.innerHTML = '';
  } else {
    noVarsEl.style.display = 'none';
    listEl.innerHTML = '';
    for (const [key, rawVal] of vars) {
      const val     = _activeVal(rawVal);
      const spec    = parseRandomSpec(val);
      const pick    = parsePickSpec(val);
      const isRand  = !!spec;
      const isPick  = !!pick;
      let icon, badgeLabel, badgeCls, preview;
      if (isRand) {
        icon = '🎲'; badgeLabel = 'Random'; badgeCls = 'rand';
        preview = previewRandom(spec.type, spec.length);
      } else if (isPick) {
        icon = '⚄'; badgeLabel = `Pick (${pick.length})`; badgeCls = 'rand';
        preview = pick.join(' | ');
        if (preview.length > 40) preview = preview.slice(0, 40) + '…';
      } else {
        icon = '🔤'; badgeLabel = 'Static'; badgeCls = 'static';
        preview = val.length > 40 ? val.slice(0, 40) + '…' : val;
      }
      const row = document.createElement('div');
      row.className = 'export-bm-var-row';
      row.innerHTML = `
        <div class="export-bm-var-icon ${badgeCls}">${icon}</div>
        <span class="export-bm-var-name">\${${escHtml(key)}}</span>
        <span class="export-bm-badge ${badgeCls}">${badgeLabel}</span>
        <span class="export-bm-preview">${escHtml(preview)}</span>`;
      listEl.appendChild(row);
    }
  }

  // Actions review tab
  const actStats = _renderActionsTab(_currentActions);

  // Stats pills
  const { supported, skipped } = result.stats;
  document.getElementById('exportBmStatSteps').textContent = `${supported} steps`;
  document.getElementById('exportBmStatVars').textContent  = `${vars.length} variables`;

  const warnPill    = document.getElementById('exportBmStatWarnPill');
  const skippedPill = document.getElementById('exportBmStatSkippedPill');
  if (actStats.warnCount > 0) {
    document.getElementById('exportBmStatWarn').textContent = `${actStats.warnCount} verify`;
    warnPill.style.display = '';
  } else {
    warnPill.style.display = 'none';
  }
  if (skipped > 0) {
    document.getElementById('exportBmStatSkipped').textContent = `${skipped} skipped`;
    skippedPill.style.display = '';
  } else {
    skippedPill.style.display = 'none';
  }
}

// Produce a single-line bookmark URL: drop // comment lines, collapse whitespace.
// Keeps the javascript: prefix so it's ready to paste into a bookmark URL field.
function _toBookmarkletUrl(code) {
  return code
    .split('\n')
    .map(line => {
      const t = line.trim();
      return t.startsWith('//') ? '' : t;
    })
    .filter(Boolean)
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Strip the `javascript:` URI prefix for saving as a .js file.
 * `trimStart()` removes the leading newline that follows `javascript:` in the
 * multi-line pretty-printed template.
 */
function _toJsFile(code) {
  const body = code.startsWith('javascript:') ? code.slice('javascript:'.length) : code;
  return body.trimStart();
}

function _close() {
  const modal = document.getElementById('exportBmModal');
  modal?.classList.remove('show');
  modal?.setAttribute('aria-hidden', 'true');
  if (_releaseFocus) { _releaseFocus(); _releaseFocus = null; }
  unlockScroll();
}

function _switchTab(tab) {
  document.querySelectorAll('.export-bm-tab').forEach(btn => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  document.getElementById('exportBmTabPreview').hidden   = tab !== 'preview';
  document.getElementById('exportBmTabVariables').hidden = tab !== 'variables';
  document.getElementById('exportBmTabActions').hidden   = tab !== 'actions';
  document.getElementById('exportBmTabSettings').hidden  = tab !== 'settings';
}

async function _copy() {
  if (!_currentCode) return;
  try {
    await navigator.clipboard.writeText(_toBookmarkletUrl(_currentCode));
    const btn = document.getElementById('exportBmCopy');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✓ Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
    }
  } catch {
    showToast('Clipboard not available', 'error');
  }
}

function _download() {
  if (!_currentCode) return;
  const safe = _currentScenarioName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  // .js file: pretty-printed, without javascript: prefix
  const blob  = new Blob([_toJsFile(_currentCode)], { type: 'application/javascript' });
  const url   = URL.createObjectURL(blob);
  const a     = Object.assign(document.createElement('a'), { href: url, download: `${safe}_bookmarklet.js` });
  a.click();
  URL.revokeObjectURL(url);
}

function _regenerate() {
  const sel        = document.getElementById('exportCodeSelect');
  const scenarioId = sel?.value;
  if (!scenarioId) return;

  const delay   = parseInt(document.getElementById('exportBmStepDelay')?.value) || 300;
  const timeout = parseInt(document.getElementById('exportBmElTimeout')?.value)  || 5000;

  chrome.runtime.sendMessage({ type: 'GET_SCENARIOS' }, res => {
    const scenario  = (res?.scenarios || {})[scenarioId];
    const actions   = scenario?.actions || [];
    _currentActions = actions;
    chrome.runtime.sendMessage({ type: 'GET_VARIABLES' }, varRes => {
      const variables = varRes?.variables || {};
      const result    = generateBookmarklet(_currentScenarioName, actions, variables, { stepDelay: delay, elTimeout: timeout });
      _currentCode    = result.code;
      _renderModal(_currentScenarioName, result, variables);
      _switchTab('preview');
      showToast('Code regenerated');
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIONS REVIEW TAB
// ─────────────────────────────────────────────────────────────────────────────

const _ACT_TYPE_INFO = {
  navigate:           { icon: '🌐', label: 'navigate',   cls: 'nav' },
  click:              { icon: '👆', label: 'click',      cls: 'click' },
  input:              { icon: '⌨',  label: 'input',      cls: 'input' },
  hover:              { icon: '🖱',  label: 'hover',      cls: 'hover' },
  dropdown:           { icon: '▼',  label: 'dropdown',   cls: 'click' },
  dragdrop:           { icon: '↔',  label: 'dragdrop',   cls: 'dragdrop' },
  wait:               { icon: '⏱',  label: 'wait',       cls: 'wait' },
  script:             { icon: '📜', label: 'script',     cls: 'script' },
  condition:          { icon: '🔀', label: 'condition',  cls: 'condition' },
  screenshot:         { icon: '📷', label: 'screenshot', cls: 'screenshot' },
  screenshot_full:    { icon: '📷', label: 'scr-full',   cls: 'screenshot' },
  screenshot_element: { icon: '📷', label: 'scr-elem',   cls: 'screenshot' },
  screenshot_tovar:   { icon: '📷', label: 'scr-var',    cls: 'screenshot' },
  readdom:            { icon: '📖', label: 'readdom',    cls: 'readdom' },
  switch:             { icon: '🔄', label: 'switch',     cls: 'wait' },
};

function _actionDesc(a) {
  const sel = (a.selectors?.css
    || (a.selectors?.id ? '#' + a.selectors.id : '')
    || a.selector
    || '').slice(0, 40);
  switch (a.type) {
    case 'navigate':  return (a.value || a.url || '').slice(0, 50);
    case 'wait':      return `${a.delay ?? a.value ?? 1000} ms`;
    case 'script':    return 'custom JS code';
    case 'condition': return a.conditionType || 'condition';
    case 'switch':    return `→ ${(a.scenario || a.value || '')}`.slice(0, 40);
    case 'readdom':   return `${sel} → \${${a.varName || 'var'}}`;
    case 'screenshot':
    case 'screenshot_full':    return 'viewport';
    case 'screenshot_element': return sel || 'element';
    case 'screenshot_tovar':   return `→ \${${a.varName || 'screenshot'}}`;
    case 'input': {
      const v = a.value ? ` = "${String(a.value).slice(0, 15)}"` : '';
      return `${sel}${v}`;
    }
    default: return sel;
  }
}

function _renderActionsTab(actions) {
  const listEl    = document.getElementById('exportBmActList');
  const summaryEl = document.getElementById('exportBmActSummary');
  if (!listEl || !summaryEl) return { okCount: 0, warnCount: 0, skipCount: 0 };

  let okCount = 0, skipCount = 0, warnCount = 0;
  let html = '';

  const enabled = (actions || []).filter(a => !a.disabled);
  enabled.forEach((a, i) => {
    const info = _ACT_TYPE_INFO[a.type] || { icon: '●', label: a.type, cls: 'wait' };
    const desc = _actionDesc(a);
    let status, statusLabel, rowCls;
    if (SKIPPED_TYPES.has(a.type)) {
      status = 'skip'; statusLabel = '— Skip'; rowCls = 'row-skip'; skipCount++;
    } else if (a.type === 'script') {
      status = 'warn'; statusLabel = '⚠ Verify'; rowCls = 'row-warn'; warnCount++;
    } else {
      status = 'ok'; statusLabel = '✓ OK'; rowCls = ''; okCount++;
    }
    html += `<div class="export-bm-action-row ${rowCls}">
      <span class="export-bm-action-step">${i + 1}</span>
      <span class="export-bm-action-type abt-${info.cls}">${info.icon} ${info.label}</span>
      <span class="export-bm-action-desc">${escHtml(desc)}</span>
      <span class="export-bm-action-status ast-${status}">${statusLabel}</span>
    </div>`;
  });
  listEl.innerHTML = html;

  let sumHtml = '<span class="export-bm-act-sum-label">Will export:</span>';
  sumHtml += `<span class="export-bm-act-sum-pill act-sum-ok">✓ ${okCount} OK</span>`;
  if (warnCount) sumHtml += `<span class="export-bm-act-sum-pill act-sum-warn">⚠ ${warnCount} needs review</span>`;
  if (skipCount) sumHtml += `<span class="export-bm-act-sum-pill act-sum-skip">— ${skipCount} skipped</span>`;
  summaryEl.innerHTML = sumHtml;

  const badge = document.getElementById('exportBmActCount');
  if (badge) {
    const warnTotal = skipCount + warnCount;
    badge.textContent = warnTotal > 0 ? `${warnTotal} ⚠` : String(enabled.length);
    badge.className   = 'export-bm-tab-count' + (warnTotal > 0 ? ' warn' : '');
  }

  return { okCount, warnCount, skipCount };
}
