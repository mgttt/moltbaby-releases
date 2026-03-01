#!/usr/bin/env bun
/**
 * 测试分区裁剪优化
 * 
 * 验证：时间范围查询是否真的跳过无关分区
 */

import { PartitionedTable } from '../src/partition';
import { existsSync, rmSync } from 'fs';

function main() {
  console.log('======================================================================');
  console.log('   分区裁剪优化测试');
  console.log('======================================================================\n');

  const testDir = './data/test-partition-pruning';
  
  // 清理旧数据
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }

  // 1. 创建时间分区表（按天分区）
  const table = new PartitionedTable(
    testDir,
    [
      { name: 'timestamp', type: 'int64' },
      { name: 'value', type: 'int32' },
      { name: 'symbol_id', type: 'int32' },
    ],
    { type: 'time', column: 'timestamp', interval: 'day' }
  );

  // 2. 插入测试数据（跨 30 天，每天 1000 条）
  console.log('[准备] 插入 30 天数据（每天 1000 条）...');
  
  const baseTime = new Date('2024-01-01').getTime();
  const rows: Array<Record<string, any>> = [];

  for (let day = 0; day < 30; day++) {
    for (let i = 0; i < 1000; i++) {
      rows.push({
        timestamp: BigInt(baseTime + day * 86400_000 + i * 60_000),
        value: day * 1000 + i,
        symbol_id: 1,
      });
    }
  }

  table.append(rows);
  
  console.log(`[准备] 插入完成：${rows.length.toLocaleString()} 条数据`);
  
  // 打印分区信息
  const partitions = table.getPartitions();
  console.log(`[准备] 分区数量：${partitions.length}\n`);
  
  console.log('[调试] 前 5 个分区：');
  for (let i = 0; i < Math.min(5, partitions.length); i++) {
    const p = partitions[i];
    console.log(`  ${p.label}: ${p.rows} 条`);
  }
  console.log();

  // 3. 测试全表扫描（无 timeRange）
  console.log('[测试 1] 全表扫描（无 timeRange）');
  
  const t1 = performance.now();
  const allRows = table.query(row => row.symbol_id === 1);
  const t2 = performance.now();
  
  console.log(`  结果：${allRows.length.toLocaleString()} 条`);
  console.log(`  耗时：${(t2 - t1).toFixed(2)} ms\n`);

  // 4. 测试分区裁剪（查询第 10-12 天）
  console.log('[测试 2] 时间范围查询（第 10-12 天，应该只扫描 3 个分区）');
  
  const day10Start = baseTime + 10 * 86400_000;
  const day12End = baseTime + 13 * 86400_000; // 13 号 00:00（不含）
  
  console.log(`  查询时间范围：${new Date(day10Start).toISOString()} ~ ${new Date(day12End).toISOString()}`);
  console.log(`  预期：2024-01-11 00:00 ~ 2024-01-14 00:00（第 11-13 天）\n`);
  
  const t3 = performance.now();
  const rangeRows = table.query(
    row => row.symbol_id === 1,
    {
      timeRange: {
        min: BigInt(day10Start),
        max: BigInt(day12End)
      }
    }
  );
  const t4 = performance.now();
  
  // 打印查询到的数据的时间范围
  const timestamps = rangeRows.map(r => Number(r.timestamp));
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);
  console.log(`  实际查询到的时间范围：${new Date(minTs).toISOString()} ~ ${new Date(maxTs).toISOString()}`);
  
  console.log(`  结果：${rangeRows.length.toLocaleString()} 条`);
  console.log(`  耗时：${(t4 - t3).toFixed(2)} ms`);
  console.log(`  加速比：${((t2 - t1) / (t4 - t3)).toFixed(1)}x\n`);

  // 验证结果正确性
  const expectedRows = 3 * 1000; // 3 天 × 1000 条
  if (rangeRows.length === expectedRows) {
    console.log(`  ✅ 结果正确：${rangeRows.length} === ${expectedRows}\n`);
  } else {
    console.log(`  ❌ 结果错误：${rangeRows.length} !== ${expectedRows}\n`);
  }

  // 5. 测试窄时间范围（只查 1 天）
  console.log('[测试 3] 窄时间范围（只查第 15 天，应该只扫描 1 个分区）');
  
  const day15Start = baseTime + 15 * 86400_000;
  const day15End = baseTime + 16 * 86400_000;
  
  const t5 = performance.now();
  const narrowRows = table.query(
    row => row.symbol_id === 1,
    {
      timeRange: {
        min: BigInt(day15Start),
        max: BigInt(day15End)
      }
    }
  );
  const t6 = performance.now();
  
  console.log(`  结果：${narrowRows.length.toLocaleString()} 条`);
  console.log(`  耗时：${(t6 - t5).toFixed(2)} ms`);
  console.log(`  加速比（vs 全表）：${((t2 - t1) / (t6 - t5)).toFixed(1)}x\n`);

  // 验证结果正确性
  if (narrowRows.length === 1000) {
    console.log(`  ✅ 结果正确：${narrowRows.length} === 1000\n`);
  } else {
    console.log(`  ❌ 结果错误：${narrowRows.length} !== 1000\n`);
  }

  // 6. 测试边界情况（时间范围跨分区边界）
  console.log('[测试 4] 边界情况（时间范围跨分区边界）');
  
  const boundaryStart = baseTime + 20 * 86400_000 + 12 * 3600_000; // 第 20 天中午
  const boundaryEnd = baseTime + 22 * 86400_000 + 12 * 3600_000;   // 第 22 天中午
  
  const t7 = performance.now();
  const boundaryRows = table.query(
    row => row.symbol_id === 1,
    {
      timeRange: {
        min: BigInt(boundaryStart),
        max: BigInt(boundaryEnd)
      }
    }
  );
  const t8 = performance.now();
  
  console.log(`  结果：${boundaryRows.length.toLocaleString()} 条`);
  console.log(`  耗时：${(t8 - t7).toFixed(2)} ms\n`);

  // 7. 性能汇总
  console.log('[性能汇总]');
  console.log(`  全表扫描（30 个分区）：${(t2 - t1).toFixed(2)} ms`);
  console.log(`  3 天查询（3 个分区）：${(t4 - t3).toFixed(2)} ms (${((t2 - t1) / (t4 - t3)).toFixed(1)}x)`);
  console.log(`  1 天查询（1 个分区）：${(t6 - t5).toFixed(2)} ms (${((t2 - t1) / (t6 - t5)).toFixed(1)}x)`);
  console.log(`  跨边界查询（3 个分区）：${(t8 - t7).toFixed(2)} ms (${((t2 - t1) / (t8 - t7)).toFixed(1)}x)\n`);

  // 8. 分区裁剪效率验证
  console.log('[分区裁剪效率]');
  
  const expectedSpeedup3Days = 30 / 3; // 30 个分区 / 3 个分区 = 10x
  const actualSpeedup3Days = (t2 - t1) / (t4 - t3);
  
  const expectedSpeedup1Day = 30 / 1; // 30 个分区 / 1 个分区 = 30x
  const actualSpeedup1Day = (t2 - t1) / (t6 - t5);
  
  console.log(`  预期加速比（3 天）：~${expectedSpeedup3Days.toFixed(1)}x`);
  console.log(`  实际加速比（3 天）：${actualSpeedup3Days.toFixed(1)}x`);
  
  if (actualSpeedup3Days >= expectedSpeedup3Days * 0.5) {
    console.log(`  ✅ 分区裁剪生效（3 天）\n`);
  } else {
    console.log(`  ❌ 分区裁剪可能未生效（3 天）\n`);
  }
  
  console.log(`  预期加速比（1 天）：~${expectedSpeedup1Day.toFixed(1)}x`);
  console.log(`  实际加速比（1 天）：${actualSpeedup1Day.toFixed(1)}x`);
  
  if (actualSpeedup1Day >= expectedSpeedup1Day * 0.5) {
    console.log(`  ✅ 分区裁剪生效（1 天）\n`);
  } else {
    console.log(`  ❌ 分区裁剪可能未生效（1 天）\n`);
  }

  console.log('✅ 测试完成');
}

main();
