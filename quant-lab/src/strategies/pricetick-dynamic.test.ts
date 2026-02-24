/**
 * priceTick动态获取测试
 * 
 * 验证GalesStrategy正确从config或交易所获取priceTick
 */

import { createLogger } from '../utils/logger';
const logger = createLogger('pricetick-dynamic.test');

import { describe, it, expect, beforeEach } from 'bun:test';
import { GalesStrategy, GalesConfig } from './GalesStrategy';
import { StrategyContext } from '../engine/types';

// 模拟StrategyContext
const mockContext: StrategyContext = {
  symbol: 'BTCUSDT',
  provider: {
    placeOrder: async () => ({ id: 'test-order', status: 'OPEN' } as any),
    cancelOrder: async () => {},
    getBalance: async () => ({ available: 10000, locked: 0 }),
    getPosition: async () => null,
  } as any,
  notify: async () => {},
  getState: () => ({}),
  setState: () => {},
};

describe('GalesStrategy priceTick动态获取', () => {
  it('应该使用config中指定的priceTick', async () => {
    const config: GalesConfig = {
      symbol: 'BTCUSDT',
      gridCount: 4,
      gridSpacing: 0.01,
      orderSize: 100,
      maxPosition: 1000,
      magnetDistance: 0.002,
      cancelDistance: 0.005,
      priceOffset: 0.0005,
      priceTick: 0.5, // 手动指定priceTick
    };

    const strategy = new GalesStrategy(config);
    await strategy.onInit(mockContext);

    // 验证symbolInfo使用了config中的priceTick
    expect(strategy.symbolInfo?.priceTick).toBe(0.5);
  });

  it('不同品种应有不同的priceTick精度', async () => {
    const testCases = [
      { symbol: 'BTCUSDT', expectedPriceTick: 0.1 },
      { symbol: 'ETHUSDT', expectedPriceTick: 0.01 },
      { symbol: 'MYXUSDT', expectedPriceTick: 0.0001 },
      { symbol: 'SOLUSDT', expectedPriceTick: 0.01 },
    ];

    for (const { symbol, expectedPriceTick } of testCases) {
      const config: GalesConfig = {
        symbol,
        gridCount: 4,
        gridSpacing: 0.01,
        orderSize: 100,
        maxPosition: 1000,
        magnetDistance: 0.002,
        cancelDistance: 0.005,
        priceOffset: 0.0005,
        // 不指定priceTick，应从默认配置获取
      };

      const strategy = new GalesStrategy(config);
      await strategy.onInit(mockContext);

      expect(strategy.symbolInfo?.priceTick).toBe(expectedPriceTick);
      logger.info(`✓ ${symbol}: priceTick=${strategy.symbolInfo?.priceTick}`);
    }
  });

  it('未知品种应使用默认priceTick 0.01', async () => {
    const config: GalesConfig = {
      symbol: 'UNKNOWNUSDT',
      gridCount: 4,
      gridSpacing: 0.01,
      orderSize: 100,
      maxPosition: 1000,
      magnetDistance: 0.002,
      cancelDistance: 0.005,
      priceOffset: 0.0005,
    };

    const strategy = new GalesStrategy(config);
    await strategy.onInit(mockContext);

    // 未知USDT品种默认priceTick为0.01
    expect(strategy.symbolInfo?.priceTick).toBe(0.01);
  });

  it('价格格式化应符合priceTick精度', async () => {
    const { formatPrice } = await import('./symbol-info');
    
    // BTC priceTick=0.1，价格应格式化为0.1的倍数
    expect(formatPrice(50000.33, 0.1)).toBe(50000.3);
    expect(formatPrice(50000.55, 0.1)).toBe(50000.6);
    
    // ETH priceTick=0.01，价格应格式化为0.01的倍数
    expect(formatPrice(3000.333, 0.01)).toBe(3000.33);
    expect(formatPrice(3000.555, 0.01)).toBe(3000.56);
    
    // MYX priceTick=0.0001，价格应格式化为0.0001的倍数
    expect(formatPrice(0.01234, 0.0001)).toBe(0.0123);
    expect(formatPrice(0.01235, 0.0001)).toBe(0.0124);
  });

  it('订单价格应符合交易所精度要求', async () => {
    const { isValidPrice } = await import('./symbol-info');
    
    // BTC: priceTick=0.1
    expect(isValidPrice(50000.1, 0.1)).toBe(true);
    expect(isValidPrice(50000.15, 0.1)).toBe(false);
    
    // ETH: priceTick=0.01
    expect(isValidPrice(3000.01, 0.01)).toBe(true);
    expect(isValidPrice(3000.015, 0.01)).toBe(false);
    
    // MYX: priceTick=0.0001
    expect(isValidPrice(0.0001, 0.0001)).toBe(true);
    expect(isValidPrice(0.00005, 0.0001)).toBe(false);
  });

  it('切换交易对时应自动获取对应priceTick', async () => {
    // 先创建BTC策略
    const btcConfig: GalesConfig = {
      symbol: 'BTCUSDT',
      gridCount: 4,
      gridSpacing: 0.01,
      orderSize: 100,
      maxPosition: 1000,
      magnetDistance: 0.002,
      cancelDistance: 0.005,
      priceOffset: 0.0005,
    };
    const btcStrategy = new GalesStrategy(btcConfig);
    await btcStrategy.onInit(mockContext);
    expect(btcStrategy.symbolInfo?.priceTick).toBe(0.1);

    // 再创建ETH策略
    const ethConfig: GalesConfig = {
      symbol: 'ETHUSDT',
      gridCount: 4,
      gridSpacing: 0.01,
      orderSize: 100,
      maxPosition: 1000,
      magnetDistance: 0.002,
      cancelDistance: 0.005,
      priceOffset: 0.0005,
    };
    const ethStrategy = new GalesStrategy(ethConfig);
    await ethStrategy.onInit(mockContext);
    expect(ethStrategy.symbolInfo?.priceTick).toBe(0.01);

    logger.info('✓ BTC策略priceTick=0.1, ETH策略priceTick=0.01');
  });
});
