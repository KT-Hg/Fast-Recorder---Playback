/**
 * datagen.js — Inferred schema and per-case test data fixtures.
 *
 * A test case says "age = 17, everything else satisfied". A manual tester needs
 * that turned into rows: which table, which columns, what to type in each, and
 * how the rows link to one another. That is what this module produces.
 *
 * There is no real schema to work from, so one is inferred: the columns are
 * whichever ones the query mentions, their types come from the analysis, the
 * primary key is guessed from naming, and the foreign keys come from the join
 * conditions — `ON o.user_id = u.id` is a statement about how the two tables
 * relate, and that is exactly what a fixture needs in order to link its rows.
 *
 * Values are taken from `resolve()` rather than from a case's prose, because
 * the prose is translated and the values must not be.
 *
 * Filler values — the ones for columns no predicate constrains — are the
 * tool's own invention, so they are the ones a tester most often wants to
 * replace. `valueSlots()` lists them (and the query's bind parameters) for the
 * value book to edit; `fillerFor()` reads whatever the book holds back.
 */

import { resolve } from './hints.js';
import { typeFromName } from './analyze.js';
import { columnKey, columnSample, paramKey, paramLabel, rawOverride, valueFor } from './valuebook.js';
import { t } from './i18n.js';

/** Columns whose name marks them as the row's own identity. */
const PK_NAMES = ['id', 'pk', 'uuid', 'guid'];

/** Rough singularisation, enough to turn `orders` into `order_id`. */
function singular(name) {
  const n = String(name).toLowerCase().replace(/^.*\./, '');
  if (n.endsWith('ies')) return n.slice(0, -3) + 'y';
  if (n.endsWith('ses') || n.endsWith('xes') || n.endsWith('zes')) return n.slice(0, -2);
  if (n.endsWith('s') && !n.endsWith('ss')) return n.slice(0, -1);
  return n;
}

/**
 * Build a synthetic schema from the analysis model.
 *
 * @param {object} model — from analyze()
 * @returns {{tables: Array, byLabel: Map, notes: Array}}
 */
export function inferSchema(model) {
  const notes = [];
  const tables = [];
  const byLabel = new Map();

  model.tables.forEach(tbl => {
    if (tbl.isSubquery) {
      notes.push({ level: 'info', key: 'dg.note.subqueryTable', params: { label: tbl.label } });
      return;
    }
    const entry = {
      name: tbl.name,
      label: tbl.label,
      alias: tbl.alias,
      role: tbl.role,
      joinType: tbl.joinType,
      columns: [],
      byName: new Map()
    };
    tables.push(entry);
    byLabel.set(tbl.label.toLowerCase(), entry);
    if (tbl.alias) byLabel.set(tbl.alias.toLowerCase(), entry);
    byLabel.set(tbl.name.toLowerCase(), entry);
  });

  if (!tables.length) return { tables, byLabel, notes };

  /** Which table a column reference belongs to. */
  const tableFor = (colRef) => {
    if (colRef.table) return byLabel.get(colRef.table.toLowerCase()) || null;
    // Unqualified: unambiguous only when the query has a single table.
    if (tables.length === 1) return tables[0];
    return null;
  };

  const addColumn = (entry, name, type) => {
    const key = name.toLowerCase();
    let col = entry.byName.get(key);
    if (!col) {
      col = { name, type: type || 'unknown', nullable: true, isPk: false, fk: null };
      entry.byName.set(key, col);
      entry.columns.push(col);
    } else if (col.type === 'unknown' && type && type !== 'unknown') {
      col.type = type;
    }
    return col;
  };

  // --- columns, typed from the conditions that mention them ---------------
  const typeOf = new Map();
  [...model.conditions, ...model.havingConditions, ...model.joinConditions].forEach(c => {
    if (c.column && c.dataType?.type && c.dataType.type !== 'unknown') {
      typeOf.set(c.column.raw.toLowerCase(), c.dataType.type);
    }
  });

  const unresolved = new Set();
  const aliases = new Set((model.selectAliases || []).map(a => a.toLowerCase()));
  model.columns.forEach(colRef => {
    // An unqualified name that matches a select alias refers to a result
    // column, so it needs no storage and is not an ambiguity worth reporting.
    if (!colRef.table && aliases.has(colRef.name.toLowerCase())) return;
    const entry = tableFor(colRef);
    if (!entry) { unresolved.add(colRef.raw); return; }
    const type = typeOf.get(colRef.raw.toLowerCase()) || typeFromName(colRef.name).type;
    addColumn(entry, colRef.name, type);
  });

  if (unresolved.size) {
    notes.push({
      level: 'info',
      key: 'dg.note.ambiguousColumns',
      params: { cols: [...unresolved].join(', ') }
    });
  }

  // Columns written by INSERT/UPDATE belong to the target table.
  if (model.writes && model.writes.columns?.length) {
    const entry = byLabel.get(String(model.writes.table).toLowerCase());
    if (entry) {
      model.writes.columns.forEach(c => addColumn(entry, c.name, c.dataType?.type));
    }
  }

  // --- primary keys -------------------------------------------------------
  tables.forEach(entry => {
    const candidates = [
      ...PK_NAMES,
      `${singular(entry.name)}_id`,
      `${singular(entry.name)}id`
    ];
    let pk = null;
    for (const cand of candidates) {
      const found = entry.byName.get(cand);
      if (found) { pk = found; break; }
    }
    if (!pk) {
      // Nothing looked like an identity column, so give the table one. A
      // fixture needs something to point foreign keys at.
      pk = addColumn(entry, 'id', 'integer');
      pk.synthetic = true;
      notes.push({ level: 'info', key: 'dg.note.syntheticPk', params: { table: entry.name } });
    }
    pk.isPk = true;
    pk.nullable = false;
    if (pk.type === 'unknown') pk.type = 'integer';
    entry.pk = pk;
  });

  // --- foreign keys, read off the join conditions -------------------------
  model.joins.forEach(join => {
    (join.keys || []).forEach(k => {
      const parse = (raw) => {
        const dot = raw.lastIndexOf('.');
        const tbl = dot > 0 ? byLabel.get(raw.slice(0, dot).toLowerCase()) : (tables.length === 1 ? tables[0] : null);
        if (!tbl) return null;
        const name = dot > 0 ? raw.slice(dot + 1) : raw;
        // A join key can name a column no SELECT/WHERE ever spelled under this
        // table's own label — a correlated subquery in an ON clause is read
        // through its own alias (`h.order_id`), never the outer one (`s.order_id`),
        // so the column would otherwise not exist under `s` at all. The key
        // still names a real column, so give the table one rather than
        // silently dropping the relationship, the same way a missing PK does.
        const col = tbl.byName.get(name.toLowerCase()) || addColumn(tbl, name, typeFromName(name).type);
        return { tbl, col };
      };
      const a = parse(k.left);
      const b = parse(k.right);
      if (!a?.col || !b?.col || a.tbl === b.tbl) return;
      // The side that is its table's primary key is the one being pointed at.
      const [child, parent] = b.col.isPk ? [a, b] : [b, a];
      if (!parent.col.isPk) return;
      child.col.fk = { table: parent.tbl.name, label: parent.tbl.label, column: parent.col.name };
      if (child.col.type === 'unknown') child.col.type = parent.col.type;
    });
  });

  // --- nullability --------------------------------------------------------
  model.conditions.concat(model.joinConditions).forEach(c => {
    if (c.kind === 'null-check' && c.negated && c.column) {
      const entry = tableFor(c.column);
      const col = entry?.byName.get(c.column.name.toLowerCase());
      // `IS NOT NULL` in the query is the only nullability signal available.
      if (col) col.nullable = false;
    }
  });

  return { tables, byLabel, notes };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Turn an SQL literal into the bare value a person would type into a form. */
export function plainValue(valueSql) {
  if (valueSql === null || valueSql === undefined) return '';
  const s = String(valueSql);
  if (s === 'NULL') return 'NULL';
  const m = /^'([\s\S]*)'$/.exec(s);
  if (m) return m[1].replace(/''/g, "'");
  return s;
}

/** Stable, readable row ids so two cases never collide in one database. */
function idFor(caseIndex, tableIndex, rowIndex) {
  return (tableIndex + 1) * 100000 + (caseIndex + 1) * 10 + rowIndex;
}

/**
 * Conditions that constrain a given table, as concrete column values.
 * Only WHERE and ON predicates apply — HAVING filters groups, not rows.
 */
function baseValuesFor(entry, model, schema) {
  const out = new Map();
  const apply = (cond) => {
    if (!cond.column) return;
    const owner = cond.column.table
      ? schema.byLabel.get(cond.column.table.toLowerCase())
      : (schema.tables.length === 1 ? schema.tables[0] : null);
    if (owner !== entry) return;
    const r = resolve(cond, true);
    if (r.kind === 'value' && r.valueSql !== null) out.set(cond.column.name.toLowerCase(), r.valueSql);
  };
  model.conditions.forEach(apply);
  model.joinConditions.forEach(apply);
  return out;
}

/**
 * A neutral value for a column with nothing else pinning it down.
 *
 * @param {object} col — schema column
 * @param {number} rowIndex
 * @param {object} [entry] — the table it belongs to, for the value-book lookup
 */
function fillerFor(col, rowIndex, entry) {
  if (col.fk) return null;                       // linked separately
  const sample = entry && columnSample(entry.name, col.name, col.type);
  return sample ? sample.sql : autoFillerFor(col, rowIndex);
}

/** The generated filler, before any value-book override is applied. */
export function autoFillerFor(col, rowIndex = 0) {
  if (col.fk) return null;
  switch (col.type) {
    case 'integer': return String(100 + rowIndex);
    case 'decimal': return String(100 + rowIndex) + '.00';
    case 'boolean': return 'TRUE';
    case 'date': return `'2026-01-${String((rowIndex % 28) + 1).padStart(2, '0')}'`;
    case 'datetime': return `'2026-01-${String((rowIndex % 28) + 1).padStart(2, '0')} 10:00:00'`;
    case 'time': return `'10:00:00'`;
    case 'email': return `'user${rowIndex + 1}@example.com'`;
    case 'string': return `'${col.name}_${rowIndex + 1}'`;
    default: return `'v${rowIndex + 1}'`;
  }
}

/**
 * Read a spec entry as a row count, when it is really about an aggregate.
 *
 * A HAVING case pins `COUNT(o.id)` to a number. No column can hold that value —
 * it is a statement about how many `o` rows the group needs — so it becomes a
 * population count for that table instead.
 *
 * @returns {{entry: object, n: number}|null}
 */
function countTarget(spec, schema) {
  const m = /^COUNT\(\s*(?:DISTINCT\s+)?([\w.]+|\*)\s*\)$/i.exec(String(spec.columnRaw || '').trim());
  if (!m) return null;
  const n = Number(spec.valueSql);
  if (!Number.isInteger(n) || n < 0 || n > 50) return null;

  const ref = m[1];
  // COUNT(*) counts rows of the joined side; a qualified column names it.
  const dot = ref.lastIndexOf('.');
  const label = dot > 0 ? ref.slice(0, dot) : null;
  const entry = label
    ? schema.byLabel.get(label.toLowerCase())
    : schema.tables[schema.tables.length - 1];
  return entry ? { entry, n } : null;
}

/**
 * Build the data rows one test case needs.
 *
 * @param {object} model
 * @param {object} schema — from inferSchema()
 * @param {object} testCase — one generated case
 * @param {number} caseIndex — position in the case list, for stable ids
 * @returns {{caseId: string, tables: Array, requirements: Array}|null}
 */
export function buildFixture(model, schema, testCase, caseIndex) {
  if (!schema.tables.length) return null;

  const spec = testCase.spec || {};
  const requirements = [];

  // How many rows each table needs. A join-cardinality case says so directly;
  // everything else wants one row per table.
  const counts = new Map();
  schema.tables.forEach(e => counts.set(e, 1));
  if (spec.population) {
    Object.entries(spec.population).forEach(([label, n]) => {
      const entry = schema.byLabel.get(String(label).toLowerCase());
      if (entry) counts.set(entry, n);
    });
  }

  // Overrides keyed by "table label|column", from the case's own spec.
  const overrides = new Map();
  (spec.set || []).forEach(s => {
    // `COUNT(o.id) = 4` is not a column value, it is a row count. Turning it
    // into one is the difference between a fixture that reproduces a HAVING
    // case and one that quietly seeds a single row and fails it.
    const agg = countTarget(s, schema);
    if (agg) { counts.set(agg.entry, agg.n); return; }

    if (!s.column) { requirements.push({ text: `${s.columnRaw} = ${s.valueSql}` }); return; }
    const entry = s.column.table
      ? schema.byLabel.get(s.column.table.toLowerCase())
      : (schema.tables.length === 1 ? schema.tables[0] : null);
    if (!entry) { requirements.push({ text: `${s.columnRaw} = ${s.valueSql}` }); return; }
    overrides.set(`${entry.label}|${s.column.name.toLowerCase()}`, s.valueSql);
  });
  (spec.requires || []).forEach(r => requirements.push(r));

  const pkValues = new Map();
  const out = [];

  schema.tables.forEach((entry, tableIndex) => {
    const n = counts.get(entry);
    if (n === 0) {
      out.push({ table: entry.name, label: entry.label, columns: [], rows: [], emptyKey: 'dg.row.none' });
      return;
    }
    const base = baseValuesFor(entry, model, schema);
    const rows = [];

    for (let i = 0; i < n; i++) {
      const values = {};
      entry.columns.forEach(col => {
        const key = col.name.toLowerCase();
        let valueSql;
        let focus = false;

        if (col.isPk) {
          valueSql = String(idFor(caseIndex, tableIndex, i));
          pkValues.set(`${entry.label}|${col.name.toLowerCase()}`, valueSql);
        } else if (col.fk) {
          // Point at the first row of the parent table so the join matches.
          valueSql = pkValues.get(`${col.fk.label}|${col.fk.column.toLowerCase()}`) ?? null;
        } else if (overrides.has(`${entry.label}|${key}`)) {
          valueSql = overrides.get(`${entry.label}|${key}`);
          focus = true;
        } else if (base.has(key)) {
          valueSql = base.get(key);
        } else {
          valueSql = fillerFor(col, i, entry);
        }

        // An override always wins, including over a primary or foreign key.
        if (overrides.has(`${entry.label}|${key}`)) {
          valueSql = overrides.get(`${entry.label}|${key}`);
          focus = true;
        }
        values[col.name] = { sql: valueSql, plain: plainValue(valueSql), focus };
      });
      rows.push({ values });
    }

    out.push({
      table: entry.name,
      label: entry.label,
      columns: entry.columns.map(c => c.name),
      rows
    });
  });

  // Deferred foreign keys: a child table listed before its parent had no id to
  // point at on the first pass, so fill those in now that every id exists.
  out.forEach((tbl, tableIndex) => {
    const entry = schema.tables[tableIndex];
    if (!entry) return;
    tbl.rows.forEach(row => {
      entry.columns.forEach(col => {
        if (!col.fk) return;
        const cell = row.values[col.name];
        if (cell && cell.sql === null) {
          const v = pkValues.get(`${col.fk.label}|${col.fk.column.toLowerCase()}`);
          if (v !== undefined) { cell.sql = v; cell.plain = v; }
        }
      });
    });
  });

  return { caseId: testCase.id, tables: out, requirements };
}

/**
 * Fixtures for every case, plus the schema they were built against.
 *
 * @param {object} model
 * @param {Array} cases
 * @returns {{schema: object, fixtures: Map<string, object>}}
 */
export function buildAllFixtures(model, cases) {
  const schema = inferSchema(model);
  const fixtures = new Map();
  cases.forEach((c, i) => {
    const f = buildFixture(model, schema, c, i);
    if (f) fixtures.set(c.id, f);
  });
  return { schema, fixtures };
}

// ---------------------------------------------------------------------------
// The editable value book
// ---------------------------------------------------------------------------

/**
 * A type for each bind parameter, read off whatever it is compared against.
 *
 * `balance >= :amount` says nothing about `:amount` on its own, but the
 * condition it sits in was already typed from the column — so the value book
 * can validate what the user types and quote it correctly.
 */
function paramTypeHints(model) {
  const hints = new Map();
  const note = (operand, type) => {
    if (!operand || !type || type === 'unknown') return;
    const label = operand.kind === 'param'
      ? paramLabel(operand.name, operand.ordinal)
      : operand.param;
    if (label && !hints.has(label)) hints.set(label, type);
  };

  [...model.conditions, ...model.havingConditions, ...model.joinConditions].forEach(c => {
    (c.values || []).forEach(v => note(v, c.dataType?.type));
  });
  (model.writes?.columns || []).forEach(col => {
    const vals = col.values || (col.value ? [col.value] : []);
    vals.forEach(v => note(v, col.dataType?.type));
  });
  // Paging values are counts whatever else the query does.
  [model.paging?.limit, model.paging?.offset].forEach(o => note(o, 'integer'));
  return hints;
}

/** One editable entry, resolved against whatever the book currently holds. */
function makeSlot(kind, key, label, name, type, autoSql, uses) {
  const raw = rawOverride(key);
  const parsed = valueFor(key, type);
  return {
    kind, key, label, name, type,
    autoSql,
    autoPlain: autoSql === null || autoSql === undefined ? '' : plainValue(autoSql),
    raw,
    overridden: !!raw,
    valueSql: parsed ? parsed.sql : (autoSql ?? null),
    valuePlain: parsed ? plainValue(parsed.sql) : (autoSql === null || autoSql === undefined ? '' : plainValue(autoSql)),
    valid: parsed ? parsed.valid : true,
    uses
  };
}

/**
 * Everything the value book can edit for the current query.
 *
 * Two families, because they enter the results by two different routes. A
 * parameter replaces an opaque marker in the query itself, so it changes the
 * *case values* — boundaries, partitions, the lot. A column sample only fills
 * cells no predicate constrains, so it changes the *fixture rows*. Primary and
 * foreign keys are left out: those link the rows to each other, and a value
 * typed over them would break the join the fixture exists to exercise.
 *
 * @param {object} model
 * @param {object} schema — from inferSchema()
 * @param {Map} [fixtures] — from buildAllFixtures(), for the usage counts
 * @returns {{params: Array, tables: Array, total: number, overridden: number}}
 */
export function valueSlots(model, schema, fixtures) {
  const hints = paramTypeHints(model || {});
  const rows = fixtures ? [...fixtures.values()] : [];

  const params = (model?.params || []).map(p => {
    const label = p.label;
    const type = hints.get(label) || 'unknown';
    const uses = (model.conditions || []).concat(model.havingConditions || [], model.joinConditions || [])
      .filter(c => String(c.sql).includes(p.name)).length;
    return makeSlot('param', paramKey(p.name, p.ordinal), label, label, type, null, uses);
  });

  const tables = (schema?.tables || []).map(entry => {
    const slots = entry.columns
      .filter(col => !col.isPk && !col.fk)
      .map(col => {
        // A cell "uses" the sample when it holds exactly what the filler
        // produced — anything pinned by the case or by a WHERE value does not.
        let uses = 0;
        rows.forEach(fixture => {
          const tbl = fixture.tables.find(x => x.label === entry.label);
          if (!tbl) return;
          tbl.rows.forEach((row, i) => {
            const cell = row.values[col.name];
            if (cell && !cell.focus && cell.sql === fillerFor(col, i, entry)) uses++;
          });
        });
        return makeSlot('column', columnKey(entry.name, col.name), `${entry.name}.${col.name}`,
          col.name, col.type, autoFillerFor(col, 0), uses);
      });
    return { name: entry.name, label: entry.label, alias: entry.alias, slots };
  }).filter(tb => tb.slots.length);

  const all = [...params, ...tables.flatMap(tb => tb.slots)];
  return {
    params,
    tables,
    total: all.length,
    overridden: all.filter(s => s.overridden).length
  };
}

/**
 * The query to run once the data is in place, with the expected outcome
 * recorded beside it so a manual run is self-checking.
 */
export function verifyFor(sql, testCase) {
  const trimmed = String(sql || '').trim().replace(/;+\s*$/, '');
  return {
    header: `${testCase.id} — ${testCase.title}`,
    expectation: testCase.expected,
    sql: trimmed + ';'
  };
}

/**
 * One CSV per table: every fixture row, tagged with the case it belongs to.
 *
 * @returns {Array<{table: string, csv: string, rows: number}>}
 */
export function fixturesToCsv(schema, fixtures, cases) {
  const byCase = new Map(cases.map(c => [c.id, c]));
  return schema.tables.map(entry => {
    const header = [t('dg.csv.caseId'), t('dg.csv.caseTitle'), ...entry.columns.map(c => c.name)];
    const rows = [header];

    fixtures.forEach((fixture, caseId) => {
      const tbl = fixture.tables.find(x => x.label === entry.label);
      if (!tbl || !tbl.rows.length) return;
      const title = byCase.get(caseId)?.title || '';
      tbl.rows.forEach(row => {
        rows.push([caseId, title, ...entry.columns.map(c => row.values[c.name]?.plain ?? '')]);
      });
    });

    const csv = rows
      .map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\r\n') + '\r\n';

    return { table: entry.name, label: entry.label, csv: '﻿' + csv, rows: rows.length - 1 };
  });
}
