// cmd_io.c - Data I/O 子命令实现
#include "cmd_io.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <time.h>
#include <fcntl.h>
#include <errno.h>
#include <math.h>
#include "../../ndtsdb-lib/native/ndtsdb.h"
#include "../../ndtsdb-lib/native/ndtsdb_vec.h"
#include "ndtsdb_lock.h"

#ifdef _WIN32
#include <winsock2.h>
#include <windows.h>
#include <io.h>
#include <direct.h>
#include <sys/stat.h>
#define mkdir(path, mode) _mkdir(path)
// gettimeofday for Windows
static int gettimeofday(struct timeval *tv, void *tz) {
    FILETIME ft;
    ULARGE_INTEGER li;
    GetSystemTimeAsFileTime(&ft);
    li.LowPart = ft.dwLowDateTime;
    li.HighPart = ft.dwHighDateTime;
    // Convert from 100ns intervals since 1601 to seconds since 1970
    tv->tv_sec = (long)((li.QuadPart - 116444736000000000ULL) / 10000000);
    tv->tv_usec = (long)((li.QuadPart % 10000000) / 10);
    return 0;
}
#else
#include <unistd.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <dirent.h>
#endif

// 外部依赖（由 main.c 提供）
extern JSContext *ctx;
extern JSRuntime *rt;

/* ─── 向量字段支持（M1-B/C） ───────────────────────────────
 * VecRecord 定义在 ndtsdb_vec.h 中
 */
#define VECTOR_MAX_DIM 4096

// json_find_key — 在 JSON 字符串中查找 key，返回值起始指针（冒号后跳过空格）
// 返回 NULL 如果 key 不存在
static const char *json_find_key(const char *json, const char *key) {
    char needle[128];
    snprintf(needle, sizeof(needle), "\"%s\"", key);
    const char *p = strstr(json, needle);
    if (!p) return NULL;
    p += strlen(needle);
    while (*p == ' ' || *p == '\t') p++;
    if (*p != ':') return NULL;
    p++;
    while (*p == ' ' || *p == '\t') p++;
    return p;
}

// json_get_string — 从 json_find_key 返回值中提取字符串（带引号），写入 buf
static void json_get_string(const char *val, char *buf, size_t buf_sz) {
    buf[0] = '\0';
    if (!val || *val != '"') return;
    val++;
    size_t i = 0;
    while (*val && *val != '"' && i < buf_sz - 1) buf[i++] = *val++;
    buf[i] = '\0';
}

// json_get_int64 — 从 json_find_key 返回值中提取整数
static int64_t json_get_int64(const char *val) {
    if (!val) return 0;
    while (*val == ' ') val++;
    return (int64_t)strtoll(val, NULL, 10);
}

// json_get_double — 从 json_find_key 返回值中提取浮点数
static double json_get_double(const char *val) {
    if (!val) return 0.0;
    return strtod(val, NULL);
}

// json_parse_float_array — 解析 JSON float 数组 "[0.1, 0.2, ...]"
// 返回堆分配的 float*，写入 out_dim；失败返回 NULL
static float *json_parse_float_array(const char *val, int *out_dim) {
    *out_dim = 0;
    if (!val || *val != '[') return NULL;
    val++;

    // 第一遍：数维度
    int dim = 0;
    const char *scan = val;
    while (*scan && *scan != ']') {
        char *end;
        strtod(scan, &end);
        if (end == scan) { scan++; continue; }
        dim++;
        scan = end;
        while (*scan == ' ' || *scan == ',') scan++;
    }
    if (dim == 0 || dim > VECTOR_MAX_DIM) return NULL;

    float *arr = malloc(dim * sizeof(float));
    if (!arr) return NULL;

    // 第二遍：填充
    int idx = 0;
    while (*val && *val != ']' && idx < dim) {
        char *end;
        double v = strtod(val, &end);
        if (end == val) { val++; continue; }
        arr[idx++] = (float)v;
        val = end;
        while (*val == ' ' || *val == ',') val++;
    }
    *out_dim = idx;
    return arr;
}

// json_is_vector_record — 判断一行 JSON 是否为向量记录（含 embedding 字段）
static bool json_is_vector_record(const char *line) {
    return strstr(line, "\"embedding\"") != NULL;
}

// parse_vector_record — 解析向量 JSON 行到 VecRecord
// 成功返回 true，embedding 需调用方 free()
static bool parse_vector_record(const char *line, VecRecord *out) {
    memset(out, 0, sizeof(*out));

    const char *v;

    v = json_find_key(line, "timestamp");
    out->timestamp = json_get_int64(v);

    v = json_find_key(line, "agent_id");
    if (v) json_get_string(v, out->agent_id, sizeof(out->agent_id));

    v = json_find_key(line, "type");
    if (v) json_get_string(v, out->type, sizeof(out->type));

    v = json_find_key(line, "confidence");
    out->confidence = v ? (float)json_get_double(v) : 1.0f;

    v = json_find_key(line, "embedding");
    int dim_tmp = 0;
    if (v) out->embedding = json_parse_float_array(v, &dim_tmp);
    out->embedding_dim = (uint16_t)dim_tmp;

    return out->timestamp > 0 && out->agent_id[0] != '\0' && out->embedding != NULL && out->embedding_dim > 0;
}
extern int exit_code;
extern int exit_code;

// 辅助函数：打印异常
static void print_exception(JSContext *ctx) {
    JSValue exc = JS_GetException(ctx);
    const char *msg = JS_ToCString(ctx, exc);
    fprintf(stderr, "Error: %s\n", msg ? msg : "(unknown)");
    if (msg) JS_FreeCString(ctx, msg);
    JS_FreeValue(ctx, exc);
}

// ==================== write-csv 子命令 ====================
int cmd_write_csv(int argc, char *argv[]) {
        const char *database = NULL;
        bool help_flag = false;
        for (int i = 2; i < argc; i++) {
            if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
                help_flag = true;
            } else if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
                if (i + 1 < argc) database = argv[++i];
            }
        }
        if (help_flag) {
            printf("Usage: ndtsdb-cli write-csv --database <path>\n\n");
            printf("Write CSV data from stdin to database.\n\n");
            printf("Options:\n");
            printf("  --database, -d  Database directory path (required)\n");
            printf("\nExample:\n");
            printf("  cat data.csv | ndtsdb-cli write-csv -d ./db\n");
        }
        if (!database) {
            fprintf(stderr, "Error: --database is required\n");
            return 1;
        }
        
        // 验证路径不为空，且不含单引号（防止 JS 脚本注入）
        if (strlen(database) == 0) {
            fprintf(stderr, "Error: --database path cannot be empty\n");
            return 1;
        }
        for (const char *_p = database; *_p; _p++) {
            if (*_p == '\'' || *_p == '\\' || *_p == '\n' || *_p == '\r') {
                fprintf(stderr, "Error: --database path contains invalid character\n");
                return 1;
            }
        }

        // 自动创建数据库目录（如果不存在）
        struct stat st;
        if (stat(database, &st) != 0) {
            // 目录不存在，尝试创建
            if (mkdir(database, 0755) != 0) {
                fprintf(stderr, "Error: Failed to create database directory: %s\n", database);
                return 1;
            }
        } else if (!S_ISDIR(st.st_mode)) {
            fprintf(stderr, "Error: Database path exists but is not a directory: %s\n", database);
            return 1;
        }
        
        // 获取独占写锁（跨进程保护）
        int lock_fd = ndtsdb_lock_acquire(database, true);
        if (lock_fd < 0) {
            fprintf(stderr, "Error: Failed to acquire write lock on database: %s\n", database);
            return 1;
        }
        
        char write_csv_script[8192];
        snprintf(write_csv_script, sizeof(write_csv_script),
            "import * as ndtsdb from 'ndtsdb';\n"
            "const db = ndtsdb.open('%s/');\n"
            "let successCount = 0, errorCount = 0, lineNum = 0;\n"
            "while (true) {\n"
            "    const line = __readStdinLine();\n"
            "    if (line === null) break;\n"
            "    lineNum++;\n"
            "    if (line.trim() === '') continue;\n"
            "    if (lineNum === 1 && (line.includes('symbol') || line.includes('timestamp'))) continue;\n"
            "    const cols = line.split(',');\n"
            "    if (cols.length < 8) { console.error(`Skip line ${lineNum}: insufficient columns`); errorCount++; continue; }\n"
            "    try {\n"
            "        const symbol = cols[0].trim();\n"
            "        const interval = cols[1].trim();\n"
            "        const timestamp = BigInt(cols[2].trim());\n"
            "        const open = parseFloat(cols[3].trim());\n"
            "        const high = parseFloat(cols[4].trim());\n"
            "        const low = parseFloat(cols[5].trim());\n"
            "        const close = parseFloat(cols[6].trim());\n"
            "        const volume = parseFloat(cols[7].trim());\n"
            "        if (!symbol || !interval || !timestamp) { console.error(`Skip line ${lineNum}: missing fields`); errorCount++; continue; }\n"
            "        ndtsdb.insert(db, symbol, interval, { timestamp: timestamp, open: open || 0, high: high || 0, low: low || 0, close: close || 0, volume: volume || 0 });\n"
            "        successCount++;\n"
            "    } catch (e) { console.error(`Error line ${lineNum}: ${e.message}`); errorCount++; }\n"
            "}\n"
            "ndtsdb.close(db);\n"
            "console.log(`write-csv: ${successCount} rows inserted, ${errorCount} errors`);\n",
            database
        );
        
        JSValue result = JS_Eval(ctx, write_csv_script, strlen(write_csv_script), "<write-csv>", JS_EVAL_TYPE_MODULE);
        int ret = 0;
        if (JS_IsException(result)) { print_exception(ctx); ret = 1; }
        JS_FreeValue(ctx, result);
        
        JSContext *ctx2;
        while (JS_ExecutePendingJob(rt, &ctx2) > 0) {}
        
        ndtsdb_lock_release(lock_fd);
        
        return 0;
    }

// ==================== write-json 子命令 ====================
int cmd_write_json(int argc, char *argv[]) {
        const char *database = NULL;
        bool daemon_mode = false;
        bool delete_mode = false;  // --delete标志：写入tombstone
        bool upsert_mode = false;  // --upsert标志：按timestamp更新
        bool help_flag = false;
        for (int i = 2; i < argc; i++) {
            if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
                help_flag = true;
            } else if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
                if (i + 1 < argc) database = argv[++i];
            } else if (strcmp(argv[i], "--daemon") == 0) {
                daemon_mode = true;
            } else if (strcmp(argv[i], "--delete") == 0) {
                delete_mode = true;
            } else if (strcmp(argv[i], "--upsert") == 0) {
                upsert_mode = true;
            }
        }
        if (help_flag) {
            printf("Usage: ndtsdb-cli write-json --database <path> [--daemon] [--delete] [--upsert]\n\n");
            printf("Write JSON Lines data from stdin to database.\n\n");
            printf("Options:\n");
            printf("  --database, -d  Database directory path (required)\n");
            printf("  --daemon        Run in daemon mode (continuous input)\n");
            printf("  --delete        Write tombstone (mark as deleted)\n");
            printf("  --upsert        Update existing rows by timestamp\n");
            printf("\nExample:\n");
            printf("  echo '{\"symbol\":\"BTC\",\"interval\":\"1m\",...}' | ndtsdb-cli write-json -d ./db\n");
        }
        if (!database) {
            fprintf(stderr, "Error: --database is required\n");
            return 1;
        }
        
        // 验证路径不为空
        if (strlen(database) == 0) {
            fprintf(stderr, "Error: --database path cannot be empty\n");
            return 1;
        }
        
        // 获取独占写锁（跨进程保护）
        int lock_fd = ndtsdb_lock_acquire(database, true);
        if (lock_fd < 0) {
            fprintf(stderr, "Error: Failed to acquire write lock on database: %s\n", database);
            return 1;
        }
        
        // 打开数据库（纯C实现）
        NDTSDB *db = ndtsdb_open(database);
        if (!db) {
            fprintf(stderr, "Error: Failed to open database: %s\n", database);
            ndtsdb_lock_release(lock_fd);
            return 1;
        }
        
        // UPSERT 模式：读取现有数据，建立 timestamp→index 映射
        typedef struct { int64_t timestamp; KlineRow row; } TimestampRow;
        TimestampRow *existing_rows = NULL;
        int existing_count = 0;
        int existing_capacity = 0;
        char upsert_symbol[64] = {0};
        char upsert_interval[16] = {0};
        
        if (upsert_mode) {
            // 先读取所有数据（需要知道symbol/interval，但此时还不知道，延迟到第一行）
            existing_capacity = 1024;
            existing_rows = malloc(existing_capacity * sizeof(TimestampRow));
            if (!existing_rows) {
                fprintf(stderr, "Error: OOM\n");
                ndtsdb_close(db);
                ndtsdb_lock_release(lock_fd);
                return 1;
            }
        }
        
        // 批量插入配置
        #define BATCH_SIZE 5000
        #define DAEMON_FLUSH_MS 100
        KlineRow *batch = malloc(BATCH_SIZE * sizeof(KlineRow)); if (!batch) { fprintf(stderr, "OOM\n"); return 1; }
        char batch_symbol[64] = {0};
        char batch_interval[16] = {0};
        int batch_count = 0;
        
        char line[4096];
        int count = 0;
        int errors = 0;
        int updated_count = 0;
        int inserted_count = 0;
        
        // Daemon模式：初始化 flush 时间
        struct timeval last_flush_time;
        bool use_daemon_mode = daemon_mode;
        if (use_daemon_mode) {
            gettimeofday(&last_flush_time, NULL);
            fprintf(stderr, "Daemon mode: flush interval %dms, batch size %d\n", DAEMON_FLUSH_MS, BATCH_SIZE);
        }
        
        // 辅助宏
        #define SKIP_COLON(p) while (*p && *p != ':') p++; if (*p == ':') p++
        
        // 逐行读取stdin并解析JSON（普通模式和daemon模式共用 fgets）
        while (fgets(line, sizeof(line), stdin)) {
            // 去掉末尾换行
            size_t len = strlen(line);
            while (len > 0 && (line[len-1] == '\n' || line[len-1] == '\r')) {
                line[--len] = '\0';
            }
            
            // 跳过空行
            if (len == 0) continue;

            // ── 向量记录路径（M1-B）──────────────────────────────
            if (json_is_vector_record(line)) {
                VecRecord vrec;
                if (!parse_vector_record(line, &vrec)) {
                    fprintf(stderr, "Warning: failed to parse vector record: %.80s\n", line);
                    errors++;
                    if (vrec.embedding) free(vrec.embedding);
                    continue;
                }

                // M1-C: 调用 native 向量 API（vrec 本身就是 VecRecord）
                int ok = ndtsdb_vec_insert(db, vrec.agent_id, vrec.type, &vrec);
                if (ok == 0) {
                    count++;
                    // 同时写入 KlineRow 标记行（flags=0x01），供 query_all 列举
                    // 数据存储在 .ndtv 文件，此处仅作索引
                    KlineRow marker = {
                        .timestamp = vrec.timestamp,
                        .open = vrec.confidence,
                        .high = (double)vrec.embedding_dim,
                        .low = 0.0,
                        .close = 0.0,
                        .volume = 0.0,
                        .flags = 0x01
                    };
                    ndtsdb_insert(db, vrec.agent_id, vrec.type, &marker);
                } else {
                    fprintf(stderr, "Warning: failed to insert vector row ts=%lld\n",
                            (long long)vrec.timestamp);
                    errors++;
                }
                free(vrec.embedding);
                continue;
            }
            // ── 常规 K 线路径 ────────────────────────────────────

            char symbol[64] = {0};
            char interval[16] = {0};
            int64_t timestamp = 0;
            double open = 0, high = 0, low = 0, close = 0, volume = 0;
            
            // 单次扫描解析（极速版 - 假设字段顺序固定）
            char *p = line;
            // 跳过 {"symbol":"
            while (*p && *p != '"') p++; p++; 
            while (*p && *p != '"') p++; p++;
            while (*p && *p != '"') p++; p++;
            int i = 0; while (*p && *p != '"' && i < 63) symbol[i++] = *p++;
            symbol[i] = '\0'; 
            
            // 跳过 ","interval":"
            while (*p && *p != '"') p++; p++; 
            while (*p && *p != '"') p++; p++;
            while (*p && *p != '"') p++; p++;
            while (*p && *p != '"') p++; p++;
            i = 0; while (*p && *p != '"' && i < 15) interval[i++] = *p++;
            interval[i] = '\0';
            
            // 跳过 ","timestamp":
            while (*p && *p != '"') p++; p++;
            while (*p && *p != ':') p++; p++;
            while (*p == ' ' || *p == '\t') p++;  // 跳过可能的空格
            timestamp = 0; while (*p >= '0' && *p <= '9') timestamp = timestamp * 10 + (*p++ - '0');
            
            // 跳过 ","open":
            while (*p && *p != '"') p++; p++;
            while (*p && *p != ':') p++; p++;
            open = strtod(p, &p);
            
            // 跳过 ","high":
            while (*p && *p != '"') p++; p++;
            while (*p && *p != ':') p++; p++;
            high = strtod(p, &p);
            
            // 跳过 ","low":
            while (*p && *p != '"') p++; p++;
            while (*p && *p != ':') p++; p++;
            low = strtod(p, &p);
            
            // 跳过 ","close":
            while (*p && *p != '"') p++; p++;
            while (*p && *p != ':') p++; p++;
            close = strtod(p, &p);
            
            // 跳过 ","volume":
            while (*p && *p != '"') p++; p++;
            while (*p && *p != ':') p++; p++;
            volume = strtod(p, &p);
            
            // delete模式：设置tombstone标志
            if (delete_mode) {
                volume = -1.0;
            }
            
            // 验证必要字段
            if (symbol[0] == '\0' || interval[0] == '\0' || timestamp == 0) {
                errors++;
                continue;
            }
            
            // UPSERT 模式：延迟加载现有数据
            if (upsert_mode && existing_count == 0 && upsert_symbol[0] == '\0') {
                strncpy(upsert_symbol, symbol, 63);
                strncpy(upsert_interval, interval, 15);
                
                // 读取该 symbol/interval 的现有数据
                QueryResult *qr = ndtsdb_query_all(db);
                if (qr) {
                    // ResultRow 结构: KlineRow row; char symbol[32]; char interval[16];
                    typedef struct { KlineRow row; char sym[32]; char itv[16]; } ResultRow;
                    ResultRow *rr = (ResultRow*)qr->rows;
                    for (uint32_t j = 0; j < qr->count; j++) {
                        if (strcmp(rr[j].sym, symbol) == 0 && strcmp(rr[j].itv, interval) == 0) {
                            if (existing_count >= existing_capacity) {
                                existing_capacity *= 2;
                                existing_rows = realloc(existing_rows, existing_capacity * sizeof(TimestampRow));
                                if (!existing_rows) {
                                    fprintf(stderr, "Error: OOM\n");
                                    ndtsdb_free_result(qr);
                                    goto cleanup;
                                }
                            }
                            existing_rows[existing_count].timestamp = rr[j].row.timestamp;
                            existing_rows[existing_count].row = rr[j].row;
                            existing_count++;
                        }
                    }
                    ndtsdb_free_result(qr);
                }
            }
            
            // UPSERT 模式：检查是否已存在
            if (upsert_mode) {
                int found = 0;
                for (int j = 0; j < existing_count; j++) {
                    if (existing_rows[j].timestamp == timestamp) {
                        // 更新现有行
                        existing_rows[j].row.open = open;
                        existing_rows[j].row.high = high;
                        existing_rows[j].row.low = low;
                        existing_rows[j].row.close = close;
                        existing_rows[j].row.volume = volume;
                        updated_count++;
                        found = 1;
                        break;
                    }
                }
                if (found) continue; // 已更新，跳过插入
                
                // 新行：添加到 existing_rows
                if (existing_count >= existing_capacity) {
                    existing_capacity *= 2;
                    existing_rows = realloc(existing_rows, existing_capacity * sizeof(TimestampRow));
                    if (!existing_rows) {
                        fprintf(stderr, "Error: OOM\n");
                        goto cleanup;
                    }
                }
                existing_rows[existing_count].timestamp = timestamp;
                existing_rows[existing_count].row.timestamp = timestamp;
                existing_rows[existing_count].row.open = open;
                existing_rows[existing_count].row.high = high;
                existing_rows[existing_count].row.low = low;
                existing_rows[existing_count].row.close = close;
                existing_rows[existing_count].row.volume = volume;
                existing_rows[existing_count].row.flags = 0;
                existing_count++;
                inserted_count++;
                continue;
            }
            
            // 检查 symbol/interval 是否变化，变化则先刷新批次
            if (batch_count > 0 && (strcmp(symbol, batch_symbol) != 0 || strcmp(interval, batch_interval) != 0)) {
                off_t wal_offset = ndtsdb_wal_append(database, batch_symbol, batch_interval, batch, batch_count);
                int inserted = ndtsdb_insert_batch(db, batch_symbol, batch_interval, batch, batch_count);
                if (inserted > 0) {
                    count += inserted;
                    if (wal_offset >= 0) {
                        ndtsdb_wal_mark_committed(database, wal_offset);
                    }
                } else {
                    errors += batch_count;
                }
                batch_count = 0;
            }
            
            // 保存 symbol/interval（首次或变化后）
            if (batch_count == 0) {
                strncpy(batch_symbol, symbol, 63);
                strncpy(batch_interval, interval, 15);
            }
            
            // 填充 batch
            batch[batch_count].timestamp = timestamp;
            batch[batch_count].open = open;
            batch[batch_count].high = high;
            batch[batch_count].low = low;
            batch[batch_count].close = close;
            batch[batch_count].volume = volume;
            batch[batch_count].flags = 0;
            batch_count++;
            
            // 批量写入（满批次）
            if (batch_count >= BATCH_SIZE) {
                // 先写 WAL，再写数据
                off_t wal_offset = ndtsdb_wal_append(database, batch_symbol, batch_interval, batch, batch_count);
                int inserted = ndtsdb_insert_batch(db, batch_symbol, batch_interval, batch, batch_count);
                if (inserted > 0) {
                    count += inserted;
                    // 标记 WAL 为已提交
                    if (wal_offset >= 0) {
                        ndtsdb_wal_mark_committed(database, wal_offset);
                    }
                } else {
                    errors += batch_count;
                }
                batch_count = 0;
                if (use_daemon_mode) {
                    gettimeofday(&last_flush_time, NULL);
                    fprintf(stderr, "Flushed: total=%d, errors=%d\r", count, errors);
                }
            }
        }
        
        // UPSERT 模式：清空并重新写入所有数据
        if (upsert_mode && existing_count > 0) {
            // 清空该 symbol/interval
            ndtsdb_clear(db, upsert_symbol, upsert_interval);
            
            // 重新构建 batch 并写入
            #define UPSERT_BATCH 5000
            KlineRow *upsert_batch = malloc(UPSERT_BATCH * sizeof(KlineRow));
            if (upsert_batch) {
                int upsert_batch_count = 0;
                for (int i = 0; i < existing_count; i++) {
                    upsert_batch[upsert_batch_count++] = existing_rows[i].row;
                    if (upsert_batch_count >= UPSERT_BATCH) {
                        ndtsdb_insert_batch(db, upsert_symbol, upsert_interval, upsert_batch, upsert_batch_count);
                        upsert_batch_count = 0;
                    }
                }
                if (upsert_batch_count > 0) {
                    ndtsdb_insert_batch(db, upsert_symbol, upsert_interval, upsert_batch, upsert_batch_count);
                }
                free(upsert_batch);
            }
            printf("UPSERT: %d updated, %d inserted, %d total\n", updated_count, inserted_count, existing_count);
        }
        
    cleanup:
        // 写入剩余数据（非upsert模式）
        if (!upsert_mode && batch_count > 0 && batch_symbol[0] != '\0') {
            // 先写 WAL，再写数据
            off_t wal_offset = ndtsdb_wal_append(database, batch_symbol, batch_interval, batch, batch_count);
            int inserted = ndtsdb_insert_batch(db, batch_symbol, batch_interval, batch, batch_count);
            if (inserted > 0) {
                count += inserted;
                // 标记 WAL 为已提交
                if (wal_offset >= 0) {
                    ndtsdb_wal_mark_committed(database, wal_offset);
                }
            } else {
                errors += batch_count;
            }
        }
        
        if (use_daemon_mode) {
            fprintf(stderr, "\nFinal: inserted=%d, errors=%d\n", count, errors);
        } else if (!upsert_mode) {
            printf("Inserted %d rows, %d errors\n", count, errors);
        }
        
        #undef SKIP_COLON
        
        if (existing_rows) free(existing_rows);
        ndtsdb_close(db);
        ndtsdb_lock_release(lock_fd);
        free(batch);
        
        return errors > 0 ? 1 : 0;
}

// ==================== write-vector 子命令 ====================
int cmd_write_vector(int argc, char *argv[]) {
    const char *database = NULL;
    bool help_flag = false;
    
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            help_flag = true;
        } else if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
            if (i + 1 < argc) database = argv[++i];
        }
    }
    
    if (help_flag) {
        printf("Usage: ndtsdb-cli write-vector --database <path>\n\n");
        printf("Write vector records from stdin to database.\n\n");
        printf("Options:\n");
        printf("  --database, -d  Database directory path (required)\n");
        printf("\nExample:\n");
        printf("  echo '{\"timestamp\":...,\"agent_id\":...,\"type\":...,\"confidence\":...,\"embedding\":[...]}' | ndtsdb-cli write-vector -d ./db\n");
        return 0;
    }
    
    if (!database) {
        fprintf(stderr, "Error: --database is required\n");
        return 1;
    }
    
    // 获取独占写锁
    int lock_fd = ndtsdb_lock_acquire(database, true);
    if (lock_fd < 0) {
        fprintf(stderr, "Error: Failed to acquire write lock\n");
        return 1;
    }
    
    NDTSDB *db = ndtsdb_open(database);
    if (!db) {
        fprintf(stderr, "Error: Failed to open database\n");
        ndtsdb_lock_release(lock_fd);
        return 1;
    }
    
    char line[8192];
    int count = 0;
    int errors = 0;
    
    while (fgets(line, sizeof(line), stdin)) {
        // 去掉末尾换行
        size_t len = strlen(line);
        while (len > 0 && (line[len-1] == '\n' || line[len-1] == '\r')) {
            line[--len] = '\0';
        }
        
        if (len == 0) continue;
        
        // 解析向量 JSON
        VecRecord vrec;
        memset(&vrec, 0, sizeof(vrec));
        
        // 解析 agent_id
        const char *p = strstr(line, "\"agent_id\"");
        if (p) {
            p = strstr(p, ":");
            if (p) {
                p++;
                while (*p == ' ' || *p == '\t') p++;
                if (*p == '"') {
                    p++;
                    int i = 0;
                    while (p && *p && *p != '"' && i < 31) vrec.agent_id[i++] = *p++;
                    vrec.agent_id[i] = '\0';
                }
            }
        }
        
        // 解析 type
        p = strstr(line, "\"type\"");
        if (p) {
            p = strstr(p, ":");
            if (p) {
                p++;
                while (*p == ' ' || *p == '\t') p++;
                if (*p == '"') {
                    p++;
                    int i = 0;
                    while (p && *p && *p != '"' && i < 15) vrec.type[i++] = *p++;
                    vrec.type[i] = '\0';
                }
            }
        }
        
        // 解析 timestamp
        p = strstr(line, "\"timestamp\"");
        if (p) {
            p = strchr(p, ':');
            if (p) vrec.timestamp = atoll(p + 1);
        }
        
        // 解析 confidence
        p = strstr(line, "\"confidence\"");
        if (p) {
            p = strchr(p, ':');
            if (p) vrec.confidence = (float)atof(p + 1);
        }
        
        // 解析 embedding
        p = strstr(line, "\"embedding\"");
        if (p) {
            p = strchr(p, '[');
            if (p) {
                p++;
                float emb[4096];
                int dim = 0;
                while (p && *p && *p != ']' && dim < 4096) {
                    char *end;
                    float v = strtof(p, &end);
                    if (end == p) { p++; continue; }
                    emb[dim++] = v;
                    p = end;
                    while (*p == ' ' || *p == ',') p++;
                }
                if (dim > 0) {
                    vrec.embedding = malloc(dim * sizeof(float));
                    if (vrec.embedding) {
                        memcpy(vrec.embedding, emb, dim * sizeof(float));
                        vrec.embedding_dim = dim;
                    }
                } else {
                    // 空 embedding 时分配一个默认值（占位）
                    vrec.embedding = malloc(sizeof(float));
                    if (vrec.embedding) {
                        vrec.embedding[0] = 0.0f;
                        vrec.embedding_dim = 1;
                    }
                }
            }
        }
        
        // 验证并写入
        if (vrec.timestamp > 0 && vrec.agent_id[0] && vrec.embedding && vrec.embedding_dim > 0) {
            int ok = ndtsdb_vec_insert(db, vrec.agent_id, vrec.type, &vrec);
            if (ok == 0) {
                // 写入标记行
                KlineRow marker = {
                    .timestamp = vrec.timestamp,
                    .open = vrec.confidence,
                    .high = (double)vrec.embedding_dim,
                    .low = 0.0,
                    .close = 0.0,
                    .volume = 0.0,
                    .flags = 0x01
                };
                ndtsdb_insert(db, vrec.agent_id, vrec.type, &marker);
                count++;
            } else {
                errors++;
            }
        } else {
            errors++;
        }
        
        if (vrec.embedding) free(vrec.embedding);
    }
    
    ndtsdb_close(db);
    ndtsdb_lock_release(lock_fd);
    
    printf("{\"inserted\":%d,\"errors\":%d}\n", count, errors);
    return errors > 0 ? 1 : 0;
}

// ==================== delete 子命令 ====================
int cmd_delete(int argc, char *argv[]) {
        const char *database = NULL;
        const char *symbol = NULL;
        const char *interval = NULL;
        int64_t timestamp = 0;
        
        for (int i = 2; i < argc; i++) {
            if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
                if (i + 1 < argc) database = argv[++i];
            } else if (strcmp(argv[i], "--symbol") == 0 || strcmp(argv[i], "-s") == 0) {
                if (i + 1 < argc) symbol = argv[++i];
            } else if (strcmp(argv[i], "--interval") == 0 || strcmp(argv[i], "-i") == 0) {
                if (i + 1 < argc) interval = argv[++i];
            } else if (strcmp(argv[i], "--timestamp") == 0 || strcmp(argv[i], "-t") == 0) {
                if (i + 1 < argc) timestamp = atoll(argv[++i]);
            }
        }
        
        if (!database || !symbol || !interval || timestamp == 0) {
            fprintf(stderr, "Error: --database, --symbol, --interval, --timestamp are required\n");
            return 1;
        }
        
        // 获取独占写锁
        int lock_fd = ndtsdb_lock_acquire(database, true);
        if (lock_fd < 0) {
            fprintf(stderr, "Error: Failed to acquire write lock on database: %s\n", database);
            return 1;
        }
        
        // 打开数据库
        NDTSDB *db = ndtsdb_open(database);
        if (!db) {
            fprintf(stderr, "Error: Failed to open database: %s\n", database);
            ndtsdb_lock_release(lock_fd);
            return 1;
        }
        
        // 写入tombstone：volume=-1.0作为删除标记
        KlineRow tombstone = {
            .timestamp = timestamp,
            .open = 0,
            .high = 0,
            .low = 0,
            .close = 0,
            .volume = -1.0,  // tombstone标志
            .flags = 0
        };
        
        int result = ndtsdb_insert(db, symbol, interval, &tombstone);
        
        if (result >= 0) {
            printf("Deleted: symbol=%s, interval=%s, timestamp=%ld\n", symbol, interval, timestamp);
        } else {
            fprintf(stderr, "Error: Failed to delete row\n");
        }
        
        ndtsdb_close(db);
        ndtsdb_lock_release(lock_fd);
        
        return result >= 0 ? 0 : 1;
    }

// ==================== export 子命令 ====================
int cmd_export(int argc, char *argv[]) {
    // 用法: ndtsdb-cli export --database <path> [--output <file>] [--symbol <sym>] [--interval <intv>]
    // 导出数据为 JSON Lines 格式（与 write-json 兼容）
    if (argc > 1 && strcmp(argv[1], "export") == 0) {
        const char *database = NULL;
        const char *output = NULL;
        const char *symbol = NULL;
        const char *interval = NULL;
        const char *format = "json";  // json | csv
        int help_flag = 0;
        for (int i = 2; i < argc; i++) {
            if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) { help_flag = 1; }
            else if ((strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) && i+1 < argc) database = argv[++i];
            else if ((strcmp(argv[i], "--output") == 0 || strcmp(argv[i], "-o") == 0) && i+1 < argc) output = argv[++i];
            else if ((strcmp(argv[i], "--symbol") == 0 || strcmp(argv[i], "-s") == 0) && i+1 < argc) symbol = argv[++i];
            else if ((strcmp(argv[i], "--interval") == 0 || strcmp(argv[i], "-i") == 0) && i+1 < argc) interval = argv[++i];
            else if ((strcmp(argv[i], "--format") == 0 || strcmp(argv[i], "-F") == 0) && i+1 < argc) format = argv[++i];
        }
        if (help_flag) {
            printf("Usage: ndtsdb-cli export --database <path> [--output <file>] [--symbol <sym>] [--interval <intv>] [--format json|csv]\n");
            printf("  Export data as JSON Lines or CSV (compatible with write-json)\n");
            printf("  --database, -d  Database path (required)\n");
            printf("  --output, -o    Output file (default: stdout)\n");
            printf("  --symbol, -s    Filter by symbol\n");
            printf("  --interval, -i  Filter by interval (requires --symbol)\n");
            printf("  --format, -F    Output format: json (default) or csv\n");
        }
        if (!database) {
            fprintf(stderr, "Usage: ndtsdb-cli export --database <path> [--output <file>] [--symbol <sym>] [--interval <intv>]\n");
        }
        NDTSDB *db = ndtsdb_open(database);
        QueryResult *result;
        if (symbol) { const char *syms[1] = {symbol}; result = ndtsdb_query_filtered(db, syms, 1); }
        else result = ndtsdb_query_all(db);

        typedef struct { KlineRow row; char symbol[32]; char interval[16]; } ExportRow;
        ExportRow *rows = (ExportRow*)result->rows;

        FILE *fp = stdout;
        if (output) {
            fp = fopen(output, "w");
        }

        int is_csv = (strcmp(format, "csv") == 0);
        if (is_csv) fprintf(fp, "symbol,interval,timestamp,open,high,low,close,volume\n");

        for (int i = 0; i < (int)result->count; i++) {
            if (rows[i].row.volume < 0) continue; // 过滤 tombstone
            if (interval && strcmp(rows[i].interval, interval) != 0) continue; // 过滤 interval

            // ── 向量行输出（M1-C）──────────────────────────────
            // flags & 0x01 == NDTSDB_FLAG_VECTOR
            if (rows[i].row.flags & 0x01) {
                // 临时策略：当发现向量行标记时，实时查询 .ndtv 文件获取完整数据
                // （此处 rows[i].symbol/interval 作为分区键）
                VecQueryResult* vqr = ndtsdb_vec_query(db, rows[i].symbol, rows[i].interval);
                if (vqr && vqr->count > 0) {
                    // 找到匹配 timestamp 的记录
                    for (uint32_t j = 0; j < vqr->count; j++) {
                        if (vqr->records[j].timestamp == rows[i].row.timestamp) {
                            VecRecord* vrec = &vqr->records[j];
                            if (is_csv) {
                                // CSV 不适合输出变长 embedding，仅输出元数据
                                fprintf(fp, "%s,%s,%lld,%.6f,%d,,,\n",
                                    vrec->agent_id, vrec->type,
                                    (long long)vrec->timestamp,
                                    vrec->confidence, vrec->embedding_dim);
                            } else {
                                // JSON 输出完整 embedding
                                fprintf(fp, "{\"agent_id\":\"%s\",\"type\":\"%s\",\"timestamp\":%lld,\"confidence\":%.6f,\"embedding\":[",
                                    vrec->agent_id, vrec->type,
                                    (long long)vrec->timestamp, vrec->confidence);
                                for (int k = 0; k < vrec->embedding_dim; k++) {
                                    fprintf(fp, k == 0 ? "%.8f" : ",%.8f", vrec->embedding[k]);
                                }
                                fprintf(fp, "]}\n");
                            }
                            break;
                        }
                    }
                    ndtsdb_vec_free_result(vqr);
                } else {
                    // 向量文件不存在或为空，输出占位（不应发生）
                    fprintf(fp, "{\"agent_id\":\"%s\",\"type\":\"%s\",\"timestamp\":%lld,\"error\":\"vector data not found\"}\n",
                        rows[i].symbol, rows[i].interval, (long long)rows[i].row.timestamp);
                }
                continue;
            }
            // ── 常规 K 线输出 ────────────────────────────────────

            if (is_csv) {
                fprintf(fp, "%s,%s,%lld,%.8f,%.8f,%.8f,%.8f,%.8f\n",
                    rows[i].symbol, rows[i].interval, (long long)rows[i].row.timestamp,
                    rows[i].row.open, rows[i].row.high, rows[i].row.low, rows[i].row.close, rows[i].row.volume);
            } else {
                fprintf(fp, "{\"symbol\":\"%s\",\"interval\":\"%s\",\"timestamp\":%lld,\"open\":%.8f,\"high\":%.8f,\"low\":%.8f,\"close\":%.8f,\"volume\":%.8f}\n",
                    rows[i].symbol, rows[i].interval, (long long)rows[i].row.timestamp,
                    rows[i].row.open, rows[i].row.high, rows[i].row.low, rows[i].row.close, rows[i].row.volume);
            }
        }

        if (output) fclose(fp);
        ndtsdb_free_result(result);
        ndtsdb_close(db);
        return 0;
    }
}
