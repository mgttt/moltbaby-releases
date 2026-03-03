/**
 * sql.ts — Simple SQL parser and executor for ndtsdb
 *
 * Supports SELECT statements against ColumnarTable / PartitionedTable.
 * Features: WHERE, GROUP BY, HAVING, ORDER BY, LIMIT, OFFSET, DISTINCT
 * Aggregate functions: COUNT, SUM, AVG, MIN, MAX
 *
 * Supported syntax:
 *   SELECT [DISTINCT] [*|col1,col2,...] FROM <table>
 *   [WHERE <condition>]
 *   [GROUP BY col1, col2, ...]
 *   [HAVING <aggregate_condition>]
 *   [ORDER BY <col> [ASC|DESC] [, <col2> [ASC|DESC], ...]]
 *   [LIMIT <n>]
 *   [OFFSET <n>]
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OrderBySpec {
  col: string;
  direction: 'ASC' | 'DESC';
}

export interface SelectData {
  fields: string[];        // ['*'] or specific column names
  from:   string;          // table name
  distinct?: boolean;      // SELECT DISTINCT
  where?: string;          // raw WHERE clause string (unparsed)
  groupBy?: string[];      // GROUP BY column names
  having?: string;         // HAVING clause string (unparsed)
  orderBy?: OrderBySpec[]; // ORDER BY clause with multiple columns support
  limit?: number;
  offset?: number;
}

export interface ParsedSQL {
  type: 'SELECT' | 'INSERT' | 'DELETE' | 'UPDATE' | 'CREATE' | 'DROP' | 'UNKNOWN';
  data: SelectData;
}

export interface QueryResult {
  rows: Record<string, any>[];
}

// ─── parseSQL ────────────────────────────────────────────────────────────────

export function parseSQL(sql: string): ParsedSQL {
  const s = sql.trim();
  const upper = s.toUpperCase();

  if (!upper.startsWith('SELECT')) {
    const type = ['INSERT','DELETE','UPDATE','CREATE','DROP']
      .find(t => upper.startsWith(t)) ?? 'UNKNOWN';
    return { type: type as ParsedSQL['type'], data: { fields: [], from: '' } };
  }

  // Split by clause keywords (case-insensitive)
  const clauseRe = /\b(SELECT|FROM|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET)\b/gi;

  const parts: { name: string; start: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = clauseRe.exec(s)) !== null) {
    parts.push({ name: m[1].replace(/\s+/, ' ').toUpperCase(), start: m.index + m[0].length });
  }

  const clauses: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const end = i + 1 < parts.length ? parts[i + 1].start - parts[i + 1].name.length - 1 : s.length;
    clauses[parts[i].name] = s.slice(parts[i].start, end).trim();
  }

  // Parse SELECT: check for DISTINCT
  let distinct = false;
  let fieldsStr = clauses['SELECT'] ?? '*';
  if (fieldsStr.toUpperCase().startsWith('DISTINCT')) {
    distinct = true;
    fieldsStr = fieldsStr.slice(8).trim(); // Remove 'DISTINCT' keyword
  }
  const fields = fieldsStr === '*' ? ['*'] : fieldsStr.split(',').map(f => f.trim()).filter(Boolean);

  // Parse FROM (table name — may have alias, take first token)
  const fromStr = (clauses['FROM'] ?? '').split(/\s+/)[0] ?? '';

  // Parse GROUP BY
  let groupBy: string[] | undefined;
  if (clauses['GROUP BY']) {
    groupBy = clauses['GROUP BY'].split(',').map(c => c.trim()).filter(Boolean);
  }

  // Parse ORDER BY (support multiple columns)
  let orderBySpecs: OrderBySpec[] | undefined;
  if (clauses['ORDER BY']) {
    const orderByStr = clauses['ORDER BY'];
    const orderItems = orderByStr.split(',');
    orderBySpecs = [];

    for (const item of orderItems) {
      const parts = item.trim().split(/\s+/);
      const col = parts[0];
      let direction: 'ASC' | 'DESC' = 'ASC';
      if (parts[1]?.toUpperCase() === 'DESC') direction = 'DESC';
      else if (parts[1]?.toUpperCase() === 'ASC') direction = 'ASC';

      orderBySpecs.push({ col, direction });
    }
  }

  // Parse LIMIT / OFFSET
  const limitStr  = clauses['LIMIT'];
  const offsetStr = clauses['OFFSET'];
  const limit  = limitStr  ? parseInt(limitStr,  10) : undefined;
  const offset = offsetStr ? parseInt(offsetStr, 10) : undefined;

  return {
    type: 'SELECT',
    data: {
      fields,
      from: fromStr,
      distinct,
      where: clauses['WHERE'],
      groupBy,
      having: clauses['HAVING'],
      orderBy: orderBySpecs,
      limit,
      offset,
    },
  };
}

// ─── ColumnarTable ───────────────────────────────────────────────────────────

export interface ColumnDef {
  name: string;
  type: 'int64' | 'float64' | 'string';
}

/**
 * In-memory columnar table backed by typed arrays.
 * Used by SQLExecutor as the query target after loading from a PartitionedTable.
 */
export class ColumnarTable {
  private _columns: ColumnDef[];
  private _rows: Record<string, any>[] = [];

  constructor(columns: ColumnDef[]) {
    this._columns = columns;
  }

  get columnNames(): string[] { return this._columns.map(c => c.name); }

  appendBatch(rows: Record<string, any>[]): void {
    this._rows.push(...rows);
  }

  getRows(): Record<string, any>[] {
    return this._rows;
  }
}

// ─── WHERE clause evaluator ──────────────────────────────────────────────────

function buildWherePredicate(whereClause: string): (row: Record<string, any>) => boolean {
  // Evaluation function for WHERE and HAVING clauses.
  // Handles both regular columns (a, b) and aggregate expressions (COUNT(*), SUM(volume))
  //
  // Security note: this evaluates arbitrary WHERE expressions. This is acceptable
  // in a CLI tool used by the developer/operator, not in a multi-tenant web service.
  try {
    // First, extract and protect string literals to avoid replacing identifiers within them
    const strings: string[] = [];
    let expr = whereClause;

    // Extract string literals (both single and double quoted)
    expr = expr.replace(/(['"])([^'"]*)\1/g, (match) => {
      strings.push(match);
      return `___STRING_${strings.length - 1}___`;
    });

    // SQL operators → JS
    // Convert SQL = to JS ==, but be careful about ===, <=, >=, !=, <>
    expr = expr
      .replace(/([^=!<>])=([^=])/g, '$1==$2')  // Convert = to == but not when it's part of ==, !=, <=, >=
      .replace(/\bAND\b/gi, '&&')
      .replace(/\bOR\b/gi, '||')
      .replace(/\bNOT\b/gi, '!')
      .replace(/\bIS NULL\b/gi, '=== null')
      .replace(/\bIS NOT NULL\b/gi, '!== null')
      .replace(/(<>|!=)/g, '!==');  // Convert <> and != to !==

    // First, replace aggregate expressions: FN(args) → row['FN(args)']
    expr = expr.replace(/\b(count|sum|avg|min|max|first|last)\s*\(\s*([^)]*)\s*\)/gi, (match) => {
      return `row['${match}']`;
    });

    // Now replace simple column identifiers: bare words not followed by ( and not keywords
    // But exclude the string placeholder markers
    expr = expr.replace(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b(?!\s*\()/g, (_, id) => {
      const keywords = ['null', 'undefined', 'true', 'false', 'AND', 'OR', 'NOT', 'row'];
      // Skip placeholder markers (___STRING_\d+___)
      if (/^___STRING_\d+___$/.test(id)) return id;
      return keywords.includes(id.toUpperCase()) || keywords.includes(id) ? id : `row['${id}']`;
    });

    // Restore string literals
    expr = expr.replace(/___STRING_(\d+)___/g, (_, idx) => strings[parseInt(idx, 10)]);

    // eslint-disable-next-line no-new-func
    return new Function('row', `"use strict"; return (${expr});`) as (row: Record<string, any>) => boolean;
  } catch (e) {
    // If the WHERE clause is too complex, skip filtering
    return () => true;
  }
}

// ─── Aggregation helpers ─────────────────────────────────────────────────────

function isAggregateFunction(expr: string): boolean {
  const normalized = expr.toLowerCase().replace(/\s+/g, '');
  const aggregateFunctions = ['count(', 'sum(', 'avg(', 'min(', 'max(', 'first(', 'last('];
  return aggregateFunctions.some(fn => normalized.includes(fn));
}

function aggregateRows(rows: Record<string, any>[], expr: string): any {
  const s = expr.trim();
  const compact = s.toLowerCase().replace(/\s+/g, '');

  // COUNT(*)
  if (compact === 'count(*)') {
    return rows.length;
  }

  // COUNT(DISTINCT col)
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

  // Generic function pattern: fn(col)
  const fnMatch = compact.match(/^([a-z_][a-z0-9_]*)\(([^)]*)\)$/i);
  if (!fnMatch) {
    // Non-aggregate: return first value
    const trimmed = s.trim();
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) return rows[0]?.[trimmed];
    return undefined;
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
    case 'sum': {
      let sum = 0;
      for (const v of values) {
        if (Number.isFinite(v)) sum += v;
      }
      return sum;
    }
    case 'avg': {
      const good = values.filter(v => Number.isFinite(v));
      return good.length === 0 ? NaN : good.reduce((a, b) => a + b, 0) / good.length;
    }
    case 'min': {
      let m = Infinity;
      for (const v of values) {
        if (Number.isFinite(v) && v < m) m = v;
      }
      return m === Infinity ? NaN : m;
    }
    case 'max': {
      let m = -Infinity;
      for (const v of values) {
        if (Number.isFinite(v) && v > m) m = v;
      }
      return m === -Infinity ? NaN : m;
    }
    case 'first':
      return rows[0]?.[colName];
    case 'last':
      return rows[rows.length - 1]?.[colName];
    default:
      return rows[0]?.[colName];
  }
}

// ─── SQLExecutor ─────────────────────────────────────────────────────────────

export class SQLExecutor {
  private _tables = new Map<string, ColumnarTable>();

  registerTable(name: string, table: ColumnarTable): void {
    this._tables.set(name, table);
  }

  execute(parsed: ParsedSQL): QueryResult {
    if (parsed.type !== 'SELECT') {
      throw new Error(`Only SELECT is supported (got: ${parsed.type})`);
    }

    const { fields, from, distinct, where, groupBy, having, orderBy, limit, offset } = parsed.data;

    const table = this._tables.get(from);
    if (!table) {
      throw new Error(`Table not found: ${from}`);
    }

    let rows = [...table.getRows()];

    // WHERE
    if (where) {
      const pred = buildWherePredicate(where);
      rows = rows.filter(row => {
        try { return pred(row); } catch { return false; }
      });
    }

    // GROUP BY & HAVING
    if (groupBy && groupBy.length > 0) {
      rows = this.executeGroupBy(rows, fields, groupBy, having);
    } else if (fields.some(f => isAggregateFunction(f))) {
      // Aggregate without GROUP BY
      rows = this.executeAggregateWithoutGroupBy(rows, fields);
    }

    // SELECT projection (before DISTINCT to project fields)
    if (!fields.includes('*')) {
      rows = rows.map(row => {
        const out: Record<string, any> = {};
        for (const f of fields) {
          out[f] = row[f];
        }
        return out;
      });
    }

    // DISTINCT
    if (distinct) {
      rows = this.executeDistinct(rows);
    }

    // ORDER BY (support multiple columns)
    if (orderBy && orderBy.length > 0) {
      rows.sort((a, b) => {
        for (const spec of orderBy) {
          const av = a[spec.col];
          const bv = b[spec.col];
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          if (cmp !== 0) {
            return spec.direction === 'DESC' ? -cmp : cmp;
          }
        }
        return 0;
      });
    }

    // OFFSET
    if (offset && offset > 0) {
      rows = rows.slice(offset);
    }

    // LIMIT
    if (limit && limit > 0 && rows.length > limit) {
      rows = rows.slice(0, limit);
    }

    return { rows };
  }

  private executeGroupBy(
    rows: Record<string, any>[],
    fields: string[],
    groupByCols: string[],
    having?: string
  ): Record<string, any>[] {
    const groups = new Map<string, Record<string, any>[]>();

    // Group rows
    for (const row of rows) {
      const key = groupByCols.map(c => String(row[c] ?? '')).join('|');
      let arr = groups.get(key);
      if (!arr) { arr = []; groups.set(key, arr); }
      arr.push(row);
    }

    // Aggregate each group
    const result: Record<string, any>[] = [];
    for (const groupRows of groups.values()) {
      const aggregated: Record<string, any> = {};

      for (const field of fields) {
        if (isAggregateFunction(field)) {
          aggregated[field] = aggregateRows(groupRows, field);
        } else if (groupByCols.includes(field)) {
          aggregated[field] = groupRows[0][field];
        } else {
          // Non-aggregate, non-group column: use first value
          aggregated[field] = groupRows[0][field];
        }
      }

      result.push(aggregated);
    }

    // HAVING filter
    if (having) {
      const pred = buildWherePredicate(having);
      return result.filter(row => {
        try { return pred(row); } catch { return false; }
      });
    }

    return result;
  }

  private executeAggregateWithoutGroupBy(
    rows: Record<string, any>[],
    fields: string[]
  ): Record<string, any>[] {
    if (rows.length === 0) return [];

    const result: Record<string, any> = {};

    for (const field of fields) {
      if (isAggregateFunction(field)) {
        result[field] = aggregateRows(rows, field);
      } else {
        result[field] = rows[0][field];
      }
    }

    return [result];
  }

  private executeDistinct(rows: Record<string, any>[]): Record<string, any>[] {
    const seen = new Map<string, Record<string, any>>();
    for (const row of rows) {
      // Create a key that handles BigInt values
      const key = Object.entries(row)
        .map(([k, v]) => `${k}:${typeof v === 'bigint' ? `${v}n` : JSON.stringify(v)}`)
        .join('|');
      if (!seen.has(key)) {
        seen.set(key, row);
      }
    }
    return Array.from(seen.values());
  }
}
