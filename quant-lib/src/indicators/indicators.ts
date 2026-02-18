// ============================================================
// 技术指标库 - 批量计算函数
//
// 用于回测场景，接受数组输入并返回数组输出
// ============================================================

/**
 * 简单移动平均（SMA）
 * 
 * @param data - 价格数组
 * @param period - 周期
 * @returns SMA 数组（前 period-1 个值为 NaN）
 */
export function sma(data: number[], period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  
  if (data.length < period) return result;
  
  // 计算第一个 SMA
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += data[i];
  }
  result[period - 1] = sum / period;
  
  // 滚动计算后续 SMA
  for (let i = period; i < data.length; i++) {
    sum = sum - data[i - period] + data[i];
    result[i] = sum / period;
  }
  
  return result;
}

/**
 * 指数移动平均（EMA）
 * 
 * @param data - 价格数组
 * @param period - 周期
 * @returns EMA 数组
 */
export function ema(data: number[], period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  
  if (data.length < period) return result;
  
  const multiplier = 2 / (period + 1);
  
  // 第一个 EMA 使用 SMA
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += data[i];
  }
  result[period - 1] = sum / period;
  
  // 后续 EMA
  for (let i = period; i < data.length; i++) {
    result[i] = (data[i] - result[i - 1]) * multiplier + result[i - 1];
  }
  
  return result;
}

/**
 * MACD（Moving Average Convergence Divergence）
 * 
 * @param data - 价格数组
 * @param fastPeriod - 快线周期（默认 12）
 * @param slowPeriod - 慢线周期（默认 26）
 * @param signalPeriod - 信号线周期（默认 9）
 * @returns { macd, signal, histogram }
 */
export function macd(
  data: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
): { macd: number[]; signal: number[]; histogram: number[] } {
  const fastEMA = ema(data, fastPeriod);
  const slowEMA = ema(data, slowPeriod);
  
  // MACD 线 = 快线 - 慢线
  const macdLine: number[] = fastEMA.map((fast, i) => {
    if (isNaN(fast) || isNaN(slowEMA[i])) return NaN;
    return fast - slowEMA[i];
  });
  
  // 信号线 = MACD 的 EMA（跳过开头的 NaN）
  const validMacdStart = macdLine.findIndex(x => !isNaN(x));
  const validMacd = macdLine.slice(validMacdStart);
  const signalLineValid = ema(validMacd, signalPeriod);
  
  // 填充 signalLine（与 data 长度一致）
  const fullSignal: number[] = new Array(data.length).fill(NaN);
  for (let i = 0; i < signalLineValid.length; i++) {
    fullSignal[validMacdStart + i] = signalLineValid[i];
  }
  
  // 柱状图 = MACD - 信号线
  const histogram: number[] = macdLine.map((m, i) => {
    if (isNaN(m) || isNaN(fullSignal[i])) return NaN;
    return m - fullSignal[i];
  });
  
  return {
    macd: macdLine,
    signal: fullSignal,
    histogram,
  };
}

/**
 * RSI（Relative Strength Index）
 * 
 * @param data - 价格数组
 * @param period - 周期（默认 14）
 * @returns RSI 数组（0-100）
 */
export function rsi(data: number[], period = 14): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  
  if (data.length < period + 1) return result;
  
  // 计算价格变化
  const changes: number[] = [];
  for (let i = 1; i < data.length; i++) {
    changes.push(data[i] - data[i - 1]);
  }
  
  // 分离涨跌
  const gains: number[] = changes.map(c => (c > 0 ? c : 0));
  const losses: number[] = changes.map(c => (c < 0 ? -c : 0));
  
  // 计算第一个平均涨跌
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= period;
  avgLoss /= period;
  
  // 第一个 RSI
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result[period] = 100 - 100 / (1 + rs);
  
  // 后续 RSI（使用 Wilder's 平滑）
  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result[i + 1] = 100 - 100 / (1 + rs);
  }
  
  return result;
}

/**
 * 布林带（Bollinger Bands）
 * 
 * @param data - 价格数组
 * @param period - 周期（默认 20）
 * @param stdDev - 标准差倍数（默认 2）
 * @returns { upper, middle, lower }
 */
export function bollingerBands(
  data: number[],
  period = 20,
  stdDev = 2
): { upper: number[]; middle: number[]; lower: number[] } {
  const middle = sma(data, period);
  
  // 计算标准差
  const stdDevValues: number[] = new Array(data.length).fill(NaN);
  for (let i = period - 1; i < data.length; i++) {
    const slice = data.slice(i - period + 1, i + 1);
    const mean = middle[i];
    const variance = slice.reduce((sum, x) => sum + Math.pow(x - mean, 2), 0) / period;
    stdDevValues[i] = Math.sqrt(variance);
  }
  
  // 上下轨
  const upper: number[] = middle.map((m, i) => {
    if (isNaN(m) || isNaN(stdDevValues[i])) return NaN;
    return m + stdDev * stdDevValues[i];
  });
  
  const lower: number[] = middle.map((m, i) => {
    if (isNaN(m) || isNaN(stdDevValues[i])) return NaN;
    return m - stdDev * stdDevValues[i];
  });
  
  return { upper, middle, lower };
}

/**
 * ATR（Average True Range）
 * 
 * @param high - 最高价数组
 * @param low - 最低价数组
 * @param close - 收盘价数组
 * @param period - 周期（默认 14）
 * @returns ATR 数组
 */
export function atr(
  high: number[],
  low: number[],
  close: number[],
  period = 14
): number[] {
  const result: number[] = new Array(close.length).fill(NaN);
  
  if (close.length < period + 1) return result;
  
  // 计算 True Range
  const tr: number[] = [NaN]; // 第一个 TR 无法计算
  for (let i = 1; i < close.length; i++) {
    const hl = high[i] - low[i];
    const hc = Math.abs(high[i] - close[i - 1]);
    const lc = Math.abs(low[i] - close[i - 1]);
    tr.push(Math.max(hl, hc, lc));
  }
  
  // 第一个 ATR（简单平均）
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    sum += tr[i];
  }
  result[period] = sum / period;
  
  // 后续 ATR（Wilder's 平滑）
  for (let i = period + 1; i < close.length; i++) {
    result[i] = (result[i - 1] * (period - 1) + tr[i]) / period;
  }
  
  return result;
}

/**
 * OBV（On-Balance Volume）
 * 
 * @param close - 收盘价数组
 * @param volume - 成交量数组
 * @returns OBV 数组
 */
export function obv(close: number[], volume: number[]): number[] {
  const result: number[] = new Array(close.length);
  
  result[0] = volume[0];
  
  for (let i = 1; i < close.length; i++) {
    if (close[i] > close[i - 1]) {
      result[i] = result[i - 1] + volume[i];
    } else if (close[i] < close[i - 1]) {
      result[i] = result[i - 1] - volume[i];
    } else {
      result[i] = result[i - 1];
    }
  }
  
  return result;
}

/**
 * 标准差（Standard Deviation）
 * 
 * @param data - 数据数组
 * @param period - 周期
 * @returns 标准差数组
 */
export function stdDev(data: number[], period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  const mean = sma(data, period);
  
  for (let i = period - 1; i < data.length; i++) {
    if (isNaN(mean[i])) continue;
    
    const slice = data.slice(i - period + 1, i + 1);
    const variance = slice.reduce((sum, x) => sum + Math.pow(x - mean[i], 2), 0) / period;
    result[i] = Math.sqrt(variance);
  }
  
  return result;
}

/**
 * WMA（Weighted Moving Average）
 * 
 * @param data - 价格数组
 * @param period - 周期
 * @returns WMA 数组
 */
export function wma(data: number[], period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  
  if (data.length < period) return result;
  
  // 权重总和：1+2+3+...+period = period*(period+1)/2
  const weightSum = (period * (period + 1)) / 2;
  
  for (let i = period - 1; i < data.length; i++) {
    let weightedSum = 0;
    for (let j = 0; j < period; j++) {
      weightedSum += data[i - period + 1 + j] * (j + 1);
    }
    result[i] = weightedSum / weightSum;
  }
  
  return result;
}

/**
 * 动量指标（Momentum）
 * 
 * @param data - 价格数组
 * @param period - 周期
 * @returns 动量数组（当前价格 - period 前价格）
 */
export function momentum(data: number[], period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  
  for (let i = period; i < data.length; i++) {
    result[i] = data[i] - data[i - period];
  }
  
  return result;
}

/**
 * ROC（Rate of Change）
 * 
 * @param data - 价格数组
 * @param period - 周期
 * @returns ROC 数组（百分比）
 */
export function roc(data: number[], period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  
  for (let i = period; i < data.length; i++) {
    if (data[i - period] !== 0) {
      result[i] = ((data[i] - data[i - period]) / data[i - period]) * 100;
    }
  }
  
  return result;
}
