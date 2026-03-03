#!/usr/bin/env bun
/**
 * Phase 2 验证：FFI 二进制 API 性能测试
 * 对比 JSON API vs 二进制 API 的性能
 *
 * 用法: bun tests/phase2-binary-perf.ts <db-path>
 */

import { openDatabase } from '../src/ndts-db.ts';
import { ffi_query_all_json, ffi_query_all_binary, parseQueryAllBinary, ffi_open, ffi_close } from '../src/ndts-db-ffi.ts';
import { cstr } from '../src/ndts-db-ffi.ts';

interface BenchResult {
  name: string;
  ffiTime: number;
  parseTime: number;
  totalTime: number;
  rowCount: number;
  dataSize: number;
  throughput: string;
}

async function runBinaryComparison(dbPath: string): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log('Phase 2 验证：FFI 二进制 API 性能对比\n');
  console.log('对比项：JSON API vs 二进制 API\n');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const results: BenchResult[] = [];

  // ─── Test 1: JSON API (当前方式) ─────────────────────────────────────────
  console.log('Test 1: JSON API（当前方式）\n');

  const db1 = openDatabase(dbPath);
  const ptr1 = (db1 as any)._ptr;

  // Measure JSON FFI call
  const start1FFI = performance.now();
  const jsonStr = ffi_query_all_json(ptr1);
  const time1FFI = performance.now() - start1FFI;

  if (!jsonStr) {
    console.error('Failed to get JSON data');
    process.exit(1);
  }

  console.log(`  FFI 获取时间: ${time1FFI.toFixed(2)}ms`);
  console.log(`  JSON 大小: ${(jsonStr.length / 1024 / 1024).toFixed(2)}MB`);

  // Measure JSON parsing
  const start1Parse = performance.now();
  const rows1 = JSON.parse(jsonStr);
  const rows1Array = rows1.rows || [];
  const time1Parse = performance.now() - start1Parse;

  console.log(`  JSON 解析时间: ${time1Parse.toFixed(2)}ms`);
  console.log(`  行数: ${rows1Array.length.toLocaleString()}\n`);

  results.push({
    name: 'JSON API',
    ffiTime: time1FFI,
    parseTime: time1Parse,
    totalTime: time1FFI + time1Parse,
    rowCount: rows1Array.length,
    dataSize: jsonStr.length,
    throughput: ((rows1Array.length / ((time1FFI + time1Parse) / 1000)) / 1000000).toFixed(2) + 'M rows/s',
  });

  db1.close();

  // ─── Test 2: 二进制 API (Phase 2) ───────────────────────────────────────
  console.log('Test 2: 二进制 API（Phase 2）\n');

  const db2 = openDatabase(dbPath);
  const ptr2 = (db2 as any)._ptr;

  // Measure binary FFI call
  const start2FFI = performance.now();
  const binResult = ffi_query_all_binary(ptr2);
  const time2FFI = performance.now() - start2FFI;

  if (!binResult) {
    console.error('Failed to get binary data');
    process.exit(1);
  }

  console.log(`  FFI 获取时间: ${time2FFI.toFixed(2)}ms`);
  console.log(`  二进制大小: ${(binResult.data.length / 1024 / 1024).toFixed(2)}MB`);

  // Measure binary parsing
  const start2Parse = performance.now();
  const rows2 = parseQueryAllBinary(binResult);
  const time2Parse = performance.now() - start2Parse;

  console.log(`  二进制解析时间: ${time2Parse.toFixed(2)}ms`);
  console.log(`  行数: ${rows2.length.toLocaleString()}\n`);

  results.push({
    name: '二进制 API',
    ffiTime: time2FFI,
    parseTime: time2Parse,
    totalTime: time2FFI + time2Parse,
    rowCount: rows2.length,
    dataSize: binResult.data.length,
    throughput: ((rows2.length / ((time2FFI + time2Parse) / 1000)) / 1000000).toFixed(2) + 'M rows/s',
  });

  db2.close();

  // ─── 结果对比 ───────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log('性能对比结果\n');

  const jsonRes = results[0];
  const binRes = results[1];

  console.log('│ 方式        │ FFI (ms) │ 解析 (ms) │ 总计 (ms) │ 大小 (MB) │ 改进    │');
  console.log('├─────────────┼──────────┼───────────┼───────────┼───────────┼─────────┤');

  for (const r of results) {
    const improvement =
      r.name === 'JSON API'
        ? '-'
        : `${(jsonRes.totalTime / r.totalTime).toFixed(2)}x`;
    console.log(
      `│ ${r.name.padEnd(11)} │ ${r.ffiTime.toFixed(1).padStart(8)} │ ${r.parseTime.toFixed(1).padStart(9)} │ ${r.totalTime.toFixed(1).padStart(9)} │ ${(r.dataSize / 1024 / 1024).toFixed(1).padStart(9)} │ ${improvement.padStart(7)} │`,
    );
  }

  console.log('└─────────────┴──────────┴───────────┴───────────┴───────────┴─────────┘\n');

  // ─── 详细分析 ───────────────────────────────────────────────────────────
  console.log('详细分析\n');

  console.log(`总行数: ${jsonRes.rowCount.toLocaleString()}`);
  console.log('');

  console.log('数据压缩率 (二进制 vs JSON)：');
  const compressionRatio = jsonRes.dataSize / binRes.dataSize;
  console.log(`  JSON 大小: ${(jsonRes.dataSize / 1024 / 1024).toFixed(2)}MB`);
  console.log(`  二进制大小: ${(binRes.dataSize / 1024 / 1024).toFixed(2)}MB`);
  console.log(`  压缩率: ${compressionRatio.toFixed(2)}x\n`);

  console.log('FFI 传输改进：');
  const ffiImprovement = jsonRes.ffiTime / binRes.ffiTime;
  console.log(`  JSON: ${jsonRes.ffiTime.toFixed(0)}ms`);
  console.log(`  二进制: ${binRes.ffiTime.toFixed(0)}ms`);
  console.log(`  改进: ${ffiImprovement.toFixed(2)}x\n`);

  console.log('解析时间改进：');
  const parseImprovement = jsonRes.parseTime / binRes.parseTime;
  console.log(`  JSON: ${jsonRes.parseTime.toFixed(0)}ms`);
  console.log(`  二进制: ${binRes.parseTime.toFixed(0)}ms`);
  console.log(`  改进: ${parseImprovement.toFixed(2)}x\n`);

  console.log('总体性能改进：');
  const overallImprovement = jsonRes.totalTime / binRes.totalTime;
  console.log(`  JSON: ${jsonRes.totalTime.toFixed(0)}ms`);
  console.log(`  二进制: ${binRes.totalTime.toFixed(0)}ms`);
  console.log(`  改进: ${overallImprovement.toFixed(2)}x\n`);

  // ─── 数据一致性验证 ─────────────────────────────────────────────────────
  console.log('─────────────────────────────────────────────────────────────\n');
  console.log('数据一致性验证\n');

  if (rows1Array.length !== rows2.length) {
    console.error(`✗ 行数不匹配: JSON=${rows1Array.length}, 二进制=${rows2.length}`);
  } else {
    console.log(`✓ 行数一致: ${rows1Array.length.toLocaleString()}`);
  }

  // 随机抽检几行数据
  const checkCount = Math.min(5, rows1Array.length);
  let allMatch = true;

  for (let i = 0; i < checkCount; i++) {
    const idx = Math.floor(Math.random() * rows1Array.length);
    const j = rows1Array[idx];
    const b = rows2[idx];

    if (
      j.symbol !== b.symbol ||
      j.interval !== b.interval ||
      Number(j.timestamp) !== Number(b.timestamp) ||
      Math.abs(j.open - b.open) > 0.01
    ) {
      console.error(`✗ 数据不匹配 at index ${idx}`);
      allMatch = false;
    }
  }

  if (allMatch && checkCount > 0) {
    console.log(`✓ 数据样本验证通过 (${checkCount} 行)`);
  }

  // ─── 性能总结 ──────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════\n');
  console.log('性能总结\n');

  if (overallImprovement >= 2) {
    console.log(`✅ Phase 2 二进制 API 性能达到目标`);
    console.log(`   总体改进: ${overallImprovement.toFixed(2)}x (目标 > 2x)`);
  } else {
    console.log(`⚠️  Phase 2 二进制 API 性能未达到目标`);
    console.log(`   总体改进: ${overallImprovement.toFixed(2)}x (目标 > 2x)`);
  }

  console.log(`\n   JSON 吞吐: ${jsonRes.throughput}`);
  console.log(`   二进制吞吐: ${binRes.throughput}`);
  console.log(`\n═══════════════════════════════════════════════════════════════\n`);
}

// Main
const dbPath = Bun.argv[2];
if (!dbPath) {
  console.error('用法: bun tests/phase2-binary-perf.ts <db-path>');
  console.error('\n示例: bun tests/phase2-binary-perf.ts /path/to/ndts/database');
  process.exit(1);
}

await runBinaryComparison(dbPath);
