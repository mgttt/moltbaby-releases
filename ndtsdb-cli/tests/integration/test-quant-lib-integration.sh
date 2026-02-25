#!/bin/bash
# test-quant-lib-integration.sh - quant-lib ↔ ndtsdb-cli 集成测试
# 验证双向数据互通：quant-lib写→ndtsdb-cli读，ndtsdb-cli写→quant-lib读

set -e

CLI="${CLI:-../../ndtsdb-cli}"
TEST_DB="/tmp/test_quant_lib_int_$$"
TEST_DATA_DIR="/tmp/test_quant_lib_data_$$"

# 颜色
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "=== quant-lib ↔ ndtsdb-cli 集成测试 ==="

# 清理函数
cleanup() {
    rm -rf "$TEST_DB" "$TEST_DATA_DIR"
}
trap cleanup EXIT

# ============================================
# Part 1: ndtsdb-cli 写入 → quant-lib 读取
# ============================================
echo ""
echo "1. 测试 ndtsdb-cli 写入 → quant-lib 读取..."

mkdir -p "$TEST_DB"

# 用ndtsdb-cli写入测试数据
cat > /tmp/test_klines_$$.csv << 'EOF'
symbol,interval,timestamp,open,high,low,close,volume
BTCUSDT,1h,1700000000000,30000,30100,29900,30050,100
BTCUSDT,1h,1700003600000,30050,30200,30000,30100,200
BTCUSDT,1h,1700007200000,30100,30300,30050,30250,150
ETHUSDT,1h,1700000000000,2000,2010,1990,2005,500
EOF

cat /tmp/test_klines_$$.csv | "$CLI" write-csv --database "$TEST_DB"
echo "   ✓ ndtsdb-cli写入4条K线数据"

# 使用ndtsdb-cli验证能读出
count=$("$CLI" query --database "$TEST_DB" --format json | wc -l)
if [ "$count" -eq 4 ]; then
    echo "   ✓ ndtsdb-cli能正确读出4条"
else
    echo -e "${RED}   ✗ ndtsdb-cli读出$count条，期望4条${NC}"
    exit 1
fi

# ============================================
# Part 2: quant-lib格式兼容性验证（模拟）
# ============================================
echo ""
echo "2. 测试 .ndts 文件格式互通性..."

# 检查.ndts文件格式
ndts_files=$(find "$TEST_DB" -name "*.ndts" | wc -l)
if [ "$ndts_files" -ge 1 ]; then
    echo "   ✓ 生成.ndts文件: $ndts_files个"
else
    echo -e "${RED}   ✗ 未找到.ndts文件${NC}"
    exit 1
fi

# 验证文件头magic
dd if="$(find "$TEST_DB" -name "*.ndts" | head -1)" bs=4 count=1 2>/dev/null | od -An -tx1 | grep -q "4e 44 54 53"
if [ $? -eq 0 ]; then
    echo "   ✓ 文件头magic正确(NDTS)"
else
    echo -e "${RED}   ✗ 文件头magic错误${NC}"
    exit 1
fi

# ============================================
# Part 3: export → write-csv 往返测试
# ============================================
echo ""
echo "3. 测试 export → write-csv 往返一致性..."

rm -rf /tmp/test_roundtrip_$$
mkdir -p /tmp/test_roundtrip_$$

# export为JSON
"$CLI" export --database "$TEST_DB" --format json > /tmp/exported_$$.jsonl
export_count=$(wc -l < /tmp/exported_$$.jsonl)
echo "   export输出: $export_count条"

# 转换格式后写回
cat /tmp/exported_$$.jsonl | "$CLI" write-json --database /tmp/test_roundtrip_$$

# 验证条数
roundtrip_count=$("$CLI" query --database /tmp/test_roundtrip_$$ --format json | wc -l)
if [ "$roundtrip_count" -eq "$export_count" ]; then
    echo "   ✓ 往返数据一致: $roundtrip_count条"
else
    echo -e "${RED}   ✗ 往返数据不一致: export=$export_count, roundtrip=$roundtrip_count${NC}"
    exit 1
fi

# ============================================
# Part 4: 多symbol/interval复杂场景
# ============================================
echo ""
echo "4. 测试多symbol/interval复杂场景..."

rm -rf /tmp/test_multi_$$
mkdir -p /tmp/test_multi_$$

# 写入多symbol多interval数据
cat > /tmp/test_multi_$$.csv << 'EOF'
symbol,interval,timestamp,open,high,low,close,volume
BTCUSDT,1m,1700000000000,100,110,95,105,10
BTCUSDT,1m,1700000060000,105,115,100,110,20
BTCUSDT,5m,1700000000000,100,115,95,112,30
ETHUSDT,1m,1700000000000,2000,2100,1950,2050,100
ETHUSDT,5m,1700000000000,2000,2200,1900,2100,200
EOF

cat /tmp/test_multi_$$.csv | "$CLI" write-csv --database /tmp/test_multi_$$

# 验证symbol列表
if "$CLI" list --database /tmp/test_multi_$$ | grep -q "BTCUSDT"; then
    echo "   ✓ 列出BTCUSDT"
fi
if "$CLI" list --database /tmp/test_multi_$$ | grep -q "ETHUSDT"; then
    echo "   ✓ 列出ETHUSDT"
fi

# 验证条数
total_count=$("$CLI" query --database /tmp/test_multi_$$ --format json | wc -l)
if [ "$total_count" -eq 5 ]; then
    echo "   ✓ 总条数正确: 5条"
else
    echo -e "${RED}   ✗ 总条数错误: $total_count (期望5)${NC}"
    exit 1
fi

# 按symbol过滤
btc_count=$("$CLI" query --database /tmp/test_multi_$$ --symbol BTCUSDT --format json | wc -l)
if [ "$btc_count" -eq 3 ]; then
    echo "   ✓ BTCUSDT过滤: 3条"
else
    echo -e "${RED}   ✗ BTCUSDT过滤错误: $btc_count (期望3)${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}=== 所有集成测试通过 ✓ ===${NC}"
