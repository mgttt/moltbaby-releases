// ============================================================
// MmapMergeStream - 扁平化时间桶归并流
// 预索引 + 顺序遍历 · libndts FFI 加速 · 467K+ snapshots/s
// ============================================================

import { MmapPool } from './pool.js';
import {
  isNdtsReady,
  int64ToF64,
  countingSortArgsort,
  gatherBatch4,
  findSnapshotBoundaries,
} from '../ndts-ffi.js';

// ─── Types ──────────────────────────────────────────────────

export interface ReplayTick {
  timestamp: bigint;
  symbol: string;
  price: number;
  volume: number;
}

export interface ReplaySnapshot {
  timestamp: bigint;
  /** 本时间戳变化的 symbol 数量 */
  changedCount: number;
  /** 变化的 symbol 索引数组 (长度 = changedCount) */
  changedSymbols: Int32Array;
  /** 所有 symbol 的最新价格 */
  prices: Float64Array;
  /** 所有 symbol 的最新成交量 */
  volumes: Int32Array;
}

export interface ReplayStats {
  totalTicks: number;
  uniqueTimestamps: number;
  elapsedMs: number;
  ticksPerSecond: number;
  symbolCount: number;
}

export interface ReplayConfig {
  symbols?: string[];
  columns?: string[];
  startTimestamp?: bigint;
  endTimestamp?: bigint;
}

// ─── MmapMergeStream ───────────────────────────────────────

export class MmapMergeStream {
  private pool: MmapPool;
  private symbols: string[] = [];
  private symbolToIndex: Map<string, number> = new Map();

  // 原始列数据
  private tsArrays: Float64Array[] = [];
  private priceArrays: Float64Array[] = [];
  private volumeArrays: Int32Array[] = [];

  // 扁平化索引（init 时构建）
  private totalTicks = 0;
  private snapshotCount = 0;
  private snapshotStarts: Int32Array = new Int32Array(0);
  private sortedTimestamps: Float64Array = new Float64Array(0);
  private sortedSymIdx: Int32Array = new Int32Array(0);
  private sortedPrices: Float64Array = new Float64Array(0);
  private sortedVolumes: Int32Array = new Int32Array(0);

  // 当前状态池
  private pricePool: Float64Array = new Float64Array(0);
  private volumePool: Int32Array = new Int32Array(0);
  private changedBuffer: Int32Array = new Int32Array(0);

  // 统计
  private _totalTicks = 0;
  private _uniqueTimestamps = 0;
  private initTimeMs = 0;

  constructor(pool: MmapPool) {
    this.pool = pool;
  }

  /**
   * 初始化归并流 — 构建扁平化时间桶索引
   */
  init(config: ReplayConfig = {}): void {
    const initStart = performance.now();

    this.symbols = config.symbols || this.pool.getSymbols();
    this.symbolToIndex.clear();
    for (let i = 0; i < this.symbols.length; i++) {
      this.symbolToIndex.set(this.symbols[i], i);
    }

    const symbolCount = this.symbols.length;

    const useFFI = isNdtsReady();

    // 1. 加载原始列数据 (FFI 加速 BigInt64→Float64)
    this.tsArrays = [];
    this.priceArrays = [];
    this.volumeArrays = [];

    let totalRows = 0;
    for (let i = 0; i < symbolCount; i++) {
      const sym = this.symbols[i];
      try {
        const ts = this.pool.getColumn<BigInt64Array>(sym, 'timestamp');
        const price = this.pool.getColumn<Float64Array>(sym, 'price');
        const volume = this.pool.getColumn<Int32Array>(sym, 'volume');

        // BigInt64 → Float64 转换 (FFI 加速)
        const tsNum = useFFI ? int64ToF64(ts) : (() => {
          const arr = new Float64Array(ts.length);
          for (let j = 0; j < ts.length; j++) arr[j] = Number(ts[j]);
          return arr;
        })();

        this.tsArrays.push(tsNum);
        this.priceArrays.push(price);
        this.volumeArrays.push(volume);
        totalRows += ts.length;
      } catch {
        this.tsArrays.push(new Float64Array(0));
        this.priceArrays.push(new Float64Array(0));
        this.volumeArrays.push(new Int32Array(0));
      }
    }

    this.totalTicks = totalRows;

    // 2. 收集所有 tick 数据
    const tickTs = new Float64Array(totalRows);
    const tickSym = new Int32Array(totalRows);
    const tickPrices = new Float64Array(totalRows);
    const tickVolumes = new Int32Array(totalRows);

    let idx = 0;
    for (let symIdx = 0; symIdx < symbolCount; symIdx++) {
      const ts = this.tsArrays[symIdx];
      const prices = this.priceArrays[symIdx];
      const volumes = this.volumeArrays[symIdx];
      for (let cursor = 0; cursor < ts.length; cursor++) {
        tickTs[idx] = ts[cursor];
        tickSym[idx] = symIdx;
        tickPrices[idx] = prices[cursor];
        tickVolumes[idx] = volumes[cursor];
        idx++;
      }
    }

    // 3. Counting Sort (FFI 加速)
    const sortedIndices = countingSortArgsort(tickTs);

    // 4. 应用范围过滤
    let startIdx = 0;
    let endIdx = totalRows;

    if (config.startTimestamp !== undefined) {
      const startNum = Number(config.startTimestamp);
      while (startIdx < totalRows && tickTs[sortedIndices[startIdx]] < startNum) {
        startIdx++;
      }
    }

    if (config.endTimestamp !== undefined) {
      const endNum = Number(config.endTimestamp);
      while (endIdx > startIdx && tickTs[sortedIndices[endIdx - 1]] > endNum) {
        endIdx--;
      }
    }

    const filteredCount = endIdx - startIdx;

    // 5. 构建扁平化数据结构 (FFI batch gather 加速)
    if (startIdx === 0 && endIdx === totalRows) {
      // 无过滤，直接使用 FFI
      const gathered = gatherBatch4(tickTs, tickSym, tickPrices, tickVolumes, sortedIndices);
      this.sortedTimestamps = gathered.ts;
      this.sortedSymIdx = gathered.sym;
      this.sortedPrices = gathered.prices;
      this.sortedVolumes = gathered.volumes;
    } else {
      // 有过滤，使用子数组
      const filteredIndices = sortedIndices.subarray(startIdx, endIdx);
      const gathered = gatherBatch4(tickTs, tickSym, tickPrices, tickVolumes, filteredIndices);
      this.sortedTimestamps = gathered.ts;
      this.sortedSymIdx = gathered.sym;
      this.sortedPrices = gathered.prices;
      this.sortedVolumes = gathered.volumes;
    }

    // 6. 找出 snapshot 边界 (FFI 加速)
    this.snapshotStarts = findSnapshotBoundaries(this.sortedTimestamps);
    this.snapshotCount = this.snapshotStarts.length - 1;

    // 7. 分配状态池
    this.pricePool = new Float64Array(symbolCount);
    this.volumePool = new Int32Array(symbolCount);
    this.changedBuffer = new Int32Array(symbolCount);

    // 统计
    this._totalTicks = filteredCount;
    this._uniqueTimestamps = this.snapshotCount;
    this.initTimeMs = performance.now() - initStart;
  }

  /**
   * Tick-level 回放
   */
  *replayTicks(): Generator<ReplayTick> {
    const symbols = this.symbols;
    const sortedSymIdx = this.sortedSymIdx;
    const sortedTimestamps = this.sortedTimestamps;
    const sortedPrices = this.sortedPrices;
    const sortedVolumes = this.sortedVolumes;
    const n = sortedSymIdx.length;

    for (let i = 0; i < n; i++) {
      yield {
        timestamp: BigInt(sortedTimestamps[i]),
        symbol: symbols[sortedSymIdx[i]],
        price: sortedPrices[i],
        volume: sortedVolumes[i],
      };
    }
  }

  /**
   * Snapshot 回放 — 每个时间戳 yield 一次
   */
  *replaySnapshots(): Generator<ReplaySnapshot> {
    const snapshotStarts = this.snapshotStarts;
    const snapshotCount = this.snapshotCount;
    const sortedSymIdx = this.sortedSymIdx;
    const sortedTimestamps = this.sortedTimestamps;
    const sortedPrices = this.sortedPrices;
    const sortedVolumes = this.sortedVolumes;
    const pricePool = this.pricePool;
    const volumePool = this.volumePool;
    const changedBuffer = this.changedBuffer;

    for (let s = 0; s < snapshotCount; s++) {
      const start = snapshotStarts[s];
      const end = snapshotStarts[s + 1];
      let changedCount = 0;

      for (let i = start; i < end; i++) {
        const symIdx = sortedSymIdx[i];
        pricePool[symIdx] = sortedPrices[i];
        volumePool[symIdx] = sortedVolumes[i];
        changedBuffer[changedCount++] = symIdx;
      }

      yield {
        timestamp: BigInt(sortedTimestamps[start]),
        changedCount,
        changedSymbols: changedBuffer,
        prices: pricePool,
        volumes: volumePool,
      };
    }
  }

  /**
   * ASOF JOIN 点查 — 查询某时间戳的完整快照
   */
  asofSnapshot(timestamp: bigint): { prices: Float64Array; volumes: Int32Array } {
    const targetNum = Number(timestamp);
    const snapshotStarts = this.snapshotStarts;
    const snapshotCount = this.snapshotCount;
    const sortedTimestamps = this.sortedTimestamps;
    const sortedSymIdx = this.sortedSymIdx;
    const sortedPrices = this.sortedPrices;
    const sortedVolumes = this.sortedVolumes;

    // 二分找到 <= target 的最后一个 snapshot
    let lo = 0, hi = snapshotCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const ts = sortedTimestamps[snapshotStarts[mid]];
      if (ts <= targetNum) lo = mid + 1;
      else hi = mid;
    }
    const snapIdx = lo - 1;

    // 应用该 snapshot 之前的所有更新
    const prices = new Float64Array(this.symbols.length);
    const volumes = new Int32Array(this.symbols.length);

    if (snapIdx >= 0) {
      const endTick = snapshotStarts[snapIdx + 1];
      for (let i = 0; i < endTick; i++) {
        const symIdx = sortedSymIdx[i];
        prices[symIdx] = sortedPrices[i];
        volumes[symIdx] = sortedVolumes[i];
      }
    }

    return { prices, volumes };
  }

  /**
   * Seek — 跳转到指定时间戳开始回放
   */
  *replaySnapshotsFrom(startTimestamp: bigint): Generator<ReplaySnapshot> {
    const targetNum = Number(startTimestamp);
    const snapshotStarts = this.snapshotStarts;
    const snapshotCount = this.snapshotCount;
    const sortedTimestamps = this.sortedTimestamps;
    const sortedSymIdx = this.sortedSymIdx;
    const sortedPrices = this.sortedPrices;
    const sortedVolumes = this.sortedVolumes;
    const pricePool = this.pricePool;
    const volumePool = this.volumePool;
    const changedBuffer = this.changedBuffer;

    // 二分找到 >= target 的第一个 snapshot
    let lo = 0, hi = snapshotCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const ts = sortedTimestamps[snapshotStarts[mid]];
      if (ts < targetNum) lo = mid + 1;
      else hi = mid;
    }
    const startSnapIdx = lo;

    // 先应用之前的状态
    if (startSnapIdx > 0) {
      const warmupEnd = snapshotStarts[startSnapIdx];
      for (let i = 0; i < warmupEnd; i++) {
        const symIdx = sortedSymIdx[i];
        pricePool[symIdx] = sortedPrices[i];
        volumePool[symIdx] = sortedVolumes[i];
      }
    }

    // 从目标位置开始回放
    for (let s = startSnapIdx; s < snapshotCount; s++) {
      const start = snapshotStarts[s];
      const end = snapshotStarts[s + 1];
      let changedCount = 0;

      for (let i = start; i < end; i++) {
        const symIdx = sortedSymIdx[i];
        pricePool[symIdx] = sortedPrices[i];
        volumePool[symIdx] = sortedVolumes[i];
        changedBuffer[changedCount++] = symIdx;
      }

      yield {
        timestamp: BigInt(sortedTimestamps[start]),
        changedCount,
        changedSymbols: changedBuffer,
        prices: pricePool,
        volumes: volumePool,
      };
    }
  }

  // ─── Getters ───────────────────────────────────────────

  getSymbols(): string[] {
    return this.symbols;
  }

  getSymbolIndex(symbol: string): number {
    return this.symbolToIndex.get(symbol) ?? -1;
  }

  getStats(): ReplayStats {
    return {
      totalTicks: this._totalTicks,
      uniqueTimestamps: this._uniqueTimestamps,
      elapsedMs: this.initTimeMs,
      ticksPerSecond: 0,
      symbolCount: this.symbols.length,
    };
  }

  getSnapshotCount(): number {
    return this.snapshotCount;
  }

  getTotalTicks(): number {
    return this.totalTicks;
  }

  getInitTimeMs(): number {
    return this.initTimeMs;
  }
}
