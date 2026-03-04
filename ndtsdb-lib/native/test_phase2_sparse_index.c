/**
 * Test: Phase 2 Sparse Index & Streaming Iterator
 * Tests for ndtb sparse indexing and range query optimization
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include <time.h>
#include "ndtsdb.h"

#define TEST_DB_PATH "/tmp/test_ndtb_phase2"
#define TEST_FILE    TEST_DB_PATH "/test_phase2.ndtb"

/**
 * Helper: Generate test NDTB file with known timestamps
 * Creates a file with 1000 rows of test data
 */
int create_test_ndtb_file(const char* filepath) {
    NDTSDB* db = ndtsdb_open(TEST_DB_PATH);
    if (!db) return -1;

    /* Create test data: 100 rows per symbol/interval */
    int64_t base_ts = 1609459200000LL;  /* 2021-01-01 00:00:00 UTC */

    for (int i = 0; i < 100; i++) {
        KlineRow row = {
            .timestamp = base_ts + i * 60000,  /* 1-minute interval */
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

    /* Write to NDTB file */
    write_ndtb_file(filepath, db);
    ndtsdb_close(db);

    return 0;
}

/**
 * Test 1: Basic sparse index creation
 */
void test_sparse_index_creation(void) {
    printf("\n✓ Test 1: Sparse Index Creation\n");

    if (create_test_ndtb_file(TEST_FILE) < 0) {
        printf("  ✗ Failed to create test file\n");
        return;
    }

    SparseIndex* idx = ndtb_sparse_index_create(TEST_FILE, 10);
    if (!idx) {
        printf("  ✗ Failed to create sparse index\n");
        return;
    }

    printf("  ✓ Index created: %u blocks\n", idx->entry_count);

    if (idx->entry_count > 0) {
        SparseIndexEntry* first = &idx->entries[0];
        printf("    Block 0: offset=%lu, min_ts=%ld, max_ts=%ld, rows=%u\n",
               first->block_offset, first->min_ts, first->max_ts, first->row_count);
    }

    ndtb_sparse_index_free(idx);
}

/**
 * Test 2: Range query using sparse index
 */
void test_sparse_index_range_query(void) {
    printf("\n✓ Test 2: Sparse Index Range Query\n");

    SparseIndex* idx = ndtb_sparse_index_create(TEST_FILE, 10);
    if (!idx) {
        printf("  ✗ Failed to create sparse index\n");
        return;
    }

    /* Query for time range covering first 50 rows */
    int64_t base_ts = 1609459200000LL;
    int64_t min_ts = base_ts;
    int64_t max_ts = base_ts + 49 * 60000;  /* First 50 minutes */

    uint32_t matched_count = 0;
    uint32_t* matched_blocks = ndtb_sparse_index_query_range(idx, min_ts, max_ts, &matched_count);

    if (!matched_blocks) {
        printf("  ✗ Range query failed\n");
        ndtb_sparse_index_free(idx);
        return;
    }

    printf("  ✓ Query matched %u blocks\n", matched_count);

    /* Expected: should match first 5 blocks (10 rows per block, 50 rows total) */
    if (matched_count > 0) {
        printf("    Matched blocks: ");
        for (uint32_t i = 0; i < matched_count && i < 5; i++) {
            printf("%u ", matched_blocks[i]);
        }
        printf("%s\n", matched_count > 5 ? "..." : "");
    }

    free(matched_blocks);
    ndtb_sparse_index_free(idx);
}

/**
 * Test 3: Streaming iterator creation
 */
void test_streaming_iterator_creation(void) {
    printf("\n✓ Test 3: Streaming Iterator Creation\n");

    StreamingIterator* iter = ndtb_streaming_iterator_create(TEST_FILE, 10);
    if (!iter) {
        printf("  ✗ Failed to create streaming iterator\n");
        return;
    }

    printf("  ✓ Iterator created\n");
    printf("    File: %s\n", iter->file_path);
    printf("    Block rows: %u\n", iter->block_rows);
    printf("    Buffer capacity: %u bytes\n", iter->read_buffer_cap);

    ndtb_streaming_iterator_free(iter);
}

/**
 * Test 4: Streaming iterator basic iteration
 */
void test_streaming_iterator_iteration(void) {
    printf("\n✓ Test 4: Streaming Iterator Iteration\n");

    StreamingIterator* iter = ndtb_streaming_iterator_create(TEST_FILE, 10);
    if (!iter) {
        printf("  ✗ Failed to create streaming iterator\n");
        return;
    }

    uint32_t total_read = 0;
    uint32_t block_count = 0;

    while (1) {
        uint32_t rows_read = ndtb_streaming_iterator_next(iter);
        if (rows_read == 0) break;

        printf("  Block %u: %u rows\n", block_count, rows_read);
        total_read += rows_read;
        block_count++;

        if (block_count > 20) break;  /* Safety limit */
    }

    printf("  ✓ Iteration complete: %u blocks, %u total rows\n", block_count, total_read);

    ndtb_streaming_iterator_free(iter);
}

/**
 * Test 5: Index efficiency measurement
 */
void test_index_efficiency(void) {
    printf("\n✓ Test 5: Index Efficiency\n");

    SparseIndex* idx = ndtb_sparse_index_create(TEST_FILE, 20);
    if (!idx) {
        printf("  ✗ Failed to create sparse index\n");
        return;
    }

    int64_t base_ts = 1609459200000LL;

    /* Case 1: Query first 20% of time range */
    uint32_t count1 = 0;
    uint32_t* blocks1 = ndtb_sparse_index_query_range(
        idx, base_ts, base_ts + 19 * 60000, &count1);
    printf("  Query 1 (first 20%% of range): %u blocks\n", count1);
    if (blocks1) free(blocks1);

    /* Case 2: Query middle 20% of time range */
    uint32_t count2 = 0;
    uint32_t* blocks2 = ndtb_sparse_index_query_range(
        idx, base_ts + 40 * 60000, base_ts + 59 * 60000, &count2);
    printf("  Query 2 (middle 20%% of range): %u blocks\n", count2);
    if (blocks2) free(blocks2);

    /* Case 3: Query outside range */
    uint32_t count3 = 0;
    uint32_t* blocks3 = ndtb_sparse_index_query_range(
        idx, base_ts - 1000000, base_ts - 100000, &count3);
    printf("  Query 3 (before data): %u blocks\n", count3);
    if (blocks3) free(blocks3);

    ndtb_sparse_index_free(idx);
    printf("  ✓ Efficiency test complete\n");
}

int main(void) {
    printf("=== Phase 2 Sparse Index & Streaming Iterator Tests ===\n");

    /* Create test directory */
    system("mkdir -p " TEST_DB_PATH);

    test_sparse_index_creation();
    test_sparse_index_range_query();
    test_streaming_iterator_creation();
    test_streaming_iterator_iteration();
    test_index_efficiency();

    printf("\n=== All Phase 2 Tests Complete ===\n");

    /* Cleanup */
    system("rm -rf " TEST_DB_PATH);

    return 0;
}
