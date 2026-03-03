/**
 * ndts-db-ffi.ts — Low-level Bun FFI bindings for libndts
 *
 * Wraps the C library functions via Bun FFI.
 * Handles platform detection, struct encoding, and raw pointer management.
 */
import { dlopen, FFIType, CString } from 'bun:ffi';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { arch, platform } from 'os';

// ─── KlineRow struct layout (56 bytes, matches C struct) ───────────────────
// offset 0:  int64_t  timestamp (8 bytes LE)
// offset 8:  double   open      (8 bytes LE)
// offset 16: double   high      (8 bytes LE)
// offset 24: double   low       (8 bytes LE)
// offset 32: double   close     (8 bytes LE)
// offset 40: double   volume    (8 bytes LE)
// offset 48: uint32_t flags     (4 bytes LE)
// offset 52: padding            (4 bytes)
export const KLINE_ROW_SIZE = 56;

export interface KlineRow {
  timestamp: bigint;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  flags?: number;
}

export interface NDTSRow extends KlineRow {
  symbol: string;
  interval: string;
}

// ─── Library path detection ─────────────────────────────────────────────────

function findLibPath(): string {
  const dir = import.meta.dir; // ndtsdb-bun/src/
  const p = platform();
  const a = arch();

  const libName = (() => {
    if (p === 'linux'  && a === 'x64')   return 'libndts-lnx-x86-64.so';
    if (p === 'linux'  && a === 'arm64') return 'libndts-lnx-arm-64.so';
    if (p === 'darwin' && a === 'x64')   return 'libndts-osx-x86-64.dylib';
    if (p === 'darwin' && a === 'arm64') return 'libndts-osx-arm-64.dylib';
    if (p === 'win32'  && a === 'x64')   return 'libndts-win-x86-64.dll';
    throw new Error(`Unsupported platform: ${p} ${a}`);
  })();

  const candidates = [
    // ndtsdb-bun/src/ → ndtsdb-lib/native/dist/
    resolve(dir, '../../ndtsdb-lib/native/dist', libName),
    // sibling dist/ directory
    resolve(dir, '../dist', libName),
    // system-level
    `/usr/local/lib/${libName}`,
  ];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  throw new Error(
    `libndts not found. Tried:\n${candidates.map(c => `  ${c}`).join('\n')}\n` +
    `Build with: make -C ndtsdb-lib cross`
  );
}

// ─── FFI singleton ──────────────────────────────────────────────────────────

let _lib: ReturnType<typeof dlopen> | null = null;
let _libc: ReturnType<typeof dlopen> | null = null;

function getLib() {
  if (_lib) return _lib;

  _lib = dlopen(findLibPath(), {
    ndtsdb_open:                 { args: [FFIType.ptr], returns: FFIType.ptr },
    ndtsdb_open_snapshot:        { args: [FFIType.ptr, FFIType.u64], returns: FFIType.ptr },
    ndtsdb_close:                { args: [FFIType.ptr], returns: FFIType.void },
    ndtsdb_insert:               { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    ndtsdb_insert_batch:         { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    ndtsdb_clear:                { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    ndtsdb_query_all_json:       { args: [FFIType.ptr], returns: FFIType.ptr },
    ndtsdb_list_symbols_json:    { args: [FFIType.ptr], returns: FFIType.ptr },
    ndtsdb_free_json:            { args: [FFIType.ptr], returns: FFIType.void },
    ndtsdb_query_all_binary:     { args: [FFIType.ptr], returns: FFIType.ptr },
    ndtsdb_binary_get_data:      { args: [FFIType.ptr], returns: FFIType.ptr },
    ndtsdb_binary_get_count:     { args: [FFIType.ptr], returns: FFIType.u32 },
    ndtsdb_binary_get_stride:    { args: [FFIType.ptr], returns: FFIType.u32 },
    ndtsdb_free_binary:          { args: [FFIType.ptr], returns: FFIType.void },
    ndtsdb_get_latest_timestamp: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i64 },
    ndtsdb_get_path:             { args: [FFIType.ptr], returns: FFIType.ptr },
  });

  return _lib;
}

/** Load libc memcpy for copying C memory to JS */
function getLibc() {
  if (_libc) return _libc;

  const libcName = platform() === 'darwin' ? 'libc.dylib' : 'libc.so.6';
  _libc = dlopen(libcName, {
    memcpy: { args: [FFIType.ptr, FFIType.ptr, FFIType.usize], returns: FFIType.ptr },
  });

  return _libc;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Convert a JS string to a null-terminated UTF-8 Uint8Array for C ptr args */
export function cstr(s: string): Uint8Array {
  return Buffer.from(s + '\0');
}

/** Read a malloc'd C string from ptr, copy to JS string, then free it */
function readAndFreeJson(ptr: number | bigint | null): string | null {
  if (!ptr) return null;
  const p = typeof ptr === 'bigint' ? Number(ptr) : ptr;
  if (!p) return null;
  const str = new CString(p).toString();
  getLib().symbols.ndtsdb_free_json(p);
  return str;
}

/** Read a non-freed C string (internal pointer, do not free) */
function readCStrPtr(ptr: number | bigint | null): string {
  if (!ptr) return '';
  const p = typeof ptr === 'bigint' ? Number(ptr) : ptr;
  if (!p) return '';
  return new CString(p).toString();
}

/** Encode a single KlineRow into a 56-byte Uint8Array (matches C struct layout) */
export function encodeKlineRow(row: KlineRow): Uint8Array {
  const buf = new ArrayBuffer(KLINE_ROW_SIZE);
  const dv = new DataView(buf);
  const ts = typeof row.timestamp === 'bigint' ? row.timestamp : BigInt(row.timestamp as any);
  dv.setBigInt64(0, ts, true);
  dv.setFloat64(8,  row.open,   true);
  dv.setFloat64(16, row.high,   true);
  dv.setFloat64(24, row.low,    true);
  dv.setFloat64(32, row.close,  true);
  dv.setFloat64(40, row.volume, true);
  dv.setUint32(48, row.flags ?? 0, true);
  // bytes 52-55: zero padding (zero-initialised by ArrayBuffer)
  return new Uint8Array(buf);
}

/** Encode an array of KlineRows into a contiguous Uint8Array */
export function encodeKlineBatch(rows: KlineRow[]): Uint8Array {
  const out = new Uint8Array(rows.length * KLINE_ROW_SIZE);
  for (let i = 0; i < rows.length; i++) {
    out.set(encodeKlineRow(rows[i]), i * KLINE_ROW_SIZE);
  }
  return out;
}

// ─── Raw FFI operations ──────────────────────────────────────────────────────

export function ffi_open(path: string): number {
  const ptr = getLib().symbols.ndtsdb_open(cstr(path));
  const n = typeof ptr === 'bigint' ? Number(ptr) : (ptr as number);
  if (!n) throw new Error(`ndtsdb_open failed for path: ${path}`);
  return n;
}

export function ffi_open_snapshot(path: string, snapshotSize = 0n): number {
  const ptr = getLib().symbols.ndtsdb_open_snapshot(cstr(path), snapshotSize);
  const n = typeof ptr === 'bigint' ? Number(ptr) : (ptr as number);
  if (!n) throw new Error(`ndtsdb_open_snapshot failed for path: ${path}`);
  return n;
}

export function ffi_close(ptr: number): void {
  getLib().symbols.ndtsdb_close(ptr);
}

export function ffi_insert(ptr: number, symbol: string, interval: string, row: KlineRow): boolean {
  const buf = encodeKlineRow(row);
  const r = getLib().symbols.ndtsdb_insert(ptr, cstr(symbol), cstr(interval), buf);
  return (r as number) === 0;
}

export function ffi_insert_batch(ptr: number, symbol: string, interval: string, rows: KlineRow[]): number {
  if (rows.length === 0) return 0;
  const buf = encodeKlineBatch(rows);
  const r = getLib().symbols.ndtsdb_insert_batch(ptr, cstr(symbol), cstr(interval), buf, rows.length);
  return r as number;
}

export function ffi_clear(ptr: number, symbol: string, interval: string): boolean {
  const r = getLib().symbols.ndtsdb_clear(ptr, cstr(symbol), cstr(interval));
  return (r as number) === 0;
}

export function ffi_query_all_json(ptr: number): string | null {
  const jsonPtr = getLib().symbols.ndtsdb_query_all_json(ptr);
  return readAndFreeJson(jsonPtr as number | bigint | null);
}

export function ffi_list_symbols_json(ptr: number): string | null {
  const jsonPtr = getLib().symbols.ndtsdb_list_symbols_json(ptr);
  return readAndFreeJson(jsonPtr as number | bigint | null);
}

export function ffi_get_latest_timestamp(ptr: number, symbol: string, interval: string): bigint {
  const ts = getLib().symbols.ndtsdb_get_latest_timestamp(ptr, cstr(symbol), cstr(interval));
  return typeof ts === 'bigint' ? ts : BigInt(ts as number);
}

export function ffi_get_path(ptr: number): string {
  const pathPtr = getLib().symbols.ndtsdb_get_path(ptr);
  return readCStrPtr(pathPtr as number | bigint | null);
}

// ─── Binary API (Phase 2) ───────────────────────────────────────────────────

/** Binary query result with data buffer and metadata */
export interface BinaryQueryResult {
  data: Uint8Array;
  count: number;
  stride: number;
}

/**
 * Read a null-terminated C string from binary buffer
 * @param buffer  The Uint8Array containing the data
 * @param offset  Starting offset
 * @param maxLen  Maximum bytes to read
 */
function readCStringFromBuffer(buffer: Uint8Array, offset: number, maxLen: number): string {
  let len = 0;
  while (len < maxLen && buffer[offset + len] !== 0) len++;
  return new TextDecoder().decode(buffer.slice(offset, offset + len));
}

/**
 * ffi_query_all_binary — Get all data in binary format (Phase 2 optimization)
 *
 * Returns raw binary buffer with fixed 128-byte rows to avoid JSON serialization
 * overhead. Much faster than ffi_query_all_json for large datasets.
 *
 * Binary row format (128 bytes per row):
 *   0-7:    timestamp (int64, ms)
 *   8-15:   open (double)
 *   16-23:  high (double)
 *   24-31:  low (double)
 *   32-39:  close (double)
 *   40-47:  volume (double)
 *   48-51:  flags (uint32)
 *   52-55:  padding
 *   56-87:  symbol (char[32])
 *   88-103: interval (char[16])
 *   104-127: reserved
 *
 * @param ptr  Database handle from ffi_open
 * @return Binary result with data buffer, or null on failure
 */
export function ffi_query_all_binary(ptr: number): BinaryQueryResult | null {
  const resultPtr = getLib().symbols.ndtsdb_query_all_binary(ptr);
  const resultNum = typeof resultPtr === 'bigint' ? Number(resultPtr) : (resultPtr as number | null);

  if (!resultNum) return null;

  // Use helper functions to extract fields
  const dataPtr = getLib().symbols.ndtsdb_binary_get_data(resultNum);
  const countVal = getLib().symbols.ndtsdb_binary_get_count(resultNum);
  const strideVal = getLib().symbols.ndtsdb_binary_get_stride(resultNum);

  // Ensure count is a number
  const count = typeof countVal === 'bigint' ? Number(countVal) : (countVal as number);
  const stride = typeof strideVal === 'bigint' ? Number(strideVal) : (strideVal as number);

  if (!dataPtr || count === 0) {
    getLib().symbols.ndtsdb_free_binary(resultNum);
    return null;
  }

  const dataPtrNum = typeof dataPtr === 'bigint' ? Number(dataPtr) : (dataPtr as number);
  const bufferSize = count * stride;

  // Create a Uint8Array to hold the binary data
  const buffer = new Uint8Array(bufferSize);

  // Copy data from C memory using memcpy
  const libc = getLibc();
  libc.symbols.memcpy(buffer, dataPtrNum, bufferSize);

  // Free the C-allocated result structure
  getLib().symbols.ndtsdb_free_binary(resultNum);

  return { data: buffer, count, stride };
}

/**
 * Parse binary query result into NDTSRow array
 *
 * Converts raw binary buffer into structured rows with proper typing
 *
 * @param result  Binary query result from ffi_query_all_binary
 * @return Array of parsed rows
 */
export function parseQueryAllBinary(result: BinaryQueryResult): NDTSRow[] {
  const rows: NDTSRow[] = [];
  const { data, count, stride } = result;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

  for (let i = 0; i < count; i++) {
    const offset = i * stride;
    const row: NDTSRow = {
      timestamp: dv.getBigInt64(offset + 0, true), // LE
      open: dv.getFloat64(offset + 8, true),
      high: dv.getFloat64(offset + 16, true),
      low: dv.getFloat64(offset + 24, true),
      close: dv.getFloat64(offset + 32, true),
      volume: dv.getFloat64(offset + 40, true),
      flags: dv.getUint32(offset + 48, true),
      symbol: readCStringFromBuffer(data, offset + 56, 32),
      interval: readCStringFromBuffer(data, offset + 88, 16),
    };
    rows.push(row);
  }

  return rows;
}

/**
 * ffi_free_binary — Release binary query result
 * @param resultPtr Pointer from ffi_query_all_binary
 */
export function ffi_free_binary(resultPtr: number): void {
  getLib().symbols.ndtsdb_free_binary(resultPtr);
}
