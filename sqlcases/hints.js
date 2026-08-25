/**
 * hints.js — Resolving one condition to a concrete value.
 *
 * Two callers need the same answer in two shapes. The technique modules need a
 * sentence ("to get rule 5, set age to something that fails the range"), while
 * the fixture generator needs the value itself so it can put it in a data row.
 *
 * So `resolve()` does the thinking once and returns structure; `satisfy()` and
 * `violate()` are thin wrappers that turn that structure into prose. Deriving
 * the fixture from `resolve()` rather than from the sentence matters: the
 * sentence is translated, and parsing it back would break the moment the page
 * is switched to Vietnamese.
 */

import { shift, midpoint, notEqualTo, outsideList, likeExamples, columnLabel } from './values.js';
import { columnSample } from './valuebook.js';
import { t } from './i18n.js';

/**
 * Work out what `cond` needs in order to evaluate to `wantTrue`.
 *
 * @param {object} cond — a condition record from analyze()
 * @param {boolean} wantTrue — TRUE, or FALSE (never UNKNOWN; see unknownize)
 * @returns {{col: string, column: object|null, valueSql: string|null,
 *            kind: 'value'|'subquery'|'opaque', messageKey?: string, params?: object}}
 *   `kind: 'value'` means valueSql is usable as a data value. `'subquery'` means
 *   the requirement is about rows existing elsewhere, not a column on this row.
 *   `'opaque'` means the predicate is one this tool does not model well enough
 *   to pin a value on — the caller should fall back to describing it.
 */
export function resolve(cond, wantTrue) {
  const col = columnLabel(cond);
  const type = cond.dataType.type;
  const column = cond.column;
  const v = cond.values[0];
  const value = (valueSql) => ({ col, column, valueSql, kind: 'value' });
  const opaque = (messageKey, params) => ({ col, column, valueSql: null, kind: 'opaque', messageKey, params });

  switch (cond.kind) {
    case 'comparison': {
      if (!v) return opaque(wantTrue ? 'hint.satisfying' : 'hint.failing', { col, cond: cond.sql });
      if (cond.columnToColumn) {
        return opaque(wantTrue ? 'hint.holds' : 'hint.notHolds', { expr: `${col} ${cond.operator} ${v.sql}` });
      }
      // Each operator has a value that passes and one that fails; `wantTrue`
      // picks the side, and the two sides are mirror images of each other.
      switch (cond.operator) {
        case '=': case '<=>': return value(wantTrue ? v.sql : notEqualTo(v, type).sql);
        case '!=': case '<>': return value(wantTrue ? notEqualTo(v, type).sql : v.sql);
        case '>':  return value(wantTrue ? shift(v, type, 1).sql : v.sql);
        case '>=': return value(wantTrue ? v.sql : shift(v, type, -1).sql);
        case '<':  return value(wantTrue ? shift(v, type, -1).sql : v.sql);
        case '<=': return value(wantTrue ? v.sql : shift(v, type, 1).sql);
        default:   return opaque(wantTrue ? 'hint.satisfiesOp' : 'hint.failsOp', { col, op: cond.operator, value: v.sql });
      }
    }

    case 'between': {
      const [lo, hi] = cond.values;
      if (!lo || !hi) return opaque(wantTrue ? 'hint.insideRange' : 'hint.outsideRange', { col });
      // NOT BETWEEN inverts which side of the range counts as passing.
      const inside = wantTrue !== !!cond.negated;
      return value(inside ? midpoint(lo, hi, type).sql : shift(hi, type, 1).sql);
    }

    case 'in-list': {
      const m = cond.values[0];
      if (!m) return opaque(wantTrue ? 'hint.inList' : 'hint.outsideList', { col });
      const inList = wantTrue !== !!cond.negated;
      return value(inList ? m.sql : outsideList(cond.values, type).sql);
    }

    case 'like': {
      const p = cond.values[0];
      const ex = likeExamples(p?.kind === 'literal' ? p.value : null);
      const matches = wantTrue !== !!cond.negated;
      if (matches) return value(`'${ex.match}'`);
      // A non-matching example is only a concrete string when the pattern had
      // literal text to work from; otherwise it is a description.
      return value(ex.core ? ex.noMatch : `'${ex.noMatch}'`);
    }

    case 'null-check': {
      const isNull = wantTrue !== !!cond.negated;
      return value(isNull ? 'NULL' : nonNullValue(cond));
    }

    case 'boolean-column':
      return value(wantTrue ? 'TRUE' : 'FALSE');

    case 'exists':
    case 'in-subquery': {
      const wantRows = wantTrue !== !!cond.negated;
      return {
        col, column, valueSql: null, kind: 'subquery', wantRows,
        messageKey: wantRows ? 'hint.subqueryMatches' : 'hint.subqueryEmpty'
      };
    }

    default:
      return opaque(wantTrue ? 'hint.holds' : 'hint.notHolds', { expr: cond.sql });
  }
}

/**
 * A concrete value that is definitely not NULL.
 *
 * "Any non-NULL value" is exactly the question the value book answers, so a
 * sample for the column replaces the placeholder — and every case that asks
 * for a non-NULL value gets the same one, which is what makes the fixture and
 * the case description agree.
 */
export function nonNullValue(cond) {
  const sample = cond.column &&
    columnSample(cond.column.table, cond.column.name, cond.dataType?.type);
  return sample ? sample.sql : t('val.anyNonNull');
}

/** Render a resolution as the sentence shown in a case's "test data" column. */
function describe(r) {
  if (r.kind === 'value') return `${r.col} = ${r.valueSql}`;
  return t(r.messageKey, r.params);
}

/** A value that makes `cond` evaluate TRUE. */
export function satisfy(cond) {
  return describe(resolve(cond, true));
}

/** A value that makes `cond` evaluate FALSE (not UNKNOWN). */
export function violate(cond) {
  return describe(resolve(cond, false));
}

/**
 * A value that makes `cond` evaluate UNKNOWN rather than FALSE — only possible
 * where a NULL operand can reach the comparison. IS NULL never returns UNKNOWN.
 */
export function unknownize(cond) {
  if (cond.kind === 'null-check') return null;
  const col = columnLabel(cond);
  if (!cond.column) return null;
  return `${col} = NULL`;
}
