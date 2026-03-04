/**
 * Simple Streaming Iterator Test
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include "ndtsdb.h"

int main() {
    const char* test_db = "/tmp/test_streaming_simple";
    const char* test_file = "/tmp/test_streaming_simple/test.ndtb";

    system("rm -rf /tmp/test_streaming_simple");
    mkdir(test_db, 0755);

    printf("=== Streaming Iterator Test ===\n\n");

    printf("[Step 1] Create test NDTB file...\n");
    NDTSDB* db = ndtsdb_open(test_db);
    if (!db) {
        fprintf(stderr, "Failed to open database\n");
        return 1;
    }

    int64_t base_ts = 1609459200000LL;
    for (int i = 0; i < 150; i++) {
        KlineRow row = {
            .timestamp = base_ts + i * 60000,
            .open = 100.0 + i * 0.1,
            .high = 101.0 + i * 0.1,
            .low = 99.0 + i * 0.1,
            .close = 100.5 + i * 0.1,
            .volume = 1000.0 + i * 10,
            .quoteVolume = 100000.0 + i * 100,
            .trades = 50 + i,
            .takerBuyVolume = 500.0 + i * 5,
            .takerBuyQuoteVolume = 50000.0 + i * 50,
            .flags = 0
        };
        ndtsdb_insert(db, "BTCUSD", "1m", &row);
    }

    write_ndtb_file(test_file, db);
    ndtsdb_close(db);
    printf("  ✓ Created %s\n\n", test_file);

    printf("[Step 2] Test streaming iterator...\n");
    StreamingIterator* iter = ndtb_streaming_iterator_create(test_file, 25);
    if (!iter) {
        fprintf(stderr, "Failed to create iterator\n");
        return 1;
    }

    uint32_t total_rows = 0;
    uint32_t block_count = 0;

    while (1) {
        uint32_t rows = ndtb_streaming_iterator_next(iter);
        if (rows == 0) break;

        printf("  Block %u: %u rows", block_count, rows);
        if (rows > 0) {
            printf(" [first ts=%ld, open=%f, close=%f]",
                   iter->current_block[0].timestamp,
                   iter->current_block[0].open,
                   iter->current_block[0].close);
        }
        printf("\n");

        total_rows += rows;
        block_count++;
    }

    printf("\n  ✓ Total: %u blocks, %u rows\n", block_count, total_rows);

    if (total_rows != 150) {
        fprintf(stderr, "ERROR: Expected 150 rows, got %u\n", total_rows);
        ndtb_streaming_iterator_free(iter);
        return 1;
    }

    ndtb_streaming_iterator_free(iter);

    printf("\n[Step 3] Test sparse index on same file...\n");
    SparseIndex* idx = ndtb_sparse_index_create(test_file, 25);
    if (!idx) {
        fprintf(stderr, "Failed to create index\n");
        return 1;
    }

    printf("  ✓ Index created: %u blocks\n", idx->entry_count);

    uint32_t matched_count = 0;
    uint32_t* matched = ndtb_sparse_index_query_range(idx, base_ts, base_ts + 50*60000, &matched_count);
    printf("  ✓ Range query matched %u blocks\n", matched_count);

    if (matched) free(matched);
    ndtb_sparse_index_free(idx);

    system("rm -rf /tmp/test_streaming_simple");

    printf("\n=== All Tests Passed ===\n");
    return 0;
}
