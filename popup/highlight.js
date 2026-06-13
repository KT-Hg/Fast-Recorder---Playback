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
  // Stats — bar IDs (compact) + detail IDs (expanded)
  const statPage     = document.getElementById('hlStatPage');
  const statTotal    = document.getElementById('hlStatTotal');
  const statPages    = document.getElementById('hlStatPages');
  const statPageD    = document.getElementById('hlStatPageDetail');
  const statTotalD   = document.getElementById('hlStatTotalDetail');
  const statPagesD   = document.getElementById('hlStatPagesDetail');
  const statsDetailBtn = document.getElementById('hlStatsDetailBtn');
  const statsDetail    = document.getElementById('hlStatsDetail');
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
  // Manual add form
  const hlAddTrigger    = document.getElementById('hlAddTrigger');
  const hlAddForm       = document.getElementById('hlAddForm');
  const hlAddText       = document.getElementById('hlAddText');
  const hlAddSubmitBtn  = document.getElementById('hlAddSubmitBtn');
  const hlAddCancelBtn  = document.getElementById('hlAddCancelBtn');
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
  let builderDomain           = '';
  let builderDomainParts      = []; // hostname split by '.'
  let builderDomainPartStates = []; // 'exact' | 'wildcard' | 'fixed' per domain part
  let builderSegs             = []; // path segments
  let builderStates           = []; // 'exact' | 'any' | 'end' per path segment

  // ── URL normalisation (mirrors content.js logic) ──
  // Supports * in both path segments AND subdomain (e.g. *.myapp.com/path)
  function hlMatchPattern(url, pattern) {
    const strip = s => s.replace(/^https?:\/\//, '');
    // Escape all regex special chars except *, then convert * → [^/]+
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

  // ── Stats detail toggle ──
  if (statsDetailBtn && statsDetail) {
    statsDetailBtn.addEventListener('click', () => {
      const open = statsDetail.classList.toggle('open');
      statsDetailBtn.textContent = open ? '▴ Details' : '▾ Details';
    });
  }

  // ── Manual add form ──
  let addSelectedColor = 'yellow';

  if (hlAddTrigger && hlAddForm) {
    hlAddTrigger.addEventListener('click', () => {
      hlAddForm.classList.toggle('open');
      if (hlAddForm.classList.contains('open')) hlAddText?.focus();
    });
  }

  if (hlAddForm) {
    // Color dot selection
    hlAddForm.querySelectorAll('.hl-add-cdot').forEach(dot => {
      dot.addEventListener('click', () => {
        hlAddForm.querySelectorAll('.hl-add-cdot').forEach(d => d.classList.remove('sel'));
        dot.classList.add('sel');
        addSelectedColor = dot.dataset.color || 'yellow';
      });
    });

    if (hlAddCancelBtn) {
      hlAddCancelBtn.addEventListener('click', () => {
        hlAddForm.classList.remove('open');
        if (hlAddText) hlAddText.value = '';
      });
    }

    if (hlAddSubmitBtn) {
      hlAddSubmitBtn.addEventListener('click', () => {
        const text = hlAddText?.value.trim();
        if (!text) { showToast('Enter text to highlight', 'warn'); return; }
        if (!selectedUrl) { showToast('No page selected', 'warn'); return; }
        const list = allData[selectedUrl] || [];
        if (list.some(h => h.text === text)) { showToast('Already exists', 'warn'); return; }
        list.push({ id: crypto.randomUUID(), text, color: addSelectedColor, createdAt: Date.now() });
        allData[selectedUrl] = list;
        chrome.storage.local.set({ [HL_STORAGE_KEY]: allData }, () => {
          hlAddForm.classList.remove('open');
          if (hlAddText) hlAddText.value = '';
          render();
          updateStats();
          updateSwatchBadges();
          showToast('Highlight added', 'success');
        });
      });
    }
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
    const dParts  = builderDomain.split('.');
    // Only lock the last part (TLD). Everything before it is toggleable.
    // For single-part hosts (localhost, IP segments handled separately) nothing is locked.
    const tldIdx = dParts.length - 1;
    builderDomainParts      = dParts;
    builderDomainPartStates = dParts.map((_, i) => i < tldIdx ? 'exact' : 'fixed');
    builderSegs   = u.pathname.split('/').filter(Boolean);
    builderStates = builderSegs.map(() => 'exact');

    hlUrlBuilder.style.display = '';
    renderBuilder();
  }

  function buildPatternStr() {
    const endIdx   = builderStates.indexOf('end');
    const active   = endIdx === -1 ? builderSegs.length : endIdx;
    const domainStr = builderDomainParts
      .map((p, i) => builderDomainPartStates[i] === 'wildcard' ? '*' : p)
      .join('.');
    let pat = domainStr;
    for (let i = 0; i < active; i++) {
      pat += '/' + (builderStates[i] === 'any' ? '*' : builderSegs[i]);
    }
    return pat;
  }

  function renderBuilder() {
    if (!hlBuilderSegments) return;
    hlBuilderSegments.innerHTML = '';

    const endIdx = builderStates.indexOf('end');

    // ── Domain parts (split by '.') ──
    builderDomainParts.forEach((part, i) => {
      if (i > 0) {
        const dotSep = document.createElement('span');
        dotSep.className = 'hl-seg-sep';
        dotSep.textContent = '.';
        hlBuilderSegments.appendChild(dotSep);
      }

      const state = builderDomainPartStates[i];

      if (state === 'fixed') {
        const chip = document.createElement('span');
        chip.className = 'hl-seg hl-seg--domain';
        chip.textContent = part;
        chip.title = 'TLD — fixed';
        hlBuilderSegments.appendChild(chip);
      } else {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `hl-seg hl-seg--${state === 'wildcard' ? 'any' : 'exact'}`;
        chip.textContent = state === 'wildcard' ? '*' : part;
        chip.title = state === 'wildcard'
          ? `Wildcard (*) — click for exact (${part})`
          : `${part} — click for wildcard (*)`;
        chip.addEventListener('click', () => {
          builderDomainPartStates[i] = state === 'exact' ? 'wildcard' : 'exact';
          renderBuilder();
        });
        hlBuilderSegments.appendChild(chip);
      }
    });

    // ── Path segments (split by '/') ──
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

    // Update trigger host label
    if (hlBuilderHost) {
      const domStr = builderDomainParts
        .map((p, i) => builderDomainPartStates[i] === 'wildcard' ? '*' : p)
        .join('.');
      let host = domStr + (builderSegs.length ? '/…' : '');
      if (host.length > 36) host = host.slice(0, 34) + '…';
      hlBuilderHost.textContent = host;
    }

    // Update preview + Use button
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
      const matchCount  = Object.keys(allData).filter(u => hlMatchPattern(u, p) || u === p).length;
      const isWildcard  = p.includes('*');
      const isLocalhost = /^(localhost|127\.|0\.0\.0\.)/.test(p);
      const badgeClass  = isLocalhost ? 'hl-pattern-badge hl-pattern-badge--local'
                        : isWildcard  ? 'hl-pattern-badge hl-pattern-badge--wildcard'
                        : 'hl-pattern-badge';
      const badgeLabel  = isLocalhost ? 'local' : isWildcard ? '* wildcard' : 'exact';
      const display     = p.replace(/\*/g, '<span class="hl-pattern-wildcard">*</span>');
      li.innerHTML = `
        <span class="${badgeClass}">${badgeLabel}</span>
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

    // Toggle visibility (not display) so the button's slot is always reserved —
    // showing/hiding it must not shift the URL card below.
    clearBtn.style.visibility = filtered.length ? 'visible' : 'hidden';

    if (filtered.length === 0) {
      listEl.innerHTML = '';
      emptyEl.style.display = '';
      return;
    }
    emptyEl.style.display = 'none';

    const isCurrentTab = selectedUrl === hlNormalizeUrl(activeTabUrl);
    const otherUrls    = Object.keys(allData)
      .filter(u => u !== selectedUrl && (allData[u] || []).length > 0);

    // Build list using action-list template
    listEl.innerHTML = '';
    filtered.forEach((h, i) => {
      const cfg      = HL_COLORS[h.color] || HL_COLORS.yellow;
      const disabled = !!h.disabled;
      const preview  = h.text.length > 70 ? h.text.slice(0, 70) + '…' : h.text;

      // ── Main li: .index + .type + .value (no btn-row in innerHTML) ──
      const li = document.createElement('li');
      li.className = `action hl-${h.color}${disabled ? ' hl-disabled' : ''}`;
      li.dataset.hlId = h.id;
      li.innerHTML = `
        <span class="index">${i + 1}</span>
        <span class="type">${cfg.label}</span>
        <span class="value">${searchQuery ? buildExcerpt(h.text) : esc(preview)}</span>`;

      // ── btn-row: DOM element, buttons with secondary/danger class ──
      const btnRow  = document.createElement('div');
      btnRow.className = 'btn-row';

      const disBtn  = document.createElement('button');
      disBtn.className   = 'secondary';
      disBtn.textContent = disabled ? 'Enable' : 'Disable';

      const copyBtn = document.createElement('button');
      copyBtn.className   = 'secondary';
      copyBtn.textContent = 'Copy';

      const editBtn = document.createElement('button');
      editBtn.className   = 'secondary';
      editBtn.textContent = 'Edit';

      const delBtn  = document.createElement('button');
      delBtn.className   = 'danger';
      delBtn.textContent = 'Delete';

      btnRow.append(disBtn, copyBtn, editBtn, delBtn);
      li.appendChild(btnRow);

      // ── Color picker sub-row ──
      const colorRow = document.createElement('div');
      colorRow.className = 'hl-color-picker-row';
      const colorLabel = document.createElement('span');
      colorLabel.style.cssText = 'font-size:10px;color:var(--muted)';
      colorLabel.textContent = 'Color:';
      colorRow.appendChild(colorLabel);
      const colorDots = Object.keys(HL_COLORS).map(c => {
        const dot = document.createElement('div');
        dot.className = `hl-add-cdot ${c}${c === h.color ? ' sel' : ''}`;
        dot.title = HL_COLORS[c].label;
        dot.dataset.color = c;
        return dot;
      });
      colorDots.forEach(d => colorRow.appendChild(d));
      const colorClose = document.createElement('button');
      colorClose.className   = 'secondary';
      colorClose.style.marginLeft = 'auto';
      colorClose.textContent = '✕';
      colorRow.appendChild(colorClose);

      // ── Copy-to-URL sub-row ──
      const copyRow = document.createElement('div');
      copyRow.className = 'hl-copy-url-row';
      const copyArrow = document.createElement('span');
      copyArrow.style.cssText = 'font-size:10px;color:var(--muted)';
      copyArrow.textContent = '→';
      const copyRowSel = document.createElement('select');
      copyRowSel.className = 'copy-url-sel';
      const defOpt = document.createElement('option');
      defOpt.value = '';
      defOpt.textContent = otherUrls.length ? '— Pick page —' : 'No other pages';
      copyRowSel.appendChild(defOpt);
      otherUrls.forEach(u => {
        const opt = document.createElement('option');
        opt.value = u;
        let label = u.replace(/^https?:\/\//, '');
        if (label.length > 44) label = label.slice(0, 42) + '…';
        opt.textContent = label;
        copyRowSel.appendChild(opt);
      });
      if (!otherUrls.length) copyRowSel.disabled = true;
      const copyRowGo = document.createElement('button');
      copyRowGo.className   = 'secondary';
      copyRowGo.textContent = 'Add';
      if (!otherUrls.length) copyRowGo.disabled = true;
      const copyClose = document.createElement('button');
      copyClose.className   = 'secondary';
      copyClose.style.marginLeft = 'auto';
      copyClose.textContent = '✕';
      copyRow.append(copyArrow, copyRowSel, copyRowGo, copyClose);

      listEl.appendChild(li);
      listEl.appendChild(colorRow);
      listEl.appendChild(copyRow);

      // ── Disable / Enable ──
      disBtn.addEventListener('click', e => {
        e.stopPropagation();
        const list = allData[selectedUrl] || [];
        const item = list.find(x => x.id === h.id);
        if (!item) return;
        item.disabled = !item.disabled;
        chrome.storage.local.set({ [HL_STORAGE_KEY]: allData }, () => {
          const msgType = item.disabled ? 'HL_SET_HIDDEN' : 'HL_RESTORE';
          if (isCurrentTab) sendToTab({ type: msgType, id: h.id });
          render();
          updateStats();
        });
      });

      // ── Edit → open color picker row ──
      editBtn.addEventListener('click', e => {
        e.stopPropagation();
        const isOpen = colorRow.classList.contains('open');
        listEl.querySelectorAll('.hl-color-picker-row.open, .hl-copy-url-row.open').forEach(r => r.classList.remove('open'));
        if (!isOpen) colorRow.classList.add('open');
      });

      // Color dot click
      colorDots.forEach(dot => {
        dot.addEventListener('click', () => {
          const newColor = dot.dataset.color;
          const list = allData[selectedUrl] || [];
          const item = list.find(x => x.id === h.id);
          if (!item || item.color === newColor) return;
          item.color = newColor;
          chrome.storage.local.set({ [HL_STORAGE_KEY]: allData }, () => {
            if (isCurrentTab) sendToTab({ type: 'HL_UPDATE_COLOR', id: h.id, color: newColor });
            colorRow.classList.remove('open');
            render();
          });
        });
      });

      colorClose.addEventListener('click', e => {
        e.stopPropagation();
        colorRow.classList.remove('open');
      });

      // ── Copy ──
      copyBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (!otherUrls.length) {
          navigator.clipboard.writeText(h.text).then(() => showToast('Copied', 'success'));
          return;
        }
        const isOpen = copyRow.classList.contains('open');
        listEl.querySelectorAll('.hl-color-picker-row.open, .hl-copy-url-row.open').forEach(r => r.classList.remove('open'));
        if (!isOpen) copyRow.classList.add('open');
      });

      copyRowGo.addEventListener('click', e => {
        e.stopPropagation();
        const targetUrl = copyRowSel.value;
        if (!targetUrl) { showToast('Select a page first', 'warn'); return; }
        const targetList = allData[targetUrl] || [];
        if (targetList.some(x => x.text === h.text)) {
          showToast('Already exists on that page', 'warn');
          return;
        }
        targetList.push({ id: crypto.randomUUID(), text: h.text, color: h.color, createdAt: Date.now() });
        allData[targetUrl] = targetList;
        chrome.storage.local.set({ [HL_STORAGE_KEY]: allData }, () => {
          copyRow.classList.remove('open');
          showToast('Copied to page', 'success');
          updateStats();
        });
      });

      copyClose.addEventListener('click', e => {
        e.stopPropagation();
        copyRow.classList.remove('open');
      });

      // ── Delete ──
      delBtn.addEventListener('click', e => {
        e.stopPropagation();
        const textPrev = h.text.length > 60 ? h.text.slice(0, 60) + '…' : h.text;
        showConfirm(
          textPrev ? `"${textPrev}"` : 'Remove this highlight?',
          () => {
            // Storage is the source of truth — update it directly so deletion
            // works even on pages without a content script (e.g. file:// URLs).
            const list = (allData[selectedUrl] || []).filter(x => x.id !== h.id);
            if (list.length === 0) delete allData[selectedUrl];
            else allData[selectedUrl] = list;
            chrome.storage.local.set({ [HL_STORAGE_KEY]: allData }, () => {
              // Notify the content script to unwrap the DOM mark when present.
              if (isCurrentTab) sendToTab({ type: 'HL_REMOVE', id: h.id });
              load();
            });
            showToast('Highlight removed', 'success');
          },
          { title: 'Remove highlight', danger: true, okLabel: 'Remove' }
        );
      });

      // ── Scroll to on click (current tab only) ──
      if (isCurrentTab) {
        li.addEventListener('click', e => {
          if (e.target.closest('.btn-row')) return;
          chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
            if (!tab?.id) return;
            chrome.tabs.sendMessage(tab.id, { type: 'HL_SCROLL_TO', id: h.id });
            window.close();
          });
        });
      }
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
    const pageList  = allData[selectedUrl] || [];
    const allKeys   = Object.keys(allData).filter(k => allData[k]?.length > 0);
    const totalAll  = allKeys.reduce((s, k) => s + allData[k].length, 0);
    const pageCount = pageList.length || 0;
    const pagesCount = allKeys.length || 0;

    // Compact bar
    if (statPage)  statPage.textContent  = pageCount;
    if (statTotal) statTotal.textContent = totalAll || '0';
    if (statPages) statPages.textContent = pagesCount || '—';
    // Detail section
    if (statPageD)  statPageD.textContent  = pageCount;
    if (statTotalD) statTotalD.textContent = totalAll || '0';
    if (statPagesD) statPagesD.textContent = pagesCount || '—';

    const allHighlights = allKeys.flatMap(k => allData[k]);
    renderColorBar('hlStatBarPage',  pageList);
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
