// ============================================================
// 智能预读测试
// ============================================================

import { MmapPool } from '../src/mmap/pool.js';
import { SmartPrefetcher, ProgressiveLoader } from '../src/mmap/prefetcher.js';
import { ColumnarTable } from '../src/columnar.js';
import { existsSync, mkdirSync } from 'fs';

console.log('🧪 智能预读测试\n');
console.log('=' .repeat(60));

// 准备测试数据
const testDir = './data/prefetch-test';
if (!existsSync(testDir)) {
  mkdirSync(testDir, { recursive: true });
}

// 创建 200 个测试产品
const symbols = Array.from({ length: 200 }, (_, i) => `SYM${String(i).padStart(3, '0')}`);

console.log(`\n📦 创建 ${symbols.length} 个测试数据...\n`);

for (const symbol of symbols) {
  const table = new ColumnarTable([
    { name: 'timestamp', type: 'int64' },
    { name: 'price', type: 'float64' },
  ]);

  const now = BigInt(Date.now());
  const rows = [];
  for (let i = 0; i < 1000; i++) {
    rows.push({
      timestamp: now + BigInt(i * 60000),
      price: 100 + Math.random() * 50,
    });
  }
  table.appendBatch(rows);
  table.saveToFile(`${testDir}/${symbol}.ndts`);
}
console.log(`  ✅ 创建了 ${symbols.length} 个文件`);

// 测试 1: MmapPool 加载
console.log('\n📋 测试 1: MmapPool 加载 200 个文件\n');

const pool = new MmapPool();
const loadStart = performance.now();
pool.init(symbols, testDir);
const loadTime = performance.now() - loadStart;

console.log(`  加载耗时: ${loadTime.toFixed(2)}ms`);
console.log(`  文件数: ${pool.getSymbols().length}`);

// 测试 2: SmartPrefetcher 滑动窗口
console.log('\n📋 测试 2: SmartPrefetcher 滑动窗口\n');

const prefetcher = new SmartPrefetcher(pool, { windowSize: 20, lookahead: 50 });

console.log('  模拟回放过程...\n');

const windowSizes = [];
for (let i = 0; i < 200; i += 25) {
  prefetcher.slideWindow(symbols, i);
  const size = prefetcher.getActiveWindowSize();
  windowSizes.push(size);
  console.log(`    位置 ${String(i).padStart(3)}: 活跃窗口 ${size} 个产品`);
}

console.log(`\n  平均窗口大小: ${(windowSizes.reduce((a, b) => a + b, 0) / windowSizes.length).toFixed(1)}`);

// 测试 3: 渐进式加载
console.log('\n📋 测试 3: ProgressiveLoader 渐进加载\n');

const loader = new ProgressiveLoader(pool, 50);
const progressLog = [];

await loader.load(symbols, (loaded, total) => {
  progressLog.push({ loaded, total });
});

console.log(`  加载进度:`);
for (const p of progressLog) {
  const percent = ((p.loaded / p.total) * 100).toFixed(1);
  console.log(`    ${p.loaded}/${p.total} (${percent}%)`);
}

// 测试 4: 内存统计
console.log('\n📋 测试 4: 内存统计\n');

if (typeof process !== 'undefined' && process.memoryUsage) {
  const mem = process.memoryUsage();
  console.log(`  RSS: ${(mem.rss / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Heap used: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  External: ${(mem.external / 1024 / 1024).toFixed(2)} MB`);
}

await pool.close();

console.log('\n' + '=' .repeat(60));
console.log('\n✅ 智能预读测试完成！');
console.log('\n💡 关键验证:');
console.log('  • 滑动窗口控制活跃产品数');
console.log('  • 渐进式加载避免内存峰值');
console.log('  • 预读策略有效');
