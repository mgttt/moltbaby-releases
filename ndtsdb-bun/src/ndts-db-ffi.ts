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
    ndtsdb_get_latest_timestamp: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i64 },
    ndtsdb_get_path:             { args: [FFIType.ptr], returns: FFIType.ptr },
  });

  return _lib;
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
