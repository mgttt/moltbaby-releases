#ifndef NDTSDB_H
#define NDTSDB_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

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

NDTSDB* ndtsdb_open(const char* path);

/**
 * 以 snapshot 模式打开数据库（只读取指定大小范围内的数据）
 * @param path 数据库文件路径
 * @param snapshot_size 最大读取字节数（0表示不限制）
 * @return 数据库句柄，NULL表示失败
 */
NDTSDB* ndtsdb_open_snapshot(const char* path, uint64_t snapshot_size);

void ndtsdb_close(NDTSDB* db);
int ndtsdb_insert(NDTSDB* db, const char* symbol, const char* interval, const KlineRow* row);
int ndtsdb_insert_batch(NDTSDB* db, const char* symbol, const char* interval, const KlineRow* rows, uint32_t n);
QueryResult* ndtsdb_query(NDTSDB* db, const Query* query);
QueryResult* ndtsdb_query_all(NDTSDB* db);
QueryResult* ndtsdb_query_time_range(NDTSDB* db, int64_t since_ms, int64_t until_ms);
QueryResult* ndtsdb_query_filtered(NDTSDB* db, const char** symbols, int n_symbols);
QueryResult* ndtsdb_query_filtered_time(NDTSDB* db, const char** symbols, int n_symbols, int64_t since_ms, int64_t until_ms);
void ndtsdb_free_result(QueryResult* result);
int64_t ndtsdb_get_latest_timestamp(NDTSDB* db, const char* symbol, const char* interval);

#ifdef __cplusplus
}
#endif

#endif
