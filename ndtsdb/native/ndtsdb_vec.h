/**
 * ndtsdb_vec.h — 向量字段存储扩展 (ndtsdb-vec)
 *
 * 在不修改 KlineRow / 现有 API 的前提下，为 ndtsdb 添加
 * float 数组（embedding）存储能力。
 *
 * 文件格式：<db_path>/<symbol>__<interval>.ndtv
 *   - 文件头：固定 64 字节（magic + version + record_count）
 *   - 记录序列：定长头 + 变长 embedding（float32 数组）
 *   - HNSW 索引：<db_path>/<symbol>__<interval>.hnsw（可选）
 *
 * 线程安全：否，与 ndtsdb 一致。
 */
#ifndef NDTSDB_VEC_H
#define NDTSDB_VEC_H

#include <stdint.h>
#include "ndtsdb.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ─── 数据结构 ─────────────────────────────────────────── */

/**
 * VecRecord — 单条向量记录
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
} VecRecord;

/**
 * VecQueryResult — 向量查询结果（堆分配，须 ndtsdb_vec_free_result 释放）
 *
 * @field records  VecRecord 数组（embedding 各自独立堆分配）
 * @field count    有效记录数
 */
typedef struct {
    VecRecord* records;
    uint32_t   count;
} VecQueryResult;

/* ─── HNSW 索引配置 ────────────────────────────────────── */

typedef struct {
    int M;              /* 每个节点的最大连接数，默认 16 */
    int ef_construction; /* 构建时的搜索范围，默认 200 */
    int ef_search;       /* 搜索时的搜索范围，默认 50 */
} VecHnswConfig;

/* ─── 写入 ─────────────────────────────────────────────── */

/**
 * ndtsdb_vec_insert — 插入单条向量记录
 *
 * @param db        数据库句柄（复用 NDTSDB 路径信息）
 * @param symbol    分区 symbol（最大 31 字节）
 * @param interval  分区 interval（最大 15 字节）
 * @param record    VecRecord 指针（embedding 在函数内序列化，不转移所有权）
 * @return          0 成功，-1 失败
 */
int ndtsdb_vec_insert(NDTSDB* db,
                      const char* symbol,
                      const char* interval,
                      const VecRecord* record);

/* ─── 查询 ─────────────────────────────────────────────── */

/**
 * ndtsdb_vec_query — 查询向量记录（全表扫描）
 *
 * @param db        数据库句柄
 * @param symbol    分区 symbol
 * @param interval  分区 interval
 * @return          VecQueryResult*（堆分配），须 ndtsdb_vec_free_result 释放；
 *                  无记录时返回 count=0 的空结果，失败返回 NULL
 */
VecQueryResult* ndtsdb_vec_query(NDTSDB* db,
                                 const char* symbol,
                                 const char* interval);

/**
 * ndtsdb_vec_search — HNSW 近似最近邻搜索
 *
 * @param db        数据库句柄
 * @param symbol    分区 symbol
 * @param interval  分区 interval
 * @param query     查询向量
 * @param dim       向量维度
 * @param top_k     返回最相似的 k 个结果
 * @param config    HNSW 配置（NULL 使用默认）
 * @return          VecQueryResult*（堆分配），须 ndtsdb_vec_free_result 释放
 */
VecQueryResult* ndtsdb_vec_search(NDTSDB* db,
                                  const char* symbol,
                                  const char* interval,
                                  const float* query,
                                  int dim,
                                  int top_k,
                                  const VecHnswConfig* config);

/**
 * ndtsdb_vec_free_result — 释放查询结果（含各 embedding 数组）
 *
 * @param result  ndtsdb_vec_query 或 ndtsdb_vec_search 返回的指针，NULL 安全
 */
void ndtsdb_vec_free_result(VecQueryResult* result);

/* ─── HNSW 索引管理 ────────────────────────────────────── */

/**
 * ndtsdb_vec_build_index — 为指定分区构建 HNSW 索引
 *
 * @param db        数据库句柄
 * @param symbol    分区 symbol
 * @param interval  分区 interval
 * @param config    HNSW 配置（NULL 使用默认）
 * @return          0 成功，-1 失败
 */
int ndtsdb_vec_build_index(NDTSDB* db,
                           const char* symbol,
                           const char* interval,
                           const VecHnswConfig* config);

/**
 * ndtsdb_vec_has_index — 检查指定分区是否有 HNSW 索引
 *
 * @param db        数据库句柄
 * @param symbol    分区 symbol
 * @param interval  分区 interval
 * @return          1 有索引，0 无索引
 */
int ndtsdb_vec_has_index(NDTSDB* db,
                         const char* symbol,
                         const char* interval);

#ifdef __cplusplus
}
#endif

#endif /* NDTSDB_VEC_H */
