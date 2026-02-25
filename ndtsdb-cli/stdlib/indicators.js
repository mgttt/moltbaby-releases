// indicators.js - 流式技术指标库
// 为 ndtsdb-cli 提供纯 JS 实现的流式指标

/**
 * StreamingSMA - 简单移动平均（流式计算）
 * 
 * 用法：
 *   import { StreamingSMA } from 'ndtsdb';
 *   const sma = new StreamingSMA(20);  // 20周期SMA
 *   const value = sma.update(close);    // 返回值或null
 *   console.log(sma.value);             // 当前值
 *   sma.reset();                        // 重置
 */
export class StreamingSMA {
    constructor(period = 20) {
        if (period <= 0) {
            throw new Error('Period must be positive');
        }
        this.period = period;
        this.reset();
    }

    /**
     * 重置指标状态
     */
    reset() {
        this._values = [];
        this._sum = 0;
        this._count = 0;
        this._value = null;
    }

    /**
     * 获取当前SMA值
     * @returns {number|null} 当前值或null（未满足period）
     */
    get value() {
        return this._value;
    }

    /**
     * 更新指标
     * @param {number} close - 收盘价
     * @returns {number|null} 当前SMA值或null（未满足period）
     */
    update(close) {
        if (typeof close !== 'number' || isNaN(close)) {
            return this._value;
        }

        // 维护滑动窗口
        this._values.push(close);
        this._sum += close;
        this._count++;

        // 移除超出窗口的数据
        if (this._values.length > this.period) {
            const removed = this._values.shift();
            this._sum -= removed;
        }

        // 只有当有足够数据时才计算SMA
        if (this._values.length >= this.period) {
            this._value = this._sum / this.period;
        }

        return this._value;
    }

    /**
     * 检查是否已准备好（有足够数据）
     * @returns {boolean}
     */
    get isReady() {
        return this._values.length >= this.period;
    }

    /**
     * 获取已收集的数据点数
     * @returns {number}
     */
    get count() {
        return this._count;
    }
}

/**
 * 批量计算SMA（非流式，用于验证或一次性计算）
 * @param {number[]} data - 数据数组
 * @param {number} period - 周期
 * @returns {Array<{index: number, value: number}>} SMA值数组
 */
export function calculateSMA(data, period = 20) {
    const sma = new StreamingSMA(period);
    const results = [];
    
    for (let i = 0; i < data.length; i++) {
        const value = sma.update(data[i]);
        if (value !== null) {
            results.push({ index: i, value: value });
        }
    }
    
    return results;
}

/**
 * StreamingEMA - 指数移动平均（流式计算）
 * 
 * EMA公式：
 *   multiplier = 2 / (period + 1)
 *   EMA = close × multiplier + prevEMA × (1 - multiplier)
 *   前period个数据用SMA初始化
 * 
 * 用法：
 *   import { StreamingEMA } from 'ndtsdb';
 *   const ema = new StreamingEMA(20);  // 20周期EMA
 *   const value = ema.update(close);    // 返回值或null
 *   console.log(ema.value);             // 当前值
 *   ema.reset();                        // 重置
 */
export class StreamingEMA {
    constructor(period = 20) {
        if (period <= 0) {
            throw new Error('Period must be positive');
        }
        this.period = period;
        this.multiplier = 2 / (period + 1);
        this.reset();
    }

    /**
     * 重置指标状态
     */
    reset() {
        this._values = [];
        this._sum = 0;
        this._value = null;
        this._initialized = false;
    }

    /**
     * 获取当前EMA值
     * @returns {number|null} 当前值或null（未满足period）
     */
    get value() {
        return this._value;
    }

    /**
     * 更新指标
     * @param {number} close - 收盘价
     * @returns {number|null} 当前EMA值或null（未满足period）
     */
    update(close) {
        if (typeof close !== 'number' || isNaN(close)) {
            return this._value;
        }

        if (!this._initialized) {
            // 初始化阶段：收集前period个数据用SMA初始化
            this._values.push(close);
            this._sum += close;

            if (this._values.length === this.period) {
                // 用SMA作为第一个EMA值
                this._value = this._sum / this.period;
                this._initialized = true;
                this._values = [];  // 清空，不再需要
            }
        } else {
            // EMA计算
            this._value = close * this.multiplier + this._value * (1 - this.multiplier);
        }

        return this._value;
    }

    /**
     * 检查是否已准备好（有足够数据）
     * @returns {boolean}
     */
    get isReady() {
        return this._initialized;
    }
}

/**
 * 批量计算EMA（非流式，用于验证或一次性计算）
 * @param {number[]} data - 数据数组
 * @param {number} period - 周期
 * @returns {Array<{index: number, value: number}>} EMA值数组
 */
export function calculateEMA(data, period = 20) {
    const ema = new StreamingEMA(period);
    const results = [];
    
    for (let i = 0; i < data.length; i++) {
        const value = ema.update(data[i]);
        if (value !== null) {
            results.push({ index: i, value: value });
        }
    }
    
    return results;
}

/**
 * StreamingBB - 布林带（Bollinger Bands，流式计算）
 *
 * 算法：
 *   - middle = SMA(period)
 *   - std = 标准差（总体，除以n）
 *   - upper = middle + stdDev × std
 *   - lower = middle - stdDev × std
 *   - bandwidth = (upper - lower) / middle
 *   - %B = (close - lower) / (upper - lower)
 *
 * 用法：
 *   import { StreamingBB } from 'ndtsdb';
 *   const bb = new StreamingBB(20, 2);  // 20周期，2倍标准差
 *   const result = bb.update(close);    // { upper, middle, lower, bandwidth, percentB } 或 null
 *   console.log(bb.value);              // 同 result
 *   bb.reset();                         // 重置
 */
export class StreamingBB {
    constructor(period = 20, stdDev = 2) {
        if (period <= 0) {
            throw new Error('Period must be positive');
        }
        if (stdDev <= 0) {
            throw new Error('Standard deviation multiplier must be positive');
        }
        this.period = period;
        this.stdDev = stdDev;
        this._sma = new StreamingSMA(period);
        this._values = [];
        this._value = null;
    }

    /**
     * 重置指标状态
     */
    reset() {
        this._sma.reset();
        this._values = [];
        this._value = null;
    }

    /**
     * 获取当前BB值
     * @returns {{upper: number, middle: number, lower: number, bandwidth: number, percentB: number}|null}
     */
    get value() {
        return this._value;
    }

    /**
     * 检查是否已准备好
     * @returns {boolean}
     */
    get isReady() {
        return this._value !== null;
    }

    /**
     * 更新指标
     * @param {number} close - 收盘价
     * @returns {{upper: number, middle: number, lower: number, bandwidth: number, percentB: number}|null}
     */
    update(close) {
        if (typeof close !== 'number' || isNaN(close)) {
            return this._value;
        }

        // 更新SMA（middle）
        this._sma.update(close);

        // 维护滑动窗口用于标准差计算
        this._values.push(close);
        if (this._values.length > this.period) {
            this._values.shift();
        }

        // SMA未就绪时，BB无法计算
        if (!this._sma.isReady) {
            return null;
        }

        const middle = this._sma.value;

        // 计算总体标准差（除以n，不是n-1）
        let sumSquaredDiff = 0;
        for (let i = 0; i < this._values.length; i++) {
            const diff = this._values[i] - middle;
            sumSquaredDiff += diff * diff;
        }
        const std = Math.sqrt(sumSquaredDiff / this._values.length);

        // 计算布林带
        const upper = middle + this.stdDev * std;
        const lower = middle - this.stdDev * std;

        // 计算带宽和%B
        const bandwidth = (upper - lower) / middle;
        const percentB = (close - lower) / (upper - lower);

        this._value = {
            upper: upper,
            middle: middle,
            lower: lower,
            bandwidth: bandwidth,
            percentB: percentB
        };

        return this._value;
    }
}

/**
 * 批量计算BB（非流式，用于验证或一次性计算）
 * @param {number[]} data - 数据数组
 * @param {number} period - 周期
 * @param {number} stdDev - 标准差倍数
 * @returns {Array<{index: number, upper: number, middle: number, lower: number, bandwidth: number, percentB: number}>} BB值数组
 */
export function calculateBB(data, period = 20, stdDev = 2) {
    const bb = new StreamingBB(period, stdDev);
    const results = [];

    for (let i = 0; i < data.length; i++) {
        const value = bb.update(data[i]);
        if (value !== null) {
            results.push({ index: i, ...value });
        }
    }

    return results;
}

/**
 * StreamingRSI - 相对强弱指标（流式计算）
 * 
 * Wilder's 平滑法：
 *   1. 计算价格变化 delta = close - prevClose
 *   2. gain = max(delta, 0), loss = max(-delta, 0)
 *   3. avgGain = prevAvgGain × (period-1)/period + gain/period
 *   4. avgLoss = prevAvgLoss × (period-1)/period + loss/period
 *   5. RS = avgGain / avgLoss
 *   6. RSI = 100 - (100 / (1 + RS))
 * 
 * 用法：
 *   import { StreamingRSI } from 'ndtsdb';
 *   const rsi = new StreamingRSI(14);  // 14周期RSI
 *   const value = rsi.update(close);    // 返回值或null
 *   console.log(rsi.value);             // 当前值
 *   rsi.reset();                        // 重置
 */
export class StreamingRSI {
    constructor(period = 14) {
        if (period <= 0) {
            throw new Error('Period must be positive');
        }
        this.period = period;
        this.reset();
    }

    /**
     * 重置指标状态
     */
    reset() {
        this._prevClose = null;
        this._gains = [];
        this._losses = [];
        this._avgGain = null;
        this._avgLoss = null;
        this._value = null;
        this._count = 0;
    }

    /**
     * 获取当前RSI值
     * @returns {number|null} 当前值或null（未满足period）
     */
    get value() {
        return this._value;
    }

    /**
     * 更新指标
     * @param {number} close - 收盘价
     * @returns {number|null} 当前RSI值或null（未满足period）
     */
    update(close) {
        if (typeof close !== 'number' || isNaN(close)) {
            return this._value;
        }

        this._count++;

        if (this._prevClose === null) {
            this._prevClose = close;
            return this._value;
        }

        const delta = close - this._prevClose;
        this._prevClose = close;

        const gain = delta > 0 ? delta : 0;
        const loss = delta < 0 ? -delta : 0;

        if (this._avgGain === null) {
            // 初始化阶段：收集前period个gain/loss
            this._gains.push(gain);
            this._losses.push(loss);

            if (this._gains.length === this.period) {
                // 计算初始平均值
                this._avgGain = this._gains.reduce((a, b) => a + b, 0) / this.period;
                this._avgLoss = this._losses.reduce((a, b) => a + b, 0) / this.period;
                this._gains = [];
                this._losses = [];
                this._calculateRSI();
            }
        } else {
            // Wilder's 平滑
            this._avgGain = (this._avgGain * (this.period - 1) + gain) / this.period;
            this._avgLoss = (this._avgLoss * (this.period - 1) + loss) / this.period;
            this._calculateRSI();
        }

        return this._value;
    }

    /**
     * 计算RSI值
     */
    _calculateRSI() {
        if (this._avgLoss === 0) {
            this._value = 100;
        } else {
            const rs = this._avgGain / this._avgLoss;
            this._value = 100 - (100 / (1 + rs));
        }
    }

    /**
     * 检查是否已准备好（有足够数据）
     * @returns {boolean}
     */
    get isReady() {
        return this._avgGain !== null;
    }

    /**
     * 获取已收集的数据点数
     * @returns {number}
     */
    get count() {
        return this._count;
    }
}

/**
 * 批量计算RSI（非流式，用于验证或一次性计算）
 * @param {number[]} data - 数据数组
 * @param {number} period - 周期
 * @returns {Array<{index: number, value: number}>} RSI值数组
 */
export function calculateRSI(data, period = 14) {
    const rsi = new StreamingRSI(period);
    const results = [];

    for (let i = 0; i < data.length; i++) {
        const value = rsi.update(data[i]);
        if (value !== null) {
            results.push({ index: i, value: value });
        }
    }

    return results;
}

/**
 * StreamingVWAP - 成交量加权平均价（流式计算）
 *
 * 公式：
 *   VWAP = Σ(close × volume) / Σ(volume)
 *
 * 两种模式：
 *   1. 无 period：全程累积 VWAP
 *   2. 有 period：滑动窗口 VWAP（最近 period 个数据点）
 *
 * 用法：
 *   import { StreamingVWAP } from 'ndtsdb';
 *   const vwap = new StreamingVWAP();           // 全程累积
 *   const vwap20 = new StreamingVWAP(20);       // 20周期滑动窗口
 *   vwap.update(close, volume);                 // 更新
 *   console.log(vwap.value);                    // 当前 VWAP
 *   vwap.reset();                               // 重置
 */
export class StreamingVWAP {
    /**
     * @param {number|null} period - 滑动窗口周期，null 表示全程累积
     */
    constructor(period = null) {
        if (period !== null && period <= 0) {
            throw new Error('Period must be positive or null');
        }
        this.period = period;
        this.reset();
    }

    /**
     * 重置指标状态
     */
    reset() {
        this._cumulativePV = 0;  // Σ(price × volume)
        this._cumulativeV = 0;   // Σ(volume)
        this._values = [];       // 滑动窗口用 [ {close, volume}, ... ]
        this._value = null;
        this._count = 0;
    }

    /**
     * 获取当前 VWAP 值
     * @returns {number|null} 当前 VWAP 或 null（无数据）
     */
    get value() {
        return this._value;
    }

    /**
     * 更新指标
     * @param {number} close - 收盘价
     * @param {number} volume - 成交量
     * @returns {number|null} 当前 VWAP 或 null（无数据）
     */
    update(close, volume) {
        if (typeof close !== 'number' || isNaN(close) ||
            typeof volume !== 'number' || isNaN(volume) || volume < 0) {
            return this._value;
        }

        const pv = close * volume;
        this._count++;

        if (this.period === null) {
            // 全程累积模式
            this._cumulativePV += pv;
            this._cumulativeV += volume;
        } else {
            // 滑动窗口模式
            this._values.push({ close, volume, pv });
            this._cumulativePV += pv;
            this._cumulativeV += volume;

            // 移除超出窗口的数据
            if (this._values.length > this.period) {
                const removed = this._values.shift();
                this._cumulativePV -= removed.pv;
                this._cumulativeV -= removed.volume;
            }
        }

        // 只有当有成交量时才计算 VWAP
        if (this._cumulativeV > 0) {
            this._value = this._cumulativePV / this._cumulativeV;
        }

        return this._value;
    }

    /**
     * 检查是否已准备好（有数据）
     * @returns {boolean}
     */
    get isReady() {
        return this._value !== null;
    }

    /**
     * 获取已收集的数据点数
     * @returns {number}
     */
    get count() {
        return this._count;
    }

    /**
     * 获取累积成交量
     * @returns {number}
     */
    get totalVolume() {
        return this._cumulativeV;
    }
}

/**
 * 批量计算 VWAP（非流式，用于验证或一次性计算）
 * @param {Array<{close: number, volume: number}>} data - 数据数组
 * @param {number|null} period - 周期，null 表示全程累积
 * @returns {Array<{index: number, value: number}>} VWAP 值数组
 */
export function calculateVWAP(data, period = null) {
    const vwap = new StreamingVWAP(period);
    const results = [];

    for (let i = 0; i < data.length; i++) {
        const { close, volume } = data[i];
        const value = vwap.update(close, volume);
        if (value !== null) {
            results.push({ index: i, value: value });
        }
    }

    return results;
}

// 默认导出
export default { StreamingSMA, calculateSMA, StreamingEMA, calculateEMA, StreamingBB, calculateBB, StreamingRSI, calculateRSI, StreamingVWAP, calculateVWAP };
