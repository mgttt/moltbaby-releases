/**
 * test_dlopen.c — 验证 libndtsdb.so 可被 dlopen 加载并调用
 */
#include <stdio.h>
#include <stdlib.h>
#include <dlfcn.h>
#include <string.h>
#include "libndtsdb.h"

#define TEST_ASSERT(cond, msg) do { \
    if (!(cond)) { \
        fprintf(stderr, "FAIL: %s\n", msg); \
        return 1; \
    } \
    printf("PASS: %s\n", msg); \
} while(0)

typedef NDTSDB* (*open_fn)(const char*);
typedef void (*close_fn)(NDTSDB*);
typedef int (*insert_fn)(NDTSDB*, const char*, const char*, const KlineRow*);
typedef QueryResult* (*query_fn)(NDTSDB*, const Query*);
typedef void (*free_result_fn)(QueryResult*);
typedef int64_t (*get_latest_ts_fn)(NDTSDB*, const char*, const char*);

int main(int argc, char** argv) {
    const char* lib_path = argc > 1 ? argv[1] : "./libndtsdb.so";
    
    printf("Loading library: %s\n", lib_path);
    
    void* handle = dlopen(lib_path, RTLD_NOW | RTLD_LOCAL);
    if (!handle) {
        fprintf(stderr, "dlopen failed: %s\n", dlerror());
        return 1;
    }
    printf("Library loaded successfully\n\n");
    
    // 获取函数指针
    open_fn ndtsdb_open = (open_fn)dlsym(handle, "ndtsdb_open");
    close_fn ndtsdb_close = (close_fn)dlsym(handle, "ndtsdb_close");
    insert_fn ndtsdb_insert = (insert_fn)dlsym(handle, "ndtsdb_insert");
    query_fn ndtsdb_query = (query_fn)dlsym(handle, "ndtsdb_query");
    free_result_fn ndtsdb_free_result = (free_result_fn)dlsym(handle, "ndtsdb_free_result");
    get_latest_ts_fn ndtsdb_get_latest_timestamp = (get_latest_ts_fn)dlsym(handle, "ndtsdb_get_latest_timestamp");
    
    // 验证函数存在
    TEST_ASSERT(ndtsdb_open != NULL, "ndtsdb_open symbol resolved");
    TEST_ASSERT(ndtsdb_close != NULL, "ndtsdb_close symbol resolved");
    TEST_ASSERT(ndtsdb_insert != NULL, "ndtsdb_insert symbol resolved");
    TEST_ASSERT(ndtsdb_query != NULL, "ndtsdb_query symbol resolved");
    TEST_ASSERT(ndtsdb_free_result != NULL, "ndtsdb_free_result symbol resolved");
    TEST_ASSERT(ndtsdb_get_latest_timestamp != NULL, "ndtsdb_get_latest_timestamp symbol resolved");
    
    printf("\n--- Functional Tests ---\n");
    
    // 测试1: 打开数据库
    const char* db_path = "/tmp/test_dlopen_db";
    system("rm -rf /tmp/test_dlopen_db");
    
    NDTSDB* db = ndtsdb_open(db_path);
    TEST_ASSERT(db != NULL, "ndtsdb_open returns valid handle");
    
    // 测试2: 插入数据
    KlineRow row = {
        .timestamp = 1704067200000LL,  // 2024-01-01 00:00:00 UTC
        .open = 100.0,
        .high = 105.0,
        .low = 99.0,
        .close = 102.5,
        .volume = 1000.0,
        .flags = 0
    };
    int rc = ndtsdb_insert(db, "BTCUSDT", "1h", &row);
    TEST_ASSERT(rc == 0, "ndtsdb_insert succeeds");
    
    // 测试3: 获取最新时间戳
    int64_t ts = ndtsdb_get_latest_timestamp(db, "BTCUSDT", "1h");
    TEST_ASSERT(ts == 1704067200000LL, "ndtsdb_get_latest_timestamp returns correct value");
    
    // 测试4: 查询数据
    Query q = {
        .symbol = "BTCUSDT",
        .interval = "1h",
        .startTime = 0,
        .endTime = 9999999999999LL,
        .limit = 100
    };
    QueryResult* result = ndtsdb_query(db, &q);
    TEST_ASSERT(result != NULL, "ndtsdb_query returns result");
    TEST_ASSERT(result->count == 1, "query returns 1 row");
    TEST_ASSERT(result->rows[0].close == 102.5, "returned row has correct close price");
    
    ndtsdb_free_result(result);
    
    // 测试5: 关闭数据库
    ndtsdb_close(db);
    printf("PASS: ndtsdb_close executes without crash\n");
    
    // 清理
    system("rm -rf /tmp/test_dlopen_db");
    dlclose(handle);
    
    printf("\n=== All tests passed ===\n");
    return 0;
}
