// cmd_indicators.c - 技术指标子命令实现
#include "cmd_indicators.h"
#include "quickjs.h"
#include <math.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <limits.h>
#include <stdbool.h>

// 外部依赖（由 main.c 提供）
extern JSContext *ctx;
extern JSRuntime *rt;

// ==================== sma 子命令 ====================
int cmd_sma(int argc, char *argv[]) {
    const char *database = NULL;
    const char *symbol = NULL;
    const char *interval = NULL;
    const char *format = "json";
    int period = 20;
    int64_t since = -1;
    int64_t until = -1;
    int help_flag = 0;
    
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            help_flag = 1;
        } else if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
            if (i + 1 < argc) database = argv[++i];
        } else if (strcmp(argv[i], "--symbol") == 0 || strcmp(argv[i], "-s") == 0) {
            if (i + 1 < argc) symbol = argv[++i];
        } else if (strcmp(argv[i], "--interval") == 0 || strcmp(argv[i], "-i") == 0) {
            if (i + 1 < argc) interval = argv[++i];
        } else if (strcmp(argv[i], "--period") == 0 || strcmp(argv[i], "-p") == 0) {
            if (i + 1 < argc) period = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--since") == 0) {
            if (i + 1 < argc) since = atoll(argv[++i]);
        } else if (strcmp(argv[i], "--until") == 0) {
            if (i + 1 < argc) until = atoll(argv[++i]);
        } else if (strcmp(argv[i], "--format") == 0) {
            if (i + 1 < argc) format = argv[++i];
        }
    }
    
    if (help_flag) {
        printf("Usage: ndtsdb-cli sma --database <path> --symbol <sym> --interval <intv> [--period <n>] [--since <ts>] [--until <ts>] [--format <json|csv>]\n\n");
        printf("Calculate Simple Moving Average.\n\n");
        printf("Options:\n");
        printf("  --database, -d   Database directory path (required)\n");
        printf("  --symbol, -s     Symbol to query (required)\n");
        printf("  --interval, -i   Interval (e.g., 1m, 5m, 1h) (required)\n");
        printf("  --period, -p     SMA period (default: 20)\n");
        printf("  --since          Start timestamp (ms)\n");
        printf("  --until          End timestamp (ms)\n");
        printf("  --format         Output format: json or csv (default: json)\n");
        printf("\nExample:\n");
        printf("  ndtsdb-cli sma -d ./db -s BTC -i 1m --period 20\n");
        return 0;
    }
    
    if (!database || !symbol || !interval) {
        fprintf(stderr, "Usage: ndtsdb-cli sma --database <path> --symbol <sym> --interval <intv> [--period <n>] [--since <ts>] [--until <ts>]\n");
        return 1;
    }
    
    NDTSDB *db = ndtsdb_open(database);
    if (!db) {
        fprintf(stderr, "Error: Failed to open database: %s\n", database);
        return 1;
    }
    
    QueryResult *result = ndtsdb_query_all(db);
    if (!result) {
        fprintf(stderr, "Error: Query failed\n");
        ndtsdb_close(db);
        return 1;
    }
    
    typedef struct { KlineRow row; char symbol[32]; char interval[16]; } ResultRow;
    ResultRow* rows = (ResultRow*)result->rows;
    
    int max_points = result->count;
    double *closes = (double*)malloc(max_points * sizeof(double));
    int64_t *timestamps = (int64_t*)malloc(max_points * sizeof(int64_t));
    int n = 0;
    
    for (uint32_t i = 0; i < result->count; i++) {
        if (rows[i].row.volume < 0) continue;
        if (strcmp(rows[i].symbol, symbol) != 0 || strcmp(rows[i].interval, interval) != 0) continue;
        if (since >= 0 && rows[i].row.timestamp < since) continue;
        if (until >= 0 && rows[i].row.timestamp > until) continue;
        
        closes[n] = rows[i].row.close;
        timestamps[n] = rows[i].row.timestamp;
        n++;
    }
    
    ndtsdb_free_result(result);
    
    if (n < period) {
        fprintf(stderr, "Error: Not enough data points (%d < %d)\n", n, period);
        free(closes); free(timestamps);
        ndtsdb_close(db);
        return 1;
    }
    
    double sum = 0.0;
    int first_output = 1;
    for (int i = 0; i < n; i++) {
        sum += closes[i];
        if (i >= period) {
            sum -= closes[i - period];
        }
        if (i >= period - 1) {
            double sma = sum / period;
            if (first_output) {
                if (strcmp(format, "csv") == 0) printf("timestamp,sma\n");
                first_output = 0;
            }
            if (strcmp(format, "csv") == 0)
                printf("%lld,%.8f\n", (long long)timestamps[i], sma);
            else
                printf("{\"timestamp\":%lld,\"sma\":%.8f}\n", (long long)timestamps[i], sma);
        }
    }
    
    free(closes); free(timestamps);
    ndtsdb_close(db);
    return 0;
}

// ==================== vwap 子命令 ====================
int cmd_vwap(int argc, char *argv[]) {
    const char *database = NULL;
    const char *symbol = NULL;
    const char *interval = NULL;
    const char *format = "json";
    int64_t since = -1;
    int64_t until = -1;
    int help_flag = 0;

    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            help_flag = 1;
        } else if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
            if (i + 1 < argc) database = argv[++i];
        } else if (strcmp(argv[i], "--symbol") == 0 || strcmp(argv[i], "-s") == 0) {
            if (i + 1 < argc) symbol = argv[++i];
        } else if (strcmp(argv[i], "--interval") == 0 || strcmp(argv[i], "-i") == 0) {
            if (i + 1 < argc) interval = argv[++i];
        } else if (strcmp(argv[i], "--since") == 0) {
            if (i + 1 < argc) since = atoll(argv[++i]);
        } else if (strcmp(argv[i], "--until") == 0) {
            if (i + 1 < argc) until = atoll(argv[++i]);
        } else if (strcmp(argv[i], "--format") == 0) {
            if (i + 1 < argc) format = argv[++i];
        }
    }

    if (help_flag) {
        printf("Usage: ndtsdb-cli vwap --database <path> --symbol <sym> --interval <intv> [--since <ts>] [--until <ts>] [--format <json|csv>]\n\n");
        printf("Calculate Volume-Weighted Average Price.\n\n");
        printf("Options:\n");
        printf("  --database, -d   Database directory path (required)\n");
        printf("  --symbol, -s     Symbol to query (required)\n");
        printf("  --interval, -i   Interval (e.g., 1m, 5m, 1h) (required)\n");
        printf("  --since          Start timestamp (ms)\n");
        printf("  --until          End timestamp (ms)\n");
        printf("  --format         Output format: json or csv (default: json)\n");
        printf("\nExample:\n");
        printf("  ndtsdb-cli vwap -d ./db -s BTC -i 1m\n");
        return 0;
    }

    if (!database || !symbol || !interval) {
        fprintf(stderr, "Usage: ndtsdb-cli vwap --database <path> --symbol <sym> --interval <intv> [--since <ts>] [--until <ts>] [--format json|csv]\n");
        return 1;
    }

    NDTSDB *db = ndtsdb_open(database);
    if (!db) {
        fprintf(stderr, "Error: Failed to open database: %s\n", database);
        return 1;
    }

    QueryResult *result = ndtsdb_query_all(db);
    if (!result) {
        fprintf(stderr, "Error: Query failed\n");
        ndtsdb_close(db);
        return 1;
    }

    typedef struct { KlineRow row; char symbol[32]; char interval[16]; } ResultRow;
    ResultRow* rows = (ResultRow*)result->rows;

    int max_points = result->count;
    double *highs = (double*)malloc(max_points * sizeof(double));
    double *lows = (double*)malloc(max_points * sizeof(double));
    double *closes = (double*)malloc(max_points * sizeof(double));
    double *volumes = (double*)malloc(max_points * sizeof(double));
    int64_t *timestamps = (int64_t*)malloc(max_points * sizeof(int64_t));
    int n = 0;

    for (uint32_t i = 0; i < result->count; i++) {
        if (rows[i].row.volume < 0) continue;
        if (strcmp(rows[i].symbol, symbol) != 0 || strcmp(rows[i].interval, interval) != 0) continue;
        if (since >= 0 && rows[i].row.timestamp < since) continue;
        if (until >= 0 && rows[i].row.timestamp > until) continue;

        highs[n] = rows[i].row.high;
        lows[n] = rows[i].row.low;
        closes[n] = rows[i].row.close;
        volumes[n] = rows[i].row.volume;
        timestamps[n] = rows[i].row.timestamp;
        n++;
    }

    ndtsdb_free_result(result);

    if (n == 0) {
        fprintf(stderr, "Error: No data points found\n");
        free(highs); free(lows); free(closes); free(volumes); free(timestamps);
        ndtsdb_close(db);
        return 1;
    }

    double cumulative_tpv = 0.0;
    double cumulative_vol = 0.0;
    int first_output = 1;

    for (int i = 0; i < n; i++) {
        double tp = (highs[i] + lows[i] + closes[i]) / 3.0;
        cumulative_tpv += tp * volumes[i];
        cumulative_vol += volumes[i];
        double vwap = cumulative_vol > 0 ? cumulative_tpv / cumulative_vol : 0.0;

        if (first_output) {
            if (strcmp(format, "csv") == 0) printf("timestamp,vwap\n");
            first_output = 0;
        }
        if (strcmp(format, "csv") == 0)
            printf("%lld,%.8f\n", (long long)timestamps[i], vwap);
        else
            printf("{\"timestamp\":%lld,\"vwap\":%.8f}\n", (long long)timestamps[i], vwap);
    }

    free(highs); free(lows); free(closes); free(volumes); free(timestamps);
    ndtsdb_close(db);
    return 0;
}

// ==================== ema 子命令 ====================
int cmd_ema(int argc, char *argv[]) {
    const char *database = NULL;
    const char *symbol = NULL;
    const char *interval = NULL;
    const char *format = "json";
    int period = 20;
    int64_t since = -1;
    int64_t until = -1;
    int help_flag = 0;
    
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            help_flag = 1;
        } else if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
            if (i + 1 < argc) database = argv[++i];
        } else if (strcmp(argv[i], "--symbol") == 0 || strcmp(argv[i], "-s") == 0) {
            if (i + 1 < argc) symbol = argv[++i];
        } else if (strcmp(argv[i], "--interval") == 0 || strcmp(argv[i], "-i") == 0) {
            if (i + 1 < argc) interval = argv[++i];
        } else if (strcmp(argv[i], "--period") == 0 || strcmp(argv[i], "-p") == 0) {
            if (i + 1 < argc) period = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--since") == 0) {
            if (i + 1 < argc) since = atoll(argv[++i]);
        } else if (strcmp(argv[i], "--until") == 0) {
            if (i + 1 < argc) until = atoll(argv[++i]);
        } else if (strcmp(argv[i], "--format") == 0) {
            if (i + 1 < argc) format = argv[++i];
        }
    }
    
    if (help_flag) {
        printf("Usage: ndtsdb-cli ema --database <path> --symbol <sym> --interval <intv> [--period <n>] [--since <ts>] [--until <ts>] [--format <json|csv>]\n\n");
        printf("Calculate Exponential Moving Average.\n\n");
        printf("Options:\n");
        printf("  --database, -d   Database directory path (required)\n");
        printf("  --symbol, -s     Symbol to query (required)\n");
        printf("  --interval, -i   Interval (e.g., 1m, 5m, 1h) (required)\n");
        printf("  --period, -p     EMA period (default: 20)\n");
        printf("  --since          Start timestamp (ms)\n");
        printf("  --until          End timestamp (ms)\n");
        printf("  --format         Output format: json or csv (default: json)\n");
        printf("\nExample:\n");
        printf("  ndtsdb-cli ema -d ./db -s BTC -i 1m --period 20\n");
        return 0;
    }
    
    if (!database || !symbol || !interval) {
        fprintf(stderr, "Usage: ndtsdb-cli ema --database <path> --symbol <sym> --interval <intv> [--period <n>] [--since <ts>] [--until <ts>]\n");
        return 1;
    }
    
    NDTSDB *db = ndtsdb_open(database);
    if (!db) {
        fprintf(stderr, "Error: Failed to open database: %s\n", database);
        return 1;
    }
    
    QueryResult *result = ndtsdb_query_all(db);
    if (!result) {
        fprintf(stderr, "Error: Query failed\n");
        ndtsdb_close(db);
        return 1;
    }
    
    typedef struct { KlineRow row; char symbol[32]; char interval[16]; } ResultRow;
    ResultRow* rows = (ResultRow*)result->rows;
    
    int max_points = result->count;
    double *closes = (double*)malloc(max_points * sizeof(double));
    int64_t *timestamps = (int64_t*)malloc(max_points * sizeof(int64_t));
    int n = 0;
    
    for (uint32_t i = 0; i < result->count; i++) {
        if (rows[i].row.volume < 0) continue;
        if (strcmp(rows[i].symbol, symbol) != 0 || strcmp(rows[i].interval, interval) != 0) continue;
        if (since >= 0 && rows[i].row.timestamp < since) continue;
        if (until >= 0 && rows[i].row.timestamp > until) continue;
        
        closes[n] = rows[i].row.close;
        timestamps[n] = rows[i].row.timestamp;
        n++;
    }
    
    ndtsdb_free_result(result);
    
    if (n < period) {
        fprintf(stderr, "Error: Not enough data points (%d < %d)\n", n, period);
        free(closes); free(timestamps);
        ndtsdb_close(db);
        return 1;
    }
    
    double multiplier = 2.0 / (period + 1);
    double ema = 0.0;
    int first_output = 1;
    
    for (int i = 0; i < n; i++) {
        double close = closes[i];
        if (i == period - 1) {
            double sum = 0.0;
            for (int j = 0; j < period; j++) {
                sum += closes[j];
            }
            ema = sum / period;
        } else if (i >= period) {
            ema = close * multiplier + ema * (1.0 - multiplier);
        }
        if (i >= period - 1) {
            if (first_output) {
                if (strcmp(format, "csv") == 0) printf("timestamp,ema\n");
                first_output = 0;
            }
            if (strcmp(format, "csv") == 0)
                printf("%lld,%.8f\n", (long long)timestamps[i], ema);
            else
                printf("{\"timestamp\":%lld,\"ema\":%.8f}\n", (long long)timestamps[i], ema);
        }
    }
    
    free(closes); free(timestamps);
    ndtsdb_close(db);
    return 0;
}

// ==================== atr 子命令 ====================
int cmd_atr(int argc, char *argv[]) {
    const char *database = NULL;
    const char *symbol = NULL;
    const char *interval = NULL;
    const char *format = "json";
    int period = 14;
    int64_t since = -1;
    int64_t until = -1;
    int help_flag = 0;
    
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            help_flag = 1;
        } else if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
            if (i + 1 < argc) database = argv[++i];
        } else if (strcmp(argv[i], "--symbol") == 0 || strcmp(argv[i], "-s") == 0) {
            if (i + 1 < argc) symbol = argv[++i];
        } else if (strcmp(argv[i], "--interval") == 0 || strcmp(argv[i], "-i") == 0) {
            if (i + 1 < argc) interval = argv[++i];
        } else if (strcmp(argv[i], "--period") == 0 || strcmp(argv[i], "-p") == 0) {
            if (i + 1 < argc) period = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--since") == 0) {
            if (i + 1 < argc) since = atoll(argv[++i]);
        } else if (strcmp(argv[i], "--until") == 0) {
            if (i + 1 < argc) until = atoll(argv[++i]);
        } else if (strcmp(argv[i], "--format") == 0) {
            if (i + 1 < argc) format = argv[++i];
        }
    }
    
    if (help_flag) {
        printf("Usage: ndtsdb-cli atr --database <path> --symbol <sym> --interval <intv> [--period <n>] [--since <ts>] [--until <ts>] [--format <json|csv>]\n\n");
        printf("Calculate Average True Range.\n\n");
        printf("Options:\n");
        printf("  --database, -d   Database directory path (required)\n");
        printf("  --symbol, -s     Symbol to query (required)\n");
        printf("  --interval, -i   Interval (e.g., 1m, 5m, 1h) (required)\n");
        printf("  --period, -p     ATR period (default: 14)\n");
        printf("  --since          Start timestamp (ms)\n");
        printf("  --until          End timestamp (ms)\n");
        printf("  --format         Output format: json or csv (default: json)\n");
        printf("\nExample:\n");
        printf("  ndtsdb-cli atr -d ./db -s BTC -i 1m --period 14\n");
        return 0;
    }
    
    if (!database || !symbol || !interval) {
        fprintf(stderr, "Usage: ndtsdb-cli atr --database <path> --symbol <sym> --interval <intv> [--period <n>] [--since <ts>] [--until <ts>]\n");
        return 1;
    }
    
    NDTSDB *db = ndtsdb_open(database);
    if (!db) {
        fprintf(stderr, "Error: Failed to open database: %s\n", database);
        return 1;
    }
    
    Query q = {
        .symbol = symbol,
        .interval = interval,
        .startTime = since >= 0 ? since : 0,
        .endTime = until >= 0 ? until : INT64_MAX,
        .limit = 0
    };
    QueryResult *result = ndtsdb_query(db, &q);
    
    if (!result) {
        fprintf(stderr, "Error: Query failed\n");
        ndtsdb_close(db);
        return 1;
    }
    
    int max_rows = result->count;
    double *highs = (double*)malloc(max_rows * sizeof(double));
    double *lows = (double*)malloc(max_rows * sizeof(double));
    double *closes = (double*)malloc(max_rows * sizeof(double));
    int64_t *timestamps = (int64_t*)malloc(max_rows * sizeof(int64_t));
    
    int n = 0;
    for (uint32_t i = 0; i < result->count; i++) {
        if (result->rows[i].volume < 0) continue;
        highs[n] = result->rows[i].high;
        lows[n] = result->rows[i].low;
        closes[n] = result->rows[i].close;
        timestamps[n] = result->rows[i].timestamp;
        n++;
    }
    
    ndtsdb_free_result(result);
    
    if (n < period) {
        fprintf(stderr, "Error: Not enough data points (%d < %d)\n", n, period);
        free(highs); free(lows); free(closes); free(timestamps);
        ndtsdb_close(db);
        return 1;
    }
    
    double *tr = (double*)malloc(n * sizeof(double));
    double *atr = (double*)malloc(n * sizeof(double));
    
    tr[0] = highs[0] - lows[0];
    
    for (int i = 1; i < n; i++) {
        double hl = highs[i] - lows[i];
        double hpc = highs[i] - closes[i-1];
        if (hpc < 0) hpc = -hpc;
        double lpc = lows[i] - closes[i-1];
        if (lpc < 0) lpc = -lpc;
        
        tr[i] = hl;
        if (hpc > tr[i]) tr[i] = hpc;
        if (lpc > tr[i]) tr[i] = lpc;
    }
    
    double tr_sum = 0.0;
    for (int i = 0; i < period; i++) {
        tr_sum += tr[i];
    }
    atr[period - 1] = tr_sum / period;
    
    for (int i = period; i < n; i++) {
        atr[i] = (atr[i-1] * (period - 1) + tr[i]) / period;
    }
    
    if (strcmp(format, "csv") == 0) printf("timestamp,atr\n");
    for (int i = period - 1; i < n; i++) {
        if (strcmp(format, "csv") == 0)
            printf("%lld,%.8f\n", (long long)timestamps[i], atr[i]);
        else
            printf("{\"timestamp\":%lld,\"atr\":%.8f}\n", (long long)timestamps[i], atr[i]);
    }
    
    free(highs); free(lows); free(closes); free(timestamps);
    free(tr); free(atr);
    ndtsdb_close(db);
    return 0;
}

// ==================== obv 子命令 ====================
int cmd_obv(int argc, char *argv[]) {
    const char *database = NULL;
    const char *symbol = NULL;
    const char *interval = NULL;
    const char *format = "json";
    int64_t since = -1;
    int64_t until = -1;
    int help_flag = 0;
    
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            help_flag = 1;
        } else if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
            if (i + 1 < argc) database = argv[++i];
        } else if (strcmp(argv[i], "--symbol") == 0 || strcmp(argv[i], "-s") == 0) {
            if (i + 1 < argc) symbol = argv[++i];
        } else if (strcmp(argv[i], "--interval") == 0 || strcmp(argv[i], "-i") == 0) {
            if (i + 1 < argc) interval = argv[++i];
        } else if (strcmp(argv[i], "--since") == 0) {
            if (i + 1 < argc) since = atoll(argv[++i]);
        } else if (strcmp(argv[i], "--until") == 0) {
            if (i + 1 < argc) until = atoll(argv[++i]);
        } else if (strcmp(argv[i], "--format") == 0) {
            if (i + 1 < argc) format = argv[++i];
        }
    }
    
    if (help_flag) {
        printf("Usage: ndtsdb-cli obv --database <path> --symbol <sym> --interval <intv> [--since <ts>] [--until <ts>] [--format <json|csv>]\n\n");
        printf("Calculate On-Balance Volume.\n\n");
        printf("Options:\n");
        printf("  --database, -d   Database directory path (required)\n");
        printf("  --symbol, -s     Symbol to query (required)\n");
        printf("  --interval, -i   Interval (e.g., 1m, 5m, 1h) (required)\n");
        printf("  --since          Start timestamp (ms)\n");
        printf("  --until          End timestamp (ms)\n");
        printf("  --format         Output format: json or csv (default: json)\n");
        printf("\nExample:\n");
        printf("  ndtsdb-cli obv -d ./db -s BTC -i 1m\n");
        return 0;
    }
    
    if (!database || !symbol || !interval) {
        fprintf(stderr, "Usage: ndtsdb-cli obv --database <path> --symbol <sym> --interval <intv> [--since <ts>] [--until <ts>] [--format json|csv]\n");
        return 1;
    }
    
    NDTSDB *db = ndtsdb_open(database);
    if (!db) {
        fprintf(stderr, "Error: Failed to open database: %s\n", database);
        return 1;
    }
    
    QueryResult *result = ndtsdb_query_all(db);
    if (!result) {
        fprintf(stderr, "Error: Query failed\n");
        ndtsdb_close(db);
        return 1;
    }
    
    typedef struct { KlineRow row; char symbol[32]; char interval[16]; } ResultRow;
    ResultRow* rows = (ResultRow*)result->rows;
    
    int max_points = result->count;
    double *closes = (double*)malloc(max_points * sizeof(double));
    double *volumes = (double*)malloc(max_points * sizeof(double));
    int64_t *timestamps = (int64_t*)malloc(max_points * sizeof(int64_t));
    int n = 0;
    
    for (uint32_t i = 0; i < result->count; i++) {
        if (rows[i].row.volume < 0) continue;
        if (strcmp(rows[i].symbol, symbol) != 0 || strcmp(rows[i].interval, interval) != 0) continue;
        if (since >= 0 && rows[i].row.timestamp < since) continue;
        if (until >= 0 && rows[i].row.timestamp > until) continue;
        
        closes[n] = rows[i].row.close;
        volumes[n] = rows[i].row.volume;
        timestamps[n] = rows[i].row.timestamp;
        n++;
    }
    
    ndtsdb_free_result(result);
    ndtsdb_close(db);
    
    if (n == 0) {
        fprintf(stderr, "Error: No data points\n");
        free(closes); free(volumes); free(timestamps);
        return 1;
    }
    
    double *obv = (double*)malloc(n * sizeof(double));
    obv[0] = volumes[0];
    
    for (int i = 1; i < n; i++) {
        if (closes[i] > closes[i-1]) {
            obv[i] = obv[i-1] + volumes[i];
        } else if (closes[i] < closes[i-1]) {
            obv[i] = obv[i-1] - volumes[i];
        } else {
            obv[i] = obv[i-1];
        }
    }
    
    if (strcmp(format, "csv") == 0) {
        printf("timestamp,obv\n");
        for (int i = 0; i < n; i++) {
            printf("%lld,%.4f\n", (long long)timestamps[i], obv[i]);
        }
    } else {
        for (int i = 0; i < n; i++) {
            printf("{\"timestamp\":%lld,\"obv\":%.4f}\n", (long long)timestamps[i], obv[i]);
        }
    }
    
    free(closes); free(volumes); free(timestamps); free(obv);
    return 0;
}

// ==================== rsi 子命令 ====================
int cmd_rsi(int argc, char *argv[]) {
    const char *database = NULL;
    const char *symbol = NULL;
    const char *interval = NULL;
    const char *format = "json";
    int period = 14;
    int64_t since = -1;
    int64_t until = -1;
    int help_flag = 0;
    
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            help_flag = 1;
        } else if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
            if (i + 1 < argc) database = argv[++i];
        } else if (strcmp(argv[i], "--symbol") == 0 || strcmp(argv[i], "-s") == 0) {
            if (i + 1 < argc) symbol = argv[++i];
        } else if (strcmp(argv[i], "--interval") == 0 || strcmp(argv[i], "-i") == 0) {
            if (i + 1 < argc) interval = argv[++i];
        } else if (strcmp(argv[i], "--period") == 0 || strcmp(argv[i], "-p") == 0) {
            if (i + 1 < argc) period = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--since") == 0) {
            if (i + 1 < argc) since = atoll(argv[++i]);
        } else if (strcmp(argv[i], "--until") == 0) {
            if (i + 1 < argc) until = atoll(argv[++i]);
        } else if (strcmp(argv[i], "--format") == 0) {
            if (i + 1 < argc) format = argv[++i];
        }
    }
    
    if (help_flag) {
        printf("Usage: ndtsdb-cli rsi --database <path> --symbol <sym> --interval <intv> [--period <n>] [--since <ts>] [--until <ts>] [--format <json|csv>]\n\n");
        printf("Calculate Relative Strength Index (Wilder's RSI).\n\n");
        printf("Options:\n");
        printf("  --database, -d   Database directory path (required)\n");
        printf("  --symbol, -s     Symbol to query (required)\n");
        printf("  --interval, -i   Interval (e.g., 1m, 5m, 1h) (required)\n");
        printf("  --period, -p     RSI period (default: 14)\n");
        printf("  --since          Start timestamp (ms)\n");
        printf("  --until          End timestamp (ms)\n");
        printf("  --format         Output format: json or csv (default: json)\n");
        printf("\nExample:\n");
        printf("  ndtsdb-cli rsi -d ./db -s BTC -i 1m --period 14\n");
        return 0;
    }
    
    if (!database || !symbol || !interval) {
        fprintf(stderr, "Usage: ndtsdb-cli rsi --database <path> --symbol <sym> --interval <intv> [--period <n>] [--since <ts>] [--until <ts>] [--format json|csv]\n");
        return 1;
    }
    
    NDTSDB *db = ndtsdb_open(database);
    if (!db) {
        fprintf(stderr, "Error: Failed to open database: %s\n", database);
        return 1;
    }
    
    QueryResult *result = ndtsdb_query_all(db);
    if (!result) {
        fprintf(stderr, "Error: Query failed\n");
        ndtsdb_close(db);
        return 1;
    }
    
    typedef struct { KlineRow row; char symbol[32]; char interval[16]; } ResultRow;
    ResultRow* rows = (ResultRow*)result->rows;
    
    int max_points = result->count;
    double *closes = (double*)malloc(max_points * sizeof(double));
    int64_t *timestamps = (int64_t*)malloc(max_points * sizeof(int64_t));
    int n = 0;
    
    for (uint32_t i = 0; i < result->count; i++) {
        if (rows[i].row.volume < 0) continue;
        if (strcmp(rows[i].symbol, symbol) != 0 || strcmp(rows[i].interval, interval) != 0) continue;
        if (since >= 0 && rows[i].row.timestamp < since) continue;
        if (until >= 0 && rows[i].row.timestamp > until) continue;
        
        closes[n] = rows[i].row.close;
        timestamps[n] = rows[i].row.timestamp;
        n++;
    }
    
    ndtsdb_free_result(result);
    ndtsdb_close(db);
    
    if (n < period + 1) {
        fprintf(stderr, "Error: Not enough data points (%d < %d)\n", n, period + 1);
        free(closes); free(timestamps);
        return 1;
    }
    
    double *gains = (double*)malloc(n * sizeof(double));
    double *losses = (double*)malloc(n * sizeof(double));
    double *rsi = (double*)malloc(n * sizeof(double));
    
    for (int i = 1; i < n; i++) {
        double delta = closes[i] - closes[i-1];
        gains[i] = delta > 0 ? delta : 0;
        losses[i] = delta < 0 ? -delta : 0;
    }
    
    double avgGain = 0, avgLoss = 0;
    for (int i = 1; i <= period; i++) {
        avgGain += gains[i];
        avgLoss += losses[i];
    }
    avgGain /= period;
    avgLoss /= period;
    
    if (avgLoss == 0) {
        rsi[period] = 100;
    } else {
        double rs = avgGain / avgLoss;
        rsi[period] = 100 - 100 / (1 + rs);
    }
    
    for (int i = period + 1; i < n; i++) {
        avgGain = (avgGain * (period - 1) + gains[i]) / period;
        avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
        
        if (avgLoss == 0) {
            rsi[i] = 100;
        } else {
            double rs = avgGain / avgLoss;
            rsi[i] = 100 - 100 / (1 + rs);
        }
    }
    
    if (strcmp(format, "csv") == 0) {
        printf("timestamp,rsi\n");
        for (int i = 0; i < n; i++) {
            if (i < period) {
                printf("%lld,\n", (long long)timestamps[i]);
            } else {
                printf("%lld,%.4f\n", (long long)timestamps[i], rsi[i]);
            }
        }
    } else {
        for (int i = 0; i < n; i++) {
            if (i < period) {
                printf("{\"timestamp\":%lld,\"rsi\":null}\n", (long long)timestamps[i]);
            } else {
                printf("{\"timestamp\":%lld,\"rsi\":%.4f}\n", (long long)timestamps[i], rsi[i]);
            }
        }
    }
    
    free(closes); free(timestamps); free(gains); free(losses); free(rsi);
    return 0;
}

// ==================== macd 子命令 ====================
int cmd_macd(int argc, char *argv[]) {
    const char *database = NULL;
    const char *symbol = NULL;
    const char *interval = NULL;
    const char *format = "json";
    int fast = 12;
    int slow = 26;
    int signal_period = 9;
    int64_t since = -1;
    int64_t until = -1;
    int help_flag = 0;
    
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            help_flag = 1;
        } else if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
            if (i + 1 < argc) database = argv[++i];
        } else if (strcmp(argv[i], "--symbol") == 0 || strcmp(argv[i], "-s") == 0) {
            if (i + 1 < argc) symbol = argv[++i];
        } else if (strcmp(argv[i], "--interval") == 0 || strcmp(argv[i], "-i") == 0) {
            if (i + 1 < argc) interval = argv[++i];
        } else if (strcmp(argv[i], "--fast") == 0) {
            if (i + 1 < argc) fast = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--slow") == 0) {
            if (i + 1 < argc) slow = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--signal") == 0) {
            if (i + 1 < argc) signal_period = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--since") == 0) {
            if (i + 1 < argc) since = atoll(argv[++i]);
        } else if (strcmp(argv[i], "--until") == 0) {
            if (i + 1 < argc) until = atoll(argv[++i]);
        } else if (strcmp(argv[i], "--format") == 0) {
            if (i + 1 < argc) format = argv[++i];
        }
    }
    
    if (help_flag) {
        printf("Usage: ndtsdb-cli macd --database <path> --symbol <sym> --interval <intv> [--fast <n>] [--slow <n>] [--signal <n>] [--since <ts>] [--until <ts>] [--format <json|csv>]\n\n");
        printf("Calculate MACD (Moving Average Convergence Divergence).\n\n");
        printf("Options:\n");
        printf("  --database, -d   Database directory path (required)\n");
        printf("  --symbol, -s     Symbol to query (required)\n");
        printf("  --interval, -i   Interval (e.g., 1m, 5m, 1h) (required)\n");
        printf("  --fast           Fast EMA period (default: 12)\n");
        printf("  --slow           Slow EMA period (default: 26)\n");
        printf("  --signal         Signal line period (default: 9)\n");
        printf("  --since          Start timestamp (ms)\n");
        printf("  --until          End timestamp (ms)\n");
        printf("  --format         Output format: json or csv (default: json)\n");
        printf("\nExample:\n");
        printf("  ndtsdb-cli macd -d ./db -s BTC -i 1m --fast 12 --slow 26 --signal 9\n");
        return 0;
    }
    
    if (!database || !symbol || !interval) {
        fprintf(stderr, "Usage: ndtsdb-cli macd --database <path> --symbol <sym> --interval <intv> [--fast <n>] [--slow <n>] [--signal <n>] [--since <ts>] [--until <ts>] [--format json|csv]\n");
        return 1;
    }
    
    NDTSDB *db = ndtsdb_open(database);
    if (!db) {
        fprintf(stderr, "Error: Failed to open database: %s\n", database);
        return 1;
    }
    
    QueryResult *result = ndtsdb_query_all(db);
    if (!result) {
        fprintf(stderr, "Error: Query failed\n");
        ndtsdb_close(db);
        return 1;
    }
    
    typedef struct { KlineRow row; char symbol[32]; char interval[16]; } ResultRow;
    ResultRow* rows = (ResultRow*)result->rows;
    
    int max_points = result->count;
    double *closes = (double*)malloc(max_points * sizeof(double));
    int64_t *timestamps = (int64_t*)malloc(max_points * sizeof(int64_t));
    int n = 0;
    
    for (uint32_t i = 0; i < result->count; i++) {
        if (rows[i].row.volume < 0) continue;
        if (strcmp(rows[i].symbol, symbol) != 0 || strcmp(rows[i].interval, interval) != 0) continue;
        if (since >= 0 && rows[i].row.timestamp < since) continue;
        if (until >= 0 && rows[i].row.timestamp > until) continue;
        
        closes[n] = rows[i].row.close;
        timestamps[n] = rows[i].row.timestamp;
        n++;
    }
    
    ndtsdb_free_result(result);
    ndtsdb_close(db);
    
    if (n < slow) {
        fprintf(stderr, "Error: Not enough data points (%d < %d)\n", n, slow);
        free(closes); free(timestamps);
        return 1;
    }
    
    double *fast_ema = (double*)malloc(n * sizeof(double));
    double *slow_ema = (double*)malloc(n * sizeof(double));
    double *macd_line = (double*)malloc(n * sizeof(double));
    double *signal_line = (double*)malloc(n * sizeof(double));
    double *histogram = (double*)malloc(n * sizeof(double));
    
    double k_fast = 2.0 / (fast + 1);
    fast_ema[0] = closes[0];
    for (int i = 1; i < n; i++) {
        fast_ema[i] = closes[i] * k_fast + fast_ema[i-1] * (1 - k_fast);
    }
    
    double k_slow = 2.0 / (slow + 1);
    slow_ema[0] = closes[0];
    for (int i = 1; i < n; i++) {
        slow_ema[i] = closes[i] * k_slow + slow_ema[i-1] * (1 - k_slow);
    }
    
    for (int i = 0; i < n; i++) {
        macd_line[i] = fast_ema[i] - slow_ema[i];
    }
    
    double k_signal = 2.0 / (signal_period + 1);
    signal_line[slow - 1] = macd_line[slow - 1];
    for (int i = slow; i < n; i++) {
        signal_line[i] = macd_line[i] * k_signal + signal_line[i-1] * (1 - k_signal);
    }
    
    for (int i = slow - 1; i < n; i++) {
        histogram[i] = macd_line[i] - signal_line[i];
    }
    
    if (strcmp(format, "csv") == 0) {
        printf("timestamp,macd,signal,histogram\n");
        for (int i = 0; i < n; i++) {
            if (i < slow - 1) {
                printf("%lld,,,\n", (long long)timestamps[i]);
            } else {
                printf("%lld,%.4f,%.4f,%.4f\n", (long long)timestamps[i], macd_line[i], signal_line[i], histogram[i]);
            }
        }
    } else {
        for (int i = 0; i < n; i++) {
            if (i < slow - 1) {
                printf("{\"timestamp\":%lld,\"macd\":null,\"signal\":null,\"histogram\":null}\n", (long long)timestamps[i]);
            } else {
                printf("{\"timestamp\":%lld,\"macd\":%.4f,\"signal\":%.4f,\"histogram\":%.4f}\n", (long long)timestamps[i], macd_line[i], signal_line[i], histogram[i]);
            }
        }
    }
    
    free(closes); free(timestamps); free(fast_ema); free(slow_ema); 
    free(macd_line); free(signal_line); free(histogram);
    return 0;
}

// ==================== bollinger 子命令 ====================
int cmd_bollinger(int argc, char *argv[]) {
    const char *database = NULL;
    const char *symbol = NULL;
    const char *interval = NULL;
    const char *format = "json";
    int period = 20;
    double mult = 2.0;
    int64_t since = -1;
    int64_t until = -1;
    int help_flag = 0;
    
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            help_flag = 1;
        } else if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
            if (i + 1 < argc) database = argv[++i];
        } else if (strcmp(argv[i], "--symbol") == 0 || strcmp(argv[i], "-s") == 0) {
            if (i + 1 < argc) symbol = argv[++i];
        } else if (strcmp(argv[i], "--interval") == 0 || strcmp(argv[i], "-i") == 0) {
            if (i + 1 < argc) interval = argv[++i];
        } else if (strcmp(argv[i], "--period") == 0) {
            if (i + 1 < argc) period = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--mult") == 0) {
            if (i + 1 < argc) mult = atof(argv[++i]);
        } else if (strcmp(argv[i], "--since") == 0) {
            if (i + 1 < argc) since = atoll(argv[++i]);
        } else if (strcmp(argv[i], "--until") == 0) {
            if (i + 1 < argc) until = atoll(argv[++i]);
        } else if (strcmp(argv[i], "--format") == 0) {
            if (i + 1 < argc) format = argv[++i];
        }
    }
    
    if (help_flag) {
        printf("Usage: ndtsdb-cli bollinger --database <path> --symbol <sym> --interval <intv> [--period <n>] [--mult <k>] [--since <ts>] [--until <ts>] [--format <json|csv>]\n\n");
        printf("Calculate Bollinger Bands.\n\n");
        printf("Options:\n");
        printf("  --database, -d   Database directory path (required)\n");
        printf("  --symbol, -s     Symbol to query (required)\n");
        printf("  --interval, -i   Interval (e.g., 1m, 5m, 1h) (required)\n");
        printf("  --period         SMA period (default: 20)\n");
        printf("  --mult           Standard deviation multiplier (default: 2.0)\n");
        printf("  --since          Start timestamp (ms)\n");
        printf("  --until          End timestamp (ms)\n");
        printf("  --format         Output format: json or csv (default: json)\n");
        printf("\nExample:\n");
        printf("  ndtsdb-cli bollinger -d ./db -s BTC -i 1m --period 20 --mult 2.0\n");
        return 0;
    }
    
    if (!database || !symbol || !interval) {
        fprintf(stderr, "Usage: ndtsdb-cli bollinger --database <path> --symbol <sym> --interval <intv> [--period <n>] [--mult <k>] [--since <ts>] [--until <ts>] [--format json|csv]\n");
        return 1;
    }
    
    if (period < 2) {
        fprintf(stderr, "Error: period must be >= 2\n");
        return 1;
    }
    
    NDTSDB *db = ndtsdb_open(database);
    if (!db) {
        fprintf(stderr, "Error: Failed to open database: %s\n", database);
        return 1;
    }
    
    QueryResult *result = ndtsdb_query_all(db);
    if (!result) {
        fprintf(stderr, "Error: Query failed\n");
        ndtsdb_close(db);
        return 1;
    }
    
    typedef struct { KlineRow row; char symbol[32]; char interval[16]; } ResultRow;
    ResultRow* rows = (ResultRow*)result->rows;
    
    int max_points = result->count;
    double *closes = (double*)malloc(max_points * sizeof(double));
    int64_t *timestamps = (int64_t*)malloc(max_points * sizeof(int64_t));
    int n = 0;
    
    for (uint32_t i = 0; i < result->count; i++) {
        if (rows[i].row.volume < 0) continue;
        if (strcmp(rows[i].symbol, symbol) != 0 || strcmp(rows[i].interval, interval) != 0) continue;
        if (since >= 0 && rows[i].row.timestamp < since) continue;
        if (until >= 0 && rows[i].row.timestamp > until) continue;
        
        closes[n] = rows[i].row.close;
        timestamps[n] = rows[i].row.timestamp;
        n++;
    }
    
    ndtsdb_free_result(result);
    ndtsdb_close(db);
    
    if (n < period) {
        fprintf(stderr, "Error: Not enough data points (%d < %d)\n", n, period);
        free(closes); free(timestamps);
        return 1;
    }
    
    double *middle = (double*)malloc(n * sizeof(double));
    double *upper = (double*)malloc(n * sizeof(double));
    double *lower = (double*)malloc(n * sizeof(double));
    double *bandwidth = (double*)malloc(n * sizeof(double));
    
    for (int i = 0; i < n; i++) {
        if (i < period - 1) {
            middle[i] = 0.0;
            upper[i] = 0.0;
            lower[i] = 0.0;
            bandwidth[i] = 0.0;
        } else {
            double sum = 0.0;
            for (int j = 0; j < period; j++) {
                sum += closes[i - j];
            }
            middle[i] = sum / period;
            
            double variance_sum = 0.0;
            for (int j = 0; j < period; j++) {
                double diff = closes[i - j] - middle[i];
                variance_sum += diff * diff;
            }
            double stddev = sqrt(variance_sum / period);
            
            upper[i] = middle[i] + mult * stddev;
            lower[i] = middle[i] - mult * stddev;
            
            if (middle[i] > 0.0) {
                bandwidth[i] = (upper[i] - lower[i]) / middle[i];
            } else {
                bandwidth[i] = 0.0;
            }
        }
    }
    
    if (strcmp(format, "csv") == 0) {
        printf("timestamp,upper,middle,lower,bandwidth\n");
        for (int i = period - 1; i < n; i++) {
            printf("%lld,%.8f,%.8f,%.8f,%.8f\n", 
                (long long)timestamps[i], upper[i], middle[i], lower[i], bandwidth[i]);
        }
    } else {
        for (int i = period - 1; i < n; i++) {
            printf("{\"timestamp\":%lld,\"upper\":%.8f,\"middle\":%.8f,\"lower\":%.8f,\"bandwidth\":%.8f}\n",
                (long long)timestamps[i], upper[i], middle[i], lower[i], bandwidth[i]);
        }
    }
    
    free(closes); free(timestamps);
    free(middle); free(upper); free(lower); free(bandwidth);
    return 0;
}
