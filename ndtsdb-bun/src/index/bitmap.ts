// ============================================================
// Bitmap 索引 - 适合低基数列（如 symbol、status）
// 空间效率高，支持快速 AND/OR 查询
// ============================================================

import { ColumnarTable } from './columnar.js';

/**
 * Roaring Bitmap 简化版
 * 压缩存储稀疏位图
 */
export class RoaringBitmap {
  private containers: Map<number, Uint16Array> = new Map();

  /**
   * 添加值
   */
  add(value: number): void {
    const high = value >>> 16;
    const low = value & 0xFFFF;
    
    let container = this.containers.get(high);
    if (!container) {
      container = new Uint16Array(0);
      this.containers.set(high, container);
    }
    
    // 检查是否已存在
    if (!this.contains(value)) {
      // 扩展数组并插入（保持有序）
      const newContainer = new Uint16Array(container.length + 1);
      let inserted = false;
      let j = 0;
      
      for (let i = 0; i < container.length; i++) {
        if (!inserted && container[i] > low) {
          newContainer[j++] = low;
          inserted = true;
        }
        newContainer[j++] = container[i];
      }
      
      if (!inserted) {
        newContainer[j] = low;
      }
      
      this.containers.set(high, newContainer);
    }
  }

  /**
   * 检查是否包含
   */
  contains(value: number): boolean {
    const high = value >>> 16;
    const low = value & 0xFFFF;
    
    const container = this.containers.get(high);
    if (!container) return false;
    
    // 二分查找
    let left = 0, right = container.length - 1;
    while (left <= right) {
      const mid = (left + right) >>> 1;
      if (container[mid] === low) return true;
      if (container[mid] < low) left = mid + 1;
      else right = mid - 1;
    }
    return false;
  }

  /**
   * AND 操作
   */
  and(other: RoaringBitmap): RoaringBitmap {
    const result = new RoaringBitmap();
    
    for (const [high, container1] of this.containers) {
      const container2 = other.containers.get(high);
      if (container2) {
        // 交集
        const intersection: number[] = [];
        let i = 0, j = 0;
        
        while (i < container1.length && j < container2.length) {
          if (container1[i] === container2[j]) {
            intersection.push(container1[i]);
            i++;
            j++;
          } else if (container1[i] < container2[j]) {
            i++;
          } else {
            j++;
          }
        }
        
        if (intersection.length > 0) {
          result.containers.set(high, new Uint16Array(intersection));
        }
      }
    }
    
    return result;
  }

  /**
   * OR 操作
   */
  or(other: RoaringBitmap): RoaringBitmap {
    const result = new RoaringBitmap();
    
    // 复制所有容器
    for (const [high, container] of this.containers) {
      result.containers.set(high, new Uint16Array(container));
    }
    
    // 合并
    for (const [high, container2] of other.containers) {
      const container1 = result.containers.get(high);
      if (container1) {
        // 合并两个有序数组
        const merged: number[] = [];
        let i = 0, j = 0;
        
        while (i < container1.length && j < container2.length) {
          if (container1[i] === container2[j]) {
            merged.push(container1[i]);
            i++;
            j++;
          } else if (container1[i] < container2[j]) {
            merged.push(container1[i]);
            i++;
          } else {
            merged.push(container2[j]);
            j++;
          }
        }
        
        while (i < container1.length) merged.push(container1[i++]);
        while (j < container2.length) merged.push(container2[j++]);
        
        result.containers.set(high, new Uint16Array(merged));
      } else {
        result.containers.set(high, new Uint16Array(container2));
      }
    }
    
    return result;
  }

  /**
   * 获取所有值
   */
  toArray(): number[] {
    const result: number[] = [];
    
    for (const [high, container] of this.containers) {
      for (const low of container) {
        result.push((high << 16) | low);
      }
    }
    
    return result.sort((a, b) => a - b);
  }

  /**
   * 获取基数（唯一值数量）
   */
  getCardinality(): number {
    let count = 0;
    for (const container of this.containers.values()) {
      count += container.length;
    }
    return count;
  }

  /**
   * 序列化
   */
  serialize(): Uint8Array {
    const parts: Uint8Array[] = [];
    
    // 容器数量
    const header = new DataView(new ArrayBuffer(4));
    header.setUint32(0, this.containers.size, true);
    parts.push(new Uint8Array(header.buffer));
    
    for (const [high, container] of this.containers) {
      // high key
      const highBytes = new DataView(new ArrayBuffer(4));
      highBytes.setUint32(0, high, true);
      parts.push(new Uint8Array(highBytes.buffer));
      
      // 容器大小
      const sizeBytes = new DataView(new ArrayBuffer(2));
      sizeBytes.setUint16(0, container.length, true);
      parts.push(new Uint8Array(sizeBytes.buffer));
      
      // 容器数据
      parts.push(new Uint8Array(container.buffer));
    }
    
    // 合并
    const totalSize = parts.reduce((sum, p) => sum + p.length, 0);
    const result = new Uint8Array(totalSize);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    
    return result;
  }

  /**
   * 反序列化
   */
  static deserialize(buffer: Uint8Array): RoaringBitmap {
    const bitmap = new RoaringBitmap();
    const view = new DataView(buffer.buffer);
    let offset = 0;
    
    const containerCount = view.getUint32(offset, true);
    offset += 4;
    
    for (let i = 0; i < containerCount; i++) {
      const high = view.getUint32(offset, true);
      offset += 4;
      
      const size = view.getUint16(offset, true);
      offset += 2;
      
      const container = new Uint16Array(buffer.buffer, offset, size);
      bitmap.containers.set(high, new Uint16Array(container)); // 复制
      offset += size * 2;
    }
    
    return bitmap;
  }
}

/**
 * Bitmap 索引管理器
 */
export class BitmapIndex {
  private columnName: string;
  private valueToBitmap: Map<string | number, RoaringBitmap> = new Map();
  private allValues: Set<string | number> = new Set();

  constructor(columnName: string) {
    this.columnName = columnName;
  }

  /**
   * 从列数据构建索引
   */
  build(column: Int32Array | Float64Array | BigInt64Array): void {
    this.valueToBitmap.clear();
    this.allValues.clear();

    for (let i = 0; i < column.length; i++) {
      const value = column[i];
      const key = typeof value === 'bigint' ? Number(value) : value;
      
      this.allValues.add(key);
      
      let bitmap = this.valueToBitmap.get(key);
      if (!bitmap) {
        bitmap = new RoaringBitmap();
        this.valueToBitmap.set(key, bitmap);
      }
      
      bitmap.add(i);
    }
  }

  /**
   * 查询单个值
   */
  query(value: string | number): number[] {
    const bitmap = this.valueToBitmap.get(value);
    return bitmap ? bitmap.toArray() : [];
  }

  /**
   * 查询多个值 (OR)
   */
  queryAny(values: (string | number)[]): number[] {
    if (values.length === 0) return [];
    
    let result: RoaringBitmap | null = null;
    
    for (const value of values) {
      const bitmap = this.valueToBitmap.get(value);
      if (bitmap) {
        result = result ? result.or(bitmap) : bitmap;
      }
    }
    
    return result ? result.toArray() : [];
  }

  /**
   * 获取所有唯一值
   */
  getUniqueValues(): (string | number)[] {
    return Array.from(this.allValues);
  }

  /**
   * 获取索引大小（内存占用估算）
   */
  getSize(): number {
    let size = 0;
    for (const bitmap of this.valueToBitmap.values()) {
      size += bitmap.getCardinality() * 4; // 粗略估计
    }
    return size;
  }
}

/**
 * 索引管理器
 */
export class IndexManager {
  private indexes: Map<string, BitmapIndex> = new Map();
  private table: ColumnarTable;

  constructor(table: ColumnarTable) {
    this.table = table;
  }

  /**
   * 为列创建 Bitmap 索引
   */
  createBitmapIndex(columnName: string): void {
    const column = this.table.getColumn(columnName);
    if (!column) {
      throw new Error(`Column not found: ${columnName}`);
    }

    const index = new BitmapIndex(columnName);
    index.build(column as any);
    
    this.indexes.set(columnName, index);
    
    console.log(`✅ Created bitmap index on ${columnName}`);
    console.log(`   Unique values: ${index.getUniqueValues().length}`);
    console.log(`   Index size: ${(index.getSize() / 1024).toFixed(2)} KB`);
  }

  /**
   * 使用索引查询
   */
  query(columnName: string, value: string | number): number[] {
    const index = this.indexes.get(columnName);
    if (!index) {
      // 回退到全表扫描
      return this.fullTableScan(columnName, value);
    }
    
    return index.query(value);
  }

  /**
   * 全表扫描（回退）
   */
  private fullTableScan(columnName: string, value: string | number): number[] {
    const column = this.table.getColumn(columnName);
    if (!column) return [];
    
    const indices: number[] = [];
    for (let i = 0; i < column.length; i++) {
      if (column[i] === value || Number(column[i]) === value) {
        indices.push(i);
      }
    }
    return indices;
  }

  /**
   * 获取索引
   */
  getIndex(columnName: string): BitmapIndex | undefined {
    return this.indexes.get(columnName);
  }

  /**
   * 列出所有索引
   */
  listIndexes(): string[] {
    return Array.from(this.indexes.keys());
  }
}
