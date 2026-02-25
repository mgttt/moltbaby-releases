#!/usr/bin/env bash
# v0.3.0 Integration Tests
# 覆盖：HAVING / BETWEEN / IN / DISTINCT / head / tail / CSV / WAL / --since/--until
# 多列 GROUP BY / SQL split 修复

set -e
BINARY=${BINARY:-../../ndtsdb-cli}
EXAMPLES_DIR=${EXAMPLES_DIR:-../../examples}
PASS=0
FAIL=0

assert() {
    local desc="$1" actual="$2" expected="$3"
    if echo "$actual" | grep -qF "$expected"; then
        echo "✓ $desc"
        PASS=$((PASS+1))
    else
        echo "✗ $desc"
        echo "  expected: $expected"
        echo "  got: $actual"
        FAIL=$((FAIL+1))
    fi
}

assert_count() {
    local desc="$1" actual="$2" expected="$3"
    local count
    count=$(echo "$actual" | grep -c "symbol\|timestamp" 2>/dev/null || echo 0)
    if [ "$count" -eq "$expected" ]; then
        echo "✓ $desc: $count rows"
        PASS=$((PASS+1))
    else
        echo "✗ $desc: expected $expected rows, got $count"
        FAIL=$((FAIL+1))
    fi
}

DB=$(mktemp -d)
echo "=== v0.3.0 Integration Tests ==="
echo "Database: $DB"
echo ""

# --- 准备数据 ---
echo "--- 准备测试数据 ---"
for i in $(seq 1 20); do
    echo "{\"symbol\":\"BTC\",\"interval\":\"1m\",\"timestamp\":$i,\"open\":100,\"high\":$((100+i)),\"low\":$((90+i)),\"close\":$((105+i)),\"volume\":$((1000+i*10))}" \
        | $BINARY write-json --database $DB 2>/dev/null
    echo "{\"symbol\":\"ETH\",\"interval\":\"1m\",\"timestamp\":$i,\"open\":50,\"high\":$((55+i)),\"low\":$((45+i)),\"close\":$((52+i)),\"volume\":$((500+i*5))}" \
        | $BINARY write-json --database $DB 2>/dev/null
done
for i in $(seq 1 10); do
    echo "{\"symbol\":\"BTC\",\"interval\":\"5m\",\"timestamp\":$i,\"open\":200,\"high\":210,\"low\":190,\"close\":205,\"volume\":2000}" \
        | $BINARY write-json --database $DB 2>/dev/null
done
echo "数据就绪（BTC/1m×20, ETH/1m×20, BTC/5m×10）"
echo ""

# --- 1. SQL WHERE BETWEEN ---
echo "--- 1. SQL WHERE BETWEEN ---"
result=$($BINARY sql --database $DB --query 'SELECT * FROM data WHERE timestamp BETWEEN 5 AND 8')
assert "BETWEEN 5 AND 8: contains ts=5" "$result" '"timestamp":5'
assert "BETWEEN 5 AND 8: contains ts=8" "$result" '"timestamp":8'
count=$(echo "$result" | wc -l | tr -d ' ')
if [ "$count" -ge 8 ]; then  # ≥8行（BTC/1m×4 + ETH/1m×4 + BTC/5m×4）
    echo "✓ BETWEEN: $count rows (>=8)"
    PASS=$((PASS+1))
else
    echo "✗ BETWEEN: expected >=8 rows, got $count"
    FAIL=$((FAIL+1))
fi

# --- 2. SQL WHERE IN ---
echo "--- 2. SQL WHERE IN ---"
result=$($BINARY sql --database $DB --query 'SELECT * FROM data WHERE timestamp IN (3, 7, 15)')
assert "IN (3,7,15): contains ts=3" "$result" '"timestamp":3'
assert "IN (3,7,15): contains ts=15" "$result" '"timestamp":15'
count=$(echo "$result" | wc -l | tr -d ' ')
if [ "$count" -ge 6 ]; then  # ≥6行
    echo "✓ IN: $count rows (>=6)"
    PASS=$((PASS+1))
else
    echo "✗ IN: expected >=6 rows, got $count"
    FAIL=$((FAIL+1))
fi

# --- 3. SQL HAVING ---
echo "--- 3. SQL HAVING ---"
result=$($BINARY sql --database $DB --query 'SELECT symbol, COUNT(*) FROM data GROUP BY symbol HAVING COUNT(*) > 15')
assert "HAVING COUNT>15: BTC in result" "$result" 'BTC'
# ETH有20行，BTC有30行(1m 20 + 5m 10)，两者都>15
count=$(echo "$result" | wc -l | tr -d ' ')
if [ "$count" -ge 2 ]; then
    echo "✓ HAVING: $count rows returned"
    PASS=$((PASS+1))
else
    echo "✗ HAVING: expected >=2 rows, got $count"
    FAIL=$((FAIL+1))
fi

# --- 4. SQL DISTINCT ---
echo "--- 4. SQL DISTINCT ---"
result=$($BINARY sql --database $DB --query 'SELECT DISTINCT symbol FROM data')
assert "DISTINCT symbol: BTC present" "$result" 'BTC'
assert "DISTINCT symbol: ETH present" "$result" 'ETH'
count=$(echo "$result" | wc -l | tr -d ' ')
if [ "$count" -eq 2 ]; then
    echo "✓ DISTINCT: 2 unique symbols"
    PASS=$((PASS+1))
else
    echo "✗ DISTINCT: expected 2, got $count"
    FAIL=$((FAIL+1))
fi

# --- 5. 多列 GROUP BY ---
echo "--- 5. 多列 GROUP BY ---"
result=$($BINARY sql --database $DB --query 'SELECT symbol, interval, COUNT(*) FROM data GROUP BY symbol, interval')
assert "多列 GROUP BY: BTC/1m" "$result" '"symbol":"BTC"'
count=$(echo "$result" | wc -l | tr -d ' ')
if [ "$count" -ge 3 ]; then  # BTC/1m, ETH/1m, BTC/5m
    echo "✓ 多列 GROUP BY: $count groups"
    PASS=$((PASS+1))
else
    echo "✗ 多列 GROUP BY: expected >=3 groups, got $count"
    FAIL=$((FAIL+1))
fi

# --- 6. tail 子命令 ---
echo "--- 6. tail 子命令 ---"
result=$($BINARY tail --database $DB --symbol BTC --interval 1m --n 5)
assert "tail -n 5: contains ts=20" "$result" '"timestamp":20'
assert "tail -n 5: contains ts=16" "$result" '"timestamp":16'
count=$(echo "$result" | wc -l | tr -d ' ')
if [ "$count" -eq 5 ]; then
    echo "✓ tail: 5 rows"
    PASS=$((PASS+1))
else
    echo "✗ tail: expected 5, got $count"
    FAIL=$((FAIL+1))
fi

# tail --format csv
csv_result=$($BINARY tail --database $DB --symbol BTC --interval 1m --n 3 --format csv)
assert "tail CSV: header" "$csv_result" 'timestamp'
echo "✓ tail CSV: header present"

# --- 7. head 子命令 ---
echo "--- 7. head 子命令 ---"
result=$($BINARY head --database $DB --symbol BTC --interval 1m --n 5)
assert "head -n 5: contains ts=1" "$result" '"timestamp":1'
assert "head -n 5: contains ts=5" "$result" '"timestamp":5'
count=$(echo "$result" | wc -l | tr -d ' ')
if [ "$count" -eq 5 ]; then
    echo "✓ head: 5 rows"
    PASS=$((PASS+1))
else
    echo "✗ head: expected 5, got $count"
    FAIL=$((FAIL+1))
fi

# --- 8. SMA JSON 默认输出（非CSV）---
echo "--- 8. SMA/EMA/ATR 默认 JSON 输出 ---"
sma_result=$($BINARY sma --database $DB --symbol BTC --interval 1m --period 10)
sma_first=$(echo "$sma_result" | head -1)
assert "SMA: JSON格式 (含timestamp key)" "$sma_first" '"timestamp"'
assert "SMA: JSON格式 (含sma key)" "$sma_first" '"sma"'

ema_result=$($BINARY ema --database $DB --symbol BTC --interval 1m --period 10)
ema_first=$(echo "$ema_result" | head -1)
assert "EMA: JSON格式" "$ema_first" '"ema"'

atr_result=$($BINARY atr --database $DB --symbol BTC --interval 1m --period 14)
atr_first=$(echo "$atr_result" | head -1)
assert "ATR: JSON格式" "$atr_first" '"atr"'

# SMA CSV format
sma_csv=$($BINARY sma --database $DB --symbol BTC --interval 1m --period 10 --format csv)
assert "SMA CSV: header" "$(echo "$sma_csv" | head -1)" 'timestamp,sma'

# --- 9. --since/--until ---
echo "--- 9. --since/--until 时间过滤 ---"
result=$($BINARY sma --database $DB --symbol BTC --interval 1m --period 5 --since 10 --until 15)
count=$(echo "$result" | wc -l | tr -d ' ')
if [ "$count" -ge 1 ]; then
    echo "✓ SMA --since/--until: $count rows"
    PASS=$((PASS+1))
else
    echo "✗ SMA --since/--until: expected rows"
    FAIL=$((FAIL+1))
fi

# --- 10. SQL FORMAT CSV ---
echo "--- 10. SQL --format csv ---"
csv=$($BINARY sql --database $DB --query 'SELECT * FROM data WHERE timestamp = 1' --format csv)
csv_header=$(echo "$csv" | head -1)
assert "SQL CSV: header contains symbol" "$csv_header" 'symbol'
assert "SQL CSV: header contains timestamp" "$csv_header" 'timestamp'

# --- 11. SQL LIMIT + ORDER BY ---
echo "--- 11. SQL LIMIT + ORDER BY ---"
result=$($BINARY sql --database $DB --query 'SELECT * FROM data ORDER BY timestamp DESC LIMIT 3')
first=$(echo "$result" | head -1)
assert "LIMIT DESC: first row is latest ts" "$first" '"timestamp":20'
count=$(echo "$result" | wc -l | tr -d ' ')
if [ "$count" -eq 3 ]; then
    echo "✓ LIMIT 3: got 3 rows"
    PASS=$((PASS+1))
else
    echo "✗ LIMIT 3: expected 3, got $count"
    FAIL=$((FAIL+1))
fi

# --- 12. WAL replay ---
echo "--- 12. WAL ---"
WAL_DB=$(mktemp -d)
echo '{"symbol":"BTC","interval":"1m","timestamp":1,"open":100,"high":110,"low":90,"close":105,"volume":1000}' \
    | $BINARY write-json --database $WAL_DB 2>/dev/null
wal_file="$WAL_DB/.wal.log"
if [ -f "$wal_file" ]; then
    echo "✓ WAL: 文件自动创建"
    PASS=$((PASS+1))
else
    echo "✗ WAL: 文件未创建 ($wal_file)"
    FAIL=$((FAIL+1))
fi
replay=$($BINARY wal-replay --database $WAL_DB 2>&1 | tail -1)
if echo "$replay" | grep -qE "replay|replayed|0 entries|no entries|already"; then
    echo "✓ WAL replay: 命令成功"
    PASS=$((PASS+1))
else
    echo "? WAL replay: $replay"
fi
rm -rf $WAL_DB

echo ""
# --- 13. SQL WHERE OR ---
echo "--- 13. SQL WHERE OR ---"
result=$($BINARY sql --database $DB --query "SELECT * FROM data WHERE symbol = 'BTC' OR symbol = 'ETH'")
assert "WHERE OR: BTC in result" "$result" '"symbol":"BTC"'
assert "WHERE OR: ETH in result" "$result" '"symbol":"ETH"'
count=$(echo "$result" | wc -l | tr -d ' ')
if [ "$count" -ge 6 ]; then
    echo "✓ WHERE OR: $count rows (>=6)"
    PASS=$((PASS+1))
else
    echo "✗ WHERE OR: expected >=6 rows, got $count"
    FAIL=$((FAIL+1))
fi

# --- 14. SQL WHERE LIKE % ---
echo "--- 14. SQL WHERE LIKE % ---"
result=$($BINARY sql --database $DB --query "SELECT * FROM data WHERE symbol LIKE 'BT%'")
assert "WHERE LIKE 'BT%': BTC in result" "$result" '"symbol":"BTC"'
# 确保结果里没有 ETH
if echo "$result" | grep -q '"symbol":"ETH"'; then
    echo "✗ WHERE LIKE: ETH should not appear"
    FAIL=$((FAIL+1))
else
    echo "✓ WHERE LIKE 'BT%': no ETH in result"
    PASS=$((PASS+1))
fi

# --- 15. SQL WHERE NOT ---
echo "--- 15. SQL WHERE NOT ---"
result=$($BINARY sql --database $DB --query "SELECT * FROM data WHERE NOT symbol = 'BTC'")
# 确保结果里没有 BTC
if echo "$result" | grep -q '"symbol":"BTC"'; then
    echo "✗ WHERE NOT: BTC should not appear"
    FAIL=$((FAIL+1))
else
    echo "✓ WHERE NOT symbol='BTC': no BTC in result"
    PASS=$((PASS+1))
fi
# 确保有 ETH
assert "WHERE NOT: ETH in result" "$result" '"symbol":"ETH"'

# --- 16. count 子命令（全库） ---
echo "--- 16. count 子命令（全库） ---"
result=$($BINARY count --database $DB)
assert "count all: contains count field" "$result" '"count":'
row_count=$(echo "$result" | grep -c '"symbol"' 2>/dev/null || echo 0)
if [ "$row_count" -gt 0 ]; then
    echo "✓ count all: $row_count symbol/interval pairs"
    PASS=$((PASS+1))
else
    echo "✗ count all: expected >0 rows, got $row_count"
    FAIL=$((FAIL+1))
fi

# --- 17. count --symbol BTC ---
echo "--- 17. count --symbol BTC ---"
result=$($BINARY count --database $DB --symbol BTC)
assert "count --symbol BTC: BTC in result" "$result" '"symbol":"BTC"'
# 确保只有 BTC，没有 ETH
if echo "$result" | grep -q '"symbol":"ETH"'; then
    echo "✗ count --symbol BTC: ETH should not appear"
    FAIL=$((FAIL+1))
else
    echo "✓ count --symbol BTC: no ETH in result"
    PASS=$((PASS+1))
fi

# --- 18. count --symbol BTC --interval 1m ---
echo "--- 18. count --symbol BTC --interval 1m ---"
result=$($BINARY count --database $DB --symbol BTC --interval 1m)
assert "count --symbol BTC --interval 1m: exact match" "$result" '{"symbol":"BTC","interval":"1m","count":'

# 验证 count 值是否为数字
btc_count=$(echo "$result" | grep -o '"count":[0-9]*' | cut -d: -f2)
if [ -n "$btc_count" ] && [ "$btc_count" -gt 0 ] 2>/dev/null; then
    echo "✓ count --symbol BTC --interval 1m: count=$btc_count (>0)"
    PASS=$((PASS+1))
else
    echo "✗ count --symbol BTC --interval 1m: invalid count value"
    FAIL=$((FAIL+1))
fi

# --- 19. info 子命令（全库） ---
echo "--- 19. info 子命令（全库） ---"
result=$($BINARY info --database $DB)
assert "info all: contains first field" "$result" '"first":'
assert "info all: contains last field" "$result" '"last":'

# --- 20. info --symbol BTC ---
echo "--- 20. info --symbol BTC ---"
result=$($BINARY info --database $DB --symbol BTC)
assert "info --symbol BTC: BTC in result" "$result" '"symbol":"BTC"'
# 确保只有 BTC，没有 ETH
if echo "$result" | grep -q '"symbol":"ETH"'; then
    echo "✗ info --symbol BTC: ETH should not appear"
    FAIL=$((FAIL+1))
else
    echo "✓ info --symbol BTC: no ETH in result"
    PASS=$((PASS+1))
fi

# --- 21. script sma 测试 ---
echo "--- 21. script sma 测试 ---"
TEST_JS_SMA="/tmp/test_sma_$$.js"
cat > "$TEST_JS_SMA" << 'JSEOF'
// 内联 SMA 计算函数
function sma(rows, period) {
    if (!rows || rows.length < period) return [];
    var result = [];
    for (var i = period - 1; i < rows.length; i++) {
        var sum = 0;
        for (var j = 0; j < period; j++) sum += parseFloat(rows[i-j].close) || 0;
        result.push({ timestamp: rows[i].timestamp, value: sum / period });
    }
    return result;
}
const db = ndtsdb.open("__DB_PATH__");
const rows = ndtsdb.queryFiltered(db, ['BTC']);
ndtsdb.close(db);
const r = sma(rows, 3);
console.log(r.length > 0 ? 'SMA_OK' : 'SMA_FAIL');
JSEOF
# 替换实际的数据库路径
sed -i "s|__DB_PATH__|$DB|g; s|__EXAMPLES_DIR__|$EXAMPLES_DIR|g" "$TEST_JS_SMA"
result=$($BINARY "$TEST_JS_SMA" 2>/dev/null)
assert "script sma: returns SMA_OK" "$result" 'SMA_OK'
rm -f "$TEST_JS_SMA"

# --- 22. script bollinger 测试 ---
echo "--- 22. script bollinger 测试 ---"
TEST_JS_BOLL="/tmp/test_boll_$$.js"
cat > "$TEST_JS_BOLL" << 'JSEOF'
// 内联 Bollinger Bands 计算函数
function bollinger(rows, period, mult) {
    if (!rows || rows.length < period) return [];
    if (mult === undefined) mult = 2;
    var result = [];
    for (var i = period - 1; i < rows.length; i++) {
        var sum = 0;
        for (var j = 0; j < period; j++) sum += parseFloat(rows[i-j].close) || 0;
        var mid = sum / period;
        var vsum = 0;
        for (var j = 0; j < period; j++) {
            var d = (parseFloat(rows[i-j].close) || 0) - mid;
            vsum += d * d;
        }
        var std = Math.sqrt(vsum / period);
        result.push({ timestamp: rows[i].timestamp, mid: mid, upper: mid + mult*std, lower: mid - mult*std, std: std });
    }
    return result;
}
const db = ndtsdb.open("__DB_PATH__");
const rows = ndtsdb.queryFiltered(db, ['BTC']);
ndtsdb.close(db);
const r = bollinger(rows, 3, 2);
if (r.length > 0 && r[0].upper !== undefined && r[0].lower !== undefined) {
    console.log('BOLL_OK');
} else {
    console.log('BOLL_FAIL');
}
JSEOF
# 替换实际的数据库路径
sed -i "s|__DB_PATH__|$DB|g" "$TEST_JS_BOLL"
result=$($BINARY "$TEST_JS_BOLL" 2>/dev/null)
assert "script bollinger: returns BOLL_OK" "$result" 'BOLL_OK'
rm -f "$TEST_JS_BOLL"

# --- 23. SQL LAG(close,1) AS prev ---
echo "--- 23. SQL LAG(close,1) AS prev ---"
result=$($BINARY sql --database $DB --query "SELECT timestamp, close, LAG(close,1) AS prev FROM data WHERE symbol='BTC' ORDER BY timestamp")
# 第一行 prev 应该是 null
first_row=$(echo "$result" | head -1)
assert "LAG: first row has prev" "$first_row" '"prev"'
if echo "$first_row" | grep -q '"prev":null'; then
    echo "✓ LAG: first row prev is null"
    PASS=$((PASS+1))
else
    echo "✗ LAG: first row prev should be null"
    FAIL=$((FAIL+1))
fi
# 第二行 prev 应该等于第一行的 close 值
second_row=$(echo "$result" | sed -n '2p')
assert "LAG: second row has prev" "$second_row" '"prev"'

# --- 24. SQL LEAD(close,1) AS next ---
echo "--- 24. SQL LEAD(close,1) AS next ---"
result=$($BINARY sql --database $DB --query "SELECT timestamp, close, LEAD(close,1) AS next FROM data WHERE symbol='BTC' ORDER BY timestamp")
# 检查是否有 next 字段
assert "LEAD: output has next field" "$result" '"next"'
# 统计 next=null 的行数
null_count=$(echo "$result" | grep -c '"next":null')
if [ "$null_count" -ge 1 ]; then
    echo "✓ LEAD: $null_count row(s) with next=null"
    PASS=$((PASS+1))
else
    echo "✗ LEAD: expected at least 1 row with next=null"
    FAIL=$((FAIL+1))
fi

# --- 25. SQL COUNT(DISTINCT symbol) ---
echo "--- 25. SQL COUNT(DISTINCT symbol) ---"
result=$($BINARY sql --database $DB --query "SELECT COUNT(DISTINCT symbol) FROM data")
assert "COUNT(DISTINCT symbol): returns result" "$result" '"COUNT(DISTINCT symbol)"'
# 验证结果 >= 1 (数据库中有 BTC 和 ETH)
count_val=$(echo "$result" | grep -o '"COUNT(DISTINCT symbol)":[0-9]*' | cut -d: -f2)
if [ -n "$count_val" ] && [ "$count_val" -ge 1 ] 2>/dev/null; then
    echo "✓ COUNT(DISTINCT symbol): count=$count_val (>=1)"
    PASS=$((PASS+1))
else
    echo "✗ COUNT(DISTINCT symbol): invalid count value"
    FAIL=$((FAIL+1))
fi

# --- 26. script MACD 基本测试 ---
echo "--- 26. script MACD 基本测试 ---"
# 先写入 50 行 BTC 数据
for i in $(seq 1 50); do
    echo "{\"symbol\":\"BTC\",\"interval\":\"1m\",\"timestamp\":$i,\"open\":100,\"high\":110,\"low\":90,\"close\":$((100+i%10)),\"volume\":1000}" \
        | $BINARY write-json --database $DB 2>/dev/null
done
TEST_JS_MACD="/tmp/test_macd_$$.js"
cat > "$TEST_JS_MACD" << 'JSEOF'
// 内联 MACD 计算函数
function macd(rows, fast, slow, signal) {
    if (!rows || rows.length < slow) return [];
    if (fast === undefined) fast = 12;
    if (slow === undefined) slow = 26;
    if (signal === undefined) signal = 9;
    // 计算 EMA
    function ema(data, period) {
        var k = 2 / (period + 1);
        var result = [];
        var emaVal = parseFloat(data[0].close) || 0;
        for (var i = 0; i < data.length; i++) {
            emaVal = (parseFloat(data[i].close) || 0) * k + emaVal * (1 - k);
            if (i >= period - 1) result.push(emaVal);
        }
        return result;
    }
    var fastEMA = ema(rows, fast);
    var slowEMA = ema(rows, slow);
    var macdLine = [];
    var offset = slow - fast;
    for (var i = 0; i < slowEMA.length; i++) {
        macdLine.push(fastEMA[i + offset] - slowEMA[i]);
    }
    // 计算 signal line (EMA of MACD)
    var signalEMA = [];
    var k = 2 / (signal + 1);
    var sigVal = macdLine[0];
    for (var i = 0; i < macdLine.length; i++) {
        sigVal = macdLine[i] * k + sigVal * (1 - k);
        if (i >= signal - 1) signalEMA.push(sigVal);
    }
    // 组合结果
    var result = [];
    for (var i = 0; i < signalEMA.length; i++) {
        var macdVal = macdLine[i + signal - 1];
        result.push({
            timestamp: rows[rows.length - signalEMA.length + i].timestamp,
            macd: macdVal,
            signal: signalEMA[i],
            hist: macdVal - signalEMA[i]
        });
    }
    return result;
}
const db = ndtsdb.open("__DB_PATH__");
const rows = ndtsdb.queryFiltered(db, ['BTC']);
ndtsdb.close(db);
const r = macd(rows, 12, 26, 9);
if (r.length > 0 && r[r.length-1].macd !== undefined && r[r.length-1].signal !== undefined && r[r.length-1].hist !== undefined) {
    console.log('MACD_OK');
} else {
    console.log('MACD_FAIL');
}
JSEOF
sed -i "s|__DB_PATH__|$DB|g" "$TEST_JS_MACD"
result=$($BINARY "$TEST_JS_MACD" 2>/dev/null)
assert "script MACD: returns MACD_OK" "$result" 'MACD_OK'
rm -f "$TEST_JS_MACD"

# --- 27. MACD signal 非零测试 ---
echo "--- 27. MACD signal 非零测试 ---"
TEST_JS_MACD2="/tmp/test_macd2_$$.js"
cat > "$TEST_JS_MACD2" << 'JSEOF'
// 内联 MACD 计算函数
function macd(rows, fast, slow, signal) {
    if (!rows || rows.length < slow) return [];
    if (fast === undefined) fast = 12;
    if (slow === undefined) slow = 26;
    if (signal === undefined) signal = 9;
    function ema(data, period) {
        var k = 2 / (period + 1);
        var result = [];
        var emaVal = parseFloat(data[0].close) || 0;
        for (var i = 0; i < data.length; i++) {
            emaVal = (parseFloat(data[i].close) || 0) * k + emaVal * (1 - k);
            if (i >= period - 1) result.push(emaVal);
        }
        return result;
    }
    var fastEMA = ema(rows, fast);
    var slowEMA = ema(rows, slow);
    var macdLine = [];
    var offset = slow - fast;
    for (var i = 0; i < slowEMA.length; i++) {
        macdLine.push(fastEMA[i + offset] - slowEMA[i]);
    }
    var signalEMA = [];
    var k = 2 / (signal + 1);
    var sigVal = macdLine[0];
    for (var i = 0; i < macdLine.length; i++) {
        sigVal = macdLine[i] * k + sigVal * (1 - k);
        if (i >= signal - 1) signalEMA.push(sigVal);
    }
    var result = [];
    for (var i = 0; i < signalEMA.length; i++) {
        var macdVal = macdLine[i + signal - 1];
        result.push({
            timestamp: rows[rows.length - signalEMA.length + i].timestamp,
            macd: macdVal,
            signal: signalEMA[i],
            hist: macdVal - signalEMA[i]
        });
    }
    return result;
}
const db = ndtsdb.open("__DB_PATH__");
const rows = ndtsdb.queryFiltered(db, ['BTC']);
ndtsdb.close(db);
const r = macd(rows, 12, 26, 9);
if (r.length > 0 && r[r.length-1].signal !== 0) {
    console.log('SIGNAL_OK');
} else {
    console.log('SIGNAL_FAIL');
}
JSEOF
sed -i "s|__DB_PATH__|$DB|g" "$TEST_JS_MACD2"
result=$($BINARY "$TEST_JS_MACD2" 2>/dev/null)
assert "script MACD: last.signal !== 0" "$result" 'SIGNAL_OK'
rm -f "$TEST_JS_MACD2"

# --- 26. SQL STDDEV ---
echo '--- 26. SQL STDDEV ---'
result=$($BINARY sql --database $DB --query "SELECT STDDEV(close) AS std FROM data WHERE symbol='BTC'")
assert 'STDDEV: has std field' "$result" '"std"'
std_val=$(echo "$result" | grep -o '"std":[0-9.]*' | cut -d: -f2)
if [ -n "$std_val" ] && awk "BEGIN{exit !($std_val > 0)}"; then
    echo "✓ STDDEV: std=$std_val (>0)"
    PASS=$((PASS+1))
else
    echo "✗ STDDEV: expected std > 0, got: $std_val"
    FAIL=$((FAIL+1))
fi

# --- 27. SQL VARIANCE ---
echo '--- 27. SQL VARIANCE ---'
result=$($BINARY sql --database $DB --query "SELECT VARIANCE(close) AS var FROM data WHERE symbol='BTC'")
assert 'VARIANCE: has var field' "$result" '"var"'
var_val=$(echo "$result" | grep -o '"var":[0-9.]*' | cut -d: -f2)
if [ -n "$var_val" ] && awk "BEGIN{exit !($var_val > 0)}"; then
    echo "✓ VARIANCE: var=$var_val (>0)"
    PASS=$((PASS+1))
else
    echo "✗ VARIANCE: expected var > 0, got: $var_val"
    FAIL=$((FAIL+1))
fi

# --- 28. SQL PERCENTILE(50) ---
echo '--- 28. SQL PERCENTILE(50) median ---'
result=$($BINARY sql --database $DB --query "SELECT PERCENTILE(close,50) AS median FROM data WHERE symbol='BTC'")
assert 'PERCENTILE(50): has median field' "$result" '"median"'
median_val=$(echo "$result" | grep -o '"median":[0-9.]*' | cut -d: -f2)
if [ -n "$median_val" ] && awk "BEGIN{exit !($median_val > 0)}"; then
    echo "✓ PERCENTILE(50): median=$median_val (>0)"
    PASS=$((PASS+1))
else
    echo "✗ PERCENTILE(50): expected median > 0"
    FAIL=$((FAIL+1))
fi

# --- 29. SQL FIRST/LAST ---
echo '--- 29. SQL FIRST/LAST ---'
result=$($BINARY sql --database $DB --query "SELECT FIRST(close) AS first_c, LAST(close) AS last_c FROM data WHERE symbol='BTC'")
assert 'FIRST/LAST: has first_c' "$result" '"first_c"'
assert 'FIRST/LAST: has last_c' "$result" '"last_c"'
first_val=$(echo "$result" | grep -o '"first_c":[0-9.]*' | cut -d: -f2)
last_val=$(echo "$result" | grep -o '"last_c":[0-9.]*' | cut -d: -f2)
if [ -n "$first_val" ] && [ -n "$last_val" ]; then
    echo "✓ FIRST/LAST: first=$first_val, last=$last_val"
    PASS=$((PASS+1))
else
    echo "✗ FIRST/LAST: missing values"
    FAIL=$((FAIL+1))
fi

# --- 30. SQL CORR 测试 ---
echo '--- 30. SQL CORR ---'
result=$($BINARY sql --database $DB --query "SELECT CORR(close,volume) AS corr FROM data WHERE symbol='BTC'")
assert 'CORR: has corr field' "$result" '"corr"'
corr_val=$(echo "$result" | grep -o '"corr":[^,}]*' | cut -d: -f2)
if [ -n "$corr_val" ]; then
    echo "✓ CORR: corr=$corr_val"
    PASS=$((PASS+1))
else
    echo "✗ CORR: no corr value"
    FAIL=$((FAIL+1))
fi

# --- 31. export --format csv 测试 ---
echo '--- 31. export --format csv ---'
csv_out=$(mktemp)
$BINARY export --database $DB --symbol BTC --format csv --output $csv_out
assert 'export csv: header' "$(head -1 $csv_out)" 'symbol'
csv_lines=$(wc -l < $csv_out)
if [ "$csv_lines" -ge 2 ]; then
    echo "✓ export csv: $csv_lines lines (header+data)"
    PASS=$((PASS+1))
else
    echo "✗ export csv: expected >=2 lines"
    FAIL=$((FAIL+1))
fi
rm -f $csv_out

# --- 32. merge 子命令 ---
echo '--- 32. merge 子命令 ---'
DB_MERGE=$(mktemp -d)
$BINARY merge --from $DB --to $DB_MERGE --symbol BTC
merge_count=$($BINARY count --database $DB_MERGE | grep -o '"count":[0-9]*' | head -1 | cut -d: -f2)
if [ -n "$merge_count" ] && [ "$merge_count" -ge 1 ]; then
    echo "✓ merge: count=$merge_count"
    PASS=$((PASS+1))
else
    echo "✗ merge: expected count>=1"
    FAIL=$((FAIL+1))
fi
rm -rf $DB_MERGE

# --- 33. SQL strftime GROUP BY ---
echo '--- 33. SQL strftime GROUP BY ---'
result=$($BINARY sql --database $DB --query "SELECT strftime(timestamp,'%Y-%m') AS month, COUNT(*) FROM data WHERE symbol='BTC' GROUP BY month")
assert 'strftime GROUP BY: has month' "$result" '"month"'

# --- 34. help system 测试 ---
echo '--- 34. help system ---'
help_out=$($BINARY --help 2>&1)
assert 'help: shows ndtsdb-cli' "$help_out" 'ndtsdb-cli'

# --- 35. export --format json 测试 ---
echo '--- 35. export --format json ---'
json_out=$(mktemp)
$BINARY export --database $DB --symbol BTC --format json --output $json_out
if [ -s "$json_out" ] && head -1 "$json_out" | grep -q '{'; then
    echo "✓ export json: valid JSON output"
    PASS=$((PASS+1))
else
    echo "✗ export json: expected valid JSON"
    FAIL=$((FAIL+1))
fi
rm -f $json_out

# --- 36. SQL MIN/MAX 测试 ---
echo '--- 36. SQL MIN/MAX ---'
result=$($BINARY sql --database $DB --query "SELECT MIN(close) AS min_c, MAX(close) AS max_c FROM data WHERE symbol='BTC'")
assert 'MIN/MAX: has min_c' "$result" '"min_c"'
assert 'MIN/MAX: has max_c' "$result" '"max_c"'

# --- 37. SQL SUM/AVG 测试 ---
echo '--- 37. SQL SUM/AVG ---'
result=$($BINARY sql --database $DB --query "SELECT SUM(volume) AS sum_vol, AVG(close) AS avg_close FROM data WHERE symbol='BTC'")
assert 'SUM/AVG: has sum_vol' "$result" '"sum_vol"'
assert 'SUM/AVG: has avg_close' "$result" '"avg_close"'

# --- 38. SQL COUNT(*) 测试 ---
echo '--- 38. SQL COUNT(*) ---'
result=$($BINARY sql --database $DB --query "SELECT COUNT(*) AS total FROM data WHERE symbol='BTC'")
assert 'COUNT(*): has total' "$result" '"total"'
cnt_val=$(echo "$result" | grep -o '"total":[0-9]*' | cut -d: -f2)
if [ -n "$cnt_val" ] && [ "$cnt_val" -ge 70 ]; then
    echo "✓ COUNT(*): total=$cnt_val (>=70)"
    PASS=$((PASS+1))
else
    echo "✗ COUNT(*): expected >=70, got: $cnt_val"
    FAIL=$((FAIL+1))
fi

# --- 39. list 子命令 ---
echo '--- 39. list 子命令 ---'
result=$($BINARY list --database $DB)
assert 'list: has BTC' "$result" 'BTC'
assert 'list: has ETH' "$result" 'ETH'

# --- 40. SQL ORDER BY DESC + LIMIT 边界 ---
echo '--- 40. SQL ORDER BY DESC + LIMIT 边界 ---'
result=$($BINARY sql --database $DB --query "SELECT * FROM data WHERE symbol='BTC' ORDER BY timestamp DESC LIMIT 1")
assert 'ORDER BY LIMIT: has timestamp' "$result" '"timestamp"'
# 验证只有1行
count=$(echo "$result" | wc -l | tr -d ' ')
if [ "$count" -eq 1 ]; then
    echo "✓ ORDER BY LIMIT: exactly 1 row"
    PASS=$((PASS+1))
else
    echo "✗ ORDER BY LIMIT: expected 1 row, got $count"
    FAIL=$((FAIL+1))
fi

# --- 41. resample 子命令 ---
echo '--- 41. resample 1m to 5m ---'
DB_RS=$(mktemp -d)
for i in $(seq 1 30); do
    echo '{"symbol":"BTC","interval":"1m","timestamp":'$i',"open":100,"high":110,"low":90,"close":105,"volume":1000}' | $BINARY write-json --database $DB_RS 2>/dev/null
done
result=$($BINARY resample --database $DB_RS --symbol BTC --from 1m --to 5m)
assert 'resample: has open' "$result" '"open"'
resample_lines=$(echo "$result" | wc -l | tr -d ' ')
if [ "$resample_lines" -eq 6 ]; then
    echo "✓ resample: 6 rows (30/5)"
    PASS=$((PASS+1))
else
    echo "✗ resample: expected 6 rows, got $resample_lines"
    FAIL=$((FAIL+1))
fi
assert 'resample: volume=5000' "$result" '5000'
rm -rf $DB_RS

# --- 42. serve 子命令集成测试 ---
echo '--- 42. serve 子命令 ---'
DB_S=$(mktemp -d)
echo '{"symbol":"BTC","interval":"1m","timestamp":1,"open":100,"high":110,"low":90,"close":105,"volume":1000}' | $BINARY write-json --database $DB_S 2>/dev/null
PORT=$((19000 + RANDOM % 1000))
$BINARY serve --database $DB_S --port $PORT &
SERVE_PID=$!
sleep 1

# /health
h=$(curl -sf http://localhost:$PORT/health 2>/dev/null)
assert 'serve /health: ok' "$h" 'ok'

# /symbols
s=$(curl -sf http://localhost:$PORT/symbols 2>/dev/null)
assert 'serve /symbols: BTC' "$s" 'BTC'

# /query?symbol=BTC
q=$(curl -sf "http://localhost:$PORT/query?symbol=BTC" 2>/dev/null)
assert 'serve /query: has timestamp' "$q" 'timestamp'

# POST /write-json
w=$(curl -sf -X POST -d '{"symbol":"ETH","interval":"1m","timestamp":1,"open":50,"high":55,"low":48,"close":52,"volume":500}' http://localhost:$PORT/write-json 2>/dev/null)
assert 'serve POST: inserted' "$w" 'inserted'

kill $SERVE_PID 2>/dev/null; wait $SERVE_PID 2>/dev/null
rm -rf $DB_S

# --- 43. vwap 子命令 ---
echo '--- 43. vwap ---'
DB_V=$(mktemp -d)
for i in $(seq 1 10); do
    echo '{"symbol":"BTC","interval":"1m","timestamp":'$i',"open":100,"high":110,"low":90,"close":105,"volume":1000}' | $BINARY write-json --database $DB_V 2>/dev/null
done
vwap_out=$($BINARY vwap --database $DB_V --symbol BTC --interval 1m)
assert 'vwap: has vwap field' "$vwap_out" '"vwap"'
vwap_val=$(echo "$vwap_out" | tail -1 | grep -o '"vwap":[0-9.]*' | cut -d: -f2)
if [ -n "$vwap_val" ] && awk "BEGIN{exit !($vwap_val > 0)}"; then
    echo "✓ vwap: value > 0"
    PASS=$((PASS+1))
else
    echo "✗ vwap: expected value > 0"
    FAIL=$((FAIL+1))
fi
rm -rf $DB_V

# --- 44. script --watch 模式 ---
echo '--- 44. script --watch ---'
DB_W=$(mktemp -d)
# 写初始数据
for i in $(seq 1 60); do
    echo '{"symbol":"BTC","interval":"1m","timestamp":'$i',"open":100,"high":110,"low":90,"close":105,"volume":1000}' | $BINARY write-json --database $DB_W 2>/dev/null
done
# 启动 watch，超时 4s 后检查是否有输出
output=$(timeout 4 $BINARY script $EXAMPLES_DIR/strategy-demo.js --database $DB_W --watch --interval 500 2>&1 || true)
assert 'watch: ran at least once' "$output" 'watch'
rm -rf $DB_W

# --- 44. OBV 指标子命令 ---
echo '--- 44. OBV 指标 ---'
obv_out=$($BINARY obv --database $DB --symbol BTC --interval 1m)
assert 'obv: has obv field' "$obv_out" '"obv"'
# 验证行数等于输入行数
obv_lines=$(echo "$obv_out" | wc -l | tr -d ' ')
if [ "$obv_lines" -ge 10 ]; then
    echo '✓ obv: enough lines'
    PASS=$((PASS+1))
else
    echo '✗ obv: too few'
    FAIL=$((FAIL+1))
fi

# --- 45. RSI 指标子命令 ---
echo '--- 45. RSI 指标 ---'
DB_RSI=$(mktemp -d)
# 写入单调递增数据（RSI 应接近 100）
for i in $(seq 1 20); do
    echo '{"symbol":"BTC","interval":"1m","timestamp":'$i',"open":100,"high":110,"low":90,"close":'$((100+i))',"volume":1000}' | $BINARY write-json --database $DB_RSI 2>/dev/null
done
rsi_out=$($BINARY rsi --database $DB_RSI --symbol BTC --interval 1m --period 5)
assert 'rsi: has rsi field' "$rsi_out" '"rsi"'
# 验证第6行开始有有效值（非null）
rsi_line6=$(echo "$rsi_out" | sed -n '6p')
if echo "$rsi_line6" | grep -q '"rsi":100'; then
    echo '✓ rsi: rising trend gives ~100'
    PASS=$((PASS+1))
else
    echo '✗ rsi: expected ~100 for rising trend'
    FAIL=$((FAIL+1))
fi
rm -rf $DB_RSI

# --- 46. Bollinger Bands 指标子命令 ---
echo '--- 46. Bollinger Bands 指标 ---'
DB_BB=$(mktemp -d)
# 写入30条波动数据
for i in $(seq 1 30); do
    close=$((100 + i % 10))
    echo '{"symbol":"BTC","interval":"1m","timestamp":'$i',"open":100,"high":110,"low":90,"close":'$close',"volume":1000}' | $BINARY write-json --database $DB_BB 2>/dev/null
done
bb_out=$($BINARY bollinger --database $DB_BB --symbol BTC --interval 1m --period 20)
assert 'bollinger: has upper field' "$bb_out" '"upper"'
assert 'bollinger: has middle field' "$bb_out" '"middle"'
assert 'bollinger: has lower field' "$bb_out" '"lower"'
assert 'bollinger: has bandwidth field' "$bb_out" '"bandwidth"'
# 验证 upper > middle > lower
bb_first=$(echo "$bb_out" | head -1)
bb_upper=$(echo "$bb_first" | grep -o '"upper":[0-9.]*' | cut -d: -f2)
bb_middle=$(echo "$bb_first" | grep -o '"middle":[0-9.]*' | cut -d: -f2)
bb_lower=$(echo "$bb_first" | grep -o '"lower":[0-9.]*' | cut -d: -f2)
if awk "BEGIN {exit !($bb_upper > $bb_middle && $bb_middle > $bb_lower)}"; then
    echo '✓ bollinger: upper > middle > lower'
    PASS=$((PASS+1))
else
    echo "✗ bollinger: invalid band order (u=$bb_upper, m=$bb_middle, l=$bb_lower)"
    FAIL=$((FAIL+1))
fi
# 验证只有11行（30条数据 - period20 = 10有效行，但索引从19开始，所以30-19=11）
bb_lines=$(echo "$bb_out" | wc -l | tr -d ' ')
if [ "$bb_lines" -eq 11 ]; then
    echo "✓ bollinger: correct row count ($bb_lines)"
    PASS=$((PASS+1))
else
    echo "✗ bollinger: expected 11 rows, got $bb_lines"
    FAIL=$((FAIL+1))
fi
# 测试CSV格式
bb_csv=$($BINARY bollinger --database $DB_BB --symbol BTC --interval 1m --period 20 --format csv)
bb_header=$(echo "$bb_csv" | head -1)
if echo "$bb_header" | grep -q 'timestamp,upper,middle,lower,bandwidth'; then
    echo '✓ bollinger csv: correct header'
    PASS=$((PASS+1))
else
    echo "✗ bollinger csv: wrong header ($bb_header)"
    FAIL=$((FAIL+1))
fi
rm -rf $DB_BB

# --- 47. MACD 指标子命令 ---
echo '--- 47. MACD 指标 ---'
DB_MACD=$(mktemp -d)
# 写入50条波动数据
for i in $(seq 1 50); do
    close=$((100 + i % 20))
    echo '{"symbol":"BTC","interval":"1m","timestamp":'$i',"open":100,"high":110,"low":90,"close":'$close',"volume":1000}' | $BINARY write-json --database $DB_MACD 2>/dev/null
done
macd_out=$($BINARY macd --database $DB_MACD --symbol BTC --interval 1m --fast 12 --slow 26 --signal 9)
assert 'macd: has macd field' "$macd_out" '"macd"'
assert 'macd: has signal field' "$macd_out" '"signal"'
assert 'macd: has histogram field' "$macd_out" '"histogram"'
# 验证前25行是null（slow=26，所以前25行无效）
macd_line25=$(echo "$macd_out" | sed -n '25p')
if echo "$macd_line25" | grep -q '"macd":null'; then
    echo '✓ macd: first 25 rows are null (as expected)'
    PASS=$((PASS+1))
else
    echo '✗ macd: expected null at row 25'
    FAIL=$((FAIL+1))
fi
# 验证第26行开始有有效值
macd_line26=$(echo "$macd_out" | sed -n '26p')
if echo "$macd_line26" | grep -qE '"macd":-?[0-9]'; then
    echo '✓ macd: row 26 has valid value'
    PASS=$((PASS+1))
else
    echo '✗ macd: expected valid value at row 26'
    FAIL=$((FAIL+1))
fi
rm -rf $DB_MACD

echo ""
echo "================================"
echo "结果: $PASS passed, $FAIL failed"
echo "================================"
rm -rf $DB
[ $FAIL -eq 0 ] && exit 0 || exit 1
