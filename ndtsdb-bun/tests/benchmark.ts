// ============================================================
// 性能基准测试
// ============================================================

import { TSDB } from '../src/index.js';
import type { ColumnDef } from '../src/index.js';

const schema: ColumnDef[] = [
  { name: 'timestamp', type: 'timestamp' },
  { name: 'symbol', type: 'symbol', index: true },
  { name: 'price', type: 'double' },
  { name: 'volume', type: 'long' },
  { name: 'bid', type: 'double' },
  { name: 'ask', type: 'double' }
];

async function benchmark() {
  console.log('⚡ ndtsdb 性能基准测试\n');
  console.log('=' .repeat(50));

  // 清理旧数据
  await Bun.$`rm -rf ./data/benchmark`.catch(() => {});

  const db = new TSDB({
    dataDir: './data/benchmark',
    partitionBy: { column: 'timestamp', granularity: 'hour' },
    walEnabled: true,
    cacheSize: 10000
  });

  db.createTable('trades', schema);

  const symbols = ['AAPL', 'GOOGL', 'MSFT', 'AMZN', 'TSLA', 'NVDA', 'META', 'NFLX'];
  const batchSizes = [1000, 10000, 100000];

  // 1. 写入性能测试
  console.log('\n📝 写入性能测试');
  console.log('-'.repeat(50));

  for (const batchSize of batchSizes) {
    const rows = generateRows(batchSize, symbols);
    
    const start = performance.now();
    db.insertBatch('trades', rows);
    const duration = performance.now() - start;
    
    const rowsPerSecond = (batchSize / duration * 1000).toFixed(0);
    console.log(`批次 ${batchSize.toLocaleString().padStart(6)}: ${duration.toFixed(2).padStart(8)}ms | ${rowsPerSecond.padStart(10)} rows/s`);
  }

  db.flush();

  // 2. 查询性能测试
  console.log('\n🔍 查询性能测试');
  console.log('-'.repeat(50));

  const totalRows = db.getStats('trades').rowCount;
  console.log(`总数据量: ${totalRows.toLocaleString()} 行`);

  // 全表扫描
  const scanStart = performance.now();
  const allRows = db.query({ table: 'trades' });
  const scanTime = performance.now() - scanStart;
  console.log(`全表扫描: ${scanTime.toFixed(2)}ms (${allRows.length.toLocaleString()} 行)`);

  // Symbol 过滤
  const filterStart = performance.now();
  const aaplRows = db.query({
    table: 'trades',
    where: row => row.symbol === 'AAPL'
  });
  const filterTime = performance.now() - filterStart;
  console.log(`Symbol 过滤: ${filterTime.toFixed(2)}ms (${aaplRows.length.toLocaleString()} 行)`);

  // 时间范围查询
  const now = Date.now();
  const rangeStart = performance.now();
  const rangeRows = db.query({
    table: 'trades',
    start: new Date(now - 1800000), // 30分钟前
    end: new Date(now - 1200000)    // 20分钟前
  });
  const rangeTime = performance.now() - rangeStart;
  console.log(`时间范围: ${rangeTime.toFixed(2)}ms (${rangeRows.length.toLocaleString()} 行)`);

  // 3. SAMPLE BY 聚合测试
  console.log('\n📈 SAMPLE BY 聚合测试');
  console.log('-'.repeat(50));

  const aggStart = performance.now();
  const ohlcv = db.sampleBy('trades', '1m', [
    { name: 'price', agg: 'first' },
    { name: 'price', agg: 'max' },
    { name: 'price', agg: 'min' },
    { name: 'price', agg: 'last' },
    { name: 'volume', agg: 'sum' }
  ]);
  const aggTime = performance.now() - aggStart;
  console.log(`1分钟 OHLCV: ${aggTime.toFixed(2)}ms (${ohlcv.length} 根 K 线)`);

  // 4. 存储统计
  console.log('\n💾 存储统计');
  console.log('-'.repeat(50));
  
  const stats = db.getStats('trades');
  console.log(`总行数: ${stats.rowCount.toLocaleString()}`);
  console.log(`分区数: ${stats.partitions}`);
  console.log(`Symbol 表: ${Object.entries(stats.symbols).map(([k, v]) => `${k}=${v}`).join(', ')}`);

  // 磁盘使用
  const { $ } = await import('bun');
  const du = await $`du -sh ./data/benchmark`.text().catch(() => 'N/A');
  console.log(`磁盘占用: ${du.trim()}`);

  db.close();

  console.log('\n✅ 测试完成');
}

function generateRows(count: number, symbols: string[]): Array<Record<string, Date | string | number>> {
  const now = Date.now();
  const rows: Array<Record<string, Date | string | number>> = [];
  
  for (let i = 0; i < count; i++) {
    rows.push({
      timestamp: new Date(now - (count - i) * 100), // 倒序时间
      symbol: symbols[i % symbols.length],
      price: 100 + Math.random() * 50,
      volume: Math.floor(Math.random() * 10000),
      bid: 100 + Math.random() * 50 - 0.01,
      ask: 100 + Math.random() * 50 + 0.01
    });
  }
  
  return rows;
}

benchmark().catch(console.error);
