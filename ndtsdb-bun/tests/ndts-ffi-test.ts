// libndts FFI 测试
import { 
  isNdtsReady, 
  int64ToF64, 
  countingSortArgsort,
  gatherF64,
  gatherBatch4,
  findSnapshotBoundaries,
  sumF64
} from '../src/ndts-ffi.js';

console.log('🧪 libndts FFI 测试\n');
console.log(`FFI Ready: ${isNdtsReady()}`);

const N = 1_000_000;

// 1. int64 → f64
console.log('\n1. int64_to_f64...');
const int64Data = new BigInt64Array(N);
for (let i = 0; i < N; i++) int64Data[i] = BigInt(1700000000000 + i);

const t1 = performance.now();
const f64Data = int64ToF64(int64Data);
const time1 = performance.now() - t1;
console.log(`   ${N.toLocaleString()} elements: ${time1.toFixed(1)}ms`);
console.log(`   Sample: ${f64Data[0]}, ${f64Data[1]}, ${f64Data[N-1]}`);

// 2. Counting Sort
console.log('\n2. countingSortArgsort...');
const unsorted = new Float64Array(N);
for (let i = 0; i < N; i++) unsorted[i] = 1700000000000 + Math.floor(Math.random() * 100000);

const t2 = performance.now();
const indices = countingSortArgsort(unsorted);
const time2 = performance.now() - t2;
console.log(`   ${N.toLocaleString()} elements: ${time2.toFixed(1)}ms`);

// 验证排序
let sorted = true;
for (let i = 1; i < Math.min(1000, N); i++) {
  if (unsorted[indices[i]] < unsorted[indices[i-1]]) {
    sorted = false;
    break;
  }
}
console.log(`   Sorted: ${sorted ? '✅' : '❌'}`);

// 3. Gather
console.log('\n3. gatherF64...');
const src = new Float64Array(N);
for (let i = 0; i < N; i++) src[i] = i * 1.5;

const t3 = performance.now();
const gathered = gatherF64(src, indices);
const time3 = performance.now() - t3;
console.log(`   ${N.toLocaleString()} elements: ${time3.toFixed(1)}ms`);

// 4. Batch Gather
console.log('\n4. gatherBatch4...');
const tsSrc = new Float64Array(N);
const symSrc = new Int32Array(N);
const priceSrc = new Float64Array(N);
const volSrc = new Int32Array(N);
for (let i = 0; i < N; i++) {
  tsSrc[i] = 1700000000000 + i;
  symSrc[i] = i % 3000;
  priceSrc[i] = 100 + Math.random();
  volSrc[i] = Math.floor(Math.random() * 10000);
}

const t4 = performance.now();
const batch = gatherBatch4(tsSrc, symSrc, priceSrc, volSrc, indices);
const time4 = performance.now() - t4;
console.log(`   ${N.toLocaleString()} elements: ${time4.toFixed(1)}ms`);

// 5. Find boundaries
console.log('\n5. findSnapshotBoundaries...');
const sortedTs = new Float64Array(N);
for (let i = 0; i < N; i++) sortedTs[i] = 1700000000000 + Math.floor(i / 100);

const t5 = performance.now();
const boundaries = findSnapshotBoundaries(sortedTs);
const time5 = performance.now() - t5;
console.log(`   ${N.toLocaleString()} elements → ${boundaries.length - 1} snapshots: ${time5.toFixed(1)}ms`);

// 6. Sum
console.log('\n6. sumF64...');
const t6 = performance.now();
const sum = sumF64(f64Data);
const time6 = performance.now() - t6;
console.log(`   ${N.toLocaleString()} elements: ${time6.toFixed(1)}ms`);
console.log(`   Sum: ${sum.toExponential(6)}`);

console.log('\n✅ FFI 测试完成');
