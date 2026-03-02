// ============================================================
// 压缩算法集合
// - Gorilla: Facebook 时序数据压缩（浮点数）
// - Delta: 单调递增序列（timestamp, ID）
// - RLE: 重复值序列（symbol_id, 状态）
// - Zstd: 通用压缩（DuckDB 默认算法）
// ============================================================

import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'zlib';

// 简化访问 zlib 常量
const zlib = { constants: zlibConstants };

/**
 * Gorilla XOR 压缩器 (浮点数)
 * 原理: 相邻值的 XOR 结果通常有很多前导零，只存储有效位
 */
function countTrailingZeros64(n: bigint): number {
  // n is treated as unsigned 64-bit
  n = BigInt.asUintN(64, n);
  if (n === 0n) return 64;
  let count = 0;
  while ((n & 1n) === 0n) {
    n >>= 1n;
    count++;
  }
  return count;
}

export class GorillaCompressor {
  private buffer: Uint8Array;
  private bitPos: number = 0;
  private bytePos: number = 0;
  private prevValue: bigint = 0n;
  private prevLeadingZeros: number = -1;
  private prevTrailingZeros: number = 0;
  private first: boolean = true;

  constructor(maxSize: number = 1024 * 1024) {
    this.buffer = new Uint8Array(maxSize);
  }

  /**
   * 压缩一个浮点数
   */
  compress(value: number): void {
    const bits = BigInt.asUintN(64, BigInt(DoubleToBits(value)));

    if (this.first) {
      // 第一个值：完整存储
      this.writeBits(bits, 64);
      this.prevValue = bits;
      this.first = false;
      return;
    }

    const xor = bits ^ this.prevValue;

    if (xor === 0n) {
      // 值相同：写 0
      this.writeBit(0);
    } else {
      // 值不同：写 1
      this.writeBit(1);

      const leadingZeros = BigInt(xor).toString(2).padStart(64, '0').indexOf('1');
      const trailingZeros = countTrailingZeros64(xor);

      if (this.prevLeadingZeros !== -1 &&
          leadingZeros >= this.prevLeadingZeros &&
          trailingZeros >= this.prevTrailingZeros) {
        // 使用之前的块描述
        this.writeBit(0);
        const meaningfulBits = 64 - this.prevLeadingZeros - this.prevTrailingZeros;
        this.writeBits(xor >> BigInt(this.prevTrailingZeros), meaningfulBits);
      } else {
        // 新的块描述
        this.writeBit(1);
        this.writeBits(BigInt(leadingZeros), 6);
        const meaningfulBits = 64 - leadingZeros - trailingZeros;
        this.writeBits(BigInt(meaningfulBits), 6);
        this.writeBits(xor >> BigInt(trailingZeros), meaningfulBits);
        
        this.prevLeadingZeros = leadingZeros;
        this.prevTrailingZeros = trailingZeros;
      }
    }

    this.prevValue = bits;
  }

  /**
   * 完成压缩，返回结果
   */
  finish(): Uint8Array {
    // 补齐最后一个字节
    if (this.bitPos > 0) {
      this.bytePos++;
    }
    return this.buffer.slice(0, this.bytePos);
  }

  private writeBit(bit: number): void {
    if (this.bitPos === 0) {
      this.buffer[this.bytePos] = 0;
    }
    if (bit) {
      this.buffer[this.bytePos] |= (1 << (7 - this.bitPos));
    }
    this.bitPos++;
    if (this.bitPos === 8) {
      this.bitPos = 0;
      this.bytePos++;
    }
  }

  private writeBits(value: bigint, bits: number): void {
    for (let i = bits - 1; i >= 0; i--) {
      this.writeBit(Number((value >> BigInt(i)) & 1n));
    }
  }
}

/**
 * Gorilla XOR 解压器
 */
export class GorillaDecompressor {
  private buffer: Uint8Array;
  private bitPos: number = 0;
  private bytePos: number = 0;
  private prevValue: bigint = 0n;
  private prevLeadingZeros: number = -1;
  private prevTrailingZeros: number = 0;
  private first: boolean = true;

  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
  }

  /**
   * 解压下一个值
   */
  decompress(): number | null {
    if (this.first) {
      const bits = this.readBits(64);
      this.prevValue = bits;
      this.first = false;
      return BitsToDouble(Number(bits));
    }

    if (this.bytePos >= this.buffer.length) {
      return null;
    }

    const same = this.readBit();
    if (same === 0) {
      // 值相同
      return BitsToDouble(Number(this.prevValue));
    }

    let leadingZeros: number;
    let meaningfulBits: number;

    const usePrevious = this.readBit();
    if (usePrevious === 0) {
      // 使用之前的块描述
      leadingZeros = this.prevLeadingZeros;
      meaningfulBits = 64 - leadingZeros - this.prevTrailingZeros;
    } else {
      // 新的块描述
      leadingZeros = Number(this.readBits(6));
      meaningfulBits = Number(this.readBits(6));
      this.prevTrailingZeros = 64 - leadingZeros - meaningfulBits;
    }

    const xor = this.readBits(meaningfulBits) << BigInt(this.prevTrailingZeros);
    const value = this.prevValue ^ xor;
    
    this.prevValue = value;
    this.prevLeadingZeros = leadingZeros;

    return BitsToDouble(Number(value));
  }

  private readBit(): number {
    if (this.bytePos >= this.buffer.length) return 0;
    const bit = (this.buffer[this.bytePos] >> (7 - this.bitPos)) & 1;
    this.bitPos++;
    if (this.bitPos === 8) {
      this.bitPos = 0;
      this.bytePos++;
    }
    return bit;
  }

  private readBits(bits: number): bigint {
    let result = 0n;
    for (let i = 0; i < bits; i++) {
      result = (result << 1n) | BigInt(this.readBit());
    }
    return result;
  }
}

/**
 * Delta-of-Delta 时间戳压缩
 * 适合规律的时间序列（如每秒一个数据点）
 */
export class DeltaCompressor {
  private timestamps: number[] = [];
  private deltas: number[] = [];

  compress(timestamps: number[]): Uint8Array {
    if (timestamps.length < 2) {
      return new Uint8Array(new Float64Array(timestamps).buffer);
    }

    // 第一个时间戳
    let prev = timestamps[0];
    let prevDelta = timestamps[1] - timestamps[0];

    // 使用 Varint 编码 delta-of-delta
    const writer = new VarintWriter();
    writer.writeFloat64(prev);
    writer.writeVarint(prevDelta);

    for (let i = 2; i < timestamps.length; i++) {
      const delta = timestamps[i] - prev;
      const deltaOfDelta = delta - prevDelta;
      
      writer.writeVarint(deltaOfDelta);
      
      prev = timestamps[i];
      prevDelta = delta;
    }

    return writer.finish();
  }

  decompress(buffer: Uint8Array): number[] {
    const reader = new VarintReader(buffer);
    const result: number[] = [];

    let prev = reader.readFloat64();
    let prevDelta = reader.readVarint();

    result.push(prev);
    result.push(prev + prevDelta);

    while (reader.hasMore()) {
      const deltaOfDelta = reader.readVarint();
      const delta = prevDelta + deltaOfDelta;
      const timestamp = prev + delta;
      
      result.push(timestamp);
      
      prev = timestamp;
      prevDelta = delta;
    }

    return result;
  }
}

/**
 * Delta 编码器（int64/bigint）
 * 适用于单调递增序列（如 ID、递增的 timestamp）
 */
export class DeltaEncoderInt64 {
  compress(values: BigInt64Array): Uint8Array {
    if (values.length === 0) return new Uint8Array(0);
    if (values.length === 1) {
      const buf = Buffer.allocUnsafe(8);
      buf.writeBigInt64LE(values[0]);
      return new Uint8Array(buf);
    }

    const writer = new VarintWriter();
    writer.writeBigInt64(values[0]); // 第一个值完整存储

    for (let i = 1; i < values.length; i++) {
      const delta = Number(values[i] - values[i - 1]);
      writer.writeVarint(delta);
    }

    return writer.finish();
  }

  decompress(buffer: Uint8Array, count: number): BigInt64Array {
    if (buffer.length === 0) return new BigInt64Array(0);

    const reader = new VarintReader(buffer);
    const result = new BigInt64Array(count);

    result[0] = reader.readBigInt64();

    for (let i = 1; i < count; i++) {
      const delta = BigInt(reader.readVarint());
      result[i] = result[i - 1] + delta;
    }

    return result;
  }
}

/**
 * Delta 编码器（int32）
 */
export class DeltaEncoderInt32 {
  compress(values: Int32Array): Uint8Array {
    if (values.length === 0) return new Uint8Array(0);
    if (values.length === 1) {
      const buf = Buffer.allocUnsafe(4);
      buf.writeInt32LE(values[0]);
      return new Uint8Array(buf);
    }

    const writer = new VarintWriter();
    writer.writeInt32(values[0]);

    for (let i = 1; i < values.length; i++) {
      const delta = values[i] - values[i - 1];
      writer.writeVarint(delta);
    }

    return writer.finish();
  }

  decompress(buffer: Uint8Array, count: number): Int32Array {
    if (buffer.length === 0) return new Int32Array(0);

    const reader = new VarintReader(buffer);
    const result = new Int32Array(count);

    result[0] = reader.readInt32();

    for (let i = 1; i < count; i++) {
      const delta = reader.readVarint();
      result[i] = result[i - 1] + delta;
    }

    return result;
  }
}

/**
 * Gorilla 编码器（Float64 数组）
 * 适用于浮点数时序数据（价格、指标等）
 * 压缩率：70-90%
 */
export class GorillaEncoder {
  compress(values: Float64Array): Uint8Array {
    if (values.length === 0) return new Uint8Array(0);

    const compressor = new GorillaCompressor(values.length * 8 * 2); // 预留空间
    for (let i = 0; i < values.length; i++) {
      compressor.compress(values[i]);
    }
    return compressor.finish();
  }

  decompress(buffer: Uint8Array, count: number): Float64Array {
    if (buffer.length === 0) return new Float64Array(0);

    const decompressor = new GorillaDecompressor(buffer);
    const result = new Float64Array(count);

    for (let i = 0; i < count; i++) {
      const value = decompressor.decompress();
      if (value === null) break;
      result[i] = value;
    }

    return result;
  }
}

/**
 * RLE (Run-Length Encoding) 编码器
 * 适用于有大量重复值的序列（如状态字段、symbol ID）
 */
export class RLEEncoder {
  compress(values: Int32Array): Uint8Array {
    if (values.length === 0) return new Uint8Array(0);

    const writer = new VarintWriter();
    let runValue = values[0];
    let runLength = 1;

    for (let i = 1; i < values.length; i++) {
      if (values[i] === runValue) {
        runLength++;
      } else {
        writer.writeInt32(runValue);
        writer.writeVarint(runLength);
        runValue = values[i];
        runLength = 1;
      }
    }

    // 写入最后一个 run
    writer.writeInt32(runValue);
    writer.writeVarint(runLength);

    return writer.finish();
  }

  decompress(buffer: Uint8Array, count: number): Int32Array {
    const reader = new VarintReader(buffer);
    const result = new Int32Array(count);
    let pos = 0;

    while (reader.hasMore() && pos < count) {
      const value = reader.readInt32();
      const length = reader.readVarint();

      for (let i = 0; i < length && pos < count; i++) {
        result[pos++] = value;
      }
    }

    return result;
  }
}

// Varint 编码器 (简化版)
class VarintWriter {
  private buffer: number[] = [];

  writeFloat64(value: number): void {
    const arr = new Float64Array([value]);
    const bytes = new Uint8Array(arr.buffer);
    this.buffer.push(...bytes);
  }

  writeBigInt64(value: bigint): void {
    const arr = new BigInt64Array([value]);
    const bytes = new Uint8Array(arr.buffer);
    this.buffer.push(...bytes);
  }

  writeInt32(value: number): void {
    const arr = new Int32Array([value]);
    const bytes = new Uint8Array(arr.buffer);
    this.buffer.push(...bytes);
  }

  writeVarint(value: number): void {
    // 使用 zigzag 编码处理负数
    value = value < 0 ? (Math.abs(value) * 2 - 1) : (value * 2);
    
    while (value >= 128) {
      this.buffer.push((value & 0x7f) | 0x80);
      value >>= 7;
    }
    this.buffer.push(value);
  }

  finish(): Uint8Array {
    return new Uint8Array(this.buffer);
  }
}

class VarintReader {
  private buffer: Uint8Array;
  private pos = 0;

  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
  }

  readFloat64(): number {
    const bytes = this.buffer.slice(this.pos, this.pos + 8);
    this.pos += 8;
    return new Float64Array(bytes.buffer)[0];
  }

  readBigInt64(): bigint {
    const bytes = this.buffer.slice(this.pos, this.pos + 8);
    this.pos += 8;
    return new BigInt64Array(bytes.buffer)[0];
  }

  readInt32(): number {
    const bytes = this.buffer.slice(this.pos, this.pos + 4);
    this.pos += 4;
    return new Int32Array(bytes.buffer)[0];
  }

  readVarint(): number {
    let result = 0;
    let shift = 0;
    
    while (this.pos < this.buffer.length) {
      const byte = this.buffer[this.pos++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    
    // zigzag 解码
    return (result & 1) ? -(result >> 1) - 1 : result >> 1;
  }

  hasMore(): boolean {
    return this.pos < this.buffer.length;
  }
}

// 辅助函数: double <-> bits
function DoubleToBits(value: number): bigint {
  const arr = new Float64Array(1);
  arr[0] = value;
  return new BigInt64Array(arr.buffer)[0];
}

function BitsToDouble(bits: number): number {
  const arr = new BigInt64Array(1);
  arr[0] = BigInt(bits);
  return new Float64Array(arr.buffer)[0];
}

// ============================================================
// Brotli 压缩 - 通用压缩算法（Bun 内置）
// ============================================================

/**
 * Brotli 压缩器（支持所有数据类型）
 * 
 * 特点：
 * - 压缩率：50-70%（通用数据，类似 zstd）
 * - 速度：比 gzip 慢但压缩率更好
 * - 内置：无需外部依赖
 * - 适用场景：Gorilla 效果不好的浮点数
 */
export class BrotliCompressor {
  private level: number;

  constructor(level: number = 4) {
    // brotli 压缩级别：0-11（默认 4，平衡速度和压缩率）
    this.level = Math.max(0, Math.min(11, level));
  }

  /**
   * 压缩 Float64Array
   */
  compressFloat64(values: Float64Array): Uint8Array {
    const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
    return brotliCompressSync(bytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: this.level } });
  }

  /**
   * 解压 Float64Array
   */
  decompressFloat64(buffer: Uint8Array, count: number): Float64Array {
    const decompressed = brotliDecompressSync(buffer);
    return new Float64Array(decompressed.buffer, decompressed.byteOffset, count);
  }

  /**
   * 压缩 Int32Array
   */
  compressInt32(values: Int32Array): Uint8Array {
    const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
    return brotliCompressSync(bytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: this.level } });
  }

  /**
   * 解压 Int32Array
   */
  decompressInt32(buffer: Uint8Array, count: number): Int32Array {
    const decompressed = brotliDecompressSync(buffer);
    return new Int32Array(decompressed.buffer, decompressed.byteOffset, count);
  }

  /**
   * 压缩 BigInt64Array
   */
  compressBigInt64(values: BigInt64Array): Uint8Array {
    const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
    return brotliCompressSync(bytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: this.level } });
  }

  /**
   * 解压 BigInt64Array
   */
  decompressBigInt64(buffer: Uint8Array, count: number): BigInt64Array {
    const decompressed = brotliDecompressSync(buffer);
    return new BigInt64Array(decompressed.buffer, decompressed.byteOffset, count);
  }

  /**
   * 压缩 Uint8Array（通用）
   */
  compress(data: Uint8Array): Uint8Array {
    return brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: this.level } });
  }

  /**
   * 解压 Uint8Array（通用）
   */
  decompress(buffer: Uint8Array): Uint8Array {
    return brotliDecompressSync(buffer);
  }
}



