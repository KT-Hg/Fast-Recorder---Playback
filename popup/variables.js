/**
 * variables.js — Variables list management (Pure Action Row Mirror design).
 *
 * Each variable is an <li class="var-row t-{s|r|p}"> that mirrors the action
 * list style: fixed-width type column with equal-size icon badge (S/R/P),
 * key → value display, Edit/Delete buttons.
 *
 * Three variable formats stored in li.dataset.value:
 *   static  — plain string
 *   rand    — {random:type:len}
 *   pick    — {pick:val1|val2|val3}
 *
 * Editing always goes through the 3-tab modal (Static / Random / Pick).
 *
 * Exports: addVariableRow, loadVariables, getVariablesFromTable, findEmptyRow, initVariables
 */

import { showToast, lockScroll, unlockScroll } from './utils.js';

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

/* ── Type helpers ────────────────────────────────────────────────────────── */

// 's' | 'r' | 'p' | 'f'
function _typeKey(value) {
  if (_parseFallback(value)) return 'f';
  if (_parsePick(value))     return 'p';
  if (_parseRandom(value))   return 'r';
  return 's';
}

function _typeLabel(t) {
  return t === 'f' ? 'Fallback' : t === 'p' ? 'Pick' : t === 'r' ? 'Rand' : 'Static';
}

// Text shown in the value column for each type
function _valueText(value, t) {
  if (t === 'r') {
    const spec = _parseRandom(value);
    return spec ? `${spec.type} · ${spec.length}` : value;
  }
  if (t === 'p') {
    const vals = _parsePick(value);
    return vals ? vals.join(' · ') : value;
  }
  if (t === 'f') {
    const vals = _parseFallback(value);
    return vals ? vals.join(' → ') : value;
  }
  return value || '';
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
  // Show/hide empty state message
  const empty = ul.querySelector('.var-list-empty');
  const hasRows = ul.querySelectorAll('li.var-row').length > 0;
  if (empty) empty.style.display = hasRows ? 'none' : '';
}

/* ── Row rendering ───────────────────────────────────────────────────────── */

function _buildRow(key, value) {
  const t = _typeKey(value);

  const li = document.createElement('li');
  li.className = `var-row t-${t}`;
  li.dataset.key   = key;
  li.dataset.value = value;

  // Index
  const idxSpan = document.createElement('span');
  idxSpan.className = 'vr-idx';
  idxSpan.textContent = '1.';

  // Type — fixed-width column with equal-size icon box
  const typeSpan = document.createElement('span');
  typeSpan.className = 'vr-type';
  const iconBox = document.createElement('span');
  iconBox.className = `vt-i ${t}`;
  iconBox.textContent = t === 's' ? 'S' : t === 'r' ? 'R' : t === 'p' ? 'P' : 'F';
  typeSpan.appendChild(iconBox);
  typeSpan.appendChild(document.createTextNode(' ' + _typeLabel(t)));

  // Key
  const keySpan = document.createElement('span');
  keySpan.className = 'vr-key';
  keySpan.title = key;
  keySpan.textContent = key || '—';

  // Arrow
  const arrSpan = document.createElement('span');
  arrSpan.className = 'vr-arr';
  arrSpan.textContent = '→';

  // Value
  const valSpan = document.createElement('span');
  valSpan.className = 'vr-val';
  valSpan.title = value;
  valSpan.textContent = _valueText(value, t);

  if (t === 'p') {
    const sub = document.createElement('span');
    sub.className = 'vr-sub';
    const n = _parsePick(value)?.length || 0;
    sub.textContent = `${n} option${n !== 1 ? 's' : ''} · random per run · CSV overrides`;
    valSpan.appendChild(sub);
  } else if (t === 'r') {
    const sub = document.createElement('span');
    sub.className = 'vr-sub';
    sub.textContent = 'new value each run';
    valSpan.appendChild(sub);
  } else if (t === 'f') {
    const sub = document.createElement('span');
    sub.className = 'vr-sub';
    const n = _parseFallback(value)?.length || 0;
    sub.textContent = `${n} values · tries A→B→C in Child Condition · sticky per run`;
    valSpan.appendChild(sub);
  }

  // Buttons
  const btnRow = document.createElement('div');
  btnRow.className = 'var-btn-row';

  const editBtn = document.createElement('button');
  editBtn.className = 'vr-edit';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => _openModal(li));

  const delBtn = document.createElement('button');
  delBtn.className = 'vr-delete';
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', () => { li.remove(); _reindexRows(); });

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

// Refreshes all visual elements of an existing row from its data attributes
function _refreshRow(li) {
  const key   = li.dataset.key   || '';
  const value = li.dataset.value || '';
  const t     = _typeKey(value);

  li.className = `var-row t-${t}`;

  const typeSpan = li.querySelector('.vr-type');
  if (typeSpan) {
    typeSpan.innerHTML = '';
    const iconBox = document.createElement('span');
    iconBox.className = `vt-i ${t}`;
    iconBox.textContent = t === 's' ? 'S' : t === 'r' ? 'R' : 'P';
    typeSpan.appendChild(iconBox);
    typeSpan.appendChild(document.createTextNode(' ' + _typeLabel(t)));
  }

  const keySpan = li.querySelector('.vr-key');
  if (keySpan) { keySpan.textContent = key || '—'; keySpan.title = key; }

  const valSpan = li.querySelector('.vr-val');
  if (valSpan) {
    valSpan.title = value;
    valSpan.textContent = _valueText(value, t);
    if (t === 'p') {
      const sub = document.createElement('span');
      sub.className = 'vr-sub';
      const n = _parsePick(value)?.length || 0;
      sub.textContent = `${n} option${n !== 1 ? 's' : ''} · random per run · CSV overrides`;
      valSpan.appendChild(sub);
    } else if (t === 'r') {
      const sub = document.createElement('span');
      sub.className = 'vr-sub';
      sub.textContent = 'new value each run';
      valSpan.appendChild(sub);
    } else if (t === 'f') {
      const sub = document.createElement('span');
      sub.className = 'vr-sub';
      const n = _parseFallback(value)?.length || 0;
      sub.textContent = `${n} values · tries A→B→C in Child Condition · sticky per run`;
      valSpan.appendChild(sub);
    }
  }
}

/* ── Public API ──────────────────────────────────────────────────────────── */

/**
 * Add a variable row. Called by main.js (auto-create vars, restore draft, etc.)
 * and by the modal confirm handler for new rows.
 */
export function addVariableRow(key = '', value = '') {
  const ul = getListEl();
  if (!ul) return;

  // Reuse the first empty row if key+value were given (migration compat)
  if (key || value) {
    const empty = findEmptyRow();
    if (empty) {
      empty.dataset.key   = key;
      empty.dataset.value = value;
      _refreshRow(empty);
      _reindexRows();
      return;
    }
  }

  const li = _buildRow(key, value);
  ul.appendChild(li);
  _reindexRows();
}

/** Return the first row with no key and no value, or null. */
export function findEmptyRow() {
  const ul = getListEl();
  if (!ul) return null;
  for (const li of ul.querySelectorAll('li.var-row')) {
    if (!li.dataset.key && !li.dataset.value) return li;
  }
  return null;
}

/** Read all non-empty key/value pairs from the list. */
export function getVariablesFromTable() {
  const ul = getListEl();
  const result = {};
  if (!ul) return result;
  ul.querySelectorAll('li.var-row').forEach(li => {
    const key = li.dataset.key?.trim();
    if (key) result[key] = li.dataset.value || '';
  });
  return result;
}

/** Fetch variables from background and repopulate the list. */
export function loadVariables() {
  chrome.runtime.sendMessage({ type: 'GET_VARIABLES' }, (res) => {
    const ul = getListEl();
    if (!ul) return;
    ul.innerHTML = '';

    // Empty-state placeholder (hidden when rows exist)
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
let _focusTimer = null;
let _triggerEl  = null;
let _rndMode    = 'static'; // 'static' | 'string' | 'pick'

/* ── Pick list helpers ───────────────────────────────────────────────────── */

function _addPickValueRow(value = '') {
  const list = document.getElementById('pickValuesList');
  if (!list) return;

  const row = document.createElement('div');
  row.className = 'pick-value-row';

  const inp = document.createElement('input');
  inp.type = 'text'; inp.placeholder = 'e.g., active'; inp.value = value;

  const del = document.createElement('button');
  del.className = 'del-pick-btn'; del.type = 'button'; del.textContent = '×';
  del.title = 'Remove value';
  del.addEventListener('click', () => {
    const rows = list.querySelectorAll('.pick-value-row');
    if (rows.length > 1) row.remove();
    else showToast('At least one value required', 'error');
  });

  row.appendChild(inp); row.appendChild(del);
  list.appendChild(row);
  inp.focus();
}

function _getPickValues() {
  const list = document.getElementById('pickValuesList');
  if (!list) return [];
  return [...list.querySelectorAll('.pick-value-row input')]
    .map(i => i.value.trim()).filter(Boolean);
}

function _addFallbackValueRow(value = '') {
  const list = document.getElementById('fallbackValuesList');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'pick-value-row';
  const inp = document.createElement('input');
  inp.type = 'text'; inp.placeholder = 'e.g., active'; inp.value = value;
  const del = document.createElement('button');
  del.className = 'del-pick-btn'; del.type = 'button'; del.textContent = '×';
  del.addEventListener('click', () => {
    if (list.querySelectorAll('.pick-value-row').length > 1) row.remove();
    else showToast('At least one fallback value required', 'error');
  });
  row.appendChild(inp); row.appendChild(del);
  list.appendChild(row);
  inp.focus();
}

function _getFallbackValues() {
  const list = document.getElementById('fallbackValuesList');
  if (!list) return [];
  return [...list.querySelectorAll('.pick-value-row input')]
    .map(i => i.value.trim()).filter(Boolean);
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
  const pickList   = document.getElementById('pickValuesList');

  if (editRow) {
    const currentKey   = editRow.dataset.key   || '';
    const currentValue = editRow.dataset.value  || '';
    if (varName) { varName.value = currentKey; varName.readOnly = !!currentKey; }
    if (title)      title.textContent      = 'Edit Variable';
    if (confirmBtn) confirmBtn.textContent = 'Save';

    // Always reset all panels so stale data from a previous edit never leaks
    // into a tab the user switches to during this session.
    if (pickList) { pickList.innerHTML = ''; _addPickValueRow(''); _addPickValueRow(''); }
    const fbListEl0 = document.getElementById('fallbackValuesList');
    if (fbListEl0) { fbListEl0.innerHTML = ''; _addFallbackValueRow(''); _addFallbackValueRow(''); }
    if (rndType) rndType.value = 'alphanumeric';
    if (rndLen)  rndLen.value  = '8';
    const sv0 = document.getElementById('staticValue');
    if (sv0) sv0.value = '';

    const pickVals    = _parsePick(currentValue);
    const randSpec    = _parseRandom(currentValue);
    const fallbackVals = _parseFallback(currentValue);

    if (fallbackVals) {
      _switchMode('fallback');
      const fbListEl = document.getElementById('fallbackValuesList');
      if (fbListEl) { fbListEl.innerHTML = ''; fallbackVals.forEach(v => _addFallbackValueRow(v)); }
    } else if (pickVals) {
      _switchMode('pick');
      if (pickList) { pickList.innerHTML = ''; pickVals.forEach(v => _addPickValueRow(v)); }
    } else if (randSpec) {
      _switchMode('string');
      if (rndType) rndType.value = randSpec.type;
      if (rndLen)  rndLen.value  = randSpec.length;
    } else {
      _switchMode('static');
      const sv = document.getElementById('staticValue');
      if (sv) sv.value = currentValue;
    }
  } else {
    if (varName) { varName.value = ''; varName.readOnly = false; }
    if (title)      title.textContent      = 'Add Variable';
    if (confirmBtn) confirmBtn.textContent = 'Add Variable';
    _switchMode('static');
    const sv = document.getElementById('staticValue');
    if (sv) sv.value = '';
    if (rndType) rndType.value = 'alphanumeric';
    if (rndLen)  rndLen.value  = '8';
    if (pickList) { pickList.innerHTML = ''; _addPickValueRow(''); _addPickValueRow(''); }
    const fbListElNew = document.getElementById('fallbackValuesList');
    if (fbListElNew) { fbListElNew.innerHTML = ''; _addFallbackValueRow(''); _addFallbackValueRow(''); }
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
  const addBtn  = document.getElementById('addVariableRow');
  const saveBtn = document.getElementById('saveVariables');
  const reloadBtn    = document.getElementById('reloadVariables');
  const modal        = document.getElementById('randomModal');
  const varName      = document.getElementById('randomVarName');
  const rndType      = document.getElementById('randomType');
  const rndLen       = document.getElementById('randomLength');
  const cancelBtn    = document.getElementById('cancelRandom');
  const confirmBtn   = document.getElementById('confirmRandom');

  addBtn?.addEventListener('click', () => _openModal(null));

  cancelBtn?.addEventListener('click', _closeModal);
  modal?.addEventListener('click', (e) => { if (e.target === modal) _closeModal(); });

  // Mode tab switching
  document.querySelectorAll('.rnd-mode-tab').forEach(btn => {
    btn.addEventListener('click', () => _switchMode(btn.dataset.mode));
  });

  document.getElementById('addPickValue')?.addEventListener('click', () => _addPickValueRow());
  document.getElementById('addFallbackValue')?.addEventListener('click', () => _addFallbackValueRow());

  confirmBtn?.addEventListener('click', () => {
    const name = varName?.value.trim();
    if (!name) {
      varName?.classList.add('required-error');
      setTimeout(() => varName?.classList.remove('required-error'), 2000);
      return;
    }

    let value;
    if (_rndMode === 'fallback') {
      const vals = _getFallbackValues();
      if (vals.length < 2) { showToast('Add at least 2 fallback values', 'error'); return; }
      value = `{fallback:${vals.join('|')}}`;
    } else if (_rndMode === 'pick') {
      const vals = _getPickValues();
      if (vals.length < 2) { showToast('Add at least 2 values to Pick list', 'error'); return; }
      value = `{pick:${vals.join('|')}}`;
    } else if (_rndMode === 'string') {
      value = `{random:${rndType?.value}:${rndLen?.value}}`;
    } else {
      value = document.getElementById('staticValue')?.value || '';
    }

    if (_editingRow) {
      _editingRow.dataset.key   = name;
      _editingRow.dataset.value = value;
      _refreshRow(_editingRow);
      _reindexRows();
    } else {
      addVariableRow(name, value);
    }
    _closeModal();
  });

  saveBtn?.addEventListener('click', () => {
    const vars = getVariablesFromTable();
    chrome.runtime.sendMessage({ type: 'SAVE_VARIABLES', variables: vars }, () => {
      showToast('✓ Variables saved', 'success');
    });
  });

  reloadBtn?.addEventListener('click', () => loadVariables());

  loadVariables();
}
