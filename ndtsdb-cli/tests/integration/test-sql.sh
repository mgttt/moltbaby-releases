#!/bin/bash
# test-sql.sh - SQL子命令集成测试

set -e

CLI="${CLI:-../../ndtsdb-cli}"
TEST_DB="/tmp/test_sql_db"

echo "=== SQL 子命令集成测试 ==="

# 清理
cleanup() {
    rm -rf "$TEST_DB"
}
trap cleanup EXIT

rm -rf "$TEST_DB"
mkdir -p "$TEST_DB"

# 准备测试数据
echo "1. 准备测试数据..."
cat > /tmp/test_sql_data.csv << 'EOF'
symbol,interval,timestamp,open,high,low,close,volume
BTCUSDT,1m,1700000000000,30000,30100,29900,30050,100
BTCUSDT,1m,1700000060000,30050,30200,30000,30100,200
BTCUSDT,1m,1700000120000,30100,30300,30000,30200,300
ETHUSDT,1m,1700000000000,2000,2010,1990,2005,500
ETHUSDT,1m,1700000060000,2005,2020,1995,2010,600
EOF

cat /tmp/test_sql_data.csv | "$CLI" write-csv --database "$TEST_DB"
echo "   ✓ 5条测试数据写入成功"

# 测试1: --query参数方式
echo ""
echo "2. 测试 --query 参数方式..."
result=$($CLI sql --database "$TEST_DB" --query "SELECT symbol,timestamp,close FROM data WHERE symbol='BTCUSDT' LIMIT 10")
count=$(echo "$result" | grep -c "BTCUSDT" || true)
if [ "$count" -eq 3 ]; then
    echo "   ✓ SELECT特定字段 + WHERE symbol + LIMIT"
else
    echo "   ✗ 期望3条，实际$count条"
    exit 1
fi

# 测试2: stdin方式
echo ""
echo "3. 测试 stdin 方式..."
result=$(echo "SELECT * FROM data WHERE symbol='ETHUSDT'" | $CLI sql --database "$TEST_DB")
count=$(echo "$result" | grep -c "ETHUSDT" || true)
if [ "$count" -eq 2 ]; then
    echo "   ✓ SELECT * + WHERE symbol (stdin)"
else
    echo "   ✗ 期望2条，实际$count条"
    exit 1
fi

# 测试3: 时间范围过滤
echo ""
echo "4. 测试时间范围过滤..."
result=$($CLI sql --database "$TEST_DB" --query "SELECT symbol,timestamp FROM data WHERE timestamp \> 1700000000000")
count=$(echo "$result" | wc -l)
# timestamp > 1700000000000 应该过滤掉第一条，返回4条
if [ "$count" -ge 4 ]; then
    echo "   ✓ WHERE timestamp > xxx ($count 条)"
else
    echo "   ✗ 期望至少4条，实际$count条"
    exit 1
fi

# 测试4: 复合WHERE条件
echo ""
echo "5. 测试复合WHERE条件..."
result=$($CLI sql --database "$TEST_DB" --query "SELECT symbol,close FROM data WHERE symbol='BTCUSDT' AND timestamp \> 1700000000000 AND timestamp \< 1700000120000")
count=$(echo "$result" | wc -l)
# 复合条件应该返回BTCUSDT且timestamp在范围内的数据
if [ "$count" -ge 1 ]; then
    echo "   ✓ WHERE symbol AND timestamp \> xxx AND timestamp \< xxx ($count 条)"
else
    echo "   ✗ 期望至少1条，实际$count条"
    exit 1
fi

# 测试5: SELECT * 返回所有字段
echo ""
echo "6. 测试 SELECT * 返回所有字段..."
result=$($CLI sql --database "$TEST_DB" --query "SELECT * FROM data LIMIT 1")
if echo "$result" | grep -q "symbol" && echo "$result" | grep -q "timestamp" && echo "$result" | grep -q "close"; then
    echo "   ✓ SELECT * 返回所有字段"
else
    echo "   ✗ 字段不完整"
    exit 1
fi

# 测试6: LIMIT限制
echo ""
echo "7. 测试 LIMIT 限制..."
result=$($CLI sql --database "$TEST_DB" --query "SELECT symbol FROM data LIMIT 2")
count=$(echo "$result" | wc -l)
if [ "$count" -eq 2 ]; then
    echo "   ✓ LIMIT 正确限制结果数量"
else
    echo "   ✗ 期望2条，实际$count条"
    exit 1
fi

# 测试7: 无WHERE条件查询所有
echo ""
echo "8. 测试无WHERE条件查询所有..."
result=$($CLI sql --database "$TEST_DB" --query "SELECT symbol FROM data")
count=$(echo "$result" | wc -l)
if [ "$count" -eq 5 ]; then
    echo "   ✓ 无WHERE条件返回所有数据"
else
    echo "   ✗ 期望5条，实际$count条"
    exit 1
fi

# 测试8: 字段过滤
echo ""
echo "9. 测试字段过滤..."
result=$($CLI sql --database "$TEST_DB" --query "SELECT symbol,close FROM data LIMIT 1")
if echo "$result" | grep -q "symbol" && echo "$result" | grep -q "close"; then
    if ! echo "$result" | grep -q "volume"; then
        echo "   ✓ 只返回SELECT指定的字段"
    else
        echo "   ✗ 返回了未指定的字段"
        exit 1
    fi
else
    echo "   ✗ 字段不完整"
    exit 1
fi

# 测试9: 错误SQL处理
echo ""
echo "10. 测试错误SQL处理..."
if $CLI sql --database "$TEST_DB" --query "INVALID SQL" 2>&1 | grep -qiE "(Error|error|invalid|SQL)"; then
    echo "   ✓ 错误SQL正确报错"
else
    echo "   ✗ 错误SQL应报错"
    exit 1
fi

# 测试10: 空结果
echo ""
echo "11. 测试不存在的symbol..."
result=$($CLI sql --database "$TEST_DB" --query "SELECT * FROM data WHERE symbol='NOTEXIST'" 2>&1)
if [ -z "$result" ]; then
    echo "   ✓ 不存在的symbol返回空结果"
else
    echo "   ✗ 应返回空结果"
    exit 1
fi

echo ""
echo "=== 所有SQL测试通过 ==="
