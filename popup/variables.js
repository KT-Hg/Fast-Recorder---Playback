/**
 * variables.js — Variables table management and random-value generator.
 *
 * Random variables are stored with the sentinel value `{random:type:len}` (e.g.
 * `{random:alphanumeric:8}`). The background service resolves this token at
 * playback time via `resolveRandomVars`, so a fresh random value is generated
 * for each run rather than being fixed at save time.
 *
 * Exports: addVariableRow, loadVariables, getVariablesFromTable, findEmptyRow, initVariables
 */

import { showToast, lockScroll, unlockScroll } from './utils.js';

function getTableBody() {
  return document.getElementById('variablesTableBody');
}

/**
 * Append a key/value row to the variables table.
 * If the table already has a completely empty row and both `key` and `value`
 * are provided, that row is reused instead of adding a new one — prevents
 * duplicate blank rows when loading an initial empty state.
 *
 * Row HTML is built via the DOM API (not innerHTML) to prevent XSS from
 * untrusted key/value strings loaded from storage.
 */
export function addVariableRow(key = '', value = '') {
  const tbody = getTableBody();
  if (!tbody) return;
  const emptyRow = findEmptyRow();
  if (emptyRow && (key || value)) {
    const keyInput = emptyRow.querySelector('.var-key');
    const valueInput = emptyRow.querySelector('.var-value');
    if (keyInput) keyInput.value = key;
    if (valueInput) valueInput.value = value;
    return;
  }
  // Use DOM API instead of innerHTML to prevent XSS from untrusted key/value data.
  const row = document.createElement('tr');

  const keyTd = document.createElement('td');
  const keyInput = document.createElement('input');
  keyInput.type = 'text'; keyInput.className = 'var-key';
  keyInput.value = key; keyInput.placeholder = 'key';
  keyTd.appendChild(keyInput);

  const valTd = document.createElement('td');
  const valInput = document.createElement('input');
  valInput.type = 'text'; valInput.className = 'var-value';
  valInput.value = value; valInput.placeholder = 'value';
  valTd.appendChild(valInput);

  const actionsTd = document.createElement('td');
  actionsTd.className = 'var-actions-cell';

  const randBtn = document.createElement('button');
  randBtn.className = 'var-random-btn secondary';
  randBtn.title = 'Set as random';
  randBtn.innerHTML = '&#9860;';
  randBtn.addEventListener('click', () => _openModal(row));

  const delBtn = document.createElement('button');
  delBtn.innerHTML = '&#x2715;';
  delBtn.className = 'delete-row';
  delBtn.addEventListener('click', () => row.remove());

  actionsTd.appendChild(randBtn);
  actionsTd.appendChild(delBtn);
  row.appendChild(keyTd);
  row.appendChild(valTd);
  row.appendChild(actionsTd);
  tbody.appendChild(row);
}

/** Return the first table row whose key and value inputs are both blank, or null. */
export function findEmptyRow() {
  const tbody = getTableBody();
  if (!tbody) return null;
  for (const row of tbody.querySelectorAll('tr')) {
    const key = row.querySelector('.var-key')?.value.trim();
    const value = row.querySelector('.var-value')?.value.trim();
    if (!key && !value) return row;
  }
  return null;
}

/** Read all non-empty key/value pairs from the table into a plain object. */
export function getVariablesFromTable() {
  const tbody = getTableBody();
  const result = {};
  if (!tbody) return result;
  tbody.querySelectorAll('tr').forEach((row) => {
    const key = row.querySelector('.var-key')?.value.trim();
    const value = row.querySelector('.var-value')?.value.trim();
    if (key) result[key] = value || '';
  });
  return result;
}

/** Fetch variables from the background and repopulate the table. */
export function loadVariables() {
  chrome.runtime.sendMessage({ type: 'GET_VARIABLES' }, (res) => {
    const tbody = getTableBody();
    if (!tbody) return;
    tbody.innerHTML = '';
    const vars = res?.variables || {};
    Object.entries(vars).forEach(([k, v]) => addVariableRow(k, v));
    if (Object.keys(vars).length === 0) addVariableRow();
  });
}

let _editingRow  = null;
let _focusTimer  = null;
let _triggerEl   = null;

/**
 * Open the random-variable generator modal.
 * When `editRow` is a table row, the modal pre-fills from that row and saves
 * back to it on confirm. When null, the modal creates a new row.
 */
function _openModal(editRow = null) {
  _triggerEl = document.activeElement;
  const modal      = document.getElementById('randomModal');
  const varName    = document.getElementById('randomVarName');
  const rndType    = document.getElementById('randomType');
  const rndLen     = document.getElementById('randomLength');
  const title      = document.getElementById('randomModalTitle');
  const confirmBtn = document.getElementById('confirmRandom');

  _editingRow = editRow;

  if (editRow) {
    const currentKey   = editRow.querySelector('.var-key')?.value.trim() || '';
    const currentValue = editRow.querySelector('.var-value')?.value.trim() || '';
    if (varName) { varName.value = currentKey; varName.readOnly = true; }
    // Parse existing {random:type:len} if present
    const match = currentValue.match(/^\{random:(\w+):(\d+)\}$/);
    if (rndType) rndType.value = match ? match[1] : 'alphanumeric';
    if (rndLen)  rndLen.value  = match ? match[2] : '8';
    if (title)      title.textContent      = 'Set Random Variable';
    if (confirmBtn) confirmBtn.textContent = 'Set Random';
  } else {
    if (varName) { varName.value = ''; varName.readOnly = false; }
    if (rndType) rndType.value = 'alphanumeric';
    if (rndLen)  rndLen.value  = '8';
    if (title)      title.textContent      = 'Generate Random Variable';
    if (confirmBtn) confirmBtn.textContent = 'Add Variable';
  }

  modal?.setAttribute('aria-hidden', 'false');
  modal?.classList.add('show');
  lockScroll();
  clearTimeout(_focusTimer);
  // Defer focus by one rAF-equivalent tick so the modal's CSS transition has
  // started and the element is visible before focus is applied; some browsers
  // silently ignore focus() on an element whose display is still 'none'.
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
  // Move focus out before aria-hidden="true" to avoid "retained focus" warning
  if (modal?.contains(document.activeElement)) {
    document.activeElement.blur();
  }
  modal?.classList.remove('show');
  modal?.setAttribute('aria-hidden', 'true');
  _triggerEl?.focus();
  _editingRow = null;
  _triggerEl  = null;
  unlockScroll();
}

/** Attach all variable-panel event listeners and load initial data from storage. */
export function initVariables() {
  const addBtn       = document.getElementById('addVariableRow');
  const addRandomBtn = document.getElementById('addRandomVariable');
  const saveBtn      = document.getElementById('saveVariables');
  const reloadBtn    = document.getElementById('reloadVariables');
  const modal        = document.getElementById('randomModal');
  const varName      = document.getElementById('randomVarName');
  const rndType      = document.getElementById('randomType');
  const rndLen       = document.getElementById('randomLength');
  const cancelBtn    = document.getElementById('cancelRandom');
  const confirmBtn   = document.getElementById('confirmRandom');

  addBtn?.addEventListener('click', () => addVariableRow());
  addRandomBtn?.addEventListener('click', () => _openModal(null));
  cancelBtn?.addEventListener('click', _closeModal);
  modal?.addEventListener('click', (e) => { if (e.target === modal) _closeModal(); });

  confirmBtn?.addEventListener('click', () => {
    const name = varName?.value.trim();
    if (!name) {
      varName?.classList.add('required-error');
      setTimeout(() => varName?.classList.remove('required-error'), 2000);
      return;
    }
    const value = `{random:${rndType?.value}:${rndLen?.value}}`;
    if (_editingRow) {
      const valueInput = _editingRow.querySelector('.var-value');
      if (valueInput) valueInput.value = value;
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
