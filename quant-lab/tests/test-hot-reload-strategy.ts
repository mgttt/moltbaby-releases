#!/usr/bin/env bun
/**
 * 测试策略热更新（应该失败 - 鲶鱼验收修复验证）
 */

import { HotReloadManager } from '../src/hot-reload';
import { writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

async function main() {
  console.log('===== 测试策略热更新（应该失败）=====\n');

  const manager = new HotReloadManager();

  // 创建state文件让门闸通过
  const stateDir = join(homedir(), '.quant-lab/state');
  const stateFile = join(stateDir, 'test-strategy-456.json');
  writeFileSync(stateFile, '{"state":{}}');

  const result = await manager.reload('test-strategy-456', {
    target: 'strategy',
    dryRun: false,
  });

  console.log('\n结果:', result.success ? '成功 ✅' : '失败 ❌');
  if (result.error) {
    console.log('错误:', result.error);
  }

  console.log('\n===== 测试完成 =====');
  console.log('预期：失败 ❌（因为策略热更新需要API支持）');
  console.log('实际：', result.success ? '成功（假成功Bug！）' : '失败 ✅');
}

main().catch(console.error);
