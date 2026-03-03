import { describe, it, expect, beforeEach } from 'bun:test';
import { parseSQL, SQLExecutor, ColumnarTable } from '../src/sql.ts';

/**
 * Performance benchmarks for SQL aggregation.
 * Reference baseline: C+QJS version achieves ~862K rows/s (write-json throughput)
 */

describe('SQL Performance Benchmarks', () => {
  function makeTable(rows: Record<string, any>[]): ColumnarTable {
    const t = new ColumnarTable([
      { name: 'symbol', type: 'string' },
      { name: 'interval', type: 'string' },
      { name: 'timestamp', type: 'int64' },
      { name: 'open', type: 'float64' },
      { name: 'high', type: 'float64' },
      { name: 'low', type: 'float64' },
      { name: 'close', type: 'float64' },
      { name: 'volume', type: 'float64' },
    ]);
    t.appendBatch(rows);
    return t;
  }

  function generateKlines(count: number): Record<string, any>[] {
    const rows: Record<string, any>[] = [];
    const symbols = ['BTC', 'ETH', 'BNB', 'XRP', 'SOL', 'ADA', 'DOGE', 'LINK', 'MATIC', 'AVAX'];
    const intervals = ['1m', '5m', '15m', '1h', '4h'];

    for (let i = 0; i < count; i++) {
      const symbolIdx = i % symbols.length;
      const intervalIdx = (i / symbols.length) % intervals.length;
      rows.push({
        symbol: symbols[Math.floor(symbolIdx)],
        interval: intervals[Math.floor(intervalIdx)],
        timestamp: BigInt(1700000000000 + i * 60000),
        open: 100 + Math.random() * 1000,
        high: 100 + Math.random() * 1000,
        low: 100 + Math.random() * 1000,
        close: 100 + Math.random() * 1000,
        volume: Math.random() * 10000,
      });
    }
    return rows;
  }

  it('COUNT(*) on 10K rows', () => {
    const exec = new SQLExecutor();
    const rows = generateKlines(10000);
    exec.registerTable('klines', makeTable(rows));

    const start = performance.now();
    const result = exec.execute(parseSQL('SELECT COUNT(*) FROM klines'));
    const elapsed = performance.now() - start;

    expect(result.rows[0]['COUNT(*)']).toBe(10000);
    console.log(`  COUNT(*) on 10K rows: ${elapsed.toFixed(2)}ms`);
  });

  it('GROUP BY symbol with COUNT on 10K rows', () => {
    const exec = new SQLExecutor();
    const rows = generateKlines(10000);
    exec.registerTable('klines', makeTable(rows));

    const start = performance.now();
    const result = exec.execute(parseSQL('SELECT symbol, COUNT(*) FROM klines GROUP BY symbol'));
    const elapsed = performance.now() - start;

    expect(result.rows.length).toBe(10); // 10 symbols
    console.log(`  GROUP BY + COUNT on 10K rows: ${elapsed.toFixed(2)}ms`);
  });

  it('GROUP BY symbol, interval with SUM/AVG on 10K rows', () => {
    const exec = new SQLExecutor();
    const rows = generateKlines(10000);
    exec.registerTable('klines', makeTable(rows));

    const start = performance.now();
    const result = exec.execute(
      parseSQL('SELECT symbol, interval, COUNT(*), SUM(volume), AVG(close) FROM klines GROUP BY symbol, interval')
    );
    const elapsed = performance.now() - start;

    // 10 symbols * 5 intervals = 50 groups
    expect(result.rows.length).toBe(50);
    expect(result.rows[0]['COUNT(*)']).toBeGreaterThan(0);
    console.log(`  GROUP BY symbol, interval + COUNT/SUM/AVG on 10K rows: ${elapsed.toFixed(2)}ms`);
  });

  it('MIN/MAX aggregates on 10K rows', () => {
    const exec = new SQLExecutor();
    const rows = generateKlines(10000);
    exec.registerTable('klines', makeTable(rows));

    const start = performance.now();
    const result = exec.execute(parseSQL('SELECT MIN(close), MAX(close), AVG(volume) FROM klines'));
    const elapsed = performance.now() - start;

    expect(result.rows).toHaveLength(1);
    console.log(`  MIN/MAX/AVG on 10K rows: ${elapsed.toFixed(2)}ms`);
  });

  it('HAVING filter on GROUP BY results', () => {
    const exec = new SQLExecutor();
    const rows = generateKlines(10000);
    exec.registerTable('klines', makeTable(rows));

    const start = performance.now();
    const result = exec.execute(
      parseSQL('SELECT symbol, COUNT(*) FROM klines GROUP BY symbol HAVING COUNT(*) > 50')
    );
    const elapsed = performance.now() - start;

    // All symbols should have > 50 rows in 10K dataset
    expect(result.rows.length).toBeGreaterThan(0);
    console.log(`  GROUP BY + HAVING filter on 10K rows: ${elapsed.toFixed(2)}ms`);
  });

  it('Complex query: GROUP BY interval with multiple aggregates', () => {
    const exec = new SQLExecutor();
    const rows = generateKlines(50000);
    exec.registerTable('klines', makeTable(rows));

    const start = performance.now();
    const result = exec.execute(
      parseSQL(`
        SELECT interval,
               COUNT(*) as cnt,
               SUM(volume) as total_vol,
               AVG(close) as avg_close,
               MIN(low) as min_low,
               MAX(high) as max_high
        FROM klines
        GROUP BY interval
        ORDER BY interval
      `)
    );
    const elapsed = performance.now() - start;
    const throughput = (50000 / (elapsed / 1000)).toLocaleString('en-US', { maximumFractionDigits: 0 });

    expect(result.rows.length).toBe(5); // 5 intervals
    console.log(`  Complex GROUP BY on 50K rows: ${elapsed.toFixed(2)}ms (${throughput} rows/sec)`);
    console.log(`  Baseline comparison: C+QJS ~862K rows/sec (write-json)`);
  });
});
