/**
 * BarCacheLayer — ndtsdb-backed K线缓存层
 *
 * 职责：在 provider REST 层外包一层缓存，减少重复 API 调用。
 *
 * 设计约束：
 * - 不干预 WS tick 实时路径（实盘执行口径不经此层）
 * - DISABLE_BAR_CACHE=1 → bypass，直接回源（灰度/回滚开关）
 * - 仅用于历史 bar 查询（bridge_getKlines / 指标warmup）
 *
 * 存储布局：
 *   ~/.wp/cache/bars/{symbol}/{interval}.ndts
 *
 * TTL 策略（0.8×interval，防止与刷新周期同相）：
 *   1m → 48s | 5m → 240s | 1h → 2880s | 1d → 69120s
 */

import { createLogger } from '../utils/logger';
const logger = createLogger('BarCacheLayer');

import { env } from '../config/env';

import { AppendWriter } from '../../../ndtsdb/src/append.ts';
import { existsSync, mkdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

export interface Kline {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BarCacheStats {
  hits: number;
  misses: number;
  errors: number;
  apiCalls: number;
}

export interface BarCacheOptions {
  /** 缓存根目录，默认 ~/.wp/cache/bars */
  cacheDir?: string;
  /** 是否禁用缓存（等同 DISABLE_BAR_CACHE=1）*/
  disabled?: boolean;
  /** 日志函数 */
  logger?: (msg: string) => void;
}

const NDTS_COLS = [
  { name: 'timestamp', type: 'int64' },
  { name: 'open',      type: 'float64' },
  { name: 'high',      type: 'float64' },
  { name: 'low',       type: 'float64' },
  { name: 'close',     type: 'float64' },
  { name: 'volume',    type: 'float64' },
] as const;

/** interval → TTL（秒） */
const INTERVAL_SECS: Record<string, number> = {
  '1m':  60,   '3m':  180,  '5m':  300,
  '15m': 900,  '30m': 1800, '1h':  3600,
  '2h':  7200, '4h':  14400,'6h':  21600,
  '12h': 43200,'1d':  86400,'1w':  604800,
};

function intervalTtl(interval: string): number {
  const secs = INTERVAL_SECS[interval] ?? 60;
  return Math.floor(secs * 0.8);
}

export class BarCacheLayer {
  private cacheDir: string;
  private disabled: boolean;
  private log: (msg: string) => void;
  public stats: BarCacheStats = { hits: 0, misses: 0, errors: 0, apiCalls: 0 };

  constructor(opts: BarCacheOptions = {}) {
    this.cacheDir = opts.cacheDir ?? join(homedir(), '.wp', 'cache', 'bars');
    this.disabled = opts.disabled ?? env.DISABLE_BAR_CACHE;
    this.log = opts.logger ?? ((msg: string) => logger.info('[BarCache]', msg));
  }

  private filePath(symbol: string, interval: string): string {
    return join(this.cacheDir, symbol, `${interval}.ndts`);
  }

  /**
   * 读取缓存文件的写入时间（mtime），用于 TTL 新鲜度判断。
   * 同时返回最新 bar 的 timestamp（用于增量写入去重）。
   */
  private readCacheInfo(file: string): { mtimeSec: number; latestBarTs: number } {
    if (!existsSync(file)) return { mtimeSec: 0, latestBarTs: 0 };
    try {
      const mtime = Math.floor(statSync(file).mtimeMs / 1000);
      const { data } = AppendWriter.readAll(file);
      const ts = data.get('timestamp') as BigInt64Array | undefined;
      const latestBarTs = ts && ts.length > 0 ? Number(ts[ts.length - 1]) : 0;
      return { mtimeSec: mtime, latestBarTs };
    } catch {
      return { mtimeSec: 0, latestBarTs: 0 };
    }
  }

  /** 读取缓存所有bar（转为Kline[]）*/
  private readAll(file: string): Kline[] {
    const { data } = AppendWriter.readAll(file);
    const ts  = data.get('timestamp') as BigInt64Array;
    const o   = data.get('open')      as Float64Array;
    const h   = data.get('high')      as Float64Array;
    const l   = data.get('low')       as Float64Array;
    const c   = data.get('close')     as Float64Array;
    const v   = data.get('volume')    as Float64Array;
    const result: Kline[] = [];
    for (let i = 0; i < ts.length; i++) {
      result.push({ timestamp: Number(ts[i]), open: o[i], high: h[i], low: l[i], close: c[i], volume: v[i] });
    }
    return result;
  }

  /** 将 Kline[] 追加写入 ndtsdb（去重：仅写比latestTs新的bar）*/
  private writeNew(file: string, bars: Kline[], latestTs: number): number {
    const newBars = bars.filter(b => b.timestamp > latestTs);
    if (newBars.length === 0) return 0;

    mkdirSync(dirname(file), { recursive: true });
    const writer = new AppendWriter(file, NDTS_COLS as any);
    writer.open();
    writer.append(newBars.map(b => ({
      timestamp: BigInt(b.timestamp),
      open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
    })));
    // AppendWriter.close() is async, but we use sync pattern here
    void (writer as any).close?.();
    return newBars.length;
  }

  /**
   * 核心接口：获取最近 limit 条 bar
   * @param symbol   交易对（e.g. MYXUSDT）
   * @param interval K线周期（e.g. '1m'）
   * @param limit    返回条数
   * @param fetchFn  回源函数（缓存miss时调用）
   */
  async getBars(
    symbol: string,
    interval: string,
    limit: number,
    fetchFn: () => Promise<Kline[]>,
  ): Promise<{ bars: Kline[]; fromCache: boolean }> {
    // bypass模式
    if (this.disabled) {
      this.stats.apiCalls++;
      const bars = await fetchFn();
      return { bars: bars.slice(-limit), fromCache: false };
    }

    const file = this.filePath(symbol, interval);
    const ttl  = intervalTtl(interval);
    const nowSec = Math.floor(Date.now() / 1000);

    // 检查缓存TTL（基于文件mtime，非bar时间戳）
    const { mtimeSec, latestBarTs } = this.readCacheInfo(file);
    const age = nowSec - mtimeSec;

    if (mtimeSec > 0 && age < ttl) {
      // 缓存命中（文件在TTL内被写过）
      try {
        const cached = this.readAll(file);
        if (cached.length >= limit) {
          this.stats.hits++;
          this.log(`HIT ${symbol}/${interval} mtime_age=${age}s ttl=${ttl}s rows=${cached.length}`);
          return { bars: cached.slice(-limit), fromCache: true };
        }
        // 缓存行数不足，继续回源
        this.log(`HIT_INSUFFICIENT ${symbol}/${interval} cached=${cached.length} need=${limit}`);
      } catch (e) {
        this.stats.errors++;
        this.log(`READ_ERR ${file}: ${e}`);
      }
    }

    // 缓存miss → 回源
    this.stats.misses++;
    this.stats.apiCalls++;
    this.log(`MISS ${symbol}/${interval} mtime_age=${age}s ttl=${ttl}s → fetchFn`);

    let fresh: Kline[];
    try {
      fresh = await fetchFn();
    } catch (e) {
      this.stats.errors++;
      // 回源失败 → 降级返回旧缓存（如果有）
      if (existsSync(file)) {
        this.log(`FETCH_ERR fallback to stale cache: ${e}`);
        const stale = this.readAll(file);
        return { bars: stale.slice(-limit), fromCache: true };
      }
      throw e;
    }

    // 写入缓存（增量追加，去重：只写比latestBarTs更新的bar）
    try {
      const written = this.writeNew(file, fresh, latestBarTs);
      this.log(`BACKFILL ${symbol}/${interval} +${written}bars`);
    } catch (e) {
      this.stats.errors++;
      this.log(`WRITE_ERR (non-fatal): ${e}`);
    }

    return { bars: fresh.slice(-limit), fromCache: false };
  }

  /** 获取缓存统计（用于心跳日志） */
  getStats(): BarCacheStats & { hitRate: string } {
    const total = this.stats.hits + this.stats.misses;
    const hr = total > 0 ? (this.stats.hits / total * 100).toFixed(1) + '%' : 'N/A';
    return { ...this.stats, hitRate: hr };
  }
}
