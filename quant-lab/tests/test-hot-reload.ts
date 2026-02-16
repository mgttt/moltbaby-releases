#!/usr/bin/env bun
/**
 * 热更新功能测试
 * 
 * 测试：
 * 1. HotReloadManager基础功能
 * 2. ModuleReloader动态加载
 * 3. 门闸检查
 * 4. 审计日志
 * 5. 告警机制
 */

import { HotReloadManager } from '../src/hot-reload';

async function main() {
  console.log('===== 热更新功能测试 =====\n');

  const manager = new HotReloadManager();

  // 测试1：门闸检查
  console.log('1. 测试门闸检查...');
  const gateResult = await manager.checkGate('test-strategy-123', { target: 'module' });
  console.log('  门闸检查结果:', gateResult.passed ? '通过 ✅' : '失败 ❌');
  if (!gateResult.passed) {
    console.log('  失败项:', gateResult.failedChecks.map(c => c.name).join(', '));
  }
  console.log();

  // 测试2：状态快照
  console.log('2. 测试状态快照...');
  const snapshot = await manager.snapshot('test-strategy-123');
  console.log('  快照时间:', new Date(snapshot.timestamp).toISOString());
  console.log('  快照hash:', snapshot.hash || 'N/A');
  console.log();

  // 测试3：审计日志
  console.log('3. 测试审计日志...');
  await manager.audit({
    timestamp: Date.now(),
    strategyId: 'test-strategy-123',
    event: 'reload_start',
    target: 'module',
  });
  console.log('  审计日志已写入 ✅');
  console.log();

  // 测试4：干跑模式热更新
  console.log('4. 测试干跑模式热更新...');
  const result = await manager.reload('test-strategy-123', {
    target: 'module',
    dryRun: true,
  });
  console.log('  热更新结果:', result.success ? '成功 ✅' : '失败 ❌');
  console.log('  耗时:', result.duration, 'ms');
  if (result.error) {
    console.log('  错误:', result.error);
  }
  console.log();

  console.log('===== 测试完成 =====');
}

main().catch(console.error);
