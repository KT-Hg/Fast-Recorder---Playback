/**
 * analyze.js — Turns a parsed statement into the flat model the technique
 * modules consume.
 *
 * The techniques should not each re-walk an AST, so everything they need is
 * normalised once here: the boolean tree of WHERE reduced to numbered leaf
 * conditions, each leaf carrying its column, operator, comparison values and
 * an inferred data type; the join list with the cardinality-relevant bits;
 * grouping, ordering and paging; and, for DML, the columns being written.
 *
 * Type inference is heuristic and says so — `dataType.confidence` is 'literal'
 * when a comparison value told us outright, 'name' when only the column name
 * hinted at it, and 'unknown' otherwise. Generators use that to decide whether
 * a boundary value is concrete or a placeholder for the tester to fill in.
 *
 * One value comes from outside the query: a bind parameter the user has bound
 * in the value book stops being an opaque marker here and is described as an
 * ordinary literal. That single substitution is why binding `:amount` turns
 * every downstream case concrete without any technique knowing the value book
 * exists.
 */

import { exprToSql } from './parser.js';
import { boundParam, paramLabel, useTables } from './valuebook.js';

/** Operators that place a value on an ordered scale, so BVA applies. */
export const ORDERED_OPS = new Set(['>', '>=', '<', '<=', 'BETWEEN']);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

const NAME_HINTS = [
  [/(^|_)(is|has|can|should)_/i, 'boolean'],
  [/(^|_)(id|ids)$/i, 'integer'],
  [/_id$/i, 'integer'],
  [/(count|qty|quantity|num|number|total|level|rank|age|year|month|day)$/i, 'integer'],
  [/(price|amount|balance|rate|ratio|percent|score|cost|fee|tax)$/i, 'decimal'],
  [/_at$/i, 'datetime'],
  [/(^|_)(date|birthday|dob)$/i, 'date'],
  [/_date$/i, 'date'],
  [/(^|_)(time)$/i, 'time'],
  [/(email|mail)$/i, 'email'],
  [/(name|title|code|status|type|slug|label|desc|description|address|note)$/i, 'string']
];

const DATE_FUNCS = new Set(['NOW', 'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURDATE', 'GETDATE', 'SYSDATE', 'TODAY']);

/** Infer a data type from a literal/expression on the right of a comparison. */
function typeFromValue(e) {
  if (!e) return null;
  if (e.type === 'group') return typeFromValue(e.expr);
  if (e.type === 'cast') return { type: normalizeSqlType(e.dataType), confidence: 'literal' };
  if (e.type === 'literal') {
    if (e.kind === 'number') return { type: Number.isInteger(e.value) ? 'integer' : 'decimal', confidence: 'literal' };
    if (e.kind === 'boolean') return { type: 'boolean', confidence: 'literal' };
    if (e.kind === 'string') {
      if (DATETIME_RE.test(e.value)) return { type: 'datetime', confidence: 'literal' };
      if (DATE_RE.test(e.value)) return { type: 'date', confidence: 'literal' };
      if (TIME_RE.test(e.value)) return { type: 'time', confidence: 'literal' };
      return { type: 'string', confidence: 'literal' };
    }
    return null;
  }
  if (e.type === 'func' && DATE_FUNCS.has(e.name.toUpperCase())) {
    return { type: e.name.toUpperCase() === 'CURRENT_DATE' ? 'date' : 'datetime', confidence: 'literal' };
  }
  if (e.type === 'interval') return { type: 'datetime', confidence: 'literal' };
  if (e.type === 'param') {
    // A bound parameter types the comparison as surely as a literal would:
    // `amount > :limit` with :limit = 0.5 is a decimal comparison.
    const bound = boundParam(e.name, e.ordinal);
    if (!bound) return null;
    return typeFromValue({ type: 'literal', kind: bound.literalKind, value: bound.value });
  }
  return null;
}

function normalizeSqlType(raw) {
  const t = String(raw || '').toLowerCase();
  if (/int|serial|bigint|smallint/.test(t)) return 'integer';
  if (/dec|numeric|float|double|real|money/.test(t)) return 'decimal';
  if (/timestamp|datetime/.test(t)) return 'datetime';
  if (/date/.test(t)) return 'date';
  if (/time/.test(t)) return 'time';
  if (/bool|bit/.test(t)) return 'boolean';
  return 'string';
}

/** Fall back to the column name when no literal gave the type away. */
function typeFromName(name) {
  if (!name) return { type: 'unknown', confidence: 'unknown' };
  for (const [re, type] of NAME_HINTS) {
    if (re.test(name)) return { type, confidence: 'name' };
  }
  return { type: 'unknown', confidence: 'unknown' };
}

/**
 * Infer a type for a compared expression that is not a plain column.
 *
 * `HAVING SUM(qty * unit_price * (1 - discount)) > 5000000` compares against an
 * integer literal, but the expression produces money — so the real boundary is
 * 4999999.99, not 4999999. Walking the expression for a column whose name reads
 * as decimal recovers that, while COUNT stays integer whatever it counts.
 */
function typeFromExpression(e) {
  const n = unwrap(e);
  if (!n) return null;
  if (n.type === 'func' && n.name.toUpperCase() === 'COUNT') {
    return { type: 'integer', confidence: 'literal' };
  }

  let best = null;
  const walk = (x) => {
    if (!x || typeof x !== 'object') return;
    if (x.type === 'column') {
      const hint = typeFromName(x.name);
      // Decimal wins over integer: an integer column in the same expression
      // does not stop the result from having a fractional part.
      if (hint.type === 'decimal') best = hint;
      else if (!best && hint.type !== 'unknown') best = hint;
      return;
    }
    for (const k of Object.keys(x)) {
      const v = x[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(n);
  return best;
}

/** Unwrap parentheses so `(a)` and `a` look the same to the techniques. */
function unwrap(e) {
  let n = e;
  while (n && n.type === 'group') n = n.expr;
  return n;
}

function isColumn(e) { return unwrap(e)?.type === 'column'; }
function asColumn(e) {
  const n = unwrap(e);
  return n?.type === 'column' ? { table: n.table, name: n.name, raw: n.raw } : null;
}

/** A literal, a bind parameter, or something we cannot pin to a value. */
function describeOperand(e) {
  const n = unwrap(e);
  if (!n) return { kind: 'none', sql: '' };
  if (n.type === 'literal') return { kind: 'literal', value: n.value, literalKind: n.kind, sql: n.raw };
  if (n.type === 'param') {
    const bound = boundParam(n.name, n.ordinal);
    // `param` stays on the operand so a case can still say where the value
    // came from; `kind: 'literal'` is what makes the arithmetic work.
    if (bound) {
      return {
        kind: 'literal', value: bound.value, literalKind: bound.literalKind,
        sql: bound.sql, param: paramLabel(n.name, n.ordinal), bound: true
      };
    }
    return { kind: 'param', name: n.name, ordinal: n.ordinal ?? null, sql: n.name };
  }
  if (n.type === 'column') return { kind: 'column', column: asColumn(n), sql: n.raw };
  return { kind: 'expr', sql: exprToSql(n) };
}

const MIRROR = { '>': '<', '>=': '<=', '<': '>', '<=': '>=', '=': '=', '!=': '!=', '<>': '<>', '<=>': '<=>' };

/**
 * Walk a boolean expression, collecting leaf conditions and rebuilding the
 * tree with leaves replaced by `{ node:'leaf', id }` so the decision-table
 * technique can evaluate combinations without re-parsing.
 */
function collectConditions(expr, source, out, prefix) {
  if (!expr) return null;
  const e = unwrap(expr);

  if (e.type === 'binary' && (e.op === 'AND' || e.op === 'OR')) {
    return {
      node: e.op.toLowerCase(),
      children: [
        collectConditions(e.left, source, out, prefix),
        collectConditions(e.right, source, out, prefix)
      ]
    };
  }

  if (e.type === 'unary' && e.op === 'NOT') {
    return { node: 'not', child: collectConditions(e.expr, source, out, prefix) };
  }

  const cond = describeLeaf(e, source);
  cond.id = `${prefix}${out.length + 1}`;
  out.push(cond);
  return { node: 'leaf', id: cond.id };
}

/** Normalise a single non-boolean predicate into a condition record. */
function describeLeaf(e, source) {
  const base = {
    source,
    sql: exprToSql(e),
    column: null,
    operator: '?',
    negated: false,
    operands: [],
    values: [],
    dataType: { type: 'unknown', confidence: 'unknown' },
    kind: 'other',
    columnToColumn: false
  };

  const finish = (c) => {
    if (c.dataType.confidence === 'unknown' && c.column) c.dataType = typeFromName(c.column.name);
    return c;
  };

  switch (e.type) {
    case 'binary': {
      if (!MIRROR[e.op]) {
        // Arithmetic used as a predicate, or an operator we do not model.
        return finish(base);
      }
      let left = e.left, right = e.right, op = e.op;
      // Put the column on the left so every technique can assume that shape.
      if (!isColumn(left) && isColumn(right)) { [left, right] = [right, left]; op = MIRROR[op] || op; }
      base.operator = op;
      base.kind = 'comparison';
      base.column = asColumn(left);
      base.operands = [describeOperand(left), describeOperand(right)];
      base.columnToColumn = isColumn(left) && isColumn(right);
      base.values = [describeOperand(right)];
      base.dataType = typeFromValue(right) || (base.column ? typeFromName(base.column.name) : base.dataType);
      // A literal only tells us how it was written. When the left side is an
      // expression rather than a column, what that expression produces is the
      // better guide — an integer literal is a valid decimal too.
      if (!base.column && base.dataType.type === 'integer') {
        const fromExpr = typeFromExpression(left);
        if (fromExpr && fromExpr.type === 'decimal') base.dataType = fromExpr;
      }
      if (!base.column) base.column = asColumn(right);
      return finish(base);
    }
    case 'is': {
      base.kind = e.target === 'NULL' ? 'null-check' : 'truth-check';
      base.operator = `IS ${e.negated ? 'NOT ' : ''}${e.target}`;
      base.negated = e.negated;
      base.column = asColumn(e.expr);
      base.operands = [describeOperand(e.expr)];
      return finish(base);
    }
    case 'in': {
      base.kind = e.select ? 'in-subquery' : 'in-list';
      base.operator = `${e.negated ? 'NOT ' : ''}IN`;
      base.negated = e.negated;
      base.column = asColumn(e.expr);
      base.operands = [describeOperand(e.expr)];
      base.values = e.list ? e.list.map(describeOperand) : [];
      const typed = e.list?.map(typeFromValue).find(Boolean);
      base.dataType = typed || (base.column ? typeFromName(base.column.name) : base.dataType);
      return finish(base);
    }
    case 'like': {
      base.kind = 'like';
      base.operator = `${e.negated ? 'NOT ' : ''}${e.ci ? 'ILIKE' : 'LIKE'}`;
      base.negated = e.negated;
      base.column = asColumn(e.expr);
      base.operands = [describeOperand(e.expr)];
      base.values = [describeOperand(e.pattern)];
      base.dataType = { type: 'string', confidence: 'literal' };
      return finish(base);
    }
    case 'between': {
      base.kind = 'between';
      base.operator = `${e.negated ? 'NOT ' : ''}BETWEEN`;
      base.negated = e.negated;
      base.column = asColumn(e.expr);
      base.operands = [describeOperand(e.expr)];
      base.values = [describeOperand(e.low), describeOperand(e.high)];
      base.dataType = typeFromValue(e.low) || typeFromValue(e.high) ||
        (base.column ? typeFromName(base.column.name) : base.dataType);
      return finish(base);
    }
    case 'exists': {
      base.kind = 'exists';
      base.operator = `${e.negated ? 'NOT ' : ''}EXISTS`;
      base.negated = e.negated;
      return finish(base);
    }
    case 'quantified': {
      base.kind = 'quantified';
      base.operator = `${e.op} ${e.quant}`;
      base.column = asColumn(e.left);
      return finish(base);
    }
    case 'column': {
      // A bare boolean column used as a predicate.
      base.kind = 'boolean-column';
      base.operator = 'TRUTHY';
      base.column = asColumn(e);
      base.dataType = { type: 'boolean', confidence: 'name' };
      return finish(base);
    }
    default:
      return finish(base);
  }
}

/**
 * Collect every CASE expression, with the clause it appeared in.
 *
 * A CASE is a decision inside the projection, so its branches need the same
 * coverage a WHERE clause gets — including the implicit NULL branch a missing
 * ELSE leaves behind.
 */
function findCases(node, context, out) {
  const walk = (e) => {
    if (!e || typeof e !== 'object') return;
    if (e.type === 'case') {
      out.push({
        context,
        sql: caseSql(e),
        operand: e.operand ? exprToSql(e.operand) : null,
        whens: e.whens.map(w => ({ when: exprToSql(w.when), then: exprToSql(w.then) })),
        elseSql: e.else ? exprToSql(e.else) : null,
        hasElse: !!e.else
      });
    }
    for (const k of Object.keys(e)) {
      const v = e[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(node);
  return out;
}

/** Render a CASE compactly enough to identify it in a case list. */
function caseSql(e) {
  const head = e.operand ? `CASE ${exprToSql(e.operand)}` : 'CASE';
  const whens = e.whens.map(w => `WHEN ${exprToSql(w.when)} THEN ${exprToSql(w.then)}`).join(' ');
  return `${head} ${whens}${e.else ? ` ELSE ${exprToSql(e.else)}` : ''} END`;
}

/** Collect every aggregate call inside an expression. */
function findAggregates(expr, out = []) {
  const AGG = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'GROUP_CONCAT', 'STRING_AGG', 'ARRAY_AGG', 'STDDEV', 'VARIANCE']);
  const walk = (e) => {
    if (!e || typeof e !== 'object') return;
    if (e.type === 'func' && AGG.has(e.name.toUpperCase())) {
      const arg = e.args[0];
      out.push({
        name: e.name.toUpperCase(),
        distinct: !!e.distinct,
        star: arg?.type === 'star',
        column: arg ? asColumn(arg) : null,
        sql: exprToSql(e)
      });
    }
    for (const k of Object.keys(e)) {
      const v = e[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object' && v.type) walk(v);
      else if (v && typeof v === 'object' && (v.expr || v.when)) walk(v);
    }
  };
  walk(expr);
  return out;
}

/** Every distinct column mentioned anywhere in the statement. */
function findColumns(node, out = new Map()) {
  const walk = (e) => {
    if (!e || typeof e !== 'object') return;
    if (e.type === 'column') {
      const key = e.raw.toLowerCase();
      if (!out.has(key)) out.set(key, { table: e.table, name: e.name, raw: e.raw });
    }
    for (const k of Object.keys(e)) {
      const v = e[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(node);
  return [...out.values()];
}

function tableLabel(ref) {
  if (!ref) return '?';
  if (ref.kind === 'subquery') return ref.alias || '(subquery)';
  return ref.alias || ref.name;
}

/**
 * Build the analysis model.
 *
 * @param {object} ast — from parse()
 * @returns {object} model consumed by the technique modules
 */
export function analyze(ast) {
  const model = {
    statement: ast?.type || 'unknown',
    tables: [],
    joins: [],
    conditions: [],
    whereTree: null,
    havingConditions: [],
    havingTree: null,
    joinConditions: [],
    grouping: { groupBy: [], having: null, aggregates: [], distinct: false },
    paging: { orderBy: [], limit: null, offset: null },
    writes: null,
    subqueries: [],
    caseExprs: [],
    columns: [],
    selectAliases: [],
    selectsStar: false,
    params: [],
    notes: []
  };

  if (!ast) return model;

  if (ast.type === 'setop') {
    // Analyse the left branch and flag the set operation itself.
    const left = analyze(ast.left);
    left.notes.push({
      level: 'info',
      message: `${ast.op}${ast.all ? ' ALL' : ''} combines two result sets — only the first branch is analysed in detail.`
    });
    left.setop = { op: ast.op, all: ast.all };
    return left;
  }

  // --- tables & joins -------------------------------------------------
  const fromList = ast.from || (ast.table ? [ast.table] : []);
  fromList.forEach(ref => model.tables.push({
    name: ref.kind === 'subquery' ? '(subquery)' : (ref.schema ? `${ref.schema}.${ref.name}` : ref.name),
    alias: ref.alias,
    label: tableLabel(ref),
    role: 'from',
    joinType: null,
    isSubquery: ref.kind === 'subquery'
  }));

  (ast.joins || []).forEach((j, idx) => {
    const ref = j.table;
    const label = tableLabel(ref);
    model.tables.push({
      name: ref.kind === 'subquery' ? '(subquery)' : (ref.schema ? `${ref.schema}.${ref.name}` : ref.name),
      alias: ref.alias,
      label,
      role: 'join',
      joinType: j.joinType,
      isSubquery: ref.kind === 'subquery'
    });
    const leftLabel = model.tables[0]?.label || '?';
    model.joins.push({
      index: idx,
      joinType: j.joinType,
      implicit: !!j.implicit,
      natural: !!j.natural,
      leftLabel,
      rightLabel: label,
      on: j.on,
      onSql: j.on ? exprToSql(j.on) : (j.using.length ? `USING (${j.using.join(', ')})` : null),
      using: j.using,
      keys: j.on ? joinKeys(j.on) : j.using.map(c => ({ left: `${leftLabel}.${c}`, right: `${label}.${c}` }))
    });
    if (j.on) collectConditions(j.on, `ON ${label}`, model.joinConditions, 'J');
  });

  // The value book keys column samples by table name, so it needs this query's
  // alias map before anything resolves a condition to a value.
  useTables(model.tables);

  // --- predicates -----------------------------------------------------
  model.whereTree = collectConditions(ast.where, 'WHERE', model.conditions, 'C');
  if (ast.having) {
    model.havingTree = collectConditions(ast.having, 'HAVING', model.havingConditions, 'H');
  }

  // --- grouping / paging ----------------------------------------------
  model.grouping.groupBy = (ast.groupBy || []).map(e => ({ sql: exprToSql(e), column: asColumn(e) }));
  model.grouping.having = ast.having ? exprToSql(ast.having) : null;
  model.grouping.distinct = !!ast.distinct;
  // The same aggregate usually appears in both the select list and HAVING —
  // dedupe by rendered SQL so it does not generate the case twice.
  const aggs = [];
  (ast.columns || []).forEach(c => findAggregates(c.expr, aggs));
  if (ast.having) findAggregates(ast.having, aggs);
  const seenAgg = new Set();
  model.grouping.aggregates = aggs.filter(a => {
    const key = a.sql.toLowerCase();
    if (seenAgg.has(key)) return false;
    seenAgg.add(key);
    return true;
  });

  model.paging.orderBy = (ast.orderBy || []).map(o => ({ sql: exprToSql(o.expr), dir: o.dir, nulls: o.nulls, column: asColumn(o.expr) }));
  model.paging.limit = ast.limit ? describeOperand(ast.limit) : null;
  model.paging.offset = ast.offset ? describeOperand(ast.offset) : null;

  // --- DML writes -----------------------------------------------------
  if (ast.type === 'insert') {
    const cols = ast.columns.length
      ? ast.columns
      : (ast.rows[0] || []).map((_, i) => `col${i + 1}`);
    model.writes = {
      kind: 'insert',
      table: tableLabel(ast.table),
      columnsExplicit: ast.columns.length > 0,
      fromSelect: !!ast.select,
      rowCount: ast.rows.length,
      columns: cols.map((name, i) => {
        const vals = ast.rows.map(r => describeOperand(r[i])).filter(Boolean);
        const typed = ast.rows.map(r => typeFromValue(r[i])).find(Boolean);
        return {
          name,
          values: vals,
          dataType: typed || typeFromName(name)
        };
      })
    };
  } else if (ast.type === 'update') {
    model.writes = {
      kind: 'update',
      table: tableLabel(ast.table),
      hasWhere: !!ast.where,
      columns: ast.set.map(s => ({
        name: s.column,
        value: describeOperand(s.value),
        selfReferential: findColumns(s.value).some(c => c.name.toLowerCase() === s.column.toLowerCase()),
        dataType: typeFromValue(s.value) || typeFromName(s.column)
      }))
    };
  } else if (ast.type === 'delete') {
    model.writes = { kind: 'delete', table: tableLabel(ast.table), hasWhere: !!ast.where, columns: [] };
  }

  // --- subqueries & CTEs ----------------------------------------------
  (ast.ctes || []).forEach(c => model.subqueries.push({ kind: 'cte', name: c.name }));
  collectSubqueries(ast, model.subqueries);

  model.selectsStar = (ast.columns || []).some(c => c.expr?.type === 'star');
  // `COUNT(o.id) AS orders` puts `orders` into ORDER BY, where it parses as a
  // column reference. It is a name for a result column, not a stored one, so
  // record the aliases and let consumers tell the two apart.
  model.selectAliases = (ast.columns || []).map(c => c.alias).filter(Boolean);

  (ast.columns || []).forEach(c => findCases(c.expr, c.alias ? `SELECT ${c.alias}` : 'SELECT list', model.caseExprs));
  if (ast.where) findCases(ast.where, 'WHERE', model.caseExprs);
  if (ast.having) findCases(ast.having, 'HAVING', model.caseExprs);
  (ast.set || []).forEach(sv => findCases(sv.value, `SET ${sv.column}`, model.caseExprs));

  model.columns = findColumns(ast);
  model.params = findParams(ast);
  return model;
}

/**
 * Every distinct bind parameter in the statement, in source order.
 *
 * The value book offers one field per entry, so `?` markers have to be told
 * apart: `WHERE a > ? AND b < ?` is two independent values, not one used twice.
 * Named parameters are the opposite — `:amount` written three times is one
 * value, and binding it once must reach all three.
 */
function findParams(ast) {
  const out = [];
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 64) return;
    if (node.type === 'param') {
      const label = paramLabel(node.name, node.ordinal);
      if (!seen.has(label.toLowerCase())) {
        seen.add(label.toLowerCase());
        out.push({ name: node.name, ordinal: node.ordinal ?? null, label, pos: node.pos ?? 0 });
      }
      return;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(x => walk(x, depth + 1));
      else if (v && typeof v === 'object') walk(v, depth + 1);
    }
  };
  walk(ast, 0);
  return out.sort((a, b) => a.pos - b.pos);
}

function collectSubqueries(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach(x => collectSubqueries(x, out, depth + 1));
    else if (v && typeof v === 'object') {
      if (v.type === 'subquery' || v.kind === 'subquery') out.push({ kind: 'inline', name: v.alias || null });
      if (v.type === 'in' && v.select) out.push({ kind: 'in-subquery', name: null });
      if (v.type === 'exists') out.push({ kind: 'exists', name: null });
      collectSubqueries(v, out, depth + 1);
    }
  }
}

/** Pull the `a.x = b.y` pairs out of a join condition. */
function joinKeys(expr) {
  const keys = [];
  const walk = (e) => {
    if (!e) return;
    const n = unwrap(e);
    if (n.type === 'binary' && n.op === 'AND') { walk(n.left); walk(n.right); return; }
    if (n.type === 'binary' && n.op === '=' && isColumn(n.left) && isColumn(n.right)) {
      keys.push({ left: asColumn(n.left).raw, right: asColumn(n.right).raw });
    }
  };
  walk(expr);
  return keys;
}

export { unwrap, asColumn, describeOperand, typeFromName };
