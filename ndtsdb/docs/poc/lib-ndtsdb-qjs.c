// ============================================================
// lib-ndtsdb-qjs: QuickJS -> ndtsdb 绑定层 (MVP)
// ============================================================

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "quickjs.h"
#include "ndtsdb.h"

#define countof(x) (sizeof(x) / sizeof((x)[0]))

static JSClassID js_ndtsdb_class_id = 0;

static JSValue js_ndtsdb_open(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_ThrowInternalError(ctx, "path required");
    
    printf("ndtsdb.open('%s')\n", path);
    
    NDTSDB *db = ndtsdb_open(path);
    JS_FreeCString(ctx, path);
    
    if (!db) return JS_ThrowInternalError(ctx, "failed to open database");
    
    return JS_NewInt32(ctx, (int)(intptr_t)db);
}

static JSValue js_ndtsdb_close(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
    int db_handle;
    if (JS_ToInt32(ctx, &db_handle, argv[0])) return JS_EXCEPTION;
    NDTSDB *db = (NDTSDB *)(intptr_t)db_handle;
    printf("ndtsdb.close(%d)\n", db_handle);
    ndtsdb_close(db);
    return JS_UNDEFINED;
}

static JSValue js_ndtsdb_insert(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    int db_handle;
    if (JS_ToInt32(ctx, &db_handle, argv[0])) return JS_EXCEPTION;
    NDTSDB *db = (NDTSDB *)(intptr_t)db_handle;
    
    const char *symbol = JS_ToCString(ctx, argv[1]);
    const char *interval = JS_ToCString(ctx, argv[2]);
    
    JSValue obj = argv[3];
    
    double timestamp, open_val, high, low, close_val, volume;
    JS_ToFloat64(ctx, &timestamp, JS_GetPropertyStr(ctx, obj, "timestamp"));
    JS_ToFloat64(ctx, &open_val, JS_GetPropertyStr(ctx, obj, "open"));
    JS_ToFloat64(ctx, &high, JS_GetPropertyStr(ctx, obj, "high"));
    JS_ToFloat64(ctx, &low, JS_GetPropertyStr(ctx, obj, "low"));
    JS_ToFloat64(ctx, &close_val, JS_GetPropertyStr(ctx, obj, "close"));
    JS_ToFloat64(ctx, &volume, JS_GetPropertyStr(ctx, obj, "volume"));
    
    printf("ndtsdb.insert(db=%d, symbol=%s, ts=%.0f)\n", db_handle, symbol, timestamp);
    
    KlineRow row = {
        .timestamp = (int64_t)timestamp,
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
    
    return JS_NewInt32(ctx, result);
}

static JSValue js_ndtsdb_query(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
    int db_handle;
    if (JS_ToInt32(ctx, &db_handle, argv[0])) return JS_EXCEPTION;
    NDTSDB *db = (NDTSDB *)(intptr_t)db_handle;
    
    const char *symbol = JS_ToCString(ctx, argv[1]);
    const char *interval = JS_ToCString(ctx, argv[2]);
    
    double startTime, endTime, limit;
    JS_ToFloat64(ctx, &startTime, argv[3]);
    JS_ToFloat64(ctx, &endTime, argv[4]);
    JS_ToFloat64(ctx, &limit, argv[5]);
    
    printf("ndtsdb.query(db=%d, symbol=%s, start=%.0f, end=%.0f)\n", db_handle, symbol, startTime, endTime);
    
    Query q = {
        .symbol = symbol,
        .interval = interval,
        .startTime = (int64_t)startTime,
        .endTime = (int64_t)endTime,
        .limit = (uint32_t)limit
    };
    
    QueryResult *r = ndtsdb_query(db, &q);
    
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
    
    printf("ndtsdb.query result: %d rows\n", r->count);
    
    ndtsdb_free_result(r);
    JS_FreeCString(ctx, symbol);
    JS_FreeCString(ctx, interval);
    
    return arr;
}

static JSValue js_ndtsdb_get_latest_timestamp(JSContext *ctx, JSValueConst this_val,
                                               int argc, JSValueConst *argv) {
    int db_handle;
    if (JS_ToInt32(ctx, &db_handle, argv[0])) return JS_EXCEPTION;
    NDTSDB *db = (NDTSDB *)(intptr_t)db_handle;
    const char *symbol = JS_ToCString(ctx, argv[1]);
    const char *interval = JS_ToCString(ctx, argv[2]);
    
    printf("ndtsdb.getLatestTimestamp(db=%d, symbol=%s)\n", db_handle, symbol);
    
    int64_t ts = ndtsdb_get_latest_timestamp(db, symbol, interval);
    
    JS_FreeCString(ctx, symbol);
    JS_FreeCString(ctx, interval);
    
    return JS_NewInt64(ctx, ts);
}

static const JSCFunctionListEntry js_ndtsdb_funcs[] = {
    JS_CFUNC_DEF("open", 1, js_ndtsdb_open),
    JS_CFUNC_DEF("close", 1, js_ndtsdb_close),
    JS_CFUNC_DEF("insert", 3, js_ndtsdb_insert),
    JS_CFUNC_DEF("query", 6, js_ndtsdb_query),
    JS_CFUNC_DEF("getLatestTimestamp", 3, js_ndtsdb_get_latest_timestamp),
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
