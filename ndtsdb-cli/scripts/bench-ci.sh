#!/usr/bin/env bash
# ndtsdb-cli CI Performance Benchmark
# 运行性能基准测试，对比基准值，输出 JSON 结果

set -e

BINARY="${BINARY:-./zig-out/bin/ndtsdb-cli}"
BATCH_SIZE=50000
ITERATIONS=3
WRITE_BASELINE=500000   # 500k rows/s（CLI 场景实际基准）
READ_BASELINE=500000    # 500k rows/s
REGRESSION_THRESHOLD=0.10  # 10% 下降阈值

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 检查二进制是否存在
if [ ! -f "$BINARY" ]; then
    echo "[bench-ci] Error: Binary not found at $BINARY"
    echo "[bench-ci] Please build first: zig build -Doptimize=ReleaseFast"
    exit 1
fi

# 获取版本
VERSION=$($BINARY --help 2>/dev/null | head -1 | grep -o 'v[0-9]\+\.[0-9]\+\.[0-9]\+' || echo "unknown")

# 创建临时数据库
DB_DIR=$(mktemp -d)
trap "rm -rf $DB_DIR" EXIT

echo "[bench-ci] 运行性能基准测试..."
echo "[BENCH] === ndtsdb-cli Performance Benchmark ==="
echo "[BENCH] Batch size: $BATCH_SIZE rows"
echo "[BENCH] Iterations: $ITERATIONS"
echo "[BENCH] Baseline: write ≥${WRITE_BASELINE} rows/s, read ≥${READ_BASELINE} rows/s"
echo ""

# 准备测试数据
echo "[BENCH] Preparing test data..."
TEST_DATA_FILE=$(mktemp)
for i in $(seq 1 $BATCH_SIZE); do
    echo "{\"symbol\":\"BTC\",\"interval\":\"1m\",\"timestamp\":$i,\"open\":100.0,\"high\":110.0,\"low\":90.0,\"close\":105.0,\"volume\":1000.0}"
done > "$TEST_DATA_FILE"

# 存储每轮结果
WRITE_TIMES=()
READ_TIMES=()

for round in $(seq 1 $ITERATIONS); do
    echo "[BENCH] === Round $round/$ITERATIONS ==="
    
    # 清理数据库
    rm -rf "$DB_DIR"/*
    
    # Write benchmark
    START_TIME=$(date +%s%N)
    $BINARY write-json --database "$DB_DIR" < "$TEST_DATA_FILE" >/dev/null 2>&1
    END_TIME=$(date +%s%N)
    WRITE_MS=$(( (END_TIME - START_TIME) / 1000000 ))
    [ $WRITE_MS -eq 0 ] && WRITE_MS=1  # 避免除零
    WRITE_TIMES+=($WRITE_MS)
    echo "[BENCH] Write: $BATCH_SIZE rows in ${WRITE_MS}ms"
    
    # Read benchmark
    START_TIME=$(date +%s%N)
    $BINARY query --database "$DB_DIR" --symbol BTC --interval 1m >/dev/null 2>&1
    END_TIME=$(date +%s%N)
    READ_MS=$(( (END_TIME - START_TIME) / 1000000 ))
    [ $READ_MS -eq 0 ] && READ_MS=1
    READ_TIMES+=($READ_MS)
    echo "[BENCH] Read: $BATCH_SIZE rows in ${READ_MS}ms"
done

# 清理测试数据
rm -f "$TEST_DATA_FILE"

# 计算平均值
WRITE_SUM=0
READ_SUM=0
for t in "${WRITE_TIMES[@]}"; do WRITE_SUM=$((WRITE_SUM + t)); done
for t in "${READ_TIMES[@]}"; do READ_SUM=$((READ_SUM + t)); done
WRITE_AVG=$((WRITE_SUM / ITERATIONS))
READ_AVG=$((READ_SUM / ITERATIONS))

# 计算吞吐量 (rows/s)
WRITE_RPS=$((BATCH_SIZE * 1000 / WRITE_AVG))
READ_RPS=$((BATCH_SIZE * 1000 / READ_AVG))

# 获取二进制大小 (MB)
BINARY_SIZE=$(stat -c%s "$BINARY" 2>/dev/null || stat -f%z "$BINARY" 2>/dev/null || echo "0")
BINARY_SIZE_MB=$(awk "BEGIN{printf \"%.1f\", $BINARY_SIZE/1024/1024}")

echo ""
echo "========================================"
echo "BENCHMARK RESULTS"
echo "========================================"
printf "| %-12s | %-7s | %-8s | %-13s |\n" "Operation" "Rows" "Time(ms)" "Speed(rows/s)"
printf "| %-12s | %-7s | %-8s | %-13s |\n" "-------------" "---------" "----------" "---------------"
printf "| %-12s | %-7d | %-8d | %-13d |\n" "write batch" "$BATCH_SIZE" "$WRITE_AVG" "$WRITE_RPS"
printf "| %-12s | %-7d | %-8d | %-13d |\n" "read all" "$BATCH_SIZE" "$READ_AVG" "$READ_RPS"
echo "========================================"
echo ""
echo "--- Raw Data ---"
for i in $(seq 0 $((ITERATIONS-1))); do
    echo "Round $((i+1)): write=${WRITE_TIMES[$i]}ms, read=${READ_TIMES[$i]}ms"
done

# 判断是否通过基准
PASS="true"
FAIL_REASON=""

if [ $WRITE_RPS -lt $WRITE_BASELINE ]; then
    PASS="false"
    FAIL_REASON="${FAIL_REASON}write_rps($WRITE_RPS) < baseline($WRITE_BASELINE); "
fi

if [ $READ_RPS -lt $READ_BASELINE ]; then
    PASS="false"
    FAIL_REASON="${FAIL_REASON}read_rps($READ_RPS) < baseline($READ_BASELINE); "
fi

# 检查历史回归（如果有历史数据）
HISTORY_FILE="$HOME/.ndtsdb-cli/bench-history.jsonl"
if [ -f "$HISTORY_FILE" ]; then
    # 获取上次通过的基准值
    LAST_WRITE_RPS=$(tail -1 "$HISTORY_FILE" 2>/dev/null | grep -o '"write_rps":[0-9]*' | cut -d: -f2 || echo "0")
    LAST_READ_RPS=$(tail -1 "$HISTORY_FILE" 2>/dev/null | grep -o '"read_rps":[0-9]*' | cut -d: -f2 || echo "0")
    
    if [ -n "$LAST_WRITE_RPS" ] && [ -n "$LAST_READ_RPS" ] && [ "$LAST_WRITE_RPS" -gt 0 ] 2>/dev/null && [ "$LAST_READ_RPS" -gt 0 ] 2>/dev/null; then
        # 计算下降比例
        WRITE_DROP=$(awk "BEGIN{v=($LAST_WRITE_RPS-$WRITE_RPS)/$LAST_WRITE_RPS; print (v>$REGRESSION_THRESHOLD)?1:0}")
        READ_DROP=$(awk "BEGIN{v=($LAST_READ_RPS-$READ_RPS)/$LAST_READ_RPS; print (v>$REGRESSION_THRESHOLD)?1:0}")
        
        if [ "$WRITE_DROP" = "1" ]; then
            PASS="false"
            FAIL_REASON="${FAIL_REASON}write_rps regression >${REGRESSION_THRESHOLD}; "
        fi
        if [ "$READ_DROP" = "1" ]; then
            PASS="false"
            FAIL_REASON="${FAIL_REASON}read_rps regression >${REGRESSION_THRESHOLD}; "
        fi
    fi
fi

# 生成 JSON 结果
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
JSON_RESULT="{\"timestamp\":\"$TIMESTAMP\",\"version\":\"$VERSION\",\"batch_size\":$BATCH_SIZE,\"iterations\":$ITERATIONS,\"write_rps\":$WRITE_RPS,\"read_rps\":$READ_RPS,\"write_avg_ms\":$WRITE_AVG,\"read_avg_ms\":$READ_AVG,\"binary_size_mb\":$BINARY_SIZE_MB,\"pass\":$PASS}"

# 保存结果
mkdir -p "$HOME/.ndtsdb-cli"
echo "$JSON_RESULT" >> "$HISTORY_FILE"

echo ""
echo "[bench-ci] 写入吞吐量: $(printf '%'d $WRITE_RPS) rows/s"
echo "[bench-ci] 读取吞吐量: $(printf '%'d $READ_RPS) rows/s"
echo "[bench-ci] 二进制大小: ${BINARY_SIZE_MB}MB"
echo ""

if [ "$PASS" = "true" ]; then
    echo -e "${GREEN}[bench-ci] ✅ 基准测试通过${NC}"
    echo -e "${GREEN}[bench-ci] 结果已保存到 $HISTORY_FILE${NC}"
    EXIT_CODE=0
else
    echo -e "${RED}[bench-ci] ❌ 基准测试失败${NC}"
    echo -e "${RED}[bench-ci] 原因: $FAIL_REASON${NC}"
    EXIT_CODE=1
fi

echo ""
echo "[bench-ci] --- 本次运行摘要 ---"
echo "时间: $TIMESTAMP"
echo "版本: $VERSION"
echo "写入: $(printf '%'d $WRITE_RPS) rows/s"
echo "读取: $(printf '%'d $READ_RPS) rows/s"
echo "结果: $([ "$PASS" = "true" ] && echo "PASS" || echo "FAIL")"

exit $EXIT_CODE
