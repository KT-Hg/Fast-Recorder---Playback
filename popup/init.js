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
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');
  function switchTab(tabId) {
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
    tabPanels.forEach(p => p.classList.toggle('active', p.id === tabId));
    chrome.storage.local.set({ lastTab: tabId });
    if (tabId === 'settings') reloadSettings();
  }
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  chrome.storage.local.get(['lastTab'], (res) => {
    if (res?.lastTab && document.getElementById(res.lastTab)) switchTab(res.lastTab);
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
startConnectionCheck();
