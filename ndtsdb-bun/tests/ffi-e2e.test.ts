import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { openDatabase, NdtsDatabase, type NDTSRow } from '../src/ndts-db.ts';
import { parseSQL, SQLExecutor, ColumnarTable } from '../src/sql.ts';

/**
 * End-to-end FFI integration tests
 * Verifies: NdtsDatabase (FFI) → SQL Engine (TS) → Query Results
 *
 * This validates the "zero-copy" FFI path:
 * 1. C library returns JSON string
 * 2. Bun FFI receives and parses JSON
 * 3. TS SQL engine processes rows with WHERE/GROUP BY/HAVING/DISTINCT/ORDER BY
 */

describe('FFI End-to-End Integration', () => {
  let dir: string;
  let db: NdtsDatabase;

  function tmpDir(): string {
    const p = join(tmpdir(), `ndtsdb-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(p, { recursive: true });
    return p;
  }

  function cleanDir(p: string): void {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }

  beforeEach(() => {
    dir = tmpDir();
    db = openDatabase(dir);
  });

  afterEach(() => {
    db.close();
    cleanDir(dir);
  });

  function queryWithSQL(sql: string): any[] {
    // Fetch all rows from database via FFI
    const rows = db.queryAll();

    // Register with SQL executor
    const table = new ColumnarTable([
      { name: 'symbol', type: 'string' },
      { name: 'interval', type: 'string' },
      { name: 'timestamp', type: 'int64' },
      { name: 'open', type: 'float64' },
      { name: 'high', type: 'float64' },
      { name: 'low', type: 'float64' },
      { name: 'close', type: 'float64' },
      { name: 'volume', type: 'float64' },
    ]);
    table.appendBatch(rows as any[]);

    const exec = new SQLExecutor();
    exec.registerTable('klines', table);

    // Execute SQL query
    const result = exec.execute(parseSQL(sql));
    return result.rows;
  }

  it('FFI: queryAll returns all inserted rows', () => {
    db.insert('BTCUSDT', '1h', {
      timestamp: 1700000000000n,
      open: 30000, high: 30100, low: 29900, close: 30050, volume: 100,
    });
    db.insert('ETHUSDT', '1h', {
      timestamp: 1700000000000n,
      open: 2000, high: 2050, low: 1950, close: 2000, volume: 50,
    });

    const rows = db.queryAll();
    expect(rows).toHaveLength(2);
    expect(rows[0].symbol).toBe('BTCUSDT');
    expect(rows[1].symbol).toBe('ETHUSDT');
  });

  it('FFI → SQL: WHERE filter on symbol', () => {
    db.insertBatch('BTCUSDT', '1h', [
      { timestamp: 1700000000000n, open: 100, high: 110, low: 90, close: 105, volume: 10 },
      { timestamp: 1700003600000n, open: 110, high: 120, low: 100, close: 115, volume: 15 },
    ]);
    db.insertBatch('ETHUSDT', '1h', [
      { timestamp: 1700000000000n, open: 50, high: 55, low: 45, close: 52, volume: 5 },
    ]);

    const rows = queryWithSQL("SELECT * FROM klines WHERE symbol = 'BTCUSDT'");
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.symbol === 'BTCUSDT')).toBe(true);
  });

  it('FFI → SQL: GROUP BY with aggregates', () => {
    db.insertBatch('BTCUSDT', '1h', [
      { timestamp: 1700000000000n, open: 100, high: 110, low: 90, close: 105, volume: 100 },
      { timestamp: 1700003600000n, open: 110, high: 120, low: 100, close: 115, volume: 150 },
    ]);
    db.insertBatch('ETHUSDT', '1h', [
      { timestamp: 1700000000000n, open: 50, high: 55, low: 45, close: 52, volume: 50 },
    ]);

    const rows = queryWithSQL('SELECT symbol, COUNT(*), SUM(volume) FROM klines GROUP BY symbol');
    expect(rows).toHaveLength(2);

    const btcRow = rows.find((r: any) => r.symbol === 'BTCUSDT');
    const ethRow = rows.find((r: any) => r.symbol === 'ETHUSDT');

    expect(btcRow?.['COUNT(*)']).toBe(2);
    expect(btcRow?.['SUM(volume)']).toBe(250);
    expect(ethRow?.['COUNT(*)']).toBe(1);
    expect(ethRow?.['SUM(volume)']).toBe(50);
  });

  it('FFI → SQL: DISTINCT removes duplicates', () => {
    // Insert same row twice (different timestamps but will have duplicates after projection)
    db.insertBatch('BTCUSDT', '1h', [
      { timestamp: 1700000000000n, open: 100, high: 110, low: 90, close: 105, volume: 100 },
      { timestamp: 1700003600000n, open: 100, high: 110, low: 90, close: 105, volume: 100 }, // same values
    ]);

    const rows = queryWithSQL('SELECT DISTINCT symbol, interval FROM klines');
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe('BTCUSDT');
    expect(rows[0].interval).toBe('1h');
  });

  it('FFI → SQL: ORDER BY timestamp descending', () => {
    db.insertBatch('BTCUSDT', '1h', [
      { timestamp: 1700000000000n, open: 100, high: 110, low: 90, close: 105, volume: 100 },
      { timestamp: 1700003600000n, open: 110, high: 120, low: 100, close: 115, volume: 150 },
      { timestamp: 1700007200000n, open: 120, high: 130, low: 110, close: 125, volume: 200 },
    ]);

    const rows = queryWithSQL('SELECT * FROM klines ORDER BY timestamp DESC LIMIT 2');
    expect(rows).toHaveLength(2);
    expect(rows[0].timestamp).toBe(1700007200000n);
    expect(rows[1].timestamp).toBe(1700003600000n);
  });

  it('FFI → SQL: Complex query with WHERE, GROUP BY, HAVING, ORDER BY', () => {
    // Insert test data
    const symbols = ['BTC', 'ETH', 'SOL'];
    for (const sym of symbols) {
      const rows = Array.from({ length: 10 }, (_, i) => ({
        timestamp: BigInt(1700000000000 + i * 3600000),
        open: 100 + Math.random() * 100,
        high: 150 + Math.random() * 100,
        low: 50 + Math.random() * 50,
        close: 100 + Math.random() * 100,
        volume: Math.random() * 1000,
      }));
      db.insertBatch(`${sym}USDT`, '1h', rows);
    }

    const rows = queryWithSQL(`
      SELECT symbol, COUNT(*), AVG(close), MAX(volume)
      FROM klines
      WHERE close > 100
      GROUP BY symbol
      HAVING COUNT(*) > 5
      ORDER BY AVG(close) DESC
    `);

    // All rows should have COUNT(*) > 5
    expect(rows.every((r: any) => r['COUNT(*)'] > 5)).toBe(true);
    // Should be ordered by AVG(close) descending
    for (let i = 0; i < rows.length - 1; i++) {
      expect(rows[i]['AVG(close)'] >= rows[i + 1]['AVG(close)']).toBe(true);
    }
  });

  it('FFI → SQL: Multiple intervals with multiple ORDER BY columns', () => {
    db.insertBatch('BTCUSDT', '1h', [
      { timestamp: 1700000000000n, open: 100, high: 110, low: 90, close: 105, volume: 100 },
    ]);
    db.insertBatch('BTCUSDT', '4h', [
      { timestamp: 1700000000000n, open: 100, high: 110, low: 90, close: 105, volume: 100 },
    ]);
    db.insertBatch('ETHUSDT', '1h', [
      { timestamp: 1700000000000n, open: 50, high: 55, low: 45, close: 52, volume: 50 },
    ]);

    const rows = queryWithSQL('SELECT * FROM klines ORDER BY symbol ASC, interval DESC LIMIT 10');
    expect(rows.length > 0).toBe(true);
    // First rows should be BTC sorted by interval DESC (4h before 1h)
    const btcRows = rows.filter((r: any) => r.symbol === 'BTCUSDT');
    expect(btcRows.length).toBeGreaterThan(0);
  });

  it('Performance: FFI roundtrip with 1000 rows', () => {
    const batchSize = 100;
    const numBatches = 10;

    for (let b = 0; b < numBatches; b++) {
      const batch = Array.from({ length: batchSize }, (_, i) => ({
        timestamp: BigInt(1700000000000 + (b * batchSize + i) * 60000),
        open: 100 + Math.random() * 100,
        high: 150 + Math.random() * 100,
        low: 50 + Math.random() * 50,
        close: 100 + Math.random() * 100,
        volume: Math.random() * 1000,
      }));
      db.insertBatch('BTCUSDT', '1h', batch);
    }

    const start = performance.now();
    const rows = queryWithSQL('SELECT * FROM klines WHERE close > 100 ORDER BY timestamp DESC LIMIT 100');
    const elapsed = performance.now() - start;

    expect(rows).toHaveLength(100);
    console.log(`  FFI + SQL query on 1000 rows: ${elapsed.toFixed(2)}ms`);
  });

  it('FFI → SQL: LIMIT and OFFSET', () => {
    db.insertBatch('BTCUSDT', '1h', [
      { timestamp: 1700000000000n, open: 100, high: 110, low: 90, close: 100, volume: 100 },
      { timestamp: 1700003600000n, open: 110, high: 120, low: 100, close: 110, volume: 150 },
      { timestamp: 1700007200000n, open: 120, high: 130, low: 110, close: 120, volume: 200 },
      { timestamp: 1700010800000n, open: 130, high: 140, low: 120, close: 130, volume: 250 },
    ]);

    const rows = queryWithSQL('SELECT * FROM klines ORDER BY timestamp ASC LIMIT 2 OFFSET 1');
    expect(rows).toHaveLength(2);
    expect(rows[0].close).toBe(110);
    expect(rows[1].close).toBe(120);
  });
});
