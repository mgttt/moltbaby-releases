// ============================================================
// ndtsdb-cli: CLI 入口 - QuickJS + libndtsdb
// 支持: ./ndtsdb-cli script.js  或  ./ndtsdb-cli (REPL)
// ============================================================

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <time.h>
#include <fcntl.h>
#include <errno.h>
#include <signal.h>
#include <math.h>
#include "quickjs.h"

#ifdef _WIN32
#include <winsock2.h>
#include <windows.h>
#include <ws2tcpip.h>
#include <io.h>
#include <direct.h>
#include <sys/stat.h>
#define mkdir(path, mode) _mkdir(path)
#define close(fd) _close(fd)
#define read(fd, buf, count) _read(fd, buf, count)
#define write(fd, buf, count) _write(fd, buf, count)
#pragma comment(lib, "ws2_32.lib")
#else
#include <unistd.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <sys/select.h>
#include <dirent.h>
#endif

// 使用完整的 ndtsdb.h（而不是 src/bindings 中的简化版）
#include "../../ndtsdb-lib/native/ndtsdb.h"
#include "../../ndtsdb-lib/native/ndtsdb_vec.h"
#include "ndtsdb_lock.h"
#include "cmd_indicators.h"
#include "cmd_io.h"
#include "common.h"
#include "cmd_query.h"
#include "cmd_sql.h"
// #include "cmd_serve.h"  /* serve 已禁用：ndtsdb-cli 为纯CLI工具，不暴露HTTP服务 */
#include "cmd_plugin.h"
#include "cmd_search.h"
#include "cmd_facts.h"
#include "cmd_embed.h"

// ============================================================
// 跨平台兼容层
// ============================================================

// macOS clock_gettime 兼容
#ifdef __APPLE__
#include <mach/mach_time.h>
#include <mach/clock.h>
#include <mach/mach.h>

// macOS 10.12+ 原生支持 clock_gettime，但为了兼容旧版本提供替代
#ifndef CLOCK_REALTIME
#define CLOCK_REALTIME 0
typedef int clockid_t;

static int clock_gettime_compat(clockid_t clk_id, struct timespec *ts) {
    (void)clk_id;
    clock_serv_t cclock;
    mach_timespec_t mts;
    host_get_clock_service(mach_host_self(), CALENDAR_CLOCK, &cclock);
    clock_get_time(cclock, &mts);
    mach_port_deallocate(mach_task_self(), cclock);
    ts->tv_sec = mts.tv_sec;
    ts->tv_nsec = mts.tv_nsec;
    return 0;
}
#define clock_gettime clock_gettime_compat
#endif
#endif

// macOS getline 兼容（GNU 扩展，macOS 原生不支持）
#ifdef __APPLE__
static ssize_t portable_getline(char **lineptr, size_t *n, FILE *stream) {
    if (!lineptr || !stream) {
        errno = EINVAL;
        return -1;
    }
    
    // 初始分配
    if (*lineptr == NULL || *n == 0) {
        *n = 256;
        *lineptr = (char *)malloc(*n);
        if (!*lineptr) {
            errno = ENOMEM;
            return -1;
        }
    }
    
    size_t len = 0;
    int c;
    
    while ((c = fgetc(stream)) != EOF) {
        // 需要扩展缓冲区
        if (len + 2 >= *n) {
            *n = (*n) * 2;
            char *new_buf = (char *)realloc(*lineptr, *n);
            if (!new_buf) {
                errno = ENOMEM;
                return -1;
            }
            *lineptr = new_buf;
        }
        
        (*lineptr)[len++] = (char)c;
        
        if (c == '\n') {
            break;
        }
    }
    
    // EOF 且没有读到数据
    if (len == 0 && c == EOF) {
        return -1;
    }
    
    (*lineptr)[len] = '\0';
    return (ssize_t)len;
}
#define getline portable_getline
#endif

// Readline 支持（可选）
#ifdef HAVE_READLINE
#include <readline/readline.h>
#include <readline/history.h>
#endif

// 外部模块初始化函数声明
JSModuleDef *js_init_module_ndtsdb(JSContext *ctx, const char *module_name);

// 执行 JS 脚本文件
static int run_script(JSContext *ctx, const char *filename) {
    size_t len;
    char *script = read_file(filename, &len);
    if (!script) {
        fprintf(stderr, "Failed to read file: %s\n", filename);
        return 1;
    }
    
    bool is_module = (strstr(script, "import ") != NULL || strstr(script, "import\t") != NULL);
    int eval_flags = is_module ? JS_EVAL_TYPE_MODULE : JS_EVAL_TYPE_GLOBAL;

    JSValue result = JS_Eval(ctx, script, len, filename, eval_flags);
    free(script);
    
    if (JS_IsException(result)) {
        print_exception(ctx);
        JS_FreeValue(ctx, result);
        return 1;
    }
    JS_FreeValue(ctx, result);
    
    if (is_module) {
        JSContext *ctx2;
        JSRuntime *rt = JS_GetRuntime(ctx);
        int r;
        while ((r = JS_ExecutePendingJob(rt, &ctx2)) > 0) {}
        if (r < 0) {
            print_exception(ctx);
            return 1;
        }
    }
    
    return 0;
}

// 执行单条 JS 表达式（REPL 用）
static int eval_line(JSContext *ctx, const char *line) {
    JSValue result = JS_Eval(ctx, line, strlen(line), "<repl>", JS_EVAL_TYPE_GLOBAL);
    
    if (JS_IsException(result)) {
        print_exception(ctx);
        JS_FreeValue(ctx, result);
        return -1;
    }
    
    if (!JS_IsUndefined(result)) {
        const char *str = JS_ToCString(ctx, result);
        if (str) {
            printf("%s\n", str);
            JS_FreeCString(ctx, str);
        }
    }
    
    JS_FreeValue(ctx, result);
    return 0;
}

// REPL 主循环
static void repl(JSContext *ctx) {
    printf("ndtsdb-cli REPL (QuickJS)\n");
    printf("Type .exit or press Ctrl+D to exit\n\n");
    
#ifdef HAVE_READLINE
    char *line;
    while ((line = readline("> ")) != NULL) {
        if (strlen(line) == 0) {
            free(line);
            continue;
        }
        add_history(line);
        if (strcmp(line, ".exit") == 0 || strcmp(line, ".quit") == 0) {
            free(line);
            break;
        }
        if (strcmp(line, ".help") == 0) {
            printf("Commands:\n  .exit  - Exit REPL\n  .help  - Show this help\n\n");
            free(line);
            continue;
        }
        eval_line(ctx, line);
        free(line);
    }
#else
    char line[4096];
    while (true) {
        printf("> ");
        fflush(stdout);
        if (!fgets(line, sizeof(line), stdin)) {
            printf("\n");
            break;
        }
        size_t len = strlen(line);
        if (len > 0 && line[len - 1] == '\n') line[len - 1] = '\0';
        if (strlen(line) == 0) continue;
        if (strcmp(line, ".exit") == 0 || strcmp(line, ".quit") == 0) break;
        if (strcmp(line, ".help") == 0) {
            printf("Commands:\n  .exit  - Exit REPL\n  .help  - Show this help\n\n");
            continue;
        }
        eval_line(ctx, line);
    }
#endif
}

// ==================== C 层 stdlib 函数 ====================
static JSValue js_readFile(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 1) return JS_ThrowTypeError(ctx, "readFile requires path argument");
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_ThrowTypeError(ctx, "path must be a string");
    size_t len;
    char *content = read_file(path, &len);
    JS_FreeCString(ctx, path);
    if (!content) return JS_ThrowInternalError(ctx, "failed to read file");
    JSValue result = JS_NewStringLen(ctx, content, len);
    free(content);
    return result;
}

static JSValue js_writeFile(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 2) return JS_ThrowTypeError(ctx, "writeFile requires path and data arguments");
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_ThrowTypeError(ctx, "path must be a string");
    size_t len;
    const char *data = JS_ToCStringLen(ctx, &len, argv[1]);
    if (!data) { JS_FreeCString(ctx, path); return JS_ThrowTypeError(ctx, "data must be a string"); }
    FILE *f = fopen(path, "wb");
    if (!f) { JS_FreeCString(ctx, path); JS_FreeCString(ctx, data); return JS_ThrowInternalError(ctx, "failed to open file for writing"); }
    size_t written = fwrite(data, 1, len, f);
    fclose(f);
    JS_FreeCString(ctx, path);
    JS_FreeCString(ctx, data);
    if (written != len) return JS_ThrowInternalError(ctx, "failed to write all data");
    return JS_UNDEFINED;
}

static JSValue js_fileExists(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 1) return JS_ThrowTypeError(ctx, "fileExists requires path argument");
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_ThrowTypeError(ctx, "path must be a string");
    struct stat st;
    int exists = (stat(path, &st) == 0);
    JS_FreeCString(ctx, path);
    return JS_NewBool(ctx, exists);
}

static JSValue js_removeFile(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 1) return JS_ThrowTypeError(ctx, "removeFile requires path argument");
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_ThrowTypeError(ctx, "path must be a string");
    int result = remove(path);
    JS_FreeCString(ctx, path);
    if (result != 0) return JS_ThrowInternalError(ctx, "failed to remove file");
    return JS_UNDEFINED;
}

static JSValue js_getTimeMs(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    int64_t ms = (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
    return JS_NewInt64(ctx, ms);
}

static JSValue js_readStdinLine(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    static char *line_buffer = NULL;
    static size_t buffer_size = 0;
    ssize_t len = getline(&line_buffer, &buffer_size, stdin);
    if (len == -1) {
        free(line_buffer);
        line_buffer = NULL;
        buffer_size = 0;
        return JS_NULL;
    }
    if (len > 0 && line_buffer[len - 1] == '\n') line_buffer[len - 1] = '\0';
    if (len > 1 && line_buffer[len - 2] == '\r') line_buffer[len - 2] = '\0';
    JSValue result = JS_NewString(ctx, line_buffer);
    return result;
}

static JSValue js_console_log(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    for (int i = 0; i < argc; i++) {
        if (i > 0) fputs(" ", stdout);
        const char *str = JS_ToCString(ctx, argv[i]);
        if (str) { fputs(str, stdout); JS_FreeCString(ctx, str); }
    }
    fputs("\n", stdout);
    fflush(stdout);
    return JS_UNDEFINED;
}

static JSValue js_console_error(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    for (int i = 0; i < argc; i++) {
        if (i > 0) fputs(" ", stderr);
        const char *str = JS_ToCString(ctx, argv[i]);
        if (str) { fputs(str, stderr); JS_FreeCString(ctx, str); }
    }
    fputs("\n", stderr);
    fflush(stderr);
    return JS_UNDEFINED;
}

static void register_stdlib(JSContext *ctx) {
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "__readFile", JS_NewCFunction(ctx, js_readFile, "__readFile", 2));
    JS_SetPropertyStr(ctx, global, "__writeFile", JS_NewCFunction(ctx, js_writeFile, "__writeFile", 3));
    JS_SetPropertyStr(ctx, global, "__fileExists", JS_NewCFunction(ctx, js_fileExists, "__fileExists", 1));
    JS_SetPropertyStr(ctx, global, "__removeFile", JS_NewCFunction(ctx, js_removeFile, "__removeFile", 1));
    JS_SetPropertyStr(ctx, global, "__getTimeMs", JS_NewCFunction(ctx, js_getTimeMs, "__getTimeMs", 0));
    JS_SetPropertyStr(ctx, global, "__readStdinLine", JS_NewCFunction(ctx, js_readStdinLine, "__readStdinLine", 0));
    JS_SetPropertyStr(ctx, global, "__print", JS_NewCFunction(ctx, js_console_log, "__print", 1));
    JS_SetPropertyStr(ctx, global, "__printerr", JS_NewCFunction(ctx, js_console_error, "__printerr", 1));
    JS_FreeValue(ctx, global);

    const char *console_js = "globalThis.console = {log: function() { __print.apply(null, Array.from(arguments)); },warn: function() { __print.apply(null, Array.from(arguments)); },error: function() { __printerr.apply(null, Array.from(arguments)); },info: function() { __print.apply(null, Array.from(arguments)); }};";
    JSValue r = JS_Eval(ctx, console_js, strlen(console_js), "<stdlib>", JS_EVAL_TYPE_GLOBAL);
    JS_FreeValue(ctx, r);
}

// 全局 QuickJS 运行时和上下文（供子命令模块使用）
JSContext *ctx = NULL;
JSRuntime *rt = NULL;
int exit_code = 0;

int main(int argc, char **argv) {
    rt = JS_NewRuntime();
    if (!rt) { fprintf(stderr, "Failed to create QuickJS runtime\n"); return 1; }
    JS_SetMemoryLimit(rt, 128 * 1024 * 1024);
    
    ctx = JS_NewContext(rt);
    if (!ctx) { fprintf(stderr, "Failed to create QuickJS context\n"); JS_FreeRuntime(rt); return 1; }
    
    js_init_module_ndtsdb(ctx, "ndtsdb");
    register_stdlib(ctx);
    
    // 注入 process.env
    {
        extern char **environ;
        JSValue global = JS_GetGlobalObject(ctx);
        JSValue proc = JS_NewObject(ctx);
        JSValue env_obj = JS_NewObject(ctx);
        for (int i = 0; environ && environ[i]; i++) {
            const char *kv = environ[i];
            const char *eq = strchr(kv, '=');
            if (!eq) continue;
            char key[256];
            size_t klen = eq - kv;
            if (klen >= sizeof(key)) continue;
            memcpy(key, kv, klen);
            key[klen] = '\0';
            JS_SetPropertyStr(ctx, env_obj, key, JS_NewString(ctx, eq + 1));
        }
        JS_SetPropertyStr(ctx, proc, "env", env_obj);
        JS_SetPropertyStr(ctx, global, "process", proc);
        JS_FreeValue(ctx, global);
    }

    int exit_code = 0;
    
    if (argc > 1 && (strcmp(argv[1], "--version") == 0 || strcmp(argv[1], "-v") == 0 || strcmp(argv[1], "version") == 0)) {
        printf("ndtsdb-cli v1.0.0-beta\n");
        printf("  SQL: SELECT/WHERE/GROUP BY/ORDER BY/HAVING/DISTINCT/LIMIT/OFFSET\n");
        printf("  Aggregates: COUNT SUM AVG MIN MAX FIRST LAST STDDEV VARIANCE PERCENTILE CORR\n");
        printf("  Window: LAG LEAD | Time: strftime()\n");
        printf("  Indicators: SMA EMA ATR Bollinger RSI MACD\n");
        printf("  Built with: QuickJS 2024-01-13 + libndtsdb\n");
        fflush(stdout);
        _exit(0);
    }
    if (argc > 1 && (strcmp(argv[1], "--help") == 0 || strcmp(argv[1], "-h") == 0)) {
        printf("Usage: ndtsdb-cli <command> [options]\n\n");
        printf("ndtsdb-cli v1.0.0-beta — Time Series Database CLI\n\n");
        printf("Data I/O:\n");
        printf("  write-json  --database <path>          Write JSON Lines from stdin\n");
        printf("  write-csv   --database <path>          Write CSV from stdin\n");
        printf("  export      --database --output [--format json|csv] [--symbol] [--interval]\n");
        printf("  merge       --from <src> --to <dst>    Merge two databases\n");
        printf("  resample    --database --symbol --from <intv> --to <intv> [--output]\n");
        printf("\nQuery:\n");
        printf("  query       --database --symbol --interval [--since] [--until]\n");
        printf("  sql         --database --query \"SELECT ...\" [--format json|csv]\n");
        printf("  tail        --database --symbol --interval [--n N]\n");
        printf("  head        --database --symbol --interval [--n N]\n");
        printf("  count       --database [--symbol] [--interval]\n");
        printf("  info        --database [--symbol]\n");
        printf("\nIndicators (fast C path):\n");
        printf("  sma/ema/atr/vwap/obv/rsi/macd --database --symbol --interval [--period/fast/slow/signal] [--format csv]\n");
        printf("\nKnowledge Engine:\n");
        printf("  embed       --text <text> --dim <n>    Generate embedding vector (pure C, TF-IDF hash)\n");
        printf("  search      --database --query-vector '[...]' [--top-k N] [--threshold F]\n");
        printf("  facts       write/import/list/search   Knowledge base management\n");
        printf("    write     --database --text <t> --agent-id <id> [--type T] [--validity V] [--scope S] [--key K]\n");
        printf("    search    --database --query <text> [--top-k N] [--threshold F] [--agent-id ID] [--json]\n");
        printf("\nScripting:\n");
        printf("  script      <file.js> --database <path> [--repeat N]\n");
        printf("  repl        --database <path>\n");
        printf("\nSQL Aggregates: COUNT SUM AVG MIN MAX FIRST LAST STDDEV VARIANCE PERCENTILE CORR\n");
        printf("SQL Window: LAG LEAD | SQL Time: strftime(timestamp,'%%Y-%%m-%%d')\n");
        printf("\nRun 'ndtsdb-cli <command> --help' for command-specific help.\n");
        fflush(stdout);
        _exit(0);
    }

    // ==================== embed 子命令 ====================
    if (argc > 1 && strcmp(argv[1], "embed") == 0) {
        return cmd_embed(argc, argv);
    }

    // ==================== serve 子命令（已禁用）====================
    if (argc > 1 && strcmp(argv[1], "serve") == 0) {
        fprintf(stderr, "Error: 'serve' subcommand is disabled. ndtsdb-cli is a pure CLI tool.\n");
        fprintf(stderr, "Use 'facts write/search' for knowledge base operations.\n");
        return 1;
    }

    // ==================== query 子命令 (纯C优化版) ====================
    if (argc > 1 && strcmp(argv[1], "query") == 0) {
        return cmd_query(argc, argv);
    }

    // ==================== list 子命令 ====================
    if (argc > 1 && strcmp(argv[1], "list") == 0) {
        return cmd_list(argc, argv);
    }

    // ==================== write-csv 子命令 ====================
    if (argc > 1 && strcmp(argv[1], "write-csv") == 0) {
        return cmd_write_csv(argc, argv);
    }

    // ==================== write-json 子命令 ====================
    if (argc > 1 && strcmp(argv[1], "write-json") == 0) {
        return cmd_write_json(argc, argv);
    }

    // ==================== write-vector 子命令 ====================
    if (argc > 1 && strcmp(argv[1], "write-vector") == 0) {
        return cmd_write_vector(argc, argv);
    }

    // ==================== partitioned 子命令 ====================
    if (argc > 1 && strcmp(argv[1], "partitioned") == 0) {
        if (argc >= 3 && (strcmp(argv[2], "--help") == 0 || strcmp(argv[2], "-h") == 0)) {
            printf("Usage: ndtsdb-cli partitioned <list|query|write-json> --database <dir> [options]\n");
            printf("  Manage partitioned data storage\n");
            printf("  list       List all partitions\n");
            printf("  query      Query data from partitions\n");
            printf("  write-json Write JSON data to partitions\n");
            printf("  --database, -d  Database directory (required)\n");
            printf("  --symbol, -s    Filter by symbol\n");
            printf("  --interval, -i  Filter by interval\n");
            JS_FreeContext(ctx); JS_FreeRuntime(rt); return 0;
        }
        if (argc < 3) {
            fprintf(stderr, "Usage: ndtsdb-cli partitioned <list|query|write-json> --database <dir> [options]\n");
            JS_FreeContext(ctx);
            JS_FreeRuntime(rt);
            return 1;
        }
        
        const char *subcmd = argv[2];
        const char *database = NULL;
        const char *symbol = NULL;
        const char *interval = NULL;
        for (int i = 3; i < argc; i++) {
            if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
                if (i + 1 < argc) database = argv[++i];
            } else if (strcmp(argv[i], "--symbol") == 0 || strcmp(argv[i], "-s") == 0) {
                if (i + 1 < argc) symbol = argv[++i];
            } else if (strcmp(argv[i], "--interval") == 0 || strcmp(argv[i], "-i") == 0) {
                if (i + 1 < argc) interval = argv[++i];
            }
        }
        
        if (!database) {
            fprintf(stderr, "Error: --database is required\n");
            JS_FreeContext(ctx);
            JS_FreeRuntime(rt);
            return 1;
        }
        
        // ========== partitioned list ==========
        if (strcmp(subcmd, "list") == 0) {
            // 获取读锁
            int lock_fd = ndtsdb_lock_acquire(database, false);
            if (lock_fd < 0) {
                fprintf(stderr, "Error: Failed to acquire read lock on database: %s\n", database);
                JS_FreeContext(ctx);
                JS_FreeRuntime(rt);
                return 1;
            }

            // 打开数据库（快照模式，自动格式检测）
            NDTSDB *db = ndtsdb_open_any(database);
            if (!db) {
                fprintf(stderr, "Error: Failed to open database: %s\n", database);
                ndtsdb_lock_release(lock_fd);
                JS_FreeContext(ctx);
                JS_FreeRuntime(rt);
                return 1;
            }
            
            // 获取所有symbol/interval组合
            char symbols[100][32];
            char intervals[100][16];
            int count = ndtsdb_list_symbols(db, symbols, intervals, 100);
            
            for (int i = 0; i < count; i++) {
                printf("{\"symbol\":\"%s\",\"interval\":\"%s\"}\n", symbols[i], intervals[i]);
            }
            
            ndtsdb_close(db);
            ndtsdb_lock_release(lock_fd);
            
            JS_FreeContext(ctx);
            JS_FreeRuntime(rt);
            return 0;
        }
        
        // ========== partitioned query ==========
        if (strcmp(subcmd, "query") == 0) {
            if (!symbol || !interval) {
                fprintf(stderr, "Error: --symbol and --interval are required for query\n");
                JS_FreeContext(ctx);
                JS_FreeRuntime(rt);
                return 1;
            }
            
            // 获取读锁
            int lock_fd = ndtsdb_lock_acquire(database, false);
            if (lock_fd < 0) {
                fprintf(stderr, "Error: Failed to acquire read lock on database: %s\n", database);
                JS_FreeContext(ctx);
                JS_FreeRuntime(rt);
                return 1;
            }

            // 打开数据库（快照模式，自动格式检测）
            NDTSDB *db = ndtsdb_open_any(database);
            if (!db) {
                fprintf(stderr, "Error: Failed to open database: %s\n", database);
                ndtsdb_lock_release(lock_fd);
                JS_FreeContext(ctx);
                JS_FreeRuntime(rt);
                return 1;
            }

            // 执行查询
            Query q = {
                .symbol = symbol,
                .interval = interval,
                .startTime = 0,
                .endTime = INT64_MAX,
                .limit = 0
            };
            QueryResult *result = ndtsdb_query(db, &q);
            
            // 收集被删除的timestamp（tombstone）
            int64_t deleted_ts[1000];
            int deleted_count = 0;
            if (result) {
                for (uint32_t i = 0; i < result->count && deleted_count < 1000; i++) {
                    if (result->rows[i].volume < 0) {
                        deleted_ts[deleted_count++] = result->rows[i].timestamp;
                    }
                }
            }
            
            if (result && result->count > 0) {
                for (uint32_t i = 0; i < result->count; i++) {
                    // 跳过tombstone（软删除的行）
                    if (result->rows[i].volume < 0) continue;
                    // 跳过被删除timestamp的行
                    int is_deleted = 0;
                    for (int j = 0; j < deleted_count; j++) {
                        if (result->rows[i].timestamp == deleted_ts[j]) { is_deleted = 1; break; }
                    }
                    if (is_deleted) continue;
                    printf("{\"symbol\":\"%s\",\"interval\":\"%s\",\"timestamp\":%ld,"
                           "\"open\":%.8f,\"high\":%.8f,\"low\":%.8f,\"close\":%.8f,\"volume\":%.8f}\n",
                           symbol, interval,
                           result->rows[i].timestamp,
                           result->rows[i].open, result->rows[i].high,
                           result->rows[i].low, result->rows[i].close,
                           result->rows[i].volume);
                }
            }
            
            ndtsdb_free_result(result);
            ndtsdb_close(db);
            ndtsdb_lock_release(lock_fd);
            
            JS_FreeContext(ctx);
            JS_FreeRuntime(rt);
            return 0;
        }
        
        // ========== partitioned write-json ==========
        if (strcmp(subcmd, "write-json") == 0) {
            // 获取独占写锁
            int lock_fd = ndtsdb_lock_acquire(database, true);
            if (lock_fd < 0) {
                fprintf(stderr, "Error: Failed to acquire write lock on database: %s\n", database);
                JS_FreeContext(ctx);
                JS_FreeRuntime(rt);
                return 1;
            }
            
            // 打开数据库（目录模式）
            NDTSDB *db = ndtsdb_open(database);
            if (!db) {
                fprintf(stderr, "Error: Failed to open database: %s\n", database);
                ndtsdb_lock_release(lock_fd);
                JS_FreeContext(ctx);
                JS_FreeRuntime(rt);
                return 1;
            }
            
            // 批量插入配置（复用write-json逻辑）
            #define BATCH_SIZE 5000
            KlineRow *batch = malloc(BATCH_SIZE * sizeof(KlineRow)); if (!batch) { fprintf(stderr, "OOM\n"); return 1; }
            char batch_symbol[64] = {0};
            char batch_interval[16] = {0};
            int batch_count = 0;
            int count = 0;
            int errors = 0;
            
            char line[4096];
            
            while (fgets(line, sizeof(line), stdin)) {
                // 去掉末尾换行
                size_t len = strlen(line);
                while (len > 0 && (line[len-1] == '\n' || line[len-1] == '\r')) {
                    line[--len] = '\0';
                }
                
                // 跳过空行
                if (len == 0) continue;
                
                char symbol[64] = {0};
                char interval[16] = {0};
                int64_t timestamp = 0;
                double open = 0, high = 0, low = 0, close = 0, volume = 0;
                
                // 单次扫描解析（极速版）
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
                
                // 验证必要字段
                if (symbol[0] == '\0' || interval[0] == '\0' || timestamp == 0) {
                    errors++;
                    continue;
                }
                
                // 如果 symbol 或 interval 变化，先写入当前批次
                if (batch_count > 0 && (strcmp(batch_symbol, symbol) != 0 || strcmp(batch_interval, interval) != 0)) {
                    int inserted = ndtsdb_insert_batch(db, batch_symbol, batch_interval, batch, batch_count);
                    if (inserted > 0) count += inserted;
                    else errors += batch_count;
                    batch_count = 0;
                }
                
                // 填充 batch
                batch[batch_count].timestamp = timestamp;
                batch[batch_count].open = open;
                batch[batch_count].high = high;
                batch[batch_count].low = low;
                batch[batch_count].close = close;
                batch[batch_count].volume = volume;
                batch[batch_count].flags = 0;
                
                // 保存 symbol/interval
                if (batch_count == 0) {
                    strncpy(batch_symbol, symbol, 63);
                    strncpy(batch_interval, interval, 15);
                }
                batch_count++;
                
                // 批量写入
                if (batch_count >= BATCH_SIZE) {
                    int inserted = ndtsdb_insert_batch(db, batch_symbol, batch_interval, batch, batch_count);
                    if (inserted > 0) count += inserted;
                    else errors += batch_count;
                    batch_count = 0;
                }
            }
            
            // 写入剩余数据
            if (batch_count > 0 && batch_symbol[0] != '\0') {
                int inserted = ndtsdb_insert_batch(db, batch_symbol, batch_interval, batch, batch_count);
                if (inserted > 0) count += inserted;
                else errors += batch_count;
            }
            
            printf("Inserted %d rows, %d errors\n", count, errors);
            
            ndtsdb_close(db);
            ndtsdb_lock_release(lock_fd);
            free(batch);
            
            JS_FreeContext(ctx);
            JS_FreeRuntime(rt);
            return errors > 0 ? 1 : 0;
        }
        
        fprintf(stderr, "Error: Unknown partitioned subcommand: %s\n", subcmd);
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
        return 1;
    }

    // ==================== delete 子命令 (tombstone软删除) ====================
    if (argc > 1 && strcmp(argv[1], "delete") == 0) {
        return cmd_delete(argc, argv);
    }

    // ==================== wal-replay 子命令 ====================
    if (argc > 1 && strcmp(argv[1], "wal-replay") == 0) {
        const char *database = NULL;
        for (int i = 2; i < argc; i++) {
            if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
                if (i + 1 < argc) database = argv[++i];
            }
        }
        if (!database) {
            fprintf(stderr, "Usage: ndtsdb-cli wal-replay --database <path>\n");
            JS_FreeContext(ctx);
            JS_FreeRuntime(rt);
            return 1;
        }
        
        // 获取独占写锁
        int lock_fd = ndtsdb_lock_acquire(database, true);
        if (lock_fd < 0) {
            fprintf(stderr, "Error: Failed to acquire write lock\n");
            JS_FreeContext(ctx);
            JS_FreeRuntime(rt);
            return 1;
        }
        
        NDTSDB *db = ndtsdb_open(database);
        if (!db) {
            fprintf(stderr, "Error: Failed to open database\n");
            ndtsdb_lock_release(lock_fd);
            JS_FreeContext(ctx);
            JS_FreeRuntime(rt);
            return 1;
        }
        
        // 检查 WAL 文件是否存在
        char *wal_path = ndtsdb_wal_path(database);
        if (!wal_path) {
            fprintf(stderr, "Error: OOM\n");
            ndtsdb_close(db);
            ndtsdb_lock_release(lock_fd);
            JS_FreeContext(ctx);
            JS_FreeRuntime(rt);
            return 1;
        }
        
        if (access(wal_path, F_OK) != 0) {
            printf("No WAL file found at %s\n", wal_path);
            free(wal_path);
            ndtsdb_close(db);
            ndtsdb_lock_release(lock_fd);
            JS_FreeContext(ctx);
            JS_FreeRuntime(rt);
            return 0;
        }
        
        // 打开 WAL 文件并逐条重放
        int fd = open(wal_path, O_RDWR);
        if (fd < 0) {
            fprintf(stderr, "Error: Failed to open WAL file\n");
            free(wal_path);
            ndtsdb_close(db);
            ndtsdb_lock_release(lock_fd);
            JS_FreeContext(ctx);
            JS_FreeRuntime(rt);
            return 1;
        }
        
        int record_count = 0;
        int total_rows = 0;
        
        while (1) {
            // 记录当前位置（用于标记 committed）
            off_t record_offset = lseek(fd, 0, SEEK_CUR);
            
            WALRecordHeader header;
            ssize_t n = read(fd, &header, sizeof(header));
            if (n == 0) break;
            if (n != sizeof(header)) {
                fprintf(stderr, "Warning: Incomplete WAL record header\n");
                break;
            }
            
            if (header.magic != WAL_MAGIC) {
                fprintf(stderr, "Warning: Invalid WAL magic number\n");
                break;
            }
            
            size_t data_size = header.row_count * sizeof(KlineRow);
            KlineRow *rows = malloc(data_size);
            if (!rows) {
                fprintf(stderr, "Error: OOM\n");
                break;
            }
            
            n = read(fd, rows, data_size);
            if ((size_t)n != data_size) {
                fprintf(stderr, "Warning: Incomplete WAL data\n");
                free(rows);
                break;
            }
            
            // 只重放未提交的条目
            if (header.committed == 0x00) {
                // 插入到数据库
                int inserted = ndtsdb_insert_batch(db, header.symbol, header.interval, rows, header.row_count);
                if (inserted > 0) {
                    record_count++;
                    total_rows += inserted;
                    // 标记为已提交
                    uint8_t committed = 0x01;
                    off_t commit_offset = record_offset + offsetof(WALRecordHeader, committed);
                    pwrite(fd, &committed, 1, commit_offset);
                }
            }
            free(rows);
        }
        
        close(fd);
        free(wal_path);
        ndtsdb_close(db);
        ndtsdb_lock_release(lock_fd);
        
        printf("Replayed %d records, %d rows\n", record_count, total_rows);
        
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
        return 0;
    }

    // ==================== sma 子命令 ====================
    if (argc > 1 && strcmp(argv[1], "sma") == 0) {
        return cmd_sma(argc, argv);
    }

    // ==================== vwap 子命令 ====================
    if (argc > 1 && strcmp(argv[1], "vwap") == 0) {
        return cmd_vwap(argc, argv);
    }

    // ==================== ema 子命令 ====================
    if (argc > 1 && strcmp(argv[1], "ema") == 0) {
        return cmd_ema(argc, argv);
    }

    // ==================== atr 子命令 (ATR指标) ====================
    if (argc > 1 && strcmp(argv[1], "atr") == 0) {
        return cmd_atr(argc, argv);
    }

    // ==================== obv 子命令 ====================
    if (argc > 1 && strcmp(argv[1], "obv") == 0) {
        return cmd_obv(argc, argv);
    }

    // ==================== rsi 子命令 ====================
    if (argc > 1 && strcmp(argv[1], "rsi") == 0) {
        return cmd_rsi(argc, argv);
    }

    // ==================== macd 子命令 ====================
    if (argc > 1 && strcmp(argv[1], "macd") == 0) {
        return cmd_macd(argc, argv);
    }

    // ==================== bollinger 子命令 ====================
    if (argc > 1 && strcmp(argv[1], "bollinger") == 0) {
        return cmd_bollinger(argc, argv);
    }

    // ==================== tail 子命令 ====================
    if (argc > 1 && strcmp(argv[1], "tail") == 0) {
        return cmd_tail(argc, argv);
    }

    // ==================== head 子命令 ====================
    if (argc > 1 && strcmp(argv[1], "head") == 0) {
        const char *database = NULL;
        const char *symbol = NULL;
        const char *interval = NULL;
        int n = 10;
        const char *format = "json";
        bool help_flag = false;

        for (int i = 2; i < argc; i++) {
            if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
                help_flag = true;
            } else if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
                if (i + 1 < argc) database = argv[++i];
            } else if (strcmp(argv[i], "--symbol") == 0 || strcmp(argv[i], "-s") == 0) {
                if (i + 1 < argc) symbol = argv[++i];
            } else if (strcmp(argv[i], "--interval") == 0 || strcmp(argv[i], "-i") == 0) {
                if (i + 1 < argc) interval = argv[++i];
            } else if (strcmp(argv[i], "--n") == 0 || strcmp(argv[i], "-n") == 0) {
                if (i + 1 < argc) n = atoi(argv[++i]);
            } else if (strcmp(argv[i], "--format") == 0 || strcmp(argv[i], "-f") == 0) {
                if (i + 1 < argc) format = argv[++i];
            }
        }

        if (help_flag) {
            printf("Usage: ndtsdb-cli head --database <path> --symbol <sym> --interval <intv> [--n <count>] [--format <json|csv>]\n\n");
            printf("Show first N rows of a series.\n\n");
            printf("Options:\n");
            printf("  --database, -d   Database directory path (required)\n");
            printf("  --symbol, -s     Symbol to query (required)\n");
            printf("  --interval, -i   Interval (e.g., 1m, 5m, 1h) (required)\n");
            printf("  --n              Number of rows to show (default: 10)\n");
            printf("  --format, -f     Output format: json or csv (default: json)\n");
            printf("\nExample:\n");
            printf("  ndtsdb-cli head -d ./db -s BTC -i 1m --n 20\n");
            JS_FreeContext(ctx); JS_FreeRuntime(rt); return 0;
        }

        if (!database || !symbol || !interval) {
            fprintf(stderr, "Error: --database, --symbol, --interval are required\n");
            fprintf(stderr, "Usage: %s head --database <path> --symbol <sym> --interval <intv> [--n <count>] [--format csv|json]\n", argv[0]);
            JS_FreeContext(ctx);
            JS_FreeRuntime(rt);
            return 1;
        }

        NDTSDB *db = ndtsdb_open_any(database);
        if (!db) {
            fprintf(stderr, "Error: Failed to open database: %s\n", database);
            JS_FreeContext(ctx);
            JS_FreeRuntime(rt);
            return 1;
        }

        QueryResult *result = ndtsdb_query_all(db);
        if (!result) {
            fprintf(stderr, "Error: Query failed\n");
            ndtsdb_close(db);
            JS_FreeContext(ctx);
            JS_FreeRuntime(rt);
            return 1;
        }

        typedef struct { KlineRow row; char symbol[32]; char interval[16]; } ResultRow;
        ResultRow* rows = (ResultRow*)result->rows;

        // 收集tombstone（软删除标记）
        int64_t deleted_ts[1000];
        int deleted_count = 0;
        for (int i = 0; i < (int)result->count && deleted_count < 1000; i++) {
            if (rows[i].row.volume < 0) {
                deleted_ts[deleted_count++] = rows[i].row.timestamp;
            }
        }

        // 统计匹配symbol/interval且未删除的有效行数
        int valid_count = 0;
        for (int i = 0; i < (int)result->count; i++) {
            ResultRow *rr = &rows[i];
            if (rr->row.volume < 0) continue;
            if (strcmp(rr->symbol, symbol) != 0 || strcmp(rr->interval, interval) != 0) continue;
            int is_deleted = 0;
            for (int j = 0; j < deleted_count; j++) {
                if (rr->row.timestamp == deleted_ts[j]) { is_deleted = 1; break; }
            }
            if (!is_deleted) valid_count++;
        }

        // head: 取前 N 行（与 tail 不同）
        int end_idx = (valid_count < n) ? valid_count : n;
        int matched = 0;

        if (strcmp(format, "csv") == 0) {
            printf("timestamp,symbol,interval,open,high,low,close,volume\n");
            for (int i = 0; i < (int)result->count && matched < end_idx; i++) {
                ResultRow *rr = &rows[i];
                if (rr->row.volume < 0) continue;
                if (strcmp(rr->symbol, symbol) != 0 || strcmp(rr->interval, interval) != 0) continue;
                int is_deleted = 0;
                for (int j = 0; j < deleted_count; j++) {
                    if (rr->row.timestamp == deleted_ts[j]) { is_deleted = 1; break; }
                }
                if (is_deleted) continue;
                printf("%lld,%s,%s,%.2f,%.2f,%.2f,%.2f,%.4f\n",
                    (long long)rr->row.timestamp, rr->symbol, rr->interval,
                    rr->row.open, rr->row.high, rr->row.low, rr->row.close, rr->row.volume);
                matched++;
            }
        } else {
            // JSON 格式
            for (int i = 0; i < (int)result->count && matched < end_idx; i++) {
                ResultRow *rr = &rows[i];
                if (rr->row.volume < 0) continue;
                if (strcmp(rr->symbol, symbol) != 0 || strcmp(rr->interval, interval) != 0) continue;
                int is_deleted = 0;
                for (int j = 0; j < deleted_count; j++) {
                    if (rr->row.timestamp == deleted_ts[j]) { is_deleted = 1; break; }
                }
                if (is_deleted) continue;
                printf("{\"symbol\":\"%s\",\"interval\":\"%s\",\"timestamp\":%lld,\"open\":%.2f,\"high\":%.2f,\"low\":%.2f,\"close\":%.2f,\"volume\":%.4f}\n",
                    rr->symbol, rr->interval, (long long)rr->row.timestamp,
                    rr->row.open, rr->row.high, rr->row.low, rr->row.close, rr->row.volume);
                matched++;
            }
        }

        ndtsdb_free_result(result);
        ndtsdb_close(db);
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
        return 0;
    }

    // ==================== script 子命令 ====================
    // 用法:
    //   ndtsdb-cli script <file.js> [--database <path>] [--plugin <plugin.so>]
    //   ndtsdb-cli script --file <file.js> [--database <path>]
    // JS 全局变量:
    //   ndtsdb       — ndtsdb 模块（open/queryAll/queryFiltered/insert/close 等）
    //   __database   — --database 参数值（可为 null）
    //   __args       — 剩余未解析参数数组
    if (argc > 1 && strcmp(argv[1], "script") == 0) {
        const char *database = NULL;
        const char *script_file = NULL;
        const char *plugin_file = NULL;
        int extra_argc = 0;
        const char *extra_args[64];
        int repeat_secs = 0;  // --repeat N: run script every N seconds
        int watch_mode = 0;   // --watch: watch DB changes
        int watch_interval_ms = 2000;  // --interval N: watch check interval in ms
        int help_flag = 0;

        for (int i = 2; i < argc; i++) {
            if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) { help_flag = 1; }
            else if ((strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) && i + 1 < argc) {
                database = argv[++i];
            } else if ((strcmp(argv[i], "--file") == 0 || strcmp(argv[i], "-f") == 0) && i + 1 < argc) {
                script_file = argv[++i];
            } else if ((strcmp(argv[i], "--plugin") == 0 || strcmp(argv[i], "-p") == 0) && i + 1 < argc) {
                plugin_file = argv[++i];
            } else if ((strcmp(argv[i], "--repeat") == 0 || strcmp(argv[i], "-r") == 0) && i + 1 < argc) {
                repeat_secs = atoi(argv[++i]);
            } else if (strcmp(argv[i], "--watch") == 0) {
                watch_mode = 1;
            } else if ((strcmp(argv[i], "--interval") == 0) && i + 1 < argc) {
                watch_interval_ms = atoi(argv[++i]);
            } else if (script_file == NULL && argv[i][0] != '-') {
                // 第一个非 flag 参数作为脚本文件
                script_file = argv[i];
            } else {
                if (extra_argc < 64) extra_args[extra_argc++] = argv[i];
            }
        }

        if (help_flag) {
            printf("Usage: ndtsdb-cli script <file.js> [--database <path>] [--repeat <secs>] [--watch] [--interval <ms>] [--plugin <plugin.so>]\n");
            printf("  Execute JavaScript with ndtsdb module\n");
            printf("  --database, -d  Database path (sets __database global)\n");
            printf("  --plugin, -p    Load native plugin (.so file)\n");
            printf("  --repeat, -r    Run script every N seconds\n");
            printf("  --watch         Watch DB directory mtime changes and re-run\n");
            printf("  --interval      Watch check interval in ms (default: 2000)\n");
            printf("  JS globals: ndtsdb, __database, __args\n");
            JS_FreeContext(ctx); JS_FreeRuntime(rt); return 0;
        }

        if (!script_file) {
            fprintf(stderr, "Usage: ndtsdb-cli script <file.js> [--database <path>]\n");
            fprintf(stderr, "  JS globals: ndtsdb, __database, __args\n");
            JS_FreeContext(ctx);
            JS_FreeRuntime(rt);
            return 1;
        }

        // 读取脚本文件
        FILE *fp = fopen(script_file, "rb");
        if (!fp) {
            fprintf(stderr, "Error: Cannot open script file: %s\n", script_file);
            JS_FreeContext(ctx);
            JS_FreeRuntime(rt);
            return 1;
        }
        fseek(fp, 0, SEEK_END);
        long file_size = ftell(fp);
        fseek(fp, 0, SEEK_SET);
        char *script_buf = (char *)malloc(file_size + 1);
        if (!script_buf) {
            fclose(fp);
            fprintf(stderr, "Error: Out of memory\n");
            JS_FreeContext(ctx);
            JS_FreeRuntime(rt);
            return 1;
        }
        size_t nread = fread(script_buf, 1, file_size, fp);
        fclose(fp);
        script_buf[nread] = '\0';

        // 0. 加载插件（如果指定）- 使用 dlopen 动态加载
        if (plugin_file) {
            NDTSDB *plugin_db = NULL;
            if (database) {
                plugin_db = ndtsdb_open_any(database);
            }
            
            int load_ret = load_plugin(plugin_file, plugin_db, ctx);
            if (plugin_db) ndtsdb_close(plugin_db);
            
            if (load_ret != 0) {
                fprintf(stderr, "Error: Failed to load plugin: %s\n", plugin_file);
                free(script_buf);
                JS_FreeContext(ctx);
                JS_FreeRuntime(rt);
                return 1;
            }
            
            list_plugin_cmds();
        }

        // 1. 导入 ndtsdb 模块到 globalThis
        const char *import_src = "import * as ndtsdb from 'ndtsdb'; globalThis.ndtsdb = ndtsdb; 'ok';";
        JSValue import_val = JS_Eval(ctx, import_src, strlen(import_src), "<import>", JS_EVAL_TYPE_MODULE);
        JS_FreeValue(ctx, import_val);
        JSContext *ctx_tmp;
        while (JS_ExecutePendingJob(rt, &ctx_tmp) > 0) {}

        // 1.5 注入便捷指标函数到 ndtsdb（sma/ema/atr）
        // 注意：ndtsdb 是 ES module namespace（frozen），不能直接赋属性。
        // 解法：Object.assign({}, globalThis.ndtsdb) 创建可写副本，追加方法后替换。
        const char *indicators_src =
            "(function(){"
            "  var _nd = Object.assign({}, globalThis.ndtsdb);"
            "  _nd.sma = function(rows, period) {"
            "    if (!rows || rows.length < period) return [];"
            "    var result = [];"
            "    for (var i = period - 1; i < rows.length; i++) {"
            "      var sum = 0;"
            "      for (var j = 0; j < period; j++) sum += parseFloat(rows[i-j].close) || 0;"
            "      result.push({ timestamp: rows[i].timestamp, value: sum / period });"
            "    }"
            "    return result;"
            "  };"
            "  _nd.ema = function(rows, period) {"
            "    if (!rows || rows.length < period) return [];"
            "    var result = [];"
            "    var k = 2 / (period + 1);"
            "    var ema = parseFloat(rows[0].close) || 0;"
            "    for (var i = 1; i < rows.length; i++) {"
            "      ema = (parseFloat(rows[i].close) || 0) * k + ema * (1 - k);"
            "      if (i >= period - 1) result.push({ timestamp: rows[i].timestamp, value: ema });"
            "    }"
            "    return result;"
            "  };"
            "  _nd.atr = function(rows, period) {"
            "    if (!rows || rows.length < period + 1) return [];"
            "    var result = [];"
            "    var trs = [];"
            "    for (var i = 1; i < rows.length; i++) {"
            "      var h = parseFloat(rows[i].high) || 0;"
            "      var l = parseFloat(rows[i].low) || 0;"
            "      var pc = parseFloat(rows[i-1].close) || 0;"
            "      trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));"
            "    }"
            "    for (var i = period - 1; i < trs.length; i++) {"
            "      var sum = 0;"
            "      for (var j = 0; j < period; j++) sum += trs[i-j];"
            "      result.push({ timestamp: rows[i+1].timestamp, value: sum / period });"
            "    }"
            "    return result;"
            "  };"
            "  _nd.bollinger = function(rows, period, mult) {"
            "    if (!rows || rows.length < period) return [];"
            "    if (mult === undefined) mult = 2;"
            "    var result = [];"
            "    for (var i = period - 1; i < rows.length; i++) {"
            "      var sum = 0;"
            "      for (var j = 0; j < period; j++) sum += parseFloat(rows[i-j].close) || 0;"
            "      var mid = sum / period;"
            "      var vsum = 0;"
            "      for (var j = 0; j < period; j++) {"
            "        var d = (parseFloat(rows[i-j].close) || 0) - mid;"
            "        vsum += d * d;"
            "      }"
            "      var std = Math.sqrt(vsum / period);"
            "      result.push({ timestamp: rows[i].timestamp, mid: mid, upper: mid + mult*std, lower: mid - mult*std, std: std });"
            "    }"
            "    return result;"
            "  };"
            "  _nd.rsi = function(rows, period) {"
            "    if (!rows || rows.length < period + 1) return [];"
            "    if (period === undefined) period = 14;"
            "    var result = [];"
            "    var gains = 0, losses = 0;"
            "    for (var i = 1; i <= period; i++) {"
            "      var d = (parseFloat(rows[i].close)||0) - (parseFloat(rows[i-1].close)||0);"
            "      if (d > 0) gains += d; else losses -= d;"
            "    }"
            "    var avgGain = gains / period, avgLoss = losses / period;"
            "    for (var i = period; i < rows.length; i++) {"
            "      if (i > period) {"
            "        var d = (parseFloat(rows[i].close)||0) - (parseFloat(rows[i-1].close)||0);"
            "        avgGain = (avgGain * (period-1) + (d>0?d:0)) / period;"
            "        avgLoss = (avgLoss * (period-1) + (d<0?-d:0)) / period;"
            "      }"
            "      var rs = avgLoss === 0 ? 100 : avgGain / avgLoss;"
            "      result.push({ timestamp: rows[i].timestamp, value: 100 - 100/(1+rs) });"
            "    }"
            "    return result;"
            "  };"
            "  _nd.macd = function(rows, fast, slow, signal) {"
            "    fast = fast || 12;"
            "    slow = slow || 26;"
            "    signal = signal || 9;"
            "    if (!rows || rows.length < slow) return [];"
            "    var fastEMA = _nd.ema(rows, fast);"
            "    var slowEMA = _nd.ema(rows, slow);"
            "    var macdLine = [];"
            "    var offset = fastEMA.length - slowEMA.length;"
            "    for (var i = 0; i < slowEMA.length; i++) {"
            "      macdLine.push({ timestamp: slowEMA[i].timestamp, value: fastEMA[i + offset].value - slowEMA[i].value });"
            "    }"
            "    var signalInput = macdLine.map(function(r){return {timestamp:r.timestamp,close:r.value};});"
            "    var signalEMA = _nd.ema(signalInput, signal);"
            "    var result = [];"
            "    var macdOffset = macdLine.length - signalEMA.length;"
            "    for (var i = 0; i < signalEMA.length; i++) {"
            "      result.push({ timestamp: signalEMA[i].timestamp, macd: macdLine[i + macdOffset].value, signal: signalEMA[i].value, hist: macdLine[i + macdOffset].value - signalEMA[i].value });"
            "    }"
            "    return result;"
            "  };"
            "  _nd.vwap = function(rows) {"
            "    if (!rows || rows.length === 0) return [];"
            "    var result = [];"
            "    var cumulativeTpv = 0;"
            "    var cumulativeVol = 0;"
            "    for (var i = 0; i < rows.length; i++) {"
            "      var h = parseFloat(rows[i].high) || 0;"
            "      var l = parseFloat(rows[i].low) || 0;"
            "      var c = parseFloat(rows[i].close) || 0;"
            "      var v = parseFloat(rows[i].volume) || 0;"
            "      var tp = (h + l + c) / 3;"
            "      cumulativeTpv += tp * v;"
            "      cumulativeVol += v;"
            "      result.push({ timestamp: rows[i].timestamp, value: cumulativeVol > 0 ? cumulativeTpv / cumulativeVol : 0 });"
            "    }"
            "    return result;"
            "  };"
            "  _nd.obv = function(rows) {"
            "    if (!rows || rows.length === 0) return [];"
            "    var result = [];"
            "    var obv = parseFloat(rows[0].volume) || 0;"
            "    result.push({ timestamp: rows[0].timestamp, value: obv });"
            "    for (var i = 1; i < rows.length; i++) {"
            "      var close = parseFloat(rows[i].close) || 0;"
            "      var prevClose = parseFloat(rows[i-1].close) || 0;"
            "      var volume = parseFloat(rows[i].volume) || 0;"
            "      if (close > prevClose) obv += volume;"
            "      else if (close < prevClose) obv -= volume;"
            "      result.push({ timestamp: rows[i].timestamp, value: obv });"
            "    }"
            "    return result;"
            "  };"
            "  globalThis.ndtsdb = _nd;"
            "})();";
        JSValue indicators_val = JS_Eval(ctx, indicators_src, strlen(indicators_src), "<indicators>", JS_EVAL_TYPE_GLOBAL);
        if (JS_IsException(indicators_val)) {
            JSValue exc = JS_GetException(ctx);
            const char *msg = JS_ToCString(ctx, exc);
            fprintf(stderr, "[WARN] Failed to inject indicators: %s\n", msg ? msg : "(unknown)");
            if (msg) JS_FreeCString(ctx, msg);
            JS_FreeValue(ctx, exc);
        }
        JS_FreeValue(ctx, indicators_val);

        // 2. 注入全局变量
        JSValue global_obj = JS_GetGlobalObject(ctx);

        // __database
        if (database) {
            JS_SetPropertyStr(ctx, global_obj, "__database", JS_NewString(ctx, database));
        } else {
            JS_SetPropertyStr(ctx, global_obj, "__database", JS_NULL);
        }

        // __args (数组)
        JSValue args_arr = JS_NewArray(ctx);
        for (int i = 0; i < extra_argc; i++) {
            JS_SetPropertyUint32(ctx, args_arr, i, JS_NewString(ctx, extra_args[i]));
        }
        JS_SetPropertyStr(ctx, global_obj, "__args", args_arr);

        // __file
        JS_SetPropertyStr(ctx, global_obj, "__file", JS_NewString(ctx, script_file));

        JS_FreeValue(ctx, global_obj);

        // 3. 执行脚本
        JSValue result = JS_Eval(ctx, script_buf, nread, script_file, JS_EVAL_TYPE_MODULE);
        free(script_buf);

        // 执行 pending jobs（async/Promise）
        while (JS_ExecutePendingJob(rt, &ctx_tmp) > 0) {}

        if (JS_IsException(result)) {
            JSValue exc = JS_GetException(ctx);
            const char *msg = JS_ToCString(ctx, exc);
            fprintf(stderr, "Error: %s\n", msg ? msg : "(unknown)");
            if (msg) JS_FreeCString(ctx, msg);
            // print stack trace if available
            JSValue stack = JS_GetPropertyStr(ctx, exc, "stack");
            if (!JS_IsUndefined(stack)) {
                const char *stack_str = JS_ToCString(ctx, stack);
                if (stack_str) { fprintf(stderr, "%s\n", stack_str); JS_FreeCString(ctx, stack_str); }
            }
            JS_FreeValue(ctx, stack);
            JS_FreeValue(ctx, exc);
            JS_FreeValue(ctx, result);
            JS_FreeContext(ctx);
            JS_FreeRuntime(rt);
            return 1;
        }
        JS_FreeValue(ctx, result);
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
        
        // --watch mode: watch DB directory mtime changes
        if (watch_mode && database) {
            struct stat st;
            time_t last_mtime = 0;
            
            // get initial mtime
            if (stat(database, &st) == 0) {
                last_mtime = st.st_mtime;
            }
            
            printf("[watch] Watching database: %s (interval: %dms)\n", database, watch_interval_ms);
            fflush(stdout);
            
            while (1) {
                // sleep interval (ms)
                usleep((useconds_t)watch_interval_ms * 1000);
                
                // check mtime
                if (stat(database, &st) == 0) {
                    if (st.st_mtime != last_mtime) {
                        // mtime changed, re-run
                        char timestamp[64];
                        struct tm *tm_info = localtime(&st.st_mtime);
                        strftime(timestamp, sizeof(timestamp), "%Y-%m-%d %H:%M:%S", tm_info);
                        printf("[watch] DB changed at %s, re-running...\n", timestamp);
                        
                        last_mtime = st.st_mtime;
                        
                        // re-exec with same args
                        char **new_argv = (char **)malloc(sizeof(char*) * ((size_t)argc + 1));
                        int na = 0;
                        for (int i = 0; i < argc; i++) {
                            if (strcmp(argv[i], "--watch") == 0) continue;
                            if (strcmp(argv[i], "--interval") == 0 && i+1 < argc) { i++; continue; }
                            new_argv[na++] = argv[i];
                        }
                        new_argv[na] = NULL;
                        execv("/proc/self/exe", new_argv);
                        perror("execv failed"); return 1;
                    }
                }
            }
        }
        
        // --repeat: sleep 后重新 exec 自身（不带 --repeat），避免 QuickJS 模块缓存问题
        if (repeat_secs > 0) {
            sleep((unsigned int)repeat_secs);
            char **new_argv = (char **)malloc(sizeof(char*) * ((size_t)argc + 1));
            int na = 0;
            for (int i = 0; i < argc; i++) {
                if ((strcmp(argv[i], "--repeat") == 0 || strcmp(argv[i], "-r") == 0) && i+1 < argc) { i++; continue; }
                new_argv[na++] = argv[i];
            }
            new_argv[na] = NULL;
            execv("/proc/self/exe", new_argv);
            perror("execv failed"); return 1;
        }
        return 0;
    }

    // ==================== export 子命令 ====================
    if (argc > 1 && strcmp(argv[1], "export") == 0) {
        return cmd_export(argc, argv);
    }

    // ==================== count 子命令 ====================
    if (argc > 1 && strcmp(argv[1], "count") == 0) {
        return cmd_count(argc, argv);
    }

    // ==================== info 子命令 ====================
    // 用法: ndtsdb-cli info --database <path> [--symbol <sym>]
    // 输出每个 series 的元信息：行数 + 时间范围（first/last timestamp）
    if (argc > 1 && strcmp(argv[1], "info") == 0) {
        const char *database = NULL, *symbol = NULL;
        int help_flag = 0;
        for (int i = 2; i < argc; i++) {
            if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) { help_flag = 1; }
            else if ((strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) && i+1 < argc) database = argv[++i];
            else if ((strcmp(argv[i], "--symbol") == 0 || strcmp(argv[i], "-s") == 0) && i+1 < argc) symbol = argv[++i];
        }
        if (help_flag) {
            printf("Usage: ndtsdb-cli info --database <path> [--symbol <sym>]\n");
            printf("  Show series metadata (count, first/last timestamp)\n");
            printf("  --database, -d  Database path (required)\n");
            printf("  --symbol, -s    Filter by symbol\n");
            JS_FreeContext(ctx); JS_FreeRuntime(rt); return 0;
        }
        if (!database) {
            fprintf(stderr, "Usage: ndtsdb-cli info --database <path> [--symbol <sym>]\n");
            JS_FreeContext(ctx); JS_FreeRuntime(rt); return 1;
        }
        NDTSDB *db = ndtsdb_open_any(database);
        if (!db) { fprintf(stderr, "Error: Cannot open database: %s\n", database); JS_FreeContext(ctx); JS_FreeRuntime(rt); return 1; }
        QueryResult *result;
        if (symbol) { const char *syms[1] = {symbol}; result = ndtsdb_query_filtered(db, syms, 1); }
        else result = ndtsdb_query_all(db);
        if (!result) { ndtsdb_close(db); JS_FreeContext(ctx); JS_FreeRuntime(rt); return 1; }

        typedef struct { KlineRow row; char symbol[32]; char interval[16]; } InfoRow;
        InfoRow *rows = (InfoRow*)result->rows;

        // 按 symbol+interval 聚合：count, first_ts, last_ts
        typedef struct { char sym[32]; char iv[16]; int cnt; int64_t first_ts; int64_t last_ts; } Series;
        Series *series = (Series*)malloc(sizeof(Series) * 1024);
        int n = 0;
        for (int i = 0; i < (int)result->count; i++) {
            if (rows[i].row.volume < 0) continue;
            int64_t ts = rows[i].row.timestamp;
            int f = 0;
            for (int j = 0; j < n; j++) {
                if (!strcmp(series[j].sym, rows[i].symbol) && !strcmp(series[j].iv, rows[i].interval)) {
                    series[j].cnt++;
                    if (ts < series[j].first_ts) series[j].first_ts = ts;
                    if (ts > series[j].last_ts) series[j].last_ts = ts;
                    f = 1; break;
                }
            }
            if (!f && n < 1024) {
                strncpy(series[n].sym, rows[i].symbol, 31);
                strncpy(series[n].iv, rows[i].interval, 15);
                series[n].cnt = 1;
                series[n].first_ts = ts;
                series[n].last_ts = ts;
                n++;
            }
        }
        for (int j = 0; j < n; j++)
            printf("{\"symbol\":\"%s\",\"interval\":\"%s\",\"count\":%d,\"first\":%lld,\"last\":%lld}\n",
                series[j].sym, series[j].iv, series[j].cnt,
                (long long)series[j].first_ts, (long long)series[j].last_ts);
        free(series);
        ndtsdb_free_result(result); ndtsdb_close(db);
        JS_FreeContext(ctx); JS_FreeRuntime(rt); return 0;
    }

    // ==================== repl 子命令 ====================
    // 用法: ndtsdb-cli repl [--database <path>]
    // 带 ndtsdb 模块的交互式 JS shell
    if (argc > 1 && strcmp(argv[1], "repl") == 0) {
        const char *database = NULL;
        for (int i = 2; i < argc; i++) {
            if ((strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) && i + 1 < argc) {
                database = argv[++i];
            }
        }

        // 导入 ndtsdb 模块到 globalThis
        const char *import_src = "import * as ndtsdb from 'ndtsdb'; globalThis.ndtsdb = ndtsdb; 'ok';";
        JSValue import_val = JS_Eval(ctx, import_src, strlen(import_src), "<import>", JS_EVAL_TYPE_MODULE);
        JS_FreeValue(ctx, import_val);
        JSContext *ctx_repl_tmp;
        while (JS_ExecutePendingJob(rt, &ctx_repl_tmp) > 0) {}

        // 注入 __database
        JSValue global_repl = JS_GetGlobalObject(ctx);
        if (database) {
            JS_SetPropertyStr(ctx, global_repl, "__database", JS_NewString(ctx, database));
            // 方便起见，直接打开数据库赋给 __db
            char open_js[512];
            snprintf(open_js, sizeof(open_js), "globalThis.__db = ndtsdb.open('%s'); 'ok';", database);
            JSValue open_val = JS_Eval(ctx, open_js, strlen(open_js), "<open>", JS_EVAL_TYPE_GLOBAL);
            JS_FreeValue(ctx, open_val);
        } else {
            JS_SetPropertyStr(ctx, global_repl, "__database", JS_NULL);
            JS_SetPropertyStr(ctx, global_repl, "__db", JS_NULL);
        }
        JS_FreeValue(ctx, global_repl);

        // 欢迎信息
        printf("ndtsdb-cli REPL v1.0.0-beta (QuickJS + ndtsdb)\n");
        if (database) {
            printf("Database: %s  →  globalThis.__db 已打开\n", database);
        } else {
            printf("提示: 用 --database <path> 自动打开数据库\n");
            printf("     或手动: const db = ndtsdb.open('/path/to/db')\n");
        }
        printf("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
        printf("可用: ndtsdb / __database / __db\n");
        printf("命令: .exit .help .symbols .version\n");
        printf("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n");

        // 进入 REPL 循环（复用已有 repl() 函数，但先增强 .help）
        // 内联处理以便注入特有命令
#ifdef HAVE_READLINE
        char *rline;
        while ((rline = readline(database ? "ndtsdb> " : "> ")) != NULL) {
            if (strlen(rline) == 0) { free(rline); continue; }
            add_history(rline);
            if (strcmp(rline, ".exit") == 0 || strcmp(rline, ".quit") == 0) { free(rline); break; }
            if (strcmp(rline, ".help") == 0) {
                printf("ndtsdb API:\n");
                printf("  ndtsdb.open(path)                    → db handle\n");
                printf("  ndtsdb.queryAll(db)                  → rows[]\n");
                printf("  ndtsdb.queryFiltered(db, [symbol])   → rows[]\n");
                printf("  ndtsdb.insert(db, sym, intv, row)    → void\n");
                printf("  ndtsdb.close(db)                     → void\n");
                printf("快捷变量:\n");
                printf("  __db         (已打开的数据库，若传了--database)\n");
                printf("  __database   (数据库路径字符串)\n");
                printf("REPL命令:\n");
                printf("  .exit .quit  退出\n");
                printf("  .symbols     列出当前数据库所有 symbol/interval\n");
                printf("  .version     显示版本\n\n");
                free(rline); continue;
            }
            if (strcmp(rline, ".version") == 0) {
                printf("ndtsdb-cli v1.0.0-beta\n");
                free(rline); continue;
            }
            if (strcmp(rline, ".symbols") == 0) {
                const char *sym_js = database
                    ? "(() => { const d = ndtsdb.queryAll(__db); const s={}; d.forEach(r=>{const k=r.symbol+'@'+r.interval;s[k]=(s[k]||0)+1;}); Object.entries(s).forEach(([k,v])=>console.log(k+': '+v+' rows')); })()"
                    : "console.error('需要 --database 参数')";
                eval_line(ctx, sym_js);
                free(rline); continue;
            }
            eval_line(ctx, rline);
            free(rline);
        }
#else
        char rline_buf[4096];
        while (true) {
            printf(database ? "ndtsdb> " : "> ");
            fflush(stdout);
            if (!fgets(rline_buf, sizeof(rline_buf), stdin)) { printf("\n"); break; }
            size_t rlen = strlen(rline_buf);
            if (rlen > 0 && rline_buf[rlen-1] == '\n') rline_buf[rlen-1] = '\0';
            if (strlen(rline_buf) == 0) continue;
            if (strcmp(rline_buf, ".exit") == 0 || strcmp(rline_buf, ".quit") == 0) break;
            if (strcmp(rline_buf, ".help") == 0) {
                printf("ndtsdb.open/queryAll/queryFiltered/insert/close | __db __database | .symbols .version\n");
                continue;
            }
            if (strcmp(rline_buf, ".version") == 0) { printf("ndtsdb-cli v1.0.0-beta\n"); continue; }
            if (strcmp(rline_buf, ".symbols") == 0) {
                const char *sym_js = database
                    ? "(() => { const d = ndtsdb.queryAll(__db); const s={}; d.forEach(r=>{const k=r.symbol+'@'+r.interval;s[k]=(s[k]||0)+1;}); Object.entries(s).forEach(([k,v])=>console.log(k+': '+v+' rows')); })()"
                    : "console.error('需要 --database 参数')";
                eval_line(ctx, sym_js);
                continue;
            }
            eval_line(ctx, rline_buf);
        }
#endif
        if (database) {
            // 关闭数据库
            const char *close_js = "if (__db) { ndtsdb.close(__db); }";
            JSValue cv = JS_Eval(ctx, close_js, strlen(close_js), "<close>", JS_EVAL_TYPE_GLOBAL);
            JS_FreeValue(ctx, cv);
        }
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
        return 0;
    }

    // ==================== sql 子命令 ====================
    if (argc > 1 && strcmp(argv[1], "sql") == 0) {
        return cmd_sql(argc, argv);
    }

    // ==================== merge 子命令 ====================
    if (argc > 1 && strcmp(argv[1], "merge") == 0) {
        return cmd_merge(argc, argv);
    }

    // ==================== resample 子命令 ====================
    if (argc > 1 && strcmp(argv[1], "resample") == 0) {
        return cmd_resample(argc, argv);
    }

    // ==================== search 子命令 ====================
    if (argc > 1 && strcmp(argv[1], "search") == 0) {
        return cmd_search(argc, argv);
    }

    // ==================== facts 子命令 ====================
    if (argc > 1 && strcmp(argv[1], "facts") == 0) {
        return cmd_facts(argc, argv);
    }

    // ==================== plugin 子命令 ====================
    if (argc > 1 && strcmp(argv[1], "plugin") == 0) {
        return cmd_plugin(argc, argv);
    }

        // ==================== 脚本/REPL 模式（支持 --plugin）====================
    {
        const char *plugin_file = NULL;
        const char *script_file = NULL;
        const char *db_path = NULL;
        int script_argc_start = 1;
        
        // 解析参数（包括 --plugin 和 --database）
        for (int i = 1; i < argc; i++) {
            if (strcmp(argv[i], "--plugin") == 0 || strcmp(argv[i], "-p") == 0) {
                if (i + 1 < argc) {
                    plugin_file = argv[++i];
                    script_argc_start = i + 1;
                }
            } else if (strncmp(argv[i], "--plugin=", 9) == 0) {
                plugin_file = argv[i] + 9;
                script_argc_start = i + 1;
            } else if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
                if (i + 1 < argc) {
                    db_path = argv[++i];
                }
            } else if (strncmp(argv[i], "--database=", 11) == 0) {
                db_path = argv[i] + 11;
            }
        }
        
        // 如果有剩余参数，第一个是脚本文件
        if (script_argc_start < argc && argv[script_argc_start][0] != '-') {
            script_file = argv[script_argc_start];
        }
        
        // 导入ndtsdb模块到全局
        JSValue import_result = JS_Eval(ctx, 
            "import * as ndtsdb from 'ndtsdb'; globalThis.ndtsdb = ndtsdb; 'ok';", 
            strlen("import * as ndtsdb from 'ndtsdb'; globalThis.ndtsdb = ndtsdb; 'ok';"), 
            "<import>", JS_EVAL_TYPE_MODULE);
        JS_FreeValue(ctx, import_result);
        JSContext *ctx_temp;
        while (JS_ExecutePendingJob(rt, &ctx_temp) > 0) {}
        
        // 加载插件（如果指定）- 使用 dlopen 动态加载
        if (plugin_file) {
            // 解析 --database 参数给插件用
            const char *plugin_db_path = NULL;
            for (int i = 1; i < argc; i++) {
                if ((strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) && i + 1 < argc) {
                    plugin_db_path = argv[++i];
                }
            }
            // 初始化数据库连接（插件可能需要）
            NDTSDB *plugin_db = NULL;
            if (plugin_db_path) {
                plugin_db = ndtsdb_open_any(plugin_db_path);
            }

            // 使用 cmd_plugin 加载 .so 插件
            int load_ret = load_plugin(plugin_file, plugin_db, ctx);
            if (plugin_db) ndtsdb_close(plugin_db);
            
            if (load_ret != 0) {
                fprintf(stderr, "Error: Failed to load plugin: %s\n", plugin_file);
                JS_FreeContext(ctx);
                JS_FreeRuntime(rt);
                return 1;
            }
            
            // 显示已注册的插件命令
            list_plugin_cmds();
        }
        
        // 执行用户脚本或进入REPL
        if (script_file) {
            exit_code = run_script(ctx, script_file);
        } else {
            repl(ctx);
        }
    }
    
    JSContext *ctx2;
    while (JS_ExecutePendingJob(rt, &ctx2) > 0) {}
    
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    
    fflush(stdout);
    fflush(stderr);
    
    return exit_code;
}
