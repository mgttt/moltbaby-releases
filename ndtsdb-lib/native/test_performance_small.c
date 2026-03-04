#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/time.h>
#include <unistd.h>
#include "ndtsdb.h"

typedef struct { struct timeval start, end; } Timer;
static void timer_start(Timer* t) { gettimeofday(&t->start, NULL); }
static void timer_stop(Timer* t) { gettimeofday(&t->end, NULL); }
static double timer_elapsed_ms(const Timer* t) {
    long sec = t->end.tv_sec - t->start.tv_sec;
    long usec = t->end.tv_usec - t->start.tv_usec;
    return sec * 1000.0 + usec / 1000.0;
}

void test_small_dataset(uint32_t row_count) {
    printf("\n=== Testing %u rows ===\n", row_count);
    char filepath[256];
    snprintf(filepath, sizeof(filepath), "/tmp/test_%u.ndtb", row_count);

    NDTSDB* db = ndtsdb_open("/tmp/perf_test");
    int64_t base_ts = 1609459200000LL;
    for (uint32_t i = 0; i < row_count; i++) {
        KlineRow row = {.timestamp = base_ts + i * 60000, .open = 100.0 + i * 0.01,
                        .high = 101.0 + i * 0.01, .low = 99.0 + i * 0.01,
                        .close = 100.5 + i * 0.01, .volume = 1000.0 + i * 0.5,
                        .quoteVolume = 100000.0 + i * 50, .trades = 50 + i,
                        .takerBuyVolume = 500.0 + i * 0.25,
                        .takerBuyQuoteVolume = 50000.0 + i * 25, .flags = 0};
        ndtsdb_insert(db, "BTC", "1m", &row);
    }
    write_ndtb_file(filepath, db);
    ndtsdb_close(db);
    printf("Generated: %s\n", filepath);

    Timer t;
    timer_start(&t);
    NDTSDB* db2 = ndtsdb_open_snapshot("/tmp/perf_test2", 0);
    int loaded = load_ndtb_file(db2, filepath);
    timer_stop(&t);
    printf("Loaded via load_ndtb_file: %d rows in %.1f ms (%.0f rows/sec)\n",
           loaded, timer_elapsed_ms(&t), loaded / (timer_elapsed_ms(&t) / 1000.0));
    ndtsdb_close(db2);

    timer_start(&t);
    StreamingIterator* iter = ndtb_streaming_iterator_create(filepath, 10000);
    uint32_t total = 0;
    while ((total += ndtb_streaming_iterator_next(iter)) > 0 && total < row_count * 2) { }
    timer_stop(&t);
    printf("Loaded via streaming (block=10k): %u rows in %.1f ms (%.0f rows/sec)\n",
           total, timer_elapsed_ms(&t), total / (timer_elapsed_ms(&t) / 1000.0));
    ndtb_streaming_iterator_free(iter);
    unlink(filepath);
}

int main() {
    printf("=== NDTB Performance Benchmark ===\n");
    test_small_dataset(10000);
    test_small_dataset(100000);
    return 0;
}
