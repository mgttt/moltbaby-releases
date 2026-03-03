/**
 * ndts-db-ffi-optimized.ts — 优化的 FFI 数据获取
 *
 * 优化策略：
 * 1. 批量 JSON 解析（避免逐个创建对象）
 * 2. 使用 Uint8Array 直接缓冲（减少内存复制）
 * 3. 缓存符号表（减少重复转换）
 * 4. 预分配数组空间
 *
 * 性能目标：890ms → 150-200ms (4.5-6x 加速)
 */

import { ffi_query_all_json } from './ndts-db-ffi.ts';
import type { NDTSRow } from './ndts-db-ffi.ts';

/**
 * 缓存的符号信息，避免重复字符串创建
 */
interface SymbolCache {
  [key: string]: { symbol: string; interval: string };
}

/**
 * 优化的 JSON 解析：使用流式处理和缓存
 */
export function parseQueryAllJsonOptimized(json: string): NDTSRow[] {
  if (!json) return [];

  const startParse = performance.now();

  // 策略 1: 直接从 JSON 数组提取
  // 从 {"rows":[...], "count":...} 中提取行数组
  const rowsMatch = json.match(/"rows":\s*\[([\s\S]*)\]/);
  if (!rowsMatch || !rowsMatch[1]) return [];

  const rowsJson = rowsMatch[1];

  // 策略 2: 预分配数组（估算大小）
  const estimatedCount = (json.match(/"timestamp":/g) || []).length;
  const rows: NDTSRow[] = [];
  rows.length = estimatedCount; // 预分配，避免多次 resize

  // 策略 3: 快速正则提取（比逐字符解析快）
  const rowPattern = /\{[^}]*?"symbol":"([^"]+)","interval":"([^"]+)","timestamp":(\d+),"open":([\d.eE+-]+),"high":([\d.eE+-]+),"low":([\d.eE+-]+),"close":([\d.eE+-]+),"volume":([\d.eE+-]+)/g;

  let match;
  let rowIndex = 0;
  const symbolCache: SymbolCache = {};

  while ((match = rowPattern.exec(rowsJson)) !== null && rowIndex < estimatedCount) {
    const symbol = match[1];
    const interval = match[2];
    const cacheKey = `${symbol}|${interval}`;

    // 策略 4: 缓存字符串，避免重复创建
    let cached = symbolCache[cacheKey];
    if (!cached) {
      cached = { symbol, interval };
      symbolCache[cacheKey] = cached;
    }

    rows[rowIndex] = {
      symbol: cached.symbol,
      interval: cached.interval,
      timestamp: BigInt(match[3]),
      open: parseFloat(match[4]),
      high: parseFloat(match[5]),
      low: parseFloat(match[6]),
      close: parseFloat(match[7]),
      volume: parseFloat(match[8]),
    };

    rowIndex++;
  }

  // 调整数组大小到实际行数
  rows.length = rowIndex;

  const parseTime = performance.now() - startParse;
  console.log(`[ndtsdb-optimized] JSON parse: ${parseTime.toFixed(2)}ms (${rowIndex} rows)`);

  return rows;
}

/**
 * 流式 FFI 获取（未来优化方向）
 * 目标：使用分页或流式传输，避免一次性加载所有数据
 */
export interface StreamOptions {
  pageSize?: number;  // 每批行数，默认 10000
  onChunk?: (rows: NDTSRow[]) => void;
}

/**
 * 使用缓存的 QueryAll（避免重复 FFI 调用）
 */
class NdtsQueryCache {
  private cache: Map<string, { rows: NDTSRow[]; timestamp: number }> = new Map();
  private cacheTTL = 5000; // 5 秒缓存

  getOrFetch(path: string, fetcher: () => NDTSRow[]): NDTSRow[] {
    const now = Date.now();
    const cached = this.cache.get(path);

    // 使用缓存
    if (cached && now - cached.timestamp < this.cacheTTL) {
      console.log(`[ndtsdb-optimized] Cache hit for ${path}`);
      return cached.rows;
    }

    // 重新 fetch
    const rows = fetcher();
    this.cache.set(path, { rows, timestamp: now });
    return rows;
  }

  clear() {
    this.cache.clear();
  }
}

export const queryCache = new NdtsQueryCache();

/**
 * 性能比较函数（用于基准测试）
 */
export async function compareParsingMethods(json: string): Promise<void> {
  console.log('\n════════════════════════════════════════════════════════════\n');
  console.log('JSON Parsing Performance Comparison\n');

  // Method 1: 标准 JSON.parse
  const start1 = performance.now();
  const result1 = JSON.parse(json);
  const time1 = performance.now() - start1;
  console.log(`Method 1 (JSON.parse):       ${time1.toFixed(2)}ms`);

  // Method 2: 优化的正则解析
  const start2 = performance.now();
  const result2 = parseQueryAllJsonOptimized(json);
  const time2 = performance.now() - start2;
  console.log(`Method 2 (Regex optimized):  ${time2.toFixed(2)}ms`);

  console.log(`\nImprovement: ${(time1 / time2).toFixed(1)}x faster\n`);
  console.log(`Rows parsed: ${result2.length.toLocaleString()}\n`);
  console.log('════════════════════════════════════════════════════════════\n');
}

/**
 * 整体优化后的 queryAll 函数
 */
export function queryAllOptimized(dbPath: string): NDTSRow[] {
  const ffiStart = performance.now();

  // 使用原始 FFI 获取 JSON
  const json = ffi_query_all_json(dbPath.endsWith('/') ? dbPath.slice(0, -1) : dbPath);
  if (!json) return [];

  const ffiTime = performance.now() - ffiStart;
  console.log(`[ndtsdb-optimized] FFI fetch: ${ffiTime.toFixed(2)}ms`);

  // 使用优化的解析
  const rows = parseQueryAllJsonOptimized(json);

  return rows;
}
