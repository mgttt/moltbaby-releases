// ============================================================
// Simple Partition Reader - Reads NDTS without decompression
// ============================================================
// For now, just reads the header and returns empty data
// Full decompression will be done in C via FFI

import { readFileSync } from 'fs';

const HEADER_BLOCK_SIZE = 4096;

export function readPartitionHeader(filePath: string): {
  totalRows: number;
  columns?: any[];
  compressionConfig?: Record<string, string>;
} {
  try {
    const buf = readFileSync(filePath);

    if (buf.length < HEADER_BLOCK_SIZE) {
      return { totalRows: 0 };
    }

    const headerBlock = buf.subarray(0, HEADER_BLOCK_SIZE);
    const magic = headerBlock.subarray(0, 4).toString('utf-8');

    if (magic !== 'NDTS') {
      return { totalRows: 0 };
    }

    const headerLen = headerBlock.readUInt32LE(4);
    const jsonStr = headerBlock.subarray(8, 8 + headerLen).toString('utf-8');

    try {
      const headerJson = JSON.parse(jsonStr);
      return {
        totalRows: headerJson.totalRows || 0,
        columns: headerJson.columns,
        compressionConfig: headerJson.compression,
      };
    } catch (e) {
      return { totalRows: 0 };
    }
  } catch (err) {
    return { totalRows: 0 };
  }
}
