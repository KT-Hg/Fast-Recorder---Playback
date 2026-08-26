/**
 * ui.js — Page wiring for the SQL Test Case Designer.
 *
 * Everything below the surface lives in generate.js and the technique modules;
 * this file only renders what they return and keeps the query, the technique
 * toggles and the theme in chrome.storage.local so reopening the tab lands
 * where the user left off.
 *
 * Rendering builds nodes rather than assigning innerHTML: case text is derived
 * from the user's own SQL, and a table name containing angle brackets should
 * appear as text, not become markup.
 */

import { generateCases, generateComparison, TECHNIQUES, DEFAULT_OPTIONS } from './generate.js';
import { toCsv, toJson, suggestFilename, downloadText } from './export.js';
import { t, tPlural, setLang, getLang, LANGUAGES, DEFAULT_LANG } from './i18n.js';
import { buildAllFixtures, fixturesToCsv, valueSlots, verifyFor } from './datagen.js';
import { parse } from './parser.js';
import * as valuebook from './valuebook.js';

const THEME_KEY = 'popupTheme';
const STATE_KEY = 'sqlCasesState';
const LANG_KEY = 'sqlCasesLang';
const PANELS_KEY = 'sqlCasesPanels';
const VALUES_KEY = 'sqlCasesValues';

/**
 * Extension storage, or null when the page is opened as a plain file.
 * Everything it holds is a convenience (last query, toggles, theme), so the
 * page stays fully usable without it rather than failing to start.
 */
const storage = (typeof chrome !== 'undefined' && chrome.storage?.local) || null;

const EXAMPLES = [
  {
    labelKey: 'ui.ex.report',
    sql: `SELECT u.id, u.name, COUNT(o.id) AS order_count, SUM(o.total) AS revenue
  FROM users u
  LEFT JOIN orders o ON o.user_id = u.id
 WHERE u.age BETWEEN 18 AND 65
   AND u.country IN ('VN', 'SG')
   AND u.email LIKE '%@gmail.com'
   AND u.deleted_at IS NULL
 GROUP BY u.id, u.name
HAVING COUNT(o.id) > 3
 ORDER BY revenue DESC
 LIMIT 20 OFFSET 40`
  },
  {
    labelKey: 'ui.ex.nulls',
    sql: `SELECT c.id, c.name
  FROM customers c
  LEFT JOIN orders o ON o.customer_id = c.id
 WHERE o.status <> 'cancelled'
   AND c.id NOT IN (SELECT customer_id FROM blocked)`
  },
  {
    labelKey: 'ui.ex.decision',
    sql: `SELECT * FROM bookings
 WHERE (status = 'confirmed' OR status = 'pending')
   AND guests >= 2
   AND check_in >= '2026-01-01'
   AND cancelled_at IS NULL`
  },
  {
    labelKey: 'ui.ex.case',
    sql: `SELECT id,
       CASE WHEN score >= 90 THEN 'A'
            WHEN score >= 80 THEN 'B'
            WHEN score >= 70 THEN 'C'
       END AS grade
  FROM results
 WHERE submitted_at IS NOT NULL`
  },
  {
    labelKey: 'ui.ex.update',
    sql: `UPDATE accounts
   SET balance = balance - :amount,
       updated_at = NOW()
 WHERE id = :account_id
   AND balance >= :amount`
  },
  {
    labelKey: 'ui.ex.insert',
    sql: `INSERT INTO audit_log (user_id, action, detail, created_at)
VALUES (:user_id, 'login', NULL, NOW())`
  }
];

// ---- element handles -------------------------------------------------

const $ = id => document.getElementById(id);
const el = {
  sql: $('sqlInput'),
  sqlLabel: $('sqlLabel'),
  modeToggle: $('modeToggle'),
  sqlAfterCard: $('sqlAfterCard'),
  sqlAfter: $('sqlInputAfter'),
  parseErrorsAfter: $('parseErrorsAfter'),
  diffPanel: $('diffPanel'),
  diffBody: $('diffBody'),
  diffSummary: $('diffSummary'),
  stalePanel: $('stalePanel'),
  staleBody: $('staleBody'),
  staleSummary: $('staleSummary'),
  impactFilter: $('impactFilter'),
  clauseFilter: $('clauseFilter'),
  columnFilter: $('columnFilter'),
  fixtureFilter: $('fixtureFilter'),
  analyze: $('btnAnalyze'),
  clear: $('btnClear'),
  sample: $('sampleSelect'),
  parseStatus: $('parseStatus'),
  parseErrors: $('parseErrors'),
  techList: $('techList'),
  maxFull: $('optMaxFull'),
  joinConds: $('optJoinConds'),
  analysisCard: $('analysisCard'),
  analysisBody: $('analysisBody'),
  findings: $('findings'),
  findingsPanel: $('findingsPanel'),
  findingsSummary: $('findingsSummary'),
  coverage: $('coverage'),
  coveragePanel: $('coveragePanel'),
  coverageSummary: $('coverageSummary'),
  techPanel: $('techPanel'),
  techSummary: $('techSummary'),
  schemaSummary: $('schemaSummary'),
  analysisSummary: $('analysisSummary'),
  techFilter: $('techFilter'),
  prioFilter: $('prioFilter'),
  search: $('searchBox'),
  body: $('caseBody'),
  empty: $('emptyState'),
  csv: $('btnCsv'),
  dataCsv: $('btnDataCsv'),
  verifySql: $('btnVerifySql'),
  schemaCard: $('schemaCard'),
  schemaBody: $('schemaBody'),
  valuesCard: $('valuesCard'),
  valuesBody: $('valuesBody'),
  valuesSummary: $('valuesSummary'),
  resetValues: $('btnResetValues'),
  json: $('btnJson'),
  copyJson: $('btnCopyJson'),
  theme: $('toggleTheme'),
  lang: $('toggleLang'),
  langLabel: $('langLabel'),
  help: $('btnHelp'),
  helpModal: $('helpModal'),
  helpClose: $('btnHelpClose'),
  toast: $('toast'),
  stats: {
    total: $('statTotal'), high: $('statHigh'),
    conds: $('statConds'), joins: $('statJoins'), tables: $('statTables')
  }
};

/**
 * The SQL text that produced `current` — #sqlInput in single mode, but
 * #sqlInputAfter in compare mode, since that is the query the case table,
 * fixtures and exports are actually generated from.
 */
function activeSql() {
  return mode === 'compare' ? el.sqlAfter.value : el.sql.value;
}

/** Last generation result, and the filter state applied on top of it. */
let current = null;
let activeTechnique = '';
let activeClause = '';
let activeColumn = '';
let activeImpact = '';
let onlyWithFixture = false;
/** Inferred schema and per-case fixtures for the current result. */
let data = null;
/** Case ids whose data panel is expanded, kept across re-renders. */
const expanded = new Set();
/** 'single' analyses #sqlInput alone; 'compare' diffs it against #sqlInputAfter. */
let mode = 'single';
/** Cases from the "before" query whose source no longer exists (compare mode). */
let staleCases = [];

// ---- collapsible panels ----------------------------------------------

/**
 * The four secondary panels, and whether each starts open.
 *
 * They default shut so the case table gets the height. Findings are the
 * exception when the query has a real defect in it: an error the user never
 * expands is an error they never see.
 */
const PANELS = ['techPanel', 'findingsPanel', 'coveragePanel', 'schemaCard', 'valuesCard', 'analysisCard'];

function initPanels() {
  PANELS.forEach(id => {
    const d = $(id);
    if (!d) return;
    d.addEventListener('toggle', savePanels);
  });
}

function savePanels() {
  const state = {};
  PANELS.forEach(id => { const d = $(id); if (d) state[id] = d.open; });
  storage?.set({ [PANELS_KEY]: state });
}

function applyPanelState(state) {
  if (!state) return;
  PANELS.forEach(id => {
    const d = $(id);
    if (d && typeof state[id] === 'boolean') d.open = state[id];
  });
}

// ---- small helpers ---------------------------------------------------

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

let toastTimer = null;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2200);
}

/** CSS-safe suffix for a technique badge class. */
function techClass(technique) {
  return 'tech-' + technique.replace(/[^A-Za-z]/g, '').slice(0, 9);
}

/** Line and column of a character offset, for parse-error messages. */
function positionOf(sql, pos) {
  const upto = sql.slice(0, Math.max(0, pos));
  const line = upto.split('\n').length;
  const col = pos - upto.lastIndexOf('\n');
  return { line, col };
}

// ---- options ---------------------------------------------------------

function readOptions() {
  const options = {
    maxFullTable: Number(el.maxFull.value) || DEFAULT_OPTIONS.maxFullTable,
    includeJoinConditions: el.joinConds.checked
  };
  TECHNIQUES.forEach(tech => {
    options[tech.key] = el.techList.querySelector(`input[data-tech="${tech.key}"]`)?.checked ?? true;
  });
  return options;
}

function buildTechniqueList() {
  TECHNIQUES.forEach(tech => {
    const li = node('li');
    const label = node('label', 'check-row');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = true;
    input.dataset.tech = tech.key;
    input.addEventListener('change', () => { saveState(); run(); });
    label.append(input, node('span', 'tech-name', t(tech.labelKey)), node('span', 'tech-count', ''));
    li.append(label);
    el.techList.append(li);
  });
}

function updateTechniqueCounts(stats) {
  TECHNIQUES.forEach(tech => {
    const n = tech.codes.reduce((sum, code) => sum + (stats.byTechnique[code] || 0), 0);
    const span = el.techList.querySelector(`input[data-tech="${tech.key}"]`)?.parentElement
      ?.querySelector('.tech-count');
    if (span) span.textContent = n ? t('ui.techCases', { n }) : '';
  });

  const boxes = [...el.techList.querySelectorAll('input[data-tech]')];
  el.techSummary.textContent = t('ui.sumTechniques', {
    on: boxes.filter(b => b.checked).length,
    total: boxes.length,
    n: stats.total
  });
}

// ---- rendering: parsed analysis --------------------------------------

function renderAnalysis(model) {
  el.analysisBody.replaceChildren();
  if (!model) { el.analysisCard.hidden = true; return; }

  const section = (label, chips) => {
    if (!chips.length) return;
    const g = node('div', 'an-group');
    g.append(node('div', 'an-label', label));
    const row = node('div', 'chip-row');
    chips.forEach(c => row.append(c));
    g.append(row);
    el.analysisBody.append(g);
  };

  const plainChip = (text) => node('span', 'chip', text);

  section(t('ui.statement'), [plainChip(model.statement.toUpperCase())]);

  section(t('ui.tables'), model.tables.map(tbl => {
    const chip = node('span', 'chip');
    chip.append(node('code', null, tbl.name));
    if (tbl.alias) chip.append(node('span', 'chip-type', t('ui.as', { alias: tbl.alias })));
    if (tbl.joinType) chip.append(node('span', 'chip-type', tbl.joinType));
    return chip;
  }));

  const conds = [...model.conditions, ...model.havingConditions];
  section(t('ui.conditions'), conds.map(c => {
    const chip = node('span', 'chip');
    chip.append(node('span', 'chip-id', c.id));
    chip.append(node('code', null, c.sql));
    chip.append(node('span', 'chip-type', `${c.dataType.type}${c.dataType.confidence === 'name' ? '?' : ''}`));
    return chip;
  }));

  section(t('ui.joins'), model.joins.map(j =>
    plainChip(`${j.joinType}${j.implicit ? ' (comma)' : ''} · ${j.leftLabel} ⋈ ${j.rightLabel}`)
  ));

  const shape = [];
  if (model.grouping.distinct) shape.push(plainChip('DISTINCT'));
  model.grouping.groupBy.forEach(g => shape.push(plainChip(`GROUP BY ${g.sql}`)));
  model.grouping.aggregates.forEach(a => shape.push(plainChip(a.sql)));
  model.paging.orderBy.forEach(o => shape.push(plainChip(`ORDER BY ${o.sql} ${o.dir}`)));
  if (model.paging.limit) shape.push(plainChip(`LIMIT ${model.paging.limit.sql}`));
  if (model.paging.offset) shape.push(plainChip(`OFFSET ${model.paging.offset.sql}`));
  section(t('ui.resultShape'), shape);

  if (model.writes) {
    section(t('ui.writes'), model.writes.columns.map(c => plainChip(`${c.name} : ${c.dataType.type}`)));
  }

  el.analysisSummary.textContent = t('ui.sumAnalysis', {
    statement: model.statement.toUpperCase(),
    tables: model.tables.length,
    conds: model.conditions.length + model.havingConditions.length
  });
  el.analysisCard.hidden = false;
}

/**
 * The schema the fixtures were built against.
 *
 * Shown because every generated value depends on it: if a type or a foreign key
 * was guessed wrong, this panel is where that becomes visible, before the
 * tester has typed the data in somewhere.
 */
function renderSchema() {
  el.schemaBody.replaceChildren();
  if (!data || !data.schema.tables.length) { el.schemaCard.hidden = true; return; }

  data.schema.tables.forEach(tbl => {
    const box = node('div', 'sc-table');
    const head = node('div', 'sc-name', tbl.name);
    if (tbl.alias) head.append(node('span', 'chip-type', ` ${tbl.alias}`));
    box.append(head);

    const cols = node('div', 'sc-cols');
    tbl.columns.forEach(c => {
      const row = node('div', 'sc-col');
      row.append(node('span', 'sc-col-name', c.name));
      row.append(node('span', 'sc-col-type', c.type));
      if (c.isPk) row.append(node('span', 'sc-tag sc-tag-pk', t('dg.pk')));
      else if (c.fk) row.append(node('span', 'sc-tag sc-tag-fk', t('dg.fk', { target: `${c.fk.table}.${c.fk.column}` })));
      else if (!c.nullable) row.append(node('span', 'sc-tag sc-tag-nn', t('dg.notNull')));
      if (c.synthetic) row.append(node('span', 'chip-type', t('dg.synthetic')));
      cols.append(row);
    });
    box.append(cols);
    el.schemaBody.append(box);
  });

  data.schema.notes.forEach(n => {
    el.schemaBody.append(node('div', 'fx-note', t(n.key, n.params)));
  });

  el.schemaSummary.textContent = t('ui.sumSchema', {
    tables: data.schema.tables.length,
    columns: data.schema.tables.reduce((sum, x) => sum + x.columns.length, 0)
  });
  el.schemaCard.hidden = false;
}

// ---- rendering: the value book ---------------------------------------

/** Set by a reset, so focus lands back on the field the button belonged to. */
let pendingValueFocus = null;

/**
 * The one place sample values are managed.
 *
 * Every value in the results is either read from the query or invented by the
 * tool, and this panel lists the invented ones: the bind parameters it cannot
 * see the value of, and the filler used for columns no predicate constrains.
 * Editing one writes it into the value book and re-runs generation, so the
 * cases and the fixture rows that use it change together — which is the whole
 * point of managing them in one place rather than per case.
 */
function renderValues() {
  // Focus is captured before the rebuild and handed back afterwards: a commit
  // regenerates everything, and losing the caret mid-edit would make the panel
  // unusable for typing more than one value. A reset names its own field,
  // because the button it was clicked on no longer exists afterwards.
  const active = document.activeElement;
  const editing = active && active.classList?.contains('vb-input');
  const focusKey = pendingValueFocus || (editing ? active.dataset.key : null);
  const caret = editing && !pendingValueFocus ? active.selectionStart : null;
  pendingValueFocus = null;

  el.valuesBody.replaceChildren();
  el.valuesSummary.textContent = '';

  if (!current?.model) { el.valuesCard.hidden = true; return; }

  const book = valueSlots(current.model, data?.schema, data?.fixtures);
  if (!book.total) { el.valuesCard.hidden = true; return; }

  if (book.params.length) {
    el.valuesBody.append(node('div', 'vb-section', t('vb.params')));
    el.valuesBody.append(node('div', 'vb-group-hint', t('vb.paramsHint')));
    el.valuesBody.append(valueGroup('', null, book.params));
  }
  if (book.tables.length) {
    el.valuesBody.append(node('div', 'vb-section', t('vb.columns')));
    el.valuesBody.append(node('div', 'vb-group-hint', t('vb.columnsHint')));
    book.tables.forEach(tbl => {
      const name = tbl.alias && tbl.alias !== tbl.name ? `${tbl.name} (${tbl.alias})` : tbl.name;
      el.valuesBody.append(valueGroup(name, null, tbl.slots));
    });
  }

  el.valuesSummary.textContent = t('vb.sum', { overridden: book.overridden, total: book.total });
  el.resetValues.disabled = book.overridden === 0;
  el.valuesCard.hidden = false;

  if (focusKey) {
    const back = el.valuesBody.querySelector(`.vb-input[data-key="${CSS.escape(focusKey)}"]`);
    if (back) {
      back.focus();
      const at = caret ?? back.value.length;
      try { back.setSelectionRange(at, at); } catch { /* not a text input */ }
    }
  }
}

/** One labelled block of value rows. */
function valueGroup(title, hint, slots) {
  const box = node('div', 'vb-group');
  if (title) box.append(node('div', 'vb-group-name', title));
  if (hint) box.append(node('div', 'vb-group-hint', hint));
  slots.forEach(slot => box.append(valueRow(slot)));
  return box;
}

/** One editable value: what it is called, what it holds, and where it is used. */
function valueRow(slot) {
  const row = node('div', `vb-row${slot.overridden ? ' vb-set' : ''}`);

  const head = node('div', 'vb-row-head');
  head.append(node('span', 'vb-name', slot.label));
  if (slot.type && slot.type !== 'unknown') head.append(node('span', 'vb-type', slot.type));
  head.append(node('span', 'vb-uses', slot.uses
    ? (slot.kind === 'param' ? t('vb.usesParam', { n: slot.uses }) : t('vb.usesCells', { n: slot.uses }))
    : t('vb.usesNone')));
  row.append(head);

  const line = node('div', 'vb-line');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = `vb-input${slot.overridden && !slot.valid ? ' vb-invalid' : ''}`;
  input.value = slot.raw;
  input.dataset.key = slot.key;
  input.placeholder = slot.kind === 'param'
    ? t('vb.unbound')
    : `${slot.autoPlain} (${t('vb.auto')})`;
  input.setAttribute('aria-label', slot.label);
  input.addEventListener('change', () => commitValue(slot, input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = slot.raw; input.blur(); }
  });
  line.append(input);

  if (slot.overridden) {
    const reset = node('button', 't-btn t-btn-sm vb-reset', '↺');
    reset.title = t('vb.resetOne');
    reset.addEventListener('click', () => {
      pendingValueFocus = slot.key;
      commitValue(slot, '');
    });
    line.append(reset);
  }
  row.append(line);

  if (slot.overridden && !slot.valid) {
    row.append(node('div', 'vb-warn', t('vb.badType', { type: slot.type })));
  }
  return row;
}

/**
 * Store one edited value and rebuild everything that depends on it.
 *
 * Deferred by a tick so the browser can finish moving focus first: `change`
 * fires during the blur, and regenerating before focus lands would drop the
 * user out of the field they tabbed into.
 */
function commitValue(slot, raw) {
  if (!valuebook.setOverride(slot.key, raw)) return;
  setTimeout(() => { saveValues(); run(); }, 0);
}

function saveValues() {
  storage?.set({ [VALUES_KEY]: valuebook.toJSON() });
}

// ---- rendering: findings & coverage ----------------------------------

const FINDING_ICON = { error: '⛔', warn: '⚠', info: 'ℹ' };

function renderFindings(findings) {
  el.findings.replaceChildren();
  el.findingsSummary.replaceChildren();

  if (!findings.length) { el.findingsPanel.hidden = true; return; }

  findings.forEach(f => {
    const row = node('div', `finding finding-${f.level}`);
    row.append(node('span', 'finding-icon', FINDING_ICON[f.level] || 'ℹ'));
    row.append(node('span', null, f.message));
    el.findings.append(row);
  });

  // Collapsed, the summary has to carry the weight — how many, and how bad.
  const counts = { error: 0, warn: 0, info: 0 };
  findings.forEach(f => { if (counts[f.level] !== undefined) counts[f.level]++; });

  const parts = [];
  if (counts.error) parts.push(node('span', 'sum-error', t('ui.sumErrors', { n: counts.error })));
  if (counts.warn) parts.push(node('span', 'sum-warn', t('ui.sumWarns', { n: counts.warn })));
  if (counts.info) parts.push(node('span', null, t('ui.sumInfos', { n: counts.info })));
  parts.forEach((n, i) => {
    if (i) el.findingsSummary.append(node('span', null, ' · '));
    el.findingsSummary.append(n);
  });

  el.findingsPanel.hidden = false;
  // An error is worth opening unasked; warnings and notes are not.
  if (counts.error) el.findingsPanel.open = true;
}

function renderCoverage(summaries) {
  el.coverage.replaceChildren();
  el.coverageSummary.textContent = '';
  if (!summaries.length) { el.coveragePanel.hidden = true; return; }

  el.coverageSummary.textContent = summaries
    .map(x => t('ui.sumCoverage', { scope: x.scope, cond: x.conditionCoverage, dec: x.decisionCoverage }))
    .join(' · ');
  el.coveragePanel.hidden = false;

  summaries.forEach(s => {
    const card = node('div', 'cov-card');
    const head = node('div', 'cov-head');
    head.append(node('span', 'cov-scope', s.scope));
    head.append(node('span', 'cov-mode',
      t('ui.covCombinations', { mode: s.mode, rules: s.ruleCount, total: s.fullTableSize ?? '—' })));
    card.append(head);

    const bars = node('div', 'cov-bars');
    const bar = (label, pct) => {
      const row = node('div', 'cov-bar-row');
      row.append(node('span', 'cov-bar-lbl', label));
      const track = node('div', 'cov-bar');
      const fill = node('div', `cov-bar-fill${pct < 100 ? ' partial' : ''}`);
      fill.style.width = `${pct}%`;
      track.append(fill);
      row.append(track, node('span', 'cov-bar-val', `${pct}%`));
      bars.append(row);
    };
    bar(t('ui.covCondition'), s.conditionCoverage);
    bar(t('ui.covDecision'), s.decisionCoverage);
    card.append(bars);

    const legend = node('div', 'cov-legend');
    s.legend.forEach(l => {
      const line = node('div');
      line.append(node('span', 'chip-id', l.id + ' '));
      line.append(node('code', null, l.sql));
      legend.append(line);
    });
    card.append(legend);

    if (s.maskedConditions.length) {
      card.append(node('div', 'helper',
        t('ui.covMasked', { ids: s.maskedConditions.join(', ') })));
    }
    el.coverage.append(card);
  });
}

// ---- rendering: compare-mode diff --------------------------------------

/** One coloured chip for a diff panel row: added / removed / changed. */
function diffChip(kind, text) {
  const mark = { added: '+', removed: '−', changed: '~' }[kind] || '';
  const chip = node('span', `chip chip-${kind}`);
  if (mark) chip.append(node('span', 'chip-mark', mark));
  chip.append(node('span', null, text));
  return chip;
}

// How to render one item from each section — most are just their rendered
// SQL; a few (joins, ORDER BY, writes) need more than one field to read as a
// change rather than a mystery.
const DIFF_TABLE = t2 => `${t2.label}${t2.joinType ? ` (${t2.joinType})` : ''}`;
const DIFF_JOIN = j => `${j.leftLabel} ⋈ ${j.rightLabel} (${j.joinType}${j.implicit ? ', implicit' : ''}${j.natural ? ', natural' : ''})`;
const DIFF_JOIN_CHANGED = (o, n) => `${o.leftLabel} ⋈ ${o.rightLabel}: ${o.joinType} → ${n.joinType}`;
const DIFF_COND = c => c.sql;
const DIFF_COND_CHANGED = (o, n) => `${o.sql}  →  ${n.sql}`;
const DIFF_GROUPBY = g => g.sql;
const DIFF_AGG = a => a.sql;
const DIFF_ORDERBY = o => `${o.sql} ${o.dir}`;
const DIFF_ORDERBY_CHANGED = (o, n) =>
  `${o.sql}: ${o.dir}${o.nulls ? ' NULLS ' + o.nulls : ''} → ${n.dir}${n.nulls ? ' NULLS ' + n.nulls : ''}`;
const DIFF_SELECT = c => (c.alias ? `${c.sql} AS ${c.alias}` : c.sql);
const DIFF_SELECT_CHANGED = (o, n) => `${DIFF_SELECT(o)}  →  ${DIFF_SELECT(n)}`;
const DIFF_CASE = c => c.sql;
const DIFF_WRITE = w => `${w.name} = ${w.sql}`;
const DIFF_WRITE_CHANGED = (o, n) => `${o.name}: ${o.sql}  →  ${n.sql}`;

/** One labelled group of chips for a diff section, or null when it has nothing to show. */
function diffSection(labelKey, sec, textOf, changedTextOf) {
  if (!sec) return null;
  const total = sec.added.length + sec.removed.length + sec.changed.length + (sec.shapeChanged ? 1 : 0);
  if (!total) return null;

  const g = node('div', 'an-group');
  g.append(node('div', 'an-label', t(labelKey)));
  const row = node('div', 'chip-row');
  sec.removed.forEach(x => row.append(diffChip('removed', textOf(x))));
  sec.added.forEach(x => row.append(diffChip('added', textOf(x))));
  sec.changed.forEach(x => row.append(
    diffChip('changed', changedTextOf ? changedTextOf(x.old, x.new) : `${textOf(x.old)} → ${textOf(x.new)}`)));
  if (sec.shapeChanged) row.append(diffChip('changed', t('diff.shapeChanged')));
  g.append(row);
  return g;
}

/**
 * Render the "changes detected" panel for compare mode.
 *
 * @param {object|null} diff — from diffQueries(), or null to hide the panel
 *   (single mode, or an empty query on either side).
 */
function renderDiff(diff) {
  el.diffBody.replaceChildren();
  el.diffSummary.textContent = '';

  if (!diff) { el.diffPanel.hidden = true; return; }
  el.diffPanel.hidden = false;

  if (!diff.ok) {
    el.diffBody.append(node('div', 'helper', t('diff.parseFailed')));
    return;
  }

  if (diff.statementChanged) {
    el.diffBody.append(node('div', 'diff-banner', t('diff.statementChanged', {
      old: diff.statement.old.toUpperCase(), new: diff.statement.new.toUpperCase()
    })));
  }

  const groups = [
    diffSection('diff.tables', diff.tables, DIFF_TABLE),
    diffSection('diff.joins', diff.joins, DIFF_JOIN, DIFF_JOIN_CHANGED),
    // The aggregate ON-clause shapeChangedCount across joins does not fit the
    // single boolean the other sections use, so it is folded in here as one.
    diffSection('diff.joinConditions',
      { ...diff.joinConditions, shapeChanged: diff.joinConditions.shapeChangedCount > 0 },
      DIFF_COND, DIFF_COND_CHANGED),
    diffSection('diff.where', diff.where, DIFF_COND, DIFF_COND_CHANGED),
    diffSection('diff.having', diff.having, DIFF_COND, DIFF_COND_CHANGED),
    diffSection('diff.groupBy', diff.groupBy, DIFF_GROUPBY),
    diffSection('diff.aggregates', diff.aggregates, DIFF_AGG),
    diffSection('diff.orderBy', diff.orderBy, DIFF_ORDERBY, DIFF_ORDERBY_CHANGED),
    diffSection('diff.selectList', diff.selectList, DIFF_SELECT, DIFF_SELECT_CHANGED),
    diffSection('diff.caseExprs', diff.caseExprs, DIFF_CASE),
    diffSection('diff.writes', diff.writes, DIFF_WRITE, DIFF_WRITE_CHANGED)
  ].filter(Boolean);

  // LIMIT/OFFSET are a single optional value each, not a list — handled apart
  // from diffSection rather than forcing them into its {added,removed,changed} shape.
  const { limit, offset } = diff.paging;
  const pagingChips = [];
  if (limit.changed) {
    pagingChips.push(diffChip(!limit.old ? 'added' : !limit.new ? 'removed' : 'changed',
      `LIMIT ${limit.old ? limit.old.sql : '—'} → ${limit.new ? limit.new.sql : '—'}`));
  }
  if (offset.changed) {
    pagingChips.push(diffChip(!offset.old ? 'added' : !offset.new ? 'removed' : 'changed',
      `OFFSET ${offset.old ? offset.old.sql : '—'} → ${offset.new ? offset.new.sql : '—'}`));
  }
  if (pagingChips.length) {
    const g = node('div', 'an-group');
    g.append(node('div', 'an-label', t('diff.paging')));
    const row = node('div', 'chip-row');
    pagingChips.forEach(c => row.append(c));
    g.append(row);
    groups.push(g);
  }

  if (!groups.length && !diff.statementChanged) {
    el.diffBody.append(node('div', 'helper', t('diff.noChanges')));
  } else {
    groups.forEach(g => el.diffBody.append(g));
  }

  el.diffSummary.textContent = tPlural(diff.summary.totalChanges, 'diff.summaryOne', 'diff.summaryMany');
}

// ---- rendering: filters & table --------------------------------------

/** Order the clause dropdown lists its options in — matches the enum the
 *  technique modules tag cases with via diff.js's caseSourceFrom*() helpers. */
const CLAUSE_ORDER = ['WHERE', 'HAVING', 'JOIN', 'GROUP_BY', 'ORDER_BY', 'LIMIT_OFFSET', 'SET', 'INSERT', 'CASE_EXPR', 'DML_SCOPE', 'OTHER'];
const CLAUSE_LABELS = {
  WHERE: 'ui.clauseWhere', HAVING: 'ui.clauseHaving', JOIN: 'ui.clauseJoin',
  GROUP_BY: 'ui.clauseGroupBy', ORDER_BY: 'ui.clauseOrderBy', LIMIT_OFFSET: 'ui.clauseLimitOffset',
  SET: 'ui.clauseSet', INSERT: 'ui.clauseInsert', CASE_EXPR: 'ui.clauseCaseExpr',
  DML_SCOPE: 'ui.clauseDmlScope', OTHER: 'ui.clauseOther'
};
const IMPACT_ICON = { changed: '🎯', unrelated: '➖', stale: '🗑' };
const IMPACT_TIP_KEY = { changed: 'ui.impactChangedTip', unrelated: 'ui.impactUnrelatedTip', stale: 'ui.impactStaleTip' };

/** The small coloured marker shown before a case's title in compare mode. */
function impactBadge(impact) {
  const b = node('span', `impact-badge impact-${impact}`, IMPACT_ICON[impact] || '');
  b.title = t(IMPACT_TIP_KEY[impact] || '');
  return b;
}

/** Whether any of a case's `columns` matches the Table/Column filter value —
 *  a bare table label matches every column on that table, a full `table.col`
 *  value matches only that one column. */
function columnMatches(caseColumns, filterValue) {
  if (!filterValue) return true;
  const wanted = filterValue.toLowerCase();
  return (caseColumns || []).some(col => {
    const raw = (col.raw || (col.table ? `${col.table}.${col.name}` : col.name) || '').toLowerCase();
    if (raw === wanted) return true;
    return (col.table || '').toLowerCase() === wanted;
  });
}

/** Impact pills — only shown once a compare-mode run has tagged the cases. */
function renderImpactFilter() {
  el.impactFilter.replaceChildren();
  const withImpact = !!current && current.cases.some(c => c.impact === 'changed' || c.impact === 'unrelated');
  if (!withImpact) {
    el.impactFilter.hidden = true;
    activeImpact = '';
    return;
  }

  const counts = { changed: 0, unrelated: 0 };
  current.cases.forEach(c => { if (counts[c.impact] !== undefined) counts[c.impact]++; });

  const labelKey = { changed: 'ui.impactChanged', unrelated: 'ui.impactUnrelated' };
  const mk = (value, count) => {
    const b = node('button', `pill${activeImpact === value ? ' active' : ''}`, t(labelKey[value]));
    b.append(node('span', 'pill-n', count));
    b.addEventListener('click', () => {
      activeImpact = activeImpact === value ? '' : value;
      renderImpactFilter();
      renderTable();
    });
    return b;
  };

  el.impactFilter.append(mk('changed', counts.changed));
  el.impactFilter.append(mk('unrelated', counts.unrelated));
  el.impactFilter.hidden = false;
}

/** Clause dropdown — only lists clauses that actually occur in the current case list. */
function renderClauseFilter() {
  const sel = el.clauseFilter;
  const prevValue = activeClause;
  sel.replaceChildren();
  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = t('ui.allClauses');
  sel.append(allOpt);

  const present = current ? new Set(current.cases.map(c => c.clause).filter(Boolean)) : new Set();
  CLAUSE_ORDER.filter(k => present.has(k)).forEach(k => {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = t(CLAUSE_LABELS[k]);
    sel.append(opt);
  });

  sel.disabled = present.size === 0;
  activeClause = present.has(prevValue) ? prevValue : '';
  sel.value = activeClause;
}

/** Table/column dropdown — populated from the current query's own schema. */
function renderColumnFilter() {
  const sel = el.columnFilter;
  const prevValue = activeColumn;
  sel.replaceChildren();
  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = t('ui.allColumns');
  sel.append(allOpt);

  if (current?.model) {
    const seen = new Set();
    current.model.tables.forEach(tbl => {
      if (!tbl.label || seen.has(tbl.label)) return;
      seen.add(tbl.label);
      const opt = document.createElement('option');
      opt.value = tbl.label;
      opt.textContent = `🗂 ${tbl.label}`;
      sel.append(opt);
    });
    current.model.columns.forEach(col => {
      if (!col.raw || seen.has(col.raw)) return;
      seen.add(col.raw);
      const opt = document.createElement('option');
      opt.value = col.raw;
      opt.textContent = `  ${col.raw}`;
      sel.append(opt);
    });
  }

  const available = new Set([...sel.options].map(o => o.value));
  sel.disabled = available.size <= 1;
  activeColumn = available.has(prevValue) ? prevValue : '';
  sel.value = activeColumn;
}

/**
 * Compare mode: the "before" query's cases whose source condition/join/etc.
 * is gone in the "after" query — shown as a compact list rather than in the
 * main table, since they describe behaviour that no longer exists to test.
 */
function renderStale(list) {
  staleCases = list || [];
  el.staleBody.replaceChildren();
  el.staleSummary.textContent = '';

  if (!staleCases.length) { el.stalePanel.hidden = true; return; }

  staleCases.forEach(c => {
    const row = node('div', 'stale-row');
    row.append(impactBadge('stale'));
    row.append(node('span', 'stale-title', `${c.title} — ${c.data}`));
    row.append(node('span', 'stale-group', `${t('tech.code.' + c.technique)} · ${c.group}`));
    el.staleBody.append(row);
  });
  el.staleSummary.textContent = t('ui.sumStale', { n: staleCases.length });
  el.stalePanel.hidden = false;
}

function renderTechniqueFilter(stats) {
  el.techFilter.replaceChildren();
  const codes = Object.keys(stats.byTechnique);

  const mk = (label, value, count) => {
    const b = node('button', `pill${activeTechnique === value ? ' active' : ''}`, label);
    if (count !== undefined) b.append(node('span', 'pill-n', count));
    b.addEventListener('click', () => {
      activeTechnique = activeTechnique === value ? '' : value;
      renderTechniqueFilter(stats);
      renderTable();
    });
    return b;
  };

  el.techFilter.append(mk(t('ui.filterAll'), '', stats.total));
  codes.forEach(code => el.techFilter.append(mk(t('tech.code.' + code), code, stats.byTechnique[code])));
}

function visibleCases() {
  if (!current) return [];
  const q = el.search.value.trim().toLowerCase();
  const prio = el.prioFilter.value;
  return current.cases.filter(c => {
    if (activeTechnique && c.technique !== activeTechnique) return false;
    if (prio && c.priority !== prio) return false;
    if (activeClause && c.clause !== activeClause) return false;
    if (activeImpact && c.impact !== activeImpact) return false;
    if (activeColumn && !columnMatches(c.columns, activeColumn)) return false;
    if (onlyWithFixture && !data?.fixtures.get(c.id)) return false;
    if (!q) return true;
    return [c.id, c.technique, c.group, c.target, c.title, c.data, c.expected, c.notes]
      .join(' ').toLowerCase().includes(q);
  });
}

function renderTable() {
  const rows = visibleCases();
  el.body.replaceChildren();

  el.empty.hidden = rows.length > 0;
  if (!rows.length) {
    const filtered = !!current && current.cases.length > 0;
    const noResult = !!current;
    el.empty.querySelector('.empty-title').textContent =
      t(filtered ? 'ui.noMatchTitle' : (noResult ? 'ui.nothingTitle' : 'ui.emptyTitle'));
    el.empty.querySelector('.empty-sub').textContent =
      t(filtered ? 'ui.noMatchSub' : (noResult ? 'ui.nothingSub' : 'ui.emptySub'));
  }

  const colSpan = el.body.closest('table').tHead.rows[0].cells.length;
  const frag = document.createDocumentFragment();
  rows.forEach(c => {
    const tr = node('tr', 'case-row');
    if (expanded.has(c.id)) tr.classList.add('open');

    tr.append(node('td', 'cell-id', c.id));

    const tdTech = node('td');
    tdTech.append(node('span', `tech-badge ${techClass(c.technique)}`, t('tech.code.' + c.technique)));
    tr.append(tdTech);

    tr.append(node('td', 'cell-target', c.target));

    const tdTitle = node('td');
    if (c.impact === 'changed' || c.impact === 'unrelated') tdTitle.append(impactBadge(c.impact));
    tdTitle.append(node('span', null, c.title));
    tdTitle.append(node('span', 'cell-group', c.group));
    tr.append(tdTitle);

    tr.append(node('td', 'cell-data', c.data));

    const tdExp = node('td', 'cell-exp');
    tdExp.append(node('span', null, c.expected));
    if (c.notes) tdExp.append(node('span', 'cell-note', c.notes));
    tr.append(tdExp);

    const tdPrio = node('td');
    tdPrio.append(node('span', `prio prio-${c.priority}`, t('prio.' + c.priority)));
    tr.append(tdPrio);

    tr.addEventListener('click', () => {
      if (expanded.has(c.id)) expanded.delete(c.id);
      else expanded.add(c.id);
      renderTable();
    });

    frag.append(tr);
    if (expanded.has(c.id)) frag.append(buildDetailRow(c, colSpan));
  });
  el.body.append(frag);
}

/**
 * The expanded panel under one case: the rows to create, anything that could
 * not be expressed as a row, and the query to run once the data is in place.
 */
function buildDetailRow(testCase, colSpan) {
  const tr = node('tr', 'case-detail');
  const td = node('td');
  td.colSpan = colSpan;

  if (testCase.rationale) {
    const secWhy = node('div', 'fx-sec');
    secWhy.append(node('div', 'fx-label', t('dg.rationale')));
    secWhy.append(node('div', 'fx-rationale', testCase.rationale));
    td.append(secWhy);
  }

  const fixture = data?.fixtures.get(testCase.id);

  if (!fixture) {
    td.append(node('div', 'fx-req', t('dg.noFixture')));
    tr.append(td);
    return tr;
  }

  // --- rows to prepare ---
  const secRows = node('div', 'fx-sec');
  secRows.append(node('div', 'fx-label', t('dg.fixture')));
  const wrap = node('div', 'fx-tables');

  fixture.tables.forEach(tbl => {
    const box = node('div', 'fx-table');
    const name = node('div', 'fx-tname', tbl.table);
    name.append(node('span', 'fx-count',
      tbl.rows.length ? t('dg.rowCount', { n: tbl.rows.length }) : t('dg.row.none')));
    box.append(name);

    if (!tbl.rows.length) {
      box.append(node('div', 'fx-empty', t('dg.row.none')));
    } else {
      const grid = node('table', 'fx-grid');
      const thead = node('thead');
      const hrow = node('tr');
      tbl.columns.forEach(cn => hrow.append(node('th', null, cn)));
      thead.append(hrow);
      grid.append(thead);

      const tbody = node('tbody');
      tbl.rows.forEach(row => {
        const rtr = node('tr');
        tbl.columns.forEach(cn => {
          const cell = row.values[cn];
          rtr.append(node('td', cell?.focus ? 'focus' : null, cell?.plain ?? ''));
        });
        tbody.append(rtr);
      });
      grid.append(tbody);
      box.append(grid);
    }
    wrap.append(box);
  });

  secRows.append(wrap);
  if (fixture.tables.some(tb => tb.rows.some(r => Object.values(r.values).some(v => v.focus)))) {
    secRows.append(node('div', 'fx-note', t('dg.focusHint')));
  }
  td.append(secRows);

  // --- requirements no row can express ---
  if (fixture.requirements.length) {
    const secReq = node('div', 'fx-sec');
    secReq.append(node('div', 'fx-label', t('dg.requirements')));
    fixture.requirements.forEach(r => secReq.append(node('div', 'fx-req', r.text)));
    td.append(secReq);
  }

  // --- the query to run afterwards ---
  const v = verifyFor(activeSql(), testCase);
  const secSql = node('div', 'fx-sec');
  secSql.append(node('div', 'fx-label', t('dg.verify')));
  secSql.append(node('pre', 'fx-sql', v.sql));
  const exp = node('div', 'fx-exp');
  exp.append(node('b', null, t('dg.expected') + ': '));
  exp.append(node('span', null, v.expectation));
  secSql.append(exp);
  td.append(secSql);

  tr.append(td);
  return tr;
}

// ---- run -------------------------------------------------------------

function renderParseProblems(sql, result, target = el.parseErrors) {
  target.replaceChildren();
  const errors = result.errors || [];
  const warnings = result.warnings || [];

  if (!errors.length && !warnings.length) {
    target.hidden = true;
    return;
  }

  errors.forEach(e => {
    const p = node('div');
    const { line, col } = positionOf(sql, e.pos);
    p.append(node('b', null, t('ui.parseError', { line, col })));
    p.append(node('span', null, e.message));
    target.append(p);
    const lineText = sql.split('\n')[line - 1];
    if (lineText) target.append(node('code', null, `${lineText}\n${' '.repeat(Math.max(0, col - 1))}^`));
  });

  warnings.forEach(w => {
    // A warning that names a position is usually one about text that went
    // unanalysed — pointing at it is the difference between a shrug and a fix.
    const where = w.pos > 0 ? positionOf(sql, w.pos) : null;
    target.append(node('div', null, where
      ? t('ui.warnAt', { line: where.line, col: where.col, message: w.message })
      : t('ui.warn', { message: w.message })));
  });
  target.hidden = false;
}

/**
 * Run the full parse → generate → render pipeline for one SQL string.
 *
 * In single mode this is the whole page's model. In compare mode it still
 * drives the case table, findings, coverage and schema panels — off the
 * "after" query, since that is the version being tested — while `run()`
 * separately renders the "before" side's own parse errors and the diff
 * between the two.
 */
/**
 * Render everything the results pane shows for one already-computed
 * generateCases() result: schema, value book, analysis, findings, coverage,
 * technique filter, stats, and the case table itself.
 *
 * Shared by single mode (called from a plain generateCases() run) and by
 * compare mode's "after" side (called with the already-tagged result out of
 * generateComparison()) — the rendering does not care where the result came
 * from, only that its shape matches.
 */
function renderResult(sql, result, errorsEl) {
  renderParseProblems(sql, result, errorsEl);

  if (!result.ok) {
    current = null;
    data = null;
    expanded.clear();
    renderSchema();
    renderValues();
    el.parseStatus.textContent = t('ui.parseFailed');
    renderAnalysis(null);
    renderFindings([]);
    renderCoverage([]);
    el.techFilter.replaceChildren();
    renderClauseFilter();
    renderColumnFilter();
    renderImpactFilter();
    setStats(null);
    renderTable();
    return;
  }

  current = result;
  // Fixtures depend only on the model and the case list, so they are rebuilt
  // with every generation — including a language switch, which re-runs it.
  try {
    data = buildAllFixtures(result.model, result.cases);
  } catch (err) {
    console.error('[SQLCASES] fixture generation failed:', err);
    data = null;
  }
  renderSchema();
  renderValues();
  el.parseStatus.textContent = t('ui.parsedAs', { statement: result.model.statement.toUpperCase(), n: result.cases.length });
  renderAnalysis(result.model);
  renderFindings(result.findings);
  renderCoverage(result.coverage);
  updateTechniqueCounts(result.stats);
  if (activeTechnique && !result.stats.byTechnique[activeTechnique]) activeTechnique = '';
  renderTechniqueFilter(result.stats);
  renderClauseFilter();
  renderColumnFilter();
  renderImpactFilter();
  setStats(result.stats);
  renderTable();
}

/** Single mode: parse, generate and render one query. */
function runFor(sql, errorsEl) {
  if (!sql.trim()) {
    current = null;
    data = null;
    expanded.clear();
    renderSchema();
    renderValues();
    errorsEl.hidden = true;
    el.parseStatus.textContent = t('ui.parseHint');
    renderAnalysis(null);
    renderFindings([]);
    renderCoverage([]);
    el.techFilter.replaceChildren();
    renderClauseFilter();
    renderColumnFilter();
    renderImpactFilter();
    setStats(null);
    renderTable();
    return;
  }

  let result;
  try {
    result = generateCases(sql, readOptions());
  } catch (err) {
    console.error('[SQLCASES] generation failed:', err);
    current = null;
    data = null;
    expanded.clear();
    renderSchema();
    renderValues();
    errorsEl.replaceChildren(node('div', null, t('ui.genFailed', { message: err.message })));
    errorsEl.hidden = false;
    setStats(null);
    renderTable();
    return;
  }

  renderResult(sql, result, errorsEl);
}

/**
 * Compare mode: one generateComparison() call drives the whole page — the
 * case table, findings etc. still come off the "after" query (now with
 * `.impact` tagged on each case), and the diff panel comes off the same
 * call's `.diff` rather than a second, separate diffQueries() run.
 */
function runCompare() {
  const beforeSql = el.sql.value;
  const afterSql = el.sqlAfter.value;

  if (!afterSql.trim()) {
    // Nothing to generate cases from yet — still show whatever is wrong
    // with the "before" side, so a mistake there does not read as silence.
    const beforeParsed = parse(beforeSql);
    renderParseProblems(beforeSql, beforeParsed, el.parseErrors);
    renderDiff(null);
    renderStale([]);
    runFor('', el.parseErrorsAfter);
    return;
  }

  let comparison;
  try {
    comparison = generateComparison(beforeSql, afterSql, readOptions());
  } catch (err) {
    console.error('[SQLCASES] comparison failed:', err);
    current = null;
    data = null;
    expanded.clear();
    renderSchema();
    renderValues();
    el.parseErrorsAfter.replaceChildren(node('div', null, t('ui.genFailed', { message: err.message })));
    el.parseErrorsAfter.hidden = false;
    setStats(null);
    renderTable();
    renderDiff(null);
    renderStale([]);
    return;
  }

  // The before side never drives the results pane, only its own errors —
  // its cases are only consulted below, for which of them the after-side
  // change left with no source element to test any more.
  renderParseProblems(beforeSql, comparison.before, el.parseErrors);
  renderResult(afterSql, comparison.after, el.parseErrorsAfter);
  renderDiff(comparison.diff);
  renderStale(comparison.before.ok ? comparison.before.cases.filter(c => c.impact === 'stale') : []);
}

function run() {
  if (mode !== 'compare') {
    renderDiff(null);
    renderStale([]);
    runFor(el.sql.value, el.parseErrors);
    return;
  }
  runCompare();
}

function setStats(stats) {
  const enabled = !!stats && stats.total > 0;
  el.stats.total.textContent = stats?.total ?? 0;
  el.stats.high.textContent = stats?.byPriority.High ?? 0;
  el.stats.conds.textContent = stats?.conditions ?? 0;
  el.stats.joins.textContent = stats?.joins ?? 0;
  el.stats.tables.textContent = stats?.tables ?? 0;
  [el.csv, el.json, el.copyJson].forEach(b => { b.disabled = !enabled; });
  const hasData = enabled && !!data && data.schema.tables.length > 0;
  [el.dataCsv, el.verifySql].forEach(b => { b.disabled = !hasData; });
}

// ---- persistence -----------------------------------------------------

function saveState() {
  const techniques = {};
  TECHNIQUES.forEach(tech => {
    techniques[tech.key] = el.techList.querySelector(`input[data-tech="${tech.key}"]`)?.checked ?? true;
  });
  storage?.set({
    [STATE_KEY]: {
      sql: el.sql.value,
      sqlAfter: el.sqlAfter.value,
      mode,
      techniques,
      maxFullTable: el.maxFull.value,
      includeJoinConditions: el.joinConds.checked
    },
    [LANG_KEY]: getLang()
  });
}

function restoreState(done) {
  if (!storage) { applyTheme('light'); setLang(DEFAULT_LANG); done(); return; }
  storage.get([STATE_KEY, THEME_KEY, LANG_KEY, PANELS_KEY, VALUES_KEY], (res) => {
    applyTheme(res?.[THEME_KEY] === 'dark' ? 'dark' : 'light');
    // Only select the language here. Rendering and the first generation wait
    // until the saved query is back in the textarea, so startup runs once.
    setLang(res?.[LANG_KEY] || DEFAULT_LANG);
    applyPanelState(res?.[PANELS_KEY]);
    // Before the first generation: the saved values are an input to it, not a
    // decoration applied to the result afterwards.
    valuebook.load(res?.[VALUES_KEY]);
    const s = res?.[STATE_KEY];
    setMode(s?.mode);
    if (s) {
      if (typeof s.sql === 'string') el.sql.value = s.sql;
      if (typeof s.sqlAfter === 'string') el.sqlAfter.value = s.sqlAfter;
      if (s.maxFullTable) el.maxFull.value = s.maxFullTable;
      if (typeof s.includeJoinConditions === 'boolean') el.joinConds.checked = s.includeJoinConditions;
      if (s.techniques) {
        Object.entries(s.techniques).forEach(([key, on]) => {
          const input = el.techList.querySelector(`input[data-tech="${key}"]`);
          if (input) input.checked = !!on;
        });
      }
    }
    done();
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  el.theme.textContent = theme === 'dark' ? '☀️' : '🌙';
}

/**
 * Fill in every element carrying a data-i18n attribute.
 *
 * Called on load and again on each language switch, so the same code path
 * produces the initial render and every later one — there is no separate
 * "translate what is already on screen" pass that could fall out of step.
 */
function applyStaticText() {
  document.querySelectorAll('[data-i18n]').forEach(n => { n.textContent = t(n.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach(n => { n.placeholder = t(n.dataset.i18nPh); });
  document.querySelectorAll('[data-i18n-title]').forEach(n => { n.title = t(n.dataset.i18nTitle); });

  // Option elements that carry no key: the decision-table sizes are computed,
  // and the examples dropdown is keyed by position.
  [...el.maxFull.options].forEach(opt => {
    const n = Number(opt.value);
    opt.textContent = t('ui.condRules', { n, rules: Math.pow(2, n) });
  });
  [...el.sample.options].forEach((opt, i) => {
    opt.textContent = i === 0 ? t('ui.examples') : t(EXAMPLES[i - 1].labelKey);
  });

  // Technique checkbox labels.
  TECHNIQUES.forEach(tech => {
    const name = el.techList.querySelector(`input[data-tech="${tech.key}"]`)?.parentElement
      ?.querySelector('.tech-name');
    if (name) name.textContent = t(tech.labelKey);
  });

  document.querySelectorAll('.help-lang').forEach(n => {
    n.hidden = n.dataset.helpLang !== getLang();
  });
  document.documentElement.lang = getLang();
  el.langLabel.textContent = (LANGUAGES.find(l => l.code === getLang()) || LANGUAGES[0]).short;

  // #sqlLabel carries a fixed data-i18n key for single mode; compare mode
  // overrides it below, so redo that override after the generic pass above
  // would otherwise put the single-mode label back.
  el.sqlLabel.textContent = t(mode === 'compare' ? 'ui.sqlQueryBefore' : 'ui.sqlQuery');
}

/** Switch language, retranslate the chrome, then regenerate so cases follow. */
function applyLanguage(code) {
  setLang(code);
  applyStaticText();
  run();
}

/**
 * Switch between analysing one query and diffing two.
 *
 * The "before" side reuses #sqlInput rather than adding a third textarea —
 * one query is one query whichever mode is active, only its role and label
 * change, and the AFTER card is added/removed around it.
 */
function setMode(next) {
  mode = next === 'compare' ? 'compare' : 'single';
  el.modeToggle.querySelectorAll('button[data-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  el.sqlAfterCard.hidden = mode !== 'compare';
  el.sqlLabel.textContent = t(mode === 'compare' ? 'ui.sqlQueryBefore' : 'ui.sqlQuery');
}

// ---- wiring ----------------------------------------------------------

function initExamples() {
  const placeholder = document.createElement('option');
  placeholder.value = '';
  el.sample.append(placeholder);
  EXAMPLES.forEach((ex, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    el.sample.append(opt);
  });
  el.sample.addEventListener('change', () => {
    const ex = EXAMPLES[Number(el.sample.value)];
    if (!ex) return;
    el.sql.value = ex.sql;
    el.sample.value = '';
    saveState();
    run();
  });
}

function initExports() {
  el.csv.addEventListener('click', () => {
    if (!current) return;
    downloadText(toCsv(current.cases), suggestFilename(current, 'csv'), 'text/csv');
    toast(t('ui.toastCsv', { n: current.cases.length }));
  });

  el.json.addEventListener('click', () => {
    if (!current) return;
    downloadText(toJson(activeSql(), current), suggestFilename(current, 'json'), 'application/json');
    toast(t('ui.toastJson'));
  });

  el.dataCsv.addEventListener('click', () => {
    if (!current || !data) return;
    const files = fixturesToCsv(data.schema, data.fixtures, current.cases).filter(f => f.rows > 0);
    // One file per table, as asked. chrome.downloads queues them, so a
    // multi-table query produces several downloads from the single click.
    files.forEach(f => downloadText(f.csv, `testdata_${f.table.replace(/[^a-z0-9_-]+/gi, '_')}.csv`, 'text/csv'));
    toast(t('dg.toastCsv', { n: files.length }));
  });

  el.verifySql.addEventListener('click', () => {
    if (!current) return;
    const lines = [`-- ${t('dg.verifyHeader')}`, `-- ${t('dg.verifyIntro')}`, ''];
    current.cases.forEach(c => {
      const v = verifyFor(activeSql(), c);
      lines.push(`-- ${'='.repeat(70)}`);
      lines.push(`-- ${v.header}`);
      lines.push(`-- ${t('dg.expected')}: ${v.expectation}`);
      lines.push(v.sql, '');
    });
    downloadText(lines.join('\n'), suggestFilename(current, 'sql'), 'text/plain');
    toast(t('dg.toastVerify'));
  });

  el.copyJson.addEventListener('click', async () => {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(toJson(activeSql(), current));
      toast(t('ui.toastCopied'));
    } catch (err) {
      console.error('[SQLCASES] clipboard write failed:', err);
      toast(t('ui.toastCopyFail'));
    }
  });
}

function init() {
  buildTechniqueList();
  initPanels();
  initExamples();
  initExports();

  el.analyze.addEventListener('click', () => { saveState(); run(); });

  el.sql.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      saveState();
      run();
    }
  });

  // Typing re-runs on a debounce: generation is pure and fast enough that
  // waiting for a button press only makes the tool feel slower than it is.
  let debounce = null;
  el.sql.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { saveState(); run(); }, 500);
  });

  el.sqlAfter.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      saveState();
      run();
    }
  });
  let debounceAfter = null;
  el.sqlAfter.addEventListener('input', () => {
    clearTimeout(debounceAfter);
    debounceAfter = setTimeout(() => { saveState(); run(); }, 500);
  });

  el.modeToggle.querySelectorAll('button[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.mode === mode) return;
      setMode(btn.dataset.mode);
      saveState();
      run();
    });
  });

  el.clear.addEventListener('click', () => {
    el.sql.value = '';
    el.sqlAfter.value = '';
    saveState();
    run();
    el.sql.focus();
  });

  el.resetValues.addEventListener('click', () => {
    if (!valuebook.clearAll()) return;
    saveValues();
    run();
    toast(t('vb.toastReset'));
  });

  el.maxFull.addEventListener('change', () => { saveState(); run(); });
  el.joinConds.addEventListener('change', () => { saveState(); run(); });
  el.prioFilter.addEventListener('change', renderTable);
  el.search.addEventListener('input', renderTable);
  el.clauseFilter.addEventListener('change', () => { activeClause = el.clauseFilter.value; renderTable(); });
  el.columnFilter.addEventListener('change', () => { activeColumn = el.columnFilter.value; renderTable(); });
  el.fixtureFilter.addEventListener('change', () => { onlyWithFixture = el.fixtureFilter.checked; renderTable(); });

  el.theme.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    storage?.set({ [THEME_KEY]: next });
  });

  el.lang.addEventListener('click', () => {
    const idx = LANGUAGES.findIndex(l => l.code === getLang());
    applyLanguage(LANGUAGES[(idx + 1) % LANGUAGES.length].code);
    saveState();
  });

  el.help.addEventListener('click', () => { el.helpModal.hidden = false; });
  el.helpClose.addEventListener('click', () => { el.helpModal.hidden = true; });
  el.helpModal.addEventListener('click', (e) => {
    if (e.target === el.helpModal) el.helpModal.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.helpModal.hidden) el.helpModal.hidden = true;
  });

  restoreState(() => {
    applyStaticText();
    run();
    el.sql.focus();
  });
}

init();
