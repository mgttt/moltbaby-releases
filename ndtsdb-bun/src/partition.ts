/**
 * partition.ts — PartitionedTable: multi-symbol, time-partitioned storage
 *
 * Wraps NdtsDatabase (which handles YYYY-MM-DD.ndts partitioning internally)
 * with a higher-level interface supporting per-symbol/interval append and
 * filtered queries.
 */
import { mkdirSync } from 'fs';
import { openDatabase, type NDTSRow } from './ndts-db.ts';
import type { KlineRow } from './ndts-db-ffi.ts';

export interface ColumnDef {
  name: string;
  type: 'int64' | 'float64' | 'string';
}

export interface TimePartitionStrategy {
  type: 'time';
  column: string;
  /** 'day' | 'hour' | 'month' — or use bucketSize (seconds) */
  interval?: 'day' | 'hour' | 'month';
  /** Alternative: bucket size in seconds (e.g. 86400 = 1 day) */
  bucketSize?: number;
}

export type PartitionStrategy = TimePartitionStrategy;

export interface TimeRange {
  min: bigint;
  max: bigint;
}

export interface QueryOptions {
  timeRange?: TimeRange;
  limit?: number;
}

type AnyRow = Record<string, any>;

export class PartitionedTable {
  private _basePath: string;
  private _columns: ColumnDef[];
  private _strategy: PartitionStrategy;

  constructor(basePath: string, columns: ColumnDef[], strategy: PartitionStrategy) {
    this._basePath = basePath;
    this._columns  = columns;
    this._strategy = strategy;
    mkdirSync(basePath, { recursive: true });
  }

  /**
   * Append rows to the table. Each row may include 'symbol' and 'interval'
   * fields; if absent, defaults to '_' / '_'.
   * Opens the database, inserts, and closes (flushes to disk) atomically.
   */
  append(rows: AnyRow[]): void {
    if (!rows.length) return;

    const db = openDatabase(this._basePath);
    try {
      // Group by symbol+interval
      const groups = new Map<string, { symbol: string; interval: string; klines: KlineRow[] }>();

      for (const row of rows) {
        const symbol   = String(row.symbol   ?? '_');
        const interval = String(row.interval ?? '_');
        const key = `${symbol}\0${interval}`;

        if (!groups.has(key)) {
          groups.set(key, { symbol, interval, klines: [] });
        }

        const ts = typeof row.timestamp === 'bigint'
          ? row.timestamp
          : BigInt(Math.trunc(Number(row.timestamp ?? 0)));

        groups.get(key)!.klines.push({
          timestamp: ts,
          open:   Number(row.open   ?? 0),
          high:   Number(row.high   ?? 0),
          low:    Number(row.low    ?? 0),
          close:  Number(row.close  ?? 0),
          volume: Number(row.volume ?? 0),
          flags:  0,
        });
      }

      for (const { symbol, interval, klines } of groups.values()) {
        db.insertBatch(symbol, interval, klines);
      }
    } finally {
      db.close();
    }
  }

  /**
   * Query rows with optional filter function and time range.
   *
   * Opens the database, reads all rows, applies filters, closes.
   *
   * @param filterFn  Optional predicate run on each row. Return true to keep.
   * @param options   Optional time range and row limit.
   */
  query(filterFn?: (row: AnyRow) => boolean, options?: QueryOptions): AnyRow[] {
    const db = openDatabase(this._basePath);
    try {
      let rows: NDTSRow[] = db.queryAll();

      // Apply time range filter
      if (options?.timeRange) {
        const { min, max } = options.timeRange;
        rows = rows.filter(r => r.timestamp >= min && r.timestamp <= max);
      }

      // Convert NDTSRow → plain AnyRow (bigint timestamp → number for compat)
      let result: AnyRow[] = rows.map(r => ({
        symbol:    r.symbol,
        interval:  r.interval,
        timestamp: r.timestamp,    // keep as bigint
        open:      r.open,
        high:      r.high,
        low:       r.low,
        close:     r.close,
        volume:    r.volume,
        flags:     r.flags,
      }));

      // Apply caller's filter function
      if (filterFn) {
        result = result.filter(filterFn);
      }

      // Apply limit
      if (options?.limit && result.length > options.limit) {
        result = result.slice(0, options.limit);
      }

      return result;
    } finally {
      db.close();
    }
  }

  get basePath(): string { return this._basePath; }
}
