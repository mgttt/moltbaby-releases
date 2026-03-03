#!/usr/bin/env bun
/**
 * Phase 1 验证：FFI 优化基准测试
 * 对比 JSON 解析 vs 优化解析的性能
 *
 * 用法: bun tests/benchmark-optimized.ts <db-path>
 */

import { openDatabase } from '../src/ndts-db.ts';
import { parseSQL, SQLExecutor, ColumnarTable } from '../src/sql.ts';
import { parseQueryAllJsonOptimized } from '../src/ndts-db-ffi-optimized.ts';
import { ffi_query_all_json } from '../src/ndts-db-ffi.ts';
import { cstr } from '../src/ndts-db-ffi.ts';

interface BenchResult {
  name: string;
  ffiTime: number;
  parseTime: number;
  totalTime: number;
  rowCount: number;
  throughput: number;
}

async function runComparativeBenchmark(dbPath: string): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log('Phase 1 验证：FFI 优化基准测试\n');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const results: BenchResult[] = [];

  // Test 1: 当前方式 (JSON.parse)
  console.log('Test 1: 当前方式 - JSON.parse()\n');

  const db1 = openDatabase(dbPath);
  const start1FFI = performance.now();
  const rows1 = db1.queryAll();
  const time1FFI = performance.now() - start1FFI;

  console.log(`  FFI 获取 (queryAll): ${time1FFI.toFixed(2)}ms`);
  console.log(`  行数: ${rows1.length.toLocaleString()}`);

  // 单独测试 SQL 执行（用预加载数据）
  const table = new ColumnarTable([
    { name: 'symbol', type: 'string' },
    { name: 'interval', type: 'string' },
    { name: 'timestamp', type: 'int64' },
    { name: 'open', type: 'float64' },
    { name: 'high', type: 'float64' },
    { name: 'low', type: 'float64' },
    { name: 'close', type: 'float64' },
    { name: 'volume', type: 'float64' },
  ]);
  table.appendBatch(rows1 as any[]);

  const start1SQL = performance.now();
  const executor1 = new SQLExecutor();
  executor1.registerTable('klines', table);
  const result1 = executor1.execute(parseSQL('SELECT COUNT(*) FROM klines'));
  const time1SQL = performance.now() - start1SQL;

  console.log(`  SQL 执行 (COUNT): ${time1SQL.toFixed(2)}ms\n`);

  results.push({
    name: 'JSON.parse (当前)',
    ffiTime: time1FFI,
    parseTime: 0,
    totalTime: time1FFI + time1SQL,
    rowCount: rows1.length,
    throughput: (rows1.length / ((time1FFI + time1SQL) / 1000)),
  });

  db1.close();

  // Test 2: 优化方式（模拟 FFI 获取后用优化解析）
  console.log('Test 2: 优化方式 - 正则表达式优化解析\n');

  // 从 rows1 重新生成 JSON（模拟 C 层生成，处理 BigInt）
  const jsonStr = JSON.stringify(
    { rows: rows1, count: rows1.length },
    (key, value) => typeof value === 'bigint' ? Number(value) : value
  );

  console.log(`  FFI 获取 (模拟): ${time1FFI.toFixed(2)}ms (同 Test 1)`);
  console.log(`  JSON 大小: ${(jsonStr.length / 1024 / 1024).toFixed(2)}MB\n`);

  const start2Parse = performance.now();
  const rows2 = parseQueryAllJsonOptimized(jsonStr);
  const time2Parse = performance.now() - start2Parse;

  console.log(`  优化解析 (正则): ${time2Parse.toFixed(2)}ms`);
  console.log(`  行数: ${rows2.length.toLocaleString()}\n`);

  results.push({
    name: '正则优化 (Phase 1)',
    ffiTime: time1FFI,
    parseTime: time2Parse,
    totalTime: time1FFI + time2Parse,
    rowCount: rows2.length,
    throughput: (rows2.length / ((time1FFI + time2Parse) / 1000)),
  });

  // Test 3: 理想情况 - 仅 FFI 传输（二进制）
  console.log('Test 3: 预期方式 - 二进制格式 (Phase 2)\n');

  // 估算时间（基于分析）
  const est3FFI = time1FFI * 0.15; // 二进制 15% 的传输时间
  const est3Parse = time2Parse * 0.3; // 二进制解析 30% 的时间
  const est3Total = est3FFI + est3Parse;

  console.log(`  FFI 预期: ${est3FFI.toFixed(2)}ms (二进制传输)`);
  console.log(`  解析预期: ${est3Parse.toFixed(2)}ms (DataView 读取)`);
  console.log(`  总计预期: ${est3Total.toFixed(2)}ms\n`);

  results.push({
    name: '二进制 (Phase 2 预期)',
    ffiTime: est3FFI,
    parseTime: est3Parse,
    totalTime: est3Total,
    rowCount: rows2.length,
    throughput: (rows2.length / (est3Total / 1000)),
  });

  // 显示对比结果
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log('对比结果\n');
  console.log('│ 方式                  │ FFI (ms) │ 解析 (ms) │ 总计 (ms) │ 改进 │');
  console.log('├────────────────────────┼──────────┼───────────┼───────────┼──────┤');

  const baseline = results[0].totalTime;
  for (const r of results) {
    const improvement = baseline / r.totalTime;
    const improvementStr =
      r.name.includes('当前') ? '-' : `${improvement.toFixed(1)}x`;
    console.log(
      `│ ${r.name.padEnd(22)} │ ${r.ffiTime.toFixed(1).padStart(8)} │ ${r.parseTime.toFixed(1).padStart(9)} │ ${r.totalTime.toFixed(1).padStart(9)} │ ${improvementStr.padStart(4)} │`,
    );
  }

  console.log('└────────────────────────┴──────────┴───────────┴───────────┴──────┘\n');

  // 数据分析
  console.log('数据分析\n');
  console.log(`总行数: ${results[0].rowCount.toLocaleString()}`);
  console.log(`JSON 大小: ${(jsonStr.length / 1024 / 1024).toFixed(2)}MB\n`);

  console.log('开销分布（当前方式）\n');
  const current = results[0];
  const ffiPercent = ((current.ffiTime / current.totalTime) * 100).toFixed(1);
  const sqlPercent = ((current.totalTime - current.ffiTime) / current.totalTime * 100).toFixed(1);

  console.log(`  FFI: ${current.ffiTime.toFixed(0)}ms (${ffiPercent}%)`);
  console.log(`  SQL: ${(current.totalTime - current.ffiTime).toFixed(0)}ms (${sqlPercent}%)\n`);

  // 优化效果总结
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log('优化总结\n');

  const phase1Saved = results[0].totalTime - results[1].totalTime;
  const phase2Saved = results[0].totalTime - results[2].totalTime;

  console.log(`Phase 1 (当前 → 优化解析):`);
  console.log(`  节省: ${phase1Saved.toFixed(0)}ms (${((phase1Saved / results[0].totalTime) * 100).toFixed(1)}%)`);
  console.log(`  加速: ${(results[0].totalTime / results[1].totalTime).toFixed(2)}x\n`);

  console.log(`Phase 2 (当前 → 二进制):`);
  console.log(`  节省: ${phase2Saved.toFixed(0)}ms (${((phase2Saved / results[0].totalTime) * 100).toFixed(1)}%)`);
  console.log(`  加速: ${(results[0].totalTime / results[2].totalTime).toFixed(2)}x\n`);

  console.log('═══════════════════════════════════════════════════════════════\n');
}

// Main
const dbPath = Bun.argv[2];
if (!dbPath) {
  console.error('用法: bun tests/benchmark-optimized.ts <db-path>');
  console.error('\n示例: bun tests/benchmark-optimized.ts /path/to/ndts/database');
  process.exit(1);
}

await runComparativeBenchmark(dbPath);
