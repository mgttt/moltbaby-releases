/**
 * test-flags-persist.c — KlineRow.flags 持久化测试
 *
 * 编译: gcc -o test-flags-persist test-flags-persist.c ../ndts.c -lm
 * 运行: ./test-flags-persist
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include "ndtsdb.h"

int main(void)
{
    printf("=== KlineRow.flags 持久化测试 ===\n\n");

    char tmpdir[] = "/tmp/flags_test_XXXXXX";
    if (!mkdtemp(tmpdir)) {
        perror("mkdtemp"); return 1;
    }
    printf("测试目录: %s\n", tmpdir);

    /* 写入带 flags 的数据 */
    NDTSDB* db = ndtsdb_open(tmpdir);
    if (!db) { fprintf(stderr, "open failed\n"); return 1; }

    KlineRow rows[3] = {
        { .timestamp = 1700000000000LL, .open = 100, .high = 110, .low = 90, .close = 105, .volume = 1000, .flags = 0x01 },
        { .timestamp = 1700000001000LL, .open = 105, .high = 115, .low = 95, .close = 110, .volume = 2000, .flags = 0x02 },
        { .timestamp = 1700000002000LL, .open = 110, .high = 120, .low = 100, .close = 115, .volume = 3000, .flags = 0xFF }
    };

    int inserted = ndtsdb_insert_batch(db, "BTC", "1m", rows, 3);
    printf("插入 %d 行 (flags: 0x01, 0x02, 0xFF)\n", inserted);

    ndtsdb_close(db);

    /* 重新打开并读取 */
    db = ndtsdb_open(tmpdir);
    if (!db) { fprintf(stderr, "reopen failed\n"); return 1; }

    /* 使用 ndtsdb_query 而不是 query_all */
    Query q = { .symbol = "BTC", .interval = "1m", .startTime = 0, .endTime = INT64_MAX, .limit = 0 };
    QueryResult* qr = ndtsdb_query(db, &q);
    if (!qr) { fprintf(stderr, "query failed\n"); ndtsdb_close(db); return 1; }

    printf("读取 %u 行\n", qr->count);

    int pass = 0, fail = 0;
    for (uint32_t i = 0; i < qr->count; i++) {
        uint32_t expected = (i == 0) ? 0x01 : (i == 1) ? 0x02 : 0xFF;
        if (qr->rows[i].flags == expected) {
            printf("  ✓ row[%u]: flags=0x%02X (expected 0x%02X)\n", i, qr->rows[i].flags, expected);
            pass++;
        } else {
            printf("  ✗ row[%u]: flags=0x%02X (expected 0x%02X)\n", i, qr->rows[i].flags, expected);
            fail++;
        }
    }

    ndtsdb_free_result(qr);
    ndtsdb_close(db);

    printf("\n================================\n");
    printf("结果: %d passed, %d failed\n", pass, fail);
    printf("================================\n");

    return fail > 0 ? 1 : 0;
}
