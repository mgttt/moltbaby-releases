// ============================================================
// ndtsdb: N-Dimensional Time Series Database
//
// 高性能多维时序数据库 · 为量化交易而生
// 技术栈: Bun · TypeScript · C FFI · mmap · zero-copy · Gorilla
// ============================================================

// ─── 核心存储 ────────────────────────────────────────

export { ColumnarTable } from './columnar.js';
export type { ColumnarType } from './columnar.js';

// ─── 版本信息 ────────────────────────────────────────

export { VERSION, VERSION_MAJOR, VERSION_MINOR, VERSION_PATCH, getVersion } from './ndts-db-ffi.js';

// ─── 统一入口 ────────────────────────────────────────

export { open, detectFormat } from './ndts-open.js';
export type { NdtsHandle, NdtsFormat, NdtsQueryParams } from './ndts-open.js';

// ─── 增量写入 + 完整性校验 ───────────────────────────

// FFI 适配层 (与 CLI 格式互通)
export { AppendWriterFFI as AppendWriter, AppendWriterFFI } from './append-ffi.js';
export { NdtsDatabase, openDatabase, isLibraryAvailable } from './ndts-db-ffi.js';
export type { KlineRow } from './ndts-db-ffi.js';

// ─── 压缩 ────────────────────────────────────────────

export { GorillaCompressor, GorillaDecompressor } from './compression.js';
export { CompressionCache } from './compression-cache.js';

// ─── 缓存监测 ────────────────────────────────────────

export { CacheMonitor } from './cache-monitor.js';
export type { 
  CacheAccessRecord, 
  CacheMetrics, 
  CacheAlertConfig, 
  CacheAlert 
} from './cache-monitor.js';

// ─── libndts (C FFI) ─────────────────────────────────

export {
  isNdtsReady,
  int64ToF64,
  countingSortArgsort,
  gatherF64,
  gorillaCompress,
  gorillaDecompress,
  binarySearchI64,
  binarySearchBatchI64,
  prefixSum,
  deltaEncode,
  deltaDecode,
  ema,
  sma,
  rollingStd,
} from './ndts-ffi.js';

// ─── mmap + 全市场回放 ──────────────────────────────

export { MmapPool, MmappedColumnarTable } from './mmap/pool.js';
export { SmartPrefetcher, ProgressiveLoader } from './mmap/prefetcher.js';
export { MmapMergeStream } from './mmap/merge.js';
export type { ReplayTick, ReplaySnapshot, ReplayConfig, ReplayStats } from './mmap/merge.js';

// ─── SQL ─────────────────────────────────────────────

export { SQLParser, parseSQL } from './sql/parser.js';
export { SQLExecutor } from './sql/executor.js';
export type { SQLStatement, SQLSelect, SQLCTE, SQLCondition, SQLUpsert } from './sql/parser.js';
export type { SQLQueryResult } from './sql/executor.js';

// ─── 索引 ────────────────────────────────────────────

export { RoaringBitmap, BitmapIndex, IndexManager } from './index/bitmap.js';
export { BTreeIndex, TimestampIndex } from './index/btree.js';

// ─── 时序查询 ────────────────────────────────────────

export { sampleBy, ohlcv, latestOn, movingAverage, exponentialMovingAverage, rollingStdDev } from './query.js';
export type { SampleByColumn, SampleByResult, AggType } from './query.js';

// ─── 并行查询 ────────────────────────────────────────

export { ParallelQueryEngine, parallelScan, parallelAggregate } from './parallel.js';

// ─── 云存储 ──────────────────────────────────────────

export { TieredStorageManager } from './cloud.js';

// ─── 行式存储 (兼容) ─────────────────────────────────

export { TSDB } from './storage.js';
export { PartitionedTable, type PartitionStrategy, type PartitionMeta } from './partition.js';
export { extractTimeRange, extractTimeRangeLegacy, queryPartitionedTableToColumnar } from './partition-sql.js';
export {
  SlidingWindowAggregator,
  StreamingSMA,
  StreamingEMA,
  StreamingStdDev,
  StreamingMin,
  StreamingMax,
  StreamingAggregator,
  StreamingRSI,
  StreamingMACD,
  StreamingBollingerBands,
  StreamingATR,
  StreamingOBV,
  StreamingVWAP,
} from './stream.js';
export { NdtsVecDatabase } from './vector-ffi.js';
export type { VecRecord, VecSearchResult } from './vector-ffi.js';
export { SymbolTable } from './symbol.js';
export { WAL } from './wal.js';

// ─── 类型 ────────────────────────────────────────────

export type {
  Row,
  QueryOptions,
  PartitionConfig,
  TSDBOptions,
  ColumnType,
  ColumnDef,
} from './types.js';
