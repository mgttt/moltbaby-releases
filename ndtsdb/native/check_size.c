#include <stdio.h>
#include "ndtsdb.h"

int main() {
    printf("sizeof(KlineRow) = %zu\n", sizeof(KlineRow));
    printf("  timestamp offset = %zu\n", __builtin_offsetof(KlineRow, timestamp));
    printf("  open offset = %zu\n", __builtin_offsetof(KlineRow, open));
    printf("  high offset = %zu\n", __builtin_offsetof(KlineRow, high));
    printf("  low offset = %zu\n", __builtin_offsetof(KlineRow, low));
    printf("  close offset = %zu\n", __builtin_offsetof(KlineRow, close));
    printf("  volume offset = %zu\n", __builtin_offsetof(KlineRow, volume));
    printf("  flags offset = %zu\n", __builtin_offsetof(KlineRow, flags));
    return 0;
}
