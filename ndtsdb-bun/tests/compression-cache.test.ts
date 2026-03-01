// ============================================================
// 透明解压缓存 - 集成测试
// 验证：压缩文件对上层API完全透明
// ============================================================

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { zstdCompressSync } from 'zlib';
import { join } from 'path';
import { ColumnarTable } from '../src/columnar.js';
import { MmapPool, MmappedColumnarTable } from '../src/mmap/pool.js';
import { CompressionCache } from '../src/compression-cache.js';

const TEST_DIR = '/tmp/ndts-compression-test';
const CACHE_DIR = '/tmp/ndts-compression-test-cache';

// 测试数据
const ROW_COUNT = 1000;
const COLUMNS = [
  { name: 'timestamp', type: 'int64' as const },
  { name: 'open', type: 'float64' as const },
  { name: 'high', type: 'float64' as const },
  { name: 'low', type: 'float64' as const },
  { name: 'close', type: 'float64' as const },
  { name: 'volume', type: 'float64' as const },
];

function createTestTable(): ColumnarTable {
  const table = new ColumnarTable(COLUMNS, ROW_COUNT);

  let baseTs = BigInt(Date.now());
  let price = 100.0;

  // 使用 appendBatch 正确递增 rowCount
  const rows: Record<string, number | bigint>[] = [];
  for (let i = 0; i < ROW_COUNT; i++) {
    price += (Math.random() - 0.5) * 0.5;
    rows.push({
      timestamp: baseTs + BigInt(i * 60000),
      open: price,
      high: price + Math.random() * 0.3,
      low: price - Math.random() * 0.3,
      close: price + (Math.random() - 0.5) * 0.2,
      volume: Math.floor(Math.random() * 10000),
    });
  }
  table.appendBatch(rows);

  return table;
}

beforeAll(() => {
  CompressionCache.resetInstance();
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });

  // 创建两个测试文件
  const table1 = createTestTable();
  const table2 = createTestTable();

  // RAW_ONLY: 只有 .ndts
  table1.saveToFile(join(TEST_DIR, 'RAW_ONLY.ndts'));

  // ZST_ONLY: 只有 .ndts.zst（模拟已压缩归档）
  table2.saveToFile(join(TEST_DIR, 'ZST_ONLY.ndts'));
  const zstOnlyRaw = readFileSync(join(TEST_DIR, 'ZST_ONLY.ndts'));
  writeFileSync(join(TEST_DIR, 'ZST_ONLY.ndts.zst'), zstdCompressSync(zstOnlyRaw, { level: 1 }));
  rmSync(join(TEST_DIR, 'ZST_ONLY.ndts')); // 删除原始文件

  // BOTH: .ndts 和 .ndts.zst 都有（优先用原始文件）
  table1.saveToFile(join(TEST_DIR, 'BOTH.ndts'));
  const bothRaw = readFileSync(join(TEST_DIR, 'BOTH.ndts'));
  writeFileSync(join(TEST_DIR, 'BOTH.ndts.zst'), zstdCompressSync(bothRaw, { level: 1 }));
});

afterAll(() => {
  CompressionCache.resetInstance();
  rmSync(TEST_DIR, { recursive: true, force: true });
  rmSync(CACHE_DIR, { recursive: true, force: true });
});

// ─── CompressionCache.resolve ─────────────────────────

describe('CompressionCache.resolve', () => {
  test('原始文件存在 → 直接返回原路径', () => {
    const cache = CompressionCache.getInstance(CACHE_DIR, 100);
    const resolved = cache.resolve(join(TEST_DIR, 'RAW_ONLY.ndts'));
    expect(resolved).toBe(join(TEST_DIR, 'RAW_ONLY.ndts'));
  });

  test('只有 .zst → 解压到缓存并返回缓存路径', () => {
    const cache = CompressionCache.getInstance(CACHE_DIR, 100);
    const resolved = cache.resolve(join(TEST_DIR, 'ZST_ONLY.ndts'));
    expect(resolved).not.toBe(join(TEST_DIR, 'ZST_ONLY.ndts'));
    expect(resolved.startsWith(CACHE_DIR)).toBe(true);
    expect(existsSync(resolved)).toBe(true);
  });

  test('两者都有 → 优先返回原始文件', () => {
    const cache = CompressionCache.getInstance(CACHE_DIR, 100);
    const resolved = cache.resolve(join(TEST_DIR, 'BOTH.ndts'));
    expect(resolved).toBe(join(TEST_DIR, 'BOTH.ndts'));
  });

  test('都不存在 → 抛异常', () => {
    const cache = CompressionCache.getInstance(CACHE_DIR, 100);
    expect(() => cache.resolve(join(TEST_DIR, 'NONEXIST.ndts'))).toThrow('File not found');
  });

  test('重复 resolve 同一个 .zst → 缓存命中，不重复解压', () => {
    const cache = CompressionCache.getInstance(CACHE_DIR, 100);
    const resolved1 = cache.resolve(join(TEST_DIR, 'ZST_ONLY.ndts'));
    const resolved2 = cache.resolve(join(TEST_DIR, 'ZST_ONLY.ndts'));
    expect(resolved1).toBe(resolved2);
  });
});

// ─── ColumnarTable.loadFromFile 透明解压 ──────────────

describe('ColumnarTable.loadFromFile (transparent decompression)', () => {
  test('加载原始 .ndts', () => {
    const table = ColumnarTable.loadFromFile(join(TEST_DIR, 'RAW_ONLY.ndts'));
    expect(table.getRowCount()).toBe(ROW_COUNT);
    expect(table.getColumnNames()).toContain('timestamp');
    expect(table.getColumnNames()).toContain('close');
  });

  test('加载 .ndts.zst（透明解压）', () => {
    const table = ColumnarTable.loadFromFile(join(TEST_DIR, 'ZST_ONLY.ndts'));
    expect(table.getRowCount()).toBe(ROW_COUNT);
    expect(table.getColumnNames()).toContain('timestamp');
    expect(table.getColumnNames()).toContain('close');
  });

  test('压缩文件数据与原始数据完全一致', () => {
    // BOTH 有原始和压缩两份，用原始读一次，用压缩读一次，比较
    const raw = ColumnarTable.loadFromFile(join(TEST_DIR, 'BOTH.ndts'));

    // 临时删除原始文件，强制走解压路径
    const rawPath = join(TEST_DIR, 'BOTH.ndts');
    const tmpPath = rawPath + '.bak';
    renameSync(rawPath, tmpPath);

    try {
      CompressionCache.resetInstance(); // 清缓存，强制重新解压
      const fromZst = ColumnarTable.loadFromFile(rawPath);

      expect(fromZst.getRowCount()).toBe(raw.getRowCount());

      // 逐列比较
      const rawClose = raw.getColumn('close') as Float64Array;
      const zstClose = fromZst.getColumn('close') as Float64Array;
      for (let i = 0; i < rawClose.length; i++) {
        expect(zstClose[i]).toBe(rawClose[i]);
      }

      const rawTs = raw.getColumn('timestamp') as BigInt64Array;
      const zstTs = fromZst.getColumn('timestamp') as BigInt64Array;
      for (let i = 0; i < rawTs.length; i++) {
        expect(zstTs[i]).toBe(rawTs[i]);
      }
    } finally {
      renameSync(tmpPath, rawPath);
      CompressionCache.resetInstance();
    }
  });
});

// ─── MmappedColumnarTable 透明解压 ────────────────────

describe('MmappedColumnarTable (transparent decompression)', () => {
  test('mmap 原始 .ndts', () => {
    const mmapped = new MmappedColumnarTable(join(TEST_DIR, 'RAW_ONLY.ndts'));
    mmapped.open();
    expect(mmapped.getRowCount()).toBe(ROW_COUNT);
    const close = mmapped.getColumn<Float64Array>('close');
    expect(close.length).toBe(ROW_COUNT);
    mmapped.close();
  });

  test('mmap .ndts.zst（透明解压）', () => {
    const mmapped = new MmappedColumnarTable(join(TEST_DIR, 'ZST_ONLY.ndts'));
    mmapped.open();
    expect(mmapped.getRowCount()).toBe(ROW_COUNT);
    const close = mmapped.getColumn<Float64Array>('close');
    expect(close.length).toBe(ROW_COUNT);
    expect(typeof close[0]).toBe('number');
    expect(isNaN(close[0])).toBe(false);
    mmapped.close();
  });
});

// ─── MmapPool 透明探测 ───────────────────────────────

describe('MmapPool (transparent probe)', () => {
  test('混合加载原始和压缩文件', () => {
    CompressionCache.resetInstance();
    const pool = new MmapPool();
    pool.init(['RAW_ONLY', 'ZST_ONLY', 'BOTH'], TEST_DIR);

    expect(pool.getSymbols().sort()).toEqual(['BOTH', 'RAW_ONLY', 'ZST_ONLY']);
    expect(pool.getRowCount('RAW_ONLY')).toBe(ROW_COUNT);
    expect(pool.getRowCount('ZST_ONLY')).toBe(ROW_COUNT);
    expect(pool.getRowCount('BOTH')).toBe(ROW_COUNT);

    // 读取压缩文件的列数据
    const close = pool.getColumn<Float64Array>('ZST_ONLY', 'close');
    expect(close.length).toBe(ROW_COUNT);
    expect(isNaN(close[0])).toBe(false);

    pool.close();
  });

  test('不存在的 symbol 应该跳过而不是崩溃', () => {
    const pool = new MmapPool();
    pool.init(['RAW_ONLY', 'NONEXIST'], TEST_DIR);
    expect(pool.getSymbols()).toEqual(['RAW_ONLY']);
    pool.close();
  });
});

// ─── 缓存统计 ─────────────────────────────────────────

describe('Cache stats', () => {
  test('缓存统计正确', () => {
    CompressionCache.resetInstance();
    const cache = CompressionCache.getInstance(CACHE_DIR, 100);
    // 触发一次解压
    cache.resolve(join(TEST_DIR, 'ZST_ONLY.ndts'));
    const stats = cache.getStats();
    expect(stats.entries).toBeGreaterThanOrEqual(1);
    expect(stats.totalMB).toBeGreaterThan(0);
  });
});
