// ============================================================
// ndtsdb-vec FFI 绑定 — 向量存储与 HNSW 近似最近邻搜索
//
// C 结构体对齐（x86-64 / arm64）：
//
// VecRecord (80 bytes):
//   offset  0  int64_t  timestamp       (8 bytes)
//   offset  8  char[32] agent_id        (32 bytes)
//   offset 40  char[16] type            (16 bytes)
//   offset 56  float    confidence      (4 bytes)
//   offset 60  uint16_t embedding_dim   (2 bytes)
//   offset 62  uint8_t  _pad[2]         (2 bytes padding → 64-byte align for ptr)
//   offset 64  float*   embedding       (8 bytes pointer)
//   offset 72  uint32_t flags           (4 bytes)
//   offset 76  uint8_t  _pad2[4]        (4 bytes → align to 8)
//   sizeof = 80
//
// VecQueryResult (16 bytes):
//   offset  0  VecRecord* records       (8 bytes pointer)
//   offset  8  uint32_t   count         (4 bytes)
//   offset 12  uint8_t    _pad[4]       (4 bytes)
//   sizeof = 16
//
// ============================================================

import { dlopen, FFIType, ptr, CString, toArrayBuffer } from 'bun:ffi';
import { existsSync } from 'fs';
import { dirname, join } from 'path';

// ─── 类型 ────────────────────────────────────────────────────────────────

export interface VecRecord {
  timestamp: number;
  agentId: string;
  type: string;
  confidence: number;
  embedding: Float32Array;
  flags?: number;
}

export interface VecSearchResult extends VecRecord {
  score?: number;
}

// ─── 库加载（复用 ndts-db-ffi 的同一 .so）─────────────────────────────

function findLibrary(): string {
  const platform = process.platform;
  const arch = process.arch;
  const os = platform === 'darwin' ? 'osx' : platform === 'win32' ? 'win' : 'lnx';
  const cpu = arch === 'arm64' || arch === 'arm' ? 'arm' : 'x86';
  const bits = arch === 'arm64' || arch === 'x64' ? '64' : '32';
  const ext = platform === 'darwin' ? 'dylib' : platform === 'win32' ? 'dll' : 'so';
  const libName = `libndts-${os}-${cpu}-${bits}.${ext}`;

  const candidates = [
    join(dirname(import.meta.path), '../../ndtsdb-lib/native/dist', libName),
    join(dirname(import.meta.path), '../native/dist', libName),
    join(process.cwd(), 'native/dist', libName),
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(`[ndtsdb-vec] libndts not found: ${libName}`);
}

let vecLib: ReturnType<typeof dlopen> | null = null;

function initVecLib(): void {
  if (vecLib) return;
  const libPath = findLibrary();
  vecLib = dlopen(libPath, {
    ndtsdb_vec_insert: {
      args: [FFIType.ptr, FFIType.cstring, FFIType.cstring, FFIType.ptr],
      returns: FFIType.i32,
    },
    ndtsdb_vec_query: {
      args: [FFIType.ptr, FFIType.cstring, FFIType.cstring],
      returns: FFIType.ptr,
    },
    ndtsdb_vec_search: {
      args: [FFIType.ptr, FFIType.cstring, FFIType.cstring, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.ptr],
      returns: FFIType.ptr,
    },
    ndtsdb_vec_free_result: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
    ndtsdb_vec_build_index: {
      args: [FFIType.ptr, FFIType.cstring, FFIType.cstring, FFIType.ptr],
      returns: FFIType.i32,
    },
    ndtsdb_vec_has_index: {
      args: [FFIType.ptr, FFIType.cstring, FFIType.cstring],
      returns: FFIType.i32,
    },
  });
  console.log('[ndtsdb-vec] FFI initialized');
}

// ─── 结构体序列化 ────────────────────────────────────────────────────────

const VEC_RECORD_SIZE = 80;

function buildVecRecordBuf(
  timestamp: number,
  agentId: string,
  type: string,
  confidence: number,
  embedding: Float32Array,
  embeddingBuf: Buffer,  // must remain alive during FFI call
  flags = 0,
): Buffer {
  const buf = Buffer.alloc(VEC_RECORD_SIZE, 0);
  buf.writeBigInt64LE(BigInt(timestamp), 0);

  // agent_id: 32 bytes, null-terminated
  buf.write(agentId.slice(0, 31), 8, 'utf8');

  // type: 16 bytes, null-terminated
  buf.write(type.slice(0, 15), 40, 'utf8');

  // confidence: float32
  buf.writeFloatLE(confidence, 56);

  // embedding_dim: uint16
  buf.writeUInt16LE(embedding.length, 60);
  // _pad[2] at 62 — already zero

  // embedding pointer at offset 64
  const embPtr = BigInt(ptr(embeddingBuf));
  buf.writeBigUInt64LE(embPtr, 64);

  // flags at offset 72
  buf.writeUInt32LE(flags, 72);
  // _pad[4] at 76 — already zero

  return buf;
}

// ─── VecQueryResult 反序列化 ─────────────────────────────────────────────

const VEC_QUERY_RESULT_SIZE = 16;
// VecRecord pointer at offset 0, count at offset 8

function parseVecQueryResult(resultPtr: bigint | number): VecRecord[] {
  // #94: resultPtr 有效性检查
  if (!resultPtr) return [];
  const ptrNum = Number(resultPtr);
  if (!Number.isFinite(ptrNum) || ptrNum === 0) return [];

  try {
    const resultBuf = toArrayBuffer(ptrNum as any, 0, VEC_QUERY_RESULT_SIZE);
    const resultView = new DataView(resultBuf);

    const recordsPtr = resultView.getBigUint64(0, true);
    const count = resultView.getUint32(8, true);

    // #94: count 合理性上限（防 C 层返回垃圾值导致 OOM）
    if (!recordsPtr || count === 0 || count > 1_000_000) return [];

    const results: VecRecord[] = [];

    for (let i = 0; i < count; i++) {
      const recPtr = Number(recordsPtr) + i * VEC_RECORD_SIZE;
      if (recPtr === 0) continue;

      const recBuf = toArrayBuffer(recPtr as any, 0, VEC_RECORD_SIZE);
      const recView = new DataView(recBuf);

      const timestamp = Number(recView.getBigInt64(0, true));

      // agent_id: 32 bytes at offset 8
      const agentIdRaw = new Uint8Array(recBuf, 8, 32);
      const agentIdEnd = agentIdRaw.indexOf(0);
      const agentId = Buffer.from(agentIdRaw.slice(0, agentIdEnd < 0 ? 32 : agentIdEnd)).toString('utf8');

      // type: 16 bytes at offset 40
      const typeRaw = new Uint8Array(recBuf, 40, 16);
      const typeEnd = typeRaw.indexOf(0);
      const type = Buffer.from(typeRaw.slice(0, typeEnd < 0 ? 16 : typeEnd)).toString('utf8');

      const confidence = recView.getFloat32(56, true);
      const embeddingDim = recView.getUint16(60, true);
      const embeddingPtr = recView.getBigUint64(64, true);
      const flags = recView.getUint32(72, true);

      // #94: embeddingDim 上限 + embeddingPtr 非零检查
      let embedding = new Float32Array(0);
      if (embeddingPtr && embeddingDim > 0 && embeddingDim <= 65536) {
        const embBuf = toArrayBuffer(Number(embeddingPtr) as any, 0, embeddingDim * 4);
        embedding = new Float32Array(embBuf.slice(0));
      }

      results.push({ timestamp, agentId, type, confidence, embedding, flags });
    }

    return results;
  } catch (err) {
    // #94: 捕获任何来自 C 内存的非法访问，避免 Bun 崩溃
    console.error('[ndtsdb-vec] parseVecQueryResult error (invalid C pointer?):', err);
    return [];
  }
}

// ─── NdtsVecDatabase ─────────────────────────────────────────────────────

export class NdtsVecDatabase {
  private dbHandle: bigint;

  /**
   * @param dbHandle — bigint handle from NdtsDatabase (通过 db['handle'] 获取，
   *                    或直接将 NdtsDatabase 传入后调用 getHandle())
   */
  constructor(dbHandle: bigint) {
    this.dbHandle = dbHandle;
    initVecLib();
  }

  insertVector(
    symbol: string,
    interval: string,
    record: VecRecord,
  ): void {
    if (!vecLib) throw new Error('[ndtsdb-vec] Library not initialized');

    const symBuf = Buffer.from(symbol + '\0');
    const intBuf = Buffer.from(interval + '\0');

    // Float32Array → Buffer (keep alive during FFI call)
    const embeddingBuf = Buffer.from(record.embedding.buffer);

    const recBuf = buildVecRecordBuf(
      record.timestamp,
      record.agentId,
      record.type,
      record.confidence,
      record.embedding,
      embeddingBuf,
      record.flags ?? 0,
    );

    const rc = vecLib.symbols.ndtsdb_vec_insert(
      this.dbHandle,
      ptr(symBuf),
      ptr(intBuf),
      ptr(recBuf),
    ) as number;

    if (rc !== 0) {
      throw new Error(`[ndtsdb-vec] insertVector failed for ${symbol}/${interval} (rc=${rc})`);
    }
  }

  queryVectors(symbol: string, interval: string): VecRecord[] {
    if (!vecLib) throw new Error('[ndtsdb-vec] Library not initialized');

    const symBuf = Buffer.from(symbol + '\0');
    const intBuf = Buffer.from(interval + '\0');

    const resultPtr = vecLib.symbols.ndtsdb_vec_query(
      this.dbHandle,
      ptr(symBuf),
      ptr(intBuf),
    ) as bigint | number;

    if (!resultPtr) return [];

    const results = parseVecQueryResult(resultPtr);

    try {
      vecLib.symbols.ndtsdb_vec_free_result(resultPtr);
    } catch { /* best-effort */ }

    return results;
  }

  searchVectors(
    symbol: string,
    interval: string,
    queryVec: Float32Array,
    topK = 10,
    config?: { M?: number; efConstruction?: number; efSearch?: number },
  ): VecRecord[] {
    if (!vecLib) throw new Error('[ndtsdb-vec] Library not initialized');

    const symBuf = Buffer.from(symbol + '\0');
    const intBuf = Buffer.from(interval + '\0');

    // query vector buffer (must stay alive during call)
    const queryBuf = Buffer.from(queryVec.buffer);

    // HNSW config struct: { int M; int ef_construction; int ef_search; } = 12 bytes
    let configPtr: number | bigint | null = null;
    let configBuf: Buffer | null = null;
    if (config) {
      configBuf = Buffer.alloc(12, 0);
      configBuf.writeInt32LE(config.M ?? 16, 0);
      configBuf.writeInt32LE(config.efConstruction ?? 200, 4);
      configBuf.writeInt32LE(config.efSearch ?? 50, 8);
      configPtr = ptr(configBuf);
    }

    const resultPtr = vecLib.symbols.ndtsdb_vec_search(
      this.dbHandle,
      ptr(symBuf),
      ptr(intBuf),
      ptr(queryBuf),
      queryVec.length,
      topK,
      configPtr,
    ) as bigint | number;

    if (!resultPtr) return [];

    const results = parseVecQueryResult(resultPtr);

    try {
      vecLib.symbols.ndtsdb_vec_free_result(resultPtr);
    } catch { /* best-effort */ }

    return results;
  }

  buildIndex(
    symbol: string,
    interval: string,
    config?: { M?: number; efConstruction?: number; efSearch?: number },
  ): void {
    if (!vecLib) throw new Error('[ndtsdb-vec] Library not initialized');

    const symBuf = Buffer.from(symbol + '\0');
    const intBuf = Buffer.from(interval + '\0');

    let configPtr: number | bigint | null = null;
    let configBuf: Buffer | null = null;
    if (config) {
      configBuf = Buffer.alloc(12, 0);
      configBuf.writeInt32LE(config.M ?? 16, 0);
      configBuf.writeInt32LE(config.efConstruction ?? 200, 4);
      configBuf.writeInt32LE(config.efSearch ?? 50, 8);
      configPtr = ptr(configBuf);
    }

    const rc = vecLib.symbols.ndtsdb_vec_build_index(
      this.dbHandle,
      ptr(symBuf),
      ptr(intBuf),
      configPtr,
    ) as number;

    if (rc !== 0) {
      throw new Error(`[ndtsdb-vec] buildIndex failed for ${symbol}/${interval} (rc=${rc})`);
    }
  }

  hasIndex(symbol: string, interval: string): boolean {
    if (!vecLib) throw new Error('[ndtsdb-vec] Library not initialized');

    const symBuf = Buffer.from(symbol + '\0');
    const intBuf = Buffer.from(interval + '\0');

    return (vecLib.symbols.ndtsdb_vec_has_index(
      this.dbHandle,
      ptr(symBuf),
      ptr(intBuf),
    ) as number) === 1;
  }
}
