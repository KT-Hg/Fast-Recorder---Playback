/**
 * diff.js — Structural (AST-level) diff between two versions of a query.
 *
 * A text diff of the two SQL strings would flatten away everything that
 * makes SQL semantics testable — it cannot tell "moved to another line"
 * apart from "moved into a different AND/OR branch". This module diffs the
 * two statements the same way the rest of the tool understands them: off
 * `analyze()`'s model, which already reduces WHERE/HAVING/ON to a leaf list
 * plus the AND/OR/NOT tree those leaves sit in, and off the raw AST for the
 * SELECT list (analyze() does not preserve column order/aliases).
 *
 * Every section below follows the same shape: `{added, removed, changed,
 * unchanged}`, where `changed` holds `{old, new}` pairs. WHERE/HAVING/ON also
 * carry `shapeChanged` — true when the AND/OR/NOT nesting around the
 * conditions common to both sides differs, which a flat added/removed list
 * cannot express (a condition moved from one OR branch into an AND, or an
 * AND flipped to an OR, with the same leaves present on both sides).
 */

import { parse, exprToSql } from './parser.js';
import { analyze } from './analyze.js';

// ---- generic keyed list diff ---------------------------------------------

/**
 * Key a list, disambiguating duplicate keys by occurrence order — two GROUP
 * BY entries that happen to render the same SQL still get distinct slots
 * rather than colliding into one.
 */
function keyList(list, keyFn) {
  const counts = new Map();
  return (list || []).map(item => {
    const base = keyFn(item);
    const n = counts.get(base) || 0;
    counts.set(base, n + 1);
    return [`${base} ${n}`, item];
  });
}

/**
 * Match two lists by key. A key present on both sides is `unchanged` when
 * `sameFn` agrees, `changed` (as `{old, new}`) otherwise; a key on only one
 * side is `added` or `removed`.
 */
function diffByKey(oldList, newList, keyFn, sameFn) {
  const oldMap = new Map(keyList(oldList, keyFn));
  const newMap = new Map(keyList(newList, keyFn));
  const added = [], removed = [], changed = [], unchanged = [];

  oldMap.forEach((oldItem, key) => {
    if (!newMap.has(key)) { removed.push(oldItem); return; }
    const newItem = newMap.get(key);
    if (sameFn(oldItem, newItem)) unchanged.push(newItem);
    else changed.push({ old: oldItem, new: newItem });
  });
  newMap.forEach((newItem, key) => {
    if (!oldMap.has(key)) added.push(newItem);
  });

  return { added, removed, changed, unchanged };
}

// ---- condition-set diff (WHERE / HAVING / one JOIN's ON) ------------------

function conditionKey(c) {
  return `${(c.column?.raw || '').toLowerCase()}|${c.operator}|${c.kind}`;
}

function tokenSet(sql) {
  return new Set(String(sql || '').toLowerCase().match(/[a-z0-9_.']+/g) || []);
}

/** Token-overlap (Jaccard) similarity on rendered SQL — cheap and order-free. */
function textSimilarity(a, b) {
  const ta = tokenSet(a), tb = tokenSet(b);
  if (!ta.size && !tb.size) return 1;
  let inter = 0;
  ta.forEach(x => { if (tb.has(x)) inter++; });
  const union = ta.size + tb.size - inter;
  return union ? inter / union : 0;
}

/** What changed about a matched pair, for a short display label. */
function leafDiffKind(o, n) {
  if (o.operator !== n.operator) return 'operator';
  if (o.negated !== n.negated) return 'negation';
  if ((o.column?.raw || null) !== (n.column?.raw || null)) return 'column';
  return 'value';
}

/**
 * Match leaf conditions between two flattened lists.
 *
 * Pass 1 pairs by (column, operator, kind) — a confident structural match,
 * so `age >= 18` on both sides pairs up even if the literal changed. Pass 2
 * falls back to token-overlap similarity on the rendered SQL for whatever is
 * left, so `status <> 'x'` becoming `status <> 'y'` (a changed literal that
 * also changed the pass-1 key because... it doesn't, but an operator swap
 * would) is still recognised as "changed" rather than one removal plus one
 * unrelated addition.
 */
function matchConditions(oldConds, newConds) {
  const usedNew = new Set();
  const pairs = [];

  const newByKey = new Map();
  newConds.forEach(n => {
    const k = conditionKey(n);
    if (!newByKey.has(k)) newByKey.set(k, []);
    newByKey.get(k).push(n);
  });

  const leftoverOld = [];
  oldConds.forEach(o => {
    const bucket = newByKey.get(conditionKey(o)) || [];
    const candidate = bucket.find(n => !usedNew.has(n.id));
    if (candidate) { pairs.push([o, candidate]); usedNew.add(candidate.id); }
    else leftoverOld.push(o);
  });

  const stillOld = [];
  leftoverOld.forEach(o => {
    let best = null, bestScore = 0;
    newConds.forEach(n => {
      if (usedNew.has(n.id)) return;
      const score = textSimilarity(o.sql, n.sql) + (o.source === n.source ? 0.05 : 0);
      if (score > bestScore) { bestScore = score; best = n; }
    });
    if (best && bestScore >= 0.4) { pairs.push([o, best]); usedNew.add(best.id); }
    else stillOld.push(o);
  });

  return {
    pairs,
    unmatchedOld: stillOld,
    unmatchedNew: newConds.filter(n => !usedNew.has(n.id))
  };
}

/**
 * Canonical string for a condition tree, restricted to leaves `idOf` can
 * resolve — a leaf with no counterpart on the other side (`idOf` returns
 * null) drops out, and an AND/OR node that loses every child that way
 * collapses away with them. AND/OR children are sorted before joining, so
 * sibling reordering (which does not change truth value) is not reported as
 * a shape change — only an actual AND↔OR swap, a NOT added/removed, or a
 * leaf moving to a different parent survives the comparison.
 */
function serialize(tree, idOf) {
  if (!tree) return 'true';
  switch (tree.node) {
    case 'leaf': {
      const id = idOf(tree.id);
      return id === null || id === undefined ? null : `#${id}`;
    }
    case 'not': {
      const c = serialize(tree.child, idOf);
      return c === null ? null : `not(${c})`;
    }
    case 'and':
    case 'or': {
      const parts = tree.children.map(c => serialize(c, idOf)).filter(p => p !== null);
      if (!parts.length) return null;
      if (parts.length === 1) return parts[0];
      return `${tree.node}(${parts.slice().sort().join(',')})`;
    }
    default:
      return null;
  }
}

/**
 * Diff two flattened+treed condition sets (WHERE, HAVING, or one JOIN's ON).
 *
 * @returns {{added, removed, changed, unchanged, shapeChanged}}
 */
export function diffConditionSet(oldConds, oldTree, newConds, newTree) {
  const { pairs, unmatchedOld, unmatchedNew } = matchConditions(oldConds || [], newConds || []);
  const changed = [], unchanged = [];
  const newIdByOldId = new Map();

  pairs.forEach(([o, n]) => {
    newIdByOldId.set(o.id, n.id);
    if (o.sql === n.sql && o.fingerprint === n.fingerprint) unchanged.push(n);
    else changed.push({ old: o, new: n, what: leafDiffKind(o, n) });
  });

  const commonNewIds = new Set(pairs.map(([, n]) => n.id));
  const shapeOld = serialize(oldTree, id => newIdByOldId.get(id) ?? null);
  const shapeNew = serialize(newTree, id => commonNewIds.has(id) ? id : null);

  return {
    added: unmatchedNew,
    removed: unmatchedOld,
    changed,
    unchanged,
    // A shape comparison is only meaningful with something to arrange —
    // one shared leaf has no AND/OR around it to have reshaped.
    shapeChanged: pairs.length > 1 && shapeOld !== shapeNew
  };
}

// ---- joins: existence/type, plus their ON conditions ----------------------

/**
 * Stable-ish string keys for the model elements that do not carry a leaf id
 * the way conditions do (`cond.id`, from analyze()'s WHERE/HAVING/ON walk).
 *
 * These are exported so the technique modules can tag a generated case with
 * the same key its source element gets diffed under (`sourceIds`) — the two
 * sides of the Giai đoạn 3 impact match have to agree on what a "changed
 * GROUP BY key" or "changed join" is called, or the match silently misses.
 */
// Each prefixed so the sets never collide across sections — a GROUP BY key
// and a SET column happening to render the same text must not look like the
// same changed element.
export function joinKey(j) { return `JOIN:${j.leftLabel}⋈${j.rightLabel}`; }
export function tableKey(t) { return `TBL:${t.label}`; }
export function groupByKey(g) { return `GB:${g.sql}`; }
export function aggregateKey(a) { return `AGG:${a.sql}`; }
export function orderByKey(o) { return `OB:${o.sql}`; }
export function selectKey(c) { return `SEL:${c.alias || c.sql}`; }
export function caseExprKey(c) { return `CE:${c.context}`; }
export function writeKey(c) { return `WCOL:${c.name}`; }

/**
 * Which diff section (and case filter bucket) a condition's `source` — as
 * set by analyze()'s collectConditions() — belongs to. Shared by the
 * technique modules (to tag a case's `clause`) and by the case filter in
 * ui.js, so both sides of "what clause is this case about" agree.
 */
export function clauseFromSource(source) {
  if (!source) return 'OTHER';
  if (source === 'WHERE') return 'WHERE';
  if (source === 'HAVING') return 'HAVING';
  if (source.startsWith('ON ')) return 'JOIN';
  return 'OTHER';
}

// ---- case tagging -----------------------------------------------------
//
// One `caseSourceFrom*()` per kind of model element a technique module can
// build a case from. Each returns the `{sourceIds, clause, columns}` slice
// every case needs for Giai đoạn 3's change-impact match and its filters —
// centralised here, next to the key functions above, so a technique module
// never has to invent its own scheme (and risk drifting from what the
// impact match and the filter actually key on).

/** A case built from one WHERE/HAVING/ON leaf condition. */
export function caseSourceFromCondition(cond) {
  return { sourceIds: [cond.id], clause: clauseFromSource(cond.source), columns: cond.column ? [cond.column] : [] };
}

/** A case built from every condition in a decision-table rule or bail-out. */
export function caseSourceFromConditions(conds, clauseLabel) {
  return {
    sourceIds: conds.map(c => c.id),
    clause: clauseFromSource(clauseLabel),
    columns: conds.map(c => c.column).filter(Boolean)
  };
}

/** A case built from a join's existence/type/cardinality, not one predicate. */
export function caseSourceFromJoin(join) {
  return { sourceIds: [joinKey(join)], clause: 'JOIN', columns: [] };
}

export function caseSourceFromGroupBy(gb) {
  return { sourceIds: [groupByKey(gb)], clause: 'GROUP_BY', columns: gb.column ? [gb.column] : [] };
}

export function caseSourceFromAggregate(agg) {
  return { sourceIds: [aggregateKey(agg)], clause: 'GROUP_BY', columns: agg.column ? [agg.column] : [] };
}

export function caseSourceFromOrderBy(o) {
  return { sourceIds: [orderByKey(o)], clause: 'ORDER_BY', columns: o.column ? [o.column] : [] };
}

export function caseSourceFromWrite(kind, col) {
  return { sourceIds: [writeKey(col)], clause: kind === 'insert' ? 'INSERT' : 'SET', columns: [] };
}

export function caseSourceFromCaseExpr(ce) {
  return { sourceIds: [caseExprKey(ce)], clause: 'CASE_EXPR', columns: [] };
}

/**
 * Joins are diffed in two layers: whether the join itself (and its type)
 * changed, and — separately — whether its ON predicates changed. A join that
 * flips from LEFT to INNER with an identical ON clause is a very different
 * risk from one whose join type is untouched but gained a filtering
 * predicate, so collapsing the two into one bucket would hide that.
 */
function diffJoinsFull(oldModel, newModel) {
  const existence = diffByKey(oldModel.joins, newModel.joins, joinKey,
    (a, b) => a.joinType === b.joinType && a.implicit === b.implicit && a.natural === b.natural);

  const conditions = { added: [], removed: [], changed: [], unchanged: [], shapeChangedCount: 0 };
  const newByKey = new Map(newModel.joins.map(j => [joinKey(j), j]));
  const onCondsFor = (model, join) => model.joinConditions.filter(c => c.source === `ON ${join.rightLabel}`);

  const seen = new Set();
  oldModel.joins.forEach(oj => {
    const k = joinKey(oj);
    seen.add(k);
    const nj = newByKey.get(k);
    const oldConds = onCondsFor(oldModel, oj);
    if (!nj) { conditions.removed.push(...oldConds); return; }
    const newConds = onCondsFor(newModel, nj);
    const d = diffConditionSet(oldConds, oj.onTree, newConds, nj.onTree);
    conditions.added.push(...d.added);
    conditions.removed.push(...d.removed);
    conditions.changed.push(...d.changed);
    conditions.unchanged.push(...d.unchanged);
    if (d.shapeChanged) conditions.shapeChangedCount++;
  });
  newModel.joins.forEach(nj => {
    if (seen.has(joinKey(nj))) return;
    conditions.added.push(...onCondsFor(newModel, nj));
  });

  return { existence, conditions };
}

// ---- the simpler, list-shaped sections -------------------------------------

function diffTables(oldModel, newModel) {
  return diffByKey(oldModel.tables, newModel.tables, tableKey,
    (a, b) => a.name === b.name && a.joinType === b.joinType && a.role === b.role);
}

function diffGroupBy(oldModel, newModel) {
  return diffByKey(oldModel.grouping.groupBy, newModel.grouping.groupBy, groupByKey, () => true);
}

function diffAggregates(oldModel, newModel) {
  return diffByKey(oldModel.grouping.aggregates, newModel.grouping.aggregates, aggregateKey, () => true);
}

function diffOrderBy(oldModel, newModel) {
  return diffByKey(oldModel.paging.orderBy, newModel.paging.orderBy, orderByKey,
    (a, b) => a.dir === b.dir && a.nulls === b.nulls);
}

function diffCaseExprs(oldModel, newModel) {
  return diffByKey(oldModel.caseExprs, newModel.caseExprs, caseExprKey, (a, b) => a.sql === b.sql);
}

/** The SELECT list keeps its column order and aliases only on the raw AST. */
function selectAst(ast) { return ast.type === 'setop' ? selectAst(ast.left) : ast; }

function selectItems(ast) {
  return (selectAst(ast).columns || []).map(c => ({ sql: exprToSql(c.expr), alias: c.alias || null }));
}

function diffSelectList(oldAst, newAst) {
  return diffByKey(selectItems(oldAst), selectItems(newAst), selectKey,
    (a, b) => a.sql === b.sql && a.alias === b.alias);
}

function writeItems(writes) {
  if (!writes) return [];
  return writes.columns.map(c => ({
    name: c.name,
    sql: writes.kind === 'insert' ? (c.values || []).map(v => v.sql).join(', ') : (c.value ? c.value.sql : '')
  }));
}

function diffWrites(oldModel, newModel) {
  if (!oldModel.writes && !newModel.writes) return null;
  return diffByKey(writeItems(oldModel.writes), writeItems(newModel.writes), writeKey, (a, b) => a.sql === b.sql);
}

function operandSql(op) { return op ? op.sql : null; }

function diffPaging(oldModel, newModel) {
  const o = oldModel.paging, n = newModel.paging;
  return {
    limit: { changed: operandSql(o.limit) !== operandSql(n.limit), old: o.limit, new: n.limit },
    offset: { changed: operandSql(o.offset) !== operandSql(n.offset), old: o.offset, new: n.offset }
  };
}

// ---- totals -----------------------------------------------------------

function sectionCount(sec) {
  if (!sec) return 0;
  return sec.added.length + sec.removed.length + sec.changed.length + (sec.shapeChanged ? 1 : 0);
}

// ---- entry point --------------------------------------------------------

/**
 * Diff two SQL statements structurally.
 *
 * @param {string} sqlBefore
 * @param {string} sqlAfter
 * @returns {object} `{ok:false, before, after}` if either side fails to
 *   parse; otherwise the full section-by-section diff plus a `summary`.
 */
export function diffQueries(sqlBefore, sqlAfter) {
  const beforeParsed = parse(sqlBefore || '');
  const afterParsed = parse(sqlAfter || '');
  const before = { errors: beforeParsed.errors, warnings: beforeParsed.warnings };
  const after = { errors: afterParsed.errors, warnings: afterParsed.warnings };

  if (!beforeParsed.ast || !afterParsed.ast) {
    return { ok: false, before, after };
  }

  const oldModel = analyze(beforeParsed.ast);
  const newModel = analyze(afterParsed.ast);
  before.model = oldModel;
  after.model = newModel;

  const joinsFull = diffJoinsFull(oldModel, newModel);

  const result = {
    ok: true,
    before,
    after,
    statementChanged: oldModel.statement !== newModel.statement,
    statement: { old: oldModel.statement, new: newModel.statement },
    tables: diffTables(oldModel, newModel),
    joins: joinsFull.existence,
    joinConditions: joinsFull.conditions,
    where: diffConditionSet(oldModel.conditions, oldModel.whereTree, newModel.conditions, newModel.whereTree),
    having: diffConditionSet(oldModel.havingConditions, oldModel.havingTree, newModel.havingConditions, newModel.havingTree),
    groupBy: diffGroupBy(oldModel, newModel),
    aggregates: diffAggregates(oldModel, newModel),
    orderBy: diffOrderBy(oldModel, newModel),
    paging: diffPaging(oldModel, newModel),
    selectList: diffSelectList(beforeParsed.ast, afterParsed.ast),
    caseExprs: diffCaseExprs(oldModel, newModel),
    writes: diffWrites(oldModel, newModel)
  };

  let totalChanges = [
    result.tables, result.joins, result.joinConditions, result.where, result.having,
    result.groupBy, result.aggregates, result.orderBy, result.selectList, result.caseExprs, result.writes
  ].reduce((sum, sec) => sum + sectionCount(sec), 0);
  totalChanges += joinsFull.conditions.shapeChangedCount;
  if (result.paging.limit.changed) totalChanges++;
  if (result.paging.offset.changed) totalChanges++;
  if (result.statementChanged) totalChanges++;

  result.summary = { totalChanges, hasChanges: totalChanges > 0 };
  return result;
}
