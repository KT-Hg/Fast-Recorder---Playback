/**
 * structure.js — Join cardinality, grouping, ordering and paging.
 *
 * These are the parts of a query where the bug is not in a value but in the
 * shape of the result: a 1:n join quietly duplicating rows and inflating a
 * SUM, a WHERE clause on the right side of a LEFT JOIN turning it back into an
 * INNER JOIN, a paginated query with no ORDER BY returning the same row on two
 * different pages. None of those are visible from a single-row test, so each
 * case here specifies the row *population* to seed rather than one value.
 */

import { columnLabel } from '../values.js';
import { t } from '../i18n.js';
import {
  caseSourceFromCondition, caseSourceFromJoin, caseSourceFromOrderBy,
  groupByKey, aggregateKey, writeKey
} from '../diff.js';

function baseCase(fields) {
  return { technique: 'Structure', priority: 'Medium', notes: '', ...fields };
}

const NON_DUPLICATING = new Set(['MIN', 'MAX']);

/** Cardinality cases for each join. */
function joinCases(model) {
  const cases = [];
  const hasInflatableAggregate = model.grouping.aggregates.some(
    a => !NON_DUPLICATING.has(a.name) && !a.distinct
  );

  model.joins.forEach(join => {
    const L = join.leftLabel;
    const R = join.rightLabel;
    const group = `JOIN · ${L} ⋈ ${R}`;
    const keyText = join.keys?.length
      ? join.keys.map(k => `${k.left} = ${k.right}`).join(' AND ')
      : (join.onSql || t('st.noJoinCond'));

    const add = (title, data, expected, extra = {}) => cases.push(baseCase({
      group, target: `${join.joinType} JOIN ${R}`, condition: keyText, title, data, expected,
      ...caseSourceFromJoin(join), ...extra
    }));

    if (join.joinType === 'CROSS' || join.implicit) {
      add(
        join.implicit ? t('st.commaJoin', { left: L, right: R }) : t('st.crossJoin', { left: L, right: R }),
        t('st.rows3x4', { left: L, right: R }),
        t('st.cartesian12'),
        {
          priority: 'High',
          notes: join.implicit ? t('st.commaJoinNote') : ''
        }
      );
      return;
    }

    if (!join.onSql && !join.natural) {
      add(
        t('st.noOn', { type: join.joinType, right: R }),
        t('st.rows3x4', { left: L, right: R }),
        t('st.noOnExp'),
        { priority: 'High', notes: t('st.noOnNote') }
      );
    }

    if (join.natural) {
      add(
        t('st.natural', { right: R }),
        t('st.naturalData', { left: L, right: R }),
        t('st.naturalExp'),
        { priority: 'High' }
      );
    }

    // --- the three cardinalities every join has ---
    add(
      t('st.card11', { right: R }),
      t('st.card11Data', { left: L, right: R }),
      t('st.card11Exp'),
      { priority: 'High', spec: { population: { [L]: 1, [R]: 1 } } }
    );

    add(
      t('st.orphan', { right: R }),
      t('st.orphanData', { left: L, right: R }),
      join.joinType === 'LEFT' || join.joinType === 'FULL'
        ? t('st.orphanKept', { side: R })
        : t('st.orphanDropped', { type: join.joinType }),
      { priority: 'High', spec: { population: { [L]: 1, [R]: 0 } } }
    );

    add(
      t('st.card1n', { right: R }),
      t('st.card1nData', { left: L, right: R }),
      hasInflatableAggregate
        ? t('st.card1nInflated', { left: L, aggs: model.grouping.aggregates.filter(a => !NON_DUPLICATING.has(a.name) && !a.distinct).map(a => a.sql).join(', ') })
        : t('st.card1nExp', { left: L }),
      {
        priority: 'High',
        notes: hasInflatableAggregate ? t('st.card1nNote') : '',
        spec: { population: { [L]: 1, [R]: 3 } }
      }
    );

    if (join.joinType === 'RIGHT' || join.joinType === 'FULL') {
      add(
        t('st.orphan', { right: L }),
        t('st.orphanData', { left: R, right: L }),
        t('st.orphanKept', { side: L }),
        { priority: 'High' }
      );
    }
  });

  return cases;
}

/**
 * A WHERE predicate on a LEFT-joined table's column turns the outer join into
 * an inner one, because the NULLs it produces fail the predicate.
 */
function outerJoinFilterCases(model) {
  const cases = [];
  const outerAliases = new Map();
  model.joins.forEach(j => {
    if (j.joinType === 'LEFT' || j.joinType === 'FULL') outerAliases.set(j.rightLabel.toLowerCase(), j);
  });
  if (!outerAliases.size) return cases;

  model.conditions.forEach(cond => {
    const tbl = cond.column?.table;
    if (!tbl || !outerAliases.has(tbl.toLowerCase())) return;
    if (cond.kind === 'null-check' && !cond.negated) return;  // IS NULL is the anti-join idiom, intentional

    const join = outerAliases.get(tbl.toLowerCase());
    cases.push(baseCase({
      group: `JOIN · ${join.leftLabel} ⋈ ${join.rightLabel}`,
      target: columnLabel(cond),
      condition: cond.sql,
      title: t('st.outerCancelled', { right: join.rightLabel, type: join.joinType }),
      data: t('st.orphanData', { left: join.leftLabel, right: join.rightLabel }),
      expected: t('st.outerCancelledExp', { cond: cond.sql }),
      priority: 'High',
      notes: t('st.outerCancelledNote', { left: join.leftLabel }),
      ...caseSourceFromCondition(cond)
    }));
  });

  return cases;
}

/** GROUP BY / HAVING result-shape cases. */
function groupingCases(model) {
  const cases = [];
  const g = model.grouping;
  const keys = g.groupBy.map(x => x.sql).join(', ');

  // Every case below is about the grouping shape as a whole rather than one
  // column, so it is tagged against every GROUP BY key (or every aggregate,
  // when there is no GROUP BY at all) rather than picking just one.
  const groupBySource = g.groupBy.length
    ? { sourceIds: g.groupBy.map(groupByKey), clause: 'GROUP_BY', columns: g.groupBy.map(x => x.column).filter(Boolean) }
    : { sourceIds: g.aggregates.map(aggregateKey), clause: 'GROUP_BY', columns: g.aggregates.map(a => a.column).filter(Boolean) };

  const add = (title, data, expected, extra = {}) => cases.push(baseCase({
    group: keys ? `GROUP BY · ${keys}` : t('grp.aggregation'), target: keys || t('grp.aggregate'), condition: keys ? `GROUP BY ${keys}` : t('st.aggNoGroupCond'), title, data, expected,
    ...groupBySource, ...extra
  }));

  if (g.groupBy.length) {
    add(t('st.emptyTable'), t('st.noRowsMatch'), t('st.zeroGroups'), { priority: 'High' });
    add(t('st.oneGroupOneRow'), t('st.oneRowMatches'), t('st.oneGroupOneRowExp'), { priority: 'High' });
    add(t('st.oneGroupManyRows'), t('st.fourSameKey'), t('st.oneGroupManyRowsExp'), { priority: 'High' });
    add(t('st.severalGroups'), t('st.threeKeys'), t('st.severalGroupsExp'), { priority: 'High' });

    // Selecting a column that is neither grouped nor aggregated.
    const grouped = new Set(g.groupBy.map(x => (x.column?.raw || x.sql).toLowerCase()));
    const ungrouped = model.columns.filter(c => !grouped.has(c.raw.toLowerCase()));
    if (ungrouped.length && g.aggregates.length) {
      add(
        t('st.ungrouped'),
        t('st.ungroupedData', { cols: ungrouped.slice(0, 2).map(c => c.raw).join(', ') }),
        t('st.ungroupedExp'),
        { priority: 'Medium', notes: t('st.ungroupedNote') }
      );
    }
  } else if (g.aggregates.length) {
    add(
      t('st.aggNoGroup'),
      t('st.noRowsMatch'),
      t('st.aggNoGroupExp', { aggs: g.aggregates.filter(a => a.name !== 'COUNT').map(a => a.name).join('/') || 'SUM/AVG/MIN/MAX' }),
      { priority: 'High', notes: t('st.aggNoGroupNote') }
    );
  }

  if (g.having) {
    add(
      t('st.havingEmpty'),
      t('st.havingEmptyData'),
      t('st.havingEmptyExp'),
      {
        priority: 'High', notes: `HAVING: ${g.having}`,
        // Overrides groupBySource: this case is about HAVING filtering every
        // group away, not the GROUP BY key itself.
        sourceIds: model.havingConditions.map(c => c.id),
        clause: 'HAVING',
        columns: model.havingConditions.map(c => c.column).filter(Boolean)
      }
    );
  }

  if (g.distinct) {
    cases.push(baseCase({
      group: 'DISTINCT',
      target: 'SELECT DISTINCT',
      condition: 'SELECT DISTINCT …',
      title: t('st.distinctDupes'),
      data: t('st.distinctDupesData'),
      expected: t('st.distinctDupesExp'),
      priority: 'Medium'
    }));
  }

  return cases;
}

/** ORDER BY / LIMIT / OFFSET cases. */
function pagingCases(model) {
  const cases = [];
  const { orderBy, limit, offset } = model.paging;

  const add = (group, title, data, expected, extra = {}) => cases.push(baseCase({
    group, target: group, condition: '', title, data, expected, ...extra
  }));
  // LIMIT and OFFSET have no condition/column to key on the way a predicate
  // does — 'LIMIT'/'OFFSET' are the same synthetic ids diff.js's paging
  // section is checked against in generate.js's change-impact match.
  const LIMIT_SOURCE = { sourceIds: ['LIMIT'], clause: 'LIMIT_OFFSET', columns: [] };
  const OFFSET_SOURCE = { sourceIds: ['OFFSET'], clause: 'LIMIT_OFFSET', columns: [] };

  orderBy.forEach(o => {
    const source = caseSourceFromOrderBy(o);
    add(
      `ORDER BY · ${o.sql}`,
      t('st.ties', { key: o.sql }),
      t('st.tiesData', { key: o.sql }),
      orderBy.length > 1 || model.paging.orderBy.some(x => x.sql !== o.sql)
        ? t('st.tiesDeterministic')
        : t('st.tiesUnstable'),
      { priority: orderBy.length > 1 ? 'Low' : 'High', ...source }
    );
    add(
      `ORDER BY · ${o.sql}`,
      t('st.sortDir', { dir: o.dir }),
      t('st.sortDirData', { key: o.sql }),
      t(o.dir === 'DESC' ? 'st.sortedDesc' : 'st.sortedAsc', { key: o.sql }),
      { priority: 'Medium', ...source }
    );
  });

  if (limit) {
    const group = 'LIMIT / OFFSET';
    const n = limit.kind === 'literal' ? limit.value : null;
    const nText = n ?? limit.sql;

    if (!orderBy.length) {
      add(group, t('st.limitNoOrder'), t('st.limitNoOrderData'),
        t('st.limitNoOrderExp'),
        { priority: 'High', notes: t('st.limitNoOrderNote'), ...LIMIT_SOURCE });
    }

    add(group, t('st.fewerThanLimit'), t('st.matchingRows', { n: n ? Math.max(1, n - 1) : t('st.limitMinus1') }),
      t('st.fewerThanLimitExp', { n: n ? n - 1 : t('st.available') }), { priority: 'High', ...LIMIT_SOURCE });
    add(group, t('st.exactlyLimit'), t('st.matchingRows', { n: nText }),
      t('st.exactlyLimitExp', { n: nText }), { priority: 'High', ...LIMIT_SOURCE });
    add(group, t('st.moreThanLimit'), t('st.matchingRows', { n: n ? n + 5 : t('st.limitPlus5') }),
      t('st.moreThanLimitExp', { n: nText }), { priority: 'High', ...LIMIT_SOURCE });
    add(group, t('st.noRowsAtAll'), t('st.zeroMatchingRows'),
      t('st.emptyNotError'), { priority: 'Medium', ...LIMIT_SOURCE });

    if (limit.kind === 'param') {
      add(group, t('st.limitParam', { param: limit.sql }), t('st.limitParamData', { param: limit.sql }),
        t('st.limitParamExp'),
        { priority: 'High', notes: t('st.limitParamNote'), ...LIMIT_SOURCE });
    }
  }

  if (offset) {
    const group = 'LIMIT / OFFSET';
    const o = offset.kind === 'literal' ? offset.value : null;
    add(group, t('st.offsetBeyond'), t('st.fewerThan', { n: o ?? offset.sql }),
      t('st.emptyNotError'), { priority: 'High', ...OFFSET_SOURCE });
    add(group, t('st.firstPage'), t('st.firstPageData'),
      t('st.firstPageExp'), { priority: 'Medium', ...OFFSET_SOURCE });
    add(group, t('st.pageContinuity'), t('st.pageContinuityData'),
      t('st.pageContinuityExp'), { priority: 'High', ...OFFSET_SOURCE });
    add(group, t('st.pageDrift'), t('st.pageDriftData'),
      t('st.pageDriftExp'),
      { priority: 'Medium', ...OFFSET_SOURCE });
  }

  return cases;
}

/** UNION / INTERSECT / EXCEPT branches. */
function setOpCases(model) {
  if (!model.setop) return [];
  const { op, all } = model.setop;
  const group = `${op}${all ? ' ALL' : ''}`;
  return [
    baseCase({
      group, target: group, condition: group,
      title: t('st.setopDupes', { op }),
      data: t('st.setopDupesData'),
      expected: all ? t('st.setopAll') : t('st.setopDedup', { op }),
      priority: 'High'
    }),
    baseCase({
      group, target: group, condition: group,
      title: t('st.setopEmptyBranch'),
      data: t('st.setopEmptyBranchData'),
      expected: t(op === 'INTERSECT' ? 'st.setopEmptyResult' : 'st.setopFirstBranch'),
      priority: 'Medium'
    }),
    baseCase({
      group, target: group, condition: group,
      title: t('st.setopColumns'),
      data: t('st.setopColumnsData'),
      expected: t('st.setopColumnsExp'),
      priority: 'Medium'
    })
  ];
}

/** DML statements missing a WHERE clause. */
function dmlScopeCases(model) {
  const w = model.writes;
  if (!w || w.kind === 'insert') return [];
  const cases = [];
  // Whether the DML touches too much or too little data is a question about
  // the WHERE clause as a whole — so a change to any WHERE condition (added,
  // removed, or its value/operator changed) makes these cases worth a look.
  const whereSource = { sourceIds: model.conditions.map(c => c.id), clause: 'WHERE', columns: [] };

  if (!w.hasWhere) {
    cases.push(baseCase({
      group: `${w.kind.toUpperCase()} · ${w.table}`,
      target: w.table,
      condition: t('st.dmlNoWhereCond', { kind: w.kind.toUpperCase() }),
      title: t('st.dmlNoWhere', { kind: w.kind.toUpperCase() }),
      data: t('st.dmlNoWhereData', { table: w.table }),
      expected: t(w.kind === 'update' ? 'st.dmlAllUpdated' : 'st.dmlAllDeleted'),
      priority: 'High',
      notes: t('st.dmlNoWhereNote'),
      ...whereSource
    }));
  } else {
    cases.push(baseCase({
      group: `${w.kind.toUpperCase()} · ${w.table}`,
      target: w.table,
      condition: `${w.kind.toUpperCase()} … WHERE …`,
      title: t('st.dmlNoMatch'),
      data: t('st.dmlNoMatchData'),
      expected: t('st.dmlNoMatchExp'),
      priority: 'High',
      ...whereSource
    }));
    cases.push(baseCase({
      group: `${w.kind.toUpperCase()} · ${w.table}`,
      target: w.table,
      condition: `${w.kind.toUpperCase()} … WHERE …`,
      title: t('st.dmlTooMany'),
      data: t('st.dmlTooManyData'),
      expected: t(w.kind === 'update' ? 'st.dmlTooManyUpdated' : 'st.dmlTooManyDeleted'),
      priority: 'High',
      ...whereSource
    }));
  }

  if (w.kind === 'update') {
    cases.push(baseCase({
      group: `UPDATE · ${w.table}`,
      target: w.table,
      condition: t('st.idempotency'),
      title: t('st.runTwice'),
      data: t('st.runTwiceData'),
      expected: w.columns.some(c => c.selfReferential)
        ? t('st.runTwiceNotIdempotent')
        : t('st.runTwiceIdempotent'),
      priority: w.columns.some(c => c.selfReferential) ? 'High' : 'Medium',
      sourceIds: w.columns.filter(c => c.selfReferential).map(writeKey),
      clause: 'SET'
    }));
    if (w.columns.some(c => c.selfReferential)) {
      cases.push(baseCase({
        group: `UPDATE · ${w.table}`,
        target: w.table,
        condition: t('st.concurrency'),
        title: t('st.concurrentUpdate'),
        data: t('st.concurrentUpdateData'),
        expected: t('st.concurrentUpdateExp'),
        priority: 'Medium',
        notes: t('st.concurrentUpdateNote'),
        sourceIds: w.columns.filter(c => c.selfReferential).map(writeKey),
        clause: 'SET'
      }));
    }
  }

  return cases;
}

/**
 * The checks every query deserves regardless of what it contains.
 *
 * A query with no WHERE, no join and no grouping still has testable behaviour —
 * it must survive an empty table, and `SELECT *` still couples the caller to
 * the table's column order. Without these a simple query generates nothing at
 * all, which reads as "nothing to test" rather than "not much to test".
 */
function baselineCases(model, hasStar) {
  if (model.statement !== 'select') return [];
  const table = model.tables[0]?.label || 'the source table';
  const cases = [];

  if (!model.grouping.groupBy.length && !model.grouping.aggregates.length) {
    cases.push(baseCase({
      group: t('grp.resultSet'),
      target: table,
      condition: '',
      title: t('st.emptyTable'),
      data: t('st.emptyTableData', { table }),
      expected: t('st.emptyTableExp'),
      priority: 'Medium'
    }));
  }

  if (hasStar) {
    cases.push(baseCase({
      group: t('grp.resultSet'),
      target: 'SELECT *',
      condition: 'SELECT *',
      title: t('st.selectStar'),
      data: t('st.selectStarData'),
      expected: t('st.selectStarExp'),
      priority: 'Medium',
      notes: t('st.selectStarNote')
    }));
  }

  model.subqueries.forEach(sq => {
    if (sq.kind !== 'cte') return;
    cases.push(baseCase({
      group: `CTE · ${sq.name}`,
      target: sq.name,
      condition: `WITH ${sq.name} AS (…)`,
      title: t('st.cteEmpty', { name: sq.name }),
      data: t('st.cteEmptyData', { name: sq.name }),
      expected: t('st.cteEmptyExp'),
      priority: 'Medium',
      notes: t('st.cteEmptyNote')
    }));
  });

  return cases;
}

/**
 * @param {object} model — from analyze()
 * @returns {Array} cases
 */
export function generateStructure(model) {
  return [
    ...baselineCases(model, model.selectsStar),
    ...joinCases(model),
    ...outerJoinFilterCases(model),
    ...groupingCases(model),
    ...pagingCases(model),
    ...setOpCases(model),
    ...dmlScopeCases(model)
  ];
}
