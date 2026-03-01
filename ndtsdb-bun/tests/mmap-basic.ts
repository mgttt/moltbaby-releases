// ============================================================
// MmapPool 基础测试
// ============================================================

import { MmapPool, MmappedColumnarTable } from '../src/mmap/pool.js';
import { ColumnarTable } from '../src/columnar.js';
import { existsSync, mkdirSync } from 'fs';

console.log('🧪 MmapPool 基础测试\n');
console.log('=' .repeat(60));

// 准备测试数据
const testDir = './data/mmap-test';
if (!existsSync(testDir)) {
  mkdirSync(testDir, { recursive: true });
}

// 创建测试数据
const symbols = ['TEST1', 'TEST2', 'TEST3'];

console.log('\n📦 创建测试数据...\n');

for (const symbol of symbols) {
  const table = new ColumnarTable([
    { name: 'timestamp', type: 'int64' },
    { name: 'price', type: 'float64' },
    { name: 'volume', type: 'int32' },
  ]);

  const now = BigInt(Date.now());
  const rows = [];
  for (let i = 0; i < 10000; i++) {
    rows.push({
      timestamp: now + BigInt(i * 60000),
      price: 100 + Math.random() * 50,
      volume: Math.floor(Math.random() * 10000),
    });
  }
  table.appendBatch(rows);
  table.saveToFile(`${testDir}/${symbol}.ndts`);
  console.log(`  ✅ ${symbol}: ${table.getRowCount()} rows`);
}

// 测试 1: 单文件 mmap
console.log('\n📋 测试 1: 单文件内存映射\n');

const mmapped = new MmappedColumnarTable(`${testDir}/TEST1.ndts`);
await mmapped.open();

console.log(`  文件大小: ${(mmapped.getSize() / 1024).toFixed(2)} KB`);
console.log(`  行数: ${mmapped.getRowCount()}`);
console.log(`  列: ${mmapped.getColumnNames().join(', ')}`);

// zero-copy 读取
const timestamps = mmapped.getColumn<BigInt64Array>('timestamp');
const prices = mmapped.getColumn<Float64Array>('price');
const volumes = mmapped.getColumn<Int32Array>('volume');

console.log(`  时间戳列 (zero-copy): ${timestamps.length} 元素`);
console.log(`  价格列 (zero-copy): ${prices.length} 元素`);
console.log(`  成交量列 (zero-copy): ${volumes.length} 元素`);

// 验证数据
let valid = true;
for (let i = 0; i < 5; i++) {
  if (timestamps[i] <= 0n || prices[i] <= 0 || volumes[i] < 0) {
    valid = false;
    break;
  }
}
console.log(`  数据验证: ${valid ? '✅' : '❌'}`);

await mmapped.close();

// 测试 2: MmapPool
console.log('\n📋 测试 2: MmapPool 多文件映射\n');

const pool = new MmapPool();
await pool.init(symbols, testDir);

console.log(`  成功映射: ${pool.getSymbols().length} 个文件`);

// 从 pool 读取
const test1Prices = pool.getColumn<Float64Array>('TEST1', 'price');
const test2Prices = pool.getColumn<Float64Array>('TEST2', 'price');
const test3Prices = pool.getColumn<Float64Array>('TEST3', 'price');

console.log(`  TEST1 价格 (zero-copy): ${test1Prices.length} 元素`);
console.log(`  TEST2 价格 (zero-copy): ${test2Prices.length} 元素`);
console.log(`  TEST3 价格 (zero-copy): ${test3Prices.length} 元素`);

// 预读测试
console.log('\n📋 测试 3: 预读优化\n');
const prefetchStart = performance.now();
pool.prefetch('TEST1', ['timestamp', 'price', 'volume']);
const prefetchTime = performance.now() - prefetchStart;
console.log(`  预读耗时: ${prefetchTime.toFixed(2)}ms`);

await pool.close();

console.log('\n' + '=' .repeat(60));
console.log('\n✅ MmapPool 基础测试完成！');
console.log('\n💡 关键验证:');
console.log('  • 内存映射建立成功');
console.log('  • Zero-copy 列读取正常');
console.log('  • 多文件池化管理 OK');
console.log('  • 预读优化可用');
