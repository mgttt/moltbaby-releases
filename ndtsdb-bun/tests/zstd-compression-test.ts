#!/usr/bin/env bun
/**
 * P2: Brotli 压缩率测试
 * 
 * 对比：
 * - Gorilla 压缩
 * - Brotli 压缩（Bun 内置，类似 zstd 的压缩率）
 * 
 * 数据：仿真真实 K 线（5000 条）
 */

import { PartitionedTable } from '../src/partition';
import { existsSync, rmSync, statSync } from 'fs';

interface Kline {
  symbol: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// 生成仿真真实数据（与 real-data-validation.ts 相同）
function generateRealisticKlines(symbol: string, count: number = 1000): Kline[] {
  const klines: Kline[] = [];
  
  let basePrice = 50000;
  if (symbol.includes('ETH')) basePrice = 3000;
  if (symbol.includes('BNB')) basePrice = 500;
  if (symbol.includes('SOL')) basePrice = 100;
  if (symbol.includes('ADA')) basePrice = 0.5;
  
  let currentPrice = basePrice;
  const startTime = Date.now() - count * 60_000;
  
  const drift = 0.00001;
  const volatility = 0.0005;
  const volumeMean = 100;
  const volumeStd = 50;
  
  const boxMuller = () => {
    const u1 = Math.random();
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  
  for (let i = 0; i < count; i++) {
    const dW = boxMuller();
    const change = drift + volatility * dW;
    
    const open = currentPrice;
    const close = open * (1 + change);
    
    const range = Math.abs(close - open) * (1 + Math.random() * 2);
    const high = Math.max(open, close) + range * Math.random();
    const low = Math.min(open, close) - range * Math.random();
    
    const volume = Math.max(0, volumeMean + (Math.random() - 0.5) * volumeStd * 2);
    
    klines.push({
      symbol,
      timestamp: startTime + i * 60_000,
      open,
      high,
      low,
      close,
      volume,
    });
    
    currentPrice = close;
  }
  
  return klines;
}

async function main() {
  console.log('======================================================================');
  console.log('   Brotli vs Gorilla 压缩率对比测试');
  console.log('======================================================================\n');

  const symbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'ADAUSDT'];
  const allKlines: Array<Kline & { symbol_id: number }> = [];
  
  for (let i = 0; i < symbols.length; i++) {
    const klines = generateRealisticKlines(symbols[i], 1000);
    for (const k of klines) {
      allKlines.push({ ...k, symbol_id: i });
    }
  }
  
  console.log(`[数据] 生成了 ${allKlines.length.toLocaleString()} 条仿真 K 线\n`);

  // 测试 1: Gorilla 压缩
  console.log('[测试 1] Gorilla 压缩（旧方案）\n');
  
  const testDir1 = './data/test-gorilla';
  if (existsSync(testDir1)) rmSync(testDir1, { recursive: true });
  
  const table1 = new PartitionedTable(
    testDir1,
    [
      { name: 'symbol_id', type: 'int32' },
      { name: 'timestamp', type: 'int64' },
      { name: 'open', type: 'float64' },
      { name: 'high', type: 'float64' },
      { name: 'low', type: 'float64' },
      { name: 'close', type: 'float64' },
      { name: 'volume', type: 'float64' },
    ],
    { type: 'hash', column: 'symbol_id', buckets: 10 },
    {
      compression: {
        enabled: true,
        algorithms: {
          timestamp: 'delta',
          open: 'gorilla',
          high: 'gorilla',
          low: 'gorilla',
          close: 'gorilla',
          volume: 'gorilla',
        },
      },
    }
  );

  table1.append(allKlines);
  
  let size1 = 0;
  for (const p of table1.getPartitions()) {
    size1 += statSync(p.path).size;
  }
  
  console.log(`  压缩后大小：${(size1 / 1024).toFixed(2)} KB`);

  // 测试 2: Brotli 压缩
  console.log('\n[测试 2] Brotli 压缩（新方案）\n');
  
  const testDir2 = './data/test-brotli';
  if (existsSync(testDir2)) rmSync(testDir2, { recursive: true });
  
  const table2 = new PartitionedTable(
    testDir2,
    [
      { name: 'symbol_id', type: 'int32' },
      { name: 'timestamp', type: 'int64' },
      { name: 'open', type: 'float64' },
      { name: 'high', type: 'float64' },
      { name: 'low', type: 'float64' },
      { name: 'close', type: 'float64' },
      { name: 'volume', type: 'float64' },
    ],
    { type: 'hash', column: 'symbol_id', buckets: 10 },
    {
      compression: {
        enabled: true,
        algorithms: {
          timestamp: 'delta',
          open: 'zstd',
          high: 'zstd',
          low: 'zstd',
          close: 'zstd',
          volume: 'zstd',
        },
      },
    }
  );

  table2.append(allKlines);
  
  let size2 = 0;
  for (const p of table2.getPartitions()) {
    size2 += statSync(p.path).size;
  }
  
  console.log(`  压缩后大小：${(size2 / 1024).toFixed(2)} KB`);

  // 对比
  console.log('\n[对比结果]\n');
  
  const rawSize = allKlines.length * 7 * 8; // 7列 × 8字节
  const ratio1 = size1 / rawSize;
  const ratio2 = size2 / rawSize;
  const improvement = (size1 - size2) / size1;
  
  console.log(`  原始数据：${(rawSize / 1024).toFixed(2)} KB`);
  console.log(`  Gorilla 压缩：${(size1 / 1024).toFixed(2)} KB (${(ratio1 * 100).toFixed(1)}%)`);
  console.log(`  Brotli 压缩：${(size2 / 1024).toFixed(2)} KB (${(ratio2 * 100).toFixed(1)}%)`);
  console.log(`  改进：${(improvement * 100).toFixed(1)}% (节省 ${((size1 - size2) / 1024).toFixed(2)} KB)\n`);

  if (ratio2 < 0.30) {
    console.log(`  ✅ Brotli 压缩效果优秀（< 30%）`);
  } else if (ratio2 < 0.50) {
    console.log(`  ✅ Brotli 压缩效果良好（< 50%）`);
  } else {
    console.log(`  ⚠️  Brotli 压缩效果一般（>= 50%）`);
  }
  
  console.log();

  // 验证数据正确性
  console.log('[验证] 数据正确性\n');
  
  const query1 = table1.query(row => row.symbol_id === 0);
  const query2 = table2.query(row => row.symbol_id === 0);
  
  if (query1.length === query2.length && query1.length === 1000) {
    console.log(`  ✅ 查询返回行数一致：${query1.length} 条`);
    
    // 检查前 10 行数据是否一致
    let allMatch = true;
    for (let i = 0; i < 10; i++) {
      const r1 = query1[i];
      const r2 = query2[i];
      
      if (
        Math.abs(r1.open - r2.open) > 0.001 ||
        Math.abs(r1.high - r2.high) > 0.001 ||
        Math.abs(r1.low - r2.low) > 0.001 ||
        Math.abs(r1.close - r2.close) > 0.001
      ) {
        allMatch = false;
        break;
      }
    }
    
    if (allMatch) {
      console.log(`  ✅ 数据值一致（前 10 行验证通过）\n`);
    } else {
      console.log(`  ❌ 数据值不一致\n`);
    }
  } else {
    console.log(`  ❌ 查询返回行数不一致\n`);
  }

  console.log('✅ 测试完成\n');
}

main().catch(console.error);
