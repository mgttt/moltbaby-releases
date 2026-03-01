// ============================================================
// 流式聚合 - 增量窗口计算
// ============================================================

/**
 * 滑动窗口聚合器（基类）
 */
export abstract class SlidingWindowAggregator {
  protected window: number[] = [];
  protected windowSize: number;

  constructor(windowSize: number) {
    this.windowSize = windowSize;
  }

  /**
   * 添加新值并返回聚合结果
   */
  add(value: number): number {
    this.window.push(value);
    if (this.window.length > this.windowSize) {
      this.window.shift();
    }
    return this.compute();
  }

  /**
   * 重置窗口
   */
  reset(): void {
    this.window = [];
  }

  /**
   * 获取当前窗口大小
   */
  getWindowLength(): number {
    return this.window.length;
  }

  /**
   * 计算聚合值（子类实现）
   */
  protected abstract compute(): number;
}

/**
 * 滑动平均（SMA）
 */
export class StreamingSMA extends SlidingWindowAggregator {
  protected compute(): number {
    if (this.window.length === 0) return 0;
    const sum = this.window.reduce((a, b) => a + b, 0);
    return sum / this.window.length;
  }
}

/**
 * 指数移动平均（EMA）
 */
export class StreamingEMA {
  private alpha: number;
  private ema: number | null = null;

  constructor(period: number) {
    this.alpha = 2 / (period + 1);
  }

  add(value: number): number {
    if (this.ema === null) {
      this.ema = value;
    } else {
      this.ema = this.alpha * value + (1 - this.alpha) * this.ema;
    }
    return this.ema;
  }

  reset(): void {
    this.ema = null;
  }

  getValue(): number | null {
    return this.ema;
  }
}

/**
 * 滑动标准差
 */
export class StreamingStdDev extends SlidingWindowAggregator {
  protected compute(): number {
    if (this.window.length < 2) return 0;

    const mean = this.window.reduce((a, b) => a + b, 0) / this.window.length;
    const variance = this.window.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / this.window.length;
    return Math.sqrt(variance);
  }
}

/**
 * 滑动最小值
 */
export class StreamingMin extends SlidingWindowAggregator {
  protected compute(): number {
    if (this.window.length === 0) return 0;
    return Math.min(...this.window);
  }
}

/**
 * 滑动最大值
 */
export class StreamingMax extends SlidingWindowAggregator {
  protected compute(): number {
    if (this.window.length === 0) return 0;
    return Math.max(...this.window);
  }
}

/**
 * 流式 RSI（Relative Strength Index）
 * 使用 Wilder's smoothing
 */
export class StreamingRSI {
  private period: number;
  private gains: number[] = [];
  private losses: number[] = [];
  private avgGain: number | null = null;
  private avgLoss: number | null = null;
  private prevValue: number | null = null;
  private count = 0;

  constructor(period: number) {
    this.period = period;
  }

  add(value: number): number {
    this.count++;

    // 第一个值无法计算变化
    if (this.prevValue === null) {
      this.prevValue = value;
      return 0; // 初始值返回0（未成熟）
    }

    const change = value - this.prevValue;
    this.prevValue = value;

    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    // 累积期：收集前 period 个变化
    if (this.count <= this.period + 1) {
      this.gains.push(gain);
      this.losses.push(loss);

      // 第一个 RSI 计算点
      if (this.count === this.period + 1) {
        this.avgGain = this.gains.reduce((a, b) => a + b, 0) / this.period;
        this.avgLoss = this.losses.reduce((a, b) => a + b, 0) / this.period;
        return this.calculateRSI();
      }
      return 0;
    }

    // Wilder's smoothing
    this.avgGain = (this.avgGain! * (this.period - 1) + gain) / this.period;
    this.avgLoss = (this.avgLoss! * (this.period - 1) + loss) / this.period;

    return this.calculateRSI();
  }

  private calculateRSI(): number {
    if (this.avgLoss === 0) return 100;
    const rs = this.avgGain! / this.avgLoss;
    return 100 - 100 / (1 + rs);
  }

  reset(): void {
    this.gains = [];
    this.losses = [];
    this.avgGain = null;
    this.avgLoss = null;
    this.prevValue = null;
    this.count = 0;
  }

  getValue(): number | null {
    if (this.avgGain === null || this.avgLoss === null) return null;
    return this.calculateRSI();
  }
}

/**
 * 流式 MACD（Moving Average Convergence Divergence）
 * 与批量计算保持一致：EMA初始值 = 前period个值的SMA
 */
export class StreamingMACD {
  private fastPeriod: number;
  private slowPeriod: number;
  private signalPeriod: number;
  private fastValues: number[] = [];
  private slowValues: number[] = [];
  private signalValues: number[] = [];
  private fastEMA: number | null = null;
  private slowEMA: number | null = null;
  private signalEMA: number | null = null;
  private macdLine: number | null = null;
  private alphaFast: number;
  private alphaSlow: number;
  private alphaSignal: number;

  constructor(fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    this.fastPeriod = fastPeriod;
    this.slowPeriod = slowPeriod;
    this.signalPeriod = signalPeriod;
    this.alphaFast = 2 / (fastPeriod + 1);
    this.alphaSlow = 2 / (slowPeriod + 1);
    this.alphaSignal = 2 / (signalPeriod + 1);
  }

  add(value: number): { macd: number; signal: number; histogram: number } {
    // 收集初始值
    this.fastValues.push(value);
    this.slowValues.push(value);

    // 初始化 Fast EMA（用前 fastPeriod 个值的 SMA）
    if (this.fastEMA === null) {
      if (this.fastValues.length >= this.fastPeriod) {
        const sum = this.fastValues.slice(0, this.fastPeriod).reduce((a, b) => a + b, 0);
        this.fastEMA = sum / this.fastPeriod;
      }
    } else {
      this.fastEMA = this.alphaFast * value + (1 - this.alphaFast) * this.fastEMA;
    }

    // 初始化 Slow EMA（用前 slowPeriod 个值的 SMA）
    if (this.slowEMA === null) {
      if (this.slowValues.length >= this.slowPeriod) {
        const sum = this.slowValues.slice(0, this.slowPeriod).reduce((a, b) => a + b, 0);
        this.slowEMA = sum / this.slowPeriod;
      }
    } else {
      this.slowEMA = this.alphaSlow * value + (1 - this.alphaSlow) * this.slowEMA;
    }

    // 必须有 fastEMA 和 slowEMA 才能计算 MACD
    if (this.fastEMA === null || this.slowEMA === null) {
      return { macd: 0, signal: 0, histogram: 0 };
    }

    // MACD 线 = 快线 - 慢线
    this.macdLine = this.fastEMA - this.slowEMA;
    this.signalValues.push(this.macdLine);

    // 初始化 Signal EMA（用前 signalPeriod 个 MACD 值的 SMA）
    if (this.signalEMA === null) {
      if (this.signalValues.length >= this.signalPeriod) {
        const sum = this.signalValues.slice(0, this.signalPeriod).reduce((a, b) => a + b, 0);
        this.signalEMA = sum / this.signalPeriod;
      }
    } else {
      this.signalEMA = this.alphaSignal * this.macdLine + (1 - this.alphaSignal) * this.signalEMA;
    }

    // 信号线必须有值才能计算 histogram
    if (this.signalEMA === null) {
      return { macd: this.macdLine, signal: 0, histogram: 0 };
    }

    // 柱状图
    const histogram = this.macdLine - this.signalEMA;

    return { macd: this.macdLine, signal: this.signalEMA, histogram };
  }

  reset(): void {
    this.fastValues = [];
    this.slowValues = [];
    this.signalValues = [];
    this.fastEMA = null;
    this.slowEMA = null;
    this.signalEMA = null;
    this.macdLine = null;
  }

  getValue(): { macd: number | null; signal: number | null; histogram: number | null } {
    return {
      macd: this.macdLine,
      signal: this.signalEMA,
      histogram: this.macdLine !== null && this.signalEMA !== null
        ? this.macdLine - this.signalEMA
        : null,
    };
  }
}

/**
 * 流式布林带（Bollinger Bands）
 */
export class StreamingBollingerBands {
  private period: number;
  private stdDevMultiplier: number;
  private window: number[] = [];

  constructor(period = 20, stdDevMultiplier = 2) {
    this.period = period;
    this.stdDevMultiplier = stdDevMultiplier;
  }

  add(value: number): { upper: number; middle: number; lower: number } {
    this.window.push(value);
    if (this.window.length > this.period) {
      this.window.shift();
    }

    // 计算中轨（SMA）
    const middle = this.window.reduce((a, b) => a + b, 0) / this.window.length;

    // 计算标准差
    const variance = this.window.reduce((sum, x) => sum + Math.pow(x - middle, 2), 0) / this.window.length;
    const stdDev = Math.sqrt(variance);

    // 上下轨
    const upper = middle + this.stdDevMultiplier * stdDev;
    const lower = middle - this.stdDevMultiplier * stdDev;

    return { upper, middle, lower };
  }

  reset(): void {
    this.window = [];
  }

  getValue(): { upper: number | null; middle: number | null; lower: number | null } {
    if (this.window.length === 0) {
      return { upper: null, middle: null, lower: null };
    }
    const middle = this.window.reduce((a, b) => a + b, 0) / this.window.length;
    const variance = this.window.reduce((sum, x) => sum + Math.pow(x - middle, 2), 0) / this.window.length;
    const stdDev = Math.sqrt(variance);
    return {
      upper: middle + this.stdDevMultiplier * stdDev,
      middle,
      lower: middle - this.stdDevMultiplier * stdDev,
    };
  }
}

/**
 * 多指标流式计算器（组合多个聚合器）
 */
export class StreamingAggregator {
  private aggregators: Map<string, SlidingWindowAggregator | StreamingEMA> = new Map();

  /**
   * 添加聚合器
   */
  addAggregator(name: string, aggregator: SlidingWindowAggregator | StreamingEMA): void {
    this.aggregators.set(name, aggregator);
  }

  /**
   * 添加新值并返回所有聚合结果
   */
  add(value: number): Record<string, number> {
    const results: Record<string, number> = {};
    for (const [name, agg] of this.aggregators) {
      results[name] = agg.add(value);
    }
    return results;
  }

  /**
   * 重置所有聚合器
   */
  reset(): void {
    for (const agg of this.aggregators.values()) {
      agg.reset();
    }
  }
}
