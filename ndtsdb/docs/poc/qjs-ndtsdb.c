// ============================================================
// QuickJS -> ndtsdb 绑定层 (MVP)
// ============================================================

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ndtsdb.h"
#include "quickjs.h"

/**
 * ndtsdb.open(path) -> db handle
 */
static JSValue js_ndtsdb_open(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_ThrowInternalError(ctx, "path required");
    
    NDTSDB *db = ndtsdb_open(path);
    JS_FreeCString(ctx, path);
    
    if (!db) return JS_ThrowInternalError(ctx, "failed to open database");
    
    return JS_NewUint32(ctx, (uint32_t)(uintptr_t)db);
}

/**
 * ndtsdb.close(db)
 */
static JSValue js_ndtsdb_close(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
    uint32_t db_handle = JS_ValueToUint32(ctx, argv[0]);
    NDTSDB *db = (NDTSDB *)(uintptr_t)db_handle;
    ndtsdb_close(db);
    return JS_UNDEFINED;
}

/**
 * ndtsdb.insert(db, symbol, interval, row)
 * row: {timestamp, open, high, low, close, volume}
 */
static JSValue js_ndtsdb_insert(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    uint32_t db_handle = JS_ValueToUint32(ctx, argv[0]);
    NDTSDB *db = (NDTSDB *)(uintptr_t)db_handle;
    
    const char *symbol = JS_ToCString(ctx, argv[1]);
    const char *interval = JS_ToCString(ctx, argv[2]);
    
    // 解析 row 对象
    JSValue timestamp_val = JS_GetPropertyStr(ctx, argv[3], "timestamp");
    JSValue open_val = JS_GetPropertyStr(ctx, argv[3], "open");
    JSValue high_val = JS_GetPropertyStr(ctx, argv[3], "high");
    JSValue low_val = JS_GetPropertyStr(ctx, argv[3], "low");
    JSValue close_val = JS_GetPropertyStr(ctx, argv[3], "close");
    JSValue volume_val = JS_GetPropertyStr(ctx, argv[3], "volume");
    
    KlineRow row = {
        .timestamp = (int64_t)JS_ValueToInt64(ctx, timestamp_val),
        .open = JS_ValueToFloat64(ctx, open_val),
        .high = JS_ValueToFloat64(ctx, high_val),
        .low = JS_ValueToFloat64(ctx, low_val),
        .close = JS_ValueToFloat64(ctx, close_val),
        .volume = JS_ValueToFloat64(ctx, volume_val),
        .flags = 0
    };
    
    int result = ndtsdb_insert(db, symbol, interval, &row);
    
    JS_FreeCString(ctx, symbol);
    JS_FreeCString(ctx, interval);
    
    return JS_NewInt32(ctx, result);
}

/**
 * ndtsdb.query(db, symbol, interval, startTime, endTime, limit)
 */
static JSValue js_ndtsdb_query(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
    uint32_t db_handle = JS_ValueToUint32(ctx, argv[0]);
    NDTSDB *db = (NDTSDB *)(uintptr_t)db_handle;
    
    const char *symbol = JS_ToCString(ctx, argv[1]);
    const char *interval = JS_ToCString(ctx, argv[2]);
    
    Query q = {
        .symbol = symbol,
        .interval = interval,
        .startTime = JS_ValueToInt64(ctx, argv[3]),
        .endTime = JS_ValueToInt64(ctx, argv[4]),
        .limit = (uint32_t)JS_ValueToInt64(ctx, argv[5])
    };
    
    QueryResult *r = ndtsdb_query(db, &q);
    
    // 转换为 JS 数组
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

/**
 * ndtsdb.getLatestTimestamp(db, symbol, interval)
 */
static JSValue js_ndtsdb_get_latest_timestamp(JSContext *ctx, JSValueConst this_val,
                                               int argc, JSValueConst *argv) {
    uint32_t db_handle = JS_ValueToUint32(ctx, argv[0]);
    NDTSDB *db = (NDTSDB *)(uintptr_t)db_handle;
    const char *symbol = JS_ToCString(ctx, argv[1]);
    const char *interval = JS_ToCString(ctx, argv[2]);
    
    int64_t ts = ndtsdb_get_latest_timestamp(db, symbol, interval);
    
    JS_FreeCString(ctx, symbol);
    JS_FreeCString(ctx, interval);
    
    return JS_NewInt64(ctx, ts);
}

/**
 * 模块初始化
 */
static int js_ndtsdb_init(JSContext *ctx, JSModuleDef *m) {
    JSValue ndtsdb = JS_NewObject(ctx);
    
    JS_SetPropertyStr(ctx, ndtsdb, "open", JS_NewCFunction(ctx, js_ndtsdb_open, "open", 1));
    JS_SetPropertyStr(ctx, ndtsdb, "close", JS_NewCFunction(ctx, js_ndtsdb_close, "close", 1));
    JS_SetPropertyStr(ctx, ndtsdb, "insert", JS_NewCFunction(ctx, js_ndtsdb_insert, "insert", 3));
    JS_SetPropertyStr(ctx, ndtsdb, "query", JS_NewCFunction(ctx, js_ndtsdb_query, "query", 6));
    JS_SetPropertyStr(ctx, ndtsdb, "getLatestTimestamp", JS_NewCFunction(ctx, js_ndtsdb_get_latest_timestamp, "getLatestTimestamp", 3));
    
    JS_SetModuleExportList(ctx, m, &ndtsdb, 5);
    return 0;
}

JS_MODULE_INIT(js_ndtsdb_init)
