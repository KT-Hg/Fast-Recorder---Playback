/**
 * sqlcapture.js — understanding a statement typed into the SQL command page.
 *
 * The edit form hands us the old values for free. A hand-written
 * `UPDATE m_generic SET …  WHERE …` does not, and that is the statement people
 * actually reach for when a test needs twenty rows changed — so the rows it is
 * about have to be read *before* it runs.
 *
 * To do that we need two things out of the text: which table it writes, and the
 * exact predicate that selects the rows. The repo already parses SQL
 * (`sqlcases/parser.js`), and that answers the first. It cannot answer the
 * second: `exprToSql` renders a subquery as the literal text `(SELECT …)`,
 * because it exists to describe a predicate to a human, not to re-execute one.
 * Re-running that against the database would silently select the wrong rows.
 *
 * So the predicate is taken from the source text instead, by offset: the tokens
 * carry `start`/`end`, so the slice between the top-level `WHERE` and whatever
 * clause ends it is the user's own predicate, character for character, subqueries
 * and all. The parser is used for structure, the tokenizer for text, and neither
 * is asked to do the other's job.
 *
 * What this module refuses to capture is as important as what it captures — a
 * multi-table UPDATE, a statement with no WHERE, an INSERT whose new rows cannot
 * be named. Those come back with `capturable: false` and a reason, and the panel
 * says so rather than recording a change it could not undo.
 */

import { tokenize } from '../sqlcases/tokenizer.js';
import { parse } from '../sqlcases/parser.js';
import { quoteTable, quoteIdent } from './sqlquote.js';

/** Clause keywords that end a WHERE at the top level of a statement. */
const WHERE_END = new Set(['ORDER', 'LIMIT', 'OFFSET', 'FETCH', 'RETURNING', 'GROUP', 'HAVING', 'WINDOW']);

/** Split on top-level `;` — a semicolon inside a string or parens is not one. */
export function splitStatements(sql) {
  const { tokens } = tokenize(sql);
  const out = [];
  let depth = 0;
  let start = 0;
  for (const tok of tokens) {
    if (tok.type === 'punct' && tok.value === '(') depth++;
    else if (tok.type === 'punct' && tok.value === ')') depth--;
    else if (tok.type === 'punct' && tok.value === ';' && depth === 0) {
      const text = sql.slice(start, tok.start).trim();
      if (text) out.push(text);
      start = tok.end;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/** The raw text of the top-level WHERE clause, or '' when there is none. */
export function whereText(sql) {
  const { tokens } = tokenize(sql);
  let depth = 0;
  let from = -1;
  for (const tok of tokens) {
    if (tok.type === 'punct' && tok.value === '(') { depth++; continue; }
    if (tok.type === 'punct' && tok.value === ')') { depth--; continue; }
    if (depth !== 0 || tok.type !== 'word' || !tok.keyword) continue;

    if (from === -1) {
      if (tok.upper === 'WHERE') from = tok.end;
    } else if (WHERE_END.has(tok.upper)) {
      return sql.slice(from, tok.start).trim();
    }
  }
  return from === -1 ? '' : sql.slice(from).trim();
}

/**
 * What one statement is and whether its rows can be snapshotted first.
 *
 * `capturable` is about the snapshot, not about danger: a `DELETE` with no
 * WHERE is perfectly capturable in the sense that we could read the whole table,
 * but it is refused here because doing so quietly is the wrong answer — the
 * caller warns instead.
 */
export function describeStatement(sql) {
  const { ast, errors } = parse(sql);
  if (!ast) {
    return { kind: 'other', capturable: false, reason: 'parse-error', errors };
  }

  const kind = ast.type;
  if (kind !== 'update' && kind !== 'delete' && kind !== 'insert') {
    return { kind, capturable: false, reason: 'not-a-write' };
  }

  const ref = ast.table || {};
  const desc = {
    kind,
    sql,
    table: ref.name || '',
    schema: ref.schema || '',
    alias: ref.alias || '',
    where: whereText(sql),
    setCols: kind === 'update' ? (ast.set || []).map((s) => s.column) : [],
    joins: (ast.joins || []).length,
    capturable: false,
    reason: '',
  };

  if (kind === 'insert') {
    desc.insertColumns = ast.columns || [];
    desc.insertRows = (ast.rows || []).map((row) => row.map(literalOf));
    desc.insertSelect = Boolean(ast.select);
  }

  if (!desc.table)                     desc.reason = 'no-table';
  else if (desc.joins)                 desc.reason = 'multi-table';
  else if (kind === 'insert')          desc.capturable = true;
  else if (!desc.where)                desc.reason = 'no-where';
  else                                 desc.capturable = true;

  return desc;
}

/**
 * A literal's value as the database will store it, or `undefined` when the
 * expression is not a plain literal (a function call, DEFAULT, arithmetic).
 * Numbers keep their source spelling, so `7.50` stays `7.50`.
 */
function literalOf(expr) {
  if (!expr || expr.type !== 'literal') return undefined;
  if (expr.kind === 'null') return null;
  if (expr.kind === 'number') return String(expr.raw ?? expr.value);
  if (expr.kind === 'string') return String(expr.value);
  return undefined;
}

/**
 * The keys an INSERT names outright: one `{ col: value }` per row, when the
 * statement lists every key column and gives each a literal. Anything else — an
 * auto-increment key left out, `INSERT … SELECT`, a key computed by an expression —
 * returns null, and the caller finds the new rows by comparing the table's keys
 * before and after instead.
 */
export function literalInsertKeys(desc, keyCols) {
  if (!desc || desc.kind !== 'insert' || desc.insertSelect) return null;
  if (!keyCols || !keyCols.length || !desc.insertColumns.length || !desc.insertRows.length) return null;
  const index = keyCols.map((col) => desc.insertColumns.findIndex((c) => c.toLowerCase() === col.toLowerCase()));
  if (index.some((i) => i < 0)) return null;
  const out = [];
  for (const row of desc.insertRows) {
    const where = {};
    for (let k = 0; k < keyCols.length; k++) {
      const value = row[index[k]];
      if (value === undefined || value === null) return null;
      where[keyCols[k]] = value;
    }
    out.push(where);
  }
  return out;
}

/**
 * The SELECT that identifies the rows a statement is about.
 *
 * It asks for the key columns only, never `SELECT *`. Adminer shortens long text
 * in a result grid, and a shortened value read back as if it were the whole one
 * would corrupt the row it was meant to protect — so the grid is used to learn
 * *which* rows are affected, and each row's actual values are then read through
 * its edit form, where nothing is abbreviated.
 *
 * The alias is carried over, because the predicate text may be written in terms
 * of it (`WHERE g.id = 3`), and `limit` is a guard: a statement that turns out to
 * touch more rows than the caller is willing to store should be reported, not
 * half-recorded.
 */
export function prefetchSelect(desc, engine = 'mysql', limit = 0, columns = []) {
  const table = quoteTable(desc.table, engine, desc.schema);
  const alias = desc.alias ? ` ${quoteIdent(desc.alias, engine)}` : '';
  const prefix = desc.alias ? `${quoteIdent(desc.alias, engine)}.` : '';
  const cols = columns.length ? columns.map((c) => prefix + quoteIdent(c, engine)).join(', ') : '*';
  let sql = `SELECT ${cols} FROM ${table}${alias} WHERE ${desc.where}`;
  if (limit && (engine === 'mysql' || engine === 'pgsql' || engine === 'sqlite')) {
    sql += ` LIMIT ${limit + 1}`;   // one over, so "too many" is detectable
  }
  return sql;
}

/**
 * Statements that change data without being reversible from a row snapshot.
 * Used for the warning the panel shows, not for blocking.
 */
export function isDestructiveDdl(sql) {
  return /^\s*(DROP|TRUNCATE|ALTER|CREATE|RENAME)\b/i.test(sql);
}
