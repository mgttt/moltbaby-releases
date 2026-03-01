// ============================================================
// 核心存储引擎
// 整合 WAL + Partition + Symbol Table
// ============================================================

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { PartitionedTable } from './partition.js';
import { SymbolTable } from './symbol.js';
import { WAL } from './wal.js';
import type { TSDBOptions, Row, QueryOptions, ColumnDef } from './types.js';

interface TableSchema {
  name: string;
  columns: ColumnDef[];
  timestampColumn: string;
  symbolColumns: string[];
}

export class TSDB {
  private readonly options: Required<TSDBOptions>;
  private readonly tables: Map<string, TableSchema> = new Map();
  private readonly partitions: Map<string, PartitionedTable> = new Map();
  private readonly symbols: Map<string, SymbolTable> = new Map();
  private readonly wal: WAL;
  private readonly schemaPath: string;
  private closed = false;

  constructor(options: TSDBOptions) {
    this.options = {
      walEnabled: true,
      walFlushIntervalMs: 1000,
      cacheSize: 10000,
      compression: false,
      partitionBy: { column: 'timestamp', granularity: 'day' },
      ...options
    };

    // 确保数据目录存在
    if (!existsSync(this.options.dataDir)) {
      mkdirSync(this.options.dataDir, { recursive: true });
    }

    // 初始化 WAL
    const walDir = join(this.options.dataDir, '.wal');
    this.wal = new WAL(walDir, {
      flushIntervalMs: this.options.walFlushIntervalMs
    });

    // 加载 schema
    this.schemaPath = join(this.options.dataDir, '.schema.json');
    this.loadSchemas();

    // 启动时恢复 WAL
    this.recoverFromWAL();
  }

  /**
   * 创建表
   */
  createTable(name: string, columns: ColumnDef[]): void {
    if (this.tables.has(name)) {
      throw new Error(`Table ${name} already exists`);
    }

    // 找到时间戳列
    const timestampColumn = columns.find(c => c.type === 'timestamp')?.name;
    if (!timestampColumn) {
      throw new Error('Table must have a timestamp column');
    }

    // 收集 symbol 列
    const symbolColumns = columns
      .filter(c => c.type === 'symbol')
      .map(c => c.name);

    const schema: TableSchema = {
      name,
      columns,
      timestampColumn,
      symbolColumns
    };

    this.tables.set(name, schema);

    // 初始化分区管理器
    const tableDir = join(this.options.dataDir, name);
    this.partitions.set(name, new PartitionedTable(tableDir, this.options.partitionBy, {
      maxRowsInMemory: this.options.cacheSize
    }));

    // 初始化 symbol 表
    for (const col of symbolColumns) {
      const symbolPath = join(tableDir, `.symbols-${col}.json`);
      this.symbols.set(`${name}.${col}`, new SymbolTable(symbolPath));
    }

    this.saveSchemas();
  }

  /**
   * 插入单条记录
   */
  insert(tableName: string, row: Row): void {
    this.checkOpen();
    const schema = this.tables.get(tableName);
    if (!schema) {
      throw new Error(`Table ${tableName} does not exist`);
    }

    // 编码 symbol 列
    const encodedRow = this.encodeRow(tableName, row, schema);

    // 写入 WAL
    if (this.options.walEnabled) {
      this.wal.append(tableName, encodedRow);
    }

    // 写入分区
    const ts = new Date(row[schema.timestampColumn] as string | number);
    this.partitions.get(tableName)!.writeRow(encodedRow, ts);
  }

  /**
   * 批量插入（高性能路径）
   */
  insertBatch(tableName: string, rows: Row[]): void {
    this.checkOpen();
    const schema = this.tables.get(tableName);
    if (!schema) {
      throw new Error(`Table ${tableName} does not exist`);
    }

    // 批量编码
    const encodedRows = rows.map(row => this.encodeRow(tableName, row, schema));

    // 批量写入 WAL
    if (this.options.walEnabled) {
      this.wal.appendBatch(tableName, encodedRows);
    }

    // 按时间排序后批量写入分区（避免频繁切换）
    const sortedRows = encodedRows
      .map((row, idx) => ({ row, ts: new Date(rows[idx][schema.timestampColumn] as string | number) }))
      .sort((a, b) => a.ts.getTime() - b.ts.getTime());

    const partition = this.partitions.get(tableName)!;
    for (const { row, ts } of sortedRows) {
      partition.writeRow(row, ts);
    }
  }

  /**
   * 查询数据
   */
  query(options: QueryOptions): Row[] {
    this.checkOpen();
    const schema = this.tables.get(options.table);
    if (!schema) {
      throw new Error(`Table ${options.table} does not exist`);
    }

    const partition = this.partitions.get(options.table)!;
    const start = options.start || new Date(0);
    const end = options.end || new Date();

    // 查询分区数据
    let results = partition.query(start, end, options.where);

    // 限制返回数量
    if (options.limit) {
      results = results.slice(0, options.limit);
    }

    // 解码 symbol 列
    return results.map(row => this.decodeRow(options.table, row, schema));
  }

  /**
   * 执行 SQL-Like 聚合查询（简化版 SAMPLE BY）
   */
  sampleBy(tableName: string, interval: string, columns: { name: string; agg: 'first' | 'last' | 'min' | 'max' | 'sum' | 'avg' }[], options: Partial<QueryOptions> = {}): Row[] {
    const rows = this.query({ table: tableName, ...options });
    if (rows.length === 0) return [];

    const schema = this.tables.get(tableName)!;
    const intervalMs = this.parseInterval(interval);

    // 按时间桶分组
    const buckets = new Map<number, Row[]>();
    for (const row of rows) {
      const ts = new Date(row[schema.timestampColumn] as string | number).getTime();
      const bucketTs = Math.floor(ts / intervalMs) * intervalMs;
      
      if (!buckets.has(bucketTs)) {
        buckets.set(bucketTs, []);
      }
      buckets.get(bucketTs)!.push(row);
    }

    // 聚合
    const results: Row[] = [];
    for (const [bucketTs, bucketRows] of buckets) {
      const result: Row = {
        [schema.timestampColumn]: new Date(bucketTs)
      };

      for (const col of columns) {
        const values = bucketRows.map(r => r[col.name] as number).filter(v => typeof v === 'number');
        
        switch (col.agg) {
          case 'first':
            result[col.name] = values[0];
            break;
          case 'last':
            result[col.name] = values[values.length - 1];
            break;
          case 'min':
            result[col.name] = Math.min(...values);
            break;
          case 'max':
            result[col.name] = Math.max(...values);
            break;
          case 'sum':
            result[col.name] = values.reduce((a, b) => a + b, 0);
            break;
          case 'avg':
            result[col.name] = values.reduce((a, b) => a + b, 0) / values.length;
            break;
        }
      }

      results.push(result);
    }

    return results.sort((a, b) => 
      new Date(a[schema.timestampColumn] as string | number).getTime() - 
      new Date(b[schema.timestampColumn] as string | number).getTime()
    );
  }

  /**
   * 获取表统计信息
   */
  getStats(tableName: string): { rowCount: number; partitions: number; symbols: Record<string, number> } {
    const schema = this.tables.get(tableName);
    if (!schema) {
      throw new Error(`Table ${tableName} does not exist`);
    }

    const partitions = this.partitions.get(tableName)!.listPartitions();
    const rowCount = partitions.reduce((sum, p) => sum + p.rowCount, 0);

    const symbols: Record<string, number> = {};
    for (const col of schema.symbolColumns) {
      const symbolTable = this.symbols.get(`${tableName}.${col}`);
      if (symbolTable) {
        symbols[col] = symbolTable.getStats().count;
      }
    }

    return { rowCount, partitions: partitions.length, symbols };
  }

  /**
   * 强制刷盘
   */
  flush(): void {
    this.wal.flush();
    for (const partition of this.partitions.values()) {
      partition.flush();
    }
    for (const symbol of this.symbols.values()) {
      symbol.save();
    }
  }

  /**
   * 关闭数据库
   */
  close(): void {
    if (this.closed) return;
    
    this.flush();
    this.wal.close();
    this.closed = true;
  }

  private checkOpen(): void {
    if (this.closed) {
      throw new Error('Database is closed');
    }
  }

  private encodeRow(tableName: string, row: Row, schema: TableSchema): Row {
    const encoded: Row = { ...row };

    // 编码 symbol 列为整数
    for (const col of schema.symbolColumns) {
      const symbolValue = row[col] as string;
      if (symbolValue !== undefined) {
        const symbolTable = this.symbols.get(`${tableName}.${col}`)!;
        encoded[col] = symbolTable.getOrCreateId(symbolValue);
      }
    }

    return encoded;
  }

  private decodeRow(tableName: string, row: Row, schema: TableSchema): Row {
    const decoded: Row = { ...row };

    // 解码 symbol 列
    for (const col of schema.symbolColumns) {
      const id = row[col] as number;
      if (typeof id === 'number') {
        const symbolTable = this.symbols.get(`${tableName}.${col}`)!;
        decoded[col] = symbolTable.getName(id) || String(id);
      }
    }

    return decoded;
  }

  private loadSchemas(): void {
    if (!existsSync(this.schemaPath)) return;

    try {
      const schemas: TableSchema[] = JSON.parse(readFileSync(this.schemaPath, 'utf-8'));
      for (const schema of schemas) {
        this.createTable(schema.name, schema.columns);
      }
    } catch {
      // Schema 文件损坏，忽略
    }
  }

  private saveSchemas(): void {
    const schemas = Array.from(this.tables.values());
    writeFileSync(this.schemaPath, JSON.stringify(schemas, null, 2));
  }

  private recoverFromWAL(): void {
    const walData = this.wal.readAll();
    
    for (const [tableName, rows] of walData) {
      const schema = this.tables.get(tableName);
      if (!schema) continue;

      const partition = this.partitions.get(tableName);
      if (!partition) continue;

      // 重放 WAL 到分区
      for (const row of rows) {
        const ts = new Date(row[schema.timestampColumn] as string | number);
        partition.writeRow(row, ts);
      }
    }

    // 归档 WAL
    this.wal.archive();
  }

  private parseInterval(interval: string): number {
    const match = interval.match(/^(\d+)([smhd])$/);
    if (!match) throw new Error(`Invalid interval: ${interval}`);

    const value = parseInt(match[1]);
    const unit = match[2];

    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000
    };

    return value * multipliers[unit];
  }
}
