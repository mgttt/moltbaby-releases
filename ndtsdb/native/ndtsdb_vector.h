/**
 * ndtsdb_vector.h — 向量字段存储扩展
 *
 * 在不修改 KlineRow / 现有 API 的前提下，为 ndtsdb 添加
 * float 数组（embedding）存储能力。
 *
 * 文件格式：<db_path>/<symbol>__<interval>.ndtv
 *   - 文件头：固定 64 字节（magic + version + record_count）
 *   - 记录序列：定长头 + 变长 embedding（float32 数组）
 *
 * 线程安全：否，与 ndtsdb 一致。
 */
#ifndef NDTSDB_VECTOR_H
#define NDTSDB_VECTOR_H

#include <stdint.h>
#include "ndtsdb.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ─── 数据结构 ─────────────────────────────────────────── */

/**
 * VectorRecord — 单条向量记录
 *
 * @field timestamp     毫秒 epoch（int64_t）
 * @field agent_id      来源 agent 标识（最大 31 字节）
 * @field type          语义类型："semantic"/"episodic"/"procedural"
 * @field confidence    置信度 [0.0, 1.0]
 * @field embedding_dim embedding 维度（float32 数组长度）
 * @field embedding     float32 数组（堆分配，须调用方管理）
 * @field flags         保留标志位
 */
typedef struct {
    int64_t  timestamp;
    char     agent_id[32];
    char     type[16];
    float    confidence;
    uint16_t embedding_dim;
    float*   embedding;    /* 调用方分配，写入后不转移所有权 */
    uint32_t flags;
} VectorRecord;

/**
 * VectorQueryResult — 向量查询结果（堆分配，须 ndtsdb_vector_free_result 释放）
 *
 * @field records  VectorRecord 数组（embedding 各自独立堆分配）
 * @field count    有效记录数
 */
typedef struct {
    VectorRecord* records;
    uint32_t      count;
} VectorQueryResult;

/* ─── 写入 ─────────────────────────────────────────────── */

/**
 * ndtsdb_insert_vector — 插入单条向量记录
 *
 * @param db        数据库句柄（复用 NDTSDB 路径信息）
 * @param symbol    分区 symbol（最大 31 字节）
 * @param interval  分区 interval（最大 15 字节）
 * @param record    VectorRecord 指针（embedding 在函数内序列化，不转移所有权）
 * @return          0 成功，-1 失败
 */
int ndtsdb_insert_vector(NDTSDB* db,
                         const char* symbol,
                         const char* interval,
                         const VectorRecord* record);

/* ─── 查询 ─────────────────────────────────────────────── */

/**
 * ndtsdb_query_vectors — 查询向量记录
 *
 * @param db        数据库句柄
 * @param symbol    分区 symbol
 * @param interval  分区 interval
 * @return          VectorQueryResult*（堆分配），须 ndtsdb_vector_free_result 释放；
 *                  无记录时返回 count=0 的空结果，失败返回 NULL
 */
VectorQueryResult* ndtsdb_query_vectors(NDTSDB* db,
                                        const char* symbol,
                                        const char* interval);

/**
 * ndtsdb_vector_free_result — 释放查询结果（含各 embedding 数组）
 *
 * @param result  ndtsdb_query_vectors 返回的指针，NULL 安全
 */
void ndtsdb_vector_free_result(VectorQueryResult* result);

#ifdef __cplusplus
}
#endif

#endif /* NDTSDB_VECTOR_H */
