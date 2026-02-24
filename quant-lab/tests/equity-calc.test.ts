#!/usr/bin/env bun
/**
 * P0: 回测引擎equity计算单元测试
 * 
 * 验证修复后的equity计算逻辑
 * 运行: bun test test-equity-calc.ts
 */

import { describe, it, expect } from 'bun:test';

// 直接测试equity计算逻辑（不依赖完整引擎）
// 模拟QuickJSBacktestEngine的核心计算

class MockBacktestEngine {
  private balance: number = 10000;
  private position: number = 0;
  private positionNotional: number = 0;
  private avgEntryPrice: number = 0;
  private equity: number = 10000;
  private totalPnL: number = 0;

  constructor(initialBalance: number = 10000) {
    this.balance = initialBalance;
    this.equity = initialBalance;
  }

  // 模拟成交
  fillOrder(side: 'Buy' | 'Sell', qty: number, price: number): void {
    const prevPosition = this.position;
    const prevAvgEntry = this.avgEntryPrice;
    let realizedPnl = 0;

    if (side === 'Sell' && prevPosition > 0) {
      // Sell 平多仓
      const closeQty = Math.min(qty, prevPosition);
      realizedPnl = (price - prevAvgEntry) * closeQty;
    } else if (side === 'Buy' && prevPosition < 0) {
      // Buy 平空仓
      const closeQty = Math.min(qty, Math.abs(prevPosition));
      realizedPnl = (prevAvgEntry - price) * closeQty;
    }

    // 更新持仓
    const notional = qty * price;
    if (side === 'Buy') {
      this.positionNotional += notional;
      this.position += qty;
    } else {
      this.positionNotional -= notional;
      this.position -= qty;
    }

    // 计算平均入场价
    if (this.position !== 0) {
      this.avgEntryPrice = Math.abs(this.positionNotional / this.position);
    }

    // P0修复：平仓时realizedPnL加到balance
    if (realizedPnl !== 0) {
      this.balance += realizedPnl;
    }
    this.totalPnL += realizedPnl;
  }

  // P0修复：更新equity
  updateEquity(currentPrice: number): void {
    let unrealizedPnL = 0;
    if (this.position !== 0) {
      // P0修复：多头价格上涨=盈利；空头价格下跌=盈利
      unrealizedPnL = this.position * (currentPrice - this.avgEntryPrice);
    }
    // P0修复：equity = balance + unrealizedPnL（不加positionNotional）
    this.equity = this.balance + unrealizedPnL;
  }

  getAccount() {
    return {
      balance: this.balance,
      equity: this.equity,
      position: this.position,
      avgEntryPrice: this.avgEntryPrice,
      totalPnL: this.totalPnL,
    };
  }
}

describe('P0 Equity Calculation Tests', () => {

  it('Test 1: Short position, price drops, equity increases', () => {
    // 开空100@1.0 → 价格0.9 → equity=10010
    const engine = new MockBacktestEngine(10000);
    
    // 开空100@1.0 (Sell开仓)
    engine.fillOrder('Sell', 100, 1.0);
    engine.updateEquity(0.9);
    
    const account = engine.getAccount();
    // position = -100, avgEntryPrice = 1.0
    // unrealizedPnL = (-100) * (0.9 - 1.0) = +10
    // equity = 10000 + 10 = 10010
    expect(account.equity).toBeCloseTo(10010, 1);
    console.log('Test 1 PASS: equity=' + account.equity.toFixed(2));
  });

  it('Test 2: Close short position, balance and equity match', () => {
    // 平空100@0.9 → balance=10010, equity=10010
    const engine = new MockBacktestEngine(10000);
    
    // 开空100@1.0
    engine.fillOrder('Sell', 100, 1.0);
    engine.updateEquity(0.9);
    
    // 平空100@0.9 (Buy平仓)
    engine.fillOrder('Buy', 100, 0.9);
    engine.updateEquity(0.9);
    
    const account = engine.getAccount();
    // realizedPnL = (1.0 - 0.9) * 100 = +10
    // balance = 10000 + 10 = 10010
    // equity = 10010 + 0 = 10010 (position=0)
    expect(account.balance).toBeCloseTo(10010, 1);
    expect(account.equity).toBeCloseTo(10010, 1);
    console.log('Test 2 PASS: balance=' + account.balance.toFixed(2) + ', equity=' + account.equity.toFixed(2));
  });

  it('Test 3: Long position, price rises, equity increases', () => {
    // 开多100@1.0 → 价格1.1 → equity=10020
    const engine = new MockBacktestEngine(10000);
    
    // 开多100@1.0
    engine.fillOrder('Buy', 100, 1.0);
    engine.updateEquity(1.1);
    
    const account = engine.getAccount();
    // position = 100, avgEntryPrice = 1.0
    // unrealizedPnL = 100 * (1.1 - 1.0) = +10
    // equity = 10000 + 10 = 10010
    expect(account.equity).toBeCloseTo(10010, 1);
    console.log('Test 3 PASS: equity=' + account.equity.toFixed(2));
  });

  it('Test 4: Close long position, balance and equity match', () => {
    // 平多100@1.1 → balance=10020, equity=10020
    const engine = new MockBacktestEngine(10000);
    
    // 开多100@1.0
    engine.fillOrder('Buy', 100, 1.0);
    engine.updateEquity(1.1);
    
    // 平多100@1.1 (Sell平仓)
    engine.fillOrder('Sell', 100, 1.1);
    engine.updateEquity(1.1);
    
    const account = engine.getAccount();
    // realizedPnL = (1.1 - 1.0) * 100 = +10
    // balance = 10000 + 10 = 10010
    // equity = 10010 + 0 = 10010 (position=0)
    expect(account.balance).toBeCloseTo(10010, 1);
    expect(account.equity).toBeCloseTo(10010, 1);
    console.log('Test 4 PASS: balance=' + account.balance.toFixed(2) + ', equity=' + account.equity.toFixed(2));
  });

  it('Test 5: Partial close short position', () => {
    // 开空200@1.0 → 平空100@0.9 → 再平空100@0.85
    const engine = new MockBacktestEngine(10000);
    
    // 开空200@1.0
    engine.fillOrder('Sell', 200, 1.0);
    engine.updateEquity(0.9);
    
    // 部分平仓100@0.9
    engine.fillOrder('Buy', 100, 0.9);
    engine.updateEquity(0.9);
    
    const account1 = engine.getAccount();
    // realizedPnL1 = (1.0 - 0.9) * 100 = +10
    // balance = 10000 + 10 = 10010
    // 剩余仓位：-100@1.0， unrealizedPnL = (-100) * (0.9 - 1.0) = +10
    // equity = 10010 + 10 = 10020
    expect(account1.balance).toBeCloseTo(10010, 1);
    console.log('Test 5a PASS: after partial close balance=' + account1.balance.toFixed(2));
    
    // 再平仓剩余100@0.85
    engine.fillOrder('Buy', 100, 0.85);
    engine.updateEquity(0.85);
    
    const account2 = engine.getAccount();
    // realizedPnL2 = (1.0 - 0.85) * 100 = +15
    // total realized = 10 + 15 = 25
    // balance = 10000 + 25 = 10025
    // equity = 10025 + 0 = 10025 (position=0)
    expect(account2.balance).toBeCloseTo(10025, 1);
    expect(account2.equity).toBeCloseTo(10025, 1);
    console.log('Test 5b PASS: final balance=' + account2.balance.toFixed(2));
  });

  it('Test 6: Flip position from short to long', () => {
    // 开空100@1.0 → 平空100@0.9 → 开多100@0.9 → 平多100@1.0
    const engine = new MockBacktestEngine(10000);
    
    // 开空100@1.0
    engine.fillOrder('Sell', 100, 1.0);
    
    // 平空100@0.9（盈利+10）
    engine.fillOrder('Buy', 100, 0.9);
    engine.updateEquity(0.9);
    
    const account1 = engine.getAccount();
    expect(account1.balance).toBeCloseTo(10010, 1);
    console.log('Test 6a PASS: after close short balance=' + account1.balance.toFixed(2));
    
    // 开多100@0.9
    engine.fillOrder('Buy', 100, 0.9);
    
    // 平多100@1.0（盈利+10）
    engine.fillOrder('Sell', 100, 1.0);
    engine.updateEquity(1.0);
    
    const account2 = engine.getAccount();
    // total realized = 10 + 10 = 20
    // balance = 10000 + 20 = 10020
    // equity = 10020 (position=0)
    expect(account2.balance).toBeCloseTo(10020, 1);
    expect(account2.equity).toBeCloseTo(10020, 1);
    console.log('Test 6b PASS: final balance=' + account2.balance.toFixed(2));
  });
});

// 手动运行入口
if (import.meta.main) {
  console.log('Running P0 equity calculation tests...\n');
  
  // 简单运行所有测试
  const tests = [
    { name: 'Test 1: Short position, price drops', fn: () => {
      const engine = new MockBacktestEngine(10000);
      engine.fillOrder('Sell', 100, 1.0);
      engine.updateEquity(0.9);
      const acc = engine.getAccount();
      if (Math.abs(acc.equity - 10010) > 0.1) throw new Error(`Expected 10010, got ${acc.equity}`);
      return 'PASS';
    }},
    { name: 'Test 2: Close short position', fn: () => {
      const engine = new MockBacktestEngine(10000);
      engine.fillOrder('Sell', 100, 1.0);
      engine.updateEquity(0.9);
      engine.fillOrder('Buy', 100, 0.9);
      engine.updateEquity(0.9);
      const acc = engine.getAccount();
      if (Math.abs(acc.balance - 10010) > 0.1) throw new Error(`Expected balance 10010, got ${acc.balance}`);
      if (Math.abs(acc.equity - 10010) > 0.1) throw new Error(`Expected equity 10010, got ${acc.equity}`);
      return 'PASS';
    }},
    { name: 'Test 3: Long position, price rises', fn: () => {
      const engine = new MockBacktestEngine(10000);
      engine.fillOrder('Buy', 100, 1.0);
      engine.updateEquity(1.1);
      const acc = engine.getAccount();
      if (Math.abs(acc.equity - 10010) > 0.1) throw new Error(`Expected 10010, got ${acc.equity}`);
      return 'PASS';
    }},
    { name: 'Test 4: Close long position', fn: () => {
      const engine = new MockBacktestEngine(10000);
      engine.fillOrder('Buy', 100, 1.0);
      engine.updateEquity(1.1);
      engine.fillOrder('Sell', 100, 1.1);
      engine.updateEquity(1.1);
      const acc = engine.getAccount();
      if (Math.abs(acc.balance - 10010) > 0.1) throw new Error(`Expected 10010, got ${acc.balance}`);
      if (Math.abs(acc.equity - 10010) > 0.1) throw new Error(`Expected 10010, got ${acc.equity}`);
      return 'PASS';
    }},
    { name: 'Test 5: Partial close short', fn: () => {
      const engine = new MockBacktestEngine(10000);
      engine.fillOrder('Sell', 200, 1.0);
      engine.updateEquity(0.9);
      engine.fillOrder('Buy', 100, 0.9);
      engine.updateEquity(0.9);
      engine.fillOrder('Buy', 100, 0.85);
      engine.updateEquity(0.85);
      const acc = engine.getAccount();
      // realizedPnL1 = (1.0-0.9)*100 = 10
      // realizedPnL2 = (1.0-0.85)*100 = 15
      // total = 25, balance = 10025
      if (Math.abs(acc.balance - 10025) > 0.1) throw new Error(`Expected balance 10025, got ${acc.balance}`);
      if (Math.abs(acc.equity - 10025) > 0.1) throw new Error(`Expected equity 10025, got ${acc.equity}`);
      return 'PASS';
    }},
    { name: 'Test 6: Flip position', fn: () => {
      const engine = new MockBacktestEngine(10000);
      engine.fillOrder('Sell', 100, 1.0);
      engine.fillOrder('Buy', 100, 0.9);
      engine.updateEquity(0.9);
      const acc1 = engine.getAccount();
      if (Math.abs(acc1.balance - 10010) > 0.1) throw new Error(`Expected 10010, got ${acc1.balance}`);
      
      engine.fillOrder('Buy', 100, 0.9);
      engine.fillOrder('Sell', 100, 1.0);
      engine.updateEquity(1.0);
      const acc2 = engine.getAccount();
      // short realizedPnL = (1.0-0.9)*100 = 10
      // long realizedPnL = (1.0-0.9)*100 = 10
      // total = 20, balance = 10020
      if (Math.abs(acc2.balance - 10020) > 0.1) throw new Error(`Expected balance 10020, got ${acc2.balance}`);
      if (Math.abs(acc2.equity - 10020) > 0.1) throw new Error(`Expected equity 10020, got ${acc2.equity}`);
      return 'PASS';
    }},
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const test of tests) {
    try {
      const result = test.fn();
      console.log(`✅ ${test.name}: ${result}`);
      passed++;
    } catch (e: any) {
      console.log(`❌ ${test.name}: FAIL - ${e.message}`);
      failed++;
    }
  }
  
  console.log(`\n${passed}/${tests.length} tests passed`);
  process.exit(failed > 0 ? 1 : 0);
}
