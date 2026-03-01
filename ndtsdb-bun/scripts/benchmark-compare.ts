#!/usr/bin/env bun
/**
 * ndtsdb Benchmark Suite
 * 
 * 用法:
 *   bun run scripts/benchmark-compare.ts
 *   bun run scripts/benchmark-compare.ts --quick
 *   bun run scripts/benchmark-compare.ts --export
 */

import { ColumnarTable, SQLParser, SQLExecutor, AppendWriter } from '../src/index.js';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';

// ============================================================
// 配置
// ============================================================

const CONFIG = {
  quick: {
    tickCount: 100_000,
    symbolCount: 10,
    queryIterations: 100,
  },
  full: {
    tickCount: 1_000_000,
    symbolCount: 100,
    queryIterations: 1000,
  },
  outputDir: './benchmarks/results',
};

const isQuick = process.argv.includes('--quick');
const shouldExport = process.argv.includes('--export');
const config = isQuick ? CONFIG.quick : CONFIG.full;

// ============================================================
// 工具函数
// ============================================================

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(2);
}

function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(2)}μs`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

interface BenchmarkResult {
  name: string;
  operation: string;
  totalOps: number;
  totalTimeMs: number;
  opsPerSec: number;
  avgLatencyMs: number;
  p99LatencyMs?: number;
}

const results: BenchmarkResult[] = [];

async function benchmark(
  name: string,
  operation: string,
  fn: () => void | Promise<void>,
  iterations: number = 1
): Promise<BenchmarkResult> {
  // Warmup
  for (let i = 0; i < Math.min(5, iterations); i++) {
    await fn();
  }

  // Actual benchmark
  const latencies: number[] = [];
  const start = performance.now();
  
  for (let i = 0; i < iterations; i++) {
    const iterStart = performance.now();
    await fn();
    latencies.push(performance.now() - iterStart);
  }
  
  const totalTimeMs = performance.now() - start;
  const opsPerSec = (iterations / totalTimeMs) * 1000;
  const avgLatencyMs = totalTimeMs / iterations;
  
  // P99
  latencies.sort((a, b) => a - b);
  const p99Index = Math.floor(latencies.length * 0.99);
  const p99LatencyMs = latencies[p99Index] || latencies[latencies.length - 1];

  const result: BenchmarkResult = {
    name,
    operation,
    totalOps: iterations,
    totalTimeMs,
    opsPerSec,
    avgLatencyMs,
    p99LatencyMs,
  };

  results.push(result);
  
  console.log(
    `  ${operation.padEnd(30)} | ` +
    `${formatNumber(opsPerSec).padStart(10)} ops/sec | ` +
    `avg ${formatDuration(avgLatencyMs).padStart(10)} | ` +
    `p99 ${formatDuration(p99LatencyMs).padStart(10)}`
  );

  return result;
}

// ============================================================
// OHLCV Schema
// ============================================================

const OHLCV_SCHEMA = [
  { name: 'ts', type: 'int64' as const },
  { name: 'open', type: 'float64' as const },
  { name: 'high', type: 'float64' as const },
  { name: 'low', type: 'float64' as const },
  { name: 'close', type: 'float64' as const },
  { name: 'volume', type: 'float64' as const },
];

function generateTick(ts: number): Record<string, number> {
  const base = 100 + Math.random() * 10;
  return {
    ts,
    open: base,
    high: base + Math.random() * 5,
    low: base - Math.random() * 5,
    close: base + (Math.random() - 0.5) * 2,
    volume: Math.floor(Math.random() * 10000),
  };
}

// ============================================================
// Benchmark Suite
// ============================================================

async function runBenchmarks() {
  console.log('═'.repeat(70));
  console.log('ndtsdb Benchmark Suite');
  console.log('═'.repeat(70));
  console.log(`Mode: ${isQuick ? 'Quick' : 'Full'}`);
  console.log(`Ticks: ${formatNumber(config.tickCount)}`);
  console.log(`Symbols: ${config.symbolCount}`);
  console.log('═'.repeat(70));
  console.log();

  const dataDir = `/tmp/ndtsdb-benchmark-${Date.now()}`;
  mkdirSync(dataDir, { recursive: true });

  // ----------------------------------------------------------
  // 1. Write Performance (In-Memory)
  // ----------------------------------------------------------
  console.log('📝 Write Performance (In-Memory ColumnarTable)');
  console.log('-'.repeat(70));

  const table = new ColumnarTable(OHLCV_SCHEMA);
  let ticksWritten = 0;
  const ticksPerSymbol = Math.floor(config.tickCount / config.symbolCount);

  // Bulk write
  const writeStart = performance.now();
  for (let s = 0; s < config.symbolCount; s++) {
    const baseTs = Date.now() - ticksPerSymbol * 1000;
    for (let i = 0; i < ticksPerSymbol; i++) {
      table.append(generateTick(baseTs + i * 1000));
      ticksWritten++;
    }
  }
  const writeTimeMs = performance.now() - writeStart;
  const writeOpsPerSec = (ticksWritten / writeTimeMs) * 1000;

  results.push({
    name: 'ndtsdb',
    operation: 'Bulk Write (In-Memory)',
    totalOps: ticksWritten,
    totalTimeMs: writeTimeMs,
    opsPerSec: writeOpsPerSec,
    avgLatencyMs: writeTimeMs / ticksWritten,
  });

  console.log(
    `  ${'Bulk Write'.padEnd(30)} | ` +
    `${formatNumber(writeOpsPerSec).padStart(10)} ops/sec | ` +
    `total ${formatDuration(writeTimeMs).padStart(10)} | ` +
    `${formatNumber(ticksWritten)} ticks`
  );

  console.log();

  // ----------------------------------------------------------
  // 2. SQL Query Performance
  // ----------------------------------------------------------
  console.log('📖 SQL Query Performance');
  console.log('-'.repeat(70));

  const parser = new SQLParser();
  const executor = new SQLExecutor();
  executor.registerTable('ticks', table);

  // Full scan with LIMIT
  await benchmark('ndtsdb', 'SELECT * LIMIT 1000', () => {
    const ast = parser.parse('SELECT * FROM ticks LIMIT 1000');
    executor.execute(ast);
  }, config.queryIterations);

  // Range query
  const rangeTs = Date.now() - 3600000;
  await benchmark('ndtsdb', 'WHERE ts > (range)', () => {
    const ast = parser.parse(`SELECT * FROM ticks WHERE ts > ${rangeTs} LIMIT 1000`);
    executor.execute(ast);
  }, config.queryIterations);

  // Aggregation (MIN/MAX - supported) - fewer iterations for full table scan
  await benchmark('ndtsdb', 'MIN/MAX aggregation', () => {
    const ast = parser.parse('SELECT MIN(close), MAX(close) FROM ticks');
    executor.execute(ast);
  }, Math.min(10, config.queryIterations));

  // Simple filter
  await benchmark('ndtsdb', 'WHERE close > 100', () => {
    const ast = parser.parse('SELECT * FROM ticks WHERE close > 100 LIMIT 1000');
    executor.execute(ast);
  }, config.queryIterations);

  console.log();

  // ----------------------------------------------------------
  // 3. Persistent Write (AppendWriter)
  // ----------------------------------------------------------
  console.log('💾 Persistent Write (AppendWriter)');
  console.log('-'.repeat(70));

  const writer = new AppendWriter(join(dataDir, 'benchmark.ndts'), OHLCV_SCHEMA);
  writer.open();

  const persistWriteStart = performance.now();
  const persistTickCount = Math.min(10000, config.tickCount);
  const batch: Record<string, number>[] = [];
  for (let i = 0; i < persistTickCount; i++) {
    batch.push(generateTick(Date.now() - (persistTickCount - i) * 1000));
  }
  writer.append(batch);
  writer.close();
  const persistWriteTimeMs = performance.now() - persistWriteStart;
  const persistWriteOpsPerSec = (persistTickCount / persistWriteTimeMs) * 1000;

  results.push({
    name: 'ndtsdb',
    operation: 'Persistent Write (batch)',
    totalOps: persistTickCount,
    totalTimeMs: persistWriteTimeMs,
    opsPerSec: persistWriteOpsPerSec,
    avgLatencyMs: persistWriteTimeMs / persistTickCount,
  });

  console.log(
    `  ${'Batch Write + Flush'.padEnd(30)} | ` +
    `${formatNumber(persistWriteOpsPerSec).padStart(10)} ops/sec | ` +
    `total ${formatDuration(persistWriteTimeMs).padStart(10)} | ` +
    `${formatNumber(persistTickCount)} ticks`
  );

  console.log();

  // ----------------------------------------------------------
  // 4. Memory Usage
  // ----------------------------------------------------------
  console.log('💾 Memory Usage');
  console.log('-'.repeat(70));

  const memUsage = process.memoryUsage();
  console.log(`  Heap Used:  ${formatNumber(memUsage.heapUsed / 1024 / 1024)} MB`);
  console.log(`  Heap Total: ${formatNumber(memUsage.heapTotal / 1024 / 1024)} MB`);
  console.log(`  RSS:        ${formatNumber(memUsage.rss / 1024 / 1024)} MB`);

  console.log();

  // ----------------------------------------------------------
  // 5. Summary
  // ----------------------------------------------------------
  console.log('═'.repeat(70));
  console.log('Summary');
  console.log('═'.repeat(70));
  console.log();
  console.log(`Total ticks:      ${formatNumber(ticksWritten)}`);
  console.log(`Write throughput: ${formatNumber(writeOpsPerSec)} ticks/sec`);
  console.log(`Memory (heap):    ${formatNumber(memUsage.heapUsed / 1024 / 1024)} MB`);
  console.log();

  // ----------------------------------------------------------
  // Export Results
  // ----------------------------------------------------------
  if (shouldExport) {
    if (!existsSync(CONFIG.outputDir)) {
      mkdirSync(CONFIG.outputDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    // JSON
    const jsonPath = join(CONFIG.outputDir, `benchmark-${timestamp}.json`);
    writeFileSync(jsonPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      config,
      results,
      memory: {
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
        rss: memUsage.rss,
      },
    }, null, 2));
    console.log(`📊 Results exported to: ${jsonPath}`);

    // Markdown
    const mdPath = join(CONFIG.outputDir, `benchmark-${timestamp}.md`);
    const mdContent = generateMarkdownReport(results, memUsage, ticksWritten, writeOpsPerSec);
    writeFileSync(mdPath, mdContent);
    console.log(`📄 Report exported to: ${mdPath}`);
  }

  // Cleanup
  rmSync(dataDir, { recursive: true, force: true });
}

function generateMarkdownReport(
  results: BenchmarkResult[],
  memUsage: NodeJS.MemoryUsage,
  ticksWritten: number,
  writeOpsPerSec: number
): string {
  return `# ndtsdb Benchmark Results

Generated: ${new Date().toISOString()}

## Configuration

| Parameter | Value |
|-----------|-------|
| Mode | ${isQuick ? 'Quick' : 'Full'} |
| Total Ticks | ${formatNumber(ticksWritten)} |
| Symbols | ${config.symbolCount} |

## Write Performance

| Operation | Ops/sec | Total Time |
|-----------|---------|------------|
${results.filter(r => r.operation.includes('Write'))
  .map(r => `| ${r.operation} | ${formatNumber(r.opsPerSec)} | ${formatDuration(r.totalTimeMs)} |`)
  .join('\n')}

## Query Performance

| Operation | Ops/sec | Avg Latency | P99 Latency |
|-----------|---------|-------------|-------------|
${results.filter(r => !r.operation.includes('Write'))
  .map(r => `| ${r.operation} | ${formatNumber(r.opsPerSec)} | ${formatDuration(r.avgLatencyMs)} | ${formatDuration(r.p99LatencyMs || 0)} |`)
  .join('\n')}

## Memory Usage

| Metric | Value |
|--------|-------|
| Heap Used | ${formatNumber(memUsage.heapUsed / 1024 / 1024)} MB |
| Heap Total | ${formatNumber(memUsage.heapTotal / 1024 / 1024)} MB |
| RSS | ${formatNumber(memUsage.rss / 1024 / 1024)} MB |

## Comparison with Other TSDBs

| Feature | ndtsdb | InfluxDB | TimescaleDB | QuestDB |
|---------|--------|----------|-------------|---------|
| Embedded | ✅ | ❌ | ❌ | ❌ |
| TypeScript Native | ✅ | ❌ | ❌ | ❌ |
| Zero Dependencies | ✅ | ❌ | ❌ | ❌ |
| Memory Footprint | ~${formatNumber(memUsage.heapUsed / 1024 / 1024)} MB | ~500MB+ | ~1GB+ | ~500MB+ |

---

*Benchmarks run on: ${process.platform} ${process.arch}, Bun ${process.versions.bun || 'N/A'}*
`;
}

// Run
runBenchmarks().catch(console.error);
