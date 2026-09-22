/**
 * init.js — Popup bootstrap: imports all feature modules and runs their init functions.
 *
 * Execution order matters:
 *  1. initHeaderSpacer / initTabs — structural layout must be ready before content renders.
 *  2. initTheme — applies before any elements render to avoid flash of wrong theme.
 *  3. Feature modules (screenshots, variables, settings, main, exports) — order is independent.
 *  4. startConnectionCheck — starts the PING interval after UI is ready.
 */

import { initTheme } from './theme.js';
import { startConnectionCheck } from './connection.js';
import { initScreenshots } from './screenshots.js';
import { initVariables } from './variables.js';
import { initSettings, reloadSettings } from './settings.js';
import { initMain } from './main.js';
import { initExportBookmarklet } from './export-bookmarklet.js';
import { initExportSelenium } from './export-selenium.js';
import { initImageEditor } from './image-editor.js';
import { initHighlight } from './highlight.js';
import { TABLE_COPIES } from '../dbtools/features.js';
import { initUpdateBanner } from './update-banner.js';

/**
 * Keep a spacer div below the sticky header the same height as the header.
 * The sticky header changes height when recording/playback badges appear, so
 * a MutationObserver re-measures on every structural or style change to prevent
 * content from being obscured behind the header.
 */
function initHeaderSpacer() {
  const header = document.querySelector('.sticky-header');
  const spacer = document.getElementById('headerSpacer');
  if (!header || !spacer) return;
  function sync() {
    const h = header.offsetHeight;
    spacer.style.height = h + 'px';
    document.documentElement.style.setProperty('--header-h', h + 'px');
  }
  sync();
  new MutationObserver(sync).observe(header, {
    childList: true, subtree: true, attributes: true,
    // 'hidden' — the update banner shows/hides via the attribute, not style
    attributeFilter: ['class', 'style', 'hidden']
  });
  window.addEventListener('resize', sync);
}

function initCaptureTabs() {
  const nav = document.getElementById('captureTabNav');
  if (!nav) return;
  nav.addEventListener('click', e => {
    const btn = e.target.closest('.capture-tab-btn');
    if (!btn) return;
    const tab = btn.dataset.captureTab;
    nav.querySelectorAll('.capture-tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.capture-group').forEach(g => {
      g.style.display = g.id === `captureGroup-${tab}` ? '' : 'none';
    });
  });
}

/**
 * Wire a button that opens one of the extension's full pages in its own tab.
 *
 * Both of these pages are tables too wide for a 480px popup. An already-open
 * instance is focused instead of duplicated — each page keeps state in storage
 * (the unsaved query text, the changeset being reviewed), and a second tab
 * would silently compete with the first over the same key.
 */
function initPageButton(buttonId, page) {
  const btn = document.getElementById(buttonId);
  if (!btn) return;
  const url = chrome.runtime.getURL(page);
  btn.addEventListener('click', () => {
    // Matched without the query or hash: a page opened on one session
    // (`dbtools.html?session=…`) is still the page, and a second copy of it is
    // not what the button is for.
    chrome.tabs.query({}, (tabs) => {
      const existing = (tabs || []).find((t) => t.url && t.url.split(/[?#]/)[0] === url);
      if (existing) {
        chrome.tabs.update(existing.id, { active: true });
        chrome.windows.update(existing.windowId, { focused: true });
      } else {
        chrome.tabs.create({ url });
      }
      window.close();
    });
  });
}

function initFullPages() {
  initPageButton('openSqlCases', 'sqlcases.html');
  initPageButton('openDbTools', 'dbtools.html');
  initDbGuardToggle();
  initDbStatus();
}

/**
 * The two switches on the DB Test Session card.
 *
 * The first is the master one: off, the panel disappears from the Adminer tabs
 * that are already open and nothing is recorded — an Adminer tab watches this
 * setting, so neither switch needs a page reload. The second is the Playback
 * guard (bg/dbguard.js); which database and which tables it protects are chosen
 * on the Test sessions page, so switching it on before that has been done opens
 * those settings instead of pretending to work.
 */
/**
 * The DB Test Session card's status line: the session recording right now (or
 * the one last used, when none is), with a click through to it on the manager
 * page. Kept live while the popup is open — ending a session in the Adminer tab
 * next to it shows up here straight away.
 */
function initDbStatus() {
  const line = document.getElementById('dbStatus');
  if (!line) return;
  const KEYS = ['dbtoolsSessions', 'dbtoolsActive', 'dbtoolsSettings'];
  let target = '';

  const paint = (res) => {
    const sessions = Object.values(res.dbtoolsSessions || {});
    const active = res.dbtoolsActive || {};
    const off = (res.dbtoolsSettings || {}).enabled === false;
    const recording = sessions.filter((s) => !s.closedAt && active[s.key] === s.id)
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    const latest = [...sessions].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
    const shown = recording[0] || latest;
    if (!shown || off) {
      line.hidden = true;
      target = '';
      return;
    }
    target = shown.id;
    const n = (shown.changes || []).length;
    const rec = Boolean(recording[0]);
    line.hidden = false;
    line.classList.toggle('rec', rec);
    line.replaceChildren();
    const dot = document.createElement('span');
    dot.className = 'dot';
    const label = document.createElement('span');
    label.className = 'label';
    const lead = document.createElement('span');
    lead.textContent = rec ? 'Recording: ' : 'Last session: ';
    const name = document.createElement('b');
    name.textContent = shown.name;
    label.append(lead, name);
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = `${n} change${n === 1 ? '' : 's'}`
      + (rec && recording.length > 1 ? ` · +${recording.length - 1} more` : '')
      + (rec ? '' : ' · ended');
    line.append(dot, label, sub);
    line.title = 'Open this session on the Test sessions & rollback page';
  };

  chrome.storage.local.get(KEYS, paint);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && KEYS.some((k) => changes[k])) chrome.storage.local.get(KEYS, paint);
  });
  line.addEventListener('click', () => {
    if (!target) return;
    // The background reuses an open manager tab rather than opening another.
    chrome.runtime.sendMessage({ type: 'dbtools-open-manager', sessionId: target }, () => {
      void chrome.runtime.lastError;
      window.close();
    });
  });
}

function initDbGuardToggle() {
  const enabled = document.getElementById('dbEnabledToggle');
  const box = document.getElementById('dbGuardToggle');
  if (!box || !enabled) return;
  // The guard is held back with the table snapshots it runs on (features.js).
  // The label carries an inline display, which the `hidden` attribute loses to.
  if (!TABLE_COPIES) box.closest('label').style.display = 'none';
  const KEY = 'dbtoolsSettings';

  const write = (patch) => chrome.storage.local.get([KEY], (res) => {
    chrome.storage.local.set({ [KEY]: { ...(res[KEY] || {}), ...patch } });
  });

  const paint = (settings) => {
    const guard = settings.guard || {};
    // Stored settings written before this switch existed have no `enabled` key,
    // and the integration was on for them.
    enabled.checked = settings.enabled !== false;
    box.checked = Boolean(guard.enabled && guard.key);
    box.disabled = !enabled.checked;
  };

  chrome.storage.local.get([KEY], (res) => paint(res[KEY] || {}));

  enabled.addEventListener('change', () => {
    write({ enabled: enabled.checked });
    chrome.storage.local.get([KEY], (res) => paint({ ...(res[KEY] || {}), enabled: enabled.checked }));
  });

  box.addEventListener('change', () => {
    chrome.storage.local.get([KEY], (res) => {
      const settings = res[KEY] || {};
      const guard = settings.guard || {};
      if (box.checked && !guard.key) {
        box.checked = false;
        chrome.tabs.create({ url: chrome.runtime.getURL('dbtools.html?settings=1') });
        window.close();
        return;
      }
      write({ guard: { ...guard, enabled: box.checked } });
    });
  });
}

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

/**
 * Run one bootstrap step, isolated.
 *
 * These used to be twelve bare calls. A throw in any of them — one renamed
 * element id is enough — aborted the whole sequence, so everything after it
 * never ran and the popup opened half-dead with nothing in the console pointing
 * at the cause. Now a failing module costs only itself, and says so.
 */
function step(name, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`[POPUP] ${name}() failed — the rest of the popup still loads:`, err);
  }
}

step('initHeaderSpacer',       initHeaderSpacer);
step('initTabs',               initTabs);
step('initCaptureTabs',        initCaptureTabs);
step('initFullPages',          initFullPages);
step('initTheme',              initTheme);
step('initScreenshots',        initScreenshots);
step('initVariables',          initVariables);
step('initSettings',           initSettings);
step('initMain',               initMain);
step('initExportBookmarklet',  initExportBookmarklet);
step('initExportSelenium',     initExportSelenium);
step('initImageEditor',        initImageEditor);
step('initHighlight',          initHighlight);
step('initUpdateBanner',       initUpdateBanner);
step('startConnectionCheck',   startConnectionCheck);
