/**
 * ep-bva.js — Equivalence Partitioning and Boundary Value Analysis.
 *
 * EP splits each predicate's input domain into classes that the query treats
 * identically and takes one representative per class. BVA then adds the values
 * where off-by-one defects actually live: the boundary itself and its two
 * neighbours. Both run over the same condition list, so a query with
 * `age BETWEEN 18 AND 65` gets three partitions from EP and six edge values
 * from BVA rather than one generic "check the age filter" case.
 *
 * BVA only fires for types that sit on a scale. For a string column the
 * boundary is a length or collation question, so the case says so instead of
 * inventing `'abc' - 1`.
 */

import { isOrdered, shift, midpoint, notEqualTo, outsideList, likeExamples, stepLabel, columnLabel } from '../values.js';
import { nonNullValue } from '../hints.js';
import { t } from '../i18n.js';

/** Whether a row satisfying the partition is expected in or out of the result. */
const IN = 'out.rowIn';
const OUT = 'out.rowOut';

function groupOf(cond) {
  return `${cond.source} · ${columnLabel(cond)}`;
}

/** One EP/BVA case. */
function makeCase(technique, cond, fields) {
  return {
    technique,
    group: groupOf(cond),
    target: columnLabel(cond),
    condition: cond.sql,
    priority: 'Medium',
    notes: '',
    ...fields
  };
}

/** Expected outcome text, phrased for the statement kind being tested. */
function outcomeFor(kind, matches) {
  if (kind === 'update') return t(matches ? 'out.rowUpdated' : 'out.rowNotUpdated');
  if (kind === 'delete') return t(matches ? 'out.rowDeleted' : 'out.rowNotDeleted');
  if (kind === 'having') return t(matches ? 'out.groupKept' : 'out.groupFiltered');
  return t(matches ? IN : OUT);
}

/**
 * Generate EP cases for one condition.
 * @returns {Array} cases
 */
function partitionsFor(cond, kind) {
  const col = columnLabel(cond);
  const type = cond.dataType.type;
  const cases = [];
  const val = cond.values[0];

  const add = (title, data, matches, extra = {}) => cases.push(makeCase('EP', cond, {
    title, data, expected: outcomeFor(kind, matches), ...extra
  }));

  /**
   * The common form: this case pins `col` to one value. Recording the value in
   * `spec` as well as in the prose is what lets the fixture generator build a
   * data row without parsing a translated sentence back apart.
   */
  const addVal = (title, valueSql, matches, extra = {}) => cases.push(makeCase('EP', cond, {
    title,
    data: `${col} = ${valueSql}`,
    expected: outcomeFor(kind, matches),
    spec: { set: [{ column: cond.column, columnRaw: col, valueSql }] },
    ...extra
  }));

  switch (cond.kind) {
    case 'comparison': {
      if (cond.columnToColumn) {
        const right = cond.values[0]?.sql || '?';
        add(t('ep.c2c.greater', { col, right }), `${col} > ${right}`, ['>', '>=', '!=', '<>'].includes(cond.operator), { priority: 'High' });
        add(t('ep.c2c.equal', { col, right }), `${col} = ${right}`, ['>=', '<=', '=', '<=>'].includes(cond.operator), { priority: 'High' });
        add(t('ep.c2c.less', { col, right }), `${col} < ${right}`, ['<', '<=', '!=', '<>'].includes(cond.operator), { priority: 'Medium' });
        return cases;
      }
      if (!val) return cases;

      switch (cond.operator) {
        case '=':
        case '<=>': {
          const other = notEqualTo(val, type);
          addVal(t('ep.eq.match', { col }), `${val.sql}`, true, { priority: 'High' });
          addVal(t('ep.eq.differ', { col }), `${other.sql}`, false,
            { priority: 'High', notes: other.exact ? '' : t('ep.eq.pickOther') });
          break;
        }
        case '!=':
        case '<>': {
          const other = notEqualTo(val, type);
          addVal(t('ep.ne.differ', { col }), `${other.sql}`, true, { priority: 'High' });
          addVal(t('ep.ne.equal', { col }), `${val.sql}`, false, { priority: 'High' });
          break;
        }
        case '>':
        case '>=': {
          const above = shift(val, type, 1);
          const below = shift(val, type, -1);
          addVal(t('ep.above', { col }), `${above.sql}`, true, { priority: 'High' });
          addVal(t('ep.at', { col }), `${val.sql}`, cond.operator === '>=', { priority: 'High' });
          addVal(t('ep.below', { col }), `${below.sql}`, false, { priority: 'High' });
          break;
        }
        case '<':
        case '<=': {
          const above = shift(val, type, 1);
          const below = shift(val, type, -1);
          addVal(t('ep.below', { col }), `${below.sql}`, true, { priority: 'High' });
          addVal(t('ep.at', { col }), `${val.sql}`, cond.operator === '<=', { priority: 'High' });
          addVal(t('ep.above', { col }), `${above.sql}`, false, { priority: 'High' });
          break;
        }
        default:
          break;
      }
      break;
    }

    case 'between': {
      const [low, high] = cond.values;
      if (!low || !high) break;
      const inside = midpoint(low, high, type);
      const belowLow = shift(low, type, -1);
      const aboveHigh = shift(high, type, 1);
      const inRange = !cond.negated;
      addVal(t('ep.range.inside', { col }), `${inside.sql}`, inRange, { priority: 'High' });
      addVal(t('ep.range.below', { col }), `${belowLow.sql}`, !inRange, { priority: 'High' });
      addVal(t('ep.range.above', { col }), `${aboveHigh.sql}`, !inRange, { priority: 'High' });
      if (low.kind === 'literal' && high.kind === 'literal' &&
          typeof low.value === 'number' && typeof high.value === 'number' && low.value > high.value) {
        cases.push(makeCase('EP', cond, {
          title: t('ep.range.inverted', { low: low.sql, high: high.sql }),
          data: t('ep.anyValue'),
          expected: t('ep.range.invertedExp'),
          priority: 'High',
          notes: t('ep.range.invertedNote')
        }));
      }
      break;
    }

    case 'in-list': {
      const members = cond.values.filter(v => v.kind === 'literal' || v.kind === 'param');
      if (!members.length) break;
      // One representative per listed value is the strict EP reading; for long
      // lists the first and last carry the same information at a fraction of
      // the cost, so cap it and say what was skipped.
      const CAP = 6;
      const picked = members.length > CAP ? [members[0], members[members.length - 1]] : members;
      picked.forEach(m => addVal(
        t('ep.list.member', { col, value: m.sql }),
        `${m.sql}`,
        !cond.negated,
        { priority: 'High', notes: members.length > CAP ? t('ep.list.sampled', { n: members.length }) : '' }
      ));
      const outsider = outsideList(members, type);
      addVal(t('ep.list.outside', { col }), `${outsider.sql}`, !!cond.negated,
        { priority: 'High', notes: outsider.exact ? '' : t('ep.list.anyAbsent') });
      if (cond.values.some(v => v.kind === 'literal' && v.value === null)) {
        cases.push(makeCase('EP', cond, {
          title: t('ep.list.hasNull', { col }),
          data: t('ep.anyValue'),
          expected: t(cond.negated ? 'ep.list.hasNullNotIn' : 'ep.list.hasNullIn'),
          priority: 'High',
          notes: t('ep.list.hasNullNote')
        }));
      }
      break;
    }

    case 'like': {
      const pat = cond.values[0];
      const ex = likeExamples(pat?.kind === 'literal' ? pat.value : null);
      const matches = !cond.negated;
      addVal(t('ep.like.match', { col }), `'${ex.match}'`, matches, { priority: 'High' });
      addVal(t('ep.like.noMatch', { col }), `${ex.core ? ex.noMatch : `'${ex.noMatch}'`}`, !matches, { priority: 'High' });
      if (ex.anchored === 'prefix' && ex.core) {
        addVal(t('ep.like.notAtStart', { col }), `'zz${ex.core}'`, !matches,
          { priority: 'High', notes: t('ep.like.prefixNote', { core: ex.core }) });
      }
      if (ex.anchored === 'suffix' && ex.core) {
        addVal(t('ep.like.notAtEnd', { col }), `'${ex.core}zz'`, !matches,
          { priority: 'High', notes: t('ep.like.suffixNote') });
      }
      if (ex.core) {
        cases.push(makeCase('EP', cond, {
          title: t('ep.like.caseOnly', { col }),
          data: `${col} = '${String(ex.match).toUpperCase()}'`,
          expected: cond.ci
            ? t('ep.like.ilikeCi', { outcome: outcomeFor(kind, matches) })
            : t('ep.like.collation'),
          priority: 'Medium',
          notes: cond.ci ? '' : t('ep.like.collationNote')
        }));
        cases.push(makeCase('EP', cond, {
          title: t('ep.like.wildcardLiteral', { col }),
          data: `${col} = '100%_off'`,
          expected: t('ep.like.wildcardExp'),
          priority: 'Medium',
          notes: cond.values[0]?.kind === 'param' ? t('ep.like.wildcardParam') : ''
        }));
      }
      break;
    }

    case 'boolean-column': {
      addVal(t('ep.bool.true', { col }), `TRUE`, true, { priority: 'High' });
      addVal(t('ep.bool.false', { col }), `FALSE`, false, { priority: 'High' });
      break;
    }

    case 'null-check': {
      const wantNull = !cond.negated;
      addVal(t('ep.null.isNull', { col }), `NULL`, wantNull, { priority: 'High' });
      addVal(t('ep.null.hasValue', { col }), nonNullValue(cond), !wantNull, { priority: 'High' });
      break;
    }

    case 'exists':
    case 'in-subquery':
    case 'quantified': {
      const positive = !cond.negated;
      add(t('ep.sub.some'), t('ep.sub.someData'), positive, { priority: 'High' });
      add(t('ep.sub.none'), t('ep.sub.noneData'), !positive, { priority: 'High' });
      break;
    }

    default:
      break;
  }
  return cases;
}

/** Generate BVA cases for one condition. */
function boundariesFor(cond, kind) {
  const col = columnLabel(cond);
  const type = cond.dataType.type;
  const cases = [];

  if (!['comparison', 'between'].includes(cond.kind)) return cases;
  if (cond.columnToColumn) return cases;

  const ordered = isOrdered(type);
  const unit = stepLabel(type);

  const add = (title, data, matches, extra = {}) => cases.push(makeCase('BVA', cond, {
    title, data, expected: outcomeFor(kind, matches), priority: 'High', ...extra
  }));

  const addVal = (title, valueSql, matches, extra = {}) => cases.push(makeCase('BVA', cond, {
    title,
    data: `${col} = ${valueSql}`,
    expected: outcomeFor(kind, matches),
    priority: 'High',
    spec: { set: [{ column: cond.column, columnRaw: col, valueSql }] },
    ...extra
  }));

  /** Emit the -1 / on / +1 triple around one boundary value. */
  const triple = (operand, label, at, below, above) => {
    const lo = shift(operand, type, -1);
    const hi = shift(operand, type, 1);
    const note = lo.exact ? '' : (lo.note || t('bva.stepSize', { unit }));
    addVal(t('bva.justBelow', { col, value: lo.sql, label, unit }), `${lo.sql}`, below, { notes: note });
    addVal(t('bva.exactlyOn', { col, value: operand.sql, label }), `${operand.sql}`, at);
    addVal(t('bva.justAbove', { col, value: hi.sql, label, unit }), `${hi.sql}`, above, { notes: note });
  };

  if (!ordered) {
    // No arithmetic neighbour exists — record the boundary questions that do apply.
    if (type === 'string' || type === 'email' || type === 'unknown') {
      const v = cond.values[0];
      if (v) {
        cases.push(makeCase('BVA', cond, {
          title: t('bva.stringEdges', { col, value: v.sql }),
          data: t('bva.stringEdgesData', { col }),
          expected: t('bva.stringEdgesExp'),
          priority: 'Medium',
          notes: t('bva.stringEdgesNote', { type, confidence: cond.dataType.confidence })
        }));
      }
    }
    return cases;
  }

  if (cond.kind === 'between') {
    const [low, high] = cond.values;
    if (!low || !high) return cases;
    const inRange = !cond.negated;
    triple(low, t('bva.lowerBound'), inRange, !inRange, inRange);
    triple(high, t('bva.upperBound'), inRange, inRange, !inRange);
    return cases;
  }

  const val = cond.values[0];
  if (!val) return cases;
  switch (cond.operator) {
    case '>':  triple(val, t('bva.threshold'), false, false, true); break;
    case '>=': triple(val, t('bva.threshold'), true, false, true); break;
    case '<':  triple(val, t('bva.threshold'), false, true, false); break;
    case '<=': triple(val, t('bva.threshold'), true, true, false); break;
    case '=':
    case '<=>': triple(val, t('bva.targetValue'), true, false, false); break;
    case '!=':
    case '<>': triple(val, t('bva.excludedValue'), false, true, true); break;
    default: break;
  }
  return cases;
}

/**
 * @param {object} model — from analyze()
 * @param {object} options — { includeJoinConditions: boolean }
 * @returns {Array} generated cases
 */
export function generateEpBva(model, options = {}) {
  const cases = [];
  const kind = model.statement === 'select' ? 'select' : model.statement;

  const runOver = (conds, k) => {
    conds.forEach(cond => {
      cases.push(...partitionsFor(cond, k));
      cases.push(...boundariesFor(cond, k));
    });
  };

  runOver(model.conditions, kind);
  runOver(model.havingConditions, 'having');
  if (options.includeJoinConditions !== false) {
    // ON predicates that are not plain key equality carry real filtering logic.
    const filtering = model.joinConditions.filter(c => !c.columnToColumn);
    runOver(filtering, kind);
  }
  return cases;
}
