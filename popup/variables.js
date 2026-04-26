/**
 * variables.js — Variables table management & random generator
 * Exports: addVariableRow, loadVariables, getVariablesFromTable, findEmptyRow, initVariables
 */

import { showToast, lockScroll, unlockScroll } from './utils.js';

/* === Table Helpers === */

function getTableBody() {
  return document.getElementById('variablesTableBody');
}

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
  const row = document.createElement('tr');
  row.innerHTML = `
    <td><input type="text" class="var-key" value="${key}" placeholder="key" /></td>
    <td><input type="text" class="var-value" value="${value}" placeholder="value" /></td>
    <td class="var-actions-cell">
      <button class="var-random-btn secondary" title="Set as random">&#9860;</button>
      <button class="delete-row">&#x2715;</button>
    </td>
  `;
  tbody.appendChild(row);
  row.querySelector('.delete-row')?.addEventListener('click', () => row.remove());
  row.querySelector('.var-random-btn')?.addEventListener('click', () => _openModal(row));
}

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

/* === Modal helpers === */

let _editingRow  = null;
let _focusTimer  = null;
let _triggerEl   = null;

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

/* === Init === */

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
    chrome.runtime.sendMessage({ type: 'SAVE_VARIABLES', variables: vars });
  });

  reloadBtn?.addEventListener('click', () => loadVariables());

  loadVariables();
}
