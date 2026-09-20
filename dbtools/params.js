/**
 * params.js — reading and writing the URL shape Adminer uses.
 *
 * Every Adminer page is one script with its state in the query string:
 *
 *   ?server=db.local&username=root&db=shop&edit=orders&where%5Bid%5D=42
 *   ?pgsql=db.local&username=postgres&db=shop&ns=public&select=orders
 *   ?sqlite=&username=&db=data.db&sql=
 *
 * The driver is the *name* of the first parameter, not a value: Adminer emits
 * `DRIVER=SERVER`, with `server` standing for MySQL. So a URL is read by looking
 * for whichever driver key is present, and rebuilt the same way — get that wrong
 * and every request this feature makes lands on the login screen, which parses
 * perfectly well as "no rows found".
 *
 * Two groups matter here. The connection (`driver/server/username/db/ns`) is what
 * a changeset is keyed by — a rollback must never be offered against a different
 * database than the one it was recorded on. And `where[col]=val` is the row
 * identity Adminer itself computed from the primary or unique key; it is exactly
 * the predicate an undo statement needs, so it is read off the URL rather than
 * guessed from the row.
 *
 * NULL key values arrive in a second bag: Adminer sends `null[col]=` alongside
 * `where[col]=` when the key column is NULL, because an empty `where` value and
 * a NULL one are different rows. Both are folded into one map here, with null
 * represented as JS `null` and the empty string kept as `''`.
 *
 * Nothing in this file touches the DOM, so it is testable under Node.
 */

/**
 * Every driver Adminer can be logged in with. Order matters only in that the
 * first one present wins; a URL never carries two.
 */
export const DRIVER_KEYS = [
  'server', 'sqlite', 'sqlite2', 'pgsql', 'oracle', 'mssql',
  'mongo', 'elastic', 'firebird', 'clickhouse', 'simpledb',
];

/**
 * Adminer's `bracket_escape`: a column name goes inside `where[…]`, so the
 * characters that would end or confuse the brackets are replaced. Reversed here
 * so a column called `a[b]` is not read back as `a:3b:2`.
 */
const BRACKET = [[':', ':1'], [']', ':2'], ['[', ':3'], ['"', ':4']];

export function bracketEscape(name) {
  let out = '';
  for (const ch of String(name)) {
    const hit = BRACKET.find(([raw]) => raw === ch);
    out += hit ? hit[1] : ch;
  }
  return out;
}

export function unbracket(name) {
  return String(name).replace(/:([1-4])/g, (_m, d) => BRACKET[Number(d) - 1][0]);
}

/** Pull `name[key]` style parameters out of a URLSearchParams into a plain map. */
function bag(sp, prefix) {
  const out = {};
  for (const [rawKey, value] of sp.entries()) {
    if (!rawKey.startsWith(prefix + '[') || !rawKey.endsWith(']')) continue;
    const key = rawKey.slice(prefix.length + 1, -1);
    if (key) out[unbracket(key)] = value;
  }
  return out;
}

/**
 * The columns a URL says are NULL.
 *
 * Adminer sends them as a list — `null[]=col` — because a NULL has no value to
 * put in `where[col]=`. `null[col]=` is accepted too, for identities written
 * before this was read correctly.
 */
function nullCols(sp) {
  const out = [];
  for (const [rawKey, value] of sp.entries()) {
    if (!rawKey.startsWith('null[') || !rawKey.endsWith(']')) continue;
    const inner = rawKey.slice(5, -1);
    if (inner === '' || /^\d+$/.test(inner)) { if (value !== '') out.push(value); }
    else out.push(unbracket(inner));
  }
  return out;
}

/**
 * Parse an Adminer URL into { base, conn, page, table, where }.
 *
 * `base` is the script URL with no query string, which every fetch this feature
 * makes is built from.
 */
export function parseAdminerUrl(href) {
  const url = new URL(href);
  const sp = url.searchParams;

  let driver = '';
  let server = '';
  for (const key of DRIVER_KEYS) {
    if (!sp.has(key)) continue;
    driver = key;
    server = sp.get(key) || '';
    break;
  }

  const conn = {
    driver,
    server,
    // Absent and empty are different: Adminer only carries `username` when it has
    // one, and adding it back on a URL that never had it changes who we are.
    username: sp.has('username') ? sp.get('username') : null,
    db: sp.get('db') || '',
    ns: sp.get('ns') || '',
  };

  // The page kind is encoded as which parameter is present at all, so an empty
  // value still counts: `?sql=` is the SQL command page.
  let page = 'other';
  let table = '';
  if (sp.has('edit'))        { page = 'edit';      table = sp.get('edit')   || ''; }
  else if (sp.has('select')) { page = 'select';    table = sp.get('select') || ''; }
  else if (sp.has('sql'))    { page = 'sql'; }
  else if (sp.has('table'))  { page = 'structure'; table = sp.get('table')  || ''; }

  const where = bag(sp, 'where');
  for (const col of nullCols(sp)) where[col] = null;

  return {
    base: url.origin + url.pathname,
    origin: url.origin,
    conn,
    page,
    table,
    where,
    hasWhere: sp.toString().includes('where%5B') || sp.toString().includes('where['),
  };
}

/** Write the connection back out in Adminer's own `DRIVER=SERVER` shape. */
function writeConn(sp, conn) {
  if (!conn) return;
  sp.set(conn.driver || 'server', conn.server || '');
  if (conn.username !== null && conn.username !== undefined) sp.set('username', conn.username);
  if (conn.db) sp.set('db', conn.db);
  if (conn.ns) sp.set('ns', conn.ns);
}

/** Build an Adminer URL: base + connection + the page-specific parameters. */
export function buildUrl(base, conn, extra = {}) {
  const sp = new URLSearchParams();
  writeConn(sp, conn);
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    sp.set(key, value === null ? '' : String(value));
  }
  return `${base}?${sp.toString()}`;
}

/** Build the `?edit=…&where[…]=…` URL for one row. */
export function editUrl(base, conn, table, where) {
  const sp = new URLSearchParams();
  writeConn(sp, conn);
  sp.set('edit', table);
  for (const [col, value] of Object.entries(where || {})) {
    if (value === null) sp.append('null[]', col);
    else sp.set(`where[${bracketEscape(col)}]`, String(value));
  }
  return `${base}?${sp.toString()}`;
}

/**
 * The edit URL for a row named by Adminer's own identity string — the value of
 * its `check[]` box in the grid. Used verbatim rather than rebuilt, because for
 * a long text key it is not a value at all but a hash (see parseRowIdf).
 */
export function editUrlIdf(base, conn, table, idf) {
  return `${buildUrl(base, conn, { edit: table })}&${String(idf).replace(/^&/, '')}`;
}

/**
 * Read the identity Adminer gives a row in the grid.
 *
 * It is the query-string tail of the row's edit link: `where[id]=42`, plus
 * `null[]=col` for a NULL key column. A text key longer than 64 characters is
 * sent as a hash instead — `where[MD5(`col`)]=…` in 4.x, `fun[0]=md5&col[0]=col
 * &val[0]=…` in 5.x — which can find the row but cannot be put in an undo
 * statement. Those columns come back in `hashed`, and the caller fills them in
 * from the row once it has read it.
 */
export function parseRowIdf(idf) {
  const sp = new URLSearchParams(String(idf || '').replace(/^&/, ''));
  const where = {};
  const hashed = [];
  for (const [col, value] of Object.entries(bag(sp, 'where'))) {
    const inner = /^[A-Z_][A-Z0-9_]*\((.*)\)$/i.exec(col);
    if (inner) {
      const name = /[`"[]((?:[^`"\]]|``|"")+)[`"\]]/.exec(inner[1]);
      hashed.push(name ? name[1].replace(/``/g, '`').replace(/""/g, '"') : inner[1]);
    } else {
      where[col] = value;
    }
  }
  for (const col of nullCols(sp)) where[col] = null;
  for (const [i, col] of Object.entries(bag(sp, 'col'))) {
    if (sp.has(`fun[${i}]`)) hashed.push(col);
  }
  return { where, hashed, raw: String(idf || '').replace(/^&/, '') };
}

/**
 * The key a changeset is stored under. Two Adminer installs pointed at the same
 * database are the same target; the same install pointed at two databases is not.
 */
export function connKey(origin, conn) {
  return [origin, conn.driver || 'server', conn.server || '', conn.db || '', conn.ns || ''].join('|');
}

/** Human-readable connection label for the panel and the manager page. */
export function connLabel(conn) {
  const host = conn.server || 'localhost';
  const db = conn.ns ? `${conn.db}.${conn.ns}` : conn.db;
  return db ? `${host} / ${db}` : host;
}
