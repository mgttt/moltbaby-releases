// ============================================================
// NDTS 分区文件读取器 - 通过 symbol 枚举和 ndtsdb-cli
// ============================================================
// 对于 bucket 分区文件（含多个 symbol），通过以下方式读取：
// 1. 列出数据库中的所有 symbol
// 2. 为每个 symbol 调用 ndtsdb-cli export
// 3. 合并所有数据

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface PartitionData {
  header: {
    totalRows: number;
    columns?: any[];
  };
  data: Map<string, any>;
}

/**
 * 通过 ndtsdb-cli 读取分区文件数据
 * 对于 bucket 文件，我们需要：
 * 1. 找到所有 symbol
 * 2. 对每个 symbol 导出数据
 * 3. 合并结果
 */
/**
 * 通过直接读取分区文件来获取数据
 * 分区文件包含多个 symbol 的混合数据，可以直接读取
 */
export function readPartitionViaSymbols(bucketPath: string, dbPath: string): PartitionData {
  // 直接使用二进制读取器读取分区文件
  try {
    const { readNdtsBinaryFile } = require('./ndts-binary-reader.js');
    const fileData = readNdtsBinaryFile(bucketPath);

    // 直接返回文件中的所有数据
    return {
      header: fileData.header,
      data: fileData.data,
    };
  } catch (err: any) {
    throw new Error(`Failed to read partition file: ${err.message}`);
  }

