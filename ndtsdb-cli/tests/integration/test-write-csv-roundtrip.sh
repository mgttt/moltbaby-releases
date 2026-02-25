#!/bin/bash
# test-write-csv-roundtrip.sh - 测试 write-csv 往返一致性
# 验证: query --format csv | write-csv -> 数据一致

set -e

CLI="${CLI:-../../ndtsdb-cli}"
TEST_DB="/tmp/test_ndtsdb_roundtrip_$$"
TEST_CSV="/tmp/test_input_$$.csv"

echo "=== ndtsdb-cli write-csv 往返测试 ==="

# 清理函数
cleanup() {
    rm -rf "$TEST_DB" "$TEST_CSV"
}
trap cleanup EXIT

# 创建测试CSV (symbol,interval,timestamp,open,high,low,close,volume)
cat > "$TEST_CSV" << 'EOF'
symbol,interval,timestamp,open,high,low,close,volume
BTCUSDT,1m,1700000000000,30000.5,30100.75,29900.25,30050.5,100.5
BTCUSDT,1m,1700000060000,30050,30200,30000,30100,200
ETHUSDT,5m,1700000000000,2000,2010,1990,2005,500.75
ETHUSDT,5m,1700000300000,2005,2020,1995,2010,600.25
EOF

# 创建测试数据库目录
mkdir -p "$TEST_DB"

echo "1. 写入CSV到数据库..."
cat "$TEST_CSV" | "$CLI" write-csv --database "$TEST_DB"

echo ""
echo "2. 查询并输出CSV..."
"$CLI" query --database "$TEST_DB" --format csv > /tmp/queried_$$.csv

echo ""
echo "3. 验证数据一致性..."
# 统计行数（去掉header）
input_count=$(tail -n +2 "$TEST_CSV" | wc -l)
queried_count=$(tail -n +2 /tmp/queried_$$.csv | wc -l)

echo "   输入行数: $input_count"
echo "   查询行数: $queried_count"

if [ "$input_count" -eq "$queried_count" ]; then
    echo "   ✓ 行数一致"
else
    echo "   ✗ 行数不一致!"
    exit 1
fi

# 验证关键数据点
if grep -q "30050.5" /tmp/queried_$$.csv && grep -q "ETHUSDT" /tmp/queried_$$.csv; then
    echo "   ✓ 数据内容正确"
else
    echo "   ✗ 数据内容缺失!"
    exit 1
fi

echo ""
echo "4. 测试错误行跳过..."
cat > /tmp/bad_csv_$$.csv << 'EOF'
symbol,interval,timestamp,open,high,low,close,volume
BTCUSDT,1m,1700000000000,30000,30100,29900,30050,100.5
BAD_LINE_ONLY_3_COLS,a,b
ETHUSDT,1m,1700000060000,2000,2010,1990,2005,500
EOF

rm -rf "$TEST_DB" && mkdir -p "$TEST_DB"
output=$(cat /tmp/bad_csv_$$.csv | "$CLI" write-csv --database "$TEST_DB" 2>&1)

if echo "$output" | grep -q "2 rows inserted, 1 errors"; then
    echo "   ✓ 错误行正确跳过并统计"
else
    echo "   ✗ 错误处理不正确: $output"
    exit 1
fi

echo ""
echo "=== 所有测试通过 ✓ ==="

# 清理临时文件
rm -f /tmp/queried_$$.csv /tmp/bad_csv_$$.csv
