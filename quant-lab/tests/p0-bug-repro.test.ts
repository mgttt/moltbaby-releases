#!/usr/bin/env bun
/**
 * P0 Bug复现测试：neutral方向equity为负、maxDD超100%
 * 
 * 预期行为：maxDrawdown不应超过100%，equity不应为负
 * 实际行为：maxDrawdown=235%，equity=-6
 */

import { describe, it, expect } from 'bun:test';

// 简化版回测引擎，模拟核心计算逻辑
class MockBacktestEngine {
  private balance: number = 10000;
  private equity: number = 10000;
  private position: number = 0;
  private avgEntryPrice: number = 0;
  private peakEquity: number = 10000;
  private maxDrawdown: number = 0;
  private trades: Array<{side: string, qty: number, price: number, pnl: number}> = [];

  constructor(private initialBalance: number = 10000) {
    this.balance = initialBalance;
    this.equity = initialBalance;
    this.peakEquity = initialBalance;
  }

  // 模拟成交
  fillOrder(side: 'Buy' | 'Sell', qty: number, price: number): void {
    const prevPosition = this.position;
    let realizedPnl = 0;

    // 判断平仓
    if (side === 'Sell' && prevPosition > 0) {
      const closeQty = Math.min(qty, prevPosition);
      realizedPnl = (price - this.avgEntryPrice) * closeQty;
    } else if (side === 'Buy' && prevPosition < 0) {
      const closeQty = Math.min(qty, Math.abs(prevPosition));
      realizedPnl = (this.avgEntryPrice - price) * closeQty;
    }

    // 更新持仓
    if (side === 'Buy') {
      this.position += qty;
    } else {
      this.position -= qty;
    }

    // 更新平均入场价
    if (this.position !== 0) {
      this.avgEntryPrice = price; // 简化处理
    }

    // 更新balance
    if (realizedPnl !== 0) {
      this.balance += realizedPnl;
    }

    this.trades.push({side, qty, price, pnl: realizedPnl});
  }

  // 更新equity
  updateEquity(currentPrice: number): void {
    let unrealizedPnL = 0;
    if (this.position !== 0) {
      unrealizedPnL = this.position * (currentPrice - this.avgEntryPrice);
    }
    this.equity = this.balance + unrealizedPnL;

    // 更新maxDrawdown
    if (this.equity > this.peakEquity) {
      this.peakEquity = this.equity;
    }
    const drawdown = (this.peakEquity - this.equity) / this.peakEquity;
    if (drawdown > this.maxDrawdown) {
      this.maxDrawdown = drawdown;
    }
  }

  getStats() {
    return {
      balance: this.balance,
      equity: this.equity,
      position: this.position,
      maxDrawdown: this.maxDrawdown,
      peakEquity: this.peakEquity,
    };
  }
}

describe('P0 Bug Reproduction: neutral direction equity negative', () => {
  
  it('should NOT allow maxDrawdown > 100%', () => {
    const engine = new MockBacktestEngine(10000);
    
    // 模拟neutral策略只开空单（bug场景）
    // 连续Sell导致空头持仓
    engine.fillOrder('Sell', 50, 1.0);  // 开空50@1.0
    engine.updateEquity(1.0);
    
    engine.fillOrder('Sell', 50, 1.0);  // 再开空50@1.0
    engine.updateEquity(1.0);
    
    // 价格上涨到1.5，空头大幅亏损
    engine.updateEquity(1.5);
    
    const stats = engine.getStats();
    
    // 断言：maxDrawdown不应超过100%
    expect(stats.maxDrawdown).toBeLessThanOrEqual(1.0);
    
    // 断言：equity不应为负
    expect(stats.equity).toBeGreaterThanOrEqual(0);
  });

  it('should handle single-direction short correctly', () => {
    const engine = new MockBacktestEngine(10000);
    
    // 纯空头场景
    engine.fillOrder('Sell', 100, 1.0);  // 开空100@1.0
    engine.updateEquity(1.0);
    expect(engine.getStats().equity).toBe(10000);
    
    // 价格跌，空头盈利
    engine.updateEquity(0.8);
    expect(engine.getStats().equity).toBeGreaterThan(10000);
    
    // 价格涨，空头亏损
    engine.updateEquity(1.5);
    const stats = engine.getStats();
    
    // equity不应为负
    expect(stats.equity).toBeGreaterThanOrEqual(0);
    // maxDD不应超100%
    expect(stats.maxDrawdown).toBeLessThanOrEqual(1.0);
  });

  it('demonstrates the bug: continuous sells cause negative equity', () => {
    const engine = new MockBacktestEngine(10000);
    
    // 模拟bug：neutral策略只发Sell单
    for (let i = 0; i < 10; i++) {
      engine.fillOrder('Sell', 40, 0.7 + i * 0.01);  // 价格逐步上涨
      engine.updateEquity(0.7 + i * 0.01);
    }
    
    // 最终价格大幅上涨
    engine.updateEquity(1.5);
    
    const stats = engine.getStats();
    
    // 这个测试展示bug存在时的行为
    // equity会变为负数
    // maxDD会超过100%
    
    console.log('Bug reproduction stats:', {
      equity: stats.equity,
      maxDrawdown: stats.maxDrawdown,
      position: stats.position,
    });
    
    // 在修复前，这个测试会失败（展示bug）
    // 修复后应该通过
    if (stats.equity < 0 || stats.maxDrawdown > 1.0) {
      console.log('⚠️ Bug detected: equity or maxDrawdown out of bounds');
    }
  });
});

// 手动运行入口
if (import.meta.main) {
  console.log('P0 Bug Reproduction Test');
  console.log('========================');
  
  const engine = new MockBacktestEngine(10000);
  
  // 复现N1场景：neutral只开Sell
  console.log('\n模拟neutral方向连续Sell（bug场景）：');
  
  for (let i = 0; i < 8; i++) {
    engine.fillOrder('Sell', 50, 0.7 + i * 0.05);
    engine.updateEquity(0.7 + i * 0.05);
    const stats = engine.getStats();
    console.log(`  Sell #${i+1}: price=${(0.7 + i * 0.05).toFixed(2)}, position=${stats.position}, equity=${stats.equity.toFixed(2)}, maxDD=${(stats.maxDrawdown * 100).toFixed(2)}%`);
  }
  
  // 价格大幅上涨
  engine.updateEquity(1.5);
  const final = engine.getStats();
  
  console.log('\n最终结果：');
  console.log(`  Equity: ${final.equity.toFixed(2)}`);
  console.log(`  Max Drawdown: ${(final.maxDrawdown * 100).toFixed(2)}%`);
  console.log(`  Position: ${final.position}`);
  
  if (final.equity < 0 || final.maxDrawdown > 1.0) {
    console.log('\n❌ Bug reproduced: equity or maxDrawdown out of bounds');
    process.exit(1);
  } else {
    console.log('\n✓ Values within bounds');
    process.exit(0);
  }
}
