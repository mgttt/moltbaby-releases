// ============================================================
// SQL Engine for QuickJS - complete parser + executor
// Ported from ndtsdb-bun TypeScript sources to plain ES2020 JS
// No Node.js or Bun APIs - pure QuickJS compatible
// ============================================================

// Module-level import (required to be at top level in ES modules)
import * as ndtsdb from 'ndtsdb';

// ---------------------------------------------------------------------------
// PARSER
// ---------------------------------------------------------------------------

class SQLParser {
  constructor() {
    this.sql = '';
    this.pos = 0;
    this.tokens = [];
    this.tokenPos = 0;
    this.subqueryId = 0;
  }

  parse(sql) {
    this.sql = sql.trim();
    this.pos = 0;
    this.tokens = this.tokenize(this.sql);
    this.tokenPos = 0;

    const firstToken = this.peek()?.toUpperCase();

    switch (firstToken) {
      case 'WITH':
        return { type: 'SELECT', data: this.parseWithSelect() };
      case 'SELECT':
        return { type: 'SELECT', data: this.parseSelect() };
      case 'INSERT':
        return this.parseInsertOrUpsert();
      case 'UPSERT':
        return { type: 'UPSERT', data: this.parseUpsert() };
      case 'CREATE':
        return { type: 'CREATE TABLE', data: this.parseCreateTable() };
      default:
        throw new Error(`Unsupported SQL statement: ${firstToken}`);
    }
  }

  tokenize(sql) {
    const tokens = [];
    let i = 0;

    while (i < sql.length) {
      const char = sql[i];

      if (/\s/.test(char)) {
        i++;
        continue;
      }

      if (char === "'" || char === '"') {
        const quote = char;
        let str = '';
        i++;
        while (i < sql.length && sql[i] !== quote) {
          if (sql[i] === '\\' && i + 1 < sql.length) {
            str += sql[i + 1];
            i += 2;
          } else {
            str += sql[i];
            i++;
          }
        }
        i++;
        tokens.push(`'${str}'`);
        continue;
      }

      if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(sql[i + 1]))) {
        let num = '';
        while (i < sql.length && (/[0-9.]/.test(sql[i]) || sql[i] === 'e' || sql[i] === 'E' || sql[i] === '+' || sql[i] === '-')) {
          num += sql[i];
          i++;
        }
        tokens.push(num);
        continue;
      }

      if (/[a-zA-Z_]/.test(char)) {
        let ident = '';
        while (i < sql.length && /[a-zA-Z0-9_.]/.test(sql[i])) {
          ident += sql[i];
          i++;
        }
        tokens.push(ident);
        continue;
      }

      if (char === '!' && sql[i + 1] === '=') {
        tokens.push('!=');
        i += 2;
        continue;
      }
      if (char === '<' && sql[i + 1] === '=') {
        tokens.push('<=');
        i += 2;
        continue;
      }
      if (char === '>' && sql[i + 1] === '=') {
        tokens.push('>=');
        i += 2;
        continue;
      }
      if (char === '<' && sql[i + 1] === '>') {
        tokens.push('<>');
        i += 2;
        continue;
      }
      if (char === '|' && sql[i + 1] === '|') {
        tokens.push('||');
        i += 2;
        continue;
      }

      tokens.push(char);
      i++;
    }

    return tokens;
  }

  parseSelectStatement() {
    const first = this.peek()?.toUpperCase();
    if (first === 'WITH') return this.parseWithSelect();
    if (first === 'SELECT') return this.parseSelect();
    throw new Error(`Expected SELECT statement, got ${this.peek()}`);
  }

  parseWithSelect() {
    this.consume('WITH');

    const withCTEs = [];

    while (true) {
      const name = this.consumeIdentifier();

      if (this.peek() === '(') {
        this.consume('(');
        this.parseIdentifierList();
        this.consume(')');
      }

      this.consume('AS');
      this.consume('(');
      const select = this.parseSelect();
      this.consume(')');

      withCTEs.push({ name, select });

      if (this.peek() === ',') {
        this.consume(',');
        continue;
      }
      break;
    }

    const main = this.parseSelect();
    main.with = [...withCTEs, ...(main.with || [])];
    return main;
  }

  parseSelect() {
    this.consume('SELECT');

    // DISTINCT support
    let distinct = false;
    if (this.peek()?.toUpperCase() === 'DISTINCT') {
      this.consume('DISTINCT');
      distinct = true;
    }

    const columns = this.parseSelectColumns();

    this.consume('FROM');

    let extraWith;
    let from;

    if (this.peek() === '(') {
      this.consume('(');
      const sub = this.parseSelectStatement();
      this.consume(')');

      const name = `__subq${++this.subqueryId}`;
      extraWith = [{ name, select: sub }];
      from = name;
    } else {
      from = this.consumeIdentifier();
    }

    let fromAlias;
    const nextAfterFrom = this.peek()?.toUpperCase();
    if (nextAfterFrom === 'AS') {
      this.consume('AS');
      fromAlias = this.consumeIdentifier();
    } else if (this.peek() && this.isIdentifierToken(this.peek()) && !['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'JOIN', 'INNER', 'LEFT'].includes(nextAfterFrom || '')) {
      fromAlias = this.consumeIdentifier();
    }

    const joins = [];
    while (true) {
      const t = this.peek()?.toUpperCase();
      if (!t) break;

      let joinType = 'INNER';
      if (t === 'INNER') {
        this.consume('INNER');
        this.consume('JOIN');
        joinType = 'INNER';
      } else if (t === 'LEFT') {
        this.consume('LEFT');
        if (this.peek()?.toUpperCase() === 'OUTER') this.consume('OUTER');
        this.consume('JOIN');
        joinType = 'LEFT';
      } else if (t === 'JOIN') {
        this.consume('JOIN');
        joinType = 'INNER';
      } else {
        break;
      }

      const table = this.consumeIdentifier();

      let alias;
      const next = this.peek()?.toUpperCase();
      if (next === 'AS') {
        this.consume('AS');
        alias = this.consumeIdentifier();
      } else if (this.peek() && this.isIdentifierToken(this.peek()) && !['ON', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'JOIN', 'INNER', 'LEFT'].includes(next || '')) {
        alias = this.consumeIdentifier();
      }

      this.consume('ON');
      const on = this.parseJoinOn();

      joins.push({ type: joinType, table, alias, on });
    }

    let where;
    let whereExpr;
    if (this.peek()?.toUpperCase() === 'WHERE') {
      this.consume('WHERE');
      whereExpr = this.parseWhereExpr();
      where = this.linearizeWhereExpr(whereExpr) || undefined;
    }

    let groupBy;
    if (this.peek()?.toUpperCase() === 'GROUP') {
      this.consume('GROUP');
      this.consume('BY');
      groupBy = this.parseIdentifierList();
    }

    let havingExpr;
    if (this.peek()?.toUpperCase() === 'HAVING') {
      this.consume('HAVING');
      havingExpr = this.parseWhereExpr(true);
    }

    let orderBy;
    if (this.peek()?.toUpperCase() === 'ORDER') {
      this.consume('ORDER');
      this.consume('BY');
      orderBy = this.parseOrderBy();
    }

    let limit;
    if (this.peek()?.toUpperCase() === 'LIMIT') {
      this.consume('LIMIT');
      limit = parseInt(this.consume());
    }

    let offset;
    if (this.peek()?.toUpperCase() === 'OFFSET') {
      this.consume('OFFSET');
      offset = parseInt(this.consume());
    }

    return {
      with: extraWith,
      distinct,
      columns,
      from,
      fromAlias,
      joins: joins.length > 0 ? joins : undefined,
      where,
      whereExpr,
      groupBy,
      havingExpr,
      orderBy,
      limit,
      offset,
    };
  }

  parseSelectColumns() {
    const columns = [];

    if (this.peek() === '*') {
      this.consume('*');
      return ['*'];
    }

    while (true) {
      const col = this.parseColumnOrExpr();
      columns.push(col);

      if (this.peek() === ',') {
        this.consume(',');
        continue;
      }
      break;
    }

    return columns;
  }

  parseColumnOrExpr() {
    let expr = '';
    let depth = 0;

    while (this.tokenPos < this.tokens.length) {
      const token = this.peek();
      if (!token) break;

      const upper = token.toUpperCase();

      if (depth === 0 && ['FROM', 'WHERE', 'GROUP', 'ORDER', 'LIMIT', 'OFFSET'].includes(upper)) {
        break;
      }

      if (depth === 0 && token === ',') {
        break;
      }

      if (depth === 0 && upper === 'AS') {
        this.consume('AS');
        const alias = this.consumeIdentifier();
        return { expr: expr.trim(), alias };
      }

      if (token === '(') depth++;
      if (token === ')') depth = Math.max(0, depth - 1);

      expr += this.consume() + ' ';
    }

    return expr.trim();
  }

  parseWhereExpr(allowExprLHS = false) {
    const self = this;

    const parseOr = () => {
      let node = parseAnd();
      while (self.peek()?.toUpperCase() === 'OR') {
        self.consume('OR');
        const right = parseAnd();
        node = { type: 'or', left: node, right };
      }
      return node;
    };

    const parseAnd = () => {
      let node = parseNot();
      while (self.peek()?.toUpperCase() === 'AND') {
        self.consume('AND');
        const right = parseNot();
        node = { type: 'and', left: node, right };
      }
      return node;
    };

    const parseNot = () => {
      if (self.peek()?.toUpperCase() === 'NOT') {
        self.consume('NOT');
        return { type: 'not', expr: parseNot() };
      }
      return parsePrimary();
    };

    const parsePrimary = () => {
      if (self.peek() === '(' && !self.isTupleLHS()) {
        self.consume('(');
        const inner = parseOr();
        self.consume(')');
        return inner;
      }

      const pred = self.parsePredicate(allowExprLHS);
      return { type: 'pred', pred };
    };

    return parseOr();
  }

  isTupleLHS() {
    if (this.peek() !== '(') return false;
    const t1 = this.tokens[this.tokenPos + 1];
    const t2 = this.tokens[this.tokenPos + 2];
    return !!t1 && this.isIdentifierToken(t1) && t2 === ',';
  }

  isIdentifierToken(t) {
    return /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/.test(t);
  }

  parsePredicate(allowExprLHS) {
    let column;

    if (this.peek() === '(') {
      this.consume('(');
      column = this.parseIdentifierList();
      this.consume(')');
    } else if (!allowExprLHS) {
      column = this.consumeIdentifier();
    } else {
      let expr = '';
      let depth = 0;

      const isOpToken = (t) => {
        const up = t.toUpperCase();
        return ['=', '!=', '<>', '<', '>', '<=', '>=', 'LIKE', 'IN'].includes(up);
      };

      while (this.tokenPos < this.tokens.length) {
        const token = this.peek();
        if (!token) break;

        if (depth === 0 && isOpToken(token)) break;

        if (token === '(') depth++;
        if (token === ')') depth = Math.max(0, depth - 1);

        expr += this.consume() + ' ';
      }

      expr = expr.trim();
      if (!expr) throw new Error('Expected predicate expression');
      column = expr;
    }

    const operator = this.parseOperator();
    const value = operator === 'IN' ? this.parseInValue() : this.parseValue();
    return { column, operator, value };
  }

  linearizeWhereExpr(expr) {
    const preds = [];

    const collectAnd = (n) => {
      if (n.type === 'pred') {
        preds.push(n.pred);
        return true;
      }
      if (n.type === 'and') {
        return collectAnd(n.left) && collectAnd(n.right);
      }
      return false;
    };

    if (!collectAnd(expr)) return null;

    const out = preds.map((p) => ({ ...p }));
    for (let i = 0; i < out.length - 1; i++) out[i].logic = 'AND';
    return out;
  }

  parseJoinOn() {
    const on = [];

    while (true) {
      const left = this.consumeIdentifier();
      this.consume('=');
      const right = this.consumeIdentifier();
      on.push({ left, operator: '=', right });

      const next = this.peek()?.toUpperCase();
      if (next === 'AND') {
        this.consume('AND');
        continue;
      }
      break;
    }

    return on;
  }

  parseOperator() {
    const op = this.consume().toUpperCase();
    const validOps = ['=', '!=', '<>', '<', '>', '<=', '>=', 'LIKE', 'IN'];

    if (!validOps.includes(op)) {
      throw new Error(`Invalid operator: ${op}`);
    }

    return op;
  }

  parseValue() {
    const token = this.peek();

    if (token?.toUpperCase() === 'NULL') {
      this.consume('NULL');
      return null;
    }

    if (token === '(') {
      this.consume('(');
      const values = [];
      while (this.peek() !== ')') {
        values.push(this.parseSingleValue());
        if (this.peek() === ',') this.consume(',');
      }
      this.consume(')');
      return values;
    }

    return this.parseSingleValue();
  }

  parseInValue() {
    if (this.peek() !== '(') {
      return [this.parseSingleValue()];
    }

    this.consume('(');

    if (this.peek()?.toUpperCase() === 'SELECT' || this.peek()?.toUpperCase() === 'WITH') {
      const subquery = this.parseSelectStatement();
      this.consume(')');
      return { subquery };
    }

    if (this.peek() === '(') {
      const tuples = [];
      while (true) {
        this.consume('(');
        const row = [];
        while (this.peek() !== ')') {
          row.push(this.parseSingleValue());
          if (this.peek() === ',') this.consume(',');
        }
        this.consume(')');
        tuples.push(row);

        if (this.peek() === ',') {
          this.consume(',');
          continue;
        }
        break;
      }

      this.consume(')');
      return tuples;
    }

    const values = [];
    while (this.peek() !== ')') {
      values.push(this.parseSingleValue());
      if (this.peek() === ',') this.consume(',');
    }
    this.consume(')');
    return values;
  }

  parseSingleValue() {
    const token = this.consume();

    if (token.startsWith("'") && token.endsWith("'")) {
      return token.slice(1, -1);
    }

    if (token.toUpperCase() === 'TRUE') return true;
    if (token.toUpperCase() === 'FALSE') return false;
    if (token.toUpperCase() === 'NULL') return null;

    const num = parseFloat(token);
    if (!isNaN(num)) return num;

    return token;
  }

  parseOrderBy() {
    const orderBy = [];

    while (true) {
      let expr = '';
      let depth = 0;

      while (this.tokenPos < this.tokens.length) {
        const token = this.peek();
        if (!token) break;

        const upper = token.toUpperCase();

        if (depth === 0 && (token === ',' || ['LIMIT', 'OFFSET'].includes(upper))) {
          break;
        }

        if (depth === 0 && (upper === 'ASC' || upper === 'DESC')) {
          break;
        }

        if (token === '(') depth++;
        if (token === ')') depth = Math.max(0, depth - 1);

        expr += this.consume() + ' ';
      }

      expr = expr.trim();
      if (!expr) throw new Error('Expected ORDER BY expression');

      let direction = 'ASC';
      const next = this.peek()?.toUpperCase();
      if (next === 'ASC' || next === 'DESC') {
        direction = this.consume().toUpperCase();
      }

      orderBy.push({ expr, direction });

      if (this.peek() === ',') {
        this.consume(',');
        continue;
      }
      break;
    }

    return orderBy;
  }

  parseInsertOrUpsert() {
    this.consume('INSERT');
    this.consume('INTO');

    const into = this.consumeIdentifier();

    let columns = [];
    if (this.peek() === '(') {
      this.consume('(');
      columns = this.parseIdentifierList();
      this.consume(')');
    }

    this.consume('VALUES');
    const values = this.parseValuesList();

    if (this.peek()?.toUpperCase() === 'ON') {
      return {
        type: 'UPSERT',
        data: this.parseOnConflict(into, columns, values)
      };
    }

    return { type: 'INSERT', data: { into, columns, values } };
  }

  parseUpsert() {
    this.consume('UPSERT');
    this.consume('INTO');

    const into = this.consumeIdentifier();

    let columns = [];
    if (this.peek() === '(') {
      this.consume('(');
      columns = this.parseIdentifierList();
      this.consume(')');
    }

    this.consume('VALUES');
    const values = this.parseValuesList();

    let conflictColumns = [];
    if (this.peek()?.toUpperCase() === 'KEY') {
      this.consume('KEY');
      this.consume('(');
      conflictColumns = this.parseIdentifierList();
      this.consume(')');
    } else {
      conflictColumns = columns.length > 0 ? [columns[0]] : [];
    }

    const updateColumns = columns.filter(c => !conflictColumns.includes(c));

    return { into, columns, values, conflictColumns, updateColumns };
  }

  parseOnConflict(into, columns, values) {
    this.consume('ON');
    this.consume('CONFLICT');

    this.consume('(');
    const conflictColumns = this.parseIdentifierList();
    this.consume(')');

    this.consume('DO');
    this.consume('UPDATE');
    this.consume('SET');

    const updateColumns = [];
    while (true) {
      const col = this.consumeIdentifier();
      this.consume('=');

      // Parse EXCLUDED.col - in our tokenizer, dotted idents are a single token
      const excluded = this.consumeIdentifier();
      const excludedUpper = excluded.toUpperCase();
      if (excludedUpper.startsWith('EXCLUDED.')) {
        // Single token: EXCLUDED.colname
        updateColumns.push(col);
      } else if (excludedUpper === 'EXCLUDED') {
        // Separate tokens: EXCLUDED . colname
        if (this.peek() === '.') this.consume('.');
        this.consumeIdentifier();
        updateColumns.push(col);
      } else {
        throw new Error(`Expected EXCLUDED.column, got: ${excluded}`);
      }

      if (this.peek() === ',') {
        this.consume(',');
        continue;
      }
      break;
    }

    return { into, columns, values, conflictColumns, updateColumns };
  }

  parseValuesList() {
    const allValues = [];

    while (true) {
      this.consume('(');
      const row = [];

      while (this.peek() !== ')') {
        row.push(this.parseSingleValue());
        if (this.peek() === ',') this.consume(',');
      }

      this.consume(')');
      allValues.push(row);

      if (this.peek() === ',') {
        this.consume(',');
        continue;
      }
      break;
    }

    return allValues;
  }

  parseCreateTable() {
    this.consume('CREATE');
    this.consume('TABLE');

    const table = this.consumeIdentifier();

    this.consume('(');
    const columns = [];

    while (this.peek() !== ')') {
      const name = this.consumeIdentifier();
      const type = this.consumeIdentifier();

      const constraints = [];
      while (this.peek() && ![')', ','].includes(this.peek())) {
        constraints.push(this.consume().toUpperCase());
      }

      columns.push({ name, type, constraints: constraints.length > 0 ? constraints : undefined });

      if (this.peek() === ',') this.consume(',');
    }

    this.consume(')');

    return { table, columns };
  }

  peek() {
    return this.tokens[this.tokenPos];
  }

  consume(expected) {
    const token = this.tokens[this.tokenPos];
    if (!token) {
      throw new Error(`Unexpected end of SQL, expected: ${expected}`);
    }

    if (expected && token.toUpperCase() !== expected.toUpperCase()) {
      throw new Error(`Expected ${expected}, got ${token}`);
    }

    this.tokenPos++;
    return token;
  }

  consumeIdentifier() {
    const token = this.consume();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/.test(token)) {
      throw new Error(`Expected identifier, got ${token}`);
    }
    return token;
  }

  parseIdentifierList() {
    const list = [];
    while (true) {
      list.push(this.consumeIdentifier());
      if (this.peek() === ',') {
        this.consume(',');
        continue;
      }
      break;
    }
    return list;
  }
}

function parseSQL(sql) {
  return new SQLParser().parse(sql);
}

// ---------------------------------------------------------------------------
// EXECUTOR
// ---------------------------------------------------------------------------

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/;

class SQLExecutor {
  constructor() {
    // Map of table name (lowercase) -> array of row objects
    this.tables = new Map();
  }

  registerTable(name, rows) {
    this.tables.set(name.toLowerCase(), rows);
  }

  getTable(name) {
    return this.tables.get(name.toLowerCase());
  }

  // ---------------------------------------------------------------------------
  // CTE
  // ---------------------------------------------------------------------------

  installCTEs(ctes) {
    const saved = new Map();

    for (const cte of ctes) {
      const key = cte.name.toLowerCase();
      if (!saved.has(key)) {
        saved.set(key, this.tables.get(key));
      }

      const res = this.executeSelect(cte.select);
      this.tables.set(key, res.rows);
    }

    return () => {
      for (const [key, prev] of saved.entries()) {
        if (prev !== undefined) this.tables.set(key, prev);
        else this.tables.delete(key);
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Top-level execute
  // ---------------------------------------------------------------------------

  execute(statement) {
    switch (statement.type) {
      case 'SELECT':
        return this.executeSelect(statement.data);
      case 'INSERT':
        return this.executeInsert(statement.data);
      case 'UPSERT':
        return this.executeUpsert(statement.data);
      case 'CREATE TABLE':
        return this.executeCreateTable(statement.data);
      default:
        throw new Error(`Unsupported statement type: ${statement.type}`);
    }
  }

  // ---------------------------------------------------------------------------
  // SELECT
  // ---------------------------------------------------------------------------

  executeSelect(select) {
    let restore = null;

    try {
      restore = (select.with && select.with.length > 0) ? this.installCTEs(select.with) : null;

      const fromName = select.from;
      let baseRows = this.getTable(fromName);
      if (!baseRows) throw new Error(`Table not found: ${fromName}`);

      const hasJoins = !!(select.joins && select.joins.length > 0);

      // Strip alias from WHERE expr (for non-JOIN queries)
      const fromAlias = select.fromAlias;

      const stripAliasFromColumn = (col) => {
        if (!fromAlias) return col;
        if (Array.isArray(col)) return col.map(c => stripAliasFromColumn(c));
        if (typeof col === 'string' && col.startsWith(fromAlias + '.')) return col.slice(fromAlias.length + 1);
        return col;
      };

      const stripAliasFromWhereExpr = (expr) => {
        if (!fromAlias || !expr) return expr;
        if (expr.type === 'pred') {
          return { ...expr, pred: { ...expr.pred, column: stripAliasFromColumn(expr.pred.column) } };
        }
        if (expr.type === 'not') return { ...expr, expr: stripAliasFromWhereExpr(expr.expr) };
        if (expr.type === 'and' || expr.type === 'or') {
          return { ...expr, left: stripAliasFromWhereExpr(expr.left), right: stripAliasFromWhereExpr(expr.right) };
        }
        return expr;
      };

      if (hasJoins) {
        // Materialize left side with alias namespace
        const baseAlias = fromAlias || fromName;
        let joinedRows = this.namespaceRows(baseRows, baseAlias);

        for (const j of select.joins) {
          const rightRows = this.getTable(j.table);
          if (!rightRows) throw new Error(`Table not found: ${j.table}`);
          const rightAlias = j.alias || j.table;
          joinedRows = this.executeJoin(joinedRows, baseAlias, rightRows, rightAlias, j.type, j.on);
        }

        // WHERE on joined rows
        if (select.whereExpr) {
          joinedRows = this.filterRowsByWhereExpr(joinedRows, select.whereExpr);
        }

        // SELECT *
        if (select.columns[0] === '*') {
          let outRows = joinedRows;
          if (select.orderBy && select.orderBy.length > 0) {
            outRows = this.executeOrderBy(outRows, select.orderBy, []);
          }
          if (select.offset !== undefined) outRows = outRows.slice(select.offset);
          if (select.limit !== undefined) outRows = outRows.slice(0, select.limit);

          const cols = outRows.length > 0 ? Object.keys(outRows[0]) : [];
          return { columns: cols, rows: outRows, rowCount: outRows.length };
        }

        const selections = this.buildSelections(select.columns);

        let rows;
        if (select.groupBy && select.groupBy.length > 0) {
          rows = this.executeGroupBy(joinedRows, selections, select.groupBy);
          if (select.havingExpr) {
            rows = this.filterRowsByWhereExpr(rows, select.havingExpr);
          }
        } else {
          if (select.havingExpr) throw new Error('HAVING requires GROUP BY');
          if (this.hasAggregateInSelections(selections)) {
            rows = this.executeGroupBy(joinedRows, selections, []);
          } else {
            rows = joinedRows.map(r => this.projectRow(r, selections));
          }
        }

        const outputColumns = selections.map(s => s.name);
        if (select.orderBy && select.orderBy.length > 0) {
          rows = this.executeOrderBy(rows, select.orderBy, outputColumns);
        }
        if (select.offset !== undefined) rows = rows.slice(select.offset);
        if (select.limit !== undefined) rows = rows.slice(0, select.limit);

        if (select.distinct) {
          rows = this.applyDistinct(rows);
        }

        return { columns: outputColumns, rows, rowCount: rows.length };
      }

      // Non-JOIN path
      let filteredRows = baseRows;

      // Apply alias prefix for WHERE
      const effectiveWhereExpr = select.whereExpr ? stripAliasFromWhereExpr(select.whereExpr) : null;

      if (effectiveWhereExpr) {
        filteredRows = this.filterRowsByWhereExpr(filteredRows, effectiveWhereExpr);
      }

      // SELECT *
      if (select.columns[0] === '*') {
        let outRows = filteredRows;

        // Add alias prefix if needed
        if (fromAlias && outRows.length > 0) {
          const cols = Object.keys(outRows[0]);
          outRows = outRows.map(r => {
            const newR = { ...r };
            for (const c of cols) {
              const k = `${fromAlias}.${c}`;
              if (!(k in newR)) newR[k] = r[c];
            }
            return newR;
          });
        }

        if (select.orderBy && select.orderBy.length > 0) {
          outRows = this.executeOrderBy(outRows, select.orderBy, []);
        }
        if (select.offset !== undefined) outRows = outRows.slice(select.offset);
        if (select.limit !== undefined) outRows = outRows.slice(0, select.limit);

        if (select.distinct) outRows = this.applyDistinct(outRows);

        const cols = outRows.length > 0 ? Object.keys(outRows[0]) : (baseRows.length > 0 ? Object.keys(baseRows[0]) : []);
        return { columns: cols, rows: outRows, rowCount: outRows.length };
      }

      const selections = this.buildSelections(select.columns);

      // Add alias prefixes so expr references work
      let rows2 = filteredRows;
      if (fromAlias && rows2.length > 0) {
        const cols = Object.keys(rows2[0]);
        rows2 = rows2.map(r => {
          const newR = { ...r };
          for (const c of cols) {
            const k = `${fromAlias}.${c}`;
            if (!(k in newR)) newR[k] = r[c];
          }
          return newR;
        });
      }

      // Prepare inline windows
      const { selections: rewrittenSel, windowItems } = this.prepareInlineWindows(selections);

      // Apply window functions to rows
      this.applyWindowAndAliases(rows2, rewrittenSel);
      for (const item of windowItems) {
        const values = this.computeWindowColumn(rows2, item.spec);
        for (let i = 0; i < rows2.length; i++) {
          rows2[i][item.name] = values[i];
        }
      }

      let rows;
      if (select.groupBy && select.groupBy.length > 0) {
        rows = this.executeGroupBy(rows2, rewrittenSel, select.groupBy);
        if (select.havingExpr) {
          rows = this.filterRowsByWhereExpr(rows, select.havingExpr);
        }
      } else {
        if (select.havingExpr) throw new Error('HAVING requires GROUP BY');
        if (this.hasAggregateInSelections(rewrittenSel)) {
          rows = this.executeGroupBy(rows2, rewrittenSel, []);
        } else {
          rows = rows2.map(r => this.projectRow(r, rewrittenSel));
        }
      }

      const outputColumns = selections.map(s => s.name);

      if (select.orderBy && select.orderBy.length > 0) {
        rows = this.executeOrderBy(rows, select.orderBy, outputColumns);
      }

      if (select.offset !== undefined) rows = rows.slice(select.offset);
      if (select.limit !== undefined) rows = rows.slice(0, select.limit);

      if (select.distinct) rows = this.applyDistinct(rows);

      return { columns: outputColumns, rows, rowCount: rows.length };

    } finally {
      if (restore) restore();
    }
  }

  applyDistinct(rows) {
    const seen = new Set();
    return rows.filter(r => {
      const key = JSON.stringify(Object.values(r));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // ---------------------------------------------------------------------------
  // projectRow
  // ---------------------------------------------------------------------------

  projectRow(row, selections) {
    const out = {};
    for (const s of selections) {
      if (Object.prototype.hasOwnProperty.call(row, s.name)) {
        out[s.name] = row[s.name];
        continue;
      }

      const rawExpr = s.__rewrittenExpr !== undefined ? s.__rewrittenExpr : s.expr;
      const expr = this.normalizeExpr(rawExpr);

      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(expr)) {
        out[s.name] = row[expr];
        continue;
      }

      // dotted identifier
      if (/^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/.test(expr)) {
        out[s.name] = row[expr];
        continue;
      }

      try {
        out[s.name] = this.evalScalarExpr(expr, row);
      } catch (e) {
        out[s.name] = undefined;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // WHERE row-level evaluation
  // ---------------------------------------------------------------------------

  filterRowsByWhereExpr(rows, expr) {
    const self = this;

    const evalNode = (row, n) => {
      switch (n.type) {
        case 'pred': {
          const v = self.getConditionValueFromRow(row, n.pred.column);
          return self.evaluateCondition(v, n.pred.operator, n.pred.value);
        }
        case 'and':
          return evalNode(row, n.left) && evalNode(row, n.right);
        case 'or':
          return evalNode(row, n.left) || evalNode(row, n.right);
        case 'not':
          return !evalNode(row, n.expr);
        default:
          return false;
      }
    };

    return rows.filter(r => evalNode(r, expr));
  }

  getConditionValueFromRow(row, column) {
    if (Array.isArray(column)) return column.map(c => this.getConditionValueFromRow(row, c));

    const expr = this.normalizeExpr(column);

    // plain column
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(expr)) {
      return row[expr] !== undefined ? row[expr] : this.evalScalarExpr(expr, row);
    }

    // dotted
    if (expr in row) return row[expr];

    // scalar expr (for HAVING)
    try {
      return this.evalScalarExpr(expr, row);
    } catch (e) {
      return undefined;
    }
  }

  sqlEquals(a, b) {
    if (a === b) return true;
    if (typeof a === 'string' && typeof b === 'string') return a === b;
    if (a == null || b == null) return false;

    // number ↔ string
    if (typeof a === 'number' && typeof b === 'string' && b.trim() !== '' && Number.isFinite(Number(b))) {
      return a === Number(b);
    }
    if (typeof a === 'string' && typeof b === 'number' && a.trim() !== '' && Number.isFinite(Number(a))) {
      return Number(a) === b;
    }

    return false;
  }

  evaluateCondition(value, operator, compareValue) {
    switch (operator) {
      case '=':
        return this.sqlEquals(value, compareValue);
      case '!=':
      case '<>':
        return !this.sqlEquals(value, compareValue);
      case '<':
        return value < compareValue;
      case '>':
        return value > compareValue;
      case '<=':
        return value <= compareValue;
      case '>=':
        return value >= compareValue;
      case 'IN': {
        if (compareValue && typeof compareValue === 'object' && 'subquery' in compareValue) {
          const subRes = this.executeSelect(compareValue.subquery);
          if (subRes.rowCount === 0 || subRes.columns.length === 0) return false;
          const col0 = subRes.columns[0];
          const vals = subRes.rows.map(r => r[col0]);
          if (Array.isArray(value)) throw new Error('Multi-column IN subquery not supported');
          return vals.some(v => this.sqlEquals(value, v));
        }

        if (!Array.isArray(compareValue)) return false;

        if (Array.isArray(value)) {
          return compareValue.some(tuple => {
            if (!Array.isArray(tuple)) return false;
            if (tuple.length !== value.length) return false;
            for (let i = 0; i < value.length; i++) {
              if (!this.sqlEquals(value[i], tuple[i])) return false;
            }
            return true;
          });
        }

        return compareValue.some(v => this.sqlEquals(value, v));
      }
      case 'LIKE':
        return this.likeMatch(String(value ?? ''), String(compareValue));
      default:
        return false;
    }
  }

  likeMatch(value, pattern) {
    const regex = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/%/g, '.*')
      .replace(/_/g, '.');
    return new RegExp(`^${regex}$`, 'i').test(value);
  }

  // ---------------------------------------------------------------------------
  // JOIN
  // ---------------------------------------------------------------------------

  namespaceRows(rows, alias) {
    return rows.map(r => {
      const out = {};
      for (const k of Object.keys(r)) {
        out[`${alias}.${k}`] = r[k];
        out[k] = r[k]; // also keep plain for fallback
      }
      return out;
    });
  }

  executeJoin(leftRows, leftAlias, rightRows, rightAlias, joinType, on) {
    // namespace right rows
    const rightNS = rightRows.map(r => {
      const out = {};
      for (const k of Object.keys(r)) {
        out[`${rightAlias}.${k}`] = r[k];
      }
      return out;
    });

    // Determine ON pairs: normalize so left refers to leftAlias namespace, right to rightAlias
    const pairs = on.map(p => {
      const l = String(p.left).trim();
      const r = String(p.right).trim();
      // Determine which side is right
      const lIsRight = l.startsWith(`${rightAlias}.`);
      const rIsRight = r.startsWith(`${rightAlias}.`);
      if (lIsRight && !rIsRight) {
        return { leftKey: this.qualifyRef(r, leftAlias), rightKey: l };
      }
      return { leftKey: this.qualifyRef(l, leftAlias), rightKey: this.qualifyRef(r, rightAlias) };
    });

    // Build hash index on right
    const index = new Map();
    for (const rr of rightNS) {
      const key = pairs.map(p => String(rr[p.rightKey] ?? '')).join('\u0000');
      const arr = index.get(key);
      if (arr) arr.push(rr);
      else index.set(key, [rr]);
    }

    const rightNullTemplate = {};
    if (rightNS.length > 0) {
      for (const k of Object.keys(rightNS[0])) rightNullTemplate[k] = null;
    } else if (rightRows.length > 0) {
      for (const k of Object.keys(rightRows[0])) rightNullTemplate[`${rightAlias}.${k}`] = null;
    }

    const out = [];
    for (const lr of leftRows) {
      const key = pairs.map(p => {
        const v = lr[p.leftKey] !== undefined ? lr[p.leftKey] : lr[p.leftKey.split('.').pop()];
        return String(v ?? '');
      }).join('\u0000');
      const matches = index.get(key);

      if (matches && matches.length > 0) {
        for (const rr of matches) {
          out.push({ ...lr, ...rr });
        }
      } else if (joinType === 'LEFT') {
        out.push({ ...lr, ...rightNullTemplate });
      }
    }

    return out;
  }

  qualifyRef(ref, alias) {
    const t = String(ref).trim();
    if (t.includes('.')) return t;
    return `${alias}.${t}`;
  }

  // ---------------------------------------------------------------------------
  // Window functions
  // ---------------------------------------------------------------------------

  applyWindowAndAliases(rows, selections) {
    // 1) Simple column aliases
    for (const s of selections) {
      if (s.name === s.expr) continue;
      const expr = this.normalizeExpr(s.expr);
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(expr)) {
        for (const r of rows) {
          if (!Object.prototype.hasOwnProperty.call(r, s.name)) {
            r[s.name] = r[expr];
          }
        }
      }
    }

    // 2) Compute window functions
    for (const s of selections) {
      const spec = this.parseWindowExpr(s.expr);
      if (spec) {
        const values = this.computeWindowColumn(rows, spec);
        for (let i = 0; i < rows.length; i++) {
          rows[i][s.name] = values[i];
        }
      }
    }
  }

  prepareInlineWindows(selections) {
    const windowItems = [];
    const newSelections = selections.map(s => ({ ...s }));

    for (let i = 0; i < newSelections.length; i++) {
      const s = newSelections[i];
      if (!/\bOVER\b/i.test(s.expr)) continue;

      const { rewrittenExpr, extracted } = this.extractInlineWindows(s.expr, i);
      if (extracted.length > 0) {
        s.__rewrittenExpr = rewrittenExpr;
        for (const e of extracted) {
          windowItems.push({ spec: e.spec, name: e.placeholder, rawExpr: e.rawExpr });
        }
      }
    }

    return { selections: newSelections, windowItems };
  }

  extractInlineWindows(expr, selIdx) {
    const extracted = [];
    let rewritten = expr;

    // Match FUNC(...) OVER (...)
    const windowRegex = /([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\s*([^)]*)\s*\)\s+OVER\s*\(([^)]+)\)/gi;
    let match;

    while ((match = windowRegex.exec(expr)) !== null) {
      const rawExpr = match[0];
      const funcRaw = match[1];
      const argRaw = match[2].trim();
      const overRaw = match[3];

      const func = this.mapWindowFunc(funcRaw.toLowerCase());
      if (!func) continue;

      const spec = {
        func,
        arg: argRaw === '' ? undefined : argRaw,
        partitionBy: this.parsePartitionByClause(overRaw),
        orderBy: this.parseOrderByClause(overRaw),
        frame: this.parseRowsFrame(overRaw),
      };

      const placeholder = `__iw_${selIdx}_${extracted.length}`;
      extracted.push({ placeholder, spec, rawExpr });

      rewritten = rewritten.replace(rawExpr, placeholder);
    }

    return { rewrittenExpr: rewritten, extracted };
  }

  parseWindowExpr(expr) {
    const s = this.normalizeExpr(expr);
    if (!/\bOVER\b/i.test(s)) return null;

    // ROW_NUMBER() OVER (...)
    {
      const m = s.match(/^ROW_NUMBER\s*\(\s*\)\s*OVER\s*\(\s*(.+)\s*\)$/i);
      if (m) {
        const over = m[1];
        return {
          func: 'row_number',
          partitionBy: this.parsePartitionByClause(over),
          orderBy: this.parseOrderByClause(over),
          frame: this.parseRowsFrame(over),
        };
      }
    }

    // RANK() OVER (...)
    {
      const m = s.match(/^RANK\s*\(\s*\)\s*OVER\s*\(\s*(.+)\s*\)$/i);
      if (m) {
        const over = m[1];
        return {
          func: 'rank',
          partitionBy: this.parsePartitionByClause(over),
          orderBy: this.parseOrderByClause(over),
          frame: this.parseRowsFrame(over),
        };
      }
    }

    // LAG(col, n) OVER (...)
    {
      const m = s.match(/^LAG\s*\(\s*([^,)]+)(?:,\s*(\d+))?\s*\)\s*OVER\s*\(\s*(.+)\s*\)$/i);
      if (m) {
        const over = m[3];
        return {
          func: 'lag',
          arg: m[1].trim(),
          lagN: m[2] ? parseInt(m[2]) : 1,
          partitionBy: this.parsePartitionByClause(over),
          orderBy: this.parseOrderByClause(over),
          frame: undefined,
        };
      }
    }

    // LEAD(col, n) OVER (...)
    {
      const m = s.match(/^LEAD\s*\(\s*([^,)]+)(?:,\s*(\d+))?\s*\)\s*OVER\s*\(\s*(.+)\s*\)$/i);
      if (m) {
        const over = m[3];
        return {
          func: 'lead',
          arg: m[1].trim(),
          leadN: m[2] ? parseInt(m[2]) : 1,
          partitionBy: this.parsePartitionByClause(over),
          orderBy: this.parseOrderByClause(over),
          frame: undefined,
        };
      }
    }

    // strftime(col, 'fmt') OVER (...)  - unusual but supported
    {
      const m = s.match(/^strftime\s*\(\s*([^,)]+),\s*'([^']*)'\s*\)\s*OVER\s*\(\s*(.+)\s*\)$/i);
      if (m) {
        const over = m[3];
        return {
          func: 'strftime',
          arg: m[1].trim(),
          fmtArg: m[2],
          partitionBy: this.parsePartitionByClause(over),
          orderBy: this.parseOrderByClause(over),
          frame: undefined,
        };
      }
    }

    // FUNC(arg) OVER (...)
    const m = s.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\s*([^)]*)\s*\)\s*OVER\s*\(\s*(.+)\s*\)$/i);
    if (!m) return null;

    const funcRaw = m[1].toLowerCase();
    const argRaw = m[2].trim();
    const over = m[3];

    const func = this.mapWindowFunc(funcRaw);
    if (!func) return null;

    return {
      func,
      arg: argRaw === '' ? undefined : argRaw,
      partitionBy: this.parsePartitionByClause(over),
      orderBy: this.parseOrderByClause(over),
      frame: this.parseRowsFrame(over),
    };
  }

  mapWindowFunc(func) {
    switch (func) {
      case 'row_number': return 'row_number';
      case 'rank': return 'rank';
      case 'count': return 'count';
      case 'sum': return 'sum';
      case 'avg': return 'avg';
      case 'min': return 'min';
      case 'max': return 'max';
      case 'variance':
      case 'var': return 'variance';
      case 'stddev':
      case 'std': return 'stddev';
      case 'lag': return 'lag';
      case 'lead': return 'lead';
      case 'strftime': return 'strftime';
      default: return null;
    }
  }

  parsePartitionByClause(over) {
    const m = over.match(/PARTITION\s+BY\s+(.+?)(?=(ORDER\s+BY|ROWS\s+BETWEEN|$))/i);
    if (!m) return [];
    return m[1].split(',').map(x => x.trim()).filter(Boolean);
  }

  parseOrderByClause(over) {
    const m = over.match(/ORDER\s+BY\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(ASC|DESC))?/i);
    if (!m) return undefined;
    return { column: m[1], direction: (m[2] || 'ASC').toUpperCase() };
  }

  parseRowsFrame(over) {
    const m = over.match(/ROWS\s+BETWEEN\s+(\d+|UNBOUNDED)\s+PRECEDING\s+AND\s+CURRENT\s+ROW/i);
    if (!m) return undefined;
    const p = m[1].toUpperCase() === 'UNBOUNDED' ? 'unbounded' : Number(m[1]);
    return { kind: 'rows', preceding: p, following: 0 };
  }

  computeWindowColumn(rows, spec) {
    const out = new Array(rows.length).fill(NaN);

    const partCols = spec.partitionBy || [];
    const order = spec.orderBy;
    const dir = order?.direction || 'ASC';

    // Group rows by partition
    const groups = new Map();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const key = partCols.length === 0 ? '__all__' : partCols.map(c => String(r[c] ?? '')).join('|');
      let arr = groups.get(key);
      if (!arr) { arr = []; groups.set(key, arr); }
      arr.push(i);
    }

    for (const indices of groups.values()) {
      // Sort within partition
      if (order) {
        indices.sort((ia, ib) => {
          const a = rows[ia][order.column];
          const b = rows[ib][order.column];
          const cmp = this.compareValues(a, b);
          return dir === 'ASC' ? cmp : -cmp;
        });
      }

      if (spec.func === 'row_number') {
        for (let p = 0; p < indices.length; p++) {
          out[indices[p]] = p + 1;
        }
        continue;
      }

      if (spec.func === 'rank') {
        // Rank: rows with same order value get same rank
        for (let p = 0; p < indices.length; p++) {
          let rank = p + 1;
          if (p > 0 && order) {
            const prev = rows[indices[p - 1]][order.column];
            const curr = rows[indices[p]][order.column];
            if (this.compareValues(prev, curr) === 0) {
              rank = out[indices[p - 1]];
            }
          }
          out[indices[p]] = rank;
        }
        continue;
      }

      if (spec.func === 'lag') {
        const n = spec.lagN || 1;
        for (let p = 0; p < indices.length; p++) {
          const srcIdx = p - n;
          if (srcIdx < 0) {
            out[indices[p]] = null;
          } else {
            out[indices[p]] = rows[indices[srcIdx]][spec.arg];
          }
        }
        continue;
      }

      if (spec.func === 'lead') {
        const n = spec.leadN || 1;
        for (let p = 0; p < indices.length; p++) {
          const srcIdx = p + n;
          if (srcIdx >= indices.length) {
            out[indices[p]] = null;
          } else {
            out[indices[p]] = rows[indices[srcIdx]][spec.arg];
          }
        }
        continue;
      }

      if (spec.func === 'strftime') {
        for (let p = 0; p < indices.length; p++) {
          const ridx = indices[p];
          const ts = rows[ridx][spec.arg];
          out[ridx] = this.strftimeFormat(ts, spec.fmtArg || '%Y-%m-%d');
        }
        continue;
      }

      const argCol = spec.arg && spec.arg !== '*' ? spec.arg : undefined;

      const preceding = spec.frame?.preceding !== undefined ? spec.frame.preceding : 'unbounded';
      const winLen = preceding === 'unbounded' ? Infinity : (preceding + 1);

      // Circular buffer for fixed window
      let buf = winLen !== Infinity ? new Array(winLen).fill(0) : null;
      let head = 0;
      let size = 0;
      let sum = 0;
      let sumSq = 0;

      const pushVal = (v) => {
        if (!buf) return;
        buf[(head + size) % buf.length] = v;
        size++;
      };
      const popVal = () => {
        if (!buf || size === 0) return NaN;
        const v = buf[head];
        head = (head + 1) % buf.length;
        size--;
        return v;
      };

      // deque for min/max
      const dequeIdx = [];
      const dequeVal = [];

      const dequePush = (pos, v, isMin) => {
        while (dequeIdx.length > 0) {
          const last = dequeVal[dequeVal.length - 1];
          if (isMin ? last <= v : last >= v) break;
          dequeIdx.pop();
          dequeVal.pop();
        }
        dequeIdx.push(pos);
        dequeVal.push(v);
      };

      const dequeExpire = (pos, window) => {
        const minPos = pos - window + 1;
        while (dequeIdx.length > 0 && dequeIdx[0] < minPos) {
          dequeIdx.shift();
          dequeVal.shift();
        }
      };

      for (let p = 0; p < indices.length; p++) {
        const ridx = indices[p];

        if (spec.func === 'count' && (!argCol || spec.arg === '*')) {
          if (winLen === Infinity) {
            out[ridx] = p + 1;
          } else {
            out[ridx] = Math.min(p + 1, winLen);
          }
          continue;
        }

        const raw = argCol ? rows[ridx][argCol] : undefined;
        const v = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(v)) {
          out[ridx] = NaN;
          continue;
        }

        if (winLen !== Infinity) {
          pushVal(v);
          if (size > winLen) {
            const old = popVal();
            sum -= old;
            sumSq -= old * old;
            if (spec.func === 'min' || spec.func === 'max') {
              dequeExpire(p, winLen);
            }
          }
        }

        sum += v;
        sumSq += v * v;

        if (spec.func === 'min' || spec.func === 'max') {
          dequePush(p, v, spec.func === 'min');
          if (winLen !== Infinity) {
            dequeExpire(p, winLen);
          }
        }

        const n = winLen === Infinity ? (p + 1) : size;
        out[ridx] = this.windowAggValue(spec.func, n, sum, sumSq, dequeVal[0]);
      }
    }

    return out;
  }

  windowAggValue(func, n, sum, sumSq, dequeFront) {
    if (n <= 0) return NaN;

    switch (func) {
      case 'count': return n;
      case 'sum': return sum;
      case 'avg': return sum / n;
      case 'min':
      case 'max':
        return dequeFront !== undefined ? dequeFront : NaN;
      case 'variance': {
        if (n <= 1) return 0;
        const mean = sum / n;
        const varSamp = (sumSq - n * mean * mean) / (n - 1);
        return Math.max(0, varSamp);
      }
      case 'stddev': {
        if (n <= 1) return 0;
        const mean = sum / n;
        const varSamp = (sumSq - n * mean * mean) / (n - 1);
        return Math.sqrt(Math.max(0, varSamp));
      }
      default:
        return NaN;
    }
  }

  strftimeFormat(ts, fmt) {
    // ts is either a Unix timestamp (ms or s), convert to Date
    let ms = typeof ts === 'number' ? ts : Number(ts);
    // Heuristic: if < 1e12 then it's seconds
    if (ms < 1e12) ms *= 1000;
    const d = new Date(ms);
    const pad = (n, w) => String(n).padStart(w || 2, '0');
    return fmt
      .replace('%Y', d.getUTCFullYear())
      .replace('%m', pad(d.getUTCMonth() + 1))
      .replace('%d', pad(d.getUTCDate()))
      .replace('%H', pad(d.getUTCHours()))
      .replace('%M', pad(d.getUTCMinutes()))
      .replace('%S', pad(d.getUTCSeconds()));
  }

  compareValues(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
    const sa = String(a ?? '');
    const sb = String(b ?? '');
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  normalizeExpr(expr) {
    return String(expr)
      .replace(/\s+/g, ' ')
      .replace(/\s*\.\s*/g, '.')
      .replace(/\s*\(\s*/g, '(')  // 去除 ( 前的空格和 ( 后的空格
      .replace(/\s*\)/g, ')')     // 去除 ) 前的空格
      .trim();
  }

  buildSelections(cols) {
    const norm = (x) => this.normalizeExpr(x);

    const proposed = cols.map(c => {
      if (typeof c === 'string') {
        const expr = norm(c);
        if (IDENT_RE.test(expr)) {
          const last = expr.split('.').pop();
          return { expr, proposed: last, explicit: false };
        }
        return { expr, proposed: expr, explicit: false };
      }

      const expr = norm(c.expr);
      const name = c.alias || expr;
      return { expr, proposed: name, explicit: true };
    });

    const counts = new Map();
    for (const p of proposed) {
      const key = p.proposed;
      counts.set(key, (counts.get(key) || 0) + 1);
    }

    return proposed.map(p => {
      if (p.explicit) return { expr: p.expr, name: p.proposed };
      if ((counts.get(p.proposed) || 0) > 1) return { expr: p.expr, name: p.expr };
      return { expr: p.expr, name: p.proposed };
    });
  }

  // ---------------------------------------------------------------------------
  // Scalar expressions
  // ---------------------------------------------------------------------------

  evalScalarExpr(expr, row) {
    // Pre-process CAST(x AS type) -> CAST(x)  (type annotation ignored, just return value)
    const preprocessed = expr.replace(/\bCAST\s*\(\s*(.+?)\s+AS\s+[a-zA-Z_][a-zA-Z0-9_]*\s*\)/gi, (m, inner) => `CAST(${inner})`);
    const tokens = this.tokenizeExpr(preprocessed);
    let pos = 0;

    const peek = () => tokens[pos];
    const consume = (expected) => {
      const t = tokens[pos];
      if (!t) throw new Error(`Unexpected end of expression: ${expr}`);
      if (expected && t.value.toUpperCase() !== expected.toUpperCase()) {
        throw new Error(`Expected ${expected}, got ${t.value} in expr: ${expr}`);
      }
      pos++;
      return t;
    };

    const parseExpression = () => parseComparison();

    // comparison: a > b, a = b, etc. (lowest precedence in scalar, needed for IF conditions)
    const parseComparison = () => {
      let node = parseConcat();
      const t = peek();
      if (t && t.kind === 'op' && ['=', '!=', '<>', '<', '>', '<=', '>='].includes(t.value)) {
        const op = consume().value;
        const right = parseConcat();
        return { type: 'cmp', op, left: node, right };
      }
      return node;
    };

    const parseConcat = () => {
      let node = parseAddSub();
      while (true) {
        const t = peek();
        if (!t) break;
        if (t.kind === 'op' && t.value === '||') {
          consume();
          const right = parseAddSub();
          node = { type: 'bin', op: '||', left: node, right };
          continue;
        }
        break;
      }
      return node;
    };

    const parseAddSub = () => {
      let node = parseMulDiv();
      while (true) {
        const t = peek();
        if (!t) break;
        if (t.kind === 'op' && (t.value === '+' || t.value === '-')) {
          const op = consume().value;
          const right = parseMulDiv();
          node = { type: 'bin', op, left: node, right };
          continue;
        }
        break;
      }
      return node;
    };

    const parseMulDiv = () => {
      let node = parseUnary();
      while (true) {
        const t = peek();
        if (!t) break;
        if (t.kind === 'op' && (t.value === '*' || t.value === '/' || t.value === '%')) {
          const op = consume().value;
          const right = parseUnary();
          node = { type: 'bin', op, left: node, right };
          continue;
        }
        break;
      }
      return node;
    };

    const parseUnary = () => {
      const t = peek();
      if (t && t.kind === 'op' && (t.value === '+' || t.value === '-')) {
        const op = consume().value;
        const inner = parseUnary();
        return { type: 'unary', op, inner };
      }
      return parsePrimary();
    };

    const parsePrimary = () => {
      const t = peek();
      if (!t) throw new Error(`Unexpected end of expression: ${expr}`);

      if (t.kind === 'number') {
        consume();
        return { type: 'number', value: Number(t.value) };
      }

      if (t.kind === 'string') {
        consume();
        return { type: 'string', value: t.value };
      }

      if (t.value === '(') {
        consume('(');
        const inner = parseExpression();
        consume(')');
        return inner;
      }

      if (t.kind === 'ident') {
        const name = consume().value;

        if (peek()?.value === '(') {
          consume('(');
          const args = [];
          if (peek()?.value !== ')') {
            while (true) {
              args.push(parseExpression());
              if (peek()?.value === ',') {
                consume(',');
                continue;
              }
              break;
            }
          }
          consume(')');
          return { type: 'call', name, args };
        }

        return { type: 'ident', name };
      }

      throw new Error(`Unexpected token ${t.value} in expr: ${expr}`);
    };

    const ast = parseExpression();

    const evalNode = (n) => {
      switch (n.type) {
        case 'number':
          return n.value;
        case 'string':
          return n.value;
        case 'ident': {
          const v = row[n.name];
          return v !== undefined ? v : undefined;
        }
        case 'unary': {
          const v = Number(evalNode(n.inner));
          return n.op === '-' ? -v : +v;
        }
        case 'cmp': {
          const a = evalNode(n.left);
          const b = evalNode(n.right);
          return this.evaluateCondition(a, n.op, b) ? 1 : 0;
        }
        case 'bin': {
          if (n.op === '||') {
            const a = evalNode(n.left);
            const b = evalNode(n.right);
            return String(a ?? '') + String(b ?? '');
          }

          const a = Number(evalNode(n.left));
          const b = Number(evalNode(n.right));
          switch (n.op) {
            case '+': return a + b;
            case '-': return a - b;
            case '*': return a * b;
            case '/': return b === 0 ? NaN : a / b;
            case '%': return a % b;
            default: return NaN;
          }
        }
        case 'call': {
          const fname = String(n.name).toUpperCase();

          // CAST(x AS type) - special handling for AS keyword
          if (fname === 'CAST') {
            // args[0] = value, args[1] = type name (ident) - but AS is parsed as ident
            // We just return the value coerced
            const rawVal = evalNode(n.args[0]);
            // The type would be in args[1] but tokenizer sees AS as ident
            // Just return value as-is (type coercion not critical for row arrays)
            return rawVal;
          }

          // IF/IIF: special - first arg is condition (boolean), not numeric
          if (fname === 'IF' || fname === 'IIF') {
            const condNode = n.args[0];
            const condVal = evalNode(condNode);
            const isTruthy = condVal !== 0 && condVal !== null && condVal !== undefined && condVal !== false;
            return isTruthy ? evalNode(n.args[1]) : evalNode(n.args[2]);
          }

          const args = (n.args || []).map(x => evalNode(x));

          switch (fname) {
            case 'SQRT': return Math.sqrt(Number(args[0]));
            case 'ABS': return Math.abs(Number(args[0]));
            case 'LN':
            case 'LOG': return Math.log(Number(args[0]));
            case 'LOG2': return Math.log2(Number(args[0]));
            case 'LOG10': return Math.log10(Number(args[0]));
            case 'EXP': return Math.exp(Number(args[0]));
            case 'POW':
            case 'POWER': return Math.pow(Number(args[0]), Number(args[1]));
            case 'ROUND': {
              const x = Number(args[0]);
              const nDigits = args.length >= 2 ? Number(args[1]) : 0;
              const f = Math.pow(10, nDigits);
              return Math.round(x * f) / f;
            }
            case 'FLOOR': return Math.floor(Number(args[0]));
            case 'CEIL':
            case 'CEILING': return Math.ceil(Number(args[0]));
            case 'SIGN': return Math.sign(Number(args[0]));
            case 'MIN': return Math.min(...args.map(x => Number(x)));
            case 'MAX': return Math.max(...args.map(x => Number(x)));
            case 'COALESCE': {
              for (const a of args) {
                if (a !== null && a !== undefined) return a;
              }
              return null;
            }
            case 'IF':
            case 'IIF': {
              // IF(cond_expr, a, b) - evaluate cond_expr as boolean
              // args[0] is already evaluated as number (0/1)
              return args[0] ? args[1] : args[2];
            }
            case 'NULLIF': {
              return this.sqlEquals(args[0], args[1]) ? null : args[0];
            }
            case 'CAST': {
              // CAST(x AS type) - handled specially below
              // args[0] = value, args[1] might be the type string
              return args[0]; // simplified - just return value
            }
            case 'STRFTIME': {
              // strftime(ts, 'fmt')
              return this.strftimeFormat(args[0], String(args[1] || '%Y-%m-%d'));
            }
            case 'COSINE_SIM': {
              // COSINE_SIM(field, [v1,v2,...]) - handled in WHERE level
              return 0;
            }
            case 'LENGTH':
            case 'LEN': return String(args[0] ?? '').length;
            case 'UPPER': return String(args[0] ?? '').toUpperCase();
            case 'LOWER': return String(args[0] ?? '').toLowerCase();
            case 'TRIM': return String(args[0] ?? '').trim();
            case 'SUBSTR':
            case 'SUBSTRING': {
              const s = String(args[0] ?? '');
              const start = Number(args[1]) - 1; // SQL is 1-indexed
              const len = args[2] !== undefined ? Number(args[2]) : undefined;
              return len !== undefined ? s.substr(start, len) : s.substr(start);
            }
            case 'REPLACE': {
              const s = String(args[0] ?? '');
              return s.split(String(args[1])).join(String(args[2]));
            }
            case 'CONCAT': {
              return args.map(a => String(a ?? '')).join('');
            }
            default:
              throw new Error(`Unsupported function: ${n.name}`);
          }
        }
        default:
          return NaN;
      }
    };

    return evalNode(ast);
  }

  tokenizeExpr(expr) {
    const s = String(expr);
    const out = [];
    let i = 0;

    while (i < s.length) {
      const ch = s[i];
      if (/\s/.test(ch)) { i++; continue; }

      if (ch === "'" || ch === '"') {
        const quote = ch;
        i++;
        let buf = '';
        while (i < s.length && s[i] !== quote) {
          if (s[i] === '\\' && i + 1 < s.length) {
            buf += s[i + 1];
            i += 2;
          } else {
            buf += s[i];
            i++;
          }
        }
        i++;
        out.push({ kind: 'string', value: buf });
        continue;
      }

      if (/[0-9]/.test(ch) || (ch === '.' && i + 1 < s.length && /[0-9]/.test(s[i + 1]))) {
        let num = '';
        while (i < s.length && /[0-9eE+\-\.]/.test(s[i])) {
          num += s[i];
          i++;
        }
        out.push({ kind: 'number', value: num });
        continue;
      }

      if (/[a-zA-Z_]/.test(ch)) {
        let id = '';
        while (i < s.length && /[a-zA-Z0-9_\.]/.test(s[i])) {
          id += s[i];
          i++;
        }
        out.push({ kind: 'ident', value: id });
        continue;
      }

      if (ch === '|' && i + 1 < s.length && s[i + 1] === '|') {
        out.push({ kind: 'op', value: '||' });
        i += 2;
        continue;
      }

      if (ch === '!' && i + 1 < s.length && s[i + 1] === '=') {
        out.push({ kind: 'op', value: '!=' });
        i += 2;
        continue;
      }

      if (ch === '<' && i + 1 < s.length && s[i + 1] === '=') {
        out.push({ kind: 'op', value: '<=' });
        i += 2;
        continue;
      }

      if (ch === '>' && i + 1 < s.length && s[i + 1] === '=') {
        out.push({ kind: 'op', value: '>=' });
        i += 2;
        continue;
      }

      if (ch === '<' && i + 1 < s.length && s[i + 1] === '>') {
        out.push({ kind: 'op', value: '<>' });
        i += 2;
        continue;
      }

      if ('()+-*/%,<>='.includes(ch)) {
        out.push({ kind: 'op', value: ch });
        i++;
        continue;
      }

      throw new Error(`Unexpected char '${ch}' in expr: ${expr}`);
    }

    return out;
  }

  // ---------------------------------------------------------------------------
  // GROUP BY & Aggregation
  // ---------------------------------------------------------------------------

  hasAggregateFunction(expr) {
    const normalized = this.normalizeExpr(expr).toLowerCase().replace(/\s+/g, '');
    const aggregateFunctions = ['count(', 'sum(', 'avg(', 'min(', 'max(', 'stddev(', 'variance(', 'first(', 'last(', 'percentile(', 'corr('];
    for (const fn of aggregateFunctions) {
      if (normalized.includes(fn)) return true;
    }
    return false;
  }

  hasAggregateInSelections(selections) {
    for (const sel of selections) {
      const rawExpr = sel.__rewrittenExpr !== undefined ? sel.__rewrittenExpr : sel.expr;
      if (this.hasAggregateFunction(rawExpr)) return true;
    }
    return false;
  }

  executeGroupBy(rows, selections, groupByCols) {
    const groups = new Map();

    for (const row of rows) {
      const key = groupByCols.length === 0 ? '__all__' : groupByCols.map(c => String(row[c] ?? '')).join('|');
      let arr = groups.get(key);
      if (!arr) { arr = []; groups.set(key, arr); }
      arr.push(row);
    }

    const result = [];

    for (const groupRows of groups.values()) {
      const aggregated = {};

      for (const sel of selections) {
        const rawExpr = sel.__rewrittenExpr !== undefined ? sel.__rewrittenExpr : sel.expr;
        const normExpr = this.normalizeExpr(rawExpr);

        // Check if this is a group key column
        const isGroupKey = groupByCols.some(gc => {
          const normGc = this.normalizeExpr(gc);
          return normGc === normExpr || normGc === sel.name || normGc === sel.expr;
        });

        if (isGroupKey) {
          const keyCol = groupByCols.find(gc => {
            const normGc = this.normalizeExpr(gc);
            return normGc === normExpr || normGc === sel.name;
          }) || sel.expr;
          aggregated[sel.name] = groupRows[0][keyCol] !== undefined ? groupRows[0][keyCol] : groupRows[0][sel.name];
        } else {
          aggregated[sel.name] = this.aggregateExpr(groupRows, rawExpr);
        }
      }

      result.push(aggregated);
    }

    return result;
  }

  aggregateExpr(rows, expr) {
    const s = this.normalizeExpr(expr);
    // Use s (normalized, has single spaces) for DISTINCT detection, compact for other patterns
    const compact = s.toLowerCase().replace(/\s+/g, '');

    if (compact.startsWith('count(*)')) return rows.length;

    // COUNT(DISTINCT col) - check against normalized (spaces preserved as single space)
    const distinctMatch = s.match(/^count\s*\(\s*distinct\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\)$/i);
    if (distinctMatch) {
      const colName = distinctMatch[1];
      const seen = new Set();
      for (const r of rows) {
        const v = r[colName];
        if (v !== null && v !== undefined) seen.add(String(v));
      }
      return seen.size;
    }

    // PERCENTILE(col, p)
    const percentileMatch = s.match(/^percentile\s*\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*,\s*([\d.]+)\s*\)$/i);
    if (percentileMatch) {
      const colName = percentileMatch[1];
      const p = parseFloat(percentileMatch[2]);
      const values = rows.map(r => Number(r[colName])).filter(v => Number.isFinite(v)).sort((a, b) => a - b);
      if (values.length === 0) return NaN;
      const idx = (p / 100) * (values.length - 1);
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      if (lo === hi) return values[lo];
      return values[lo] + (values[hi] - values[lo]) * (idx - lo);
    }

    // CORR(col1, col2)
    const corrMatch = s.match(/^corr\s*\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*,\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\)$/i);
    if (corrMatch) {
      const c1 = corrMatch[1], c2 = corrMatch[2];
      const pairs = rows.map(r => [Number(r[c1]), Number(r[c2])]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
      if (pairs.length < 2) return NaN;
      const n = pairs.length;
      const mean1 = pairs.reduce((s, p) => s + p[0], 0) / n;
      const mean2 = pairs.reduce((s, p) => s + p[1], 0) / n;
      let cov = 0, std1 = 0, std2 = 0;
      for (const [a, b] of pairs) {
        cov += (a - mean1) * (b - mean2);
        std1 += (a - mean1) ** 2;
        std2 += (b - mean2) ** 2;
      }
      const denom = Math.sqrt(std1 * std2);
      return denom === 0 ? NaN : cov / denom;
    }

    const fnMatch = compact.match(/^([a-z_][a-z0-9_]*)\(([^)]*)\)$/i);
    if (!fnMatch) {
      // Non-aggregate: return first value
      const trimmed = s.trim();
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) return rows[0]?.[trimmed];
      if (/^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) return rows[0]?.[trimmed];
      // Try scalar expr on first row
      try {
        return this.evalScalarExpr(trimmed, rows[0] || {});
      } catch (e) {
        return rows[0]?.[expr];
      }
    }

    const fn = fnMatch[1].toLowerCase();
    const colName = fnMatch[2].trim();

    const values = colName === '*' ? [] : rows.map(r => {
      const v = r[colName];
      return typeof v === 'number' ? v : Number(v);
    });

    switch (fn) {
      case 'count':
        return colName === '*' ? rows.length : values.filter(v => Number.isFinite(v)).length;
      case 'sum':
        return values.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
      case 'avg': {
        const good = values.filter(v => Number.isFinite(v));
        if (good.length === 0) return NaN;
        return good.reduce((a, b) => a + b, 0) / good.length;
      }
      case 'min': {
        let m = Infinity;
        for (const v of values) if (Number.isFinite(v) && v < m) m = v;
        return m === Infinity ? NaN : m;
      }
      case 'max': {
        let m = -Infinity;
        for (const v of values) if (Number.isFinite(v) && v > m) m = v;
        return m === -Infinity ? NaN : m;
      }
      case 'first':
        return rows[0]?.[colName];
      case 'last':
        return rows[rows.length - 1]?.[colName];
      case 'variance':
      case 'var': {
        const good = values.filter(v => Number.isFinite(v));
        const n = good.length;
        if (n <= 1) return 0;
        const mean = good.reduce((a, b) => a + b, 0) / n;
        let sumSq = 0;
        for (const v of good) sumSq += (v - mean) * (v - mean);
        return sumSq / (n - 1);
      }
      case 'stddev':
      case 'std': {
        const good = values.filter(v => Number.isFinite(v));
        const n = good.length;
        if (n <= 1) return 0;
        const mean = good.reduce((a, b) => a + b, 0) / n;
        let sumSq = 0;
        for (const v of good) sumSq += (v - mean) * (v - mean);
        return Math.sqrt(sumSq / (n - 1));
      }
      default:
        return rows[0]?.[colName];
    }
  }

  // ---------------------------------------------------------------------------
  // ORDER BY
  // ---------------------------------------------------------------------------

  executeOrderBy(rows, orderBy, outputColumns) {
    const plans = orderBy.map(({ expr, direction }) => {
      const raw = this.normalizeExpr(expr);

      if (/^[0-9]+$/.test(raw)) {
        const idx = parseInt(raw, 10);
        if (idx >= 1 && idx <= outputColumns.length) {
          return { kind: 'col', direction, col: outputColumns[idx - 1] };
        }
      }

      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(raw)) {
        return { kind: 'col', direction, col: raw };
      }

      if (/^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/.test(raw)) {
        return { kind: 'col', direction, col: raw };
      }

      return { kind: 'expr', direction, expr: raw };
    });

    const decorated = rows.map((row, index) => {
      const keys = plans.map(p => {
        if (p.kind === 'col') return row[p.col];
        try {
          return this.evalScalarExpr(p.expr, row);
        } catch (e) {
          return undefined;
        }
      });
      return { row, index, keys };
    });

    decorated.sort((a, b) => {
      for (let i = 0; i < plans.length; i++) {
        const p = plans[i];
        const cmp = this.compareValues(a.keys[i], b.keys[i]);
        if (cmp !== 0) return p.direction === 'ASC' ? cmp : -cmp;
      }
      return a.index - b.index;
    });

    return decorated.map(d => d.row);
  }

  // ---------------------------------------------------------------------------
  // CREATE TABLE
  // ---------------------------------------------------------------------------

  executeCreateTable(create) {
    const name = create.table.toLowerCase();
    if (this.tables.has(name)) {
      throw new Error(`Table already exists: ${create.table}`);
    }
    this.tables.set(name, []);
    return 0;
  }

  // ---------------------------------------------------------------------------
  // INSERT / UPSERT
  // ---------------------------------------------------------------------------

  executeInsert(insert) {
    const name = insert.into.toLowerCase();
    let table = this.tables.get(name);
    if (!table) {
      table = [];
      this.tables.set(name, table);
    }

    for (const values of insert.values) {
      const row = {};
      insert.columns.forEach((col, i) => {
        row[col] = values[i];
      });
      table.push(row);
    }

    return insert.values.length;
  }

  executeUpsert(upsert) {
    const name = upsert.into.toLowerCase();
    let table = this.tables.get(name);
    if (!table) {
      table = [];
      this.tables.set(name, table);
    }

    const makeKey = (row) => upsert.conflictColumns.map(c => String(row[c])).join('|');

    // Build key index
    const keyIndex = new Map();
    for (let i = 0; i < table.length; i++) {
      keyIndex.set(makeKey(table[i]), i);
    }

    let count = 0;
    for (const values of upsert.values) {
      const row = {};
      upsert.columns.forEach((col, i) => {
        row[col] = values[i];
      });

      const key = makeKey(row);
      const existingIdx = keyIndex.get(key);

      if (existingIdx !== undefined) {
        for (const col of upsert.updateColumns) {
          table[existingIdx][col] = row[col];
        }
      } else {
        table.push(row);
        keyIndex.set(key, table.length - 1);
      }
      count++;
    }

    return count;
  }
}

// ---------------------------------------------------------------------------
// PUSH-DOWN helper
// ---------------------------------------------------------------------------

function extractPushDown(selectData) {
  const result = {
    symbol: null,
    tsMin: null,
    tsMax: null,
    interval: null,
  };

  const walkExpr = (expr) => {
    if (!expr) return;

    if (expr.type === 'pred') {
      const pred = expr.pred;
      const col = typeof pred.column === 'string' ? pred.column.toLowerCase() : null;
      const val = pred.value;

      if (col === 'symbol' && pred.operator === '=' && typeof val === 'string') {
        result.symbol = val;
      } else if (col === 'interval' && pred.operator === '=' && typeof val === 'string') {
        result.interval = val;
      } else if (col === 'timestamp') {
        const numVal = typeof val === 'number' ? val : Number(val);
        if (Number.isFinite(numVal)) {
          if (pred.operator === '>' || pred.operator === '>=') {
            if (result.tsMin === null || numVal > result.tsMin) result.tsMin = numVal;
          } else if (pred.operator === '<' || pred.operator === '<=') {
            if (result.tsMax === null || numVal < result.tsMax) result.tsMax = numVal;
          } else if (pred.operator === '=') {
            result.tsMin = numVal;
            result.tsMax = numVal;
          }
        }
      }
      return;
    }

    if (expr.type === 'and') {
      walkExpr(expr.left);
      walkExpr(expr.right);
      return;
    }

    // OR/NOT: can't safely push down, skip
  };

  // Also walk legacy where[]
  if (selectData.where && selectData.where.length > 0) {
    for (const cond of selectData.where) {
      const col = typeof cond.column === 'string' ? cond.column.toLowerCase() : null;
      const val = cond.value;

      if (col === 'symbol' && cond.operator === '=' && typeof val === 'string') {
        result.symbol = val;
      } else if (col === 'interval' && cond.operator === '=' && typeof val === 'string') {
        result.interval = val;
      } else if (col === 'timestamp') {
        const numVal = typeof val === 'number' ? val : Number(val);
        if (Number.isFinite(numVal)) {
          if (cond.operator === '>' || cond.operator === '>=') {
            if (result.tsMin === null || numVal > result.tsMin) result.tsMin = numVal;
          } else if (cond.operator === '<' || cond.operator === '<=') {
            if (result.tsMax === null || numVal < result.tsMax) result.tsMax = numVal;
          }
        }
      }
    }
  }

  if (selectData.whereExpr) {
    walkExpr(selectData.whereExpr);
  }

  return result;
}

// ---------------------------------------------------------------------------
// MAIN ENTRY POINT
// ---------------------------------------------------------------------------

try {
  const dbPath = globalThis.__SQL_DATABASE;
  if (!dbPath) {
    throw new Error('__SQL_DATABASE is not set');
  }

  const db = ndtsdb.open(dbPath + '/');

  let sqlQuery = globalThis.__SQL_QUERY;
  if (!sqlQuery) {
    const lines = [];
    while (true) {
      const line = globalThis.__readStdinLine();
      if (line === null) break;
      if (line.trim()) lines.push(line);
    }
    sqlQuery = lines.join(' ');
  }

  if (!sqlQuery || !sqlQuery.trim()) {
    ndtsdb.close(db);
    throw new Error('No SQL query provided');
  }

  const executor = new SQLExecutor();

  const stmt = parseSQL(sqlQuery);

  if (stmt.type === 'SELECT') {
    const pushDown = extractPushDown(stmt.data);

    let rows;
    const fromName = stmt.data.from ? stmt.data.from.toLowerCase() : '';

    if (fromName === 'vectors') {
      const sym = pushDown.symbol || 'bot-006';
      const interval = pushDown.interval || 'semantic';
      rows = ndtsdb.queryVectors(db, sym, interval);
    } else if (pushDown.symbol && pushDown.tsMin !== null && pushDown.tsMax !== null) {
      rows = ndtsdb.queryFilteredTime(db, [pushDown.symbol], pushDown.tsMin, pushDown.tsMax);
    } else if (pushDown.symbol) {
      rows = ndtsdb.queryFiltered(db, [pushDown.symbol]);
    } else if (pushDown.tsMin !== null && pushDown.tsMax !== null) {
      rows = ndtsdb.queryTimeRange(db, pushDown.tsMin, pushDown.tsMax);
    } else {
      rows = ndtsdb.queryAll(db);
    }

    if (!Array.isArray(rows)) rows = [];

    executor.registerTable(stmt.data.from, rows);
    if (stmt.data.from.toLowerCase() !== 'klines') {
      executor.registerTable('klines', rows);
    }

    // Also register CTEs from WITH clause if they reference other tables
    if (stmt.data.with) {
      for (const cte of stmt.data.with) {
        if (cte.select && cte.select.from) {
          const ctFrom = cte.select.from.toLowerCase();
          if (!executor.getTable(ctFrom)) {
            executor.registerTable(ctFrom, rows);
          }
        }
      }
    }
  }

  const result = executor.execute(stmt);
  ndtsdb.close(db);

  const fmt = globalThis.__SQL_FORMAT || 'json';

  if (typeof result === 'number') {
    console.log(JSON.stringify({ rowsAffected: result }));
  } else {
    const { rows } = result;
    if (fmt === 'csv' && rows.length > 0) {
      const keys = Object.keys(rows[0]);
      console.log(keys.join(','));
      for (const row of rows) {
        console.log(keys.map(k => {
          const v = row[k];
          if (v === null || v === undefined) return '';
          const s = String(v);
          // Quote if contains comma or newline
          if (s.includes(',') || s.includes('\n') || s.includes('"')) {
            return '"' + s.replace(/"/g, '""') + '"';
          }
          return s;
        }).join(','));
      }
    } else {
      for (const row of rows) {
        console.log(JSON.stringify(row));
      }
    }
  }

} catch (err) {
  console.error('SQL Engine Error:', err && err.message ? err.message : String(err));
  if (err && err.stack) console.error(err.stack);
  throw err;
}
