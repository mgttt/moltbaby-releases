/**
 * test_ndtb_write.c — 测试 write_ndtb_file() 和 load_ndtb_file() 的兼容性
 *
 * 编译：gcc -Wall -Wextra -O2 -lm ndts.c test_ndtb_write.c -o test_ndtb_write
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <math.h>
#include <stdint.h>
#include <limits.h>
#include "ndtsdb.h"

#define TEST_FILE "/tmp/test_output.ndtb"

int main(void) {
    printf("=== NDTB Write/Load Test ===\n\n");

    /* 1. 创建临时目录模式数据库 */
    NDTSDB* db1 = ndtsdb_open("/tmp/test_db1");
    if (!db1) {
        fprintf(stderr, "Failed to create db1\n");
        return 1;
    }

    /* 2. 插入测试数据 */
    printf("Inserting test data...\n");
    const char* symbols[] = {"BTCUSDT", "ETHUSDT"};
    const char* intervals[] = {"1h", "4h"};

    int total_inserted = 0;
    for (int s = 0; s < 2; s++) {
        for (int iv = 0; iv < 2; iv++) {
            int64_t base_time = 1700000000000LL;  /* Some timestamp */

            for (int i = 0; i < 50; i++) {
                KlineRow row = {
                    .timestamp = base_time + (int64_t)i * 3600000,  /* 1 hour increments */
                    .open = 1000.0 + (i * 0.5),
                    .high = 1005.0 + (i * 0.5),
                    .low = 995.0 + (i * 0.5),
                    .close = 1002.0 + (i * 0.5),
                    .volume = 1000000.0 + (i * 10000),
                    .quoteVolume = 2000000000.0 + (i * 20000000),
                    .trades = 5000 + i,
                    .takerBuyVolume = 500000.0 + (i * 5000),
                    .takerBuyQuoteVolume = 1000000000.0 + (i * 10000000),
                    .flags = 0
                };

                if (ndtsdb_insert(db1, symbols[s], intervals[iv], &row) != 0) {
                    fprintf(stderr, "Failed to insert row\n");
                    ndtsdb_close(db1);
                    return 1;
                }
                total_inserted++;
            }
        }
    }

    printf("Inserted %d rows\n", total_inserted);

    /* 3. 调用 write_ndtb_file() 将数据写入到 .ndtb 文件 */
    printf("Writing NDTB file...\n");

    /* 我们需要声明和调用 write_ndtb_file
     * 由于它是 static，我们需要在这个文件中声明它 */
    extern int write_ndtb_file(const char* filepath, NDTSDB* db);
    int written = write_ndtb_file(TEST_FILE, db1);
    if (written < 0) {
        fprintf(stderr, "Failed to write NDTB file\n");
        ndtsdb_close(db1);
        return 1;
    }

    printf("Wrote %d rows to %s\n", written, TEST_FILE);

    ndtsdb_close(db1);

    /* 4. 创建新的数据库并加载 .ndtb 文件 */
    printf("Loading NDTB file into new database...\n");
    NDTSDB* db2 = ndtsdb_open("/tmp/test_db2");
    if (!db2) {
        fprintf(stderr, "Failed to create db2\n");
        return 1;
    }

    /* 使用 ndtsdb_insert_batch 或读取文件 */
    extern int load_ndtb_file(NDTSDB* db, const char* filepath);
    int loaded = load_ndtb_file(db2, TEST_FILE);
    if (loaded < 0) {
        fprintf(stderr, "Failed to load NDTB file\n");
        ndtsdb_close(db2);
        return 1;
    }

    printf("Loaded %d rows from %s\n", loaded, TEST_FILE);

    /* 5. 验证数据一致性 */
    printf("\nVerifying data loaded correctly...\n");

    int errors = 0;

    /* 简单验证：检查所有数据都被加载 */
    QueryResult* all_data = ndtsdb_query_all(db2);
    if (!all_data) {
        fprintf(stderr, "Failed to query all data\n");
        errors++;
    } else {
        printf("✓ Loaded %u total rows\n", all_data->count);
        if (all_data->count != total_inserted) {
            fprintf(stderr, "Row count mismatch: expected %d, got %u\n",
                total_inserted, all_data->count);
            errors++;
        } else {
            printf("✓ Row count matches expected count\n");

            /* 检查一些样本行 */
            if (all_data->count > 0) {
                printf("✓ Sample data: timestamp=%ld, open=%.2f, trades=%u\n",
                    all_data->rows[0].timestamp,
                    all_data->rows[0].open,
                    all_data->rows[0].trades);
            }
        }
        ndtsdb_free_result(all_data);
    }

    ndtsdb_close(db2);

    if (errors == 0) {
        printf("\n✓ All tests passed!\n");
        return 0;
    } else {
        printf("\n✗ %d test(s) failed\n", errors);
        return 1;
    }
}
