import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { openDatabase, NdtsDatabase } from '../src/ndts-db.ts';
import { AppendWriter } from '../src/append-ffi.ts';
import { PartitionedTable } from '../src/partition.ts';
import { parseSQL, SQLExecutor, ColumnarTable } from '../src/sql.ts';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function tmpDir(): string {
  const p = join(tmpdir(), `ndtsdb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(p, { recursive: true });
  return p;
}

function cleanDir(p: string): void {
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

// ─── NdtsDatabase ─────────────────────────────────────────────────────────────

describe('NdtsDatabase', () => {
  let dir: string;
  let db: NdtsDatabase;

  beforeEach(() => {
    dir = tmpDir();
    db = openDatabase(dir);
  });

  afterEach(() => {
    db.close();
    cleanDir(dir);
  });

  it('inserts and queries a single row', () => {
    db.insert('BTCUSDT', '1h', {
      timestamp: 1700000000000n,
      open: 30000, high: 30100, low: 29900, close: 30050, volume: 100,
    });
    const rows = db.queryAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe('BTCUSDT');
    expect(rows[0].interval).toBe('1h');
    expect(rows[0].timestamp).toBe(1700000000000n);
    expect(rows[0].close).toBe(30050);
  });

  it('inserts a batch of rows', () => {
    const batch = Array.from({ length: 100 }, (_, i) => ({
      timestamp: BigInt(1700000000000 + i * 3_600_000),
      open: 100 + i, high: 110 + i, low: 90 + i, close: 105 + i, volume: 1000 + i,
    }));
    const n = db.insertBatch('ETHUSDT', '1h', batch);
    expect(n).toBe(100);
    const rows = db.queryAll();
    expect(rows).toHaveLength(100);
  });

  it('listSymbols returns all (symbol, interval) pairs', () => {
    db.insert('BTCUSDT', '1h',  { timestamp: 1700000000000n, open: 1, high: 1, low: 1, close: 1, volume: 1 });
    db.insert('BTCUSDT', '4h',  { timestamp: 1700000000000n, open: 1, high: 1, low: 1, close: 1, volume: 1 });
    db.insert('ETHUSDT', '1h',  { timestamp: 1700000000000n, open: 1, high: 1, low: 1, close: 1, volume: 1 });
    const syms = db.listSymbols();
    expect(syms).toHaveLength(3);
    const keys = syms.map(s => `${s.symbol}/${s.interval}`).sort();
    expect(keys).toEqual(['BTCUSDT/1h', 'BTCUSDT/4h', 'ETHUSDT/1h']);
  });

  it('getLatestTimestamp returns the max timestamp for a symbol', () => {
    db.insertBatch('BTCUSDT', '1m', [
      { timestamp: 1700000001000n, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { timestamp: 1700000060000n, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { timestamp: 1700000030000n, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ]);
    const latest = db.getLatestTimestamp('BTCUSDT', '1m');
    expect(latest).toBe(1700000060000n);
  });

  it('clear removes rows for a symbol/interval', () => {
    db.insert('BTCUSDT', '1h', { timestamp: 1700000000000n, open: 1, high: 1, low: 1, close: 1, volume: 1 });
    db.insert('ETHUSDT', '1h', { timestamp: 1700000000000n, open: 2, high: 2, low: 2, close: 2, volume: 2 });
    db.clear('BTCUSDT', '1h');
    const rows = db.queryAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe('ETHUSDT');
  });

  it('upserts rows with duplicate timestamp', () => {
    const ts = 1700000000000n;
    db.insert('BTCUSDT', '1h', { timestamp: ts, open: 1, high: 1, low: 1, close: 1, volume: 1 });
    db.insert('BTCUSDT', '1h', { timestamp: ts, open: 2, high: 2, low: 2, close: 2, volume: 2 });
    const rows = db.queryAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].close).toBe(2); // updated
  });
});

// ─── AppendWriter ─────────────────────────────────────────────────────────────

describe('AppendWriter', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = tmpDir();
    filePath = join(dir, 'bars.ndts');
  });

  afterEach(() => {
    cleanDir(dir);
  });

  it('open + append + close then readAll', () => {
    const cols = [
      { name: 'timestamp', type: 'int64'   as const },
      { name: 'open',      type: 'float64' as const },
      { name: 'high',      type: 'float64' as const },
      { name: 'low',       type: 'float64' as const },
      { name: 'close',     type: 'float64' as const },
      { name: 'volume',    type: 'float64' as const },
    ];

    const w = new AppendWriter(filePath, cols);
    w.open();
    w.append([
      { timestamp: 1700000000000n, open: 100, high: 110, low: 90,  close: 105, volume: 500 },
      { timestamp: 1700003600000n, open: 105, high: 115, low: 95,  close: 110, volume: 600 },
      { timestamp: 1700007200000n, open: 110, high: 120, low: 100, close: 115, volume: 700 },
    ]);
    w.close();

    const { data } = AppendWriter.readAll(filePath);
    const ts = data.get('timestamp') as BigInt64Array;
    const cl = data.get('close')     as Float64Array;

    expect(ts).toHaveLength(3);
    expect(ts[0]).toBe(1700000000000n);
    expect(ts[2]).toBe(1700007200000n);
    expect(cl[0]).toBe(105);
    expect(cl[2]).toBe(115);
  });

  it('readAll on empty path returns empty map', () => {
    const { data } = AppendWriter.readAll('/tmp/nonexistent-ndtsdb-xxx-yyy');
    expect(data.size).toBe(0);
  });
});

// ─── PartitionedTable ─────────────────────────────────────────────────────────

describe('PartitionedTable', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { cleanDir(dir); });

  const columns = [
    { name: 'symbol',    type: 'string' as const },
    { name: 'interval',  type: 'string' as const },
    { name: 'timestamp', type: 'int64'   as const },
    { name: 'open',      type: 'float64' as const },
    { name: 'high',      type: 'float64' as const },
    { name: 'low',       type: 'float64' as const },
    { name: 'close',     type: 'float64' as const },
    { name: 'volume',    type: 'float64' as const },
  ];

  const strategy = { type: 'time' as const, column: 'timestamp', interval: 'day' as const };

  it('appends and queries rows', () => {
    const table = new PartitionedTable(dir, columns, strategy);
    const base = 1700000000000n;

    table.append(Array.from({ length: 24 }, (_, i) => ({
      symbol: 'ETHUSDT', interval: '1h',
      timestamp: base + BigInt(i) * 3_600_000n,
      open: 3000 + i, high: 3010 + i, low: 2990 + i, close: 3005 + i, volume: 100 + i,
    })));

    const rows = table.query();
    expect(rows).toHaveLength(24);
  });

  it('filter by symbol', () => {
    const table = new PartitionedTable(dir, columns, strategy);
    const base = 1700000000000n;

    table.append([
      { symbol: 'BTCUSDT', interval: '1h', timestamp: base,          open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { symbol: 'ETHUSDT', interval: '1h', timestamp: base + 1000n,  open: 2, high: 2, low: 2, close: 2, volume: 2 },
      { symbol: 'BTCUSDT', interval: '4h', timestamp: base + 2000n,  open: 3, high: 3, low: 3, close: 3, volume: 3 },
    ]);

    const eth = table.query(r => r.symbol === 'ETHUSDT');
    expect(eth).toHaveLength(1);
    expect(eth[0].symbol).toBe('ETHUSDT');

    const btc1h = table.query(r => r.symbol === 'BTCUSDT' && r.interval === '1h');
    expect(btc1h).toHaveLength(1);
  });

  it('timeRange filter', () => {
    const table = new PartitionedTable(dir, columns, strategy);
    const base = 1700000000000n;
    const rows24 = Array.from({ length: 24 }, (_, i) => ({
      symbol: 'X', interval: '1h',
      timestamp: base + BigInt(i) * 3_600_000n,
      open: 1, high: 1, low: 1, close: 1, volume: 1,
    }));
    table.append(rows24);

    // First 12 hours
    const first12 = table.query(undefined, {
      timeRange: { min: base, max: base + 11n * 3_600_000n },
    });
    expect(first12).toHaveLength(12);
  });
});

// ─── parseSQL ─────────────────────────────────────────────────────────────────

describe('parseSQL', () => {
  it('parses basic SELECT *', () => {
    const r = parseSQL('SELECT * FROM klines');
    expect(r.type).toBe('SELECT');
    expect(r.data.fields).toEqual(['*']);
    expect(r.data.from).toBe('klines');
  });

  it('parses SELECT with columns', () => {
    const r = parseSQL('SELECT timestamp, close, volume FROM bars');
    expect(r.data.fields).toEqual(['timestamp', 'close', 'volume']);
    expect(r.data.from).toBe('bars');
  });

  it('parses WHERE clause', () => {
    const r = parseSQL("SELECT * FROM klines WHERE symbol = 'BTCUSDT'");
    expect(r.data.where).toBeDefined();
    expect(r.data.where).toContain('symbol');
  });

  it('parses ORDER BY and LIMIT', () => {
    const r = parseSQL('SELECT * FROM klines ORDER BY timestamp DESC LIMIT 100');
    expect(r.data.orderBy).toHaveLength(1);
    expect(r.data.orderBy?.[0].col).toBe('timestamp');
    expect(r.data.orderBy?.[0].direction).toBe('DESC');
    expect(r.data.limit).toBe(100);
  });

  it('parses OFFSET', () => {
    const r = parseSQL('SELECT * FROM klines LIMIT 10 OFFSET 20');
    expect(r.data.limit).toBe(10);
    expect(r.data.offset).toBe(20);
  });

  it('handles non-SELECT statements', () => {
    expect(parseSQL('INSERT INTO t VALUES (1)').type).toBe('INSERT');
    expect(parseSQL('DELETE FROM t').type).toBe('DELETE');
  });
});

// ─── SQLExecutor ─────────────────────────────────────────────────────────────

describe('SQLExecutor', () => {
  function makeTable(rows: Record<string, any>[]): ColumnarTable {
    const t = new ColumnarTable([
      { name: 'symbol', type: 'string' },
      { name: 'timestamp', type: 'int64' },
      { name: 'close', type: 'float64' },
      { name: 'volume', type: 'float64' },
    ]);
    t.appendBatch(rows);
    return t;
  }

  it('SELECT * returns all rows', () => {
    const exec = new SQLExecutor();
    exec.registerTable('klines', makeTable([
      { symbol: 'BTC', timestamp: 1n, close: 100, volume: 10 },
      { symbol: 'ETH', timestamp: 2n, close: 200, volume: 20 },
    ]));
    const { rows } = exec.execute(parseSQL('SELECT * FROM klines'));
    expect(rows).toHaveLength(2);
  });

  it('LIMIT restricts rows', () => {
    const exec = new SQLExecutor();
    exec.registerTable('klines', makeTable([
      { symbol: 'A', timestamp: 1n, close: 1, volume: 1 },
      { symbol: 'B', timestamp: 2n, close: 2, volume: 2 },
      { symbol: 'C', timestamp: 3n, close: 3, volume: 3 },
    ]));
    const { rows } = exec.execute(parseSQL('SELECT * FROM klines LIMIT 2'));
    expect(rows).toHaveLength(2);
  });

  it('ORDER BY timestamp ASC', () => {
    const exec = new SQLExecutor();
    exec.registerTable('klines', makeTable([
      { symbol: 'A', timestamp: 3n, close: 3, volume: 3 },
      { symbol: 'B', timestamp: 1n, close: 1, volume: 1 },
      { symbol: 'C', timestamp: 2n, close: 2, volume: 2 },
    ]));
    const { rows } = exec.execute(parseSQL('SELECT * FROM klines ORDER BY timestamp ASC'));
    expect(rows[0].timestamp).toBe(1n);
    expect(rows[2].timestamp).toBe(3n);
  });

  it('throws on unknown table', () => {
    const exec = new SQLExecutor();
    expect(() => exec.execute(parseSQL('SELECT * FROM nonexistent'))).toThrow('Table not found');
  });
});

// ─── Group By & Aggregation ──────────────────────────────────────────────────

describe('GROUP BY and Aggregation', () => {
  function makeTable(rows: Record<string, any>[]): ColumnarTable {
    const t = new ColumnarTable([
      { name: 'symbol', type: 'string' },
      { name: 'interval', type: 'string' },
      { name: 'timestamp', type: 'int64' },
      { name: 'close', type: 'float64' },
      { name: 'volume', type: 'float64' },
    ]);
    t.appendBatch(rows);
    return t;
  }

  it('COUNT(*) without GROUP BY', () => {
    const exec = new SQLExecutor();
    exec.registerTable('klines', makeTable([
      { symbol: 'BTC', interval: '1h', timestamp: 1n, close: 100, volume: 10 },
      { symbol: 'ETH', interval: '1h', timestamp: 2n, close: 200, volume: 20 },
      { symbol: 'BTC', interval: '1h', timestamp: 3n, close: 150, volume: 15 },
    ]));
    const { rows } = exec.execute(parseSQL('SELECT COUNT(*) FROM klines'));
    expect(rows).toHaveLength(1);
    expect(rows[0]['COUNT(*)']).toBe(3);
  });

  it('SUM aggregate without GROUP BY', () => {
    const exec = new SQLExecutor();
    exec.registerTable('klines', makeTable([
      { symbol: 'BTC', interval: '1h', timestamp: 1n, close: 100, volume: 10 },
      { symbol: 'ETH', interval: '1h', timestamp: 2n, close: 200, volume: 20 },
    ]));
    const { rows } = exec.execute(parseSQL('SELECT SUM(volume) FROM klines'));
    expect(rows).toHaveLength(1);
    expect(rows[0]['SUM(volume)']).toBe(30);
  });

  it('AVG aggregate without GROUP BY', () => {
    const exec = new SQLExecutor();
    exec.registerTable('klines', makeTable([
      { symbol: 'BTC', interval: '1h', timestamp: 1n, close: 100, volume: 10 },
      { symbol: 'ETH', interval: '1h', timestamp: 2n, close: 200, volume: 20 },
    ]));
    const { rows } = exec.execute(parseSQL('SELECT AVG(close) FROM klines'));
    expect(rows).toHaveLength(1);
    expect(rows[0]['AVG(close)']).toBe(150);
  });

  it('MIN and MAX aggregates', () => {
    const exec = new SQLExecutor();
    exec.registerTable('klines', makeTable([
      { symbol: 'BTC', interval: '1h', timestamp: 1n, close: 100, volume: 10 },
      { symbol: 'ETH', interval: '1h', timestamp: 2n, close: 200, volume: 20 },
      { symbol: 'BTC', interval: '1h', timestamp: 3n, close: 150, volume: 15 },
    ]));
    const { rows } = exec.execute(parseSQL('SELECT MIN(close), MAX(close) FROM klines'));
    expect(rows).toHaveLength(1);
    expect(rows[0]['MIN(close)']).toBe(100);
    expect(rows[0]['MAX(close)']).toBe(200);
  });

  it('GROUP BY single column with COUNT', () => {
    const exec = new SQLExecutor();
    exec.registerTable('klines', makeTable([
      { symbol: 'BTC', interval: '1h', timestamp: 1n, close: 100, volume: 10 },
      { symbol: 'ETH', interval: '1h', timestamp: 2n, close: 200, volume: 20 },
      { symbol: 'BTC', interval: '1h', timestamp: 3n, close: 150, volume: 15 },
    ]));
    const { rows } = exec.execute(parseSQL('SELECT symbol, COUNT(*) FROM klines GROUP BY symbol'));
    expect(rows).toHaveLength(2);
    const btcRow = rows.find(r => r.symbol === 'BTC');
    const ethRow = rows.find(r => r.symbol === 'ETH');
    expect(btcRow?.['COUNT(*)']).toBe(2);
    expect(ethRow?.['COUNT(*)']).toBe(1);
  });

  it('GROUP BY with SUM', () => {
    const exec = new SQLExecutor();
    exec.registerTable('klines', makeTable([
      { symbol: 'BTC', interval: '1h', timestamp: 1n, close: 100, volume: 10 },
      { symbol: 'ETH', interval: '1h', timestamp: 2n, close: 200, volume: 20 },
      { symbol: 'BTC', interval: '1h', timestamp: 3n, close: 150, volume: 15 },
    ]));
    const { rows } = exec.execute(parseSQL('SELECT symbol, SUM(volume) FROM klines GROUP BY symbol'));
    expect(rows).toHaveLength(2);
    const btcRow = rows.find(r => r.symbol === 'BTC');
    expect(btcRow?.['SUM(volume)']).toBe(25); // 10 + 15
  });

  it('GROUP BY multiple columns', () => {
    const exec = new SQLExecutor();
    exec.registerTable('klines', makeTable([
      { symbol: 'BTC', interval: '1h', timestamp: 1n, close: 100, volume: 10 },
      { symbol: 'BTC', interval: '4h', timestamp: 2n, close: 200, volume: 20 },
      { symbol: 'BTC', interval: '1h', timestamp: 3n, close: 150, volume: 15 },
      { symbol: 'ETH', interval: '1h', timestamp: 4n, close: 50, volume: 5 },
    ]));
    const { rows } = exec.execute(parseSQL('SELECT symbol, interval, COUNT(*) FROM klines GROUP BY symbol, interval'));
    expect(rows).toHaveLength(3);
    const btc1h = rows.find(r => r.symbol === 'BTC' && r.interval === '1h');
    expect(btc1h?.['COUNT(*)']).toBe(2);
  });

  it('GROUP BY with AVG', () => {
    const exec = new SQLExecutor();
    exec.registerTable('klines', makeTable([
      { symbol: 'BTC', interval: '1h', timestamp: 1n, close: 100, volume: 10 },
      { symbol: 'BTC', interval: '1h', timestamp: 2n, close: 200, volume: 20 },
      { symbol: 'ETH', interval: '1h', timestamp: 3n, close: 50, volume: 5 },
    ]));
    const { rows } = exec.execute(parseSQL('SELECT symbol, AVG(close) FROM klines GROUP BY symbol'));
    expect(rows).toHaveLength(2);
    const btcRow = rows.find(r => r.symbol === 'BTC');
    expect(btcRow?.['AVG(close)']).toBe(150); // (100 + 200) / 2
  });

  it('parseSQL: parses GROUP BY clause', () => {
    const r = parseSQL('SELECT symbol, COUNT(*) FROM klines GROUP BY symbol');
    expect(r.data.groupBy).toEqual(['symbol']);
  });

  it('parseSQL: parses multiple GROUP BY columns', () => {
    const r = parseSQL('SELECT symbol, interval, COUNT(*) FROM klines GROUP BY symbol, interval');
    expect(r.data.groupBy).toEqual(['symbol', 'interval']);
  });

  it('parseSQL: parses HAVING clause', () => {
    const r = parseSQL("SELECT symbol, COUNT(*) FROM klines GROUP BY symbol HAVING COUNT(*) > 1");
    expect(r.data.having).toBe('COUNT(*) > 1');
  });

  it('HAVING filters grouped results', () => {
    const exec = new SQLExecutor();
    exec.registerTable('klines', makeTable([
      { symbol: 'BTC', interval: '1h', timestamp: 1n, close: 100, volume: 10 },
      { symbol: 'ETH', interval: '1h', timestamp: 2n, close: 200, volume: 20 },
      { symbol: 'BTC', interval: '1h', timestamp: 3n, close: 150, volume: 15 },
    ]));
    const { rows } = exec.execute(parseSQL("SELECT symbol, COUNT(*) FROM klines GROUP BY symbol HAVING COUNT(*) > 1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe('BTC');
  });
});

// ─── DISTINCT and Enhanced ORDER BY ──────────────────────────────────────────

describe('DISTINCT and Enhanced ORDER BY', () => {
  function makeTable(rows: Record<string, any>[]): ColumnarTable {
    const t = new ColumnarTable([
      { name: 'symbol', type: 'string' },
      { name: 'interval', type: 'string' },
      { name: 'timestamp', type: 'int64' },
      { name: 'close', type: 'float64' },
      { name: 'volume', type: 'float64' },
    ]);
    t.appendBatch(rows);
    return t;
  }

  it('SELECT DISTINCT removes duplicates', () => {
    const exec = new SQLExecutor();
    exec.registerTable('klines', makeTable([
      { symbol: 'BTC', interval: '1h', timestamp: 1n, close: 100, volume: 10 },
      { symbol: 'BTC', interval: '1h', timestamp: 1n, close: 100, volume: 10 }, // duplicate
      { symbol: 'ETH', interval: '1h', timestamp: 2n, close: 200, volume: 20 },
    ]));
    const { rows } = exec.execute(parseSQL('SELECT DISTINCT * FROM klines'));
    expect(rows).toHaveLength(2);
  });

  it('SELECT DISTINCT with column projection', () => {
    const exec = new SQLExecutor();
    exec.registerTable('klines', makeTable([
      { symbol: 'BTC', interval: '1h', timestamp: 1n, close: 100, volume: 10 },
      { symbol: 'BTC', interval: '4h', timestamp: 2n, close: 150, volume: 15 },
      { symbol: 'BTC', interval: '1h', timestamp: 3n, close: 100, volume: 10 }, // duplicate symbol
      { symbol: 'ETH', interval: '1h', timestamp: 4n, close: 200, volume: 20 },
    ]));
    const { rows } = exec.execute(parseSQL('SELECT DISTINCT symbol FROM klines'));
    expect(rows).toHaveLength(2);
  });

  it('parseSQL detects DISTINCT', () => {
    const r = parseSQL('SELECT DISTINCT symbol FROM klines');
    expect(r.data.distinct).toBe(true);
  });

  it('ORDER BY multiple columns', () => {
    const exec = new SQLExecutor();
    exec.registerTable('klines', makeTable([
      { symbol: 'BTC', interval: '4h', timestamp: 3n, close: 150, volume: 15 },
      { symbol: 'BTC', interval: '1h', timestamp: 1n, close: 100, volume: 10 },
      { symbol: 'ETH', interval: '1h', timestamp: 2n, close: 200, volume: 20 },
    ]));
    const { rows } = exec.execute(parseSQL('SELECT * FROM klines ORDER BY symbol ASC, interval ASC'));
    expect(rows[0].symbol).toBe('BTC');
    expect(rows[0].interval).toBe('1h');
    expect(rows[1].interval).toBe('4h');
    expect(rows[2].symbol).toBe('ETH');
  });

  it('ORDER BY with DESC on multiple columns', () => {
    const exec = new SQLExecutor();
    exec.registerTable('klines', makeTable([
      { symbol: 'A', interval: '1h', timestamp: 1n, close: 100, volume: 10 },
      { symbol: 'A', interval: '4h', timestamp: 2n, close: 200, volume: 20 },
      { symbol: 'B', interval: '1h', timestamp: 3n, close: 150, volume: 15 },
    ]));
    const { rows } = exec.execute(parseSQL('SELECT * FROM klines ORDER BY symbol DESC, close DESC'));
    expect(rows[0].symbol).toBe('B');
    expect(rows[1].symbol).toBe('A');
    expect(rows[1].close).toBe(200);
    expect(rows[2].close).toBe(100);
  });

  it('parseSQL: parses multiple ORDER BY columns', () => {
    const r = parseSQL('SELECT * FROM klines ORDER BY symbol ASC, timestamp DESC');
    expect(r.data.orderBy).toHaveLength(2);
    expect(r.data.orderBy?.[0].col).toBe('symbol');
    expect(r.data.orderBy?.[0].direction).toBe('ASC');
    expect(r.data.orderBy?.[1].col).toBe('timestamp');
    expect(r.data.orderBy?.[1].direction).toBe('DESC');
  });

  it('DISTINCT with ORDER BY', () => {
    const exec = new SQLExecutor();
    exec.registerTable('klines', makeTable([
      { symbol: 'BTC', interval: '1h', timestamp: 3n, close: 150, volume: 15 },
      { symbol: 'ETH', interval: '1h', timestamp: 2n, close: 200, volume: 20 },
      { symbol: 'BTC', interval: '1h', timestamp: 3n, close: 150, volume: 15 }, // duplicate
    ]));
    const { rows } = exec.execute(parseSQL('SELECT DISTINCT symbol FROM klines ORDER BY symbol DESC'));
    expect(rows).toHaveLength(2);
    expect(rows[0].symbol).toBe('ETH');
    expect(rows[1].symbol).toBe('BTC');
  });
});
