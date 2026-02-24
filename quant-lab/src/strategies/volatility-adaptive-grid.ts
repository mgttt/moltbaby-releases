/**
 * 波动率自适应网格间距
 * 
 * 功能：
 * 1. 计算ATR（平均真实波幅）或近期波动率
 * 2. 基于波动率动态调整gridSpacing
 * 3. 设置上下限（防止极端调整）
 * 4. 无缝集成GalesStrategy
 * 
 * 位置：quant-lab/src/strategies/volatility-adaptive-grid.ts
 */

import { createLogger } from '../utils/logger';
const logger = createLogger('volatility-adaptive-grid');

import type { Kline } from '../../../quant-lib/src';

// ============ 类型定义 ============

export interface VolatilityConfig {
  // ATR周期
  atrPeriod: number; // 默认14
  
  // 波动率计算周期
  volatilityPeriod: number; // 默认20
  
  // 基准网格间距（当波动率适中时）
  baseGridSpacing: number; // 默认0.02 (2%)
  
  // 网格间距范围限制
  minGridSpacing: number; // 默认0.005 (0.5%)
  maxGridSpacing: number; // 默认0.05 (5%)
  
  // 波动率调整系数
  volatilityMultiplier: number; // 默认1.0
  
  // 调整平滑系数（0-1，越大越激进）
  smoothingFactor: number; // 默认0.3
}

export interface VolatilityState {
  currentATR: number;
  currentVolatility: number;
  currentGridSpacing: number;
  lastUpdate: number;
  priceHistory: number[];
}

// ============ 波动率自适应网格管理器 ============

export class VolatilityAdaptiveGridManager {
  private config: VolatilityConfig;
  private state: VolatilityState;

  constructor(config?: Partial<VolatilityConfig>) {
    this.config = {
      atrPeriod: 14,
      volatilityPeriod: 20,
      baseGridSpacing: 0.02,
      minGridSpacing: 0.005,
      maxGridSpacing: 0.05,
      volatilityMultiplier: 1.0,
      smoothingFactor: 0.3,
      ...config,
    };

    this.state = {
      currentATR: 0,
      currentVolatility: 0,
      currentGridSpacing: this.config.baseGridSpacing,
      lastUpdate: 0,
      priceHistory: [],
    };
  }

  /**
   * 更新K线数据，计算波动率和网格间距
   */
  update(bar: Kline): number {
    // 1. 更新价格历史
    this.state.priceHistory.push(bar.close);
    
    // 限制历史长度
    const maxLength = Math.max(this.config.atrPeriod, this.config.volatilityPeriod) * 2;
    if (this.state.priceHistory.length > maxLength) {
      this.state.priceHistory.shift();
    }

    // 2. 计算ATR
    if (this.state.priceHistory.length >= this.config.atrPeriod) {
      this.state.currentATR = this.calculateATR(this.state.priceHistory);
    }

    // 3. 计算波动率
    if (this.state.priceHistory.length >= this.config.volatilityPeriod) {
      this.state.currentVolatility = this.calculateVolatility(
        this.state.priceHistory.slice(-this.config.volatilityPeriod)
      );
    }

    // 4. 基于波动率调整网格间距
    if (this.state.currentVolatility > 0) {
      const newGridSpacing = this.calculateAdaptiveGridSpacing();
      
      // 平滑调整
      this.state.currentGridSpacing =
        this.state.currentGridSpacing * (1 - this.config.smoothingFactor) +
        newGridSpacing * this.config.smoothingFactor;
      
      // 应用上下限
      this.state.currentGridSpacing = Math.max(
        this.config.minGridSpacing,
        Math.min(this.config.maxGridSpacing, this.state.currentGridSpacing)
      );
    }

    this.state.lastUpdate = Date.now();

    return this.state.currentGridSpacing;
  }

  /**
   * 计算ATR（平均真实波幅）
   */
  private calculateATR(prices: number[]): number {
    if (prices.length < 2) return 0;

    const trueRanges: number[] = [];
    
    for (let i = 1; i < prices.length; i++) {
      const high = prices[i];
      const low = prices[i];
      const prevClose = prices[i - 1];
      
      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      
      trueRanges.push(tr);
    }

    // 计算ATR（简单移动平均）
    if (trueRanges.length < this.config.atrPeriod) {
      return trueRanges.reduce((sum, tr) => sum + tr, 0) / trueRanges.length;
    }

    const recentTRs = trueRanges.slice(-this.config.atrPeriod);
    return recentTRs.reduce((sum, tr) => sum + tr, 0) / recentTRs.length;
  }

  /**
   * 计算波动率（标准差/均值）
   */
  private calculateVolatility(prices: number[]): number {
    if (prices.length < 2) return 0;

    const mean = prices.reduce((sum, p) => sum + p, 0) / prices.length;
    const squaredDiffs = prices.map((p) => Math.pow(p - mean, 2));
    const variance = squaredDiffs.reduce((sum, d) => sum + d, 0) / prices.length;
    const stdDev = Math.sqrt(variance);

    // 波动率 = 标准差 / 均值
    return stdDev / mean;
  }

  /**
   * 计算自适应网格间距
   */
  private calculateAdaptiveGridSpacing(): number {
    // 基准波动率（当波动率等于此时，网格间距等于基准）
    const baseVolatility = this.state.currentATR / this.getAveragePrice();
    
    if (baseVolatility === 0) {
      return this.config.baseGridSpacing;
    }

    // 波动率比率
    const volatilityRatio = this.state.currentVolatility / baseVolatility;
    
    // 调整网格间距
    // 波动率高 → 网格间距大
    // 波动率低 → 网格间距小
    let adjustedGridSpacing = this.config.baseGridSpacing * volatilityRatio * this.config.volatilityMultiplier;
    
    // 应用上下限
    return Math.max(
      this.config.minGridSpacing,
      Math.min(this.config.maxGridSpacing, adjustedGridSpacing)
    );
  }

  /**
   * 获取平均价格
   */
  private getAveragePrice(): number {
    if (this.state.priceHistory.length === 0) return 0;
    
    const recentPrices = this.state.priceHistory.slice(-this.config.volatilityPeriod);
    return recentPrices.reduce((sum, p) => sum + p, 0) / recentPrices.length;
  }

  /**
   * 获取当前网格间距
   */
  getCurrentGridSpacing(): number {
    return this.state.currentGridSpacing;
  }

  /**
   * 获取当前ATR
   */
  getCurrentATR(): number {
    return this.state.currentATR;
  }

  /**
   * 获取当前波动率
   */
  getCurrentVolatility(): number {
    return this.state.currentVolatility;
  }

  /**
   * 获取状态
   */
  getState(): VolatilityState {
    return { ...this.state };
  }

  /**
   * 重置状态
   */
  reset(): void {
    this.state = {
      currentATR: 0,
      currentVolatility: 0,
      currentGridSpacing: this.config.baseGridSpacing,
      lastUpdate: 0,
      priceHistory: [],
    };
  }

  /**
   * 日志
   */
  private log(message: string, ...args: any[]): void {
    const timestamp = new Date().toISOString();
    logger.info(`[${timestamp}] ${message}`, ...args);
  }
}

// ============ 导出 ============

export default VolatilityAdaptiveGridManager;
