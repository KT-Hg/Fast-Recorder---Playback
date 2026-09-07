/**
 * values.js — Value arithmetic shared by the technique modules.
 *
 * Boundary analysis needs to answer "what is one step below this value?" for
 * whatever the column holds. The step differs per type — 1 for an integer,
 * 0.01 for money, a day for a date, a second for a timestamp — and for strings
 * there is no arithmetic at all, so the boundary becomes a length boundary
 * instead. Everything that has to know those rules lives here.
 */

import { t } from './i18n.js';

/**
 * Smallest meaningful increment for a type. The label is a message key rather
 * than text: the step is written into every boundary case title, so it has to
 * resolve in whichever language is active when generation runs.
 */
export const STEPS = {
  integer:  { delta: 1,    label: 'val.step.one' },
  decimal:  { delta: 0.01, label: 'val.step.hundredth' },
  date:     { delta: 1,    label: 'val.step.day' },
  datetime: { delta: 1,    label: 'val.step.second' },
  time:     { delta: 1,    label: 'val.step.second' },
  boolean:  { delta: null, label: 'val.step.none' },
  string:   { delta: null, label: 'val.step.char' },
  email:    { delta: null, label: 'val.step.char' },
  unknown:  { delta: null, label: 'val.step.smallest' }
};

/** True when the type sits on a scale we can step along. */
export function isOrdered(type) {
  return ['integer', 'decimal', 'date', 'datetime', 'time'].includes(type);
}

export function stepLabel(type) {
  return t((STEPS[type] || STEPS.unknown).label);
}

function pad(n, width = 2) { return String(n).padStart(width, '0'); }

/** Parse an SQL date/datetime literal into parts we can shift. */
function parseTemporal(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(raw));
  if (!m) return null;
  const hasTime = m[4] !== undefined;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
  return Number.isNaN(d.getTime()) ? null : { date: d, hasTime, hasSeconds: m[6] !== undefined };
}

function formatTemporal(d, hasTime, hasSeconds) {
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (!hasTime) return day;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${hasSeconds ? ':' + pad(d.getUTCSeconds()) : ''}`;
  return `${day} ${time}`;
}

/** Round away binary float noise: 0.1 + 0.01 must read as 0.11, not 0.11000000000000001. */
function tidyNumber(n, reference) {
  const decimals = Math.max(
    (String(reference).split('.')[1] || '').length,
    2
  );
  const rounded = Number(n.toFixed(Math.min(decimals, 10)));
  return Number.isInteger(rounded) ? rounded : rounded;
}

/**
 * Shift a comparison value by `steps` smallest units.
 *
 * @param {{kind:string, value?:*, sql:string}} operand — from analyze.describeOperand
 * @param {string} type — inferred data type
 * @param {number} steps — e.g. -1, 0, +1
 * @returns {{sql: string, exact: boolean, note: string, unitLabel: string}} —
 *   `exact:false` means we could not compute it and the string is a human
 *   instruction instead. `unitLabel` is what was actually used for the step,
 *   for a caller that renders it next to `sql` (e.g. BVA's case title) —
 *   reading it back here instead of recomputing `stepLabel(type)` is what
 *   keeps the two from disagreeing.
 */
export function shift(operand, type, steps) {
  const unit = stepLabel(type);
  if (steps === 0) return { sql: operand.sql, exact: operand.kind === 'literal', note: '', unitLabel: unit };

  const mag = Math.abs(steps);

  if (operand.kind !== 'literal') {
    // The base itself is symbolic (an unbound bind parameter), so a computed
    // magnitude like "0.01" or "1" would claim precision the query text never
    // gave us — the real step is a business decision, not something the
    // tokenizer can read off `@amount`. Name the step instead of guessing a
    // number for integer/decimal; date/datetime/time keep their calendar or
    // clock unit, which is not a guess the way a decimal's precision is.
    const relUnit = (type === 'integer' || type === 'decimal') ? t('val.step.smallest') : unit;
    return {
      sql: `${operand.sql} ${steps < 0 ? '-' : '+'} ${mag} ${relUnit === t('val.step.none') ? t('val.unit') : relUnit}`,
      exact: false,
      note: t('val.relativeTo', { expr: operand.sql }),
      unitLabel: relUnit
    };
  }

  if (type === 'integer' && typeof operand.value === 'number') {
    return { sql: String(operand.value + steps), exact: true, note: '', unitLabel: unit };
  }

  if (type === 'decimal' && typeof operand.value === 'number') {
    const raw = String(operand.value);
    const decimals = (raw.split('.')[1] || '').length;
    const delta = decimals > 0 ? Math.pow(10, -decimals) : STEPS.decimal.delta;
    return { sql: String(tidyNumber(operand.value + delta * steps, raw)), exact: true, note: '', unitLabel: unit };
  }

  if (type === 'date' || type === 'datetime') {
    const parsed = parseTemporal(operand.value);
    if (parsed) {
      const ms = parsed.hasTime ? 1000 : 86400000;
      const shifted = new Date(parsed.date.getTime() + steps * ms);
      return { sql: `'${formatTemporal(shifted, parsed.hasTime, parsed.hasSeconds)}'`, exact: true, note: '', unitLabel: unit };
    }
  }

  if (type === 'string' || type === 'email' || type === 'unknown') {
    return {
      sql: t(steps < 0 ? 'val.adjacentBelow' : 'val.adjacentAbove', { value: operand.sql }),
      exact: false,
      note: t('val.noNumericNeighbour'),
      unitLabel: unit
    };
  }

  return { sql: `${operand.sql} ${steps < 0 ? '−' : '+'} ${mag} ${unit}`, exact: false, note: '', unitLabel: unit };
}

/** A plausible value that is clearly inside a range (not on its edge). */
export function midpoint(low, high, type) {
  if (low.kind === 'literal' && high.kind === 'literal') {
    if ((type === 'integer' || type === 'decimal') && typeof low.value === 'number' && typeof high.value === 'number') {
      const mid = (low.value + high.value) / 2;
      return { sql: String(type === 'integer' ? Math.round(mid) : tidyNumber(mid, String(low.value))), exact: true };
    }
    const lo = parseTemporal(low.value), hi = parseTemporal(high.value);
    if (lo && hi) {
      const mid = new Date((lo.date.getTime() + hi.date.getTime()) / 2);
      return { sql: `'${formatTemporal(mid, lo.hasTime, lo.hasSeconds)}'`, exact: true };
    }
  }
  return { sql: t('val.strictlyBetween', { low: low.sql, high: high.sql }), exact: false };
}

/** A value that is definitely not equal to `operand` — for the "≠" partition. */
export function notEqualTo(operand, type) {
  if (operand.kind !== 'literal') return { sql: t('val.anyNotEqual', { value: operand.sql }), exact: false };
  if (type === 'integer' || type === 'decimal') {
    return { sql: String((Number(operand.value) || 0) + 1), exact: true };
  }
  if (type === 'boolean') {
    return { sql: operand.value ? 'FALSE' : 'TRUE', exact: true };
  }
  if (type === 'date' || type === 'datetime') return shift(operand, type, 1);
  if (typeof operand.value === 'string') {
    return { sql: `'${operand.value}_x'`, exact: true };
  }
  return { sql: t('val.anyNotEqual', { value: operand.sql }), exact: false };
}

/**
 * A value guaranteed to be outside an entire IN list.
 *
 * Stepping away from the first member is not enough: for `IN (1, 2)` the value
 * one above 1 is 2, which is still in the list. So this steps past the extreme
 * member instead, and falls back to a placeholder when the members are not
 * comparable.
 */
export function outsideList(operands, type) {
  const literals = operands.filter(o => o.kind === 'literal' && o.value !== null);
  const rendered = operands.map(o => o.sql).join(', ');
  if (!literals.length) return { sql: t('val.anyNotInList', { list: rendered }), exact: false };

  if (type === 'integer' || type === 'decimal') {
    const nums = literals.map(o => Number(o.value)).filter(n => !Number.isNaN(n));
    if (nums.length) {
      const max = Math.max(...nums);
      return { sql: String(type === 'integer' ? max + 1 : tidyNumber(max + STEPS.decimal.delta, String(max))), exact: true };
    }
  }

  if (type === 'date' || type === 'datetime') {
    const latest = literals.reduce((best, o) => {
      const parsed = parseTemporal(o.value);
      return parsed && (!best.t || parsed.date > best.t.date) ? { t: parsed, o } : best;
    }, { t: null, o: null });
    if (latest.o) return shift(latest.o, type, 1);
  }

  if (literals.every(o => typeof o.value === 'string')) {
    // Suffix the longest member: no other member can share it as a whole value.
    const longest = literals.reduce((a, b) => (String(b.value).length > String(a.value).length ? b : a));
    return { sql: `'${String(longest.value).replace(/'/g, "''")}_x'`, exact: true };
  }

  return { sql: t('val.anyNotInList', { list: rendered }), exact: false };
}

/**
 * Turn a LIKE pattern into a matching example and a non-matching example.
 * `%` becomes a filler run, `_` becomes a single character.
 */
export function likeExamples(pattern) {
  if (typeof pattern !== 'string') {
    return { match: t('val.likeMatch'), noMatch: t('val.likeNoMatch'), anchored: null };
  }
  const match = pattern.replace(/%/g, 'xyz').replace(/_/g, 'a');
  const anchored =
    pattern.startsWith('%') && pattern.endsWith('%') ? 'contains'
    : pattern.endsWith('%') ? 'prefix'
    : pattern.startsWith('%') ? 'suffix'
    : 'exact';
  const core = pattern.replace(/[%_]/g, '');
  const noMatch = core ? `zzz${core.slice(0, Math.max(1, core.length - 1))}zzz`.replace(core, 'QQQ') || 'no-match-value' : 'no-match-value';
  return { match, noMatch: core ? t('val.valueWithout', { core }) : noMatch, anchored, core };
}

const ACCENT_MAP = {
  a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', y: 'ý',
  A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú', Y: 'Ý'
};

/**
 * Add a diacritic to the first plain Latin vowel in `s`, or `null` when there
 * is none to accent.
 *
 * Used to build an accent-varied twin of a LIKE pattern's literal text — most
 * collations used for Vietnamese data (e.g. `Vietnamese_CI_AI` in SQL Server,
 * a `_vietnamese_ci` collation in MySQL) treat "nguyen" and "nguyễn" as equal;
 * a binary or plain `_bin`/`_cs_as` one does not, and that difference is easy
 * to miss until it silently drops rows a user would expect to match.
 */
export function accentVariant(s) {
  if (typeof s !== 'string') return null;
  for (let i = 0; i < s.length; i++) {
    const mark = ACCENT_MAP[s[i]];
    if (mark) return s.slice(0, i) + mark + s.slice(i + 1);
  }
  return null;
}

/** Quote a raw JS value the way it would appear in SQL. */
export function quote(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Human label for a column reference, falling back to the raw predicate SQL. */
export function columnLabel(cond) {
  return cond.column ? cond.column.raw : (cond.operands[0]?.sql || cond.sql);
}
