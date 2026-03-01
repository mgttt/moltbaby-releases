// ============================================================
// Tombstone 管理 - 延迟删除 + compact
// 使用独立 .tomb 文件存储已删除行号（RoaringBitmap 压缩）
// ============================================================

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { RoaringBitmap } from './index/bitmap.js';

/**
 * Tombstone 管理器
 * 
 * 文件格式：
 * ┌─────────────────────────────┐
 * │ Magic: "TOMB" (4 bytes)     │
 * │ Version: 1 (4 bytes LE)     │
 * │ Bitmap size (4 bytes LE)    │
 * │ Bitmap data (serialized)    │
 * └─────────────────────────────┘
 */
export class TombstoneManager {
  private bitmap: RoaringBitmap;
  private filePath: string;
  private dirty: boolean = false;

  constructor(dataFilePath: string) {
    this.filePath = dataFilePath + '.tomb';
    this.bitmap = new RoaringBitmap();
    this.load();
  }

  /**
   * 标记行为已删除
   */
  markDeleted(rowIndex: number): void {
    this.bitmap.add(rowIndex);
    this.dirty = true;
  }

  /**
   * 批量标记删除
   */
  markDeletedBatch(rowIndices: number[]): void {
    for (const idx of rowIndices) {
      this.bitmap.add(idx);
    }
    this.dirty = true;
  }

  /**
   * 检查行是否已删除
   */
  isDeleted(rowIndex: number): boolean {
    return this.bitmap.contains(rowIndex);
  }

  /**
   * 获取所有已删除行号
   */
  getDeletedRows(): number[] {
    return this.bitmap.toArray();
  }

  /**
   * 获取已删除行数
   */
  getDeletedCount(): number {
    return this.bitmap.getCardinality();
  }

  /**
   * 清空 tombstone（compact 后调用）
   */
  clear(): void {
    this.bitmap = new RoaringBitmap();
    this.dirty = true;
  }

  /**
   * 保存到文件
   */
  save(): void {
    if (!this.dirty) return;

    const magic = Buffer.from('TOMB');
    const version = Buffer.allocUnsafe(4);
    version.writeUInt32LE(1, 0);

    // 序列化 bitmap
    const bitmapData = this.serializeBitmap();
    const size = Buffer.allocUnsafe(4);
    size.writeUInt32LE(bitmapData.length, 0);

    const buf = Buffer.concat([magic, version, size, bitmapData]);
    writeFileSync(this.filePath, buf);
    this.dirty = false;
  }

  /**
   * 从文件加载
   */
  private load(): void {
    if (!existsSync(this.filePath)) return;

    try {
      const buf = readFileSync(this.filePath);
      if (buf.length < 12) return;

      // 验证 magic
      const magic = buf.subarray(0, 4);
      if (magic.toString() !== 'TOMB') return;

      // 读取版本
      const version = buf.readUInt32LE(4);
      if (version !== 1) {
        console.warn(`Unknown tombstone version: ${version}`);
        return;
      }

      // 读取 bitmap
      const size = buf.readUInt32LE(8);
      const bitmapData = buf.subarray(12, 12 + size);
      this.bitmap = this.deserializeBitmap(bitmapData);
    } catch (err) {
      console.warn('Failed to load tombstone file:', err);
    }
  }

  /**
   * 删除 tombstone 文件
   */
  delete(): void {
    if (existsSync(this.filePath)) {
      unlinkSync(this.filePath);
    }
    this.bitmap = new RoaringBitmap();
    this.dirty = false;
  }

  /**
   * 序列化 bitmap（简单格式：行数组）
   */
  private serializeBitmap(): Buffer {
    const rows = this.bitmap.toArray();
    const buf = Buffer.allocUnsafe(4 + rows.length * 4);
    buf.writeUInt32LE(rows.length, 0);
    
    for (let i = 0; i < rows.length; i++) {
      buf.writeUInt32LE(rows[i], 4 + i * 4);
    }
    
    return buf;
  }

  /**
   * 反序列化 bitmap
   */
  private deserializeBitmap(buf: Buffer): RoaringBitmap {
    const bitmap = new RoaringBitmap();
    if (buf.length < 4) return bitmap;

    const count = buf.readUInt32LE(0);
    for (let i = 0; i < count && (4 + i * 4 + 4) <= buf.length; i++) {
      const rowIndex = buf.readUInt32LE(4 + i * 4);
      bitmap.add(rowIndex);
    }

    return bitmap;
  }
}
