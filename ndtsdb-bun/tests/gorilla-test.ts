// Gorilla 压缩测试
import { gorillaCompress, gorillaDecompress, isNdtsReady } from '../src/ndts-ffi.js';

console.log('🧪 Gorilla 压缩测试\n');
console.log(`FFI Ready: ${isNdtsReady()}`);

// 生成测试数据 (模拟股价)
const N = 100000;
const data = new Float64Array(N);
let price = 100.0;
for (let i = 0; i < N; i++) {
  price += (Math.random() - 0.5) * 0.01;
  data[i] = price;
}

console.log(`\n数据: ${N} 个 float64 (${(N * 8 / 1024).toFixed(1)} KB)`);

// 压缩
const t1 = performance.now();
const compressed = gorillaCompress(data);
const compressTime = performance.now() - t1;

const ratio = (1 - compressed.length / (N * 8)) * 100;
console.log(`压缩后: ${(compressed.length / 1024).toFixed(1)} KB (${ratio.toFixed(1)}% 压缩率)`);
console.log(`压缩时间: ${compressTime.toFixed(1)}ms (${(N / compressTime * 1000 / 1e6).toFixed(2)}M/s)`);

// 解压
const t2 = performance.now();
const decompressed = gorillaDecompress(compressed, N);
const decompressTime = performance.now() - t2;
console.log(`解压时间: ${decompressTime.toFixed(1)}ms (${(N / decompressTime * 1000 / 1e6).toFixed(2)}M/s)`);

// 验证
let match = true;
for (let i = 0; i < N; i++) {
  if (Math.abs(data[i] - decompressed[i]) > 1e-10) {
    console.log(`❌ Mismatch at ${i}: ${data[i]} vs ${decompressed[i]}`);
    match = false;
    break;
  }
}
console.log(`\n验证: ${match ? '✅ PASSED' : '❌ FAILED'}`);

// 对比 JS 版本
console.log('\n--- JS vs C FFI 性能对比 ---');

// 多次运行取平均
const RUNS = 5;
let jsCompressTotal = 0, ffiCompressTotal = 0;

for (let r = 0; r < RUNS; r++) {
  const t = performance.now();
  gorillaCompress(data);
  ffiCompressTotal += performance.now() - t;
}

console.log(`FFI 压缩平均: ${(ffiCompressTotal / RUNS).toFixed(1)}ms`);
