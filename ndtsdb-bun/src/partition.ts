// ============================================================
// 分区表管理 - 按时间/symbol 自动分区
// ============================================================

import { AppendWriter, type AppendWriterOptions } from './append-ffi.js';
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';

/**
 * 分区策略
 */
export type PartitionStrategy =
  | { type: 'time'; column: string; interval: 'day' | 'month' | 'year' }
  | { type: 'range'; column: string; ranges: Array<{ min: number; max: number; label: string }> }
  | { type: 'hash'; column: string; buckets: number };

/**
 * 分区元数据
 */
export interface PartitionMeta {
  label: string; // 分区标识（如 "2024-01"）
  path: string; // 分区文件路径
  minValue?: bigint | number; // 分区最小值（时间/范围分区）
  maxValue?: bigint | number; // 分区最大值
  rows: number; // 分区行数
  createdAt: number; // 创建时间
  
  // 列最大值缓存（用于优化 getMax 查询）
  columnMaxCache?: Map<string, Map<any, bigint | number>>; // column → (filterKey → maxValue)
}

/**
 * 分区表管理器
 */
export class PartitionedTable {
  private basePath: string;
  private columns: Array<{ name: string; type: string }>;
  private strategy: PartitionStrategy;
  private options?: AppendWriterOptions;
  private partitions: Map<string, PartitionMeta> = new Map();
  private writers: Map<string, AppendWriter> = new Map();
  
  // 分组最大值索引（仅哈希分区）
  // 结构: partitionLabel → hashValue → column → maxValue
  private groupMaxIndex: Map<string, Map<any, Map<string, bigint | number>>> = new Map();

  constructor(
    basePath: string,
    columns: Array<{ name: string; type: string }>,
    strategy: PartitionStrategy,
    options?: AppendWriterOptions
  ) {
    this.basePath = basePath;
    this.columns = columns;
    this.strategy = strategy;
    this.options = options;

    // 确保基础目录存在
    if (!existsSync(basePath)) {
      mkdirSync(basePath, { recursive: true });
    }

    // 加载已有分区
    this.loadPartitions();
  }

  /**
   * 加载已有分区元数据
   */
  private loadPartitions(): void {
    if (!existsSync(this.basePath)) return;

    const files = readdirSync(this.basePath).filter(f => f.endsWith('.ndts'));

    for (const file of files) {
      const path = join(this.basePath, file);
      const label = file.replace('.ndts', '');

      try {
        const header = AppendWriter.readHeader(path);
        const stat = statSync(path);

        this.partitions.set(label, {
          label,
          path,
          rows: header.totalRows,
          createdAt: stat.birthtimeMs,
        });
      } catch (e) {
        console.warn(`Failed to load partition ${label}:`, e);
      }
    }

    console.log(`[PartitionedTable] Loaded ${this.partitions.size} partitions`);
  }

  /**
   * 根据策略确定分区标签
   */
  private getPartitionLabel(row: Record<string, any>): string {
    switch (this.strategy.type) {
      case 'time': {
        const colValue = row[this.strategy.column];
        const timestamp = typeof colValue === 'bigint' ? Number(colValue) : colValue;
        const date = new Date(timestamp);

        switch (this.strategy.interval) {
          case 'day':
            return date.toISOString().slice(0, 10); // YYYY-MM-DD
          case 'month':
            return date.toISOString().slice(0, 7); // YYYY-MM
          case 'year':
            return date.toISOString().slice(0, 4); // YYYY
        }
        break;
      }

      case 'range': {
        const colValue = Number(row[this.strategy.column]);
        for (const range of this.strategy.ranges) {
          if (colValue >= range.min && colValue < range.max) {
            return range.label;
          }
        }
        return 'default';
      }

      case 'hash': {
        const colValue = String(row[this.strategy.column]);
        const hash = this.simpleHash(colValue);
        const bucket = hash % this.strategy.buckets;
        return `bucket-${bucket}`;
      }
    }

    return 'default';
  }

  /**
   * 简单哈希函数
   */
  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  /**
   * 获取分区的 AppendWriter（自动创建）
   */
  private getWriter(label: string): AppendWriter {
    if (this.writers.has(label)) {
      return this.writers.get(label)!;
    }

    const path = join(this.basePath, `${label}.ndts`);
    const writer = new AppendWriter(path, this.columns, this.options);

    const isNew = !existsSync(path);
    writer.open(); // open() 会自动创建文件如果不存在

    if (isNew) {
      this.partitions.set(label, {
        label,
        path,
        rows: 0,
        createdAt: Date.now(),
      });
    }

    this.writers.set(label, writer);
    return writer;
  }

  /**
   * 写入数据（自动分区）
   */
  append(rows: Record<string, any>[]): void {
    // 按分区分组
    const groups = new Map<string, Record<string, any>[]>();

    for (const row of rows) {
      const label = this.getPartitionLabel(row);
      if (!groups.has(label)) {
        groups.set(label, []);
      }
      groups.get(label)!.push(row);
    }

    // 写入各分区
    for (const [label, partitionRows] of groups) {
      const writer = this.getWriter(label);
      writer.append(partitionRows);

      // 更新元数据
      const meta = this.partitions.get(label)!;
      meta.rows += partitionRows.length;
      
      // 更新分组最大值索引（仅哈希分区）
      if (this.strategy.type === 'hash') {
        this.updateGroupMaxIndex(label, partitionRows);
      }
    }
  }
  
  /**
   * 更新分组最大值索引（哈希分区专用）
   */
  private updateGroupMaxIndex(label: string, rows: Record<string, any>[]): void {
    if (this.strategy.type !== 'hash') return;
    
    const hashColumn = this.strategy.column;
    
    // 确保分区索引存在
    if (!this.groupMaxIndex.has(label)) {
      this.groupMaxIndex.set(label, new Map());
    }
    const partitionIndex = this.groupMaxIndex.get(label)!;
    
    // 遍历行，更新每个 hashValue 的最大值
    for (const row of rows) {
      const hashValue = row[hashColumn];
      if (hashValue === undefined || hashValue === null) continue;
      
      // 确保 hashValue 的索引存在
      if (!partitionIndex.has(hashValue)) {
        partitionIndex.set(hashValue, new Map());
      }
      const groupIndex = partitionIndex.get(hashValue)!;
      
      // 更新每个列的最大值
      for (const col of this.columns) {
        const value = row[col.name];
        if (value === undefined || value === null) continue;
        
        // 只为数值列建立索引
        if (typeof value !== 'number' && typeof value !== 'bigint') continue;
        
        const currentMax = groupIndex.get(col.name);
        if (currentMax === undefined) {
          groupIndex.set(col.name, value);
        } else {
          // 比较并更新
          if (typeof value === 'bigint' && typeof currentMax === 'bigint') {
            if (value > currentMax) groupIndex.set(col.name, value);
          } else {
            const v1 = typeof currentMax === 'bigint' ? Number(currentMax) : currentMax;
            const v2 = typeof value === 'bigint' ? Number(value) : value;
            if (v2 > v1) groupIndex.set(col.name, value);
          }
        }
      }
    }
  }

  /**
   * 查询（跨分区）
   * @param filter 行过滤函数
   * @param options 查询选项
   *   - timeRange: 时间范围过滤（用于分区裁剪）
   *   - limit: 最大返回行数（提前退出优化）
   *   - reverse: 倒序扫描（查最新数据时从尾部开始）
   */
  query(
    filter?: (row: Record<string, any>) => boolean,
    options?: {
      timeRange?: { min?: number | bigint; max?: number | bigint };
      limit?: number;
      reverse?: boolean;
    }
  ): Array<Record<string, any>> {
    const results: Array<Record<string, any>> = [];
    const limit = options?.limit;
    const reverse = options?.reverse || false;
    const timeRange = options?.timeRange;

    // 智能分区过滤（仅扫描时间范围内的分区）
    let partitionsToScan = Array.from(this.partitions.values());

    if (timeRange && this.strategy.type === 'time') {
      partitionsToScan = this.filterPartitionsByTimeRange(timeRange);
    }

    // 倒序扫描时反转分区顺序
    if (reverse) {
      partitionsToScan.reverse();
    }

    // 时间范围过滤（行级）
    const timeMin = timeRange?.min ? Number(timeRange.min) : -Infinity;
    const timeMax = timeRange?.max ? Number(timeRange.max) : Infinity;
    const timeColumn = this.strategy.type === 'time' ? this.strategy.column : null;

    // 扫描分区
    for (const meta of partitionsToScan) {
      const { header, data } = AppendWriter.readAll(meta.path);

      // 确定扫描顺序
      const startIdx = reverse ? header.totalRows - 1 : 0;
      const endIdx = reverse ? -1 : header.totalRows;
      const step = reverse ? -1 : 1;

      for (let i = startIdx; reverse ? i > endIdx : i < endIdx; i += step) {
        const row: Record<string, any> = {};
        for (const [colName, colData] of data) {
          row[colName] = (colData as any)[i];
        }

        // 行级 timeRange 过滤（时间分区专用）
        if (timeRange && timeColumn) {
          const rowTime = Number(row[timeColumn]);
          if (rowTime < timeMin || rowTime >= timeMax) {
            continue; // 跳过不在时间范围内的行
          }
        }

        if (!filter || filter(row)) {
          results.push(row);

          // 提前退出优化
          if (limit && results.length >= limit) {
            return results;
          }
        }
      }

      // 提前退出（跨分区）
      if (limit && results.length >= limit) {
        return results;
      }
    }

    return results;
  }

  /**
   * 根据时间范围过滤分区
   */
  private filterPartitionsByTimeRange(timeRange: { min?: number | bigint; max?: number | bigint }): PartitionMeta[] {
    if (this.strategy.type !== 'time') {
      return Array.from(this.partitions.values());
    }

    const min = timeRange.min ? Number(timeRange.min) : -Infinity;
    const max = timeRange.max ? Number(timeRange.max) : Infinity;

    const filtered = Array.from(this.partitions.values()).filter((meta) => {
      // 从分区标签推断时间范围
      const partitionTime = this.getPartitionTimeRange(meta.label);
      if (!partitionTime) return true; // 无法推断，保留

      // 检查分区时间范围是否与查询范围重叠
      const overlaps = !(partitionTime.max < min || partitionTime.min > max);
      
      return overlaps;
    });

    return filtered;
  }

  /**
   * 从分区标签推断时间范围
   */
  private getPartitionTimeRange(label: string): { min: number; max: number } | null {
    if (this.strategy.type !== 'time') return null;

    try {
      switch (this.strategy.interval) {
        case 'day': {
          // label 格式: YYYY-MM-DD
          const date = new Date(label);
          const min = date.getTime();
          const max = min + 24 * 60 * 60 * 1000 - 1;
          return { min, max };
        }

        case 'month': {
          // label 格式: YYYY-MM
          const [year, month] = label.split('-').map(Number);
          const min = new Date(year, month - 1, 1).getTime();
          const max = new Date(year, month, 0, 23, 59, 59, 999).getTime();
          return { min, max };
        }

        case 'year': {
          // label 格式: YYYY
          const year = parseInt(label);
          const min = new Date(year, 0, 1).getTime();
          const max = new Date(year, 11, 31, 23, 59, 59, 999).getTime();
          return { min, max };
        }
      }
    } catch {
      return null;
    }

    return null;
  }

  /**
   * 获取所有分区元数据
   */
  getPartitions(): PartitionMeta[] {
    return Array.from(this.partitions.values());
  }

  /**
   * 获取指定列的最大值（高效实现，避免全表扫描）
   * 
   * 优化策略：
   * 1. 时间分区：只扫描最新分区
   * 2. 哈希分区 + partitionHint：先查索引（O(1)），缓存未命中再扫描
   * 3. 范围分区：需要扫描所有分区
   * 
   * @param column 列名
   * @param filter 可选过滤条件（如 symbol_id 过滤）
   * @param partitionHint 分区提示（用于哈希分区优化，如 { symbol_id: 123 }）
   * @returns 最大值（bigint/number）或 null（无数据）
   */
  getMax(
    column: string,
    filter?: (row: Record<string, any>) => boolean,
    partitionHint?: Record<string, any>
  ): bigint | number | null {
    // 验证列存在
    if (!this.columns.find(c => c.name === column)) {
      throw new Error(`Column ${column} not found`);
    }

    let partitionsToScan: PartitionMeta[];
    let targetLabel: string | undefined;

    // 优化 1：时间分区只扫描最新分区
    if (this.strategy.type === 'time') {
      partitionsToScan = this.getLatestPartitions(1);
      if (partitionsToScan.length === 0) return null;
    }
    // 优化 2：哈希分区 + partitionHint → 先查索引，缓存未命中再扫描
    else if (this.strategy.type === 'hash' && partitionHint) {
      const label = this.getPartitionLabel(partitionHint);
      const partition = this.partitions.get(label);
      
      if (!partition) {
        // 分区不存在（可能是新数据），返回 null
        return null;
      }
      
      partitionsToScan = [partition];
      targetLabel = label;
      
      // 尝试从索引中查询
      const hashValue = partitionHint[this.strategy.column];
      if (hashValue !== undefined && hashValue !== null) {
        const cachedMax = this.getFromGroupMaxIndex(label, hashValue, column);
        if (cachedMax !== undefined) {
          // 索引命中，直接返回
          return cachedMax;
        }
      }
    }
    // 默认：扫描所有分区
    else {
      partitionsToScan = Array.from(this.partitions.values());
    }

    let maxValue: bigint | number | null = null;

    for (const meta of partitionsToScan) {
      try {
        const { header, data } = AppendWriter.readAll(meta.path);
        const columnData = data.get(column);
        if (!columnData) continue;

        // 优化：提前获取所有需要的列数据（避免重复 data.get）
        const filterColumns = filter ? Array.from(data.keys()) : [];
        const filterColumnData = filter
          ? new Map(filterColumns.map(colName => [colName, data.get(colName)!]))
          : new Map();

        for (let i = 0; i < header.totalRows; i++) {
          // 构造行用于过滤（仅在需要时）
          if (filter) {
            const row: Record<string, any> = {};
            for (const [colName, colData] of filterColumnData) {
              row[colName] = (colData as any)[i];
            }
            if (!filter(row)) continue;
          }

          const value = (columnData as any)[i];
          if (value === null || value === undefined) continue;

          if (maxValue === null) {
            maxValue = value;
          } else {
            // 处理 bigint 和 number 的比较
            if (typeof maxValue === 'bigint' && typeof value === 'bigint') {
              if (value > maxValue) maxValue = value;
            } else {
              const v1 = typeof maxValue === 'bigint' ? Number(maxValue) : maxValue;
              const v2 = typeof value === 'bigint' ? Number(value) : value;
              if (v2 > v1) maxValue = value;
            }
          }
        }
      } catch (e) {
        console.warn(`Failed to read partition ${meta.label}:`, e);
      }
    }

    // 缓存结果到索引（仅哈希分区 + partitionHint）
    if (
      this.strategy.type === 'hash' &&
      targetLabel &&
      partitionHint &&
      maxValue !== null
    ) {
      const hashValue = partitionHint[this.strategy.column];
      if (hashValue !== undefined && hashValue !== null) {
        this.setGroupMaxIndex(targetLabel, hashValue, column, maxValue);
      }
    }

    return maxValue;
  }

  /**
   * 从分组最大值索引中查询（O(1)）
   */
  private getFromGroupMaxIndex(label: string, hashValue: any, column: string): bigint | number | undefined {
    const partitionIndex = this.groupMaxIndex.get(label);
    if (!partitionIndex) return undefined;
    
    const groupIndex = partitionIndex.get(hashValue);
    if (!groupIndex) return undefined;
    
    return groupIndex.get(column);
  }
  
  /**
   * 设置分组最大值索引
   */
  private setGroupMaxIndex(label: string, hashValue: any, column: string, value: bigint | number): void {
    // 确保索引结构存在
    if (!this.groupMaxIndex.has(label)) {
      this.groupMaxIndex.set(label, new Map());
    }
    const partitionIndex = this.groupMaxIndex.get(label)!;
    
    if (!partitionIndex.has(hashValue)) {
      partitionIndex.set(hashValue, new Map());
    }
    const groupIndex = partitionIndex.get(hashValue)!;
    
    groupIndex.set(column, value);
  }
  
  /**
   * 获取最新的 N 个分区（按标签排序）
   */
  private getLatestPartitions(count: number): PartitionMeta[] {
    const sorted = Array.from(this.partitions.values())
      .sort((a, b) => b.label.localeCompare(a.label)); // 降序

    return sorted.slice(0, count);
  }

  /**
   * 关闭所有打开的 writer
   */
  async closeAll(): Promise<void> {
    for (const writer of this.writers.values()) {
      await writer.close();
    }
    this.writers.clear();
  }
}
