/* HNSW 索引持久化测试 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <assert.h>
#include <unistd.h>
#include "ndtsdb.h"

/* 模拟 ndtsdb_get_path */
static char test_db_path[256] = "/tmp/test_hnsw_db";
const char* ndtsdb_get_path(NDTSDB* db) { (void)db; return test_db_path; }

/* 包含被测代码 */
#include "ndtsdb_vec.c"

/* 创建测试目录 */
void setup() {
    system("mkdir -p /tmp/test_hnsw_db");
    system("rm -f /tmp/test_hnsw_db/test__1m.ndtv /tmp/test_hnsw_db/test__1m.hnsw");
}

/* 清理 */
void cleanup() {
    system("rm -rf /tmp/test_hnsw_db");
}

/* 测试向量写入和索引构建 */
void test_build_and_save() {
    printf("[TEST] 构建 HNSW 索引并保存...\n");
    
    /* 创建模拟数据库句柄（实际只使用路径） */
    NDTSDB* db = (NDTSDB*)1;
    
    /* 插入测试向量 */
    int dim = 128;
    int num_vectors = 100;
    
    for (int i = 0; i < num_vectors; i++) {
        VecRecord rec;
        rec.timestamp = 1000000LL + i;
        strcpy(rec.agent_id, "test_agent");
        strcpy(rec.type, "semantic");
        rec.confidence = 0.9f;
        rec.embedding_dim = dim;
        rec.embedding = (float*)malloc(dim * sizeof(float));
        rec.flags = 0;
        
        /* 生成随机向量 */
        for (int j = 0; j < dim; j++) {
            rec.embedding[j] = (float)rand() / RAND_MAX;
        }
        
        int ret = ndtsdb_vec_insert(db, "test", "1m", &rec);
        assert(ret == 0);
        free(rec.embedding);
    }
    
    printf("  ✓ 写入 %d 条向量记录\n", num_vectors);
    
    /* 构建 HNSW 索引 */
    VecHnswConfig config = { .M = 16, .ef_construction = 100, .ef_search = 50 };
    int ret = ndtsdb_vec_build_index(db, "test", "1m", &config);
    assert(ret == 0);
    
    printf("  ✓ HNSW 索引构建成功\n");
    
    /* 验证索引文件存在 */
    assert(access("/tmp/test_hnsw_db/test__1m.hnsw", F_OK) == 0);
    printf("  ✓ 索引文件已保存\n");
}

/* 测试索引加载和搜索 */
void test_load_and_search() {
    printf("[TEST] 加载 HNSW 索引并搜索...\n");
    
    NDTSDB* db = (NDTSDB*)1;
    int dim = 128;
    
    /* 验证索引存在 */
    int has_idx = ndtsdb_vec_has_index(db, "test", "1m");
    assert(has_idx == 1);
    printf("  ✓ 索引存在检测通过\n");
    
    /* 构建查询向量 */
    float query[128];
    for (int j = 0; j < dim; j++) {
        query[j] = (float)rand() / RAND_MAX;
    }
    
    /* HNSW 搜索 */
    VecQueryResult* result = ndtsdb_vec_search(db, "test", "1m", query, dim, 10, NULL);
    assert(result != NULL);
    assert(result->count > 0);
    printf("  ✓ HNSW 搜索返回 %d 个结果\n", result->count);
    
    ndtsdb_vec_free_result(result);
}

/* 测试索引文件格式 */
void test_index_format() {
    printf("[TEST] 验证索引文件格式...\n");
    
    FILE* f = fopen("/tmp/test_hnsw_db/test__1m.hnsw", "rb");
    assert(f != NULL);
    
    /* 读取魔数 */
    char magic[4];
    (void)fread(magic, 1, 4, f);
    assert(memcmp(magic, "NHNS", 4) == 0);
    printf("  ✓ 魔数正确 (NHNS)\n");
    
    /* 读取版本 */
    uint16_t ver;
    (void)fread(&ver, 2, 1, f);
    assert(ver == 0x0001);
    printf("  ✓ 版本正确 (0x0001)\n");
    
    /* 读取 M */
    uint16_t M;
    (void)fread(&M, 2, 1, f);
    printf("  ✓ M = %d\n", M);
    
    /* 读取 ef_construction */
    uint32_t ef_c;
    (void)fread(&ef_c, 4, 1, f);
    printf("  ✓ ef_construction = %d\n", ef_c);
    
    /* 读取 ef_search */
    uint32_t ef_s;
    (void)fread(&ef_s, 4, 1, f);
    printf("  ✓ ef_search = %d\n", ef_s);
    
    /* 读取 dim */
    uint32_t dim;
    (void)fread(&dim, 4, 1, f);
    printf("  ✓ dim = %d\n", dim);
    
    /* 读取节点数 */
    uint64_t num_nodes;
    (void)fread(&num_nodes, 8, 1, f);
    printf("  ✓ num_nodes = %lu\n", num_nodes);
    
    /* 读取 entry_point */
    int64_t entry_point;
    (void)fread(&entry_point, 8, 1, f);
    printf("  ✓ entry_point = %ld\n", entry_point);
    
    fclose(f);
}

int main() {
    printf("=== HNSW 索引持久化测试 ===\n\n");
    
    srand(42);
    setup();
    
    test_build_and_save();
    test_index_format();
    test_load_and_search();
    
    cleanup();
    
    printf("\n=== 所有测试通过 ===\n");
    return 0;
}
