/**
 * ndts-db.ts — High-level NdtsDatabase class
 *
 * Wraps the raw FFI handle with a clean TypeScript API.
 */
import { mkdirSync } from 'fs';
import {
  ffi_open, ffi_close,
  ffi_insert, ffi_insert_batch, ffi_clear,
  ffi_query_all_json, ffi_list_symbols_json,
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

  insert(symbol: string, interval: string, row: KlineRow): boolean {
    return ffi_insert(this._ptr, symbol, interval, row);
  }

  insertBatch(symbol: string, interval: string, rows: KlineRow[]): number {
    return ffi_insert_batch(this._ptr, symbol, interval, rows);
  }

  clear(symbol: string, interval: string): boolean {
    return ffi_clear(this._ptr, symbol, interval);
  }

  // ── Query ────────────────────────────────────────────────────────────────

  /** Query all rows. Each row includes symbol and interval. */
  queryAll(): NDTSRow[] {
    const json = ffi_query_all_json(this._ptr);
    if (!json) return [];
    try {
      return parseQueryAllJson(json);
    } catch {
      return [];
    }
  }

  /** List all (symbol, interval) pairs stored in this database. */
  listSymbols(): SymbolInfo[] {
    const json = ffi_list_symbols_json(this._ptr);
    if (!json) return [];
    try {
      return parseListSymbolsJson(json);
    } catch {
      return [];
    }
  }

  /**
   * Get the latest (largest) timestamp for a given symbol/interval.
   * Returns -1n if no data exists.
   */
  getLatestTimestamp(symbol: string, interval: string): bigint {
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
