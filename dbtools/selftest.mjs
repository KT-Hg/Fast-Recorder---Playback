/**
 * selftest.mjs — regression guard for the Adminer rollback feature.
 *
 * Run with:  node dbtools/selftest.mjs
 *
 * No framework and no dependencies, same as sqlcases/selftest.mjs.
 *
 * What it is here to catch is a wrong *undo*, because that is the failure with
 * teeth: a rollback that runs cleanly and puts back the wrong value looks like a
 * success and is only noticed later, by someone else. So the assertions below
 * are mostly about the cases where the obvious implementation is subtly wrong —
 * NULL against the empty string, an edit that moved the primary key, a value
 * that merely looks like a number, a predicate that has to be lifted out of the
 * user's own SQL rather than re-rendered from an AST.
 *
 * Anything that needs a live DOM (reading Adminer's edit form, parsing a result
 * grid) is not covered here; those live in adapters/adminer.js behind an
 * `{ ok: false, reason }` contract precisely because they cannot be tested
 * without a browser.
 */

import {
  parseAdminerUrl, buildUrl, editUrl, connKey, connLabel, parseRowIdf, bracketEscape, unbracket,
} from './params.js';
import {
  snapshotSelect, keysSelect, keyOf, keyWhere, newRows, diffSnapshot, diffIsEmpty, restoreStatements,
  backupName, backupCreateSql, backupRestoreSql, backupDropSql,
} from './snapshot.js';
import {
  quoteIdent, quoteValue, quoteTable, looksNumeric, whereClause,
  buildUpdate, buildInsert, buildDelete, engineOf, joinStatements,
} from './sqlquote.js';
import {
  undoStatements, undoWhere, blockingReason, changedColumns, columnsToRestore,
  driftOf, sameValue, sessionUndoScript,
} from './undo.js';
import {
  splitStatements, whereText, describeStatement, prefetchSelect, isDestructiveDdl, literalInsertKeys,
} from './sqlcapture.js';
import { keyColsFromDoc } from './adapters/adminer.js';
import { CATALOGS, LANGUAGES, setLang, t, missingKeys, clearMissingKeys } from './i18n.js';

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

/* ---------------------------------------------------------------------
 * 1. URL shape — the row identity comes from here, so a mistake in this
 *    file targets the wrong row rather than failing loudly.
 * ------------------------------------------------------------------- */
{
  const href = 'https://db.test/adminer.php?server=h1&username=root&db=shop&edit=orders'
    + '&where%5Bid%5D=42&null%5Bnote%5D=';
  const info = parseAdminerUrl(href);

  eq('edit page is recognised', info.page, 'edit');
  eq('the default driver is read from the server parameter', info.conn.driver, 'server');
  eq('and its value is the host', info.conn.server, 'h1');
  eq('table is read from the edit parameter', info.table, 'orders');
  eq('where value survives', info.where.id, '42');
  check('a null key column is null, not an empty string', info.where.note === null,
    JSON.stringify(info.where.note));
  eq('base drops the query string', info.base, 'https://db.test/adminer.php');

  const rebuilt = parseAdminerUrl(editUrl(info.base, info.conn, info.table, info.where));
  check('edit URL round-trips the predicate',
    rebuilt.where.id === '42' && rebuilt.where.note === null, JSON.stringify(rebuilt.where));
  eq('rebuilt URL keeps the connection', rebuilt.conn.db, 'shop');

  eq('select page is recognised',
    parseAdminerUrl('https://db.test/a.php?db=x&select=t').page, 'select');
  eq('an empty sql parameter still means the SQL page',
    parseAdminerUrl('https://db.test/a.php?db=x&sql=').page, 'sql');

  check('two databases on one host are different changesets',
    connKey('https://db.test', { server: 'h', db: 'a' }) !==
    connKey('https://db.test', { server: 'h', db: 'b' }));
  check('the same database over two origins is different too',
    connKey('https://a.test', { server: 'h', db: 'a' }) !==
    connKey('https://b.test', { server: 'h', db: 'a' }));
  check('label names host and database', connLabel({ server: 'h', db: 'shop' }).includes('shop'));

  // Adminer names the driver rather than passing it as a value: `?pgsql=host`,
  // `?sqlite=`, `?server=host` for MySQL. Getting this wrong sends every request
  // to the login screen, which parses perfectly well as "no rows found".
  const pg = parseAdminerUrl('https://db.test/a.php?pgsql=h2&username=postgres&db=shop&ns=public&select=t');
  eq('a non-default driver is read from the parameter name', pg.conn.driver, 'pgsql');
  eq('its value is the server', pg.conn.server, 'h2');
  eq('the schema is kept', pg.conn.ns, 'public');
  check('and it is written back the same way',
    buildUrl(pg.base, pg.conn, { sql: '' }) ===
    'https://db.test/a.php?pgsql=h2&username=postgres&db=shop&ns=public&sql=',
    buildUrl(pg.base, pg.conn, { sql: '' }));

  const lite = parseAdminerUrl('http://127.0.0.1/index.php?sqlite=&username=&db=test.db&sql=');
  eq('an empty driver value still names the driver', lite.conn.driver, 'sqlite');
  eq('an empty server stays empty', lite.conn.server, '');
  eq('sqlite round-trips exactly',
    buildUrl(lite.base, lite.conn, { sql: '' }),
    'http://127.0.0.1/index.php?sqlite=&username=&db=test.db&sql=');

  // A URL with no username must not gain one: it is part of who Adminer thinks
  // we are logged in as.
  const anon = parseAdminerUrl('https://db.test/a.php?server=h&db=d&sql=');
  check('a missing username stays missing', anon.conn.username === null);
  check('and is not invented when rebuilding',
    !buildUrl(anon.base, anon.conn, { sql: '' }).includes('username'),
    buildUrl(anon.base, anon.conn, { sql: '' }));
  check('an empty username is kept as empty',
    buildUrl(lite.base, lite.conn, { sql: '' }).includes('username='));
}

/* ---------------------------------------------------------------------
 * 2. Quoting — per engine, and the numeric shortcut that must not fire
 *    on text that only looks numeric.
 * ------------------------------------------------------------------- */
{
  eq('mysql identifier', quoteIdent('a`b', 'mysql'), '`a``b`');
  eq('pgsql identifier', quoteIdent('a"b', 'pgsql'), '"a""b"');
  eq('mssql identifier', quoteIdent('a]b', 'mssql'), '[a]]b]');
  eq('qualified table', quoteTable('t', 'pgsql', 'public'), '"public"."t"');

  eq('mysql escapes a backslash', quoteValue('a\\b', 'mysql'), "'a\\\\b'");
  eq('pgsql leaves a backslash alone', quoteValue('a\\b', 'pgsql'), "'a\\b'");
  eq('a quote is doubled', quoteValue("O'Brien", 'mysql'), "'O''Brien'");
  eq('null is NULL', quoteValue(null, 'mysql'), 'NULL');
  eq('the empty string is not NULL', quoteValue('', 'mysql'), "''");

  check('plain integers are unquoted', looksNumeric('42') && looksNumeric('-7') && looksNumeric('0'));
  check('a leading zero stays text', !looksNumeric('007'), 'a zip code or account number would be mangled');
  check('exponent notation stays text', !looksNumeric('1e5'));
  check('a padded number stays text', !looksNumeric(' 1 '));
  check('a plus sign stays text', !looksNumeric('+1'));
  eq('code 007 is quoted', quoteValue('007', 'mysql'), "'007'");

  eq('null in a predicate is IS NULL', whereClause({ a: null }, 'mysql'), '`a` IS NULL');
  eq('empty string in a predicate is an equality', whereClause({ a: '' }, 'mysql'), "`a` = ''");
  eq('an empty map yields no clause', whereClause({}, 'mysql'), '');

  eq('delete takes a limit guard only where it is legal',
    buildDelete('t', { a: '1' }, 'pgsql', '', 1), 'DELETE FROM "t" WHERE "a" = 1');
  check('mysql delete accepts the limit guard',
    buildDelete('t', { a: '1' }, 'mysql', '', 1).endsWith('LIMIT 1'));

  eq('driver names map to a quoting family', engineOf('mariadb'), 'mysql');
  eq('an unknown driver falls back to mysql', engineOf('nonsense'), 'mysql');
  eq('an empty driver means Adminer default', engineOf(''), 'mysql');
  eq('statements are terminated once', joinStatements(['A;', 'B']), 'A;\nB;');
}

/* ---------------------------------------------------------------------
 * 3. Undo generation.
 * ------------------------------------------------------------------- */
{
  const update = {
    op: 'update', table: 'm_generic', keyCols: ['id'],
    rows: [{ where: { id: '42' }, before: { value: 'A', note: null }, after: { value: 'B', note: 'x' } }],
  };
  eq('a plain update is undoable', blockingReason(update), '');
  eq('it restores both columns by the recorded key',
    undoStatements(update, 'mysql')[0],
    "UPDATE `m_generic` SET `value` = 'A', `note` = NULL WHERE `id` = 42");

  // The case the whole `undoWhere` exists for.
  const movedKey = {
    op: 'update', table: 't', keyCols: ['id'],
    rows: [{ where: { id: '1' }, before: { id: '1', v: 'a' }, after: { id: '2', v: 'b' } }],
  };
  eq('an edit that moved the key is looked up by its new value',
    undoWhere(movedKey.rows[0], movedKey.keyCols).id, '2');
  check('and it sets the old key back',
    undoStatements(movedKey, 'mysql')[0] === "UPDATE `t` SET `id` = 1, `v` = 'a' WHERE `id` = 2",
    undoStatements(movedKey, 'mysql')[0]);

  // A non-key column with the same name as a key column elsewhere must not be
  // swapped into the predicate.
  const nonKeyEdit = {
    op: 'update', table: 't', keyCols: ['id'],
    rows: [{ where: { id: '1' }, before: { v: 'a' }, after: { v: 'b' } }],
  };
  eq('a predicate untouched by the edit is left alone',
    undoWhere(nonKeyEdit.rows[0], nonKeyEdit.keyCols).id, '1');

  eq('null and the empty string are different changes',
    changedColumns({ before: { a: null }, after: { a: '' } }).length, 1);
  eq('a value retyped identically is no change',
    changedColumns({ before: { a: '1' }, after: { a: '1' } }).length, 0);
  check('sameValue compares as text, not by type', sameValue('1', 1));
  check('sameValue keeps null apart from empty', !sameValue(null, ''));

  const noChange = {
    op: 'update', table: 't', keyCols: ['id'],
    rows: [{ where: { id: '1' }, before: { a: 'x' }, after: { a: 'x' } }],
  };
  eq('a save that changed nothing produces no statement', undoStatements(noChange, 'mysql').length, 0);

  const del = {
    op: 'delete', table: 't', keyCols: ['id'],
    rows: [{ where: { id: '9' }, before: { id: '9', a: 'z', b: null }, after: null }],
  };
  eq('a delete is undone by re-inserting the whole row',
    undoStatements(del, 'pgsql')[0], 'INSERT INTO "t" ("id", "a", "b") VALUES (9, \'z\', NULL)');

  const ins = { op: 'insert', table: 't', keyCols: ['id'], rows: [{ where: { id: '5' }, before: null, after: {} }] };
  eq('an insert is undone by deleting the new row',
    undoStatements(ins, 'mysql')[0], 'DELETE FROM `t` WHERE `id` = 5');

  // Refusals.
  eq('a keyless table is refused',
    blockingReason({ op: 'update', table: 't', keyCols: [], rows: [{ where: {}, before: { a: '1' }, after: { a: '2' } }] }),
    'no-key');
  eq('an unknown operation is refused',
    blockingReason({ op: 'alter', table: 't', rows: [{ where: { id: '1' } }] }), 'unsupported-op');
  eq('a change with no rows is refused', blockingReason({ op: 'update', table: 't', rows: [] }), 'no-rows');
  eq('an unreadable column blocks the change',
    blockingReason({
      op: 'update', table: 't', keyCols: ['id'], unreadableCols: ['photo'],
      rows: [{ where: { id: '1' }, before: { a: '1' }, after: { a: '2' } }],
    }), 'unreadable-columns');

  // A bulk capture from the SQL page: no "after" at all, columns named explicitly.
  const bulk = {
    op: 'update', table: 'm_generic', keyCols: ['id'], restoreCols: ['value'],
    rows: [
      { where: { id: '1' }, before: { id: '1', value: 'A', other: 'keep' }, after: {} },
      { where: { id: '2' }, before: { id: '2', value: 'B', other: 'keep' }, after: {} },
    ],
  };
  eq('a bulk capture is undoable without an after', blockingReason(bulk), '');
  eq('it restores only the columns the statement wrote',
    undoStatements(bulk, 'mysql').join('\n'),
    "UPDATE `m_generic` SET `value` = 'A' WHERE `id` = 1\nUPDATE `m_generic` SET `value` = 'B' WHERE `id` = 2");
  eq('columnsToRestore ignores a named column the row never had',
    columnsToRestore({ restoreCols: ['value', 'missing'] }, bulk.rows[0]).length, 1);
  eq('a named column with nothing recorded is refused',
    blockingReason({ op: 'update', table: 't', keyCols: ['id'], restoreCols: ['x'],
      rows: [{ where: { id: '1' }, before: {}, after: {} }] }), 'nothing-to-restore');

  // Drift.
  eq('an untouched row reports no drift', driftOf(update, update.rows[0], { value: 'B', note: 'x' }).diffs.length, 0);
  eq('a changed column is reported', driftOf(update, update.rows[0], { value: 'Z', note: 'x' }).diffs[0].col, 'value');
  check('a vanished row is reported as missing', driftOf(update, update.rows[0], null).missing);
  check('a bulk capture cannot be drift-checked and says so', driftOf(bulk, bulk.rows[0], { value: 'Z' }).unknown);
  check('a column the change never wrote is not drift',
    driftOf(update, update.rows[0], { value: 'B', note: 'x', unrelated: 'new' }).diffs.length === 0);

  // Ordering: the newest change has to be undone first.
  const session = {
    conn: { driver: '' },
    changes: [
      { seq: 1, ...del, id: 'a' },
      { seq: 2, ...update, id: 'b' },
      { seq: 3, ...ins, id: 'c', undone: true },
    ],
  };
  const script = sessionUndoScript(session);
  check('rollback runs newest first', script[0].startsWith('UPDATE'), script[0]);
  eq('an already undone change is left out', script.length, 2);
}

/* ---------------------------------------------------------------------
 * 4. Reading a hand-written statement.
 * ------------------------------------------------------------------- */
{
  const both = splitStatements("UPDATE a SET x=';' WHERE id=1; DELETE FROM b WHERE y IN (SELECT z FROM c);");
  eq('a semicolon inside a string does not split', both.length, 2);
  check('the first statement is intact', both[0].includes("x=';'"), both[0]);

  const subquery = "UPDATE shop.m_generic g SET value='B' "
    + "WHERE g.id IN (SELECT x FROM y WHERE k=';') AND a=1 ORDER BY id LIMIT 3";
  const desc = describeStatement(subquery);
  eq('the table is read through its schema and alias', desc.table, 'm_generic');
  eq('the schema survives', desc.schema, 'shop');
  eq('the alias survives', desc.alias, 'g');
  eq('the written column is known', desc.setCols.join(','), 'value');
  // This is the assertion the module exists for: the predicate is the user's own
  // text, subquery and all, not a re-rendered approximation of it.
  eq('the predicate is lifted verbatim, subquery included',
    desc.where, "g.id IN (SELECT x FROM y WHERE k=';') AND a=1");
  check('ORDER BY and LIMIT are not swept into the predicate', !/ORDER BY/i.test(desc.where), desc.where);
  check('the statement is capturable', desc.capturable);

  eq('a WHERE-less delete is refused', describeStatement('DELETE FROM t').reason, 'no-where');
  eq('a multi-table update is refused',
    describeStatement('UPDATE a JOIN b ON a.id=b.id SET a.x=1 WHERE b.y=2').reason, 'multi-table');
  check('an insert is captured now — its key is found afterwards',
    describeStatement('INSERT INTO t (a) VALUES (1)').capturable);
  eq('a select is not a write', describeStatement('SELECT 1').reason, 'not-a-write');
  eq('unparsable text is reported as such', describeStatement('NOT SQL AT ALL ((').reason, 'parse-error');

  eq('a statement with no WHERE has no predicate text', whereText('UPDATE t SET a=1'), '');
  eq('a nested WHERE is not mistaken for the outer one',
    whereText('UPDATE t SET a=(SELECT max(b) FROM u WHERE u.c=1) WHERE t.d=2'), 't.d=2');

  eq('the snapshot asks for the key columns through the alias',
    prefetchSelect(desc, 'mysql', 200, ['id']),
    "SELECT `g`.`id` FROM `shop`.`m_generic` `g` WHERE g.id IN (SELECT x FROM y WHERE k=';') AND a=1 LIMIT 201");
  check('the row cap is fetched one over so overflow is detectable',
    prefetchSelect(describeStatement('DELETE FROM t WHERE a=1'), 'mysql', 5, ['id']).endsWith('LIMIT 6'));
  check('DDL is flagged', isDestructiveDdl('  truncate table t') && isDestructiveDdl('DROP TABLE t'));
  check('a plain update is not DDL', !isDestructiveDdl('UPDATE t SET a=1 WHERE b=2'));
}

/* ---------------------------------------------------------------------
 * 5. Key discovery from an edit link. The smallest fake document that
 *    exercises the real selector path.
 * ------------------------------------------------------------------- */
{
  const fakeDoc = (hrefs) => ({
    baseURI: 'https://db.test/adminer.php',
    querySelectorAll: () => hrefs.map((href) => ({ getAttribute: () => href })),
  });

  eq('a single-column key is read off the edit link',
    (keyColsFromDoc(fakeDoc(['?db=shop&edit=orders&where%5Bid%5D=7'])) || []).join(','), 'id');
  eq('a composite key keeps both columns',
    (keyColsFromDoc(fakeDoc(['?db=shop&edit=lines&where%5Border_id%5D=7&where%5Bline%5D=2'])) || []).join(','),
    'order_id,line');
  check('a link with no predicate yields no key',
    keyColsFromDoc(fakeDoc(['?db=shop&edit=orders'])) === null);
  check('an empty page yields no key', keyColsFromDoc(fakeDoc([])) === null);
}

/* ---------------------------------------------------------------------
 * 5b. Row identity as Adminer writes it — in the grid's `check[]` boxes and
 *     in its edit links. NULL key columns come as a list, `null[]=col`;
 *     a long text key comes as a hash that cannot go into an undo.
 * ------------------------------------------------------------------- */
{
  const real = parseAdminerUrl('https://db.test/a.php?server=h&db=d&edit=t&where%5Bid%5D=1&null%5B%5D=note');
  check('null[]=col — how Adminer actually sends a NULL key column — is read as that column',
    real.where.id === '1' && real.where.note === null && !('' in real.where), JSON.stringify(real.where));

  const url = editUrl('https://db.test/a.php', { driver: 'server', server: 'h', username: null, db: 'd', ns: '' },
    't', { id: '1', note: null, other: null });
  check('and it is written back as a list, one entry per column',
    url.includes('null%5B%5D=note') && url.includes('null%5B%5D=other') && !url.includes('null%5Bnote%5D'), url);

  eq('a column name with brackets is escaped the way Adminer does', bracketEscape('a[b]:c'), 'a:3b:2:1c');
  eq('and read back', unbracket(bracketEscape('a[b]:"c"')), 'a[b]:"c"');
  const odd = parseAdminerUrl(editUrl('https://db.test/a.php', { driver: 'sqlite', server: '', username: '', db: 'x', ns: '' },
    't', { 'a[1]': '5' }));
  eq('a bracketed column name round-trips through an edit URL', odd.where['a[1]'], '5');

  const v4 = parseRowIdf('where%5Bid%5D=42&where%5Bcode%5D=A%26B');
  check('a 4.x grid identity (URL-encoded) gives the predicate',
    v4.where.id === '42' && v4.where.code === 'A&B' && !v4.hashed.length, JSON.stringify(v4));
  const v5 = parseRowIdf('where[id]=42&null[]=note');
  check('a 5.x grid identity (brackets left bare) gives the same, NULL included',
    v5.where.id === '42' && v5.where.note === null, JSON.stringify(v5));
  const md5v4 = parseRowIdf('where%5BMD5%28%60body%60%29%5D=abc123&where%5Bid%5D=1');
  check('a 4.x hashed long-text key is flagged, not used as a column',
    md5v4.hashed.join() === 'body' && !Object.keys(md5v4.where).some((k) => k.includes('(')),
    JSON.stringify(md5v4));
  const md5v5 = parseRowIdf('fun[0]=md5&col[0]=body&val[0]=abc123&where[id]=1');
  check('a 5.x hashed key (fun/col/val) is flagged too',
    md5v5.hashed.join() === 'body' && md5v5.where.id === '1' && !('body' in md5v5.where), JSON.stringify(md5v5));
  eq('the identity is kept verbatim for fetching the row', parseRowIdf('&where[id]=1').raw, 'where[id]=1');
}

/* ---------------------------------------------------------------------
 * 5c. INSERT: undone by deleting the new row, which needs its key.
 * ------------------------------------------------------------------- */
{
  const desc = describeStatement("INSERT INTO m_generic (id, code, value) VALUES (7, 'X', NULL), (8, 'Y''s', 'z')");
  const keys = literalInsertKeys(desc, ['id']);
  check('keys spelled out as literals are read straight off the statement',
    keys && keys.length === 2 && keys[0].id === '7' && keys[1].id === '8', JSON.stringify(keys));
  check('a key column left out means the key is not known from the text',
    literalInsertKeys(describeStatement("INSERT INTO t (code) VALUES ('a')"), ['id']) === null);
  check('INSERT … SELECT names no rows',
    literalInsertKeys(describeStatement('INSERT INTO t SELECT * FROM u'), ['id']) === null);
  check('a key computed by an expression is not a literal',
    literalInsertKeys(describeStatement("INSERT INTO t (id, a) VALUES (1+1, 'x')"), ['id']) === null);
  check('a NULL key is not a key',
    literalInsertKeys(describeStatement("INSERT INTO t (id) VALUES (NULL)"), ['id']) === null);
  eq('column names match whatever their case',
    (literalInsertKeys(describeStatement('INSERT INTO t (ID, a) VALUES (3, 4)'), ['id']) || [])[0]?.id, '3');

  const ins = { op: 'insert', table: 'm_generic', keyCols: ['id'],
    rows: [{ where: { id: '7' }, before: null, after: { id: '7', code: 'X', value: null } }] };
  eq('an insert with its key is undone by deleting exactly that row',
    undoStatements(ins, 'mysql')[0], 'DELETE FROM `m_generic` WHERE `id` = 7');
  eq('and nothing blocks it', blockingReason(ins), '');
  eq('an insert whose key was never found says so, in its own words',
    blockingReason({ op: 'insert', table: 't', keyCols: [], rows: [{ where: {}, before: null, after: { a: '1' } }] }),
    'insert-key-unknown');
}

/* ---------------------------------------------------------------------
 * 5d. Whole-table snapshots and backup tables.
 * ------------------------------------------------------------------- */
{
  eq('snapshot select, mysql', snapshotSelect('m_generic', 'mysql', '', 5001, ['id']),
    'SELECT * FROM `m_generic` ORDER BY `id` LIMIT 5001');
  eq('snapshot select, mssql uses TOP', snapshotSelect('t', 'mssql', '', 10, ['id']),
    'SELECT TOP 10 * FROM [t] ORDER BY [id]');
  eq('snapshot select, oracle uses FETCH FIRST', snapshotSelect('t', 'oracle', '', 10, []),
    'SELECT * FROM "t" FETCH FIRST 10 ROWS ONLY');
  eq('key select asks for the key only', keysSelect('t', ['a', 'b'], 'pgsql', '', 3),
    'SELECT "a", "b" FROM "t" ORDER BY "a", "b" LIMIT 3');

  const snap = {
    keyCols: ['id'],
    columns: ['id', 'code', 'note', 'blob'],
    unreadable: ['blob'],
    rows: [
      { id: '1', code: 'A', note: null, blob: null },
      { id: '2', code: 'B', note: '', blob: null },
      { id: '3', code: 'C', note: 'x', blob: null },
    ],
  };
  const now = {
    columns: ['id', 'code', 'note', 'blob'],
    unreadable: ['blob'],
    rows: [
      { id: '1', code: 'A', note: '', blob: null },      // NULL became ''
      { id: '2', code: 'B', note: '', blob: null },      // untouched
      { id: '4', code: 'D', note: null, blob: null },    // inserted since
    ],                                                   // 3 deleted since
  };
  const diff = diffSnapshot(snap, now);
  eq('a row added since the snapshot is deleted', diff.deletes.map((d) => d.where.id).join(), '4');
  eq('a row removed since is inserted back', diff.inserts.map((i) => i.row.id).join(), '3');
  check('a NULL that became an empty string is a change, and is put back as NULL',
    diff.updates.length === 1 && diff.updates[0].where.id === '1' && diff.updates[0].set.note === null
      && Object.keys(diff.updates[0].set).join() === 'note', JSON.stringify(diff.updates));
  check('an unreadable column is not compared, and is listed as skipped',
    diff.skippedCols.includes('blob') && !diff.inserts[0].row.hasOwnProperty('blob'), JSON.stringify(diff));
  const sql = restoreStatements(diff, 'm_generic', 'mysql');
  check('deletes run first, then updates, then inserts — so unique values are free when needed',
    sql[0].startsWith('DELETE') && sql[1].startsWith('UPDATE') && sql[2].startsWith('INSERT'), sql.join(' | '));
  eq('the restored row keeps its NULL', sql[1], 'UPDATE `m_generic` SET `note` = NULL WHERE `id` = 1');
  check('an unchanged table needs nothing', diffIsEmpty(diffSnapshot(snap, { ...snap })));

  eq('no key, no diff', diffSnapshot({ ...snap, keyCols: [] }, now).reason, 'no-key');
  eq('duplicate keys are refused rather than guessed',
    diffSnapshot(snap, { ...now, rows: [...now.rows, { id: '4', code: 'E', note: null }] }).reason, 'duplicate-key');
  eq('a key column that cannot be read is refused',
    diffSnapshot({ ...snap, unreadable: ['id'] }, now).reason, 'key-not-compared');
  check('a column dropped since the snapshot is skipped, not written',
    diffSnapshot(snap, { ...now, columns: ['id', 'code', 'blob'] }).skippedCols.includes('note'));

  // An empty table reads back as "No rows." — no header, so no column list.
  const wasEmpty = diffSnapshot({ keyCols: ['id'], columns: [], rows: [], unreadable: [] },
    { columns: ['id', 'name'], rows: [{ id: '2', name: 'from app' }], unreadable: [] });
  check('a table that was empty when snapshotted is emptied again',
    !wasEmpty.reason && wasEmpty.deletes.length === 1 && wasEmpty.deletes[0].where.id === '2', JSON.stringify(wasEmpty));
  const nowEmpty = diffSnapshot({ keyCols: ['id'], columns: ['id', 'name'], rows: [{ id: '1', name: 'a' }], unreadable: [] },
    { columns: [], rows: [], unreadable: [] });
  check('a table emptied since the snapshot gets its rows back',
    !nowEmpty.reason && nowEmpty.inserts.length === 1 && nowEmpty.inserts[0].row.name === 'a', JSON.stringify(nowEmpty));

  const before = [keyOf({ id: '1' }, ['id']), keyOf({ id: '2' }, ['id'])];
  eq('new rows are the ones whose key was not there before',
    newRows(before, [{ id: '1' }, { id: '2' }, { id: '9' }], ['id']).map((r) => r.id).join(), '9');
  eq('key comparison keeps NULL apart from the text "null"',
    newRows([keyOf({ id: null }, ['id'])], [{ id: 'null' }], ['id']).length, 1);
  eq('a key predicate from a row', JSON.stringify(keyWhere({ a: '1', b: null, c: 'x' }, ['a', 'b'])), '{"a":"1","b":null}');

  const when = new Date(2026, 8, 19, 14, 5, 9);
  eq('a backup is named after the table and the moment', backupName('m_generic', when, 'mysql'),
    'm_generic_bak_20260919_140509');
  const long = backupName('x'.repeat(80), when, 'pgsql');
  check('a long name is cut from the table end, never the timestamp',
    long.length === 63 && long.endsWith('_bak_20260919_140509'), long);
  check('oracle keeps within 30', backupName('a_long_master_table', when, 'oracle').length <= 30);
  eq('backup is CREATE TABLE AS', backupCreateSql('t', 't_bak', 'mysql'), 'CREATE TABLE `t_bak` AS SELECT * FROM `t`');
  eq('except in SQL Server, which uses SELECT INTO', backupCreateSql('t', 't_bak', 'mssql'),
    'SELECT * INTO [t_bak] FROM [t]');
  eq('wholesale restore empties then copies back', backupRestoreSql('t', 't_bak', 'pgsql').join('; '),
    'DELETE FROM "t"; INSERT INTO "t" SELECT * FROM "t_bak"');
  eq('drop', backupDropSql('t_bak', 'sqlite'), 'DROP TABLE "t_bak"');
}

/* ---------------------------------------------------------------------
 * 6. Translation catalogs. A missing key degrades to the key itself, which
 *    is how `reason.no-key` ends up on screen instead of a sentence.
 * ------------------------------------------------------------------- */
{
  const viKeys = Object.keys(CATALOGS.vi).sort();
  const enKeys = Object.keys(CATALOGS.en).sort();
  eq('both catalogs hold the same keys', viKeys.join(','), enKeys.join(','));

  const placeholders = (text) => (text.match(/\{(\w+)\}/g) || []).sort().join(',');
  for (const key of viKeys) {
    check(`placeholders match for ${key}`,
      placeholders(CATALOGS.vi[key]) === placeholders(CATALOGS.en[key]),
      `${CATALOGS.vi[key]} / ${CATALOGS.en[key]}`);
  }

  // Every reason code the code can produce must have a sentence in both.
  const REASONS = [
    'no-key', 'no-before', 'nothing-to-restore', 'no-rows', 'no-table', 'unsupported-op',
    'unreadable-columns', 'multi-table', 'no-where', 'insert-not-captured', 'parse-error', 'not-a-write',
    'insert-key-unknown', 'too-many-rows', 'import-not-captured',
  ];
  for (const lang of LANGUAGES) {
    setLang(lang);
    clearMissingKeys();
    for (const reason of REASONS) t(`reason.${reason}`);
    for (const op of ['update', 'delete', 'insert']) t(`op.${op}`);
    for (const key of viKeys) t(key);
    eq(`no key is missing in ${lang}`, missingKeys().join(','), '');
  }

  setLang('vi');
  eq('placeholders are filled', t('panel.changes', { n: 3 }), '3 thay đổi');
  setLang('en');
  eq('and in English too', t('panel.changes', { n: 3 }), '3 change(s)');
  eq('an unknown key degrades to itself', t('nope.nope'), 'nope.nope');
}

/* ------------------------------------------------------------------- */

if (failures.length) {
  console.error(`\n${failures.length} FAILED, ${passed} passed:\n`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`All ${passed} checks passed.`);
