/**
 * init.js — Main entry point for popup UI
 * Imports all modules and orchestrates initialization
 */

import { applyTheme, initTheme } from './theme.js';
import { startConnectionCheck } from './connection.js';
import { initScreenshots } from './screenshots.js';
import { initVariables } from './variables.js';
import { initSettings, reloadSettings } from './settings.js';
import { initMain } from './main.js';
import { initExportBookmarklet } from './export-bookmarklet.js';
import { initExportSelenium } from './export-selenium.js';

/* === Header Spacer Sync === */

function initHeaderSpacer() {
  const header = document.querySelector('.sticky-header');
  const spacer = document.getElementById('headerSpacer');
  if (!header || !spacer) return;
  function sync() { spacer.style.height = header.offsetHeight + 'px'; }
  sync();
  new MutationObserver(sync).observe(header, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['class', 'style']
  });
  window.addEventListener('resize', sync);
}

/* === Tab Navigation === */

function initTabs() {
  const tabNav = document.getElementById('tabNav');
  const tabPanels = document.querySelectorAll('.tab-panel');

  function getTabBtns() {
    return [...tabNav.querySelectorAll('.tab-btn')];
  }

  function switchTab(tabId) {
    getTabBtns().forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
    tabPanels.forEach(p => p.classList.toggle('active', p.id === tabId));
    document.body.dataset.activeTab = tabId;
    chrome.storage.local.set({ lastTab: tabId });
    if (tabId === 'tabSettings') reloadSettings();
  }

  function applyTabOrder(order) {
    if (!order || !order.length) return;
    order.forEach(tabId => {
      const btn = tabNav.querySelector(`[data-tab="${tabId}"]`);
      if (btn) tabNav.appendChild(btn);
    });
  }

  function saveTabOrder() {
    const order = getTabBtns().map(b => b.dataset.tab);
    chrome.storage.local.set({ tabOrder: order });
  }

  function initDragDrop() {
    let dragSrc = null;
    getTabBtns().forEach(btn => {
      btn.draggable = true;
      btn.addEventListener('dragstart', e => {
        dragSrc = btn;
        btn.classList.add('tab-dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      btn.addEventListener('dragend', () => {
        btn.classList.remove('tab-dragging');
        getTabBtns().forEach(b => b.classList.remove('tab-drag-over'));
        saveTabOrder();
      });
      btn.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        getTabBtns().forEach(b => b.classList.remove('tab-drag-over'));
        if (btn !== dragSrc) btn.classList.add('tab-drag-over');
      });
      btn.addEventListener('drop', e => {
        e.stopPropagation();
        if (dragSrc && btn !== dragSrc) {
          const btns = getTabBtns();
          const srcIdx = btns.indexOf(dragSrc);
          const dstIdx = btns.indexOf(btn);
          if (srcIdx < dstIdx) {
            tabNav.insertBefore(dragSrc, btn.nextSibling);
          } else {
            tabNav.insertBefore(dragSrc, btn);
          }
        }
      });
    });
  }

  getTabBtns().forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  chrome.storage.local.get(['lastTab', 'tabOrder'], (res) => {
    if (res?.tabOrder) applyTabOrder(res.tabOrder);
    initDragDrop();
    const firstTab = getTabBtns()[0]?.dataset.tab ?? 'tabRecord';
    const target = res?.lastTab && document.getElementById(res.lastTab) ? res.lastTab : firstTab;
    switchTab(target);
  });
}

/* === Bootstrap === */

initHeaderSpacer();
initTabs();
initTheme();
initScreenshots();
initVariables();
initSettings();
initMain();
initExportBookmarklet();
initExportSelenium();
startConnectionCheck();
