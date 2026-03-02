// cmd_sql.c - SQL/Merge/Resample 子命令实现
#include "cmd_sql.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <stdint.h>
#include <limits.h>
#include <math.h>
#include "quickjs.h"
#include "../../ndtsdb-lib/native/ndtsdb.h"
#include "ndtsdb_lock.h"
#include "sql_engine_js.h"

// 外部依赖（由 main.c 提供）
extern JSContext *ctx;
extern JSRuntime *rt;
extern void print_exception(JSContext *ctx);

// 字符串转义辅助函数
static char *quote_string(const char *str) {
    if (!str) return strdup("null");
    size_t len = strlen(str);
    /* Worst case: every char needs 2-char escape + surrounding quotes + NUL */
    char *escaped = (char *)malloc(len * 4 + 3);
    if (!escaped) return NULL;
    escaped[0] = '\"';
    size_t j = 1;
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)str[i];
        if (c == '\"' || c == '\\') { escaped[j++] = '\\'; escaped[j++] = c; }
        else if (c == '\n') { escaped[j++] = '\\'; escaped[j++] = 'n'; }
        else if (c == '\r') { escaped[j++] = '\\'; escaped[j++] = 'r'; }
        else if (c == '\t') { escaped[j++] = '\\'; escaped[j++] = 't'; }
        else { escaped[j++] = c; }
    }
    escaped[j++] = '\"';
    escaped[j] = '\0';
    return escaped;
}

// ==================== SQL 子命令 ====================
int cmd_sql(int argc, char *argv[]) {
    const char *database = NULL;
    const char *query = NULL;
    const char *format = "json";
    int help_flag = 0;
    
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) { help_flag = 1; }
        else if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
            if (i + 1 < argc) database = argv[++i];
        } else if (strcmp(argv[i], "--query") == 0 || strcmp(argv[i], "-q") == 0) {
            if (i + 1 < argc) query = argv[++i];
        } else if (strcmp(argv[i], "--format") == 0 || strcmp(argv[i], "-f") == 0) {
            if (i + 1 < argc) format = argv[++i];
        }
    }
    
    if (help_flag) {
        printf("Usage: ndtsdb-cli sql --database <path> --query <sql> [--format <json|csv>]\n");
        printf("  Execute SQL query on the database\n");
        printf("  --database, -d  Database path (required)\n");
        printf("  --query, -q     SQL query string (required)\n");
        printf("  --format, -f    Output format: json or csv (default: json)\n");
        return 0;
    }
    
    if (!database) {
        fprintf(stderr, "Error: --database is required\n");
        return 1;
    }


    // Inject globals for the SQL engine
    char globals_js[4096];
    char *db_escaped = quote_string(database);
    char *query_escaped = query ? quote_string(query) : strdup("null");
    snprintf(globals_js, sizeof(globals_js),
        "globalThis.__SQL_DATABASE = %s;\n"
        "globalThis.__SQL_QUERY = %s;\n"
        "globalThis.__SQL_FORMAT = '%s';\n",
        db_escaped ? db_escaped : "null",
        query_escaped,
        format
    );
    free(db_escaped);
    free(query_escaped);

    JS_Eval(ctx, globals_js, strlen(globals_js), "<sql-globals>", JS_EVAL_TYPE_GLOBAL);

    // Run the full SQL engine embedded from sql_engine_js.h
    JSValue result = JS_Eval(ctx, sql_engine_js, sql_engine_js_len, "<sql-engine>", JS_EVAL_TYPE_MODULE);
    int exit_code = 0;
    if (JS_IsException(result)) {
        print_exception(ctx);
        exit_code = 1;
    }
    JS_FreeValue(ctx, result);

    JSContext *ctx2;
    while (JS_ExecutePendingJob(rt, &ctx2) > 0) {}

    return exit_code;
}

// ==================== Merge 子命令 ====================
typedef struct {
    char symbol[32];
    char interval[16];
    KlineRow row;
} MergeRow;

// 去重用的 hash set 条目
typedef struct {
    char key[80];  // symbol + interval + timestamp 组合键
    bool exists;
} DedupEntry;

#define DEDUP_BUCKETS 65536  // 2^16 buckets

static unsigned int dedup_hash(const char *key) {
    unsigned int h = 5381;
    while (*key) {
        h = ((h << 5) + h) + *key++;
    }
    return h % DEDUP_BUCKETS;
}

static void build_dedup_key(char *buf, size_t buf_sz, const char *symbol, const char *interval, int64_t timestamp) {
    snprintf(buf, buf_sz, "%s|%s|%ld", symbol, interval, timestamp);
}

int cmd_merge(int argc, char *argv[]) {
    const char *from_db = NULL;
    const char *to_db = NULL;
    const char *filter_symbol = NULL;
    const char *filter_interval = NULL;
    int help_flag = 0;

    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) { help_flag = 1; }
        else if (strcmp(argv[i], "--from") == 0 && i+1 < argc) { from_db = argv[++i]; }
        else if (strcmp(argv[i], "--to")   == 0 && i+1 < argc) { to_db   = argv[++i]; }
        else if (strcmp(argv[i], "--symbol")   == 0 && i+1 < argc) { filter_symbol   = argv[++i]; }
        else if (strcmp(argv[i], "--interval") == 0 && i+1 < argc) { filter_interval = argv[++i]; }
    }

    if (help_flag) {
        printf("Usage: ndtsdb-cli merge --from <src> --to <dst> [--symbol <sym>] [--interval <intv>]\n");
        printf("  Merge data from source database to target (tombstones filtered)\n");
        printf("  --from, -f    Source database path (required)\n");
        printf("  --to, -t      Target database path (required)\n");
        printf("  --symbol      Filter by symbol\n");
        printf("  --interval    Filter by interval (requires --symbol)\n");
        return 0;
    }

    if (!from_db || !to_db) {
        fprintf(stderr, "Error: --from and --to are required\n");
        return 1;
    }

    MergeRow *buf = NULL;
    int buf_count = 0;
    int buf_capacity = 4096;
    int total_skipped = 0;
    int total_duplicates = 0;  // 去重计数

    // 去重 hash set
    DedupEntry **dedup_set = calloc(DEDUP_BUCKETS, sizeof(DedupEntry*));
    if (!dedup_set) {
        fprintf(stderr, "Error: OOM allocating dedup set\n");
        return 1;
    }

    buf = (MergeRow*)malloc(buf_capacity * sizeof(MergeRow));
    if (!buf) {
        fprintf(stderr, "Error: OOM allocating merge buffer\n");
        free(dedup_set);
        return 1;
    }

    // ========== 第一步：读取目标库，构建去重集合 ==========
    {
        int lock_fd = ndtsdb_lock_acquire(to_db, false);
        if (lock_fd < 0) {
            fprintf(stderr, "Error: cannot lock target DB: %s\n", to_db);
            free(buf);
            free(dedup_set);
            return 1;
        }

        NDTSDB *to = ndtsdb_open(to_db);
        if (!to) {
            ndtsdb_lock_release(lock_fd);
            fprintf(stderr, "Error: cannot open target DB: %s\n", to_db);
            free(buf);
            free(dedup_set);
            return 1;
        }

        char syms[256][32]; char itvs[256][16];
        int n = ndtsdb_list_symbols(to, syms, itvs, 256);

        for (int s = 0; s < n; s++) {
            if (filter_symbol && strcmp(syms[s], filter_symbol) != 0) continue;
            if (filter_interval && strcmp(itvs[s], filter_interval) != 0) continue;

            Query q = { .symbol = syms[s], .interval = itvs[s],
                         .startTime = 0, .endTime = INT64_MAX, .limit = 0 };
            QueryResult *qr = ndtsdb_query(to, &q);
            if (!qr) continue;

            for (uint32_t r = 0; r < qr->count; r++) {
                if (qr->rows[r].volume < 0) continue;  // 跳过 tombstone

                char key[80];
                build_dedup_key(key, sizeof(key), syms[s], itvs[s], qr->rows[r].timestamp);
                unsigned int h = dedup_hash(key);

                // 检查是否已存在（处理碰撞）
                DedupEntry *entry = dedup_set[h];
                while (entry) {
                    if (strcmp(entry->key, key) == 0) {
                        entry->exists = true;
                        break;
                    }
                    // 简单线性探测：在同一 bucket 内找下一个
                    h = (h + 1) % DEDUP_BUCKETS;
                    entry = dedup_set[h];
                }

                if (!entry) {
                    entry = malloc(sizeof(DedupEntry));
                    if (entry) {
                        strncpy(entry->key, key, sizeof(entry->key) - 1);
                        entry->key[sizeof(entry->key) - 1] = '\0';
                        entry->exists = true;
                        dedup_set[h] = entry;
                    }
                }
            }
            ndtsdb_free_result(qr);
        }

        ndtsdb_close(to);
        ndtsdb_lock_release(lock_fd);
    }

    // ========== 第二步：读取源库，过滤重复 ==========
    {
        int lock_fd = ndtsdb_lock_acquire(from_db, false);
        if (lock_fd < 0) {
            fprintf(stderr, "Error: cannot lock source DB: %s\n", from_db);
            free(buf);
            // 清理 dedup_set
            for (int i = 0; i < DEDUP_BUCKETS; i++) {
                if (dedup_set[i]) free(dedup_set[i]);
            }
            free(dedup_set);
            return 1;
        }

        NDTSDB *from = ndtsdb_open(from_db);
        if (!from) {
            ndtsdb_lock_release(lock_fd);
            fprintf(stderr, "Error: cannot open source DB: %s\n", from_db);
            free(buf);
            for (int i = 0; i < DEDUP_BUCKETS; i++) {
                if (dedup_set[i]) free(dedup_set[i]);
            }
            free(dedup_set);
            return 1;
        }

        char syms[256][32]; char itvs[256][16];
        int n = ndtsdb_list_symbols(from, syms, itvs, 256);

        for (int s = 0; s < n; s++) {
            if (filter_symbol && strcmp(syms[s], filter_symbol) != 0) continue;
            if (filter_interval && strcmp(itvs[s], filter_interval) != 0) continue;

            Query q = { .symbol = syms[s], .interval = itvs[s],
                         .startTime = 0, .endTime = INT64_MAX, .limit = 0 };
            QueryResult *qr = ndtsdb_query(from, &q);
            if (!qr) continue;

            for (uint32_t r = 0; r < qr->count; r++) {
                if (qr->rows[r].volume < 0) { total_skipped++; continue; }

                // 检查是否在目标库已存在
                char key[80];
                build_dedup_key(key, sizeof(key), syms[s], itvs[s], qr->rows[r].timestamp);
                unsigned int h = dedup_hash(key);
                bool exists = false;

                DedupEntry *entry = dedup_set[h];
                while (entry) {
                    if (strcmp(entry->key, key) == 0) {
                        exists = entry->exists;
                        break;
                    }
                    h = (h + 1) % DEDUP_BUCKETS;
                    entry = dedup_set[h];
                }

                if (exists) {
                    total_duplicates++;
                    continue;  // 跳过重复
                }

                if (buf_count >= buf_capacity) {
                    buf_capacity *= 2;
                    MergeRow *tmp = (MergeRow*)realloc(buf, buf_capacity * sizeof(MergeRow));
                    if (!tmp) {
                        ndtsdb_free_result(qr);
                        ndtsdb_close(from);
                        ndtsdb_lock_release(lock_fd);
                        for (int di = 0; di < DEDUP_BUCKETS; di++) if (dedup_set[di]) free(dedup_set[di]);
                        free(dedup_set);
                        free(buf);
                        fprintf(stderr, "Error: out of memory during merge\n");
                        return 1;
                    }
                    buf = tmp;
                }
                strncpy(buf[buf_count].symbol, syms[s], 31);
                buf[buf_count].symbol[31] = '\0';
                strncpy(buf[buf_count].interval, itvs[s], 15);
                buf[buf_count].interval[15] = '\0';
                buf[buf_count].row = qr->rows[r];
                buf_count++;
            }
            ndtsdb_free_result(qr);
        }

        ndtsdb_close(from);
        ndtsdb_lock_release(lock_fd);
    }

    // 清理 dedup_set
    for (int i = 0; i < DEDUP_BUCKETS; i++) {
        if (dedup_set[i]) free(dedup_set[i]);
    }
    free(dedup_set);

    // ========== 第三步：批量插入目标库 ==========
    {
        int lock_fd = ndtsdb_lock_acquire(to_db, true);
        if (lock_fd < 0) {
            fprintf(stderr, "Error: cannot lock target DB: %s\n", to_db);
            free(buf);
            return 1;
        }

        NDTSDB *to = ndtsdb_open(to_db);
        if (!to) {
            ndtsdb_lock_release(lock_fd);
            fprintf(stderr, "Error: cannot open target DB: %s\n", to_db);
            free(buf);
            return 1;
        }

        int total_merged = 0;
        int i = 0;
        while (i < buf_count) {
            int j = i;
            while (j < buf_count &&
                   strcmp(buf[j].symbol, buf[i].symbol) == 0 &&
                   strcmp(buf[j].interval, buf[i].interval) == 0) j++;

            int batch_n = j - i;
            KlineRow *batch = (KlineRow*)malloc(batch_n * sizeof(KlineRow));
            if (!batch) goto merge_oom2;
            for (int k = 0; k < batch_n; k++) batch[k] = buf[i+k].row;
            int ins = ndtsdb_insert_batch(to, buf[i].symbol, buf[i].interval, batch, (uint32_t)batch_n);
            if (ins > 0) total_merged += ins;
            free(batch);
            i = j;
        }

        ndtsdb_close(to);
        ndtsdb_lock_release(lock_fd);
        free(buf);

        printf("Merged %d rows (skipped %d tombstones, %d duplicates)\n", total_merged, total_skipped, total_duplicates);
        return 0;

merge_oom2:
        ndtsdb_close(to);
        ndtsdb_lock_release(lock_fd);
        free(buf);
        fprintf(stderr, "Error: out of memory during merge\n");
        return 1;
    }
}

// ==================== Resample 子命令 ====================
typedef struct { int64_t timestamp; double open, high, low, close, volume; } OHLCV;
typedef struct { int64_t timestamp; double open, high, low, close, volume; } AggCandle;

int cmd_resample(int argc, char *argv[]) {
    const char *database = NULL;
    const char *symbol = NULL;
    const char *from_interval = NULL;
    const char *to_interval = NULL;
    const char *output_db = NULL;
    int help_flag = 0;

    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) { help_flag = 1; }
        else if ((strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) && i+1 < argc) database = argv[++i];
        else if ((strcmp(argv[i], "--symbol") == 0 || strcmp(argv[i], "-s") == 0) && i+1 < argc) symbol = argv[++i];
        else if ((strcmp(argv[i], "--from") == 0 || strcmp(argv[i], "-f") == 0) && i+1 < argc) from_interval = argv[++i];
        else if ((strcmp(argv[i], "--to") == 0 || strcmp(argv[i], "-t") == 0) && i+1 < argc) to_interval = argv[++i];
        else if ((strcmp(argv[i], "--output") == 0 || strcmp(argv[i], "-o") == 0) && i+1 < argc) output_db = argv[++i];
    }

    if (help_flag) {
        printf("Usage: ndtsdb-cli resample --database <path> --symbol <sym> --from <intv> --to <intv> [--output <db>]\n");
        printf("  Resample OHLCV data from smaller to larger timeframe\n");
        printf("  --database, -d  Source database path (required)\n");
        printf("  --symbol, -s    Symbol to resample (required)\n");
        printf("  --from, -f      Source interval, e.g., 1m (required)\n");
        printf("  --to, -t        Target interval, e.g., 5m, 15m, 1h (required)\n");
        printf("  --output, -o    Output database (default: stdout as JSONL)\n");
        printf("  Supported: 1m->5m(N=5), 1m->15m(N=15), 1m->1h(N=60), 5m->1h(N=12)\n");
        return 0;
    }

    if (!database || !symbol || !from_interval || !to_interval) {
        fprintf(stderr, "Error: --database, --symbol, --from, and --to are required\n");
        return 1;
    }

    int N = 0;
    if (strcmp(from_interval, "1m") == 0) {
        if (strcmp(to_interval, "5m") == 0) N = 5;
        else if (strcmp(to_interval, "15m") == 0) N = 15;
        else if (strcmp(to_interval, "1h") == 0) N = 60;
    } else if (strcmp(from_interval, "5m") == 0) {
        if (strcmp(to_interval, "1h") == 0) N = 12;
    }
    if (N == 0) {
        fprintf(stderr, "Error: Unsupported resample conversion: %s -> %s\n", from_interval, to_interval);
        return 1;
    }

    NDTSDB *db = ndtsdb_open(database);
    if (!db) { fprintf(stderr, "Error: Cannot open database: %s\n", database); return 1; }

    const char *syms[1] = {symbol};
    QueryResult *result = ndtsdb_query_filtered(db, syms, 1);
    if (!result) { ndtsdb_close(db); return 1; }

    typedef struct { KlineRow row; char symbol[32]; char interval[16]; } ResampleRow;
    ResampleRow *rows = (ResampleRow*)result->rows;

    OHLCV *candles = NULL;
    int candle_count = 0;
    int candle_capacity = 1024;
    candles = (OHLCV*)malloc(candle_capacity * sizeof(OHLCV));
    if (!candles) { ndtsdb_free_result(result); ndtsdb_close(db); return 1; }

    for (int i = 0; i < (int)result->count; i++) {
        if (rows[i].row.volume < 0) continue;
        if (strcmp(rows[i].interval, from_interval) != 0) continue;
        if (candle_count >= candle_capacity) {
            candle_capacity *= 2;
            OHLCV *tmp = (OHLCV*)realloc(candles, candle_capacity * sizeof(OHLCV));
            if (!tmp) { free(candles); ndtsdb_free_result(result); ndtsdb_close(db); return 1; }
            candles = tmp;
        }
        candles[candle_count].timestamp = rows[i].row.timestamp;
        candles[candle_count].open = rows[i].row.open;
        candles[candle_count].high = rows[i].row.high;
        candles[candle_count].low = rows[i].row.low;
        candles[candle_count].close = rows[i].row.close;
        candles[candle_count].volume = rows[i].row.volume;
        candle_count++;
    }
    ndtsdb_free_result(result);
    ndtsdb_close(db);

    if (candle_count == 0) {
        fprintf(stderr, "Error: No data found for %s/%s\n", symbol, from_interval);
        free(candles);
        return 1;
    }

    for (int i = 0; i < candle_count - 1; i++) {
        for (int j = i + 1; j < candle_count; j++) {
            if (candles[j].timestamp < candles[i].timestamp) {
                OHLCV tmp = candles[i]; candles[i] = candles[j]; candles[j] = tmp;
            }
        }
    }

    AggCandle *agg = NULL;
    int agg_count = 0;
    int agg_capacity = (candle_count + N - 1) / N + 1;
    agg = (AggCandle*)malloc(agg_capacity * sizeof(AggCandle));
    if (!agg) { free(candles); return 1; }

    for (int i = 0; i < candle_count; i += N) {
        int64_t ts = candles[i].timestamp;
        double open = candles[i].open;
        double high = candles[i].high;
        double low = candles[i].low;
        double close = candles[i].close;
        double volume = candles[i].volume;
        for (int j = i + 1; j < i + N && j < candle_count; j++) {
            if (candles[j].high > high) high = candles[j].high;
            if (candles[j].low < low) low = candles[j].low;
            close = candles[j].close;
            volume += candles[j].volume;
        }
        agg[agg_count].timestamp = ts;
        agg[agg_count].open = open;
        agg[agg_count].high = high;
        agg[agg_count].low = low;
        agg[agg_count].close = close;
        agg[agg_count].volume = volume;
        agg_count++;
    }
    free(candles);

    if (output_db) {
        NDTSDB *out_db = ndtsdb_open(output_db);
        if (!out_db) {
            fprintf(stderr, "Error: Cannot open output database: %s\n", output_db);
            free(agg);
            return 1;
        }
        KlineRow *batch = (KlineRow*)malloc(agg_count * sizeof(KlineRow));
        if (!batch) { ndtsdb_close(out_db); free(agg); return 1; }
        for (int i = 0; i < agg_count; i++) {
            batch[i].timestamp = agg[i].timestamp;
            batch[i].open = agg[i].open;
            batch[i].high = agg[i].high;
            batch[i].low = agg[i].low;
            batch[i].close = agg[i].close;
            batch[i].volume = agg[i].volume;
            batch[i].flags = 0;  // 初始化flags，避免垃圾值
        }
        int inserted = ndtsdb_insert_batch(out_db, symbol, to_interval, batch, agg_count);
        ndtsdb_close(out_db);
        free(batch);
        free(agg);
        printf("Resampled %d rows into %d %s candles (inserted: %d)\n", candle_count, agg_count, to_interval, inserted);
    } else {
        for (int i = 0; i < agg_count; i++) {
            printf("{\"symbol\":\"%s\",\"interval\":\"%s\",\"timestamp\":%lld,\"open\":%.8f,\"high\":%.8f,\"low\":%.8f,\"close\":%.8f,\"volume\":%.8f}\n",
                symbol, to_interval, (long long)agg[i].timestamp,
                agg[i].open, agg[i].high, agg[i].low, agg[i].close, agg[i].volume);
        }
        free(agg);
    }
    return 0;
}
