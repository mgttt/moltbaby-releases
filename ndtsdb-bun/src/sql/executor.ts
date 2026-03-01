// ============================================================
// SQL 执行器 - 将 SQL 解析结果转换为 ColumnarTable 操作
//
// 目标：支持时序场景常用的 SQL 子集，并逐步扩展到窗口聚合能力。
// ============================================================

import { ColumnarTable, type ColumnarType } from '../columnar.js';
import type { SQLStatement, SQLSelect, SQLCTE, SQLCondition, SQLWhereExpr, SQLOperator, SQLUpsert, SQLCreateTable } from './parser.js';

type RollingStdFn = (src: Float64Array, window: number) => Float64Array;

// 可选 native 加速：在 Bun 环境下尝试加载；在 Node 环境自动回退到纯 JS（避免 bun:ffi 导致 import 崩溃）
let rollingStdNative: RollingStdFn | null = null;
try {
  if (typeof (globalThis as any).Bun !== 'undefined') {
    const mod = await import('../ndts-ffi.js');
    rollingStdNative = (mod as any).rollingStd as RollingStdFn;
  }
} catch {
  rollingStdNative = null;
}

export interface SQLQueryResult {
  columns: string[];
  rows: Array<Record<string, number | bigint | string>>;
  rowCount: number;
}

type SelectItem = { expr: string; name: string };

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/;


type WindowSpec = {
  func: 'row_number' | 'count' | 'sum' | 'avg' | 'min' | 'max' | 'variance' | 'stddev';
  arg?: string; // column name or '*'
  partitionBy: string[];
  orderBy?: { column: string; direction: 'ASC' | 'DESC' };
  frame?: { kind: 'rows'; preceding: number | 'unbounded'; following: 0 };
};

export class SQLExecutor {
  private tables: Map<string, ColumnarTable> = new Map();

  // 注册表
  registerTable(name: string, table: ColumnarTable): void {
    this.tables.set(name.toLowerCase(), table);
  }

  // 获取表
  getTable(name: string): ColumnarTable | undefined {
    return this.tables.get(name.toLowerCase());
  }

  // ---------------------------------------------------------------------------
  // CTE (WITH)
  // ---------------------------------------------------------------------------

  private installCTEs(ctes: SQLCTE[]): (() => void) {
    const saved = new Map<string, ColumnarTable | undefined>();

    for (const cte of ctes) {
      const key = cte.name.toLowerCase();
      if (!saved.has(key)) {
        saved.set(key, this.tables.get(key));
      }

      const res = this.executeSelect(cte.select);
      const table = this.materializeResultAsTable(res);
      this.tables.set(key, table);
    }

    return () => {
      for (const [key, prev] of saved.entries()) {
        if (prev) this.tables.set(key, prev);
        else this.tables.delete(key);
      }
    };
  }

  private materializeResultAsTable(res: SQLQueryResult): ColumnarTable {
    const cols = res.columns;
    const rows = res.rows;

    // 推断列类型（小型结果集场景，够用；后续可按 column stats 优化）
    const defs = cols.map((name) => ({ name, type: this.inferColumnType(rows, name) } as any));

    const t = new ColumnarTable(defs, Math.max(1, rows.length));
    if (rows.length > 0) {
      t.appendBatch(rows as any);
    }
    return t;
  }

  private inferColumnType(rows: Array<Record<string, any>>, col: string): import('../columnar.js').ColumnarType {
    // 推断列类型（CTE/materialize 小结果集用；足够用即可）
    // 优先级：string > bigint(int64) > float64 > int32

    let sawFloat = false;
    for (let i = 0; i < rows.length && i < 200; i++) {
      const v = rows[i][col];
      if (typeof v === 'string') return 'string';
      if (typeof v === 'bigint') return 'int64';
      if (typeof v === 'number') {
        if (!Number.isInteger(v)) sawFloat = true;
      }
    }

    if (sawFloat) return 'float64';
    return 'int32';
  }

  // 执行 SQL
  execute(statement: SQLStatement): SQLQueryResult | number {
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

  // 执行 SELECT
  private executeSelect(select: SQLSelect): SQLQueryResult {
    let restore: null | (() => void) = null;

    try {
      // Fast path 0: 尝试在不 materialize CTE 的情况下执行（避免大表全量物化）
      if (select.with && select.with.length === 1) {
        const cte = select.with[0];
        const baseTable = this.getTable(cte.select.from);
        if (baseTable) {
          const partTail = this.tryExecutePartitionTail(select, cte.name, cte.select, baseTable);
          if (partTail) return partTail;
        }
      }

      // 常规路径：安装/物化 CTE
      restore = select.with && select.with.length > 0 ? this.installCTEs(select.with) : null;

      const table = this.getTable(select.from);
      if (!table) throw new Error(`Table not found: ${select.from}`);

      const hasJoins = !!((select as any).joins && (select as any).joins.length > 0);

      if (!hasJoins) {
        // Fast path 1: simple tail window (no PARTITION BY)
        const tail = this.tryExecuteTailWindow(select, table);
        if (tail) return tail;
      }

      const allColumns = table.getColumnNames ? table.getColumnNames() : this.inferColumnNames(table);

      if ((select as any).havingExpr && (!select.groupBy || select.groupBy.length === 0)) {
        throw new Error('HAVING requires GROUP BY');
      }

      // JOIN：先把 FROM + JOIN materialize 成 row objects（再做 WHERE/投影/聚合）
      if (hasJoins) {
        const baseAlias = (select as any).fromAlias || select.from;
        let joinedRows = this.extractRowsNamespaced(table, allColumns, baseAlias, true);

        const joinSpecs = (select as any).joins as any[];
        const joinColumns: string[] = [];
        joinColumns.push(...allColumns.map((c) => `${baseAlias}.${c}`));

        for (const j of joinSpecs) {
          const right = this.getTable(j.table);
          if (!right) throw new Error(`Table not found: ${j.table}`);

          const rightAlias = j.alias || j.table;
          const rightCols = right.getColumnNames ? right.getColumnNames() : this.inferColumnNames(right);
          joinColumns.push(...rightCols.map((c) => `${rightAlias}.${c}`));

          joinedRows = this.executeJoin(joinedRows, baseAlias, right, rightCols, rightAlias, j.type, j.on);
        }

        // WHERE（在 joined rows 上评估）
        if ((select as any).whereExpr) {
          joinedRows = this.filterRowsByWhereExpr(joinedRows, (select as any).whereExpr);
        }

        // SELECT *
        if (select.columns[0] === '*') {
          let outRows = joinedRows.map((r) => this.projectRowByColumns(r, joinColumns));

          if (select.orderBy && select.orderBy.length > 0) {
            outRows = this.executeOrderBy(outRows, select.orderBy, joinColumns);
          }
          if (select.offset !== undefined) outRows = outRows.slice(select.offset);
          if (select.limit !== undefined) outRows = outRows.slice(0, select.limit);

          return { columns: joinColumns, rows: outRows, rowCount: outRows.length };
        }

        // explicit projections
        const selections: SelectItem[] = this.buildSelections(select.columns);

        let baseRows = joinedRows;

        // 投影 / GROUP BY
        let rows: Array<Record<string, any>>;
        if (select.groupBy && select.groupBy.length > 0) {
          rows = this.executeGroupBy(baseRows, selections, select.groupBy);
          if ((select as any).havingExpr) {
            rows = this.filterRowsByWhereExpr(rows, (select as any).havingExpr);
          }
        } else {
          if ((select as any).havingExpr) throw new Error('HAVING requires GROUP BY');
          
          // 检测是否有聚合函数（如果有，执行整体聚合）
          if (this.hasAggregateInSelections(selections)) {
            // 整体聚合：把所有行当作一个组
            rows = this.executeGroupBy(baseRows, selections, []);
          } else {
            rows = baseRows.map((r) => this.projectRow(r, selections));
          }
        }

        const outputColumns = selections.map((s) => s.name);
        if (select.orderBy && select.orderBy.length > 0) {
          rows = this.executeOrderBy(rows, select.orderBy, outputColumns);
        }
        if (select.offset !== undefined) rows = rows.slice(select.offset);
        if (select.limit !== undefined) rows = rows.slice(0, select.limit);

        return { columns: outputColumns, rows, rowCount: rows.length };
      }

      // 非 JOIN：WHERE 过滤（table 上评估；支持 FROM alias：WHERE a.col -> col）
      const fromAlias = (select as any).fromAlias as string | undefined;

      const stripAliasFromColumn = (col: any): any => {
        if (!fromAlias) return col;
        if (Array.isArray(col)) return col.map((c) => stripAliasFromColumn(c));
        if (typeof col === 'string' && col.startsWith(fromAlias + '.')) return col.slice(fromAlias.length + 1);
        return col;
      };

      const stripAliasFromWhereExpr = (expr: any): any => {
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

      let rowIndices: number[] | undefined;
      if ((select as any).whereExpr) {
        rowIndices = this.evaluateWhereExpr(table, stripAliasFromWhereExpr((select as any).whereExpr));
      } else if (select.where && select.where.length > 0) {
        const w = fromAlias
          ? (select.where as any[]).map((c) => ({ ...c, column: stripAliasFromColumn(c.column) }))
          : select.where;
        rowIndices = this.evaluateWhere(table, w as any);
      }

      // SELECT * 快速路径
      if (select.columns[0] === '*') {
        let rows = this.extractRows(table, allColumns, rowIndices);
        this.applyFromAliasPrefix(rows, allColumns, (select as any).fromAlias);

        if (select.orderBy && select.orderBy.length > 0) {
          rows = this.executeOrderBy(rows, select.orderBy, allColumns);
        }
        if (select.offset !== undefined) rows = rows.slice(select.offset);
        if (select.limit !== undefined) rows = rows.slice(0, select.limit);

        return { columns: allColumns, rows, rowCount: rows.length };
      }

      // 规范化选择项（保留 alias）
      const selections: SelectItem[] = this.buildSelections(select.columns);

      // 简化实现：直接抽全列，后续再按需裁剪（在大表上可优化）
      let baseRows = this.extractRows(table, allColumns, rowIndices);
      this.applyFromAliasPrefix(baseRows, allColumns, (select as any).fromAlias);

    // 提取内嵌窗口函数（如 vol_1d / price 中的 STDDEV(...) OVER (...)）
    const { selections: rewrittenSel, windowItems } = this.prepareInlineWindows(selections);

    // 计算窗口函数（包括内嵌的）+ 别名映射（在 baseRows 上追加派生列）
    this.applyWindowAndAliases(baseRows, rewrittenSel);
    for (const item of windowItems) {
      const values = this.computeWindowColumn(baseRows, item.spec);
      for (let i = 0; i < baseRows.length; i++) {
        baseRows[i][item.name] = values[i];
      }
    }

    // 投影 / GROUP BY
    let rows: Array<Record<string, any>>;
    if (select.groupBy && select.groupBy.length > 0) {
      // 当前实现不支持「GROUP BY + 窗口函数」混用（后续可扩展）
      rows = this.executeGroupBy(baseRows, rewrittenSel, select.groupBy);

      // HAVING（聚合后过滤）
      if ((select as any).havingExpr) {
        rows = this.filterRowsByWhereExpr(rows, (select as any).havingExpr);
      }
    } else {
      if ((select as any).havingExpr) {
        throw new Error('HAVING requires GROUP BY');
      }
      
      // 检测是否有聚合函数（如果有，执行整体聚合）
      const hasAgg = this.hasAggregateInSelections(rewrittenSel);
      if (hasAgg) {
        // 整体聚合：把所有行当作一个组
        rows = this.executeGroupBy(baseRows, rewrittenSel, []);
      } else {
        rows = baseRows.map((r) => this.projectRow(r, rewrittenSel));
      }
    }

    const outputColumns = selections.map((s) => s.name);

    // ORDER BY
    if (select.orderBy && select.orderBy.length > 0) {
      rows = this.executeOrderBy(rows, select.orderBy, outputColumns);
    }

    // LIMIT/OFFSET
    if (select.offset !== undefined) rows = rows.slice(select.offset);
    if (select.limit !== undefined) rows = rows.slice(0, select.limit);

    return {
      columns: selections.map((s) => s.name),
      rows,
      rowCount: rows.length,
    };
    } finally {
      if (restore) restore();
    }
  }

  private projectRow(row: Record<string, any>, selections: SelectItem[]): Record<string, any> {
    const out: Record<string, any> = {};
    for (const s of selections) {
      // 优先取派生列（alias / window result）
      if (Object.prototype.hasOwnProperty.call(row, s.name)) {
        out[s.name] = row[s.name];
        continue;
      }

      const rawExpr = (s as any).__rewrittenExpr ?? s.expr;
      const expr = this.normalizeExpr(rawExpr);

      // 纯列名
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(expr)) {
        out[s.name] = row[expr];
        continue;
      }

      // 表达式（向 DuckDB/SQLite 看齐：支持基础算术 + 常用函数）
      out[s.name] = this.evalScalarExpr(expr, row);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // WHERE
  // ---------------------------------------------------------------------------

  private evaluateWhere(table: ColumnarTable, conditions: SQLCondition[]): number[] {
    const matching: number[] = [];
    const rowCount = table.getRowCount();

    for (let i = 0; i < rowCount; i++) {
      let match = true;

      for (let j = 0; j < conditions.length; j++) {
        const cond = conditions[j];
        const value = this.getConditionValue(table, cond.column, i);
        const condMatch = this.evaluateCondition(value, cond.operator, cond.value);

        if (j === 0) {
          match = condMatch;
        } else {
          const prevLogic = conditions[j - 1].logic || 'AND';
          match = prevLogic === 'AND' ? match && condMatch : match || condMatch;
        }
      }

      if (match) matching.push(i);
    }

    return matching;
  }

  private evaluateWhereExpr(table: ColumnarTable, expr: SQLWhereExpr): number[] {
    // 索引优化：检测简单的范围查询（单列 + AND 链）
    const indexResult = this.tryUseIndex(table, expr);
    if (indexResult) return indexResult;

    // 回退到全表扫描
    const matching: number[] = [];
    const rowCount = table.getRowCount();

    const evalNode = (rowIndex: number, n: SQLWhereExpr): boolean => {
      switch (n.type) {
        case 'pred': {
          const v = this.getConditionValue(table, n.pred.column as any, rowIndex);
          return this.evaluateCondition(v, n.pred.operator as any, (n.pred as any).value);
        }
        case 'and':
          return evalNode(rowIndex, n.left) && evalNode(rowIndex, n.right);
        case 'or':
          return evalNode(rowIndex, n.left) || evalNode(rowIndex, n.right);
        case 'not':
          return !evalNode(rowIndex, n.expr);
        default:
          return false;
      }
    };

    for (let i = 0; i < rowCount; i++) {
      if (evalNode(i, expr)) matching.push(i);
    }

    return matching;
  }

  /**
   * 尝试使用索引优化查询
   * 支持：col > val, col < val, col >= val, col <= val, col = val, col IN (...)
   * 以及简单的 AND 组合（但不支持 OR）
   */
  private tryUseIndex(table: ColumnarTable, expr: SQLWhereExpr): number[] | null {
    // 提取所有 AND 链接的 pred
    const preds: Array<{ column: string; operator: string; value: any }> = [];
    
    const collectPreds = (n: SQLWhereExpr): boolean => {
      if (n.type === 'pred') {
        if (typeof n.pred.column !== 'string') return false; // 不支持 tuple
        preds.push({
          column: n.pred.column,
          operator: n.pred.operator,
          value: n.pred.value,
        });
        return true;
      }
      if (n.type === 'and') {
        return collectPreds(n.left) && collectPreds(n.right);
      }
      return false; // OR / NOT 不支持索引优化
    };

    if (!collectPreds(expr)) return null;

    const normalizeIndexValue = (column: string, v: any): number | bigint | null => {
      const colArr = table.getColumn(column);

      // bigint column (int64)
      if (colArr instanceof BigInt64Array) {
        if (typeof v === 'bigint') return v;
        if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)) return BigInt(v);
        if (typeof v === 'string' && /^[+-]?\d+$/.test(v)) {
          try {
            return BigInt(v);
          } catch {}
        }
        return null;
      }

      // numeric columns
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'bigint') {
        const n = Number(v);
        if (Number.isFinite(n) && Number.isSafeInteger(n)) return n;
      }
      if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
      return null;
    };

    // 1) 复合索引（N 列：前缀精确 + 最后一列 '='|range）
    if (typeof (table as any).getCompositeIndexes === 'function') {
      const compositeDefs: string[][] = (table as any).getCompositeIndexes();

      // 评估每个索引的匹配度，选择最优的
      let bestIndex: string[] | null = null;
      let bestMatchedCols = 0;
      let bestFilters: any = null;

      for (const cols of compositeDefs) {
        if (cols.length < 2) continue;

        const filters: any = {};
        let matchedCols = 0;

        // 检查前 N-1 列（前缀）：必须精确匹配（=）
        let allPrefixMatched = true;
        for (let i = 0; i < cols.length - 1; i++) {
          const col = cols[i];
          const pred = preds.find((p) => p.column === col && p.operator === '=');
          if (!pred) {
            allPrefixMatched = false;
            break;
          }
          filters[col] = pred.value;
          matchedCols++;
        }

        if (!allPrefixMatched) continue;

        // 检查最后一列：'=' 或范围
        const lastCol = cols[cols.length - 1];
        const lastEq = preds.find((p) => p.column === lastCol && p.operator === '=');
        const lastGt = preds.find((p) => p.column === lastCol && p.operator === '>');
        const lastGte = preds.find((p) => p.column === lastCol && p.operator === '>=');
        const lastLt = preds.find((p) => p.column === lastCol && p.operator === '<');
        const lastLte = preds.find((p) => p.column === lastCol && p.operator === '<=');

        if (lastEq) {
          const v = normalizeIndexValue(lastCol, lastEq.value);
          if (v == null) continue;
          filters[lastCol] = v;
          matchedCols++;
        } else if (lastGte || lastGt || lastLt || lastLte) {
          const range: any = {};

          if (lastGte) {
            const v = normalizeIndexValue(lastCol, lastGte.value);
            if (v == null) continue;
            range.gte = v;
          } else if (lastGt) {
            const v = normalizeIndexValue(lastCol, lastGt.value);
            if (v == null) continue;
            range.gt = v;
          }

          if (lastLt) {
            const v = normalizeIndexValue(lastCol, lastLt.value);
            if (v == null) continue;
            range.lt = v;
          } else if (lastLte) {
            const v = normalizeIndexValue(lastCol, lastLte.value);
            if (v == null) continue;
            range.lte = v;
          }

          if (Object.keys(range).length === 0) continue;
          filters[lastCol] = range;
          matchedCols++;
        }
        // 如果最后一列没有条件，也可以用索引（只匹配前缀）

        // 选择匹配列数最多的索引
        if (matchedCols > bestMatchedCols) {
          bestIndex = cols;
          bestMatchedCols = matchedCols;
          bestFilters = filters;
        }
      }

      if (bestIndex && bestFilters) {
        let candidates: number[] | null = null;
        try {
          candidates = (table as any).queryCompositeIndex(bestIndex, bestFilters);
        } catch {
          candidates = null;
        }

        if (candidates && candidates.length > 0) {
          const result: number[] = [];
          for (const rowIndex of candidates) {
            if (this.evalWhereExprAt(table, expr, rowIndex)) {
              result.push(rowIndex);
            }
          }
          return result;
        }
      }
    }

    // 2) 单列索引
    for (const p of preds) {
      if (!table.hasIndex(p.column)) continue;

      const val = normalizeIndexValue(p.column, p.value);
      if (val == null) continue;

      let candidates: number[] | null = null;

      switch (p.operator) {
        case '=':
          candidates = table.queryIndexExact(p.column, val);
          break;
        case '>':
          candidates = table.queryIndexGreaterThan(p.column, val);
          break;
        case '<':
          candidates = table.queryIndexLessThan(p.column, val);
          break;
        case '>=': {
          const gt = table.queryIndexGreaterThan(p.column, val);
          const eq = table.queryIndexExact(p.column, val);
          candidates = [...new Set([...gt, ...eq])].sort((a, b) => a - b);
          break;
        }
        case '<=': {
          const lt = table.queryIndexLessThan(p.column, val);
          const eq = table.queryIndexExact(p.column, val);
          candidates = [...new Set([...lt, ...eq])].sort((a, b) => a - b);
          break;
        }
        default:
          continue;
      }

      if (!candidates) continue;

      // 在候选集上评估剩余条件
      const result: number[] = [];
      for (const rowIndex of candidates) {
        if (this.evalWhereExprAt(table, expr, rowIndex)) {
          result.push(rowIndex);
        }
      }

      return result;
    }

    return null;
  }

  /**
   * 在指定行评估 WHERE 表达式（用于索引后的二次过滤）
   */
  private evalWhereExprAt(table: ColumnarTable, expr: SQLWhereExpr, rowIndex: number): boolean {
    switch (expr.type) {
      case 'pred': {
        const v = this.getConditionValue(table, expr.pred.column as any, rowIndex);
        return this.evaluateCondition(v, expr.pred.operator as any, (expr.pred as any).value);
      }
      case 'and':
        return this.evalWhereExprAt(table, expr.left, rowIndex) && this.evalWhereExprAt(table, expr.right, rowIndex);
      case 'or':
        return this.evalWhereExprAt(table, expr.left, rowIndex) || this.evalWhereExprAt(table, expr.right, rowIndex);
      case 'not':
        return !this.evalWhereExprAt(table, expr.expr, rowIndex);
      default:
        return false;
    }
  }

  private sqlEquals(a: any, b: any): boolean {
    if (a === b) return true;

    // string
    if (typeof a === 'string' && typeof b === 'string') return a === b;

    // null
    if (a == null || b == null) return false;

    // bigint ↔ number (only safe for finite integers)
    if (typeof a === 'bigint' && typeof b === 'number' && Number.isFinite(b) && Number.isInteger(b)) {
      return a === BigInt(b);
    }
    if (typeof a === 'number' && typeof b === 'bigint' && Number.isFinite(a) && Number.isInteger(a)) {
      return BigInt(a) === b;
    }

    // bigint ↔ numeric string
    if (typeof a === 'bigint' && typeof b === 'string' && /^[+-]?\d+$/.test(b)) {
      try {
        return a === BigInt(b);
      } catch {}
    }
    if (typeof a === 'string' && typeof b === 'bigint' && /^[+-]?\d+$/.test(a)) {
      try {
        return BigInt(a) === b;
      } catch {}
    }

    // number ↔ numeric string
    if (typeof a === 'number' && typeof b === 'string' && b.trim() !== '' && Number.isFinite(Number(b))) {
      return a === Number(b);
    }
    if (typeof a === 'string' && typeof b === 'number' && a.trim() !== '' && Number.isFinite(Number(a))) {
      return Number(a) === b;
    }

    return false;
  }

  private evaluateCondition(value: any, operator: SQLOperator, compareValue: any): boolean {
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
        // 子查询：IN (SELECT ...)
        if (compareValue && typeof compareValue === 'object' && 'subquery' in compareValue) {
          const subRes = this.executeSelect((compareValue as any).subquery);
          if (subRes.rowCount === 0) return false;
          if (subRes.columns.length === 0) return false;

          // 提取第一列作为 IN 的值集合
          const col0 = subRes.columns[0];
          const vals = subRes.rows.map((r: any) => r[col0]);

          // 多列 IN 子查询（暂不支持）
          if (Array.isArray(value)) {
            throw new Error('Multi-column IN subquery not yet supported');
          }

          // 单列 IN
          return vals.some((v) => this.sqlEquals(value, v));
        }

        if (!Array.isArray(compareValue)) return false;

        // 多列 IN: value=[a,b], compareValue=[[a1,b1],[a2,b2]]
        if (Array.isArray(value)) {
          return (compareValue as any[]).some((tuple) => {
            if (!Array.isArray(tuple)) return false;
            if (tuple.length !== value.length) return false;
            for (let i = 0; i < value.length; i++) {
              if (!this.sqlEquals(value[i], tuple[i])) return false;
            }
            return true;
          });
        }

        // 单列 IN
        return (compareValue as any[]).some((v) => this.sqlEquals(value, v));
      }
      case 'LIKE':
        return this.likeMatch(String(value), String(compareValue));
      default:
        return false;
    }
  }

  private likeMatch(value: string, pattern: string): boolean {
    const regex = pattern.replace(/%/g, '.*').replace(/_/g, '.');
    return new RegExp(`^${regex}$`, 'i').test(value);
  }

  // 在“行对象”上评估 WHERE/HAVING AST（用于 GROUP BY 后 HAVING）
  private getConditionValueFromRow(row: Record<string, any>, column: string | string[]): any {
    if (Array.isArray(column)) return column.map((c) => row[c]);

    const expr = this.normalizeExpr(column);
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(expr)) return row[expr];

    // 允许在 HAVING 里写简单标量表达式（基于聚合输出/alias）
    return this.evalScalarExpr(expr, row);
  }

  private filterRowsByWhereExpr(rows: Array<Record<string, any>>, expr: SQLWhereExpr): Array<Record<string, any>> {
    const evalNode = (row: Record<string, any>, n: SQLWhereExpr): boolean => {
      switch (n.type) {
        case 'pred': {
          const v = this.getConditionValueFromRow(row, (n.pred as any).column);
          return this.evaluateCondition(v, (n.pred as any).operator, (n.pred as any).value);
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

    return rows.filter((r) => evalNode(r, expr));
  }

  // ---------------------------------------------------------------------------
  // Fast path: ORDER BY <col> DESC LIMIT 1 + window aggs over that <col>
  // ---------------------------------------------------------------------------

  private tryExecuteTailWindow(select: SQLSelect, table: ColumnarTable): SQLQueryResult | null {
    // 条件尽量保守：只优化我们确定的波动率模式
    if (!select.limit || select.limit !== 1) return null;
    if (select.offset !== undefined) return null;
    if ((select as any).whereExpr) return null;
    if (select.where && select.where.length > 0) return null;
    if (select.groupBy && select.groupBy.length > 0) return null;
    if (!select.orderBy || select.orderBy.length !== 1) return null;

    const ob = select.orderBy[0];
    if (ob.direction !== 'DESC') return null;

    const orderExpr = this.normalizeExpr(ob.expr);
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(orderExpr)) return null;
    const orderCol = orderExpr;

    if (!table.getColumnNames || !table.getColumn) return null;

    const rowCount = table.getRowCount();
    if (rowCount <= 0) {
      return { columns: [], rows: [], rowCount: 0 };
    }
    const lastIdx = rowCount - 1;

    // 规范化选择项（保留 alias / dotted ident 自动取末段）
    const selections: SelectItem[] = this.buildSelections(select.columns);

    // 允许：纯列名（可 alias） + window expr + 标量表达式（会在单行上求值）
    const windowItems: Array<{ spec: WindowSpec; name: string; rawExpr: string }> = [];
    const scalarExprItems: Array<{ expr: string; name: string }> = [];

    for (const s of selections) {
      const expr = this.normalizeExpr(s.expr);

      // 纯列名
      const isIdent = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(expr);
      if (expr === '*' ) return null; // fast-path 不处理 *
      if (isIdent) continue;

      const spec = this.parseWindowExpr(expr);
      if (!spec) {
        scalarExprItems.push({ expr, name: s.name });
        continue;
      }

      // 仅支持无 partition 的 tail 计算（每个 symbol 文件本身就是单分区）
      if (spec.partitionBy && spec.partitionBy.length > 0) return null;

      // OVER 必须 ORDER BY orderCol ASC
      if (!spec.orderBy) return null;
      if (spec.orderBy.column !== orderCol) return null;
      if ((spec.orderBy.direction || 'ASC') !== 'ASC') return null;

      // frame 必须是 ROWS BETWEEN N PRECEDING AND CURRENT ROW (N 为数字或 UNBOUNDED)
      if (spec.frame && spec.frame.kind !== 'rows') return null;

      windowItems.push({ spec, name: s.name, rawExpr: expr });
    }

    // 至少要有一个 window expr（否则这个 fast-path 价值不大）
    if (windowItems.length === 0) return null;

    const outRow: Record<string, any> = {};

    // 先填充列名（含 alias）
    for (const s of selections) {
      const expr = this.normalizeExpr(s.expr);
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(expr)) {
        const col = table.getColumn(expr);
        if (col) outRow[s.name] = (col as any)[lastIdx];
      }
    }

    // 计算每个 window expr 的 last 值
    for (const item of windowItems) {
      const val = this.computeWindowTail(table, lastIdx, item.spec);
      outRow[item.name] = val;
    }

    // 标量表达式（可引用上面的 alias/window 结果）
    for (const it of scalarExprItems) {
      outRow[it.name] = this.evalScalarExpr(it.expr, outRow);
    }

    return {
      columns: selections.map((s) => s.name),
      rows: [outRow],
      rowCount: 1,
    };
  }

  private computeWindowTail(table: ColumnarTable, lastIdx: number, spec: WindowSpec): number {
    if (spec.func === 'row_number') return lastIdx + 1;

    const argCol = spec.arg && spec.arg !== '*' ? spec.arg : undefined;
    if (!argCol) {
      // count(*)
      if (spec.func === 'count') return lastIdx + 1;
      return NaN;
    }

    const col = table.getColumn(argCol) as any;
    if (!col) return NaN;

    const preceding = spec.frame?.preceding ?? 'unbounded';
    const winLen = preceding === 'unbounded' ? (lastIdx + 1) : (preceding as number) + 1;

    const start = Math.max(0, lastIdx - winLen + 1);
    const n = lastIdx - start + 1;
    if (n <= 0) return NaN;

    if (spec.func === 'count') return n;

    // 单 pass 聚合
    let sum = 0;
    let sumSq = 0;
    let min = Infinity;
    let max = -Infinity;

    for (let i = start; i <= lastIdx; i++) {
      const raw = col[i];
      const v = typeof raw === 'bigint' ? Number(raw) : Number(raw);
      if (!Number.isFinite(v)) return NaN;

      sum += v;
      sumSq += v * v;
      if (v < min) min = v;
      if (v > max) max = v;
    }

    switch (spec.func) {
      case 'sum':
        return sum;
      case 'avg':
        return sum / n;
      case 'min':
        return min;
      case 'max':
        return max;
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

  /**
   * Fast path: CTE + PARTITION BY + ROW_NUMBER() ... DESC + WHERE rn=1
   * 典型场景：波动率脚本的 periods CTE，只取每个 symbol 的最新一行
   */
  private tryExecutePartitionTail(
    select: SQLSelect,
    cteName: string,
    cteSelect: SQLSelect,
    baseTable: ColumnarTable
  ): SQLQueryResult | null {
    // 1) 检查外层是 FROM cte + WHERE rn=1
    if (select.from !== cteName) return null;

    let whereOk = false;
    if (select.where && select.where.length === 1) {
      const c = select.where[0];
      whereOk = c.column === 'rn' && c.operator === '=' && c.value === 1;
    } else if ((select as any).whereExpr && (select as any).whereExpr.type === 'pred') {
      const p = (select as any).whereExpr.pred;
      whereOk = p.column === 'rn' && p.operator === '=' && (p as any).value === 1;
    }
    if (!whereOk) return null;

    // 2) 检查 CTE 包含 ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ... DESC) AS rn
    const rnSel = cteSelect.columns.find((c: any) => (c.alias || c.expr) === 'rn');
    if (!rnSel) return null;
    const rnExpr = typeof rnSel === 'string' ? rnSel : rnSel.expr;
    const rnSpec = this.parseWindowExpr(rnExpr);
    if (!rnSpec || rnSpec.func !== 'row_number') return null;
    if (!rnSpec.partitionBy || rnSpec.partitionBy.length === 0) return null;
    if (!rnSpec.orderBy || rnSpec.orderBy.direction !== 'DESC') return null;
    const orderCol = rnSpec.orderBy.column;

    // 3) 收集 CTE 中的其他窗口函数（需要按 partition 计算 tail）
    const cteSelections: SelectItem[] = cteSelect.columns.map((c: any) =>
      typeof c === 'string' ? { expr: c, name: c } : { expr: c.expr, name: c.alias || c.expr }
    );
    const { selections: rewrittenCteSel, windowItems } = this.prepareInlineWindows(cteSelections);

    // 额外：CTE 选择项本身可能就是窗口函数（例如 ROW_NUMBER() OVER (...) AS rn）
    const standaloneWindowItems: Array<{ spec: WindowSpec; name: string; rawExpr: string }> = [];
    for (const s of rewrittenCteSel) {
      const spec = this.parseWindowExpr(s.expr);
      if (spec) standaloneWindowItems.push({ spec, name: s.name, rawExpr: s.expr });
    }

    // 4) 确定 partition 边界（按 partition columns + orderCol 排序后的连续段）
    const partCols = rnSpec.partitionBy;
    let partitions = this.findPartitions(baseTable, partCols, orderCol, 'DESC');

    // 4.1) 尝试从 CTE 的 WHERE 提取“分区级过滤”（典型：WHERE (a,b) IN (...)）
    if (cteSelect.where && cteSelect.where.length > 0) {
      const predFilter = this.tryBuildPartitionFilter(baseTable, partCols, cteSelect.where);
      if (!predFilter) return null; // 有 WHERE 但无法安全优化 → 回退常规执行
      partitions = partitions.filter(({ end }) => predFilter(end));
    } else if ((cteSelect as any).whereExpr) {
      // 有 whereExpr 但未线性化：为了正确性直接回退
      return null;
    }

    // 5) 对每个 partition 计算最后一行的各窗口值
    const rows: Array<Record<string, any>> = [];
    for (const { start, end } of partitions) {
      const lastIdx = end;
      const row: Record<string, any> = {};

      // 复制纯列值（同时保留原列名，避免后续表达式引用到原名时变成 undefined）
      for (const sel of rewrittenCteSel) {
        const expr = this.normalizeExpr((sel as any).__rewrittenExpr ?? sel.expr);
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(expr)) {
          const col = baseTable.getColumn(expr);
          if (col) {
            const v = (col as any)[lastIdx];
            if (row[expr] === undefined) row[expr] = v;
            row[sel.name] = v;
          }
        }
      }

      // 计算 standalone window（如 rn）
      for (const item of standaloneWindowItems) {
        // ROW_NUMBER() OVER (... ORDER BY ... DESC) 在“最新一行”上恒为 1
        if (item.spec.func === 'row_number' && item.spec.orderBy?.direction === 'DESC') {
          row[item.name] = 1;
          continue;
        }

        const val = this.computeWindowTailPartition(baseTable, lastIdx, item.spec, start);
        row[item.name] = val;
      }

      // 计算 inline window（表达式里嵌套的窗口）
      for (const item of windowItems) {
        const val = this.computeWindowTailPartition(baseTable, lastIdx, item.spec, start);
        row[item.name] = val;
      }

      // 标量表达式（如 base || '/' || quote；或对 inline window 占位符做算术）
      for (const sel of rewrittenCteSel) {
        if (row[sel.name] !== undefined) continue;
        const rawExpr = (sel as any).__rewrittenExpr ?? sel.expr;
        const expr = this.normalizeExpr(rawExpr);
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(expr)) {
          row[sel.name] = this.evalScalarExpr(expr, row);
        }
      }

      rows.push(row);
    }

    // 6) 应用外层投影（scalar 表达式，如 vol_1d_pct）
    const outerSelections: SelectItem[] = select.columns.map((c: any) =>
      typeof c === 'string' ? { expr: c, name: c } : { expr: c.expr, name: c.alias || c.expr }
    );
    const { selections: rewrittenOuter } = this.prepareInlineWindows(outerSelections);
    let finalRows = rows.map((r) => this.projectRow(r, rewrittenOuter));

    // 外层 ORDER BY / LIMIT/OFFSET（分区数通常远小于总行数，可直接排序切片）
    if (select.orderBy && select.orderBy.length > 0) {
      finalRows = this.executeOrderBy(finalRows, select.orderBy, outerSelections.map((s) => s.name));
    }
    if (select.offset !== undefined) finalRows = finalRows.slice(select.offset);
    if (select.limit !== undefined) finalRows = finalRows.slice(0, select.limit);

    return {
      columns: outerSelections.map((s) => s.name),
      rows: finalRows,
      rowCount: finalRows.length,
    };
  }

  /**
   * 查找 partitions（返回每个分区的 [start, end] 索引，包含 end）
   * 假设 table 已按 orderCol 在 partition 内有序
   */
  private tryBuildPartitionFilter(
    table: ColumnarTable,
    partCols: string[],
    where: SQLCondition[]
  ): ((rowIndex: number) => boolean) | null {
    // 仅支持 AND 链（legacy where[] 本身不表达括号/优先级）
    for (let i = 0; i < where.length - 1; i++) {
      if ((where[i].logic || 'AND') !== 'AND') return null;
    }

    // tuple IN: WHERE (a,b) IN ((..),(..))
    const tuple = where.find((c) => Array.isArray(c.column));
    let tupleSet: Set<string> | null = null;
    if (tuple) {
      const cols = tuple.column as string[];
      if (tuple.operator !== 'IN') return null;
      if (cols.length !== partCols.length) return null;
      for (let i = 0; i < cols.length; i++) if (cols[i] !== partCols[i]) return null;
      if (!Array.isArray(tuple.value) || tuple.value.length === 0) return null;
      tupleSet = new Set(
        (tuple.value as any[]).map((t) => {
          if (!Array.isArray(t)) return '__invalid__';
          return t.map((x) => String(x)).join('\u0000');
        })
      );
      if (tupleSet.has('__invalid__')) return null;
    }

    // per-column filters: col IN (...) / col = ... (only on partition columns)
    const colIn: Map<string, Set<string>> = new Map();
    const colEq: Map<string, string> = new Map();

    for (const c of where) {
      if (Array.isArray(c.column)) continue; // tuple 已处理
      const col = c.column;
      if (!partCols.includes(col)) return null;

      if (c.operator === 'IN') {
        if (!Array.isArray(c.value)) return null;
        colIn.set(col, new Set((c.value as any[]).map((x) => String(x))));
        continue;
      }
      if (c.operator === '=') {
        colEq.set(col, String(c.value));
        continue;
      }
      return null;
    }

    return (rowIndex: number) => {
      if (tupleSet) {
        const key = partCols
          .map((p) => {
            const col = table.getColumn(p) as any;
            return col ? String(col[rowIndex]) : 'undefined';
          })
          .join('\u0000');
        if (!tupleSet.has(key)) return false;
      }

      for (const [col, s] of colIn) {
        const arr = table.getColumn(col) as any;
        if (!arr) return false;
        if (!s.has(String(arr[rowIndex]))) return false;
      }
      for (const [col, v] of colEq) {
        const arr = table.getColumn(col) as any;
        if (!arr) return false;
        if (String(arr[rowIndex]) !== v) return false;
      }

      return true;
    };
  }

  private findPartitions(
    table: ColumnarTable,
    partCols: string[],
    orderCol: string,
    orderDir: 'ASC' | 'DESC'
  ): Array<{ start: number; end: number }> {
    const n = table.getRowCount();
    if (n === 0) return [];

    // 获取列数据
    const getVals = (idx: number): (string | number | bigint)[] => {
      return partCols.map((c) => {
        const col = table.getColumn(c) as any;
        return col ? col[idx] : undefined;
      });
    };

    const partitions: Array<{ start: number; end: number }> = [];
    let start = 0;
    let prevKey = getVals(0);

    for (let i = 1; i < n; i++) {
      const key = getVals(i);
      let same = true;
      for (let j = 0; j < key.length; j++) {
        if (key[j] !== prevKey[j]) {
          same = false;
          break;
        }
      }
      if (!same) {
        partitions.push({ start, end: i - 1 });
        start = i;
        prevKey = key;
      }
    }
    partitions.push({ start, end: n - 1 });
    return partitions;
  }

  /**
   * 计算指定位置在 partition 范围内的窗口 tail 值
   */
  private computeWindowTailPartition(
    table: ColumnarTable,
    lastIdx: number,
    spec: WindowSpec,
    partStart: number
  ): number {
    if (spec.func === 'row_number') return 1; // 在 tail 位置，row_number=1（相对于 DESC）

    const argCol = spec.arg && spec.arg !== '*' ? spec.arg : undefined;
    if (!argCol) {
      if (spec.func === 'count') return lastIdx - partStart + 1;
      return NaN;
    }

    const col = table.getColumn(argCol) as any;
    if (!col) return NaN;

    const preceding = spec.frame?.preceding ?? 'unbounded';
    const maxWin = preceding === 'unbounded' ? lastIdx - partStart + 1 : (preceding as number) + 1;
    const start = Math.max(partStart, lastIdx - maxWin + 1);
    const n = lastIdx - start + 1;
    if (n <= 0) return NaN;

    if (spec.func === 'count') return n;

    let sum = 0;
    let sumSq = 0;
    let min = Infinity;
    let max = -Infinity;

    for (let i = start; i <= lastIdx; i++) {
      const raw = col[i];
      const v = typeof raw === 'bigint' ? Number(raw) : Number(raw);
      if (!Number.isFinite(v)) return NaN;
      sum += v;
      sumSq += v * v;
      if (v < min) min = v;
      if (v > max) max = v;
    }

    switch (spec.func) {
      case 'sum':
        return sum;
      case 'avg':
        return sum / n;
      case 'min':
        return min;
      case 'max':
        return max;
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

  private getConditionValue(table: ColumnarTable, column: string | string[], rowIndex: number): any {
    if (Array.isArray(column)) {
      return column.map((c) => this.getColumnValue(table, c, rowIndex));
    }
    return this.getColumnValue(table, column, rowIndex);
  }

  private getColumnValue(table: ColumnarTable, column: string, rowIndex: number): any {
    const col: any = table.getColumn(column);
    if (!col) return undefined;
    return col[rowIndex];
  }

  // ---------------------------------------------------------------------------
  // Rows extraction
  // ---------------------------------------------------------------------------

  private extractRows(table: ColumnarTable, columns: string[], indices?: number[]): Array<Record<string, any>> {
    const rows: Array<Record<string, any>> = [];
    const rowCount = indices?.length ?? table.getRowCount();
    const actual = indices ?? Array.from({ length: rowCount }, (_, i) => i);

    for (const idx of actual) {
      const row: Record<string, any> = {};
      for (const col of columns) {
        row[col] = this.getColumnValue(table, col, idx);
      }
      rows.push(row);
    }

    return rows;
  }

  private applyFromAliasPrefix(rows: Array<Record<string, any>>, columns: string[], alias?: string): void {
    if (!alias) return;
    for (const r of rows) {
      for (const c of columns) {
        const k = `${alias}.${c}`;
        if (!Object.prototype.hasOwnProperty.call(r, k)) r[k] = r[c];
      }
    }
  }

  // ---------------------------------------------------------------------------
  // JOIN helpers
  // ---------------------------------------------------------------------------

  private extractRowsNamespaced(
    table: ColumnarTable,
    columns: string[],
    alias: string,
    includePlain: boolean
  ): Array<Record<string, any>> {
    const rows: Array<Record<string, any>> = [];
    const rowCount = table.getRowCount();

    for (let i = 0; i < rowCount; i++) {
      const row: Record<string, any> = {};
      for (const col of columns) {
        const v = this.getColumnValue(table, col, i);
        row[`${alias}.${col}`] = v;
        if (includePlain && row[col] === undefined) row[col] = v;
      }
      rows.push(row);
    }

    return rows;
  }

  private projectRowByColumns(row: Record<string, any>, cols: string[]): Record<string, any> {
    const out: Record<string, any> = {};
    for (const c of cols) out[c] = row[c];
    return out;
  }

  private getRowValue(row: Record<string, any>, ref: string, defaultAlias?: string): any {
    const r = String(ref).trim();

    if (r.includes('.')) return row[r];
    if (Object.prototype.hasOwnProperty.call(row, r)) return row[r];

    if (defaultAlias) {
      const key = `${defaultAlias}.${r}`;
      if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
    }

    // fallback: try unique match by suffix
    const suffix = `.${r}`;
    let foundKey: string | null = null;
    for (const k of Object.keys(row)) {
      if (k.endsWith(suffix)) {
        if (foundKey) return undefined; // ambiguous
        foundKey = k;
      }
    }

    return foundKey ? row[foundKey] : undefined;
  }

  private executeJoin(
    leftRows: Array<Record<string, any>>,
    leftDefaultAlias: string,
    rightTable: ColumnarTable,
    rightCols: string[],
    rightAlias: string,
    joinType: 'INNER' | 'LEFT',
    on: Array<{ left: string; operator: '='; right: string }>
  ): Array<Record<string, any>> {
    // right side materialize (namespaced only)
    const rightRows = this.extractRowsNamespaced(rightTable, rightCols, rightAlias, false);

    // build hash index on right
    const index = new Map<string, Array<Record<string, any>>>();

    const normRightRef = (s: string) => {
      const t = String(s).trim();
      if (t.includes('.')) return t;
      return `${rightAlias}.${t}`;
    };

    const normLeftRef = (s: string) => {
      const t = String(s).trim();
      if (t.includes('.')) return t;
      return t; // left rows already have plain keys; keep as-is
    };

    // determine mapping (swap if condition is reversed)
    const pairs = on.map((p) => {
      const l = String(p.left).trim();
      const r = String(p.right).trim();
      const leftIsRight = l.startsWith(`${rightAlias}.`);
      const rightIsRight = r.startsWith(`${rightAlias}.`);
      if (leftIsRight && !rightIsRight) {
        return { left: normLeftRef(r), right: normRightRef(l) };
      }
      return { left: normLeftRef(l), right: normRightRef(r) };
    });

    for (const rr of rightRows) {
      const key = pairs.map((p) => String(this.getRowValue(rr, p.right, rightAlias))).join('\u0000');
      const arr = index.get(key);
      if (arr) arr.push(rr);
      else index.set(key, [rr]);
    }

    const rightNullTemplate: Record<string, any> = {};
    for (const c of rightCols) rightNullTemplate[`${rightAlias}.${c}`] = undefined;

    const out: Array<Record<string, any>> = [];
    for (const lr of leftRows) {
      const key = pairs.map((p) => String(this.getRowValue(lr, p.left, leftDefaultAlias))).join('\u0000');
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

  // ---------------------------------------------------------------------------
  // Window functions + aliases
  // ---------------------------------------------------------------------------

  private applyWindowAndAliases(rows: Array<Record<string, any>>, selections: SelectItem[]): void {
    // 1) 先做简单 alias：SELECT close AS price
    for (const s of selections) {
      if (s.name === s.expr) continue;
      const expr = this.normalizeExpr(s.expr);

      // 仅处理“纯列名别名”（不处理复杂表达式别名）
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(expr)) {
        for (const r of rows) {
          if (!Object.prototype.hasOwnProperty.call(r, s.name)) {
            r[s.name] = r[expr];
          }
        }
      }
    }

    // 2) 计算窗口函数
    const windowItems: Array<{ spec: WindowSpec; name: string; rawExpr: string }> = [];
    for (const s of selections) {
      const spec = this.parseWindowExpr(s.expr);
      if (spec) windowItems.push({ spec, name: s.name, rawExpr: s.expr });
    }

    for (const item of windowItems) {
      const values = this.computeWindowColumn(rows, item.spec);
      for (let i = 0; i < rows.length; i++) {
        rows[i][item.name] = values[i];
      }
    }
  }

  /**
   * 提取表达式中内嵌的窗口函数（如 STDDEV(close) OVER (...) / SQRT(1)）
   * 返回 rewritten selections（窗口替换为占位符）+ 窗口项列表
   */
  private prepareInlineWindows(selections: SelectItem[]): {
    selections: SelectItem[];
    windowItems: Array<{ spec: WindowSpec; name: string; rawExpr: string }>;
  } {
    const windowItems: Array<{ spec: WindowSpec; name: string; rawExpr: string }> = [];
    const newSelections: SelectItem[] = selections.map((s) => ({ ...s }));

    for (let i = 0; i < newSelections.length; i++) {
      const s = newSelections[i];
      if (!/\bOVER\b/i.test(s.expr)) continue;

      const { rewrittenExpr, extracted } = this.extractInlineWindows(s.expr, i);
      if (extracted.length > 0) {
        (s as any).__rewrittenExpr = rewrittenExpr;
        for (const e of extracted) {
          windowItems.push({ spec: e.spec, name: e.placeholder, rawExpr: e.rawExpr });
        }
      }
    }

    return { selections: newSelections, windowItems };
  }

  private extractInlineWindows(
    expr: string,
    selIdx: number
  ): { rewrittenExpr: string; extracted: Array<{ placeholder: string; spec: WindowSpec; rawExpr: string }> } {
    const extracted: Array<{ placeholder: string; spec: WindowSpec; rawExpr: string }> = [];
    let rewritten = expr;

    // 匹配 FUNC(...) OVER (...)
    const windowRegex = /([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\s*([^)]*)\s*\)\s+OVER\s*\(([^)]+)\)/gi;
    let match: RegExpExecArray | null;

    while ((match = windowRegex.exec(expr)) !== null) {
      const rawExpr = match[0];
      const funcRaw = match[1];
      const argRaw = match[2].trim();
      const overRaw = match[3];

      const func = this.mapWindowFunc(funcRaw.toLowerCase());
      if (!func) continue;

      const spec: WindowSpec = {
        func,
        arg: argRaw === '' ? undefined : argRaw,
        partitionBy: this.parsePartitionBy(overRaw),
        orderBy: this.parseOrderBy(overRaw),
        frame: this.parseRowsFrame(overRaw),
      };

      const placeholder = `__iw_${selIdx}_${extracted.length}`;
      extracted.push({ placeholder, spec, rawExpr });

      // 只替换第一次出现（避免重复替换同一子串）
      rewritten = rewritten.replace(rawExpr, placeholder);
    }

    return { rewrittenExpr: rewritten, extracted };
  }

  private parseWindowExpr(expr: string): WindowSpec | null {
    const s = this.normalizeExpr(expr);
    if (!/\bOVER\b/i.test(s)) return null;

    // ROW_NUMBER() OVER (...)
    {
      const m = s.match(/^ROW_NUMBER\s*\(\s*\)\s*OVER\s*\(\s*(.+)\s*\)$/i);
      if (m) {
        const over = m[1];
        return {
          func: 'row_number',
          partitionBy: this.parsePartitionBy(over),
          orderBy: this.parseOrderBy(over),
          frame: this.parseRowsFrame(over),
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
      partitionBy: this.parsePartitionBy(over),
      orderBy: this.parseOrderBy(over),
      frame: this.parseRowsFrame(over),
    };
  }

  private mapWindowFunc(func: string): WindowSpec['func'] | null {
    switch (func) {
      case 'count':
        return 'count';
      case 'sum':
        return 'sum';
      case 'avg':
        return 'avg';
      case 'min':
        return 'min';
      case 'max':
        return 'max';
      case 'variance':
      case 'var':
        return 'variance';
      case 'stddev':
      case 'std':
        return 'stddev';
      default:
        return null;
    }
  }

  private parsePartitionBy(over: string): string[] {
    const m = over.match(/PARTITION\s+BY\s+(.+?)(?=(ORDER\s+BY|ROWS\s+BETWEEN|$))/i);
    if (!m) return [];
    return m[1].split(',').map((x) => x.trim()).filter(Boolean);
  }

  private parseOrderBy(over: string): { column: string; direction: 'ASC' | 'DESC' } | undefined {
    const m = over.match(/ORDER\s+BY\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(ASC|DESC))?/i);
    if (!m) return undefined;
    return { column: m[1], direction: ((m[2] || 'ASC').toUpperCase() as 'ASC' | 'DESC') };
  }

  private parseRowsFrame(over: string): WindowSpec['frame'] | undefined {
    // ROWS BETWEEN 96 PRECEDING AND CURRENT ROW
    const m = over.match(/ROWS\s+BETWEEN\s+(\d+|UNBOUNDED)\s+PRECEDING\s+AND\s+CURRENT\s+ROW/i);
    if (!m) return undefined;
    const p = m[1].toUpperCase() === 'UNBOUNDED' ? 'unbounded' : Number(m[1]);
    return { kind: 'rows', preceding: p as any, following: 0 };
  }

  private computeWindowColumn(rows: Array<Record<string, any>>, spec: WindowSpec): Array<number> {
    const out = new Array<number>(rows.length).fill(NaN);

    const partCols = spec.partitionBy || [];
    const order = spec.orderBy;
    const dir = order?.direction || 'ASC';

    // 分组
    const groups = new Map<string, number[]>();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const key = partCols.length === 0 ? '__all__' : partCols.map((c) => String(r[c])).join('|');
      let arr = groups.get(key);
      if (!arr) {
        arr = [];
        groups.set(key, arr);
      }
      arr.push(i);
    }

    for (const indices of groups.values()) {
      // order
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

      const argCol = spec.arg && spec.arg !== '*' ? spec.arg : undefined;
      if (!argCol) {
        // count(*) only
        if (spec.func !== 'count') continue;
      }

      const preceding = spec.frame?.preceding ?? 'unbounded';
      const winLen = preceding === 'unbounded' ? Infinity : (preceding as number) + 1;

      // Fast path: 固定 ROWS window 的 variance/stddev 用 libndts (rollingStd) 加速
      // - rollingStd 是「population std」，这里转换成「sample std/var」以对齐 DuckDB/SQL 常见语义
      if ((spec.func === 'stddev' || spec.func === 'variance') && rollingStdNative && winLen !== Infinity && argCol) {
        const w = winLen as number;

        if (w <= 1) {
          for (let p = 0; p < indices.length; p++) {
            out[indices[p]] = 0;
          }
          continue;
        }

        const values = new Float64Array(indices.length);
        let allFinite = true;
        for (let p = 0; p < indices.length; p++) {
          const ridx = indices[p];
          const raw = rows[ridx][argCol];
          const v = typeof raw === 'bigint' ? Number(raw) : Number(raw);
          if (!Number.isFinite(v)) {
            allFinite = false;
            break;
          }
          values[p] = v;
        }

        if (allFinite) {
          const popStd = indices.length >= w ? rollingStdNative(values, w) : null;
          const ratio = w / (w - 1); // pop → samp
          const scale = Math.sqrt(ratio);

          let sum = 0;
          let sumSq = 0;

          for (let p = 0; p < indices.length; p++) {
            const ridx = indices[p];
            const v = values[p];

            // 前 w-1 行：frame 实际长度 < w，按真实 n 做 sample 统计（SQL window 语义）
            if (!popStd || p < w - 1) {
              sum += v;
              sumSq += v * v;
              const n = p + 1;
              if (n <= 1) {
                out[ridx] = 0;
              } else {
                const mean = sum / n;
                const varSamp = (sumSq - n * mean * mean) / (n - 1);
                out[ridx] = spec.func === 'stddev' ? Math.sqrt(Math.max(0, varSamp)) : Math.max(0, varSamp);
              }
              continue;
            }

            const sPop = popStd[p];
            if (!Number.isFinite(sPop)) {
              out[ridx] = NaN;
              continue;
            }

            if (spec.func === 'stddev') {
              out[ridx] = sPop * scale;
            } else {
              out[ridx] = (sPop * sPop) * ratio;
            }
          }

          continue;
        }
      }

      // 目前 window 聚合仅支持数值列（count(*) 例外）
      const buf = winLen !== Infinity ? new Float64Array(winLen) : null;
      let head = 0;
      let size = 0;
      let sum = 0;
      let sumSq = 0;

      // min/max 用 deque
      const dequeIdx: number[] = [];
      const dequeVal: number[] = [];

      const pushVal = (v: number) => {
        if (!buf) return;
        buf[(head + size) % buf.length] = v;
        size++;
      };
      const popVal = (): number => {
        if (!buf || size === 0) return NaN;
        const v = buf[head];
        head = (head + 1) % buf.length;
        size--;
        return v;
      };

      const dequePush = (pos: number, v: number, isMin: boolean) => {
        // maintain monotonic
        while (dequeIdx.length > 0) {
          const last = dequeVal[dequeVal.length - 1];
          if (isMin ? last <= v : last >= v) break;
          dequeIdx.pop();
          dequeVal.pop();
        }
        dequeIdx.push(pos);
        dequeVal.push(v);
      };

      const dequeExpire = (pos: number, window: number) => {
        const minPos = pos - window + 1;
        while (dequeIdx.length > 0 && dequeIdx[0] < minPos) {
          dequeIdx.shift();
          dequeVal.shift();
        }
      };

      for (let p = 0; p < indices.length; p++) {
        const ridx = indices[p];

        if (spec.func === 'count' && spec.arg === '*') {
          if (winLen === Infinity) {
            out[ridx] = p + 1;
          } else {
            out[ridx] = Math.min(p + 1, winLen);
          }
          continue;
        }

        const raw = rows[ridx][argCol!];
        const v = typeof raw === 'bigint' ? Number(raw) : Number(raw);
        if (!Number.isFinite(v)) {
          out[ridx] = NaN;
          continue;
        }

        // add
        if (winLen !== Infinity) {
          pushVal(v);
          if (size > (winLen as number)) {
            const old = popVal();
            sum -= old;
            sumSq -= old * old;
            if (spec.func === 'min' || spec.func === 'max') {
              dequeExpire(p, winLen as number);
            }
          }
        }

        sum += v;
        sumSq += v * v;

        // update deque after expire handled
        if (spec.func === 'min' || spec.func === 'max') {
          dequePush(p, v, spec.func === 'min');
          if (winLen !== Infinity) {
            dequeExpire(p, winLen as number);
          }
        }

        const n = winLen === Infinity ? (p + 1) : size;
        out[ridx] = this.windowAggValue(spec.func, n, sum, sumSq, dequeVal[0]);
      }
    }

    return out;
  }

  private windowAggValue(func: WindowSpec['func'], n: number, sum: number, sumSq: number, dequeFront: number | undefined): number {
    if (n <= 0) return NaN;

    switch (func) {
      case 'count':
        return n;
      case 'sum':
        return sum;
      case 'avg':
        return sum / n;
      case 'min':
      case 'max':
        return dequeFront ?? NaN;
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

  private compareValues(a: any, b: any): number {
    if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
    if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
    // fallback
    const sa = String(a);
    const sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  private normalizeExpr(expr: string): string {
    // also normalize dotted identifiers that may come from tokenized SQL: "t . col" -> "t.col"
    return String(expr)
      .replace(/\s+/g, ' ')
      .replace(/\s*\.\s*/g, '.')
      .trim();
  }

  private buildSelections(cols: SQLSelect['columns']): SelectItem[] {
    const norm = (x: string) => this.normalizeExpr(x);

    // first pass: propose names
    const proposed: Array<{ expr: string; proposed: string; explicit: boolean }> = cols.map((c: any) => {
      if (typeof c === 'string') {
        const expr = norm(c);
        if (IDENT_RE.test(expr)) {
          const last = expr.split('.').pop()!;
          return { expr, proposed: last, explicit: false };
        }
        return { expr, proposed: expr, explicit: false };
      }

      const expr = norm(c.expr);
      const name = c.alias || expr;
      return { expr, proposed: name, explicit: true };
    });

    const counts = new Map<string, number>();
    for (const p of proposed) {
      const key = p.proposed;
      counts.set(key, (counts.get(key) || 0) + 1);
    }

    return proposed.map((p) => {
      if (p.explicit) return { expr: p.expr, name: p.proposed };

      // avoid collisions for implicit names: fall back to full expr
      if ((counts.get(p.proposed) || 0) > 1) return { expr: p.expr, name: p.expr };
      return { expr: p.expr, name: p.proposed };
    });
  }

  // ---------------------------------------------------------------------------
  // Scalar expressions (DuckDB/SQLite style subset)
  // ---------------------------------------------------------------------------

  private evalScalarExpr(expr: string, row: Record<string, any>): any {
    const tokens = this.tokenizeExpr(expr);
    let pos = 0;

    const peek = () => tokens[pos];
    const consume = (expected?: string) => {
      const t = tokens[pos];
      if (!t) throw new Error(`Unexpected end of expression: ${expr}`);
      if (expected && t.value.toUpperCase() !== expected.toUpperCase()) {
        throw new Error(`Expected ${expected}, got ${t.value} in expr: ${expr}`);
      }
      pos++;
      return t;
    };

    const parseExpression = (): any => parseConcat();

    // string concat operator (SQLite): a || b
    const parseConcat = (): any => {
      let node = parseAddSub();
      while (true) {
        const t = peek();
        if (!t) break;
        if (t.value === '||') {
          consume();
          const right = parseAddSub();
          node = { type: 'bin', op: '||', left: node, right };
          continue;
        }
        break;
      }
      return node;
    };

    const parseAddSub = (): any => {
      let node = parseMulDiv();
      while (true) {
        const t = peek();
        if (!t) break;
        if (t.value === '+' || t.value === '-') {
          consume();
          const right = parseMulDiv();
          node = { type: 'bin', op: t.value, left: node, right };
          continue;
        }
        break;
      }
      return node;
    };

    const parseMulDiv = (): any => {
      let node = parseUnary();
      while (true) {
        const t = peek();
        if (!t) break;
        if (t.value === '*' || t.value === '/' || t.value === '%') {
          consume();
          const right = parseUnary();
          node = { type: 'bin', op: t.value, left: node, right };
          continue;
        }
        break;
      }
      return node;
    };

    const parseUnary = (): any => {
      const t = peek();
      if (t && (t.value === '+' || t.value === '-')) {
        consume();
        const inner = parseUnary();
        return { type: 'unary', op: t.value, inner };
      }
      return parsePrimary();
    };

    const parsePrimary = (): any => {
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

        // function call
        if (peek()?.value === '(') {
          consume('(');
          const args: any[] = [];
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
    if (pos < tokens.length) {
      // allow trailing whitespace already removed; any leftover token is an error
      throw new Error(`Unexpected token ${tokens[pos].value} in expr: ${expr}`);
    }

    const evalNode = (n: any): any => {
      switch (n.type) {
        case 'number':
          return n.value;
        case 'string':
          return n.value;
        case 'ident': {
          const v = row[n.name];
          return typeof v === 'bigint' ? Number(v) : v;
        }
        case 'unary': {
          const v = Number(evalNode(n.inner));
          return n.op === '-' ? -v : +v;
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
            case '+':
              return a + b;
            case '-':
              return a - b;
            case '*':
              return a * b;
            case '/':
              return a / b;
            case '%':
              return a % b;
            default:
              return NaN;
          }
        }
        case 'call': {
          const fname = String(n.name).toUpperCase();
          const args = (n.args || []).map((x: any) => evalNode(x));

          // 常用数学函数（足够覆盖波动率/指标场景）
          switch (fname) {
            case 'SQRT':
              return Math.sqrt(Number(args[0]));
            case 'ABS':
              return Math.abs(Number(args[0]));
            case 'LN':
              return Math.log(Number(args[0]));
            case 'LOG':
              return Math.log(Number(args[0]));
            case 'EXP':
              return Math.exp(Number(args[0]));
            case 'POW':
            case 'POWER':
              return Math.pow(Number(args[0]), Number(args[1]));
            case 'ROUND': {
              const x = Number(args[0]);
              const nDigits = args.length >= 2 ? Number(args[1]) : 0;
              const f = Math.pow(10, nDigits);
              return Math.round(x * f) / f;
            }
            case 'MIN':
              return Math.min(...args.map((x: any) => Number(x)));
            case 'MAX':
              return Math.max(...args.map((x: any) => Number(x)));
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

  private tokenizeExpr(expr: string): Array<{ kind: 'number' | 'ident' | 'string' | 'op'; value: string }> {
    const s = String(expr);
    const out: Array<{ kind: any; value: string }> = [];
    let i = 0;

    while (i < s.length) {
      const ch = s[i];
      if (/\s/.test(ch)) {
        i++;
        continue;
      }

      // string literal
      if (ch === '\'' || ch === '"') {
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
        i++; // closing quote
        out.push({ kind: 'string', value: buf });
        continue;
      }

      // number
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(s[i + 1]))) {
        let num = '';
        while (i < s.length && /[0-9eE+\-\.]/.test(s[i])) {
          num += s[i];
          i++;
        }
        out.push({ kind: 'number', value: num });
        continue;
      }

      // identifier (support dotted: t.col)
      if (/[a-zA-Z_]/.test(ch)) {
        let id = '';
        while (i < s.length && /[a-zA-Z0-9_\.]/.test(s[i])) {
          id += s[i];
          i++;
        }
        out.push({ kind: 'ident', value: id });
        continue;
      }

      // operators / punctuation
      if (ch === '|' && s[i + 1] === '|') {
        out.push({ kind: 'op', value: '||' });
        i += 2;
        continue;
      }

      if ('()+-*/%,'.includes(ch)) {
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

  /**
   * 检测表达式是否包含聚合函数
   */
  private hasAggregateFunction(expr: string): boolean {
    const normalized = this.normalizeExpr(expr).toLowerCase().replace(/\s+/g, '');
    const aggregateFunctions = ['count', 'sum', 'avg', 'min', 'max', 'stddev', 'variance', 'first', 'last'];
    
    for (const fn of aggregateFunctions) {
      if (normalized.includes(`${fn}(`)) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * 检测 SelectItem 列表中是否有聚合函数
   */
  private hasAggregateInSelections(selections: SelectItem[]): boolean {
    for (const sel of selections) {
      const rawExpr = (sel as any).__rewrittenExpr ?? sel.expr;
      if (this.hasAggregateFunction(rawExpr)) {
        return true;
      }
    }
    return false;
  }

  private executeGroupBy(rows: Array<Record<string, any>>, selections: SelectItem[], groupByCols: string[]): Array<Record<string, any>> {
    const groups = new Map<string, Array<Record<string, any>>>();

    for (const row of rows) {
      const key = groupByCols.map((c) => String(row[c])).join('|');
      let arr = groups.get(key);
      if (!arr) {
        arr = [];
        groups.set(key, arr);
      }
      arr.push(row);
    }

    const result: Array<Record<string, any>> = [];

    for (const groupRows of groups.values()) {
      const aggregated: Record<string, any> = {};

      for (const sel of selections) {
        if (groupByCols.includes(sel.expr) || groupByCols.includes(sel.name)) {
          // group key
          const keyCol = groupByCols.includes(sel.name) ? sel.name : sel.expr;
          aggregated[sel.name] = groupRows[0][keyCol];
        } else {
          aggregated[sel.name] = this.aggregateExpr(groupRows, sel.expr);
        }
      }

      result.push(aggregated);
    }

    return result;
  }

  private aggregateExpr(rows: Array<Record<string, any>>, expr: string): any {
    const s = this.normalizeExpr(expr);
    const compact = s.toLowerCase().replace(/\s+/g, '');

    // count(*)
    if (compact.startsWith('count(*)')) return rows.length;

    const fnMatch = compact.match(/^([a-z_][a-z0-9_]*)\(([^)]*)\)$/i);
    if (!fnMatch) {
      // 非聚合列：取第一个值
      return rows[0]?.[expr];
    }

    const fn = fnMatch[1].toLowerCase();
    const colName = fnMatch[2].trim();

    const values = colName === '*' ? [] : rows.map((r) => Number(r[colName]));

    switch (fn) {
      case 'count':
        return colName === '*' ? rows.length : values.filter((v) => Number.isFinite(v)).length;
      case 'sum':
        return values.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
      case 'avg': {
        const good = values.filter((v) => Number.isFinite(v));
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
        const good = values.filter((v) => Number.isFinite(v));
        const n = good.length;
        if (n <= 1) return 0;
        const mean = good.reduce((a, b) => a + b, 0) / n;
        let sumSq = 0;
        for (const v of good) sumSq += (v - mean) * (v - mean);
        return sumSq / (n - 1);
      }
      case 'stddev':
      case 'std': {
        const good = values.filter((v) => Number.isFinite(v));
        const n = good.length;
        if (n <= 1) return 0;
        const mean = good.reduce((a, b) => a + b, 0) / n;
        let sumSq = 0;
        for (const v of good) sumSq += (v - mean) * (v - mean);
        return Math.sqrt(sumSq / (n - 1));
      }
      default:
        // 非聚合列：取第一个
        return rows[0]?.[colName];
    }
  }

  // ---------------------------------------------------------------------------
  // ORDER BY
  // ---------------------------------------------------------------------------

  private executeOrderBy(
    rows: Array<Record<string, any>>,
    orderBy: { expr: string; direction: 'ASC' | 'DESC' }[],
    outputColumns: string[]
  ): Array<Record<string, any>> {
    const plans = orderBy.map(({ expr, direction }) => {
      const raw = this.normalizeExpr(expr);

      // ORDER BY 1 / 2 / ...（按输出列序号）
      if (/^[0-9]+$/.test(raw)) {
        const idx = parseInt(raw, 10);
        if (idx >= 1 && idx <= outputColumns.length) {
          return { kind: 'col' as const, direction, col: outputColumns[idx - 1] };
        }
      }

      // ORDER BY col/alias
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(raw)) {
        return { kind: 'col' as const, direction, col: raw };
      }

      // ORDER BY <scalar expr>
      return { kind: 'expr' as const, direction, expr: raw };
    });

    // Decorate → sort → undecorate（避免 sort comparator 内反复 eval expr）
    const decorated = rows.map((row, index) => {
      const keys = plans.map((p) => {
        if (p.kind === 'col') return row[p.col];
        return this.evalScalarExpr(p.expr, row);
      });
      return { row, index, keys };
    });

    decorated.sort((a, b) => {
      for (let i = 0; i < plans.length; i++) {
        const p = plans[i];
        const cmp = this.compareValues(a.keys[i], b.keys[i]);
        if (cmp !== 0) return p.direction === 'ASC' ? cmp : -cmp;
      }
      // 稳定排序：完全相等时按原顺序
      return a.index - b.index;
    });

    return decorated.map((d) => d.row);
  }

  // ---------------------------------------------------------------------------
  // CREATE TABLE
  // ---------------------------------------------------------------------------

  private executeCreateTable(create: SQLCreateTable): number {
    const name = create.table;
    if (this.getTable(name)) {
      throw new Error(`Table already exists: ${name}`);
    }

    const columnDefs = create.columns.map((c) => ({
      name: c.name,
      type: this.mapSQLTypeToColumnarType(c.type),
    }));

    const table = new ColumnarTable(columnDefs);
    this.registerTable(name, table);

    return 0;
  }

  private mapSQLTypeToColumnarType(type: string): ColumnarType {
    const t = String(type).trim().toUpperCase();

    // int64
    if (['INT64', 'BIGINT', 'LONG', 'TIMESTAMP', 'I64'].includes(t)) return 'int64';

    // int32
    if (['INT', 'INTEGER', 'INT32', 'I32'].includes(t)) return 'int32';

    // int16
    if (['INT16', 'SMALLINT', 'SHORT', 'I16'].includes(t)) return 'int16';

    // float64
    if (['FLOAT', 'FLOAT64', 'DOUBLE', 'REAL', 'DECIMAL', 'NUMERIC', 'F64'].includes(t)) return 'float64';

    throw new Error(`Unsupported column type: ${type}`);
  }

  // ---------------------------------------------------------------------------
  // INSERT / UPSERT
  // ---------------------------------------------------------------------------

  private executeInsert(insert: any): number {
    const table = this.getTable(insert.into);
    if (!table) throw new Error(`Table not found: ${insert.into}`);

    const rows = insert.values.map((row: any[]) => {
      const obj: Record<string, any> = {};
      insert.columns.forEach((col: string, i: number) => {
        obj[col] = row[i];
      });
      return obj;
    });

    table.appendBatch(rows);
    return rows.length;
  }

  private executeUpsert(upsert: SQLUpsert): number {
    const table = this.getTable(upsert.into);
    if (!table) throw new Error(`Table not found: ${upsert.into}`);

    const keyIndex = this.buildKeyIndex(table, upsert.conflictColumns);

    let inserted = 0;
    let updated = 0;

    for (const values of upsert.values) {
      const row: Record<string, any> = {};
      upsert.columns.forEach((col, i) => {
        row[col] = values[i];
      });

      const key = this.makeKey(row, upsert.conflictColumns);
      const existingIndex = keyIndex.get(key);

      if (existingIndex !== undefined) {
        const updateData: Record<string, any> = {};
        for (const col of upsert.updateColumns) {
          updateData[col] = row[col];
        }
        table.updateRow(existingIndex, updateData);
        updated++;
      } else {
        table.append(row);
        keyIndex.set(key, table.getRowCount() - 1);
        inserted++;
      }
    }

    return inserted + updated;
  }

  private buildKeyIndex(table: ColumnarTable, keyColumns: string[]): Map<string, number> {
    const index = new Map<string, number>();
    const rowCount = table.getRowCount();

    const keyArrays = keyColumns.map((col) => table.getColumn(col));

    for (let i = 0; i < rowCount; i++) {
      const keyParts: string[] = [];
      for (let j = 0; j < keyColumns.length; j++) {
        const arr = keyArrays[j];
        if (arr) keyParts.push(String((arr as any)[i]));
      }
      index.set(keyParts.join('|'), i);
    }

    return index;
  }

  private makeKey(row: Record<string, any>, keyColumns: string[]): string {
    return keyColumns.map((col) => String(row[col])).join('|');
  }

  // 推断列名 (简化)
  private inferColumnNames(_table: ColumnarTable): string[] {
    return ['timestamp', 'symbol', 'price', 'volume'];
  }
}
