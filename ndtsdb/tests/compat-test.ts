#!/usr/bin/env bun
// ============================================================
// ndtsdb 互通性测试 - 验证 Bun 版与 CLI 版格式兼容
// ============================================================

import { AppendWriter, isLibraryAvailable, openDatabase } from '../src/index.js';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const TEST_DB = '/tmp/ndtsdb_compat_test';
const SYMBOL = 'BTCUSDT';
const INTERVAL = '1m';

console.log('=== ndtsdb 互通性测试 ===\n');

// 检查 libndts 是否可用
console.log('1. 检查 libndts 库...');
if (!isLibraryAvailable()) {
  console.error('❌ libndts 不可用。请先构建 ndtsdb-cli:');
  console.error('   cd ndtsdb-cli && make cosmo-docker');
  process.exit(1);
}
console.log('✓ libndts 可用\n');

// 清理测试目录
if (existsSync(TEST_DB)) {
  rmSync(TEST_DB, { recursive: true });
}
mkdirSync(TEST_DB, { recursive: true });

// 测试 1: Bun 版写入
console.log('2. Bun 版写入数据...');
const writer = new AppendWriter(
  join(TEST_DB, `${SYMBOL}__${INTERVAL}.ndts`),
  [
    { name: 'timestamp', type: 'int64' },
    { name: 'open', type: 'float64' },
    { name: 'high', type: 'float64' },
    { name: 'low', type: 'float64' },
    { name: 'close', type: 'float64' },
    { name: 'volume', type: 'float64' },
  ]
);

writer.open();

const testData = [
  { timestamp: 1704067200000, open: 100, high: 105, low: 99, close: 102, volume: 1000 },
  { timestamp: 1704067260000, open: 102, high: 106, low: 101, close: 105, volume: 1500 },
  { timestamp: 1704067320000, open: 105, high: 108, low: 104, close: 107, volume: 2000 },
];

writer.append(testData);
writer.close();
console.log(`✓ 写入 ${testData.length} 行数据\n`);

// 测试 2: Bun 版读取
console.log('3. Bun 版读取数据...');
const reader = openDatabase(TEST_DB);
const rows = reader.queryAll();
console.log(`✓ 读取 ${rows.length} 行数据`);
if (rows.length === testData.length) {
  console.log('✓ 行数匹配\n');
} else {
  console.error(`❌ 行数不匹配: 期望 ${testData.length}, 实际 ${rows.length}\n`);
  process.exit(1);
}
reader.close();

// 测试 3: CLI 版读取 (需要 ndtsdb-cli)
console.log('4. CLI 版读取验证...');
const cliPath = './ndtsdb-cli.com';
if (existsSync(cliPath)) {
  const proc = Bun.spawn([cliPath, 'query', '--database', TEST_DB, '--symbol', SYMBOL, '--interval', INTERVAL]);
  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  
  if (exitCode === 0 && output.includes('BTCUSDT')) {
    console.log('✓ CLI 可以读取 Bun 版写入的数据\n');
  } else {
    console.error('❌ CLI 读取失败');
    console.error(output);
    process.exit(1);
  }
} else {
  console.log('⚠ CLI 二进制不存在，跳过 CLI 读取测试');
  console.log('   如需完整测试，请确保 ndtsdb-cli.com 存在\n');
}

// 清理
rmSync(TEST_DB, { recursive: true });

console.log('=== 互通性测试通过 ===');
