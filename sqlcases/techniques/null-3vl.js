/**
 * null-3vl.js — NULL handling and three-valued logic.
 *
 * SQL predicates return TRUE, FALSE or UNKNOWN, and only TRUE keeps a row.
 * That one rule is behind most of the quiet data bugs in production queries:
 * `status <> 'cancelled'` silently drops rows where status is NULL,
 * `NOT IN (subquery)` returns nothing at all if the subquery yields a single
 * NULL, and `COUNT(col)` disagrees with `COUNT(*)` by exactly the NULL count.
 *
 * Each case here names the specific NULL that triggers the behaviour, so the
 * tester seeds one row rather than guessing which column to blank out.
 */

import { columnLabel } from '../values.js';
import { t } from '../i18n.js';
import {
  caseSourceFromCondition, caseSourceFromJoin, caseSourceFromGroupBy,
  caseSourceFromAggregate, caseSourceFromOrderBy, caseSourceFromWrite
} from '../diff.js';

const CMP = new Set(['comparison', 'between', 'in-list', 'like', 'quantified']);

function baseCase(fields) {
  return { technique: 'NULL / 3VL', priority: 'High', notes: '', ...fields };
}

/** Predicates whose column going NULL makes them UNKNOWN → row disappears. */
function nullablePredicateCases(model, kind) {
  const cases = [];
  const outcome = t(kind === 'update' ? 'n3.outUpdate'
    : kind === 'delete' ? 'n3.outDelete'
    : 'n3.outSelect');

  const seen = new Set();
  const all = [...model.conditions, ...model.havingConditions, ...model.joinConditions];

  all.forEach(cond => {
    if (!CMP.has(cond.kind) || !cond.column) return;
    const col = columnLabel(cond);
    const key = `${cond.source}|${col}`;
    if (seen.has(key)) return;
    seen.add(key);

    const negativeOp = ['!=', '<>'].includes(cond.operator) || cond.operator === 'NOT IN' || cond.negated;

    cases.push(baseCase({
      group: `${cond.source} · ${col}`,
      target: col,
      condition: cond.sql,
      title: t('n3.unknownTitle', { col }),
      data: t('n3.unknownData', { col }),
      expected: t('n3.unknownExp', { outcome }),
      spec: { set: [{ column: cond.column, columnRaw: col, valueSql: 'NULL' }] },
      priority: negativeOp ? 'High' : 'Medium',
      notes: negativeOp ? t('n3.unknownNote', { op: cond.operator, col }) : '',
      ...caseSourceFromCondition(cond)
    }));
  });

  return cases;
}

/** The NOT IN / NOT EXISTS asymmetry, which only bites when NULLs are present. */
function notInSubqueryCases(model) {
  const cases = [];
  model.conditions.concat(model.havingConditions).forEach(cond => {
    if (cond.kind === 'in-subquery' && cond.negated) {
      const col = columnLabel(cond);
      cases.push(baseCase({
        group: `${cond.source} · ${col}`,
        target: col,
        condition: cond.sql,
        title: t('n3.notInNull'),
        data: t('n3.notInNullData'),
        expected: t('n3.notInNullExp'),
        priority: 'High',
        notes: t('n3.notInNullNote'),
        ...caseSourceFromCondition(cond)
      }));
      cases.push(baseCase({
        group: `${cond.source} · ${col}`,
        target: col,
        condition: cond.sql,
        title: t('n3.notInClean'),
        data: t('n3.notInCleanData'),
        expected: t('n3.notInCleanExp'),
        priority: 'High',
        notes: t('n3.notInCleanNote'),
        ...caseSourceFromCondition(cond)
      }));
    }
    if (cond.kind === 'in-list' && cond.negated) {
      cases.push(baseCase({
        group: `${cond.source} · ${columnLabel(cond)}`,
        target: columnLabel(cond),
        condition: cond.sql,
        title: t('n3.notInListNull', { col: columnLabel(cond) }),
        data: `${columnLabel(cond)} = NULL`,
        expected: t('n3.notInListNullExp'),
        spec: { set: [{ column: cond.column, columnRaw: columnLabel(cond), valueSql: 'NULL' }] },
        priority: 'High',
        ...caseSourceFromCondition(cond)
      }));
    }
  });
  return cases;
}

/** `= NULL` / `<> NULL` written where IS NULL was meant. */
function equalsNullCases(model) {
  const cases = [];
  [...model.conditions, ...model.havingConditions, ...model.joinConditions].forEach(cond => {
    const literalNull = cond.values.some(v => v.kind === 'literal' && v.value === null);
    if (cond.kind === 'comparison' && literalNull) {
      cases.push(baseCase({
        group: `${cond.source} · ${columnLabel(cond)}`,
        target: columnLabel(cond),
        condition: cond.sql,
        title: t('n3.equalsNull', { cond: cond.sql }),
        data: t('n3.equalsNullData', { col: columnLabel(cond) }),
        expected: t('n3.equalsNullExp'),
        priority: 'High',
        notes: t('n3.queryDefect'),
        ...caseSourceFromCondition(cond)
      }));
    }
  });
  return cases;
}

/** Split `alias.column` back into the shape a spec entry needs. */
function parseRef(raw) {
  const dot = String(raw).lastIndexOf('.');
  return dot > 0
    ? { table: raw.slice(0, dot), name: raw.slice(dot + 1), raw }
    : { table: null, name: String(raw), raw };
}

/** NULLs on either side of a join key. */
function joinNullCases(model) {
  const cases = [];
  model.joins.forEach(join => {
    (join.keys || []).forEach(k => {
      cases.push(baseCase({
        group: `JOIN · ${join.leftLabel} ⋈ ${join.rightLabel}`,
        target: `${k.left} = ${k.right}`,
        condition: join.onSql || '',
        spec: { set: [{ column: parseRef(k.left), columnRaw: k.left, valueSql: 'NULL' }] },
        title: t('n3.joinKeyNull', { key: k.left }),
        data: t('n3.joinKeyNullData', { left: join.leftLabel, key: k.left }),
        expected: join.joinType === 'LEFT' || join.joinType === 'FULL'
          ? t('n3.joinKeyNullOuter', { right: join.rightLabel })
          : t('n3.joinKeyNullInner'),
        priority: 'High',
        notes: t('n3.joinKeyNullNote'),
        ...caseSourceFromJoin(join)
      }));
    });
    if (!join.keys?.length && join.onSql) {
      cases.push(baseCase({
        group: `JOIN · ${join.leftLabel} ⋈ ${join.rightLabel}`,
        target: join.rightLabel,
        condition: join.onSql,
        title: t('n3.joinOnNull', { right: join.rightLabel }),
        data: t('n3.joinOnNullData', { right: join.rightLabel }),
        expected: t('n3.joinOnNullExp'),
        priority: 'Medium',
        ...caseSourceFromJoin(join)
      }));
    }
  });
  return cases;
}

/** Aggregates and grouping under NULLs. */
function aggregateNullCases(model) {
  const cases = [];
  const g = model.grouping;

  g.aggregates.forEach(agg => {
    const col = agg.column?.raw || (agg.star ? '*' : t('grp.expression'));
    const group = `${t('grp.aggregate')} · ${agg.sql}`;

    if (agg.name === 'COUNT' && !agg.star) {
      cases.push(baseCase({
        group, target: agg.sql, condition: agg.sql,
        title: t('n3.countSkipsNull', { col }),
        data: t('n3.countSkipsNullData', { col }),
        expected: t('n3.countSkipsNullExp', { agg: agg.sql }),
        priority: 'High',
        notes: agg.distinct ? t('n3.countDistinctNote') : '',
        ...caseSourceFromAggregate(agg)
      }));
    }
    if (agg.name === 'COUNT' && agg.star) {
      cases.push(baseCase({
        group, target: agg.sql, condition: agg.sql,
        title: t('n3.countStar'),
        data: t('n3.countStarData'),
        expected: t('n3.countStarExp'),
        priority: 'Medium',
        ...caseSourceFromAggregate(agg)
      }));
    }
    if (['SUM', 'AVG', 'MIN', 'MAX'].includes(agg.name)) {
      cases.push(baseCase({
        group, target: agg.sql, condition: agg.sql,
        title: t('n3.aggIgnoresNull', { agg: agg.name, col }),
        data: t('n3.aggIgnoresNullData', { col }),
        expected: agg.name === 'AVG' ? t('n3.avgDenominator') : t('n3.aggOverNonNull', { agg: agg.name }),
        priority: 'High',
        ...caseSourceFromAggregate(agg)
      }));
      cases.push(baseCase({
        group, target: agg.sql, condition: agg.sql,
        title: t('n3.aggAllNull', { agg: agg.name, col }),
        data: t('n3.aggAllNullData', { col }),
        expected: agg.name === 'SUM' ? t('n3.aggAllNullSum') : t('n3.aggAllNullExp'),
        priority: 'High',
        ...caseSourceFromAggregate(agg)
      }));
    }
  });

  g.groupBy.forEach(gb => {
    cases.push(baseCase({
      group: `GROUP BY · ${gb.sql}`,
      target: gb.sql,
      condition: `GROUP BY ${gb.sql}`,
      spec: gb.column ? { set: [{ column: gb.column, columnRaw: gb.sql, valueSql: 'NULL' }] } : undefined,
      title: t('n3.groupKeyNull', { key: gb.sql }),
      data: t('n3.groupKeyNullData', { key: gb.sql }),
      expected: t('n3.groupKeyNullExp'),
      priority: 'High',
      ...caseSourceFromGroupBy(gb)
    }));
  });

  if (g.distinct) {
    cases.push(baseCase({
      group: 'DISTINCT',
      target: 'SELECT DISTINCT',
      condition: 'SELECT DISTINCT …',
      title: t('n3.distinctNull'),
      data: t('n3.distinctNullData'),
      expected: t('n3.distinctNullExp'),
      priority: 'Medium'
    }));
  }

  return cases;
}

/** ORDER BY position of NULLs. */
function orderingNullCases(model) {
  return model.paging.orderBy
    .filter(o => o.column)
    .map(o => baseCase({
      group: `ORDER BY · ${o.sql}`,
      target: o.sql,
      condition: `ORDER BY ${o.sql} ${o.dir}`,
      spec: o.column ? { set: [{ column: o.column, columnRaw: o.sql, valueSql: 'NULL' }] } : undefined,
      title: t('n3.orderNull', { key: o.sql }),
      data: t('n3.orderNullData', { key: o.sql }),
      expected: o.nulls
        ? t(o.nulls === 'FIRST' ? 'n3.orderNullFirst' : 'n3.orderNullLast')
        : t('n3.orderNullEngine'),
      priority: o.nulls ? 'Low' : 'Medium',
      notes: o.nulls ? '' : t('n3.orderNullNote'),
      ...caseSourceFromOrderBy(o)
    }));
}

/** NULLs written by INSERT / UPDATE. */
function writeNullCases(model) {
  const cases = [];
  const w = model.writes;
  if (!w) return cases;

  if (w.kind === 'insert') {
    w.columns.forEach(c => {
      const explicitNull = c.values.some(v => v.kind === 'literal' && v.value === null);
      cases.push(baseCase({
        group: `INSERT · ${w.table}.${c.name}`,
        target: `${w.table}.${c.name}`,
        condition: `INSERT INTO ${w.table} (… ${c.name} …)`,
        title: t(explicitNull ? 'n3.insertExplicitNull' : 'n3.insertNull', { col: c.name }),
        data: `${c.name} = NULL`,
        expected: t(explicitNull ? 'n3.insertExplicitNullExp' : 'n3.insertNullExp'),
        priority: explicitNull ? 'High' : 'Medium',
        ...caseSourceFromWrite('insert', c)
      }));
    });
    if (!w.columnsExplicit && !w.fromSelect) {
      cases.push(baseCase({
        group: `INSERT · ${w.table}`,
        target: w.table,
        condition: t('n3.noColumnListCond'),
        title: t('n3.noColumnList'),
        data: t('n3.noColumnListData'),
        expected: t('n3.noColumnListExp'),
        priority: 'High'
      }));
    }
  }

  if (w.kind === 'update') {
    w.columns.forEach(c => {
      if (c.selfReferential) {
        cases.push(baseCase({
          group: `UPDATE · ${w.table}.${c.name}`,
          target: `${w.table}.${c.name}`,
          condition: `SET ${c.name} = ${c.value.sql}`,
          title: t('n3.updateArithNull', { col: c.name }),
          data: t('n3.updateArithNullData', { col: c.name }),
          expected: t('n3.updateArithNullExp', { col: c.name }),
          priority: 'High',
          notes: t('n3.updateArithNullNote', { col: c.name }),
          ...caseSourceFromWrite('update', c)
        }));
      }
      cases.push(baseCase({
        group: `UPDATE · ${w.table}.${c.name}`,
        target: `${w.table}.${c.name}`,
        condition: `SET ${c.name} = ${c.value.sql}`,
        title: t('n3.updateSetNull', { col: c.name }),
        data: c.value.kind === 'param'
          ? t('n3.updateSetNullParam', { param: c.value.sql })
          : t('n3.updateSetNullData', { col: c.name }),
        expected: t('n3.updateSetNullExp'),
        priority: c.value.kind === 'param' ? 'High' : 'Medium',
        notes: c.value.kind === 'param' ? t('n3.updateSetNullParamNote') : '',
        ...caseSourceFromWrite('update', c)
      }));
    });
  }

  return cases;
}

/**
 * @param {object} model — from analyze()
 * @returns {Array} cases
 */
export function generateNull3vl(model) {
  const kind = model.statement;
  return [
    ...nullablePredicateCases(model, kind),
    ...notInSubqueryCases(model),
    ...equalsNullCases(model),
    ...joinNullCases(model),
    ...aggregateNullCases(model),
    ...orderingNullCases(model),
    ...writeNullCases(model)
  ];
}
