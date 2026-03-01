// ============================================================
// ndtsdb.open() — 统一数据库入口（格式自动检测）
// ============================================================
// 自动识别 C 格式（dir / 单文件）和旧 TS 分区格式，
// 返回统一的 NdtsHandle 接口，屏蔽底层差异。
//
// 格式对应关系：
//   c-dir        目录内含 YYYY-MM-DD.ndts        → NdtsDatabase (FFI)
//   c-file       单个 .ndts 文件（无压缩 C 格式）  → NdtsDatabase (FFI)
//   ts-partitioned 目录内含 klines-partitioned/  → ndts-decompress-reader
//   empty        路径不存在或空目录               → 空结果

import { existsSync, statSync, readdirSync } from 'fs';
import { join } from 'path';
import { openDatabase, type KlineRow } from './ndts-db-ffi.js';

// ─── 公共类型 ────────────────────────────────────────────────

/** 自动检测出的存储格式 */
export type NdtsFormat = 'c-dir' | 'c-file' | 'empty';

/** 过滤参数（时间范围；symbol/interval 因 KlineRow 结构暂不支持） */
export interface NdtsQueryParams {
  /** 起始时间戳（ms，含） */
  since?: number;
  /** 结束时间戳（ms，含） */
  until?: number;
  /** 最多返回行数（0 = 不限制） */
  limit?: number;
}

/** 统一数据库句柄 */
export interface NdtsHandle {
  /** 检测到的存储格式 */
  readonly format: NdtsFormat;
  /** 打开的路径 */
  readonly path: string;
  /** 返回所有行 */
  queryAll(): KlineRow[];
  /** 返回符合过滤条件的行 */
  query(params?: NdtsQueryParams): KlineRow[];
  /** 释放资源（C FFI handle / 缓存） */
  close(): void;
}

// ─── 格式检测 ────────────────────────────────────────────────

/**
 * 检测给定路径的存储格式。
 *
 * 检测顺序（优先级从高到低）：
 * 1. 路径不存在 → 'empty'
 * 2. 单文件（.ndts）→ 'c-file'
 * 3. 目录含 .ndts 文件 → 'c-dir'
 * 4. 子目录中含 .ndts 文件 → 'c-dir'（递归一层）
 * 5. 其他 → 'empty'
 */
export function detectFormat(path: string): NdtsFormat {
  if (!existsSync(path)) return 'empty';

  let s: ReturnType<typeof statSync>;
  try { s = statSync(path); } catch { return 'empty'; }

  if (!s.isDirectory()) return 'c-file';

  let entries: string[];
  try { entries = readdirSync(path); } catch { return 'empty'; }

  if (entries.some(e => e.endsWith('.ndts'))) return 'c-dir';

  // 递归一层
  for (const entry of entries) {
    const sub = join(path, entry);
    try {
      if (!statSync(sub).isDirectory()) continue;
      if (readdirSync(sub).some(e => e.endsWith('.ndts'))) return 'c-dir';
    } catch { /* skip */ }
  }

  return 'empty';
}

// ─── 统一入口 ────────────────────────────────────────────────

/**
 * 打开 NDTS 数据库，自动识别格式。
 *
 * 支持三种路径形式：
 * - 单文件：`open('./data/2024-01-15.ndts')`
 * - C 目录：`open('./data/klines/')` — 内含 YYYY-MM-DD.ndts
 * - TS 分区：`open('./data/')` — 内含 klines-partitioned/ 子目录
 *
 * @example
 * ```typescript
 * import { open } from 'ndtsdb';
 *
 * const db = open('./data/klines');
 * console.log('format:', db.format);
 *
 * const rows = db.query({ since: Date.now() - 86400_000 });
 * console.log('rows:', rows.length);
 * db.close();
 * ```
 */
export function open(path: string): NdtsHandle {
  const format = detectFormat(path);
  return createCFormatHandle(path, format);
}

// ─── C 格式 handle ───────────────────────────────────────────

function createCFormatHandle(path: string, format: NdtsFormat): NdtsHandle {
  const db = openDatabase(path);

  return {
    format,
    path,

    queryAll(): KlineRow[] {
      return db.queryAll();
    },

    query(params?: NdtsQueryParams): KlineRow[] {
      const all = db.queryAll();
      return applyFilter(all, params);
    },

    close(): void {
      db.close();
    },
  };
}

// ─── 工具函数 ────────────────────────────────────────────────

function applyFilter(rows: KlineRow[], params?: NdtsQueryParams): KlineRow[] {
  if (!params) return rows;

  let result = rows;

  if (params.since !== undefined) {
    const since = params.since;
    result = result.filter(r => r.timestamp >= since);
  }
  if (params.until !== undefined) {
    const until = params.until;
    result = result.filter(r => r.timestamp <= until);
  }
  if (params.limit && params.limit > 0) {
    result = result.slice(0, params.limit);
  }

  return result;
}
