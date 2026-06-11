/**
 * highlight.js — Popup module for the Highlight tab.
 * Communicates with content.js via chrome.tabs.sendMessage for the active tab.
 * For non-active URLs, reads/writes chrome.storage.local directly.
 */

import { showConfirm, showToast } from './utils.js';

const HL_STORAGE_KEY  = 'hl_v1';
const HL_PATTERNS_KEY = 'hl_patterns_v1';

const HL_COLORS = {
  yellow: { dot: '#fde047', label: 'Yellow' },
  green:  { dot: '#86efac', label: 'Green'  },
  pink:   { dot: '#f9a8d4', label: 'Pink'   },
  blue:   { dot: '#93c5fd', label: 'Blue'   },
  orange: { dot: '#fdba74', label: 'Orange' },
};

const SWATCH_BADGE_IDS = {
  yellow: 'hlBadgeYellow',
  green:  'hlBadgeGreen',
  pink:   'hlBadgePink',
  blue:   'hlBadgeBlue',
  orange: 'hlBadgeOrange',
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
  const hlPageDomain = document.getElementById('hlPageDomain');
  const hlPageCount  = document.getElementById('hlPageCount');
  const searchInput  = document.getElementById('hlSearch');
  // Header / toggle
  const hlToggle     = document.getElementById('hlToggle');
  const hlModePill   = document.getElementById('hlModePill');
  const hlModeLabel  = document.getElementById('hlModeLabel');
  const hlExportBtn  = document.getElementById('hlExportBtn');
  // Pattern editor
  const patternHeader      = document.getElementById('hlPatternHeader');
  const patternInput       = document.getElementById('hlPatternInput');
  const patternAddBtn      = document.getElementById('hlPatternAddBtn');
  const patternList        = document.getElementById('hlPatternList');
  const patternBody        = document.getElementById('hlPatternBody');
  const patternCaret       = document.getElementById('hlPatternCaret');
  const hlPatternCopyAll   = document.getElementById('hlPatternCopyAll');
  const hlValMsg           = document.getElementById('hlValMsg');
  // URL Builder
  const hlUrlBuilder        = document.getElementById('hlUrlBuilder');
  const hlBuilderTrigger    = document.getElementById('hlBuilderTrigger');
  const hlBuilderHost       = document.getElementById('hlBuilderHost');
  const hlBuilderPanel      = document.getElementById('hlBuilderPanel');
  const hlBuilderSegments   = document.getElementById('hlBuilderSegments');
  const hlBuilderPreview    = document.getElementById('hlBuilderPreview');
  const hlBuilderUse        = document.getElementById('hlBuilderUse');

  let activeFilter  = '';
  let searchQuery   = '';
  let allData       = {};
  let activeTabUrl  = '';
  let selectedUrl   = '';
  let patterns      = [];

  // Builder state
  let builderDomain = '';
  let builderSegs   = [];   // raw path segments from current tab
  let builderStates = [];   // 'exact' | 'any' | 'end' per segment

  // ── URL normalisation (mirrors content.js logic) ──
  function hlMatchPattern(url, pattern) {
    const strip = s => s.replace(/^https?:\/\//, '');
    const escaped = strip(pattern)
      .replace(/[.+?^${}()|[\]\\]/g, c => '\\' + c)
      .replace(/\*/g, '[^/]+');
    try { return new RegExp('^' + escaped + '(/.*)?$').test(strip(url)); }
    catch (_) { return false; }
  }

  function hlNormalizeUrl(url) {
    for (const p of patterns) {
      if (hlMatchPattern(url, p)) return p;
    }
    return url;
  }

  // ── Header / Toggle ──
  function syncToggleUI() {
    if (!hlToggle) return;
    const on = hlToggle.checked;
    if (hlModePill)  hlModePill.classList.toggle('hl-mode-pill--off', !on);
    if (hlModeLabel) hlModeLabel.textContent = on ? 'Highlight ON' : 'Highlight OFF';
  }

  if (hlToggle) {
    chrome.storage.local.get('hl_enabled', res => {
      hlToggle.checked = res.hl_enabled !== false;
      syncToggleUI();
    });

    hlToggle.addEventListener('change', () => {
      const on = hlToggle.checked;
      chrome.storage.local.set({ hl_enabled: on });
      sendToTab({ type: 'HL_SET_ENABLED', enabled: on });
      syncToggleUI();
    });
  }

  // ── Export ──
  if (hlExportBtn) {
    hlExportBtn.addEventListener('click', () => {
      const data = JSON.stringify(allData, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = 'highlights.json';
      a.click();
      URL.revokeObjectURL(url);
      showToast('Highlights exported', 'success');
    });
  }

  // ── Filter row: "All" pill + color swatches ──
  filterRow.addEventListener('click', e => {
    const allPill = e.target.closest('.hl-pill-all');
    const swatch  = e.target.closest('.hl-swatch');
    if (!allPill && !swatch) return;

    filterRow.querySelector('.hl-pill-all')?.classList.remove('active');
    filterRow.querySelectorAll('.hl-swatch').forEach(s => s.classList.remove('active'));

    if (allPill) {
      allPill.classList.add('active');
      activeFilter = '';
    } else {
      swatch.classList.add('active');
      activeFilter = swatch.dataset.color || '';
    }
    render();
  });

  // ── Search ──
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value.trim().toLowerCase();
      render();
    });
  }

  // ── Current tab context card click → switch to active tab view ──
  if (currentPage) {
    currentPage.addEventListener('click', () => {
      if (!activeTabUrl) return;
      selectedUrl = hlNormalizeUrl(activeTabUrl);
      urlSelect.value = '';
      activeFilter    = '';
      searchQuery     = '';
      if (searchInput) searchInput.value = '';
      resetFilter();
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
    searchQuery  = '';
    if (searchInput) searchInput.value = '';
    resetFilter();
    render();
    updateStats();
    syncChipState();
  });

  // ── URL-level clear button ──
  urlClearBtn.addEventListener('click', () => {
    if (!selectedUrl) return;
    const isCurrentTab = selectedUrl === hlNormalizeUrl(activeTabUrl);
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
    urlClearBtn.click();
  });

  // ── Refresh when content script updates storage ──
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes[HL_STORAGE_KEY] || changes[HL_PATTERNS_KEY])) load();
  });

  // ── Load when user clicks the Highlight tab ──
  const hlTabBtn = document.querySelector('[data-tab="tabHighlight"]');
  if (hlTabBtn) hlTabBtn.addEventListener('click', load);

  // ── Load immediately if popup opens already on Highlight tab ──
  chrome.storage.local.get('lastTab', res => {
    if (res?.lastTab === 'tabHighlight') load();
  });

  // ── Pattern card (accordion) ──
  if (patternHeader && patternBody) {
    chrome.storage.local.get('hl_pattern_open', res => {
      if (res.hl_pattern_open) {
        patternBody.style.display = 'block';
        patternCaret?.classList.add('hl-pattern-caret--open');
      }
    });

    patternHeader.addEventListener('click', e => {
      if (e.target.closest('#hlPatternCopyAll')) return;
      const open = patternBody.style.display !== 'none';
      patternBody.style.display = open ? 'none' : 'block';
      patternCaret?.classList.toggle('hl-pattern-caret--open', !open);
      chrome.storage.local.set({ hl_pattern_open: !open });
    });
  }

  // ── URL Builder: trigger toggle ──
  if (hlBuilderTrigger && hlBuilderPanel) {
    hlBuilderTrigger.addEventListener('click', () => {
      const isOpen = hlBuilderPanel.style.display !== 'none';
      hlBuilderPanel.style.display = isOpen ? 'none' : 'block';
      hlBuilderTrigger.classList.toggle('open', !isOpen);
    });
  }

  function initBuilder(url) {
    if (!url || !hlUrlBuilder) return;
    let u;
    try { u = new URL(url); } catch { return; }

    // Skip non-http tabs (chrome://, about:, file://)
    if (!['http:', 'https:'].includes(u.protocol)) {
      hlUrlBuilder.style.display = 'none';
      return;
    }

    builderDomain = u.hostname;
    builderSegs   = u.pathname.split('/').filter(Boolean);
    builderStates = builderSegs.map(() => 'exact');

    if (hlBuilderHost) {
      let host = builderDomain + (builderSegs.length ? '/…' : '');
      if (host.length > 36) host = host.slice(0, 34) + '…';
      hlBuilderHost.textContent = host;
    }
    hlUrlBuilder.style.display = '';
    renderBuilder();
  }

  function buildPatternStr() {
    const endIdx = builderStates.indexOf('end');
    const active  = endIdx === -1 ? builderSegs.length : endIdx;
    let pat = builderDomain;
    for (let i = 0; i < active; i++) {
      pat += '/' + (builderStates[i] === 'any' ? '*' : builderSegs[i]);
    }
    return pat;
  }

  function renderBuilder() {
    if (!hlBuilderSegments) return;
    hlBuilderSegments.innerHTML = '';

    const endIdx = builderStates.indexOf('end');

    // Domain chip — always literal, not clickable
    const domChip = document.createElement('span');
    domChip.className = 'hl-seg hl-seg--domain';
    domChip.title = builderDomain;
    domChip.textContent = builderDomain;
    hlBuilderSegments.appendChild(domChip);

    builderSegs.forEach((seg, i) => {
      const sep = document.createElement('span');
      sep.className = 'hl-seg-sep';
      sep.textContent = '/';

      const state    = builderStates[i];
      const isEnd    = endIdx !== -1 && i >= endIdx;
      const chipState = isEnd ? 'end' : state;

      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `hl-seg hl-seg--${chipState}`;
      chip.textContent = chipState === 'any' ? '*' : seg;
      chip.title = chipState === 'exact'
        ? 'Exact match — click → wildcard (*)'
        : chipState === 'any'
          ? 'Wildcard (*) — click → exclude from pattern'
          : 'Excluded — click to re-include';

      chip.addEventListener('click', () => {
        if (chipState === 'end') {
          // Re-include: set this and all following back to 'exact'
          for (let j = i; j < builderStates.length; j++) builderStates[j] = 'exact';
        } else {
          const next = { exact: 'any', any: 'end' };
          builderStates[i] = next[state];
        }
        renderBuilder();
      });

      hlBuilderSegments.appendChild(sep);
      hlBuilderSegments.appendChild(chip);
    });

    // Update preview
    const pat = buildPatternStr();
    if (hlBuilderPreview) hlBuilderPreview.textContent = pat;
    if (hlBuilderUse) {
      hlBuilderUse.onclick = () => {
        if (patternInput) { patternInput.value = pat; patternInput.focus(); }
      };
    }
  }

  // ── Copy-all patterns ──
  if (hlPatternCopyAll) {
    hlPatternCopyAll.addEventListener('click', e => {
      e.stopPropagation();
      if (!patterns.length) return;
      navigator.clipboard.writeText(patterns.join('\n')).then(() => {
        showToast('Patterns copied to clipboard', 'success');
      }).catch(() => showToast('Copy failed', 'error'));
    });
  }

  if (patternAddBtn && patternInput) {
    patternAddBtn.addEventListener('click', () => addPattern());
    patternInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') addPattern();
    });
  }

  function addPattern() {
    const raw = patternInput?.value.trim();
    if (!raw) return;
    const val = raw.replace(/^https?:\/\//, '');

    if (val.includes(' ')) {
      showValMsg('Pattern must not contain spaces', 'error');
      return;
    }
    if (!val.includes('.') && !val.includes('*')) {
      showValMsg('Pattern looks incomplete — add a domain or wildcard', 'warn');
      return;
    }
    if (patterns.includes(val)) {
      showValMsg('Pattern already exists', 'warn');
      patternInput.value = '';
      return;
    }

    patterns = [...patterns, val];
    savePatterns();
    patternInput.value = '';
    showValMsg('Pattern added', 'success');
  }

  function showValMsg(text, type) {
    if (!hlValMsg) return;
    hlValMsg.textContent = text;
    hlValMsg.className = `hl-val-msg hl-val-msg--${type}`;
    hlValMsg.style.display = '';
    clearTimeout(hlValMsg._t);
    hlValMsg._t = setTimeout(() => { if (hlValMsg) hlValMsg.style.display = 'none'; }, 3000);
  }

  function savePatterns() {
    chrome.storage.local.set({ [HL_PATTERNS_KEY]: patterns }, () => {
      sendToTab({ type: 'HL_PATTERNS_UPDATED', patterns });
      renderPatterns();
      load();
    });
  }

  function renderPatterns() {
    if (!patternList) return;
    patternList.innerHTML = '';

    if (hlPatternCopyAll) hlPatternCopyAll.style.display = patterns.length ? '' : 'none';

    if (!patterns.length) {
      const li = document.createElement('li');
      li.className = 'hl-pattern-empty';
      li.textContent = 'No patterns defined';
      patternList.appendChild(li);
      return;
    }
    patterns.forEach((p, idx) => {
      const li = document.createElement('li');
      li.className = 'hl-pattern-item';
      const matchCount = Object.keys(allData).filter(u => hlMatchPattern(u, p) || u === p).length;
      const display = p.replace(/\*/g, '<span class="hl-pattern-wildcard">*</span>');
      li.innerHTML = `
        <span class="hl-pattern-item-text">${display}</span>
        ${matchCount ? `<span class="hl-pattern-item-count">${matchCount} URL${matchCount > 1 ? 's' : ''}</span>` : ''}
        <button class="hl-pattern-item-del" data-idx="${idx}" title="Remove pattern">✕</button>`;
      patternList.appendChild(li);
    });
    patternList.querySelectorAll('.hl-pattern-item-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.idx);
        patterns = patterns.filter((_, i) => i !== idx);
        savePatterns();
      });
    });
  }

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
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      activeTabUrl = tab?.url || '';

      chrome.storage.local.get([HL_STORAGE_KEY, HL_PATTERNS_KEY], res => {
        allData  = res[HL_STORAGE_KEY]  || {};
        patterns = res[HL_PATTERNS_KEY] || [];

        const normalizedTabUrl = hlNormalizeUrl(activeTabUrl);

        const savedUrls = Object.keys(allData).filter(u => allData[u]?.length > 0);
        const urlList   = activeTabUrl
          ? [normalizedTabUrl, ...savedUrls.filter(u => u !== normalizedTabUrl)]
          : savedUrls;

        if (!selectedUrl || !urlList.includes(selectedUrl)) {
          selectedUrl = normalizedTabUrl || urlList[0] || '';
        }

        buildUrlSelect(urlList);
        initBuilder(activeTabUrl);
        render();
        updateStats();
        updateTabBadge();
        updateSwatchBadges();
        renderPatterns();
      });
    });
  }

  function buildUrlSelect(urlList) {
    const normalizedTabUrl = hlNormalizeUrl(activeTabUrl);

    // Current tab context card
    if (currentPage) {
      if (activeTabUrl) {
        let label = activeTabUrl.replace(/^https?:\/\//, '');
        if (label.length > 45) label = label.slice(0, 43) + '…';
        const pageCount = (allData[normalizedTabUrl] || []).length;
        if (hlPageDomain) hlPageDomain.textContent = label;
        if (hlPageCount)  hlPageCount.textContent  = pageCount || '0';
        currentPage.style.display = '';
        currentPage.title = normalizedTabUrl !== activeTabUrl
          ? `Grouped under pattern: ${normalizedTabUrl}`
          : 'View highlights for the current tab';
      } else {
        currentPage.style.display = 'none';
      }
    }
    syncChipState();

    // Other pages dropdown (excludes active tab key)
    const otherUrls = urlList.filter(u => u !== normalizedTabUrl && (allData[u] || []).length > 0);
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

      urlClearBtn.style.display = selectedUrl !== normalizedTabUrl ? '' : 'none';
    }
  }

  function syncChipState() {
    if (!currentPage) return;
    const isCurrentSelected = selectedUrl === hlNormalizeUrl(activeTabUrl);
    urlClearBtn.style.display = (!isCurrentSelected && urlSelect.value) ? '' : 'none';
  }

  function resetFilter() {
    filterRow.querySelector('.hl-pill-all')?.classList.add('active');
    filterRow.querySelectorAll('.hl-swatch').forEach(s => s.classList.remove('active'));
    activeFilter = '';
  }

  function render() {
    const pageList = allData[selectedUrl] || [];

    let filtered = activeFilter
      ? pageList.filter(h => h.color === activeFilter)
      : pageList;

    if (searchQuery) {
      filtered = filtered.filter(h =>
        h.text.toLowerCase().includes(searchQuery)
      );
    }

    clearBtn.style.display = 'none';

    if (filtered.length === 0) {
      listEl.innerHTML = '';
      emptyEl.style.display = '';
      return;
    }
    emptyEl.style.display = 'none';

    const isCurrentTab = selectedUrl === hlNormalizeUrl(activeTabUrl);

    listEl.innerHTML = filtered.slice().reverse().map(h => {
      const cfg     = HL_COLORS[h.color] || HL_COLORS.yellow;
      const now     = Date.now();
      const diff    = now - h.createdAt;
      const relTime = diff < 60000
        ? 'just now'
        : diff < 3600000
          ? `${Math.floor(diff / 60000)}m ago`
          : diff < 86400000
            ? `${Math.floor(diff / 3600000)}h ago`
            : new Date(h.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const preview = h.text.length > 60 ? h.text.slice(0, 60) + '…' : h.text;
      const excerptHtml = searchQuery ? `<div class="hl-list-excerpt">${buildExcerpt(h.text)}</div>` : '';
      const remoteLabel = isCurrentTab ? '' : esc(selectedUrl.replace(/^https?:\/\//, '').slice(0, 30)) + ' · ';

      return `
        <li class="hl-list-item${isCurrentTab ? '' : ' hl-list-item--remote'}" data-hl-id="${h.id}">
          <div class="hl-list-accent" style="background:${cfg.dot};"></div>
          <div class="hl-list-body">
            <div class="hl-list-text">${esc(preview)}</div>
            ${excerptHtml}
            <div class="hl-list-meta">
              ${remoteLabel ? `<span>${remoteLabel}</span><span class="hl-list-meta-sep">·</span>` : ''}
              <span>${cfg.label}</span>
              <span class="hl-list-meta-sep">·</span>
              <span>${relTime}</span>
            </div>
          </div>
          <div class="hl-list-actions">
            <button class="hl-list-copy" data-text="${esc(h.text)}" title="Copy text">⧉</button>
            <button class="hl-list-del" data-id="${h.id}" title="Delete">✕</button>
          </div>
        </li>`;
    }).join('');

    // Scroll-to only for current tab
    if (isCurrentTab) {
      listEl.querySelectorAll('.hl-list-item').forEach(item => {
        item.addEventListener('click', e => {
          if (e.target.closest('.hl-list-del') || e.target.closest('.hl-list-copy')) return;
          const id = item.dataset.hlId;
          chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
            if (!tab?.id) return;
            chrome.tabs.sendMessage(tab.id, { type: 'HL_SCROLL_TO', id });
            window.close();
          });
        });
      });
    }

    // Copy text button
    listEl.querySelectorAll('.hl-list-copy').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        navigator.clipboard.writeText(btn.dataset.text || '').then(() => {
          showToast('Copied', 'success');
        });
      });
    });

    // Delete
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

  function buildExcerpt(text) {
    const idx = text.toLowerCase().indexOf(searchQuery);
    if (idx === -1) return esc(text.length > 60 ? text.slice(0, 60) + '…' : text);
    const start  = Math.max(0, idx - 20);
    const before = esc((start > 0 ? '…' : '') + text.slice(start, idx));
    const match  = esc(text.slice(idx, idx + searchQuery.length));
    const after  = esc(text.slice(idx + searchQuery.length, idx + searchQuery.length + 40));
    return `${before}<mark>${match}</mark>${after}${text.length > idx + searchQuery.length + 40 ? '…' : ''}`;
  }

  function updateStats() {
    const pageList = allData[selectedUrl] || [];
    const allKeys  = Object.keys(allData).filter(k => allData[k]?.length > 0);
    const totalAll = allKeys.reduce((s, k) => s + allData[k].length, 0);
    statPage.textContent  = pageList.length || '0';
    statTotal.textContent = totalAll        || '0';
    statPages.textContent = allKeys.length  || '—';

    renderColorBar('hlStatBarPage', pageList);
    const allHighlights = allKeys.flatMap(k => allData[k]);
    renderColorBar('hlStatBarTotal', allHighlights);
  }

  function renderColorBar(id, list) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!list.length) { el.innerHTML = ''; return; }
    const counts = {};
    list.forEach(h => { counts[h.color] = (counts[h.color] || 0) + 1; });
    el.innerHTML = Object.entries(counts).map(([color, n]) => {
      const cfg = HL_COLORS[color] || HL_COLORS.yellow;
      return `<div class="hl-stat-colorbar-seg" style="background:${cfg.dot};flex:${n};" title="${cfg.label}: ${n}"></div>`;
    }).join('');
  }

  function updateTabBadge() {
    if (!tabBadge) return;
    const pageCount = (allData[hlNormalizeUrl(activeTabUrl)] || []).length;
    tabBadge.textContent   = pageCount;
    tabBadge.style.display = pageCount ? 'inline-block' : 'none';
  }

  function updateSwatchBadges() {
    const pageList = allData[selectedUrl] || [];
    Object.entries(SWATCH_BADGE_IDS).forEach(([color, id]) => {
      const el = document.getElementById(id);
      if (!el) return;
      const n = pageList.filter(h => h.color === color).length;
      el.textContent    = n > 0 ? n : '';
      el.style.display  = n > 0 ? '' : 'none';
    });
  }

  function esc(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
