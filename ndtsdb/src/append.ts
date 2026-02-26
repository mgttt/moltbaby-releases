// ============================================================
// [DEPRECATED] 增量写入 + CRC32 完整性校验
// append-only 模式，不重写整个文件
//
// ⚠️ 本文件已废弃 (v0.9.0+)
//   - 原因: 纯 TS 实现与 CLI 格式不兼容，性能不及 C 核心
//   - 替代: 使用 append-ffi.ts (AppendWriterFFI) 或 CLI 原生接口
//   - 计划: 下版本移除
// ============================================================

import { openSync, closeSync, writeSync, readSync, fstatSync, existsSync, mkdirSync, renameSync, rmSync } from 'fs';
import { dirname } from 'path';
import { TombstoneManager } from './tombstone.js';
import { DeltaEncoderInt64, DeltaEncoderInt32, RLEEncoder, GorillaEncoder, BrotliCompressor } from './compression.js';

/**
 * CRC32 计算 (IEEE 802.3)
 * 纯 TypeScript 实现，无依赖
 */
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let j = 0; j < 8; j++) {
    crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  CRC32_TABLE[i] = crc;
}

export function crc32(data: Uint8Array, initial = 0xFFFFFFFF): number {
  let crc = initial;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * 文件格式 v2 (增量写入)
 *
 * ┌──────────────────────────────────┐
 * │ Magic: "NDTS" (4 bytes)         │
 * │ Header length (4 bytes LE)      │
 * │ Header JSON                     │
 * │ Padding (8-byte align)          │
 * │ CRC32 of header (4 bytes LE)    │
 * ├──────────────────────────────────┤
 * │ Chunk 0:                        │
 * │   row count (4 bytes LE)        │
 * │   column 0 data                 │
 * │   column 1 data                 │
 * │   ...                           │
 * │   CRC32 of chunk (4 bytes LE)   │
 * ├──────────────────────────────────┤
 * │ Chunk 1: ...                    │
 * └──────────────────────────────────┘
 *
 * 每次 append 写一个新 chunk，不重写旧数据。
 * 读取时合并所有 chunk。
 */

const MAGIC = Buffer.from('NDTS');

export interface AppendFileHeader {
  columns: Array<{ name: string; type: string }>;
  totalRows: number;    // 所有 chunk 的总行数
  chunkCount: number;   // chunk 数量
  stringDicts?: { [columnName: string]: string[] }; // string 列字典（v2.1+）
  compression?: {
    enabled: boolean;
    algorithms: { [columnName: string]: 'delta' | 'rle' | 'gorilla' | 'none' };
  };
}

export type AppendRewriteResult = {
  beforeRows: number;
  afterRows: number;
  deletedRows: number;
  chunksWritten: number;
};

export type AppendRewriteOptions = {
  batchSize?: number; // 控制输出 chunk 大小（默认 10k）
  tmpPath?: string;
  backupPath?: string;
  keepBackup?: boolean;
  mode?: 'stream' | 'readAll'; // 默认 stream（不展开全表）
};

export interface AppendWriterOptions {
  /**
   * 自动 compact 开关（默认 false）
   */
  autoCompact?: boolean;

  /**
   * Tombstone 比例触发阈值（默认 0.2 = 20%）
   * 当 deletedRows / totalRows >= threshold 时触发 compact
   */
  compactThreshold?: number;

  /**
   * Compact 触发的最小行数（默认 1000）
   * 避免小表频繁 compact
   */
  compactMinRows?: number;

  /**
   * 最大未 compact 时间（毫秒）（默认 24 小时）
   * 自上次 compact 后经过此时间将触发 compact
   */
  compactMaxAgeMs?: number;

  /**
   * 最大文件大小（字节）（默认 100MB）
   * 文件大小超过此值将触发 compact
   */
  compactMaxFileSize?: number;

  /**
   * 最大 chunk 数量（默认 1000）
   * chunk 过多表示碎片化严重，触发 compact
   */
  compactMaxChunks?: number;

  /**
   * 自上次 compact 累计写入行数（默认 100k）
   * 累计写入超过此值将触发 compact
   */
  compactMaxWrites?: number;

  /**
   * 压缩配置（默认不启用）
   */
  compression?: {
    enabled: boolean;
    /**
     * 各列压缩算法（可选，默认根据类型自动选择）
     * - int64: 'delta' (单调递增) | 'none'
     * - int32: 'delta' | 'rle' (重复值多) | 'none'
     * - float64: 'gorilla' | 'none'
     * - string: 已字典编码，无需额外压缩
     */
    algorithms?: { [columnName: string]: 'delta' | 'rle' | 'gorilla' | 'none' };
  };
}

/**
 * 增量写入器
 */
export class AppendWriter {
  private path: string;
  private columns: Array<{ name: string; type: string }>;
  private fd: number = -1;
  private totalRows = 0;
  private chunkCount = 0;
  private tombstone: TombstoneManager;
  private stringDicts: Map<string, Map<string, number>> = new Map(); // columnName → (value → id)
  private stringDictsReverse: Map<string, Map<number, string>> = new Map(); // columnName → (id → value)
  private options: AppendWriterOptions;
  private lastCompactTime: number = Date.now();
  private writesSinceCompact: number = 0;

  constructor(path: string, columns: Array<{ name: string; type: string }>, options: AppendWriterOptions = {}) {
    this.path = path;
    this.columns = columns;
    this.tombstone = new TombstoneManager(path);
    this.options = {
      autoCompact: options.autoCompact ?? false,
      compactThreshold: options.compactThreshold ?? 0.2,
      compactMinRows: options.compactMinRows ?? 1000,
      compactMaxAgeMs: options.compactMaxAgeMs ?? 24 * 60 * 60 * 1000, // 24h
      compactMaxFileSize: options.compactMaxFileSize ?? 100 * 1024 * 1024, // 100MB
      compactMaxChunks: options.compactMaxChunks ?? 1000,
      compactMaxWrites: options.compactMaxWrites ?? 100_000,
      compression: options.compression ?? { enabled: false },
    };

    // 初始化 string 列字典
    for (const col of columns) {
      if (col.type === 'string') {
        this.stringDicts.set(col.name, new Map());
        this.stringDictsReverse.set(col.name, new Map());
      }
    }
  }

  /**
   * 打开文件 (创建或追加)
   */
  open(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (existsSync(this.path)) {
      // 已有文件 — 读取 header，定位到末尾
      this.fd = openSync(this.path, 'r+');
      const header = this.readHeader();
      this.totalRows = header.totalRows;
      this.chunkCount = header.chunkCount;

      // 加载字典
      if (header.stringDicts) {
        for (const [colName, dict] of Object.entries(header.stringDicts)) {
          const fwdMap = this.stringDicts.get(colName) || new Map();
          const revMap = this.stringDictsReverse.get(colName) || new Map();

          for (let i = 0; i < dict.length; i++) {
            fwdMap.set(dict[i], i);
            revMap.set(i, dict[i]);
          }

          this.stringDicts.set(colName, fwdMap);
          this.stringDictsReverse.set(colName, revMap);
        }
      }

      // 同步压缩配置（确保 append 使用与文件一致的格式）
      if (header.compression) {
        this.options.compression = header.compression;
      }
    } else {
      // 新文件 — 写入 header
      this.fd = openSync(this.path, 'w+');
      this.writeHeader();
    }
  }

  /**
   * 追加数据 (append-only)
   */
  append(rows: Record<string, any>[]): void {
    if (this.fd === -1) throw new Error('File not opened');
    if (rows.length === 0) return;

    const rowCount = rows.length;
    const compressionEnabled = this.options.compression?.enabled ?? false;

    // 构建 chunk
    const parts: Buffer[] = [];

    // Row count
    const rcBuf = Buffer.allocUnsafe(4);
    rcBuf.writeUInt32LE(rowCount);
    parts.push(rcBuf);

    // Column data（先构建未压缩数据，再决定是否压缩）
    let dictDirty = false;

    for (const col of this.columns) {
      const byteLen = this.getByteLength(col.type);
      const buf = Buffer.allocUnsafe(byteLen * rowCount);

      // 填充数据
      for (let i = 0; i < rowCount; i++) {
        const val = rows[i][col.name];
        switch (col.type) {
          case 'int64':
            buf.writeBigInt64LE(BigInt(val), i * 8);
            break;
          case 'float64':
            buf.writeDoubleLE(Number(val), i * 8);
            break;
          case 'int32':
            buf.writeInt32LE(Number(val), i * 4);
            break;
          case 'int16':
            buf.writeInt16LE(Number(val), i * 2);
            break;
          case 'string': {
            const fwdMap = this.stringDicts.get(col.name)!;
            const revMap = this.stringDictsReverse.get(col.name)!;
            const str = String(val ?? '');

            let id = fwdMap.get(str);
            if (id === undefined) {
              id = fwdMap.size;
              fwdMap.set(str, id);
              revMap.set(id, str);
              dictDirty = true;
            }

            buf.writeInt32LE(id, i * 4);
            break;
          }
        }
      }

      // 压缩（如果启用）
      let finalBuf = buf;
      if (compressionEnabled) {
        const algorithm = this.options.compression!.algorithms?.[col.name] ?? this.autoSelectAlgorithm(col.type);
        if (algorithm !== 'none') {
          const compressed = this.compressColumn(buf, col.type, algorithm, rowCount);
          if (!compressed) {
            throw new Error(`Compression failed for column ${col.name} (${col.type}, ${algorithm})`);
          }
          // 压缩格式下：必须始终使用压缩后的字节（否则读取端无法判断是否需要解压）
          finalBuf = compressed;
        }
      }

      // 写入列数据（压缩格式需要col_len）
      if (compressionEnabled) {
        const lenBuf = Buffer.allocUnsafe(4);
        lenBuf.writeUInt32LE(finalBuf.length);
        parts.push(lenBuf);
      }
      parts.push(finalBuf);
    }

    // 合并计算 CRC
    const chunkData = Buffer.concat(parts);
    const checksum = crc32(new Uint8Array(chunkData.buffer, chunkData.byteOffset, chunkData.byteLength));
    const crcBuf = Buffer.allocUnsafe(4);
    crcBuf.writeUInt32LE(checksum);

    // 写入文件末尾
    const stat = fstatSync(this.fd);
    writeSync(this.fd, chunkData, 0, chunkData.length, stat.size);
    writeSync(this.fd, crcBuf, 0, 4, stat.size + chunkData.length);

    // 更新 header
    this.totalRows += rowCount;
    this.chunkCount++;
    this.writesSinceCompact += rowCount;

    // 字典更新时需要重写 header
    if (dictDirty) {
      this.updateHeader();
    } else {
      this.updateHeaderCountsOnly();
    }
  }

  /**
   * 自动选择压缩算法
   */
  private autoSelectAlgorithm(type: string): 'delta' | 'rle' | 'gorilla' | 'brotli' | 'none' {
    switch (type) {
      case 'int64':
        return 'delta'; // 单调递增（如 timestamp）
      case 'int32':
        return 'delta'; // 默认 delta（若 RLE 更优可手动指定）
      case 'float64':
        return 'gorilla'; // 浮点数：Gorilla 专用算法（测试证明优于通用压缩）
      default:
        return 'none';
    }
  }

  /**
   * 压缩列数据
   */
  private compressColumn(
    buf: Buffer,
    type: string,
    algorithm: 'delta' | 'rle' | 'gorilla' | 'brotli' | 'none',
    rowCount: number
  ): Buffer | null {
    try {
      switch (algorithm) {
        case 'delta': {
          if (type === 'int64') {
            const arr = new BigInt64Array(buf.buffer, buf.byteOffset, rowCount);
            const encoder = new DeltaEncoderInt64();
            const compressed = encoder.compress(arr);
            return Buffer.from(compressed);
          } else if (type === 'int32') {
            const arr = new Int32Array(buf.buffer, buf.byteOffset, rowCount);
            const encoder = new DeltaEncoderInt32();
            const compressed = encoder.compress(arr);
            return Buffer.from(compressed);
          }
          break;
        }

        case 'rle': {
          if (type === 'int32') {
            const arr = new Int32Array(buf.buffer, buf.byteOffset, rowCount);
            const encoder = new RLEEncoder();
            const compressed = encoder.compress(arr);
            return Buffer.from(compressed);
          }
          break;
        }

        case 'gorilla': {
          if (type === 'float64') {
            const arr = new Float64Array(buf.buffer, buf.byteOffset, rowCount);
            const encoder = new GorillaEncoder();
            const compressed = encoder.compress(arr);
            return Buffer.from(compressed);
          }
          break;
        }

        case 'brotli': {
          const encoder = new BrotliCompressor(3);
          
          if (type === 'float64') {
            const arr = new Float64Array(buf.buffer, buf.byteOffset, rowCount);
            const compressed = encoder.compressFloat64(arr);
            return Buffer.from(compressed);
          } else if (type === 'int64') {
            const arr = new BigInt64Array(buf.buffer, buf.byteOffset, rowCount);
            const compressed = encoder.compressBigInt64(arr);
            return Buffer.from(compressed);
          } else if (type === 'int32') {
            const arr = new Int32Array(buf.buffer, buf.byteOffset, rowCount);
            const compressed = encoder.compressInt32(arr);
            return Buffer.from(compressed);
          }
          break;
        }

        case 'none':
        default:
          return null;
      }
    } catch (e) {
      console.warn(`[Compression] Failed to compress column (${type}, ${algorithm}):`, e);
      return null;
    }

    return null;
  }

  /**
   * 解压列数据
   */
  static decompressColumn(
    buf: Buffer,
    type: string,
    algorithm: 'delta' | 'rle' | 'gorilla' | 'brotli' | 'none',
    rowCount: number
  ): Buffer | null {
    try {
      switch (algorithm) {
        case 'delta': {
          if (type === 'int64') {
            const encoder = new DeltaEncoderInt64();
            const decompressed = encoder.decompress(new Uint8Array(buf), rowCount);
            return Buffer.from(decompressed.buffer);
          } else if (type === 'int32') {
            const encoder = new DeltaEncoderInt32();
            const decompressed = encoder.decompress(new Uint8Array(buf), rowCount);
            return Buffer.from(decompressed.buffer);
          }
          break;
        }

        case 'rle': {
          if (type === 'int32') {
            const encoder = new RLEEncoder();
            const decompressed = encoder.decompress(new Uint8Array(buf), rowCount);
            return Buffer.from(decompressed.buffer);
          }
          break;
        }

        case 'gorilla': {
          if (type === 'float64') {
            const encoder = new GorillaEncoder();
            const decompressed = encoder.decompress(new Uint8Array(buf), rowCount);
            return Buffer.from(decompressed.buffer);
          }
          break;
        }

        case 'brotli': {
          const encoder = new BrotliCompressor(3);
          
          if (type === 'float64') {
            const decompressed = encoder.decompressFloat64(new Uint8Array(buf), rowCount);
            return Buffer.from(decompressed.buffer);
          } else if (type === 'int64') {
            const decompressed = encoder.decompressBigInt64(new Uint8Array(buf), rowCount);
            return Buffer.from(decompressed.buffer);
          } else if (type === 'int32') {
            const decompressed = encoder.decompressInt32(new Uint8Array(buf), rowCount);
            return Buffer.from(decompressed.buffer);
          }
          break;
        }

        case 'none':
        default:
          return null;
      }
    } catch (e) {
      console.warn(`[Compression] Failed to decompress column (${type}, ${algorithm}):`, e);
      return null;
    }

    return null;
  }

  /**
   * 快速更新 header 计数（避免重写字典）
   */
  private updateHeaderCountsOnly(): void {
    // 读取现有 header
    const header = this.readHeader();
    header.totalRows = this.totalRows;
    header.chunkCount = this.chunkCount;

    // 重写 header（保持字典不变）
    this.writeHeaderData(header);
  }

  private writeHeaderData(header: AppendFileHeader): void {
    const headerJson = JSON.stringify(header);
    const headerBuf = Buffer.from(headerJson);

    // 预留固定 header 空间：4KB（足够容纳大多数字典）
    const RESERVED_HEADER_SIZE = 4096;
    const headerActualSize = 4 + 4 + headerBuf.length; // magic + len + json
    
    if (headerActualSize > RESERVED_HEADER_SIZE - 8) { // -8 for padding + CRC
      throw new Error(`Header too large: ${headerActualSize} bytes (max ${RESERVED_HEADER_SIZE - 8})`);
    }

    const paddingSize = RESERVED_HEADER_SIZE - headerActualSize;

    const headerLenBuf = Buffer.allocUnsafe(4);
    headerLenBuf.writeUInt32LE(headerBuf.length);

    const headerBlock = Buffer.concat([
      MAGIC,
      headerLenBuf,
      headerBuf,
      Buffer.alloc(paddingSize),
    ]);

    // CRC32 计算整个 headerBlock（magic + length + header + padding）
    const headerCrc = crc32(new Uint8Array(headerBlock.buffer, headerBlock.byteOffset, headerBlock.byteLength));
    const crcBuf = Buffer.allocUnsafe(4);
    crcBuf.writeUInt32LE(headerCrc);

    // 覆盖写入 header 区域（固定大小）
    writeSync(this.fd, headerBlock, 0, headerBlock.length, 0);
    writeSync(this.fd, crcBuf, 0, 4, headerBlock.length);
  }

  /**
   * 关闭文件
   */
  async close(): Promise<void> {
    if (this.fd !== -1) {
      closeSync(this.fd);
      this.fd = -1;
    }
    // 保存 tombstone
    this.tombstone.save();

    // 自动 compact 检查
    if (this.options.autoCompact) {
      await this.checkAndCompact();
    }
  }

  /**
   * 检查并执行自动 compact
   */
  private async checkAndCompact(): Promise<void> {
    const deletedCount = this.tombstone.getDeletedCount();
    const totalRows = this.totalRows; // 当前文件中的总行数（包含已删除的）

    // 最小行数检查（避免小表频繁 compact）
    if (totalRows < this.options.compactMinRows!) {
      return;
    }

    // 收集触发原因
    const reasons: string[] = [];

    // 1. Tombstone 比例
    const deletedRatio = deletedCount / totalRows;
    if (deletedRatio >= this.options.compactThreshold!) {
      reasons.push(`tombstone ${(deletedRatio * 100).toFixed(1)}% (${deletedCount}/${totalRows})`);
    }

    // 2. 时间触发
    const ageMs = Date.now() - this.lastCompactTime;
    if (ageMs >= this.options.compactMaxAgeMs!) {
      reasons.push(`age ${(ageMs / 3600000).toFixed(1)}h`);
    }

    // 3. 文件大小触发
    if (existsSync(this.path)) {
      const tmpFd = openSync(this.path, 'r');
      try {
        const stat = fstatSync(tmpFd);
        const fileSizeMB = stat.size / (1024 * 1024);
        if (stat.size >= this.options.compactMaxFileSize!) {
          reasons.push(`size ${fileSizeMB.toFixed(1)}MB`);
        }
      } finally {
        closeSync(tmpFd);
      }
    }

    // 4. Chunk 碎片化
    if (this.chunkCount >= this.options.compactMaxChunks!) {
      reasons.push(`chunks ${this.chunkCount}`);
    }

    // 5. 写入量
    if (this.writesSinceCompact >= this.options.compactMaxWrites!) {
      reasons.push(`writes ${this.writesSinceCompact}`);
    }

    // 任一条件满足即触发
    if (reasons.length > 0) {
      console.log(`[AutoCompact] Triggering compact (${reasons.join(', ')})`);
      
      // 重新打开文件
      this.open();
      try {
        await this.compact();
        // 重置状态
        this.lastCompactTime = Date.now();
        this.writesSinceCompact = 0;
      } finally {
        if (this.fd !== -1) {
          closeSync(this.fd);
          this.fd = -1;
        }
      }
    }
  }

  // ... 其他方法保持不变

  private updateHeader(): void {
    const header: AppendFileHeader = {
      columns: this.columns,
      totalRows: this.totalRows,
      chunkCount: this.chunkCount,
    };

    // 保留/写入压缩配置
    if (this.options.compression?.enabled) {
      const algorithms: { [colName: string]: 'delta' | 'rle' | 'gorilla' | 'none' } =
        this.options.compression.algorithms ??
        Object.fromEntries(this.columns.map((c) => [c.name, this.autoSelectAlgorithm(c.type)]));
      this.options.compression.algorithms = algorithms;
      header.compression = { enabled: true, algorithms };
    }

    // 序列化字典
    if (this.stringDicts.size > 0) {
      header.stringDicts = {};
      for (const [colName, fwdMap] of this.stringDicts) {
        const dict: string[] = [];
        const revMap = this.stringDictsReverse.get(colName)!;
        for (let i = 0; i < fwdMap.size; i++) {
          dict[i] = revMap.get(i) || '';
        }
        header.stringDicts[colName] = dict;
      }
    }

    this.writeHeaderData(header);
  }

  /**
   * 标记行为已删除（tombstone）
   */
  markDeleted(rowIndex: number): void {
    this.tombstone.markDeleted(rowIndex);
  }

  /**
   * 批量标记删除
   */
  markDeletedBatch(rowIndices: number[]): void {
    this.tombstone.markDeletedBatch(rowIndices);
  }

  /**
   * 获取已删除行数
   */
  getDeletedCount(): number {
    return this.tombstone.getDeletedCount();
  }

  /**
   * 读取并过滤 tombstone
   */
  readAllFiltered(): { header: AppendFileHeader; data: Map<string, ArrayLike<any>> } {
    const { header, data } = AppendWriter.readAll(this.path);
    
    // 过滤已删除行
    const deletedRows = this.tombstone.getDeletedRows();
    if (deletedRows.length === 0) {
      return { header, data };
    }

    const deletedSet = new Set(deletedRows);
    const validCount = header.totalRows - deletedRows.length;
    const filteredData = new Map<string, ArrayLike<any>>();

    for (const [name, col] of data) {
      const colDef = this.columns.find((c) => c.name === name);
      if (!colDef) continue;

      // 创建新数组，不包含已删除行
      let newCol: any;

      switch (colDef.type) {
        case 'int64':
          newCol = new BigInt64Array(validCount);
          break;
        case 'float64':
          newCol = new Float64Array(validCount);
          break;
        case 'int32':
          newCol = new Int32Array(validCount);
          break;
        case 'int16':
          newCol = new Int16Array(validCount);
          break;
        case 'string':
          newCol = new Array(validCount);
          break;
        default:
          newCol = new Array(validCount);
      }

      let writeIdx = 0;
      for (let i = 0; i < header.totalRows; i++) {
        if (!deletedSet.has(i)) {
          newCol[writeIdx++] = (col as any)[i];
        }
      }

      filteredData.set(name, newCol);
    }

    return {
      header: { ...header, totalRows: validCount },
      data: filteredData,
    };
  }

  /**
   * 使用 tombstone 标记删除（O(1)，延迟清理）
   */
  deleteWhereWithTombstone(predicate: (row: Record<string, any>, index: number) => boolean): number {
    const { header, data } = AppendWriter.readAll(this.path);
    const toDelete: number[] = [];

    for (let i = 0; i < header.totalRows; i++) {
      const row: Record<string, any> = {};
      for (const [name, col] of data) {
        row[name] = (col as any)[i];
      }
      if (predicate(row, i)) {
        toDelete.push(i);
      }
    }

    this.tombstone.markDeletedBatch(toDelete);
    this.tombstone.save();
    return toDelete.length;
  }

  /**
   * 删除并立即 compact（兼容旧接口）
   */
  async deleteWhereAndCompact(
    predicate: (row: Record<string, any>, index: number) => boolean,
    options: AppendRewriteOptions = {}
  ): Promise<AppendRewriteResult> {
    this.deleteWhereWithTombstone(predicate);
    return this.compact(options);
  }

  /**
   * Compact：清理 tombstone + 合并 chunk
   * 
   * 触发场景：
   * 1. 有 tombstone（删除行） → 过滤 + 重写
   * 2. chunk 碎片化（即使无 tombstone）→ 合并 chunk
   */
  async compact(options: AppendRewriteOptions = {}): Promise<AppendRewriteResult> {
    const deletedCount = this.tombstone.getDeletedCount();
    const shouldCompact = deletedCount > 0 || this.chunkCount > 1;

    if (!shouldCompact) {
      // 只有 1 个 chunk 且无 tombstone → 无需 compact
      return { beforeRows: this.totalRows, afterRows: this.totalRows, deletedRows: 0, chunksWritten: 0 };
    }

    // 读取并过滤
    const { header, data } = this.readAllFiltered();
    
    // 重写文件
    const tmpPath = options.tmpPath || this.path + '.tmp';
    const writer = new AppendWriter(tmpPath, this.columns, {
      compression: this.options.compression,
    });
    writer.open();

    const batchSize = options.batchSize || 10000;
    const rows: Record<string, any>[] = [];

    for (let i = 0; i < header.totalRows; i++) {
      const row: Record<string, any> = {};
      for (const [name, col] of data) {
        row[name] = (col as any)[i];
      }
      rows.push(row);

      if (rows.length >= batchSize) {
        writer.append(rows);
        rows.length = 0;
      }
    }

    if (rows.length > 0) {
      writer.append(rows);
    }

    writer.close();

    // 原子替换
    const backupPath = options.backupPath || this.path + '.bak';
    if (existsSync(this.path)) {
      renameSync(this.path, backupPath);
    }
    renameSync(tmpPath, this.path);

    if (!options.keepBackup && existsSync(backupPath)) {
      rmSync(backupPath);
    }

    // 清空 tombstone
    this.tombstone.clear();
    this.tombstone.save();

    // 重新打开
    if (this.fd !== -1) {
      closeSync(this.fd);
      this.fd = -1;
    }
    this.open();

    // 重置 auto compact 状态
    this.lastCompactTime = Date.now();
    this.writesSinceCompact = 0;

    return {
      beforeRows: this.totalRows + deletedCount,
      afterRows: this.totalRows,
      deletedRows: deletedCount,
      chunksWritten: Math.ceil(header.totalRows / batchSize),
    };
  }

  // ─── Header 操作 ───────────────────────────────────

  private writeHeader(): void {
    const header: AppendFileHeader = {
      columns: this.columns,
      totalRows: 0,
      chunkCount: 0,
    };

    // 初始化字典结构（避免后续 header 变长覆盖 chunk）
    if (this.stringDicts.size > 0) {
      header.stringDicts = {};
      for (const [colName] of this.stringDicts) {
        header.stringDicts[colName] = [];
      }
    }

    // 压缩配置（启用时：chunk 写入变为 "len + data" 格式）
    if (this.options.compression?.enabled) {
      const algorithms: { [colName: string]: 'delta' | 'rle' | 'gorilla' | 'none' } = {};
      for (const col of this.columns) {
        algorithms[col.name] = this.options.compression.algorithms?.[col.name] ?? this.autoSelectAlgorithm(col.type);
      }
      // 固化算法映射（确保 append/read 一致）
      this.options.compression.algorithms = algorithms;
      header.compression = { enabled: true, algorithms };
    }

    this.writeHeaderData(header);
  }

  private readHeader(): AppendFileHeader {
    // 读取 magic
    const magicBuf = Buffer.allocUnsafe(4);
    readSync(this.fd, magicBuf, 0, 4, 0);
    if (!magicBuf.equals(MAGIC)) throw new Error('Invalid file magic');

    // 读取 header 长度
    const lenBuf = Buffer.allocUnsafe(4);
    readSync(this.fd, lenBuf, 0, 4, 4);
    const headerLen = lenBuf.readUInt32LE();

    // 读取 header JSON
    const headerBuf = Buffer.allocUnsafe(headerLen);
    readSync(this.fd, headerBuf, 0, headerLen, 8);

    return JSON.parse(headerBuf.toString());
  }

  private getByteLength(type: string): number {
    switch (type) {
      case 'int64': return 8;
      case 'float64': return 8;
      case 'int32': return 4;
      case 'int16': return 2;
      case 'string': return 4; // 字典 id (int32)
      default: return 8;
    }
  }

  // ─── 读取 ─────────────────────────────────────────

  /**
   * 读取所有 chunk 并合并
   * 返回: { [columnName]: TypedArray }
   */
  static readAll(path: string): { header: AppendFileHeader; data: Map<string, ArrayLike<any>> } {
    const fd = openSync(path, 'r');
    const stat = fstatSync(fd);

    // 读取 magic + header
    const magicBuf = Buffer.allocUnsafe(4);
    readSync(fd, magicBuf, 0, 4, 0);
    if (!magicBuf.equals(MAGIC)) {
      closeSync(fd);
      throw new Error('Invalid file magic');
    }

    const lenBuf = Buffer.allocUnsafe(4);
    readSync(fd, lenBuf, 0, 4, 4);
    const headerLen = lenBuf.readUInt32LE();

    const headerBuf = Buffer.allocUnsafe(headerLen);
    readSync(fd, headerBuf, 0, headerLen, 8);
    const header: AppendFileHeader = JSON.parse(headerBuf.toString());

    // Header 固定大小 4KB + 4 bytes CRC
    const RESERVED_HEADER_SIZE = 4096;
    let offset = RESERVED_HEADER_SIZE + 4; // header block + CRC

    // 分配结果数组
    const data = new Map<string, any>();
    for (const col of header.columns) {
      switch (col.type) {
        case 'int64': data.set(col.name, new BigInt64Array(header.totalRows)); break;
        case 'float64': data.set(col.name, new Float64Array(header.totalRows)); break;
        case 'int32': data.set(col.name, new Int32Array(header.totalRows)); break;
        case 'int16': data.set(col.name, new Int16Array(header.totalRows)); break;
        case 'string': data.set(col.name, new Array(header.totalRows)); break;
      }
    }

    // 读取所有 chunk
    let rowOffset = 0;
    for (let c = 0; c < header.chunkCount; c++) {
      // Row count
      const rcBuf = Buffer.allocUnsafe(4);
      readSync(fd, rcBuf, 0, 4, offset);
      const chunkRows = rcBuf.readUInt32LE();
      offset += 4;

      // 读取列数据（支持压缩）
      const compressionEnabled = header.compression?.enabled ?? false;

      for (const col of header.columns) {
        let colData: Buffer;

        if (compressionEnabled) {
          // 新格式：读取 col_len + data
          const lenBuf = Buffer.allocUnsafe(4);
          readSync(fd, lenBuf, 0, 4, offset);
          offset += 4;

          const colLen = lenBuf.readUInt32LE();
          const buf = Buffer.allocUnsafe(colLen);
          readSync(fd, buf, 0, colLen, offset);
          offset += colLen;

          // 解压（如果需要）
          const algorithm = header.compression.algorithms[col.name];
          if (algorithm && algorithm !== 'none') {
            const decompressed = AppendWriter.decompressColumn(buf, col.type, algorithm, chunkRows);
            colData = decompressed ?? buf;
          } else {
            colData = buf;
          }
        } else {
          // 旧格式：固定列长
          let byteLen: number;
          switch (col.type) {
            case 'int64':
            case 'float64':
              byteLen = 8;
              break;
            case 'int32':
            case 'string':
              byteLen = 4;
              break;
            case 'int16':
              byteLen = 2;
              break;
            default:
              byteLen = 8;
          }

          const colBytes = byteLen * chunkRows;
          const buf = Buffer.allocUnsafe(colBytes);
          readSync(fd, buf, 0, colBytes, offset);
          offset += colBytes;
          colData = buf;
        }

        // 复制到结果数组
        const targetArr = data.get(col.name)!;
        for (let i = 0; i < chunkRows; i++) {
          switch (col.type) {
            case 'int64':
              targetArr[rowOffset + i] = colData.readBigInt64LE(i * 8);
              break;
            case 'float64':
              targetArr[rowOffset + i] = colData.readDoubleLE(i * 8);
              break;
            case 'int32':
              targetArr[rowOffset + i] = colData.readInt32LE(i * 4);
              break;
            case 'int16':
              targetArr[rowOffset + i] = colData.readInt16LE(i * 2);
              break;
            case 'string': {
              const dict = header.stringDicts?.[col.name];
              if (dict) {
                const id = colData.readInt32LE(i * 4);
                targetArr[rowOffset + i] = dict[id] || '';
              } else {
                targetArr[rowOffset + i] = '';
              }
              break;
            }
          }
        }
      }

      // 跳过 CRC
      offset += 4;
      rowOffset += chunkRows;
    }

    closeSync(fd);
    return { header, data };
  }

  /**
   * 只读取 header（不读取 chunk）
   */
  static readHeaderOnly(path: string): AppendFileHeader {
    const fd = openSync(path, 'r');
    try {
      const magicBuf = Buffer.allocUnsafe(4);
      readSync(fd, magicBuf, 0, 4, 0);
      if (!magicBuf.equals(MAGIC)) {
        throw new Error('Invalid file magic');
      }

      const lenBuf = Buffer.allocUnsafe(4);
      readSync(fd, lenBuf, 0, 4, 4);
      const headerLen = lenBuf.readUInt32LE();

      const headerBuf = Buffer.allocUnsafe(headerLen);
      readSync(fd, headerBuf, 0, headerLen, 8);
      return JSON.parse(headerBuf.toString());
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Alias for readHeaderOnly (for backward compatibility)
   */
  static readHeader(path: string): AppendFileHeader {
    return AppendWriter.readHeaderOnly(path);
  }

  /**
   * 读取最后一行（不展开全表；按 chunk 跳转到最后一个 chunk）
   */
  static readLastRow(path: string): Record<string, any> | null {
    const fd = openSync(path, 'r');

    const getByteLen = (t: string) => {
      switch (t) {
        case 'int64':
        case 'float64':
          return 8;
        case 'int32':
        case 'string': // string 存储为 int32 id
          return 4;
        case 'int16':
          return 2;
        default:
          return 8;
      }
    };

    try {
      // header
      const magicBuf = Buffer.allocUnsafe(4);
      readSync(fd, magicBuf, 0, 4, 0);
      if (!magicBuf.equals(MAGIC)) throw new Error('Invalid file magic');

      const lenBuf = Buffer.allocUnsafe(4);
      readSync(fd, lenBuf, 0, 4, 4);
      const headerLen = lenBuf.readUInt32LE();

      const headerBuf = Buffer.allocUnsafe(headerLen);
      readSync(fd, headerBuf, 0, headerLen, 8);
      const header: AppendFileHeader = JSON.parse(headerBuf.toString());

      if (header.totalRows === 0 || header.chunkCount === 0) return null;

      // Header 固定大小 4KB + 4 bytes CRC
      const RESERVED_HEADER_SIZE = 4096;
      let offset = RESERVED_HEADER_SIZE + 4;

      const compressionEnabled = header.compression?.enabled ?? false;

      // 走到最后一个 chunk
      for (let c = 0; c < header.chunkCount; c++) {
        const rcBuf = Buffer.allocUnsafe(4);
        readSync(fd, rcBuf, 0, 4, offset);
        const chunkRows = rcBuf.readUInt32LE();

        // 最后一个 chunk
        if (c === header.chunkCount - 1) {
          offset += 4;
          const out: Record<string, any> = {};

          for (const col of header.columns) {
            let colData: Buffer;

            if (compressionEnabled) {
              const lenBuf = Buffer.allocUnsafe(4);
              readSync(fd, lenBuf, 0, 4, offset);
              offset += 4;
              const colLen = lenBuf.readUInt32LE();

              const buf = Buffer.allocUnsafe(colLen);
              readSync(fd, buf, 0, colLen, offset);
              offset += colLen;

              const alg = header.compression!.algorithms[col.name];
              if (alg && alg !== 'none') {
                colData = AppendWriter.decompressColumn(buf, col.type, alg, chunkRows) ?? buf;
              } else {
                colData = buf;
              }
            } else {
              const byteLen = getByteLen(col.type);
              const colBytes = byteLen * chunkRows;
              const buf = Buffer.allocUnsafe(colBytes);
              readSync(fd, buf, 0, colBytes, offset);
              offset += colBytes;
              colData = buf;
            }

            // 取最后一行值
            const i = chunkRows - 1;
            switch (col.type) {
              case 'int64':
                out[col.name] = colData.readBigInt64LE(i * 8);
                break;
              case 'float64':
                out[col.name] = colData.readDoubleLE(i * 8);
                break;
              case 'int32':
                out[col.name] = colData.readInt32LE(i * 4);
                break;
              case 'int16':
                out[col.name] = colData.readInt16LE(i * 2);
                break;
              case 'string': {
                const id = colData.readInt32LE(i * 4);
                const dict = header.stringDicts?.[col.name];
                out[col.name] = dict ? (dict[id] || '') : '';
                break;
              }
              default:
                out[col.name] = colData.readDoubleLE(i * 8);
            }
          }

          return out;
        }

        // 跳过当前 chunk
        offset += 4;

        if (compressionEnabled) {
          for (const col of header.columns) {
            const lenBuf = Buffer.allocUnsafe(4);
            readSync(fd, lenBuf, 0, 4, offset);
            offset += 4;
            const colLen = lenBuf.readUInt32LE();
            offset += colLen;
          }
        } else {
          let chunkDataBytes = 0;
          for (const col of header.columns) {
            chunkDataBytes += getByteLen(col.type) * chunkRows;
          }
          offset += chunkDataBytes;
        }

        offset += 4; // chunk CRC
      }

      return null;
    } finally {
      closeSync(fd);
    }
  }

  // (types moved to top-level)

  // (types moved to top-level)

  /**
   * Rewrite/Compact：读取旧文件 → 逐行 transform → 写入新文件 → 原子替换。
   *
   * - transform 返回 null 表示删除该行
   * - transform 返回新 row 表示保留/更新
   */
  static rewrite(
    path: string,
    transform: (row: Record<string, any>, index: number) => Record<string, any> | null,
    options: AppendRewriteOptions = {}
  ): AppendRewriteResult {
    // 兼容：需要旧行为时可强制 readAll（调试/小文件）
    if (options.mode === 'readAll') {
      if (!existsSync(path)) {
        return { beforeRows: 0, afterRows: 0, deletedRows: 0, chunksWritten: 0 };
      }

      const { header, data } = AppendWriter.readAll(path);
      const beforeRows = header.totalRows;

      const tmpPath = options.tmpPath || `${path}.tmp`;
      const backupPath = options.backupPath || `${path}.bak`;
      const batchSize = options.batchSize ?? 10_000;

      try {
        if (existsSync(tmpPath)) rmSync(tmpPath);
      } catch {}
      try {
        if (existsSync(backupPath)) rmSync(backupPath);
      } catch {}

      const writer = new AppendWriter(tmpPath, header.columns, {
        compression: header.compression,
      });
      writer.open();

      let deletedRows = 0;
      let afterRows = 0;
      let chunksWritten = 0;

      const batch: Record<string, any>[] = [];

      for (let i = 0; i < beforeRows; i++) {
        const row: Record<string, any> = {};
        for (const col of header.columns) {
          const arr = data.get(col.name) as any;
          row[col.name] = arr ? arr[i] : undefined;
        }

        const out = transform(row, i);
        if (out == null) {
          deletedRows++;
          continue;
        }

        batch.push(out);
        afterRows++;

        if (batch.length >= batchSize) {
          writer.append(batch);
          chunksWritten++;
          batch.length = 0;
        }
      }

      if (batch.length > 0) {
        writer.append(batch);
        chunksWritten++;
      }

      writer.close();

      // 原子替换：path -> bak, tmp -> path
      if (existsSync(path)) renameSync(path, backupPath);
      renameSync(tmpPath, path);

      if (!options.keepBackup) {
        try {
          if (existsSync(backupPath)) rmSync(backupPath);
        } catch {}
      }

      return { beforeRows, afterRows, deletedRows, chunksWritten };
    }

    return AppendWriter.rewriteStreaming(path, transform, options);
  }

  /**
   * rewrite 的 streaming 实现：不展开全表（按 chunk 读取），同时可自然“compact”（把旧 chunk 合并成更大的 chunk）。
   */
  static rewriteStreaming(
    path: string,
    transform: (row: Record<string, any>, index: number) => Record<string, any> | null,
    options: AppendRewriteOptions = {}
  ): AppendRewriteResult {
    if (!existsSync(path)) {
      return { beforeRows: 0, afterRows: 0, deletedRows: 0, chunksWritten: 0 };
    }

    const fd = openSync(path, 'r');

    const getByteLen = (t: string) => {
      switch (t) {
        case 'int64':
        case 'float64':
          return 8;
        case 'int32':
        case 'string': // string 存储为 int32 id
          return 4;
        case 'int16':
          return 2;
        default:
          return 8;
      }
    };

    const readValue = (t: string, buf: Buffer, offset: number, stringDict?: string[]) => {
      switch (t) {
        case 'int64':
          return buf.readBigInt64LE(offset);
        case 'float64':
          return buf.readDoubleLE(offset);
        case 'int32':
          return buf.readInt32LE(offset);
        case 'int16':
          return buf.readInt16LE(offset);
        case 'string': {
          const id = buf.readInt32LE(offset);
          return stringDict ? (stringDict[id] || '') : '';
        }
        default:
          return buf.readDoubleLE(offset);
      }
    };

    try {
      // header
      const magicBuf = Buffer.allocUnsafe(4);
      readSync(fd, magicBuf, 0, 4, 0);
      if (!magicBuf.equals(MAGIC)) throw new Error('Invalid file magic');

      const lenBuf = Buffer.allocUnsafe(4);
      readSync(fd, lenBuf, 0, 4, 4);
      const headerLen = lenBuf.readUInt32LE();

      const headerBuf = Buffer.allocUnsafe(headerLen);
      readSync(fd, headerBuf, 0, headerLen, 8);
      const header: AppendFileHeader = JSON.parse(headerBuf.toString());

      const beforeRows = header.totalRows;
      const compressionEnabled = header.compression?.enabled ?? false;

      // Header 固定大小 4KB + 4 bytes CRC
      const RESERVED_HEADER_SIZE = 4096;
      let offset = RESERVED_HEADER_SIZE + 4;

      const tmpPath = options.tmpPath || `${path}.tmp`;
      const backupPath = options.backupPath || `${path}.bak`;
      const batchSize = options.batchSize ?? 10_000;

      try {
        if (existsSync(tmpPath)) rmSync(tmpPath);
      } catch {}
      try {
        if (existsSync(backupPath)) rmSync(backupPath);
      } catch {}

      const writer = new AppendWriter(tmpPath, header.columns, {
        compression: header.compression,
      });
      writer.open();

      let deletedRows = 0;
      let afterRows = 0;
      let chunksWritten = 0;
      const batch: Record<string, any>[] = [];

      let globalIndex = 0;

      for (let c = 0; c < header.chunkCount; c++) {
        const rcBuf = Buffer.allocUnsafe(4);
        readSync(fd, rcBuf, 0, 4, offset);
        const chunkRows = rcBuf.readUInt32LE();
        offset += 4;

        const colBufs: Buffer[] = [];
        const colByteLens: number[] = [];

        for (const col of header.columns) {
          const byteLen = getByteLen(col.type);

          if (compressionEnabled) {
            const lenBuf2 = Buffer.allocUnsafe(4);
            readSync(fd, lenBuf2, 0, 4, offset);
            offset += 4;
            const colLen = lenBuf2.readUInt32LE();

            const buf = Buffer.allocUnsafe(colLen);
            if (buf.length > 0) {
              readSync(fd, buf, 0, buf.length, offset);
            }
            offset += buf.length;

            const alg = header.compression!.algorithms[col.name];
            const outBuf = alg && alg !== 'none'
              ? (AppendWriter.decompressColumn(buf, col.type, alg, chunkRows) ?? buf)
              : buf;

            colBufs.push(outBuf);
            colByteLens.push(byteLen);
          } else {
            const buf = Buffer.allocUnsafe(byteLen * chunkRows);
            if (buf.length > 0) {
              readSync(fd, buf, 0, buf.length, offset);
            }
            offset += buf.length;
            colBufs.push(buf);
            colByteLens.push(byteLen);
          }
        }

        // skip chunk CRC
        offset += 4;

        for (let i = 0; i < chunkRows; i++) {
          const row: Record<string, any> = {};
          for (let k = 0; k < header.columns.length; k++) {
            const col = header.columns[k];
            const byteLen = colByteLens[k];
            const buf = colBufs[k];
            const stringDict = col.type === 'string' ? header.stringDicts?.[col.name] : undefined;
            row[col.name] = readValue(col.type, buf, i * byteLen, stringDict);
          }

          const out = transform(row, globalIndex);
          globalIndex++;

          if (out == null) {
            deletedRows++;
            continue;
          }

          batch.push(out);
          afterRows++;

          if (batch.length >= batchSize) {
            writer.append(batch);
            chunksWritten++;
            batch.length = 0;
          }
        }
      }

      if (batch.length > 0) {
        writer.append(batch);
        chunksWritten++;
      }

      writer.close();

      // 原子替换：path -> bak, tmp -> path
      if (existsSync(path)) renameSync(path, backupPath);
      renameSync(tmpPath, path);

      if (!options.keepBackup) {
        try {
          if (existsSync(backupPath)) rmSync(backupPath);
        } catch {}
      }

      return { beforeRows, afterRows, deletedRows, chunksWritten };
    } finally {
      closeSync(fd);
    }
  }

  static deleteWhere(
    path: string,
    predicate: (row: Record<string, any>, index: number) => boolean,
    options: AppendRewriteOptions = {}
  ): AppendRewriteResult {
    return AppendWriter.rewrite(
      path,
      (row, i) => (predicate(row, i) ? null : row),
      options
    );
  }

  static updateWhere(
    path: string,
    predicate: (row: Record<string, any>, index: number) => boolean,
    patchOrUpdater: Partial<Record<string, any>> | ((row: Record<string, any>) => Partial<Record<string, any>>),
    options: AppendRewriteOptions = {}
  ): AppendRewriteResult {
    const isFn = typeof patchOrUpdater === 'function';
    return AppendWriter.rewrite(
      path,
      (row, i) => {
        if (!predicate(row, i)) return row;
        const patch = isFn ? (patchOrUpdater as any)(row) : patchOrUpdater;
        return { ...row, ...patch };
      },
      options
    );
  }

  /**
   * 验证文件完整性 (所有 CRC32)
   */
  static verify(path: string): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    const fd = openSync(path, 'r');
    const stat = fstatSync(fd);

    try {
      // 验证 magic
      const magicBuf = Buffer.allocUnsafe(4);
      readSync(fd, magicBuf, 0, 4, 0);
      if (!magicBuf.equals(MAGIC)) {
        errors.push('Invalid magic');
        return { ok: false, errors };
      }

      // 读取 header
      const lenBuf = Buffer.allocUnsafe(4);
      readSync(fd, lenBuf, 0, 4, 4);
      const headerLen = lenBuf.readUInt32LE();

      // Header 固定大小 4KB
      const RESERVED_HEADER_SIZE = 4096;
      const headerBlockSize = RESERVED_HEADER_SIZE;

      // 验证 header CRC
      const headerBlock = Buffer.allocUnsafe(headerBlockSize);
      readSync(fd, headerBlock, 0, headerBlockSize, 0);
      const expectedHeaderCrc = Buffer.allocUnsafe(4);
      readSync(fd, expectedHeaderCrc, 0, 4, headerBlockSize);
      const actualHeaderCrc = crc32(new Uint8Array(headerBlock.buffer, headerBlock.byteOffset, headerBlock.byteLength));

      if (expectedHeaderCrc.readUInt32LE() !== actualHeaderCrc) {
        errors.push(`Header CRC mismatch: expected ${expectedHeaderCrc.readUInt32LE()}, got ${actualHeaderCrc}`);
      }

      // 读取 header JSON
      const headerBuf = Buffer.allocUnsafe(headerLen);
      readSync(fd, headerBuf, 0, headerLen, 8);
      const header: AppendFileHeader = JSON.parse(headerBuf.toString());

      // 验证每个 chunk 的 CRC
      const compressionEnabled = header.compression?.enabled ?? false;

      let offset = headerBlockSize + 4;
      for (let c = 0; c < header.chunkCount; c++) {
        const rcBuf = Buffer.allocUnsafe(4);
        readSync(fd, rcBuf, 0, 4, offset);
        const chunkRows = rcBuf.readUInt32LE();

        let chunkDataSize = 4; // row count

        if (compressionEnabled) {
          // 先读取每列长度以计算 chunkDataSize
          let tmp = offset + 4;
          for (const col of header.columns) {
            const lenBuf2 = Buffer.allocUnsafe(4);
            readSync(fd, lenBuf2, 0, 4, tmp);
            const colLen = lenBuf2.readUInt32LE();
            tmp += 4 + colLen;
            chunkDataSize += 4 + colLen;
          }
        } else {
          for (const col of header.columns) {
            let byteLen: number;
            switch (col.type) {
              case 'int64':
              case 'float64':
                byteLen = 8;
                break;
              case 'int32':
              case 'string':
                byteLen = 4;
                break;
              case 'int16':
                byteLen = 2;
                break;
              default:
                byteLen = 8;
            }
            chunkDataSize += byteLen * chunkRows;
          }
        }

        const chunkBuf = Buffer.allocUnsafe(chunkDataSize);
        readSync(fd, chunkBuf, 0, chunkDataSize, offset);

        const expectedCrc = Buffer.allocUnsafe(4);
        readSync(fd, expectedCrc, 0, 4, offset + chunkDataSize);
        const actualCrc = crc32(new Uint8Array(chunkBuf.buffer, chunkBuf.byteOffset, chunkBuf.byteLength));

        if (expectedCrc.readUInt32LE() !== actualCrc) {
          errors.push(`Chunk ${c} CRC mismatch: expected ${expectedCrc.readUInt32LE()}, got ${actualCrc}`);
        }

        offset += chunkDataSize + 4;
      }
    } finally {
      closeSync(fd);
    }

    return { ok: errors.length === 0, errors };
  }
}
