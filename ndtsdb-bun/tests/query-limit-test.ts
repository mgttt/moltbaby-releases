#!/usr/bin/env bun
/**
 * 测试 query() 的 limit 和 reverse 功能
 */

import { PartitionedTable } from '../src/partition';
import { existsSync, rmSync } from 'fs';

function main() {
  console.log('======================================================================');
  console.log('   query() limit + reverse 功能测试');
  console.log('======================================================================\n');

  const testDir = './data/test-query-limit';
  
  // 清理旧数据
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }

  // 1. 创建分区表（哈希分区）
  const table = new PartitionedTable(
    testDir,
    [
      { name: 'id', type: 'int32' },
      { name: 'value', type: 'int32' },
      { name: 'timestamp', type: 'int64' },
    ],
    { type: 'hash', column: 'id', buckets: 10 }
  );

  // 2. 插入测试数据（1000 条）
  console.log('[准备] 插入 1000 条数据...');
  
  const rows: Array<Record<string, any>> = [];
  for (let i = 0; i < 1000; i++) {
    rows.push({
      id: i % 10,
      value: i,
      timestamp: BigInt(Date.now() + i * 1000),
    });
  }

  table.append(rows);
  console.log('[准备] 插入完成\n');

  // 3. 测试 limit 功能
  console.log('[测试 1] query() 不带 limit（全表扫描）');
  
  const t1 = performance.now();
  const allRows = table.query(row => row.id === 5);
  const t2 = performance.now();
  
  console.log(`  结果：${allRows.length} 条`);
  console.log(`  耗时：${(t2 - t1).toFixed(2)} ms\n`);

  // 4. 测试 limit=10（提前退出）
  console.log('[测试 2] query() 带 limit=10（提前退出）');
  
  const t3 = performance.now();
  const limitedRows = table.query(row => row.id === 5, { limit: 10 });
  const t4 = performance.now();
  
  console.log(`  结果：${limitedRows.length} 条（预期 10）`);
  console.log(`  耗时：${(t4 - t3).toFixed(2)} ms`);
  console.log(`  加速比：${((t2 - t1) / (t4 - t3)).toFixed(1)}x\n`);

  if (limitedRows.length === 10) {
    console.log('  ✅ limit 功能正常\n');
  } else {
    console.log(`  ❌ limit 功能异常：返回 ${limitedRows.length} 条，预期 10 条\n`);
  }

  // 5. 测试 reverse（倒序扫描）
  console.log('[测试 3] query() 正序扫描（默认）');
  
  const forwardRows = table.query(row => row.id === 5, { limit: 5 });
  console.log(`  前 5 条 value: ${forwardRows.map(r => r.value).join(', ')}`);

  console.log('\n[测试 4] query() 倒序扫描（reverse=true）');
  
  const reverseRows = table.query(row => row.id === 5, { limit: 5, reverse: true });
  console.log(`  后 5 条 value: ${reverseRows.map(r => r.value).join(', ')}`);

  // 验证倒序
  const isReversed = reverseRows.every((row, i) => {
    if (i === 0) return true;
    return row.value < reverseRows[i - 1].value;
  });

  if (isReversed) {
    console.log('  ✅ reverse 功能正常\n');
  } else {
    console.log('  ❌ reverse 功能异常\n');
  }

  // 6. 测试 limit=1 查最新数据（常见场景）
  console.log('[测试 5] 查询最新一条数据（reverse + limit=1）');
  
  const t5 = performance.now();
  const latestRow = table.query(row => row.id === 5, { reverse: true, limit: 1 });
  const t6 = performance.now();
  
  console.log(`  结果：value=${latestRow[0]?.value}, timestamp=${latestRow[0]?.timestamp}`);
  console.log(`  耗时：${(t6 - t5).toFixed(2)} ms`);
  console.log(`  加速比（vs 全表扫描）：${((t2 - t1) / (t6 - t5)).toFixed(1)}x\n`);

  // 7. 性能汇总
  console.log('[性能汇总]');
  console.log(`  全表扫描：${(t2 - t1).toFixed(2)} ms`);
  console.log(`  limit=10：${(t4 - t3).toFixed(2)} ms (${((t2 - t1) / (t4 - t3)).toFixed(1)}x)`);
  console.log(`  reverse+limit=1：${(t6 - t5).toFixed(2)} ms (${((t2 - t1) / (t6 - t5)).toFixed(1)}x)\n`);

  console.log('✅ 测试完成');
}

main();
