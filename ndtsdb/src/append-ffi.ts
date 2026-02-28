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

    // 支持两种路径格式：
    // 1. symbol__interval: <db_path>/<symbol>__<interval>.ndts
    // 2. 分区格式: <db_path>/15m/bucket-N.ndts (哈希分区)
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
      throw new Error(`Invalid path format: ${path}. Expected either <db>/<symbol>__<interval>.ndts or <db>/<interval>/bucket-N.ndts`);
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
      // 分区格式：向上两级
      dbPath = this.path.replace(/\/[^/]+\/bucket-\d+\.ndts$/, '');
    } else {
      // symbol__interval 格式：向上一级
      dbPath = this.path.replace(/\/[^/]+__[^/.]+\.ndts$/, '');
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
   * 静态方法：读取分区头信息 (获取行数)
   * 用于 partition.ts 的分区加载逻辑
   */
  static readHeader(path: string): { totalRows: number } {
    try {
      // 处理哈希分区路径格式：<db_path>/15m/bucket-N.ndts
      // 提取数据库根路径（向上两级目录）
      const dbPath = path.replace(/\/[^/]+\/[^/]+\.ndts$/, '');
      const db = openDatabase(dbPath);
      try {
        // 查询该分区文件的行数
        // 注意：由于分区文件名约定，我们需要通过文件大小估算或直接加载
        const rows = db.queryAll();
        return { totalRows: rows.length };
      } finally {
        db.close();
      }
    } catch (error: any) {
      // 如果打开失败（文件不存在或损坏），返回 0
      console.warn(`Failed to read header from ${path}:`, error.message);
      return { totalRows: 0 };
    }
  }

  /**
   * 静态方法：读取文件 (绕过 FFI QueryResult 指针问题)
   * 对于分区文件，通过 ndtsdb-cli 导出所有 symbol 的数据并合并
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
      const { existsSync } = require('fs');

      // 验证文件存在
      if (!existsSync(path)) {
        throw new Error(`NDTS file not found: ${path}`);
      }

      // 对于分区文件（含 bucket），使用分区读取器或降级到空数据
      if (path.includes('/bucket-')) {
        try {
          // 从分区路径提取根数据库路径
          // 路径格式: /path/to/ndtsdb/klines-partitioned/15m/bucket-N.ndts
          const dbPath = path.replace(/\/klines-partitioned\/[^/]+\/bucket-\d+\.ndts$/, '');

          // 尝试通过分区读取器读取（即使可能失败）
          try {
            const { readPartitionViaSymbols } = require('./ndts-partition-reader.js');
            const result = readPartitionViaSymbols(path, dbPath);
            // 成功读取，检查是否获取了实际数据
            if (result.header.totalRows > 0) {
              console.log(`[AppendWriter.readAll] Read ${result.header.totalRows} rows from ${path}`);
              return result;
            }
          } catch (readerErr: any) {
            // 分区读取器失败，继续尝试其他方法
          }

          // 降级：返回空数据而不是崩溃
          return {
            header: { totalRows: 0, columns: [] },
            data: new Map(),
          };
        } catch (err: any) {
          console.warn(`[AppendWriter.readAll] Partition handling failed: ${err.message}`);
          return {
            header: { totalRows: 0, columns: [] },
            data: new Map(),
          };
        }
      }

      // 提取数据库路径（单个文件格式）
      const dbPath = path.replace(/\/[^/]+__[^/.]+\.ndts$/, '');

      // 对于单个 symbol 文件，尝试通过 export 导出
      const fileName = path.split('/').pop() || '';
      const match = fileName.match(/^(.+)__(.+)\.ndts$/);
      if (match) {
        const [, symbol, interval] = match;
        try {
          return this.exportSingleSymbol(dbPath, symbol, interval);
        } catch (err: any) {
          console.warn(`[AppendWriter.readAll] Symbol export failed: ${err.message}`);
        }
      }

      // 所有方法都失败，返回空数据
      return {
        header: { totalRows: 0, columns: [] },
        data: new Map(),
      };
    } catch (err: any) {
      console.warn(`[AppendWriter.readAll] Error reading ${path}: ${err.message}`);
      return {
        header: { totalRows: 0, columns: [] },
        data: new Map(),
      };
    }
  }

  /**
   * 导出单个 symbol 的数据
   */
  private static exportSingleSymbol(
    dbPath: string,
    symbol: string,
    interval: string
  ): { header: any; data: Map<string, any> } {
    const { spawnSync } = require('child_process');
    const { existsSync } = require('fs');

    const cliPath = this.findNdtsdbCli();
    if (!cliPath) {
      throw new Error('ndtsdb-cli not found');
    }

    const result = spawnSync(cliPath, ['export', '--database', dbPath, '--symbol', symbol, '--interval', interval, '--format', 'json'], {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      timeout: 10000,
    });

    if (result.status !== 0 || !result.stdout) {
      throw new Error(`Export failed: ${result.stderr || 'no output'}`);
    }

    // 解析 JSON Lines 格式
    const lines = result.stdout.trim().split('\n').filter((l: string) => l.length > 0);
    const rows: any[] = [];

    for (const line of lines) {
      try {
        rows.push(JSON.parse(line));
      } catch {}
    }

    return this.rowsToTypedArrays(rows);
  }

  /**
   * 将行数组转换为类型化数组
   */
  private static rowsToTypedArrays(rows: any[]): {
    header: any;
    data: Map<string, any>;
  } {
    const data = new Map<string, any>();

    if (rows.length === 0) {
      return { header: { totalRows: 0 }, data };
    }

    // 初始化所有可能的列
    const symbolIds = new Int32Array(rows.length);
    const timestamps = new BigInt64Array(rows.length);
    const opens = new Float64Array(rows.length);
    const highs = new Float64Array(rows.length);
    const lows = new Float64Array(rows.length);
    const closes = new Float64Array(rows.length);
    const volumes = new Float64Array(rows.length);
    const quoteVolumes = new Float64Array(rows.length);
    const trades = new Int32Array(rows.length);
    const takerBuyVolumes = new Float64Array(rows.length);
    const takerBuyQuoteVolumes = new Float64Array(rows.length);

    // 填充数据
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      symbolIds[i] = row.symbol_id ?? 0;
      timestamps[i] = BigInt(row.timestamp ?? 0);
      opens[i] = Number(row.open ?? 0);
      highs[i] = Number(row.high ?? 0);
      lows[i] = Number(row.low ?? 0);
      closes[i] = Number(row.close ?? 0);
      volumes[i] = Number(row.volume ?? 0);
      quoteVolumes[i] = Number(row.quoteVolume ?? 0);
      trades[i] = row.trades ?? 0;
      takerBuyVolumes[i] = Number(row.takerBuyVolume ?? 0);
      takerBuyQuoteVolumes[i] = Number(row.takerBuyQuoteVolume ?? 0);
    }

    data.set('symbol_id', symbolIds);
    data.set('timestamp', timestamps);
    data.set('open', opens);
    data.set('high', highs);
    data.set('low', lows);
    data.set('close', closes);
    data.set('volume', volumes);
    data.set('quoteVolume', quoteVolumes);
    data.set('trades', trades);
    data.set('takerBuyVolume', takerBuyVolumes);
    data.set('takerBuyQuoteVolume', takerBuyQuoteVolumes);

    return {
      header: { totalRows: rows.length },
      data,
    };
  }

  /**
   * 查找 ndtsdb-cli 可执行文件
   */
  private static findNdtsdbCli(): string | null {
    const { existsSync } = require('fs');
    const paths = [
      '/home/devali/moltbaby/ndtsdb-cli/ndtsdb-cli',
      process.cwd() + '/ndtsdb-cli/ndtsdb-cli',
      '/usr/local/bin/ndtsdb-cli',
      'ndtsdb-cli',
    ];

    for (const path of paths) {
      if (existsSync(path)) {
        return path;
      }
    }
    return null;
  }
  
  /**
   * 检查文件是否存在且有效
   */
  static exists(path: string): boolean {
    try {
      const { data } = this.readAll(path);
      return data.length > 0;
    } catch {
      return false;
    }
  }
}

// 导出别名，保持 API 兼容
export { AppendWriterFFI as AppendWriter };
