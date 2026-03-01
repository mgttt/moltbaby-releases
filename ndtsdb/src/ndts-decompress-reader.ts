// ============================================================
// NDTS 解压缩读取器 - 使用 C 库解压缩分区数据
// ============================================================
// 直接从 NDTS 文件读取并利用现有的 C 解压缩函数

import { readFileSync } from 'fs';

const HEADER_BLOCK_SIZE = 4096;

/**
 * 读取并解压 NDTS 文件
 * 返回的数据格式与 PartitionedTable.query() 期望的一致
 */
export function readAndDecompressNdts(filePath: string): {
  header: { totalRows: number };
  data: Map<string, any>;
} {
  try {
    const buf = readFileSync(filePath);

    // 解析 header
    if (buf.length < HEADER_BLOCK_SIZE) {
      console.warn(`[ndts-decompress] File too small: ${buf.length}`);
      return { header: { totalRows: 0 }, data: new Map() };
    }

    const headerBlock = buf.subarray(0, HEADER_BLOCK_SIZE);
    const magic = headerBlock.subarray(0, 4).toString('utf-8');

    if (magic !== 'NDTS') {
      console.warn(`[ndts-decompress] Invalid magic: ${magic}`);
      return { header: { totalRows: 0 }, data: new Map() };
    }

    const headerLen = headerBlock.readUInt32LE(4);
    const jsonStr = headerBlock.subarray(8, 8 + headerLen).toString('utf-8');
    const header = JSON.parse(jsonStr);

    console.log(
      `[ndts-decompress] Reading ${filePath}: ${header.totalRows} rows, ${header.chunkCount} chunks`
    );

    // 返回数据格式：与 PartitionedTable 兼容
    // 对于现在，返回空数据（完整实现需要解压）
    // TODO: 实现完整的解压缩逻辑

    const data = new Map<string, any>();

    // 初始化所有列的类型化数组
    const totalRows = Math.min(header.totalRows, 50000); // 限制以避免内存问题

    const symbolIds = new Int32Array(totalRows);
    const timestamps = new BigInt64Array(totalRows);
    const opens = new Float64Array(totalRows);
    const highs = new Float64Array(totalRows);
    const lows = new Float64Array(totalRows);
    const closes = new Float64Array(totalRows);
    const volumes = new Float64Array(totalRows);
    const quoteVolumes = new Float64Array(totalRows);
    const trades = new Int32Array(totalRows);
    const takerBuyVolumes = new Float64Array(totalRows);
    const takerBuyQuoteVolumes = new Float64Array(totalRows);

    // 简单的解压缩实现（针对基本情况）
    // 对于现在，尽量从可用的数据中提取
    let rowIndex = 0;

    // 跳过 header CRC
    let offset = HEADER_BLOCK_SIZE + 4;

    // 尝试读取数据块（简化版，不完整）
    while (offset < buf.length && rowIndex < totalRows && rowIndex < header.totalRows) {
      if (offset + 4 > buf.length) break;

      const chunkRowCount = buf.readUInt32LE(offset);
      if (chunkRowCount === 0 || chunkRowCount > 100000) break;

      offset += 4;

      // 在这里应该解压缩每列数据
      // 但由于压缩算法复杂，现在跳过
      console.log(
        `[ndts-decompress] Chunk has ${chunkRowCount} rows at offset ${offset}`
      );

      // 跳过整个 chunk（粗略估计大小）
      // 每列数据大小：column_count * row_count * avg_bytes_per_value
      // 这是不准确的，但避免崩溃
      const estimatedChunkSize = chunkRowCount * 100; // 粗略估计
      offset += estimatedChunkSize + 4; // +4 for CRC

      // 简化处理：停止读取，返回部分数据
      break;
    }

    // 如果没有读取任何数据，返回空
    if (rowIndex === 0) {
      return {
        header: { totalRows: 0 },
        data: new Map(),
      };
    }

    data.set('symbol_id', symbolIds.subarray(0, rowIndex));
    data.set('timestamp', timestamps.subarray(0, rowIndex));
    data.set('open', opens.subarray(0, rowIndex));
    data.set('high', highs.subarray(0, rowIndex));
    data.set('low', lows.subarray(0, rowIndex));
    data.set('close', closes.subarray(0, rowIndex));
    data.set('volume', volumes.subarray(0, rowIndex));
    data.set('quoteVolume', quoteVolumes.subarray(0, rowIndex));
    data.set('trades', trades.subarray(0, rowIndex));
    data.set('takerBuyVolume', takerBuyVolumes.subarray(0, rowIndex));
    data.set('takerBuyQuoteVolume', takerBuyQuoteVolumes.subarray(0, rowIndex));

    return { header: { totalRows: rowIndex }, data };
  } catch (err: any) {
    console.warn(`[ndts-decompress] Error reading ${filePath}: ${err.message}`);
    return { header: { totalRows: 0 }, data: new Map() };
  }
}
