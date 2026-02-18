#!/usr/bin/env bun
/**
 * Virtual Market Generator
 * 
 * 生成模拟市场数据，用于：
 * 1. 测试 ndtsdb 压缩率、性能、SQL 接口
 * 2. 为策略回测提供数据基础
 * 3. 不依赖外部 API
 * 
 * 模拟真实市场特征：
 * - 随机游走（带漂移）
 * - 波动率聚集（GARCH-like）
 * - 跳空（开盘间隙）
 * - 成交量模式（与波动相关）
 * - 均值回归
 */

import type { Kline } from '../src/types/kline';

export interface VirtualMarketConfig {
  /** 初始价格 */
  initialPrice: number;
  /** 年化波动率 (如 0.8 = 80%) */
  annualVolatility: number;
  /** 年化收益率 (漂移项，如 0.1 = 10%) */
  annualDrift: number;
  /** 均值回归强度 (0-1, 0=无回归) */
  meanReversionStrength: number;
  /** 目标价格（均值回归用） */
  targetPrice?: number;
  /** 跳空概率 (0-1) */
  gapProbability: number;
  /** 最大跳空幅度 (价格比例) */
  maxGapSize: number;
  /** 成交量基准 */
  baseVolume: number;
  /** 成交量与波动相关性 (0-1) */
  volumeVolatilityCorrelation: number;
  /** 随机种子（可重复） */
  seed?: number;
}

export interface VirtualSymbol {
  symbol: string;
  name: string;
  config: VirtualMarketConfig;
}

const DEFAULT_CONFIG: VirtualMarketConfig = {
  initialPrice: 100,
  annualVolatility: 0.8,
  annualDrift: 0.1,
  meanReversionStrength: 0.05,
  targetPrice: 100,
  gapProbability: 0.05,
  maxGapSize: 0.02,
  baseVolume: 1000,
  volumeVolatilityCorrelation: 0.7,
};

// 虚拟币种配置
export const VIRTUAL_SYMBOLS: VirtualSymbol[] = [
  { symbol: 'VIRT:BTCUSD', name: '虚拟BTC', config: { ...DEFAULT_CONFIG, initialPrice: 65000, annualVolatility: 0.9 } },
  { symbol: 'VIRT:ETHUSD', name: '虚拟ETH', config: { ...DEFAULT_CONFIG, initialPrice: 3500, annualVolatility: 0.85 } },
  { symbol: 'VIRT:SOLUSD', name: '虚拟SOL', config: { ...DEFAULT_CONFIG, initialPrice: 150, annualVolatility: 1.2 } },
  { symbol: 'VIRT:MEMEUSD', name: '虚拟MEME', config: { ...DEFAULT_CONFIG, initialPrice: 0.001, annualVolatility: 2.5, annualDrift: 0.5 } },
  { symbol: 'VIRT:STABLEUSD', name: '虚拟稳定币', config: { ...DEFAULT_CONFIG, initialPrice: 1, annualVolatility: 0.02, annualDrift: 0 } },
];

export class VirtualMarketGenerator {
  private rng: () => number;
  private prices: Map<string, number> = new Map();
  private volatilities: Map<string, number> = new Map();

  constructor(seed: number = Date.now()) {
    // 简单的伪随机数生成器（可重复）
    this.rng = this.createRNG(seed);
  }

  /**
   * 生成历史 K 线数据
   */
  generateHistory(
    symbol: VirtualSymbol,
    interval: string,  // '1m', '5m', '15m', '1h', '4h', '1d'
    startTime: Date,
    endTime: Date
  ): Kline[] {
    const klines: Kline[] = [];
    const intervalMs = this.parseInterval(interval);
    const config = { ...DEFAULT_CONFIG, ...symbol.config };
    
    let currentPrice = config.initialPrice;
    let currentVol = config.annualVolatility / Math.sqrt(365 * 24 * 12); // 15min vol
    
    this.prices.set(symbol.symbol, currentPrice);
    this.volatilities.set(symbol.symbol, currentVol);

    for (let t = startTime.getTime(); t <= endTime.getTime(); t += intervalMs) {
      const kline = this.generateBar(symbol, config, t, interval, intervalMs, currentPrice, currentVol);
      klines.push(kline);
      
      currentPrice = kline.close;
      // 波动率聚集（GARCH-like）
      const returnPct = (kline.close - kline.open) / kline.open;
      currentVol = this.updateVolatility(currentVol, returnPct, config.annualVolatility);
    }

    return klines;
  }

  /**
   * 生成单根 K 线
   */
  private generateBar(
    symbol: VirtualSymbol,
    config: VirtualMarketConfig,
    timestamp: number,
    interval: string,
    intervalMs: number,
    prevClose: number,
    vol: number
  ): Kline {
    const isGap = this.rng() < config.gapProbability;
    let open = prevClose;
    
    // 跳空
    if (isGap) {
      const gapDir = this.rng() > 0.5 ? 1 : -1;
      const gapSize = this.rng() * config.maxGapSize * gapDir;
      open = prevClose * (1 + gapSize);
    }

    // 随机游走 + 漂移 + 均值回归
    const timeFraction = intervalMs / (365 * 24 * 60 * 60 * 1000); // 年化时间比例
    const drift = config.annualDrift * timeFraction;
    const randomShock = this.randn() * vol * Math.sqrt(timeFraction);
    
    // 均值回归
    let meanReversion = 0;
    if (config.targetPrice && config.meanReversionStrength > 0) {
      const deviation = (open - config.targetPrice) / config.targetPrice;
      meanReversion = -deviation * config.meanReversionStrength * timeFraction;
    }
    
    const returnPct = drift + randomShock + meanReversion;
    const close = open * (1 + returnPct);
    
    // 生成 high/low（基于波动）
    const intradayVol = vol * Math.sqrt(timeFraction) * Math.abs(this.randn());
    const high = Math.max(open, close) * (1 + intradayVol * 0.5);
    const low = Math.min(open, close) * (1 - intradayVol * 0.5);
    
    // 成交量（与波动相关）
    const volSignal = Math.abs(returnPct) / vol; // 标准化波动
    const volumeNoise = this.rng();
    const volume = config.baseVolume * (1 + config.volumeVolatilityCorrelation * volSignal + (1 - config.volumeVolatilityCorrelation) * volumeNoise);

    return {
      symbol: symbol.symbol.replace('VIRT:', ''),
      exchange: 'VIRTUAL',
      baseCurrency: symbol.symbol.split(':')[1]?.replace('USD', '') || 'VIRT',
      quoteCurrency: 'USD',
      interval,
      timestamp: Math.floor(timestamp / 1000), // 秒级时间戳
      open: Math.max(0.000001, open),
      high: Math.max(open, close, high),
      low: Math.max(0.000001, Math.min(open, close, low)),
      close: Math.max(0.000001, close),
      volume: Math.max(0, volume),
    };
  }

  /**
   * 生成实时 tick（流式）
   */
  *generateStream(symbol: VirtualSymbol, interval: string): Generator<Kline> {
    const config = { ...DEFAULT_CONFIG, ...symbol.config };
    let currentPrice = config.initialPrice;
    let currentVol = config.annualVolatility / Math.sqrt(365 * 24 * 12);
    const intervalMs = this.parseInterval(interval);
    let timestamp = Date.now();

    while (true) {
      const kline = this.generateBar(symbol, config, timestamp, interval, intervalMs, currentPrice, currentVol);
      yield kline;
      
      currentPrice = kline.close;
      const returnPct = (kline.close - kline.open) / kline.open;
      currentVol = this.updateVolatility(currentVol, returnPct, config.annualVolatility);
      timestamp += intervalMs;
    }
  }

  /**
   * 更新波动率（GARCH-like）
   */
  private updateVolatility(currentVol: number, returnPct: number, annualVol: number): number {
    // 简单的 EWMA: vol_t = 0.94 * vol_{t-1} + 0.06 * |return|
    const lambda = 0.94;
    const newVol = lambda * currentVol + (1 - lambda) * Math.abs(returnPct);
    // 向长期均值回归
    const targetVol = annualVol / Math.sqrt(365 * 24 * 12);
    return newVol * 0.95 + targetVol * 0.05;
  }

  /**
   * 解析时间间隔
   */
  private parseInterval(interval: string): number {
    const unit = interval.slice(-1);
    const value = parseInt(interval.slice(0, -1)) || 1;
    
    const msPerUnit: Record<string, number> = {
      'm': 60 * 1000,
      'h': 60 * 60 * 1000,
      'd': 24 * 60 * 60 * 1000,
      'w': 7 * 24 * 60 * 60 * 1000,
    };
    
    return value * (msPerUnit[unit] || msPerUnit['m']);
  }

  /**
   * 标准正态分布（Box-Muller）
   */
  private randn(): number {
    const u1 = this.rng();
    const u2 = this.rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /**
   * 线性同余生成器（可重复随机）
   */
  private createRNG(seed: number): () => number {
    let s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    return () => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };
  }
}

// CLI 入口
if (import.meta.main) {
  const generator = new VirtualMarketGenerator(42); // 固定种子，可重复
  
  console.log('🎲 Virtual Market Generator\n');
  
  // 生成 30 天 15min 数据
  const symbol = VIRTUAL_SYMBOLS[0]; // BTC
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - 30 * 24 * 60 * 60 * 1000);
  
  console.log(`生成 ${symbol.name} 数据...`);
  console.log(`时间范围: ${startTime.toISOString()} → ${endTime.toISOString()}`);
  console.log(`时间周期: 15m\n`);
  
  const klines = generator.generateHistory(symbol, '15m', startTime, endTime);
  
  console.log(`✅ 生成 ${klines.length} 条 K 线`);
  console.log(`\n前 5 条:`);
  klines.slice(0, 5).forEach(k => {
    console.log(`  ${new Date(k.timestamp * 1000).toISOString()} O:${k.open.toFixed(2)} H:${k.high.toFixed(2)} L:${k.low.toFixed(2)} C:${k.close.toFixed(2)} V:${k.volume.toFixed(0)}`);
  });
  
  console.log(`\n后 5 条:`);
  klines.slice(-5).forEach(k => {
    console.log(`  ${new Date(k.timestamp * 1000).toISOString()} O:${k.open.toFixed(2)} H:${k.high.toFixed(2)} L:${k.low.toFixed(2)} C:${k.close.toFixed(2)} V:${k.volume.toFixed(0)}`);
  });
  
  // 统计
  const returns = klines.slice(1).map((k, i) => (k.close - klines[i].close) / klines[i].close);
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const volatility = Math.sqrt(returns.reduce((a, b) => a + b * b, 0) / returns.length);
  const totalReturn = (klines[klines.length - 1].close - klines[0].open) / klines[0].open;
  
  console.log(`\n📊 统计:`);
  console.log(`  总收益率: ${(totalReturn * 100).toFixed(2)}%`);
  console.log(`  日均收益: ${(avgReturn * 100).toFixed(4)}%`);
  console.log(`  日波动率: ${(volatility * 100).toFixed(2)}%`);
  console.log(`  最高价: ${Math.max(...klines.map(k => k.high)).toFixed(2)}`);
  console.log(`  最低价: ${Math.min(...klines.map(k => k.low)).toFixed(2)}`);
}
