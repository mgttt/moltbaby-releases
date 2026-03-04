/**
 * Test: Performance Benchmark - load_ndtb_file() vs Streaming Iterator
 * Measures throughput, memory usage, and time to first row
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/time.h>
#include <unistd.h>
#include "ndtsdb.h"

/* ─── Utility: Timing ─── */

typedef struct {
    struct timeval start;
    struct timeval end;
} Timer;

static void timer_start(Timer* t) {
    gettimeofday(&t->start, NULL);
}

static void timer_stop(Timer* t) {
    gettimeofday(&t->end, NULL);
}

static double timer_elapsed_ms(const Timer* t) {
    long sec = t->end.tv_sec - t->start.tv_sec;
    long usec = t->end.tv_usec - t->start.tv_usec;
    return sec * 1000.0 + usec / 1000.0;
}

/* ─── Test Data Generation ─── */

/**
 * Generate NDTB file with N rows
 * Returns path to generated file
 */
static char* generate_test_file(uint32_t row_count) {
    static char filepath[256];
    snprintf(filepath, sizeof(filepath), "/tmp/perf_test_%u.ndtb", row_count);

    printf("  Generating %u rows to %s...\n", row_count, filepath);

    NDTSDB* db = ndtsdb_open("/tmp/perf_test_db");
    if (!db) {
        fprintf(stderr, "Failed to open database\n");
        return NULL;
    }

    /* Generate test data */
    int64_t base_ts = 1609459200000LL;  /* 2021-01-01 */

    for (uint32_t i = 0; i < row_count; i++) {
        KlineRow row = {
            .timestamp = base_ts + i * 60000,  /* 1-minute interval */
            .open = 100.0 + (i % 1000) * 0.01,
            .high = 101.0 + (i % 1000) * 0.01,
            .low = 99.0 + (i % 1000) * 0.01,
            .close = 100.5 + (i % 1000) * 0.01,
            .volume = 1000.0 + (i % 1000) * 0.5,
            .quoteVolume = 100000.0 + (i % 1000) * 50,
            .trades = 50 + (i % 1000),
            .takerBuyVolume = 500.0 + (i % 1000) * 0.25,
            .takerBuyQuoteVolume = 50000.0 + (i % 1000) * 25,
            .flags = 0
        };
        ndtsdb_insert(db, "BTCUSD", "1m", &row);
    }

    /* Write to NDTB */
    if (write_ndtb_file(filepath, db) < 0) {
        fprintf(stderr, "Failed to write NDTB file\n");
        ndtsdb_close(db);
        return NULL;
    }

    ndtsdb_close(db);
    printf("  ✓ Generated %s\n", filepath);

    return filepath;
}

/* ─── Benchmark: load_ndtb_file ─── */

void benchmark_load_ndtb_file(const char* filepath, uint32_t expected_rows) {
    printf("\n  [load_ndtb_file]\n");

    Timer timer;
    timer_start(&timer);

    NDTSDB* db = ndtsdb_open_snapshot("/tmp/perf_bench_db", 0);
    if (!db) {
        printf("    ✗ Failed to open database\n");
        return;
    }

    int rows_loaded = load_ndtb_file(db, filepath);
    timer_stop(&timer);

    double elapsed_ms = timer_elapsed_ms(&timer);
    double throughput = (rows_loaded > 0) ? rows_loaded / (elapsed_ms / 1000.0) : 0;

    printf("    Rows loaded: %d\n", rows_loaded);
    printf("    Time: %.2f ms\n", elapsed_ms);
    printf("    Throughput: %.0f rows/sec\n", throughput);

    ndtsdb_close(db);
}

/* ─── Benchmark: Streaming Iterator ─── */

void benchmark_streaming_iterator(const char* filepath, uint32_t expected_rows, uint32_t block_size) {
    printf("\n  [Streaming Iterator] (block_size=%u)\n", block_size);

    Timer timer;
    timer_start(&timer);

    StreamingIterator* iter = ndtb_streaming_iterator_create(filepath, block_size);
    if (!iter) {
        printf("    ✗ Failed to create iterator\n");
        return;
    }

    uint32_t total_rows = 0;
    uint32_t first_block_time = -1;
    Timer block_timer;

    while (1) {
        timer_start(&block_timer);
        uint32_t block_rows = ndtb_streaming_iterator_next(iter);
        timer_stop(&block_timer);

        if (first_block_time == (uint32_t)-1) {
            first_block_time = (uint32_t)timer_elapsed_ms(&block_timer);
        }

        if (block_rows == 0) break;
        total_rows += block_rows;
    }

    timer_stop(&timer);
    double elapsed_ms = timer_elapsed_ms(&timer);
    double throughput = (total_rows > 0) ? total_rows / (elapsed_ms / 1000.0) : 0;

    printf("    Rows read: %u\n", total_rows);
    printf("    Total time: %.2f ms\n", elapsed_ms);
    printf("    Time to first block: %u ms\n", first_block_time);
    printf("    Throughput: %.0f rows/sec\n", throughput);

    ndtb_streaming_iterator_free(iter);
}

/* ─── Test Entry Points ─── */

void run_performance_test(uint32_t row_count) {
    printf("\n╔══════════════════════════════════════════════════════════════╗\n");
    printf("║  Performance Test: %u rows\n", row_count);
    printf("╚══════════════════════════════════════════════════════════════╝\n");

    char* filepath = generate_test_file(row_count);
    if (!filepath) return;

    fflush(stdout);
    fflush(stderr);

    benchmark_load_ndtb_file(filepath, row_count);
    benchmark_streaming_iterator(filepath, row_count, 1000);
    benchmark_streaming_iterator(filepath, row_count, 10000);

    /* Cleanup */
    unlink(filepath);
}

int main(void) {
    printf("\n╔══════════════════════════════════════════════════════════════╗\n");
    printf("║  NDTB Performance Benchmark (Phase 2.4)\n");
    printf("║  load_ndtb_file() vs Streaming Iterator\n");
    printf("╚══════════════════════════════════════════════════════════════╝\n");

    /* Run tests with different row counts */
    run_performance_test(10000);     /* Small: 10K rows */
    run_performance_test(100000);    /* Medium: 100K rows */
    run_performance_test(500000);    /* Large: 500K rows */

    printf("\n╔══════════════════════════════════════════════════════════════╗\n");
    printf("║  Performance benchmark completed!\n");
    printf("╚══════════════════════════════════════════════════════════════╝\n");

    return 0;
}
