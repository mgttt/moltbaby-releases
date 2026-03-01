// ============================================================
// AppendWriter FFI 适配层 - 与 CLI 格式互通
// ============================================================
// 本模块将 AppendWriter 的写入操作转发到 libndts (C 核心)
// 实现 Bun 版与 CLI 版的格式互通

import { NdtsDatabase, KlineRow, openDatabase, isLibraryAvailable } from './ndts-db-ffi.js';

// 列定义映射到 KlineRow
interface ColumnDef {
  name: string;
  type: string;
}

export interface AppendWriterOptions {
  autoCompact?: boolean;
  compactThreshold?: number;
  compactMinRows?: number;
  compactMaxAgeMs?: number;
  compactMaxFileSize?: number;
  compactMaxChunks?: number;
  compactMaxWrites?: number;
  compression?: {
    enabled: boolean;
    algorithms?: { [columnName: string]: 'delta' | 'rle' | 'gorilla' | 'none' };
  };
}

/**
 * FFI 适配的 AppendWriter
 * 保持与原 AppendWriter 相同的 API，但底层使用 C 核心写入
 */
export class AppendWriterFFI {
  private db: NdtsDatabase | null = null;
  private path: string;
  private columns: ColumnDef[];
  private options: AppendWriterOptions;
  private buffer: KlineRow[] = [];
  private bufferSize = 1000; // 批量写入阈值
  private symbol: string;
  private interval: string;
  
  constructor(path: string, columns: ColumnDef[], options: AppendWriterOptions = {}) {
    this.path = path;
    this.columns = columns;
    this.options = options;

    // 支持三种路径格式：
    // 1. symbol__interval: <db_path>/<symbol>__<interval>.ndts
    // 2. 分区格式: <db_path>/15m/bucket-N.ndts (哈希分区)
    // 3. 任意 .ndts 文件: 使用文件名(不含扩展名)作为 symbol，'raw' 作为 interval
    const match = path.match(/([^/]+)__([^/.]+)\.ndts$/);
    if (match) {
      // symbol__interval 格式
      this.symbol = match[1];
      this.interval = match[2];
    } else if (path.includes('/bucket-')) {
      // 分区格式：bucket-N.ndts
      const bucketMatch = path.match(/\/([^/]+)\/bucket-(\d+)\.ndts$/);
      if (!bucketMatch) {
        throw new Error(`Invalid bucket path format: ${path}`);
      }
      this.interval = bucketMatch[1]; // 如 "15m"
      this.symbol = `bucket-${bucketMatch[2]}`; // 如 "bucket-48"
    } else {
      // 通用路径：使用文件名(不含扩展名)作为 symbol
      const fileName = path.split('/').pop()?.replace(/\.ndts$/, '') ?? 'data';
      this.symbol = fileName;
      this.interval = 'raw';
    }
  }
  
  /**
   * 打开数据库连接
   */
  open(): void {
    if (!isLibraryAvailable()) {
      throw new Error('libndts not available. Please build ndtsdb-cli first: cd ndtsdb-cli && make cosmo-docker');
    }

    // 提取数据库目录路径
    let dbPath: string;
    if (this.path.includes('/bucket-')) {
      // 分区格式：只去掉 bucket-N.ndts，保留 interval 目录
      dbPath = this.path.replace(/\/bucket-\d+\.ndts$/, '');
    } else if (this.path.match(/[^/]+__[^/.]+\.ndts$/)) {
      // symbol__interval 格式：向上一级
      dbPath = this.path.replace(/\/[^/]+__[^/.]+\.ndts$/, '');
    } else {
      // 通用路径：parent dir（或当前目录若无父目录）
      const lastSlash = this.path.lastIndexOf('/');
      dbPath = lastSlash > 0 ? this.path.substring(0, lastSlash) : '.';
    }
    this.db = openDatabase(dbPath);
  }
  
  /**
   * 关闭数据库连接
   */
  close(): void {
    this.flush();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
  
  /**
   * 追加数据 (适配到 C 核心批量插入)
   */
  append(rows: Record<string, any>[]): void {
    if (!this.db) throw new Error('Database not open');
    if (rows.length === 0) return;
    
    // 转换行数据为 KlineRow
    for (const row of rows) {
      const klineRow = this.toKlineRow(row);
      this.buffer.push(klineRow);
      
      if (this.buffer.length >= this.bufferSize) {
        this.flush();
      }
    }
  }
  
  /**
   * 立即批量写入缓冲区
   */
  flush(): void {
    if (!this.db || this.buffer.length === 0) return;
    
    this.db.insertBatch(this.symbol, this.interval, this.buffer);
    this.buffer = [];
  }
  
  /**
   * 将行数据转换为 KlineRow
   */
  private toKlineRow(row: Record<string, any>): KlineRow {
    // 标准 Kline 字段映射
    const timestamp = this.getField(row, ['timestamp', 'ts', 'time', 'datetime']);
    const open = this.getField(row, ['open', 'o']);
    const high = this.getField(row, ['high', 'h']);
    const low = this.getField(row, ['low', 'l']);
    const close = this.getField(row, ['close', 'c']);
    const volume = this.getField(row, ['volume', 'vol', 'v', 'amount']);
    
    if (timestamp === undefined) {
      throw new Error(`Row missing timestamp field: ${JSON.stringify(row)}`);
    }
    
    return {
      timestamp: typeof timestamp === 'bigint' ? Number(timestamp) : Number(timestamp),
      open: Number(open ?? 0),
      high: Number(high ?? 0),
      low: Number(low ?? 0),
      close: Number(close ?? 0),
      volume: Number(volume ?? 0),
      flags: 0,
    };
  }
  
  /**
   * 从行数据中获取字段（支持多个别名）
   */
  private getField(row: Record<string, any>, aliases: string[]): any {
    for (const alias of aliases) {
      if (alias in row) {
        return row[alias];
      }
    }
    return undefined;
  }
  
  /**
   * 重写文件 (compact) - 在 FFI 模式下使用 tombstone 机制
   */
  rewrite(options?: any): { beforeRows: number; afterRows: number; deletedRows: number; chunksWritten: number } {
    // FFI 模式下 C 核心自动处理 compact
    this.flush();
    return { beforeRows: 0, afterRows: 0, deletedRows: 0, chunksWritten: 0 };
  }
  
  /**
   * 读取所有数据 (使用 C 核心查询)
   */
  readAll(): { header: any; data: Record<string, any>[] } {
    this.flush();
    if (!this.db) throw new Error('Database not open');
    
    const rows = this.db.queryAll();
    
    // 转换回原始格式
    const data = rows.map(r => ({
      timestamp: r.timestamp,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      flags: r.flags,
    }));
    
    return {
      header: { columns: this.columns },
      data,
    };
  }
  
  /**
   * 静态方法：读取文件头信息 (获取行数)
   */
  static readHeader(path: string): { totalRows: number } {
    try {
      const dbPath = path.replace(/\/[^/]+__[^/.]+\.ndts$/, '');
      const db = openDatabase(dbPath);
      try {
        const rows = db.queryAll();
        return { totalRows: rows.length };
      } finally {
        db.close();
      }
    } catch (error: any) {
      console.warn(`Failed to read header from ${path}:`, error.message);
      return { totalRows: 0 };
    }
  }

  /**
   * 静态方法：读取文件 (使用 FFI 数据库 queryAll)
   *
   * 对于分区文件，通过打开对应的 FFI 数据库并查询所有数据来读取
   *
   * 支持两种路径格式：
   * 1. symbol__interval 格式：<db_path>/<symbol>__<interval>.ndts
   * 2. 分区格式：<db_path>/15m/bucket-N.ndts (哈希分区)
   *
   * 返回格式：
   * header: { totalRows: number, columns?: any[] }
   * data: Map<string, TypedArray> - 其中 key 是列名，value 是类型化数组
   */
  static readAll(path: string): { header: any; data: Map<string, any> } {
    try {
      // 提取数据库目录路径用于 FFI。
      // 注意：C 核心写入时会按日期分区（YYYY-MM-DD.ndts），不保留原始文件名。
      // 因此我们用目录路径打开 db，扫描目录中所有 .ndts 文件读取数据。
      let dbPath: string;
      const fileName = path.split('/').pop() || '';
      const match = fileName.match(/^(.+)__(.+)\.ndts$/);

      if (match) {
        // symbol__interval 格式
        dbPath = path.replace(/\/[^/]+__[^/.]+\.ndts$/, '');
      } else {
        // 通用格式：使用父目录
        const lastSlash = path.lastIndexOf('/');
        dbPath = lastSlash > 0 ? path.substring(0, lastSlash) : '.';
      }

      // 使用 FFI 打开数据库并查询所有数据
      try {
        const db = openDatabase(dbPath);
        try {
          const rows = db.queryAll();
          if (rows.length > 0) {
            return this.rowsToDataMap(rows);
          }
        } finally {
          db.close();
        }
      } catch (err) {
        // FFI 失败
      }

      // 无法读取数据，返回空结果
      return { header: { totalRows: 0 }, data: new Map() };
    } catch (err: any) {
      return { header: { totalRows: 0 }, data: new Map() };
    }
  }

  /**
   * 将行数组转换为数据映射
   */
  private static rowsToDataMap(rows: KlineRow[]): { header: any; data: Map<string, any> } {
    const totalRows = rows.length;
    const timestamps = new BigInt64Array(totalRows);
    const opens = new Float64Array(totalRows);
    const highs = new Float64Array(totalRows);
    const lows = new Float64Array(totalRows);
    const closes = new Float64Array(totalRows);
    const volumes = new Float64Array(totalRows);
    const symbolIds = new Int32Array(totalRows);

    for (let i = 0; i < totalRows; i++) {
      const r = rows[i];
      timestamps[i] = typeof r.timestamp === 'bigint' ? r.timestamp : BigInt(r.timestamp);
      opens[i] = Number(r.open);
      highs[i] = Number(r.high);
      lows[i] = Number(r.low);
      closes[i] = Number(r.close);
      volumes[i] = Number(r.volume);
      symbolIds[i] = 0;
    }

    const data = new Map<string, any>();
    data.set('timestamp', timestamps);
    data.set('open', opens);
    data.set('high', highs);
    data.set('low', lows);
    data.set('close', closes);
    data.set('volume', volumes);
    data.set('symbol_id', symbolIds);

    return { header: { totalRows }, data };
  }

  /**
   * 检查文件是否存在且有效
   */
  static exists(path: string): boolean {
    try {
      const { data } = this.readAll(path);
      return data.size > 0;
    } catch {
      return false;
    }
  }
}

// 导出别名，保持 API 兼容
export { AppendWriterFFI as AppendWriter };
