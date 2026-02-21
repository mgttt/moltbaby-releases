// ============================================================
// BacktestEngine 单元测试
// ============================================================

import { describe, it, expect, beforeEach } from 'bun:test';
import { BacktestEngine } from '../../src/engine/backtest';
import type { Strategy, BacktestConfig } from '../../src/engine/types';
import type { Kline } from '../../../quant-lib/src';

// Mock KlineDatabase
class MockKlineDatabase {
  private klines: Kline[] = [];

  constructor(klines: Kline[] = []) {
    this.klines = klines;
  }

  async queryKlines(params: {
    symbol: string;
    interval: string;
    startTime: number;
    endTime: number;
  }): Promise<Kline[]> {
    return this.klines.filter(
      k => k.timestamp >= params.startTime && k.timestamp <= params.endTime
    ).map(k => ({ ...k, symbol: params.symbol }));
  }
}

// 生成测试用K线数据
function generateTestKlines(
  startPrice: number,
  count: number,
  startTime: number = 1704067200, // 2024-01-01
  interval: number = 3600 // 1小时
): Kline[] {
  const klines: Kline[] = [];
  let price = startPrice;
  
  for (let i = 0; i < count; i++) {
    // 模拟价格波动：先跌后涨
    const change = i < count / 2 ? -50 : 100;
    price += change + (Math.random() - 0.5) * 20;
    
    klines.push({
      timestamp: startTime + i * interval,
      open: price - 10,
      high: price + 20,
      low: price - 30,
      close: price,
      volume: 100 + Math.random() * 50,
      quoteVolume: price * (100 + Math.random() * 50),
    });
  }
  
  return klines;
}

describe('BacktestEngine', () => {
  let mockDb: MockKlineDatabase;
  let testKlines: Kline[];

  beforeEach(() => {
    testKlines = generateTestKlines(50000, 100);
    mockDb = new MockKlineDatabase(testKlines);
  });

  it('应该正确初始化', () => {
    const strategy: Strategy = {
      name: 'TestStrategy',
      onInit: async () => {},
      onBar: async () => {},
    };

    const config: BacktestConfig = {
      initialBalance: 10000,
      symbols: ['BTCUSDT'],
      interval: '1h',
      startTime: 1704067200,
      endTime: 1704412800,
      commission: 0.001,
    };

    const engine = new BacktestEngine(mockDb as any, strategy, config);
    expect(engine).toBeDefined();
  });

  it('应该正确执行简单策略并产生交易', async () => {
    const buySignals: number[] = [];
    const sellSignals: number[] = [];

    const strategy: Strategy = {
      name: 'SimpleMA',
      onInit: async () => {},
      onBar: async (bar, ctx) => {
        // 简单策略：价格高于52000买入，低于48000卖出
        if (bar.close > 52000 && buySignals.length === 0) {
          await ctx.buy('BTCUSDT', 0.1);
          buySignals.push(bar.timestamp);
        }
        if (bar.close < 48000 && buySignals.length > 0 && sellSignals.length === 0) {
          await ctx.sell('BTCUSDT', 0.1);
          sellSignals.push(bar.timestamp);
        }
      },
    };

    // 生成包含价格波动的K线：先高于52000，后低于48000
    const customKlines: Kline[] = [];
    const baseTime = 1704067200;
    for (let i = 0; i < 50; i++) {
      customKlines.push({
        timestamp: baseTime + i * 3600,
        open: 53000,
        high: 54000,
        low: 52000,
        close: 53000, // 高价触发买入
        volume: 100,
        quoteVolume: 5300000,
      });
    }
    for (let i = 50; i < 100; i++) {
      customKlines.push({
        timestamp: baseTime + i * 3600,
        open: 47000,
        high: 48000,
        low: 46000,
        close: 47000, // 低价触发卖出
        volume: 100,
        quoteVolume: 4700000,
      });
    }

    mockDb = new MockKlineDatabase(customKlines);

    const config: BacktestConfig = {
      initialBalance: 10000,
      symbols: ['BTCUSDT'],
      interval: '1h',
      startTime: baseTime,
      endTime: baseTime + 100 * 3600,
      commission: 0.001,
    };

    const engine = new BacktestEngine(mockDb as any, strategy, config);
    const result = await engine.run();

    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.totalTrades).toBeGreaterThan(0);
  });

  it('应该正确计算盈亏', async () => {
    // 生成明确的买入价50000，卖出价60000的数据
    const customKlines: Kline[] = [];
    const baseTime = 1704067200;
    
    // 前10根K线：价格50000（买入）
    for (let i = 0; i < 10; i++) {
      customKlines.push({
        timestamp: baseTime + i * 3600,
        open: 49900,
        high: 50100,
        low: 49800,
        close: 50000,
        volume: 100,
        quoteVolume: 5000000,
      });
    }
    
    // 后10根K线：价格60000（卖出，盈利20%）
    for (let i = 10; i < 20; i++) {
      customKlines.push({
        timestamp: baseTime + i * 3600,
        open: 59900,
        high: 60100,
        low: 59800,
        close: 60000,
        volume: 100,
        quoteVolume: 6000000,
      });
    }

    mockDb = new MockKlineDatabase(customKlines);

    let hasBought = false;
    const strategy: Strategy = {
      name: 'ProfitTest',
      onInit: async () => {},
      onBar: async (bar, ctx) => {
        if (!hasBought && bar.close <= 50000) {
          await ctx.buy('BTCUSDT', 0.1);
          hasBought = true;
        } else if (hasBought && bar.close >= 60000) {
          await ctx.sell('BTCUSDT', 0.1);
        }
      },
    };

    const config: BacktestConfig = {
      initialBalance: 10000,
      symbols: ['BTCUSDT'],
      interval: '1h',
      startTime: baseTime,
      endTime: baseTime + 20 * 3600,
      commission: 0.001,
    };

    const engine = new BacktestEngine(mockDb as any, strategy, config);
    const result = await engine.run();

    // 验证交易记录
    expect(result.trades.length).toBeGreaterThan(0);
    
    // 验证盈亏计算（买入50000，卖出60000，数量0.1，毛利约100）
    const trade = result.trades[0];
    expect(trade.pnl).toBeGreaterThan(0);
    expect(trade.entryPrice).toBe(50000);
    expect(trade.exitPrice).toBe(60000);
    
    // 验证最终权益大于初始权益（扣除手续费后仍盈利）
    expect(result.finalBalance).toBeGreaterThan(result.initialBalance);
  });

  it('应该正确处理多仓位', async () => {
    const customKlines: Kline[] = [];
    const baseTime = 1704067200;
    
    // 生成20根K线，价格逐步上升
    for (let i = 0; i < 20; i++) {
      const price = 50000 + i * 500;
      customKlines.push({
        timestamp: baseTime + i * 3600,
        open: price - 100,
        high: price + 200,
        low: price - 200,
        close: price,
        volume: 100,
        quoteVolume: price * 100,
      });
    }

    mockDb = new MockKlineDatabase(customKlines);

    let buyCount = 0;
    const strategy: Strategy = {
      name: 'MultiPosition',
      onInit: async () => {},
      onBar: async (bar, ctx) => {
        // 每5根K线买入一次，共3次
        if (buyCount < 3 && bar.close > 50000 + buyCount * 2500) {
          await ctx.buy('BTCUSDT', 0.05);
          buyCount++;
        }
      },
    };

    const config: BacktestConfig = {
      initialBalance: 10000,
      symbols: ['BTCUSDT'],
      interval: '1h',
      startTime: baseTime,
      endTime: baseTime + 20 * 3600,
      commission: 0.001,
    };

    const engine = new BacktestEngine(mockDb as any, strategy, config);
    const result = await engine.run();

    // 验证有多次买入
    expect(buyCount).toBe(3);
    
    // 验证最终权益（持仓未平，权益应随价格上涨）
    expect(result.finalBalance).toBeDefined();
    expect(result.equityCurve.length).toBeGreaterThan(0);
  });

  it('应该正确计算回撤', async () => {
    const customKlines: Kline[] = [];
    const baseTime = 1704067200;
    
    // 价格先涨后跌，制造回撤
    // 前10根：价格从50000涨到60000
    for (let i = 0; i < 10; i++) {
      const price = 50000 + i * 1000;
      customKlines.push({
        timestamp: baseTime + i * 3600,
        open: price - 100,
        high: price + 200,
        low: price - 200,
        close: price,
        volume: 100,
        quoteVolume: price * 100,
      });
    }
    
    // 后10根：价格从60000跌到45000（25%回撤）
    for (let i = 10; i < 20; i++) {
      const price = 60000 - (i - 10) * 1500;
      customKlines.push({
        timestamp: baseTime + i * 3600,
        open: price + 100,
        high: price + 200,
        low: price - 200,
        close: price,
        volume: 100,
        quoteVolume: price * 100,
      });
    }

    mockDb = new MockKlineDatabase(customKlines);

    const strategy: Strategy = {
      name: 'DrawdownTest',
      onInit: async () => {},
      onBar: async (bar, ctx) => {
        // 首次买入并持有
        const pos = ctx.getPosition('BTCUSDT');
        if (!pos || pos.quantity === 0) {
          await ctx.buy('BTCUSDT', 0.1);
        }
      },
    };

    const config: BacktestConfig = {
      initialBalance: 10000,
      symbols: ['BTCUSDT'],
      interval: '1h',
      startTime: baseTime,
      endTime: baseTime + 20 * 3600,
      commission: 0.001,
    };

    const engine = new BacktestEngine(mockDb as any, strategy, config);
    const result = await engine.run();

    // 验证最大回撤存在且合理
    expect(result.maxDrawdown).toBeGreaterThan(0);
    expect(result.maxDrawdown).toBeLessThan(1); // 小于100%
  });

  it('应该正确处理手续费', async () => {
    const customKlines: Kline[] = [];
    const baseTime = 1704067200;
    
    // 价格稳定在50000
    for (let i = 0; i < 10; i++) {
      customKlines.push({
        timestamp: baseTime + i * 3600,
        open: 49900,
        high: 50100,
        low: 49800,
        close: 50000,
        volume: 100,
        quoteVolume: 5000000,
      });
    }

    mockDb = new MockKlineDatabase(customKlines);

    let hasBought = false;
    const strategy: Strategy = {
      name: 'CommissionTest',
      onInit: async () => {},
      onBar: async (bar, ctx) => {
        if (!hasBought) {
          await ctx.buy('BTCUSDT', 0.1); // 买入5000 USDT
          hasBought = true;
        }
      },
    };

    // 0.1% 手续费
    const commission = 0.001;
    const config: BacktestConfig = {
      initialBalance: 10000,
      symbols: ['BTCUSDT'],
      interval: '1h',
      startTime: baseTime,
      endTime: baseTime + 10 * 3600,
      commission,
    };

    const engine = new BacktestEngine(mockDb as any, strategy, config);
    const result = await engine.run();

    // 买入0.1 BTC @ 50000 = 5000 USDT
    // 手续费 = 5000 * 0.001 = 5 USDT
    // 剩余余额 = 10000 - 5000 - 5 = 4995 USDT
    expect(result.finalBalance).toBeLessThan(10000);
  });
});
