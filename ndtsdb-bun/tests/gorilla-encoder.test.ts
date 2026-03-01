/**
 * GorillaEncoder 单元测试
 */

import { describe, it, expect } from 'bun:test';
import { GorillaEncoder } from '../src/compression';

describe('GorillaEncoder', () => {
  it('should compress and decompress float64 array', () => {
    const encoder = new GorillaEncoder();

    // 原始数据
    const original = new Float64Array([100.0, 100.5, 101.2, 100.8, 101.5]);

    // 压缩
    const compressed = encoder.compress(original);
    console.log(`Original size: ${original.byteLength} bytes`);
    console.log(`Compressed size: ${compressed.byteLength} bytes`);
    console.log(`Compression ratio: ${(1 - compressed.byteLength / original.byteLength) * 100}%`);

    // 解压
    const decompressed = encoder.decompress(compressed, original.length);

    // 验证
    expect(decompressed.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(decompressed[i]).toBeCloseTo(original[i], 10); // 精度误差
    }
  });

  it('should compress larger dataset', () => {
    const encoder = new GorillaEncoder();

    // 生成 100 个价格
    const original = new Float64Array(100);
    let price = 100.0;
    for (let i = 0; i < 100; i++) {
      price += (Math.random() - 0.5) * 0.5;
      original[i] = price;
    }

    // 压缩
    const compressed = encoder.compress(original);
    const compressionRatio = 1 - compressed.byteLength / original.byteLength;

    console.log(`\nLarge dataset:`);
    console.log(`  Original size: ${original.byteLength} bytes`);
    console.log(`  Compressed size: ${compressed.byteLength} bytes`);
    console.log(`  Compression ratio: ${(compressionRatio * 100).toFixed(2)}%`);

    // Gorilla 压缩率通常 70-90%，但小数据集可能较低
    expect(compressed.byteLength).toBeLessThan(original.byteLength);

    // 解压验证
    const decompressed = encoder.decompress(compressed, original.length);
    expect(decompressed.length).toBe(original.length);

    // 验证前几个值
    for (let i = 0; i < Math.min(10, original.length); i++) {
      expect(decompressed[i]).toBeCloseTo(original[i], 10);
    }
  });
});
