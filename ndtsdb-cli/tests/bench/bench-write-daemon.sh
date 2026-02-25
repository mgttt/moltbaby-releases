#!/bin/bash
# bench-write-daemon.sh - 测试 write-json --daemon 性能

set -e

cd "$(dirname "$0")/../.."
DB_PATH="/tmp/bench_daemon_db"

cleanup() {
    rm -rf "$DB_PATH"
    rm -f /tmp/bench_data.jsonl
}
trap cleanup EXIT

echo "=== write-json --daemon 性能测试 ==="

# 准备数据库
mkdir -p "$DB_PATH"

# 生成10万行测试数据
echo "生成10万行测试数据..."
python3 <<'PYEOF'
import json
import sys

for i in range(100000):
    row = {
        "symbol": "BTCUSDT",
        "interval": "1m",
        "timestamp": 1700000000000 + i * 60000,
        "open": 100.0 + (i % 10),
        "high": 110.0 + (i % 10),
        "low": 95.0 + (i % 10),
        "close": 105.0 + (i % 10),
        "volume": 1000 + (i % 100)
    }
    print(json.dumps(row))
PYEOF
> /tmp/bench_data.jsonl

DATA_SIZE=$(wc -l < /tmp/bench_data.jsonl)
echo "数据行数: $DATA_SIZE"

# 测试普通模式
echo ""
echo "测试普通模式..."
rm -rf "$DB_PATH" && mkdir -p "$DB_PATH"
START=$(date +%s%N)
./ndtsdb-cli write-json --database "$DB_PATH" < /tmp/bench_data.jsonl
END=$(date +%s%N)
DURATION=$(( (END - START) / 1000000 ))  # ms
RATE=$(( DATA_SIZE * 1000 / DURATION ))
echo "普通模式: ${DURATION}ms, ${RATE} rows/s"

# 测试daemon模式
echo ""
echo "测试daemon模式..."
rm -rf "$DB_PATH" && mkdir -p "$DB_PATH"
START=$(date +%s%N)
./ndtsdb-cli write-json --database "$DB_PATH" --daemon < /tmp/bench_data.jsonl 2>/dev/null
END=$(date +%s%N)
DURATION=$(( (END - START) / 1000000 ))  # ms
RATE=$(( DATA_SIZE * 1000 / DURATION ))
echo "Daemon模式: ${DURATION}ms, ${RATE} rows/s"

echo ""
echo "目标: >= 800K rows/s"
