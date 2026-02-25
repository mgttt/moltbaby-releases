#!/bin/bash
# scripts/benchmark-quick.sh - 快速 benchmark（1万条）

set -euo pipefail

DB_PATH="./benchmark-quick-db"
NDTSDB_CLI="./ndtsdb-cli"

echo "=== NDTSDB 快速 Benchmark (10K vectors) ==="

# 清理
rm -rf "$DB_PATH"
mkdir -p "$DB_PATH"

# 生成 1万条 3072维向量
echo "[1/2] 写入 10,000 条向量..."
START=$(date +%s%N)

python3 << 'PYEOF' | $NDTSDB_CLI write-vector --database "$DB_PATH" 2>/dev/null
import json, random
for i in range(10000):
    vec = [round(random.uniform(-1, 1), 4) for _ in range(3072)]
    print(json.dumps({
        "timestamp": 1700000000000 + i,
        "agent_id": "test",
        "type": "semantic",
        "confidence": 0.9,
        "embedding": vec,
        "content": f"test {i}"
    }))
PYEOF

END=$(date +%s%N)
WRITE_MS=$(( (END - START) / 1000000 ))
WRITE_RPS=$(echo "scale=1; 10000 * 1000 / $WRITE_MS" | bc)

echo "Write time: ${WRITE_MS}ms"
echo "Write throughput: ${WRITE_RPS} rows/sec"

# 统计
echo ""
echo "[2/2] 统计..."
$NDTSDB_CLI info --database "$DB_PATH"
du -sh "$DB_PATH"

echo ""
echo "=== Summary ==="
echo "Vectors: 10,000 (3072-dim)"
echo "Write: ${WRITE_RPS} rows/sec"
