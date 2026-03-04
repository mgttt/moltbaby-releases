/**
 * ndts-db.ts — High-level NdtsDatabase class
 *
 * Wraps the raw FFI handle with a clean TypeScript API.
 */
import { mkdirSync } from 'fs';
import {
  ffi_open, ffi_open_any, ffi_close,
  ffi_insert, ffi_insert_batch, ffi_clear,
  ffi_query_all_json, ffi_list_symbols_json,
  ffi_query_all_binary, parseQueryAllBinary,
  ffi_get_latest_timestamp, ffi_get_path,
  type KlineRow, type NDTSRow,
} from './ndts-db-ffi.ts';

export type { KlineRow, NDTSRow };

export interface SymbolInfo {
  symbol: string;
  interval: string;
}

// ─── JSON parse helpers ──────────────────────────────────────────────────────

function parseQueryAllJson(json: string): NDTSRow[] {
  const parsed = JSON.parse(json) as { rows: any[]; count: number };
  if (!parsed.rows || !Array.isArray(parsed.rows)) return [];
  return parsed.rows.map(r => ({
    symbol:    String(r.symbol ?? ''),
    interval:  String(r.interval ?? ''),
    timestamp: BigInt(r.timestamp),
    open:      Number(r.open),
    high:      Number(r.high),
    low:       Number(r.low),
    close:     Number(r.close),
    volume:    Number(r.volume),
    quoteVolume: Number(r.quoteVolume ?? 0),
    trades:    Number(r.trades ?? 0),
    takerBuyVolume: Number(r.takerBuyVolume ?? 0),
    takerBuyQuoteVolume: Number(r.takerBuyQuoteVolume ?? 0),
    flags:     Number(r.flags ?? 0),
  }));
}

function parseListSymbolsJson(json: string): SymbolInfo[] {
  const arr = JSON.parse(json);
  if (!Array.isArray(arr)) return [];
  return arr.map(e => ({ symbol: String(e.symbol), interval: String(e.interval) }));
}

// ─── NdtsDatabase class ──────────────────────────────────────────────────────

export class NdtsDatabase {
  private _ptr: number;
  private _path: string;

  constructor(path: string) {
    mkdirSync(path, { recursive: true });
    this._path = path;
    this._ptr = ffi_open(path);
  }

  // ── Write ────────────────────────────────────────────────────────────────

  private _assertOpen(): void {
    if (!this._ptr) throw new Error('NdtsDatabase is already closed');
  }

  insert(symbol: string, interval: string, row: KlineRow): boolean {
    this._assertOpen();
    return ffi_insert(this._ptr, symbol, interval, row);
  }

  insertBatch(symbol: string, interval: string, rows: KlineRow[]): number {
    this._assertOpen();
    return ffi_insert_batch(this._ptr, symbol, interval, rows);
  }

  clear(symbol: string, interval: string): boolean {
    this._assertOpen();
    return ffi_clear(this._ptr, symbol, interval);
  }

  // ── Query ────────────────────────────────────────────────────────────────

  /** Query all rows, sorted by timestamp ascending. Each row includes symbol and interval. */
  queryAll(): NDTSRow[] {
    this._assertOpen();

    // Phase 2: Use binary API for better performance (avoids JSON serialization)
    const result = ffi_query_all_binary(this._ptr);
    if (!result) return [];

    try {
      const rows = parseQueryAllBinary(result);
      rows.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
      return rows;
    } catch (e) {
      // Log instead of silently swallowing — binary parse error should be visible
      console.error('[ndtsdb] queryAll binary parse error:', e instanceof Error ? e.message : e);
      return [];
    }
  }

  /** List all (symbol, interval) pairs stored in this database. */
  listSymbols(): SymbolInfo[] {
    this._assertOpen();
    const json = ffi_list_symbols_json(this._ptr);
    if (!json) return [];
    try {
      return parseListSymbolsJson(json);
    } catch (e) {
      console.error('[ndtsdb] listSymbols parse error:', e instanceof Error ? e.message : e);
      return [];
    }
  }

  /**
   * Get the latest (largest) timestamp for a given symbol/interval.
   * Returns -1n if no data exists.
   */
  getLatestTimestamp(symbol: string, interval: string): bigint {
    this._assertOpen();
    return ffi_get_latest_timestamp(this._ptr, symbol, interval);
  }

  // ── Meta ─────────────────────────────────────────────────────────────────

  get path(): string { return this._path; }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  close(): void {
    if (this._ptr) {
      ffi_close(this._ptr);
      this._ptr = 0;
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

/** Open a database at the given directory path. Close with db.close(). */
export function openDatabase(path: string): NdtsDatabase {
  return new NdtsDatabase(path);
}

/**
 * openDatabaseAny — Open database with automatic format detection (snapshot/read-only mode)
 *
 * Supports:
 * - Single file: Auto-detect Magic ("NDTS" vs "NDTB") and use appropriate parser
 * - Directory: Recursively load all .ndts and .ndtb files (mixed format support)
 *
 * Returns a snapshot database handle. Use db.close() when done.
 *
 * @example
 * // Single .ndts file
 * const db = openDatabaseAny("data.ndts");
 *
 * // Single .ndtb file
 * const db = openDatabaseAny("data.ndtb");
 *
 * // Mixed format directory
 * const db = openDatabaseAny("data/");  // loads both .ndts and .ndtb files
 */
export function openDatabaseAny(path: string): NdtsDatabase {
  // Create a new database object that uses ffi_open_any instead of ffi_open
  const db = Object.create(NdtsDatabase.prototype);
  db._ptr = ffi_open_any(path);
  db._path = path;
  return db;
}
