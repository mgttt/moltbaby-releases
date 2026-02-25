#!/bin/bash
# test-sql-groupby.sh - SQL GROUP BY + ORDER BY 集成测试

set -e

CLI="${CLI:-../../ndtsdb-cli}"
DB_DIR="/tmp/test-sql-groupby-db-$$"

# 清理函数
cleanup() {
    rm -rf "$DB_DIR"
}
trap cleanup EXIT

# 创建测试数据库
mkdir -p "$DB_DIR"

# 准备测试数据 - 多个symbol，多个interval
cat << 'EOF' | $CLI write-json --database "$DB_DIR"
{"symbol":"BTC","interval":"1m","timestamp":1000,"open":100,"high":110,"low":90,"close":105,"volume":1000}
{"symbol":"BTC","interval":"1m","timestamp":2000,"open":105,"high":115,"low":95,"close":110,"volume":2000}
{"symbol":"BTC","interval":"1m","timestamp":3000,"open":110,"high":120,"low":100,"close":115,"volume":1500}
{"symbol":"ETH","interval":"1m","timestamp":1000,"open":50,"high":55,"low":45,"close":52,"volume":500}
{"symbol":"ETH","interval":"1m","timestamp":2000,"open":52,"high":58,"low":48,"close":55,"volume":800}
{"symbol":"ETH","interval":"1m","timestamp":3000,"open":55,"high":60,"low":50,"close":58,"volume":600}
{"symbol":"BTC","interval":"5m","timestamp":1000,"open":100,"high":120,"low":90,"close":110,"volume":5000}
{"symbol":"ETH","interval":"5m","timestamp":1000,"open":50,"high":60,"low":45,"close":55,"volume":2000}
EOF

echo "=== 测试数据准备完成 ==="

# 测试1: 基本 GROUP BY COUNT
echo ""
echo "Test 1: SELECT symbol, COUNT(*) FROM data GROUP BY symbol"
RESULT=$($CLI sql --database "$DB_DIR" --query 'SELECT symbol, COUNT(*) FROM data GROUP BY symbol')
echo "$RESULT"

# 验证: BTC应该3条，ETH应该3条（1m各3条，5m各1条，总共BTC=4, ETH=4）
BTC_COUNT=$(echo "$RESULT" | grep '"symbol":"BTC"' | grep -o '"COUNT[(][*][)]":[0-9]*' | cut -d: -f2)
ETH_COUNT=$(echo "$RESULT" | grep '"symbol":"ETH"' | grep -o '"COUNT[(][*][)]":[0-9]*' | cut -d: -f2)

if [ "$BTC_COUNT" = "4" ] && [ "$ETH_COUNT" = "4" ]; then
    echo "✓ Test 1 PASSED"
else
    echo "✗ Test 1 FAILED: Expected BTC=4, ETH=4, got BTC=$BTC_COUNT, ETH=$ETH_COUNT"
    exit 1
fi

# 测试2: GROUP BY + ORDER BY DESC
echo ""
echo "Test 2: SELECT symbol, AVG(close) FROM data GROUP BY symbol ORDER BY AVG(close) DESC"
RESULT=$($CLI sql --database "$DB_DIR" --query 'SELECT symbol, AVG(close) FROM data GROUP BY symbol ORDER BY AVG(close) DESC')
echo "$RESULT"

# 验证: BTC平均close > ETH平均close，所以BTC应该在前面
FIRST_SYMBOL=$(echo "$RESULT" | head -1 | grep -o '"symbol":"[^"]*"' | cut -d'"' -f4)
if [ "$FIRST_SYMBOL" = "BTC" ]; then
    echo "✓ Test 2 PASSED"
else
    echo "✗ Test 2 FAILED: Expected BTC first, got $FIRST_SYMBOL"
    exit 1
fi

# 测试3: WHERE + ORDER BY (无GROUP BY)
echo ""
echo "Test 3: SELECT * FROM data WHERE symbol='BTC' ORDER BY timestamp DESC LIMIT 5"
RESULT=$($CLI sql --database "$DB_DIR" --query 'SELECT * FROM data WHERE symbol="BTC" ORDER BY timestamp DESC LIMIT 5')
echo "$RESULT"

# 验证: 应该只有BTC数据，且按timestamp降序
BTC_ROWS=$(echo "$RESULT" | grep -c '"symbol":"BTC"' || true)
if [ "$BTC_ROWS" -eq 4 ]; then
    echo "✓ Test 3 PASSED (4 BTC rows)"
else
    echo "✗ Test 3 FAILED: Expected 4 BTC rows, got $BTC_ROWS"
    exit 1
fi

# 测试4: GROUP BY interval
echo ""
echo "Test 4: SELECT interval, COUNT(*) FROM data GROUP BY interval"
RESULT=$($CLI sql --database "$DB_DIR" --query 'SELECT interval, COUNT(*) FROM data GROUP BY interval')
echo "$RESULT"

# 验证: 1m应该有6条，5m应该有2条
COUNT_1M=$(echo "$RESULT" | grep '"interval":"1m"' | grep -o '"COUNT[(][*][)]":[0-9]*' | cut -d: -f2)
COUNT_5M=$(echo "$RESULT" | grep '"interval":"5m"' | grep -o '"COUNT[(][*][)]":[0-9]*' | cut -d: -f2)

if [ "$COUNT_1M" = "6" ] && [ "$COUNT_5M" = "2" ]; then
    echo "✓ Test 4 PASSED"
else
    echo "✗ Test 4 FAILED: Expected 1m=6, 5m=2, got 1m=$COUNT_1M, 5m=$COUNT_5M"
    exit 1
fi

# 测试5: SUM聚合
echo ""
echo "Test 5: SELECT symbol, SUM(volume) FROM data GROUP BY symbol"
RESULT=$($CLI sql --database "$DB_DIR" --query 'SELECT symbol, SUM(volume) FROM data GROUP BY symbol')
echo "$RESULT"

# 测试6: MIN/MAX聚合
echo ""
echo "Test 6: SELECT symbol, MIN(low), MAX(high) FROM data GROUP BY symbol"
RESULT=$($CLI sql --database "$DB_DIR" --query 'SELECT symbol, MIN(low), MAX(high) FROM data GROUP BY symbol')
echo "$RESULT"

# 测试7: ORDER BY普通字段 (WHERE只支持symbol)
echo ""
echo "Test 7: SELECT * FROM data WHERE symbol='BTC' ORDER BY timestamp ASC"
RESULT=$($CLI sql --database "$DB_DIR" --query 'SELECT * FROM data WHERE symbol="BTC" ORDER BY timestamp ASC')
echo "$RESULT"

# 验证: 应该按timestamp升序
FIRST_TS=$(echo "$RESULT" | head -1 | grep -o '"timestamp":[0-9]*' | cut -d: -f2)
if [ "$FIRST_TS" = "1000" ]; then
    echo "✓ Test 7 PASSED"
else
    echo "✗ Test 7 FAILED: Expected first timestamp=1000, got $FIRST_TS"
    exit 1
fi

# 测试8: 复杂组合 - GROUP BY + ORDER BY + LIMIT
echo ""
echo "Test 8: SELECT symbol, AVG(close) as avg_close FROM data GROUP BY symbol ORDER BY avg_close DESC LIMIT 1"
RESULT=$($CLI sql --database "$DB_DIR" --query 'SELECT symbol, AVG(close) as avg_close FROM data GROUP BY symbol ORDER BY avg_close DESC LIMIT 1')
echo "$RESULT"

ROW_COUNT=$(echo "$RESULT" | grep -c '"symbol"' || true)
if [ "$ROW_COUNT" -eq 1 ]; then
    echo "✓ Test 8 PASSED (LIMIT 1 works)"
else
    echo "✗ Test 8 FAILED: Expected 1 row, got $ROW_COUNT"
    exit 1
fi

# 测试9: 带聚合函数的GROUP BY (单字段)
echo ""
echo "Test 9: SELECT interval, AVG(close) FROM data GROUP BY interval"
RESULT=$($CLI sql --database "$DB_DIR" --query 'SELECT interval, AVG(close) FROM data GROUP BY interval')
echo "$RESULT"

# 验证: 应该有2个interval (1m, 5m)
ROW_COUNT=$(echo "$RESULT" | grep -c '"interval"' || true)
if [ "$ROW_COUNT" -eq 2 ]; then
    echo "✓ Test 9 PASSED (2 interval groups)"
else
    echo "✗ Test 9 FAILED: Expected 2 groups, got $ROW_COUNT"
    exit 1
fi

# 测试10: 无GROUP BY的ORDER BY
echo ""
echo "Test 10: SELECT * FROM data ORDER BY volume DESC LIMIT 3"
RESULT=$($CLI sql --database "$DB_DIR" --query 'SELECT * FROM data ORDER BY volume DESC LIMIT 3')
echo "$RESULT"

ROW_COUNT=$(echo "$RESULT" | grep -c '"symbol"' || true)
if [ "$ROW_COUNT" -eq 3 ]; then
    echo "✓ Test 10 PASSED"
else
    echo "✗ Test 10 FAILED: Expected 3 rows, got $ROW_COUNT"
    exit 1
fi

echo ""
echo "======================================"
echo "所有测试通过！"
echo "======================================"
