#!/bin/bash
# ============================================================
# 并发写入测试脚本
# 验证两个并发 write-json 进程不会互相撕裂数据
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
CLI="$CLI_DIR/ndtsdb-cli"
TEST_DB="/tmp/test-concurrent-$$"

echo "=== ndtsdb-cli 并发写入测试 ==="
echo "测试数据库: $TEST_DB"
echo "CLI 路径: $CLI"
echo ""

# 清理函数
cleanup() {
    echo "清理测试数据..."
    rm -rf "$TEST_DB"
}
trap cleanup EXIT

# 准备测试数据
echo "[1/5] 准备测试数据..."
mkdir -p "$TEST_DB"

# 生成 100 条测试数据（进程 A）
for i in $(seq 1 100); do
    ts=$((1700000000000 + i * 60000))
    echo '{"symbol":"BTCUSDT","interval":"1m","timestamp":'$ts',"open":100.0,"high":101.0,"low":99.0,"close":100.5,"volume":1.0}'
done > /tmp/test-data-a-$$.jsonl

# 生成 100 条测试数据（进程 B）
for i in $(seq 1 100); do
    ts=$((1700000000000 + (i + 100) * 60000))
    echo '{"symbol":"ETHUSDT","interval":"1m","timestamp":'$ts',"open":200.0,"high":201.0,"low":199.0,"close":200.5,"volume":2.0}'
done > /tmp/test-data-b-$$.jsonl

echo "  - 进程A数据: 100 条 BTCUSDT"
echo "  - 进程B数据: 100 条 ETHUSDT"

# 并发写入测试
echo ""
echo "[2/5] 启动并发写入..."
echo "  - 两个 write-json 进程同时写入同一数据库"

# 后台启动两个写入进程
$CLI write-json --database "$TEST_DB" < /tmp/test-data-a-$$.jsonl &
PID_A=$!

$CLI write-json --database "$TEST_DB" < /tmp/test-data-b-$$.jsonl &
PID_B=$!

echo "  - 进程A PID: $PID_A"
echo "  - 进程B PID: $PID_B"

# 等待两个进程完成
echo "  - 等待进程完成..."
wait $PID_A
EXIT_A=$?
wait $PID_B
EXIT_B=$?

echo "  - 进程A退出码: $EXIT_A"
echo "  - 进程B退出码: $EXIT_B"

# 验证结果
echo ""
echo "[3/5] 验证数据完整性..."

# 查询总行数
echo "  - 查询数据库..."
ROW_COUNT=$($CLI query --database "$TEST_DB" --format json 2>/dev/null | wc -l)
echo "  - 数据库总行数: $ROW_COUNT"

# 验证
echo ""
echo "[4/5] 验证结果..."

PASS=true

if [ "$ROW_COUNT" -ne 200 ]; then
    echo "  ❌ 总行数错误: 期望 200, 实际 $ROW_COUNT"
    PASS=false
else
    echo "  ✅ 总行数正确: $ROW_COUNT"
fi

# 使用 list 子命令获取 symbol 统计
echo ""
echo "  - 获取 symbol 统计..."
SYMBOL_STATS=$($CLI list --database "$TEST_DB" 2>/dev/null)
echo "  - Symbol 分布: $SYMBOL_STATS"

# 检查是否同时包含 BTCUSDT 和 ETHUSDT
if echo "$SYMBOL_STATS" | grep -q "BTCUSDT" && echo "$SYMBOL_STATS" | grep -q "ETHUSDT"; then
    echo "  ✅ 同时包含 BTCUSDT 和 ETHUSDT"
else
    echo "  ❌ 缺少某些 symbol"
    PASS=false
fi

# 检查数据是否损坏（尝试解析所有 JSON）
echo ""
echo "[5/5] 检查数据格式..."
INVALID_COUNT=$($CLI query --database "$TEST_DB" --format json 2>/dev/null | while read line; do
    if ! echo "$line" | jq -e . >/dev/null 2>&1; then
        echo "INVALID"
    fi
done | wc -l)

if [ "$INVALID_COUNT" -gt 0 ]; then
    echo "  ❌ 发现 $INVALID_COUNT 条无效数据"
    PASS=false
else
    echo "  ✅ 所有数据格式正确"
fi

# 清理临时文件
rm -f /tmp/test-data-a-$$.jsonl /tmp/test-data-b-$$.jsonl

# 最终结果
echo ""
echo "========================================"
if [ "$PASS" = true ]; then
    echo "✅ 并发写入测试通过"
    echo "========================================"
    exit 0
else
    echo "❌ 并发写入测试失败"
    echo "========================================"
    exit 1
fi
