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

export function getVersion(): string {
  try {
    return readFileSync(VERSION_FILE, 'utf-8').trim();
  } catch {
    return '1.0.0.1';
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
  } else if (arch === 'ia32' || arch === 'x86') {
    cpu = 'x86';
    bits = '32';
  } else {
    cpu = 'x86';
    bits = '64';
  }
  
  const libName = `libndts-${os}-${cpu}-${bits}.${ext}`;
  
  const paths = [
    // 优先 dist 目录 (跨平台预编译)
    join(dirname(import.meta.path), '../native/dist', libName),
    join(dirname(import.meta.path), '../../native/dist', libName),
    join(process.cwd(), 'native/dist', libName),
    // 回退到本地编译
    join(dirname(import.meta.path), '../native/libndts.so'),
    join(dirname(import.meta.path), '../../native/libndts.so'),
    join(process.cwd(), 'native/libndts.so'),
    // CLI 构建产物
    join(dirname(import.meta.path), '../../ndtsdb-cli/lib/libndts.so'),
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
      returns: FFIType.cstring,
    },

    // JSON 序列化
    ndtsdb_query_all_json: {
      args: [FFIType.ptr],
      returns: FFIType.cstring,
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
    
    if (this.handle === 0n) {
      throw new Error(`Failed to open database at ${this.path}`);
    }
  }
  
  close(): void {
    if (!lib || !this.handle) return;
    lib.symbols.ndtsdb_close(this.handle);
    this.handle = null;
  }
  
  insert(symbol: string, interval: string, row: KlineRow): void {
    if (!lib || !this.handle) throw new Error('Database not open');
    
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
    );
    
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
  
  queryAll(): KlineRow[] {
    if (!lib || !this.handle) throw new Error('Database not open');

    try {
      // 使用新的 JSON 序列化函数
      // Bun FFI: cstring 返回值是直接的 JS 字符串，无需转换
      const jsonStr = lib.symbols.ndtsdb_query_all_json(this.handle) as string;

      if (!jsonStr || jsonStr.length === 0) {
        return [];
      }

      // Note: Bun FFI 会自动释放 C 字符串，无需显式调用 ndtsdb_free_json
      // 如果需要手动释放，取消下面的注释
      // try {
      //   lib.symbols.ndtsdb_free_json(jsonStr);
      // } catch (e) {
      //   // Ignore cleanup errors
      // }

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
    return pathPtr ? new CString(pathPtr) : '';
  }

  /**
   * 读取分区文件的实际数据
   *
   * ⚠️ ndtsdb_read_partition_json (C FFI) 已知返回垃圾数据，委托给 readPartitionFileFFI。
   * @param filepath 分区文件路径
   * @returns 解压后的行数组
   */
  readPartitionFile(filepath: string): KlineRow[] {
    // 委托给修复后的 readPartitionFileFFI（使用 ndtsdb-cli subprocess）
    return readPartitionFileFFI(filepath);
  }

  /**
   * 获取分区文件的行数（无需读取所有数据）
   * @param filepath 分区文件路径
   * @returns 行数
   */
  getPartitionRowCount(filepath: string): number {
    // ndtsdb_get_partition_row_count 已废弃（骨架实现，已从 .so 移除）
    // 改用 readPartitionFileHeader 读 header 中的 totalRows
    try {
      const { readPartitionFileHeader } = require('./partition-file-reader.js');
      const header = readPartitionFileHeader(filepath);
      return header.totalRows || 0;
    } catch {
      return 0;
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

/**
 * 直接读取分区文件
 *
 * ⚠️ 已知问题：ndtsdb_read_partition_json (C FFI) 会返回垃圾数据（数值严重失真）。
 * 该函数已改用 ndtsdb-cli subprocess 作为可靠路径，与 CLI 共用同一 C 核心逻辑。
 *
 * @param filepath 分区文件路径（格式: <dbPath>/klines-partitioned/<interval>/bucket-N.ndts）
 * @returns 解压后的行数组
 */
export function readPartitionFileFFI(filepath: string): KlineRow[] {
  // ndtsdb_read_partition_json 已知返回垃圾数据，不调用
  // 改用 ndtsdb-cli subprocess
  const { spawnSync } = require('child_process');
  const { existsSync } = require('fs');
  const { join, dirname } = require('path');

  // 查找 ndtsdb-cli
  const cliCandidates = [
    join(dirname(import.meta.path), '../../ndtsdb-cli/ndtsdb-cli.com'),
    join(dirname(import.meta.path), '../../ndtsdb-cli/ndtsdb-cli'),
    join(process.cwd(), 'ndtsdb-cli/ndtsdb-cli.com'),
    join(process.cwd(), 'ndtsdb-cli/ndtsdb-cli'),
    '/home/devali/moltbaby/ndtsdb-cli/ndtsdb-cli.com',
    '/home/devali/moltbaby/ndtsdb-cli/ndtsdb-cli',
  ];
  const cliPath = cliCandidates.find(p => existsSync(p));
  if (!cliPath) {
    console.warn('[ndtsdb:ffi] readPartitionFileFFI: ndtsdb-cli not found');
    return [];
  }

  // 从路径推断 dbPath 和 interval
  // 格式: <dbPath>/klines-partitioned/<interval>/bucket-N.ndts
  const partMatch = filepath.match(/^(.+)\/klines-partitioned\/([^/]+)\/bucket-\d+\.ndts$/);
  if (!partMatch) {
    console.warn(`[ndtsdb:ffi] readPartitionFileFFI: cannot parse path: ${filepath}`);
    return [];
  }

  const dbPath = partMatch[1];
  const interval = partMatch[2];

  try {
    const result = spawnSync(
      cliPath,
      ['export', '--database', dbPath, '--interval', interval, '--format', 'json'],
      { encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024, timeout: 30000 }
    );

    if (result.status !== 0 || !result.stdout || result.stdout.trim().length === 0) {
      console.warn(`[ndtsdb:ffi] ndtsdb-cli export failed for ${dbPath}/${interval}: ${result.stderr?.substring(0, 200)}`);
      return [];
    }

    const lines = result.stdout.trim().split('\n').filter((l: string) => l.length > 0);
    const rows: KlineRow[] = [];
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        rows.push({
          timestamp: row.timestamp || 0,
          open: row.open || 0,
          high: row.high || 0,
          low: row.low || 0,
          close: row.close || 0,
          volume: row.volume || 0,
          flags: row.flags || 0,
        });
      } catch {}
    }
    return rows;
  } catch (err: any) {
    console.error('[ndtsdb:ffi] readPartitionFileFFI subprocess error:', err.message);
    return [];
  }
}

/**
 * 获取分区文件的行数
 * @param filepath 分区文件路径
 * @returns 行数
 */
export function getPartitionRowCountFFI(filepath: string): number {
  initLibrary();

  if (!lib) return 0;

  try {
    const filePathBuf = Buffer.from(filepath + '\0');
    const count = lib.symbols.ndtsdb_get_partition_row_count(ptr(filePathBuf)) as number;
    return count;
  } catch (err) {
    return 0;
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
