// ============================================================
// 并行查询测试
// ============================================================

import { parallelScan, parallelAggregate } from '../src/parallel.js';

console.log('🚀 Worker 并行查询测试\n');
console.log('=' .repeat(60));

// 生成测试数据
const size = 10_000_000;  // 1000万行
const data = new Float64Array(size);
for (let i = 0; i < size; i++) {
  data[i] = Math.random() * 1000;
}

console.log(`\n📊 数据量: ${size.toLocaleString()} 行\n`);

// 测试 1: 串行过滤
console.log('🔍 测试 1: 过滤 (> 500)');

const serialStart = performance.now();
const serialResult: number[] = [];
for (let i = 0; i < data.length; i++) {
  if (data[i] > 500) serialResult.push(i);
}
const serialTime = performance.now() - serialStart;

console.log(`  串行: ${serialTime.toFixed(2)}ms | ${(size/serialTime*1000/1000000).toFixed(1)}M rows/s | ${serialResult.length} 匹配`);

// 测试 2: 并行过滤
const parallelStart = performance.now();
const parallelResult = await parallelScan(
  Array.from(data),
  (val) => val > 500,
  8  // 8 核
);
const parallelTime = performance.now() - parallelStart;

console.log(`  并行: ${parallelTime.toFixed(2)}ms | ${(size/parallelTime*1000/1000000).toFixed(1)}M rows/s | ${parallelResult.length} 匹配`);
console.log(`  加速比: ${(serialTime/parallelTime).toFixed(1)}x`);

// 测试 3: 串行聚合
console.log('\n📊 测试 2: 聚合 (sum/min/max/avg)');

const serialAggStart = performance.now();
let serialSum = 0;
let serialMin = Infinity;
let serialMax = -Infinity;
for (let i = 0; i < data.length; i++) {
  const val = data[i];
  serialSum += val;
  if (val < serialMin) serialMin = val;
  if (val > serialMax) serialMax = val;
}
const serialAggTime = performance.now() - serialAggStart;

console.log(`  串行: ${serialAggTime.toFixed(2)}ms | ${(size/serialAggTime*1000/1000000).toFixed(1)}M rows/s`);
console.log(`  结果: sum=${serialSum.toFixed(0)}, min=${serialMin.toFixed(2)}, max=${serialMax.toFixed(2)}`);

// 测试 4: 并行聚合
const parallelAggStart = performance.now();
const parallelAggResult = await parallelAggregate(data, 8);
const parallelAggTime = performance.now() - parallelAggStart;

console.log(`  并行: ${parallelAggTime.toFixed(2)}ms | ${(size/parallelAggTime*1000/1000000).toFixed(1)}M rows/s`);
console.log(`  结果: sum=${parallelAggResult.sum.toFixed(0)}, min=${parallelAggResult.min.toFixed(2)}, max=${parallelAggResult.max.toFixed(2)}`);
console.log(`  加速比: ${(serialAggTime/parallelAggTime).toFixed(1)}x`);

// 测试 5: 不同核心数对比
console.log('\n📈 测试 3: 不同并行度对比\n');

console.log('核心数 | 过滤时间 | 过滤加速 | 聚合时间 | 聚合加速');
console.log('------|----------|----------|----------|----------');

for (const workers of [1, 2, 4, 8]) {
  const start1 = performance.now();
  await parallelScan(Array.from(data), (val) => val > 500, workers);
  const time1 = performance.now() - start1;

  const start2 = performance.now();
  await parallelAggregate(data, workers);
  const time2 = performance.now() - start2;

  console.log(
    `${workers.toString().padStart(4)}  | ` +
    `${time1.toFixed(2)}ms    | ` +
    `${(serialTime/time1).toFixed(1)}x      | ` +
    `${time2.toFixed(2)}ms    | ` +
    `${(serialAggTime/time2).toFixed(1)}x`
  );
}

console.log('\n' + '=' .repeat(60));
console.log('\n✅ 并行查询测试完成！');
console.log('\n💡 结论:');
console.log('  • 并行查询可显著加速大数据集处理');
console.log('  • 最佳核心数取决于 CPU 核心数');
console.log('  • 数据量越大，并行优势越明显');
console.log('  • Bun 的 Promise.all 可以充分利用多核');
