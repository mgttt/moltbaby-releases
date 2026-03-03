/**
 * append-ffi.ts — AppendWriter: per-file append + columnar read
 *
 * Designed for single-symbol time-series storage (e.g. bar cache files).
 * Uses "_" / "_" as internal symbol/interval when rows don't specify them.
 */
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { NdtsDatabase, openDatabase, type NDTSRow } from './ndts-db.ts';

export interface ColumnDef {
  name: string;
  type: 'int64' | 'float64' | 'string';
}

export interface ReadAllResult {
  data: Map<string, BigInt64Array | Float64Array | Int32Array>;
}

type AnyRow = Record<string, any>;

// Default internal symbol/interval for single-file AppendWriter usage
const DEFAULT_SYM = '_';
const DEFAULT_ITV = '_';

export class AppendWriter {
  private _path: string;
  private _columns: ColumnDef[];
  private _db: NdtsDatabase | null = null;

  constructor(path: string, columns: ColumnDef[]) {
    this._path = path;
    this._columns = columns;
  }

  open(): void {
    mkdirSync(dirname(this._path), { recursive: true });
    this._db = openDatabase(this._path);
  }

  append(rows: AnyRow[]): void {
    if (!rows.length) return;
    if (!this._db) this.open();

    // Group by symbol+interval (use defaults when not provided)
    const groups = new Map<string, {
      symbol: string;
      interval: string;
      klines: NDTSRow[];
    }>();

    for (const row of rows) {
      const symbol   = String(row.symbol   ?? DEFAULT_SYM);
      const interval = String(row.interval ?? DEFAULT_ITV);
      const key = `${symbol}\0${interval}`;

      if (!groups.has(key)) {
        groups.set(key, { symbol, interval, klines: [] });
      }

      const ts = typeof row.timestamp === 'bigint'
        ? row.timestamp
        : BigInt(Math.trunc(Number(row.timestamp ?? 0)));

      groups.get(key)!.klines.push({
        symbol, interval,
        timestamp: ts,
        open:   Number(row.open   ?? 0),
        high:   Number(row.high   ?? 0),
        low:    Number(row.low    ?? 0),
        close:  Number(row.close  ?? 0),
        volume: Number(row.volume ?? 0),
        quoteVolume: Number(row.quoteVolume ?? 0),
        trades: Number(row.trades ?? 0),
        takerBuyVolume: Number(row.takerBuyVolume ?? 0),
        takerBuyQuoteVolume: Number(row.takerBuyQuoteVolume ?? 0),
        flags:  0,
      });
    }

    for (const { symbol, interval, klines } of groups.values()) {
      this._db!.insertBatch(symbol, interval, klines);
    }
  }

  close(): void {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }

  /**
   * Read all rows from a database path and return as columnar typed arrays.
   *
   * Returns a Map with keys: 'timestamp' (BigInt64Array) and
   * 'open', 'high', 'low', 'close', 'volume', 'quoteVolume', 'takerBuyVolume',
   * 'takerBuyQuoteVolume' (Float64Array each), 'trades' (Int32Array).
   */
  static readAll(path: string): ReadAllResult {
    let db: NdtsDatabase;
    try {
      db = openDatabase(path);
    } catch {
      return { data: new Map() };
    }

    try {
      const rows = db.queryAll();
      const n = rows.length;

      if (n === 0) {
        return { data: new Map() };
      }

      const timestamps = new BigInt64Array(n);
      const opens      = new Float64Array(n);
      const highs      = new Float64Array(n);
      const lows       = new Float64Array(n);
      const closes     = new Float64Array(n);
      const volumes    = new Float64Array(n);
      const quoteVolumes = new Float64Array(n);
      const tradesArr    = new Int32Array(n);
      const takerBuyVolumes = new Float64Array(n);
      const takerBuyQuoteVolumes = new Float64Array(n);

      for (let i = 0; i < n; i++) {
        timestamps[i] = rows[i].timestamp;
        opens[i]      = rows[i].open;
        highs[i]      = rows[i].high;
        lows[i]       = rows[i].low;
        closes[i]     = rows[i].close;
        volumes[i]    = rows[i].volume;
        quoteVolumes[i] = rows[i].quoteVolume ?? 0;
        tradesArr[i] = rows[i].trades ?? 0;
        takerBuyVolumes[i] = rows[i].takerBuyVolume ?? 0;
        takerBuyQuoteVolumes[i] = rows[i].takerBuyQuoteVolume ?? 0;
      }

      const data = new Map<string, BigInt64Array | Float64Array | Int32Array>();
      data.set('timestamp', timestamps);
      data.set('open',      opens);
      data.set('high',      highs);
      data.set('low',       lows);
      data.set('close',     closes);
      data.set('volume',    volumes);
      data.set('quoteVolume', quoteVolumes);
      data.set('trades', tradesArr);
      data.set('takerBuyVolume', takerBuyVolumes);
      data.set('takerBuyQuoteVolume', takerBuyQuoteVolumes);

      return { data };
    } finally {
      db.close();
    }
  }
}
