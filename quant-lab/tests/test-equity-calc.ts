#!/usr/bin/env bun
/**
 * Equity计算完整测试Case (6场景)
 * 验证回测引擎的balance更新、 unrealizedPnL符号、平仓逻辑
 * 
 * 运行: bun tests/test-equity-calc.ts
 */

interface Position {
  side: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
}

interface Account {
  balance: number;
  position: Position | null;
}

// 计算unrealizedPnL
function calcUnrealizedPnL(position: Position, currentPrice: number): number {
  if (position.side === 'LONG') {
    return (currentPrice - position.entryPrice) * position.quantity;
  } else {
    return (position.entryPrice - currentPrice) * position.quantity;
  }
}

// 计算equity
function calcEquity(account: Account, currentPrice: number): number {
  if (!account.position) {
    return account.balance;
  }
  return account.balance + calcUnrealizedPnL(account.position, currentPrice);
}

// 开仓
function openPosition(account: Account, side: 'LONG' | 'SHORT', quantity: number, price: number): void {
  if (account.position) {
    throw new Error(`已有仓位，无法开仓: ${account.position.side}`);
  }
  account.position = { side, quantity, entryPrice: price };
}

// 平仓（返回 realizedPnL）
function closePosition(account: Account, currentPrice: number): number {
  if (!account.position) {
    throw new Error('无仓位，无法平仓');
  }
  const realizedPnL = calcUnrealizedPnL(account.position, currentPrice);
  account.balance += realizedPnL;
  account.position = null;
  return realizedPnL;
}

// 近似相等
function approxEqual(a: number, b: number, epsilon: number = 0.001): boolean {
  return Math.abs(a - b) < epsilon;
}

function assertEqual(actual: number, expected: number, msg: string): void {
  if (!approxEqual(actual, expected)) {
    throw new Error(`${msg}: 期望${expected}, 实际${actual}`);
  }
}

function runTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (e: any) {
    console.log(`❌ ${name}: ${e.message}`);
    process.exit(1);
  }
}

console.log('═══════════════════════════════════════════════════════════');
console.log('         Equity计算完整测试Case (6场景)');
console.log('═══════════════════════════════════════════════════════════\n');

// 场景1: 纯多 - 开多→涨价→平仓→balance增加
runTest('场景1: 纯多交易(开多100@1.0→1.1→平仓→balance=10010)', () => {
  const account: Account = { balance: 10000, position: null };
  
  // 步骤1: 开多
  openPosition(account, 'LONG', 100, 1.0);
  assertEqual(calcEquity(account, 1.0), 10000, '开仓后equity应为10000');
  console.log('  ① 开多100@1.0, equity=', calcEquity(account, 1.0));
  
  // 步骤2: 价格上涨到1.1
  assertEqual(calcUnrealizedPnL(account.position!, 1.1), 10, 'unrealizedPnL应为+10');
  assertEqual(calcEquity(account, 1.1), 10010, '涨价后equity应为10010');
  console.log('  ② 价格→1.1, unrealizedPnL=+10, equity=', calcEquity(account, 1.1));
  
  // 步骤3: 平仓
  const pnl = closePosition(account, 1.1);
  assertEqual(pnl, 10, 'realizedPnL应为+10');
  assertEqual(account.balance, 10010, '平仓后balance应为10010');
  assertEqual(calcEquity(account, 1.1), 10010, '平仓后equity应等于balance');
  console.log('  ③ 平仓, realizedPnL=+10, balance=', account.balance);
});

// 场景2: 纯空 - 开空→降价→平仓→balance增加
runTest('场景2: 纯空交易(开空100@1.0→0.9→平仓→balance=10010)', () => {
  const account: Account = { balance: 10000, position: null };
  
  // 步骤1: 开空
  openPosition(account, 'SHORT', 100, 1.0);
  assertEqual(calcEquity(account, 1.0), 10000, '开仓后equity应为10000');
  console.log('  ① 开空100@1.0, equity=', calcEquity(account, 1.0));
  
  // 步骤2: 价格下跌到0.9
  assertEqual(calcUnrealizedPnL(account.position!, 0.9), 10, 'unrealizedPnL应为+10');
  assertEqual(calcEquity(account, 0.9), 10010, '降价后equity应为10010');
  console.log('  ② 价格→0.9, unrealizedPnL=+10, equity=', calcEquity(account, 0.9));
  
  // 步骤3: 平仓
  const pnl = closePosition(account, 0.9);
  assertEqual(pnl, 10, 'realizedPnL应为+10');
  assertEqual(account.balance, 10010, '平仓后balance应为10010');
  assertEqual(calcEquity(account, 0.9), 10010, '平仓后equity应等于balance');
  console.log('  ③ 平仓, realizedPnL=+10, balance=', account.balance);
});

// 场景3: 多空切换 - 开多→平多→开空→平空
runTest('场景3: 多空切换(开多→平多→开空→平空，equity全程正确)', () => {
  const account: Account = { balance: 10000, position: null };
  
  // 开多@1.0，涨价到1.1，平仓
  openPosition(account, 'LONG', 100, 1.0);
  assertEqual(calcEquity(account, 1.1), 10010, '多仓涨价后equity=10010');
  closePosition(account, 1.1);
  assertEqual(account.balance, 10010, '平多后balance=10010');
  console.log('  ① 开多→1.1平仓, balance=', account.balance);
  
  // 开空@1.1，降价到1.0，平仓
  openPosition(account, 'SHORT', 100, 1.1);
  assertEqual(calcEquity(account, 1.0), 10020, '空仓降价后equity=10020 (10010+10)');
  closePosition(account, 1.0);
  assertEqual(account.balance, 10020, '平空后balance=10020');
  console.log('  ② 开空→1.0平仓, balance=', account.balance);
});

// 场景4: 连续盈利 - 3笔连续盈利
runTest('场景4: 连续盈利(3笔盈利交易，balance逐步增加)', () => {
  const account: Account = { balance: 10000, position: null };
  
  // 第1笔: 做多 1.0→1.1 (+10)
  openPosition(account, 'LONG', 100, 1.0);
  closePosition(account, 1.1);
  assertEqual(account.balance, 10010, '第1笔后balance=10010');
  console.log('  ① 第1笔(多1.0→1.1): balance=', account.balance);
  
  // 第2笔: 做空 1.1→1.0 (+10)
  openPosition(account, 'SHORT', 100, 1.1);
  closePosition(account, 1.0);
  assertEqual(account.balance, 10020, '第2笔后balance=10020');
  console.log('  ② 第2笔(空1.1→1.0): balance=', account.balance);
  
  // 第3笔: 做多 1.0→1.2 (+20)
  openPosition(account, 'LONG', 100, 1.0);
  closePosition(account, 1.2);
  assertEqual(account.balance, 10040, '第3笔后balance=10040');
  console.log('  ③ 第3笔(多1.0→1.2): balance=', account.balance);
});

// 场景5: 连续亏损 - 3笔连续亏损
runTest('场景5: 连续亏损(3笔亏损交易，balance逐步减少)', () => {
  const account: Account = { balance: 10000, position: null };
  
  // 第1笔: 做多 1.0→0.9 (-10)
  openPosition(account, 'LONG', 100, 1.0);
  closePosition(account, 0.9);
  assertEqual(account.balance, 9990, '第1笔后balance=9990');
  console.log('  ① 第1笔(多1.0→0.9): balance=', account.balance);
  
  // 第2笔: 做空 0.9→1.0 (-10)
  openPosition(account, 'SHORT', 100, 0.9);
  closePosition(account, 1.0);
  assertEqual(account.balance, 9980, '第2笔后balance=9980');
  console.log('  ② 第2笔(空0.9→1.0): balance=', account.balance);
  
  // 第3笔: 做多 1.0→0.8 (-20)
  openPosition(account, 'LONG', 100, 1.0);
  closePosition(account, 0.8);
  assertEqual(account.balance, 9960, '第3笔后balance=9960');
  console.log('  ③ 第3笔(多1.0→0.8): balance=', account.balance);
});

// 场景6: 零仓位 - 平仓后equity必须等于balance
runTest('场景6: 零仓位验证(平仓后equity=balance, unrealizedPnL=0)', () => {
  const account: Account = { balance: 10000, position: null };
  
  // 开多→平仓
  openPosition(account, 'LONG', 100, 1.0);
  closePosition(account, 1.1);
  
  // 验证零仓位状态
  if (account.position !== null) {
    throw new Error('平仓后position应为null');
  }
  assertEqual(calcEquity(account, 1.5), account.balance, '零仓位时equity必须等于balance');
  assertEqual(calcEquity(account, 0.5), account.balance, '零仓位时equity不随价格变化');
  console.log('  零仓位验证: position=null, balance=', account.balance, 
              ', equity@1.5=', calcEquity(account, 1.5),
              ', equity@0.5=', calcEquity(account, 0.5));
  
  // 再次开空→平仓，验证
  openPosition(account, 'SHORT', 100, 1.0);
  closePosition(account, 0.9);
  if (account.position !== null) {
    throw new Error('第二次平仓后position应为null');
  }
  assertEqual(calcEquity(account, 9999), account.balance, '再次零仓位后equity=balance');
  console.log('  第二次零仓位: balance=', account.balance);
});

console.log('\n═══════════════════════════════════════════════════════════');
console.log('         所有6场景测试通过 ✅');
console.log('═══════════════════════════════════════════════════════════\n');

// 测试汇总表
console.log('测试场景汇总表:');
console.log('┌──────┬────────────────────┬─────────────────────────────────────┐');
console.log('│ 场景 │ 描述               │ 关键验证点                          │');
console.log('├──────┼────────────────────┼─────────────────────────────────────┤');
console.log('│  1   │ 纯多交易           │ 开多→涨价→平仓→balance增加        │');
console.log('│  2   │ 纯空交易           │ 开空→降价→平仓→balance增加        │');
console.log('│  3   │ 多空切换           │ 多→平→空→平，全程equity正确       │');
console.log('│  4   │ 连续盈利           │ 3笔盈利，balance逐步增加           │');
console.log('│  5   │ 连续亏损           │ 3笔亏损，balance逐步减少           │');
console.log('│  6   │ 零仓位验证         │ 平仓后equity=balance，PnL=0        │');
console.log('└──────┴────────────────────┴─────────────────────────────────────┘');
console.log('\n如果回测引擎equity计算与此不符，则存在P0 bug。');
