// ============================================================
// qjs-ndtsdb-rpc.c: 独立进程 JSON-RPC 服务器
// 协议: 每行一个 JSON {"id":N,"op":"...",...}
// ============================================================

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdarg.h>
#include "ndtsdb.h"

#define MAX_DB_HANDLES 16

typedef struct {
    NDTSDB *db;
    char path[256];
} DBHandle;

static DBHandle handles[MAX_DB_HANDLES];

int find_free_handle() {
    for (int i = 1; i < MAX_DB_HANDLES; i++) {
        if (!handles[i].db) return i;
    }
    return 0;
}

void send_response(const char *json) {
    printf("%s\n", json);
    fflush(stdout);
}

void send_error(int id, const char *msg) {
    char buf[512];
    snprintf(buf, sizeof(buf), "{\"id\":%d,\"ok\":false,\"error\":\"%s\"}", id, msg);
    send_response(buf);
}

void send_ok(int id, const char *result_fmt, ...) {
    char buf[512];
    va_list args;
    va_start(args, result_fmt);
    char result[256];
    vsnprintf(result, sizeof(result), result_fmt, args);
    va_end(args);
    snprintf(buf, sizeof(buf), "{\"id\":%d,\"ok\":true,\"result\":%s}", id, result);
    send_response(buf);
}

// 简单 JSON 解析 helpers
int extract_int(const char *json, const char *key) {
    char *p = strstr(json, key);
    if (!p) return 0;
    p = strchr(p, ':');
    if (!p) return 0;
    return atoi(p + 1);
}

long long extract_ll(const char *json, const char *key) {
    char *p = strstr(json, key);
    if (!p) return 0;
    p = strchr(p, ':');
    if (!p) return 0;
    return atoll(p + 1);
}

double extract_double(const char *json, const char *key) {
    char *p = strstr(json, key);
    if (!p) return 0;
    p = strchr(p, ':');
    if (!p) return 0;
    return atof(p + 1);
}

// 提取字符串到 buf，返回是否成功
int extract_string(const char *json, const char *key, char *buf, size_t buf_size) {
    char *p = strstr(json, key);
    if (!p) return 0;
    p = strchr(p, ':');
    if (!p) return 0;
    p = strchr(p, '"');
    if (!p) return 0;
    p++;
    char *end = strchr(p, '"');
    if (!end) return 0;
    size_t len = end - p;
    if (len >= buf_size) len = buf_size - 1;
    memcpy(buf, p, len);
    buf[len] = '\0';
    return 1;
}

void handle_open(int id, const char *json) {
    char path[256];
    if (!extract_string(json, "\"path\"", path, sizeof(path))) {
        send_error(id, "Missing path");
        return;
    }
    
    int h = find_free_handle();
    if (!h) {
        send_error(id, "Too many open databases");
        return;
    }
    
    NDTSDB *db = ndtsdb_open(path);
    if (!db) {
        send_error(id, "Failed to open database");
        return;
    }
    
    handles[h].db = db;
    strncpy(handles[h].path, path, sizeof(handles[h].path) - 1);
    
    send_ok(id, "%d", h);
}

void handle_close(int id, const char *json) {
    int h = extract_int(json, "\"db\"");
    if (h < 1 || h >= MAX_DB_HANDLES || !handles[h].db) {
        send_error(id, "Invalid handle");
        return;
    }
    
    ndtsdb_close(handles[h].db);
    handles[h].db = NULL;
    handles[h].path[0] = '\0';
    
    send_ok(id, "null");
}

void handle_insert(int id, const char *json) {
    int h = extract_int(json, "\"db\"");
    if (h < 1 || h >= MAX_DB_HANDLES || !handles[h].db) {
        send_error(id, "Invalid handle");
        return;
    }
    
    char symbol[64], interval[16];
    if (!extract_string(json, "\"symbol\"", symbol, sizeof(symbol)) ||
        !extract_string(json, "\"interval\"", interval, sizeof(interval))) {
        send_error(id, "Missing symbol or interval");
        return;
    }
    
    KlineRow row = {
        .timestamp = extract_ll(json, "\"timestamp\""),
        .open = extract_double(json, "\"open\""),
        .high = extract_double(json, "\"high\""),
        .low = extract_double(json, "\"low\""),
        .close = extract_double(json, "\"close\""),
        .volume = extract_double(json, "\"volume\""),
        .flags = 0
    };
    
    int result = ndtsdb_insert(handles[h].db, symbol, interval, &row);
    send_ok(id, "%d", result);
}

void handle_query(int id, const char *json) {
    int h = extract_int(json, "\"db\"");
    if (h < 1 || h >= MAX_DB_HANDLES || !handles[h].db) {
        send_error(id, "Invalid handle");
        return;
    }
    
    char symbol[64], interval[16];
    if (!extract_string(json, "\"symbol\"", symbol, sizeof(symbol)) ||
        !extract_string(json, "\"interval\"", interval, sizeof(interval))) {
        send_error(id, "Missing symbol or interval");
        return;
    }
    
    Query q = {
        .symbol = symbol,
        .interval = interval,
        .startTime = extract_ll(json, "\"start\""),
        .endTime = extract_ll(json, "\"end\""),
        .limit = (uint32_t)extract_int(json, "\"limit\"")
    };
    
    QueryResult *r = ndtsdb_query(handles[h].db, &q);
    
    // 输出 JSON 数组
    printf("{\"id\":%d,\"ok\":true,\"result\":[", id);
    for (uint32_t i = 0; i < r->count; i++) {
        if (i > 0) printf(",");
        printf("{\"timestamp\":%lld,\"open\":%.6f,\"high\":%.6f,\"low\":%.6f,\"close\":%.6f,\"volume\":%.6f}",
               (long long)r->rows[i].timestamp,
               r->rows[i].open, r->rows[i].high, r->rows[i].low,
               r->rows[i].close, r->rows[i].volume);
    }
    printf("]}\n");
    fflush(stdout);
    
    ndtsdb_free_result(r);
}

int main() {
    memset(handles, 0, sizeof(handles));
    
    char line[4096];
    while (fgets(line, sizeof(line), stdin)) {
        line[strcspn(line, "\n")] = 0;
        if (strlen(line) == 0) continue;
        
        int id = extract_int(line, "\"id\"");
        
        if (strstr(line, "\"op\":\"open\"") != NULL) {
            handle_open(id, line);
        }
        else if (strstr(line, "\"op\":\"close\"") != NULL) {
            handle_close(id, line);
        }
        else if (strstr(line, "\"op\":\"insert\"") != NULL) {
            handle_insert(id, line);
        }
        else if (strstr(line, "\"op\":\"query\"") != NULL) {
            handle_query(id, line);
        }
        else {
            send_error(id, "Unknown op");
        }
    }
    
    return 0;
}
