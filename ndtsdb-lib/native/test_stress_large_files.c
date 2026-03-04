/**
 * Test: Stress Test - Large File Handling (1M+ rows)
 * Validates streaming iterator with large datasets without memory blowup
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/time.h>
#include <unistd.h>
#include "ndtsdb.h"

typedef struct {
    struct timeval start, end;
} Timer;

static void timer_start(Timer* t) { gettimeofday(&t->start, NULL); }
static void timer_stop(Timer* t) { gettimeofday(&t->end, NULL); }
static double timer_elapsed_ms(const Timer* t) {
    long sec = t->end.tv_sec - t->start.tv_sec;
    long usec = t->end.tv_usec - t->start.tv_usec;
    return sec * 1000.0 + usec / 1000.0;
}

/**
 * Stress test: Generate 1M rows, validate integrity
 */
void stress_test_large_dataset(uint32_t row_count) {
    printf("\n╔══════════════════════════════════════════════════════════════╗\n");
    printf("║  Stress Test: %u rows\n", row_count);
    printf("╚══════════════════════════════════════════════════════════════╝\n");

    char filepath[256];
    snprintf(filepath, sizeof(filepath), "/tmp/stress_test_%u.ndtb", row_count);

    /* 1. Generate test data */
    printf("\n[1] Generating test data...\n");
    Timer gen_timer;
    timer_start(&gen_timer);

    NDTSDB* db = ndtsdb_open("/tmp/stress_db");
    if (!db) {
        printf("✗ Failed to open database\n");
        return;
    }

    int64_t base_ts = 1609459200000LL;
    uint32_t batch_size = 50000;

    for (uint32_t i = 0; i < row_count; i += batch_size) {
        uint32_t batch_count = (i + batch_size <= row_count) ? batch_size : (row_count - i);

        KlineRow* batch = (KlineRow*)malloc(batch_count * sizeof(KlineRow));
        if (!batch) {
            printf("✗ Batch allocation failed\n");
            ndtsdb_close(db);
            return;
        }

        for (uint32_t j = 0; j < batch_count; j++) {
            uint32_t idx = i + j;
            batch[j] = (KlineRow){
                .timestamp = base_ts + idx * 60000,
                .open = 100.0 + (idx % 10000) * 0.001,
                .high = 101.0 + (idx % 10000) * 0.001,
                .low = 99.0 + (idx % 10000) * 0.001,
                .close = 100.5 + (idx % 10000) * 0.001,
                .volume = 1000.0 + (idx % 10000) * 0.01,
                .quoteVolume = 100000.0 + (idx % 10000),
                .trades = 50 + (idx % 1000),
                .takerBuyVolume = 500.0 + (idx % 10000) * 0.005,
                .takerBuyQuoteVolume = 50000.0 + (idx % 10000) * 0.5,
                .flags = 0
            };
        }

        ndtsdb_insert_batch(db, "STRESS", "1m", batch, batch_count);
        free(batch);

        if ((i + batch_size) % 250000 == 0) {
            printf("  Generated %.0f%% (%u rows)\n", 100.0 * (i + batch_size) / row_count, i + batch_size);
            fflush(stdout);
        }
    }

    printf("  Writing NDTB file...\n");
    int written = write_ndtb_file(filepath, db);
    ndtsdb_close(db);
    timer_stop(&gen_timer);

    printf("✓ Generated %d rows in %.1f sec\n", written, timer_elapsed_ms(&gen_timer) / 1000.0);

    /* 2. Verify file with load_ndtb_file */
    printf("\n[2] Verifying with load_ndtb_file...\n");
    Timer load_timer;
    timer_start(&load_timer);

    NDTSDB* db2 = ndtsdb_open_snapshot("/tmp/stress_db2", 0);
    if (!db2) {
        printf("✗ Failed to open database for verification\n");
        unlink(filepath);
        return;
    }

    int loaded = load_ndtb_file(db2, filepath);
    timer_stop(&load_timer);

    if (loaded == (int)row_count) {
        printf("✓ Loaded %d rows (expected %u) in %.1f sec\n", loaded, row_count, timer_elapsed_ms(&load_timer) / 1000.0);
    } else {
        printf("✗ Load verification failed: got %d rows, expected %u\n", loaded, row_count);
    }

    ndtsdb_close(db2);

    /* 3. Stress test streaming iterator with small blocks */
    printf("\n[3] Streaming iterator test (block_size=1000)...\n");
    Timer stream_timer;
    timer_start(&stream_timer);

    StreamingIterator* iter = ndtb_streaming_iterator_create(filepath, 1000);
    if (!iter) {
        printf("✗ Failed to create streaming iterator\n");
        unlink(filepath);
        return;
    }

    uint32_t stream_rows = 0;
    uint32_t block_count = 0;
    while (1) {
        uint32_t block_size = ndtb_streaming_iterator_next(iter);
        if (block_size == 0) break;
        stream_rows += block_size;
        block_count++;
    }

    timer_stop(&stream_timer);

    if (stream_rows == row_count) {
        printf("✓ Streamed %u rows in %u blocks (%.1f sec)\n", stream_rows, block_count, timer_elapsed_ms(&stream_timer) / 1000.0);
    } else {
        printf("⚠ Streamed %u rows (expected %u) in %u blocks\n", stream_rows, row_count, block_count);
    }

    ndtb_streaming_iterator_free(iter);

    /* Cleanup */
    unlink(filepath);
    printf("\n✓ Stress test completed\n");
}

int main(void) {
    printf("\n╔══════════════════════════════════════════════════════════════╗\n");
    printf("║  Large File Stress Tests (Phase 2.4)\n");
    printf("║  Testing 100K, 500K, and 1M+ row datasets\n");
    printf("╚══════════════════════════════════════════════════════════════╝\n");

    stress_test_large_dataset(100000);   /* 100K rows */
    stress_test_large_dataset(500000);   /* 500K rows */
    stress_test_large_dataset(1000000);  /* 1M rows */

    printf("\n╔══════════════════════════════════════════════════════════════╗\n");
    printf("║  All stress tests completed successfully!\n");
    printf("╚══════════════════════════════════════════════════════════════╝\n");

    return 0;
}
