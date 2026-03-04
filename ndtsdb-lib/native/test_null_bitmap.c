/**
 * Test: NULL Bitmap Support (Phase 2.3)
 * Tests for NULL value encoding and decoding
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include "ndtsdb.h"

/**
 * Test 1: Basic NULL bitmap creation and query
 */
void test_null_bitmap_creation(void) {
    printf("\n✓ Test 1: NULL Bitmap Creation\n");

    uint32_t row_count = 20;
    int null_flags[20];

    /* Setup: 0,2,4,6,8,10,12,14,16,18 are NULL, others are NOT NULL */
    for (int i = 0; i < 20; i++) {
        null_flags[i] = (i % 2 == 0) ? 0 : 1;  /* 0 = NULL, 1 = NOT NULL */
    }

    NullBitmap* bitmap = ndtb_null_bitmap_create(row_count, null_flags);
    assert(bitmap != NULL);
    printf("  Created bitmap: row_count=%u, byte_count=%u\n",
           bitmap->row_count, bitmap->byte_count);

    /* Verify pattern */
    int errors = 0;
    for (int i = 0; i < 20; i++) {
        int is_null = ndtb_null_bitmap_is_null(bitmap, i);
        int expected = (i % 2 == 0) ? 1 : 0;  /* 1 = NULL, 0 = NOT NULL */
        if (is_null != expected) {
            printf("  ✗ Row %d: expected %d, got %d\n", i, expected, is_null);
            errors++;
        }
    }

    if (errors == 0) {
        printf("  ✓ All rows verified correctly\n");
    } else {
        printf("  ✗ %d verification errors\n", errors);
    }

    ndtb_null_bitmap_free(bitmap);
}

/**
 * Test 2: NULL bitmap set operation
 */
void test_null_bitmap_set(void) {
    printf("\n✓ Test 2: NULL Bitmap Set Operation\n");

    uint32_t row_count = 10;
    NullBitmap* bitmap = ndtb_null_bitmap_create(row_count, NULL);
    assert(bitmap != NULL);

    /* All rows should be NOT NULL initially (no flags provided) */
    int all_not_null = 1;
    for (int i = 0; i < 10; i++) {
        if (ndtb_null_bitmap_is_null(bitmap, i) != 0) {
            all_not_null = 0;
            break;
        }
    }
    printf("  Initial state all NOT NULL: %s\n", all_not_null ? "yes" : "no");

    /* Set rows 2, 4, 6, 8 to NULL */
    for (int i = 0; i < 10; i += 2) {
        int ret = ndtb_null_bitmap_set(bitmap, i, 1);  /* 1 = set to NULL */
        assert(ret == 0);
    }

    /* Verify changes */
    int errors = 0;
    for (int i = 0; i < 10; i++) {
        int is_null = ndtb_null_bitmap_is_null(bitmap, i);
        int expected = (i % 2 == 0) ? 1 : 0;
        if (is_null != expected) {
            printf("  ✗ Row %d: expected %d, got %d\n", i, expected, is_null);
            errors++;
        }
    }

    if (errors == 0) {
        printf("  ✓ Set operations verified correctly\n");
    } else {
        printf("  ✗ %d verification errors\n", errors);
    }

    ndtb_null_bitmap_free(bitmap);
}

/**
 * Test 3: NULL bitmap encode/decode round-trip
 */
void test_null_bitmap_encode_decode(void) {
    printf("\n✓ Test 3: NULL Bitmap Encode/Decode\n");

    uint32_t row_count = 32;  /* Test with multiple bytes */
    int null_flags[32];

    /* Complex pattern: alternating blocks */
    for (int i = 0; i < 32; i++) {
        null_flags[i] = ((i / 4) % 2 == 0) ? 0 : 1;
    }

    /* Create original bitmap */
    NullBitmap* orig = ndtb_null_bitmap_create(row_count, null_flags);
    assert(orig != NULL);

    /* Encode */
    uint32_t encoded_len = 0;
    uint8_t* encoded_data = ndtb_null_bitmap_encode(orig, &encoded_len);
    assert(encoded_data != NULL);
    printf("  Encoded: %u bytes\n", encoded_len);

    /* Decode */
    NullBitmap* decoded = ndtb_null_bitmap_decode(encoded_data, encoded_len, row_count);
    assert(decoded != NULL);

    /* Compare */
    int errors = 0;
    for (int i = 0; i < 32; i++) {
        int orig_is_null = ndtb_null_bitmap_is_null(orig, i);
        int decoded_is_null = ndtb_null_bitmap_is_null(decoded, i);
        if (orig_is_null != decoded_is_null) {
            printf("  ✗ Row %d: orig=%d, decoded=%d\n", i, orig_is_null, decoded_is_null);
            errors++;
        }
    }

    if (errors == 0) {
        printf("  ✓ Encode/decode round-trip successful\n");
    } else {
        printf("  ✗ %d round-trip errors\n", errors);
    }

    free(encoded_data);
    ndtb_null_bitmap_free(orig);
    ndtb_null_bitmap_free(decoded);
}

/**
 * Test 4: NULL bitmap edge cases
 */
void test_null_bitmap_edge_cases(void) {
    printf("\n✓ Test 4: NULL Bitmap Edge Cases\n");

    /* Single row */
    NullBitmap* single = ndtb_null_bitmap_create(1, NULL);
    assert(single != NULL);
    assert(ndtb_null_bitmap_is_null(single, 0) == 0);  /* NOT NULL */
    ndtb_null_bitmap_set(single, 0, 1);  /* Set to NULL */
    assert(ndtb_null_bitmap_is_null(single, 0) == 1);  /* NULL */
    ndtb_null_bitmap_free(single);
    printf("  ✓ Single row test passed\n");

    /* Large row count */
    uint32_t large_count = 1000000;
    NullBitmap* large = ndtb_null_bitmap_create(large_count, NULL);
    assert(large != NULL);
    printf("  Created large bitmap: %u rows, %u bytes\n",
           large->row_count, large->byte_count);

    /* Set every 100th row to NULL */
    for (uint32_t i = 0; i < large_count; i += 100) {
        ndtb_null_bitmap_set(large, i, 1);
    }

    /* Verify sample */
    int verify_ok = 1;
    for (uint32_t i = 0; i < large_count; i += 100) {
        if (ndtb_null_bitmap_is_null(large, i) != 1) {
            verify_ok = 0;
            break;
        }
    }
    if (verify_ok) {
        printf("  ✓ Large bitmap test passed\n");
    } else {
        printf("  ✗ Large bitmap verification failed\n");
    }

    ndtb_null_bitmap_free(large);

    /* Invalid index */
    NullBitmap* test = ndtb_null_bitmap_create(10, NULL);
    int invalid_result = ndtb_null_bitmap_is_null(test, 10);  /* Out of range */
    assert(invalid_result == -1);
    printf("  ✓ Out-of-range detection works\n");
    ndtb_null_bitmap_free(test);
}

int main(void) {
    printf("═══════════════════════════════════════════════════\n");
    printf("   NULL Bitmap Support Tests (Phase 2.3)\n");
    printf("═══════════════════════════════════════════════════\n");

    test_null_bitmap_creation();
    test_null_bitmap_set();
    test_null_bitmap_encode_decode();
    test_null_bitmap_edge_cases();

    printf("\n═══════════════════════════════════════════════════\n");
    printf("   All NULL bitmap tests completed!\n");
    printf("═══════════════════════════════════════════════════\n");

    return 0;
}
