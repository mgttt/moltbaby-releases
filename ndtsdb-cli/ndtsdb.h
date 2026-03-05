#ifndef NDTSDB_H
#define NDTSDB_H

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

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

/**
 * 清空指定 symbol/interval 的所有数据
 * @param db 数据库句柄
 * @param symbol 交易对
 * @param interval 时间间隔
 * @return 0 成功，-1 失败
 */
int ndtsdb_clear(NDTSDB* db, const char* symbol, const char* interval);
QueryResult* ndtsdb_query(NDTSDB* db, const Query* query);
QueryResult* ndtsdb_query_all(NDTSDB* db);
QueryResult* ndtsdb_query_time_range(NDTSDB* db, int64_t since_ms, int64_t until_ms);
QueryResult* ndtsdb_query_filtered(NDTSDB* db, const char** symbols, int n_symbols);
QueryResult* ndtsdb_query_filtered_time(NDTSDB* db, const char** symbols, int n_symbols, int64_t since_ms, int64_t until_ms);
void ndtsdb_free_result(QueryResult* result);
int64_t ndtsdb_get_latest_timestamp(NDTSDB* db, const char* symbol, const char* interval);

/**
 * 列出数据库中所有唯一的symbol/interval组合
 * @param db 数据库句柄
 * @param symbols 输出symbol数组（调用者分配，每个最大32字节）
 * @param intervals 输出interval数组（调用者分配，每个最大16字节）
 * @param max_count 最大返回数量
 * @return 实际返回的组合数量
 */
int ndtsdb_list_symbols(NDTSDB* db, char symbols[][32], char intervals[][16], int max_count);

#ifdef __cplusplus
}
#endif

#endif
