/**
 * highlight.js — Popup module for the Highlight tab.
 * Communicates with content.js via chrome.tabs.sendMessage for the active tab.
 * For non-active URLs, reads/writes chrome.storage.local directly.
 */

import { showConfirm, showToast } from './utils.js';

const HL_STORAGE_KEY = 'hl_v1';

const HL_COLORS = {
  yellow: { dot: '#d97706', label: 'Yellow' },
  green:  { dot: '#059669', label: 'Green'  },
  pink:   { dot: '#db2777', label: 'Pink'   },
  blue:   { dot: '#2563eb', label: 'Blue'   },
  orange: { dot: '#ea580c', label: 'Orange' },
};

export function initHighlight() {
  const listEl       = document.getElementById('hlList');
  if (!listEl) return;

  const emptyEl      = document.getElementById('hlEmpty');
  const filterRow    = document.getElementById('hlFilterRow');
  const clearBtn     = document.getElementById('hlClearBtn');
  const urlSelect    = document.getElementById('hlUrlSelect');
  const urlClearBtn  = document.getElementById('hlUrlClearBtn');
  const statPage     = document.getElementById('hlStatPage');
  const statTotal    = document.getElementById('hlStatTotal');
  const statPages    = document.getElementById('hlStatPages');
  const tabBadge     = document.getElementById('hlTabBadge');
  const currentPage  = document.getElementById('hlCurrentPage');
  const currentUrl   = document.getElementById('hlCurrentUrl');
  const currentCount = document.getElementById('hlCurrentCount');

  let activeFilter  = '';
  let allData       = {};   // full hl_v1 storage object
  let activeTabUrl  = '';   // URL of the currently open tab
  let selectedUrl   = '';   // URL shown in the selector

  // ── Filter pills ──
  filterRow.addEventListener('click', e => {
    const pill = e.target.closest('.hl-filter-pill');
    if (!pill) return;
    activeFilter = pill.dataset.color || '';
    filterRow.querySelectorAll('.hl-filter-pill').forEach(p => {
      p.classList.toggle('active', p === pill);
    });
    render();
  });

  // ── Current tab chip click → switch to active tab view ──
  if (currentPage) {
    currentPage.addEventListener('click', () => {
      if (!activeTabUrl) return;
      selectedUrl  = activeTabUrl;
      urlSelect.value = '';
      activeFilter = '';
      filterRow.querySelectorAll('.hl-filter-pill').forEach((p, i) => p.classList.toggle('active', i === 0));
      render();
      updateStats();
      syncChipState();
    });
  }

  // ── URL selector change (other saved pages) ──
  urlSelect.addEventListener('change', () => {
    if (!urlSelect.value) return;
    selectedUrl  = urlSelect.value;
    activeFilter = '';
    filterRow.querySelectorAll('.hl-filter-pill').forEach((p, i) => p.classList.toggle('active', i === 0));
    render();
    updateStats();
    syncChipState();
  });

  // ── URL-level clear button ──
  urlClearBtn.addEventListener('click', () => {
    if (!selectedUrl) return;
    const isCurrentTab = selectedUrl === activeTabUrl;
    const label = selectedUrl.replace(/^https?:\/\//, '');

    showConfirm(
      `Clear all highlights on:\n${label}`,
      () => {
        if (isCurrentTab) {
          sendToTab({ type: 'HL_CLEAR' }, () => load());
        } else {
          chrome.storage.local.get(HL_STORAGE_KEY, res => {
            const data = res[HL_STORAGE_KEY] || {};
            delete data[selectedUrl];
            chrome.storage.local.set({ [HL_STORAGE_KEY]: data }, () => load());
          });
        }
        showToast('Highlights cleared', 'success');
      },
      { title: 'Clear highlights', danger: true, okLabel: 'Clear' }
    );
  });

  // ── Clear current page (legacy button inside list) ──
  clearBtn.addEventListener('click', () => {
    if (!selectedUrl) return;
    urlClearBtn.click(); // delegate to URL clear
  });

  // ── Refresh when content script updates storage ──
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[HL_STORAGE_KEY]) load();
  });

  // ── Load when user clicks the Highlight tab ──
  const hlTabBtn = document.querySelector('[data-tab="tabHighlight"]');
  if (hlTabBtn) hlTabBtn.addEventListener('click', load);

  // ── Load immediately if popup opens already on Highlight tab ──
  chrome.storage.local.get('lastTab', res => {
    if (res?.lastTab === 'tabHighlight') load();
  });

  // ─────────────────────────────────────────────────────────
  function sendToTab(msg, cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id) { cb?.(); return; }
      chrome.tabs.sendMessage(tab.id, msg, () => {
        void chrome.runtime.lastError;
        cb?.();
      });
    });
  }

  function load() {
    // Get active tab URL first, then read storage
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      activeTabUrl = tab?.url || '';

      chrome.storage.local.get(HL_STORAGE_KEY, res => {
        allData = res[HL_STORAGE_KEY] || {};

        // Build URL list: active tab first (even if empty), then saved URLs
        const savedUrls = Object.keys(allData).filter(u => allData[u]?.length > 0);
        const urlList   = activeTabUrl
          ? [activeTabUrl, ...savedUrls.filter(u => u !== activeTabUrl)]
          : savedUrls;

        // Restore selectedUrl or default to active tab
        if (!selectedUrl || !urlList.includes(selectedUrl)) {
          selectedUrl = activeTabUrl || urlList[0] || '';
        }

        buildUrlSelect(urlList);
        render();
        updateStats();
        updateTabBadge();
      });
    });
  }

  function buildUrlSelect(urlList) {
    // ── Current tab chip ──
    if (currentPage && currentUrl && currentCount) {
      if (activeTabUrl) {
        let label = activeTabUrl.replace(/^https?:\/\//, '');
        if (label.length > 52) label = label.slice(0, 50) + '…';
        const count = (allData[activeTabUrl] || []).length;
        currentUrl.textContent     = label;
        currentCount.textContent   = count;
        currentCount.style.display = count ? '' : 'none';
        currentPage.style.display  = '';
      } else {
        currentPage.style.display = 'none';
      }
    }
    syncChipState();

    // ── Other pages dropdown (excludes active tab) ──
    const otherUrls = urlList.filter(u => u !== activeTabUrl && (allData[u] || []).length > 0);
    urlSelect.innerHTML = '';

    if (otherUrls.length === 0) {
      const ph = document.createElement('option');
      ph.value = '';
      ph.textContent = 'No other pages';
      urlSelect.appendChild(ph);
      urlSelect.disabled = true;
      urlClearBtn.style.display = 'none';
    } else {
      urlSelect.disabled = false;
      const ph = document.createElement('option');
      ph.value = '';
      ph.textContent = '— Other pages —';
      urlSelect.appendChild(ph);

      otherUrls.forEach(url => {
        const opt   = document.createElement('option');
        opt.value   = url;
        let label   = url.replace(/^https?:\/\//, '');
        if (label.length > 48) label = label.slice(0, 46) + '…';
        const count = (allData[url] || []).length;
        opt.textContent = `${label}${count ? ` (${count})` : ''}`;
        opt.selected    = url === selectedUrl;
        urlSelect.appendChild(opt);
      });

      urlClearBtn.style.display = selectedUrl !== activeTabUrl ? '' : 'none';
    }
  }

  function syncChipState() {
    if (!currentPage) return;
    const isCurrentSelected = selectedUrl === activeTabUrl;
    currentPage.classList.toggle('hl-current-page--active', isCurrentSelected);
    // Show clear button only when a "saved" page is selected
    urlClearBtn.style.display = (!isCurrentSelected && urlSelect.value) ? '' : 'none';
  }

  function render() {
    const pageList = allData[selectedUrl] || [];
    const filtered = activeFilter
      ? pageList.filter(h => h.color === activeFilter)
      : pageList;

    clearBtn.style.display = 'none'; // hidden — URL-level clear is via urlClearBtn

    if (filtered.length === 0) {
      listEl.innerHTML = '';
      emptyEl.style.display = '';
      return;
    }
    emptyEl.style.display = 'none';

    const isCurrentTab = selectedUrl === activeTabUrl;

    listEl.innerHTML = filtered.slice().reverse().map(h => {
      const cfg = HL_COLORS[h.color] || HL_COLORS.yellow;
      const time = new Date(h.createdAt).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit',
      });
      const preview = h.text.length > 50 ? h.text.slice(0, 50) + '…' : h.text;
      return `
        <li class="hl-list-item${isCurrentTab ? '' : ' hl-list-item--remote'}" data-hl-id="${h.id}">
          <span class="hl-list-dot" style="background:${cfg.dot};"></span>
          <div class="hl-list-body">
            <div class="hl-list-text">"${esc(preview)}"</div>
            <div class="hl-list-meta">${cfg.label} · ${time}</div>
          </div>
          <button class="hl-list-del" data-id="${h.id}" title="Delete">✕</button>
        </li>`;
    }).join('');

    // Scroll-to only for current tab
    if (isCurrentTab) {
      listEl.querySelectorAll('.hl-list-item').forEach(item => {
        item.addEventListener('click', e => {
          if (e.target.closest('.hl-list-del')) return;
          const id = item.dataset.hlId;
          chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
            if (!tab?.id) return;
            chrome.tabs.sendMessage(tab.id, { type: 'HL_SCROLL_TO', id });
            window.close();
          });
        });
      });
    }

    // Delete — works for both current and remote URLs
    listEl.querySelectorAll('.hl-list-del').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const id      = btn.dataset.id;
        const hl      = (allData[selectedUrl] || []).find(h => h.id === id);
        const preview = hl ? (hl.text.length > 60 ? hl.text.slice(0, 60) + '…' : hl.text) : '';

        showConfirm(
          preview ? `"${preview}"` : 'Remove this highlight?',
          () => {
            if (isCurrentTab) {
              sendToTab({ type: 'HL_REMOVE', id }, () => load());
            } else {
              const list = (allData[selectedUrl] || []).filter(h => h.id !== id);
              if (list.length === 0) delete allData[selectedUrl];
              else allData[selectedUrl] = list;
              chrome.storage.local.set({ [HL_STORAGE_KEY]: allData }, () => load());
            }
            showToast('Highlight removed', 'success');
          },
          { title: 'Remove highlight', danger: true, okLabel: 'Remove' }
        );
      });
    });
  }

  function updateStats() {
    const pageList = allData[selectedUrl] || [];
    const allKeys  = Object.keys(allData).filter(k => allData[k]?.length > 0);
    const totalAll = allKeys.reduce((s, k) => s + allData[k].length, 0);
    statPage.textContent  = pageList.length || '0';
    statTotal.textContent = totalAll        || '0';
    statPages.textContent = allKeys.length  || '—';
  }

  function updateTabBadge() {
    if (!tabBadge) return;
    const pageCount = (allData[activeTabUrl] || []).length;
    tabBadge.textContent   = pageCount;
    tabBadge.style.display = pageCount ? 'inline-block' : 'none';
  }

  function esc(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
