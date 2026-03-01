/**
 * Gorilla 压缩测试 - 平滑数据
 */

import { describe, it, expect } from 'bun:test';
import { GorillaEncoder } from '../src/compression';

describe('Gorilla with Smooth Data', () => {
  it('should compress sine wave better than random data', () => {
    const encoder = new GorillaEncoder();

    // 生成正弦波（平滑数据）
    const sine = new Float64Array(100);
    for (let i = 0; i < 100; i++) {
      sine[i] = 100 + Math.sin(i * 0.1) * 10;
    }

    const compressedSine = encoder.compress(sine);
    const sineCR = 1 - compressedSine.byteLength / sine.byteLength;

    console.log(`\nSine wave (smooth):`);
    console.log(`  Original: ${sine.byteLength} bytes`);
    console.log(`  Compressed: ${compressedSine.byteLength} bytes`);
    console.log(`  Compression ratio: ${(sineCR * 100).toFixed(2)}%`);

    // 验证解压
    const decompressed = encoder.decompress(compressedSine, sine.length);
    for (let i = 0; i < sine.length; i++) {
      expect(decompressed[i]).toBeCloseTo(sine[i], 10);
    }
  });

  it('should compress constant values very well', () => {
    const encoder = new GorillaEncoder();

    // 生成常量数据（最佳情况）
    const constant = new Float64Array(100).fill(100.0);

    const compressed = encoder.compress(constant);
    const cr = 1 - compressed.byteLength / constant.byteLength;

    console.log(`\nConstant values:`);
    console.log(`  Original: ${constant.byteLength} bytes`);
    console.log(`  Compressed: ${compressed.byteLength} bytes`);
    console.log(`  Compression ratio: ${(cr * 100).toFixed(2)}%`);

    // 常量值压缩率应该非常高
    expect(compressed.byteLength).toBeLessThan(constant.byteLength * 0.3);
  });

  it('should compress slowly changing values well', () => {
    const encoder = new GorillaEncoder();

    // 生成缓慢变化的数据（如股价）
    const prices = new Float64Array(100);
    let price = 100.0;
    for (let i = 0; i < 100; i++) {
      price += (Math.random() - 0.5) * 0.1; // 小幅波动
      prices[i] = price;
    }

    const compressed = encoder.compress(prices);
    const cr = 1 - compressed.byteLength / prices.byteLength;

    console.log(`\nSlowly changing prices:`);
    console.log(`  Original: ${prices.byteLength} bytes`);
    console.log(`  Compressed: ${compressed.byteLength} bytes`);
    console.log(`  Compression ratio: ${(cr * 100).toFixed(2)}%`);
  });

  it('should compare random vs smooth data', () => {
    const encoder1 = new GorillaEncoder();
    const encoder2 = new GorillaEncoder();

    // 随机数据
    const random = new Float64Array(100);
    for (let i = 0; i < 100; i++) {
      random[i] = Math.random() * 100;
    }

    // 平滑数据
    const smooth = new Float64Array(100);
    let val = 100.0;
    for (let i = 0; i < 100; i++) {
      val += (Math.random() - 0.5) * 0.05; // 非常小的波动
      smooth[i] = val;
    }

    const compressedRandom = encoder1.compress(random);
    const compressedSmooth = encoder2.compress(smooth);

    console.log(`\nRandom vs Smooth:`);
    console.log(`  Random: ${compressedRandom.byteLength} bytes (${((1 - compressedRandom.byteLength / random.byteLength) * 100).toFixed(2)}%)`);
    console.log(`  Smooth: ${compressedSmooth.byteLength} bytes (${((1 - compressedSmooth.byteLength / smooth.byteLength) * 100).toFixed(2)}%)`);

    // 平滑数据压缩率应该更好
    expect(compressedSmooth.byteLength).toBeLessThan(compressedRandom.byteLength);
  });
});
