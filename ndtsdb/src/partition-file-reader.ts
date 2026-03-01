// ============================================================
// 分区文件直接读取器 - 不依赖 C 库
// ============================================================
// 直接读取 NDTS 格式分区文件，实现基本的解压

import { readFileSync } from 'fs';

const HEADER_BLOCK_SIZE = 4096;

export interface PartitionData {
  symbol: string;
  interval: string;
  totalRows: number;
  columns: Array<{ name: string; type: string }>;
  rows: Array<{
    symbol_id?: number;
    timestamp?: number;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    volume?: number;
    trades?: number;
    quoteVolume?: number;
    takerBuyVolume?: number;
    takerBuyQuoteVolume?: number;
  }>;
}

/**
 * 简单的 delta 解码器 - 用于 int32/int64 列
 */
function deltaDecodeInt64(deltas: BigInt64Array): BigInt64Array {
  if (deltas.length === 0) return new BigInt64Array(0);

  const result = new BigInt64Array(deltas.length);
  let base = deltas[0];
  result[0] = base;

  for (let i = 1; i < deltas.length; i++) {
    base = base + deltas[i];
    result[i] = base;
  }

  return result;
}

/**
 * 读取分区文件头部信息
 */
export function readPartitionFileHeader(filePath: string): {
  totalRows: number;
  columns: Array<{ name: string; type: string }>;
  symbol?: string;
  interval?: string;
} {
  try {
    const buf = readFileSync(filePath);

    if (buf.length < 8) {
      return { totalRows: 0, columns: [] };
    }

    const magic = buf.subarray(0, 4).toString('utf-8');

    if (magic === 'NDTS') {
      // 新版格式: NDTS(4) + headerLen(4) + JSON(headerLen) + padding
      const headerLen = buf.readUInt32LE(4);
      if (8 + headerLen > buf.length) {
        return { totalRows: 0, columns: [] };
      }
      const jsonStr = buf.subarray(8, 8 + headerLen).toString('utf-8');
      try {
        const headerJson = JSON.parse(jsonStr);
        return {
          totalRows: headerJson.totalRows || 0,
          columns: headerJson.columns || [],
          symbol: headerJson.symbol,
          interval: headerJson.interval,
        };
      } catch (e) {
        return { totalRows: 0, columns: [] };
      }
    } else {
      // 旧版格式: headerLen(4, LE) + JSON(headerLen)
      // magic 字节实际上是 headerLen 的低4字节
      const headerLen = buf.readUInt32LE(0);
      if (4 + headerLen > buf.length) {
        return { totalRows: 0, columns: [] };
      }
      const jsonStr = buf.subarray(4, 4 + headerLen).toString('utf-8');
      try {
        const headerJson = JSON.parse(jsonStr);
        // 旧版 header 字段名: rowCount
        const totalRows = headerJson.totalRows ?? headerJson.rowCount ?? 0;
        return {
          totalRows,
          columns: headerJson.columns || [],
          symbol: headerJson.symbol,
          interval: headerJson.interval,
        };
      } catch (e) {
        return { totalRows: 0, columns: [] };
      }
    }
  } catch (err) {
    return { totalRows: 0, columns: [] };
  }
}

/**
 * 读取分区文件数据（返回行数组）
 * 简化实现：尽力读取可用数据，忽略复杂压缩
 */
export function readPartitionFile(filePath: string): PartitionData {
  const header = readPartitionFileHeader(filePath);

  const result: PartitionData = {
    symbol: header.symbol || 'UNKNOWN',
    interval: header.interval || 'UNKNOWN',
    totalRows: header.totalRows,
    columns: header.columns,
    rows: [],
  };

  if (header.totalRows === 0) {
    return result;
  }

  // 注意：此处不生成合成数据。
  // 实际数据解压需要通过 FFI (readPartitionFileFFI) 或 ndtsdb-cli subprocess 进行。
  // 此函数仅返回 header 元信息（totalRows 等），rows 保持为空。
  // 调用方应使用 readPartitionFileFFI 或 ndtsdb-cli 获取真实数据。

  return result;
}

/**
 * 批量读取目录中的所有分区文件
 */
export function readPartitionDirectory(
  dirPath: string
): Array<{ path: string; totalRows: number }> {
  try {
    const { readdirSync } = require('fs');
    const { join } = require('path');

    const files = readdirSync(dirPath).filter((f: string) => f.endsWith('.ndts'));
    const results = [];

    for (const file of files) {
      const filePath = join(dirPath, file);
      const header = readPartitionFileHeader(filePath);

      if (header.totalRows > 0) {
        results.push({
          path: filePath,
          totalRows: header.totalRows,
        });
      }
    }

    return results;
  } catch (err) {
    return [];
  }
}

/**
 * 计算目录中所有分区文件的总行数
 */
export function getTotalRowsInPartitionDir(dirPath: string): number {
  const files = readPartitionDirectory(dirPath);
  return files.reduce((sum, f) => sum + f.totalRows, 0);
}
