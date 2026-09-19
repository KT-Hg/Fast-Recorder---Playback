/**
 * executor.js — talking to Adminer without leaving the page.
 *
 * Everything this feature needs beyond what is on screen — reading a row back to
 * check for drift, finding out which columns key a table, running the rollback
 * itself — is done by fetching Adminer's own pages from the content script and
 * parsing the result. Same origin, so the session cookie rides along and no
 * credential is ever handled here.
 *
 * Two decisions worth stating.
 *
 * The rollback runs as SQL through the SQL command page, not by replaying the
 * edit form. Replaying the form would avoid the quoting problem entirely, but
 * then what executes is not what the preview showed — and a rollback the user
 * cannot read before it runs is not one they can trust.
 *
 * Reading a row back, on the other hand, goes through the *edit form* rather than
 * a SELECT, because `readEditForm` already distinguishes NULL from an empty
 * string exactly the way the capture did. Parsing a result grid for that would
 * be a second, subtly different reader of the same fact.
 *
 * The CSRF token is re-read from a freshly fetched page instead of being cached:
 * Adminer rotates it, and a stale token turns a rollback into a silent no-op.
 */

import { buildUrl, editUrl } from './params.js';
import * as adminer from './adapters/adminer.js';

function parseHtml(text) {
  return new DOMParser().parseFromString(text, 'text/html');
}

async function fetchDoc(url) {
  const res = await fetch(url, { credentials: 'same-origin', redirect: 'follow' });
  // Every caller runs inside an Adminer tab, so this is a same-origin request and
  // the session cookie rides along untouched. That is also why rollback is driven
  // from the content script rather than from the extension page: a fetch from the
  // extension's own origin is cross-site, and a SameSite=Lax session cookie — what
  // PHP hands out by default — would simply not be sent.
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseHtml(await res.text());
}

/** The SQL command page URL for this connection. */
function sqlUrl(ctx) {
  return buildUrl(ctx.base, ctx.conn, { sql: '' });
}

/**
 * Run one statement (or several, separated by `;`) and report what Adminer said.
 *
 * Returns { ok, errors, messages, affected, doc }. `ok` is false as soon as
 * Adminer rendered an error, because it renders one per failed statement.
 */
export async function runSql(ctx, sql) {
  const url = sqlUrl(ctx);
  const page = await fetchDoc(url);
  const token = adminer.readToken(page);
  if (!token) return { ok: false, errors: ['no-token'], messages: [], affected: null, doc: page };

  const body = new URLSearchParams();
  body.set('query', sql);
  body.set('token', token);
  body.set('error_stops', '1');   // stop at the first failure rather than ploughing on

  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) return { ok: false, errors: [`HTTP ${res.status}`], messages: [], affected: null, doc: null };

  const doc = parseHtml(await res.text());
  const errors = adminer.readErrors(doc);
  return {
    ok: errors.length === 0,
    errors,
    messages: adminer.readMessages(doc),
    affected: adminer.affectedRows(doc),
    doc,
  };
}

/** Run a SELECT and hand back its grid. */
export async function selectRows(ctx, sql) {
  const result = await runSql(ctx, sql);
  if (!result.ok) return { ok: false, errors: result.errors, rows: [], columns: [] };
  const table = result.doc ? adminer.parseResultTable(result.doc) : { ok: false, reason: 'no-doc' };
  if (!table.ok) return { ok: false, errors: [table.reason], rows: [], columns: [] };
  return { ok: true, errors: [], columns: table.columns, rows: table.rows };
}

/**
 * Read one row through its edit form.
 *
 * `null` means the row is not there any more — which is itself an answer the
 * drift check needs, so it is distinguished from a parse failure.
 */
export async function readRow(ctx, table, where) {
  const doc = await fetchDoc(editUrl(ctx.base, ctx.conn, table, where));
  if (adminer.readErrors(doc).length) return { ok: false, reason: 'error-page', values: null };
  const form = adminer.readEditForm(doc);
  if (!form.ok) return { ok: false, reason: form.reason, values: null };
  return { ok: true, values: form.values };
}

/**
 * Which columns identify a row in this table.
 *
 * Asked of the select page, where Adminer has already computed the answer for
 * every row it renders. An empty table has no edit links and so no answer — the
 * caller treats that as "unknown" and refuses to build an undo predicate from it.
 */
export async function discoverKeyCols(ctx, table) {
  const doc = await fetchDoc(buildUrl(ctx.base, ctx.conn, { select: table, limit: '1' }));
  const cols = adminer.keyColsFromDoc(doc);
  return cols && cols.length ? cols : null;
}
