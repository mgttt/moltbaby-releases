// ============================================================
// lib-ndtsdb-qjs: QuickJS -> ndtsdb 绑定层 (MVP)
// ============================================================

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ndtsdb.h"
#include "ndtsdb_vector.h"
#include "quickjs.h"

// Cosmocc 兼容性：显式前向声明
extern QueryResult* ndtsdb_query_all(NDTSDB* db);
extern QueryResult* ndtsdb_query_time_range(NDTSDB* db, int64_t since_ms, int64_t until_ms);
extern QueryResult* ndtsdb_query_filtered(NDTSDB* db, const char** symbols, int n_symbols);
extern QueryResult* ndtsdb_query_filtered_time(NDTSDB* db, const char** symbols, int n_symbols, int64_t since_ms, int64_t until_ms);

#define countof(x) (sizeof(x) / sizeof((x)[0]))

static JSClassID js_ndtsdb_class_id = 0;

// 辅助：参数检查宏
#define CHECK_ARGC(ctx, argc, expected) \
    do { if (argc < expected) return JS_ThrowTypeError(ctx, "expected %d arguments, got %d", expected, argc); } while(0)

// ============ open ============
static JSValue js_ndtsdb_open(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
    CHECK_ARGC(ctx, argc, 1);
    
    // 显式检查类型：必须是字符串
    if (!JS_IsString(argv[0])) {
        return JS_ThrowTypeError(ctx, "path must be a string");
    }
    
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_ThrowTypeError(ctx, "failed to convert path to string");
    
    NDTSDB *db = ndtsdb_open(path);
    JS_FreeCString(ctx, path);
    
    if (!db) return JS_ThrowInternalError(ctx, "failed to open database");
    
    // 使用 double 存储指针（JS number 是 64-bit float，可以精确表示 64-bit 指针）
    return JS_NewFloat64(ctx, (double)(uintptr_t)db);
}

// ============ close ============
static JSValue js_ndtsdb_close(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
    CHECK_ARGC(ctx, argc, 1);
    
    double db_handle;
    if (JS_ToFloat64(ctx, &db_handle, argv[0])) 
        return JS_ThrowTypeError(ctx, "db handle must be a number");
    
    NDTSDB *db = (NDTSDB *)(uintptr_t)db_handle;
    if (!db) return JS_ThrowTypeError(ctx, "invalid db handle");
    
    ndtsdb_close(db);
    return JS_UNDEFINED;
}

// ============ insert ============
static JSValue js_ndtsdb_insert(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    CHECK_ARGC(ctx, argc, 4);
    
    double db_handle;
    if (JS_ToFloat64(ctx, &db_handle, argv[0])) 
        return JS_ThrowTypeError(ctx, "db handle must be a number");
    NDTSDB *db = (NDTSDB *)(uintptr_t)db_handle;
    if (!db) return JS_ThrowTypeError(ctx, "invalid db handle");
    
    const char *symbol = JS_ToCString(ctx, argv[1]);
    if (!symbol) {
        JS_FreeCString(ctx, symbol);
        return JS_ThrowTypeError(ctx, "symbol must be a string");
    }
    
    const char *interval = JS_ToCString(ctx, argv[2]);
    if (!interval) {
        JS_FreeCString(ctx, symbol);
        JS_FreeCString(ctx, interval);
        return JS_ThrowTypeError(ctx, "interval must be a string");
    }
    
    // 解析 row 对象
    JSValue obj = argv[3];
    if (!JS_IsObject(obj)) {
        JS_FreeCString(ctx, symbol);
        JS_FreeCString(ctx, interval);
        return JS_ThrowTypeError(ctx, "row must be an object");
    }
    
    int64_t ts_int64;
    double open_val, high, low, close_val, volume;
    if (JS_IsException(JS_GetPropertyStr(ctx, obj, "timestamp"))) {
        JS_FreeCString(ctx, symbol);
        JS_FreeCString(ctx, interval);
        return JS_ThrowTypeError(ctx, "row.timestamp is required");
    }
    JS_ToInt64Ext(ctx, &ts_int64, JS_GetPropertyStr(ctx, obj, "timestamp"));
    JS_ToFloat64(ctx, &open_val, JS_GetPropertyStr(ctx, obj, "open"));
    JS_ToFloat64(ctx, &high, JS_GetPropertyStr(ctx, obj, "high"));
    JS_ToFloat64(ctx, &low, JS_GetPropertyStr(ctx, obj, "low"));
    JS_ToFloat64(ctx, &close_val, JS_GetPropertyStr(ctx, obj, "close"));
    JS_ToFloat64(ctx, &volume, JS_GetPropertyStr(ctx, obj, "volume"));
    
    KlineRow row = {
        .timestamp = ts_int64,
        .open = open_val,
        .high = high,
        .low = low,
        .close = close_val,
        .volume = volume,
        .flags = 0
    };
    
    int result = ndtsdb_insert(db, symbol, interval, &row);
    
    JS_FreeCString(ctx, symbol);
    JS_FreeCString(ctx, interval);
    
    if (result < 0) return JS_ThrowInternalError(ctx, "insert failed");
    
    return JS_NewInt32(ctx, result);
}

// ============ insert_batch ============
static JSValue js_ndtsdb_insert_batch(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv) {
    CHECK_ARGC(ctx, argc, 4);
    
    double db_handle;
    if (JS_ToFloat64(ctx, &db_handle, argv[0])) 
        return JS_ThrowTypeError(ctx, "db handle must be a number");
    NDTSDB *db = (NDTSDB *)(uintptr_t)db_handle;
    if (!db) return JS_ThrowTypeError(ctx, "invalid db handle");
    
    const char *symbol = JS_ToCString(ctx, argv[1]);
    if (!symbol) return JS_ThrowTypeError(ctx, "symbol must be a string");
    
    const char *interval = JS_ToCString(ctx, argv[2]);
    if (!interval) {
        JS_FreeCString(ctx, symbol);
        return JS_ThrowTypeError(ctx, "interval must be a string");
    }
    
    // rows 必须是数组
    JSValue rows_arr = argv[3];
    if (!JS_IsArray(ctx, rows_arr)) {
        JS_FreeCString(ctx, symbol);
        JS_FreeCString(ctx, interval);
        return JS_ThrowTypeError(ctx, "rows must be an array");
    }
    
    // 获取数组长度
    JSValue len_val = JS_GetPropertyStr(ctx, rows_arr, "length");
    int64_t len;
    if (JS_ToInt64(ctx, &len, len_val)) {
        JS_FreeValue(ctx, len_val);
        JS_FreeCString(ctx, symbol);
        JS_FreeCString(ctx, interval);
        return JS_ThrowTypeError(ctx, "failed to get rows length");
    }
    JS_FreeValue(ctx, len_val);
    
    if (len == 0) {
        JS_FreeCString(ctx, symbol);
        JS_FreeCString(ctx, interval);
        return JS_NewInt32(ctx, 0);
    }
    
    // 分配内存
    KlineRow *rows = malloc(sizeof(KlineRow) * len);
    if (!rows) {
        JS_FreeCString(ctx, symbol);
        JS_FreeCString(ctx, interval);
        return JS_ThrowInternalError(ctx, "failed to allocate memory for rows");
    }
    
    // 解析每一行
    for (int64_t i = 0; i < len; i++) {
        JSValue row_obj = JS_GetPropertyUint32(ctx, rows_arr, (uint32_t)i);
        if (!JS_IsObject(row_obj)) {
            free(rows);
            JS_FreeValue(ctx, row_obj);
            JS_FreeCString(ctx, symbol);
            JS_FreeCString(ctx, interval);
            return JS_ThrowTypeError(ctx, "row[%lld] must be an object", (long long)i);
        }
        
        int64_t ts_int64;
        double open_val, high, low, close_val, volume;
        JS_ToInt64Ext(ctx, &ts_int64, JS_GetPropertyStr(ctx, row_obj, "timestamp"));
        JS_ToFloat64(ctx, &open_val, JS_GetPropertyStr(ctx, row_obj, "open"));
        JS_ToFloat64(ctx, &high, JS_GetPropertyStr(ctx, row_obj, "high"));
        JS_ToFloat64(ctx, &low, JS_GetPropertyStr(ctx, row_obj, "low"));
        JS_ToFloat64(ctx, &close_val, JS_GetPropertyStr(ctx, row_obj, "close"));
        JS_ToFloat64(ctx, &volume, JS_GetPropertyStr(ctx, row_obj, "volume"));
        
        rows[i] = (KlineRow){
            .timestamp = ts_int64,
            .open = open_val,
            .high = high,
            .low = low,
            .close = close_val,
            .volume = volume,
            .flags = 0
        };
        
        JS_FreeValue(ctx, row_obj);
    }
    
    int result = ndtsdb_insert_batch(db, symbol, interval, rows, (uint32_t)len);
    
    free(rows);
    JS_FreeCString(ctx, symbol);
    JS_FreeCString(ctx, interval);
    
    if (result < 0) return JS_ThrowInternalError(ctx, "insert_batch failed");
    
    return JS_NewInt32(ctx, result);
}

// ============ query ============
static JSValue js_ndtsdb_query(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
    CHECK_ARGC(ctx, argc, 6);
    
    double db_handle;
    if (JS_ToFloat64(ctx, &db_handle, argv[0])) 
        return JS_ThrowTypeError(ctx, "db handle must be a number");
    NDTSDB *db = (NDTSDB *)(uintptr_t)db_handle;
    if (!db) return JS_ThrowTypeError(ctx, "invalid db handle");
    
    const char *symbol = JS_ToCString(ctx, argv[1]);
    if (!symbol) return JS_ThrowTypeError(ctx, "symbol must be a string");
    
    const char *interval = JS_ToCString(ctx, argv[2]);
    if (!interval) {
        JS_FreeCString(ctx, symbol);
        return JS_ThrowTypeError(ctx, "interval must be a string");
    }
    
    double startTime, endTime, limit;
    if (JS_ToFloat64(ctx, &startTime, argv[3])) {
        JS_FreeCString(ctx, symbol);
        JS_FreeCString(ctx, interval);
        return JS_ThrowTypeError(ctx, "start must be a number");
    }
    if (JS_ToFloat64(ctx, &endTime, argv[4])) {
        JS_FreeCString(ctx, symbol);
        JS_FreeCString(ctx, interval);
        return JS_ThrowTypeError(ctx, "end must be a number");
    }
    if (JS_ToFloat64(ctx, &limit, argv[5])) {
        JS_FreeCString(ctx, symbol);
        JS_FreeCString(ctx, interval);
        return JS_ThrowTypeError(ctx, "limit must be a number");
    }
    
    Query q = {
        .symbol = symbol,
        .interval = interval,
        .startTime = (int64_t)startTime,
        .endTime = (int64_t)endTime,
        .limit = (uint32_t)limit
    };
    
    QueryResult *r = ndtsdb_query(db, &q);
    if (!r) {
        JS_FreeCString(ctx, symbol);
        JS_FreeCString(ctx, interval);
        return JS_ThrowInternalError(ctx, "query failed");
    }
    
    JSValue arr = JS_NewArray(ctx);
    for (uint32_t i = 0; i < r->count; i++) {
        JSValue row = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, row, "timestamp", JS_NewInt64(ctx, r->rows[i].timestamp));
        JS_SetPropertyStr(ctx, row, "open", JS_NewFloat64(ctx, r->rows[i].open));
        JS_SetPropertyStr(ctx, row, "high", JS_NewFloat64(ctx, r->rows[i].high));
        JS_SetPropertyStr(ctx, row, "low", JS_NewFloat64(ctx, r->rows[i].low));
        JS_SetPropertyStr(ctx, row, "close", JS_NewFloat64(ctx, r->rows[i].close));
        JS_SetPropertyStr(ctx, row, "volume", JS_NewFloat64(ctx, r->rows[i].volume));
        JS_SetPropertyUint32(ctx, arr, i, row);
    }
    
    ndtsdb_free_result(r);
    JS_FreeCString(ctx, symbol);
    JS_FreeCString(ctx, interval);
    
    return arr;
}

// ============ query_all ============
typedef struct {
    KlineRow row;
    char symbol[32];
    char interval[16];
} ResultRow;

static JSValue js_ndtsdb_query_all(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
    CHECK_ARGC(ctx, argc, 1);
    
    double db_handle;
    if (JS_ToFloat64(ctx, &db_handle, argv[0])) 
        return JS_ThrowTypeError(ctx, "db handle must be a number");
    NDTSDB *db = (NDTSDB *)(uintptr_t)db_handle;
    if (!db) return JS_ThrowTypeError(ctx, "invalid db handle");
    
    QueryResult *r = ndtsdb_query_all(db);
    if (!r) {
        return JS_ThrowInternalError(ctx, "query_all failed");
    }
    
    JSValue arr = JS_NewArray(ctx);
    
    // 检查是否为扩展格式（包含symbol/interval）
    if (r->capacity == 0xDEADBEEF && r->rows) {
        ResultRow *result_rows = (ResultRow*)r->rows;
        for (uint32_t i = 0; i < r->count; i++) {
            JSValue row = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, row, "symbol", JS_NewString(ctx, result_rows[i].symbol));
            JS_SetPropertyStr(ctx, row, "interval", JS_NewString(ctx, result_rows[i].interval));
            JS_SetPropertyStr(ctx, row, "timestamp", JS_NewInt64(ctx, result_rows[i].row.timestamp));
            JS_SetPropertyStr(ctx, row, "open", JS_NewFloat64(ctx, result_rows[i].row.open));
            JS_SetPropertyStr(ctx, row, "high", JS_NewFloat64(ctx, result_rows[i].row.high));
            JS_SetPropertyStr(ctx, row, "low", JS_NewFloat64(ctx, result_rows[i].row.low));
            JS_SetPropertyStr(ctx, row, "close", JS_NewFloat64(ctx, result_rows[i].row.close));
            JS_SetPropertyStr(ctx, row, "volume", JS_NewFloat64(ctx, result_rows[i].row.volume));
            JS_SetPropertyUint32(ctx, arr, i, row);
        }
    } else {
        // 普通格式（不含symbol/interval）
        for (uint32_t i = 0; i < r->count; i++) {
            JSValue row = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, row, "timestamp", JS_NewInt64(ctx, r->rows[i].timestamp));
            JS_SetPropertyStr(ctx, row, "open", JS_NewFloat64(ctx, r->rows[i].open));
            JS_SetPropertyStr(ctx, row, "high", JS_NewFloat64(ctx, r->rows[i].high));
            JS_SetPropertyStr(ctx, row, "low", JS_NewFloat64(ctx, r->rows[i].low));
            JS_SetPropertyStr(ctx, row, "close", JS_NewFloat64(ctx, r->rows[i].close));
            JS_SetPropertyStr(ctx, row, "volume", JS_NewFloat64(ctx, r->rows[i].volume));
            JS_SetPropertyUint32(ctx, arr, i, row);
        }
    }
    
    ndtsdb_free_result(r);
    return arr;
}

// ============ query_filtered ============
static JSValue js_ndtsdb_query_filtered(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv) {
    CHECK_ARGC(ctx, argc, 2);
    
    double db_handle;
    if (JS_ToFloat64(ctx, &db_handle, argv[0])) 
        return JS_ThrowTypeError(ctx, "db handle must be a number");
    NDTSDB *db = (NDTSDB *)(uintptr_t)db_handle;
    if (!db) return JS_ThrowTypeError(ctx, "invalid db handle");
    
    // 解析symbols数组
    if (!JS_IsArray(ctx, argv[1])) {
        return JS_ThrowTypeError(ctx, "symbols must be an array");
    }
    
    JSValue len_val = JS_GetPropertyStr(ctx, argv[1], "length");
    int64_t len;
    JS_ToInt64(ctx, &len, len_val);
    JS_FreeValue(ctx, len_val);
    
    if (len <= 0 || len > 100) {
        return JS_ThrowTypeError(ctx, "symbols array must have 1-100 elements");
    }
    
    // 分配symbols数组
    const char** symbols = malloc(len * sizeof(const char*));
    if (!symbols) {
        return JS_ThrowOutOfMemory(ctx);
    }
    
    for (int64_t i = 0; i < len; i++) {
        JSValue elem = JS_GetPropertyUint32(ctx, argv[1], i);
        symbols[i] = JS_ToCString(ctx, elem);
        JS_FreeValue(ctx, elem);
    }
    
    QueryResult *r = ndtsdb_query_filtered(db, symbols, (int)len);
    
    // 释放symbols
    for (int64_t i = 0; i < len; i++) {
        JS_FreeCString(ctx, symbols[i]);
    }
    free(symbols);
    
    if (!r) {
        return JS_ThrowInternalError(ctx, "query_filtered failed");
    }
    
    JSValue arr = JS_NewArray(ctx);
    
    if (r->capacity == 0xDEADBEEF && r->rows) {
        ResultRow *result_rows = (ResultRow*)r->rows;
        for (uint32_t i = 0; i < r->count; i++) {
            JSValue row = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, row, "symbol", JS_NewString(ctx, result_rows[i].symbol));
            JS_SetPropertyStr(ctx, row, "interval", JS_NewString(ctx, result_rows[i].interval));
            JS_SetPropertyStr(ctx, row, "timestamp", JS_NewInt64(ctx, result_rows[i].row.timestamp));
            JS_SetPropertyStr(ctx, row, "open", JS_NewFloat64(ctx, result_rows[i].row.open));
            JS_SetPropertyStr(ctx, row, "high", JS_NewFloat64(ctx, result_rows[i].row.high));
            JS_SetPropertyStr(ctx, row, "low", JS_NewFloat64(ctx, result_rows[i].row.low));
            JS_SetPropertyStr(ctx, row, "close", JS_NewFloat64(ctx, result_rows[i].row.close));
            JS_SetPropertyStr(ctx, row, "volume", JS_NewFloat64(ctx, result_rows[i].row.volume));
            JS_SetPropertyUint32(ctx, arr, i, row);
        }
    }
    
    ndtsdb_free_result(r);
    return arr;
}

// ============ query_time_range ============
static JSValue js_ndtsdb_query_time_range(JSContext *ctx, JSValueConst this_val,
                                          int argc, JSValueConst *argv) {
    CHECK_ARGC(ctx, argc, 3);
    
    double db_handle;
    if (JS_ToFloat64(ctx, &db_handle, argv[0])) 
        return JS_ThrowTypeError(ctx, "db handle must be a number");
    NDTSDB *db = (NDTSDB *)(uintptr_t)db_handle;
    if (!db) return JS_ThrowTypeError(ctx, "invalid db handle");
    
    int64_t since_ms, until_ms;
    JS_ToInt64(ctx, &since_ms, argv[1]);
    JS_ToInt64(ctx, &until_ms, argv[2]);
    
    QueryResult *r = ndtsdb_query_time_range(db, since_ms, until_ms);
    if (!r) {
        return JS_ThrowInternalError(ctx, "query_time_range failed");
    }
    
    JSValue arr = JS_NewArray(ctx);
    
    if (r->capacity == 0xDEADBEEF && r->rows) {
        ResultRow *result_rows = (ResultRow*)r->rows;
        for (uint32_t i = 0; i < r->count; i++) {
            JSValue row = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, row, "symbol", JS_NewString(ctx, result_rows[i].symbol));
            JS_SetPropertyStr(ctx, row, "interval", JS_NewString(ctx, result_rows[i].interval));
            JS_SetPropertyStr(ctx, row, "timestamp", JS_NewInt64(ctx, result_rows[i].row.timestamp));
            JS_SetPropertyStr(ctx, row, "open", JS_NewFloat64(ctx, result_rows[i].row.open));
            JS_SetPropertyStr(ctx, row, "high", JS_NewFloat64(ctx, result_rows[i].row.high));
            JS_SetPropertyStr(ctx, row, "low", JS_NewFloat64(ctx, result_rows[i].row.low));
            JS_SetPropertyStr(ctx, row, "close", JS_NewFloat64(ctx, result_rows[i].row.close));
            JS_SetPropertyStr(ctx, row, "volume", JS_NewFloat64(ctx, result_rows[i].row.volume));
            JS_SetPropertyUint32(ctx, arr, i, row);
        }
    }
    
    ndtsdb_free_result(r);
    return arr;
}

// ============ query_filtered_time ============
static JSValue js_ndtsdb_query_filtered_time(JSContext *ctx, JSValueConst this_val,
                                             int argc, JSValueConst *argv) {
    CHECK_ARGC(ctx, argc, 4);
    
    double db_handle;
    if (JS_ToFloat64(ctx, &db_handle, argv[0])) 
        return JS_ThrowTypeError(ctx, "db handle must be a number");
    NDTSDB *db = (NDTSDB *)(uintptr_t)db_handle;
    if (!db) return JS_ThrowTypeError(ctx, "invalid db handle");
    
    // 解析symbols数组
    if (!JS_IsArray(ctx, argv[1])) {
        return JS_ThrowTypeError(ctx, "symbols must be an array");
    }
    
    JSValue len_val = JS_GetPropertyStr(ctx, argv[1], "length");
    int64_t len;
    JS_ToInt64(ctx, &len, len_val);
    JS_FreeValue(ctx, len_val);
    
    if (len <= 0 || len > 100) {
        return JS_ThrowTypeError(ctx, "symbols array must have 1-100 elements");
    }
    
    // 分配symbols数组
    const char** symbols = malloc(len * sizeof(const char*));
    if (!symbols) {
        return JS_ThrowOutOfMemory(ctx);
    }
    
    for (int64_t i = 0; i < len; i++) {
        JSValue elem = JS_GetPropertyUint32(ctx, argv[1], i);
        symbols[i] = JS_ToCString(ctx, elem);
        JS_FreeValue(ctx, elem);
    }
    
    int64_t since_ms, until_ms;
    JS_ToInt64(ctx, &since_ms, argv[2]);
    JS_ToInt64(ctx, &until_ms, argv[3]);
    
    QueryResult *r = ndtsdb_query_filtered_time(db, symbols, (int)len, since_ms, until_ms);
    
    // 释放symbols
    for (int64_t i = 0; i < len; i++) {
        JS_FreeCString(ctx, symbols[i]);
    }
    free(symbols);
    
    if (!r) {
        return JS_ThrowInternalError(ctx, "query_filtered_time failed");
    }
    
    JSValue arr = JS_NewArray(ctx);
    
    if (r->capacity == 0xDEADBEEF && r->rows) {
        ResultRow *result_rows = (ResultRow*)r->rows;
        for (uint32_t i = 0; i < r->count; i++) {
            JSValue row = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, row, "symbol", JS_NewString(ctx, result_rows[i].symbol));
            JS_SetPropertyStr(ctx, row, "interval", JS_NewString(ctx, result_rows[i].interval));
            JS_SetPropertyStr(ctx, row, "timestamp", JS_NewInt64(ctx, result_rows[i].row.timestamp));
            JS_SetPropertyStr(ctx, row, "open", JS_NewFloat64(ctx, result_rows[i].row.open));
            JS_SetPropertyStr(ctx, row, "high", JS_NewFloat64(ctx, result_rows[i].row.high));
            JS_SetPropertyStr(ctx, row, "low", JS_NewFloat64(ctx, result_rows[i].row.low));
            JS_SetPropertyStr(ctx, row, "close", JS_NewFloat64(ctx, result_rows[i].row.close));
            JS_SetPropertyStr(ctx, row, "volume", JS_NewFloat64(ctx, result_rows[i].row.volume));
            JS_SetPropertyUint32(ctx, arr, i, row);
        }
    }
    
    ndtsdb_free_result(r);
    return arr;
}

// ============ get_latest_timestamp ============
static JSValue js_ndtsdb_get_latest_timestamp(JSContext *ctx, JSValueConst this_val,
                                               int argc, JSValueConst *argv) {
    CHECK_ARGC(ctx, argc, 3);
    
    double db_handle;
    if (JS_ToFloat64(ctx, &db_handle, argv[0])) 
        return JS_ThrowTypeError(ctx, "db handle must be a number");
    NDTSDB *db = (NDTSDB *)(uintptr_t)db_handle;
    if (!db) return JS_ThrowTypeError(ctx, "invalid db handle");
    
    const char *symbol = JS_ToCString(ctx, argv[1]);
    if (!symbol) return JS_ThrowTypeError(ctx, "symbol must be a string");
    
    const char *interval = JS_ToCString(ctx, argv[2]);
    if (!interval) {
        JS_FreeCString(ctx, symbol);
        return JS_ThrowTypeError(ctx, "interval must be a string");
    }
    
    int64_t ts = ndtsdb_get_latest_timestamp(db, symbol, interval);
    
    JS_FreeCString(ctx, symbol);
    JS_FreeCString(ctx, interval);
    
    return JS_NewInt64(ctx, ts);
}

// ============ queryVectors ============
static JSValue js_ndtsdb_query_vectors(JSContext *ctx, JSValueConst this_val,
                                       int argc, JSValueConst *argv) {
    CHECK_ARGC(ctx, argc, 3);
    
    double db_handle;
    if (JS_ToFloat64(ctx, &db_handle, argv[0])) 
        return JS_ThrowTypeError(ctx, "db handle must be a number");
    NDTSDB *db = (NDTSDB *)(uintptr_t)db_handle;
    if (!db) return JS_ThrowTypeError(ctx, "invalid db handle");
    
    const char *symbol = JS_ToCString(ctx, argv[1]);
    if (!symbol) return JS_ThrowTypeError(ctx, "symbol must be a string");
    
    const char *interval = JS_ToCString(ctx, argv[2]);
    if (!interval) {
        JS_FreeCString(ctx, symbol);
        return JS_ThrowTypeError(ctx, "interval must be a string");
    }
    
    VectorQueryResult *r = ndtsdb_query_vectors(db, symbol, interval);
    JS_FreeCString(ctx, symbol);
    JS_FreeCString(ctx, interval);
    
    if (!r) {
        return JS_ThrowInternalError(ctx, "query_vectors failed");
    }
    
    JSValue arr = JS_NewArray(ctx);
    
    for (uint32_t i = 0; i < r->count; i++) {
        JSValue row = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, row, "timestamp", JS_NewInt64(ctx, r->records[i].timestamp));
        JS_SetPropertyStr(ctx, row, "agent_id", JS_NewString(ctx, r->records[i].agent_id));
        JS_SetPropertyStr(ctx, row, "type", JS_NewString(ctx, r->records[i].type));
        JS_SetPropertyStr(ctx, row, "confidence", JS_NewFloat64(ctx, r->records[i].confidence));
        
        // embedding 数组
        JSValue emb_arr = JS_NewArray(ctx);
        for (uint16_t j = 0; j < r->records[i].embedding_dim; j++) {
            JS_SetPropertyUint32(ctx, emb_arr, j, JS_NewFloat64(ctx, r->records[i].embedding[j]));
        }
        JS_SetPropertyStr(ctx, row, "embedding", emb_arr);
        
        JS_SetPropertyUint32(ctx, arr, i, row);
    }
    
    ndtsdb_vector_free_result(r);
    return arr;
}

// ============ 模块导出 ============
static const JSCFunctionListEntry js_ndtsdb_funcs[] = {
    JS_CFUNC_DEF("open", 1, js_ndtsdb_open),
    JS_CFUNC_DEF("close", 1, js_ndtsdb_close),
    JS_CFUNC_DEF("insert", 4, js_ndtsdb_insert),
    JS_CFUNC_DEF("insertBatch", 4, js_ndtsdb_insert_batch),
    JS_CFUNC_DEF("query", 6, js_ndtsdb_query),
    JS_CFUNC_DEF("queryAll", 1, js_ndtsdb_query_all),
    JS_CFUNC_DEF("queryFiltered", 2, js_ndtsdb_query_filtered),
    JS_CFUNC_DEF("queryTimeRange", 3, js_ndtsdb_query_time_range),
    JS_CFUNC_DEF("queryFilteredTime", 4, js_ndtsdb_query_filtered_time),
    JS_CFUNC_DEF("getLatestTimestamp", 3, js_ndtsdb_get_latest_timestamp),
    JS_CFUNC_DEF("queryVectors", 3, js_ndtsdb_query_vectors),
};

static int js_ndtsdb_init(JSContext *ctx, JSModuleDef *m)
{
    return JS_SetModuleExportList(ctx, m, js_ndtsdb_funcs, countof(js_ndtsdb_funcs));
}

#ifdef JS_SHARED_LIBRARY
#define JS_INIT_MODULE js_init_module
#else
#define JS_INIT_MODULE js_init_module_ndtsdb
#endif

JSModuleDef *JS_INIT_MODULE(JSContext *ctx, const char *module_name)
{
    JSModuleDef *m;
    m = JS_NewCModule(ctx, module_name, js_ndtsdb_init);
    if (!m)
        return NULL;
    JS_AddModuleExportList(ctx, m, js_ndtsdb_funcs, countof(js_ndtsdb_funcs));
    return m;
}
