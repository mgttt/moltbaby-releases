/**
 * UPSERT SQL 测试
 */

import { ColumnarTable, SQLParser, SQLExecutor } from '../src/index.js';

console.log('🧪 UPSERT SQL 测试\n');

// 创建测试表
const table = new ColumnarTable([
  { name: 'symbol', type: 'int32' },     // 用数字代替字符串 (1=BTC, 2=ETH)
  { name: 'interval', type: 'int32' },   // 1=1m, 15=15m, 60=1h
  { name: 'timestamp', type: 'int64' },
  { name: 'open', type: 'float64' },
  { name: 'high', type: 'float64' },
  { name: 'low', type: 'float64' },
  { name: 'close', type: 'float64' },
  { name: 'volume', type: 'float64' },
]);

const parser = new SQLParser();
const executor = new SQLExecutor();
executor.registerTable('klines', table);

// ============================================================
console.log('1️⃣ 测试 INSERT ... ON CONFLICT ... DO UPDATE SET ...');
// ============================================================

// 首次插入
const sql1 = `
INSERT INTO klines (symbol, interval, timestamp, open, high, low, close, volume)
VALUES (1, 15, 1700000000000, 100.0, 101.0, 99.0, 100.5, 1000)
ON CONFLICT (symbol, interval, timestamp)
DO UPDATE SET open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, close=EXCLUDED.close, volume=EXCLUDED.volume
`;

const stmt1 = parser.parse(sql1);
console.log('  语句类型:', stmt1.type);
const result1 = executor.execute(stmt1);
console.log('  影响行数:', result1);
console.log('  表行数:', table.getRowCount());

// 再次插入相同主键（应更新）
const sql2 = `
INSERT INTO klines (symbol, interval, timestamp, open, high, low, close, volume)
VALUES (1, 15, 1700000000000, 100.0, 102.0, 98.0, 101.0, 2000)
ON CONFLICT (symbol, interval, timestamp)
DO UPDATE SET open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, close=EXCLUDED.close, volume=EXCLUDED.volume
`;

const stmt2 = parser.parse(sql2);
const result2 = executor.execute(stmt2);
console.log('  UPSERT 影响行数:', result2);
console.log('  表行数 (应该还是1):', table.getRowCount());

// 验证更新后的值
const closeCol = table.getColumn('close') as Float64Array;
const volumeCol = table.getColumn('volume') as Float64Array;
console.log('  close 值 (应为101):', closeCol[0]);
console.log('  volume 值 (应为2000):', volumeCol[0]);

// ============================================================
console.log('\n2️⃣ 测试 UPSERT INTO ... VALUES ... KEY (...)');
// ============================================================

const sql3 = `
UPSERT INTO klines (symbol, interval, timestamp, open, high, low, close, volume)
VALUES (2, 15, 1700000000000, 200.0, 201.0, 199.0, 200.5, 500)
KEY (symbol, interval, timestamp)
`;

const stmt3 = parser.parse(sql3);
console.log('  语句类型:', stmt3.type);
const result3 = executor.execute(stmt3);
console.log('  影响行数:', result3);
console.log('  表行数 (应为2):', table.getRowCount());

// 更新 ETH
const sql4 = `
UPSERT INTO klines (symbol, interval, timestamp, open, high, low, close, volume)
VALUES (2, 15, 1700000000000, 200.0, 210.0, 195.0, 205.0, 1500)
KEY (symbol, interval, timestamp)
`;

const stmt4 = parser.parse(sql4);
const result4 = executor.execute(stmt4);
console.log('  UPSERT 影响行数:', result4);
console.log('  表行数 (应该还是2):', table.getRowCount());

// ============================================================
console.log('\n3️⃣ 批量 UPSERT 测试');
// ============================================================

const sql5 = `
UPSERT INTO klines (symbol, interval, timestamp, open, high, low, close, volume)
VALUES 
  (1, 15, 1700000001000, 101.0, 102.0, 100.0, 101.5, 1100),
  (1, 15, 1700000002000, 102.0, 103.0, 101.0, 102.5, 1200),
  (1, 15, 1700000003000, 103.0, 104.0, 102.0, 103.5, 1300)
KEY (symbol, interval, timestamp)
`;

const stmt5 = parser.parse(sql5);
const result5 = executor.execute(stmt5);
console.log('  批量插入影响行数:', result5);
console.log('  表行数 (应为5):', table.getRowCount());

// ============================================================
console.log('\n4️⃣ 性能测试');
// ============================================================

const perfTable = new ColumnarTable([
  { name: 'symbol', type: 'int32' },
  { name: 'timestamp', type: 'int64' },
  { name: 'price', type: 'float64' },
  { name: 'volume', type: 'float64' },
]);

const perfExecutor = new SQLExecutor();
perfExecutor.registerTable('ticks', perfTable);

// 生成 10000 条数据
const batchSize = 10000;
const values: string[] = [];
for (let i = 0; i < batchSize; i++) {
  values.push(`(1, ${1700000000000 + i * 1000}, ${100 + Math.random()}, ${1000 + Math.random() * 100})`);
}

const sqlBatch = `
UPSERT INTO ticks (symbol, timestamp, price, volume)
VALUES ${values.join(',')}
KEY (symbol, timestamp)
`;

const stmtBatch = parser.parse(sqlBatch);

const start = performance.now();
const resultBatch = perfExecutor.execute(stmtBatch);
const elapsed = performance.now() - start;

console.log(`  ${batchSize} 条 UPSERT: ${elapsed.toFixed(1)}ms`);
console.log(`  速度: ${(batchSize / elapsed * 1000).toFixed(0)} rows/s`);

// 再次 upsert 同样的数据（全部更新）
const start2 = performance.now();
const resultBatch2 = perfExecutor.execute(stmtBatch);
const elapsed2 = performance.now() - start2;

console.log(`  ${batchSize} 条 UPDATE: ${elapsed2.toFixed(1)}ms`);
console.log(`  速度: ${(batchSize / elapsed2 * 1000).toFixed(0)} rows/s`);

// ============================================================
console.log('\n✅ UPSERT 测试完成');
