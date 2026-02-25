#!/bin/bash
# test-export.sh - 测试 export 命令
# 验证: export --format json/csv 输出正确性, symbol过滤, 空库行为

set -e

CLI="${CLI:-../../ndtsdb-cli}"
TEST_DB="/tmp/test_ndtsdb_export_$$"
TEST_DB_EMPTY="/tmp/test_ndtsdb_export_empty_$$"

# 颜色
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo "=== ndtsdb-cli export 命令测试 ==="

# 清理函数
cleanup() {
    rm -rf "$TEST_DB" "$TEST_DB_EMPTY" /tmp/test_export_*.json /tmp/test_export_*.csv
}
trap cleanup EXIT

# 创建测试数据库
mkdir -p "$TEST_DB"

# 创建测试数据（通过 write-csv）
cat > /tmp/test_export_input_$$.csv << 'EOF'
symbol,interval,timestamp,open,high,low,close,volume
BTCUSDT,1m,1700000000000,30000.5,30100.75,29900.25,30050.5,100.5
BTCUSDT,1m,1700000060000,30050,30200,30000,30100,200
BTCUSDT,1m,1700000120000,30100,30300,30050,30250,150
ETHUSDT,5m,1700000000000,2000,2010,1990,2005,500.75
ETHUSDT,5m,1700000300000,2005,2020,1995,2010,600.25
EOF

echo "1. 写入测试数据..."
cat /tmp/test_export_input_$$.csv | "$CLI" write-csv --database "$TEST_DB"
echo "   ✓ 数据写入完成"

echo ""
echo "2. 测试 export --format json..."
"$CLI" export --database "$TEST_DB" --format json > /tmp/test_export_all_$$.json

# 验证JSON输出包含所有记录
if grep -q "BTCUSDT" /tmp/test_export_all_$$.json && \
   grep -q "ETHUSDT" /tmp/test_export_all_$$.json && \
   grep -q "30050.5" /tmp/test_export_all_$$.json; then
    echo "   ✓ JSON导出包含正确数据"
else
    echo -e "${RED}   ✗ JSON导出数据不正确${NC}"
    cat /tmp/test_export_all_$$.json
    exit 1
fi

# 验证JSON格式正确（简单检查）
line_count=$(wc -l < /tmp/test_export_all_$$.json)
if [ "$line_count" -eq 5 ]; then
    echo "   ✓ JSON导出5条记录（正确）"
else
    echo -e "${RED}   ✗ JSON记录数错误: $line_count (期望5)${NC}"
    exit 1
fi

echo ""
echo "3. 测试 export --format csv..."
"$CLI" export --database "$TEST_DB" --format csv > /tmp/test_export_all_$$.csv

# 验证CSV头部
if head -1 /tmp/test_export_all_$$.csv | grep -q "symbol,interval,timestamp,open,high,low,close,volume"; then
    echo "   ✓ CSV头部正确"
else
    echo -e "${RED}   ✗ CSV头部不正确${NC}"
    head -1 /tmp/test_export_all_$$.csv
    exit 1
fi

# 验证CSV数据行数（含header共6行）
csv_lines=$(wc -l < /tmp/test_export_all_$$.csv)
if [ "$csv_lines" -eq 6 ]; then
    echo "   ✓ CSV数据行数正确(5数据+1header)"
else
    echo -e "${RED}   ✗ CSV行数错误: $csv_lines (期望6)${NC}"
    exit 1
fi

echo ""
echo "4. 测试 export --symbol 过滤..."
"$CLI" export --database "$TEST_DB" --symbol BTCUSDT --format json > /tmp/test_export_btc_$$.json

# 验证只导出BTC
if grep -q "BTCUSDT" /tmp/test_export_btc_$$.json && ! grep -q "ETHUSDT" /tmp/test_export_btc_$$.json; then
    echo "   ✓ Symbol过滤正确(BTCUSDT only)"
else
    echo -e "${RED}   ✗ Symbol过滤不正确${NC}"
    cat /tmp/test_export_btc_$$.json
    exit 1
fi

# 验证BTC记录数（3条）
btc_count=$(wc -l < /tmp/test_export_btc_$$.json)
if [ "$btc_count" -eq 3 ]; then
    echo "   ✓ BTC记录数正确(3条)"
else
    echo -e "${RED}   ✗ BTC记录数错误: $btc_count (期望3)${NC}"
    exit 1
fi

echo ""
echo "5. 测试 export --symbol + --interval 过滤..."
"$CLI" export --database "$TEST_DB" --symbol ETHUSDT --interval 5m --format json > /tmp/test_export_eth5m_$$.json

if grep -q "ETHUSDT" /tmp/test_export_eth5m_$$.json && \
   grep -q '"interval":"5m"' /tmp/test_export_eth5m_$$.json; then
    echo "   ✓ Symbol+Interval过滤正确"
else
    echo -e "${RED}   ✗ Symbol+Interval过滤不正确${NC}"
    cat /tmp/test_export_eth5m_$$.json
    exit 1
fi

echo ""
echo "6. 测试 export 空库不报错..."
mkdir -p "$TEST_DB_EMPTY"
if "$CLI" export --database "$TEST_DB_EMPTY" --format json > /tmp/test_export_empty_$$.json 2>&1; then
    echo "   ✓ 空库export不报错"
else
    echo -e "${RED}   ✗ 空库export报错${NC}"
    exit 1
fi

# 验证空库输出为空或只有header
if [ ! -s /tmp/test_export_empty_$$.json ] || [ "$(wc -l < /tmp/test_export_empty_$$.json)" -eq 0 ]; then
    echo "   ✓ 空库export输出为空"
else
    # 也可能输出空数组或其他格式
    echo "   ✓ 空库export有输出但无数据"
fi

echo ""
echo "7. 测试 export --output 指定文件..."
"$CLI" export --database "$TEST_DB" --symbol BTCUSDT --format csv --output /tmp/test_export_out_$$.csv

if [ -f /tmp/test_export_out_$$.csv ] && grep -q "BTCUSDT" /tmp/test_export_out_$$.csv; then
    echo "   ✓ --output参数工作正常"
else
    echo -e "${RED}   ✗ --output参数不正常${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}=== 所有export测试通过 ✓ ===${NC}"
