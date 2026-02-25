#!/usr/bin/env bash
# tools/benchmark.sh — ndtsdb-cli 性能基准测试
# 用法: bash tools/benchmark.sh [N_ROWS]
# 默认 N_ROWS=10000

set -e
BINARY=${BINARY:-./zig-out/bin/ndtsdb-cli}
N=${1:-10000}
DB=$(mktemp -d)
trap 'rm -rf $DB /tmp/bench_data.jsonl 2>/dev/null' EXIT

echo "=== ndtsdb-cli 性能基准 (N=$N) ==="
echo ""

# 1. 生成测试数据
python3 -c "
import json, sys
n = $N
for i in range(n):
    row = {
        'symbol': 'BENCH',
        'interval': '1m',
        'timestamp': i + 1,
        'open': 100.0 + (i % 50),
        'high': 110.0 + (i % 50),
        'low':  90.0  + (i % 50),
        'close': 100.0 + (i % 100),
        'volume': 1000.0 + (i % 500)
    }
    print(json.dumps(row))
" > /tmp/bench_data.jsonl

# 2. write-json
echo "[1] write-json ($N rows)"
START_NS=$(date +%s%N)
WRITE_OUT=$(cat /tmp/bench_data.jsonl | $BINARY write-json --database $DB 2>&1)
INSERTED=$(echo "$WRITE_OUT" | grep -o "Inserted [0-9]* rows" | grep -o "[0-9]* rows")
END_NS=$(date +%s%N)
ELAPSED_MS=$(( (END_NS - START_NS) / 1000000 ))
RATE=$(( N * 1000 / (ELAPSED_MS + 1) ))
echo "  $INSERTED in ${ELAPSED_MS}ms → ${RATE} rows/s"
echo ""

# 3. query all
echo "[2] query all ($N rows)"
START_NS=$(date +%s%N)
COUNT=$($BINARY query --database $DB --symbol BENCH --interval 1m 2>/dev/null | wc -l | tr -d " ")
END_NS=$(date +%s%N)
ELAPSED_MS=$(( (END_NS - START_NS) / 1000000 ))
RATE=$(( COUNT * 1000 / (ELAPSED_MS + 1) ))
echo "  $COUNT rows in ${ELAPSED_MS}ms → ${RATE} rows/s"
echo ""

# 4. SQL COUNT/AVG/STDDEV
echo "[3] SQL aggregates (COUNT/AVG/MIN/MAX/STDDEV/CORR)"
START_NS=$(date +%s%N)
$BINARY sql --database $DB --query \
  "SELECT COUNT(*), AVG(close) AS avg, MIN(close) AS lo, MAX(close) AS hi, STDDEV(close) AS std FROM data WHERE symbol='BENCH'" \
  > /dev/null
END_NS=$(date +%s%N)
ELAPSED_MS=$(( (END_NS - START_NS) / 1000000 ))
echo "  ${ELAPSED_MS}ms (scanned $N rows)"
echo ""

# 5. SMA 20
echo "[4] SMA period=20 ($N rows)"
START_NS=$(date +%s%N)
SMA_ROWS=$($BINARY sma --database $DB --symbol BENCH --interval 1m --period 20 2>/dev/null | wc -l | tr -d " ")
END_NS=$(date +%s%N)
ELAPSED_MS=$(( (END_NS - START_NS) / 1000000 ))
RATE=$(( SMA_ROWS * 1000 / (ELAPSED_MS + 1) ))
echo "  $SMA_ROWS output rows in ${ELAPSED_MS}ms → ${RATE} rows/s"
echo ""

# 6. tail
echo "[5] tail --n 100"
START_NS=$(date +%s%N)
$BINARY tail --database $DB --symbol BENCH --interval 1m --n 100 > /dev/null
END_NS=$(date +%s%N)
ELAPSED_MS=$(( (END_NS - START_NS) / 1000000 ))
echo "  ${ELAPSED_MS}ms"
echo ""

# 7. export JSONL
echo "[6] export JSONL ($N rows)"
START_NS=$(date +%s%N)
EXPORT_ROWS=$($BINARY export --database $DB --symbol BENCH 2>/dev/null | wc -l | tr -d " ")
END_NS=$(date +%s%N)
ELAPSED_MS=$(( (END_NS - START_NS) / 1000000 ))
RATE=$(( EXPORT_ROWS * 1000 / (ELAPSED_MS + 1) ))
echo "  $EXPORT_ROWS rows in ${ELAPSED_MS}ms → ${RATE} rows/s"
echo ""

echo "=== 完成 ==="
