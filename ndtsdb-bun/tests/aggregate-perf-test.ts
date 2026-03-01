#!/usr/bin/env bun
/**
 * 测试全表聚合性能
 * 
 * 当前问题：100K 行聚合 ~477ms（2 ops/sec）
 */

import { ColumnarTable } from '../src/columnar';
import { SQLExecutor } from '../src/sql/executor';
import { SQLParser } from '../src/sql/parser';

function main() {
  console.log('======================================================================');
  console.log('   全表聚合性能测试');
  console.log('======================================================================\n');

  // 1. 准备测试数据（100K 行）
  console.log('[准备] 生成 100K 行测试数据...');
  
  const table = new ColumnarTable([
    { name: 'symbol_id', type: 'int32' },
    { name: 'price', type: 'float64' },
    { name: 'volume', type: 'float64' },
    { name: 'timestamp', type: 'int64' },
  ]);

  const rows: Array<Record<string, any>> = [];
  const numRows = 100_000;
  
  for (let i = 0; i < numRows; i++) {
    rows.push({
      symbol_id: i % 100,  // 100 个 symbol
      price: 50000 + Math.random() * 1000,
      volume: Math.random() * 1000,
      timestamp: BigInt(Date.now() + i * 1000),
    });
  }

  table.appendBatch(rows);
  
  const actualRowCount = table.getRowCount();
  console.log(`[准备] 数据准备完成：${numRows.toLocaleString()} 行`);
  console.log(`[准备] 表实际行数：${actualRowCount.toLocaleString()}\n`);
  
  if (actualRowCount !== numRows) {
    console.log(`  ❌ 错误：表行数不匹配！期望 ${numRows}，实际 ${actualRowCount}\n`);
  }

  // 2. 创建 SQL 执行器
  const executor = new SQLExecutor();
  executor.registerTable('klines', table);
  
  const parser = new SQLParser();

  // 3. 测试全表聚合（无 GROUP BY）
  console.log('[测试 1] 全表聚合（无 GROUP BY）');
  console.log('  SQL: SELECT COUNT(*), SUM(price), AVG(price), MIN(price), MAX(price), STDDEV(price) FROM klines\n');
  
  const sql1 = 'SELECT COUNT(*) as cnt, SUM(price) as total, AVG(price) as avg_price, MIN(price) as min_price, MAX(price) as max_price, STDDEV(price) as stddev_price FROM klines';
  const stmt1 = parser.parse(sql1);
  
  const t1 = performance.now();
  const result1 = executor.execute(stmt1) as any;
  const t2 = performance.now();
  
  console.log(`  结果：${JSON.stringify(result1.rows[0])}`);
  console.log(`  返回行数：${result1.rowCount}`);
  console.log(`  耗时：${(t2 - t1).toFixed(2)} ms`);
  console.log(`  吞吐：${(numRows / (t2 - t1) * 1000).toFixed(0).toLocaleString()} rows/sec`);
  
  // 验证结果正确性
  if (result1.rows[0].cnt !== numRows) {
    console.log(`  ❌ COUNT(*) 错误：期望 ${numRows}，实际 ${result1.rows[0].cnt}`);
  }
  if (result1.rows[0].total === 0) {
    console.log(`  ❌ SUM(price) 错误：不应该为 0`);
  }
  console.log();

  // 4. 测试 GROUP BY 聚合（100 个分组）
  console.log('[测试 2] GROUP BY 聚合（100 个分组）');
  console.log('  SQL: SELECT symbol_id, COUNT(*), AVG(price), STDDEV(price) FROM klines GROUP BY symbol_id\n');
  
  const sql2 = 'SELECT symbol_id, COUNT(*) as cnt, AVG(price) as avg_price, STDDEV(price) as stddev_price FROM klines GROUP BY symbol_id';
  const stmt2 = parser.parse(sql2);
  
  const t3 = performance.now();
  const result2 = executor.execute(stmt2);
  const t4 = performance.now();
  
  console.log(`  结果：${result2.rowCount} 个分组`);
  console.log(`  前 5 组：`);
  for (let i = 0; i < Math.min(5, result2.rowCount); i++) {
    console.log(`    ${JSON.stringify(result2.rows[i])}`);
  }
  console.log(`  耗时：${(t4 - t3).toFixed(2)} ms`);
  console.log(`  吞吐：${(numRows / (t4 - t3) * 1000).toFixed(0).toLocaleString()} rows/sec\n`);

  // 5. 测试只有一个聚合函数（baseline）
  console.log('[测试 3] 单个聚合函数（baseline）');
  console.log('  SQL: SELECT COUNT(*) FROM klines\n');
  
  const sql3 = 'SELECT COUNT(*) as cnt FROM klines';
  const stmt3 = parser.parse(sql3);
  
  const t5 = performance.now();
  const result3 = executor.execute(stmt3);
  const t6 = performance.now();
  
  console.log(`  结果：${JSON.stringify(result3.rows[0])}`);
  console.log(`  耗时：${(t6 - t5).toFixed(2)} ms`);
  console.log(`  吞吐：${(numRows / (t6 - t5) * 1000).toFixed(0).toLocaleString()} rows/sec\n`);

  // 6. 性能评估
  console.log('[性能评估]');
  
  const opsPerSec1 = 1000 / (t2 - t1);
  const opsPerSec2 = 1000 / (t4 - t3);
  
  console.log(`  全表聚合（6 个函数）：${opsPerSec1.toFixed(1)} ops/sec`);
  console.log(`  GROUP BY 聚合（100 组）：${opsPerSec2.toFixed(1)} ops/sec\n`);

  if (opsPerSec1 < 5) {
    console.log(`  ❌ 全表聚合性能低于目标（目标: >5 ops/sec）`);
  } else {
    console.log(`  ✅ 全表聚合性能达标`);
  }

  if (opsPerSec2 < 10) {
    console.log(`  ⚠️  GROUP BY 聚合性能较低（目标: >10 ops/sec）\n`);
  } else {
    console.log(`  ✅ GROUP BY 聚合性能达标\n`);
  }

  console.log('✅ 测试完成');
}

main();
