// ============================================================
// 流式指标管理 - 实时指标计算
//
// 用于 WebSocket 行情回调，增量计算 SMA/EMA/StdDev 等指标
// ============================================================

import {
  StreamingAggregator,
  StreamingSMA,
  StreamingEMA,
  StreamingStdDev,
  StreamingMin,
  StreamingMax,
  StreamingRSI,
  StreamingMACD,
  StreamingBollingerBands,
} from 'ndtsdb';

/**
 * 指标配置
 */
export interface IndicatorConfig {
  sma?: number[];           // SMA 周期列表，如 [5, 10, 20]
  ema?: number[];           // EMA 周期列表
  stddev?: number[];        // 标准差周期列表
  min?: number[];           // 最小值周期列表
  max?: number[];           // 最大值周期列表
  rsi?: number[];           // RSI 周期列表，如 [14]
  macd?: {                  // MACD 配置
    fast?: number;          // 快线周期（默认 12）
    slow?: number;          // 慢线周期（默认 26）
    signal?: number;        // 信号线周期（默认 9）
  };
  bb?: {                    // 布林带配置
    period?: number;        // 周期（默认 20）
    stdDev?: number;        // 标准差倍数（默认 2）
  };
}

/**
 * 指标结果
 */
export interface IndicatorResult {
  symbol: string;
  timestamp: number;
  close: number;
  sma?: Record<string, number>;     // { 'sma5': 100.5, 'sma10': 101.2 }
  ema?: Record<string, number>;
  stddev?: Record<string, number>;
  min?: Record<string, number>;
  max?: Record<string, number>;
  rsi?: Record<string, number>;     // { 'rsi14': 65.3 }
  macd?: {                          // MACD 结果
    macd: number;
    signal: number;
    histogram: number;
  };
  bb?: {                            // 布林带结果
    upper: number;
    middle: number;
    lower: number;
    bandwidth?: number;             // (upper - lower) / middle
    percentB?: number;              // (close - lower) / (upper - lower)
  };
}

/**
 * 流式指标管理器
 * 
 * 用法：
 * ```typescript
 * const indicators = new StreamingIndicators();
 * 
 * // 添加 symbol 配置
 * indicators.addSymbol('BTC/USDT', {
 *   sma: [5, 10, 20],
 *   ema: [12, 26],
 *   stddev: [20],
 * });
 * 
 * // 实时更新
 * ws.on('kline', (data) => {
 *   const result = indicators.update(data.symbol, data.close, data.timestamp);
 *   console.log('SMA20:', result.sma?.sma20);
 * });
 * ```
 */
export class StreamingIndicators {
  private aggregators = new Map<string, StreamingAggregator>();
  private configs = new Map<string, IndicatorConfig>();
  private rsiCalculators = new Map<string, StreamingRSI>();
  private macdCalculators = new Map<string, StreamingMACD>();
  private bbCalculators = new Map<string, StreamingBollingerBands>();

  /**
   * 添加 symbol 配置
   */
  addSymbol(symbol: string, config: IndicatorConfig): void {
    if (this.aggregators.has(symbol)) {
      console.warn(`[StreamingIndicators] Symbol ${symbol} already exists, overwriting`);
    }

    const agg = new StreamingAggregator();

    // 添加 SMA
    if (config.sma) {
      for (const period of config.sma) {
        agg.addAggregator(`sma${period}`, new StreamingSMA(period));
      }
    }

    // 添加 EMA
    if (config.ema) {
      for (const period of config.ema) {
        agg.addAggregator(`ema${period}`, new StreamingEMA(period));
      }
    }

    // 添加 StdDev
    if (config.stddev) {
      for (const period of config.stddev) {
        agg.addAggregator(`stddev${period}`, new StreamingStdDev(period));
      }
    }

    // 添加 Min
    if (config.min) {
      for (const period of config.min) {
        agg.addAggregator(`min${period}`, new StreamingMin(period));
      }
    }

    // 添加 Max
    if (config.max) {
      for (const period of config.max) {
        agg.addAggregator(`max${period}`, new StreamingMax(period));
      }
    }

    // 添加 RSI（独立存储，非 SlidingWindowAggregator）
    if (config.rsi) {
      for (const period of config.rsi) {
        // RSI 使用独立 map 存储
      }
    }

    this.aggregators.set(symbol, agg);
    this.configs.set(symbol, config);

    // 初始化 RSI 计算器
    if (config.rsi) {
      for (const period of config.rsi) {
        this.rsiCalculators.set(`${symbol}_rsi${period}`, new StreamingRSI(period));
      }
    }

    // 初始化 MACD 计算器
    if (config.macd) {
      const { fast = 12, slow = 26, signal = 9 } = config.macd;
      this.macdCalculators.set(symbol, new StreamingMACD(fast, slow, signal));
    }

    // 初始化布林带计算器
    if (config.bb) {
      const { period = 20, stdDev = 2 } = config.bb;
      this.bbCalculators.set(symbol, new StreamingBollingerBands(period, stdDev));
    }
  }

  /**
   * 移除 symbol
   */
  removeSymbol(symbol: string): void {
    this.aggregators.delete(symbol);
    this.configs.delete(symbol);
    this.macdCalculators.delete(symbol);
    this.bbCalculators.delete(symbol);
    // 清理 RSI 计算器
    for (const key of this.rsiCalculators.keys()) {
      if (key.startsWith(`${symbol}_`)) {
        this.rsiCalculators.delete(key);
      }
    }
  }

  /**
   * 重置 symbol 的指标
   */
  resetSymbol(symbol: string): void {
    const agg = this.aggregators.get(symbol);
    if (agg) {
      agg.reset();
    }
    // 重置 RSI
    for (const [key, rsi] of this.rsiCalculators.entries()) {
      if (key.startsWith(`${symbol}_`)) {
        rsi.reset();
      }
    }
    // 重置 MACD
    this.macdCalculators.get(symbol)?.reset();
    // 重置 BB
    this.bbCalculators.get(symbol)?.reset();
  }

  /**
   * 更新指标（实时计算）
   * 
   * @param symbol 交易对
   * @param close 收盘价
   * @param timestamp 时间戳（可选）
   * @returns 指标结果
   */
  update(symbol: string, close: number, timestamp?: number): IndicatorResult {
    const agg = this.aggregators.get(symbol);
    if (!agg) {
      throw new Error(`[StreamingIndicators] Symbol ${symbol} not configured`);
    }

    const results = agg.add(close);
    const config = this.configs.get(symbol)!;

    // 构建结果
    const result: IndicatorResult = {
      symbol,
      timestamp: timestamp ?? Date.now(),
      close,
    };

    // 提取 SMA
    if (config.sma) {
      result.sma = {};
      for (const period of config.sma) {
        const key = `sma${period}`;
        result.sma[key] = results[key] ?? 0;
      }
    }

    // 提取 EMA
    if (config.ema) {
      result.ema = {};
      for (const period of config.ema) {
        const key = `ema${period}`;
        result.ema[key] = results[key] ?? 0;
      }
    }

    // 提取 StdDev
    if (config.stddev) {
      result.stddev = {};
      for (const period of config.stddev) {
        const key = `stddev${period}`;
        result.stddev[key] = results[key] ?? 0;
      }
    }

    // 提取 Min
    if (config.min) {
      result.min = {};
      for (const period of config.min) {
        const key = `min${period}`;
        result.min[key] = results[key] ?? 0;
      }
    }

    // 提取 Max
    if (config.max) {
      result.max = {};
      for (const period of config.max) {
        const key = `max${period}`;
        result.max[key] = results[key] ?? 0;
      }
    }

    // 提取 RSI
    if (config.rsi) {
      result.rsi = {};
      for (const period of config.rsi) {
        const rsiKey = `${symbol}_rsi${period}`;
        const rsiCalc = this.rsiCalculators.get(rsiKey);
        if (rsiCalc) {
          result.rsi[`rsi${period}`] = rsiCalc.add(close);
        }
      }
    }

    // 提取 MACD
    if (config.macd) {
      const macdCalc = this.macdCalculators.get(symbol);
      if (macdCalc) {
        result.macd = macdCalc.add(close);
      }
    }

    // 提取布林带
    if (config.bb) {
      const bbCalc = this.bbCalculators.get(symbol);
      if (bbCalc) {
        const bb = bbCalc.add(close);
        result.bb = {
          upper: bb.upper,
          middle: bb.middle,
          lower: bb.lower,
          bandwidth: (bb.upper - bb.lower) / bb.middle,
          percentB: (close - bb.lower) / (bb.upper - bb.lower),
        };
      }
    }

    return result;
  }

  /**
   * 批量更新（用于回填历史数据）
   * 
   * @param symbol 交易对
   * @param closes 收盘价数组
   * @returns 最后一个指标结果
   */
  batchUpdate(symbol: string, closes: number[]): IndicatorResult {
    let lastResult: IndicatorResult | null = null;

    for (let i = 0; i < closes.length; i++) {
      lastResult = this.update(symbol, closes[i]);
    }

    if (!lastResult) {
      throw new Error(`[StreamingIndicators] No data to update for ${symbol}`);
    }

    return lastResult;
  }

  /**
   * 获取当前状态
   */
  getStatus(): {
    totalSymbols: number;
    symbols: string[];
  } {
    return {
      totalSymbols: this.aggregators.size,
      symbols: Array.from(this.aggregators.keys()),
    };
  }

  /**
   * 获取 symbol 的配置
   */
  getConfig(symbol: string): IndicatorConfig | undefined {
    return this.configs.get(symbol);
  }
}
