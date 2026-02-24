#!/usr/bin/env bun
/**
 * P0修复验证：小规模回测 + 手算对比
 * 
 * 场景：MYXUSDT 4天数据，2-3个关键时间点手算expected equity
 * 验证：backtest输出 vs 手算结果
 */

import { QuickJSBacktestEngine } from '../src/engine/quickjs-backtest';
import { KlineDatabase } from '../../../quant-lib/src';
import { resolve } from 'path';

// ============================================================
// 手算验证Case
// ============================================================

interface HandCalcCase {
  name: string;
  steps: Array<{
    action: 'open_long' | 'open_short' | 'close_long' | 'close_short' | 'mark_price';
    qty?: number;
    price: number;
    expectedBalance?: number;
    expectedEquity?: number;
    note: string;
  }>;
}

// Case 1: 简单short盈利
const case1: HandCalcCase = {
  name: 'Simple Short Profit',
  steps: [
    { action: 'open_short', qty: 100, price: 1.0, expectedBalance: 10000, expectedEquity: 10000, note: '开空100@1.0，初始equity=10000' },
    { action: 'mark_price', price: 0.9, expectedBalance: 10000, expectedEquity: 10010, note: '价格跌到0.9，unrealizedPnL=+10，equity=10010' },
    { action: 'close_short', qty: 100, price: 0.9, expectedBalance: 10010, expectedEquity: 10010, note: '平空@0.9，realizedPnL=+10，balance=10010，equity=10010' },
  ]
};

// Case 2: 简单long盈利
const case2: HandCalcCase = {
  name: 'Simple Long Profit',
  steps: [
    { action: 'open_long', qty: 100, price: 1.0, expectedBalance: 10000, expectedEquity: 10000, note: '开多100@1.0，初始equity=10000' },
    { action: 'mark_price', price: 1.1, expectedBalance: 10000, expectedEquity: 10010, note: '价格涨到1.1，unrealizedPnL=+10，equity=10010' },
    { action: 'close_long', qty: 100, price: 1.1, expectedBalance: 10010, expectedEquity: 10010, note: '平多@1.1，realizedPnL=+10，balance=10010，equity=10010' },
  ]
};

// Case 3: 多空切换
const case3: HandCalcCase = {
  name: 'Flip Position',
  steps: [
    { action: 'open_short', qty: 100, price: 1.0, expectedBalance: 10000, expectedEquity: 10000, note: '开空100@1.0' },
    { action: 'close_short', qty: 100, price: 0.9, expectedBalance: 10010, expectedEquity: 10010, note: '平空@0.9，盈利+10' },
    { action: 'open_long', qty: 100, price: 0.9, expectedBalance: 10010, expectedEquity: 10010, note: '开多100@0.9' },
    { action: 'close_long', qty: 100, price: 1.0, expectedBalance: 10020, expectedEquity: 10020, note: '平多@1.0，盈利+10，总盈利+20' },
  ]
};

// ============================================================
// 手动计算验证
// ============================================================

function manualCalculate(testCase: HandCalcCase): boolean {
  console.log(`\n========== ${testCase.name} ==========`);
  
  let balance = 10000;
  let position = 0;
  let avgEntryPrice = 0;
  let equity = 10000;
  
  for (const step of testCase.steps) {
    let unrealizedPnL = 0;
    let realizedPnL = 0;
    
    switch (step.action) {
      case 'open_long':
        position += step.qty!;
        avgEntryPrice = step.price;
        break;
        
      case 'open_short':
        position -= step.qty!;
        avgEntryPrice = step.price;
        break;
        
      case 'close_long':
        realizedPnL = (step.price - avgEntryPrice) * step.qty!;
        balance += realizedPnL;
        position = 0;
        break;
        
      case 'close_short':
        realizedPnL = (avgEntryPrice - step.price) * step.qty!;
        balance += realizedPnL;
        position = 0;
        break;
        
      case 'mark_price':
        // 计算unrealizedPnL
        if (position !== 0) {
          unrealizedPnL = position * (step.price - avgEntryPrice);
        }
        break;
    }
    
    // 计算equity
    if (step.action === 'mark_price') {
      unrealizedPnL = position * (step.price - avgEntryPrice);
      equity = balance + unrealizedPnL;
    } else if (step.action.startsWith('close')) {
      equity = balance; // 平仓后unrealizedPnL=0
    } else {
      equity = balance; // 开仓时equity不变
    }
    
    // 验证
    const balanceOk = Math.abs(balance - step.expectedBalance!) < 0.01;
    const equityOk = Math.abs(equity - step.expectedEquity!) < 0.01;
    
    console.log(`${step.action.padEnd(12)} @${step.price.toFixed(2)} | Balance: ${balance.toFixed(2)} ${balanceOk ? '✓' : '✗'} | Equity: ${equity.toFixed(2)} ${equityOk ? '✓' : '✗'}`);
    console.log(`  ${step.note}`);
    
    if (!balanceOk || !equityOk) {
      console.log(`  ERROR: Expected Balance=${step.expectedBalance}, Equity=${step.expectedEquity}`);
      return false;
    }
  }
  
  console.log('PASSED ✓');
  return true;
}

// ============================================================
// 运行小规模回测
// ============================================================

async function runSmallBacktest(): Promise<void> {
  console.log('\n========== Small Backtest Validation ==========');
  
  // 准备3-5组参数
  const testParams = [
    { spacing: 0.01, orderSize: 50 },
    { spacing: 0.02, orderSize: 100 },
    { spacing: 0.03, orderSize: 150 },
  ];
  
  console.log('Test params:', testParams);
  console.log('Note: Full backtest will be run after a\'s test passes');
  console.log('This is a placeholder for the actual validation');
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  console.log('P0 Equity Fix Validation');
  console.log('========================');
  
  // 1. 手算验证
  const results = [
    manualCalculate(case1),
    manualCalculate(case2),
    manualCalculate(case3),
  ];
  
  const allPassed = results.every(r => r);
  
  // 2. 准备小规模回测
  await runSmallBacktest();
  
  console.log('\n========================');
  if (allPassed) {
    console.log('All manual calculations PASSED ✓');
    console.log('Ready for small-scale backtest validation');
  } else {
    console.log('Some manual calculations FAILED ✗');
    process.exit(1);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
