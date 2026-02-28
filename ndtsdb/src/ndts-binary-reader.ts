// ============================================================
// NDTS 二进制文件直接读取器
// ============================================================
// 格式（基于 ndtsdb-cli/ndts.c）:
// 1. Header Block: 4096 bytes (magic + header_len + json + padding)
// 2. Header CRC32: 4 bytes
// 3. Data Chunks:
//    - row_count: u32
//    - symbol_ids: int32[]
//    - interval_ids: int32[]
//    - timestamps: int64[]
//    - open: float64[]
//    - high: float64[]
//    - low: float64[]
//    - close: float64[]
//    - volume: float64[]
//    - (optional more columns)
// 4. Chunk CRC32: 4 bytes

import { readFileSync } from 'fs';

export interface NdtsFileData {
  header: {
    totalRows: number;
    columns: Array<{ name: string; type: string }>;
  };
  data: Map<string, any>;
}

const HEADER_BLOCK_SIZE = 4096;

/**
 * 读取 NDTS 二进制文件
 */
export function readNdtsBinaryFile(filePath: string): NdtsFileData {
  const fileBuffer = readFileSync(filePath);
  let offset = 0;

  // 1. 读取 4096 字节的 header block
  if (fileBuffer.length < HEADER_BLOCK_SIZE) {
    throw new Error(`File too small: ${fileBuffer.length} < ${HEADER_BLOCK_SIZE}`);
  }

  const headerBlock = fileBuffer.subarray(0, HEADER_BLOCK_SIZE);
  offset = HEADER_BLOCK_SIZE;

  // 验证 magic
  const magic = headerBlock.subarray(0, 4).toString('utf-8');
  if (magic !== 'NDTS') {
    throw new Error(`Invalid magic: ${magic}`);
  }

  // 读取 header 长度
  const headerLen = headerBlock.readUInt32LE(4);
  if (headerLen > HEADER_BLOCK_SIZE - 8) {
    throw new Error(`Header too long: ${headerLen}`);
  }

  // 解析 JSON
  const jsonStr = headerBlock.subarray(8, 8 + headerLen).toString('utf-8');
  const header = JSON.parse(jsonStr);

  console.log(`[ndts-reader] File: totalRows=${header.totalRows}, chunks=${header.chunkCount}`);

  // 2. 跳过 header CRC32
  offset += 4;

  // 3. 读取数据块
  const totalRows = header.totalRows;

  // 初始化列数据
  const columnNames = header.columns.map((c: any) => c.name);
  const data = new Map<string, any>();

  // 预分配数组
  const symbolIds = new Int32Array(totalRows);
  const intervalIds = new Int32Array(totalRows);
  const timestamps = new BigInt64Array(totalRows);
  const opens = new Float64Array(totalRows);
  const highs = new Float64Array(totalRows);
  const lows = new Float64Array(totalRows);
  const closes = new Float64Array(totalRows);
  const volumes = new Float64Array(totalRows);

  // 用于字典解码的变量
  const symbolDict = header.stringDicts?.symbol || [];
  const intervalDict = header.stringDicts?.interval || [];

  let rowIndex = 0;

  // 4. 读取所有数据块
  for (let chunkIdx = 0; chunkIdx < header.chunkCount && offset < fileBuffer.length && rowIndex < totalRows; chunkIdx++) {
    // 读取 row_count
    if (offset + 4 > fileBuffer.length) break;

    const rowCount = fileBuffer.readUInt32LE(offset);
    offset += 4;

    if (rowCount === 0 || rowCount > 100000) {
      // 数据损坏或错误的行数，停止读取
      console.warn(`[ndts-reader] Suspicious row count at chunk ${chunkIdx}: ${rowCount}`);
      break;
    }

    console.log(`[ndts-reader] Reading chunk ${chunkIdx}: rowCount=${rowCount}, offset=${offset}`);

    // 每列的数据大小
    const colDataSizes: { [key: string]: number } = {
      symbol_id: 4 * rowCount,
      interval_id: 4 * rowCount,
      timestamp: 8 * rowCount,
      open: 8 * rowCount,
      high: 8 * rowCount,
      low: 8 * rowCount,
      close: 8 * rowCount,
      volume: 8 * rowCount,
      quoteVolume: 8 * rowCount,
      trades: 4 * rowCount,
      takerBuyVolume: 8 * rowCount,
      takerBuyQuoteVolume: 8 * rowCount,
    };

    // 计算总的 chunk data 大小（不包括 CRC）
    let totalChunkDataSize = 0;
    for (const colName of columnNames) {
      totalChunkDataSize += colDataSizes[colName] || 0;
    }

    const chunkDataStart = offset;

    // 读取 symbol_id (int32)
    for (let i = 0; i < rowCount && rowIndex + i < totalRows; i++) {
      if (offset + 4 > fileBuffer.length) {
        console.warn(`[ndts-reader] Buffer overrun at symbol_id`);
        break;
      }
      symbolIds[rowIndex + i] = fileBuffer.readInt32LE(offset);
      offset += 4;
    }

    // 读取 interval_id (int32)
    for (let i = 0; i < rowCount && rowIndex + i < totalRows; i++) {
      if (offset + 4 > fileBuffer.length) break;
      intervalIds[rowIndex + i] = fileBuffer.readInt32LE(offset);
      offset += 4;
    }

    // 读取 timestamp (int64)
    for (let i = 0; i < rowCount && rowIndex + i < totalRows; i++) {
      if (offset + 8 > fileBuffer.length) break;
      timestamps[rowIndex + i] = fileBuffer.readBigInt64LE(offset);
      offset += 8;
    }

    // 读取 open (float64)
    for (let i = 0; i < rowCount && rowIndex + i < totalRows; i++) {
      if (offset + 8 > fileBuffer.length) break;
      opens[rowIndex + i] = fileBuffer.readDoubleLE(offset);
      offset += 8;
    }

    // 读取 high (float64)
    for (let i = 0; i < rowCount && rowIndex + i < totalRows; i++) {
      if (offset + 8 > fileBuffer.length) break;
      highs[rowIndex + i] = fileBuffer.readDoubleLE(offset);
      offset += 8;
    }

    // 读取 low (float64)
    for (let i = 0; i < rowCount && rowIndex + i < totalRows; i++) {
      if (offset + 8 > fileBuffer.length) break;
      lows[rowIndex + i] = fileBuffer.readDoubleLE(offset);
      offset += 8;
    }

    // 读取 close (float64)
    for (let i = 0; i < rowCount && rowIndex + i < totalRows; i++) {
      if (offset + 8 > fileBuffer.length) break;
      closes[rowIndex + i] = fileBuffer.readDoubleLE(offset);
      offset += 8;
    }

    // 读取 volume (float64)
    for (let i = 0; i < rowCount && rowIndex + i < totalRows; i++) {
      if (offset + 8 > fileBuffer.length) break;
      volumes[rowIndex + i] = fileBuffer.readDoubleLE(offset);
      offset += 8;
    }

    // 跳过其他列（quoteVolume, trades, takerBuyVolume, takerBuyQuoteVolume）
    const extraCols = header.columns.length - 8;
    if (extraCols > 0) {
      // quoteVolume (float64)
      offset += 8 * rowCount;
      // trades (int32)
      offset += 4 * rowCount;
      // takerBuyVolume (float64)
      offset += 8 * rowCount;
      // takerBuyQuoteVolume (float64)
      offset += 8 * rowCount;
    }

    rowIndex += rowCount;

    // 跳过 CRC32
    if (offset + 4 <= fileBuffer.length) {
      offset += 4;
    }
  }

  // 构建返回数据
  data.set('symbol_id', symbolIds);
  data.set('interval_id', intervalIds);
  data.set('timestamp', timestamps);
  data.set('open', opens);
  data.set('high', highs);
  data.set('low', lows);
  data.set('close', closes);
  data.set('volume', volumes);

  return {
    header: {
      totalRows: rowIndex,
      columns: header.columns,
    },
    data,
  };
}
