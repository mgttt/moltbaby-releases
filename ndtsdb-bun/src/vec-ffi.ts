/**
 * vec-ffi.ts — Bun FFI bindings for ndtsdb NDTV vector format
 *
 * VecRecord struct layout (80 bytes, matches ndtsdb_vec.h):
 *   offset  0: int64_t  timestamp       (8 bytes LE)
 *   offset  8: char     agent_id[32]    (32 bytes)
 *   offset 40: char     type[16]        (16 bytes)
 *   offset 56: float    confidence      (4 bytes)
 *   offset 60: uint16_t embedding_dim   (2 bytes)
 *   offset 62: padding                  (2 bytes)
 *   offset 64: float*   embedding       (8 bytes, raw pointer)
 *   offset 72: uint32_t flags           (4 bytes)
 *   offset 76: padding                  (4 bytes)
 *
 * VecQueryResult struct layout (16 bytes):
 *   offset  0: VecRecord* records       (8 bytes, raw pointer)
 *   offset  8: uint32_t   count         (4 bytes)
 *   offset 12: padding                  (4 bytes)
 */
import { dlopen, FFIType, CString, ptr, toArrayBuffer } from 'bun:ffi';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { arch, platform } from 'os';

// ─── Re-use the same library instance as ndts-db-ffi ────────────────────────
// We extend the lib with vector symbols rather than opening a second dlopen.

export interface VecRecord {
  timestamp: bigint;
  agentId:   string;
  type:      string;
  confidence: number;
  dim:        number;
  embedding:  Float32Array;
  flags:      number;
}

const VEC_RECORD_SIZE = 80;

function findLibPath(): string {
  const dir = import.meta.dir;
  const p = platform();
  const a = arch();
  const libName = (() => {
    if (p === 'linux'  && a === 'x64')   return 'libndts-lnx-x86-64.so';
    if (p === 'linux'  && a === 'arm64') return 'libndts-lnx-arm-64.so';
    if (p === 'darwin' && a === 'x64')   return 'libndts-osx-x86-64.dylib';
    if (p === 'darwin' && a === 'arm64') return 'libndts-osx-arm-64.dylib';
    throw new Error(`Unsupported platform: ${p}/${a}`);
  })();
  const candidates = [
    resolve(dir, '../../ndtsdb-lib/native/dist', libName),
    resolve(dir, '../lib', libName),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`libndts not found. Tried:\n${candidates.join('\n')}`);
}

let _vecLib: ReturnType<typeof dlopen> | null = null;

function getVecLib() {
  if (_vecLib) return _vecLib;
  _vecLib = dlopen(findLibPath(), {
    ndtsdb_open:             { args: [FFIType.ptr], returns: FFIType.ptr },
    ndtsdb_close:            { args: [FFIType.ptr], returns: FFIType.void },
    ndtsdb_vec_insert:       { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    ndtsdb_vec_query:        { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    ndtsdb_vec_free_result:  { args: [FFIType.ptr], returns: FFIType.void },
    ndtsdb_vec_search:       { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
  });
  return _vecLib;
}

function cstr(s: string): Uint8Array {
  return Buffer.from(s + '\0');
}

// ─── Struct encoding ─────────────────────────────────────────────────────────

function encodeVecRecord(rec: VecRecord): { struct: Uint8Array; embBuf: Float32Array } {
  const struct = new Uint8Array(VEC_RECORD_SIZE);
  const dv = new DataView(struct.buffer);

  // timestamp @ 0
  dv.setBigInt64(0, rec.timestamp, true);

  // agent_id @ 8 (31 chars + NUL)
  const aid = rec.agentId.slice(0, 31);
  for (let i = 0; i < aid.length; i++) struct[8 + i] = aid.charCodeAt(i);

  // type @ 40 (15 chars + NUL)
  const typ = rec.type.slice(0, 15);
  for (let i = 0; i < typ.length; i++) struct[40 + i] = typ.charCodeAt(i);

  // confidence @ 56
  dv.setFloat32(56, rec.confidence, true);

  // embedding_dim @ 60
  dv.setUint16(60, rec.dim, true);

  // embedding pointer @ 64 — must stay alive for the duration of the call
  const embBuf = new Float32Array(rec.embedding);
  const embPtr = BigInt(ptr(embBuf));
  dv.setBigUint64(64, embPtr, true);

  // flags @ 72
  dv.setUint32(72, rec.flags ?? 0, true);

  return { struct, embBuf };
}

// ─── VecQueryResult reading ──────────────────────────────────────────────────

function decodeVecQueryResult(resultPtr: number): VecRecord[] {
  if (!resultPtr) return [];

  const resBuf = toArrayBuffer(resultPtr, 0, 16);
  const resDv = new DataView(resBuf);

  const recordsPtr = Number(resDv.getBigUint64(0, true));
  const count      = resDv.getUint32(8, true);

  if (!recordsPtr || count === 0) return [];

  const out: VecRecord[] = [];
  for (let i = 0; i < count; i++) {
    const recBase = recordsPtr + i * VEC_RECORD_SIZE;
    const recBuf  = toArrayBuffer(recBase, 0, VEC_RECORD_SIZE);
    const dv      = new DataView(recBuf);

    const ts       = dv.getBigInt64(0, true);
    const agentId  = new CString(recBase + 8).toString();
    const type     = new CString(recBase + 40).toString();
    const conf     = dv.getFloat32(56, true);
    const dim      = dv.getUint16(60, true);
    const embPtrN  = Number(dv.getBigUint64(64, true));
    const flags    = dv.getUint32(72, true);

    let embedding = new Float32Array(0);
    if (embPtrN && dim > 0) {
      const embBuf = toArrayBuffer(embPtrN, 0, dim * 4);
      embedding = new Float32Array(embBuf.slice(0)); // copy out before free
    }

    out.push({ timestamp: ts, agentId, type, confidence: conf, dim, embedding, flags });
  }
  return out;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function ffi_vec_open(path: string): number {
  const p = getVecLib().symbols.ndtsdb_open(cstr(path));
  const n = typeof p === 'bigint' ? Number(p) : (p as number);
  if (!n) throw new Error(`ndtsdb_open failed: ${path}`);
  return n;
}

export function ffi_vec_close(db: number): void {
  getVecLib().symbols.ndtsdb_close(db);
}

export function ffi_vec_insert(
  db: number,
  symbol: string,
  interval: string,
  rec: VecRecord,
): boolean {
  const { struct, embBuf } = encodeVecRecord(rec);
  const r = getVecLib().symbols.ndtsdb_vec_insert(db, cstr(symbol), cstr(interval), struct);
  void embBuf; // keep alive
  return (typeof r === 'bigint' ? Number(r) : (r as number)) === 0;
}

export function ffi_vec_query(db: number, symbol: string, interval: string): VecRecord[] {
  const resPtr = getVecLib().symbols.ndtsdb_vec_query(db, cstr(symbol), cstr(interval));
  const n = typeof resPtr === 'bigint' ? Number(resPtr) : (resPtr as number);
  if (!n) return [];
  const records = decodeVecQueryResult(n);
  getVecLib().symbols.ndtsdb_vec_free_result(n);
  return records;
}

export function ffi_vec_search(
  db: number,
  symbol: string,
  interval: string,
  query: Float32Array,
  topK: number,
): VecRecord[] {
  const resPtr = getVecLib().symbols.ndtsdb_vec_search(
    db, cstr(symbol), cstr(interval), query, query.length, topK, null,
  );
  const n = typeof resPtr === 'bigint' ? Number(resPtr) : (resPtr as number);
  if (!n) return [];
  const records = decodeVecQueryResult(n);
  getVecLib().symbols.ndtsdb_vec_free_result(n);
  return records;
}
