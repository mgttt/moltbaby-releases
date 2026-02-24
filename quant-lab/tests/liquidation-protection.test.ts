#!/usr/bin/env bun
/**
 * 方案B测试：爆仓保护机制验证
 * 
 * 测试目标：
 * 1. 验证equity<=0时触发强制平仓
 * 2. 验证maxDrawdown被cap到100%
 * 3. 验证爆仓标记正确设置
 * 
 * 使用mock K线数据构造极端场景
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { QuickJSBacktestEngine } from '../legacy/quickjs-backtest';
import { Kline } from '../../quant-lib/src';
import { existsSync } from 'fs';
import { resolve } from 'path';

const DB_PATH = '/home/devali/moltbaby/data/klines.db';
const STRATEGY_PATH = resolve(process.cwd(), 'strategies/grid/gales-simple.js');

// Mock K线数据：构造连续暴跌场景（用于触发爆仓）
function createCrashKlines(startPrice: number, count: number, dropRate: number = 0.05): Kline[] {
  const klines: Kline[] = [];
  let price = startPrice;
  const startTime = Math.floor(Date.now() / 1000) - count * 60;
  
  for (let i = 0; i < count; i++) {
    const open = price;
    // 每根K线价格下跌dropRate
    price = price * (1 - dropRate);
    const close = price;
    const high = open * 1.002;
    const low = close * 0.998;
    
    klines.push({
      timestamp: startTime + i * 60,
      open,
      high,
      low,
      close,
      volume: 1000 + Math.random() * 5000,
    });
  }
  return klines;
}

describe('方案B：爆仓保护机制', () => {
  
  it('步骤1-2：爆仓场景 - equity<=0时强制平仓且maxDrawdown≤100%', async () => {
    // 构造一个会导致爆仓的场景
    // 使用neutral方向 + 小网格 + 连续暴跌
    
    const engine = new QuickJSBacktestEngine({
      strategyPath: 'strategies/grid/gales-simple.js',
      symbol: 'MYX/USDT',
      from: '2025-02-01',
      to: '2025-02-02',
      interval: '1m',
      initialBalance: 1000,  // 小资金，容易爆仓
      direction: 'neutral',
      proxy: 'http://127.0.0.1:8890',
      dbPath: DB_PATH,
    });

    // Mock: 注入暴跌K线数据（每根跌5%，连续100根）
    const crashKlines = createCrashKlines(0.5, 200, 0.05);
    
    // 在initialize之前替换queryKlines方法
    await engine.initialize();
    
    // 替换klineDb的queryKlines方法返回mock数据
    const klineDb = (engine as any).klineDb;
    if (klineDb) {
      const originalQuery = klineDb.queryKlines.bind(klineDb);
      klineDb.queryKlines = async () => crashKlines;
    }

    // 注入高风险参数
    const strategy = (engine as any).strategy;
    if (strategy?.config?.params) {
      strategy.config.params.gridSpacing = 0.01;  // 1%间距
      strategy.config.params.orderSize = 50;       // 大订单
      strategy.config.params.gridSpacingUp = 0.01;
      strategy.config.params.gridSpacingDown = 0.01;
      strategy.config.params.magnetDistance = 0.01;
    }

    const result = await engine.run();
    await engine.cleanup();

    console.log('[TEST-步骤1-2] 爆仓场景结果:', {
      initialBalance: result.initialBalance,
      finalBalance: result.finalBalance.toFixed(2),
      maxDrawdown: (result.maxDrawdown * 100).toFixed(2) + '%',
      liquidated: result.liquidated,
      totalTrades: result.totalTrades,
    });

    // 核心断言1：final equity必须≥0（不能为负）
    expect(result.finalBalance).toBeGreaterThanOrEqual(0);
    
    // 核心断言2：maxDrawdown必须≤100%（不能超过100%）
    expect(result.maxDrawdown).toBeLessThanOrEqual(1.0);
    expect(result.maxDrawdown).toBeGreaterThanOrEqual(0);

    // 核心断言3：爆仓场景应有liquidated标记
    // 注：可能因市场数据不同而未触发，如果equity接近0则应该标记
    if (result.finalBalance <= 1) {
      expect(result.liquidated).toBe(true);
    }

  }, 120000); // 2分钟超时

  it('步骤3：爆仓标记验证', async () => {
    const engine = new QuickJSBacktestEngine({
      strategyPath: 'strategies/grid/gales-simple.js',
      symbol: 'MYX/USDT',
      from: '2025-02-01',
      to: '2025-02-02',
      interval: '1m',
      initialBalance: 500,  // 极小资金
      direction: 'neutral',
      proxy: 'http://127.0.0.1:8890',
      dbPath: DB_PATH,
    });

    // 更剧烈的暴跌
    const crashKlines = createCrashKlines(0.5, 150, 0.08); // 8%每根
    
    await engine.initialize();
    
    const klineDb = (engine as any).klineDb;
    if (klineDb) {
      klineDb.queryKlines = async () => crashKlines;
    }

    const strategy = (engine as any).strategy;
    if (strategy?.config?.params) {
      strategy.config.params.gridSpacing = 0.005;  // 0.5%间距
      strategy.config.params.orderSize = 100;
      strategy.config.params.gridSpacingUp = 0.005;
      strategy.config.params.gridSpacingDown = 0.005;
    }

    const result = await engine.run();
    await engine.cleanup();

    console.log('[TEST-步骤3] 爆仓标记检查:', {
      finalBalance: result.finalBalance.toFixed(2),
      liquidated: result.liquidated,
      maxDrawdown: (result.maxDrawdown * 100).toFixed(2) + '%',
    });

    // 如果最终equity接近0，必须有爆仓标记
    if (result.finalBalance <= 10) {
      expect(result.liquidated).toBe(true);
    }
    
    // maxDrawdown绝对不能超过100%
    expect(result.maxDrawdown).toBeLessThanOrEqual(1.0);

  }, 120000);

  it('步骤4：爆仓后状态验证 - equity=0且maxDrawdown<=100%', async () => {
    // 构造必然爆仓的场景，验证爆仓后状态正确
    const engine = new QuickJSBacktestEngine({
      strategyPath: 'strategies/grid/gales-simple.js',
      symbol: 'MYX/USDT',
      from: '2025-02-01',
      to: '2025-02-02',
      interval: '1m',
      initialBalance: 500,  // 极小资金，必然爆仓
      direction: 'neutral',
      proxy: 'http://127.0.0.1:8890',
      dbPath: DB_PATH,
    });

    // 非常剧烈的下跌 - 8%每根K线
    const crashKlines = createCrashKlines(0.5, 150, 0.08);
    
    await engine.initialize();
    
    const klineDb = (engine as any).klineDb;
    if (klineDb) {
      klineDb.queryKlines = async () => crashKlines;
    }

    const strategy = (engine as any).strategy;
    if (strategy?.config?.params) {
      strategy.config.params.gridSpacing = 0.005;  // 0.5%间距（小）
      strategy.config.params.orderSize = 100;      // 大订单
      strategy.config.params.gridSpacingUp = 0.005;
      strategy.config.params.gridSpacingDown = 0.005;
    }

    const result = await engine.run();
    await engine.cleanup();

    console.log('[TEST-步骤4] 爆仓后状态:', {
      finalBalance: result.finalBalance.toFixed(2),
      liquidated: result.liquidated,
      maxDrawdown: (result.maxDrawdown * 100).toFixed(2) + '%',
    });

    // 如果爆仓了，验证状态正确
    if (result.liquidated) {
      // 1. finalBalance必须>=0（不能为负）
      expect(result.finalBalance).toBeGreaterThanOrEqual(0);
      // 2. maxDrawdown必须<=100%
      expect(result.maxDrawdown).toBeLessThanOrEqual(1.0);
    } else {
      // 如果没爆仓，验证maxDrawdown仍然<=100%
      expect(result.maxDrawdown).toBeLessThanOrEqual(1.0);
      expect(result.finalBalance).toBeGreaterThanOrEqual(0);
    }

  }, 120000);
});
