import { showToast, lockScroll, unlockScroll, trapFocus, escHtml, getUsedVarNames } from './utils.js';

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

function previewRandom(type, length) {
  if (type === 'datetime') {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  }
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

// Picks the best available selector and returns { type, value }.
// ID is the most stable selector — prioritised over generic CSS.
function getBestSelInfo(action) {
  const s = action.selectors || {};
  if (s.id)        return { type: 'id',        value: s.id };
  if (s.name)      return { type: 'name',      value: s.name };
  if (s.css)       return { type: 'css',       value: s.css };
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

// Converts a value that may contain ${varName} to a Python string/f-string.
// Sanitizes variable names to valid Python identifiers (${var-name} → {var_name}).
//
// Escaping order matters and the braces are the subtle part: in an f-string a
// literal { or } has to be doubled, so a value like `{"id":1} for ${host}` used
// to emit `f"{\"id\":1} for {host}"` — Python reads `{\"id\":1}` as a replacement
// field and raises SyntaxError (a backslash inside one is illegal before 3.12).
// Braces are doubled first, then the placeholders are written in, so the names we
// insert are never themselves doubled.
function valueToPy(val) {
  if (val == null) return '""';
  const s = String(val);
  const escapeText = (t) => t
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');

  if (/\$\{/.test(s)) {
    const inner = s
      .split(/(\$\{[^}]+\})/g)
      .map(part => {
        const m = part.match(/^\$\{([^}]+)\}$/);
        // A placeholder becomes a replacement field; everything else is literal
        // text and gets its braces doubled so Python keeps them as characters.
        return m ? `{${safeVarName(m[1])}}` : escapeText(part).replace(/([{}])/g, '$1$1');
      })
      .join('');
    return `f"${inner}"`;
  }
  return JSON.stringify(s);
}

// Names the generated script binds for itself, plus the Python keywords. A
// variable called `driver` or `class` would otherwise overwrite the WebDriver or
// fail to parse, so those get a `_v` suffix.
const _RESERVED_PY = new Set([
  'driver', 'time', 'random', 'string', 'datetime', 'By', 'EC', 'WebDriverWait',
  'Select', 'ActionChains', 'NoSuchElementException', 'webdriver', 'e', 'print',
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import',
  'in', 'is', 'lambda', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
  'True', 'try', 'while', 'with', 'yield',
]);

// Python identifiers cannot start with a digit — a variable named `2fa` used to
// emit `2fa = "999"`, a SyntaxError that takes the whole script down.
function safeVarName(name) {
  const safe = String(name == null ? 'var' : name)
    .replace(/^\$\{|\}$/g, '')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^\d/, '_') || 'var';
  return _RESERVED_PY.has(safe) ? safe + '_v' : safe;
}

// True when a `script` action's source references a variable, which decides
// whether the generated file needs the _js() escaping helper.
function scriptUsesVars(action) {
  return /\$\{[^}]+\}/.test(String(action.code || action.value || ''));
}

/**
 * Emits the driver.execute_script(...) call for a `script` action.
 *
 * The source used to be passed through verbatim, so a `${q}` sitting inside a JS
 * string literal stayed literal text and never picked up the value — playback
 * substitutes it via _applyVarsToCode() in bg/utils.js. Emitting an f-string lets
 * Python do the same substitution at run time, which works for random and readdom
 * values too, and _js() applies the same escaping so a quote in a value cannot
 * terminate the surrounding JS literal.
 *
 * Literal braces are doubled — JS code is mostly braces, so without that every
 * block would read as an f-string replacement field.
 */
function _scriptToPy(rawCode) {
  const code    = String(rawCode);
  const hasVars = /\$\{[^}]+\}/.test(code);

  // Escape for a triple-quoted Python literal: backslashes first, then any run
  // that could close the literal early.
  let body = code.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
  if (hasVars) {
    body = body
      .split(/(\$\{[^}]+\})/g)
      .map(part => {
        const m = part.match(/^\$\{([^}]+)\}$/);
        return m ? `{_js(${safeVarName(m[1])})}` : part.replace(/([{}])/g, '$1$1');
      })
      .join('');
  }

  const prefix = hasVars ? 'f' : '';
  if (!body.includes('\n')) return [`driver.execute_script(${prefix}"""${body}""")`];

  // The closing delimiter goes on its own line so a source ending in `"` cannot
  // run into it.
  return [`driver.execute_script(${prefix}"""`, ...body.split('\n'), `""")`];
}

// The _js() runtime helper — same escaping as _applyVarsToCode() in bg/utils.js.
function _jsEscapeHelperPy() {
  return [
    'def _js(v):',
    '    """Escape a value for inlining into JS source (mirrors the extension\'s playback)."""',
    '    return (str(v).replace("\\\\", "\\\\\\\\").replace(\'"\', \'\\\\"\').replace("\'", "\\\\\'")',
    '            .replace("`", "\\\\`").replace("${", "\\\\${")',
    '            .replace("\\n", "\\\\n").replace("\\r", "\\\\r"))',
  ];
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
    case 'hasAttribute': {
      // If expectedValue is "attr=value", split on the first '=' and generate
      // a proper attribute-value comparison (get_attribute("attr=value") always returns None).
      const rawExp = String(action.expectedValue || '');
      const eqIdx  = rawExp.indexOf('=');
      if (eqIdx > 0) {
        // Both halves go through valueToPy: JSON.stringify used to freeze a
        // `data-id=${host}` into the literal string "${host}".
        const attrNamePy = valueToPy(rawExp.slice(0, eqIdx));
        const attrValPy  = valueToPy(rawExp.slice(eqIdx + 1));
        return `(driver.find_element(${selPy}).get_attribute(${attrNamePy}) == ${attrValPy}) if driver.find_elements(${selPy}) else False`;
      }
      // No '=' — check that the attribute exists (non-null, non-empty)
      return `bool(driver.find_element(${selPy}).get_attribute(${exp})) if driver.find_elements(${selPy}) else False`;
    }
    default:
      return `True  # unknown condition: ${action.conditionType}`;
  }
}

const COND_FIELDS = ['valueEquals', 'textContains', 'idContains', 'classContains', 'typeEquals'];

/**
 * The _find_child() runtime helper, mirroring _findChild in the JS bookmarklet
 * export and findElementByCondition in content.js.
 *
 * Each `lambda el, n=...` binds its needle as a default argument on purpose:
 * Python closures capture the variable, not the value, so a plain `lambda el: n
 * in ...` would make every check see the last needle assigned.
 */
function _findChildHelperPy() {
  return [
    '_FALLBACK_RE = re.compile(r"^\\{fallback:(.+)\\}$")',
    '',
    '',
    'def _find_child(parent, cond, mode="any"):',
    '    """First descendant of `parent` matching `cond`.',
    '',
    '    A field may hold a {fallback:A|B|C} spec — Fallback variables only expand',
    '    into one at run time — and each candidate is then tried in order.',
    '    """',
    '    fb_field, fb_values = None, None',
    '    for _f in ("valueEquals", "textContains", "idContains", "classContains", "typeEquals"):',
    '        _m = _FALLBACK_RE.match(str(cond.get(_f, "")))',
    '        if _m:',
    '            fb_field = _f',
    '            fb_values = [v.strip() for v in _m.group(1).split("|") if v.strip()]',
    '            break',
    '',
    '    def norm(s):',
    '        return "" if s is None else str(s).strip().lower()',
    '',
    '    def try_find(c):',
    '        checks = []',
    '        if c.get("valueEquals"):',
    '            checks.append(lambda el, v=str(c["valueEquals"]): (el.get_attribute("value") or "") == v)',
    '        if c.get("textContains"):',
    '            checks.append(lambda el, n=norm(c["textContains"]): n in norm(el.text))',
    '        if c.get("idContains"):',
    '            checks.append(lambda el, n=norm(c["idContains"]): n in norm(el.get_attribute("id")))',
    '        if c.get("classContains"):',
    '            checks.append(lambda el, n=norm(c["classContains"]): n in norm(el.get_attribute("class")))',
    '        if c.get("typeEquals"):',
    '            checks.append(lambda el, v=str(c["typeEquals"]): (el.get_attribute("type") or "") == v)',
    '        if not checks:',
    '            return None',
    '        test = all if mode == "all" else any',
    '        for el in parent.find_elements(By.XPATH, ".//*"):',
    '            if test(fn(el) for fn in checks):',
    '                return el',
    '        return None',
    '',
    '    if fb_field and fb_values:',
    '        for fv in fb_values:',
    '            el = try_find({**cond, fb_field: fv})',
    '            if el is not None:',
    '                return el',
    '        return None',
    '    return try_find(cond)',
  ];
}

/**
 * Builds Python lines to locate a child element matching action.conditions.
 *
 * The criteria are handed to the generated _find_child() helper as a dict rather
 * than being unrolled into loops here. That is what makes Fallback variables work:
 * a `{fallback:A|B|C}` spec reaching a field through `${city}` only exists once
 * the f-string has been evaluated, so deciding at export time — as the old
 * unrolled version did — compared against the literal spec text and never matched.
 * The JS bookmarklet's _findChild has always resolved this at run time.
 */
function _buildChildCondPy(conditions, elVar, tout, selPy, stepNum) {
  const cond  = conditions;
  const mode  = cond.matchMode || 'any';
  const lines = [];

  const parts = [];
  for (const f of COND_FIELDS) {
    if (cond[f] != null && String(cond[f]) !== '') {
      parts.push(`"${f}": ${valueToPy(String(cond[f]))}`);
    }
  }

  lines.push(`${elVar}_p = WebDriverWait(driver, ${tout}).until(EC.presence_of_element_located((${selPy})))`);
  lines.push(`${elVar} = _find_child(${elVar}_p, {${parts.join(', ')}}, ${JSON.stringify(mode)})`);
  lines.push(`if ${elVar} is None:`);
  lines.push(`    raise Exception("Child condition not matched (step ${stepNum})")`);
  return lines;
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
      if (action.conditions) {
        out.push(..._buildChildCondPy(action.conditions, elVar, tout, selPy, stepNum));
      } else {
        out.push(`${elVar} = WebDriverWait(driver, ${tout}).until(EC.element_to_be_clickable((${selPy})))`);
      }
      out.push(`${elVar}.click()`);
      if (delay > 0) out.push(`time.sleep(${delay})`);
      break;

    case 'input': {
      const val = valueToPy(action.value);
      out.push(`# Step ${stepNum}: input${lbl}`);
      if (action.conditions) {
        out.push(..._buildChildCondPy(action.conditions, elVar, tout, selPy, stepNum));
      } else {
        out.push(`${elVar} = WebDriverWait(driver, ${tout}).until(EC.presence_of_element_located((${selPy})))`);
      }
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
      if (action.conditions) {
        out.push(..._buildChildCondPy(action.conditions, elVar, tout, selPy, stepNum));
      } else {
        out.push(`${elVar} = WebDriverWait(driver, ${tout}).until(EC.presence_of_element_located((${selPy})))`);
      }
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
      out.push(..._scriptToPy(code));
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
// Disabled actions are skipped inline so skipCount stays aligned with the original array.
function processActions(actions, baseIdx, stepDelay, elTimeout) {
  const out = [];
  let i = 0;

  while (i < actions.length) {
    const action  = actions[i];

    if (action.disabled) {
      i++;
      continue;
    }

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
 * Generate a complete Selenium Python script for the given scenario.
 *
 * @param {string}   scenarioName      - Human-readable name used in comments/print.
 * @param {object[]} actions           - Scenario action array; disabled actions are skipped.
 * @param {object}   variables         - Key/value pairs; random specs expand at run time.
 * @param {object}   opts
 * @param {number}   opts.stepDelay    - Default inter-step `time.sleep()` in ms (default 500).
 * @param {number}   opts.elTimeout    - `WebDriverWait` timeout in ms (default 10000).
 * @param {string}   opts.driverType   - Selenium driver class name, e.g. "Chrome" (default).
 * @param {string}   opts.startUrl     - Initial `driver.get()` URL when first action is not navigate.
 * @returns {{ code: string, stats: { total, supported, skipped, hasScript, hasScreenshot } }}
 */
export function generateSeleniumPy(scenarioName, actions, variables, opts = {}) {
  const { stepDelay = 500, elTimeout = 10000, driverType = 'Chrome', startUrl = '' } = opts;

  const warnings = new Set();
  const staticVars = {}, randomSpecs = {}, pickSpecs = {}, writtenVars = new Set();
  for (const [k, v] of Object.entries(variables || {})) {
    const str  = _activeVal(v);
    const spec = parseRandomSpec(str);
    const pick = parsePickSpec(str);
    if (spec)      randomSpecs[k] = spec;
    else if (pick) pickSpecs[k]   = pick;
    else           staticVars[k]  = str;
  }

  const enabled = (actions || []).filter(a => !a.disabled);

  // Names a step assigns to. screenshot_tovar belongs here too: it writes inside
  // the flow, so a run where its branch never executes leaves a later reference
  // with nothing bound (NameError).
  for (const a of enabled) {
    if ((a.type === 'readdom' || a.type === 'screenshot_tovar') && a.varName) {
      writtenVars.add(safeVarName(a.varName));
    }
  }

  // Two different names can sanitize to the same Python identifier, which
  // silently drops one of them.
  const _byIdent = new Map();
  for (const k of [...Object.keys(staticVars), ...Object.keys(randomSpecs), ...Object.keys(pickSpecs)]) {
    const ident = safeVarName(k);
    if (_byIdent.has(ident) && _byIdent.get(ident) !== k) {
      warnings.add(`"${_byIdent.get(ident)}" and "${k}" both become the Python identifier \`${ident}\` — rename one`);
    } else {
      _byIdent.set(ident, k);
    }
    if (ident !== k) {
      warnings.add(`"${k}" is not a valid Python identifier — exported as \`${ident}\``);
    }
  }

  let skipped = 0, supported = 0, hasScript = false, hasScreenshot = false;
  for (const a of enabled) {
    if (a.type === 'switch') skipped++;
    else supported++;
    if (a.type === 'script') hasScript = true;
    if (['screenshot', 'screenshot_full', 'screenshot_element', 'screenshot_tovar'].includes(a.type)) hasScreenshot = true;
  }

  const needsRandom       = Object.keys(randomSpecs).length > 0 || Object.keys(pickSpecs).length > 0;
  const needsDatetime     = Object.values(randomSpecs).some(s => s.type === 'datetime');
  const needsActionChains = enabled.some(a => ['hover', 'dragdrop'].includes(a.type));
  const needsCondition    = enabled.some(a => a.type === 'condition');
  const needsChildCond    = enabled.some(a => a.conditions && typeof a.conditions === 'object');
  const needsJsEscape     = enabled.some(a => a.type === 'script' && scriptUsesVars(a));

  const out = [];

  // ── Imports ──
  out.push('import time');
  if (needsRandom)   { out.push('import random'); out.push('import string'); }
  if (needsChildCond) out.push('import re');
  if (needsDatetime)  out.push('from datetime import datetime');
  out.push('from selenium import webdriver');
  out.push('from selenium.webdriver.common.by import By');
  out.push('from selenium.webdriver.support.ui import WebDriverWait, Select');
  out.push('from selenium.webdriver.support import expected_conditions as EC');
  if (needsActionChains) out.push('from selenium.webdriver.common.action_chains import ActionChains');
  if (needsCondition)    out.push('from selenium.common.exceptions import NoSuchElementException');
  out.push('');
  out.push('');

  // ── Runtime helpers ──
  if (needsChildCond) {
    out.push(..._findChildHelperPy());
    out.push('');
    out.push('');
  }
  if (needsJsEscape) {
    out.push(..._jsEscapeHelperPy());
    out.push('');
    out.push('');
  }

  // ── Header ──
  out.push(`# ============================`);
  out.push(`# SCENARIO: ${scenarioName}`);
  out.push(`# ============================`);
  out.push('');
  out.push(`driver = webdriver.${driverType}()`);
  // implicitly_wait is intentionally omitted — it conflicts with WebDriverWait/EC.
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
  const hasVars = Object.keys(staticVars).length > 0 || needsRandom || writtenVars.size > 0;
  if (hasVars) {
    out.push('# --- VARIABLES ---');
    const declared = new Set();

    for (const [k, v] of Object.entries(staticVars)) {
      const safe = safeVarName(k);
      if (declared.has(safe)) continue;
      declared.add(safe);
      out.push(`${safe} = ${JSON.stringify(v)}`);
    }
    for (const [k, spec] of Object.entries(randomSpecs)) {
      const safe = safeVarName(k);
      if (declared.has(safe)) continue;
      declared.add(safe);
      // "datetime" is a type the Variables modal offers and resolveRandomVars()
      // in bg/utils.js implements; it used to fall through to the alphanumeric
      // charset here and produce random junk instead of the run's timestamp.
      if (spec.type === 'datetime') {
        out.push(`${safe} = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")`);
        continue;
      }
      const charset = spec.type === 'alpha'
        ? 'string.ascii_letters'
        : spec.type === 'numeric'
          ? 'string.digits'
          : 'string.ascii_letters + string.digits';
      out.push(`${safe} = ''.join(random.choices(${charset}, k=${spec.length}))`);
    }
    for (const [k, vals] of Object.entries(pickSpecs)) {
      const safe = safeVarName(k);
      if (declared.has(safe)) continue;
      declared.add(safe);
      const pyList = '[' + vals.map(v => JSON.stringify(v)).join(', ') + ']';
      out.push(`${safe} = random.choice(${pyList})`);
    }
    // Only the written names nothing above already seeded. This loop used to run
    // unconditionally, so `seed = "INIT"` from the Variables tab was immediately
    // followed by `seed = ''` and the seed never reached the first step.
    for (const k of writtenVars) {
      if (declared.has(k)) continue;
      declared.add(k);
      out.push(`${k} = ''`);
    }
    out.push('');
  }

  // ── Main flow ──
  out.push('# --- MAIN FLOW ---');
  out.push('try:');
  out.push('');

  const bodyLines = processActions(actions || [], 0, stepDelay, elTimeout);
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

  // A `${name}` with nothing behind it becomes a NameError the moment the step
  // runs, and the generated file gives no clue where it came from — flag it while
  // the scenario is still on screen.
  const knownNames = new Set([
    ...Object.keys(staticVars), ...Object.keys(randomSpecs), ...Object.keys(pickSpecs),
  ]);
  for (const a of enabled) {
    if ((a.type === 'readdom' || a.type === 'screenshot_tovar') && a.varName) {
      knownNames.add(String(a.varName).replace(/^\$\{|\}$/g, ''));
    }
  }
  for (const name of getUsedVarNames(enabled)) {
    if (!knownNames.has(name)) {
      warnings.add(`\${${name}} is used by a step but not defined in the Variables tab`);
    }
  }

  return {
    code: out.join('\n'),
    stats: { total: enabled.length, supported, skipped, hasScript, hasScreenshot },
    warnings: [...warnings],
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

/** Wire the export-Selenium modal trigger and all modal-internal buttons. */
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

  document.getElementById('exportSeleniumWrapBtn')?.addEventListener('click', () => {
    const code = document.getElementById('exportSeleniumCode');
    if (code) code.style.whiteSpace = code.style.whiteSpace === 'pre-wrap' ? 'pre' : 'pre-wrap';
  });

  document.getElementById('exportSeleniumSelectAllBtn')?.addEventListener('click', () => {
    const code = document.querySelector('#exportSeleniumCode code');
    if (!code) return;
    const range = document.createRange();
    range.selectNodeContents(code);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });

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
  if (!scenarioId) { showToast('Please select a scenario first', 'error'); return; }

  _currentScenarioName = sel.options[sel.selectedIndex]?.text || 'Scenario';

  chrome.runtime.sendMessage({ type: 'GET_SCENARIOS' }, res => {
    const scenario  = (res?.scenarios || {})[scenarioId];
    _currentActions = scenario?.actions || [];
    chrome.runtime.sendMessage({ type: 'GET_VARIABLES' }, varRes => {
      const allVariables = varRes?.variables || {};
      const usedNames = getUsedVarNames(_currentActions);
      _currentVariables = Object.fromEntries(
        Object.entries(allVariables).filter(([k]) => usedNames.has(k))
      );
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

  // Auto-fill Starting URL from current tab (if input is still empty)
  const urlInput = document.getElementById('exportSeleniumStartUrl');
  if (urlInput && !urlInput.value.trim()) {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const url = tabs?.[0]?.url || '';
      if (url && !url.startsWith('chrome://') && !url.startsWith('chrome-extension://')) {
        urlInput.value = url;
        urlInput.dispatchEvent(new Event('input'));
        const badge = document.getElementById('exportSeleniumUrlFromTab');
        if (badge) badge.style.display = '';
      }
    });
  }

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
  const safe = scenarioName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const filename = `${safe}_selenium.py`;

  // Header
  document.getElementById('exportSeleniumTitle').textContent = `Export Python — ${scenarioName}`;
  document.getElementById('exportSeleniumSub').textContent = `${filename} · ${result.stats.supported} steps`;
  document.getElementById('exportSeleniumCodeLabel').textContent = filename;

  // Code preview
  const codeEl = document.querySelector('#exportSeleniumCode code');
  if (codeEl) codeEl.textContent = result.code;

  // Warning bar
  const warning = document.getElementById('exportSeleniumWarning');
  const skipMsg  = document.getElementById('exportSeleniumSkipMsg');
  const msgs = [];
  if (result.stats.skipped > 0)  msgs.push(`${result.stats.skipped} action(s) skipped (switch)`);
  if (result.stats.hasScript)    msgs.push('script → driver.execute_script() — please review');
  // Anything the generator could not express faithfully (renamed identifiers,
  // unresolved ${...}). These used to surface only when the script was run.
  msgs.push(...(result.warnings || []));
  if (msgs.length > 0) {
    skipMsg.style.whiteSpace = 'pre-line';
    skipMsg.textContent  = msgs.join('\n');
    warning.style.display = '';
  } else {
    warning.style.display = 'none';
  }

  // Variables — row layout
  const vars = Object.entries(variables || {});
  document.getElementById('exportSeleniumVarCount').textContent = vars.length;

  const noVarsEl = document.getElementById('exportSeleniumNoVars');
  const listEl   = document.getElementById('exportSeleniumVarList');

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
      // Fallback specs match neither parser and used to be listed as "Static"
      // showing the raw {fallback:...} text, which reads like a broken value.
      const fbMatch = val.match(/^\{fallback:(.+)\}$/);
      let icon, badgeLabel, badgeCls, preview;
      if (isRand) {
        icon = '🎲'; badgeLabel = 'Random'; badgeCls = 'rand';
        preview = previewRandom(spec.type, spec.length);
      } else if (isPick) {
        icon = '⚄'; badgeLabel = `Pick (${pick.length})`; badgeCls = 'rand';
        preview = pick.join(' | ');
        if (preview.length > 40) preview = preview.slice(0, 40) + '…';
      } else if (fbMatch) {
        const fbVals = fbMatch[1].split('|').map(s => s.trim()).filter(Boolean);
        icon = '⛓'; badgeLabel = `Fallback (${fbVals.length})`; badgeCls = 'rand';
        preview = fbVals.join(' → ');
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
  document.getElementById('exportSeleniumStatSteps').textContent = `${supported} steps`;
  document.getElementById('exportSeleniumStatVars').textContent  = `${vars.length} variables`;

  const warnPill    = document.getElementById('exportSeleniumStatWarnPill');
  const skippedPill = document.getElementById('exportSeleniumStatSkippedPill');
  if (actStats.warnCount > 0) {
    document.getElementById('exportSeleniumStatWarn').textContent = `${actStats.warnCount} verify`;
    warnPill.style.display = '';
  } else {
    warnPill.style.display = 'none';
  }
  if (skipped > 0) {
    document.getElementById('exportSeleniumStatSkipped').textContent = `${skipped} skipped`;
    skippedPill.style.display = '';
  } else {
    skippedPill.style.display = 'none';
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
  document.getElementById('exportSeleniumTabActions').hidden   = tab !== 'actions';
  document.getElementById('exportSeleniumTabSettings').hidden  = tab !== 'settings';
}

async function _copy() {
  if (!_currentCode) return;
  try {
    await navigator.clipboard.writeText(_currentCode);
    const btn = document.getElementById('exportSeleniumCopy');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = 'Copied';
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
  showToast('Code regenerated');
}

function _fillCurrentUrl() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const url = tabs?.[0]?.url || '';
    if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
      showToast('Could not get URL from this tab', 'error');
      return;
    }
    const input = document.getElementById('exportSeleniumStartUrl');
    if (input) {
      input.value = url;
      input.dispatchEvent(new Event('input'));
      const badge = document.getElementById('exportSeleniumUrlFromTab');
      if (badge) badge.style.display = '';
    }
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
  const listEl    = document.getElementById('exportSeleniumActList');
  const summaryEl = document.getElementById('exportSeleniumActSummary');
  if (!listEl || !summaryEl) return { okCount: 0, warnCount: 0, skipCount: 0 };

  let okCount = 0, skipCount = 0, warnCount = 0;
  let html = '';

  // Selenium: only 'switch' is skipped; 'script' needs manual verification
  const enabled = (actions || []).filter(a => !a.disabled);
  enabled.forEach((a, i) => {
    // The fallback label is a.type straight out of an imported .json, so both it
    // and the class name are escaped at the interpolation site below.
    const info = _ACT_TYPE_INFO[a.type] || { icon: '●', label: String(a.type ?? 'unknown'), cls: 'wait' };
    const desc = _actionDesc(a);
    let status, statusLabel, rowCls;
    if (a.type === 'switch') {
      status = 'skip'; statusLabel = '— Skip'; rowCls = 'row-skip'; skipCount++;
    } else if (a.type === 'script') {
      status = 'warn'; statusLabel = '⚠ Verify'; rowCls = 'row-warn'; warnCount++;
    } else {
      status = 'ok'; statusLabel = '✓ OK'; rowCls = ''; okCount++;
    }
    html += `<div class="export-bm-action-row ${rowCls}">
      <span class="export-bm-action-step">${i + 1}</span>
      <span class="export-bm-action-type abt-${escHtml(info.cls)}">${info.icon} ${escHtml(info.label)}</span>
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

  const badge = document.getElementById('exportSeleniumActCount');
  if (badge) {
    const warnTotal = skipCount + warnCount;
    badge.textContent = warnTotal > 0 ? `${warnTotal} ⚠` : String(enabled.length);
    badge.className   = 'export-bm-tab-count' + (warnTotal > 0 ? ' warn' : '');
  }

  return { okCount, warnCount, skipCount };
}
