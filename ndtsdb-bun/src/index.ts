/**
 * ndtsdb-bun/src/index.ts — Public API
 *
 * Main entry point for the ndtsdb TypeScript/Bun FFI package.
 */

// ─── Core database ───────────────────────────────────────────────────────────
export { NdtsDatabase, openDatabase } from './ndts-db.ts';
export type { KlineRow, NDTSRow, SymbolInfo } from './ndts-db.ts';

// ─── AppendWriter (single-file/path, columnar read) ──────────────────────────
export { AppendWriter } from './append-ffi.ts';
export type { ColumnDef as AppendColumnDef, ReadAllResult } from './append-ffi.ts';

// ─── PartitionedTable (multi-symbol, time-partitioned) ───────────────────────
export { PartitionedTable } from './partition.ts';
export type {
  ColumnDef,
  PartitionStrategy,
  TimePartitionStrategy,
  QueryOptions,
  TimeRange,
} from './partition.ts';

// ─── SQL ─────────────────────────────────────────────────────────────────────
export { parseSQL, SQLExecutor, ColumnarTable } from './sql.ts';
export type { ParsedSQL, SelectData, QueryResult } from './sql.ts';

// ─── NDTV Vector (knowledge base, cosine similarity) ─────────────────────────
export {
  ffi_vec_open, ffi_vec_close,
  ffi_vec_insert, ffi_vec_query, ffi_vec_search,
} from './vec-ffi.ts';
export type { VecRecord } from './vec-ffi.ts';
