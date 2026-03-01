#!/usr/bin/env bun
// ============================================================
// bench.js - 性能基准测试 (JSON输出格式，供CI使用)
// 使用 ColumnarTable 和 AppendWriter 进行测试
// ============================================================

import { ColumnarTable, AppendWriter } from '../src/index.js';
import { join } from 'path';

function generateRows(count, symbols) {
  const rows = [];
  
  for (let i = 0; i < count; i++) {
    rows.push({
      timestamp: 1700000000000n + BigInt(i),
      symbol: symbols[i % symbols.length],
      price: 100 + Math.random() * 50,
      volume: Math.floor(Math.random() * 10000),
    });
  }
  
  return rows;
}

async function benchmark() {
  const results = {
    timestamp: new Date().toISOString(),
    version: 'v0.9.5',
    write_rows_per_sec: 0,
    read_rows_per_sec: 0,
    binary_size_mb: 0
  };

  const PROJECT_DIR = import.meta.dir + '/..';
  const DATA_DIR = join(PROJECT_DIR, 'data/benchmark-cli');
  
  // 清理旧数据
  try {
    await Bun.$`rm -rf ${DATA_DIR}`;
  } catch (e) {}
  await Bun.$`mkdir -p ${DATA_DIR}`;

  // 1. ColumnarTable 内存写入测试
  const symbols = ['AAPL', 'GOOGL', 'MSFT', 'AMZN', 'TSLA', 'NVDA', 'META', 'NFLX'];
  const rowCount = 100000;
  
  const table = new ColumnarTable([
    { name: 'timestamp', type: 'int64' },
    { name: 'symbol', type: 'string' },
    { name: 'price', type: 'float64' },
    { name: 'volume', type: 'int64' },
  ]);
  
  const rows = generateRows(rowCount, symbols);
  
  // 写入测试
  const writeStart = performance.now();
  table.appendBatch(rows);
  const writeDuration = performance.now() - writeStart;
  results.write_rows_per_sec = Math.round(rowCount / writeDuration * 1000);

  // 读取测试 - 直接扫描所有列
  const readStart = performance.now();
  const tsCol = table.getColumn('timestamp');
  const priceCol = table.getColumn('price');
  const volumeCol = table.getColumn('volume');
  
  let sum = 0;
  const rowCountActual = table.getRowCount();
  for (let i = 0; i < rowCountActual; i++) {
    sum += Number(tsCol[i]) + Number(priceCol[i]) + Number(volumeCol[i]);
  }
  const readDuration = performance.now() - readStart;
  results.read_rows_per_sec = Math.round(rowCountActual / readDuration * 1000);

  // 2. AppendWriter 持久化测试
  const appendPath = join(DATA_DIR, 'bench.ndts');
  const writer = new AppendWriter(appendPath, [
    { name: 'timestamp', type: 'int64' },
    { name: 'symbol', type: 'string' },
    { name: 'price', type: 'float64' },
    { name: 'volume', type: 'int64' },
  ]);
  writer.open();
  
  const appendStart = performance.now();
  writer.append(rows);
  await writer.close();
  const appendDuration = performance.now() - appendStart;
  
  // 计算二进制大小
  const file = Bun.file(appendPath);
  if (await file.exists()) {
    const stats = await file.stat();
    results.binary_size_mb = parseFloat((stats.size / 1024 / 1024).toFixed(2));
  }

  // 清理
  try {
    await Bun.$`rm -rf ${DATA_DIR}`;
  } catch (e) {}

  // 输出JSON格式供CI解析
  console.log(JSON.stringify(results));
}

benchmark().catch(err => {
  console.error(JSON.stringify({ error: err.message, stack: err.stack }));
  process.exit(1);
});
