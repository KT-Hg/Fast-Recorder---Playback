/**
 * variables.js — Variables list management (Pure Action Row Mirror design).
 *
 * Each variable is an <li class="var-row t-{s|r|p|f}"> that mirrors the action
 * list style: fixed-width type column with equal-size icon badge (S/R/P/F),
 * key → value display, Edit/Delete buttons.
 *
 * Extended config model — each variable stores a full config object so that
 * switching between types never discards previously entered data:
 *   { activeType: 's'|'r'|'p'|'f', s: string, r: {type,length}, p: string[], f: string[] }
 *
 * Old plain-string values in storage are migrated automatically on load.
 *
 * Exports: addVariableRow, loadVariables, getVariablesFromTable, findEmptyRow, initVariables
 */

import { showToast, showConfirm, lockScroll, unlockScroll } from './utils.js';

/* ── Parsers ─────────────────────────────────────────────────────────────── */

const PICK_RE     = /^\{pick:(.+)\}$/;
const RANDOM_RE   = /^\{random:(\w+):(\d+)\}$/;
const FALLBACK_RE = /^\{fallback:(.+)\}$/;

function _parsePick(val) {
  const m = typeof val === 'string' && val.match(PICK_RE);
  return m ? m[1].split('|').map(s => s.trim()).filter(Boolean) : null;
}

function _parseRandom(val) {
  const m = typeof val === 'string' && val.match(RANDOM_RE);
  return m ? { type: m[1], length: m[2] } : null;
}

function _parseFallback(val) {
  const m = typeof val === 'string' && val.match(FALLBACK_RE);
  return m ? m[1].split('|').map(s => s.trim()).filter(Boolean) : null;
}

/* ── Config model ────────────────────────────────────────────────────────── */

function _defaultConfig() {
  return { activeType: 's', s: '', r: { type: 'alphanumeric', length: '8' }, p: ['', ''], f: ['', ''] };
}

/**
 * Converts old plain-string value to new config object. Idempotent for new format.
 * Ensures all fields are present even if the stored object is partially populated.
 */
export function _migrateToConfig(val) {
  if (val && typeof val === 'object' && 'activeType' in val) {
    const def = _defaultConfig();
    return {
      ...def,
      ...val,
      r: { ...def.r, ...(val.r || {}) },
      p: Array.isArray(val.p) && val.p.length ? val.p : def.p,
      f: Array.isArray(val.f) && val.f.length ? val.f : def.f,
    };
  }
  const cfg = _defaultConfig();
  const fallbackVals = _parseFallback(val);
  const pickVals     = _parsePick(val);
  const randSpec     = _parseRandom(val);
  if      (fallbackVals) { cfg.activeType = 'f'; cfg.f = fallbackVals; }
  else if (pickVals)     { cfg.activeType = 'p'; cfg.p = pickVals; }
  else if (randSpec)     { cfg.activeType = 'r'; cfg.r = randSpec; }
  else                   { cfg.activeType = 's'; cfg.s = typeof val === 'string' ? val : ''; }
  return cfg;
}

/** Compute the active value string from a config object (for runtime/export use). */
export function _getActiveValue(cfg) {
  const t = cfg.activeType || 's';
  if (t === 'r' && cfg.r) return `{random:${cfg.r.type}:${cfg.r.length}}`;
  if (t === 'p') {
    const vals = (cfg.p || []).filter(Boolean);
    return vals.length ? `{pick:${vals.join('|')}}` : '';
  }
  if (t === 'f') {
    const vals = (cfg.f || []).filter(Boolean);
    return vals.length ? `{fallback:${vals.join('|')}}` : '';
  }
  return cfg.s || '';
}

/* ── Type helpers ────────────────────────────────────────────────────────── */

function _typeLabel(t) {
  return t === 'f' ? 'Fallback' : t === 'p' ? 'Pick' : t === 'r' ? 'Rand' : 'Static';
}

function _valueText(cfg) {
  const t = cfg.activeType || 's';
  if (t === 'r') {
    return cfg.r?.type === 'datetime'
      ? 'YYYY-MM-DD_HH-MM-SS'
      : `${cfg.r?.type || 'alphanumeric'} · ${cfg.r?.length || '8'}`;
  }
  if (t === 'p') return (cfg.p || []).filter(Boolean).join(' · ') || '—';
  if (t === 'f') return (cfg.f || []).filter(Boolean).join(' → ') || '—';
  return cfg.s || '';
}

/* ── DOM helpers ─────────────────────────────────────────────────────────── */

function getListEl() {
  return document.getElementById('variablesTableBody');
}

function _reindexRows() {
  const ul = getListEl();
  if (!ul) return;
  ul.querySelectorAll('li.var-row').forEach((li, i) => {
    const idx = li.querySelector('.vr-idx');
    if (idx) idx.textContent = (i + 1) + '.';
  });
  const empty = ul.querySelector('.var-list-empty');
  const hasRows = ul.querySelectorAll('li.var-row').length > 0;
  if (empty) empty.style.display = hasRows ? 'none' : '';
}

/* ── Auto-save ───────────────────────────────────────────────────────────── */

function _autoSave() {
  chrome.runtime.sendMessage({ type: 'SAVE_VARIABLES', variables: getVariablesFromTable() });
}

/* ── Row rendering ───────────────────────────────────────────────────────── */

function _buildRow(key, valOrCfg) {
  const cfg = _migrateToConfig(valOrCfg);
  const t   = cfg.activeType || 's';

  const li = document.createElement('li');
  li.className      = `var-row t-${t}`;
  li.dataset.key    = key;
  li.dataset.config = JSON.stringify(cfg);

  const idxSpan = document.createElement('span');
  idxSpan.className = 'vr-idx';
  idxSpan.textContent = '1.';

  const typeSpan = document.createElement('span');
  typeSpan.className = 'vr-type';
  const iconBox = document.createElement('span');
  iconBox.className   = `vt-i ${t}`;
  iconBox.textContent = t === 's' ? 'S' : t === 'r' ? 'R' : t === 'p' ? 'P' : 'F';
  typeSpan.appendChild(iconBox);
  typeSpan.appendChild(document.createTextNode(' ' + _typeLabel(t)));

  const keySpan = document.createElement('span');
  keySpan.className   = 'vr-key';
  keySpan.title       = key;
  keySpan.textContent = key || '—';

  const arrSpan = document.createElement('span');
  arrSpan.className   = 'vr-arr';
  arrSpan.textContent = '→';

  const valSpan = document.createElement('span');
  valSpan.className   = 'vr-val';
  valSpan.title       = _getActiveValue(cfg);
  valSpan.textContent = _valueText(cfg);

  if (t === 'p') {
    const sub = document.createElement('span');
    sub.className   = 'vr-sub';
    const n = (cfg.p || []).filter(Boolean).length;
    sub.textContent = `${n} option${n !== 1 ? 's' : ''} · random per run · CSV overrides`;
    valSpan.appendChild(sub);
  } else if (t === 'r') {
    const sub = document.createElement('span');
    sub.className   = 'vr-sub';
    sub.textContent = 'new value each run';
    valSpan.appendChild(sub);
  } else if (t === 'f') {
    const sub = document.createElement('span');
    sub.className   = 'vr-sub';
    const n = (cfg.f || []).filter(Boolean).length;
    sub.textContent = `${n} values · tries A→B→C in Child Condition · sticky per run`;
    valSpan.appendChild(sub);
  }

  const btnRow = document.createElement('div');
  btnRow.className = 'var-btn-row';

  const editBtn = document.createElement('button');
  editBtn.className   = 'vr-edit';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => _openModal(li));

  const delBtn = document.createElement('button');
  delBtn.className   = 'vr-delete';
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', () => {
    const varKey = li.dataset.key || 'this variable';
    showConfirm(`Delete variable "${varKey}"?`, () => {
      li.remove();
      _reindexRows();
      _autoSave();
      showToast(`"${varKey}" deleted`, 'success');
    }, { title: 'Delete Variable', danger: true });
  });

  btnRow.appendChild(editBtn);
  btnRow.appendChild(delBtn);

  li.appendChild(idxSpan);
  li.appendChild(typeSpan);
  li.appendChild(keySpan);
  li.appendChild(arrSpan);
  li.appendChild(valSpan);
  li.appendChild(btnRow);

  return li;
}

function _refreshRow(li) {
  let cfg;
  try { cfg = JSON.parse(li.dataset.config || '{}'); } catch { cfg = _defaultConfig(); }
  cfg = _migrateToConfig(cfg);
  const t = cfg.activeType || 's';

  li.className = `var-row t-${t}`;

  const typeSpan = li.querySelector('.vr-type');
  if (typeSpan) {
    typeSpan.innerHTML = '';
    const iconBox = document.createElement('span');
    iconBox.className   = `vt-i ${t}`;
    iconBox.textContent = t === 's' ? 'S' : t === 'r' ? 'R' : t === 'p' ? 'P' : 'F';
    typeSpan.appendChild(iconBox);
    typeSpan.appendChild(document.createTextNode(' ' + _typeLabel(t)));
  }

  const key     = li.dataset.key || '';
  const keySpan = li.querySelector('.vr-key');
  if (keySpan) { keySpan.textContent = key || '—'; keySpan.title = key; }

  const valSpan = li.querySelector('.vr-val');
  if (valSpan) {
    valSpan.title       = _getActiveValue(cfg);
    valSpan.textContent = _valueText(cfg);
    if (t === 'p') {
      const sub = document.createElement('span');
      sub.className   = 'vr-sub';
      const n = (cfg.p || []).filter(Boolean).length;
      sub.textContent = `${n} option${n !== 1 ? 's' : ''} · random per run · CSV overrides`;
      valSpan.appendChild(sub);
    } else if (t === 'r') {
      const sub = document.createElement('span');
      sub.className   = 'vr-sub';
      sub.textContent = 'new value each run';
      valSpan.appendChild(sub);
    } else if (t === 'f') {
      const sub = document.createElement('span');
      sub.className   = 'vr-sub';
      const n = (cfg.f || []).filter(Boolean).length;
      sub.textContent = `${n} values · tries A→B→C in Child Condition · sticky per run`;
      valSpan.appendChild(sub);
    }
  }
}

/* ── Public API ──────────────────────────────────────────────────────────── */

/**
 * Add a variable row. Called by main.js (auto-create vars, restore draft, etc.)
 * and by the modal confirm handler for new rows.
 * `value` may be a plain string (old format) or a config object (new format).
 */
export function addVariableRow(key = '', value = '') {
  const ul = getListEl();
  if (!ul) return;

  if (key || value) {
    const empty = findEmptyRow();
    if (empty) {
      const cfg = _migrateToConfig(value);
      empty.dataset.key    = key;
      empty.dataset.config = JSON.stringify(cfg);
      _refreshRow(empty);
      _reindexRows();
      return;
    }
  }

  const li = _buildRow(key, value);
  ul.appendChild(li);
  _reindexRows();
}

/** Return the first row with no key and empty active value, or null. */
export function findEmptyRow() {
  const ul = getListEl();
  if (!ul) return null;
  for (const li of ul.querySelectorAll('li.var-row')) {
    if (!li.dataset.key) {
      try {
        const cfg = JSON.parse(li.dataset.config || '{}');
        if (!_getActiveValue(cfg)) return li;
      } catch { return li; }
    }
  }
  return null;
}

/**
 * Read all non-empty key/config pairs from the list.
 * Returns a map of { varName: configObject } for storage.
 */
export function getVariablesFromTable() {
  const ul     = getListEl();
  const result = {};
  if (!ul) return result;
  ul.querySelectorAll('li.var-row').forEach(li => {
    const key = li.dataset.key?.trim();
    if (key) {
      try {
        result[key] = JSON.parse(li.dataset.config || '{}');
      } catch {
        result[key] = _defaultConfig();
      }
    }
  });
  return result;
}

/** Fetch variables from background and repopulate the list. */
export function loadVariables() {
  chrome.runtime.sendMessage({ type: 'GET_VARIABLES' }, (res) => {
    const ul = getListEl();
    if (!ul) return;
    ul.innerHTML = '';

    const empty = document.createElement('div');
    empty.className = 'var-list-empty';
    empty.textContent = 'No variables yet — click + Add Row';
    ul.appendChild(empty);

    const vars = res?.variables || {};
    Object.entries(vars).forEach(([k, v]) => addVariableRow(k, v));
    _reindexRows();
  });
}

/* ── Modal state ─────────────────────────────────────────────────────────── */

let _editingRow = null;
let _focusTimer  = null;
let _triggerEl   = null;
let _rndMode     = 'static'; // 'static' | 'string' | 'pick' | 'fallback'

const _TYPE_TO_MODE = { s: 'static', r: 'string', p: 'pick', f: 'fallback' };
const _MODE_TO_TYPE = { static: 's', string: 'r', pick: 'p', fallback: 'f' };

/* ── Pick / Fallback list helpers ────────────────────────────────────────── */

function _addPickValueRow(value = '', doFocus = true) {
  const list = document.getElementById('pickValuesList');
  if (!list) return;

  const row = document.createElement('div');
  row.className = 'pick-value-row';

  const inp = document.createElement('input');
  inp.type        = 'text';
  inp.placeholder = 'e.g., active';
  inp.value       = value;

  const del = document.createElement('button');
  del.className   = 'del-pick-btn';
  del.type        = 'button';
  del.textContent = '×';
  del.title       = 'Remove value';
  del.addEventListener('click', () => {
    const rows = list.querySelectorAll('.pick-value-row');
    if (rows.length > 1) row.remove();
    else showToast('At least one value required', 'error');
  });

  row.appendChild(inp);
  row.appendChild(del);
  list.appendChild(row);
  if (doFocus) inp.focus();
}

function _getPickValues() {
  const list = document.getElementById('pickValuesList');
  if (!list) return [];
  return [...list.querySelectorAll('.pick-value-row input')]
    .map(i => i.value.trim()).filter(Boolean);
}

function _addFallbackValueRow(value = '', doFocus = true) {
  const list = document.getElementById('fallbackValuesList');
  if (!list) return;

  const row = document.createElement('div');
  row.className = 'pick-value-row';

  const inp = document.createElement('input');
  inp.type        = 'text';
  inp.placeholder = 'e.g., active';
  inp.value       = value;

  const del = document.createElement('button');
  del.className   = 'del-pick-btn';
  del.type        = 'button';
  del.textContent = '×';
  del.addEventListener('click', () => {
    if (list.querySelectorAll('.pick-value-row').length > 1) row.remove();
    else showToast('At least one fallback value required', 'error');
  });

  row.appendChild(inp);
  row.appendChild(del);
  list.appendChild(row);
  if (doFocus) inp.focus();
}

function _getFallbackValues() {
  const list = document.getElementById('fallbackValuesList');
  if (!list) return [];
  return [...list.querySelectorAll('.pick-value-row input')]
    .map(i => i.value.trim()).filter(Boolean);
}

/* ── Length row visibility ───────────────────────────────────────────────── */

function _updateLengthRow(type) {
  const row = document.getElementById('rndLengthRow');
  if (row) row.style.display = type === 'datetime' ? 'none' : '';
}

/* ── Mode switching ──────────────────────────────────────────────────────── */

function _switchMode(mode) {
  _rndMode = mode;
  const sections = { static: 'rndStaticSection', string: 'rndStringSection', pick: 'rndPickSection', fallback: 'rndFallbackSection' };
  const tabs     = { static: 'rndTabStatic',     string: 'rndTabString',     pick: 'rndTabPick',     fallback: 'rndTabFallback'     };
  Object.entries(sections).forEach(([m, id]) => {
    const el = document.getElementById(id);
    if (el) el.style.display = m === mode ? '' : 'none';
  });
  Object.entries(tabs).forEach(([m, id]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('active', m === mode);
    el.setAttribute('aria-selected', String(m === mode));
  });
}

/* ── Modal open / close ──────────────────────────────────────────────────── */

function _openModal(editRow = null) {
  _triggerEl  = document.activeElement;
  _editingRow = editRow;

  const modal      = document.getElementById('randomModal');
  const varName    = document.getElementById('randomVarName');
  const rndType    = document.getElementById('randomType');
  const rndLen     = document.getElementById('randomLength');
  const title      = document.getElementById('randomModalTitle');
  const confirmBtn = document.getElementById('confirmRandom');

  if (editRow) {
    let cfg;
    try { cfg = JSON.parse(editRow.dataset.config || '{}'); } catch { cfg = _defaultConfig(); }
    cfg = _migrateToConfig(cfg);

    if (varName) { varName.value = editRow.dataset.key || ''; varName.readOnly = false; }
    if (title)      title.textContent      = 'Edit Variable';
    if (confirmBtn) confirmBtn.textContent = 'Save';

    // Populate static tab
    const sv = document.getElementById('staticValue');
    if (sv) sv.value = cfg.s || '';

    // Populate random tab
    if (rndType) rndType.value = cfg.r?.type   || 'alphanumeric';
    if (rndLen)  rndLen.value  = cfg.r?.length  || '8';
    _updateLengthRow(cfg.r?.type || 'alphanumeric');

    // Populate pick tab (doFocus=false to avoid stealing focus from wrong tab)
    const pickList = document.getElementById('pickValuesList');
    if (pickList) {
      pickList.innerHTML = '';
      const pickVals = (cfg.p || []).filter(v => v !== undefined);
      (pickVals.length >= 2 ? pickVals : ['', '']).forEach(v => _addPickValueRow(v, false));
    }

    // Populate fallback tab
    const fbListEl = document.getElementById('fallbackValuesList');
    if (fbListEl) {
      fbListEl.innerHTML = '';
      const fbVals = (cfg.f || []).filter(v => v !== undefined);
      (fbVals.length >= 2 ? fbVals : ['', '']).forEach(v => _addFallbackValueRow(v, false));
    }

    _switchMode(_TYPE_TO_MODE[cfg.activeType] || 'static');
  } else {
    if (varName) { varName.value = ''; varName.readOnly = false; }
    if (title)      title.textContent      = 'Add Variable';
    if (confirmBtn) confirmBtn.textContent = 'Add Variable';

    const sv = document.getElementById('staticValue');
    if (sv) sv.value = '';
    if (rndType) rndType.value = 'alphanumeric';
    if (rndLen)  rndLen.value  = '8';
    _updateLengthRow('alphanumeric');

    const pickList = document.getElementById('pickValuesList');
    if (pickList) { pickList.innerHTML = ''; _addPickValueRow('', false); _addPickValueRow('', false); }
    const fbListEl = document.getElementById('fallbackValuesList');
    if (fbListEl) { fbListEl.innerHTML = ''; _addFallbackValueRow('', false); _addFallbackValueRow('', false); }

    _switchMode('static');
  }

  modal?.setAttribute('aria-hidden', 'false');
  modal?.classList.add('show');
  lockScroll();
  clearTimeout(_focusTimer);
  _focusTimer = setTimeout(() => {
    _focusTimer = null;
    if (!document.getElementById('randomModal')?.classList.contains('show')) return;
    (editRow ? confirmBtn : varName)?.focus();
  }, 50);
}

function _closeModal() {
  clearTimeout(_focusTimer);
  _focusTimer = null;
  const modal = document.getElementById('randomModal');
  if (modal?.contains(document.activeElement)) document.activeElement.blur();
  modal?.classList.remove('show');
  modal?.setAttribute('aria-hidden', 'true');
  _triggerEl?.focus();
  _editingRow = null;
  _triggerEl  = null;
  unlockScroll();
}

/* ── Init ────────────────────────────────────────────────────────────────── */

export function initVariables() {
  const addBtn     = document.getElementById('addVariableRow');
  const modal      = document.getElementById('randomModal');
  const varName    = document.getElementById('randomVarName');
  const rndType    = document.getElementById('randomType');
  const rndLen     = document.getElementById('randomLength');
  const cancelBtn  = document.getElementById('cancelRandom');
  const confirmBtn = document.getElementById('confirmRandom');

  addBtn?.addEventListener('click', () => _openModal(null));

  cancelBtn?.addEventListener('click', _closeModal);
  modal?.addEventListener('click', (e) => { if (e.target === modal) _closeModal(); });

  document.querySelectorAll('.rnd-mode-tab').forEach(btn => {
    btn.addEventListener('click', () => _switchMode(btn.dataset.mode));
  });

  rndType?.addEventListener('change', () => _updateLengthRow(rndType.value));

  document.getElementById('addPickValue')?.addEventListener('click',     () => _addPickValueRow());
  document.getElementById('addFallbackValue')?.addEventListener('click', () => _addFallbackValueRow());

  confirmBtn?.addEventListener('click', () => {
    const name = varName?.value.trim();
    if (!name) {
      varName?.classList.add('required-error');
      setTimeout(() => varName?.classList.remove('required-error'), 2000);
      return;
    }

    // Read ALL tabs regardless of which is active — this is what preserves config across switches
    const staticVal    = document.getElementById('staticValue')?.value || '';
    const randTypeVal  = rndType?.value || 'alphanumeric';
    const randLenVal   = rndLen?.value  || '8';
    const pickVals     = _getPickValues();
    const fallbackVals = _getFallbackValues();

    // Validate only the active tab
    if (_rndMode === 'fallback') {
      if (fallbackVals.length < 2) { showToast('Add at least 2 fallback values', 'error'); return; }
    } else if (_rndMode === 'pick') {
      if (pickVals.length < 2) { showToast('Add at least 2 values to Pick list', 'error'); return; }
    }

    const cfg = {
      activeType: _MODE_TO_TYPE[_rndMode] || 's',
      s: staticVal,
      r: { type: randTypeVal, length: randLenVal },
      p: pickVals.length     ? pickVals     : ['', ''],
      f: fallbackVals.length ? fallbackVals : ['', ''],
    };

    if (_editingRow) {
      _editingRow.dataset.key    = name;
      _editingRow.dataset.config = JSON.stringify(cfg);
      _refreshRow(_editingRow);
      _reindexRows();
      _closeModal();
      _autoSave();
      showToast(`✓ "${name}" saved`, 'success');
    } else {
      addVariableRow(name, cfg);
      _closeModal();
      _autoSave();
      showToast(`✓ "${name}" added`, 'success');
    }
  });

  loadVariables();
}
