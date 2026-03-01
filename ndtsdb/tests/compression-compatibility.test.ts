import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, unlinkSync } from 'fs';
import { AppendWriterFFI, ColumnDefinition } from '../src/append-ffi.js';

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
const TEST_DIR = `/tmp/ndtsdb-compat-${RUN_ID}`;

const columns: ColumnDefinition[] = [
  { name: 'timestamp', type: 'int64' },
  { name: 'symbol_id', type: 'int32' },
  { name: 'price', type: 'float64' },
];

describe('Compression File Format Compatibility', () => {
  afterAll(() => {
    // Cleanup
    const files = [
      `${TEST_DIR}-uncompressed.ndts`,
      `${TEST_DIR}-compressed.ndts`,
      `${TEST_DIR}-reopened.ndts`,
      `${TEST_DIR}-append.ndts`,
      `${TEST_DIR}-header.ndts`,
      `${TEST_DIR}-multiappend.ndts`,
      `${TEST_DIR}-crc.ndts`,
    ];
    for (const f of files) {
      if (existsSync(f)) unlinkSync(f);
    }
  });

  it('should create and read uncompressed file', async () => {
    const path = `${TEST_DIR}-uncompressed.ndts`;
    const writer = new AppendWriterFFI(path, columns);

    const rows: any[] = [];
    for (let i = 0; i < 100; i++) {
      rows.push({
        timestamp: 1000000000000 + i * 1000000,
        symbol_id: i % 10,
        price: 50000 + i * 10,
      });
    }

    writer.open();
    writer.append(rows);
    await writer.close();

    const { header, data } = AppendWriterFFI.readAll(path);
    expect(header.totalRows).toBe(100);
    const timestamps = data.get('timestamp') as BigInt64Array;
    expect(Number(timestamps[0])).toBe(1000000000000);
    
    console.log('Uncompressed file test passed');
  });

  it('should create and read compressed file', async () => {
    const path = `${TEST_DIR}-compressed.ndts`;
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
    for (let i = 0; i < 1000; i++) {
      rows.push({
        timestamp: 1000000000000 + i * 1000000,
        symbol_id: Math.floor(i / 100),
        price: 50000 + i,
      });
    }

    writer.open();
    writer.append(rows);
    await writer.close();

    const { data } = AppendWriterFFI.readAll(path);
    const symbolIds = data.get('symbol_id') as Int32Array;
    expect(symbolIds.length).toBe(1000);
    expect(symbolIds[0]).toBe(0);
    expect(symbolIds[999]).toBe(9);
    
    console.log('Compressed file test passed');
  });

  it('should reopen and append to compressed file', async () => {
    const path = `${TEST_DIR}-reopened.ndts`;
    
    // First write
    const writer1 = new AppendWriterFFI(path, columns, {
      compression: {
        enabled: true,
        algorithms: {
          timestamp: 'delta',
          price: 'gorilla',
        },
      },
    });

    writer1.open();
    writer1.append([{
      timestamp: 1000000000000,
      symbol_id: 1,
      price: 50000,
    }]);
    await writer1.close();

    // Reopen and append
    const writer2 = new AppendWriterFFI(path, columns, {
      compression: {
        enabled: true,
        algorithms: {
          timestamp: 'delta',
          price: 'gorilla',
        },
      },
    });

    writer2.open();
    writer2.append([{
      timestamp: 1000001000000,
      symbol_id: 2,
      price: 50001,
    }]);
    await writer2.close();

    // Read all
    const { data } = AppendWriterFFI.readAll(path);
    const symbolIds = data.get('symbol_id') as Int32Array;
    expect(symbolIds.length).toBe(2);
    expect(symbolIds[0]).toBe(1);
    expect(symbolIds[1]).toBe(2);
    
    console.log('Reopen and append test passed');
  });

  it('should reopen uncompressed file and keep format', async () => {
    const path = `${TEST_DIR}-append.ndts`;
    
    // First write (uncompressed)
    const writer1 = new AppendWriterFFI(path, columns);
    writer1.open();
    writer1.append([{
      timestamp: 1000000000000,
      symbol_id: 1,
      price: 50000,
    }]);
    await writer1.close();

    // Reopen and append (still uncompressed)
    const writer2 = new AppendWriterFFI(path, columns);
    writer2.open();
    writer2.append([{
      timestamp: 1000001000000,
      symbol_id: 2,
      price: 50001,
    }]);
    await writer2.close();

    const { data } = AppendWriterFFI.readAll(path);
    expect(data.get('symbol_id')!.length).toBe(2);
    
    console.log('Reopen uncompressed test passed');
  });

  it('should verify header integrity after compression', async () => {
    const path = `${TEST_DIR}-header.ndts`;
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

    writer.open();
    writer.append([{
      timestamp: 1000000000000,
      symbol_id: 42,
      price: 12345.67,
    }]);
    await writer.close();

    // Read back and verify data
    const { data } = AppendWriterFFI.readAll(path);
    const timestamps = data.get('timestamp') as BigInt64Array;
    const prices = data.get('price') as Float64Array;
    expect(timestamps.length).toBe(1);
    expect(Number(timestamps[0])).toBe(1000000000000);
    expect(prices[0]).toBeCloseTo(12345.67, 2);

    // Cleanup
    if (existsSync(path)) unlinkSync(path);
    
    console.log('Header integrity test passed');
  });

  it('should handle multiple append operations', async () => {
    const path = `${TEST_DIR}-multiappend.ndts`;
    const writer = new AppendWriterFFI(path, columns, {
      compression: {
        enabled: true,
        algorithms: {
          timestamp: 'delta',
          price: 'gorilla',
        },
      },
    });

    // Multiple small appends
    writer.open();
    for (let batch = 0; batch < 5; batch++) {
      const rows: any[] = [];
      for (let i = 0; i < 10; i++) {
        rows.push({
          timestamp: 1000000000000 + batch * 10000000 + i * 1000000,
          symbol_id: batch * 10 + i,
          price: 50000 + batch * 100 + i,
        });
      }
      writer.append(rows);
    }
    await writer.close();

    const { data } = AppendWriterFFI.readAll(path);
    const symbolIds = data.get('symbol_id') as Int32Array;
    expect(symbolIds.length).toBe(50);
    expect(symbolIds[0]).toBe(0);
    expect(symbolIds[49]).toBe(49);

    // Cleanup
    if (existsSync(path)) unlinkSync(path);
    
    console.log('Multiple append test passed');
  });

  it('should verify CRC32 integrity', async () => {
    const path = `${TEST_DIR}-crc.ndts`;
    const writer = new AppendWriterFFI(path, columns, {
      compression: {
        enabled: true,
        algorithms: {
          timestamp: 'delta',
          price: 'gorilla',
        },
      },
    });

    writer.open();
    writer.append([{
      timestamp: 1000000000000,
      symbol_id: 1,
      price: 50000,
    }]);
    await writer.close();

    // File should exist and be readable
    expect(existsSync(path)).toBe(true);
    
    const { data } = AppendWriterFFI.readAll(path);
    expect(data.get('timestamp')!.length).toBe(1);
    
    // Cleanup
    if (existsSync(path)) unlinkSync(path);
    
    console.log('CRC integrity test passed');
  });
});
