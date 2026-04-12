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
    <td><button class="delete-row">✕</button></td>
  `;
  row.querySelector('.delete-row').onclick = () => row.remove();
  tbody.appendChild(row);
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

/* === Init === */

export function initVariables() {
  const addBtn = document.getElementById('addVariableRow');
  const addRandomBtn = document.getElementById('addRandomVariable');
  const saveBtn = document.getElementById('saveVariables');
  const reloadBtn = document.getElementById('reloadVariables');
  const modal = document.getElementById('randomModal');
  const varName = document.getElementById('randomVarName');
  const rndType = document.getElementById('randomType');
  const rndLen = document.getElementById('randomLength');
  const cancelBtn = document.getElementById('cancelRandom');
  const confirmBtn = document.getElementById('confirmRandom');

  addBtn?.addEventListener('click', () => addVariableRow());

  addRandomBtn?.addEventListener('click', () => {
    if (varName) varName.value = '';
    if (rndType) rndType.value = 'alphanumeric';
    if (rndLen) rndLen.value = '8';
    modal?.classList.add('show');
    lockScroll();
  });

  cancelBtn?.addEventListener('click', () => {
    modal?.classList.remove('show');
    unlockScroll();
  });

  confirmBtn?.addEventListener('click', () => {
    const name = varName?.value.trim();
    if (!name) {
      varName?.classList.add('required-error');
      setTimeout(() => varName?.classList.remove('required-error'), 2000);
      return;
    }
    const value = `{random:${rndType?.value}:${rndLen?.value}}`;
    addVariableRow(name, value);
    modal?.classList.remove('show');
    unlockScroll();
  });

  modal?.addEventListener('click', (e) => {
    if (e.target === modal) { modal.classList.remove('show'); unlockScroll(); }
  });

  saveBtn?.addEventListener('click', () => {
    const vars = getVariablesFromTable();
    chrome.runtime.sendMessage({ type: 'SAVE_VARIABLES', variables: vars });
  });

  reloadBtn?.addEventListener('click', () => loadVariables());

  loadVariables();
}
