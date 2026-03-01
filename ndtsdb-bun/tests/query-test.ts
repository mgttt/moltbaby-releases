// ============================================================
// 时序查询扩展测试
// SAMPLE BY + LATEST ON + 窗口函数
// ============================================================

import { sampleBy, ohlcv, latestOn, movingAverage, exponentialMovingAverage, rollingStdDev } from '../src/query.js';

console.log('🧪 时序查询扩展测试\n');
console.log('='.repeat(60));

// 生成测试数据: 1000 条 tick，100ms 间隔
const n = 1000;
const timestamps = new BigInt64Array(n);
const prices = new Float64Array(n);
const volumes = new Int32Array(n);
const symbolIds = new Int32Array(n);

const base = BigInt(1700000000000);
for (let i = 0; i < n; i++) {
  timestamps[i] = base + BigInt(i * 100);  // 100ms 间隔
  prices[i] = 100 + Math.sin(i / 50) * 10 + Math.random() * 2;
  volumes[i] = 100 + Math.floor(Math.random() * 900);
  symbolIds[i] = i % 5; // 5 个产品
}

// ─── Test 1: SAMPLE BY ──────────────────────────────

console.log('\n📋 Test 1: SAMPLE BY (1秒桶)\n');

const sampled = sampleBy(timestamps, [
  { name: 'price', data: prices, aggs: ['first', 'last', 'min', 'max', 'avg'] },
  { name: 'volume', data: volumes, aggs: ['sum', 'count'] },
], 1000); // 1秒桶

console.log(`  桶数: ${sampled.length} (期望 ~100)`);
console.log(`  第一桶: ${JSON.stringify(sampled[0].values)}`);
console.log(`  正确: ${sampled.length >= 95 && sampled.length <= 105 ? '✅' : '❌'}`);

// ─── Test 2: OHLCV ──────────────────────────────────

console.log('\n📋 Test 2: OHLCV (1分钟 K 线)\n');

const bars = ohlcv(timestamps, prices, volumes, 60000); // 1分钟
console.log(`  K线数: ${bars.length}`);
if (bars.length > 0) {
  const b = bars[0];
  console.log(`  第一根: O=${b.open.toFixed(2)} H=${b.high.toFixed(2)} L=${b.low.toFixed(2)} C=${b.close.toFixed(2)} V=${b.volume}`);
  const valid = b.high >= b.low && b.high >= b.open && b.high >= b.close && b.low <= b.open && b.low <= b.close;
  console.log(`  OHLC 关系正确: ${valid ? '✅' : '❌'}`);
}

// ─── Test 3: LATEST ON ──────────────────────────────

console.log('\n📋 Test 3: LATEST ON\n');

const latest = latestOn(symbolIds, timestamps, new Map([
  ['price', prices],
  ['volume', volumes],
]));

console.log(`  返回 symbols: ${latest.size} (期望 5)`);
for (const [sid, row] of latest) {
  console.log(`    symbol ${sid}: ts=${row.timestamp}, price=${row.values.price.toFixed(2)}, vol=${row.values.volume}`);
}
console.log(`  正确: ${latest.size === 5 ? '✅' : '❌'}`);

// 验证每个 symbol 的最新时间戳确实是最大的
let latestOk = true;
for (const [sid, row] of latest) {
  for (let i = 0; i < n; i++) {
    if (symbolIds[i] === sid && timestamps[i] > row.timestamp) {
      latestOk = false;
      break;
    }
  }
}
console.log(`  最新时间戳正确: ${latestOk ? '✅' : '❌'}`);

// ─── Test 4: 移动平均 ──────────────────────────────

console.log('\n📋 Test 4: 移动平均 (SMA-20)\n');

const sma = movingAverage(prices, 20);
console.log(`  SMA[0]: ${sma[0].toFixed(4)} (= price[0])`);
console.log(`  SMA[19]: ${sma[19].toFixed(4)} (first full window)`);
console.log(`  SMA[999]: ${sma[999].toFixed(4)}`);

// 手动验证 SMA[19]
let manualSum = 0;
for (let i = 0; i < 20; i++) manualSum += prices[i];
const manualSma = manualSum / 20;
console.log(`  手动计算: ${manualSma.toFixed(4)}`);
console.log(`  匹配: ${Math.abs(sma[19] - manualSma) < 0.001 ? '✅' : '❌'}`);

// ─── Test 5: EMA ─────────────────────────────────────

console.log('\n📋 Test 5: EMA-20\n');

const ema = exponentialMovingAverage(prices, 20);
console.log(`  EMA[0]: ${ema[0].toFixed(4)}`);
console.log(`  EMA[999]: ${ema[999].toFixed(4)}`);
console.log(`  长度正确: ${ema.length === n ? '✅' : '❌'}`);

// ─── Test 6: 滚动标准差 ─────────────────────────────

console.log('\n📋 Test 6: 滚动标准差 (window=20)\n');

const std = rollingStdDev(prices, 20);
console.log(`  StdDev[19]: ${std[19].toFixed(4)} (first full window)`);
console.log(`  StdDev[999]: ${std[999].toFixed(4)}`);
console.log(`  > 0: ${std[19] > 0 && std[999] > 0 ? '✅' : '❌'}`);

// ─── Test 7: 性能 ───────────────────────────────────

console.log('\n📋 Test 7: 性能\n');

const bigN = 1000000;
const bigTs = new BigInt64Array(bigN);
const bigPrices = new Float64Array(bigN);
const bigVol = new Int32Array(bigN);
for (let i = 0; i < bigN; i++) {
  bigTs[i] = BigInt(1700000000000 + i * 100);
  bigPrices[i] = 100 + Math.random() * 50;
  bigVol[i] = Math.floor(Math.random() * 10000);
}

const perfStart = performance.now();
const perfResult = ohlcv(bigTs, bigPrices, bigVol, 60000);
const perfTime = performance.now() - perfStart;

console.log(`  OHLCV 1M rows → ${perfResult.length} bars: ${perfTime.toFixed(1)}ms`);
console.log(`  速度: ${(bigN / (perfTime / 1000) / 1e6).toFixed(1)}M rows/s`);

const smaStart = performance.now();
movingAverage(bigPrices, 20);
const smaTime = performance.now() - smaStart;
console.log(`  SMA-20 1M rows: ${smaTime.toFixed(1)}ms (${(bigN / (smaTime / 1000) / 1e6).toFixed(1)}M rows/s)`);

const emaStart = performance.now();
exponentialMovingAverage(bigPrices, 20);
const emaTime = performance.now() - emaStart;
console.log(`  EMA-20 1M rows: ${emaTime.toFixed(1)}ms (${(bigN / (emaTime / 1000) / 1e6).toFixed(1)}M rows/s)`);

// ─── Summary ─────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log('\n✅ 全部测试完成！');
