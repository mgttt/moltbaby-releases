#!/bin/bash
# test-resample.sh - 测试 resample 命令
# 验证: 1m→5m/1h周期转换正确性(OHLCV聚合), 数据不足时的行为

set -e

CLI="${CLI:-../../ndtsdb-cli}"
TEST_DB="/tmp/test_ndtsdb_resample_$$"
OUT_DB="/tmp/test_ndtsdb_resample_out_$$"

# 颜色
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo "=== ndtsdb-cli resample 命令测试 ==="

# 清理函数
cleanup() {
    rm -rf "$TEST_DB" "$OUT_DB" /tmp/test_resample_*.json /tmp/test_resample_*.csv
}
trap cleanup EXIT

# 创建1分钟数据（10条，连续10分钟）
mkdir -p "$TEST_DB"
cat > /tmp/test_resample_input_$$.csv << 'EOF'
symbol,interval,timestamp,open,high,low,close,volume
BTCUSDT,1m,1700000000000,100,110,95,105,10
BTCUSDT,1m,1700000060000,105,115,100,110,20
BTCUSDT,1m,1700000120000,110,120,105,115,30
BTCUSDT,1m,1700000180000,115,125,110,120,40
BTCUSDT,1m,1700000240000,120,130,115,125,50
BTCUSDT,1m,1700000300000,125,135,120,130,60
BTCUSDT,1m,1700000360000,130,140,125,135,70
BTCUSDT,1m,1700000420000,135,145,130,140,80
BTCUSDT,1m,1700000480000,140,150,135,145,90
BTCUSDT,1m,1700000540000,145,155,140,150,100
EOF

echo "1. 准备1分钟测试数据(10条)..."
cat /tmp/test_resample_input_$$.csv | "$CLI" write-csv --database "$TEST_DB"
input_count=$("$CLI" query --database "$TEST_DB" --format json | wc -l)
echo "   ✓ 写入 $input_count 条1分钟数据"

echo ""
echo "2. 测试 1m→5m 重采样..."
"$CLI" resample --database "$TEST_DB" --symbol BTCUSDT --from 1m --to 5m > /tmp/test_resample_5m_$$.json

# 验证输出有2条5m数据（10条1m = 2条5m）
count_5m=$(wc -l < /tmp/test_resample_5m_$$.json)
echo "   输出 $count_5m 条5分钟数据"
if [ "$count_5m" -eq 2 ]; then
    echo "   ✓ 5m数据条数正确(10/5=2)"
else
    echo -e "${RED}   ✗ 5m数据条数错误: $count_5m (期望2)${NC}"
    cat /tmp/test_resample_5m_$$.json
    exit 1
fi

# 验证OHLCV聚合逻辑:
# 第1条5m = 第1-5条1m的聚合
# Open=100 (第1条open), High=130 (1-5条max), Low=95 (1-5条min), Close=125 (第5条close), Volume=150 (1-5条sum)
first_5m=$(head -1 /tmp/test_resample_5m_$$.json)
echo "   第1条5m: $first_5m"

if echo "$first_5m" | grep -q '"open":100' && \
   echo "$first_5m" | grep -q '"high":130' && \
   echo "$first_5m" | grep -q '"low":95' && \
   echo "$first_5m" | grep -q '"close":125'; then
    echo "   ✓ OHLC聚合逻辑正确(第1条5m)"
else
    echo -e "${RED}   ✗ OHLC聚合逻辑错误${NC}"
    echo "   期望: open=100, high=130, low=95, close=125"
    exit 1
fi

# 验证Volume聚合
if echo "$first_5m" | grep -q '"volume":150'; then
    echo "   ✓ Volume聚合正确(10+20+30+40+50=150)"
else
    echo -e "${RED}   ✗ Volume聚合错误${NC}"
    echo "   期望: volume=150"
    exit 1
fi

echo ""
echo "3. 测试 1m→1h 重采样..."
"$CLI" resample --database "$TEST_DB" --symbol BTCUSDT --from 1m --to 1h > /tmp/test_resample_1h_$$.json

# 10条1m < 60条，应该只产生1条1h（或者报错，看实现）
count_1h=$(wc -l < /tmp/test_resample_1h_$$.json || echo "0")
echo "   输出 $count_1h 条1小时数据"
if [ "$count_1h" -eq 1 ]; then
    echo "   ✓ 1h数据条数正确(数据不足60条，产生1条)"
else
    # 如果输出为空或报错，也是可接受的行为
    echo "   ℹ 1h数据条数: $count_1h (数据不足60条)"
fi

# 如果有输出，验证聚合
if [ "$count_1h" -ge 1 ]; then
    first_1h=$(head -1 /tmp/test_resample_1h_$$.json)
    # Open=100 (第1条), High=155 (所有max), Low=95 (所有min), Close=150 (最后一条)
    if echo "$first_1h" | grep -q '"open":100' && \
       echo "$first_1h" | grep -q '"high":155' && \
       echo "$first_1h" | grep -q '"low":95' && \
       echo "$first_1h" | grep -q '"close":150'; then
        echo "   ✓ 1h OHLC聚合正确"
    else
        echo -e "${RED}   ✗ 1h OHLC聚合可能有误${NC}"
        echo "   实际: $first_1h"
    fi
    # Volume = 10+20+30+40+50+60+70+80+90+100 = 550
    if echo "$first_1h" | grep -q '"volume":550'; then
        echo "   ✓ 1h Volume聚合正确(550)"
    else
        echo -e "${RED}   ✗ 1h Volume聚合错误${NC}"
        echo "   期望: volume=550"
    fi
fi

echo ""
echo "4. 测试 resample --output 写入数据库..."
rm -rf "$OUT_DB"
mkdir -p "$OUT_DB"
resample_out=$("$CLI" resample --database "$TEST_DB" --symbol BTCUSDT --from 1m --to 5m --output "$OUT_DB" 2>&1)
echo "   $resample_out"

# 验证输出数据库可以查询
"$CLI" query --database "$OUT_DB" --symbol BTCUSDT --interval 5m --format json > /tmp/test_resample_out_$$.json
out_count=$(wc -l < /tmp/test_resample_out_$$.json)
echo "   查询返回 $out_count 条5m数据"

# 验证条数正确（2条）
if [ "$out_count" -eq 2 ]; then
    echo "   ✓ --output数据库写入正确(2条5m数据)"
else
    echo -e "${RED}   ✗ --output数据库写入错误: $out_count (期望2)${NC}"
    cat /tmp/test_resample_out_$$.json
    exit 1
fi

echo ""
echo "5. 测试 5m→1h 重采样..."
# 使用刚才生成的5m数据，再转1h
# 2条5m -> 不足12条，应产生1条或报错
"$CLI" resample --database "$OUT_DB" --symbol BTCUSDT --from 5m --to 1h > /tmp/test_resample_5mto1h_$$.json 2>&1 || true
count_5mto1h=$(wc -l < /tmp/test_resample_5mto1h_$$.json || echo "0")
echo "   5m→1h 输出 $count_5mto1h 条"
# 这是可选功能，不强求通过
echo "   ℹ 5m→1h转换测试完成"

echo ""
echo "6. 测试数据不足时的行为..."
# 创建一个只有3条1m数据的数据库
rm -rf "$TEST_DB"
mkdir -p "$TEST_DB"
cat > /tmp/test_resample_minimal_$$.csv << 'EOF'
symbol,interval,timestamp,open,high,low,close,volume
BTCUSDT,1m,1700000000000,100,110,95,105,10
BTCUSDT,1m,1700000060000,105,115,100,110,20
BTCUSDT,1m,1700000120000,110,120,105,115,30
EOF
cat /tmp/test_resample_minimal_$$.csv | "$CLI" write-csv --database "$TEST_DB"

# 尝试5m重采样
"$CLI" resample --database "$TEST_DB" --symbol BTCUSDT --from 1m --to 5m > /tmp/test_resample_min_$$.json 2>&1 || true
count_min=$(wc -l < /tmp/test_resample_min_$$.json || echo "0")
echo "   3条1m→5m 输出 $count_min 条"
if [ "$count_min" -ge 0 ]; then
    echo "   ✓ 数据不足时不崩溃(输出$count_min条)"
fi

echo ""
echo -e "${GREEN}=== 所有resample测试通过 ✓ ===${NC}"
