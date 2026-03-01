// ============================================================
// ndtsdb 冒烟测试 (快速验证)
// 用法: bun tests/smoke-test.ts
// ============================================================

import { existsSync, mkdirSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';

const TEST_DIR = './data/smoke-test';
if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });

// 清理旧的 .ndts 文件
for (const f of readdirSync(TEST_DIR)) {
  if (f.endsWith('.ndts')) unlinkSync(join(TEST_DIR, f));
}

console.log('🔥 ndtsdb 冒烟测试\n');
console.log('=' .repeat(60));

let pass = 0;
let fail = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✅ ${name}`);
    pass++;
  } catch (e: any) {
    console.log(`❌ ${name}: ${e.message}`);
    fail++;
  }
}

// ─── 核心功能快速验证 ─────────────────────────────

console.log('\n📦 核心功能\n');

test('ColumnarTable 创建', () => {
  const { ColumnarTable } = require('../src/columnar.js');
  const table = new ColumnarTable([
    { name: 'ts', type: 'int64' },
    { name: 'price', type: 'float64' },
  ]);
  if (!table) throw new Error('Failed');
});

test('数据写入和读取', () => {
  const { ColumnarTable } = require('../src/columnar.js');
  const table = new ColumnarTable([
    { name: 'ts', type: 'int64' },
    { name: 'price', type: 'float64' },
  ]);
  
  table.appendBatch([
    { ts: 1700000000000n, price: 100.5 },
    { ts: 1700000001000n, price: 101.0 },
  ]);
  
  if (table.getRowCount() !== 2) throw new Error('Row count mismatch');
});

test('文件存取', () => {
  const { ColumnarTable } = require('../src/columnar.js');
  const table = new ColumnarTable([{ name: 'v', type: 'float64' }]);
  table.append({ v: 42.0 });
  
  const path = `${TEST_DIR}/smoke.ndts`;
  table.saveToFile(path);
  
  const loaded = ColumnarTable.loadFromFile(path);
  const col = loaded.getColumn('v') as Float64Array;
  if (col[0] !== 42.0) throw new Error('Data mismatch');
});

test('AppendWriterFFI 增量写入', () => {
  const { AppendWriterFFI } = require('../src/append.js');
  const path = `${TEST_DIR}/append.ndts`;
  
  const writer = new AppendWriterFFI(path, [{ name: 'v', type: 'float64' }]);
  writer.open();
  writer.append([{ v: 1.0 }, { v: 2.0 }]);
  writer.close();
  
  const { header } = AppendWriterFFI.readAll(path);
  if (header.totalRows !== 2) throw new Error('Append failed');
});

test('CRC32 校验', () => {
  const { AppendWriterFFI, crc32 } = require('../src/append.js');
  
  const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
  const checksum = crc32(data);
  if (checksum !== 0xf7d18982) throw new Error('CRC32 mismatch');
});

// ─── 时序功能 ─────────────────────────────────────

console.log('\n📦 时序功能\n');

test('SAMPLE BY 聚合', () => {
  const { sampleBy } = require('../src/query.js');
  
  const ts = new BigInt64Array([0n, 500n, 1000n, 1500n].map(n => BigInt(n)));
  const v = new Float64Array([1, 2, 3, 4]);
  
  const result = sampleBy(ts, [{ name: 'v', data: v, aggs: ['sum'] }], 1000);
  if (result.length !== 2) throw new Error('Bucket count mismatch');
});

test('OHLCV K线', () => {
  const { ohlcv } = require('../src/query.js');
  
  const ts = new BigInt64Array([0n, 500n, 1000n].map(n => BigInt(n)));
  const prices = new Float64Array([100, 105, 102]);
  const volumes = new Int32Array([10, 20, 15]);
  
  const bars = ohlcv(ts, prices, volumes, 1000);
  if (bars.length !== 2) throw new Error('Bar count mismatch');
  if (bars[0].open !== 100) throw new Error('Open price mismatch');
});

test('移动平均 SMA', () => {
  const { movingAverage } = require('../src/query.js');
  
  const data = new Float64Array([1, 2, 3, 4, 5]);
  const sma = movingAverage(data, 3);
  
  if (Math.abs(sma[2] - 2.0) > 0.001) throw new Error('SMA calculation error');
});

// ─── SQL ──────────────────────────────────────────

console.log('\n📦 SQL 引擎\n');

test('SQL 解析', () => {
  const { parseSQL } = require('../src/sql/parser.js');
  
  const result = parseSQL('SELECT * FROM trades WHERE price > 100');
  if (result.type !== 'SELECT') throw new Error('Parse error');
});

test('SQL 执行', () => {
  const { SQLParser } = require('../src/sql/parser.js');
  const { SQLExecutor } = require('../src/sql/executor.js');
  const { ColumnarTable } = require('../src/columnar.js');

  const table = new ColumnarTable([
    { name: 'id', type: 'int32' },
    { name: 'price', type: 'float64' },
  ]);
  table.appendBatch([{ id: 1, price: 100.0 }, { id: 2, price: 200.0 }]);

  const executor = new SQLExecutor();
  executor.registerTable('trades', table);

  const result = executor.execute(new SQLParser().parse('SELECT * FROM trades'));
  if (result.rowCount !== 2) throw new Error('SQL execution error');
});

// ─── 索引 ─────────────────────────────────────────

console.log('\n📦 索引\n');

test('RoaringBitmap', () => {
  const { RoaringBitmap } = require('../src/index/bitmap.js');

  const bitmap = new RoaringBitmap();
  bitmap.add(1);
  bitmap.add(100);
  bitmap.add(1000);

  if (!bitmap.contains(100)) throw new Error('Bitmap add/contains error');
});

// ─── 报告 ─────────────────────────────────────────

console.log('\n' + '=' .repeat(60));
console.log(`\n  通过: ${pass} ✅`);
console.log(`  失败: ${fail} ❌`);
console.log(`\n${fail === 0 ? '🔥 全部通过！' : '⚠️ 有测试失败'}\n`);

process.exit(fail > 0 ? 1 : 0);
