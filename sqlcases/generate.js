/**
 * generate.js — Orchestrates parse → analyze → techniques → numbered case list.
 *
 * This is the single entry point the UI calls. It owns the things that only
 * make sense once every technique has run: stable IDs, deduplication (two
 * techniques legitimately arrive at the same check), a priority ordering, and
 * the summary the results header shows.
 */

import { parse } from './parser.js';
import { analyze } from './analyze.js';
import { generateEpBva } from './techniques/ep-bva.js';
import { generateDecisionTable } from './techniques/decision-table.js';
import { generateNull3vl } from './techniques/null-3vl.js';
import { generateStructure } from './techniques/structure.js';
import { attachRationale } from './explain.js';
import { boundParams } from './valuebook.js';
import { t, tPlural } from './i18n.js';
import {
  diffQueries, tableKey, joinKey, groupByKey, aggregateKey, orderByKey, selectKey, caseExprKey, writeKey
} from './diff.js';

/** The four technique groups, in the order their cases are listed. */
export const TECHNIQUES = [
  { key: 'epbva', labelKey: 'tech.epbva', codes: ['EP', 'BVA', 'EP+BVA'] },
  { key: 'decision', labelKey: 'tech.decision', codes: ['Decision Table', 'Pairwise', 'MC/DC', 'Branch Coverage'] },
  { key: 'null3vl', labelKey: 'tech.null3vl', codes: ['NULL / 3VL'] },
  { key: 'structure', labelKey: 'tech.structure', codes: ['Structure'] }
];

export const DEFAULT_OPTIONS = {
  epbva: true,
  decision: true,
  null3vl: true,
  structure: true,
  /** Above this many conditions the decision table switches to pairwise. */
  maxFullTable: 4,
  /** Above this many conditions ('auto' mode only) pairwise gives way to MC/DC. */
  maxPairwise: 8,
  /** 'auto' honours maxFullTable/maxPairwise; 'full' forces the complete
   *  table; 'pairwise' forces pairwise (up to 12 conditions, else MC/DC). */
  mode: 'auto',
  /** Include ON-clause predicates that filter rather than just match keys. */
  includeJoinConditions: true,
  idPrefix: 'TC'
};

const PRIORITY_RANK = { High: 0, Medium: 1, Low: 2 };

/** Cases are equal when they ask for the same data and the same outcome. */
function dedupeKey(c) {
  return [c.technique, c.group, c.title, c.data, c.expected]
    .map(s => String(s || '').trim().toLowerCase())
    .join('¦');
}

/**
 * Two cases can agree on `group` + `data` + `expected` without agreeing on
 * `technique` or `title` — most commonly EP's boundary-adjacent
 * representative and BVA's own boundary triple landing on the exact same
 * value (see the note in ep-bva.js's generateEpBva()), but the same
 * coincidence can in principle happen between any two technique modules that
 * end up probing the same column with the same value. `technique` is left
 * out of this key on purpose — that is exactly the field that tells two
 * *different* techniques apart, so keying on it would hide the overlap this
 * function exists to find. (`dedupeKey` above still keys on it, for the
 * separate job of dropping an exact duplicate a single technique produced
 * twice.)
 */
function mergeKey(c) {
  return [c.group, c.data, c.expected].map(s => String(s || '').trim().toLowerCase()).join('¦');
}

/** `TECHNIQUES` order, flattened to a code → rank lookup — reused by the
 *  sort step below and by mergeCoincidentCases() to decide which technique's
 *  case "leads" a merge. */
function techRankMap() {
  const rank = new Map();
  TECHNIQUES.forEach((tech, ti) => tech.codes.forEach((code, ci) => rank.set(code, ti * 10 + ci)));
  return rank;
}

/**
 * Fold every group of cases that share a `mergeKey()` — i.e. would set up
 * the identical fixture row and expect the identical outcome — into one case
 * tagged with every technique that arrived at it (`technique: 'EP+BVA'`,
 * or more codes joined the same way for a rarer 3-or-more-way coincidence).
 * A group where every case already shares one `technique` is left alone —
 * that is a same-technique coincidence, a different situation the plain
 * `dedupeKey` exact-duplicate pass below already handles.
 *
 * Runs once, globally, over every technique's raw output (including CTE
 * bodies, since `group` already carries the `CTE · name ·` prefix by this
 * point) — so this is not specific to EP/BVA, it just happens to be the pair
 * that coincides in practice today (see ep-bva.js).
 */
function mergeCoincidentCases(cases) {
  const buckets = new Map();
  cases.forEach(c => {
    const key = mergeKey(c);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(c);
  });

  const rank = techRankMap();
  const result = [];
  buckets.forEach(bucket => {
    const techniques = [...new Set(bucket.map(c => c.technique))];
    if (techniques.length <= 1) { result.push(...bucket); return; }

    const ordered = techniques.sort((a, b) => (rank.get(a) ?? 99) - (rank.get(b) ?? 99));
    const byTechnique = new Map();
    bucket.forEach(c => { if (!byTechnique.has(c.technique)) byTechnique.set(c.technique, c); });
    const technique = ordered.join('+');

    if (ordered.length === 2 && ordered[0] === 'EP' && ordered[1] === 'BVA') {
      // The common case gets its own wording: BVA's phrasing already names
      // the boundary precisely, so it leads; EP is credited in a note.
      const ep = byTechnique.get('EP'), bva = byTechnique.get('BVA');
      const notes = [...new Set([bva.notes, ep.notes, t('ep.mergedNote', { epTitle: ep.title })].filter(Boolean))]
        .join(' ');
      result.push({ ...bva, technique, title: t('ep.mergedTitle', { bvaTitle: bva.title }), notes });
      return;
    }

    // Any other combination: the first technique in canonical order leads,
    // the rest are named in a note rather than given bespoke phrasing each.
    const lead = byTechnique.get(ordered[0]);
    const others = ordered.slice(1).map(code => byTechnique.get(code).title);
    const notes = [...new Set([lead.notes, t('case.mergedNote', { titles: others.join('; ') })].filter(Boolean))]
      .join(' ');
    result.push({ ...lead, technique, notes });
  });
  return result;
}

/**
 * Fold one CTE's own case list into the outer list.
 *
 * A CTE is a full query in its own right, so its cases come from running the
 * same four technique modules on its own model — but they need to read as
 * "this is inside the CTE" rather than being indistinguishable from the outer
 * query's cases of the same shape. The `CTE · name ·` prefix does that for
 * display and (via `group` already being part of dedupeKey) for dedup; `cte`
 * marks the case so explain.js can still classify the *un*prefixed group.
 */
function foldCteCases(cases, cteName) {
  return cases.map(c => ({ ...c, group: `CTE · ${cteName} · ${c.group}`, cte: cteName }));
}

/** Warnings the model itself justifies, shown above the results. */
function buildFindings(model) {
  const findings = [];

  model.joins.forEach(j => {
    if (j.implicit) {
      findings.push({ level: 'warn', message: t('find.commaJoin', { left: j.leftLabel, right: j.rightLabel }) });
    } else if (!j.onSql && j.joinType !== 'CROSS' && !j.natural) {
      findings.push({ level: 'warn', message: t('find.noOn', { type: j.joinType, right: j.rightLabel }) });
    }
    if (j.natural) {
      findings.push({ level: 'warn', message: t('find.natural', { right: j.rightLabel }) });
    }
  });

  const outer = new Set(model.joins.filter(j => j.joinType === 'LEFT' || j.joinType === 'FULL').map(j => j.rightLabel.toLowerCase()));
  model.conditions.forEach(c => {
    const tbl = c.column?.table?.toLowerCase();
    if (tbl && outer.has(tbl) && !(c.kind === 'null-check' && !c.negated)) {
      findings.push({ level: 'warn', message: t('find.outerFilter', { cond: c.sql }) });
    }
    if (c.kind === 'comparison' && c.values.some(v => v.kind === 'literal' && v.value === null)) {
      findings.push({ level: 'error', message: t('find.equalsNull', { cond: c.sql }) });
    }
    if (c.kind === 'in-subquery' && c.negated) {
      findings.push({ level: 'warn', message: t('find.notInSubquery', { cond: c.sql }) });
    }
  });

  if (model.paging.limit && !model.paging.orderBy.length) {
    findings.push({ level: 'warn', message: t('find.limitNoOrder') });
  }
  if (model.paging.offset && model.paging.orderBy.length === 1 && !model.paging.orderBy[0].column) {
    findings.push({ level: 'info', message: t('find.pagingKey') });
  }
  if (model.writes && model.writes.kind !== 'insert' && !model.writes.hasWhere) {
    findings.push({ level: 'error', message: t('find.dmlNoWhere', { kind: model.writes.kind.toUpperCase(), table: model.writes.table }) });
  }

  const inflatable = model.grouping.aggregates.filter(a => !['MIN', 'MAX'].includes(a.name) && !a.distinct);
  if (inflatable.length && model.joins.some(j => j.joinType !== 'CROSS')) {
    findings.push({
      level: 'info',
      message: t('find.inflated', { aggs: inflatable.map(a => a.sql).join(', ') })
    });
  }

  // Values that did not come from the query text have to be visible, or a
  // case reading `balance = 501` looks like something the SQL said.
  const bound = boundParams(model);
  if (bound.length) {
    findings.push({
      level: 'info',
      message: t('find.boundParams', { list: bound.map(b => `${b.label} = ${b.sql}`).join(', ') })
    });
  }
  const unbound = (model.params || []).length - bound.length;
  if (unbound > 0) {
    findings.push({ level: 'info', message: t('find.unboundParams', { n: unbound }) });
  }

  const unknownTypes = model.conditions.filter(c => c.dataType.confidence === 'unknown' && c.column);
  if (unknownTypes.length) {
    findings.push({
      level: 'info',
      message: t('find.unknownType', { cols: unknownTypes.map(c => c.column.raw).join(', ') })
    });
  }

  // A literal-0 or literal-NULL divisor is a defect in the query text itself,
  // not something a fixture row can change — report it once instead of as a
  // per-row case. CTE bodies are walked too, tagged with which CTE it is in.
  const divisionDefectSources = [
    { defects: model.divisionDefects, label: null },
    ...model.ctes.map(cte => ({ defects: cte.model.divisionDefects, label: cte.name }))
  ];
  divisionDefectSources.forEach(({ defects, label }) => {
    defects.forEach(d => {
      const expr = label ? `CTE ${label}: ${d.sql}` : d.sql;
      findings.push({
        level: 'error',
        message: t(d.kind === 'zero' ? 'find.divLiteralZero' : 'find.divLiteralNull', { expr })
      });
    });
  });

  const nested = model.subqueries.filter(s => s.kind !== 'cte').length;
  if (nested) {
    findings.push({
      level: 'info',
      message: t('find.outerOnly', { parts: tPlural(nested, 'find.subqOne', 'find.subqMany') })
    });
  }
  if (model.ctes.length) {
    findings.push({
      level: 'info',
      message: tPlural(model.ctes.length, 'find.cteOne', 'find.cteMany', { names: model.ctes.map(c => c.name).join(', ') })
    });
  }

  model.notes.forEach(n => findings.push(n));
  return findings;
}

/**
 * Generate the full test-case list for one SQL statement.
 *
 * @param {string} sql
 * @param {object} userOptions — merged over DEFAULT_OPTIONS
 * @returns {{ok: boolean, errors: Array, warnings: Array, model: object|null,
 *            cases: Array, coverage: Array, findings: Array, stats: object}}
 */
export function generateCases(sql, userOptions = {}) {
  const options = { ...DEFAULT_OPTIONS, ...userOptions };
  const { ast, errors, warnings } = parse(sql || '');

  if (!ast) {
    return { ok: false, errors, warnings, model: null, cases: [], coverage: [], findings: [], stats: emptyStats() };
  }

  const model = analyze(ast);
  const raw = [];
  let coverage = [];

  if (options.epbva) raw.push(...generateEpBva(model, options));
  if (options.decision) {
    const dt = generateDecisionTable(model, options);
    raw.push(...dt.cases);
    coverage = dt.summaries;
  }
  if (options.null3vl) raw.push(...generateNull3vl(model));
  if (options.structure) raw.push(...generateStructure(model));

  // Each CTE gets the same four techniques run against its own body, folded
  // into the list under a "CTE · name ·" group prefix. This is on top of —
  // not instead of — the "what if the CTE returns zero rows" baseline case
  // structure.js already generates from the outer query's point of view.
  model.ctes.forEach(cte => {
    const sub = cte.model;
    if (options.epbva) raw.push(...foldCteCases(generateEpBva(sub, options), cte.name));
    if (options.decision) {
      const dt = generateDecisionTable(sub, options);
      raw.push(...foldCteCases(dt.cases, cte.name));
      dt.summaries.forEach(s => coverage.push({ ...s, scope: `CTE · ${cte.name} · ${s.scope}` }));
    }
    if (options.null3vl) raw.push(...foldCteCases(generateNull3vl(sub), cte.name));
    if (options.structure) raw.push(...foldCteCases(generateStructure(sub), cte.name));
  });

  // Fold cross-technique coincidences into one case each, dedupe an exact
  // same-technique duplicate, then order by technique, then priority, then
  // group — so the list reads as sections rather than the order the modules
  // happened to run in.
  const merged = mergeCoincidentCases(raw);
  const seen = new Set();
  const deduped = merged.filter(c => {
    const k = dedupeKey(c);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const techRank = techRankMap();

  deduped.sort((a, b) => {
    const ta = techRank.get(a.technique) ?? 99;
    const tb = techRank.get(b.technique) ?? 99;
    if (ta !== tb) return ta - tb;
    // Decision-table rules carry an explicit sequence — a table read out of
    // rule order is much harder to check against, so it wins over priority.
    if (a.seq !== undefined && b.seq !== undefined && a.group === b.group) return a.seq - b.seq;
    const pa = PRIORITY_RANK[a.priority] ?? 3;
    const pb = PRIORITY_RANK[b.priority] ?? 3;
    if (pa !== pb) return pa - pb;
    return String(a.group).localeCompare(String(b.group));
  });

  const width = String(deduped.length).length < 3 ? 3 : String(deduped.length).length;
  const cases = attachRationale(deduped).map((c, i) => ({
    id: `${options.idPrefix}-${String(i + 1).padStart(width, '0')}`,
    // A handful of whole-query checks (DISTINCT, UNION shape, SELECT *,
    // baseline "empty table") have no single model element to point back
    // at — these defaults keep every case filterable/matchable rather than
    // needing every consumer to guard against a missing field.
    clause: 'OTHER',
    sourceIds: [],
    columns: [],
    ...c
  }));

  return {
    ok: true,
    errors,
    warnings,
    model,
    cases,
    coverage,
    findings: buildFindings(model),
    stats: buildStats(cases, model)
  };
}

function emptyStats() {
  return { total: 0, byTechnique: {}, byPriority: { High: 0, Medium: 0, Low: 0 }, conditions: 0, joins: 0, tables: 0 };
}

function buildStats(cases, model) {
  const stats = emptyStats();
  stats.total = cases.length;
  cases.forEach(c => {
    stats.byTechnique[c.technique] = (stats.byTechnique[c.technique] || 0) + 1;
    if (stats.byPriority[c.priority] !== undefined) stats.byPriority[c.priority]++;
  });
  stats.conditions = model.conditions.length + model.havingConditions.length +
    model.ctes.reduce((n, c) => n + c.model.conditions.length + c.model.havingConditions.length, 0);
  stats.joins = model.joins.length + model.ctes.reduce((n, c) => n + c.model.joins.length, 0);
  stats.tables = model.tables.length + model.ctes.reduce((n, c) => n + c.model.tables.length, 0);
  return stats;
}

// ---- change-impact comparison (Giai đoạn 3) -------------------------------

/**
 * Collect the keys of every model element a diffQueries() section marks as
 * `added` or `changed` (using its `.new` side) into one set.
 *
 * Condition-based sections (WHERE/HAVING/ON) key by the condition's own id —
 * the same id a case's `sourceIds` carries when caseSourceFromCondition()
 * tagged it, since both come from analyzing the same "after" SQL. The other
 * sections have no such id, so they go through the same exported key
 * functions the technique modules used to tag their cases, closing the loop.
 */
function collectKeys(diff, which) {
  const keys = new Set();
  const take = (sec, pick) => {
    if (!sec) return;
    sec[which].forEach(x => keys.add(pick(which === 'changed' ? x.new : x)));
  };

  take(diff.where, c => c.id);
  take(diff.having, c => c.id);
  take(diff.joinConditions, c => c.id);
  take(diff.tables, tableKey);
  take(diff.joins, joinKey);
  take(diff.groupBy, groupByKey);
  take(diff.aggregates, aggregateKey);
  take(diff.orderBy, orderByKey);
  take(diff.selectList, selectKey);
  take(diff.caseExprs, caseExprKey);
  take(diff.writes, writeKey);

  return keys;
}

/** Every key a case's `sourceIds` might match against — added or changed. */
function changedElementKeys(diff) {
  const keys = collectKeys(diff, 'added');
  collectKeys(diff, 'changed').forEach(k => keys.add(k));

  // A pure AND/OR/NOT reshape can leave every leaf's own text identical —
  // added/changed would then be empty despite the query now meaning
  // something different, so every condition common to both sides is folded
  // in too whenever the shape itself moved.
  if (diff.where.shapeChanged) diff.where.unchanged.forEach(c => keys.add(c.id));
  if (diff.having.shapeChanged) diff.having.unchanged.forEach(c => keys.add(c.id));
  if (diff.joinConditions.shapeChangedCount > 0) diff.joinConditions.unchanged.forEach(c => keys.add(c.id));

  if (diff.paging.limit.changed) keys.add('LIMIT');
  if (diff.paging.offset.changed) keys.add('OFFSET');

  return keys;
}

/** Every key a diffQueries() section marks `removed` — gone in the after version. */
function removedElementKeys(diff) {
  const keys = collectKeys(diff, 'removed');
  if (diff.paging.limit.changed && diff.paging.limit.old && !diff.paging.limit.new) keys.add('LIMIT');
  if (diff.paging.offset.changed && diff.paging.offset.old && !diff.paging.offset.new) keys.add('OFFSET');
  return keys;
}

function tagImpact(cases, keys, label) {
  return cases.map(c => ({
    ...c,
    impact: (c.sourceIds || []).some(id => keys.has(id)) ? label : 'unrelated'
  }));
}

/**
 * Generate the full case list for both the "before" and "after" version of a
 * query, diff the two structurally, and tag every case with how it relates
 * to what changed — so a reviewer can tell "this case exercises something
 * the change touched" apart from "this still passes and still matters, just
 * not because of this change" apart from "this case's condition is gone,
 * consider retiring it".
 *
 * @param {string} sqlBefore
 * @param {string} sqlAfter
 * @param {object} userOptions — merged over DEFAULT_OPTIONS, same as generateCases()
 * @returns {{ok: boolean, diff: object, before: object, after: object}}
 *   `before`/`after` are full generateCases() results; when both parse,
 *   `after.cases[].impact` is `'changed'` or `'unrelated'`, and
 *   `before.cases[].impact` is `'stale'` (its source element was removed)
 *   or `'unrelated'`.
 */
export function generateComparison(sqlBefore, sqlAfter, userOptions = {}) {
  const diff = diffQueries(sqlBefore, sqlAfter);
  const before = generateCases(sqlBefore, userOptions);
  const after = generateCases(sqlAfter, userOptions);

  if (!diff.ok || !after.ok) {
    return { ok: false, diff, before, after };
  }

  after.cases = tagImpact(after.cases, changedElementKeys(diff), 'changed');
  if (before.ok) before.cases = tagImpact(before.cases, removedElementKeys(diff), 'stale');

  return { ok: true, diff, before, after };
}
