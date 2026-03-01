/**
 * NDTS 数据解压库 - Delta 和 Gorilla 压缩支持
 */

/**
 * Delta 解压 (前缀和) - 用于整数列
 */
export function deltaDecode(compressed: number[] | BigInt64Array | Int32Array): number[] | BigInt64Array {
  if (compressed.length === 0) return compressed instanceof BigInt64Array ? new BigInt64Array(0) : [];

  const result = compressed instanceof BigInt64Array
    ? new BigInt64Array(compressed.length)
    : new Array(compressed.length);

  result[0] = compressed[0];
  for (let i = 1; i < compressed.length; i++) {
    if (compressed instanceof BigInt64Array) {
      result[i] = result[i - 1] + compressed[i];
    } else {
      result[i] = result[i - 1] + compressed[i];
    }
  }

  return result;
}

/**
 * Gorilla 解压 - 用于浮点列
 * 简化实现 - 假设标准的 Gorilla XOR 编码
 */
export class GorillaBitReader {
  private buffer: Uint8Array;
  private bytePos: number = 0;
  private bitPos: number = 0;

  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
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

  private readBits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      value = (value << 1) | this.readBit();
    }
    return value;
  }

  decompress(maxCount: number): number[] {
    const result: number[] = [];
    if (this.buffer.length < 8) return result;

    // 读取第一个值（64 bits）
    let prevValue = this.readBits(64);
    result.push(this.bitsToDouble(prevValue));

    let prevLeading = -1;
    let prevTrailing = 0;

    while (result.length < maxCount && this.bytePos < this.buffer.length) {
      const same = this.readBit();

      if (same === 0) {
        // 相同值
        result.push(this.bitsToDouble(prevValue));
      } else {
        const usePrev = this.readBit();
        let leading: number, meaningful: number;

        if (usePrev === 0) {
          // 使用之前的块描述
          leading = prevLeading;
          meaningful = 64 - prevLeading - prevTrailing;
        } else {
          // 新的块描述
          leading = this.readBits(6);
          meaningful = this.readBits(6);
          prevLeading = leading;
          prevTrailing = 64 - leading - meaningful;
        }

        const xorVal = this.readBits(meaningful) << prevTrailing;
        prevValue = prevValue ^ xorVal;
        result.push(this.bitsToDouble(prevValue));
      }
    }

    return result;
  }

  private bitsToDouble(bits: number): number {
    // 将 64 位整数转换为 IEEE 754 double
    const buffer = new ArrayBuffer(8);
    const view = new BigUint64Array(buffer);
    view[0] = BigInt(bits);
    return new Float64Array(buffer)[0];
  }
}

/**
 * 读取 varint 编码的长度
 */
export function readVarint(buffer: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let pos = offset;

  while (pos < buffer.length) {
    const byte = buffer[pos];
    value |= (byte & 0x7f) << shift;
    pos++;

    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7;
  }

  return [value, pos - offset];
}
