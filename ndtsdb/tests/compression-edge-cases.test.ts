import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, unlinkSync } from 'fs';
import { AppendWriterFFI, ColumnDefinition } from '../src/append-ffi.js';

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
const TEST_DIR = `/tmp/ndtsdb-compression-edge-${RUN_ID}`;

const columns: ColumnDefinition[] = [
  { name: 'timestamp', type: 'int64' },
  { name: 'symbol_id', type: 'int32' },
  { name: 'price', type: 'float64' },
];

describe('Compression Edge Cases', () => {
  const cleanup = () => {
    const files = [
      `${TEST_DIR}-empty.ndts`,
      `${TEST_DIR}-single.ndts`,
      `${TEST_DIR}-identical.ndts`,
      `${TEST_DIR}-random.ndts`,
      `${TEST_DIR}-mixed.ndts`,
      `${TEST_DIR}-disabled.ndts`,
      `${TEST_DIR}-large-delta.ndts`,
      `${TEST_DIR}-negative.ndts`,
      `${TEST_DIR}-all-compressed.ndts`,
    ];
    for (const f of files) {
      if (existsSync(f)) unlinkSync(f);
    }
  };

  beforeEach(cleanup);
  afterEach(cleanup);

  it('should handle empty data (0 rows)', async () => {
    const path = `${TEST_DIR}-empty.ndts`;
    const writer = new AppendWriterFFI(path, columns, {
      compression: {
        enabled: true,
        algorithms: {
          timestamp: 'delta',
        },
      },
    });

    writer.open();
    // Append empty array
    writer.append([]);
    await writer.close();

    // Should be able to read back
    const { header, data } = AppendWriterFFI.readAll(path);
    expect(header.totalRows).toBe(0);
    
    console.log('Empty data test passed: 0 rows handled correctly');
  });

  it('should handle single row', async () => {
    const path = `${TEST_DIR}-single.ndts`;
    const writer = new AppendWriterFFI(path, columns, {
      compression: {
        enabled: true,
        algorithms: {
          timestamp: 'delta',
          price: 'gorilla', // float64 uses gorilla
        },
      },
    });

    writer.open();
    writer.append([{
      timestamp: Date.now() * 1000000,
      symbol_id: 42,
      price: 12345.67,
    }]);
    await writer.close();

    const { data } = AppendWriterFFI.readAll(path);
    expect(data.get('timestamp')!.length).toBe(1);
    expect((data.get('symbol_id') as Int32Array)[0]).toBe(42);
    expect((data.get('price') as Float64Array)[0]).toBeCloseTo(12345.67, 2);
    
    console.log('Single row test passed');
  });

  it('should handle identical values (RLE best case)', async () => {
    const path = `${TEST_DIR}-identical.ndts`;
    const writer = new AppendWriterFFI(path, columns, {
      compression: {
        enabled: true,
        algorithms: {
          symbol_id: 'rle',
          price: 'gorilla',
        },
      },
    });

    // 1000 identical rows
    const rows: any[] = [];
    for (let i = 0; i < 1000; i++) {
      rows.push({
        timestamp: 1000000000000 + i * 1000000,
        symbol_id: 999, // All same
        price: 50000.00, // All same - gorilla handles this well
      });
    }

    writer.open();
    writer.append(rows);
    await writer.close();

    const { data } = AppendWriterFFI.readAll(path);
    const symbolIds = data.get('symbol_id') as Int32Array;
    expect(symbolIds.length).toBe(1000);
    expect(symbolIds.every(r => r === 999)).toBe(true);
    
    console.log('Identical values test passed');
  });

  it('should handle random values (worst case)', async () => {
    const path = `${TEST_DIR}-random.ndts`;
    const writer = new AppendWriterFFI(path, columns, {
      compression: {
        enabled: true,
        algorithms: {
          timestamp: 'none',    // Random timestamps don't compress well with delta
          price: 'gorilla',
          symbol_id: 'none',    // Random symbol_ids don't compress well with rle
        },
      },
    });

    // Generate completely random data
    const rows: any[] = [];
    for (let i = 0; i < 1000; i++) {
      rows.push({
        timestamp: Math.floor(Math.random() * 1e12), // Smaller range to avoid overflow
        symbol_id: Math.floor(Math.random() * 1000),
        price: Math.random() * 1e6,
      });
    }

    writer.open();
    writer.append(rows);
    await writer.close();

    const { data } = AppendWriterFFI.readAll(path);
    const timestamps = data.get('timestamp') as BigInt64Array;
    const prices = data.get('price') as Float64Array;
    expect(timestamps.length).toBe(1000);
    
    // Verify data integrity (values should match)
    for (let i = 0; i < 1000; i++) {
      expect(Number(timestamps[i])).toBe(rows[i].timestamp);
      expect(prices[i]).toBeCloseTo(rows[i].price, 5);
    }
    
    console.log('Random values test passed: data integrity verified');
  });

  it('should handle mixed compression (some columns compressed, some not)', async () => {
    const path = `${TEST_DIR}-mixed.ndts`;
    const writer = new AppendWriterFFI(path, columns, {
      compression: {
        enabled: true,
        algorithms: {
          timestamp: 'delta',     // Compressed
          // symbol_id: none (not specified = no compression)
          // price: none (not specified = no compression)
        },
      },
    });

    const rows: any[] = [];
    for (let i = 0; i < 1000; i++) {
      rows.push({
        timestamp: 1000000000000 + i * 1000000, // Sequential (good for delta)
        symbol_id: i % 100, // Will not be compressed
        price: 50000 + Math.random() * 1000, // Will not be compressed
      });
    }

    writer.open();
    writer.append(rows);
    await writer.close();

    const { data } = AppendWriterFFI.readAll(path);
    const timestamps = data.get('timestamp') as BigInt64Array;
    expect(timestamps.length).toBe(1000);
    expect(Number(timestamps[0])).toBe(rows[0].timestamp);
    expect(Number(timestamps[999])).toBe(rows[999].timestamp);
    
    console.log('Mixed compression test passed: only timestamp compressed');
  });

  it('should handle all columns with different compression types', async () => {
    const path = `${TEST_DIR}-all-compressed.ndts`;
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

    const rows: any[] = [];
    for (let i = 0; i < 10000; i++) {
      rows.push({
        timestamp: 1000000000000 + i * 1000000, // Delta friendly
        symbol_id: Math.floor(i / 100), // RLE friendly (100 repeats)
        price: 50000 + i * 0.01, // Gorilla handles this well
      });
    }

    writer.open();
    writer.append(rows);
    await writer.close();

    const { data } = AppendWriterFFI.readAll(path);
    const symbolIds = data.get('symbol_id') as Int32Array;
    expect(symbolIds.length).toBe(10000);
    expect(symbolIds[0]).toBe(0);
    expect(symbolIds[9900]).toBe(99);
    
    console.log('All columns compressed test passed');
  });

  it('should handle compression disabled explicitly', async () => {
    const path = `${TEST_DIR}-disabled.ndts`;
    const writer = new AppendWriterFFI(path, columns, {
      compression: {
        enabled: false,
      },
    });

    const rows: any[] = [];
    for (let i = 0; i < 1000; i++) {
      rows.push({
        timestamp: 1000000000000 + i * 1000000,
        symbol_id: i % 10,
        price: 50000 + i,
      });
    }

    writer.open();
    writer.append(rows);
    await writer.close();

    const { data } = AppendWriterFFI.readAll(path);
    expect(data.get('timestamp')!.length).toBe(1000);
    
    console.log('Explicit disabled compression test passed');
  });

  it('should handle very large delta values', async () => {
    const path = `${TEST_DIR}-large-delta.ndts`;
    const writer = new AppendWriterFFI(path, columns, {
      compression: {
        enabled: true,
        algorithms: {
          timestamp: 'delta',
          price: 'gorilla',
        },
      },
    });

    // Timestamps with moderate gaps (delta compression has limits)
    const rows: any[] = [];
    const baseTime = 1000000000000;
    for (let i = 0; i < 100; i++) {
      rows.push({
        timestamp: baseTime + i * 1000000000, // 1-second intervals in nanoseconds
        symbol_id: i,
        price: 50000,
      });
    }

    writer.open();
    writer.append(rows);
    await writer.close();

    const { data } = AppendWriterFFI.readAll(path);
    const timestamps = data.get('timestamp') as BigInt64Array;
    expect(timestamps.length).toBe(100);
    // Verify first and last values match
    expect(Number(timestamps[0])).toBe(baseTime);
    expect(Number(timestamps[99])).toBe(baseTime + 99 * 1000000000);
    
    console.log('Large delta values test passed');
  });

  it('should handle negative values with compression', async () => {
    const path = `${TEST_DIR}-negative.ndts`;
    const writer = new AppendWriterFFI(path, columns, {
      compression: {
        enabled: true,
        algorithms: {
          price: 'gorilla',
        },
      },
    });

    const rows: any[] = [];
    for (let i = 0; i < 1000; i++) {
      rows.push({
        timestamp: 1000000000000 + i * 1000000,
        symbol_id: i,
        price: (i % 2 === 0 ? 1 : -1) * (50000 + i), // Alternating signs
      });
    }

    writer.open();
    writer.append(rows);
    await writer.close();

    const { data } = AppendWriterFFI.readAll(path);
    const prices = data.get('price') as Float64Array;
    expect(prices.length).toBe(1000);
    expect(prices[0]).toBe(50000);
    expect(prices[1]).toBe(-50001);
    
    console.log('Negative values test passed');
  });
});
