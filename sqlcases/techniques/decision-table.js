/**
 * decision-table.js — Decision table, condition coverage and MC/DC.
 *
 * EP and BVA test each predicate on its own; this technique tests how they
 * combine. A WHERE clause is a boolean expression, so its rules are the rows
 * of a decision table: one column per condition, one row per combination, and
 * the query's row-visible outcome as the action.
 *
 * The full table is 2^n rules, which stops being useful somewhere around five
 * conditions. Past `maxFullTable` this switches to MC/DC — for each condition,
 * a pair of otherwise-identical rules where flipping only that condition flips
 * the overall result. MC/DC needs n+1 rules where the full table needs 2^n and
 * still proves each condition can independently drive the outcome, which is
 * the property a reviewer actually wants from a compound WHERE clause.
 */

import { satisfy, violate, resolve } from '../hints.js';
import { t } from '../i18n.js';
import { caseSourceFromConditions, caseSourceFromCondition, caseSourceFromCaseExpr } from '../diff.js';

/** Evaluate a condition tree under a truth assignment (two-valued). */
export function evalTree(tree, values) {
  if (!tree) return true;
  switch (tree.node) {
    case 'leaf': return !!values[tree.id];
    case 'not': return !evalTree(tree.child, values);
    case 'and': return tree.children.every(c => evalTree(c, values));
    case 'or': return tree.children.some(c => evalTree(c, values));
    default: return true;
  }
}

/** Bit `i` of `mask`, as a boolean. */
function bit(mask, i) { return (mask >> i & 1) === 1; }

function vectorFor(mask, conds) {
  const v = {};
  conds.forEach((c, i) => { v[c.id] = bit(mask, i); });
  return v;
}

/**
 * Find, for each condition, a pair of assignments differing only in that
 * condition and producing different outcomes. Returns the deduped union of
 * every pair found, plus the conditions no pair exists for (masked conditions
 * — ones the expression's structure makes unable to affect the result).
 */
function mcdcRules(conds, tree) {
  const n = conds.length;
  const total = 1 << n;
  const chosen = new Map();     // mask → vector
  const masked = [];
  const pairs = [];

  for (let i = 0; i < n; i++) {
    let found = null;
    for (let mask = 0; mask < total && !found; mask++) {
      if (bit(mask, i)) continue;            // iterate the FALSE side only
      const maskTrue = mask | (1 << i);
      const vF = vectorFor(mask, conds);
      const vT = vectorFor(maskTrue, conds);
      if (evalTree(tree, vF) !== evalTree(tree, vT)) found = [mask, maskTrue];
    }
    if (!found) { masked.push(conds[i]); continue; }
    chosen.set(found[0], vectorFor(found[0], conds));
    chosen.set(found[1], vectorFor(found[1], conds));
    pairs.push({ condition: conds[i], falseMask: found[0], trueMask: found[1] });
  }

  return {
    rules: [...chosen.entries()].sort((a, b) => a[0] - b[0]).map(([mask, values]) => ({ mask, values })),
    masked,
    pairs
  };
}

/**
 * A greedy pairwise (all-pairs) covering array for `n` boolean factors: every
 * pair of conditions sees all 4 TRUE/FALSE combinations across the returned
 * masks, in far fewer rows than the full 2^n table — the middle ground
 * between the full table (every combination, stops scaling past a handful of
 * conditions) and MC/DC (one pair of rules per condition, proves each can
 * independently flip the outcome but says nothing about how two conditions
 * interact together).
 *
 * Each step picks, deterministically, the row that covers the most
 * still-uncovered pairs — not the smallest possible array, but a small and
 * fully reproducible one. No randomness: a tool whose whole point is that
 * re-running it reproduces the same case list cannot pick rows by chance.
 */
function pairwiseMasks(n) {
  const total = 1 << n;
  const needed = new Set();
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) needed.add(`${i}.${a}${j}.${b}`);
    }
  }

  const pairKeysFor = (mask) => {
    const keys = [];
    for (let i = 0; i < n; i++) {
      const a = bit(mask, i) ? 1 : 0;
      for (let j = i + 1; j < n; j++) keys.push(`${i}.${a}${j}.${bit(mask, j) ? 1 : 0}`);
    }
    return keys;
  };

  const chosen = [];
  while (needed.size > 0) {
    let bestMask = 0, bestKeys = [], bestGain = -1;
    for (let mask = 0; mask < total; mask++) {
      const keys = pairKeysFor(mask);
      let gain = 0;
      for (const k of keys) if (needed.has(k)) gain++;
      if (gain > bestGain) { bestGain = gain; bestMask = mask; bestKeys = keys; }
    }
    bestKeys.forEach(k => needed.delete(k));
    chosen.push(bestMask);
    if (bestGain === 0) break; // every pair already covered — should be unreachable
  }
  return chosen;
}

/** Human label for a truth vector: "C1=T, C2=F, C3=T". */
function vectorLabel(conds, values) {
  return conds.map(c => `${c.id}=${values[c.id] ? 'T' : 'F'}`).join(', ');
}

/** The data a tester must set up to realise one rule. */
function ruleData(conds, values) {
  return conds.map(c => `${c.id}: ${values[c.id] ? satisfy(c) : violate(c)}`).join(' · ');
}

/** The same rule expressed as column assignments, for the fixture generator. */
function ruleSpec(conds, values) {
  const set = [];
  const requires = [];
  conds.forEach(c => {
    const r = resolve(c, values[c.id]);
    if (r.kind === 'value' && r.column) set.push({ column: r.column, columnRaw: r.col, valueSql: r.valueSql });
    else requires.push({ text: `${c.id}: ${values[c.id] ? satisfy(c) : violate(c)}` });
  });
  return { set, requires };
}

function outcomeText(kind, passes) {
  if (kind === 'update') return t(passes ? 'out.rowUpdated' : 'out.rowNotUpdated');
  if (kind === 'delete') return t(passes ? 'out.rowDeleted' : 'out.rowNotDeleted');
  if (kind === 'having') return t(passes ? 'out.groupKept' : 'out.groupFiltered');
  return t(passes ? 'out.rowIn' : 'out.rowOut');
}

/**
 * Build the decision-table cases for one predicate tree.
 *
 * @param {Array} conds — condition records
 * @param {object} tree — condition tree with leaf ids
 * @param {string} label — 'WHERE' / 'HAVING'
 * @param {string} kind — statement kind, for outcome wording
 * @param {object} options — { maxFullTable, mode }
 * @returns {{cases: Array, summary: object|null}}
 */
function tableFor(conds, tree, label, kind, options) {
  if (!conds.length || !tree) return { cases: [], summary: null };

  const cases = [];
  const maxFull = options.maxFullTable ?? 4;
  // 'auto' switches to pairwise once the full table stops fitting but before
  // MC/DC's per-condition pairs are the only coverage left — pairwise is the
  // only one of the three that says anything about two conditions interacting,
  // so it is worth the extra rows over MC/DC while it stays cheap to compute.
  // An explicit 'pairwise' request gets a higher cap since the user asked for
  // it deliberately; the O(2^n) greedy scan behind it is what keeps both caps
  // well under the full table's own 16-condition ceiling.
  const maxPairwise = options.maxPairwise ?? 8;
  const legend = conds.map(c => `${c.id} = ${c.sql}`).join(' | ');

  // A single condition has no combinations to explore — EP/BVA already covers it.
  if (conds.length === 1) return { cases: [], summary: null };

  const useFull = conds.length <= (options.mode === 'full' ? 16 : maxFull);
  const usePairwise = !useFull && conds.length <= (options.mode === 'pairwise' ? 12 : maxPairwise);

  const base = {
    technique: useFull ? 'Decision Table' : usePairwise ? 'Pairwise' : 'MC/DC',
    group: `${label} · ${t('dt.group')}`,
    target: label,
    condition: legend,
    // A rule spans every condition in the table, not one — so unlike EP/BVA
    // it needs the whole set of ids for the change-impact match in
    // generate.js to treat it as touched when any one of them changed.
    ...caseSourceFromConditions(conds, label)
  };

  let rules;
  let masked = [];
  if (useFull) {
    rules = [];
    for (let mask = 0; mask < (1 << conds.length); mask++) {
      rules.push({ mask, values: vectorFor(mask, conds) });
    }
  } else if (usePairwise) {
    rules = pairwiseMasks(conds.length).map(mask => ({ mask, values: vectorFor(mask, conds) }));
    // Masked-condition detection (below, via mcdcRules) is not run for
    // pairwise — it would double the work for a finding that still surfaces
    // whenever the same query is small enough for the full table, or large
    // enough to fall through to actual MC/DC.
  } else if (conds.length > 20) {
    // Beyond this the 2^n scan behind MC/DC is not worth running in a popup.
    return {
      cases: [{
        ...base,
        technique: 'Decision Table',
        title: t('dt.tooMany', { n: conds.length }),
        data: legend,
        expected: t('dt.tooManyExp'),
        priority: 'Low',
        notes: t('dt.tooManyNote')
      }],
      summary: null
    };
  } else {
    const r = mcdcRules(conds, tree);
    rules = r.rules;
    masked = r.masked;
  }

  rules.forEach((rule, idx) => {
    const passes = evalTree(tree, rule.values);
    cases.push({
      ...base,
      title: t('dt.rule', { n: idx + 1, vector: vectorLabel(conds, rule.values) }),
      data: ruleData(conds, rule.values),
      expected: outcomeText(kind, passes),
      priority: passes ? 'High' : 'Medium',
      spec: ruleSpec(conds, rule.values),
      // Rules must stay in table order in the output, so they carry an explicit
      // sequence that overrides the usual priority sort.
      seq: idx,
      notes: ''
    });
  });

  // Conditions that can never change the outcome are a query smell worth reporting.
  masked.forEach(c => cases.push({
    ...base,
    technique: 'MC/DC',
    title: t('dt.masked', { id: c.id }),
    data: `${c.id} = ${c.sql}`,
    expected: t('dt.maskedExp'),
    priority: 'High',
    notes: t('dt.maskedNote'),
    // This finding is about the one condition that turned out redundant,
    // not the whole rule set base{} otherwise carries.
    ...caseSourceFromCondition(c)
  }));

  // Condition coverage: each condition observed both TRUE and FALSE.
  const seenTrue = new Set(), seenFalse = new Set();
  rules.forEach(r => conds.forEach(c => (r.values[c.id] ? seenTrue : seenFalse).add(c.id)));
  const outcomes = new Set(rules.map(r => evalTree(tree, r.values)));

  const summary = {
    scope: label,
    conditionCount: conds.length,
    ruleCount: rules.length,
    fullTableSize: conds.length <= 20 ? (1 << conds.length) : null,
    mode: t(useFull ? 'dt.modeFull' : usePairwise ? 'dt.modePairwise' : 'dt.modeMcdc'),
    conditionCoverage: conds.length ? Math.round(100 * conds.filter(c => seenTrue.has(c.id) && seenFalse.has(c.id)).length / conds.length) : 100,
    decisionCoverage: outcomes.size === 2 ? 100 : 50,
    maskedConditions: masked.map(c => c.id),
    legend: conds.map(c => ({ id: c.id, sql: c.sql }))
  };

  return { cases, summary };
}

/**
 * Branch coverage for CASE expressions.
 *
 * A CASE is a decision the projection makes, and its branches are evaluated
 * top to bottom with the first match winning. That ordering is itself testable:
 * a row satisfying two WHEN clauses must take the earlier one. The branch most
 * often missed is the one nobody wrote — with no ELSE, an unmatched row
 * silently yields NULL rather than any of the listed values.
 */
function caseExpressionCases(model) {
  const cases = [];

  model.caseExprs.forEach((ce, i) => {
    const label = model.caseExprs.length > 1 ? `CASE #${i + 1}` : 'CASE';
    const group = `${ce.context} · ${label}`;
    const base = {
      technique: 'Branch Coverage', group, target: label, condition: ce.sql, notes: '',
      ...caseSourceFromCaseExpr(ce)
    };

    ce.whens.forEach((w, wi) => {
      cases.push({
        ...base,
        title: t('bc.branchTaken', { n: wi + 1, when: w.when }),
        data: wi === 0
          ? t('bc.branchData', { when: w.when })
          : t('bc.branchDataLater', { when: w.when, n: wi }),
        expected: t('bc.yields', { value: w.then }),
        priority: 'High'
      });
    });

    if (ce.whens.length > 1) {
      cases.push({
        ...base,
        title: t('bc.twoBranches'),
        data: t('bc.twoBranchesData', { a: ce.whens[0].when, b: ce.whens[1].when }),
        expected: t('bc.twoBranchesExp', { value: ce.whens[0].then }),
        priority: 'High',
        notes: t('bc.twoBranchesNote')
      });
    }

    cases.push({
      ...base,
      title: t(ce.hasElse ? 'bc.elseTaken' : 'bc.noElse'),
      data: t('bc.noBranchData', { n: ce.whens.length }),
      expected: ce.hasElse ? t('bc.yields', { value: ce.elseSql }) : t('bc.noElseExp'),
      priority: 'High',
      notes: ce.hasElse ? '' : t('bc.noElseNote')
    });
  });

  return cases;
}

/**
 * @param {object} model — from analyze()
 * @param {object} options — { maxFullTable: number, mode: 'auto'|'full' }
 * @returns {{cases: Array, summaries: Array}}
 */
export function generateDecisionTable(model, options = {}) {
  const kind = model.statement === 'select' ? 'select' : model.statement;
  const cases = [];
  const summaries = [];

  const where = tableFor(model.conditions, model.whereTree, 'WHERE', kind, options);
  cases.push(...where.cases);
  if (where.summary) summaries.push(where.summary);

  const having = tableFor(model.havingConditions, model.havingTree, 'HAVING', 'having', options);
  cases.push(...having.cases);
  if (having.summary) summaries.push(having.summary);

  cases.push(...caseExpressionCases(model));

  return { cases, summaries };
}
