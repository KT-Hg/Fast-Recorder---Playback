/**
 * selftest.mjs — Regression guard for the SQL analysis engine.
 *
 * Run with:  node sqlcases/selftest.mjs
 *
 * No framework and no dependencies on purpose: this is a plain script so it
 * stays runnable in a repo that has no test tooling.
 *
 * The failure this exists to catch is the silent one. A parser that stops
 * mid-statement still returns an AST, still generates cases, and still reports
 * no error — it just quietly drops every clause after the point it lost the
 * thread. So the clause-completeness checks below assert that GROUP BY, HAVING,
 * ORDER BY and LIMIT actually made it into the model, rather than only checking
 * that nothing threw.
 */

import { parse } from './parser.js';
import { analyze } from './analyze.js';
import { generateCases } from './generate.js';
import { toCsv, toJson } from './export.js';
import { inferSchema, buildAllFixtures, fixturesToCsv, valueSlots } from './datagen.js';
import * as valuebook from './valuebook.js';
import { setLang, missingKeys, clearMissingKeys, LANGUAGES } from './i18n.js';
import { EN } from './i18n/en.js';
import { VI } from './i18n/vi.js';

// The value and finding assertions below match English text, so pin the
// language rather than depending on whatever the default happens to be.
setLang('en');

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------
// 1. Clause completeness — every clause present in the SQL must survive
//    into the model, and no leftover-token warning may be raised.
// ---------------------------------------------------------------------

const COMPLETENESS = [
  {
    name: 'Postgres INTERVAL before GROUP BY',
    sql: `SELECT c.id, SUM(oi.qty * oi.unit_price) AS spent
            FROM customers c
            JOIN orders o ON o.customer_id = c.id
            JOIN order_items oi ON oi.order_id = o.order_id
           WHERE o.status = 'completed'
             AND o.order_date >= CURRENT_DATE - INTERVAL '6 months'
           GROUP BY c.id
          HAVING SUM(oi.qty * oi.unit_price) > 5000000
           ORDER BY spent DESC
           LIMIT 50;`,
    expect: { groupBy: 1, having: true, orderBy: 1, limit: true, joins: 2 }
  },
  {
    name: 'MySQL INTERVAL before GROUP BY',
    sql: `SELECT a FROM t WHERE d >= NOW() - INTERVAL 6 MONTH GROUP BY a ORDER BY a LIMIT 10`,
    expect: { groupBy: 1, orderBy: 1, limit: true }
  },
  {
    name: 'INTERVAL before ORDER BY',
    sql: `SELECT a FROM t WHERE d < CURRENT_DATE + INTERVAL '1 day' ORDER BY a DESC`,
    expect: { orderBy: 1 }
  },
  {
    name: 'INTERVAL before HAVING',
    sql: `SELECT a, COUNT(*) c FROM t WHERE d > NOW() - INTERVAL '7 days' GROUP BY a HAVING COUNT(*) > 2`,
    expect: { groupBy: 1, having: true }
  },
  {
    name: 'All clauses, no interval',
    sql: `SELECT a, COUNT(*) n FROM t JOIN u ON u.a = t.a WHERE t.x > 1
           GROUP BY a HAVING COUNT(*) > 2 ORDER BY n DESC LIMIT 5 OFFSET 10`,
    expect: { groupBy: 1, having: true, orderBy: 1, limit: true, offset: true, joins: 1 }
  },
  {
    name: 'Trailing semicolon alone raises no warning',
    sql: `SELECT a FROM t WHERE a > 1;`,
    expect: {}
  }
];

COMPLETENESS.forEach(({ name, sql, expect }) => {
  const { ast, errors, warnings } = parse(sql);
  check(`${name}: parses`, !!ast && errors.length === 0, errors.map(e => e.message).join('; '));
  check(`${name}: no leftover tokens`, warnings.length === 0, warnings.map(w => w.message).join('; '));
  if (!ast) return;

  const m = analyze(ast);
  if (expect.groupBy) check(`${name}: GROUP BY kept`, m.grouping.groupBy.length === expect.groupBy,
    `got ${m.grouping.groupBy.length}`);
  if (expect.having) check(`${name}: HAVING kept`, !!m.grouping.having);
  if (expect.orderBy) check(`${name}: ORDER BY kept`, m.paging.orderBy.length === expect.orderBy,
    `got ${m.paging.orderBy.length}`);
  if (expect.limit) check(`${name}: LIMIT kept`, !!m.paging.limit);
  if (expect.offset) check(`${name}: OFFSET kept`, !!m.paging.offset);
  if (expect.joins) check(`${name}: joins kept`, m.joins.length === expect.joins, `got ${m.joins.length}`);
});

// ---------------------------------------------------------------------
// 2. Value derivation — the numbers a tester actually types.
// ---------------------------------------------------------------------

function casesFor(sql) { return generateCases(sql).cases; }
function hasData(sql, text) { return casesFor(sql).some(c => c.data.includes(text)); }

check('integer boundary steps by 1', hasData(`SELECT * FROM t WHERE age > 18`, 'age = 19'));
check('decimal boundary steps by the literal scale',
  hasData(`SELECT * FROM t WHERE price >= 19.99`, 'price = 19.98'));
check('date boundary steps by a day',
  hasData(`SELECT * FROM t WHERE d >= '2024-01-01'`, "d = '2023-12-31'"));
check('timestamp boundary steps by a second',
  hasData(`SELECT * FROM t WHERE d >= '2024-01-01 00:00:00'`, "d = '2023-12-31 23:59:59'"));
check('decimal inferred from the compared expression, not the literal',
  hasData(`SELECT a FROM t GROUP BY a HAVING SUM(unit_price * qty) > 5000000`, '4999999.99'));
check('COUNT stays integer whatever it counts',
  hasData(`SELECT a FROM t GROUP BY a HAVING COUNT(unit_price) > 3`, 'COUNT(unit_price) = 4'));
// Stepping away from the first member is not enough: for IN (1, 2) the value
// one above 1 is 2, which is still in the list.
const outsider = casesFor(`SELECT * FROM t WHERE s IN (1, 2)`).find(c => /not in the list/.test(c.title));
check('IN outsider case exists', !!outsider);
check('IN outsider is outside the whole list', outsider?.data === 's = 3', outsider?.data);

// ---------------------------------------------------------------------
// 3. Findings that flag a defect in the query itself.
// ---------------------------------------------------------------------

function findings(sql) { return generateCases(sql).findings.map(f => f.message).join(' | '); }

check('= NULL flagged', /never be true/.test(findings(`SELECT * FROM t WHERE a = NULL`)));
check('DELETE without WHERE flagged', /every row/.test(findings(`DELETE FROM t`)));
check('comma join flagged', /implicit cross join/.test(findings(`SELECT * FROM a, b`)));
check('outer-join filter flagged',
  /degrades to an INNER JOIN/.test(findings(`SELECT * FROM a LEFT JOIN b ON b.a = a.id WHERE b.s = 'x'`)));
check('NOT IN subquery flagged', /NOT EXISTS/.test(findings(`SELECT * FROM a WHERE id NOT IN (SELECT x FROM b)`)));
check('LIMIT without ORDER BY flagged', /not deterministic/.test(findings(`SELECT * FROM t LIMIT 10`)));

// ---------------------------------------------------------------------
// 4. Nothing throws, and every case is fully populated.
// ---------------------------------------------------------------------

const SHAPES = [
  `SELECT * FROM users WHERE age > 18`,
  `SELECT id, name FROM products`,
  `SELECT * FROM t WHERE a > 1 AND b < 2 AND (c = 3 OR d LIKE 'x%') AND e IN (1,2) AND f IS NOT NULL`,
  `SELECT * FROM t WHERE (a = 1 OR b = 2) AND (c = 3 OR d = 4)`,
  `SELECT * FROM a NATURAL JOIN b`,
  `SELECT * FROM a FULL OUTER JOIN b ON a.id = b.aid RIGHT JOIN c ON c.id = a.cid`,
  `SELECT a FROM t1 UNION ALL SELECT b FROM t2`,
  `UPDATE acc SET bal = bal - :amt WHERE id = :id`,
  `INSERT INTO t (a, b) SELECT x, y FROM s WHERE x > 0`,
  `SELECT * FROM t WHERE x NOT BETWEEN 10 AND 20`,
  `SELECT TOP 10 * FROM t ORDER BY id DESC`,
  `SELECT * FROM t ORDER BY id OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY`,
  `SELECT CASE WHEN a > 1 THEN 'x' ELSE 'y' END AS c FROM t`,
  `WITH r AS (SELECT * FROM o) SELECT * FROM u WHERE EXISTS (SELECT 1 FROM r WHERE r.uid = u.id)`,
  "SELECT `a`.`b` FROM [dbo].[Users] AS `a` WHERE `a`.`x` = 1",
  `SELECT * FROM (SELECT id, SUM(v) AS s FROM t GROUP BY id) q WHERE q.s > 100`,
  ``,
  `SELEC * FRM`,
  `SELECT * FROM t WHERE a = 'abc`
];

SHAPES.forEach((sql, i) => {
  const label = `shape ${i + 1}`;
  try {
    const r = generateCases(sql);
    JSON.parse(toJson(sql, r));
    const csv = toCsv(r.cases);
    const rows = csv.replace(/^﻿/, '').trim().split('\r\n');
    const badRow = rows.find(row => (row.match(/"(?:[^"]|"")*"/g) || []).length !== 11);
    check(`${label}: CSV columns intact`, !badRow, badRow && badRow.slice(0, 80));
    const bad = r.cases.find(c =>
      !c.id || !c.title || !c.expected || !c.rationale ||
      /undefined|NaN|\[object/.test(`${c.title}|${c.data}|${c.expected}|${c.notes}|${c.rationale}`));
    check(`${label}: cases well-formed`, !bad, bad && bad.title);
  } catch (err) {
    check(`${label}: no throw`, false, err.message);
  }
});

// ---------------------------------------------------------------------
// 5. Translation catalogs.
//
// A missing key degrades to the key itself — visible as `st.orphanKept` in a
// case description rather than as a crash — so the only way to catch it is to
// generate across every shape in both languages and assert nothing was missed.
// ---------------------------------------------------------------------

const enKeys = Object.keys(EN);
const viKeys = Object.keys(VI);
const onlyEn = enKeys.filter(k => !(k in VI));
const onlyVi = viKeys.filter(k => !(k in EN));
check('every EN key exists in VI', onlyEn.length === 0, onlyEn.slice(0, 8).join(', '));
check('every VI key exists in EN', onlyVi.length === 0, onlyVi.slice(0, 8).join(', '));

// A placeholder present in one language and absent in the other means the
// translated sentence silently drops a value the reader needs.
const placeholders = str => [...String(str).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
const phMismatch = enKeys.filter(k => k in VI && placeholders(EN[k]) !== placeholders(VI[k]));
check('placeholders match across catalogs', phMismatch.length === 0, phMismatch.slice(0, 8).join(', '));

const emptyVi = viKeys.filter(k => !String(VI[k]).trim());
check('no empty VI translations', emptyVi.length === 0, emptyVi.slice(0, 8).join(', '));

LANGUAGES.forEach(({ code }) => {
  setLang(code);
  clearMissingKeys();
  SHAPES.concat(COMPLETENESS.map(c => c.sql)).forEach(sql => {
    const r = generateCases(sql);
    toCsv(r.cases);
    toJson(sql, r);
  });
  const missed = missingKeys();
  check(`no missing message keys in ${code}`, missed.length === 0, missed.slice(0, 8).join(', '));

  // Untranslated keys leak as the key itself; catch that shape in the output.
  setLang(code);
  const leaked = generateCases(COMPLETENESS[0].sql).cases.filter(c =>
    /(^|\s)(out|val|hint|ep|bva|dt|bc|n3|st|find|grp|tech|prio|csv|rationale)\.[a-zA-Z]/.test(
      `${c.title} ${c.data} ${c.expected} ${c.notes} ${c.rationale}`));
  check(`no raw keys leak into ${code} output`, leaked.length === 0, leaked[0]?.title);
});

setLang('en');

// ---------------------------------------------------------------------
// 6. Inferred schema and test-data fixtures.
// ---------------------------------------------------------------------

const JOINED = `SELECT u.id, u.name, COUNT(o.id) AS orders
   FROM users u
   LEFT JOIN orders o ON o.user_id = u.id
  WHERE u.age BETWEEN 18 AND 65 AND u.country IN ('VN','SG')
  GROUP BY u.id, u.name HAVING COUNT(o.id) > 3`;

{
  const r = generateCases(JOINED);
  const schema = inferSchema(r.model);
  const users = schema.tables.find(x => x.name === 'users');
  const orders = schema.tables.find(x => x.name === 'orders');
  check('schema found both tables', !!users && !!orders);
  check('primary key detected', users?.byName.get('id')?.isPk === true);
  const fk = orders?.byName.get('user_id');
  check('foreign key read off the join', fk?.fk?.table === 'users' && fk?.fk?.column === 'id',
    JSON.stringify(fk?.fk));
  check('type inferred from the comparison literal', users?.byName.get('age')?.type === 'integer',
    users?.byName.get('age')?.type);

  const { fixtures } = buildAllFixtures(r.model, r.cases);
  check('every case got a fixture', fixtures.size === r.cases.length, `${fixtures.size}/${r.cases.length}`);

  // A boundary case must put its own value in the row, and mark it.
  const bva = r.cases.find(c => c.technique === 'BVA' && c.target === 'u.age' && c.data.includes('17'));
  const bvaRow = bva && fixtures.get(bva.id).tables.find(x => x.label === 'u').rows[0];
  check('boundary value lands in the row', bvaRow?.values.age?.plain === '17', bvaRow?.values.age?.plain);
  check('the value under test is flagged', bvaRow?.values.age?.focus === true);

  // Child rows must point at the parent row that was generated alongside them.
  const parentId = bva && fixtures.get(bva.id).tables.find(x => x.label === 'u').rows[0].values.id.plain;
  const childFk = bva && fixtures.get(bva.id).tables.find(x => x.label === 'o').rows[0]?.values.user_id.plain;
  check('foreign key points at the generated parent row', childFk === parentId, `${childFk} vs ${parentId}`);

  // `COUNT(o.id) = 4` is a row count, not a column value.
  const having = r.cases.find(c => c.technique === 'BVA' && /COUNT/.test(c.target) && c.data.includes('4'));
  const orderRows = having && fixtures.get(having.id).tables.find(x => x.label === 'o').rows.length;
  check('HAVING COUNT drives the number of child rows', orderRows === 4, String(orderRows));

  // An orphan case must genuinely produce no row on the joined side.
  const orphan = r.cases.find(c => c.spec?.population && Object.values(c.spec.population).includes(0));
  const orphanRows = orphan && fixtures.get(orphan.id).tables.find(x => x.label === 'o').rows.length;
  check('orphan case seeds no child row', orphan ? orphanRows === 0 : true, String(orphanRows));

  const files = fixturesToCsv(schema, fixtures, r.cases);
  check('one CSV per table', files.length === 2, String(files.length));
  files.forEach(f => {
    const rows = f.csv.replace(/^﻿/, '').trim().split('\r\n');
    const width = (rows[0].match(/"(?:[^"]|"")*"/g) || []).length;
    const ragged = rows.find(row => (row.match(/"(?:[^"]|"")*"/g) || []).length !== width);
    check(`CSV for ${f.table} has square columns`, !ragged, ragged && ragged.slice(0, 70));
  });
}

// A single-table query must not need aliases to resolve its columns.
{
  const r = generateCases(`SELECT * FROM t WHERE age > 18 AND name = 'x'`);
  const { schema, fixtures } = buildAllFixtures(r.model, r.cases);
  check('unqualified columns resolve when there is one table',
    !!schema.tables[0]?.byName.get('age') && !!schema.tables[0]?.byName.get('name'));
  const c = r.cases.find(x => x.technique === 'BVA' && x.data.includes('19'));
  check('single-table fixture carries the value',
    c && fixtures.get(c.id).tables[0].rows[0].values.age.plain === '19');
}

// Nothing in fixture building may throw on the odd shapes.
SHAPES.forEach((sql, i) => {
  try {
    const r = generateCases(sql);
    if (!r.ok) return;
    const { schema, fixtures } = buildAllFixtures(r.model, r.cases);
    fixturesToCsv(schema, fixtures, r.cases);
  } catch (err) {
    check(`shape ${i + 1}: fixtures build without throwing`, false, err.message);
  }
});

// ---------------------------------------------------------------------
// 7. The value book — user-managed sample values.
//
//    The contract worth guarding is that an edit reaches everything: a bound
//    parameter must make boundary cases concrete, a column sample must reach
//    both the case prose and the fixture rows, and clearing must put the
//    generated values back exactly as they were.
// ---------------------------------------------------------------------

valuebook.clearAll();

{
  // Typed text in, SQL literal plus a usable JS value out.
  const parses = [
    ['18', 'integer', '18', 18, true],
    ['18', 'string', "'18'", '18', true],          // textual columns keep the text
    ['abc', 'integer', "'abc'", 'abc', false],     // accepted, but flagged
    ["'0123'", 'string', "'0123'", '0123', true],  // explicit SQL wins
    ['NULL', 'string', 'NULL', null, true],
    ['true', 'boolean', 'TRUE', true, true],
    ['2026-03-01', 'date', "'2026-03-01'", '2026-03-01', true],
    ['tomorrow', 'date', "'tomorrow'", 'tomorrow', false],
    ["it's", 'string', "'it''s'", "it's", true]    // quote doubling
  ];
  parses.forEach(([raw, type, sql, value, valid]) => {
    const p = valuebook.parseValue(raw, type);
    check(`parseValue(${raw}, ${type})`,
      p && p.sql === sql && p.value === value && p.valid === valid,
      JSON.stringify(p));
  });
  check('blank text is not a value', valuebook.parseValue('  ', 'integer') === null);
}

{
  // Parameters are found, numbered, and reported as unbound until they are set.
  const r = generateCases(`SELECT * FROM t WHERE a > ? AND b < ? AND c = :name AND d = :name`);
  const labels = r.model.params.map(p => p.label);
  check('anonymous parameters are numbered apart', labels.join(',') === '?1,?2,:name', labels.join(','));
  check('unbound parameters are reported',
    r.findings.some(f => /3 bind parameter/.test(f.message)),
    r.findings.map(f => f.message).join(' | '));
}

{
  const SQL = `SELECT * FROM users WHERE age >= :min`;
  const relative = (result) => result.cases.filter(c => c.target === 'age').map(c => c.data);
  const before = relative(generateCases(SQL));
  check('an unbound parameter leaves the boundary relative',
    before.some(d => d.includes(':min')) && !before.some(d => d === 'age = 19'),
    before.join(' | '));

  valuebook.setOverride('param::min', '18');
  const r = generateCases(SQL);
  const data = r.cases.filter(c => c.target === 'age').map(c => c.data);
  check('binding a parameter makes the boundary concrete',
    ['age = 17', 'age = 18', 'age = 19'].every(d => data.includes(d)), data.join(' | '));
  check('a bound value is reported as not coming from the query',
    r.findings.some(f => /:min = 18/.test(f.message)),
    r.findings.map(f => f.message).join(' | '));
  check('a bound parameter types the comparison',
    r.model.conditions[0].dataType.type === 'integer', r.model.conditions[0].dataType.type);

  valuebook.clearOverride('param::min');
  check('clearing a parameter restores the relative boundary',
    relative(generateCases(SQL)).join(' | ') === before.join(' | '));
}

{
  // A column sample has to reach the fixture rows and the case prose alike,
  // and it is keyed by table name, so an alias must resolve to it.
  const SQL = `SELECT u.id, u.name FROM users u WHERE u.email IS NOT NULL`;
  const nameCell = (result) => {
    const { fixtures } = buildAllFixtures(result.model, result.cases);
    const first = [...fixtures.values()][0];
    return first.tables.find(x => x.label === 'u').rows[0].values.name.plain;
  };

  const auto = generateCases(SQL);
  check('a column with no predicate gets a generated filler', nameCell(auto) === 'name_1', nameCell(auto));

  valuebook.setOverride('col:users.name', 'Nguyen An');
  valuebook.setOverride('col:users.email', 'qa@corp.test');
  const r = generateCases(SQL);
  check('a column sample reaches the fixture row', nameCell(r) === 'Nguyen An', nameCell(r));
  check('a column sample resolves through the table alias',
    r.cases.some(c => c.data === "u.email = 'qa@corp.test'"),
    r.cases.map(c => c.data).join(' | ').slice(0, 120));
  check('the generic non-NULL placeholder is gone once a sample exists',
    !r.cases.some(c => c.data.includes('any non-NULL')));

  // The panel's own view of the book: what is editable, and what is set.
  const { schema, fixtures } = buildAllFixtures(r.model, r.cases);
  const slots = valueSlots(r.model, schema, fixtures);
  const users = slots.tables.find(tb => tb.name === 'users');
  check('keys are not offered as editable values',
    users && !users.slots.some(x => x.name === 'id'),
    users?.slots.map(x => x.name).join(','));
  const nameSlot = users?.slots.find(x => x.name === 'name');
  check('an edited slot reports its value and its reach',
    nameSlot?.overridden === true && nameSlot.valuePlain === 'Nguyen An' && nameSlot.uses > 0,
    JSON.stringify(nameSlot));
  check('the summary counts what is set', slots.overridden === 2, String(slots.overridden));

  valuebook.clearAll();
  check('reset puts the generated value back', nameCell(generateCases(SQL)) === 'name_1');
  check('reset empties the book', valuebook.overrideCount() === 0);
}

{
  // Persistence has to round-trip, since the book outlives the page.
  valuebook.setOverride('col:users.name', 'Nguyen An');
  const saved = JSON.parse(JSON.stringify(valuebook.toJSON()));
  valuebook.clearAll();
  valuebook.load(saved);
  check('the book survives a save/load round trip',
    valuebook.rawOverride('col:users.name') === 'Nguyen An');
  valuebook.load({ 'col:users.name': '   ' });
  check('blank entries are not loaded', valuebook.overrideCount() === 0);
  valuebook.clearAll();
}

// Nothing in the value book may throw on the odd shapes.
SHAPES.forEach((sql, i) => {
  try {
    const r = generateCases(sql);
    if (!r.ok) return;
    const { schema, fixtures } = buildAllFixtures(r.model, r.cases);
    valueSlots(r.model, schema, fixtures);
  } catch (err) {
    check(`shape ${i + 1}: value slots build without throwing`, false, err.message);
  }
});

// ---------------------------------------------------------------------

if (failures.length) {
  console.error(`\n${failures.length} FAILED, ${passed} passed:\n`);
  failures.forEach(f => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`All ${passed} checks passed.`);
