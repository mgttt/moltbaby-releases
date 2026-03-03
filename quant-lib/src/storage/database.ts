// ============================================================
// ndtsdb 数据库管理 - 直接使用 NdtsDatabase FFI（C 库）
//
// 架构：直接调用 ndtsdb-bun 的 NdtsDatabase，以真实 symbol 名存储
// 之前用 PartitionedTable 的方式会以 bucket-N 为 symbol 名存储，导致无法按 symbol 查询
// ============================================================

import { openDatabase } from 'ndtsdb';
import type { KlineRow, NdtsDatabase } from 'ndtsdb';
import type { Kline } from '../types/kline';
import type { DatabaseConfig } from '../types/common';
import { existsSync, mkdirSync } from 'fs';

export class KlineDatabase {
  private dataDir: string;
  private config: DatabaseConfig;
  private db: NdtsDatabase | null = null;

  constructor(config: DatabaseConfig | string = `${process.env.HOME}/.quant-lib/data/ndtsdb`) {
    if (typeof config === 'string') {
      this.config = {
        path: config,
        accessMode: 'READ_WRITE',
        autoInit: true
      };
      this.dataDir = config;
    } else {
      this.config = {
        accessMode: 'READ_WRITE',
        autoInit: true,
        ...config
      };
      this.dataDir = config.path || `${process.env.HOME}/.quant-lib/data/ndtsdb`;
    }

    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
  }

  /**
   * 初始化数据库
   */
  async init(): Promise<void> {
    this.db = openDatabase(this.dataDir);
    console.log('[KlineDatabase] 初始化完成:', this.dataDir);
  }

  /**
   * 兼容旧接口
   */
  async connect(): Promise<void> {
    return this.init();
  }

  /**
   * 关闭数据库
   */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * 插入 K线数据（按 symbol+interval 分组批量写入）
   */
  async insertKlines(klines: Kline[]): Promise<void> {
    if (!this.db) throw new Error('Database not initialized. Call init() first.');
    if (klines.length === 0) return;

    // 按 (symbol, interval) 分组
    const groups = new Map<string, { symbol: string; interval: string; rows: KlineRow[] }>();
    for (const k of klines) {
      const key = `${k.symbol}:${k.interval}`;
      if (!groups.has(key)) {
        groups.set(key, { symbol: k.symbol, interval: k.interval, rows: [] });
      }
      groups.get(key)!.rows.push({
        timestamp: BigInt(k.timestamp), // 保持调用方的单位（通常 ms），持久化到底层需 bigint
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volume,
        flags: 0,
      });
    }

    for (const { symbol, interval, rows } of groups.values()) {
      this.db.insertBatch(symbol, interval, rows);
    }
  }

  /**
   * UPSERT K线数据（去重，只写入比最新时间戳更新的数据）
   */
  async upsertKlines(klines: Kline[]): Promise<void> {
    if (klines.length === 0) return;

    // 按 (symbol, interval) 分组
    const groups = new Map<string, Kline[]>();
    for (const k of klines) {
      const key = `${k.symbol}:${k.interval}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(k);
    }

    for (const [key, group] of groups) {
      const colonIdx = key.indexOf(':');
      const symbol = key.slice(0, colonIdx);
      const interval = key.slice(colonIdx + 1);

      const sorted = group.slice().sort((a, b) => a.timestamp - b.timestamp);
      const latest = await this.getLatestTimestamp(symbol, interval);
      const toInsert = latest == null ? sorted : sorted.filter(k => k.timestamp > latest);

      if (toInsert.length > 0) {
        await this.insertKlines(toInsert);
      }
    }
  }

  /**
   * 获取最新 timestamp（直接调用 C 层索引，O(1)）
   */
  async getLatestTimestamp(symbol: string, interval: string): Promise<number | null> {
    if (!this.db) return null;
    const ts = this.db.getLatestTimestamp(symbol, interval);
    return ts === -1n ? null : Number(ts);
  }

  /**
   * 别名
   */
  async getMaxTimestamp(symbol: string, interval: string): Promise<number | null> {
    return this.getLatestTimestamp(symbol, interval);
  }

  /**
   * 获取最新一根 K线
   */
  async getLatestKline(symbol: string, interval: string): Promise<Kline | null> {
    if (!this.db) return null;

    const maxTs = await this.getLatestTimestamp(symbol, interval);
    if (maxTs === null) return null;

    const rows = this.db.queryAll();
    const r = rows.find(r =>
      r.symbol === symbol && r.interval === interval && Number(r.timestamp) === maxTs
    );
    return r ? rowToKline(r, symbol, interval) : null;
  }

  /**
   * 查询 K线数据
   */
  async queryKlines(options: {
    symbol: string;
    interval: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
  }): Promise<Kline[]> {
    if (!this.db) throw new Error('Database not initialized. Call init() first.');

    const rows = this.db.queryAll();
    let filtered = rows.filter(r => {
      if (r.symbol !== options.symbol || r.interval !== options.interval) return false;
      const ts = Number(r.timestamp); // Convert BigInt to number for comparison
      if (options.startTime != null && ts < options.startTime) return false;
      if (options.endTime != null && ts > options.endTime) return false;
      return true;
    });

    // Sort by timestamp (convert BigInt to number for comparison)
    filtered.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));

    if (options.limit) filtered = filtered.slice(0, options.limit);

    return filtered.map(r => rowToKline(r, options.symbol, options.interval));
  }

  /**
   * 获取数据库统计
   */
  async getStats(): Promise<{
    totalSymbols: number;
    totalBars: number;
    symbols: string[];
    intervals: string[];
  }> {
    if (!this.db) return { totalSymbols: 0, totalBars: 0, symbols: [], intervals: [] };

    const rows = this.db.queryAll();
    const symbols = new Set(rows.map(r => r.symbol || ''));
    const intervals = new Set(rows.map(r => r.interval || ''));

    return {
      totalSymbols: symbols.size,
      totalBars: rows.length,
      symbols: [...symbols].filter(Boolean),
      intervals: [...intervals].filter(Boolean),
    };
  }
}

function rowToKline(r: KlineRow, symbol: string, interval: string): Kline {
  const parts = symbol.split('/');
  const baseCurrency = parts[0] || symbol;
  const quoteCurrency = parts[1] || 'USDT';
  return {
    symbol,
    exchange: 'OTHER',
    baseCurrency,
    quoteCurrency,
    interval,
    timestamp: Number(r.timestamp), // Convert BigInt to number
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
    quoteVolume: 0,
    trades: 0,
    takerBuyVolume: 0,
    takerBuyQuoteVolume: 0,
  } as any;
}
