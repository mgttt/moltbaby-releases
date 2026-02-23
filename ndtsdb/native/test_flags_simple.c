#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ndtsdb.h"

int main() {
    char tmpdir[] = "/tmp/flags_test";
    mkdir(tmpdir, 0755);
    
    NDTSDB* db = ndtsdb_open(tmpdir);
    KlineRow row = { .timestamp = 1700000000000LL, .open = 100, .high = 110, .low = 90, .close = 105, .volume = 1000, .flags = 0x01 };
    ndtsdb_insert(db, "BTC", "1m", &row);
    ndtsdb_close(db);
    
    db = ndtsdb_open(tmpdir);
    QueryResult* qr = ndtsdb_query_all(db);
    printf("flags = 0x%X (expected 0x01)\n", qr->rows[0].flags);
    ndtsdb_free_result(qr);
    ndtsdb_close(db);
    return 0;
}
