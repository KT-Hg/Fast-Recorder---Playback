/**
 * utils.js
 * Common utility functions used across popup modules.
 * Exports: escHtml, ACTION_ICONS, getActionIcon, showToast, lockScroll, unlockScroll,
 *          showConfirm, showAlert, validateNumberInput, safeSendTabMessage, isEligibleTab, debounce
 */

/* === HTML Escape === */

export function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* === Action Icons === */

export const ACTION_ICONS = {
  click: '🖱', input: '⌨', navigate: '🔗', script: '⚡', hover: '👆',
  wait: '⏱', condition: '❓', switch: '🔀', dragdrop: '↕', readdom: '📖',
  screenshot: '📷', screenshot_full: '📄', screenshot_element: '📌', screenshot_tovar: '📸',
  dropdown: '▼'
};

export function getActionIcon(type) {
  return ACTION_ICONS[type] || '';
}

/* === Toast Notification === */

let _toastTimer = null;

export function showToast(msg, type = 'success') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  // Errors should interrupt AT; success/info should not.
  toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.textContent = msg;
  toast.className = `toast toast-${type} show`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
}

/* === Scroll Lock === */

let _savedScrollY = 0;

export function lockScroll() {
  _savedScrollY = document.body.scrollTop || window.scrollY || 0;
  document.body.style.top = `-${_savedScrollY}px`;
  document.body.classList.add('modal-open');
  document.documentElement.style.overflow = 'hidden';
}

export function unlockScroll() {
  document.body.classList.remove('modal-open');
  document.documentElement.style.overflow = '';
  document.body.style.top = '';
  document.body.scrollTop = _savedScrollY;
  window.scrollTo(0, _savedScrollY);
}

/* === Focus Trap (for modal dialogs) === */

const FOCUSABLE_SEL = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function trapFocus(modalEl) {
  const prevActive = document.activeElement;
  const getFocusable = () => Array.from(modalEl.querySelectorAll(FOCUSABLE_SEL))
    .filter(el => el.offsetParent !== null || el === document.activeElement);

  const focusable = getFocusable();
  if (focusable.length) focusable[0].focus();

  const handler = (e) => {
    if (e.key !== 'Tab') return;
    const items = getFocusable();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  modalEl.addEventListener('keydown', handler);

  return () => {
    modalEl.removeEventListener('keydown', handler);
    if (prevActive && typeof prevActive.focus === 'function') {
      try { prevActive.focus(); } catch (_) {}
    }
  };
}

/* === Confirm / Alert Modals === */

function _closeModal(modal, releaseFocus, extra) {
  if (modal.contains(document.activeElement)) {
    document.activeElement.blur();
  }
  modal.classList.remove('show');
  releaseFocus();
  modal.setAttribute('aria-hidden', 'true');
  if (extra) extra();
  unlockScroll();
}

export function showConfirm(msg, onConfirm, { title = 'Confirm', danger = false, okLabel = '' } = {}) {
  const modal = document.getElementById('confirmModal');
  document.getElementById('confirmModalTitle').textContent = title;
  document.getElementById('confirmModalMsg').textContent = msg;
  const okBtn = document.getElementById('confirmModalOk');
  const cancelBtn = document.getElementById('confirmModalCancel');
  okBtn.textContent = okLabel || (danger ? 'Delete' : 'Confirm');
  okBtn.className = danger ? 'danger' : '';
  cancelBtn.style.display = '';
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  lockScroll();
  const releaseFocus = trapFocus(modal);
  const close = () => _closeModal(modal, releaseFocus);
  cancelBtn.onclick = close;
  okBtn.onclick = () => { close(); onConfirm(); };
}

export function showAlert(msg, { title = 'Notice' } = {}) {
  const modal = document.getElementById('confirmModal');
  document.getElementById('confirmModalTitle').textContent = title;
  document.getElementById('confirmModalMsg').textContent = msg;
  const okBtn = document.getElementById('confirmModalOk');
  const cancelBtn = document.getElementById('confirmModalCancel');
  okBtn.textContent = 'OK';
  okBtn.className = '';
  cancelBtn.style.display = 'none';
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  lockScroll();
  const releaseFocus = trapFocus(modal);
  const close = () => _closeModal(modal, releaseFocus, () => { cancelBtn.style.display = ''; });
  cancelBtn.onclick = close;
  okBtn.onclick = close;
}

/* === Validation === */

export function validateNumberInput(input, min = 0) {
  const value = parseInt(input.value, 10);
  if (input.value && (isNaN(value) || value < min)) {
    input.classList.add('required-error');
    setTimeout(() => {
      input.classList.remove('required-error');
    }, 2000);
    return false;
  }
  input.classList.remove('required-error');
  return true;
}

/* === Tab Messaging === */

export function safeSendTabMessage(tabId, payload) {
  chrome.tabs.sendMessage(tabId, payload, () => {
    if (chrome.runtime.lastError) {
      return;
    }
  });
}

export function isEligibleTab(tab) {
  if (!tab?.url) return false;
  const url = tab.url;
  return (
    url.startsWith('http:') ||
    url.startsWith('https:') ||
    url.startsWith('file:') ||
    url.startsWith('ftp:') ||
    url.startsWith('ws:') ||
    url.startsWith('wss:')
  );
}

/* === Debounce === */

export function debounce(fn, delay = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}
