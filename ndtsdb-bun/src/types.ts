// ============================================================
// 类型定义
// ============================================================

export type ColumnType = 'timestamp' | 'symbol' | 'double' | 'long' | 'int' | 'string';

export interface ColumnDef {
  name: string;
  type: ColumnType;
  index?: boolean;  // 是否为索引列（仅 symbol 有效）
}

export interface Row {
  [key: string]: string | number | Date | undefined;
}

export interface QueryOptions {
  table: string;
  start?: Date;
  end?: Date;
  where?: (row: Row) => boolean;
  limit?: number;
  symbols?: string[];  // symbol 过滤
}

export interface PartitionConfig {
  column: string;      // 分区列（必须是 timestamp）
  granularity: 'hour' | 'day' | 'month';
}

export interface TSDBOptions {
  dataDir: string;
  partitionBy?: PartitionConfig;
  walEnabled?: boolean;
  walFlushIntervalMs?: number;
  cacheSize?: number;  // 内存缓存行数
  compression?: boolean;
}

export interface PartitionInfo {
  name: string;
  startTime: Date;
  endTime: Date;
  rowCount: number;
  fileSize: number;
}
