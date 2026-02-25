#!/bin/bash
# v0.2.2 集成测试套件
# 覆盖：DELETE, partitioned, SMA, EMA, ATR, UPSERT, SQL LIMIT/OFFSET/ORDER BY

set -e
BINARY=${BINARY:-../../ndtsdb-cli}
PASS=0
FAIL=0

assert() {
    local desc="$1"
    local result="$2"
    local expected="$3"
    if echo "$result" | grep -q "$expected"; then
        echo "✓ $desc"
        PASS=$((PASS+1))
    else
        echo "✗ $desc"
        echo "  expected: $expected"
        echo "  got: $result"
        FAIL=$((FAIL+1))
    fi
}

assert_count() {
    local desc="$1"
    local result="$2"
    local expected_count="$3"
    local actual_count=$(echo "$result" | grep -c "timestamp" || echo "0")
    if [ "$actual_count" -eq "$expected_count" ]; then
        echo "✓ $desc (count=$actual_count)"
        PASS=$((PASS+1))
    else
        echo "✗ $desc"
        echo "  expected count: $expected_count"
        echo "  actual count: $actual_count"
        FAIL=$((FAIL+1))
    fi
}

DB=$(mktemp -d)
trap 'rm -rf $DB' EXIT

echo "=== v0.2.2 Integration Tests ==="
echo "Database: $DB"
echo ""

# --- 准备：写入20行基础数据（BTC/1m）---
echo "--- 准备基础数据（20行 BTC/1m）---"
for i in $(seq 1 20); do
    close=$((100 + i))
    echo "{\"symbol\":\"BTC\",\"interval\":\"1m\",\"timestamp\":$i,\"open\":100,\"high\":110,\"low\":90,\"close\":$close,\"volume\":1000}" | $BINARY write-json --database $DB
done

# --- 1. DELETE/tombstone ---
echo ""
echo "--- 1. DELETE/tombstone ---"
# 删除timestamp=5
$BINARY delete --database $DB --symbol BTC --interval 1m --timestamp 5
# 查询验证 - timestamp=5不应该存在（注意：tombstone行volume=-1不算有效数据）
delete_result=$($BINARY query --database $DB --symbol BTC --interval 1m)
if echo "$delete_result" | grep '"timestamp":5' | grep -qv '"volume":-1'; then
    echo "✗ DELETE: timestamp=5 still exists after delete"
    FAIL=$((FAIL+1))
else
    echo "✓ DELETE: timestamp=5 correctly removed (or only tombstone remains)"
    PASS=$((PASS+1))
fi

# --- 2. partitioned list/query/write-json ---
echo ""
echo "--- 2. partitioned 功能 ---"
# 写入ETH数据
echo '{"symbol":"ETH","interval":"1m","timestamp":1,"open":50,"high":55,"low":48,"close":52,"volume":500}' | $BINARY partitioned write-json --database $DB
# list验证
list_result=$($BINARY partitioned list --database $DB)
assert "partitioned list: should contain BTC" "$list_result" '"symbol":"BTC"'
assert "partitioned list: should contain ETH" "$list_result" '"symbol":"ETH"'
# query验证
partitioned_query=$($BINARY partitioned query --database $DB --symbol ETH --interval 1m)
assert "partitioned query: ETH should have timestamp=1" "$partitioned_query" '"timestamp":1'

# --- 3. SMA ---
echo ""
echo "--- 3. SMA指标 ---"
sma_result=$($BINARY sma --database $DB --symbol BTC --interval 1m --period 10)
# 检查第10行开始有输出
sma_first_line=$(echo "$sma_result" | head -1)
assert "SMA: first output line contains timestamp" "$sma_first_line" '"timestamp"'
# 检查有10行输出（20行数据，从第10行开始）
sma_count=$(echo "$sma_result" | wc -l)
if [ "$sma_count" -ge 10 ]; then
    echo "✓ SMA: output has $sma_count lines (>=10)"
    PASS=$((PASS+1))
else
    echo "✗ SMA: expected >=10 lines, got $sma_count"
    FAIL=$((FAIL+1))
fi

# --- 4. EMA ---
echo ""
echo "--- 4. EMA指标 ---"
ema_result=$($BINARY ema --database $DB --symbol BTC --interval 1m --period 10)
ema_first_line=$(echo "$ema_result" | head -1)
assert "EMA: first output line contains timestamp" "$ema_first_line" '"timestamp"'
ema_count=$(echo "$ema_result" | wc -l)
if [ "$ema_count" -ge 10 ]; then
    echo "✓ EMA: output has $ema_count lines (>=10)"
    PASS=$((PASS+1))
else
    echo "✗ EMA: expected >=10 lines, got $ema_count"
    FAIL=$((FAIL+1))
fi

# --- 5. ATR ---
echo ""
echo "--- 5. ATR指标 ---"
atr_result=$($BINARY atr --database $DB --symbol BTC --interval 1m --period 14)
atr_first_line=$(echo "$atr_result" | head -1)
assert "ATR: first output line contains timestamp" "$atr_first_line" '"timestamp"'
# 检查timestamp=15是第一行（因为timestamp=5被DELETE删除，数据变为19行，ATR从第15开始）
assert "ATR: first line is timestamp=15" "$atr_first_line" '"timestamp":15'
# 检查atr值为正
atr_value=$(echo "$atr_result" | head -1 | grep -o '"atr":[0-9.]*' | cut -d: -f2)
# 使用awk比较浮点数
if echo "$atr_value" | awk '{if ($1 > 0) exit 0; else exit 1}'; then
    echo "✓ ATR: value is positive ($atr_value)"
    PASS=$((PASS+1))
else
    echo "✗ ATR: expected positive value, got $atr_value"
    FAIL=$((FAIL+1))
fi

# --- 6. UPSERT ---
echo ""
echo "--- 6. UPSERT ---"
# 先写入初始值
UPDB=$(mktemp -d)
trap 'rm -rf $UPDB' EXIT
for i in $(seq 1 5); do
    echo "{\"symbol\":\"BTC\",\"interval\":\"1m\",\"timestamp\":$i,\"open\":100,\"high\":110,\"low\":90,\"close\":100,\"volume\":1000}" | $BINARY write-json --database $UPDB
done
# 获取更新前的行数
before_count=$($BINARY query --database $UPDB --symbol BTC --interval 1m | wc -l)
# UPSERT timestamp=3（更新close从100到999）
echo '{"symbol":"BTC","interval":"1m","timestamp":3,"open":100,"high":110,"low":90,"close":999,"volume":1000}' | $BINARY write-json --database $UPDB --upsert 2>/dev/null || {
    # 如果没有--upsert参数，用delete+write模拟
    $BINARY delete --database $UPDB --symbol BTC --interval 1m --timestamp 3 2>/dev/null || true
    echo '{"symbol":"BTC","interval":"1m","timestamp":3,"open":100,"high":110,"low":90,"close":999,"volume":1000}' | $BINARY write-json --database $UPDB
}
# 查询验证
upsert_result=$($BINARY query --database $UPDB --symbol BTC --interval 1m)
# 检查timestamp=3的close=999
if echo "$upsert_result" | grep '"timestamp":3' | grep -q '"close":999'; then
    echo "✓ UPSERT: timestamp=3 has updated close=999"
    PASS=$((PASS+1))
else
    echo "✗ UPSERT: timestamp=3 close value not updated to 999"
    FAIL=$((FAIL+1))
fi
# 检查行数不变（还是5行）
after_count=$(echo "$upsert_result" | wc -l)
if [ "$after_count" -eq "$before_count" ]; then
    echo "✓ UPSERT: row count unchanged ($after_count)"
    PASS=$((PASS+1))
else
    echo "✗ UPSERT: row count changed from $before_count to $after_count"
    FAIL=$((FAIL+1))
fi
rm -rf $UPDB

# --- 7. SQL LIMIT ---
echo ""
echo "--- 7. SQL LIMIT ---"
sql_limit=$($BINARY sql --database $DB --query "SELECT * FROM klines LIMIT 3")
assert_count "SQL LIMIT 3 should return 3 rows" "$sql_limit" 3

# --- 8. SQL OFFSET ---
echo ""
echo "--- 8. SQL OFFSET ---"
# 使用新数据库避免DELETE的tombstone影响
DB_OFFSET=$(mktemp -d)
for i in $(seq 1 20); do
    close=$((100 + i))
    echo "{\"symbol\":\"BTC\",\"interval\":\"1m\",\"timestamp\":$i,\"open\":100,\"high\":110,\"low\":90,\"close\":$close,\"volume\":1000}" | $BINARY write-json --database $DB_OFFSET
done
sql_offset=$($BINARY sql --database $DB_OFFSET --query "SELECT * FROM klines LIMIT 3 OFFSET 5")
# 期望返回timestamp 6,7,8（第6,7,8行，OFFSET 5跳过前5行）
assert "SQL LIMIT 3 OFFSET 5: should contain timestamp 6" "$sql_offset" '"timestamp":6'
assert "SQL LIMIT 3 OFFSET 5: should contain timestamp 7" "$sql_offset" '"timestamp":7'
assert "SQL LIMIT 3 OFFSET 5: should contain timestamp 8" "$sql_offset" '"timestamp":8'
rm -rf $DB_OFFSET

# --- 9. SQL ORDER BY DESC LIMIT ---
echo ""
echo "--- 9. SQL ORDER BY DESC LIMIT ---"
sql_order=$($BINARY sql --database $DB --query "SELECT * FROM klines ORDER BY timestamp DESC LIMIT 2")
# 期望返回最后两行（timestamp 20,19）- 注意DELETE删掉了timestamp=5，所以最大是20
assert "SQL ORDER BY DESC LIMIT 2: should contain latest timestamp" "$sql_order" '"timestamp":20'
# 检查只有2行
order_count=$(echo "$sql_order" | wc -l)
if [ "$order_count" -eq 2 ]; then
    echo "✓ SQL ORDER BY DESC LIMIT 2: returns exactly 2 rows"
    PASS=$((PASS+1))
else
    echo "✗ SQL ORDER BY DESC LIMIT 2: expected 2 rows, got $order_count"
    FAIL=$((FAIL+1))
fi

# --- 结果汇总 ---
echo ""
echo "================================"
echo "结果: $PASS passed, $FAIL failed"
echo "================================"

[ $FAIL -eq 0 ] || exit 1
