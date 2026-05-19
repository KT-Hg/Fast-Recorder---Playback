/**
 * export-selenium.js — Convert a Scenario to standalone Selenium Python code
 * Exports: generateSeleniumPy, initExportSelenium
 */

import { showToast, lockScroll, unlockScroll, trapFocus, escHtml } from './utils.js';

// ─────────────────────────────────────────────────────────────────────────────
// GENERATOR CORE
// ─────────────────────────────────────────────────────────────────────────────

function parseRandomSpec(val) {
  const m = String(val).match(/^\{random:(\w+):(\d+)\}$/);
  return m ? { type: m[1], length: parseInt(m[2]) } : null;
}

function previewRandom(type, length) {
  const c = {
    alpha: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
    numeric: '0123456789',
    alphanumeric: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  };
  const ch = c[type] || c.alphanumeric;
  return Array.from({ length }, () => ch[Math.floor(Math.random() * ch.length)]).join('');
}

function msToSec(ms) {
  return parseFloat((ms / 1000).toFixed(3));
}

// Picks the best available selector and returns { type, value }
function getBestSelInfo(action) {
  const s = action.selectors || {};
  if (s.css)       return { type: 'css',       value: s.css };
  if (s.id)        return { type: 'id',        value: s.id };
  if (s.name)      return { type: 'name',      value: s.name };
  if (s.text)      return { type: 'text',      value: s.text };
  if (s.xpath)     return { type: 'xpath',     value: s.xpath };
  if (s.fullXpath) return { type: 'fullXpath', value: s.fullXpath };
  return { type: action.selectorType || 'css', value: action.selector || '' };
}

function getBestTargetSelInfo(action) {
  const s = action.targetSelectors || {};
  if (s.css)       return { type: 'css',   value: s.css };
  if (s.xpath)     return { type: 'xpath', value: s.xpath };
  if (s.id)        return { type: 'id',    value: s.id };
  if (s.name)      return { type: 'name',  value: s.name };
  return { type: action.targetSelectorType || 'css', value: action.targetSelector || '' };
}

// Returns a Python (By.*, "selector") tuple string
function selToPy(selInfo) {
  const { type, value } = selInfo;
  switch (type) {
    case 'css':
      return `By.CSS_SELECTOR, ${JSON.stringify(value)}`;
    case 'id':
      return `By.ID, ${JSON.stringify(value)}`;
    case 'name':
      return `By.NAME, ${JSON.stringify(value)}`;
    case 'xpath':
    case 'fullXpath':
      return `By.XPATH, ${JSON.stringify(value)}`;
    case 'text': {
      // Build XPath using single-quotes when safe, else use concat()
      if (!value.includes("'")) {
        return `By.XPATH, ${JSON.stringify(`//*[contains(text(), '${value}')]`)}`;
      }
      const parts = value.split("'").map(p => `'${p}'`).join(", \"'\", ");
      return `By.XPATH, ${JSON.stringify(`//*[contains(text(), concat(${parts}))]`)}`;
    }
    default:
      return `By.CSS_SELECTOR, ${JSON.stringify(value)}`;
  }
}

// Converts a value that may contain ${varName} to a Python string/f-string
function valueToPy(val) {
  if (val == null) return '""';
  const s = String(val);
  if (/\$\{/.test(s)) {
    const inner = s
      .replace(/\$\{([^}]+)\}/g, '{$1}')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
    return `f"${inner}"`;
  }
  return JSON.stringify(s);
}

function safeVarName(name) {
  return (name || 'var').replace(/^\$\{|\}$/g, '').replace(/[^a-zA-Z0-9_]/g, '_');
}

// Generates the Python if-condition expression for a condition action
function condExprPy(action, selPy) {
  const exp = valueToPy(action.expectedValue);
  switch (action.conditionType) {
    case 'elementExists':
      return `len(driver.find_elements(${selPy})) > 0`;
    case 'elementNotExists':
      return `len(driver.find_elements(${selPy})) == 0`;
    case 'elementVisible':
      return `(lambda _e: bool(_e) and _e[0].is_displayed())(driver.find_elements(${selPy}))`;
    case 'elementHidden':
      return `(lambda _e: not _e or not _e[0].is_displayed())(driver.find_elements(${selPy}))`;
    case 'textContains':
      return `(driver.find_element(${selPy}).text if driver.find_elements(${selPy}) else '') and ${exp} in driver.find_element(${selPy}).text`;
    case 'textEquals':
      return `(driver.find_element(${selPy}).text.strip() if driver.find_elements(${selPy}) else '') == ${exp}`;
    case 'valueEquals':
      return `(driver.find_element(${selPy}).get_attribute('value') or '' if driver.find_elements(${selPy}) else '') == ${exp}`;
    case 'valueContains':
      return `${exp} in (driver.find_element(${selPy}).get_attribute('value') or '' if driver.find_elements(${selPy}) else '')`;
    case 'urlContains':
      return `${exp} in driver.current_url`;
    case 'urlEquals':
      return `driver.current_url == ${exp}`;
    case 'hasClass':
      return `${exp} in (driver.find_element(${selPy}).get_attribute('class') or '' if driver.find_elements(${selPy}) else '')`;
    case 'hasAttribute':
      return `bool(driver.find_element(${selPy}).get_attribute(${exp})) if driver.find_elements(${selPy}) else False`;
    default:
      return `True  # unknown condition: ${action.conditionType}`;
  }
}

// Generates Python lines for a single non-condition action
function actionLines(action, stepNum, stepDelay, elTimeout) {
  const lbl    = action.label ? ` — ${action.label}` : '';
  const delay  = msToSec(action.delay != null ? action.delay : stepDelay);
  const tout   = msToSec(elTimeout);
  const sel    = getBestSelInfo(action);
  const selPy  = selToPy(sel);
  const elVar  = `el${stepNum}`;
  const out    = [];

  switch (action.type) {
    case 'click':
      out.push(`# Step ${stepNum}: click${lbl}`);
      out.push(`${elVar} = WebDriverWait(driver, ${tout}).until(EC.element_to_be_clickable((${selPy})))`);
      out.push(`${elVar}.click()`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;

    case 'input': {
      const val = valueToPy(action.value);
      out.push(`# Step ${stepNum}: input${lbl}`);
      out.push(`${elVar} = WebDriverWait(driver, ${tout}).until(EC.presence_of_element_located((${selPy})))`);
      out.push(`if ${elVar}.tag_name == 'select':`);
      out.push(`    try:`);
      out.push(`        Select(${elVar}).select_by_value(${val})`);
      out.push(`    except Exception:`);
      out.push(`        Select(${elVar}).select_by_visible_text(${val})`);
      out.push(`else:`);
      out.push(`    ${elVar}.clear()`);
      out.push(`    ${elVar}.send_keys(${val})`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;
    }

    case 'hover':
      out.push(`# Step ${stepNum}: hover${lbl}`);
      out.push(`${elVar} = WebDriverWait(driver, ${tout}).until(EC.presence_of_element_located((${selPy})))`);
      out.push(`ActionChains(driver).move_to_element(${elVar}).perform()`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;

    case 'dropdown':
      out.push(`# Step ${stepNum}: open dropdown (freeze)${lbl}`);
      out.push(`${elVar} = WebDriverWait(driver, ${tout}).until(EC.element_to_be_clickable((${selPy})))`);
      out.push(`${elVar}.click()`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;

    case 'dragdrop': {
      const tgt   = getBestTargetSelInfo(action);
      const tgtPy = selToPy(tgt);
      out.push(`# Step ${stepNum}: drag & drop${lbl}`);
      out.push(`${elVar}_src = WebDriverWait(driver, ${tout}).until(EC.presence_of_element_located((${selPy})))`);
      out.push(`${elVar}_tgt = WebDriverWait(driver, ${tout}).until(EC.presence_of_element_located((${tgtPy})))`);
      out.push(`ActionChains(driver).drag_and_drop(${elVar}_src, ${elVar}_tgt).perform()`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;
    }

    case 'navigate': {
      const url = valueToPy(action.value || action.url);
      out.push(`# Step ${stepNum}: navigate${lbl}`);
      out.push(`driver.get(${url})`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;
    }

    case 'wait': {
      const ms = msToSec(action.delay != null ? action.delay : (parseInt(action.value) || 1000));
      out.push(`# Step ${stepNum}: wait${lbl}`);
      out.push(`time.sleep(${ms})`);
      break;
    }

    case 'script': {
      const code = (action.code || action.value || '').trim();
      out.push(`# Step ${stepNum}: execute script${lbl}`);
      out.push(`# ⚠ Original JS — verify logic works via execute_script()`);
      if (code.includes('\n')) {
        out.push(`driver.execute_script("""`);
        for (const line of code.split('\n')) out.push(`    ${line}`);
        out.push(`""")`);
      } else {
        out.push(`driver.execute_script(${JSON.stringify(code)})`);
      }
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;
    }

    case 'readdom': {
      const varName = safeVarName(action.varName || 'dom_var');
      out.push(`# Step ${stepNum}: read DOM → "${varName}"${lbl}`);
      out.push(`${elVar} = WebDriverWait(driver, ${tout}).until(EC.presence_of_element_located((${selPy})))`);
      if (action.readFrom === 'value')
        out.push(`${varName} = ${elVar}.get_attribute('value') or ''`);
      else if (action.readFrom === 'attr')
        out.push(`${varName} = ${elVar}.get_attribute(${JSON.stringify(action.attrName || '')}) or ''`);
      else
        out.push(`${varName} = ${elVar}.text.strip()`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;
    }

    case 'screenshot':
      out.push(`# Step ${stepNum}: screenshot (visible)${lbl}`);
      out.push(`driver.save_screenshot(f"screenshot_step${stepNum}.png")`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;

    case 'screenshot_full':
      out.push(`# Step ${stepNum}: screenshot (full page)${lbl}`);
      out.push(`# Note: full-page screenshot requires a compatible driver (e.g. Firefox)`);
      out.push(`driver.save_screenshot(f"screenshot_full_step${stepNum}.png")`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;

    case 'screenshot_element':
      out.push(`# Step ${stepNum}: screenshot element${lbl}`);
      out.push(`${elVar} = WebDriverWait(driver, ${tout}).until(EC.presence_of_element_located((${selPy})))`);
      out.push(`${elVar}.screenshot(f"screenshot_element_step${stepNum}.png")`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;

    case 'screenshot_tovar': {
      const varName = safeVarName(action.varName || 'screenshot');
      out.push(`# Step ${stepNum}: screenshot → variable "${varName}"${lbl}`);
      out.push(`_ss_file${stepNum} = f"screenshot_${varName}_step${stepNum}.png"`);
      if (action.target === 'element' && sel.value) {
        out.push(`${elVar} = WebDriverWait(driver, ${tout}).until(EC.presence_of_element_located((${selPy})))`);
        out.push(`${elVar}.screenshot(_ss_file${stepNum})`);
      } else {
        out.push(`driver.save_screenshot(_ss_file${stepNum})`);
      }
      out.push(`${varName} = _ss_file${stepNum}`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;
    }

    case 'switch':
      out.push(`# Step ${stepNum}: switch [SKIPPED] — requires extension scenario routing`);
      break;

    default:
      out.push(`# Step ${stepNum}: ${action.type}${lbl} — [unsupported, skipped]`);
  }

  return out;
}

// Recursively processes an action array, grouping condition blocks
function processActions(actions, baseIdx, stepDelay, elTimeout) {
  const out = [];
  let i = 0;

  while (i < actions.length) {
    const action  = actions[i];
    const stepNum = baseIdx + i + 1;

    if (action.type === 'condition') {
      const skipCount = Math.max(1, action.skipCount || 1);
      const lbl  = action.label ? ` — ${action.label}` : '';
      const sel  = getBestSelInfo(action);
      const selPy = selToPy(sel);

      out.push(`# Step ${stepNum}: condition — ${action.conditionType}${lbl}`);
      out.push(`if ${condExprPy(action, selPy)}:`);

      const body      = actions.slice(i + 1, i + 1 + skipCount);
      const bodyLines = processActions(body, baseIdx + i + 1, stepDelay, elTimeout);
      if (bodyLines.length === 0 || bodyLines.every(l => l === '')) {
        out.push('    pass');
      } else {
        for (const line of bodyLines) {
          out.push(line === '' ? '' : '    ' + line);
        }
      }
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
 * generateSeleniumPy(scenarioName, actions, variables, opts)
 * Returns { code: string, stats: object }
 */
export function generateSeleniumPy(scenarioName, actions, variables, opts = {}) {
  const { stepDelay = 500, elTimeout = 10000, driverType = 'Chrome', startUrl = '' } = opts;

  const staticVars = {}, randomSpecs = {}, readdomVars = new Set();
  for (const [k, v] of Object.entries(variables || {})) {
    const spec = parseRandomSpec(v);
    if (spec) randomSpecs[k] = spec;
    else staticVars[k] = v;
  }

  const enabled = (actions || []).filter(a => !a.disabled);

  for (const a of enabled) {
    if (a.type === 'readdom' && a.varName) {
      readdomVars.add(safeVarName(a.varName));
    }
  }

  let skipped = 0, supported = 0, hasScript = false, hasScreenshot = false;
  for (const a of enabled) {
    if (a.type === 'switch') skipped++;
    else supported++;
    if (a.type === 'script') hasScript = true;
    if (['screenshot', 'screenshot_full', 'screenshot_element', 'screenshot_tovar'].includes(a.type)) hasScreenshot = true;
  }

  const needsRandom       = Object.keys(randomSpecs).length > 0;
  const needsActionChains = enabled.some(a => ['hover', 'dragdrop'].includes(a.type));
  const needsCondition    = enabled.some(a => a.type === 'condition');

  const out = [];

  // ── Imports ──
  out.push('import time');
  if (needsRandom) { out.push('import random'); out.push('import string'); }
  out.push('from selenium import webdriver');
  out.push('from selenium.webdriver.common.by import By');
  out.push('from selenium.webdriver.support.ui import WebDriverWait, Select');
  out.push('from selenium.webdriver.support import expected_conditions as EC');
  if (needsActionChains) out.push('from selenium.webdriver.common.action_chains import ActionChains');
  if (needsCondition)    out.push('from selenium.common.exceptions import NoSuchElementException');
  out.push('');
  out.push('');

  // ── Header ──
  out.push(`# ============================`);
  out.push(`# SCENARIO: ${scenarioName}`);
  out.push(`# ============================`);
  out.push('');
  out.push(`driver = webdriver.${driverType}()`);
  out.push(`driver.implicitly_wait(${msToSec(elTimeout)})`);
  out.push('');

  // If no navigate action exists as the first real step, emit a driver.get() line.
  // Use the user-supplied startUrl if provided, otherwise a TODO placeholder.
  const firstAction = enabled.find(a => a.type !== 'wait');
  if (!firstAction || firstAction.type !== 'navigate') {
    if (startUrl) {
      out.push(`driver.get(${JSON.stringify(startUrl)})`);
    } else {
      out.push('# ⚠ TODO: Set the starting URL (go to Settings tab to configure)');
      out.push('driver.get("https://your-url-here.com")');
    }
    out.push('');
  }

  // ── Variables ──
  const hasVars = Object.keys(staticVars).length > 0 || needsRandom || readdomVars.size > 0;
  if (hasVars) {
    out.push('# --- VARIABLES ---');
    for (const [k, v] of Object.entries(staticVars)) {
      out.push(`${k} = ${JSON.stringify(v)}`);
    }
    for (const [k, spec] of Object.entries(randomSpecs)) {
      const charset = spec.type === 'alpha'
        ? 'string.ascii_letters'
        : spec.type === 'numeric'
          ? 'string.digits'
          : 'string.ascii_letters + string.digits';
      out.push(`${k} = ''.join(random.choices(${charset}, k=${spec.length}))`);
    }
    for (const k of readdomVars) {
      out.push(`${k} = ''`);
    }
    out.push('');
  }

  // ── Main flow ──
  out.push('# --- MAIN FLOW ---');
  out.push('try:');
  out.push('');

  const bodyLines = processActions(enabled, 0, stepDelay, elTimeout);
  for (const line of bodyLines) {
    out.push(line === '' ? '' : '    ' + line);
  }

  out.push(`    print("✅ Scenario '${scenarioName}' completed successfully.")`);
  out.push('');
  out.push('except Exception as e:');
  out.push('    print(f"❌ Error: {e}")');
  out.push('    raise');
  out.push('');
  out.push('finally:');
  out.push('    driver.quit()');

  return {
    code: out.join('\n'),
    stats: { total: enabled.length, supported, skipped, hasScript, hasScreenshot },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// UI MODULE
// ─────────────────────────────────────────────────────────────────────────────

let _currentCode         = '';
let _currentScenarioName = '';
let _currentActions      = [];
let _currentVariables    = {};
let _releaseFocus        = null;

export function initExportSelenium() {
  const triggerBtn = document.getElementById('exportSelenium');
  if (!triggerBtn) return;

  triggerBtn.addEventListener('click', _onTrigger);
  document.getElementById('exportSeleniumClose')?.addEventListener('click', _close);
  document.getElementById('exportSeleniumCancel')?.addEventListener('click', _close);
  document.getElementById('exportSeleniumCopy')?.addEventListener('click', _copy);
  document.getElementById('exportSeleniumDownload')?.addEventListener('click', _download);
  document.getElementById('exportSeleniumRegenerate')?.addEventListener('click', _regenerate);
  document.getElementById('exportSeleniumGetUrl')?.addEventListener('click', _fillCurrentUrl);

  document.querySelectorAll('.export-py-tab').forEach(btn => {
    btn.addEventListener('click', () => _switchTab(btn.dataset.tab));
  });

  const modal = document.getElementById('exportSeleniumModal');
  modal?.addEventListener('click', e => { if (e.target === modal) _close(); });
  modal?.addEventListener('keydown', e => { if (e.key === 'Escape') _close(); });
}

function _onTrigger() {
  const sel        = document.getElementById('exportCodeSelect');
  const scenarioId = sel?.value;
  if (!scenarioId) { showToast('Chọn một scenario trước', 'error'); return; }

  _currentScenarioName = sel.options[sel.selectedIndex]?.text || 'Scenario';

  chrome.runtime.sendMessage({ type: 'GET_SCENARIOS' }, res => {
    const scenario   = (res?.scenarios || {})[scenarioId];
    _currentActions  = scenario?.actions || [];
    chrome.runtime.sendMessage({ type: 'GET_VARIABLES' }, varRes => {
      _currentVariables = varRes?.variables || {};
      _openModal(_currentScenarioName, _currentActions, _currentVariables);
    });
  });
}

function _getOpts() {
  return {
    stepDelay:  parseInt(document.getElementById('exportSeleniumStepDelay')?.value) || 500,
    elTimeout:  parseInt(document.getElementById('exportSeleniumElTimeout')?.value)  || 10000,
    driverType: document.getElementById('exportSeleniumDriver')?.value || 'Chrome',
    startUrl:   document.getElementById('exportSeleniumStartUrl')?.value.trim() || '',
  };
}

function _openModal(scenarioName, actions, variables) {
  const modal = document.getElementById('exportSeleniumModal');
  if (!modal) return;

  const result  = generateSeleniumPy(scenarioName, actions, variables, _getOpts());
  _currentCode  = result.code;

  _renderModal(scenarioName, result, variables);
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  lockScroll();
  _switchTab('preview');
  _releaseFocus = trapFocus(modal);
}

function _renderModal(scenarioName, result, variables) {
  document.getElementById('exportSeleniumTitle').textContent = `Export Python — ${scenarioName}`;

  const codeEl = document.querySelector('#exportSeleniumCode code');
  if (codeEl) codeEl.textContent = result.code;

  // Warning bar
  const warning = document.getElementById('exportSeleniumWarning');
  const skipMsg  = document.getElementById('exportSeleniumSkipMsg');
  const msgs = [];
  if (result.stats.skipped > 0)  msgs.push(`${result.stats.skipped} action bị bỏ qua (switch)`);
  if (result.stats.hasScript)    msgs.push('script → driver.execute_script() — hãy kiểm tra lại');
  if (msgs.length > 0) {
    skipMsg.textContent  = msgs.join(' · ');
    warning.style.display = '';
  } else {
    warning.style.display = 'none';
  }

  // Variables tab
  const vars    = Object.entries(variables || {});
  document.getElementById('exportSeleniumVarCount').textContent = vars.length;

  const noVarsEl = document.getElementById('exportSeleniumNoVars');
  const tableEl  = document.getElementById('exportSeleniumVarTable');
  const tbody    = document.getElementById('exportSeleniumVarBody');

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
  const { total, supported, skipped } = result.stats;
  const statsEl = document.getElementById('exportSeleniumStats');
  if (statsEl) {
    let txt = `${supported}/${total} steps`;
    if (skipped > 0) txt += ` · ${skipped} skipped`;
    statsEl.textContent = txt;
  }
}

function _close() {
  const modal = document.getElementById('exportSeleniumModal');
  modal?.classList.remove('show');
  modal?.setAttribute('aria-hidden', 'true');
  if (_releaseFocus) { _releaseFocus(); _releaseFocus = null; }
  unlockScroll();
}

function _switchTab(tab) {
  document.querySelectorAll('.export-py-tab').forEach(btn => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  document.getElementById('exportSeleniumTabPreview').hidden   = tab !== 'preview';
  document.getElementById('exportSeleniumTabVariables').hidden = tab !== 'variables';
  document.getElementById('exportSeleniumTabSettings').hidden  = tab !== 'settings';
}

async function _copy() {
  if (!_currentCode) return;
  try {
    await navigator.clipboard.writeText(_currentCode);
    const btn = document.getElementById('exportSeleniumCopy');
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
  const blob  = new Blob([_currentCode], { type: 'text/x-python' });
  const url   = URL.createObjectURL(blob);
  const a     = Object.assign(document.createElement('a'), { href: url, download: `${safe}_selenium.py` });
  a.click();
  URL.revokeObjectURL(url);
}

function _regenerate() {
  const result = generateSeleniumPy(_currentScenarioName, _currentActions, _currentVariables, _getOpts());
  _currentCode = result.code;
  _renderModal(_currentScenarioName, result, _currentVariables);
  _switchTab('preview');
  showToast('Code đã được tạo lại');
}

function _fillCurrentUrl() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const url = tabs?.[0]?.url || '';
    if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
      showToast('Không lấy được URL từ tab này', 'error');
      return;
    }
    const input = document.getElementById('exportSeleniumStartUrl');
    if (input) {
      input.value = url;
      input.dispatchEvent(new Event('input'));
    }
  });
}
