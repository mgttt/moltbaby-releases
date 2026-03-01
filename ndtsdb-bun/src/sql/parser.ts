// ============================================================
// SQL 解析器 - 支持时序数据库常用 SQL 子集
// 手写递归下降解析器，零依赖
// ============================================================

export type SQLValue = string | number | boolean | null;
export type SQLOperator = '=' | '!=' | '<>' | '<' | '>' | '<=' | '>=' | 'LIKE' | 'IN';

export interface SQLCondition {
  column: string | string[]; // 支持多列 IN: (a,b) IN ((1,2),(3,4))
  operator: SQLOperator;
  value: SQLValue | SQLValue[] | SQLValue[][] | { subquery: SQLSelect };
  logic?: 'AND' | 'OR';  // legacy: 与下一个条件的逻辑关系（无括号优先级）
}

// WHERE AST（支持括号优先级 + AND/OR/NOT）
export type SQLWhereExpr =
  | { type: 'pred'; pred: Omit<SQLCondition, 'logic'> }
  | { type: 'and'; left: SQLWhereExpr; right: SQLWhereExpr }
  | { type: 'or'; left: SQLWhereExpr; right: SQLWhereExpr }
  | { type: 'not'; expr: SQLWhereExpr };

export interface SQLCTE {
  name: string;
  select: SQLSelect;
}

export interface SQLJoinOn {
  left: string;
  operator: '=';
  right: string;
}

export interface SQLJoin {
  type: 'INNER' | 'LEFT';
  table: string;
  alias?: string;
  on: SQLJoinOn[];
}

export interface SQLSelect {
  with?: SQLCTE[];
  columns: Array<string | { expr: string; alias?: string }>;
  from: string;
  fromAlias?: string;
  joins?: SQLJoin[];
  // legacy: 线性条件数组（无括号优先级）；保留兼容
  where?: SQLCondition[];
  // new: WHERE AST（括号优先级 + AND/OR/NOT）
  whereExpr?: SQLWhereExpr;
  groupBy?: string[];
  // HAVING（在 GROUP BY 之后过滤）
  havingExpr?: SQLWhereExpr;
  orderBy?: { expr: string; direction: 'ASC' | 'DESC' }[];
  limit?: number;
  offset?: number;
}

export interface SQLInsert {
  into: string;
  columns: string[];
  values: SQLValue[][];
}

export interface SQLUpsert {
  into: string;
  columns: string[];
  values: SQLValue[][];
  conflictColumns: string[];  // ON CONFLICT (col1, col2, ...)
  updateColumns: string[];    // DO UPDATE SET col1=EXCLUDED.col1, ...
}

export interface SQLCreateTable {
  table: string;
  columns: Array<{
    name: string;
    type: string;
    constraints?: string[];
  }>;
}

export type SQLStatement = 
  | { type: 'SELECT'; data: SQLSelect }
  | { type: 'INSERT'; data: SQLInsert }
  | { type: 'UPSERT'; data: SQLUpsert }
  | { type: 'CREATE TABLE'; data: SQLCreateTable };

export class SQLParser {
  private sql: string = '';
  private pos: number = 0;
  private tokens: string[] = [];
  private tokenPos: number = 0;
  private subqueryId: number = 0;

  parse(sql: string): SQLStatement {
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

  // 词法分析
  private tokenize(sql: string): string[] {
    const tokens: string[] = [];
    let i = 0;
    
    while (i < sql.length) {
      const char = sql[i];
      
      // 跳过空白
      if (/\s/.test(char)) {
        i++;
        continue;
      }
      
      // 字符串
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
        i++; // 跳过结束引号
        tokens.push(`'${str}'`);
        continue;
      }
      
      // 数字
      if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(sql[i + 1]))) {
        let num = '';
        while (i < sql.length && (/[0-9.]/.test(sql[i]) || sql[i] === 'e' || sql[i] === 'E' || sql[i] === '+' || sql[i] === '-')) {
          num += sql[i];
          i++;
        }
        tokens.push(num);
        continue;
      }
      
      // 标识符或关键字（支持 dotted ident: t.col）
      if (/[a-zA-Z_]/.test(char)) {
        let ident = '';
        while (i < sql.length && /[a-zA-Z0-9_.]/.test(sql[i])) {
          ident += sql[i];
          i++;
        }
        tokens.push(ident);
        continue;
      }
      
      // 操作符
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

      // 字符串拼接操作符 ||
      if (char === '|' && sql[i + 1] === '|') {
        tokens.push('||');
        i += 2;
        continue;
      }
      
      // 单字符 token
      tokens.push(char);
      i++;
    }
    
    return tokens;
  }

  private parseSelectStatement(): SQLSelect {
    const first = this.peek()?.toUpperCase();
    if (first === 'WITH') return this.parseWithSelect();
    if (first === 'SELECT') return this.parseSelect();
    throw new Error(`Expected SELECT statement, got ${this.peek()}`);
  }

  // 解析 WITH ... SELECT
  private parseWithSelect(): SQLSelect {
    this.consume('WITH');

    const withCTEs: SQLCTE[] = [];

    while (true) {
      const name = this.consumeIdentifier();

      // 可选：WITH t(col1,col2) AS (...) —— 先忽略列名声明
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

  // 解析 SELECT
  private parseSelect(): SQLSelect {
    this.consume('SELECT');
    
    const columns = this.parseSelectColumns();
    
    this.consume('FROM');

    let extraWith: SQLCTE[] | undefined;
    let from: string;

    // FROM <ident> | FROM (<select>)
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

    // optional FROM alias: FROM t AS x / FROM t x
    let fromAlias: string | undefined;
    const nextAfterFrom = this.peek()?.toUpperCase();
    if (nextAfterFrom === 'AS') {
      this.consume('AS');
      fromAlias = this.consumeIdentifier();
    } else if (this.peek() && this.isIdentifierToken(this.peek()!) && !['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'JOIN', 'INNER', 'LEFT'].includes(nextAfterFrom || '')) {
      fromAlias = this.consumeIdentifier();
    }

    // JOIN ... ON ... (only equality + AND chain for now)
    const joins: SQLJoin[] = [];
    while (true) {
      const t = this.peek()?.toUpperCase();
      if (!t) break;

      let joinType: 'INNER' | 'LEFT' = 'INNER';
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

      let alias: string | undefined;
      const next = this.peek()?.toUpperCase();
      if (next === 'AS') {
        this.consume('AS');
        alias = this.consumeIdentifier();
      } else if (this.peek() && this.isIdentifierToken(this.peek()!) && !['ON', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'JOIN', 'INNER', 'LEFT'].includes(next || '')) {
        alias = this.consumeIdentifier();
      }

      this.consume('ON');
      const on = this.parseJoinOn();

      joins.push({ type: joinType, table, alias, on });
    }

    let where: SQLCondition[] | undefined;
    let whereExpr: SQLWhereExpr | undefined;
    if (this.peek()?.toUpperCase() === 'WHERE') {
      this.consume('WHERE');
      whereExpr = this.parseWhereExpr();
      // 兼容：仅当可线性化时填充 legacy where[]（便于旧测试/调用方）
      where = this.linearizeWhereExpr(whereExpr) || undefined;
    }
    
    let groupBy: string[] | undefined;
    if (this.peek()?.toUpperCase() === 'GROUP') {
      this.consume('GROUP');
      this.consume('BY');
      groupBy = this.parseIdentifierList();
    }

    let havingExpr: SQLWhereExpr | undefined;
    if (this.peek()?.toUpperCase() === 'HAVING') {
      this.consume('HAVING');
      // HAVING 允许在聚合结果上做表达式比较（支持 alias / scalar expr）
      havingExpr = this.parseWhereExpr(true);
    }
    
    let orderBy: { expr: string; direction: 'ASC' | 'DESC' }[] | undefined;
    if (this.peek()?.toUpperCase() === 'ORDER') {
      this.consume('ORDER');
      this.consume('BY');
      orderBy = this.parseOrderBy();
    }
    
    let limit: number | undefined;
    if (this.peek()?.toUpperCase() === 'LIMIT') {
      this.consume('LIMIT');
      limit = parseInt(this.consume());
    }
    
    let offset: number | undefined;
    if (this.peek()?.toUpperCase() === 'OFFSET') {
      this.consume('OFFSET');
      offset = parseInt(this.consume());
    }
    
    return {
      with: extraWith,
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

  // 解析 SELECT 列
  private parseSelectColumns(): Array<string | { expr: string; alias?: string }> {
    const columns: Array<string | { expr: string; alias?: string }> = [];
    
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

  // 解析列或表达式
  // 注意：需要支持函数参数中的逗号，例如 ROUND(x, 2)
  // 所以只能在括号深度为 0 时把逗号当作列分隔符
  private parseColumnOrExpr(): string | { expr: string; alias?: string } {
    let expr = '';
    let depth = 0;

    while (this.tokenPos < this.tokens.length) {
      const token = this.peek();
      if (!token) break;

      const upper = token.toUpperCase();

      // 只在 depth==0 时识别子句边界
      if (depth === 0 && ['FROM', 'WHERE', 'GROUP', 'ORDER', 'LIMIT', 'OFFSET'].includes(upper)) {
        break;
      }

      // 只在 depth==0 时把逗号当作列分隔
      if (depth === 0 && token === ',') {
        break;
      }

      // alias 也只在 depth==0 生效
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

  // ---------------------------------------------------------------------------
  // WHERE (AST)
  // ---------------------------------------------------------------------------

  private parseWhereExpr(allowExprLHS: boolean = false): SQLWhereExpr {
    const parseOr = (): SQLWhereExpr => {
      let node = parseAnd();
      while (this.peek()?.toUpperCase() === 'OR') {
        this.consume('OR');
        const right = parseAnd();
        node = { type: 'or', left: node, right };
      }
      return node;
    };

    const parseAnd = (): SQLWhereExpr => {
      let node = parseNot();
      while (this.peek()?.toUpperCase() === 'AND') {
        this.consume('AND');
        const right = parseNot();
        node = { type: 'and', left: node, right };
      }
      return node;
    };

    const parseNot = (): SQLWhereExpr => {
      if (this.peek()?.toUpperCase() === 'NOT') {
        this.consume('NOT');
        return { type: 'not', expr: parseNot() };
      }
      return parsePrimary();
    };

    const parsePrimary = (): SQLWhereExpr => {
      if (this.peek() === '(' && !this.isTupleLHS()) {
        this.consume('(');
        const inner = parseOr();
        this.consume(')');
        return inner;
      }

      const pred = this.parsePredicate(allowExprLHS);
      return { type: 'pred', pred };
    };

    return parseOr();
  }

  private isTupleLHS(): boolean {
    if (this.peek() !== '(') return false;
    const t1 = this.tokens[this.tokenPos + 1];
    const t2 = this.tokens[this.tokenPos + 2];
    // (a,b) ... (tuple columns themselves do not accept dotted names for now)
    return !!t1 && this.isIdentifierToken(t1) && t2 === ',';
  }

  private isIdentifierToken(t: string): boolean {
    return /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/.test(t);
  }

  private parsePredicate(allowExprLHS: boolean): Omit<SQLCondition, 'logic'> {
    // 支持多列条件：(a,b) IN ((1,2),(3,4))
    let column: string | string[];

    if (this.peek() === '(') {
      // tuple LHS: (a,b) ...
      this.consume('(');
      column = this.parseIdentifierList();
      this.consume(')');
    } else if (!allowExprLHS) {
      column = this.consumeIdentifier();
    } else {
      // expr LHS（用于 HAVING）：读取到操作符为止
      let expr = '';
      let depth = 0;

      const isOpToken = (t: string) => {
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

  // 兼容：把简单的 WHERE AST 线性化为旧 where[]
  private linearizeWhereExpr(expr: SQLWhereExpr): SQLCondition[] | null {
    const preds: Array<Omit<SQLCondition, 'logic'>> = [];

    const collectAnd = (n: SQLWhereExpr): boolean => {
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

    const out: SQLCondition[] = preds.map((p) => ({ ...p } as SQLCondition));
    for (let i = 0; i < out.length - 1; i++) out[i].logic = 'AND';
    return out;
  }

  // ---------------------------------------------------------------------------
  // WHERE (legacy linear conditions)
  // ---------------------------------------------------------------------------

  private parseWhere(): SQLCondition[] {
    const conditions: SQLCondition[] = [];

    while (true) {
      // 支持多列条件：(a,b) IN ((1,2),(3,4))
      let column: string | string[];
      if (this.peek() === '(') {
        this.consume('(');
        column = this.parseIdentifierList();
        this.consume(')');
      } else {
        column = this.consumeIdentifier();
      }

      const operator = this.parseOperator();

      const value = operator === 'IN' ? this.parseInValue() : this.parseValue();

      conditions.push({ column, operator, value });

      const logic = this.peek()?.toUpperCase();
      if (logic === 'AND' || logic === 'OR') {
        this.consume();
        conditions[conditions.length - 1].logic = logic as 'AND' | 'OR';
        continue;
      }

      break;
    }

    return conditions;
  }

  // 解析操作符
  private parseOperator(): SQLOperator {
    const op = this.consume().toUpperCase();
    const validOps: SQLOperator[] = ['=', '!=', '<>', '<', '>', '<=', '>=', 'LIKE', 'IN'];
    
    if (!validOps.includes(op as SQLOperator)) {
      throw new Error(`Invalid operator: ${op}`);
    }
    
    return op as SQLOperator;
  }

  // 解析值
  private parseValue(): SQLValue | SQLValue[] {
    const token = this.peek();
    
    if (token?.toUpperCase() === 'NULL') {
      this.consume('NULL');
      return null;
    }
    
    if (token === '(') {
      // (list)
      this.consume('(');
      const values: SQLValue[] = [];
      while (this.peek() !== ')') {
        values.push(this.parseSingleValue());
        if (this.peek() === ',') this.consume(',');
      }
      this.consume(')');
      return values;
    }
    
    return this.parseSingleValue();
  }

  // 解析 IN (...) 右侧，支持：
  // - 单列 IN: (1,2,3)
  // - 多列 IN: ((1,2),(3,4))
  private parseJoinOn(): SQLJoinOn[] {
    const on: SQLJoinOn[] = [];

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

  private parseInValue(): SQLValue[] | SQLValue[][] | { subquery: SQLSelect } {
    if (this.peek() !== '(') {
      // 允许语法扩展：IN <ident>（未实现）
      return [this.parseSingleValue()];
    }

    this.consume('(');

    // 子查询：IN (SELECT ...)
    if (this.peek()?.toUpperCase() === 'SELECT' || this.peek()?.toUpperCase() === 'WITH') {
      const subquery = this.parseSelectStatement();
      this.consume(')');
      return { subquery };
    }

    // 多列：IN ( (..), (..) )
    if (this.peek() === '(') {
      const tuples: SQLValue[][] = [];
      while (true) {
        this.consume('(');
        const row: SQLValue[] = [];
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

    // 单列：IN (1,2,3)
    const values: SQLValue[] = [];
    while (this.peek() !== ')') {
      values.push(this.parseSingleValue());
      if (this.peek() === ',') this.consume(',');
    }
    this.consume(')');
    return values;
  }

  private parseSingleValue(): SQLValue {
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

  // 解析 ORDER BY（支持表达式 / alias / ordinal）
  private parseOrderBy(): { expr: string; direction: 'ASC' | 'DESC' }[] {
    const orderBy: { expr: string; direction: 'ASC' | 'DESC' }[] = [];

    while (true) {
      let expr = '';
      let depth = 0;

      while (this.tokenPos < this.tokens.length) {
        const token = this.peek();
        if (!token) break;

        const upper = token.toUpperCase();

        // depth==0: 子句边界 / 逗号分隔
        if (depth === 0 && (token === ',' || ['LIMIT', 'OFFSET'].includes(upper))) {
          break;
        }

        // depth==0: ASC/DESC 作为方向（不属于 expr 本身）
        if (depth === 0 && (upper === 'ASC' || upper === 'DESC')) {
          break;
        }

        if (token === '(') depth++;
        if (token === ')') depth = Math.max(0, depth - 1);

        expr += this.consume() + ' ';
      }

      expr = expr.trim();
      if (!expr) throw new Error('Expected ORDER BY expression');

      let direction: 'ASC' | 'DESC' = 'ASC';
      const next = this.peek()?.toUpperCase();
      if (next === 'ASC' || next === 'DESC') {
        direction = this.consume().toUpperCase() as 'ASC' | 'DESC';
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

  // 解析 INSERT 或 INSERT ... ON CONFLICT (转为 UPSERT)
  private parseInsertOrUpsert(): SQLStatement {
    this.consume('INSERT');
    this.consume('INTO');
    
    const into = this.consumeIdentifier();
    
    let columns: string[] = [];
    if (this.peek() === '(') {
      this.consume('(');
      columns = this.parseIdentifierList();
      this.consume(')');
    }
    
    this.consume('VALUES');
    const values = this.parseValuesList();
    
    // 检查是否有 ON CONFLICT 子句
    if (this.peek()?.toUpperCase() === 'ON') {
      return { 
        type: 'UPSERT', 
        data: this.parseOnConflict(into, columns, values) 
      };
    }
    
    return { type: 'INSERT', data: { into, columns, values } };
  }

  // 解析 UPSERT INTO ... VALUES ...
  private parseUpsert(): SQLUpsert {
    this.consume('UPSERT');
    this.consume('INTO');
    
    const into = this.consumeIdentifier();
    
    let columns: string[] = [];
    if (this.peek() === '(') {
      this.consume('(');
      columns = this.parseIdentifierList();
      this.consume(')');
    }
    
    this.consume('VALUES');
    const values = this.parseValuesList();
    
    // UPSERT 语法必须指定主键列
    // UPSERT INTO table (col1, col2) VALUES (...) KEY (col1)
    let conflictColumns: string[] = [];
    if (this.peek()?.toUpperCase() === 'KEY') {
      this.consume('KEY');
      this.consume('(');
      conflictColumns = this.parseIdentifierList();
      this.consume(')');
    } else {
      // 默认：第一列作为主键
      conflictColumns = columns.length > 0 ? [columns[0]] : [];
    }
    
    // 更新所有非主键列
    const updateColumns = columns.filter(c => !conflictColumns.includes(c));
    
    return { into, columns, values, conflictColumns, updateColumns };
  }

  // 解析 ON CONFLICT (...) DO UPDATE SET ...
  private parseOnConflict(into: string, columns: string[], values: SQLValue[][]): SQLUpsert {
    this.consume('ON');
    this.consume('CONFLICT');
    
    // 解析冲突列
    this.consume('(');
    const conflictColumns = this.parseIdentifierList();
    this.consume(')');
    
    this.consume('DO');
    this.consume('UPDATE');
    this.consume('SET');
    
    // 解析 SET 子句 (col=EXCLUDED.col, ...)
    const updateColumns: string[] = [];
    while (true) {
      const col = this.consumeIdentifier();
      this.consume('=');
      
      // 期望 EXCLUDED.col
      const excluded = this.consumeIdentifier();
      if (excluded.toUpperCase() !== 'EXCLUDED') {
        throw new Error(`Expected EXCLUDED.column, got: ${excluded}`);
      }
      this.consume('.');
      const targetCol = this.consumeIdentifier();
      
      updateColumns.push(col);
      
      if (this.peek() === ',') {
        this.consume(',');
        continue;
      }
      break;
    }
    
    return { into, columns, values, conflictColumns, updateColumns };
  }

  // 解析值列表
  private parseValuesList(): SQLValue[][] {
    const allValues: SQLValue[][] = [];
    
    while (true) {
      this.consume('(');
      const row: SQLValue[] = [];
      
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

  // 解析 CREATE TABLE
  private parseCreateTable(): SQLCreateTable {
    this.consume('CREATE');
    this.consume('TABLE');
    
    const table = this.consumeIdentifier();
    
    this.consume('(');
    const columns: SQLCreateTable['columns'] = [];
    
    while (this.peek() !== ')') {
      const name = this.consumeIdentifier();
      const type = this.consumeIdentifier();
      
      const constraints: string[] = [];
      while (this.peek() && ![')', ','].includes(this.peek())) {
        constraints.push(this.consume().toUpperCase());
      }
      
      columns.push({ name, type, constraints: constraints.length > 0 ? constraints : undefined });
      
      if (this.peek() === ',') this.consume(',');
    }
    
    this.consume(')');
    
    return { table, columns };
  }

  // 辅助方法
  private peek(): string | undefined {
    return this.tokens[this.tokenPos];
  }

  private consume(expected?: string): string {
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

  private consumeIdentifier(): string {
    const token = this.consume();
    // allow dotted identifier: a.b
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/.test(token)) {
      throw new Error(`Expected identifier, got ${token}`);
    }
    return token;
  }

  private parseIdentifierList(): string[] {
    const list: string[] = [];
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

// 便捷函数
export function parseSQL(sql: string): SQLStatement {
  return new SQLParser().parse(sql);
}
