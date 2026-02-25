#!/bin/bash
# scripts/benchmark-1M.sh - 百万级向量写入 + COSINE_SIM 查询 benchmark

set -euo pipefail

DB_PATH="${1:-./benchmark-1m-db}"
NDTSDB_CLI="${NDTSDB_CLI:-./ndtsdb-cli}"
VECTOR_DIM=3072
BATCH_SIZE=1000
TOTAL_ROWS=1000000

echo "=== NDTSDB 百万级向量 Benchmark ==="
echo "Database: $DB_PATH"
echo "Vector dim: $VECTOR_DIM"
echo "Total rows: $TOTAL_ROWS"
echo ""

# 清理旧数据
rm -rf "$DB_PATH"
mkdir -p "$DB_PATH"

# 生成随机向量数据并写入
echo "[1/3] 生成并写入 $TOTAL_ROWS 条向量..."
START_TIME=$(date +%s.%N)

python3 << 'EOF' | "$NDTSDB_CLI" write-vector --database "$DB_PATH"
import sys
import json
import random

DIM = 3072
BATCH = 1000
TOTAL = 1000000

count = 0
for i in range(TOTAL):
    vec = [round(random.uniform(-1, 1), 6) for _ in range(DIM)]
    record = {
        "timestamp": 1700000000000 + i,
        "agent_id": f"agent-{i % 100}",
        "type": "semantic",
        "confidence": 0.9,
        "embedding": vec,
        "content": f"test content {i}"
    }
    print(json.dumps(record))
    count += 1
    if count % 10000 == 0:
        print(f"Generated {count}/{TOTAL}", file=sys.stderr)
EOF

END_TIME=$(date +%s.%N)
WRITE_TIME=$(echo "$END_TIME - $START_TIME" | bc)
WRITE_THROUGHPUT=$(echo "scale=2; $TOTAL_ROWS / $WRITE_TIME" | bc)

echo ""
echo "--- 写入结果 ---"
echo "Time: ${WRITE_TIME}s"
echo "Throughput: ${WRITE_THROUGHPUT} rows/sec"

# 统计磁盘占用
echo ""
echo "[2/3] 统计磁盘占用..."
DISK_USAGE=$(du -sh "$DB_PATH" | cut -f1)
echo "Disk usage: $DISK_USAGE"

# 统计内存占用（如果可能）
if command -v ps >/dev/null 2>&1; then
    echo "Memory: $(ps -o rss= -p $$ | awk '{print $1/1024 " MB"}')"
fi

# COSINE_SIM 查询测试
echo ""
echo "[3/3] COSINE_SIM 查询延迟测试..."

# 生成查询向量
QUERY_VEC=$(python3 -c "import random; print(','.join([str(round(random.uniform(-1,1),6)) for _ in range(3072)]))")

# 预热
$NDTSDB_CLI serve --database "$DB_PATH" --port 19999 &
SERVER_PID=$!
sleep 2

# 查询测试
START_TIME=$(date +%s%N)
curl -s "http://localhost:19999/query-vectors?embedding=$QUERY_VEC&threshold=0.7&limit=10" > /dev/null
END_TIME=$(date +%s%N)

QUERY_LAT_MS=$(echo "scale=3; ($END_TIME - $START_TIME) / 1000000" | bc)

kill $SERVER_PID 2>/dev/null || true

echo ""
echo "--- 查询结果 ---"
echo "Query latency: ${QUERY_LAT_MS}ms"

# 输出汇总
echo ""
echo "=== Benchmark Summary ==="
echo "Write throughput: ${WRITE_THROUGHPUT} rows/sec"
echo "Query latency: ${QUERY_LAT_MS}ms"
echo "Disk usage: $DISK_USAGE"
echo ""
