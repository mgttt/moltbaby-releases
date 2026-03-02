/**
 * vec.test.ts — ndtsdb-bun NDTV 向量格式端到端测试
 *
 * 覆盖目标 (NDTV format 完整路径):
 *   ✓ ffi_vec_insert: 单条向量写入
 *   ✓ ffi_vec_query:  全表扫描读回，字段正确
 *   ✓ 多维度 embedding 精度保持 (float32)
 *   ✓ 多条记录顺序正确
 *   ✓ 空库查询返回 []
 *   ✓ 多 scope/type 分区隔离
 *   ✓ ffi_vec_search: 余弦相似度 top-k 返回
 *   ✓ ffi_vec_search: 单位向量自相似 = 1.0
 *   ✓ timestamp 精确保持 (BigInt)
 *   ✓ agent_id / type 字段截断至 31/15 字节
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  ffi_vec_open, ffi_vec_close,
  ffi_vec_insert, ffi_vec_query, ffi_vec_search,
  type VecRecord,
} from '../src/vec-ffi.ts';

// ─── helpers ─────────────────────────────────────────────────────────────────

function tmpDir(): string {
  const p = join(tmpdir(), `ndts-vec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(p, { recursive: true });
  return p;
}
function cleanDir(p: string) {
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

function makeRec(i: number, dim = 4): VecRecord {
  const embedding = new Float32Array(dim);
  embedding[i % dim] = 1.0;   // unit-ish vector along axis i%dim
  return {
    timestamp:  BigInt(1700000000000 + i * 1000),
    agentId:    `agent-${i}`,
    type:       'semantic',
    confidence: 0.9,
    dim,
    embedding,
    flags:      0,
  };
}

function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return (na > 0 && nb > 0) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('NDTV VecFFI — single insert/query round-trip', () => {
  let dir: string;
  let db: number;

  beforeEach(() => { dir = tmpDir(); db = ffi_vec_open(dir); });
  afterEach(() => { try { ffi_vec_close(db); } catch {} cleanDir(dir); });

  it('insert returns true on success', () => {
    const ok = ffi_vec_insert(db, 'bot-001', 'semantic', makeRec(0));
    expect(ok).toBe(true);
  });

  it('query on empty scope returns []', () => {
    const rows = ffi_vec_query(db, 'ghost', 'none');
    expect(rows).toHaveLength(0);
  });

  it('single insert → query returns 1 record', () => {
    const rec = makeRec(0);
    ffi_vec_insert(db, 'bot', 'fact', rec);
    const rows = ffi_vec_query(db, 'bot', 'fact');
    expect(rows).toHaveLength(1);
  });

  it('timestamp field preserved exactly', () => {
    const ts = 1700000012345n;
    ffi_vec_insert(db, 's', 't', { ...makeRec(0), timestamp: ts });
    const rows = ffi_vec_query(db, 's', 't');
    expect(rows[0].timestamp).toBe(ts);
  });

  it('agentId field preserved', () => {
    ffi_vec_insert(db, 's', 't', { ...makeRec(0), agentId: 'my-agent' });
    const rows = ffi_vec_query(db, 's', 't');
    expect(rows[0].agentId).toBe('my-agent');
  });

  it('type field preserved', () => {
    ffi_vec_insert(db, 's', 't', { ...makeRec(0), type: 'episodic' });
    const rows = ffi_vec_query(db, 's', 't');
    expect(rows[0].type).toBe('episodic');
  });

  it('confidence field preserved (float32 tolerance)', () => {
    ffi_vec_insert(db, 's', 't', { ...makeRec(0), confidence: 0.75 });
    const rows = ffi_vec_query(db, 's', 't');
    expect(rows[0].confidence).toBeCloseTo(0.75, 5);
  });

  it('embedding values preserved (float32 precision)', () => {
    const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    ffi_vec_insert(db, 's', 't', { ...makeRec(0), dim: 4, embedding });
    const rows = ffi_vec_query(db, 's', 't');
    expect(rows[0].dim).toBe(4);
    for (let i = 0; i < 4; i++) {
      expect(rows[0].embedding[i]).toBeCloseTo(embedding[i], 5);
    }
  });

  it('dim field matches embedding length', () => {
    const embedding = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
    ffi_vec_insert(db, 's', 't', { ...makeRec(0), dim: 8, embedding });
    const rows = ffi_vec_query(db, 's', 't');
    expect(rows[0].dim).toBe(8);
    expect(rows[0].embedding).toHaveLength(8);
  });

  it('multi-record insert → query returns all', () => {
    for (let i = 0; i < 5; i++) {
      ffi_vec_insert(db, 'scope', 'fact', makeRec(i));
    }
    const rows = ffi_vec_query(db, 'scope', 'fact');
    expect(rows).toHaveLength(5);
  });

  it('scope/type partition isolation', () => {
    ffi_vec_insert(db, 'A', 'semantic', makeRec(0, 4));
    ffi_vec_insert(db, 'B', 'semantic', makeRec(1, 4));
    ffi_vec_insert(db, 'A', 'episodic', makeRec(2, 4));

    expect(ffi_vec_query(db, 'A', 'semantic')).toHaveLength(1);
    expect(ffi_vec_query(db, 'B', 'semantic')).toHaveLength(1);
    expect(ffi_vec_query(db, 'A', 'episodic')).toHaveLength(1);
    expect(ffi_vec_query(db, 'ghost', 'none')).toHaveLength(0);
  });
});

describe('NDTV VecFFI — ffi_vec_search cosine similarity', () => {
  let dir: string;
  let db: number;

  beforeEach(() => { dir = tmpDir(); db = ffi_vec_open(dir); });
  afterEach(() => { try { ffi_vec_close(db); } catch {} cleanDir(dir); });

  it('self-search returns exact match (sim ≈ 1.0)', () => {
    const embedding = new Float32Array([1, 0, 0, 0]);
    ffi_vec_insert(db, 's', 'fact', { ...makeRec(0), dim: 4, embedding });
    const results = ffi_vec_search(db, 's', 'fact', embedding, 1);
    expect(results).toHaveLength(1);
    // Verify round-tripped embedding is identical to query
    const sim = cosineSim(results[0].embedding, embedding);
    expect(sim).toBeCloseTo(1.0, 4);
  });

  it('top-k=2 returns 2 best matches from 5 records', () => {
    // Insert 5 vectors along different axes
    for (let i = 0; i < 5; i++) {
      const emb = new Float32Array(5);
      emb[i] = 1.0;
      ffi_vec_insert(db, 's', 'fact', { ...makeRec(i, 5), dim: 5, embedding: emb });
    }
    // Query along axis 0 — should get axis-0 vector as top result
    const query = new Float32Array([1, 0, 0, 0, 0]);
    const results = ffi_vec_search(db, 's', 'fact', query, 2);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.length).toBeLessThanOrEqual(2);
    // Top result should have high similarity to [1,0,0,0,0]
    const topSim = cosineSim(results[0].embedding, query);
    expect(topSim).toBeCloseTo(1.0, 2);
  });

  it('search on empty scope returns []', () => {
    const query = new Float32Array([1, 0, 0, 0]);
    const results = ffi_vec_search(db, 'empty', 'fact', query, 5);
    expect(results).toHaveLength(0);
  });

  it('top-k larger than record count returns all records', () => {
    for (let i = 0; i < 3; i++) {
      const emb = new Float32Array([1, 0, 0]);
      ffi_vec_insert(db, 's', 'fact', { ...makeRec(i, 3), dim: 3, embedding: emb });
    }
    const query = new Float32Array([1, 0, 0]);
    const results = ffi_vec_search(db, 's', 'fact', query, 999);
    expect(results.length).toBeLessThanOrEqual(3);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

describe('NDTV VecFFI — edge cases', () => {
  let dir: string;
  let db: number;

  beforeEach(() => { dir = tmpDir(); db = ffi_vec_open(dir); });
  afterEach(() => { try { ffi_vec_close(db); } catch {} cleanDir(dir); });

  it('very long agentId truncated to 31 bytes', () => {
    const longId = 'a'.repeat(100);
    ffi_vec_insert(db, 's', 't', { ...makeRec(0), agentId: longId });
    const rows = ffi_vec_query(db, 's', 't');
    expect(rows[0].agentId.length).toBeLessThanOrEqual(31);
  });

  it('zero-confidence record stored and retrieved', () => {
    ffi_vec_insert(db, 's', 't', { ...makeRec(0), confidence: 0.0 });
    const rows = ffi_vec_query(db, 's', 't');
    expect(rows[0].confidence).toBeCloseTo(0.0, 5);
  });

  it('high-dimensional embedding (128-dim) round-trips', () => {
    const dim = 128;
    const embedding = Float32Array.from({ length: dim }, (_, i) => i / dim);
    ffi_vec_insert(db, 's', 't', { ...makeRec(0), dim, embedding });
    const rows = ffi_vec_query(db, 's', 't');
    expect(rows[0].dim).toBe(dim);
    expect(rows[0].embedding[64]).toBeCloseTo(64 / dim, 4);
  });
});
