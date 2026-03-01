// ============================================================
// NDTS 纯 TypeScript 文件读取器（非压缩 C 格式）
// ============================================================
// 读取 ndtsdb-lib C 核心写入的 NDTS 文件（write_partition_file 格式）。
// 文件布局：
//   [0..4095]  header_block: "NDTS"(4) + hlen(4) + json(hlen) + padding
//   [4096..4099] header CRC32
//   [4100..]   chunks: row_count(4) + sym_id[](4*n) + itv_id[](4*n)
//                      + ts[](8*n) + open[](8*n) + high[](8*n) + low[](8*n)
//                      + close[](8*n) + volume[](8*n) + flags[](4*n)
//                      + chunk CRC32(4)
//
// 注意：此格式为原始二进制（无压缩）。旧 TS PartitionedTable 写入的
//       gorilla/delta 压缩格式请通过 ndtsdb_open (C FFI) 读取。

import { readFileSync } from 'fs';

const HEADER_BLOCK_SIZE = 4096;
const HEADER_CRC_SIZE = 4;
const DATA_OFFSET = HEADER_BLOCK_SIZE + HEADER_CRC_SIZE;

/**
 * 读取 C-format NDTS 文件（非压缩）。
 * 若文件是旧 TS 压缩格式（header 含 "enabled":true），返回空数据并打印警告。
 */
export function readAndDecompressNdts(filePath: string): {
  header: { totalRows: number };
  data: Map<string, any>;
} {
  const empty = { header: { totalRows: 0 }, data: new Map<string, any>() };

  let buf: Buffer;
  try {
    buf = readFileSync(filePath);
  } catch (err: any) {
    console.warn(`[ndts-reader] Cannot read ${filePath}: ${err.message}`);
    return empty;
  }

  if (buf.length < DATA_OFFSET) {
    console.warn(`[ndts-reader] File too small (${buf.length} bytes): ${filePath}`);
    return empty;
  }

  const magic = buf.subarray(0, 4).toString('utf-8');
  if (magic !== 'NDTS') {
    console.warn(`[ndts-reader] Invalid magic "${magic}": ${filePath}`);
    return empty;
  }

  const headerLen = buf.readUInt32LE(4);
  if (headerLen > HEADER_BLOCK_SIZE - 8) {
    console.warn(`[ndts-reader] Header length ${headerLen} out of range: ${filePath}`);
    return empty;
  }

  let header: any;
  try {
    const jsonStr = buf.subarray(8, 8 + headerLen).toString('utf-8');
    header = JSON.parse(jsonStr);
  } catch {
    console.warn(`[ndts-reader] Corrupt header JSON: ${filePath}`);
    return empty;
  }

  // 旧 TS 压缩格式检测
  if (header?.compression?.enabled === true) {
    console.warn(
      `[ndts-reader] Skipping legacy compressed file (use FFI path instead): ${filePath}`
    );
    return empty;
  }

  const symDict: string[] = (header?.stringDicts?.symbol as string[]) ?? [];
  const itvDict: string[] = (header?.stringDicts?.interval as string[]) ?? [];
  const totalRowsFromHeader: number = header?.totalRows ?? 0;

  // 读取所有 chunks
  const allSymIds: number[] = [];
  const allItvIds: number[] = [];
  const allTs: bigint[] = [];
  const allOpen: number[] = [];
  const allHigh: number[] = [];
  const allLow: number[] = [];
  const allClose: number[] = [];
  const allVolume: number[] = [];
  const allFlags: number[] = [];

  let offset = DATA_OFFSET;
  while (offset + 8 <= buf.length) {
    const rowCount = buf.readUInt32LE(offset);
    offset += 4;

    if (rowCount === 0) break;

    const chunkDataSize =
      rowCount * 4 +  // sym_id
      rowCount * 4 +  // itv_id
      rowCount * 8 +  // timestamp
      rowCount * 8 +  // open
      rowCount * 8 +  // high
      rowCount * 8 +  // low
      rowCount * 8 +  // close
      rowCount * 8 +  // volume
      rowCount * 4;   // flags

    if (offset + chunkDataSize + 4 > buf.length) {
      console.warn(`[ndts-reader] Truncated chunk at offset ${offset}: ${filePath}`);
      break;
    }

    let p = offset;

    // symbol_id
    for (let i = 0; i < rowCount; i++) { allSymIds.push(buf.readInt32LE(p)); p += 4; }
    // interval_id
    for (let i = 0; i < rowCount; i++) { allItvIds.push(buf.readInt32LE(p)); p += 4; }
    // timestamp (int64 little-endian)
    for (let i = 0; i < rowCount; i++) { allTs.push(buf.readBigInt64LE(p)); p += 8; }
    // open
    for (let i = 0; i < rowCount; i++) { allOpen.push(buf.readDoubleLE(p)); p += 8; }
    // high
    for (let i = 0; i < rowCount; i++) { allHigh.push(buf.readDoubleLE(p)); p += 8; }
    // low
    for (let i = 0; i < rowCount; i++) { allLow.push(buf.readDoubleLE(p)); p += 8; }
    // close
    for (let i = 0; i < rowCount; i++) { allClose.push(buf.readDoubleLE(p)); p += 8; }
    // volume
    for (let i = 0; i < rowCount; i++) { allVolume.push(buf.readDoubleLE(p)); p += 8; }
    // flags
    for (let i = 0; i < rowCount; i++) { allFlags.push(buf.readUInt32LE(p)); p += 4; }

    offset = p + 4; // skip CRC32
  }

  const n = allTs.length;
  if (n === 0) return empty;

  const data = new Map<string, any>();
  data.set('symbol', allSymIds.map(id => symDict[id] ?? ''));
  data.set('interval', allItvIds.map(id => itvDict[id] ?? ''));
  data.set('timestamp', BigInt64Array.from(allTs));
  data.set('open', Float64Array.from(allOpen));
  data.set('high', Float64Array.from(allHigh));
  data.set('low', Float64Array.from(allLow));
  data.set('close', Float64Array.from(allClose));
  data.set('volume', Float64Array.from(allVolume));
  data.set('flags', Uint32Array.from(allFlags));

  return { header: { totalRows: n || totalRowsFromHeader }, data };
}
