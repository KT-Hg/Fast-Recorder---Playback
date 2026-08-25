/**
 * tokenizer.js — SQL lexer.
 *
 * Turns raw SQL text into a flat token list the parser can walk. It is
 * dialect-tolerant on purpose: MySQL backticks, SQL Server brackets and
 * ANSI double quotes are all accepted as quoted identifiers, and the four
 * common parameter markers (?, :name, @name, $1) all become PARAM tokens so
 * that a query written for any of those drivers still analyses.
 *
 * Comments are dropped; every other token keeps its source offset so the UI
 * can point at the exact character when parsing fails.
 */

/** Words that may never be treated as a bare identifier by the parser. */
export const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET',
  'FETCH', 'FIRST', 'NEXT', 'ROWS', 'ONLY', 'TOP', 'DISTINCT', 'ALL', 'AS',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL', 'ON', 'USING',
  'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'ILIKE', 'BETWEEN', 'EXISTS',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'CAST', 'WITH', 'RECURSIVE',
  'UNION', 'INTERSECT', 'EXCEPT',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'TRUE', 'FALSE', 'UNKNOWN', 'ASC', 'DESC', 'NULLS', 'LAST', 'ESCAPE',
  'RETURNING', 'DUPLICATE', 'KEY', 'IGNORE', 'DEFAULT', 'INTERVAL'
]);

/** Multi-character operators, longest first so that `<=` wins over `<`. */
const OPERATORS = ['<=>', '!=', '<>', '>=', '<=', '||', '::', '=', '<', '>', '+', '-', '*', '/', '%'];

const PUNCT = new Set(['(', ')', ',', ';', '.']);

/** One lexical unit. `type` is one of the TOK_* values below. */
export const TOK = {
  WORD: 'word',       // identifier or keyword (see `keyword` flag)
  STRING: 'string',   // 'literal'
  NUMBER: 'number',
  PARAM: 'param',     // ? :name @name $1
  OP: 'op',
  PUNCT: 'punct',
  EOF: 'eof'
};

function isDigit(c) { return c >= '0' && c <= '9'; }
function isIdentStart(c) { return /[A-Za-z_#]/.test(c); }
function isIdentPart(c) { return /[A-Za-z0-9_$#]/.test(c); }

/**
 * Lex `sql` into tokens.
 *
 * Unterminated strings and comments are not fatal — they yield a token that
 * runs to end-of-input, so the parser reports a structural error at a sane
 * position instead of the lexer throwing on a half-typed query.
 *
 * @param {string} sql
 * @returns {{tokens: Array, errors: Array<{message: string, pos: number}>}}
 */
export function tokenize(sql) {
  const tokens = [];
  const errors = [];
  let i = 0;
  const n = sql.length;

  const push = (type, value, start, extra) => {
    tokens.push({ type, value, start, end: i, ...(extra || {}) });
  };

  // `?` markers have no name, so they are numbered in source order: that
  // ordinal is the only thing that can tell the first one from the second.
  let anonParams = 0;

  while (i < n) {
    const c = sql[i];

    // --- whitespace ---
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }

    // --- line comment ---
    if ((c === '-' && sql[i + 1] === '-') || c === '#') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }

    // --- block comment ---
    if (c === '/' && sql[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      if (i >= n) errors.push({ message: 'Unterminated block comment', pos: start });
      else i += 2;
      continue;
    }

    // --- string literal (doubled quote escapes, backslash escape for MySQL) ---
    if (c === "'") {
      const start = i;
      i++;
      let val = '';
      while (i < n) {
        if (sql[i] === '\\' && i + 1 < n) { val += sql[i + 1]; i += 2; continue; }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { val += "'"; i += 2; continue; }
          i++;
          break;
        }
        val += sql[i++];
      }
      if (i > n) errors.push({ message: 'Unterminated string literal', pos: start });
      push(TOK.STRING, val, start);
      continue;
    }

    // --- quoted identifier: "x" `x` [x] ---
    if (c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      const start = i;
      i++;
      let val = '';
      while (i < n && sql[i] !== close) val += sql[i++];
      if (i >= n) errors.push({ message: 'Unterminated quoted identifier', pos: start });
      else i++;
      push(TOK.WORD, val, start, { keyword: false, quoted: true });
      continue;
    }

    // --- number (int, decimal, exponent) ---
    if (isDigit(c) || (c === '.' && isDigit(sql[i + 1]))) {
      const start = i;
      while (i < n && isDigit(sql[i])) i++;
      if (sql[i] === '.') { i++; while (i < n && isDigit(sql[i])) i++; }
      if (sql[i] === 'e' || sql[i] === 'E') {
        const save = i;
        i++;
        if (sql[i] === '+' || sql[i] === '-') i++;
        if (isDigit(sql[i])) { while (i < n && isDigit(sql[i])) i++; }
        else i = save;
      }
      push(TOK.NUMBER, sql.slice(start, i), start);
      continue;
    }

    // --- bind parameters ---
    if (c === '?') { const s = i; i++; push(TOK.PARAM, '?', s, { ordinal: ++anonParams }); continue; }
    if ((c === ':' || c === '@' || c === '$') && isIdentPart(sql[i + 1] || '')) {
      const start = i;
      i++;
      while (i < n && isIdentPart(sql[i])) i++;
      push(TOK.PARAM, sql.slice(start, i), start);
      continue;
    }

    // --- identifier / keyword ---
    if (isIdentStart(c)) {
      const start = i;
      while (i < n && isIdentPart(sql[i])) i++;
      const raw = sql.slice(start, i);
      const upper = raw.toUpperCase();
      push(TOK.WORD, raw, start, { keyword: KEYWORDS.has(upper), upper });
      continue;
    }

    // --- operators ---
    const op = OPERATORS.find(o => sql.startsWith(o, i));
    if (op) { const s = i; i += op.length; push(TOK.OP, op, s); continue; }

    // --- punctuation ---
    if (PUNCT.has(c)) { const s = i; i++; push(TOK.PUNCT, c, s); continue; }

    errors.push({ message: `Unexpected character "${c}"`, pos: i });
    i++;
  }

  tokens.push({ type: TOK.EOF, value: '', start: n, end: n, upper: '' });
  return { tokens, errors };
}
