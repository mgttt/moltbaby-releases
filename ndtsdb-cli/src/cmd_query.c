// cmd_query.c - Query 子命令实现
#include "cmd_query.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <stdint.h>
#include <limits.h>
#include "quickjs.h"
#include "../../ndtsdb-lib/native/ndtsdb.h"
#include "../../ndtsdb-lib/native/ndtsdb_vec.h"

// 外部依赖（由 main.c 提供）
extern JSContext *ctx;
extern JSRuntime *rt;
extern int exit_code;
extern void print_exception(JSContext *ctx);

// 从ndtsdb获取的内部结构定义
// ndtsdb_query_filtered返回ResultRow数组，不是KlineRow
typedef struct {
    KlineRow row;
    char symbol[32];
    char interval[16];
} ResultRowInternal;

// ==================== query 子命令 ====================
int cmd_query(int argc, char *argv[]) {
    const char *database = NULL;
    const char *symbols_filter = NULL;
    int64_t since_ms = -1;
    int64_t until_ms = -1;
    const char *interval_filter = NULL;
    int limit = 1000;
    const char *format = "json";
    
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
            if (i + 1 < argc) database = argv[++i];
        } else if (strcmp(argv[i], "--symbol") == 0 || strcmp(argv[i], "-s") == 0) {
            if (i + 1 < argc) symbols_filter = argv[++i];
        } else if (strcmp(argv[i], "--interval") == 0 || strcmp(argv[i], "-i") == 0) {
            if (i + 1 < argc) interval_filter = argv[++i];
        } else if (strcmp(argv[i], "--since") == 0) {
            if (i + 1 < argc) since_ms = atoll(argv[++i]);
        } else if (strcmp(argv[i], "--until") == 0) {
            if (i + 1 < argc) until_ms = atoll(argv[++i]);
        } else if (strcmp(argv[i], "--limit") == 0 || strcmp(argv[i], "-n") == 0) {
            if (i + 1 < argc) limit = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--format") == 0 || strcmp(argv[i], "-f") == 0) {
            if (i + 1 < argc) format = argv[++i];
        }
    }
    
    if (!database) {
        fprintf(stderr, "Error: --database is required\nUsage: ndtsdb-cli query --database <path> [--symbol <sym>] [--interval <intv>] [--since <ts>] [--until <ts>] [--limit <n>] [--format json|csv]\n");
        return 1;
    }
    
    NDTSDB *db = ndtsdb_open(database);
    if (!db) {
        fprintf(stderr, "Error: Failed to open database: %s\n", database);
        return 1;
    }
    
    if (strcmp(format, "csv") == 0) {
        printf("timestamp,symbol,interval,open,high,low,close,volume\n");
    }
    
    // 获取所有symbol/interval
    char symbols[1024][32];
    char intervals[1024][16];
    int sym_count = ndtsdb_list_symbols(db, symbols, intervals, 1024);
    
    int total_count = 0;
    
    for (int s = 0; s < sym_count && total_count < limit; s++) {
        if (symbols_filter && strcmp(symbols[s], symbols_filter) != 0) continue;
        if (interval_filter && strcmp(intervals[s], interval_filter) != 0) continue;
        
        const char *sym_list[1] = {symbols[s]};
        QueryResult *result = ndtsdb_query_filtered(db, sym_list, 1);
        if (!result || !result->rows) continue;
        
        // 正确解析ResultRow结构
        ResultRowInternal* rows = (ResultRowInternal*)result->rows;
        
        for (uint32_t i = 0; i < result->count && total_count < limit; i++) {
            KlineRow *row = &rows[i].row;
            
            // 跳过tombstone
            if (row->volume < 0) continue;
            
            // 时间范围过滤
            if (since_ms >= 0 && row->timestamp < since_ms) continue;
            if (until_ms >= 0 && row->timestamp > until_ms) continue;
            
            // interval过滤（使用ResultRow中的interval）
            if (interval_filter && strcmp(rows[i].interval, interval_filter) != 0) continue;
            
            // 输出
            if (row->flags & 0x01) {
                VecQueryResult* vqr = ndtsdb_vec_query(db, rows[i].symbol, rows[i].interval);
                if (vqr && vqr->count > 0) {
                    for (uint32_t j = 0; j < vqr->count; j++) {
                        if (vqr->records[j].timestamp == row->timestamp) {
                            VecRecord* vrec = &vqr->records[j];
                            if (strcmp(format, "csv") == 0) {
                                printf("%lld,%s,%s,%.6f,%d,,,\n",
                                    (long long)vrec->timestamp,
                                    vrec->agent_id, vrec->type,
                                    vrec->confidence, vrec->embedding_dim);
                            } else {
                                printf("{\"timestamp\":%lld,\"agent_id\":\"%s\",\"type\":\"%s\",\"confidence\":%.6f,\"embedding\":[",
                                    (long long)vrec->timestamp, vrec->agent_id, vrec->type, vrec->confidence);
                                for (int k = 0; k < vrec->embedding_dim; k++) {
                                    printf(k == 0 ? "%.8f" : ",%.8f", vrec->embedding[k]);
                                }
                                printf("]}\n");
                            }
                            break;
                        }
                    }
                    ndtsdb_vec_free_result(vqr);
                }
            } else if (strcmp(format, "csv") == 0) {
                printf("%lld,%s,%s,%.8f,%.8f,%.8f,%.8f,%.8f\n",
                    (long long)row->timestamp, rows[i].symbol, rows[i].interval,
                    row->open, row->high, row->low, row->close, row->volume);
            } else {
                printf("{\"timestamp\":%lld,\"symbol\":\"%s\",\"interval\":\"%s\",\"open\":%.8f,\"high\":%.8f,\"low\":%.8f,\"close\":%.8f,\"volume\":%.8f}\n",
                    (long long)row->timestamp, rows[i].symbol, rows[i].interval,
                    row->open, row->high, row->low, row->close, row->volume);
            }
            total_count++;
        }
        
        ndtsdb_free_result(result);
    }
    
    ndtsdb_close(db);
    return 0;
}

// ==================== list 子命令 ====================
int cmd_list(int argc, char *argv[]) {
    const char *database = NULL;
    
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
            if (i + 1 < argc) database = argv[++i];
        }
    }
    
    if (!database) {
        fprintf(stderr, "Error: --database is required\nUsage: ndtsdb-cli list --database <path>\n");
        return 1;
    }
    
    NDTSDB *db = ndtsdb_open(database);
    if (!db) {
        fprintf(stderr, "Error: Failed to open database: %s\n", database);
        return 1;
    }
    
    char symbols[1024][32];
    char intervals[1024][16];
    int count = ndtsdb_list_symbols(db, symbols, intervals, 1024);
    
    // 检查每个symbol是否有非tombstone数据
    for (int s = 0; s < count; s++) {
        const char *sym_list[1] = {symbols[s]};
        QueryResult *result = ndtsdb_query_filtered(db, sym_list, 1);
        if (!result || !result->rows) continue;
        
        ResultRowInternal* rows = (ResultRowInternal*)result->rows;
        int has_valid = 0;
        
        for (uint32_t i = 0; i < result->count; i++) {
            if (rows[i].row.volume >= 0) {
                has_valid = 1;
                break;
            }
        }
        
        if (has_valid) {
            printf("%s/%s\n", symbols[s], intervals[s]);
        }
        
        ndtsdb_free_result(result);
    }
    
    ndtsdb_close(db);
    return 0;
}

// ==================== tail 子命令 ====================
int cmd_tail(int argc, char *argv[]) {
    const char *database = NULL;
    const char *symbol = NULL;
    const char *interval = NULL;
    int n = 10;
    const char *format = "json";
    
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
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
    
    if (!database || !symbol || !interval) {
        fprintf(stderr, "Usage: ndtsdb-cli tail --database <path> --symbol <sym> --interval <intv> [--n <count>] [--format json|csv]\n");
        return 1;
    }
    
    NDTSDB *db = ndtsdb_open(database);
    if (!db) {
        fprintf(stderr, "Error: Failed to open database: %s\n", database);
        return 1;
    }
    
    const char *sym_list[1] = {symbol};
    QueryResult *result = ndtsdb_query_filtered(db, sym_list, 1);
    if (!result || !result->rows) {
        ndtsdb_close(db);
        return 1;
    }
    
    ResultRowInternal* rows = (ResultRowInternal*)result->rows;
    
    // 收集匹配interval的有效数据
    KlineRow **valid_rows = malloc(result->count * sizeof(KlineRow*));
    int count = 0;
    
    for (uint32_t i = 0; i < result->count; i++) {
        if (rows[i].row.volume < 0) continue;
        if (strcmp(rows[i].interval, interval) != 0) continue;
        valid_rows[count++] = &rows[i].row;
    }
    
    int start = count > n ? count - n : 0;
    
    if (strcmp(format, "csv") == 0) {
        printf("timestamp,symbol,interval,open,high,low,close,volume\n");
    }
    
    for (int i = start; i < count; i++) {
        KlineRow *r = valid_rows[i];
        if (strcmp(format, "csv") == 0) {
            printf("%lld,%s,%s,%.8f,%.8f,%.8f,%.8f,%.8f\n",
                (long long)r->timestamp, symbol, interval,
                r->open, r->high, r->low, r->close, r->volume);
        } else {
            printf("{\"timestamp\":%lld,\"symbol\":\"%s\",\"interval\":\"%s\",\"open\":%.8f,\"high\":%.8f,\"low\":%.8f,\"close\":%.8f,\"volume\":%.8f}\n",
                (long long)r->timestamp, symbol, interval,
                r->open, r->high, r->low, r->close, r->volume);
        }
    }
    
    free(valid_rows);
    ndtsdb_free_result(result);
    ndtsdb_close(db);
    return 0;
}

// ==================== head 子命令 ====================
int cmd_head(int argc, char *argv[]) {
    const char *database = NULL;
    const char *symbol = NULL;
    const char *interval = NULL;
    int n = 10;
    const char *format = "json";
    
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
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
    
    if (!database || !symbol || !interval) {
        fprintf(stderr, "Usage: ndtsdb-cli head --database <path> --symbol <sym> --interval <intv> [--n <count>] [--format json|csv]\n");
        return 1;
    }
    
    NDTSDB *db = ndtsdb_open(database);
    if (!db) {
        fprintf(stderr, "Error: Failed to open database: %s\n", database);
        return 1;
    }
    
    const char *sym_list[1] = {symbol};
    QueryResult *result = ndtsdb_query_filtered(db, sym_list, 1);
    if (!result || !result->rows) {
        ndtsdb_close(db);
        return 1;
    }
    
    ResultRowInternal* rows = (ResultRowInternal*)result->rows;
    
    int count = 0;
    
    if (strcmp(format, "csv") == 0) {
        printf("timestamp,symbol,interval,open,high,low,close,volume\n");
    }
    
    for (uint32_t i = 0; i < result->count && count < n; i++) {
        if (rows[i].row.volume < 0) continue;
        if (strcmp(rows[i].interval, interval) != 0) continue;
        
        KlineRow *row = &rows[i].row;
        if (strcmp(format, "csv") == 0) {
            printf("%lld,%s,%s,%.8f,%.8f,%.8f,%.8f,%.8f\n",
                (long long)row->timestamp, symbol, interval,
                row->open, row->high, row->low, row->close, row->volume);
        } else {
            printf("{\"timestamp\":%lld,\"symbol\":\"%s\",\"interval\":\"%s\",\"open\":%.8f,\"high\":%.8f,\"low\":%.8f,\"close\":%.8f,\"volume\":%.8f}\n",
                (long long)row->timestamp, symbol, interval,
                row->open, row->high, row->low, row->close, row->volume);
        }
        count++;
    }
    
    ndtsdb_free_result(result);
    ndtsdb_close(db);
    return 0;
}

// ==================== count 子命令 ====================
int cmd_count(int argc, char *argv[]) {
    const char *database = NULL;
    const char *symbol = NULL;
    const char *interval = NULL;
    
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
            if (i + 1 < argc) database = argv[++i];
        } else if (strcmp(argv[i], "--symbol") == 0 || strcmp(argv[i], "-s") == 0) {
            if (i + 1 < argc) symbol = argv[++i];
        } else if (strcmp(argv[i], "--interval") == 0 || strcmp(argv[i], "-i") == 0) {
            if (i + 1 < argc) interval = argv[++i];
        }
    }
    
    if (!database) {
        fprintf(stderr, "Usage: ndtsdb-cli count --database <path> [--symbol <sym>] [--interval <intv>]\n");
        return 1;
    }
    
    NDTSDB *db = ndtsdb_open(database);
    if (!db) {
        fprintf(stderr, "Error: Failed to open database: %s\n", database);
        return 1;
    }
    
    char symbols[1024][32];
    char intervals[1024][16];
    int sym_count = ndtsdb_list_symbols(db, symbols, intervals, 1024);
    
    typedef struct {
        char sym[32];
        char iv[16];
        int cnt;
    } SeriesCount;
    
    SeriesCount *counts = calloc(1024, sizeof(SeriesCount));
    int n = 0;
    
    for (int s = 0; s < sym_count; s++) {
        if (symbol && strcmp(symbols[s], symbol) != 0) continue;
        if (interval && strcmp(intervals[s], interval) != 0) continue;
        
        const char *sym_list[1] = {symbols[s]};
        QueryResult *result = ndtsdb_query_filtered(db, sym_list, 1);
        if (!result || !result->rows) continue;
        
        ResultRowInternal* rows = (ResultRowInternal*)result->rows;
        int valid_count = 0;
        
        for (uint32_t i = 0; i < result->count; i++) {
            if (rows[i].row.volume >= 0 && strcmp(rows[i].interval, intervals[s]) == 0) {
                valid_count++;
            }
        }
        
        if (valid_count > 0 && n < 1024) {
            strncpy(counts[n].sym, symbols[s], 31);
            strncpy(counts[n].iv, intervals[s], 15);
            counts[n].cnt = valid_count;
            n++;
        }
        
        ndtsdb_free_result(result);
    }
    
    for (int i = 0; i < n; i++) {
        printf("{\"symbol\":\"%s\",\"interval\":\"%s\",\"count\":%d}\n",
            counts[i].sym, counts[i].iv, counts[i].cnt);
    }
    
    free(counts);
    ndtsdb_close(db);
    return 0;
}

// ==================== info 子命令 ====================
int cmd_info(int argc, char *argv[]) {
    const char *database = NULL;
    
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
            if (i + 1 < argc) database = argv[++i];
        }
    }
    
    if (!database) {
        fprintf(stderr, "Usage: ndtsdb-cli info --database <path>\n");
        return 1;
    }
    
    NDTSDB *db = ndtsdb_open(database);
    if (!db) {
        fprintf(stderr, "Error: Failed to open database: %s\n", database);
        return 1;
    }
    
    char symbols[1024][32];
    char intervals[1024][16];
    int sym_count = ndtsdb_list_symbols(db, symbols, intervals, 1024);
    
    uint64_t total_rows = 0;
    uint64_t valid_rows = 0;
    uint64_t tombstones = 0;
    
    for (int s = 0; s < sym_count; s++) {
        const char *sym_list[1] = {symbols[s]};
        QueryResult *result = ndtsdb_query_filtered(db, sym_list, 1);
        if (!result || !result->rows) continue;
        
        ResultRowInternal* rows = (ResultRowInternal*)result->rows;
        
        for (uint32_t i = 0; i < result->count; i++) {
            total_rows++;
            if (rows[i].row.volume < 0) {
                tombstones++;
            } else {
                valid_rows++;
            }
        }
        ndtsdb_free_result(result);
    }
    
    printf("{\"total_rows\":%llu,\"valid_rows\":%llu,\"tombstones\":%llu}\n",
        (unsigned long long)total_rows,
        (unsigned long long)valid_rows,
        (unsigned long long)tombstones);
    
    ndtsdb_close(db);
    return 0;
}
