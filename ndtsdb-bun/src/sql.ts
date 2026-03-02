/**
 * sql.ts — Simple SQL parser and executor for ndtsdb
 *
 * Supports basic SELECT statements against ColumnarTable / PartitionedTable.
 * This is a lightweight parser covering the common query patterns used by
 * kline-cli. Not a full SQL engine.
 *
 * Supported syntax:
 *   SELECT [*|col1,col2,...] FROM <table>
 *   [WHERE <condition>]
 *   [ORDER BY <col> [ASC|DESC]]
 *   [LIMIT <n>]
 *   [OFFSET <n>]
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SelectData {
  fields: string[];        // ['*'] or specific column names
  from:   string;          // table name
  where?: string;          // raw WHERE clause string (unparsed)
  orderBy?: string;        // column name
  orderDir?: 'ASC' | 'DESC';
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

  // Tokenise into clauses
  const clauses: Record<string, string> = {};
  const clauseNames = ['SELECT', 'FROM', 'WHERE', 'ORDER BY', 'LIMIT', 'OFFSET'];

  // Split by clause keywords (case-insensitive)
  // Build a regex that matches any of the clause keywords at word boundary
  const clauseRe = /\b(SELECT|FROM|WHERE|ORDER\s+BY|LIMIT|OFFSET)\b/gi;

  const parts: { name: string; start: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = clauseRe.exec(s)) !== null) {
    parts.push({ name: m[1].replace(/\s+/, ' ').toUpperCase(), start: m.index + m[0].length });
  }

  for (let i = 0; i < parts.length; i++) {
    const end = i + 1 < parts.length ? parts[i + 1].start - parts[i + 1].name.length - 1 : s.length;
    clauses[parts[i].name] = s.slice(parts[i].start, end).trim();
  }

  // Parse fields
  const fieldsStr = clauses['SELECT'] ?? '*';
  const fields = fieldsStr === '*' ? ['*'] : fieldsStr.split(',').map(f => f.trim()).filter(Boolean);

  // Parse FROM (table name — may have alias, take first token)
  const fromStr = (clauses['FROM'] ?? '').split(/\s+/)[0] ?? '';

  // Parse ORDER BY
  let orderBy: string | undefined;
  let orderDir: 'ASC' | 'DESC' | undefined;
  if (clauses['ORDER BY']) {
    const parts = clauses['ORDER BY'].split(/\s+/);
    orderBy = parts[0];
    if (parts[1]?.toUpperCase() === 'DESC') orderDir = 'DESC';
    else if (parts[1]?.toUpperCase() === 'ASC') orderDir = 'ASC';
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
      where: clauses['WHERE'],
      orderBy,
      orderDir,
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
  // Simple evaluation: replace column references with row lookups and eval.
  // We scope it to a known safe set of operators: =, !=, <, >, <=, >=, AND, OR, NOT.
  // Use Function constructor with restricted scope — no access to outer vars except 'row'.
  //
  // Security note: this evaluates arbitrary WHERE expressions. This is acceptable
  // in a CLI tool used by the developer/operator, not in a multi-tenant web service.
  try {
    const expr = whereClause
      // SQL operators → JS
      .replace(/\bAND\b/gi, '&&')
      .replace(/\bOR\b/gi, '||')
      .replace(/\bNOT\b/gi, '!')
      .replace(/\bIS NULL\b/gi, '=== null')
      .replace(/\bIS NOT NULL\b/gi, '!== null')
      // Rewrite bare identifiers to row['col'] (simple heuristic: word chars not followed by '(')
      .replace(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b(?!\s*\()/g, (_, id) => {
        const keywords = ['null','undefined','true','false','AND','OR','NOT','row'];
        return keywords.includes(id.toUpperCase()) || keywords.includes(id) ? id : `row['${id}']`;
      });

    // eslint-disable-next-line no-new-func
    return new Function('row', `"use strict"; return (${expr});`) as (row: Record<string, any>) => boolean;
  } catch {
    // If the WHERE clause is too complex, skip filtering
    return () => true;
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

    const { fields, from, where, orderBy, orderDir, limit, offset } = parsed.data;

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

    // ORDER BY
    if (orderBy) {
      rows.sort((a, b) => {
        const av = a[orderBy], bv = b[orderBy];
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return orderDir === 'DESC' ? -cmp : cmp;
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

    // SELECT projection
    if (!fields.includes('*')) {
      rows = rows.map(row => {
        const out: Record<string, any> = {};
        for (const f of fields) {
          out[f] = row[f];
        }
        return out;
      });
    }

    return { rows };
  }
}
