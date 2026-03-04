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
 * KlineRow — 单根 K 线数据（88 bytes，10列完整版）
 *
 * @field timestamp           毫秒 epoch（int64_t）
 * @field open                开盘价
 * @field high                最高价
 * @field low                 最低价
 * @field close               收盘价
 * @field volume              成交量（volume < 0 表示 tombstone / 软删除标记）
 * @field quoteVolume         计价货币成交量（新增）
 * @field trades              成交笔数（新增）
 * @field takerBuyVolume      主动买入成交量（新增）
 * @field takerBuyQuoteVolume 主动买入计价成交量（新增）
 * @field flags               保留标志位（当前未使用，写 0）
 */
typedef struct {
    int64_t timestamp;
    double open;
    double high;
    double low;
    double close;
    double volume;
    double quoteVolume;
    uint32_t trades;
    double takerBuyVolume;
    double takerBuyQuoteVolume;
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
 * ndtsdb_open_any — 自动检测格式打开数据库（快照模式，只读）
 *
 * 支持自动检测文件/目录路径和格式：
 * - 若 path 是文件：读取前 4 字节检测 Magic
 *   - "NDTS" → 使用 .ndts 格式加载
 *   - "NDTB" → 使用 .ndtb 格式加载
 * - 若 path 是目录：递归加载所有 .ndts 和 .ndtb 文件（自动混合）
 *
 * @param path  数据库文件或目录路径
 * @return      数据库句柄，失败返回 NULL
 *
 * 注意：这是 ndtsdb_open_snapshot(path, 0) 的便利包装，无读取大小限制。
 */
NDTSDB* ndtsdb_open_any(const char* path);

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

/* ─── 二进制序列化（Phase 2 优化）─────────────────────────────── */

/**
 * NDTSBinaryResult — 二进制查询结果（避免 JSON 序列化开销）
 *
 * @field data      行数据缓冲指针（堆分配，每行 128 字节）
 * @field count     总行数
 * @field stride    每行字节数（固定 128）
 * @field magic     魔数 "NDB\0" 用于验证
 */
typedef struct {
    uint8_t* data;
    uint32_t count;
    uint32_t stride;
    char     magic[4];
} NDTSBinaryResult;

/**
 * ndtsdb_query_all_binary — 以二进制格式返回所有数据
 *
 * 避免 JSON 序列化开销，返回紧凑二进制格式。
 * 结果包含所有 symbol/interval 的所有 K 线数据。
 * 结果必须通过 ndtsdb_free_binary 释放。
 *
 * 二进制格式（每行 160 字节，8 字节对齐）：
 *   偏移 0:   timestamp           int64_t (ms)
 *   偏移 8:   open                double
 *   偏移 16:  high                double
 *   偏移 24:  low                 double
 *   偏移 32:  close               double
 *   偏移 40:  volume              double
 *   偏移 48:  quoteVolume         double
 *   偏移 56:  trades              uint32_t
 *   偏移 60:  _pad1               uint32_t (padding to 8 bytes)
 *   偏移 64:  takerBuyVolume      double
 *   偏移 72:  takerBuyQuoteVolume double
 *   偏移 80:  flags               uint32_t
 *   偏移 84:  _pad2               uint32_t (padding to 8 bytes)
 *   偏移 88:  symbol              char[32] (null-terminated)
 *   偏移 120: interval            char[16] (null-terminated)
 *   偏移 136: _reserved           char[24] (reserved)
 *
 * @param db  数据库句柄
 * @return    NDTSBinaryResult*（堆分配），失败返回 NULL
 */
NDTSBinaryResult* ndtsdb_query_all_binary(NDTSDB* db);

/**
 * ndtsdb_free_binary — 释放二进制查询结果
 *
 * @param result  ndtsdb_query_all_binary 返回的指针，NULL 安全
 */
void ndtsdb_free_binary(NDTSBinaryResult* result);

/**
 * ndtsdb_binary_get_data — 获取二进制结果的数据指针
 *
 * 用于 FFI 环境中方便访问数据缓冲
 *
 * @param result  ndtsdb_query_all_binary 返回的指针
 * @return        数据缓冲指针，NULL 表示无数据
 */
uint8_t* ndtsdb_binary_get_data(NDTSBinaryResult* result);

/**
 * ndtsdb_binary_get_count — 获取二进制结果的行数
 *
 * @param result  ndtsdb_query_all_binary 返回的指针
 * @return        行数
 */
uint32_t ndtsdb_binary_get_count(NDTSBinaryResult* result);

/**
 * ndtsdb_binary_get_stride — 获取二进制结果的行大小
 *
 * @param result  ndtsdb_query_all_binary 返回的指针
 * @return        每行字节数（固定 128）
 */
uint32_t ndtsdb_binary_get_stride(NDTSBinaryResult* result);

/* ─── Phase 2: Sparse Index & Streaming Iterator (Issue #139) ─── */

/**
 * SparseIndexEntry - 单个索引条目（对应一个 block）
 *
 * @field block_offset  块在文件中的字节偏移
 * @field min_ts        块内时间戳最小值（int64_t）
 * @field max_ts        块内时间戳最大值（int64_t）
 * @field row_count     块内行数
 */
typedef struct {
    uint64_t block_offset;
    int64_t min_ts;
    int64_t max_ts;
    uint32_t row_count;
} SparseIndexEntry;

/**
 * SparseIndex - 时间戳稀疏索引（用于范围查询加速）
 *
 * @field entries     索引条目数组（按块偏移有序）
 * @field entry_count 条目总数
 * @field is_sorted   条目是否已排序
 */
typedef struct {
    SparseIndexEntry* entries;
    uint32_t entry_count;
    int is_sorted;
} SparseIndex;

/**
 * StreamingIterator - 流式读取迭代器（用于大文件不溢出内存）
 *
 * @field file_path   源文件路径
 * @field f           打开的文件指针
 * @field block_rows  单次读取的行数（默认 10000）
 * @field current_block 当前块的数据缓冲区（KlineRow[]）
 * @field block_size  current_block 中的行数
 * @field block_idx   当前块的全局起始行号
 * @field total_rows  文件中的总行数
 * @field eof         是否已到达文件末尾
 * @field header_offset 列数据块的起始偏移（跳过 header）
 * @field sym_dict    symbol 字典
 * @field itv_dict    interval 字典
 * @field n_sym       symbol 数量
 * @field n_itv       interval 数量
 * @field read_buffer 压缩块的读缓冲区
 * @field read_buffer_cap 读缓冲区容量
 */
typedef struct {
    char file_path[512];
    FILE* f;
    uint32_t block_rows;
    KlineRow* current_block;
    uint32_t block_size;
    uint32_t block_idx;
    uint32_t total_rows;
    int eof;
    uint64_t header_offset;
    char** sym_dict;
    char** itv_dict;
    int n_sym;
    int n_itv;
    uint8_t* read_buffer;
    uint32_t read_buffer_cap;
} StreamingIterator;

/**
 * ndtb_sparse_index_create — 为 NDTB 文件构建稀疏索引
 *
 * 扫描 NDTB 文件的时间戳列，构建块级别的 min/max 索引。
 * 用于后续范围查询加速。
 *
 * @param file_path   NDTB 文件路径
 * @param block_rows  每个块的目标行数（建议 1000-10000）
 * @return            SparseIndex 指针（成功）或 NULL（失败）
 */
SparseIndex* ndtb_sparse_index_create(const char* file_path, uint32_t block_rows);

/**
 * ndtb_sparse_index_query_range — 使用索引过滤时间范围内的块
 *
 * 给定时间范围 [min_ts, max_ts]，返回包含该范围数据的块索引。
 * 调用者负责释放返回的数组（使用 free()）。
 *
 * @param idx         稀疏索引
 * @param min_ts      时间范围下界（毫秒）
 * @param max_ts      时间范围上界（毫秒）
 * @param out_count   输出参数：符合条件的块数
 * @return            块索引数组（0-based），NULL 表示失败
 */
uint32_t* ndtb_sparse_index_query_range(const SparseIndex* idx,
                                        int64_t min_ts, int64_t max_ts,
                                        uint32_t* out_count);

/**
 * ndtb_sparse_index_free — 释放稀疏索引
 *
 * @param idx  稀疏索引指针，NULL 安全
 */
void ndtb_sparse_index_free(SparseIndex* idx);

/**
 * ndtb_streaming_iterator_create — 创建 NDTB 文件的流式读取迭代器
 *
 * 打开 NDTB 文件并准备流式读取，不一次性加载所有数据到内存。
 * 调用者通过 ndtb_streaming_iterator_next() 逐块读取行数据。
 *
 * @param file_path   NDTB 文件路径
 * @param block_rows  单次读取的行数（建议 1000-10000）
 * @return            StreamingIterator 指针（成功）或 NULL（失败）
 */
StreamingIterator* ndtb_streaming_iterator_create(const char* file_path,
                                                  uint32_t block_rows);

/**
 * ndtb_streaming_iterator_next — 读取下一个数据块
 *
 * 从迭代器读取最多 block_rows 行数据。返回的行数可能少于
 * block_rows（最后一块）。返回 0 表示 EOF 或错误。
 *
 * 返回的行数据保存在 iter->current_block 中，
 * 调用者应在调用 next() 之前复制或使用这些数据。
 *
 * @param iter  流式迭代器
 * @return      当前块的行数（0 = EOF）
 */
uint32_t ndtb_streaming_iterator_next(StreamingIterator* iter);

/**
 * ndtb_streaming_iterator_free — 释放流式迭代器
 *
 * @param iter  迭代器指针，NULL 安全
 */
void ndtb_streaming_iterator_free(StreamingIterator* iter);

/* ─── NDTB File Operations (Phase 2 Internal) ─── */

/**
 * write_ndtb_file — 将数据库内容写入 NDTB 文件
 *
 * @param filepath  输出文件路径
 * @param db        数据库句柄
 * @return          成功返回写入的行数，失败返回 -1
 */
int write_ndtb_file(const char* filepath, NDTSDB* db);

#ifdef __cplusplus
}
#endif

#endif /* NDTSDB_H */
