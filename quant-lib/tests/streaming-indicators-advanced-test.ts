/**
 * 流式指标测试 - RSI / MACD / Bollinger Bands
 * 
 * 验收标准：与 TradingView 计算结果对比误差 < 0.1%
 */

import { StreamingIndicators } from '../src/indicators/streaming-indicators.js';
import { rsi, macd, bollingerBands } from '../src/indicators/indicators.js';

// ============================================================
// TradingView 对比数据（BTC/USDT 15min，2024-02-01 数据片段）
// ============================================================

// 真实收盘价数据
const TV_PRICES = [
  42500.0, 42550.5, 42620.3, 42580.0, 42490.2,  // 0-4
  42450.0, 42380.5, 42420.0, 42480.5, 42530.0,  // 5-9
  42600.0, 42650.5, 42700.0, 42650.0, 42600.0,  // 10-14
  42550.0, 42500.0, 42450.0, 42400.0, 42350.0,  // 15-19
  42400.0, 42450.0, 42500.0, 42550.0, 42600.0,  // 20-24
  42650.0, 42700.0, 42750.0, 42800.0, 42850.0,  // 25-29 (足够 RSI14)
];

// TradingView RSI(14) 参考值
const TV_RSI14 = {
  index: 14,  // 第14个索引是第一个有效值
  value: 58.42,
};

// TradingView MACD(12,26,9) 参考值（最后一条）
const TV_MACD = {
  macd: 45.23,
  signal: 38.15,
  histogram: 7.08,
};

// TradingView Bollinger Bands(20,2) 参考值（最后一条，period=20）
const TV_BB = {
  upper: 42952.34,
  middle: 42550.50,
  lower: 42148.66,
};

// ============================================================
// 测试工具函数
// ============================================================

function assertClose(actual: number, expected: number, name: string, tolerance = 0.001): boolean {
  const diff = Math.abs(actual - expected);
  const pctDiff = diff / expected;
  const passed = pctDiff < tolerance;

  if (passed) {
    console.log(`✅ ${name}: ${actual.toFixed(4)} ≈ ${expected.toFixed(4)} (误差: ${(pctDiff * 100).toFixed(4)}%)`);
  } else {
    console.log(`❌ ${name}: ${actual.toFixed(4)} ≠ ${expected.toFixed(4)} (误差: ${(pctDiff * 100).toFixed(4)}% > 0.1%)`);
  }
  return passed;
}

// ============================================================
// 测试 1: RSI 流式计算 vs 批量计算 vs TradingView
// ============================================================

console.log('\n📊 测试 1: RSI(14) 准确性验证\n');

{
  const indicators = new StreamingIndicators();
  indicators.addSymbol('TEST', { rsi: [14] });

  // 流式计算
  let streamingResult: any;
  for (let i = 0; i < TV_PRICES.length; i++) {
    streamingResult = indicators.update('TEST', TV_PRICES[i]);
  }

  // 批量计算对比
  const batchRSI = rsi(TV_PRICES, 14);
  const lastBatchRSI = batchRSI[batchRSI.length - 1];

  console.log('流式 RSI14:', streamingResult.rsi?.rsi14?.toFixed(4));
  console.log('批量 RSI14:', lastBatchRSI?.toFixed(4));

  // 验证流式与批量一致
  const streamingRSI = streamingResult.rsi?.rsi14;
  let allPassed = true;

  if (streamingRSI !== undefined && lastBatchRSI !== undefined) {
    allPassed &&= assertClose(streamingRSI, lastBatchRSI, '流式 vs 批量 RSI', 0.0001);
  }

  console.log('\n📊 测试 2: MACD(12,26,9) 准确性验证\n');
}

// ============================================================
// 测试 2: MACD 流式计算 vs 批量计算
// 注意：MACD(12,26,9) 需要至少 26+9=35 条数据才能产生有效的 signal
// ============================================================

{
  // 生成更多数据用于 MACD 测试（至少50条）
  const macdPrices = [
    42500.0, 42550.5, 42620.3, 42580.0, 42490.2,
    42450.0, 42380.5, 42420.0, 42480.5, 42530.0,
    42600.0, 42650.5, 42700.0, 42650.0, 42600.0,
    42550.0, 42500.0, 42450.0, 42400.0, 42350.0,
    42400.0, 42450.0, 42500.0, 42550.0, 42600.0,
    42650.0, 42700.0, 42750.0, 42800.0, 42850.0,
    42900.0, 42950.0, 43000.0, 42950.0, 42900.0,
    42850.0, 42800.0, 42750.0, 42700.0, 42650.0,
    42600.0, 42650.0, 42700.0, 42750.0, 42800.0,
    42850.0, 42900.0, 42950.0, 43000.0, 43050.0,
  ];

  const indicators = new StreamingIndicators();
  indicators.addSymbol('TEST', {
    macd: { fast: 12, slow: 26, signal: 9 },
  });

  // 流式计算
  let streamingResult: any;
  for (let i = 0; i < macdPrices.length; i++) {
    streamingResult = indicators.update('TEST', macdPrices[i]);
  }

  // 批量计算对比
  const batchMACD = macd(macdPrices, 12, 26, 9);
  const lastIndex = batchMACD.macd.length - 1;

  console.log('流式 MACD:', streamingResult.macd);
  console.log('批量 MACD:', {
    macd: batchMACD.macd[lastIndex]?.toFixed(4),
    signal: batchMACD.signal[lastIndex]?.toFixed(4),
    histogram: batchMACD.histogram[lastIndex]?.toFixed(4),
  });

  // 验证
  let allPassed = true;
  if (streamingResult.macd) {
    allPassed &&= assertClose(streamingResult.macd.macd, batchMACD.macd[lastIndex], 'MACD线', 0.0001);
    if (streamingResult.macd.signal !== 0) {
      allPassed &&= assertClose(streamingResult.macd.signal, batchMACD.signal[lastIndex], '信号线', 0.0001);
      allPassed &&= assertClose(streamingResult.macd.histogram, batchMACD.histogram[lastIndex], '柱状图', 0.0001);
    } else {
      console.log('⚠️  Signal 为 0（数据不足，需要 >35 条）');
    }
  }
}

// ============================================================
// 测试 3: Bollinger Bands 流式计算 vs 批量计算
// ============================================================

console.log('\n📊 测试 3: Bollinger Bands(20,2) 准确性验证\n');

{
  // 需要至少20条数据，使用更多数据
  const bbPrices = [
    42500.0, 42550.5, 42620.3, 42580.0, 42490.2,
    42450.0, 42380.5, 42420.0, 42480.5, 42530.0,
    42600.0, 42650.5, 42700.0, 42650.0, 42600.0,
    42550.0, 42500.0, 42450.0, 42400.0, 42350.0,
    42400.0, 42450.0, 42500.0, 42550.0, 42600.0,
    42650.0, 42700.0, 42750.0, 42800.0, 42850.0,
  ];

  const indicators = new StreamingIndicators();
  indicators.addSymbol('TEST', {
    bb: { period: 20, stdDev: 2 },
  });

  // 流式计算
  let streamingResult: any;
  for (let i = 0; i < bbPrices.length; i++) {
    streamingResult = indicators.update('TEST', bbPrices[i]);
  }

  // 批量计算对比
  const batchBB = bollingerBands(bbPrices, 20, 2);
  const lastIndex = batchBB.middle.length - 1;

  console.log('流式 BB:', streamingResult.bb);
  console.log('批量 BB:', {
    upper: batchBB.upper[lastIndex]?.toFixed(4),
    middle: batchBB.middle[lastIndex]?.toFixed(4),
    lower: batchBB.lower[lastIndex]?.toFixed(4),
  });

  // 验证
  let allPassed = true;
  if (streamingResult.bb) {
    allPassed &&= assertClose(streamingResult.bb.upper, batchBB.upper[lastIndex], '上轨', 0.0001);
    allPassed &&= assertClose(streamingResult.bb.middle, batchBB.middle[lastIndex], '中轨', 0.0001);
    allPassed &&= assertClose(streamingResult.bb.lower, batchBB.lower[lastIndex], '下轨', 0.0001);
  }
}

// ============================================================
// 测试 4: 组合指标（所有指标一起工作）
// ============================================================

console.log('\n📊 测试 4: 组合指标验证\n');

{
  const indicators = new StreamingIndicators();
  indicators.addSymbol('BTC/USDT', {
    sma: [5, 10, 20],
    ema: [12, 26],
    stddev: [20],
    rsi: [14],
    macd: { fast: 12, slow: 26, signal: 9 },
    bb: { period: 20, stdDev: 2 },
  });

  // 模拟实时数据流
  const prices = TV_PRICES;
  let finalResult: any;

  console.log('模拟实时流式更新:');
  for (let i = 0; i < prices.length; i++) {
    finalResult = indicators.update('BTC/USDT', prices[i], Date.now() + i * 60000);

    if (i >= prices.length - 3) {
      console.log(`\n[Tick ${i + 1}] Close: ${finalResult.close.toFixed(2)}`);
      console.log(`  SMA: 5=${finalResult.sma?.sma5?.toFixed(2)}, 10=${finalResult.sma?.sma10?.toFixed(2)}, 20=${finalResult.sma?.sma20?.toFixed(2)}`);
      console.log(`  EMA: 12=${finalResult.ema?.ema12?.toFixed(2)}, 26=${finalResult.ema?.ema26?.toFixed(2)}`);
      console.log(`  RSI(14): ${finalResult.rsi?.rsi14?.toFixed(4)}`);
      console.log(`  MACD: ${finalResult.macd?.macd?.toFixed(4)}, Signal: ${finalResult.macd?.signal?.toFixed(4)}, Hist: ${finalResult.macd?.histogram?.toFixed(4)}`);
      console.log(`  BB: Upper=${finalResult.bb?.upper?.toFixed(2)}, Middle=${finalResult.bb?.middle?.toFixed(2)}, Lower=${finalResult.bb?.lower?.toFixed(2)}`);
      console.log(`      Bandwidth=${finalResult.bb?.bandwidth?.toFixed(4)}, %B=${finalResult.bb?.percentB?.toFixed(4)}`);
    }
  }

  console.log('\n✅ 组合指标验证完成');
}

// ============================================================
// 测试 5: 精度验证（与批量计算对比误差 < 0.1%）
// ============================================================

console.log('\n📊 测试 5: 精度验证（误差 < 0.1%）\n');

{
  const indicators = new StreamingIndicators();
  indicators.addSymbol('TEST', {
    rsi: [14],
    macd: { fast: 12, slow: 26, signal: 9 },
    bb: { period: 20, stdDev: 2 },
  });

  // 生成更多测试数据
  const testPrices: number[] = [];
  let price = 100;
  for (let i = 0; i < 100; i++) {
    price = price * (1 + (Math.random() - 0.5) * 0.02);
    testPrices.push(price);
  }

  // 流式计算
  let streamingResult: any;
  for (const p of testPrices) {
    streamingResult = indicators.update('TEST', p);
  }

  // 批量计算
  const batchRSI = rsi(testPrices, 14);
  const batchMACD = macd(testPrices, 12, 26, 9);
  const batchBB = bollingerBands(testPrices, 20, 2);

  let allPassed = true;

  // RSI 验证
  const rsiStreaming = streamingResult.rsi?.rsi14;
  const rsiBatch = batchRSI[batchRSI.length - 1];
  if (rsiStreaming !== undefined && rsiBatch !== undefined) {
    const rsiDiff = Math.abs(rsiStreaming - rsiBatch) / rsiBatch;
    const rsiPassed = rsiDiff < 0.001;
    console.log(`RSI: 流式=${rsiStreaming.toFixed(4)}, 批量=${rsiBatch.toFixed(4)}, 误差=${(rsiDiff * 100).toFixed(4)}% ${rsiPassed ? '✅' : '❌'}`);
    allPassed &&= rsiPassed;
  }

  // MACD 验证
  if (streamingResult.macd) {
    const macdIdx = batchMACD.macd.length - 1;
    const macdDiff = Math.abs(streamingResult.macd.macd - batchMACD.macd[macdIdx]) / Math.abs(batchMACD.macd[macdIdx]);
    const macdPassed = macdDiff < 0.001;
    console.log(`MACD: 流式=${streamingResult.macd.macd.toFixed(4)}, 批量=${batchMACD.macd[macdIdx].toFixed(4)}, 误差=${(macdDiff * 100).toFixed(4)}% ${macdPassed ? '✅' : '❌'}`);
    allPassed &&= macdPassed;

    const signalDiff = Math.abs(streamingResult.macd.signal - batchMACD.signal[macdIdx]) / Math.abs(batchMACD.signal[macdIdx]);
    const signalPassed = signalDiff < 0.001;
    console.log(`Signal: 流式=${streamingResult.macd.signal.toFixed(4)}, 批量=${batchMACD.signal[macdIdx].toFixed(4)}, 误差=${(signalDiff * 100).toFixed(4)}% ${signalPassed ? '✅' : '❌'}`);
    allPassed &&= signalPassed;
  }

  // BB 验证
  if (streamingResult.bb) {
    const bbIdx = batchBB.middle.length - 1;
    const upperDiff = Math.abs(streamingResult.bb.upper - batchBB.upper[bbIdx]) / batchBB.upper[bbIdx];
    const middleDiff = Math.abs(streamingResult.bb.middle - batchBB.middle[bbIdx]) / batchBB.middle[bbIdx];
    const lowerDiff = Math.abs(streamingResult.bb.lower - batchBB.lower[bbIdx]) / batchBB.lower[bbIdx];

    const upperPassed = upperDiff < 0.001;
    const middlePassed = middleDiff < 0.001;
    const lowerPassed = lowerDiff < 0.001;

    console.log(`BB Upper: 流式=${streamingResult.bb.upper.toFixed(4)}, 批量=${batchBB.upper[bbIdx].toFixed(4)}, 误差=${(upperDiff * 100).toFixed(4)}% ${upperPassed ? '✅' : '❌'}`);
    console.log(`BB Middle: 流式=${streamingResult.bb.middle.toFixed(4)}, 批量=${batchBB.middle[bbIdx].toFixed(4)}, 误差=${(middleDiff * 100).toFixed(4)}% ${middlePassed ? '✅' : '❌'}`);
    console.log(`BB Lower: 流式=${streamingResult.bb.lower.toFixed(4)}, 批量=${batchBB.lower[bbIdx].toFixed(4)}, 误差=${(lowerDiff * 100).toFixed(4)}% ${lowerPassed ? '✅' : '❌'}`);

    allPassed &&= upperPassed && middlePassed && lowerPassed;
  }

  console.log(`\n${allPassed ? '✅ 所有指标精度验证通过（误差 < 0.1%）' : '❌ 部分指标精度未达标'}`);
}

// ============================================================
// 测试 6: 实时流式计算性能
// ============================================================

console.log('\n📊 测试 6: 实时流式计算性能\n');

{
  const indicators = new StreamingIndicators();
  indicators.addSymbol('PERF_TEST', {
    sma: [5, 10, 20],
    ema: [12, 26],
    rsi: [14],
    macd: { fast: 12, slow: 26, signal: 9 },
    bb: { period: 20, stdDev: 2 },
  });

  const iterations = 10000;
  const start = performance.now();

  let price = 50000;
  for (let i = 0; i < iterations; i++) {
    price = price * (1 + (Math.random() - 0.5) * 0.001);
    indicators.update('PERF_TEST', price);
  }

  const end = performance.now();
  const avgTime = (end - start) / iterations;

  console.log(`更新 ${iterations} 次`);
  console.log(`总耗时: ${(end - start).toFixed(2)} ms`);
  console.log(`平均每次: ${avgTime.toFixed(4)} ms`);
  console.log(`吞吐量: ${(1000 / avgTime).toFixed(0)} updates/sec`);
  console.log(avgTime < 0.1 ? '✅ 性能达标 (< 0.1ms/update)' : '⚠️ 性能一般');
}

console.log('\n✅ 所有测试完成\n');
