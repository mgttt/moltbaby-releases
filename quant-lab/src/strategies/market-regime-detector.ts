/**
 * 市场状态检测器
 * 
 * 功能：
 * 1. 基于ADX（趋势强度指标）判断趋势/横盘
 * 2. 强趋势（ADX>25）→发出警告信号
 * 3. 极强趋势（ADX>40）→建议暂停策略
 * 4. 与GalesStrategy集成（可选enableMarketRegime开关）
 * 
 * 位置：quant-lab/src/strategies/market-regime-detector.ts
 */

import type { Kline } from '../../../quant-lib/src';

// ============ 类型定义 ============

export type MarketRegime = 'RANGING' | 'TRENDING' | 'STRONG_TREND';

export interface MarketRegimeConfig {
  // ADX周期
  adxPeriod: number; // 默认14
  
  // ADX阈值
  trendingThreshold: number; // 默认25，强趋势阈值
  strongTrendThreshold: number; // 默认40，极强趋势阈值
  
  // 警告配置
  enableWarning: boolean; // 默认true，是否发出警告
  enableSuspend: boolean; // 默认true，是否建议暂停
}

export interface MarketRegimeState {
  currentADX: number;
  currentRegime: MarketRegime;
  lastUpdate: number;
  adxHistory: number[];
  shouldWarn: boolean;
  shouldSuspend: boolean;
}

export interface MarketRegimeEvents {
  onRegimeChange: (regime: MarketRegime, adx: number) => void;
  onTrendWarning: (adx: number) => void;
  onSuspendSuggestion: (adx: number) => void;
  onError: (error: Error) => void;
}

// ============ 市场状态检测器 ============

export class MarketRegimeDetector {
  private config: MarketRegimeConfig;
  private state: MarketRegimeState;
  private events: Partial<MarketRegimeEvents> = {};
  
  // 价格历史
  private priceHistory: Array<{
    high: number;
    low: number;
    close: number;
  }> = [];

  constructor(config?: Partial<MarketRegimeConfig>) {
    this.config = {
      adxPeriod: 14,
      trendingThreshold: 25,
      strongTrendThreshold: 40,
      enableWarning: true,
      enableSuspend: true,
      ...config,
    };

    this.state = {
      currentADX: 0,
      currentRegime: 'RANGING',
      lastUpdate: 0,
      adxHistory: [],
      shouldWarn: false,
      shouldSuspend: false,
    };
  }

  /**
   * 设置事件回调
   */
  setEvents(events: Partial<MarketRegimeEvents>): void {
    this.events = { ...this.events, ...events };
  }

  /**
   * 更新K线数据，计算ADX和市场状态
   */
  update(bar: Kline): MarketRegime {
    // 1. 更新价格历史
    this.priceHistory.push({
      high: bar.high,
      low: bar.low,
      close: bar.close,
    });

    // 限制历史长度
    const maxLength = this.config.adxPeriod * 3;
    if (this.priceHistory.length > maxLength) {
      this.priceHistory.shift();
    }

    // 2. 计算ADX
    if (this.priceHistory.length >= this.config.adxPeriod * 2) {
      this.state.currentADX = this.calculateADX();
      this.state.adxHistory.push(this.state.currentADX);
      
      if (this.state.adxHistory.length > 100) {
        this.state.adxHistory.shift();
      }
    }

    // 3. 判断市场状态
    const previousRegime = this.state.currentRegime;
    this.state.currentRegime = this.determineRegime(this.state.currentADX);

    // 4. 触发事件
    if (this.state.currentRegime !== previousRegime) {
      this.events.onRegimeChange?.(this.state.currentRegime, this.state.currentADX);
    }

    // 5. 检查警告和暂停
    this.checkWarnings();

    this.state.lastUpdate = Date.now();

    return this.state.currentRegime;
  }

  /**
   * 计算ADX（Average Directional Index）
   */
  private calculateADX(): number {
    if (this.priceHistory.length < this.config.adxPeriod * 2) {
      return 0;
    }

    // 1. 计算+DM和-DM
    const dmArray: Array<{ plusDM: number; minusDM: number; tr: number }> = [];
    
    for (let i = 1; i < this.priceHistory.length; i++) {
      const current = this.priceHistory[i];
      const previous = this.priceHistory[i - 1];

      const upMove = current.high - previous.high;
      const downMove = previous.low - current.low;

      const plusDM = upMove > downMove && upMove > 0 ? upMove : 0;
      const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;

      // 计算True Range
      const tr = Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      );

      dmArray.push({ plusDM, minusDM, tr });
    }

    // 2. 计算平滑的+DM、-DM和TR
    const period = this.config.adxPeriod;
    const smoothedData: Array<{ plusDM: number; minusDM: number; tr: number }> = [];

    for (let i = period - 1; i < dmArray.length; i++) {
      let sumPlusDM = 0;
      let sumMinusDM = 0;
      let sumTR = 0;

      for (let j = i - period + 1; j <= i; j++) {
        sumPlusDM += dmArray[j].plusDM;
        sumMinusDM += dmArray[j].minusDM;
        sumTR += dmArray[j].tr;
      }

      smoothedData.push({
        plusDM: sumPlusDM,
        minusDM: sumMinusDM,
        tr: sumTR,
      });
    }

    // 3. 计算+DI和-DI
    const diArray: Array<{ plusDI: number; minusDI: number; dx: number }> = [];

    for (const data of smoothedData) {
      const plusDI = data.tr > 0 ? (data.plusDM / data.tr) * 100 : 0;
      const minusDI = data.tr > 0 ? (data.minusDM / data.tr) * 100 : 0;

      // 4. 计算DX（Directional Movement Index）
      const diSum = plusDI + minusDI;
      const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;

      diArray.push({ plusDI, minusDI, dx });
    }

    // 5. 计算ADX（DX的平滑平均）
    if (diArray.length < period) {
      return 0;
    }

    let adx = 0;
    for (let i = diArray.length - period; i < diArray.length; i++) {
      adx += diArray[i].dx;
    }

    adx /= period;

    return adx;
  }

  /**
   * 判断市场状态
   */
  private determineRegime(adx: number): MarketRegime {
    if (adx >= this.config.strongTrendThreshold) {
      return 'STRONG_TREND';
    } else if (adx >= this.config.trendingThreshold) {
      return 'TRENDING';
    } else {
      return 'RANGING';
    }
  }

  /**
   * 检查警告和暂停建议
   */
  private checkWarnings(): void {
    const adx = this.state.currentADX;

    // 检查极强趋势（暂停建议）
    if (adx >= this.config.strongTrendThreshold) {
      this.state.shouldSuspend = true;
      this.state.shouldWarn = true;
      
      if (this.config.enableSuspend) {
        this.events.onSuspendSuggestion?.(adx);
        console.log(
          `[MarketRegimeDetector] ⚠️ 极强趋势检测，建议暂停策略！ADX=${adx.toFixed(2)}`
        );
      }
    }
    // 检查强趋势（警告）
    else if (adx >= this.config.trendingThreshold) {
      this.state.shouldSuspend = false;
      this.state.shouldWarn = true;
      
      if (this.config.enableWarning) {
        this.events.onTrendWarning?.(adx);
        console.log(
          `[MarketRegimeDetector] ⚡ 强趋势检测，注意风险！ADX=${adx.toFixed(2)}`
        );
      }
    }
    // 横盘市场
    else {
      this.state.shouldSuspend = false;
      this.state.shouldWarn = false;
    }
  }

  /**
   * 获取当前ADX
   */
  getCurrentADX(): number {
    return this.state.currentADX;
  }

  /**
   * 获取当前市场状态
   */
  getCurrentRegime(): MarketRegime {
    return this.state.currentRegime;
  }

  /**
   * 是否应该警告
   */
  shouldWarn(): boolean {
    return this.state.shouldWarn;
  }

  /**
   * 是否应该暂停
   */
  shouldSuspend(): boolean {
    return this.state.shouldSuspend;
  }

  /**
   * 获取状态
   */
  getState(): MarketRegimeState {
    return { ...this.state };
  }

  /**
   * 获取ADX历史
   */
  getADXHistory(): number[] {
    return [...this.state.adxHistory];
  }

  /**
   * 重置状态
   */
  reset(): void {
    this.state = {
      currentADX: 0,
      currentRegime: 'RANGING',
      lastUpdate: 0,
      adxHistory: [],
      shouldWarn: false,
      shouldSuspend: false,
    };
    this.priceHistory = [];
  }

  /**
   * 日志
   */
  private log(message: string, ...args: any[]): void {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`, ...args);
  }
}

// ============ 导出 ============

export default MarketRegimeDetector;
