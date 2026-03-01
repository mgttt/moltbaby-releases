// ============================================================
// 时序查询扩展
// SAMPLE BY (时间桶聚合) + LATEST ON (最新值)
// ============================================================

type TypedNumericArray = Float64Array | Int32Array | Int16Array;

/**
 * SAMPLE BY — 时间桶聚合
 *
 * 等价 QuestDB:
 *   SELECT first(price), max(price), min(price), last(price), sum(volume)
 *   FROM trades
 *   SAMPLE BY 1m
 *
 * @param timestamps BigInt64Array 时间戳列 (已排序)
 * @param columns    要聚合的列 { name, data, aggs }
 * @param bucketMs   桶大小 (毫秒)
 * @returns          聚合结果数组
 */
export interface SampleByColumn {
  name: string;
  data: TypedNumericArray;
  aggs: AggType[];
}

export type AggType = 'first' | 'last' | 'min' | 'max' | 'sum' | 'count' | 'avg';

export interface SampleByResult {
  bucketStart: bigint;
  values: Record<string, number>;
}

export function sampleBy(
  timestamps: BigInt64Array,
  columns: SampleByColumn[],
  bucketMs: number,
): SampleByResult[] {
  if (timestamps.length === 0) return [];

  const results: SampleByResult[] = [];
  const n = timestamps.length;

  let bucketStart = timestamps[0] - (timestamps[0] % BigInt(bucketMs));
  let bucketEnd = bucketStart + BigInt(bucketMs);
  let rowStart = 0;

  for (let i = 0; i <= n; i++) {
    const ts = i < n ? timestamps[i] : BigInt(Number.MAX_SAFE_INTEGER);

    if (ts >= bucketEnd || i === n) {
      // 输出当前桶
      if (i > rowStart) {
        const row: Record<string, number> = {};

        for (const col of columns) {
          for (const agg of col.aggs) {
            const key = col.aggs.length > 1 ? `${col.name}_${agg}` : col.name;
            row[key] = aggregate(col.data, rowStart, i, agg);
          }
        }

        results.push({ bucketStart, values: row });
      }

      if (i >= n) break;

      // 新桶
      bucketStart = ts - (ts % BigInt(bucketMs));
      bucketEnd = bucketStart + BigInt(bucketMs);
      rowStart = i;
    }
  }

  return results;
}

function aggregate(data: TypedNumericArray, start: number, end: number, agg: AggType): number {
  if (start >= end) return 0;

  switch (agg) {
    case 'first': return data[start];
    case 'last':  return data[end - 1];
    case 'count': return end - start;
    case 'sum': {
      let s = 0;
      for (let i = start; i < end; i++) s += data[i];
      return s;
    }
    case 'avg': {
      let s = 0;
      for (let i = start; i < end; i++) s += data[i];
      return s / (end - start);
    }
    case 'min': {
      let m = data[start];
      for (let i = start + 1; i < end; i++) if (data[i] < m) m = data[i];
      return m;
    }
    case 'max': {
      let m = data[start];
      for (let i = start + 1; i < end; i++) if (data[i] > m) m = data[i];
      return m;
    }
  }
}

/**
 * OHLCV 快捷方法
 * 常用于 K 线生成
 */
export function ohlcv(
  timestamps: BigInt64Array,
  prices: Float64Array,
  volumes: Int32Array | Float64Array,
  bucketMs: number,
): Array<{
  time: bigint;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}> {
  const results = sampleBy(timestamps, [
    { name: 'price', data: prices, aggs: ['first', 'max', 'min', 'last'] },
    { name: 'volume', data: volumes, aggs: ['sum'] },
  ], bucketMs);

  return results.map(r => ({
    time: r.bucketStart,
    open: r.values.price_first,
    high: r.values.price_max,
    low: r.values.price_min,
    close: r.values.price_last,
    volume: r.values.volume,
  }));
}

/**
 * LATEST ON — 获取每个 symbol 的最新值
 *
 * 等价 QuestDB:
 *   SELECT * FROM trades LATEST ON timestamp PARTITION BY symbol
 *
 * @param symbolIds   Int32Array symbol 编码列
 * @param timestamps  BigInt64Array 时间戳列
 * @param columns     数据列
 * @returns           每个 symbol 的最新行
 */
export function latestOn(
  symbolIds: Int32Array,
  timestamps: BigInt64Array,
  columns: Map<string, TypedNumericArray>,
): Map<number, { timestamp: bigint; values: Record<string, number> }> {
  const result = new Map<number, { timestamp: bigint; values: Record<string, number> }>();
  const n = symbolIds.length;

  // 从后往前扫描 (利用时间排序)
  for (let i = n - 1; i >= 0; i--) {
    const sid = symbolIds[i];
    if (result.has(sid)) continue; // 已有更新的

    const values: Record<string, number> = {};
    for (const [name, data] of columns) {
      values[name] = data[i];
    }

    result.set(sid, { timestamp: timestamps[i], values });
  }

  return result;
}

/**
 * 窗口函数: 移动平均 (SMA)
 */
export function movingAverage(data: Float64Array, window: number): Float64Array {
  const n = data.length;
  const result = new Float64Array(n);

  if (n === 0 || window <= 0) return result;

  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += data[i];
    if (i >= window) sum -= data[i - window];
    result[i] = i >= window - 1 ? sum / window : sum / (i + 1);
  }

  return result;
}

/**
 * 窗口函数: 指数移动平均 (EMA)
 */
export function exponentialMovingAverage(data: Float64Array, period: number): Float64Array {
  const n = data.length;
  const result = new Float64Array(n);

  if (n === 0 || period <= 0) return result;

  const alpha = 2 / (period + 1);
  result[0] = data[0];

  for (let i = 1; i < n; i++) {
    result[i] = alpha * data[i] + (1 - alpha) * result[i - 1];
  }

  return result;
}

/**
 * 窗口函数: 滚动标准差
 */
export function rollingStdDev(data: Float64Array, window: number): Float64Array {
  const n = data.length;
  const result = new Float64Array(n);

  if (n === 0 || window <= 1) return result;

  for (let i = window - 1; i < n; i++) {
    let sum = 0, sumSq = 0;
    for (let j = i - window + 1; j <= i; j++) {
      sum += data[j];
      sumSq += data[j] * data[j];
    }
    const mean = sum / window;
    const variance = sumSq / window - mean * mean;
    result[i] = Math.sqrt(Math.max(0, variance));
  }

  return result;
}
