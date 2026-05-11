/**
 * export-bookmarklet.js — Convert a Scenario to a standalone JS Bookmarklet
 * Exports: generateBookmarklet, initExportBookmarklet
 */

import { showToast, lockScroll, unlockScroll, trapFocus, escHtml } from './utils.js';

// ─────────────────────────────────────────────────────────────────────────────
// GENERATOR CORE
// ─────────────────────────────────────────────────────────────────────────────

const SKIPPED_TYPES = new Set([
  'screenshot', 'screenshot_full', 'screenshot_element', 'screenshot_tovar', 'switch'
]);

function parseRandomSpec(val) {
  const m = String(val).match(/^\{random:(\w+):(\d+)\}$/);
  return m ? { type: m[1], length: parseInt(m[2]) } : null;
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

function getBestSel(action) {
  return action.selectors?.css
    || action.selector
    || (action.selectors?.id ? '#' + action.selectors.id : '')
    || '';
}

// Returns a JS expression string representing the value.
// If value contains ${varName}, wraps in a template literal so it references the JS var.
function valueToJS(val) {
  if (val == null) return "''";
  const s = String(val);
  if (/\$\{/.test(s)) return '`' + s.replace(/`/g, '\\`') + '`';
  return JSON.stringify(s);
}

function indentLines(lines, spaces) {
  return lines.map(l => (l === '' ? '' : spaces + l));
}

// Generates the "if (condExpr) {" header for a condition action
function condHeader(action, stepNum) {
  const sel = getBestSel(action);
  const s = JSON.stringify(sel);
  const exp = valueToJS(action.expectedValue);
  const lbl = action.label ? ` — ${action.label}` : '';

  const exprMap = {
    elementExists:    `document.querySelector(${s}) !== null`,
    elementNotExists: `document.querySelector(${s}) === null`,
    elementVisible:   `(() => { const _e=document.querySelector(${s}); return !!_e && _e.offsetParent!==null; })()`,
    elementHidden:    `(() => { const _e=document.querySelector(${s}); return !_e || _e.offsetParent===null; })()`,
    textContains:     `(document.querySelector(${s})?.textContent||'').includes(${exp})`,
    textEquals:       `(document.querySelector(${s})?.textContent||'').trim()===${exp}`,
    valueEquals:      `(document.querySelector(${s})?.value||'')===${exp}`,
    valueContains:    `(document.querySelector(${s})?.value||'').includes(${exp})`,
    urlContains:      `window.location.href.includes(${exp})`,
    urlEquals:        `window.location.href===${exp}`,
    hasClass:         `(document.querySelector(${s})?.classList.contains(${exp})??false)`,
    hasAttribute:     `(document.querySelector(${s})?.hasAttribute(${exp})??false)`,
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
      out.push(`const ${v} = await getEl(${JSON.stringify(sel)}, ${elTimeout});`);
      out.push(`${v}.click();`);
      if (delay > 0) out.push(`await sleep(${delay});`);
      break;

    case 'input':
      out.push(`// Step ${stepNum}: input${lbl}`);
      out.push(`const ${v} = await getEl(${JSON.stringify(sel)}, ${elTimeout});`);
      out.push(`setInput(${v}, ${valueToJS(action.value)});`);
      if (delay > 0) out.push(`await sleep(${delay});`);
      break;

    case 'hover':
      out.push(`// Step ${stepNum}: hover${lbl}`);
      out.push(`const ${v} = await getEl(${JSON.stringify(sel)}, ${elTimeout});`);
      out.push(`${v}.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));`);
      out.push(`${v}.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));`);
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
      out.push(`// Step ${stepNum}: script${lbl}`);
      out.push(`// [USER SCRIPT BEGIN]`);
      for (const line of (action.code || action.value || '').split('\n')) out.push(line);
      out.push(`// [USER SCRIPT END]`);
      if (delay > 0) out.push(`await sleep(${delay});`);
      break;

    case 'readdom': {
      const varName = (action.varName || 'domVar').replace(/^\$\{|\}$/g, '');
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
function processActions(actions, baseIdx, stepDelay, elTimeout) {
  const out = [];
  let i = 0;

  while (i < actions.length) {
    const action = actions[i];
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
 * generateBookmarklet(scenarioName, actions, variables, opts)
 * Returns { code: string, stats: object }
 */
export function generateBookmarklet(scenarioName, actions, variables, opts = {}) {
  const { stepDelay = 300, elTimeout = 5000 } = opts;

  const staticVars = {}, randomSpecs = {}, readdomVars = new Set();

  for (const [k, v] of Object.entries(variables || {})) {
    const spec = parseRandomSpec(v);
    if (spec) randomSpecs[k] = spec;
    else staticVars[k] = v;
  }

  const enabled = (actions || []).filter(a => !a.disabled);

  for (const a of enabled) {
    if (a.type === 'readdom' && a.varName) {
      readdomVars.add(a.varName.replace(/^\$\{|\}$/g, ''));
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
  out.push(`  const getEl = (sel, timeout = ${elTimeout}) => new Promise((res, rej) => {`);
  out.push('    const el = document.querySelector(sel);');
  out.push('    if (el) return res(el);');
  out.push('    const obs = new MutationObserver(() => {');
  out.push('      const found = document.querySelector(sel);');
  out.push('      if (found) { obs.disconnect(); res(found); }');
  out.push('    });');
  out.push('    obs.observe(document.body, { childList: true, subtree: true });');
  // Note: backtick and ${sel} below are literal characters in the output string (single-quoted here)
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

  if (Object.keys(randomSpecs).length > 0) {
    out.push('');
    out.push('  // --- RANDOM VARIABLE GENERATORS ---');
    for (const [k, spec] of Object.entries(randomSpecs)) {
      out.push(`  const _gen_${k} = ${makeRandomFn(spec.type, spec.length)};`);
    }
  }

  const hasVars = Object.keys(staticVars).length > 0
    || Object.keys(randomSpecs).length > 0
    || readdomVars.size > 0;

  if (hasVars) {
    out.push('');
    out.push('  // --- VARIABLES ---');
    for (const [k, v] of Object.entries(staticVars)) {
      out.push(`  const ${k} = ${JSON.stringify(v)};`);
    }
    for (const k of Object.keys(randomSpecs)) {
      out.push(`  const ${k} = _gen_${k}();`);
    }
    for (const k of readdomVars) {
      out.push(`  let ${k} = '';`);
    }
  }

  out.push('');
  out.push('  // --- MAIN FLOW ---');
  out.push('  try {');
  out.push('');

  for (const line of processActions(enabled, 0, stepDelay, elTimeout)) {
    out.push(line === '' ? '' : '    ' + line);
  }

  out.push("    console.log('✅ Bookmarklet completed successfully.');");
  out.push('');
  out.push('  } catch (err) {');
  out.push("    console.error('❌ Bookmarklet error:', err);");
  out.push("    alert('Lỗi: ' + err.message);");
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

let _currentCode = '';
let _currentScenarioName = '';
let _releaseFocus = null;

export function initExportBookmarklet() {
  const triggerBtn = document.getElementById('exportBookmarklet');
  if (!triggerBtn) return;

  triggerBtn.addEventListener('click', _onTrigger);
  document.getElementById('exportBmClose')?.addEventListener('click', _close);
  document.getElementById('exportBmCancel')?.addEventListener('click', _close);
  document.getElementById('exportBmCopy')?.addEventListener('click', _copy);
  document.getElementById('exportBmDownload')?.addEventListener('click', _download);
  document.getElementById('exportBmRegenerate')?.addEventListener('click', _regenerate);

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
  if (!scenarioId) { showToast('Chọn một scenario trước', 'error'); return; }

  const scenarioName = sel.options[sel.selectedIndex]?.text || 'Scenario';
  _currentScenarioName = scenarioName;

  chrome.runtime.sendMessage({ type: 'GET_SCENARIOS' }, res => {
    const scenario = (res?.scenarios || {})[scenarioId];
    const actions = scenario?.actions || [];
    chrome.runtime.sendMessage({ type: 'GET_VARIABLES' }, varRes => {
      const variables = varRes?.variables || {};
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
  document.getElementById('exportBmTitle').textContent = `Export JS — ${scenarioName}`;

  // Code preview
  const codeEl = document.querySelector('#exportBmCode code');
  if (codeEl) codeEl.textContent = result.code;

  // Warning bar
  const warning = document.getElementById('exportBmWarning');
  const skipMsg = document.getElementById('exportBmSkipMsg');
  if (result.stats.skipped > 0) {
    skipMsg.textContent = `${result.stats.skipped} action bị bỏ qua (screenshot/switch — yêu cầu Extension API)`;
    warning.style.display = '';
  } else {
    warning.style.display = 'none';
  }

  // Variables tab
  const vars = Object.entries(variables || {});
  document.getElementById('exportBmVarCount').textContent = vars.length;

  const noVarsEl = document.getElementById('exportBmNoVars');
  const tableEl  = document.getElementById('exportBmVarTable');
  const tbody    = document.getElementById('exportBmVarBody');

  if (vars.length === 0) {
    noVarsEl.style.display = '';
    tableEl.style.display  = 'none';
  } else {
    noVarsEl.style.display = 'none';
    tableEl.style.display  = '';
    tbody.innerHTML = '';
    for (const [key, val] of vars) {
      const spec    = parseRandomSpec(val);
      const isRand  = !!spec;
      const preview = isRand
        ? previewRandom(spec.type, spec.length)
        : (val.length > 32 ? val.slice(0, 32) + '…' : val);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escHtml(key)}</td>
        <td><span class="export-bm-badge ${isRand ? 'rand' : 'static'}">${isRand ? 'Random' : 'Static'}</span></td>
        <td class="export-bm-preview">${escHtml(preview)}</td>`;
      tbody.appendChild(tr);
    }
  }

  // Stats footer
  const { total, supported, skipped, hasNavigate } = result.stats;
  const statsEl = document.getElementById('exportBmStats');
  if (statsEl) {
    let txt = `${supported}/${total} steps`;
    if (skipped > 0) txt += ` · ${skipped} skipped`;
    if (hasNavigate) txt += ' · ⚠ navigate reloads page';
    statsEl.textContent = txt;
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

// Strip the javascript: prefix for saving as a .js file
function _toJsFile(code) {
  const body = code.startsWith('javascript:') ? code.slice('javascript:'.length) : code;
  // Also remove the empty lines before try block for cleaner file
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
  document.getElementById('exportBmTabSettings').hidden  = tab !== 'settings';
}

async function _copy() {
  if (!_currentCode) return;
  try {
    // Minified single-line URL — safe to paste into any bookmark URL field
    await navigator.clipboard.writeText(_toBookmarkletUrl(_currentCode));
    const btn = document.getElementById('exportBmCopy');
    if (btn) {
      btn.textContent = '✓ Copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = '📋 Copy';
        btn.classList.remove('copied');
      }, 1500);
    }
  } catch {
    showToast('Clipboard không khả dụng', 'error');
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
    chrome.runtime.sendMessage({ type: 'GET_VARIABLES' }, varRes => {
      const variables = varRes?.variables || {};
      const result    = generateBookmarklet(_currentScenarioName, actions, variables, { stepDelay: delay, elTimeout: timeout });
      _currentCode    = result.code;
      _renderModal(_currentScenarioName, result, variables);
      _switchTab('preview');
      showToast('Code đã được tạo lại');
    });
  });
}
