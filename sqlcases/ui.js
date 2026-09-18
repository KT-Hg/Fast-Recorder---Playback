/**
 * ui.js — Page wiring for the SQL Test Case Designer.
 *
 * Everything below the surface lives in generate.js and the technique modules;
 * this file only renders what they return and keeps the query, the technique
 * toggles, the layout and the theme in chrome.storage.local so reopening the
 * tab lands where the user left off.
 *
 * The page is three columns: a rail of inputs, a list of cases, and an
 * inspector holding one case. All three are written out in sqlcases.html and
 * only toggled here — the query textarea has a caret and an undo stack, and
 * rebuilding it on a tab switch would throw both away. What this file builds
 * from scratch is what changes with every run: the case cards, the inspector,
 * the chips and bars in the insight block.
 *
 * Rendering builds nodes rather than assigning innerHTML: case text is derived
 * from the user's own SQL, and a table name containing angle brackets should
 * appear as text, not become markup.
 */

import { generateCases, generateComparison, TECHNIQUES, DEFAULT_OPTIONS } from './generate.js';
import { toCsv, toJson, suggestFilename, downloadText } from './export.js';
import { t, tAlt, setLang, getLang, LANGUAGES, DEFAULT_LANG } from './i18n.js';
import { buildAllFixtures, fixturesToCsv, valueSlots, verifyFor } from './datagen.js';
import { parse } from './parser.js';
import * as valuebook from './valuebook.js';
import { mountDiagram, keyTag } from './diagram.js';

const THEME_KEY = 'popupTheme';
const STATE_KEY = 'sqlCasesState';
const LANG_KEY = 'sqlCasesLang';
const UI_KEY = 'sqlCasesUi';
const VALUES_KEY = 'sqlCasesValues';

/**
 * Extension storage, or null when the page is opened as a plain file.
 * Everything it holds is a convenience (last query, toggles, theme), so the
 * page stays fully usable without it rather than failing to start.
 */
const storage = (typeof chrome !== 'undefined' && chrome.storage?.local) || null;

/**
 * storage.set() wrapped to surface a write failure (quota exceeded, revoked
 * permission) instead of swallowing it — otherwise the query, theme or
 * sample values look saved right up until the page is reopened and they
 * turn out not to be, with nothing having said so in between.
 */
function storageSet(items) {
  if (!storage) return;
  storage.set(items, () => {
    if (chrome.runtime.lastError) {
      console.error('[SQLCASES] storage write failed:', chrome.runtime.lastError);
      toast(t('ui.toastSaveError'), 'error');
    }
  });
}

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
  app: $('app'),
  // rail
  rail: $('rail'),
  railTabs: $('railTabs'),
  railClose: $('btnRailClose'),
  railToggle: $('btnRail'),
  railTabSqlLabel: $('railTabSqlLabel'),
  railTechCount: $('railTechCount'),
  railValuesCount: $('railValuesCount'),
  railSchemaCount: $('railSchemaCount'),
  // rail: query pane
  sql: $('sqlInput'),
  sqlLabel: $('sqlLabel'),
  modeToggle: $('modeToggle'),
  sqlAfterCard: $('sqlAfterCard'),
  sqlAfter: $('sqlInputAfter'),
  parseErrors: $('parseErrors'),
  parseErrorsAfter: $('parseErrorsAfter'),
  sample: $('sampleSelect'),
  clear: $('btnClear'),
  parseStatus: $('parseStatus'),
  analyze: $('btnAnalyze'),
  // rail: technique pane
  techList: $('techList'),
  techSummary: $('techSummary'),
  maxFull: $('optMaxFull'),
  joinConds: $('optJoinConds'),
  // rail: values pane
  valuesBody: $('valuesBody'),
  valuesSummary: $('valuesSummary'),
  resetValues: $('btnResetValues'),
  // rail: schema pane
  schemaBody: $('schemaBody'),
  schemaSummary: $('schemaSummary'),
  diagramBtn: $('btnDiagram'),
  // the diagram modal
  diagramModal: $('diagramModal'),
  dgStage: $('dgStage'),
  dgWorld: $('dgWorld'),
  dgLinks: $('dgLinks'),
  dgZoom: $('dgZoom'),
  dgCount: $('dgCount'),
  dgHint: $('dgHint'),
  dgClose: $('btnDgClose'),
  dgFit: $('btnDgFit'),
  dgZoomIn: $('btnDgZoomIn'),
  dgZoomOut: $('btnDgZoomOut'),
  // centre: head
  exportBtn: $('btnExport'),
  exportMenu: $('exportMenu'),
  inspToggle: $('btnInsp'),
  csv: $('btnCsv'),
  json: $('btnJson'),
  copyJson: $('btnCopyJson'),
  dataCsv: $('btnDataCsv'),
  verifySql: $('btnVerifySql'),
  // centre: triage
  triage: $('triage'),
  triChangedN: $('triChangedN'),
  triUnrelatedN: $('triUnrelatedN'),
  triStaleN: $('triStaleN'),
  // centre: insight
  insight: $('insight'),
  insightTabs: $('insightTabs'),
  insightToggle: $('btnInsight'),
  diffBody: $('diffBody'),
  findings: $('findings'),
  findingsDot: $('findingsDot'),
  coverage: $('coverage'),
  staleBody: $('staleBody'),
  analysisBody: $('analysisBody'),
  itabDiffN: $('itabDiffN'),
  itabFindingsN: $('itabFindingsN'),
  itabCoverageN: $('itabCoverageN'),
  itabStaleN: $('itabStaleN'),
  // centre: command bar
  cmdbarDock: $('cmdbarDock'),
  cmdbar: $('cmdbar'),
  search: $('searchBox'),
  filtersBtn: $('btnFilters'),
  filterPop: $('filterPop'),
  filterCount: $('filterCount'),
  clearFilters: $('btnClearFilters'),
  closeFilters: $('btnCloseFilters'),
  density: $('density'),
  techFilter: $('techFilter'),
  prioFilter: $('prioFilter'),
  clauseFilter: $('clauseFilter'),
  columnFilter: $('columnFilter'),
  fixtureFilter: $('fixtureFilter'),
  // centre: list
  listwrap: $('listwrap'),
  caseList: $('caseList'),
  empty: $('emptyState'),
  emptySteps: $('emptySteps'),
  emptyClear: $('btnEmptyClear'),
  // right: inspector
  insp: $('insp'),
  inspInner: $('inspInner'),
  // chrome
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

/** The rail panes, keyed by the tab that shows them. */
const RAIL_PANES = { sql: $('paneSql'), tech: $('paneTech'), values: $('paneValues'), schema: $('paneSchema') };
/** The insight panes, keyed by the tab that shows them. */
const INSIGHT_PANES = {
  diff: $('paneDiff'), findings: $('paneFindings'), coverage: $('paneCoverage'),
  stale: $('paneStale'), analysis: $('paneAnalysis')
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
/**
 * True when the last buildAllFixtures() call threw instead of producing
 * `data`. Lets the inspector's "no fixture" message tell a genuine no-fixture
 * case (by design) apart from every case going fixture-less because
 * generation itself blew up — those looked identical before this flag
 * existed. Only fires the toast on the rising edge so re-running the same
 * broken query on every keystroke doesn't spam it.
 */
let fixtureError = false;
/** The one case the inspector is showing, or null. */
let selectedId = null;
/** 'single' analyses #sqlInput alone; 'compare' diffs it against #sqlInputAfter. */
let mode = 'single';
/** Cases from the "before" query whose source no longer exists (compare mode). */
let staleCases = [];

// ---- layout state ----------------------------------------------------

/**
 * Which of the two collapsible columns are open, which tab each tabbed block
 * is on, and how tall a case card is.
 *
 * Persisted, because all six are decisions about how the user wants to work
 * rather than about one query: someone who runs on a laptop with the rail shut
 * and the list dense wants that back tomorrow, not a fresh three-column page.
 */
let railTab = 'sql';
let railOpen = true;
let inspOpen = true;
let insightTab = '';
let insightOpen = false;
let density = 'full';

/**
 * Group headings the reader has shut, by name.
 *
 * Kept in memory rather than in storage: a collapsed group is a statement
 * about the list on screen right now ("I have read the eight cancelled_at
 * cases, get them out of my way"), and carrying it into tomorrow's query —
 * whose groups are named after different columns — would only ever surprise.
 */
const collapsedGroups = new Set();

/**
 * What was shut before the search box was typed into, or null when it is empty.
 *
 * A search is a request to see what matched, so it opens everything: leaving a
 * group shut would hide the very rows the box was typed to find and read as
 * "no results". Shutting a group while a search is running still works, and
 * clearing the box puts the list back in the shape it had before.
 */
let collapsedBeforeSearch = null;

/**
 * Which insight tabs have anything behind them, and what their badges say.
 *
 * The render functions below own these: each sets its own slot and then asks
 * renderInsight() to redraw. Keeping availability here rather than as a
 * `hidden` flag on the pane itself is what lets one pane be "has content" and
 * "not the tab you are looking at" at the same time — a distinction the old
 * accordions never had to make.
 */
/**
 * True while a run is in flight.
 *
 * The panes report in one at a time — analysis, then findings, then coverage,
 * then the diff — and each asks for a redraw as it lands. Without this, the
 * first one to report is briefly the *only* thing available, and the tab
 * fallback below would treat the reader's chosen tab as gone and move them off
 * it. run() raises this for the whole pipeline and resolves the tab once, at
 * the end, when every pane has actually said whether it has anything.
 */
let insightSettling = false;

const insight = {
  diff: { available: false, count: 0 },
  findings: { available: false, count: 0, level: '' },
  coverage: { available: false, count: 0 },
  stale: { available: false, count: 0 },
  analysis: { available: false }
};

function saveUi() {
  storageSet({ [UI_KEY]: { railTab, railOpen, inspOpen, insightTab, insightOpen, density } });
}

function applyUiState(state) {
  if (!state) return;
  if (RAIL_PANES[state.railTab]) railTab = state.railTab;
  if (typeof state.railOpen === 'boolean') railOpen = state.railOpen;
  if (typeof state.inspOpen === 'boolean') inspOpen = state.inspOpen;
  if (INSIGHT_PANES[state.insightTab]) insightTab = state.insightTab;
  if (typeof state.insightOpen === 'boolean') insightOpen = state.insightOpen;
  if (state.density === 'dense' || state.density === 'full') density = state.density;
}

// ---- small helpers ---------------------------------------------------

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

/**
 * The controls the page's geometry hangs off.
 *
 * A Vietnamese label runs up to half again as long as its English one, so a
 * control sized to the text currently on screen changes width at every
 * language switch and drags everything beside it along — a right-anchored row
 * of export buttons slid 48px, the mode pills 49px the other way. Each of
 * these reserves the width of its longest translation instead (the ghost on
 * `[data-i18n-alt]` in sqlcases.css does the measuring), so a switch re-letters
 * the chrome without moving it.
 *
 * Most entries name a `> [data-i18n]` child rather than the control: a ghost is
 * an ::after box, and on a flex container it would become a flex item and take
 * real space. The labels that are already their own span are measured directly.
 *
 * Deliberately not every label on the page: prose that wraps — the subtitle,
 * the hints, the help modal, the triage descriptions — has no fixed width to
 * hold, and reserving one for it would only waste the row it sits in.
 */
const WIDTH_STABLE = [
  '.topbar-title [data-i18n]',        // the subtitle starts where this one ends
  '.topbar-actions button > [data-i18n]',
  '.rtab > [data-i18n]',              // the rail tabs sit in one non-wrapping row
  '.itab > [data-i18n]',
  '.pane-head .pill > [data-i18n]',   // mode pills; the examples select takes what they leave
  '.pane-head button > [data-i18n]',
  '.vb-head button > [data-i18n]',
  '.rail-foot button',
  '.metric-l',                        // every metric after it shifts by the difference
  '.main-head-actions button > [data-i18n]',
  '.cmd-actions button > [data-i18n]',
  '.seg button',
  '.cmd-lbl',
  '.check-row-inline span'
].join(', ');

/**
 * Write a translated label, and on the controls listed in `WIDTH_STABLE` also
 * reserve the width of the same label in the other language.
 */
function setLabel(target, key, params) {
  target.textContent = t(key, params);
  if (target.matches(WIDTH_STABLE)) target.dataset.i18nAlt = tAlt(key, params);
}

/**
 * A filter pill's label, in a box of its own so the reservation covers the
 * label and nothing else — the count beside it is the same width in every
 * language and must not be measured with it.
 */
function pillLabel(key) {
  const span = node('span', null, t(key));
  span.dataset.i18nAlt = tAlt(key);
  return span;
}

let toastTimer = null;
/**
 * `type` picks the toast's colour ('success' | 'error' | 'warn') so a failure
 * reads as a failure instead of looking identical to a confirmation — call
 * sites must pass it explicitly rather than rely on a default, since silently
 * defaulting a forgotten call to 'success' would make a real error look fine.
 */
function toast(message, type, ms = 2200) {
  el.toast.textContent = message;
  el.toast.className = `toast toast-${type}`;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  // `ms` is for the rare message that has to be read rather than glanced at —
  // the first-run note, which arrives while the reader is still taking the
  // page in. Every confirmation after an action keeps the default.
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
}

/**
 * CSS-safe suffix for a technique badge class.
 *
 * Letters and digits, so "NULL / 3VL" keeps its 3 and stays distinguishable
 * from a future "NULLVL"; the codes are a short fixed enum, so there is no
 * length to guard against. The selectors are in sqlcases.css under
 * `.tech-badge`, and a code with no rule there degrades to the neutral badge.
 */
function techClass(technique) {
  return 'tech-' + technique.replace(/[^A-Za-z0-9]/g, '');
}

/**
 * A case's `technique` is usually one code ('EP'), but can be several joined
 * with '+' when two techniques converged on the exact same case (e.g.
 * 'EP+BVA' — see mergeOverlaps() in ep-bva.js). Filtering by 'EP' alone must
 * still surface that merged case — it genuinely is an EP case, just also a
 * BVA one — so this checks membership rather than exact equality.
 */
function techniqueMatches(caseTechnique, filterValue) {
  return caseTechnique === filterValue || caseTechnique.split('+').includes(filterValue);
}

/**
 * The technique badge shown on a case card and in the inspector header.
 *
 * A plain technique renders as the usual single-colour pill. A merged one
 * ('EP+BVA' — see mergeOverlaps() in ep-bva.js) renders as one pill with a
 * smooth gradient between the two techniques' own soft backgrounds, and
 * "EP"/"BVA" each kept in that technique's own text colour (see
 * `.tech-badge-split` in sqlcases.css) — the two original badges' colours
 * combined into one, rather than a third colour belonging to neither.
 */
function techBadge(technique) {
  const codes = technique.split('+');
  if (codes.length === 1) {
    return node('span', `tech-badge ${techClass(technique)}`, t('tech.code.' + technique));
  }
  const badge = node('span', `tech-badge tech-badge-split ${techClass(technique)}`);
  codes.forEach((code, i) => {
    if (i > 0) badge.append(node('span', 'tech-badge-sep', '+'));
    badge.append(node('span', `tech-badge-part ${techClass(code)}`, t('tech.code.' + code)));
  });
  return badge;
}

/** Line and column of a character offset, for parse-error messages. */
function positionOf(sql, pos) {
  const upto = sql.slice(0, Math.max(0, pos));
  const line = upto.split('\n').length;
  const col = pos - upto.lastIndexOf('\n');
  return { line, col };
}

/**
 * Colour one block of SQL for display.
 *
 * Comments and strings come first so a keyword inside either stays plain, and
 * the result is a fragment of spans rather than a string of markup: the text
 * is the user's own query, and the whole point of building nodes elsewhere in
 * this file would be lost if the one place that shows the query verbatim
 * handed it to innerHTML.
 */
const SQL_TOKEN = new RegExp([
  /(--[^\n]*)/,                                        // 1 comment
  /('(?:[^']|'')*')/,                                  // 2 string
  /(:[A-Za-z_]\w*|\?)/,                                // 3 bind parameter
  /\b(SELECT|FROM|WHERE|GROUP|ORDER|BY|HAVING|LEFT|RIGHT|FULL|INNER|CROSS|OUTER|JOIN|ON|AND|OR|NOT|IN|IS|NULL|BETWEEN|LIKE|AS|LIMIT|OFFSET|DESC|ASC|DISTINCT|COUNT|SUM|AVG|MIN|MAX|COALESCE|CASE|WHEN|THEN|ELSE|END|UPDATE|SET|INSERT|INTO|VALUES|DELETE|EXISTS|UNION|ALL|WITH|NULLS|FIRST|LAST|TRUE|FALSE|UNKNOWN)\b/,
  /\b(\d+(?:\.\d+)?)\b/                                // 5 number
].map(r => r.source).join('|'), 'gi');

function sqlHighlight(text) {
  const frag = document.createDocumentFragment();
  const re = new RegExp(SQL_TOKEN.source, 'gi');
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) frag.append(document.createTextNode(text.slice(last, m.index)));
    const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'p' : m[4] ? 'k' : 'n';
    frag.append(node('span', cls, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
  return frag;
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
    const name = node('span', 'tech-name');
    setLabel(name, tech.labelKey);
    // The name is the technique's own term — "EP + BVA", "MC/DC" — which only
    // says what the cases are for to someone who already knows it. The line
    // under it says that in plain words. It carries data-i18n rather than a
    // second explicit pass in applyStaticText(): the generic sweep there
    // already retranslates anything holding that attribute.
    const desc = node('span', 'tech-desc');
    desc.dataset.i18n = `tech.desc.${tech.key}`;
    setLabel(desc, desc.dataset.i18n);
    const text = node('span', 'tech-text');
    text.append(name, desc);
    label.append(input, text, node('span', 'tech-count', ''));
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
  if (!model) { insight.analysis.available = false; renderInsight(); return; }

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

  insight.analysis.available = true;
  renderInsight();
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
  const tables = data?.schema.tables || [];
  // A diagram left open across a run would be a picture of the query before
  // it: redraw it from the new schema, or shut it if there is no longer one.
  if (diagram) {
    if (tables.length) openDiagram();
    else closeDiagram();
  }
  if (!tables.length) {
    el.schemaSummary.textContent = '';
    renderRail();
    return;
  }

  tables.forEach(tbl => {
    const box = node('div', 'sc-table');
    const head = node('div', 'sc-name', tbl.name);
    if (tbl.alias) head.append(node('span', 'chip-type', ` ${tbl.alias}`));
    box.append(head);

    const cols = node('div', 'sc-cols');
    tbl.columns.forEach(c => {
      const row = node('div', 'sc-col');
      row.append(node('span', 'sc-col-name', c.name));
      row.append(node('span', 'sc-col-type', c.type));
      // Every badge goes in the same right-hand lane, so PK, FK and NOT NULL
      // line up down the panel instead of each landing wherever its own text
      // happened to run out.
      const tags = node('div', 'sc-col-tags');
      const tag = keyTag(c, { showTarget: true, showNotNull: true });
      if (tag) tags.append(tag);
      if (c.synthetic) tags.append(node('span', 'chip-type', t('dg.synthetic')));
      if (tags.childElementCount) row.append(tags);
      cols.append(row);
    });
    box.append(cols);
    el.schemaBody.append(box);
  });

  data.schema.notes.forEach(n => {
    el.schemaBody.append(node('div', 'fx-note', t(n.key, n.params)));
  });

  el.schemaSummary.textContent = t('ui.sumSchema', {
    tables: tables.length,
    columns: tables.reduce((sum, x) => sum + x.columns.length, 0)
  });
  renderRail();
}

/**
 * The open diagram, or null. It owns listeners on the stage and boxes of its
 * own making, so it is torn down rather than left to be garbage — and it is
 * rebuilt on every open, because the schema behind it changes with every run.
 */
let diagram = null;

function openDiagram() {
  const tables = data?.schema.tables || [];
  if (!tables.length) return;

  el.diagramModal.hidden = false;
  // Mounted only once the modal is on screen: the boxes are measured as they
  // are built, and a box inside `hidden` measures nothing at all.
  diagram?.destroy();
  diagram = mountDiagram({
    stage: el.dgStage,
    world: el.dgWorld,
    svg: el.dgLinks,
    tables,
    onZoom: (scale) => { el.dgZoom.textContent = `${Math.round(scale * 100)}%`; }
  });

  el.dgCount.textContent = t('dg.diagramCount', { tables: diagram.tables, links: diagram.links });
  // A query over one table has nothing to link, which is worth saying outright
  // rather than leaving the reader to wonder where the lines went.
  el.dgHint.textContent = t(diagram.links ? 'dg.diagramHint' : 'dg.diagramNoLinks');
  diagram.fit();
}

function closeDiagram() {
  el.diagramModal.hidden = true;
  diagram?.destroy();
  diagram = null;
}

// ---- rendering: the value book ---------------------------------------

/** Set by a reset, so focus lands back on the field the button belonged to. */
let pendingValueFocus = null;

/** How many editable values the current run produced — the rail tab's badge. */
let valueCount = 0;

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
  valueCount = 0;

  if (!current?.model) { renderRail(); return; }

  const book = valueSlots(current.model, data?.schema, data?.fixtures);
  if (!book.total) { renderRail(); return; }

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

  valueCount = book.total;
  el.valuesSummary.textContent = t('vb.sum', { overridden: book.overridden, total: book.total });
  el.resetValues.disabled = book.overridden === 0;
  renderRail();

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
  storageSet({ [VALUES_KEY]: valuebook.toJSON() });
}

// ---- rendering: findings & coverage ----------------------------------

const FINDING_ICON = { error: '⛔', warn: '⚠', info: 'ℹ' };

function renderFindings(findings) {
  el.findings.replaceChildren();

  if (!findings.length) {
    insight.findings = { available: false, count: 0, level: '' };
    renderInsight();
    return;
  }

  findings.forEach(f => {
    const row = node('div', `finding finding-${f.level}`);
    row.append(node('span', 'finding-icon', FINDING_ICON[f.level] || 'ℹ'));
    row.append(node('span', null, f.message));
    el.findings.append(row);
  });

  const counts = { error: 0, warn: 0, info: 0 };
  findings.forEach(f => { if (counts[f.level] !== undefined) counts[f.level]++; });

  insight.findings = {
    available: true,
    count: findings.length,
    level: counts.error ? 'err' : counts.warn ? 'warn' : ''
  };
  // An error is worth opening unasked; warnings and notes are not. Only when
  // the block is shut, though: generation re-runs on every keystroke, and
  // while the query holds an error that would drag the reader off whichever
  // tab they had deliberately opened, once per character typed.
  if (counts.error && !insightOpen) { insightTab = 'findings'; insightOpen = true; }
  renderInsight();
}

function renderCoverage(summaries) {
  el.coverage.replaceChildren();
  if (!summaries.length) {
    insight.coverage = { available: false, count: 0 };
    renderInsight();
    return;
  }

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

  insight.coverage = { available: true, count: summaries.length };
  renderInsight();
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

  if (!diff) {
    insight.diff = { available: false, count: 0 };
    renderInsight();
    return;
  }

  if (!diff.ok) {
    el.diffBody.append(node('div', 'helper', t('diff.parseFailed')));
    insight.diff = { available: true, count: 0 };
    renderInsight();
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

  insight.diff = { available: true, count: diff.summary.totalChanges };
  renderInsight();
}

// ---- rendering: filters ----------------------------------------------

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

/** The small coloured marker shown beside a stale case. */
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

/**
 * Compare mode's three buckets, over the same run the list shows.
 *
 * Two of them are filters over the case list. The third is not — a stale case
 * is not in the list to be filtered down to, so that box opens the panel that
 * does hold them, which is the only place they exist.
 */
function renderTriage() {
  const counts = { changed: 0, unrelated: 0 };
  (current?.cases || []).forEach(c => { if (counts[c.impact] !== undefined) counts[c.impact]++; });
  const tagged = counts.changed + counts.unrelated > 0;

  if (!tagged && !staleCases.length) {
    el.triage.hidden = true;
    activeImpact = '';
    return;
  }

  el.triChangedN.textContent = counts.changed;
  el.triUnrelatedN.textContent = counts.unrelated;
  el.triStaleN.textContent = staleCases.length;

  el.triage.querySelector('[data-tri="changed"]').classList.toggle('active', activeImpact === 'changed');
  el.triage.querySelector('[data-tri="unrelated"]').classList.toggle('active', activeImpact === 'unrelated');
  el.triage.querySelector('[data-tri="stale"]')
    .classList.toggle('active', insightTab === 'stale' && insightOpen);
  el.triage.hidden = false;
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
      opt.textContent = `  ${col.raw}`;
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
 * main list, since they describe behaviour that no longer exists to test.
 */
function renderStale(list) {
  staleCases = list || [];
  el.staleBody.replaceChildren();

  if (!staleCases.length) {
    insight.stale = { available: false, count: 0 };
    renderInsight();
    return;
  }

  staleCases.forEach(c => {
    const row = node('div', 'stale-row');
    row.append(impactBadge('stale'));
    row.append(node('span', 'stale-title', `${c.title} — ${c.data}`));
    row.append(node('span', 'stale-group', `${t('tech.code.' + c.technique)} · ${c.group}`));
    el.staleBody.append(row);
  });

  insight.stale = { available: true, count: staleCases.length };
  renderInsight();
}

function renderTechniqueFilter(stats) {
  el.techFilter.replaceChildren();
  const codes = Object.keys(stats?.byTechnique || {});

  const mk = (key, value, count) => {
    const b = node('button', `pill${activeTechnique === value ? ' active' : ''}`);
    b.append(pillLabel(key));
    if (count !== undefined) b.append(node('span', 'pill-n', count));
    b.addEventListener('click', () => {
      activeTechnique = activeTechnique === value ? '' : value;
      renderTechniqueFilter(stats);
      renderList();
    });
    return b;
  };

  // A merged code like 'EP+BVA' counts towards its own pill *and* towards
  // 'EP' and 'BVA' individually — the count next to a pill should match how
  // many cases clicking it will actually show (see techniqueMatches()).
  const countFor = code => (current?.cases || []).filter(c => techniqueMatches(c.technique, code)).length;

  el.techFilter.append(mk('ui.filterAll', '', stats?.total ?? 0));
  codes.forEach(code => el.techFilter.append(mk('tech.code.' + code, code, countFor(code))));
  scheduleCmdHeight();
}

/** How many of the popover's filters are narrowing the list right now. */
function activeFilterCount() {
  return [el.prioFilter.value, activeClause, activeColumn].filter(Boolean).length + (onlyWithFixture ? 1 : 0);
}

function renderFilterCount() {
  const n = activeFilterCount();
  el.filterCount.hidden = !n;
  el.filterCount.textContent = n;
  el.filtersBtn.classList.toggle('active', !!n);
}

function clearAllFilters() {
  activeTechnique = '';
  activeClause = '';
  activeColumn = '';
  activeImpact = '';
  onlyWithFixture = false;
  el.search.value = '';
  el.prioFilter.value = '';
  el.clauseFilter.value = '';
  el.columnFilter.value = '';
  el.fixtureFilter.checked = false;
  renderTechniqueFilter(current?.stats);
  renderFilterCount();
  renderTriage();
  renderList();
}

/**
 * The heading a case belongs under.
 *
 * Every technique tags its cases with a group, but the heading is the only
 * thing separating one block from the next — an untagged case would open a
 * section with no name at all rather than joining a catch-all.
 */
function groupKeyOf(testCase) {
  return testCase.group || t('ui.groupOther');
}

function visibleCases() {
  if (!current) return [];
  const q = el.search.value.trim().toLowerCase();
  const prio = el.prioFilter.value;
  return current.cases.filter(c => {
    if (activeTechnique && !techniqueMatches(c.technique, activeTechnique)) return false;
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

// ---- rendering: the case list ----------------------------------------

/**
 * One case card.
 *
 * A button rather than a row: selecting a case is the only thing it does, and
 * a button gets keyboard focus, Enter and Space without any of it being
 * reimplemented here.
 */
function caseCard(testCase) {
  const card = node('button', 'case');
  card.type = 'button';
  card.dataset.id = testCase.id;
  if (testCase.notes) card.classList.add('has-note');
  if (testCase.id === selectedId) card.classList.add('selected');
  if (testCase.impact === 'changed' || testCase.impact === 'unrelated') {
    card.classList.add(`impact-${testCase.impact}`);
  }

  const l1 = node('span', 'l1');
  l1.append(node('span', 'cid', testCase.id));
  l1.append(techBadge(testCase.technique));
  l1.append(node('span', 'tgt', testCase.target));
  if (data?.fixtures.get(testCase.id)) {
    const fx = node('span', 'grpname', '🗃');
    fx.title = t('dg.fixture');
    l1.append(fx);
  }
  card.append(l1);

  const sp = node('span', 'sp');
  if (testCase.impact === 'changed') {
    sp.append(node('span', 'imp imp-changed', t('ui.impactChangedShort')));
  }
  sp.append(node('span', `prio prio-${testCase.priority}`, t('prio.' + testCase.priority)));
  card.append(sp);

  card.append(node('span', 'ttl', testCase.title));

  const l3 = node('span', 'l3');
  l3.append(node('span', 'dv', testCase.data));
  l3.append(node('span', 'arr', '→'));
  const ex = node('span', 'ex');
  ex.append(node('span', 'exv', testCase.expected));
  l3.append(ex);
  // The note goes on its own line across the whole card rather than under the
  // expected result. Sharing that column with a long value left it forty
  // pixels wide — "⚠ Type…" — which is not a warning, it is a rumour of one.
  if (testCase.notes) l3.append(node('span', 'note', `⚠ ${testCase.notes}`));
  card.append(l3);

  card.addEventListener('click', () => {
    selectedId = selectedId === testCase.id ? null : testCase.id;
    if (selectedId) inspOpen = true;
    saveUi();
    renderList();
    renderInspector();
    applyLayout();
  });
  return card;
}

/**
 * The case list, grouped by the `group` each technique tags its cases with.
 *
 * Grouping is not decoration: six boundary cases on one column are one idea,
 * and reading them as one block is what makes a list of forty cases reviewable
 * instead of merely long.
 */
function renderList() {
  const rows = visibleCases();
  syncSearchCollapse();
  el.caseList.replaceChildren();
  el.caseList.classList.toggle('dense', density === 'dense');

  if (!rows.length) {
    el.empty.hidden = false;
    el.caseList.hidden = true;

    const hasQuery = !!current;
    const filtered = hasQuery && current.cases.length > 0;
    el.empty.querySelector('.empty-title').textContent =
      t(filtered ? 'ui.noMatchTitle' : (hasQuery ? 'ui.nothingTitle' : 'ui.emptyTitle'));
    el.empty.querySelector('.empty-sub').textContent =
      t(filtered ? 'ui.noMatchSub' : (hasQuery ? 'ui.nothingSub' : 'ui.emptySub'));
    // The three steps are an answer to "what do I do here", so they belong on
    // the blank page and nowhere else; a filtered-to-nothing list gets the one
    // button that undoes it instead.
    el.emptySteps.hidden = hasQuery;
    el.emptyClear.hidden = !filtered;
    return;
  }

  el.empty.hidden = true;
  el.caseList.hidden = false;

  const groups = [];
  const byName = new Map();
  rows.forEach(c => {
    const name = groupKeyOf(c);
    let g = byName.get(name);
    if (!g) { g = { name, items: [] }; byName.set(name, g); groups.push(g); }
    g.items.push(c);
  });

  // Heading and body are siblings, not parent and child — see the note on
  // .case-sect-head in the stylesheet: it is what keeps the band under the
  // command bar showing one whole heading instead of a sliced one.
  const frag = document.createDocumentFragment();
  groups.forEach((g, i) => {
    const open = !collapsedGroups.has(g.name);
    const bodyId = `case-group-${i}`;

    const head = node('button', 'case-sect-head');
    head.type = 'button';
    head.dataset.group = g.name;
    head.setAttribute('aria-expanded', String(open));
    head.setAttribute('aria-controls', bodyId);
    head.title = t(open ? 'ui.groupCollapse' : 'ui.groupExpand');
    head.append(node('span', 'caret', '▾'));
    head.append(node('span', 't', g.name));
    head.append(node('span', 'n', g.items.length));
    head.append(node('span', 'line'));
    head.addEventListener('click', (e) => toggleGroup(g.name, groups, e.shiftKey));

    const body = node('div', 'case-sect-body');
    body.id = bodyId;
    body.hidden = !open;
    g.items.forEach(c => body.append(caseCard(c)));

    frag.append(head, body);
  });
  el.caseList.append(frag);
}

/**
 * Shut or open one group — or, with Shift held, every group at once.
 *
 * Collapsing a block that sits above the pointer would otherwise haul the rest
 * of the list up under it, so the heading that was clicked is put back on the
 * pixel it was clicked on and the scroll offset absorbs the difference.
 */
function toggleGroup(name, groups, all) {
  const scroller = el.caseList.closest('.main');
  const wasAt = headOf(name)?.getBoundingClientRect().top;

  if (all) {
    const anyOpen = groups.some(g => !collapsedGroups.has(g.name));
    groups.forEach(g => (anyOpen ? collapsedGroups.add(g.name) : collapsedGroups.delete(g.name)));
  } else if (collapsedGroups.has(name)) {
    collapsedGroups.delete(name);
  } else {
    collapsedGroups.add(name);
  }

  renderList();

  const nowAt = headOf(name)?.getBoundingClientRect().top;
  if (scroller && wasAt !== undefined && nowAt !== undefined) scroller.scrollTop += nowAt - wasAt;
}

/** Open every group for the duration of a search; put them back afterwards. */
function syncSearchCollapse() {
  const searching = !!el.search.value.trim();
  if (searching && !collapsedBeforeSearch) {
    collapsedBeforeSearch = new Set(collapsedGroups);
    collapsedGroups.clear();
  } else if (!searching && collapsedBeforeSearch) {
    collapsedGroups.clear();
    collapsedBeforeSearch.forEach(name => collapsedGroups.add(name));
    collapsedBeforeSearch = null;
  }
}

function headOf(name) {
  return el.caseList.querySelector(`.case-sect-head[data-group="${CSS.escape(name)}"]`);
}

// ---- rendering: the inspector ----------------------------------------

/**
 * The one case on screen in full: why it matters, the rows to create, anything
 * that could not be expressed as a row, and the query to run once the data is
 * in place.
 *
 * This is what used to be a detail row spliced into the table under the case,
 * which meant opening the fourth case pushed the fifth to the bottom of the
 * window. A fixed column holds the same content without moving anything.
 */
function renderInspector() {
  el.inspInner.replaceChildren();

  const testCase = current?.cases.find(c => c.id === selectedId);
  if (!testCase) {
    selectedId = null;
    const empty = node('div', 'insp-empty');
    const box = node('div');
    box.append(node('div', 'ic', '◧'));
    box.append(node('p', null, t('ui.inspEmpty')));
    empty.append(box);
    el.inspInner.append(empty);
    return;
  }

  const list = visibleCases();
  const at = list.findIndex(c => c.id === testCase.id);

  // --- head: identity and the walk through the filtered list ---
  const head = node('div', 'insp-head');
  const top = node('div', 'top');
  top.append(node('span', 'cid', testCase.id));
  top.append(techBadge(testCase.technique));
  top.append(node('span', `prio prio-${testCase.priority}`, t('prio.' + testCase.priority)));

  const nav = node('span', 'nav');
  const navBtn = (label, titleKey, delta, disabled) => {
    const b = node('button', 't-btn t-btn-icon t-btn-ghost t-btn-sm', label);
    b.title = t(titleKey);
    b.disabled = disabled;
    b.addEventListener('click', () => {
      if (delta === 0) { selectedId = null; }
      else {
        const next = list[at + delta];
        if (next) selectedId = next.id;
      }
      renderList();
      renderInspector();
    });
    return b;
  };
  nav.append(navBtn('↑', 'ui.inspPrev', -1, at <= 0));
  nav.append(navBtn('↓', 'ui.inspNext', 1, at < 0 || at >= list.length - 1));
  nav.append(navBtn('✕', 'ui.inspClose', 0, false));
  top.append(nav);
  head.append(top);

  head.append(node('h2', null, testCase.title));

  const sub = node('div', 'sub');
  sub.append(node('span', 'tgt', testCase.target));
  if (testCase.group) sub.append(node('span', null, testCase.group));
  if (testCase.impact === 'changed' || testCase.impact === 'unrelated') {
    sub.append(node('span', `imp imp-${testCase.impact}`,
      t(testCase.impact === 'changed' ? 'ui.impactChangedShort' : 'ui.impactUnrelatedShort')));
  }
  head.append(sub);
  el.inspInner.append(head);

  const body = node('div', 'insp-body');

  // --- why this case exists ---
  if (testCase.rationale) {
    const sec = node('div', 'fx-sec');
    sec.append(node('div', 'fx-label', t('dg.rationale')));
    sec.append(node('div', 'fx-rationale', testCase.rationale));
    body.append(sec);
  }

  // --- what to set up, and what should come back ---
  const secData = node('div', 'fx-sec');
  secData.append(node('div', 'fx-label', t('ui.colData')));
  secData.append(node('div', 'fx-data', testCase.data));
  const exp = node('div', 'fx-expected');
  exp.append(node('b', null, `${t('dg.expected')}: `));
  exp.append(node('span', null, testCase.expected));
  secData.append(exp);
  if (testCase.notes) {
    // Same amber as the note on the card, so the two read as one thing said
    // twice rather than as a warning and a footnote.
    const req = node('div', 'fx-req fx-req-warn');
    req.append(node('span', 'b', '⚠'));
    req.append(node('span', null, testCase.notes));
    secData.append(req);
  }
  body.append(secData);

  const fixture = data?.fixtures.get(testCase.id);

  if (!fixture) {
    const sec = node('div', 'fx-sec');
    sec.append(node('div', 'fx-label', t('dg.fixture')));
    // Two different reasons look the same to a case without a fixture: the
    // case genuinely has no rows to derive (by design), or fixture
    // generation for this whole result blew up (a bug). Silently falling
    // back to the by-design message for the second case would hide the
    // failure the toast above already reported.
    const req = node('div', fixtureError ? 'fx-req fx-req-warn' : 'fx-req');
    req.append(node('span', 'b', fixtureError ? '⚠' : '◆'));
    req.append(node('span', null, t(fixtureError ? 'dg.fixtureErrorInline' : 'dg.noFixture')));
    sec.append(req);
    body.append(sec);
    el.inspInner.append(body);
    return;
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
  body.append(secRows);

  // --- requirements no row can express ---
  if (fixture.requirements.length) {
    const secReq = node('div', 'fx-sec');
    secReq.append(node('div', 'fx-label', t('dg.requirements')));
    fixture.requirements.forEach(r => {
      const req = node('div', 'fx-req');
      req.append(node('span', 'b', '◆'));
      req.append(node('span', null, r.text));
      secReq.append(req);
    });
    body.append(secReq);
  }

  // --- the query to run afterwards ---
  const v = verifyFor(activeSql(), testCase);
  const secSql = node('div', 'fx-sec');
  secSql.append(node('div', 'fx-label', t('dg.verify')));
  const pre = node('pre', 'fx-sql');
  pre.append(sqlHighlight(v.sql));
  secSql.append(pre);
  const vexp = node('div', 'fx-exp');
  vexp.append(node('b', null, `${t('dg.expected')}:`));
  vexp.append(node('span', null, v.expectation));
  secSql.append(vexp);
  body.append(secSql);

  el.inspInner.append(body);
}

// ---- rendering: the tabbed shells ------------------------------------

function renderRail() {
  const enabledTechs = [...el.techList.querySelectorAll('input[data-tech]')].filter(b => b.checked).length;
  el.railTechCount.textContent = enabledTechs || '';
  el.railValuesCount.textContent = valueCount || '';
  el.railSchemaCount.textContent = data?.schema.tables.length || '';

  // A tab with nothing behind it is not shown at all: an empty Schema pane
  // teaches nothing, and the two that come and go are exactly the two that
  // depend on a successful run.
  const has = { sql: true, tech: true, values: valueCount > 0, schema: !!data?.schema.tables.length };
  // Resolved before anything is marked active: a run that empties the pane you
  // were on has to move you off it, and marking the old tab active first would
  // leave the row with no active tab at all.
  if (!has[railTab]) railTab = 'sql';

  el.railTabs.querySelectorAll('.rtab').forEach(btn => {
    const key = btn.dataset.rt;
    btn.hidden = !has[key];
    btn.classList.toggle('active', key === railTab);
  });

  Object.entries(RAIL_PANES).forEach(([key, pane]) => {
    if (pane) pane.hidden = key !== railTab;
  });
}

function renderInsight() {
  const tabs = el.insightTabs.querySelectorAll('.itab');
  let anyAvailable = false;

  tabs.forEach(btn => {
    const key = btn.dataset.it;
    const state = insight[key];
    const available = !!state?.available;
    btn.hidden = !available;
    if (available) anyAvailable = true;
  });

  el.itabDiffN.textContent = insight.diff.count || '';
  el.itabFindingsN.textContent = insight.findings.count || '';
  el.itabCoverageN.textContent = insight.coverage.count || '';
  el.itabStaleN.textContent = insight.stale.count || '';
  el.findingsDot.className = `dot${insight.findings.level ? ' dot-' + insight.findings.level : ''}`;

  if (!anyAvailable) {
    el.insight.hidden = true;
    return;
  }
  el.insight.hidden = false;

  // Fall back to the first tab that has something, so a run that removes the
  // panel you were reading lands somewhere real rather than on a blank body.
  // Never mid-run, though: see insightSettling.
  if (!insightSettling && !insight[insightTab]?.available) {
    const first = [...tabs].find(b => !b.hidden);
    insightTab = first ? first.dataset.it : '';
  }

  tabs.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.it === insightTab && insightOpen);
  });
  Object.entries(INSIGHT_PANES).forEach(([key, pane]) => {
    if (pane) pane.hidden = key !== insightTab;
  });
  el.insight.classList.toggle('collapsed', !insightOpen);
  el.insightToggle.textContent = insightOpen ? '▴' : '▾';
}

/**
 * Apply the two column toggles.
 *
 * `insp-open` is separate from `insp-off` because below 1240px the inspector
 * stops being a column and becomes an overlay: there it must slide in only
 * when there is a case to show, or it would cover the list it was opened from.
 */
function applyLayout() {
  el.app.classList.toggle('rail-off', !railOpen);
  el.app.classList.toggle('insp-off', !inspOpen);
  el.app.classList.toggle('insp-open', inspOpen && !!selectedId);
  // Mirrored onto <body> too: the topbar sits above .app, not inside it, and
  // needs the same closed-panel gutter (see .topbar rules in sqlcases.css).
  document.body.classList.toggle('rail-off', !railOpen);
  document.body.classList.toggle('insp-off', !inspOpen);

  const existing = el.app.querySelector('.rail-reopen');
  if (existing) existing.remove();
  if (!railOpen) {
    const b = node('button', 'rail-reopen');
    b.type = 'button';
    b.textContent = t('ui.railReopen');
    b.addEventListener('click', () => { railOpen = true; saveUi(); applyLayout(); });
    el.app.append(b);
  }

  // Opening a column narrows the middle one, which is what wraps the technique
  // pills onto another line. Saying so here rather than waiting to be told is
  // the difference between the group headings parking under the command bar
  // and parking a pill row's worth of empty band below it.
  scheduleCmdHeight();
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
  // A parse error is the reason nothing else on the page updated, and the rail
  // may well be showing the technique list — put the query back on screen.
  if (errors.length) railTab = 'sql';
}

/** Wipe everything a result feeds, without touching the query or the options. */
function clearResult() {
  current = null;
  data = null;
  selectedId = null;
  staleCases = [];
  renderSchema();
  renderValues();
  renderAnalysis(null);
  renderFindings([]);
  renderCoverage([]);
  renderTechniqueFilter(null);
  renderClauseFilter();
  renderColumnFilter();
  renderFilterCount();
  renderTriage();
  setStats(null);
  renderList();
  renderInspector();
  renderRail();
  applyLayout();
}

/**
 * Render everything the results pane shows for one already-computed
 * generateCases() result: schema, value book, analysis, findings, coverage,
 * technique filter, stats, and the case list itself.
 *
 * Shared by single mode (called from a plain generateCases() run) and by
 * compare mode's "after" side (called with the already-tagged result out of
 * generateComparison()) — the rendering does not care where the result came
 * from, only that its shape matches.
 */
function renderResult(sql, result, errorsEl) {
  renderParseProblems(sql, result, errorsEl);

  if (!result.ok) {
    el.parseStatus.textContent = t('ui.parseFailed');
    clearResult();
    return;
  }

  current = result;
  // A case that is no longer in the result cannot stay in the inspector.
  if (selectedId && !result.cases.some(c => c.id === selectedId)) selectedId = null;

  // Fixtures depend only on the model and the case list, so they are rebuilt
  // with every generation — including a language switch, which re-runs it.
  try {
    data = buildAllFixtures(result.model, result.cases);
    fixtureError = false;
  } catch (err) {
    console.error('[SQLCASES] fixture generation failed:', err);
    data = null;
    // Rising edge only — retyping the same broken query re-runs this on
    // every debounce tick, and a fresh toast each time would just be noise.
    if (!fixtureError) toast(t('ui.toastFixtureError'), 'error');
    fixtureError = true;
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
  renderFilterCount();
  renderTriage();
  setStats(result.stats);
  renderList();
  renderInspector();
  renderRail();
  applyLayout();
}

/** Single mode: parse, generate and render one query. */
function runFor(sql, errorsEl) {
  if (!sql.trim()) {
    errorsEl.hidden = true;
    el.parseStatus.textContent = t('ui.parseHint');
    clearResult();
    return;
  }

  let result;
  try {
    result = generateCases(sql, readOptions());
  } catch (err) {
    console.error('[SQLCASES] generation failed:', err);
    errorsEl.replaceChildren(node('div', null, t('ui.genFailed', { message: err.message })));
    errorsEl.hidden = false;
    el.parseStatus.textContent = t('ui.parseFailed');
    clearResult();
    return;
  }

  renderResult(sql, result, errorsEl);
}

/**
 * Compare mode: one generateComparison() call drives the whole page — the
 * case list, findings etc. still come off the "after" query (now with
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
    el.parseErrorsAfter.replaceChildren(node('div', null, t('ui.genFailed', { message: err.message })));
    el.parseErrorsAfter.hidden = false;
    el.parseStatus.textContent = t('ui.parseFailed');
    renderDiff(null);
    renderStale([]);
    clearResult();
    return;
  }

  // The before side never drives the results pane, only its own errors —
  // its cases are only consulted below, for which of them the after-side
  // change left with no source element to test any more.
  renderParseProblems(beforeSql, comparison.before, el.parseErrors);
  renderResult(afterSql, comparison.after, el.parseErrorsAfter);
  renderDiff(comparison.diff);
  renderStale(comparison.before.ok ? comparison.before.cases.filter(c => c.impact === 'stale') : []);
  renderTriage();
}

function run() {
  insightSettling = true;
  try {
    if (mode !== 'compare') {
      renderDiff(null);
      renderStale([]);
      runFor(el.sql.value, el.parseErrors);
    } else {
      runCompare();
    }
  } finally {
    // Resolved here and nowhere else, so the tab moves at most once per run —
    // and only when the pane behind it really did go away.
    insightSettling = false;
    renderInsight();
    renderTriage();
  }
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
  el.exportBtn.disabled = !enabled;
  el.cmdbarDock.hidden = !enabled;
  // ResizeObserver reports a hidden element as 0x0 but never fires for the
  // `hidden` attribute itself, so the show/hide above has to say so.
  scheduleCmdHeight();
}

// ---- persistence -----------------------------------------------------

function saveState() {
  const techniques = {};
  TECHNIQUES.forEach(tech => {
    techniques[tech.key] = el.techList.querySelector(`input[data-tech="${tech.key}"]`)?.checked ?? true;
  });
  storageSet({
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

/**
 * Put back what the last visit left, and tell the caller whether this is a
 * first visit.
 *
 * With nothing saved, the query box opens empty and the page is left
 * describing itself to someone who has not seen it work yet. Seeding the first
 * example instead means the first thing on screen is a real query with real
 * cases under it; init() follows it with the toast naming the button that
 * clears it. Anything saved — including a query deliberately cleared to empty
 * — is a returning reader and is restored untouched.
 */
function restoreState(done) {
  const seedSample = () => { el.sql.value = EXAMPLES[0].sql; };
  if (!storage) { applyTheme('light'); setLang(DEFAULT_LANG); seedSample(); done(true); return; }
  storage.get([STATE_KEY, THEME_KEY, LANG_KEY, UI_KEY, VALUES_KEY], (res) => {
    applyTheme(res?.[THEME_KEY] === 'dark' ? 'dark' : 'light');
    // Only select the language here. Rendering and the first generation wait
    // until the saved query is back in the textarea, so startup runs once.
    setLang(res?.[LANG_KEY] || DEFAULT_LANG);
    applyUiState(res?.[UI_KEY]);
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
    } else {
      seedSample();
    }
    done(!s);
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
  document.querySelectorAll('[data-i18n]').forEach(n => { setLabel(n, n.dataset.i18n); });
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
    if (name) setLabel(name, tech.labelKey);
  });

  document.querySelectorAll('.help-lang').forEach(n => {
    n.hidden = n.dataset.helpLang !== getLang();
  });
  document.documentElement.lang = getLang();

  // The toggle is the one button certain to be under the cursor when the
  // language changes, so it holds the widest code rather than its own: EN is
  // 5px wider than VI, and the two buttons after it would jump by that much
  // under the pointer that had just been clicked.
  const active = LANGUAGES.find(l => l.code === getLang()) || LANGUAGES[0];
  el.langLabel.textContent = active.short;
  el.langLabel.dataset.i18nAlt = LANGUAGES
    .filter(l => l.code !== active.code)
    .reduce((widest, l) => (l.short.length > widest.length ? l.short : widest), '');

  // #sqlLabel and the rail's first tab carry fixed data-i18n keys for single
  // mode; compare mode overrides both, so redo those overrides after the
  // generic pass above would otherwise put the single-mode labels back.
  setLabel(el.sqlLabel, mode === 'compare' ? 'ui.sqlQueryBefore' : 'ui.sqlQuery');
  setLabel(el.railTabSqlLabel, mode === 'compare' ? 'ui.railSqlCompare' : 'ui.railSql');
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
 * change, and the AFTER block is shown or hidden beneath it.
 */
function setMode(next) {
  mode = next === 'compare' ? 'compare' : 'single';
  el.modeToggle.querySelectorAll('button[data-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  el.sqlAfterCard.hidden = mode !== 'compare';
  setLabel(el.sqlLabel, mode === 'compare' ? 'ui.sqlQueryBefore' : 'ui.sqlQuery');
  // The tab sits above two textareas in compare mode, so "Query" stops being
  // the honest name for what is behind it.
  setLabel(el.railTabSqlLabel, mode === 'compare' ? 'ui.railSqlCompare' : 'ui.railSql');
  // Switching mode is switching what you are about to type into.
  if (mode === 'compare') railTab = 'sql';
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

/** Close both dropdowns. They are mutually exclusive and share every dismissal. */
function closeMenus() {
  el.exportMenu.hidden = true;
  el.filterPop.hidden = true;
  el.exportBtn.setAttribute('aria-expanded', 'false');
  el.filtersBtn.setAttribute('aria-expanded', 'false');
}

function toggleMenu(menu, button) {
  const open = menu.hidden;
  closeMenus();
  menu.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
}

function initExports() {
  el.exportBtn.addEventListener('click', () => toggleMenu(el.exportMenu, el.exportBtn));

  el.csv.addEventListener('click', () => {
    if (!current) return;
    downloadText(toCsv(current.cases), suggestFilename(current, 'csv'), 'text/csv');
    toast(t('ui.toastCsv', { n: current.cases.length }), 'success');
  });

  el.json.addEventListener('click', () => {
    if (!current) return;
    downloadText(toJson(activeSql(), current), suggestFilename(current, 'json'), 'application/json');
    toast(t('ui.toastJson'), 'success');
  });

  el.dataCsv.addEventListener('click', () => {
    if (!current || !data) return;
    const files = fixturesToCsv(data.schema, data.fixtures, current.cases).filter(f => f.rows > 0);
    // Every table came back empty (all rows filtered out above) — nothing
    // was actually downloaded, so this must not read as the success toast
    // below or the click looks like it worked when it did nothing.
    if (!files.length) {
      toast(t('ui.toastNoDataRows'), 'warn');
      return;
    }
    // One file per table, as asked. chrome.downloads queues them, so a
    // multi-table query produces several downloads from the single click.
    files.forEach(f => downloadText(f.csv, `testdata_${f.table.replace(/[^a-z0-9_-]+/gi, '_')}.csv`, 'text/csv'));
    toast(t('dg.toastCsv', { n: files.length }), 'success');
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
    toast(t('dg.toastVerify'), 'success');
  });

  el.copyJson.addEventListener('click', async () => {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(toJson(activeSql(), current));
      toast(t('ui.toastCopied'), 'success');
    } catch (err) {
      console.error('[SQLCASES] clipboard write failed:', err);
      toast(t('ui.toastCopyFail'), 'error');
    }
  });

  // The menu is a list of one-shot actions, so every one of them dismisses it.
  el.exportMenu.querySelectorAll('button').forEach(b => b.addEventListener('click', closeMenus));
}

function initLayoutControls() {
  const toggleRail = () => { railOpen = !railOpen; saveUi(); applyLayout(); };
  el.railToggle.addEventListener('click', toggleRail);
  el.railClose.addEventListener('click', toggleRail);

  el.inspToggle.addEventListener('click', () => {
    inspOpen = !inspOpen;
    saveUi();
    applyLayout();
  });

  el.railTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.rtab');
    if (!btn) return;
    railTab = btn.dataset.rt;
    saveUi();
    renderRail();
  });

  el.insightTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.itab');
    if (btn) {
      // Clicking the tab you are already reading closes the block: it is the
      // same gesture the accordions had, and the one that gets the height back.
      if (btn.dataset.it === insightTab && insightOpen) insightOpen = false;
      else { insightTab = btn.dataset.it; insightOpen = true; }
      saveUi();
      renderInsight();
      renderTriage();
      return;
    }
    if (e.target.closest('#btnInsight')) {
      insightOpen = !insightOpen;
      saveUi();
      renderInsight();
      renderTriage();
    }
  });

  el.triage.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tri]');
    if (!btn) return;
    const key = btn.dataset.tri;
    if (key === 'stale') {
      // Stale cases are not in the list, so this box opens the only panel that
      // holds them rather than filtering a list they were never part of.
      insightTab = 'stale';
      insightOpen = true;
      renderInsight();
    } else {
      activeImpact = activeImpact === key ? '' : key;
      selectedId = null;
      renderList();
      renderInspector();
    }
    saveUi();
    renderTriage();
  });

  el.density.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-d]');
    if (!btn) return;
    density = btn.dataset.d;
    el.density.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    saveUi();
    renderList();
  });
}

function initFilters() {
  el.filtersBtn.addEventListener('click', () => toggleMenu(el.filterPop, el.filtersBtn));
  el.closeFilters.addEventListener('click', closeMenus);
  el.clearFilters.addEventListener('click', clearAllFilters);
  el.emptyClear.addEventListener('click', clearAllFilters);

  el.search.addEventListener('input', renderList);
  el.prioFilter.addEventListener('change', () => { renderFilterCount(); renderList(); });
  el.clauseFilter.addEventListener('change', () => {
    activeClause = el.clauseFilter.value;
    renderFilterCount();
    renderList();
  });
  el.columnFilter.addEventListener('change', () => {
    activeColumn = el.columnFilter.value;
    renderFilterCount();
    renderList();
  });
  el.fixtureFilter.addEventListener('change', () => {
    onlyWithFixture = el.fixtureFilter.checked;
    renderFilterCount();
    renderList();
  });

  // A click anywhere that is not inside a dropdown closes both of them.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu-wrap')) closeMenus();
  });
}

/**
 * Keep --cmd-h in step with the docked command bar's real height.
 *
 * The group headings in the list park directly under the bar, and the bar is
 * not a fixed height: the technique pills wrap onto a second line on a narrow
 * window, and onto a third in Vietnamese. Every pixel this number is wrong by
 * is a pixel of the list showing in the band between the bar and the headings,
 * or a pixel of heading hidden behind the bar, so it has to be exact — no
 * rounding, and no waiting for the next thing to happen before it catches up.
 *
 * One ResizeObserver is not enough on its own. When a rewrap is set off by a
 * width change elsewhere in the shell — opening the inspector, dragging the
 * window narrower — the observation that arrives can still describe the bar as
 * it was, leaving the number a full pill row (20-30px) short until something
 * else disturbs it. So every trigger re-measures twice, once now and once on
 * the next frame when layout has certainly settled, and a scroll re-measures
 * as well: the band is only ever looked at while the list is moving, which
 * makes a scroll the last chance to notice and the cheapest place to check.
 */
function publishCmdHeight() {
  const h = el.cmdbarDock.hidden ? 0 : el.cmdbarDock.getBoundingClientRect().height;
  const shell = el.cmdbarDock.parentElement;
  const next = `${h.toFixed(2)}px`;
  if (shell.style.getPropertyValue('--cmd-h') !== next) shell.style.setProperty('--cmd-h', next);
}

let cmdHeightFrame = 0;

/** Measure now, and again next frame in case this one caught layout mid-flight. */
function scheduleCmdHeight() {
  publishCmdHeight();
  cancelAnimationFrame(cmdHeightFrame);
  cmdHeightFrame = requestAnimationFrame(publishCmdHeight);
}

function trackCmdbarHeight() {
  scheduleCmdHeight();
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(scheduleCmdHeight);
    observer.observe(el.cmdbarDock);
    observer.observe(el.cmdbar);
  }
  window.addEventListener('resize', scheduleCmdHeight);
  // Measured on the spot rather than deferred to the next frame: a scroll
  // handler runs before the frame it belongs to is painted, so correcting the
  // number here means the band is right in the very frame the reader sees. It
  // is one rect read per scrolled frame, and it writes only when the number
  // has actually moved.
  el.cmdbarDock.parentElement.addEventListener('scroll', publishCmdHeight, { passive: true });
}

function init() {
  buildTechniqueList();
  initExamples();
  initExports();
  initLayoutControls();
  initFilters();

  el.analyze.addEventListener('click', () => { saveState(); run(); });

  const runOnCtrlEnter = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      saveState();
      run();
    }
  };
  el.sql.addEventListener('keydown', runOnCtrlEnter);
  el.sqlAfter.addEventListener('keydown', runOnCtrlEnter);

  // Typing re-runs on a debounce: generation is pure and fast enough that
  // waiting for a button press only makes the tool feel slower than it is.
  let debounce = null;
  el.sql.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { saveState(); run(); }, 500);
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
      saveUi();
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
    toast(t('vb.toastReset'), 'success');
  });

  el.maxFull.addEventListener('change', () => { saveState(); run(); });
  el.joinConds.addEventListener('change', () => { saveState(); run(); });

  el.theme.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    storageSet({ [THEME_KEY]: next });
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

  el.diagramBtn.addEventListener('click', openDiagram);
  el.dgClose.addEventListener('click', closeDiagram);
  el.diagramModal.addEventListener('click', (e) => {
    if (e.target === el.diagramModal) closeDiagram();
  });
  el.dgFit.addEventListener('click', () => diagram?.fit());
  el.dgZoomIn.addEventListener('click', () => diagram?.zoomBy(1.25));
  el.dgZoomOut.addEventListener('click', () => diagram?.zoomBy(1 / 1.25));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!el.diagramModal.hidden) { closeDiagram(); return; }
    if (!el.helpModal.hidden) { el.helpModal.hidden = true; return; }
    if (!el.exportMenu.hidden || !el.filterPop.hidden) { closeMenus(); return; }
    // Escape with a case open closes the inspector, which is the only other
    // thing on this page that is "open" in the sense Escape usually means.
    if (selectedId) { selectedId = null; renderList(); renderInspector(); applyLayout(); }
  });

  // Walking the list from the keyboard, but only when the caret is not in a
  // field — an arrow key inside the query textarea moves the caret and must
  // keep doing so.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (!selectedId || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const list = visibleCases();
    const at = list.findIndex(c => c.id === selectedId);
    const next = list[at + (e.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    // Walking into a shut group opens it: the alternative is an arrow press
    // that selects a case the list is not showing.
    collapsedGroups.delete(groupKeyOf(next));
    selectedId = next.id;
    renderList();
    renderInspector();
  });

  trackCmdbarHeight();

  restoreState((firstVisit) => {
    applyStaticText();
    el.density.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.d === density));
    // A rail that starts shut on a narrow window is the same call the CSS
    // makes at that width; making it here too keeps the toggle honest.
    if (window.innerWidth < 900) railOpen = false;
    run();
    el.sql.focus();
    // After applyStaticText(), or the note would be in whatever language the
    // catalog defaulted to rather than the one now on screen.
    if (firstVisit) toast(t('ui.firstRunSample'), 'success', 6000);
  });
}

init();
