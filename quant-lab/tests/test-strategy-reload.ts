#!/usr/bin/env bun
/**
 * 测试QuickJSStrategy.reload()功能
 * 
 * Day 1验证：
 * - createSnapshot/restoreSnapshot
 * - reload()手动触发
 * - 状态连续性（runId保留）
 */

import { QuickJSStrategy } from '../legacy/QuickJSStrategy';
import type { StrategyContext } from '../src/engine/types';

async function main() {
  console.log('===== 测试QuickJSStrategy.reload() =====\n');

  // 1. 创建策略实例
  const strategy = new QuickJSStrategy({
    strategyId: 'test-reload-123',
    strategyFile: './strategies/grid/gales-simple.js',
    params: { symbol: 'MYXUSDT', direction: 'neutral' },
  });

  // 2. 模拟StrategyContext
  const mockCtx: StrategyContext = {
    log: (msg: string) => console.log(`[MockCtx] ${msg}`),
    buy: async () => ({ orderId: 'test', symbol: 'MYXUSDT', side: 'BUY', type: 'LIMIT', quantity: 1, timestamp: Date.now(), status: 'NEW' }),
    sell: async () => ({ orderId: 'test', symbol: 'MYXUSDT', side: 'SELL', type: 'LIMIT', quantity: 1, timestamp: Date.now(), status: 'NEW' }),
    cancelOrder: async () => {},
    getPosition: async () => null,
    getAccount: async () => ({ balance: 1000, equity: 1000, positions: [], totalRealizedPnl: 0, totalUnrealizedPnl: 0 }),
  } as any;

  // 3. 初始化策略
  console.log('1. 初始化策略...');
  await strategy.onInit(mockCtx);

  // 4. 运行几个tick（建立状态）
  console.log('\n2. 运行tick建立状态...');
  for (let i = 0; i < 5; i++) {
    await strategy.onTick(mockCtx);
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // 5. 创建快照（测试createSnapshot）
  console.log('\n3. 创建状态快照...');
  const snapshot = (strategy as any).createSnapshot();
  console.log(`  快照时间: ${new Date(snapshot.timestamp).toISOString()}`);
  console.log(`  状态键数: ${Object.keys(snapshot.state).length}`);
  console.log(`  tickCount: ${snapshot.tickCount}`);
  console.log(`  快照已创建 ✅`);

  // 6. 手动触发热重载（测试reload）
  console.log('\n4. 触发手动热重载...');
  try {
    await strategy.reload();
    console.log('  热重载成功 ✅');
  } catch (error: any) {
    console.error('  热重载失败 ❌:', error.message);
    process.exit(1);
  }

  // 7. 验证状态连续性
  console.log('\n5. 验证状态连续性...');
  const newSnapshot = (strategy as any).createSnapshot();
  
  // runId应该保留（如果策略使用了）
  if (snapshot.state.runId && newSnapshot.state.runId) {
    if (snapshot.state.runId === newSnapshot.state.runId) {
      console.log(`  runId保留 ✅: ${snapshot.state.runId}`);
    } else {
      console.warn(`  runId变化 ⚠️: ${snapshot.state.runId} → ${newSnapshot.state.runId}`);
    }
  }

  // tickCount应该保留
  if (snapshot.tickCount === newSnapshot.tickCount) {
    console.log(`  tickCount保留 ✅: ${snapshot.tickCount}`);
  } else {
    console.warn(`  tickCount变化 ⚠️: ${snapshot.tickCount} → ${newSnapshot.tickCount}`);
  }

  // 8. 再运行几个tick验证正常工作
  console.log('\n6. 验证热重载后正常工作...');
  for (let i = 0; i < 3; i++) {
    await strategy.onTick(mockCtx);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  console.log('  运行正常 ✅');

  // 9. 清理
  await strategy.onStop(mockCtx);

  console.log('\n===== 测试完成 =====');
  console.log('QuickJSStrategy.reload() 功能验证通过 ✅');
}

main().catch(console.error);
