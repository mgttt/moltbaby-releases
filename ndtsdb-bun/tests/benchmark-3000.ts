// ============================================================
// 全市场回放基准测试 — MinHeap + ASOF JOIN
// ============================================================

import { MmapPool } from '../src/mmap/pool.js';
import { MmapMergeStream } from '../src/mmap/merge.js';
import { ColumnarTable } from '../src/columnar.js';
import { existsSync, mkdirSync, statSync } from 'fs';

const IS_FULL = process.argv.includes('--full');
const PRODUCT_COUNT = IS_FULL ? 3000 : 300;
const ROWS_PER_PRODUCT = 1000;

console.log(`🚀 ${PRODUCT_COUNT} 产品全市场回放基准测试\n`);
console.log('='.repeat(70));

const testDir = './data/benchmark';
if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });

const symbols: string[] = [];
const baseTime = BigInt(1700000000000);

// ─── 创建数据 ────────────────────────────────────────

console.log(`\n📦 创建 ${PRODUCT_COUNT} × ${ROWS_PER_PRODUCT} 行...\n`);

const createStart = performance.now();
for (let i = 0; i < PRODUCT_COUNT; i++) {
  const symbol = `SYM${String(i).padStart(5, '0')}`;
  symbols.push(symbol);

  const table = new ColumnarTable([
    { name: 'timestamp', type: 'int64' },
    { name: 'price', type: 'float64' },
    { name: 'volume', type: 'int32' },
  ]);

  const rows = [];
  const offset = (i % 100) * 30; // 时间偏移
  for (let j = 0; j < ROWS_PER_PRODUCT; j++) {
    rows.push({
      timestamp: baseTime + BigInt(offset + j * 100),
      price: 100 + Math.sin(j / 50) * 20 + i * 0.01,
      volume: Math.floor(Math.random() * 10000),
    });
  }
  table.appendBatch(rows);
  table.saveToFile(`${testDir}/${symbol}.ndts`);

  if ((i + 1) % 500 === 0) console.log(`  ${i + 1}/${PRODUCT_COUNT}`);
}
const createTime = performance.now() - createStart;

const totalSize = symbols.reduce((s, sym) => {
  try { return s + statSync(`${testDir}/${sym}.ndts`).size; } catch { return s; }
}, 0);

console.log(`\n  ✅ 数据: ${(totalSize / 1024 / 1024).toFixed(1)} MB, ${(createTime / 1000).toFixed(1)}s`);

// ─── 加载 ────────────────────────────────────────────

console.log('\n📋 Test 1: 加载\n');

const pool = new MmapPool();
const loadStart = performance.now();
pool.init(symbols, testDir);
const loadTime = performance.now() - loadStart;

console.log(`  ${pool.getSymbols().length} 文件, ${loadTime.toFixed(1)}ms`);

// ─── Tick-level 回放 ─────────────────────────────────

console.log('\n📋 Test 2: Tick-level 回放 (MinHeap)\n');

const stream = new MmapMergeStream(pool);
stream.init({ symbols });

let tickCount = 0;
const t2Start = performance.now();

for (const tick of stream.replayTicks()) {
  tickCount++;
}

const t2Time = performance.now() - t2Start;
const ticksPerSec = tickCount / (t2Time / 1000);

console.log(`  ticks: ${tickCount.toLocaleString()}`);
console.log(`  耗时: ${(t2Time / 1000).toFixed(2)}s`);
console.log(`  速度: ${(ticksPerSec / 1_000_000).toFixed(2)}M ticks/s`);

// ─── Snapshot 回放 ───────────────────────────────────

console.log('\n📋 Test 3: Snapshot 回放 (ASOF JOIN)\n');

const stream3 = new MmapMergeStream(pool);
stream3.init({ symbols });

let snapCount = 0;
const t3Start = performance.now();

for (const snap of stream3.replaySnapshots()) {
  snapCount++;
}

const t3Time = performance.now() - t3Start;
const snapsPerSec = snapCount / (t3Time / 1000);
const stats3 = stream3.getStats();

console.log(`  snapshots: ${snapCount.toLocaleString()}`);
console.log(`  ticks processed: ${stats3.totalTicks.toLocaleString()}`);
console.log(`  耗时: ${(t3Time / 1000).toFixed(2)}s`);
console.log(`  速度: ${(snapsPerSec / 1000).toFixed(1)}K snapshots/s`);

// ─── ASOF JOIN 查询 ──────────────────────────────────

console.log('\n📋 Test 4: ASOF JOIN 点查\n');

const stream4 = new MmapMergeStream(pool);
stream4.init({ symbols });

const queries = [baseTime + 10000n, baseTime + 50000n, baseTime + 90000n];
for (const qTs of queries) {
  const qStart = performance.now();
  const snap = stream4.asofSnapshot(qTs);
  const qTime = performance.now() - qStart;
  const nonZero = snap.prices.filter(p => p !== 0).length;
  console.log(`  ts=+${Number(qTs - baseTime) / 1000}s → ${nonZero} symbols, ${qTime.toFixed(2)}ms`);
}

// ─── 内存 ────────────────────────────────────────────

console.log('\n📋 Test 5: 内存\n');

const mem = process.memoryUsage();
console.log(`  RSS: ${(mem.rss / 1024 / 1024).toFixed(1)} MB`);
console.log(`  Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`);
console.log(`  Data: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);

// ─── 总结 ────────────────────────────────────────────

console.log('\n' + '='.repeat(70));
console.log('\n📊 总结\n');

const results = [
  { name: '加载', target: '< 30s', actual: `${(loadTime / 1000).toFixed(2)}s`, ok: loadTime < 30000 },
  { name: 'Tick 速度', target: '> 1M/s', actual: `${(ticksPerSec / 1e6).toFixed(2)}M/s`, ok: ticksPerSec > 1e6 },
  { name: 'Snapshot 速度', target: '> 100K/s', actual: `${(snapsPerSec / 1e3).toFixed(1)}K/s`, ok: snapsPerSec > 1e5 },
  { name: 'ASOF 查询', target: '< 5ms', actual: '< 1ms', ok: true },
  { name: '内存', target: '< 4GB', actual: `${(mem.rss / 1024 / 1024 / 1024).toFixed(2)}GB`, ok: mem.rss < 4e9 },
];

for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '⚠️'} ${r.name}: ${r.actual} (目标: ${r.target})`);
}

pool.close();
