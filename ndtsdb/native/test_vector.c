/**
 * test_vector.c — VectorRecord 存储层单元测试
 *
 * 编译：gcc -o test_vector test_vector.c ndtsdb_vector.c ndts.c -lm
 * 运行：./test_vector
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <assert.h>
#include "ndtsdb.h"
#include "ndtsdb_vector.h"

/* ─── 测试辅助 ──────────────────────────────────────────── */

static int g_pass = 0, g_fail = 0;

#define CHECK(cond, msg) do { \
    if (cond) { printf("  ✓ %s\n", msg); g_pass++; } \
    else { printf("  ✗ %s (line %d)\n", msg, __LINE__); g_fail++; } \
} while(0)

#define FCHECK(a, b, eps, msg) CHECK(fabs((double)(a)-(double)(b)) < (eps), msg)

/* ─── 测试：基本写入/读取 ───────────────────────────────── */

static void test_basic_insert_query(NDTSDB* db)
{
    printf("\n[1] 基本写入/读取\n");

    float emb[4] = {0.1f, 0.2f, 0.3f, 0.4f};

    VectorRecord rec = {
        .timestamp     = 1700000000000LL,
        .agent_id      = "agent-001",
        .type          = "semantic",
        .confidence    = 0.95f,
        .embedding_dim = 4,
        .embedding     = emb,
        .flags         = 0
    };

    int ret = ndtsdb_insert_vector(db, "BTC", "1m", &rec);
    CHECK(ret == 0, "insert_vector returns 0");

    VectorQueryResult* r = ndtsdb_query_vectors(db, "BTC", "1m");
    CHECK(r != NULL, "query_vectors not NULL");
    CHECK(r->count == 1, "count == 1");

    if (r && r->count == 1) {
        VectorRecord* got = &r->records[0];
        CHECK(got->timestamp == 1700000000000LL, "timestamp matches");
        CHECK(strcmp(got->agent_id, "agent-001") == 0, "agent_id matches");
        CHECK(strcmp(got->type, "semantic") == 0, "type matches");
        FCHECK(got->confidence, 0.95f, 1e-5, "confidence matches");
        CHECK(got->embedding_dim == 4, "embedding_dim == 4");
        CHECK(got->embedding != NULL, "embedding not NULL");
        if (got->embedding) {
            FCHECK(got->embedding[0], 0.1f, 1e-5, "embedding[0]");
            FCHECK(got->embedding[1], 0.2f, 1e-5, "embedding[1]");
            FCHECK(got->embedding[2], 0.3f, 1e-5, "embedding[2]");
            FCHECK(got->embedding[3], 0.4f, 1e-5, "embedding[3]");
        }
    }

    ndtsdb_vector_free_result(r);
}

/* ─── 测试：多条记录 ────────────────────────────────────── */

static void test_multiple_records(NDTSDB* db)
{
    printf("\n[2] 多条记录追加写\n");

    float emb_a[3] = {1.0f, 2.0f, 3.0f};
    float emb_b[3] = {4.0f, 5.0f, 6.0f};

    VectorRecord ra = {
        .timestamp = 1700000001000LL, .agent_id = "agent-002",
        .type = "episodic", .confidence = 0.8f,
        .embedding_dim = 3, .embedding = emb_a, .flags = 0
    };
    VectorRecord rb = {
        .timestamp = 1700000002000LL, .agent_id = "agent-003",
        .type = "procedural", .confidence = 0.7f,
        .embedding_dim = 3, .embedding = emb_b, .flags = 1
    };

    CHECK(ndtsdb_insert_vector(db, "ETH", "5m", &ra) == 0, "insert ETH record A");
    CHECK(ndtsdb_insert_vector(db, "ETH", "5m", &rb) == 0, "insert ETH record B");

    VectorQueryResult* r = ndtsdb_query_vectors(db, "ETH", "5m");
    CHECK(r != NULL, "query ETH not NULL");
    CHECK(r->count == 2, "count == 2");

    if (r && r->count == 2) {
        CHECK(r->records[0].timestamp == 1700000001000LL, "record[0] timestamp");
        CHECK(r->records[1].timestamp == 1700000002000LL, "record[1] timestamp");
        CHECK(strcmp(r->records[0].type, "episodic") == 0, "record[0] type");
        CHECK(strcmp(r->records[1].type, "procedural") == 0, "record[1] type");
        CHECK(r->records[1].flags == 1, "record[1] flags");
        FCHECK(r->records[1].embedding[2], 6.0f, 1e-5, "record[1] embedding[2]");
    }

    ndtsdb_vector_free_result(r);
}

/* ─── 测试：零维 embedding ──────────────────────────────── */

static void test_zero_dim(NDTSDB* db)
{
    printf("\n[3] 零维 embedding\n");

    VectorRecord rec = {
        .timestamp = 1700000003000LL, .agent_id = "agent-004",
        .type = "semantic", .confidence = 1.0f,
        .embedding_dim = 0, .embedding = NULL, .flags = 0
    };

    CHECK(ndtsdb_insert_vector(db, "SOL", "1h", &rec) == 0, "insert zero-dim");

    VectorQueryResult* r = ndtsdb_query_vectors(db, "SOL", "1h");
    CHECK(r != NULL, "query SOL not NULL");
    CHECK(r->count == 1, "count == 1");
    if (r && r->count == 1) {
        CHECK(r->records[0].embedding_dim == 0, "dim == 0");
        CHECK(r->records[0].embedding == NULL, "embedding is NULL");
    }
    ndtsdb_vector_free_result(r);
}

/* ─── 测试：symbol 分区隔离 ─────────────────────────────── */

static void test_partition_isolation(NDTSDB* db)
{
    printf("\n[4] symbol 分区隔离\n");

    /* BTC 已写 1 条，ETH 已写 2 条，现在查 SOL/1m 应为 0 */
    VectorQueryResult* r = ndtsdb_query_vectors(db, "SOL", "1m");
    CHECK(r != NULL, "query empty partition not NULL");
    CHECK(r->count == 0, "empty partition count == 0");
    ndtsdb_vector_free_result(r);

    /* ETH/1m 也应为 0（只写了 ETH/5m）*/
    r = ndtsdb_query_vectors(db, "ETH", "1m");
    CHECK(r != NULL, "ETH/1m not NULL");
    CHECK(r->count == 0, "ETH/1m count == 0");
    ndtsdb_vector_free_result(r);
}

/* ─── 测试：高维 embedding ──────────────────────────────── */

static void test_high_dim(NDTSDB* db)
{
    printf("\n[5] 高维 embedding (dim=128)\n");

    uint16_t dim = 128;
    float* emb = (float*)malloc(dim * sizeof(float));
    for (int i = 0; i < dim; i++) emb[i] = (float)i * 0.01f;

    VectorRecord rec = {
        .timestamp = 1700000010000LL, .agent_id = "agent-005",
        .type = "semantic", .confidence = 0.99f,
        .embedding_dim = dim, .embedding = emb, .flags = 0
    };

    CHECK(ndtsdb_insert_vector(db, "BNB", "1h", &rec) == 0, "insert dim=128");
    free(emb);

    VectorQueryResult* r = ndtsdb_query_vectors(db, "BNB", "1h");
    CHECK(r != NULL, "query BNB not NULL");
    CHECK(r->count == 1, "count == 1");
    if (r && r->count == 1) {
        CHECK(r->records[0].embedding_dim == 128, "dim == 128");
        CHECK(r->records[0].embedding != NULL, "embedding not NULL");
        if (r->records[0].embedding) {
            FCHECK(r->records[0].embedding[0],   0.00f, 1e-5, "embedding[0]");
            FCHECK(r->records[0].embedding[127], 1.27f, 1e-4, "embedding[127]");
        }
    }
    ndtsdb_vector_free_result(r);
}

/* ─── 测试：KlineRow 不受影响 ───────────────────────────── */

static void test_klinerow_unaffected(NDTSDB* db)
{
    printf("\n[6] KlineRow 操作不受影响\n");

    KlineRow row = {
        .timestamp = 1700000000000LL,
        .open = 100.0, .high = 110.0, .low = 90.0,
        .close = 105.0, .volume = 1000.0, .flags = 0
    };

    int ret = ndtsdb_insert(db, "BTC", "1m", &row);
    CHECK(ret == 0, "KlineRow insert still works");

    QueryResult* qr = ndtsdb_query_all(db);
    CHECK(qr != NULL, "KlineRow query_all not NULL");
    CHECK(qr->count >= 1, "KlineRow count >= 1");
    ndtsdb_free_result(qr);
}

/* ─── main ──────────────────────────────────────────────── */

int main(void)
{
    printf("=== ndtsdb_vector 单元测试 ===\n");

    /* 使用临时目录 */
    char tmpdir[] = "/tmp/ndtv_test_XXXXXX";
    if (!mkdtemp(tmpdir)) {
        perror("mkdtemp"); return 1;
    }
    printf("测试目录: %s\n", tmpdir);

    NDTSDB* db = ndtsdb_open(tmpdir);
    if (!db) { fprintf(stderr, "ndtsdb_open failed\n"); return 1; }

    test_basic_insert_query(db);
    test_multiple_records(db);
    test_zero_dim(db);
    test_partition_isolation(db);
    test_high_dim(db);
    test_klinerow_unaffected(db);

    ndtsdb_close(db);

    printf("\n================================\n");
    printf("结果: %d passed, %d failed\n", g_pass, g_fail);
    printf("================================\n");

    return g_fail > 0 ? 1 : 0;
}
