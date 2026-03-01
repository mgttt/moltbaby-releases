import { 
  isNdtsReady, binarySearchI64, prefixSum, deltaEncode,
  ema, sma, rollingStd 
} from '../src/ndts-ffi.js';

console.log('🚀 新 FFI 函数性能测试\n');
console.log(`FFI: ${isNdtsReady() ? '✅' : '❌'}`);
console.log('═'.repeat(50));

const SIZE = 1_000_000;
const RUNS = 10;

// 准备数据
const f64 = new Float64Array(SIZE);
const i64 = new BigInt64Array(SIZE);
for (let i = 0; i < SIZE; i++) {
  f64[i] = Math.random() * 1000;
  i64[i] = BigInt(i * 1000);
}

function bench(name: string, fn: () => void): number {
  fn(); // warmup
  const t1 = performance.now();
  for (let r = 0; r < RUNS; r++) fn();
  const avg = (performance.now() - t1) / RUNS;
  const speed = SIZE / avg / 1000;
  return speed;
}

console.log('\n📊 JS vs FFI 对比 (1M 元素)\n');

// 二分查找
const jsSearch = bench('Binary Search (JS)', () => {
  for (let q = 0; q < 1000; q++) {
    const target = BigInt(q * 1000 + 500);
    let lo = 0, hi = SIZE;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (i64[mid] < target) lo = mid + 1;
      else hi = mid;
    }
  }
});

const ffiSearch = bench('Binary Search (FFI)', () => {
  for (let q = 0; q < 1000; q++) {
    binarySearchI64(i64, BigInt(q * 1000 + 500));
  }
});

console.log(`二分查找 ×1000:  JS ${jsSearch.toFixed(1)}M/s → FFI ${ffiSearch.toFixed(1)}M/s (${(ffiSearch/jsSearch).toFixed(1)}x)`);

// 累积和
const jsPrefixSum = bench('Prefix Sum (JS)', () => {
  const out = new Float64Array(SIZE);
  out[0] = f64[0];
  for (let i = 1; i < SIZE; i++) out[i] = out[i-1] + f64[i];
});

const ffiPrefixSum = bench('Prefix Sum (FFI)', () => {
  prefixSum(f64);
});

console.log(`累积和:          JS ${jsPrefixSum.toFixed(1)}M/s → FFI ${ffiPrefixSum.toFixed(1)}M/s (${(ffiPrefixSum/jsPrefixSum).toFixed(1)}x)`);

// Delta
const jsDelta = bench('Delta (JS)', () => {
  const out = new Float64Array(SIZE);
  out[0] = f64[0];
  for (let i = 1; i < SIZE; i++) out[i] = f64[i] - f64[i-1];
});

const ffiDelta = bench('Delta (FFI)', () => {
  deltaEncode(f64);
});

console.log(`差分编码:        JS ${jsDelta.toFixed(1)}M/s → FFI ${ffiDelta.toFixed(1)}M/s (${(ffiDelta/jsDelta).toFixed(1)}x)`);

// EMA
const jsEma = bench('EMA-20 (JS)', () => {
  const out = new Float64Array(SIZE);
  const alpha = 2 / 21;
  out[0] = f64[0];
  for (let i = 1; i < SIZE; i++) out[i] = alpha * f64[i] + (1-alpha) * out[i-1];
});

const ffiEma = bench('EMA-20 (FFI)', () => {
  ema(f64, 20);
});

console.log(`EMA-20:          JS ${jsEma.toFixed(1)}M/s → FFI ${ffiEma.toFixed(1)}M/s (${(ffiEma/jsEma).toFixed(1)}x)`);

// SMA
const jsSma = bench('SMA-20 (JS)', () => {
  const out = new Float64Array(SIZE);
  let sum = 0;
  for (let i = 0; i < SIZE; i++) {
    sum += f64[i];
    if (i >= 20) sum -= f64[i-20];
    out[i] = i >= 19 ? sum / 20 : NaN;
  }
});

const ffiSma = bench('SMA-20 (FFI)', () => {
  sma(f64, 20);
});

console.log(`SMA-20:          JS ${jsSma.toFixed(1)}M/s → FFI ${ffiSma.toFixed(1)}M/s (${(ffiSma/jsSma).toFixed(1)}x)`);

// Rolling Std
const jsStd = bench('Rolling Std (JS)', () => {
  const out = new Float64Array(SIZE);
  let sum = 0, sum2 = 0;
  for (let i = 0; i < SIZE; i++) {
    sum += f64[i];
    sum2 += f64[i] * f64[i];
    if (i >= 20) {
      sum -= f64[i-20];
      sum2 -= f64[i-20] * f64[i-20];
    }
    if (i >= 19) {
      const mean = sum / 20;
      out[i] = Math.sqrt(Math.max(0, sum2/20 - mean*mean));
    }
  }
});

const ffiStd = bench('Rolling Std (FFI)', () => {
  rollingStd(f64, 20);
});

console.log(`滚动标准差:      JS ${jsStd.toFixed(1)}M/s → FFI ${ffiStd.toFixed(1)}M/s (${(ffiStd/jsStd).toFixed(1)}x)`);

console.log('\n✅ 测试完成');
