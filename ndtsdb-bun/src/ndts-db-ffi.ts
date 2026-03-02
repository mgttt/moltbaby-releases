// ============================================================
// libndts 数据库 FFI 绑定 - 与 ndtsdb-cli 格式互通
// ============================================================
// 本模块通过 FFI 调用 C 核心 (libndts)，实现与 CLI 版本的格式互通
// Bun 版的写入操作将通过此层委托给 C 核心，不再使用纯 TS 的 append.ts

import { dlopen, FFIType, ptr, CString } from 'bun:ffi';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';

// ─── 版本信息 (与 CLI 统一) ──────────────────────────────

const VERSION_FILE = join(dirname(import.meta.path), '../VERSION');
const VERSION_FILE_LIB = join(dirname(import.meta.path), '../../ndtsdb-lib/VERSION');

export function getVersion(): string {
  try {
    return readFileSync(VERSION_FILE, 'utf-8').trim();
  } catch {
    try {
      return readFileSync(VERSION_FILE_LIB, 'utf-8').trim();
    } catch {
      return '1.0.0.1';
    }
  }
}

export const VERSION = getVersion();
export const VERSION_MAJOR = parseInt(VERSION.split('.')[0]) || 1;
export const VERSION_MINOR = parseInt(VERSION.split('.')[1]) || 0;
export const VERSION_PATCH = parseInt(VERSION.split('.')[2]) || 0;

// ─── 库加载 ─────────────────────────────────────────────

function findLibrary(): string {
  const platform = process.platform;
  const arch = process.arch;
  
  let os: string;
  let cpu: string;
  let bits: string;
  let ext: string;
  
  if (platform === 'darwin') {
    os = 'osx';
    ext = 'dylib';
  } else if (platform === 'win32') {
    os = 'win';
    ext = 'dll';
  } else {
    os = 'lnx';
    ext = 'so';
  }
  
  if (arch === 'arm64') {
    cpu = 'arm';
    bits = '64';
  } else if (arch === 'arm') {
    cpu = 'arm';
    bits = '32';
  } else if (arch === 'ia32') {
    cpu = 'x86';
    bits = '32';
  } else {
    cpu = 'x86';
    bits = '64';
  }
  
  const libName = `libndts-${os}-${cpu}-${bits}.${ext}`;
  
  const paths = [
    // ndtsdb-lib/native/dist (新分离式布局: ndtsdb-bun/src/ → ndtsdb-lib/native/dist/)
    join(dirname(import.meta.path), '../../ndtsdb-lib/native/dist', libName),
    // 向后兼容: 旧布局 ndtsdb/native/dist/
    join(dirname(import.meta.path), '../native/dist', libName),
    join(dirname(import.meta.path), '../../native/dist', libName),
    join(process.cwd(), 'native/dist', libName),
    // 本地编译回退
    join(dirname(import.meta.path), '../native/libndts.so'),
    join(dirname(import.meta.path), '../../native/libndts.so'),
    join(dirname(import.meta.path), '../../ndtsdb-lib/native/libndts.so'),
    join(process.cwd(), 'native/libndts.so'),
  ];
  
  for (const p of paths) {
    if (existsSync(p)) {
      console.log('[ndtsdb:ffi] Loaded library:', p);
      return p;
    }
  }
  
  throw new Error(`libndts not found. Expected: native/dist/${libName}`);
}

// ─── KlineRow 结构 (与 C 结构对齐，56 bytes) ───────────────
// typedef struct {
//     int64_t timestamp;    // 8 bytes
//     double open;          // 8 bytes
//     double high;          // 8 bytes
//     double low;           // 8 bytes
//     double close;         // 8 bytes
//     double volume;        // 8 bytes
//     uint32_t flags;       // 4 bytes
// } KlineRow;              // = 52 bytes, 实际对齐到 56

export interface KlineRow {
  symbol?: string;    // symbol_id -> symbol (for JSON deserialization)
  interval?: string;  // interval (for JSON deserialization)
  timestamp: number;  // int64_t
  open: number;       // double
  high: number;       // double
  low: number;        // double
  close: number;      // double
  volume: number;     // double
  flags?: number;     // uint32_t, default 0
}

// 将 KlineRow 转为 Buffer (56 bytes)
export function klineRowToBuffer(row: KlineRow): Buffer {
  const buf = Buffer.allocUnsafe(56);
  buf.writeBigInt64LE(BigInt(row.timestamp), 0);
  buf.writeDoubleLE(row.open, 8);
  buf.writeDoubleLE(row.high, 16);
  buf.writeDoubleLE(row.low, 24);
  buf.writeDoubleLE(row.close, 32);
  buf.writeDoubleLE(row.volume, 40);
  buf.writeUInt32LE(row.flags ?? 0, 48);
  // padding 4 bytes
  return buf;
}

// 从 Buffer 解析 KlineRow
export function bufferToKlineRow(buf: Buffer, offset: number = 0): KlineRow {
  return {
    timestamp: Number(buf.readBigInt64LE(offset)),
    open: buf.readDoubleLE(offset + 8),
    high: buf.readDoubleLE(offset + 16),
    low: buf.readDoubleLE(offset + 24),
    close: buf.readDoubleLE(offset + 32),
    volume: buf.readDoubleLE(offset + 40),
    flags: buf.readUInt32LE(offset + 48),
  };
}

// ─── Query 结构 ─────────────────────────────────────────

export interface QueryParams {
  symbol?: string;
  interval?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
}

// ─── FFI 加载 ───────────────────────────────────────────

let lib: ReturnType<typeof dlopen> | null = null;

export function initLibrary(): void {
  if (lib) return;
  
  const libPath = findLibrary();
  
  lib = dlopen(libPath, {
    // 生命周期
    ndtsdb_open: {
      args: [FFIType.cstring],
      returns: FFIType.ptr,
    },
    ndtsdb_open_snapshot: {
      args: [FFIType.cstring, FFIType.u64],
      returns: FFIType.ptr,
    },
    ndtsdb_close: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
    
    // 写入
    ndtsdb_insert: {
      args: [FFIType.ptr, FFIType.cstring, FFIType.cstring, FFIType.ptr],
      returns: FFIType.i32,
    },
    ndtsdb_insert_batch: {
      args: [FFIType.ptr, FFIType.cstring, FFIType.cstring, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    ndtsdb_clear: {
      args: [FFIType.ptr, FFIType.cstring, FFIType.cstring],
      returns: FFIType.i32,
    },
    
    // 查询
    ndtsdb_query: {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.ptr,
    },
    ndtsdb_query_all: {
      args: [FFIType.ptr],
      returns: FFIType.ptr,
    },
    ndtsdb_query_filtered: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.i32],
      returns: FFIType.ptr,
    },
    ndtsdb_free_result: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
    
    // 工具函数
    ndtsdb_get_path: {
      args: [FFIType.ptr],
      returns: FFIType.ptr,   // ptr, read via CString (cstring return type is broken in this Bun version)
    },

    // JSON 序列化
    ndtsdb_query_all_json: {
      args: [FFIType.ptr],
      returns: FFIType.ptr,
    },
    ndtsdb_list_symbols_json: {
      args: [FFIType.ptr],
      returns: FFIType.ptr,
    },
    ndtsdb_free_json: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },

    // 注意: ndtsdb_read_partition_json / ndtsdb_free_partition_json / ndtsdb_get_partition_row_count
    // 曾是 read-partition.c 的骨架实现（永远返回空 rows），现已移除。
    // 分区文件读取通过 ndtsdb_open（递归扫描目录）+ ndtsdb_query_all_json 实现。
  });
  
  console.log('[ndtsdb:ffi] Database FFI initialized');
}

// ─── 数据库句柄包装类 ───────────────────────────────────

export class NdtsDatabase {
  private handle: bigint | null = null;
  private path: string;
  
  constructor(path: string) {
    this.path = path;
    initLibrary();
  }
  
  open(): void {
    if (!lib) throw new Error('FFI not initialized');
    
    const pathBuf = Buffer.from(this.path + '\0');
    this.handle = lib.symbols.ndtsdb_open(ptr(pathBuf)) as bigint;

    // Use !handle (falsy check) instead of === 0n — FFI may return 0 (number) or 0n (bigint)
    // both are falsy, while valid pointers are non-zero
    if (!this.handle) {
      throw new Error(`Failed to open database at ${this.path} (locked by another process or invalid path)`);
    }
  }
  
  close(): void {
    if (!lib || !this.handle) return;
    lib.symbols.ndtsdb_close(this.handle);
    this.handle = null;
  }
  
  insert(symbol: string, interval: string, row: KlineRow): void {
    if (!lib || !this.handle) throw new Error('Database not open');

    // #95: timestamp 单位校验 — ndtsdb 要求毫秒（ms）。秒级值 < 1e12 抛出明确错误
    if (row.timestamp > 0 && row.timestamp < 1e12) {
      throw new Error(
        `[ndtsdb] timestamp ${row.timestamp} looks like seconds; ndtsdb requires milliseconds. ` +
        `Use Date.now() (not Date.now()/1000).`
      );
    }

    const symBuf = Buffer.from(symbol + '\0');
    const intBuf = Buffer.from(interval + '\0');
    const rowBuf = klineRowToBuffer(row);
    
    const result = lib.symbols.ndtsdb_insert(
      this.handle,
      ptr(symBuf),
      ptr(intBuf),
      ptr(rowBuf)
    );
    
    if (result !== 0) {
      throw new Error(`Insert failed for ${symbol}/${interval}`);
    }
  }
  
  insertBatch(symbol: string, interval: string, rows: KlineRow[]): number {
    if (!lib || !this.handle) throw new Error('Database not open');
    if (rows.length === 0) return 0;

    // #95: 批量检查 timestamp 单位
    for (const row of rows) {
      if (row.timestamp > 0 && row.timestamp < 1e12) {
        throw new Error(
          `[ndtsdb] timestamp ${row.timestamp} looks like seconds; ndtsdb requires milliseconds.`
        );
      }
    }
    
    const symBuf = Buffer.from(symbol + '\0');
    const intBuf = Buffer.from(interval + '\0');
    
    // 构建连续内存块
    const rowSize = 56;
    const batchBuf = Buffer.allocUnsafe(rowSize * rows.length);
    for (let i = 0; i < rows.length; i++) {
      const rowBuf = klineRowToBuffer(rows[i]);
      rowBuf.copy(batchBuf, i * rowSize);
    }
    
    const result = lib.symbols.ndtsdb_insert_batch(
      this.handle,
      ptr(symBuf),
      ptr(intBuf),
      ptr(batchBuf),
      rows.length
    ) as number;

    if (result < 0) {
      throw new Error(`Batch insert failed for ${symbol}/${interval} (${rows.length} rows)`);
    }

    return result;
  }
  
  clear(symbol: string, interval: string): void {
    if (!lib || !this.handle) throw new Error('Database not open');

    const symBuf = Buffer.from(symbol + '\0');
    const intBuf = Buffer.from(interval + '\0');

    lib.symbols.ndtsdb_clear(this.handle, ptr(symBuf), ptr(intBuf));
  }

  // ── #83 Delete / Tombstone ───────────────────────────────────────────
  // C 层约定：volume < 0 的行为 tombstone（软删除）。
  // queryAll() 仍会返回这些行；上层过滤或使用下方 queryFiltered/queryTimeRange。

  delete(symbol: string, interval: string, timestamp: number): void {
    this.insert(symbol, interval, {
      timestamp, open: 0, high: 0, low: 0, close: 0, volume: -1, flags: 0,
    });
  }

  deleteRange(symbol: string, interval: string, fromMs: number, toMs: number): void {
    const rows = this.queryAll().filter(r =>
      r.symbol === symbol && r.interval === interval &&
      r.timestamp >= fromMs && r.timestamp <= toMs &&
      (r.volume ?? 0) >= 0  // skip existing tombstones
    );
    for (const r of rows) {
      this.delete(symbol, interval, r.timestamp);
    }
  }

  // ── #84 Filtered / TimeRange queries (JS-side, tombstones excluded) ─

  queryFiltered(symbols: string[], interval?: string): KlineRow[] {
    const symSet = new Set(symbols);
    return this.queryAll().filter(r =>
      symSet.has(r.symbol) &&
      (interval == null || r.interval === interval) &&
      (r.volume ?? 0) >= 0
    );
  }

  queryTimeRange(fromMs: number, toMs: number, symbol?: string, interval?: string): KlineRow[] {
    return this.queryAll().filter(r =>
      r.timestamp >= fromMs && r.timestamp <= toMs &&
      (symbol == null || r.symbol === symbol) &&
      (interval == null || r.interval === interval) &&
      (r.volume ?? 0) >= 0
    );
  }

  queryFilteredTime(symbols: string[], fromMs: number, toMs: number, interval?: string): KlineRow[] {
    const symSet = new Set(symbols);
    return this.queryAll().filter(r =>
      symSet.has(r.symbol) &&
      r.timestamp >= fromMs && r.timestamp <= toMs &&
      (interval == null || r.interval === interval) &&
      (r.volume ?? 0) >= 0
    );
  }

  // ── #87 Convenience: head / tail / count ─────────────────────────────

  head(n: number, symbol?: string, interval?: string): KlineRow[] {
    const rows = this.queryAll()
      .filter(r =>
        (symbol == null || r.symbol === symbol) &&
        (interval == null || r.interval === interval) &&
        (r.volume ?? 0) >= 0
      )
      .sort((a, b) => a.timestamp - b.timestamp);
    return rows.slice(0, n);
  }

  tail(n: number, symbol?: string, interval?: string): KlineRow[] {
    const rows = this.queryAll()
      .filter(r =>
        (symbol == null || r.symbol === symbol) &&
        (interval == null || r.interval === interval) &&
        (r.volume ?? 0) >= 0
      )
      .sort((a, b) => a.timestamp - b.timestamp);
    return rows.slice(-n);
  }

  count(symbol?: string, interval?: string): number {
    return this.queryAll().filter(r =>
      (symbol == null || r.symbol === symbol) &&
      (interval == null || r.interval === interval) &&
      (r.volume ?? 0) >= 0
    ).length;
  }

  queryAll(): KlineRow[] {
    if (!lib || !this.handle) throw new Error('Database not open');

    try {
      // ndtsdb_query_all_json returns a malloc'd C string (ptr).
      // We read it with CString, then immediately free it to avoid leaks.
      const jsonPtr = lib.symbols.ndtsdb_query_all_json(this.handle) as bigint | number;

      if (!jsonPtr) return [];

      const jsonStr = new CString(jsonPtr as any).toString();

      try {
        lib.symbols.ndtsdb_free_json(jsonPtr);
      } catch {
        // best-effort free; ptr may already be null
      }

      if (!jsonStr || jsonStr.length === 0) {
        return [];
      }

      // Parse JSON and extract rows
      return this.parseQueryResultJson(jsonStr);
    } catch (err) {
      console.error('[ndtsdb:ffi] Error in queryAll():', err);
      return [];
    }
  }

  private parseQueryResultJson(jsonStr: string): KlineRow[] {
    try {
      // If the string looks like it contains source code, it's probably an error message
      if (jsonStr.includes('private parseQueryResultJson') || jsonStr.includes('function')) {
        console.error('[ndtsdb:ffi] Received source code instead of JSON. This suggests an error in the C code.');
        console.error('[ndtsdb:ffi] First 200 chars:', jsonStr.substring(0, 200));
        return [];
      }

      const data = JSON.parse(jsonStr);
      if (!data.rows || !Array.isArray(data.rows)) {
        return [];
      }

      return data.rows.map((row: any) => ({
        symbol: row.symbol,
        interval: row.interval,
        timestamp: row.timestamp,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        flags: row.flags || 0,
      }));
    } catch (err) {
      console.error('[ndtsdb:ffi] Error parsing query result JSON:', err);
      console.error('[ndtsdb:ffi] JSON string (first 500 chars):', jsonStr.substring(0, 500));
      return [];
    }
  }
  
  getPath(): string {
    if (!lib || !this.handle) return '';
    const pathPtr = lib.symbols.ndtsdb_get_path(this.handle);
    if (!pathPtr) return '';
    return new CString(pathPtr as any).toString();
  }

  listSymbols(): Array<{ symbol: string; interval: string }> {
    if (!lib || !this.handle) throw new Error('Database not open');
    const jsonPtr = lib.symbols.ndtsdb_list_symbols_json(this.handle);
    if (!jsonPtr) return [];
    const jsonStr = new CString(jsonPtr as any).toString();
    try {
      lib.symbols.ndtsdb_free_json(jsonPtr);
    } catch { /* best-effort */ }
    try {
      return JSON.parse(jsonStr) as Array<{ symbol: string; interval: string }>;
    } catch {
      return [];
    }
  }

}

// ─── 便捷函数 ───────────────────────────────────────────

export function openDatabase(path: string): NdtsDatabase {
  const db = new NdtsDatabase(path);
  db.open();
  return db;
}

export function isLibraryAvailable(): boolean {
  try {
    findLibrary();
    return true;
  } catch {
    return false;
  }
}

// 自动初始化（dlopen 失败时不阻塞模块加载）
if (isLibraryAvailable()) {
  try {
    initLibrary();
  } catch (e) {
    // libndts .so 可能版本不匹配，允许模块继续加载
  }
}
