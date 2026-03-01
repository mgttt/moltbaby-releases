// ============================================================
// libndts FFI 绑定 - N-Dimensional Time Series Native Core
// ============================================================

import { dlopen, FFIType, ptr } from 'bun:ffi';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

// ─── 库加载 ─────────────────────────────────────────────

function findLibrary(): string {
  const platform = process.platform;
  const arch = process.arch;
  
  // 命名规范: libndts-{win,lnx,osx}-{arm,x86}-{64,32}
  let os: string;
  let cpu: string;
  let bits: string;
  let ext: string;
  
  if (platform === 'darwin') {
    os = 'osx';
    ext = 'dylib';
  } else if (platform === 'win32') {
    os = 'win';
    ext = 'dll';
  } else {
    os = 'lnx';
    ext = 'so';
  }
  
  if (arch === 'arm64') {
    cpu = 'arm';
    bits = '64';
  } else if (arch === 'arm') {
    cpu = 'arm';
    bits = '32';
  } else if (arch === 'ia32' || arch === 'x86') {
    cpu = 'x86';
    bits = '32';
  } else {
    cpu = 'x86';
    bits = '64';
  }
  
  const libName = `libndts-${os}-${cpu}-${bits}.${ext}`;
  
  const paths = [
    // ndtsdb-lib/native/dist (新分离式布局)
    join(dirname(import.meta.path), '../../ndtsdb-lib/native/dist', libName),
    // 向后兼容: 旧布局 ndtsdb/native/dist/
    join(dirname(import.meta.path), '../native/dist', libName),
    join(dirname(import.meta.path), '../../native/dist', libName),
    join(process.cwd(), 'native/dist', libName),
    // 本地编译回退
    join(dirname(import.meta.path), '../native/libndts.so'),
    join(dirname(import.meta.path), '../../native/libndts.so'),
    join(dirname(import.meta.path), '../../ndtsdb-lib/native/libndts.so'),
    join(process.cwd(), 'native/libndts.so'),
  ];
  
  for (const p of paths) {
    if (existsSync(p)) {
      return p;
    }
  }
  
  throw new Error(`libndts not found. Expected: native/dist/${libName}`);
}

let lib: ReturnType<typeof dlopen> | null = null;

try {
  const libPath = findLibrary();
  
  lib = dlopen(libPath, {
    // 类型转换
    int64_to_f64: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.usize],
      returns: FFIType.void,
    },
    f64_to_int64: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.usize],
      returns: FFIType.void,
    },
    
    // Counting Sort
    counting_sort_apply: {
      args: [FFIType.ptr, FFIType.usize, FFIType.f64, FFIType.ptr, FFIType.usize, FFIType.ptr],
      returns: FFIType.void,
    },
    
    // Min/Max
    minmax_f64: {
      args: [FFIType.ptr, FFIType.usize, FFIType.ptr, FFIType.ptr],
      returns: FFIType.void,
    },
    
    // 数据重排列
    gather_f64: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.usize, FFIType.ptr],
      returns: FFIType.void,
    },
    gather_i32: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.usize, FFIType.ptr],
      returns: FFIType.void,
    },
    gather_batch4: {
      args: [
        FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr,  // src arrays
        FFIType.ptr,                                          // indices
        FFIType.usize,                                        // n
        FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr,  // out arrays
      ],
      returns: FFIType.void,
    },
    
    // Snapshot 边界
    find_snapshot_boundaries: {
      args: [FFIType.ptr, FFIType.usize, FFIType.ptr],
      returns: FFIType.usize,
    },
    
    // 原有 SIMD 操作
    filter_f64_gt: {
      args: [FFIType.ptr, FFIType.usize, FFIType.f64, FFIType.ptr],
      returns: FFIType.usize,
    },
    sum_f64: {
      args: [FFIType.ptr, FFIType.usize],
      returns: FFIType.f64,
    },
    aggregate_f64: {
      args: [FFIType.ptr, FFIType.usize, FFIType.ptr],
      returns: FFIType.void,
    },
    filter_price_volume: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.usize, FFIType.f64, FFIType.i32, FFIType.ptr],
      returns: FFIType.usize,
    },
    
    // Gorilla 压缩
    gorilla_compress_f64: {
      args: [FFIType.ptr, FFIType.usize, FFIType.ptr],
      returns: FFIType.usize,
    },
    gorilla_decompress_f64: {
      args: [FFIType.ptr, FFIType.usize, FFIType.ptr, FFIType.usize],
      returns: FFIType.usize,
    },
    
    // io_uring (Linux only)
    uring_ctx_size: {
      args: [],
      returns: FFIType.usize,
    },
    uring_init: {
      args: [FFIType.ptr],
      returns: FFIType.i32,
    },
    uring_destroy: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
    uring_batch_read: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.usize],
      returns: FFIType.i32,
    },
    uring_available: {
      args: [],
      returns: FFIType.i32,
    },
    
    // 二分查找
    binary_search_i64: {
      args: [FFIType.ptr, FFIType.usize, FFIType.i64],
      returns: FFIType.usize,
    },
    binary_search_batch_i64: {
      args: [FFIType.ptr, FFIType.usize, FFIType.ptr, FFIType.usize, FFIType.ptr],
      returns: FFIType.void,
    },
    
    // 累积和 & 差分
    prefix_sum_f64: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.usize],
      returns: FFIType.void,
    },
    delta_encode_f64: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.usize],
      returns: FFIType.void,
    },
    delta_decode_f64: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.usize],
      returns: FFIType.void,
    },
    
    // 技术指标
    ema_f64: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.usize, FFIType.f64],
      returns: FFIType.void,
    },
    sma_f64: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.usize, FFIType.usize],
      returns: FFIType.void,
    },
    rolling_std_f64: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.usize, FFIType.usize],
      returns: FFIType.void,
    },
    
    // OHLCV 聚合
    ohlcv_aggregate: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.usize, FFIType.usize, FFIType.ptr, FFIType.ptr],
      returns: FFIType.void,
    },
  });
  
  console.log('✅ libndts loaded');
} catch (e: any) {
  console.log(`⚠️ libndts not available: ${e.message}`);
}

// ─── 公共 API ───────────────────────────────────────────

export function isNdtsReady(): boolean {
  return lib !== null;
}

/**
 * BigInt64Array → Float64Array 转换
 */
export function int64ToF64(src: BigInt64Array): Float64Array {
  const dst = new Float64Array(src.length);
  if (lib) {
    lib.symbols.int64_to_f64(ptr(src), ptr(dst), src.length);
  } else {
    for (let i = 0; i < src.length; i++) {
      dst[i] = Number(src[i]);
    }
  }
  return dst;
}

/**
 * Counting Sort argsort
 */
export function countingSortArgsort(data: Float64Array): Int32Array {
  const n = data.length;
  if (n === 0) return new Int32Array(0);
  
  // 1. 找 min/max
  let minVal = data[0], maxVal = data[0];
  if (lib) {
    const minBuf = new Float64Array(1);
    const maxBuf = new Float64Array(1);
    lib.symbols.minmax_f64(ptr(data), n, ptr(minBuf), ptr(maxBuf));
    minVal = minBuf[0];
    maxVal = maxBuf[0];
  } else {
    for (let i = 1; i < n; i++) {
      if (data[i] < minVal) minVal = data[i];
      if (data[i] > maxVal) maxVal = data[i];
    }
  }
  
  const range = maxVal - minVal + 1;
  const count = new Int32Array(range);
  const indices = new Int32Array(n);
  
  if (lib) {
    lib.symbols.counting_sort_apply(ptr(data), n, minVal, ptr(count), range, ptr(indices));
  } else {
    // JS fallback
    for (let i = 0; i < n; i++) {
      count[data[i] - minVal]++;
    }
    for (let i = 1; i < range; i++) {
      count[i] += count[i - 1];
    }
    for (let i = n - 1; i >= 0; i--) {
      const bucket = data[i] - minVal;
      indices[--count[bucket]] = i;
    }
  }
  
  return indices;
}

/**
 * 按索引重排列 Float64 数组
 */
export function gatherF64(src: Float64Array, indices: Int32Array): Float64Array {
  const out = new Float64Array(indices.length);
  if (lib) {
    lib.symbols.gather_f64(ptr(src), ptr(indices), indices.length, ptr(out));
  } else {
    for (let i = 0; i < indices.length; i++) {
      out[i] = src[indices[i]];
    }
  }
  return out;
}

/**
 * 按索引重排列 Int32 数组
 */
export function gatherI32(src: Int32Array, indices: Int32Array): Int32Array {
  const out = new Int32Array(indices.length);
  if (lib) {
    lib.symbols.gather_i32(ptr(src), ptr(indices), indices.length, ptr(out));
  } else {
    for (let i = 0; i < indices.length; i++) {
      out[i] = src[indices[i]];
    }
  }
  return out;
}

/**
 * 批量重排列 4 个数组 (用于 merge init)
 */
export function gatherBatch4(
  tsSrc: Float64Array,
  symSrc: Int32Array,
  priceSrc: Float64Array,
  volSrc: Int32Array,
  indices: Int32Array
): {
  ts: Float64Array;
  sym: Int32Array;
  prices: Float64Array;
  volumes: Int32Array;
} {
  const n = indices.length;
  const ts = new Float64Array(n);
  const sym = new Int32Array(n);
  const prices = new Float64Array(n);
  const volumes = new Int32Array(n);
  
  if (lib) {
    lib.symbols.gather_batch4(
      ptr(tsSrc), ptr(symSrc), ptr(priceSrc), ptr(volSrc),
      ptr(indices), n,
      ptr(ts), ptr(sym), ptr(prices), ptr(volumes)
    );
  } else {
    for (let i = 0; i < n; i++) {
      const idx = indices[i];
      ts[i] = tsSrc[idx];
      sym[i] = symSrc[idx];
      prices[i] = priceSrc[idx];
      volumes[i] = volSrc[idx];
    }
  }
  
  return { ts, sym, prices, volumes };
}

/**
 * 找 snapshot 边界
 */
export function findSnapshotBoundaries(sortedTs: Float64Array): Int32Array {
  const n = sortedTs.length;
  if (n === 0) return Int32Array.from([0]);
  
  // 预分配最大可能大小
  const starts = new Int32Array(n + 1);
  let count: number;
  
  if (lib) {
    count = Number(lib.symbols.find_snapshot_boundaries(ptr(sortedTs), n, ptr(starts)));
  } else {
    count = 0;
    starts[count++] = 0;
    let prev = sortedTs[0];
    for (let i = 1; i < n; i++) {
      if (sortedTs[i] !== prev) {
        starts[count++] = i;
        prev = sortedTs[i];
      }
    }
    starts[count] = n;
  }
  
  return starts.subarray(0, count + 1);
}

// ─── 原有 SIMD 操作 ─────────────────────────────────────

export function filterF64GT(data: Float64Array, threshold: number): Uint32Array {
  const out = new Uint32Array(data.length);
  let count: number;
  
  if (lib) {
    count = Number(lib.symbols.filter_f64_gt(ptr(data), data.length, threshold, ptr(out)));
  } else {
    count = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] > threshold) out[count++] = i;
    }
  }
  
  return out.subarray(0, count);
}

export function sumF64(data: Float64Array): number {
  if (lib) {
    return lib.symbols.sum_f64(ptr(data), data.length);
  }
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  return sum;
}

export interface AggregateResult {
  sum: number;
  min: number;
  max: number;
  avg: number;
  count: number;
}

export function aggregateF64(data: Float64Array): AggregateResult {
  if (lib) {
    const result = new Float64Array(5);
    lib.symbols.aggregate_f64(ptr(data), data.length, ptr(result));
    return {
      sum: result[0],
      min: result[1],
      max: result[2],
      avg: result[3],
      count: Number(result[4]),
    };
  }
  
  if (data.length === 0) {
    return { sum: 0, min: 0, max: 0, avg: 0, count: 0 };
  }
  
  let sum = 0, min = data[0], max = data[0];
  for (let i = 0; i < data.length; i++) {
    sum += data[i];
    if (data[i] < min) min = data[i];
    if (data[i] > max) max = data[i];
  }
  
  return { sum, min, max, avg: sum / data.length, count: data.length };
}

// ─── Gorilla 压缩 ───────────────────────────────────────

/**
 * Gorilla XOR 压缩 Float64 数组
 * @returns 压缩后的字节数组
 */
export function gorillaCompress(data: Float64Array): Uint8Array {
  if (data.length === 0) return new Uint8Array(0);
  
  // 预分配最大可能大小 (每个值最多 9 bytes)
  const maxSize = data.length * 9 + 8;
  const buffer = new Uint8Array(maxSize);
  
  let compressedSize: number;
  
  if (lib) {
    compressedSize = Number(lib.symbols.gorilla_compress_f64(
      ptr(data), data.length, ptr(buffer)
    ));
  } else {
    // JS fallback (简化版)
    compressedSize = gorillaCompressJS(data, buffer);
  }
  
  return buffer.subarray(0, compressedSize);
}

/**
 * Gorilla XOR 解压
 * @param buffer 压缩数据
 * @param expectedCount 预期元素数量
 * @returns 解压后的 Float64 数组
 */
export function gorillaDecompress(buffer: Uint8Array, expectedCount: number): Float64Array {
  if (buffer.length === 0) return new Float64Array(0);
  
  const out = new Float64Array(expectedCount);
  
  let count: number;
  
  if (lib) {
    count = Number(lib.symbols.gorilla_decompress_f64(
      ptr(buffer), buffer.length, ptr(out), expectedCount
    ));
  } else {
    // JS fallback
    count = gorillaDecompressJS(buffer, out);
  }
  
  return out.subarray(0, count);
}

// JS fallback 实现
function gorillaCompressJS(data: Float64Array, buffer: Uint8Array): number {
  const view = new DataView(buffer.buffer, buffer.byteOffset);
  let bytePos = 0;
  let bitPos = 0;
  let prevValue = BigInt(0);
  let prevLeading = -1;
  let prevTrailing = 0;
  
  const writeBit = (b: number) => {
    if (bitPos === 0) buffer[bytePos] = 0;
    if (b) buffer[bytePos] |= (1 << (7 - bitPos));
    bitPos++;
    if (bitPos === 8) { bitPos = 0; bytePos++; }
  };
  
  const writeBits = (val: bigint, bits: number) => {
    for (let i = bits - 1; i >= 0; i--) {
      writeBit(Number((val >> BigInt(i)) & 1n));
    }
  };
  
  // 第一个值
  const f64View = new Float64Array(1);
  const u64View = new BigUint64Array(f64View.buffer);
  f64View[0] = data[0];
  const first = u64View[0];
  writeBits(first, 64);
  prevValue = first;
  
  for (let i = 1; i < data.length; i++) {
    f64View[0] = data[i];
    const curr = u64View[0];
    const xor = curr ^ prevValue;
    
    if (xor === 0n) {
      writeBit(0);
    } else {
      writeBit(1);
      const leading = xor.toString(2).padStart(64, '0').indexOf('1');
      let trailing = 0;
      let temp = xor;
      while ((temp & 1n) === 0n) { trailing++; temp >>= 1n; }
      
      if (prevLeading !== -1 && leading >= prevLeading && trailing >= prevTrailing) {
        writeBit(0);
        const meaningful = 64 - prevLeading - prevTrailing;
        writeBits(xor >> BigInt(prevTrailing), meaningful);
      } else {
        writeBit(1);
        writeBits(BigInt(leading), 6);
        const meaningful = 64 - leading - trailing;
        writeBits(BigInt(meaningful), 6);
        writeBits(xor >> BigInt(trailing), meaningful);
        prevLeading = leading;
        prevTrailing = trailing;
      }
    }
    prevValue = curr;
  }
  
  if (bitPos > 0) bytePos++;
  return bytePos;
}

// ─── io_uring 批量读取 ─────────────────────────────────

/**
 * 检测 io_uring 是否可用
 */
export function isUringAvailable(): boolean {
  if (!lib) return false;
  return Number(lib.symbols.uring_available()) === 1;
}

/**
 * io_uring 上下文类 - 用于批量异步读取
 */
export class UringContext {
  private ctx: Uint8Array | null = null;
  private initialized = false;
  
  constructor() {
    if (!lib) throw new Error('libndts not loaded');
    
    const size = Number(lib.symbols.uring_ctx_size());
    this.ctx = new Uint8Array(size);
    
    const ret = lib.symbols.uring_init(ptr(this.ctx));
    if (ret !== 0) {
      this.ctx = null;
      throw new Error(`uring_init failed: ${ret}`);
    }
    this.initialized = true;
  }
  
  /**
   * 批量读取多个文件
   * @param fds 文件描述符数组
   * @param offsets 读取偏移
   * @param sizes 读取大小
   * @param buffer 输出缓冲区
   * @param bufferOffsets 每个文件在缓冲区中的偏移
   * @returns 成功读取的文件数
   */
  batchRead(
    fds: Int32Array,
    offsets: BigUint64Array,
    sizes: BigUint64Array,
    buffer: Uint8Array,
    bufferOffsets: BigUint64Array
  ): number {
    if (!lib || !this.ctx || !this.initialized) return -1;
    
    // 转换为正确的类型
    const offsetsSize = new BigUint64Array(offsets);
    const sizesSize = new BigUint64Array(sizes);
    const bufOffsetsSize = new BigUint64Array(bufferOffsets);
    
    return Number(lib.symbols.uring_batch_read(
      ptr(this.ctx),
      ptr(fds),
      ptr(offsetsSize),
      ptr(sizesSize),
      ptr(buffer),
      ptr(bufOffsetsSize),
      fds.length
    ));
  }
  
  destroy(): void {
    if (lib && this.ctx && this.initialized) {
      lib.symbols.uring_destroy(ptr(this.ctx));
      this.initialized = false;
      this.ctx = null;
    }
  }
}

/**
 * 批量读取多个文件 (简化 API)
 * @param paths 文件路径数组
 * @param maxSizePerFile 每个文件最大读取大小
 * @returns 读取的数据数组
 */
export async function uringReadFiles(
  paths: string[],
  maxSizePerFile: number = 1024 * 1024
): Promise<Uint8Array[]> {
  const { openSync, closeSync, fstatSync } = await import('fs');
  
  if (!isUringAvailable()) {
    // Fallback to regular read
    const { readFileSync } = await import('fs');
    return paths.map(p => {
      try {
        const buf = readFileSync(p);
        return buf.length > maxSizePerFile ? buf.subarray(0, maxSizePerFile) : buf;
      } catch {
        return new Uint8Array(0);
      }
    });
  }
  
  const ctx = new UringContext();
  
  try {
    const fds = new Int32Array(paths.length);
    const offsets = new BigUint64Array(paths.length);
    const sizes = new BigUint64Array(paths.length);
    const bufferOffsets = new BigUint64Array(paths.length);
    
    let totalSize = 0;
    for (let i = 0; i < paths.length; i++) {
      try {
        const fd = openSync(paths[i], 'r');
        const stat = fstatSync(fd);
        const size = Math.min(stat.size, maxSizePerFile);
        
        fds[i] = fd;
        offsets[i] = 0n;
        sizes[i] = BigInt(size);
        bufferOffsets[i] = BigInt(totalSize);
        totalSize += size;
      } catch {
        fds[i] = -1;
        sizes[i] = 0n;
        bufferOffsets[i] = BigInt(totalSize);
      }
    }
    
    const buffer = new Uint8Array(totalSize);
    const completed = ctx.batchRead(fds, offsets, sizes, buffer, bufferOffsets);
    
    // 关闭文件
    for (let i = 0; i < fds.length; i++) {
      if (fds[i] >= 0) closeSync(fds[i]);
    }
    
    // 分割结果
    const results: Uint8Array[] = [];
    for (let i = 0; i < paths.length; i++) {
      const start = Number(bufferOffsets[i]);
      const size = Number(sizes[i]);
      results.push(buffer.subarray(start, start + size));
    }
    
    return results;
  } finally {
    ctx.destroy();
  }
}

function gorillaDecompressJS(buffer: Uint8Array, out: Float64Array): number {
  let bytePos = 0;
  let bitPos = 0;
  let count = 0;
  let prevValue = BigInt(0);
  let prevLeading = -1;
  let prevTrailing = 0;
  
  const f64View = new Float64Array(1);
  const u64View = new BigUint64Array(f64View.buffer);
  
  const readBit = (): number => {
    if (bytePos >= buffer.length) return 0;
    const b = (buffer[bytePos] >> (7 - bitPos)) & 1;
    bitPos++;
    if (bitPos === 8) { bitPos = 0; bytePos++; }
    return b;
  };
  
  const readBits = (bits: number): bigint => {
    let v = 0n;
    for (let i = 0; i < bits; i++) {
      v = (v << 1n) | BigInt(readBit());
    }
    return v;
  };
  
  // 第一个值
  prevValue = readBits(64);
  u64View[0] = prevValue;
  out[count++] = f64View[0];
  
  while (count < out.length && bytePos < buffer.length) {
    const same = readBit();
    if (same === 0) {
      u64View[0] = prevValue;
      out[count++] = f64View[0];
    } else {
      const usePrev = readBit();
      let leading: number, meaningful: number;
      
      if (usePrev === 0) {
        leading = prevLeading;
        meaningful = 64 - prevLeading - prevTrailing;
      } else {
        leading = Number(readBits(6));
        meaningful = Number(readBits(6));
        prevLeading = leading;
        prevTrailing = 64 - leading - meaningful;
      }
      
      const xor = readBits(meaningful) << BigInt(prevTrailing);
      prevValue = prevValue ^ xor;
      u64View[0] = prevValue;
      out[count++] = f64View[0];
    }
  }
  
  return count;
}

// ─── 新增高层 API ─────────────────────────────────

/**
 * 二分查找 - 返回第一个 >= target 的位置
 */
export function binarySearchI64(data: BigInt64Array, target: bigint): number {
  if (!lib) {
    // JS fallback
    let lo = 0, hi = data.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (data[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  return Number(lib.symbols.binary_search_i64(ptr(data), data.length, target));
}

/**
 * 批量二分查找
 */
export function binarySearchBatchI64(data: BigInt64Array, targets: BigInt64Array): Uint32Array {
  const results = new Uint32Array(targets.length);
  
  if (!lib) {
    for (let i = 0; i < targets.length; i++) {
      results[i] = binarySearchI64(data, targets[i]);
    }
    return results;
  }
  
  const resultsBig = new BigUint64Array(targets.length);
  lib.symbols.binary_search_batch_i64(
    ptr(data), data.length,
    ptr(targets), targets.length,
    ptr(resultsBig)
  );
  for (let i = 0; i < targets.length; i++) {
    results[i] = Number(resultsBig[i]);
  }
  return results;
}

/**
 * 累积和
 */
export function prefixSum(src: Float64Array): Float64Array {
  const dst = new Float64Array(src.length);
  if (!lib) {
    dst[0] = src[0];
    for (let i = 1; i < src.length; i++) dst[i] = dst[i-1] + src[i];
    return dst;
  }
  lib.symbols.prefix_sum_f64(ptr(src), ptr(dst), src.length);
  return dst;
}

/**
 * 差分编码
 */
export function deltaEncode(src: Float64Array): Float64Array {
  const dst = new Float64Array(src.length);
  if (!lib) {
    dst[0] = src[0];
    for (let i = 1; i < src.length; i++) dst[i] = src[i] - src[i-1];
    return dst;
  }
  lib.symbols.delta_encode_f64(ptr(src), ptr(dst), src.length);
  return dst;
}

/**
 * 差分解码
 */
export function deltaDecode(src: Float64Array): Float64Array {
  return prefixSum(src);
}

/**
 * EMA (指数移动平均)
 */
export function ema(src: Float64Array, period: number): Float64Array {
  const dst = new Float64Array(src.length);
  const alpha = 2 / (period + 1);
  
  if (!lib) {
    dst[0] = src[0];
    for (let i = 1; i < src.length; i++) {
      dst[i] = alpha * src[i] + (1 - alpha) * dst[i-1];
    }
    return dst;
  }
  lib.symbols.ema_f64(ptr(src), ptr(dst), src.length, alpha);
  return dst;
}

/**
 * SMA (简单移动平均)
 */
export function sma(src: Float64Array, window: number): Float64Array {
  const dst = new Float64Array(src.length);
  
  if (!lib) {
    let sum = 0;
    for (let i = 0; i < src.length; i++) {
      sum += src[i];
      if (i >= window) sum -= src[i - window];
      dst[i] = i >= window - 1 ? sum / window : NaN;
    }
    return dst;
  }
  lib.symbols.sma_f64(ptr(src), ptr(dst), src.length, window);
  return dst;
}

/**
 * 滚动标准差
 */
export function rollingStd(src: Float64Array, window: number): Float64Array {
  const dst = new Float64Array(src.length);
  
  if (!lib) {
    let sum = 0, sum2 = 0;
    for (let i = 0; i < src.length; i++) {
      sum += src[i];
      sum2 += src[i] * src[i];
      if (i >= window) {
        const old = src[i - window];
        sum -= old;
        sum2 -= old * old;
      }
      if (i >= window - 1) {
        const mean = sum / window;
        const variance = sum2 / window - mean * mean;
        dst[i] = Math.sqrt(Math.max(0, variance));
      } else {
        dst[i] = NaN;
      }
    }
    return dst;
  }
  lib.symbols.rolling_std_f64(ptr(src), ptr(dst), src.length, window);
  return dst;
}
