/**
 * parser.js — Recursive-descent parser for the SELECT/INSERT/UPDATE/DELETE subset.
 *
 * Scope is deliberate: this exists to feed the test-case generator, not to
 * validate SQL. So it parses the shapes that carry testable behaviour —
 * join kinds, predicate trees, grouping, ordering, paging, written columns —
 * and skips over anything else it meets rather than failing the whole query.
 * A vendor hint like `SQL_CALC_FOUND_ROWS` or a windowing clause it does not
 * model becomes a warning, and analysis continues.
 *
 * Precedence, lowest binding first:
 *   OR → AND → NOT → comparison/IS/IN/LIKE/BETWEEN → + - → * / % → unary → primary
 */

import { tokenize, TOK } from './tokenizer.js';

/** Thrown internally on an unrecoverable structural error; caught by parse(). */
class ParseError extends Error {
  constructor(message, pos) {
    super(message);
    this.pos = pos;
  }
}

const COMPARISON_OPS = new Set(['=', '!=', '<>', '<', '<=', '>', '>=', '<=>']);
const JOIN_LEAD = new Set(['JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL']);

/**
 * Words that may follow an INTERVAL amount as its unit — singular, plural and
 * the MySQL compound forms. Anything else after INTERVAL belongs to the next
 * clause and must be left alone.
 */
const INTERVAL_UNITS = new Set([
  'MICROSECOND', 'MILLISECOND', 'SECOND', 'MINUTE', 'HOUR', 'DAY', 'WEEK',
  'MONTH', 'QUARTER', 'YEAR', 'DECADE', 'CENTURY', 'MILLENNIUM',
  'MICROSECONDS', 'MILLISECONDS', 'SECONDS', 'MINUTES', 'HOURS', 'DAYS', 'WEEKS',
  'MONTHS', 'QUARTERS', 'YEARS', 'DECADES', 'CENTURIES', 'MILLENNIA',
  'SECOND_MICROSECOND', 'MINUTE_MICROSECOND', 'MINUTE_SECOND',
  'HOUR_MICROSECOND', 'HOUR_SECOND', 'HOUR_MINUTE',
  'DAY_MICROSECOND', 'DAY_SECOND', 'DAY_MINUTE', 'DAY_HOUR', 'YEAR_MONTH'
]);

/** Clause keywords that end a FROM item or an expression list. */
const CLAUSE_STOP = new Set([
  'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH', 'UNION',
  'INTERSECT', 'EXCEPT', 'ON', 'USING', 'SET', 'VALUES', 'RETURNING', 'INTO', 'WINDOW'
]);

class Parser {
  constructor(tokens) {
    this.toks = tokens;
    this.i = 0;
    this.warnings = [];
  }

  // ---- token helpers -------------------------------------------------

  peek(offset = 0) { return this.toks[Math.min(this.i + offset, this.toks.length - 1)]; }
  get cur() { return this.peek(0); }
  next() { return this.toks[this.i++]; }
  atEnd() { return this.cur.type === TOK.EOF; }

  /** True when the current token is the keyword `kw`. */
  isKw(kw, offset = 0) {
    const t = this.peek(offset);
    return t.type === TOK.WORD && !t.quoted && t.upper === kw;
  }

  /** Consume and return true if the current token is keyword `kw`. */
  eatKw(kw) {
    if (this.isKw(kw)) { this.i++; return true; }
    return false;
  }

  /** Consume a run of keywords in order, or consume nothing. */
  eatKwSeq(...kws) {
    for (let k = 0; k < kws.length; k++) if (!this.isKw(kws[k], k)) return false;
    this.i += kws.length;
    return true;
  }

  isPunct(ch, offset = 0) {
    const t = this.peek(offset);
    return t.type === TOK.PUNCT && t.value === ch;
  }

  eatPunct(ch) {
    if (this.isPunct(ch)) { this.i++; return true; }
    return false;
  }

  expectPunct(ch) {
    if (!this.eatPunct(ch)) this.fail(`Expected "${ch}"`);
  }

  expectKw(kw) {
    if (!this.eatKw(kw)) this.fail(`Expected ${kw}`);
  }

  isOp(op) { return this.cur.type === TOK.OP && this.cur.value === op; }

  fail(message) {
    const t = this.cur;
    const got = t.type === TOK.EOF ? 'end of statement' : `"${t.value}"`;
    throw new ParseError(`${message}, got ${got}`, t.start);
  }

  warn(message) {
    this.warnings.push({ message, pos: this.cur.start });
  }

  // ---- statements ----------------------------------------------------

  parseStatement() {
    const ctes = this.parseWith();
    let stmt;
    if (this.isKw('SELECT') || this.isPunct('(')) stmt = this.parseSelectStatement();
    else if (this.isKw('INSERT')) stmt = this.parseInsert();
    else if (this.isKw('UPDATE')) stmt = this.parseUpdate();
    else if (this.isKw('DELETE')) stmt = this.parseDelete();
    else this.fail('Expected SELECT, INSERT, UPDATE or DELETE');
    stmt.ctes = ctes;
    this.eatPunct(';');
    if (!this.atEnd()) {
      // Leftover tokens mean one of two very different things, and saying
      // which matters: a genuine second statement is expected and harmless,
      // whereas stopping mid-clause means this parser lost the thread and
      // everything past that point went unanalysed.
      const t = this.cur;
      const startsStatement = t.type === TOK.WORD && !t.quoted &&
        ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'WITH'].includes(t.upper);
      this.warn(startsStatement
        ? `Only the first statement is analysed — the ${t.upper} statement after it was ignored`
        : `Could not parse past "${t.value}" — that clause and everything after it was NOT analysed`);
    }
    return stmt;
  }

  /** WITH name [(cols)] AS (select) [, ...] */
  parseWith() {
    if (!this.eatKw('WITH')) return [];
    this.eatKw('RECURSIVE');
    const ctes = [];
    do {
      const name = this.parseIdentifier('CTE name');
      const columns = [];
      if (this.eatPunct('(')) {
        do { columns.push(this.parseIdentifier('CTE column')); } while (this.eatPunct(','));
        this.expectPunct(')');
      }
      this.expectKw('AS');
      this.expectPunct('(');
      const select = this.parseSelectStatement();
      this.expectPunct(')');
      ctes.push({ name, columns, select });
    } while (this.eatPunct(','));
    return ctes;
  }

  /** A SELECT possibly followed by UNION / INTERSECT / EXCEPT branches. */
  parseSelectStatement() {
    let left = this.parseSelectCore();
    while (this.isKw('UNION') || this.isKw('INTERSECT') || this.isKw('EXCEPT')) {
      const op = this.next().upper;
      const all = this.eatKw('ALL');
      this.eatKw('DISTINCT');
      const right = this.parseSelectCore();
      left = { type: 'setop', op, all, left, right, ctes: [] };
    }
    return left;
  }

  parseSelectCore() {
    // A parenthesised branch: (SELECT ...) UNION (SELECT ...)
    if (this.eatPunct('(')) {
      const inner = this.parseSelectStatement();
      this.expectPunct(')');
      return inner;
    }

    this.expectKw('SELECT');

    const node = {
      type: 'select',
      distinct: false,
      columns: [],
      from: [],
      joins: [],
      where: null,
      groupBy: [],
      having: null,
      orderBy: [],
      limit: null,
      offset: null,
      ctes: []
    };

    if (this.eatKw('DISTINCT')) node.distinct = true;
    else this.eatKw('ALL');

    // SQL Server TOP n
    if (this.isKw('TOP')) {
      this.next();
      const wrapped = this.eatPunct('(');
      node.limit = this.parseExpr();
      if (wrapped) this.expectPunct(')');
      this.eatKw('PERCENT');
    }

    node.columns = this.parseSelectList();

    if (this.eatKw('FROM')) {
      node.from.push(this.parseTableRef());
      // Comma joins are implicit cross joins — worth a case of their own.
      while (this.eatPunct(',')) {
        const t = this.parseTableRef();
        node.joins.push({ joinType: 'CROSS', implicit: true, natural: false, table: t, on: null, using: [] });
      }
      while (this.isJoinStart()) node.joins.push(this.parseJoin());
    }

    if (this.eatKw('WHERE')) node.where = this.parseExpr();

    if (this.isKw('GROUP') && this.isKw('BY', 1)) {
      this.i += 2;
      do { node.groupBy.push(this.parseExpr()); } while (this.eatPunct(','));
    }

    if (this.eatKw('HAVING')) node.having = this.parseExpr();

    if (this.isKw('ORDER') && this.isKw('BY', 1)) {
      this.i += 2;
      do {
        const expr = this.parseExpr();
        let dir = 'ASC';
        if (this.eatKw('DESC')) dir = 'DESC';
        else this.eatKw('ASC');
        let nulls = null;
        if (this.eatKw('NULLS')) nulls = this.eatKw('FIRST') ? 'FIRST' : (this.eatKw('LAST') ? 'LAST' : null);
        node.orderBy.push({ expr, dir, nulls });
      } while (this.eatPunct(','));
    }

    this.parsePaging(node);
    return node;
  }

  /** LIMIT n [OFFSET m] / LIMIT m, n / OFFSET m FETCH NEXT n ROWS ONLY */
  parsePaging(node) {
    if (this.eatKw('LIMIT')) {
      const first = this.parseExpr();
      if (this.eatPunct(',')) {          // MySQL "LIMIT offset, count"
        node.offset = first;
        node.limit = this.parseExpr();
      } else {
        node.limit = first;
      }
    }
    if (this.eatKw('OFFSET')) {
      node.offset = this.parseExpr();
      this.eatKw('ROWS') || this.eatKw('ROW');
    }
    if (this.eatKw('FETCH')) {
      this.eatKw('FIRST') || this.eatKw('NEXT');
      if (!this.isKw('ROW') && !this.isKw('ROWS')) node.limit = this.parseExpr();
      this.eatKw('ROWS') || this.eatKw('ROW');
      this.eatKw('ONLY');
    }
  }

  parseSelectList() {
    const cols = [];
    do {
      if (this.isOp('*')) {
        this.next();
        cols.push({ expr: { type: 'star', table: null }, alias: null });
        continue;
      }
      const expr = this.parseExpr();
      let alias = null;
      if (this.eatKw('AS')) alias = this.parseIdentifier('column alias');
      else if (this.cur.type === TOK.WORD && !this.cur.keyword) alias = this.next().value;
      cols.push({ expr, alias });
    } while (this.eatPunct(','));
    return cols;
  }

  isJoinStart() {
    const t = this.cur;
    return t.type === TOK.WORD && !t.quoted && JOIN_LEAD.has(t.upper);
  }

  parseJoin() {
    let joinType = 'INNER';
    let natural = false;
    if (this.eatKw('NATURAL')) natural = true;

    if (this.eatKw('CROSS')) { joinType = 'CROSS'; }
    else if (this.eatKw('INNER')) { joinType = 'INNER'; }
    else if (this.eatKw('LEFT')) { joinType = 'LEFT'; this.eatKw('OUTER'); }
    else if (this.eatKw('RIGHT')) { joinType = 'RIGHT'; this.eatKw('OUTER'); }
    else if (this.eatKw('FULL')) { joinType = 'FULL'; this.eatKw('OUTER'); }

    this.expectKw('JOIN');
    const table = this.parseTableRef();

    let on = null;
    const using = [];
    if (this.eatKw('ON')) {
      on = this.parseExpr();
    } else if (this.eatKw('USING')) {
      this.expectPunct('(');
      do { using.push(this.parseIdentifier('USING column')); } while (this.eatPunct(','));
      this.expectPunct(')');
    }
    return { joinType, implicit: false, natural, table, on, using };
  }

  parseTableRef() {
    let ref;
    if (this.eatPunct('(')) {
      if (this.isKw('SELECT') || this.isKw('WITH') || this.isPunct('(')) {
        const select = this.parseSelectStatement();
        this.expectPunct(')');
        ref = { kind: 'subquery', select, alias: null };
      } else {
        // Parenthesised join group — flatten it, the join list is what matters.
        const inner = this.parseTableRef();
        while (this.isJoinStart()) this.parseJoin();
        this.expectPunct(')');
        ref = inner;
      }
    } else {
      const parts = [this.parseIdentifier('table name')];
      while (this.eatPunct('.')) parts.push(this.parseIdentifier('table name'));
      ref = {
        kind: 'table',
        schema: parts.length > 1 ? parts.slice(0, -1).join('.') : null,
        name: parts[parts.length - 1],
        alias: null
      };
    }

    if (this.eatKw('AS')) ref.alias = this.parseIdentifier('table alias');
    else if (this.cur.type === TOK.WORD && !this.cur.keyword && !CLAUSE_STOP.has(this.cur.upper)) {
      ref.alias = this.next().value;
    }
    return ref;
  }

  parseIdentifier(what) {
    const t = this.cur;
    if (t.type !== TOK.WORD) this.fail(`Expected ${what}`);
    // Non-reserved keywords are common as column names (status, key, first…).
    this.i++;
    return t.value;
  }

  // ---- INSERT / UPDATE / DELETE --------------------------------------

  parseInsert() {
    this.expectKw('INSERT');
    this.eatKw('IGNORE');
    this.eatKw('INTO');
    const table = this.parseTableRef();
    const columns = [];
    if (this.eatPunct('(')) {
      do { columns.push(this.parseIdentifier('column')); } while (this.eatPunct(','));
      this.expectPunct(')');
    }

    const node = { type: 'insert', table, columns, rows: [], select: null, ctes: [] };

    if (this.eatKw('VALUES') || this.eatKw('VALUE')) {
      do {
        this.expectPunct('(');
        const row = [];
        do { row.push(this.parseExpr()); } while (this.eatPunct(','));
        this.expectPunct(')');
        node.rows.push(row);
      } while (this.eatPunct(','));
    } else if (this.isKw('SELECT') || this.isKw('WITH') || this.isPunct('(')) {
      node.select = this.parseSelectStatement();
    } else if (this.eatKw('SET')) {
      // MySQL "INSERT ... SET a = 1, b = 2"
      const row = [];
      do {
        const col = this.parseIdentifier('column');
        if (!this.isOp('=')) this.fail('Expected "="');
        this.next();
        columns.push(col);
        row.push(this.parseExpr());
      } while (this.eatPunct(','));
      node.rows.push(row);
    }
    this.skipTail();
    return node;
  }

  parseUpdate() {
    this.expectKw('UPDATE');
    const table = this.parseTableRef();
    const joins = [];
    while (this.eatPunct(',')) {
      joins.push({ joinType: 'CROSS', implicit: true, natural: false, table: this.parseTableRef(), on: null, using: [] });
    }
    while (this.isJoinStart()) joins.push(this.parseJoin());

    this.expectKw('SET');
    const set = [];
    do {
      const parts = [this.parseIdentifier('column')];
      while (this.eatPunct('.')) parts.push(this.parseIdentifier('column'));
      if (!this.isOp('=')) this.fail('Expected "=" in SET');
      this.next();
      set.push({
        table: parts.length > 1 ? parts[parts.length - 2] : null,
        column: parts[parts.length - 1],
        value: this.parseExpr()
      });
    } while (this.eatPunct(','));

    const node = { type: 'update', table, joins, set, where: null, orderBy: [], limit: null, offset: null, ctes: [] };
    if (this.eatKw('FROM')) {
      node.joins.push({ joinType: 'CROSS', implicit: true, natural: false, table: this.parseTableRef(), on: null, using: [] });
      while (this.isJoinStart()) node.joins.push(this.parseJoin());
    }
    if (this.eatKw('WHERE')) node.where = this.parseExpr();
    this.parsePaging(node);
    this.skipTail();
    return node;
  }

  parseDelete() {
    this.expectKw('DELETE');
    this.eatKw('FROM');
    const table = this.parseTableRef();
    const node = { type: 'delete', table, joins: [], where: null, orderBy: [], limit: null, offset: null, ctes: [] };
    if (this.eatKw('USING') || this.eatKw('FROM')) {
      node.joins.push({ joinType: 'CROSS', implicit: true, natural: false, table: this.parseTableRef(), on: null, using: [] });
    }
    while (this.isJoinStart()) node.joins.push(this.parseJoin());
    if (this.eatKw('WHERE')) node.where = this.parseExpr();
    this.parsePaging(node);
    this.skipTail();
    return node;
  }

  /** Swallow trailing vendor clauses (RETURNING, ON DUPLICATE KEY …) with a note. */
  skipTail() {
    if (this.atEnd() || this.isPunct(';')) return;
    const from = this.cur.value;
    let depth = 0;
    while (!this.atEnd()) {
      if (this.isPunct('(')) depth++;
      else if (this.isPunct(')')) depth--;
      else if (depth === 0 && this.isPunct(';')) break;
      this.i++;
    }
    this.warnings.push({ message: `Trailing clause starting at "${from}" was not analysed`, pos: 0 });
  }

  // ---- expressions ---------------------------------------------------

  parseExpr() { return this.parseOr(); }

  parseOr() {
    let left = this.parseAnd();
    while (this.eatKw('OR')) {
      left = { type: 'binary', op: 'OR', left, right: this.parseAnd() };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseNot();
    while (this.eatKw('AND')) {
      left = { type: 'binary', op: 'AND', left, right: this.parseNot() };
    }
    return left;
  }

  parseNot() {
    if (this.eatKw('NOT')) return { type: 'unary', op: 'NOT', expr: this.parseNot() };
    return this.parsePredicate();
  }

  /**
   * One comparison-level predicate. Each postfix form (IS / IN / LIKE /
   * BETWEEN) may be preceded by NOT, which is folded into the node's
   * `negated` flag rather than a wrapper so techniques can read the
   * operator directly.
   */
  parsePredicate() {
    if (this.isKw('EXISTS')) {
      this.next();
      this.expectPunct('(');
      const select = this.parseSelectStatement();
      this.expectPunct(')');
      return { type: 'exists', negated: false, select };
    }

    let left = this.parseAdditive();

    for (;;) {
      if (this.cur.type === TOK.OP && COMPARISON_OPS.has(this.cur.value)) {
        const op = this.next().value;
        // ANY / ALL / SOME quantifiers
        if (this.isKw('ANY') || this.isKw('ALL') || this.isKw('SOME')) {
          const quant = this.next().upper;
          this.expectPunct('(');
          const select = this.parseSelectStatement();
          this.expectPunct(')');
          left = { type: 'quantified', op, quant, left, select };
          continue;
        }
        left = { type: 'binary', op, left, right: this.parseAdditive() };
        continue;
      }

      if (this.isKw('IS')) {
        this.next();
        const negated = this.eatKw('NOT');
        let target = 'NULL';
        if (this.eatKw('NULL')) target = 'NULL';
        else if (this.eatKw('TRUE')) target = 'TRUE';
        else if (this.eatKw('FALSE')) target = 'FALSE';
        else if (this.eatKw('UNKNOWN')) target = 'UNKNOWN';
        else if (this.eatKw('DISTINCT')) { this.expectKw('FROM'); left = { type: 'binary', op: negated ? '<=>' : 'IS DISTINCT FROM', left, right: this.parseAdditive() }; continue; }
        else this.fail('Expected NULL/TRUE/FALSE/UNKNOWN after IS');
        left = { type: 'is', expr: left, negated, target };
        continue;
      }

      const negated = this.isKw('NOT') &&
        (this.isKw('IN', 1) || this.isKw('LIKE', 1) || this.isKw('ILIKE', 1) || this.isKw('BETWEEN', 1));
      if (negated) this.next();

      if (this.isKw('IN')) {
        this.next();
        this.expectPunct('(');
        if (this.isKw('SELECT') || this.isKw('WITH')) {
          const select = this.parseSelectStatement();
          this.expectPunct(')');
          left = { type: 'in', expr: left, negated, list: null, select };
        } else {
          const list = [];
          do { list.push(this.parseExpr()); } while (this.eatPunct(','));
          this.expectPunct(')');
          left = { type: 'in', expr: left, negated, list, select: null };
        }
        continue;
      }

      if (this.isKw('LIKE') || this.isKw('ILIKE')) {
        const ci = this.cur.upper === 'ILIKE';
        this.next();
        const pattern = this.parseAdditive();
        let escape = null;
        if (this.eatKw('ESCAPE')) escape = this.parseAdditive();
        left = { type: 'like', expr: left, negated, pattern, escape, ci };
        continue;
      }

      if (this.isKw('BETWEEN')) {
        this.next();
        this.eatKw('SYMMETRIC');
        const low = this.parseAdditive();
        this.expectKw('AND');
        const high = this.parseAdditive();
        left = { type: 'between', expr: left, negated, low, high };
        continue;
      }

      if (negated) this.fail('Expected IN, LIKE or BETWEEN after NOT');
      break;
    }
    return left;
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.isOp('+') || this.isOp('-') || this.isOp('||')) {
      const op = this.next().value;
      left = { type: 'binary', op, left, right: this.parseMultiplicative() };
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parseUnary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.next().value;
      left = { type: 'binary', op, left, right: this.parseUnary() };
    }
    return left;
  }

  parseUnary() {
    if (this.isOp('-') || this.isOp('+')) {
      const op = this.next().value;
      const expr = this.parseUnary();
      // Fold "-5" into a single negative literal so boundary maths sees a number.
      if (expr.type === 'literal' && expr.kind === 'number') {
        return op === '-' ? { ...expr, value: -expr.value, raw: '-' + expr.raw } : expr;
      }
      return { type: 'unary', op, expr };
    }
    if (this.eatKw('INTERVAL')) {
      const amount = this.parseUnary();
      // The unit is a trailing word in MySQL (`INTERVAL 6 MONTH`) but lives
      // inside the string in PostgreSQL (`INTERVAL '6 months'`). Taking any
      // following word would swallow the next clause keyword in the Postgres
      // form, so only a recognised unit is consumed.
      let unit = '';
      const t = this.cur;
      if (t.type === TOK.WORD && !t.quoted && INTERVAL_UNITS.has(t.upper)) {
        unit = this.next().value;
      }
      return { type: 'interval', amount, unit };
    }
    return this.parsePostfix();
  }

  /** Primary plus `::type` casts. */
  parsePostfix() {
    let node = this.parsePrimary();
    while (this.cur.type === TOK.OP && this.cur.value === '::') {
      this.next();
      const dataType = this.parseTypeName();
      node = { type: 'cast', expr: node, dataType };
    }
    return node;
  }

  parseTypeName() {
    let name = this.cur.type === TOK.WORD ? this.next().value : '';
    while (this.cur.type === TOK.WORD && !this.cur.keyword && !CLAUSE_STOP.has(this.cur.upper)) {
      name += ' ' + this.next().value;
    }
    if (this.eatPunct('(')) {
      let depth = 1;
      while (depth > 0 && !this.atEnd()) {
        if (this.isPunct('(')) depth++;
        if (this.isPunct(')')) depth--;
        this.i++;
      }
    }
    return name;
  }

  parsePrimary() {
    const t = this.cur;

    if (t.type === TOK.NUMBER) {
      this.next();
      return { type: 'literal', kind: 'number', value: Number(t.value), raw: t.value };
    }

    if (t.type === TOK.STRING) {
      this.next();
      return { type: 'literal', kind: 'string', value: t.value, raw: `'${t.value.replace(/'/g, "''")}'` };
    }

    if (t.type === TOK.PARAM) {
      this.next();
      return { type: 'param', name: t.value, ordinal: t.ordinal, pos: t.start };
    }

    if (this.isPunct('(')) {
      this.next();
      if (this.isKw('SELECT') || this.isKw('WITH')) {
        const select = this.parseSelectStatement();
        this.expectPunct(')');
        return { type: 'subquery', select };
      }
      // A parenthesised list "(a, b) IN (...)" — keep it as a row value.
      const first = this.parseExpr();
      if (this.isPunct(',')) {
        const items = [first];
        while (this.eatPunct(',')) items.push(this.parseExpr());
        this.expectPunct(')');
        return { type: 'row', items };
      }
      this.expectPunct(')');
      return { type: 'group', expr: first };
    }

    if (this.isKw('CASE')) return this.parseCase();
    if (this.isKw('CAST')) {
      this.next();
      this.expectPunct('(');
      const expr = this.parseExpr();
      this.expectKw('AS');
      const dataType = this.parseTypeName();
      this.expectPunct(')');
      return { type: 'cast', expr, dataType };
    }

    if (this.eatKw('NULL')) return { type: 'literal', kind: 'null', value: null, raw: 'NULL' };
    if (this.eatKw('TRUE')) return { type: 'literal', kind: 'boolean', value: true, raw: 'TRUE' };
    if (this.eatKw('FALSE')) return { type: 'literal', kind: 'boolean', value: false, raw: 'FALSE' };
    if (this.eatKw('DEFAULT')) return { type: 'literal', kind: 'default', value: undefined, raw: 'DEFAULT' };

    if (t.type === TOK.WORD) {
      // Dotted name: a, a.b, a.b.c — or a function call when "(" follows.
      const parts = [this.next().value];
      let star = false;
      while (this.isPunct('.')) {
        this.next();
        if (this.isOp('*')) { this.next(); star = true; break; }
        parts.push(this.parseIdentifier('name part'));
      }

      if (star) return { type: 'star', table: parts.join('.') };

      if (this.isPunct('(')) {
        this.next();
        const name = parts.join('.');
        const distinct = this.eatKw('DISTINCT');
        const args = [];
        if (!this.isPunct(')')) {
          do {
            if (this.isOp('*')) { this.next(); args.push({ type: 'star', table: null }); }
            else args.push(this.parseExpr());
          } while (this.eatPunct(','));
        }
        this.expectPunct(')');
        // OVER (...) / FILTER (...) — recorded, not modelled.
        if (this.isKw('OVER') || this.isKw('FILTER')) {
          this.warn(`Window/filter clause on ${name}() was not analysed`);
          this.next();
          if (this.eatPunct('(')) {
            let depth = 1;
            while (depth > 0 && !this.atEnd()) {
              if (this.isPunct('(')) depth++;
              if (this.isPunct(')')) depth--;
              this.i++;
            }
          }
        }
        return { type: 'func', name, args, distinct };
      }

      // Bare keyword used as a value we do not model (CURRENT_DATE, etc.)
      return {
        type: 'column',
        table: parts.length > 1 ? parts.slice(0, -1).join('.') : null,
        name: parts[parts.length - 1],
        raw: parts.join('.')
      };
    }

    this.fail('Expected an expression');
  }

  parseCase() {
    this.expectKw('CASE');
    let operand = null;
    if (!this.isKw('WHEN')) operand = this.parseExpr();
    const whens = [];
    while (this.eatKw('WHEN')) {
      const when = this.parseExpr();
      this.expectKw('THEN');
      whens.push({ when, then: this.parseExpr() });
    }
    let elseExpr = null;
    if (this.eatKw('ELSE')) elseExpr = this.parseExpr();
    this.expectKw('END');
    return { type: 'case', operand, whens, else: elseExpr };
  }
}

/**
 * Parse one SQL statement.
 *
 * @param {string} sql
 * @returns {{ast: object|null, errors: Array<{message:string,pos:number}>, warnings: Array}}
 */
export function parse(sql) {
  const { tokens, errors: lexErrors } = tokenize(sql);
  const p = new Parser(tokens);
  const errors = [...lexErrors];
  let ast = null;
  try {
    if (tokens.length <= 1) errors.push({ message: 'Empty query', pos: 0 });
    else ast = p.parseStatement();
  } catch (err) {
    if (err instanceof ParseError) errors.push({ message: err.message, pos: err.pos });
    else throw err;
  }
  return { ast, errors, warnings: p.warnings };
}

/** Render an expression node back to readable SQL — used in case descriptions. */
export function exprToSql(e) {
  if (!e) return '';
  switch (e.type) {
    case 'literal': return e.raw;
    case 'param': return e.name;
    case 'column': return e.raw;
    case 'star': return e.table ? `${e.table}.*` : '*';
    case 'group': return `(${exprToSql(e.expr)})`;
    case 'row': return `(${e.items.map(exprToSql).join(', ')})`;
    case 'unary': return e.op === 'NOT' ? `NOT ${exprToSql(e.expr)}` : `${e.op}${exprToSql(e.expr)}`;
    case 'binary': return `${exprToSql(e.left)} ${e.op} ${exprToSql(e.right)}`;
    case 'is': return `${exprToSql(e.expr)} IS ${e.negated ? 'NOT ' : ''}${e.target}`;
    case 'in': return `${exprToSql(e.expr)} ${e.negated ? 'NOT ' : ''}IN (${e.select ? 'SELECT …' : e.list.map(exprToSql).join(', ')})`;
    case 'like': return `${exprToSql(e.expr)} ${e.negated ? 'NOT ' : ''}${e.ci ? 'ILIKE' : 'LIKE'} ${exprToSql(e.pattern)}`;
    case 'between': return `${exprToSql(e.expr)} ${e.negated ? 'NOT ' : ''}BETWEEN ${exprToSql(e.low)} AND ${exprToSql(e.high)}`;
    case 'exists': return `${e.negated ? 'NOT ' : ''}EXISTS (SELECT …)`;
    case 'quantified': return `${exprToSql(e.left)} ${e.op} ${e.quant} (SELECT …)`;
    case 'func': return `${e.name}(${e.distinct ? 'DISTINCT ' : ''}${e.args.map(exprToSql).join(', ')})`;
    case 'cast': return `CAST(${exprToSql(e.expr)} AS ${e.dataType})`;
    case 'case': return 'CASE … END';
    case 'subquery': return '(SELECT …)';
    case 'interval': return `INTERVAL ${exprToSql(e.amount)}${e.unit ? ' ' + e.unit : ''}`;
    default: return '?';
  }
}
