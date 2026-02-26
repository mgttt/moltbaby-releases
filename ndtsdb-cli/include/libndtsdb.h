/**
 * libndtsdb.h — NDTSDB Shared Library Public API
 *
 * 统一头文件，包含核心 API + 向量扩展 (ndtsdb-vec)
 * 用于 Python/Node FFI 绑定
 */
#ifndef LIBNDTSDB_H
#define LIBNDTSDB_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ============================================================================
 * Core Types (from ndtsdb.h)
 * ============================================================================ */

typedef struct {
    int64_t timestamp;
    double open;
    double high;
    double low;
    double close;
    double volume;
    uint32_t flags;
} KlineRow;

typedef struct {
    const char* symbol;
    const char* interval;
    int64_t startTime;
    int64_t endTime;
    uint32_t limit;
} Query;

typedef struct {
    KlineRow* rows;
    uint32_t count;
    uint32_t capacity;
} QueryResult;

typedef struct NDTSDB NDTSDB;

/* ============================================================================
 * Vector Types (from ndtsdb_vec.h)
 * ============================================================================ */

typedef struct {
    int64_t  timestamp;
    char     agent_id[32];
    char     type[16];
    float    confidence;
    uint16_t embedding_dim;
    float*   embedding;
    uint32_t flags;
} VecRecord;

/* 向后兼容 */
typedef VecRecord VectorRecord;

typedef struct {
    VecRecord* records;
    uint32_t   count;
} VecQueryResult;

/* 向后兼容 */
typedef VecQueryResult VectorQueryResult;

/* HNSW 配置 */
typedef struct {
    int M;
    int ef_construction;
    int ef_search;
} VecHnswConfig;

/* ============================================================================
 * Core API — Lifecycle
 * ============================================================================ */

NDTSDB* ndtsdb_open(const char* path);
NDTSDB* ndtsdb_open_snapshot(const char* path, uint64_t snapshot_size);
void ndtsdb_close(NDTSDB* db);

/* ============================================================================
 * Core API — Write
 * ============================================================================ */

int ndtsdb_insert(NDTSDB* db, const char* symbol, const char* interval, const KlineRow* row);
int ndtsdb_insert_batch(NDTSDB* db, const char* symbol, const char* interval, const KlineRow* rows, uint32_t n);
int ndtsdb_clear(NDTSDB* db, const char* symbol, const char* interval);

/* ============================================================================
 * Core API — Query
 * ============================================================================ */

QueryResult* ndtsdb_query(NDTSDB* db, const Query* query);
QueryResult* ndtsdb_query_all(NDTSDB* db);
QueryResult* ndtsdb_query_time_range(NDTSDB* db, int64_t since_ms, int64_t until_ms);
QueryResult* ndtsdb_query_filtered(NDTSDB* db, const char** symbols, int n_symbols);
QueryResult* ndtsdb_query_filtered_time(NDTSDB* db, const char** symbols, int n_symbols, int64_t since_ms, int64_t until_ms);
void ndtsdb_free_result(QueryResult* result);

/* ============================================================================
 * Core API — Metadata
 * ============================================================================ */

int64_t ndtsdb_get_latest_timestamp(NDTSDB* db, const char* symbol, const char* interval);
int ndtsdb_list_symbols(NDTSDB* db, char symbols[][32], char intervals[][16], int max_count);
const char* ndtsdb_get_path(NDTSDB* db);

/* ============================================================================
 * Vector API — Write/Query (new ndtsdb-vec)
 * ============================================================================ */

int ndtsdb_vec_insert(NDTSDB* db, const char* symbol, const char* interval, const VecRecord* record);
VecQueryResult* ndtsdb_vec_query(NDTSDB* db, const char* symbol, const char* interval);
VecQueryResult* ndtsdb_vec_search(NDTSDB* db, const char* symbol, const char* interval,
                                   const float* query, int dim, int top_k, const VecHnswConfig* config);
void ndtsdb_vec_free_result(VecQueryResult* result);

/* HNSW 索引管理 */
int ndtsdb_vec_build_index(NDTSDB* db, const char* symbol, const char* interval, const VecHnswConfig* config);
int ndtsdb_vec_has_index(NDTSDB* db, const char* symbol, const char* interval);

/* ============================================================================
 * Vector API — Backward Compatibility (deprecated)
 * ============================================================================ */

/* 旧 API 映射到新 API */
#define ndtsdb_insert_vector ndtsdb_vec_insert
#define ndtsdb_query_vectors ndtsdb_vec_query
#define ndtsdb_vector_free_result ndtsdb_vec_free_result

#ifdef __cplusplus
}
#endif

#endif /* LIBNDTSDB_H */
