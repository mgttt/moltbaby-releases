/**
 * ndtsdb.h — N-Dimensional Time Series Database Public API
 *
 * 单进程嵌入式时序数据库，专为 OHLCV 行情数据设计。
 *
 * 约束：
 *   - 每个 NDTSDB* 句柄持有独立的 per-handle 符号表（db->symbols）。
 *   - 多个句柄可并发操作不同目录，无需外部同步。
 *   - 同一句柄的并发写操作需调用方加锁。
 *   - timestamp 单位：毫秒 epoch（int64_t）。
 *
 * 线程安全：单个句柄非线程安全；不同句柄并发访问不同目录是安全的。
 */
#ifndef NDTSDB_H
#define NDTSDB_H

#include <stddef.h>
#include <stdint.h>
#include <inttypes.h>   /* PRId64 — used by ndtsdb_query_all_json format strings */

/* ─── 版本信息 ─────────────────────────────────────────── */
#ifndef NDTSDB_VERSION
#define NDTSDB_VERSION "1.0.0.1"
#endif
#ifndef NDTSDB_VERSION_MAJOR
#define NDTSDB_VERSION_MAJOR 1
#endif
#ifndef NDTSDB_VERSION_MINOR
#define NDTSDB_VERSION_MINOR 0
#endif
#ifndef NDTSDB_VERSION_PATCH
#define NDTSDB_VERSION_PATCH 0
#endif

/* 版本号计算：MAJOR * 1000000 + MINOR * 1000 + PATCH */
#define NDTSDB_VERSION_NUMBER ((NDTSDB_VERSION_MAJOR * 1000000) + \
                               (NDTSDB_VERSION_MINOR * 1000) + \
                               NDTSDB_VERSION_PATCH)

/* 版本检查宏 */
#define NDTSDB_VERSION_CHECK(major, minor, patch) \
    (NDTSDB_VERSION_NUMBER >= ((major) * 1000000 + (minor) * 1000 + (patch)))

#ifdef __cplusplus
extern "C" {
#endif

/* ─── 数据结构 ─────────────────────────────────────────── */

/**
 * KlineRow — 单根 K 线数据（56 bytes）
 *
 * @field timestamp  毫秒 epoch（int64_t）
 * @field open       开盘价
 * @field high       最高价
 * @field low        最低价
 * @field close      收盘价
 * @field volume     成交量（volume < 0 表示 tombstone / 软删除标记）
 * @field flags      保留标志位（当前未使用，写 0）
 */
typedef struct {
    int64_t timestamp;
    double open;
    double high;
    double low;
    double close;
    double volume;
    uint32_t flags;
} KlineRow;

/**
 * Query — 查询参数（传给 ndtsdb_query）
 *
 * @field symbol    交易对，NULL 表示所有
 * @field interval  时间粒度字符串（"1m"/"5m"/"1h" 等），NULL 表示所有
 * @field startTime 查询起始时间戳（毫秒），0 表示不限
 * @field endTime   查询结束时间戳（毫秒），INT64_MAX 表示不限
 * @field limit     最大返回行数，0 表示不限
 */
typedef struct {
    const char* symbol;
    const char* interval;
    int64_t startTime;
    int64_t endTime;
    uint32_t limit;
} Query;

/**
 * QueryResult — 查询结果（堆分配，须 ndtsdb_free_result 释放）
 *
 * @field rows      行数据指针；单 symbol 查询时为 KlineRow[]；多 symbol
 *                  查询（query_all / query_filtered / query_time_range）时
 *                  内部为 ResultRow[]（KlineRow + symbol[32] + interval[16]），
 *                  capacity 字段标记为 NDTSDB_RESULT_EXTENDED。
 *                  跨语言使用请通过 ndtsdb_query_all_json() 获取结果。
 * @field count     有效行数
 * @field capacity  内部标记：NDTSDB_RESULT_EXTENDED 表示扩展布局（不可按
 *                  sizeof(KlineRow) 步长迭代 rows）；否则为已分配容量。
 */
typedef struct {
    KlineRow* rows;
    uint32_t  count;
    uint32_t  capacity;
} QueryResult;

/** capacity 标记值：QueryResult.rows 指向扩展 ResultRow[] 而非 KlineRow[] */
#define NDTSDB_RESULT_EXTENDED ((uint32_t)0x45585400u)  /* "EXT\0" */

/** NDTSDB — 数据库句柄（不透明类型）*/
typedef struct NDTSDB NDTSDB;

/* ─── 生命周期 ─────────────────────────────────────────── */

/**
 * ndtsdb_open — 打开数据库（读写模式）
 *
 * @param path  数据库目录路径（若不存在则创建）
 * @return      数据库句柄，失败返回 NULL
 *
 * 注意：每个句柄持有独立的 per-handle 符号表；多句柄可并发打开不同路径。
 */
NDTSDB* ndtsdb_open(const char* path);

/**
 * ndtsdb_open_snapshot — 以快照模式打开数据库（只读）
 *
 * @param path           数据库目录路径
 * @param snapshot_size  最大读取字节数（0 = 不限制）
 * @return               数据库句柄，失败返回 NULL
 */
NDTSDB* ndtsdb_open_snapshot(const char* path, uint64_t snapshot_size);

/**
 * ndtsdb_close — 关闭数据库并释放全局符号表
 *
 * 必须在下一次 ndtsdb_open 之前调用。
 * 关闭后 db 指针失效，不可再使用。
 */
void ndtsdb_close(NDTSDB* db);

/* ─── 写入 ─────────────────────────────────────────────── */

/**
 * ndtsdb_insert — 插入单行
 *
 * @param db        数据库句柄
 * @param symbol    交易对（最大 32 字节，含 '\0'）
 * @param interval  时间粒度（最大 16 字节，含 '\0'）
 * @param row       KlineRow 指针（volume < 0 写入 tombstone）
 * @return          0 成功，-1 失败
 */
int ndtsdb_insert(NDTSDB* db, const char* symbol, const char* interval, const KlineRow* row);

/**
 * ndtsdb_insert_batch — 批量插入（性能最佳路径）
 *
 * @param db        数据库句柄
 * @param symbol    交易对
 * @param interval  时间粒度
 * @param rows      KlineRow 数组
 * @param n         行数
 * @return          成功插入行数，失败返回 -1
 */
int ndtsdb_insert_batch(NDTSDB* db, const char* symbol, const char* interval, const KlineRow* rows, uint32_t n);

/**
 * ndtsdb_clear — 清空指定 symbol/interval 的所有数据
 *
 * @param db        数据库句柄
 * @param symbol    交易对
 * @param interval  时间粒度
 * @return          0 成功，-1 失败
 */
int ndtsdb_clear(NDTSDB* db, const char* symbol, const char* interval);

/* ─── 查询 ─────────────────────────────────────────────── */

/**
 * ndtsdb_query — 带参数查询
 *
 * @param db     数据库句柄
 * @param query  查询参数（含 symbol/interval/startTime/endTime/limit）
 * @return       QueryResult*（堆分配），须 ndtsdb_free_result 释放；失败返回 NULL
 *
 * tombstone 行（volume < 0）包含在结果中，调用方自行过滤。
 */
QueryResult* ndtsdb_query(NDTSDB* db, const Query* query);

/**
 * ndtsdb_query_all — 查询所有数据
 *
 * @param db  数据库句柄
 * @return    QueryResult*（堆分配），须 ndtsdb_free_result 释放
 */
QueryResult* ndtsdb_query_all(NDTSDB* db);

/**
 * ndtsdb_query_time_range — 按时间范围查询所有 symbol
 *
 * @param db        数据库句柄
 * @param since_ms  起始时间戳（毫秒，含）
 * @param until_ms  结束时间戳（毫秒，含）
 * @return          QueryResult*（堆分配），须 ndtsdb_free_result 释放
 */
QueryResult* ndtsdb_query_time_range(NDTSDB* db, int64_t since_ms, int64_t until_ms);

/**
 * ndtsdb_query_filtered — 按 symbol 白名单查询
 *
 * @param db        数据库句柄
 * @param symbols   symbol 字符串数组
 * @param n_symbols 数组长度
 * @return          QueryResult*（堆分配），须 ndtsdb_free_result 释放
 */
QueryResult* ndtsdb_query_filtered(NDTSDB* db, const char** symbols, int n_symbols);

/**
 * ndtsdb_query_filtered_time — 按 symbol 白名单 + 时间范围查询
 *
 * @param db        数据库句柄
 * @param symbols   symbol 字符串数组
 * @param n_symbols 数组长度
 * @param since_ms  起始时间戳（毫秒，含）
 * @param until_ms  结束时间戳（毫秒，含）
 * @return          QueryResult*（堆分配），须 ndtsdb_free_result 释放
 */
QueryResult* ndtsdb_query_filtered_time(NDTSDB* db, const char** symbols, int n_symbols, int64_t since_ms, int64_t until_ms);

/**
 * ndtsdb_free_result — 释放查询结果
 *
 * @param result  ndtsdb_query* 系列函数返回的指针，NULL 安全
 */
void ndtsdb_free_result(QueryResult* result);

/* ─── 元信息 ─────────────────────────────────────────────── */

/**
 * ndtsdb_get_latest_timestamp — 获取最新时间戳
 *
 * @param db        数据库句柄
 * @param symbol    交易对
 * @param interval  时间粒度
 * @return          最新 timestamp（毫秒），无数据返回 -1
 */
int64_t ndtsdb_get_latest_timestamp(NDTSDB* db, const char* symbol, const char* interval);

/**
 * ndtsdb_list_symbols — 列出所有 symbol/interval 组合
 *
 * @param db         数据库句柄
 * @param symbols    输出 symbol 数组（调用者分配，每项 32 字节）
 * @param intervals  输出 interval 数组（调用者分配，每项 16 字节）
 * @param max_count  最大返回组合数
 * @return           实际返回的组合数量
 */
int ndtsdb_list_symbols(NDTSDB* db, char symbols[][32], char intervals[][16], int max_count);

/**
 * ndtsdb_get_path — 获取数据库路径
 *
 * @param db   数据库句柄
 * @return     数据库目录路径字符串，db 为 NULL 时返回 NULL
 */
const char* ndtsdb_get_path(NDTSDB* db);

/* ─── JSON 序列化 ─────────────────────────────────────────── */

/**
 * ndtsdb_query_all_json — 将所有数据序列化为 JSON 字符串
 *
 * 返回格式：{"rows":[...], "count": N}，包含所有 symbol/interval 的所有 K 线数据
 *
 * 调用方须通过 ndtsdb_free_json() 释放返回的指针
 *
 * @param db  数据库句柄
 * @return    JSON 字符串指针，失败返回 NULL
 */
char* ndtsdb_query_all_json(NDTSDB* db);

/**
 * ndtsdb_free_json — 释放 JSON 字符串
 *
 * @param json  ndtsdb_query_all_json 返回的指针，NULL 安全
 */
void ndtsdb_free_json(char* json);

/**
 * ndtsdb_list_symbols_json — 将所有 symbol/interval 组合序列化为 JSON 数组
 *
 * 返回格式：[{"symbol":"BTCUSDT","interval":"1h"},...]
 * 调用方须通过 ndtsdb_free_json() 释放返回的指针。
 */
char* ndtsdb_list_symbols_json(NDTSDB* db);

#ifdef __cplusplus
}
#endif

#endif /* NDTSDB_H */
