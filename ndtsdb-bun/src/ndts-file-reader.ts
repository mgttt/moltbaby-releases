// ============================================================
// NDTS 文件直接读取器 - 绕过 FFI QueryResult 指针问题
// ============================================================
// 由于 Bun FFI 无法直接读取 C 结构体指针返回的内存，
// 本模块通过以下方式实现数据读取：
// 1. 解析 NDTS 文件格式（magic + version + JSON header + 压缩数据块）
// 2. 实现 delta/gorilla 解压
// 3. 返回类型化数组

import { readFileSync } from 'fs';

export interface NdtsHeader {
  columns: Array<{ name: string; type: string }>;
  totalRows: number;
  chunkCount: number;
  compression: {
    enabled: boolean;
    algorithms: { [key: string]: 'delta' | 'rle' | 'gorilla' | 'none' };
  };
}

export interface NdtsData {
  header: NdtsHeader;
  data: Map<string, any>;
}

/**
 * 读取 NDTS 文件格式
 * 格式: MAGIC(4) + VERSION(4) + HEADER_JSON + CHUNKS
 */
export function readNdtsFile(filePath: string): NdtsData {
  const fileBuffer = readFileSync(filePath);
  let offset = 0;

  // 1. 验证 Magic
  const magic = fileBuffer.subarray(offset, offset + 4).toString('utf-8');
  if (magic !== 'NDTS') {
    throw new Error(`Invalid NDTS magic: ${magic} (expected "NDTS")`);
  }
  offset += 4;

  // 2. 读取版本
  const version = fileBuffer.readUInt32LE(offset);
  offset += 4;
  console.log(`[ndts-reader] File version: ${version}`);

  // 3. 读取 JSON header (查找结束的 })
  let headerEnd = -1;
  let braceCount = 0;
  for (let i = offset; i < fileBuffer.length; i++) {
    if (fileBuffer[i] === 0x7b) braceCount++; // {
    if (fileBuffer[i] === 0x7d) braceCount--; // }
    if (braceCount === 0 && i > offset) {
      headerEnd = i + 1;
      break;
    }
  }

  if (headerEnd === -1) {
    throw new Error('Invalid NDTS: JSON header not found');
  }

  const headerStr = fileBuffer.subarray(offset, headerEnd).toString('utf-8');
  const header: NdtsHeader = JSON.parse(headerStr);
  offset = headerEnd;

  console.log(`[ndts-reader] Columns: ${header.columns.map(c => c.name).join(', ')}`);
  console.log(`[ndts-reader] Total rows: ${header.totalRows}, Chunks: ${header.chunkCount}`);

  // 4. 构建空的列数据容器
  const data = new Map<string, any>();

  // 如果没有数据，返回空数组
  if (header.totalRows === 0) {
    for (const col of header.columns) {
      data.set(col.name, createTypedArray(col.type, 0));
    }
    return { header, data };
  }

  // 5. 初始化类型化数组
  for (const col of header.columns) {
    data.set(col.name, createTypedArray(col.type, header.totalRows));
  }

  // 6. 读取和解压数据块
  let rowIndex = 0;
  for (let chunkIdx = 0; chunkIdx < header.chunkCount; chunkIdx++) {
    if (offset >= fileBuffer.length) break;

    // 读取 chunk header: chunk_size(4) + row_count(4)
    if (offset + 8 > fileBuffer.length) break;

    const chunkSize = fileBuffer.readUInt32LE(offset);
    const chunkRowCount = fileBuffer.readUInt32LE(offset + 4);
    offset += 8;

    if (offset + chunkSize > fileBuffer.length) break;

    const chunkData = fileBuffer.subarray(offset, offset + chunkSize);
    offset += chunkSize;

    // 7. 解压每列数据
    let columnOffset = 0;
    for (const col of header.columns) {
      const algo = header.compression.algorithms[col.name] || 'none';
      const columnArray = data.get(col.name);

      if (!columnArray) continue;

      // 读取该列的压缩数据大小（假设 4 字节）
      if (columnOffset + 4 > chunkData.length) break;

      const colDataSize = chunkData.readUInt32LE(columnOffset);
      columnOffset += 4;

      if (columnOffset + colDataSize > chunkData.length) break;

      const colCompressed = chunkData.subarray(columnOffset, columnOffset + colDataSize);
      columnOffset += colDataSize;

      // 8. 根据算法解压
      const decompressed = decompressColumn(colCompressed, algo, col.type, chunkRowCount);

      // 9. 填充到大数组
      for (let i = 0; i < decompressed.length && rowIndex + i < header.totalRows; i++) {
        columnArray[rowIndex + i] = decompressed[i];
      }
    }

    rowIndex += chunkRowCount;
  }

  return { header, data };
}

/**
 * 创建对应类型的类型化数组
 */
function createTypedArray(type: string, length: number): any {
  switch (type) {
    case 'int32':
      return new Int32Array(length);
    case 'int64':
    case 'timestamp':
      return new BigInt64Array(length);
    case 'float32':
      return new Float32Array(length);
    case 'float64':
    case 'double':
      return new Float64Array(length);
    case 'uint32':
      return new Uint32Array(length);
    default:
      return new Float64Array(length);
  }
}

/**
 * 解压单列数据
 * 支持: delta, gorilla, rle, none
 */
function decompressColumn(
  compressed: Buffer,
  algorithm: string,
  type: string,
  count: number
): any[] {
  const result: any[] = [];

  switch (algorithm) {
    case 'none':
      return decompressNone(compressed, type, count);
    case 'delta':
      return decompressDelta(compressed, type, count);
    case 'gorilla':
      return decompressGorilla(compressed, type, count);
    case 'rle':
      return decompressRle(compressed, type, count);
    default:
      console.warn(`[ndts-reader] Unknown compression algorithm: ${algorithm}`);
      return decompressNone(compressed, type, count);
  }
}

/**
 * 无压缩：直接读取
 */
function decompressNone(buf: Buffer, type: string, count: number): any[] {
  const result: any[] = [];
  let offset = 0;

  const typeSize = getTypeSize(type);
  for (let i = 0; i < count; i++) {
    if (offset + typeSize > buf.length) break;
    const value = readValue(buf, offset, type);
    result.push(value);
    offset += typeSize;
  }

  return result;
}

/**
 * Delta 压缩：存储差值
 * 格式：base_value(全大小) + delta1(u8) + delta2(u8) + ...
 */
function decompressDelta(buf: Buffer, type: string, count: number): any[] {
  const result: any[] = [];
  if (buf.length === 0) return result;

  let offset = 0;
  const typeSize = getTypeSize(type);

  // 读取基值
  let base = readValue(buf, offset, type);
  result.push(base);
  offset += typeSize;

  // 读取差值（可能是 1-8 字节变长编码）
  for (let i = 1; i < count && offset < buf.length; i++) {
    // 简化：假设差值是固定大小（实际应该用变长整数编码）
    const deltaSize = Math.min(typeSize, buf.length - offset);
    const delta = readValue(buf, offset, type);
    offset += deltaSize;

    base = addValues(base, delta, type);
    result.push(base);
  }

  return result;
}

/**
 * Gorilla 压缩：针对浮点数的流式压缩
 * 简化实现：尝试按字节读取
 */
function decompressGorilla(buf: Buffer, type: string, count: number): any[] {
  const result: any[] = [];
  if (buf.length === 0) return result;

  // Gorilla 对 float64 使用 XOR 编码
  // 简化实现：如果无法完整解压，降级到块读取
  if (type === 'float64' || type === 'double') {
    return decompressGorillaFloat64(buf, count);
  }

  // 对其他类型，降级到 delta 处理
  return decompressDelta(buf, type, count);
}

/**
 * Gorilla float64 解压 (简化版)
 * 真实 Gorilla 使用 XOR + 游程编码，这里简化为块读取
 */
function decompressGorillaFloat64(buf: Buffer, count: number): number[] {
  const result: number[] = [];

  // 尝试按 8 字节块读取（可能的 float64 值）
  for (let i = 0; i < count && buf.length - i * 8 >= 8; i++) {
    result.push(buf.readDoubleLE(i * 8));
  }

  return result;
}

/**
 * RLE 压缩：游程编码
 * 格式：value + count, value + count, ...
 */
function decompressRle(buf: Buffer, type: string, count: number): any[] {
  const result: any[] = [];
  if (buf.length === 0) return result;

  let offset = 0;
  const typeSize = getTypeSize(type);

  while (offset < buf.length && result.length < count) {
    // 读取值
    const value = readValue(buf, offset, typeSize);
    offset += typeSize;

    // 读取计数（1-4 字节变长编码，这里简化为 1 字节）
    let runCount = 1;
    if (offset < buf.length) {
      runCount = buf.readUInt8(offset);
      offset += 1;
    }

    // 填充
    for (let i = 0; i < runCount && result.length < count; i++) {
      result.push(value);
    }
  }

  return result;
}

/**
 * 获取类型的字节大小
 */
function getTypeSize(type: string): number {
  switch (type) {
    case 'int32':
    case 'uint32':
      return 4;
    case 'int64':
    case 'timestamp':
      return 8;
    case 'float32':
      return 4;
    case 'float64':
    case 'double':
      return 8;
    default:
      return 8;
  }
}

/**
 * 从 Buffer 读取值
 */
function readValue(buf: Buffer, offset: number, type: string): any {
  if (offset + getTypeSize(type) > buf.length) return 0;

  switch (type) {
    case 'int32':
      return buf.readInt32LE(offset);
    case 'uint32':
      return buf.readUInt32LE(offset);
    case 'int64':
    case 'timestamp':
      return buf.readBigInt64LE(offset);
    case 'float32':
      return buf.readFloatLE(offset);
    case 'float64':
    case 'double':
      return buf.readDoubleLE(offset);
    default:
      return buf.readDoubleLE(offset);
  }
}

/**
 * 两个值相加（支持 bigint）
 */
function addValues(a: any, b: any, type: string): any {
  if (type === 'int64' || type === 'timestamp') {
    return BigInt(a) + BigInt(b);
  }
  return a + b;
}
