#ifndef NDTSDB_H
#define NDTSDB_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// ============================================================
// 数据结构
// ============================================================

/** K线数据（C版本，简化版） */
typedef struct {
    int64_t timestamp;      // Unix毫秒时间戳
    double open;            // 开盘价
    double high;            // 最高价
    double low;             // 最低价
    double close;           // 收盘价
    double volume;          // 成交量
    uint32_t flags;         // 标志位
} KlineRow;

/** 查询条件 */
typedef struct {
    const char* symbol;     // 交易对，如 "BTCUSDT"
    const char* interval;   // 周期，如 "1m", "1h", "1d"
    int64_t startTime;     // 起始时间（毫秒）
    int64_t endTime;       // 结束时间（毫秒）
    uint32_t limit;        // 返回最大条数
} Query;

/** 查询结果 */
typedef struct {
    KlineRow* rows;        // 结果数组
    uint32_t count;        // 结果数量
    uint32_t capacity;     // 容量
} QueryResult;

/** 数据库句柄 */
typedef struct NDTSDB NDTSDB;

// ============================================================
// 高级 API (MVP)
// ============================================================

/**
 * 打开或创建数据库
 * @param path 数据库文件路径
 * @return 数据库句柄，NULL表示失败
 */
NDTSDB* ndtsdb_open(const char* path);

/**
 * 关闭数据库
 * @param db 数据库句柄
 */
void ndtsdb_close(NDTSDB* db);

/**
 * 插入单条K线
 * @param db 数据库句柄
 * @param symbol 交易对
 * @param interval 周期
 * @param row K线数据
 * @return 0成功，-1失败
 */
int ndtsdb_insert(NDTSDB* db, const char* symbol, const char* interval, const KlineRow* row);

/**
 * 批量插入K线
 * @param db 数据库句柄
 * @param symbol 交易对
 * @param interval 周期
 * @param rows K线数组
 * @param n 条数
 * @return 成功插入条数，-1失败
 */
int ndtsdb_insert_batch(NDTSDB* db, const char* symbol, const char* interval, const KlineRow* rows, uint32_t n);

/**
 * 查询K线
 * @param db 数据库句柄
 * @param query 查询条件
 * @return 查询结果，需用 ndtsdb_free_result 释放
 */
QueryResult* ndtsdb_query(NDTSDB* db, const Query* query);

/**
 * 查询所有K线（所有symbol）
 * @param db 数据库句柄
 * @return 查询结果，需用 ndtsdb_free_result 释放
 * @note 返回的rows实际为ResultRow*（包含symbol/interval），capacity标记为0xDEADBEEF
 */
QueryResult* ndtsdb_query_all(NDTSDB* db);

/**
 * 按时间范围查询
 * @param db 数据库句柄
 * @param since_ms 起始时间戳（毫秒，包含），-1表示无限制
 * @param until_ms 结束时间戳（毫秒，包含），-1表示无限制
 * @return 查询结果，需用 ndtsdb_free_result 释放
 */
QueryResult* ndtsdb_query_time_range(NDTSDB* db, int64_t since_ms, int64_t until_ms);

/**
 * 按symbol和时间范围联合过滤查询
 * @param db 数据库句柄
 * @param symbols symbol名称数组
 * @param n_symbols symbol数量
 * @param since_ms 起始时间戳（毫秒，包含），-1表示无限制
 * @param until_ms 结束时间戳（毫秒，包含），-1表示无限制
 * @return 查询结果，需用 ndtsdb_free_result 释放
 */
QueryResult* ndtsdb_query_filtered_time(NDTSDB* db, const char** symbols, int n_symbols, int64_t since_ms, int64_t until_ms);

/**
 * 释放查询结果
 * @param result 查询结果
 */
void ndtsdb_free_result(QueryResult* result);

/**
 * 获取最后一条K线的时间戳
 * @param db 数据库句柄
 * @param symbol 交易对
 * @param interval 周期
 * @return 时间戳，-1表示无数据
 */
int64_t ndtsdb_get_latest_timestamp(NDTSDB* db, const char* symbol, const char* interval);

#ifdef __cplusplus
}
#endif

#endif // NDTSDB_H
