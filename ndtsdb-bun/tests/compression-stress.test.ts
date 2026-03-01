import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, unlinkSync, statSync } from 'fs';
import { AppendWriterFFI, ColumnDefinition } from '../src/append-ffi.js';

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
const TEST_DIR = `/tmp/ndtsdb-compression-stress-${RUN_ID}`;

const columns: ColumnDefinition[] = [
  { name: 'timestamp', type: 'int64' },
  { name: 'symbol_id', type: 'int32' },
  { name: 'price', type: 'float64' },
  { name: 'volume', type: 'float64' },
];

describe('Compression Stress Tests', () => {
  beforeAll(() => {
    // Clean up any leftover test files
    const files = [
      `${TEST_DIR}-10k-delta.ndts`,
      `${TEST_DIR}-100k-rle.ndts`,
      `${TEST_DIR}-100k-mixed.ndts`,
      `${TEST_DIR}-nocompress.ndts`,
      `${TEST_DIR}-delta.ndts`,
      `${TEST_DIR}-rle.ndts`,
    ];
    for (const f of files) {
      if (existsSync(f)) unlinkSync(f);
    }
  });

  afterAll(() => {
    // Cleanup
    const files = [
      `${TEST_DIR}-10k-delta.ndts`,
      `${TEST_DIR}-100k-rle.ndts`,
      `${TEST_DIR}-100k-mixed.ndts`,
      `${TEST_DIR}-nocompress.ndts`,
      `${TEST_DIR}-delta.ndts`,
      `${TEST_DIR}-rle.ndts`,
    ];
    for (const f of files) {
      if (existsSync(f)) unlinkSync(f);
    }
  });

  it('should handle 10K rows with delta compression', async () => {
    const path = `${TEST_DIR}-10k-delta.ndts`;
    const writer = new AppendWriterFFI(path, columns, {
      compression: {
        enabled: true,
        algorithms: {
          timestamp: 'delta',
          price: 'gorilla', // float64 uses gorilla, not delta
        },
      },
    });

    // Generate 10K rows of tick-like data
    const rows: any[] = [];
    const baseTime = Date.now() * 1000000; // nanoseconds
    for (let i = 0; i < 10000; i++) {
      rows.push({
        timestamp: baseTime + i * 1000000, // 1ms intervals
        symbol_id: i % 100,
        price: 50000 + Math.sin(i / 100) * 1000 + Math.random() * 10,
        volume: Math.random() * 100,
      });
    }

    const startWrite = performance.now();
    writer.open();
    writer.append(rows);
    await writer.close();
    const writeTime = performance.now() - startWrite;

    // Read back and verify
    const startRead = performance.now();
    const { header, data } = AppendWriterFFI.readAll(path);
    const readTime = performance.now() - startRead;

    const timestamps = data.get('timestamp') as BigInt64Array;
    expect(timestamps.length).toBe(10000);
    expect(Number(timestamps[0])).toBe(Number(rows[0].timestamp));
    expect(Number(timestamps[9999])).toBe(Number(rows[9999].timestamp));

    // Performance assertions
    expect(writeTime).toBeLessThan(5000); // < 5 seconds
    expect(readTime).toBeLessThan(2000);  // < 2 seconds

    console.log(`10K compression: write=${writeTime.toFixed(2)}ms, read=${readTime.toFixed(2)}ms`);
  });

  it('should handle 100K rows with RLE compression', async () => {
    const path = `${TEST_DIR}-100k-rle.ndts`;
    const writer = new AppendWriterFFI(path, columns, {
      compression: {
        enabled: true,
        algorithms: {
          symbol_id: 'rle', // High repetition rate
        },
      },
    });

    // Generate 100K rows with only 10 unique symbols (high RLE efficiency)
    const rows: any[] = [];
    const baseTime = Date.now() * 1000000;
    for (let i = 0; i < 100000; i++) {
      rows.push({
        timestamp: baseTime + i * 1000000,
        symbol_id: Math.floor(i / 10000), // 0-9, each repeated 10K times
        price: 50000 + Math.random() * 1000,
        volume: Math.random() * 100,
      });
    }

    const startWrite = performance.now();
    writer.open();
    writer.append(rows);
    await writer.close();
    const writeTime = performance.now() - startWrite;

    // Check file size for compression ratio
    const fileSize = statSync(path).size;

    // Read back
    const startRead = performance.now();
    const { data } = AppendWriterFFI.readAll(path);
    const readTime = performance.now() - startRead;

    const symbolIds = data.get('symbol_id') as Int32Array;
    expect(symbolIds.length).toBe(100000);
    expect(symbolIds[0]).toBe(0);
    expect(symbolIds[50000]).toBe(5);

    console.log(`100K RLE: write=${writeTime.toFixed(2)}ms, read=${readTime.toFixed(2)}ms, size=${(fileSize/1024).toFixed(2)}KB`);
  });

  it('should handle 100K rows mixed compression within memory limits', async () => {
    const path = `${TEST_DIR}-100k-mixed.ndts`;
    
    // Monitor memory
    const memBefore = process.memoryUsage();
    
    const writer = new AppendWriterFFI(path, columns, {
      compression: {
        enabled: true,
        algorithms: {
          timestamp: 'delta',
          symbol_id: 'rle',
          price: 'gorilla',
        },
      },
    });

    // Generate 100K rows in batches to control memory
    const batchSize = 10000;
    const totalRows = 100000;
    
    writer.open();
    const startWrite = performance.now();
    
    for (let batch = 0; batch < totalRows / batchSize; batch++) {
      const rows: any[] = [];
      const baseTime = Date.now() * 1000000;
      const batchStart = batch * batchSize;
      
      for (let i = 0; i < batchSize; i++) {
        const idx = batchStart + i;
        rows.push({
          timestamp: baseTime + idx * 1000000,
          symbol_id: Math.floor(idx / 1000) % 1000, // 1000 symbols
          price: 50000 + Math.sin(idx / 1000) * 5000,
          volume: Math.random() * 1000,
        });
      }
      
      writer.append(rows);
    }
    
    await writer.close();
    const writeTime = performance.now() - startWrite;

    const memAfter = process.memoryUsage();
    const memPeakMB = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;

    // Read back
    const startRead = performance.now();
    const { data } = AppendWriterFFI.readAll(path);
    const readTime = performance.now() - startRead;

    const timestamps = data.get('timestamp') as BigInt64Array;
    expect(timestamps.length).toBe(100000);
    expect(memPeakMB).toBeLessThan(200); // < 200MB peak for 100K rows

    console.log(`100K mixed: write=${writeTime.toFixed(2)}ms, read=${readTime.toFixed(2)}ms, mem=${memPeakMB.toFixed(2)}MB`);
  }, 30000); // 30 second timeout

  it('should compare compression ratios between algorithms', async () => {
    const rows: any[] = [];
    const baseTime = Date.now() * 1000000;
    
    // Generate test data
    for (let i = 0; i < 50000; i++) {
      rows.push({
        timestamp: baseTime + i * 1000000,
        symbol_id: i % 50, // 50 symbols repeating
        price: 50000 + (i % 100) * 10, // Stepped price
        volume: 100 + (i % 10), // Small range
      });
    }

    // Test 1: No compression
    const pathNoComp = `${TEST_DIR}-nocompress.ndts`;
    const writerNoComp = new AppendWriterFFI(pathNoComp, columns);
    writerNoComp.open();
    writerNoComp.append(rows);
    await writerNoComp.close();
    const sizeNoComp = statSync(pathNoComp).size;

    // Test 2: Delta + Gorilla compression (float64 uses gorilla)
    const pathDelta = `${TEST_DIR}-delta.ndts`;
    const writerDelta = new AppendWriterFFI(pathDelta, columns, {
      compression: {
        enabled: true,
        algorithms: {
          timestamp: 'delta',
          price: 'gorilla',
        },
      },
    });
    writerDelta.open();
    writerDelta.append(rows);
    await writerDelta.close();
    const sizeDelta = statSync(pathDelta).size;

    // Test 3: RLE compression
    const pathRle = `${TEST_DIR}-rle.ndts`;
    const writerRle = new AppendWriterFFI(pathRle, columns, {
      compression: {
        enabled: true,
        algorithms: {
          symbol_id: 'rle',
        },
      },
    });
    writerRle.open();
    writerRle.append(rows);
    await writerRle.close();
    const sizeRle = statSync(pathRle).size;

    const ratioDelta = (1 - sizeDelta / sizeNoComp) * 100;
    const ratioRle = (1 - sizeRle / sizeNoComp) * 100;

    console.log(`Compression ratios (50K rows):`);
    console.log(`  No compression: ${(sizeNoComp/1024).toFixed(2)}KB`);
    console.log(`  Delta+Gorilla: ${(sizeDelta/1024).toFixed(2)}KB (${ratioDelta.toFixed(1)}%)`);
    console.log(`  RLE: ${(sizeRle/1024).toFixed(2)}KB (${ratioRle.toFixed(1)}%)`);

    // Assertions based on expected compression rates
    expect(ratioDelta).toBeGreaterThan(30); // Should achieve >30%
    expect(ratioRle).toBeGreaterThan(20);   // Should achieve >20%
  });
});
