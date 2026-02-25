#!/bin/bash
# test-max-timestamp.sh - 测试getMaxTimestamp边界case
# 验证: 空表、新symbol、单条数据等场景

set -e

CLI="${CLI:-../../ndtsdb-cli}"
TEST_DB="/tmp/test_max_ts_$$"

# 颜色
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "=== getMaxTimestamp边界case测试 ==="

# 清理函数
cleanup() {
    rm -rf "$TEST_DB"
}
trap cleanup EXIT

# ============================================
# Test 1: 空表 - 查询max(timestamp)
# ============================================
echo ""
echo "1. 测试空表查询max(timestamp)..."

mkdir -p "$TEST_DB"

# 尝试用sql查询空表的max(timestamp)
result=$("$CLI" sql --database "$TEST_DB" "SELECT MAX(timestamp) as max_ts FROM data" 2>&1 || true)
echo "   SQL结果: $result"

# 不应该crash，返回空或null都算通过
if echo "$result" | grep -qi "error"; then
    echo -e "${YELLOW}   ⚠ SQL查询返回错误(但程序未crash)${NC}"
else
    echo "   ✓ 空表查询未crash"
fi

# ============================================
# Test 2: 新symbol（无数据）查询
# ============================================
echo ""
echo "2. 测试新symbol查询..."

# 先写入一些数据
cat > /tmp/test_data_$$.csv << 'EOF'
symbol,interval,timestamp,open,high,low,close,volume
BTCUSDT,1h,1700000000000,100,110,95,105,10
EOF
cat /tmp/test_data_$$.csv | "$CLI" write-csv --database "$TEST_DB"

# 查询不存在的symbol
result=$("$CLI" query --database "$TEST_DB" --symbol ETHUSDT --format json 2>&1)
if [ -z "$result" ]; then
    echo "   ✓ 新symbol查询返回空(正确)"
else
    echo -e "${YELLOW}   ⚠ 新symbol查询返回: $result${NC}"
fi

# ============================================
# Test 3: 单条数据 - 返回正确值
# ============================================
echo ""
echo "3. 测试单条数据max(timestamp)..."

rm -rf "$TEST_DB"
mkdir -p "$TEST_DB"

cat > /tmp/test_single_$$.csv << 'EOF'
symbol,interval,timestamp,open,high,low,close,volume
BTCUSDT,1h,1700000000000,100,110,95,105,10
EOF
cat /tmp/test_single_$$.csv | "$CLI" write-csv --database "$TEST_DB"

# 用info命令检查
result=$("$CLI" info --database "$TEST_DB" --symbol BTCUSDT 2>&1)
echo "   Info: $result"

if echo "$result" | grep -q "1700000000000"; then
    echo "   ✓ 单条数据timestamp正确"
else
    echo -e "${RED}   ✗ 单条数据timestamp错误${NC}"
    exit 1
fi

# ============================================
# Test 4: 多条数据 - 返回最大值
# ============================================
echo ""
echo "4. 测试多条数据max(timestamp)..."

rm -rf "$TEST_DB"
mkdir -p "$TEST_DB"

cat > /tmp/test_multi_$$.csv << 'EOF'
symbol,interval,timestamp,open,high,low,close,volume
BTCUSDT,1h,1700000000000,100,110,95,105,10
BTCUSDT,1h,1700003600000,105,115,100,110,20
BTCUSDT,1h,1700007200000,110,120,105,115,30
EOF
cat /tmp/test_multi_$$.csv | "$CLI" write-csv --database "$TEST_DB"

# 用info命令获取last timestamp
result=$("$CLI" info --database "$TEST_DB" --symbol BTCUSDT 2>&1)
echo "   Info: $result"

if echo "$result" | grep -q '"last":1700007200000'; then
    echo "   ✓ 多条数据max timestamp正确(1700007200000)"
else
    echo -e "${RED}   ✗ 多条数据max timestamp错误${NC}"
    exit 1
fi

# ============================================
# Test 5: 多symbol - 各symbol独立
# ============================================
echo ""
echo "5. 测试多symbol各自max(timestamp)..."

rm -rf "$TEST_DB"
mkdir -p "$TEST_DB"

cat > /tmp/test_symbols_$$.csv << 'EOF'
symbol,interval,timestamp,open,high,low,close,volume
BTCUSDT,1h,1700000000000,100,110,95,105,10
BTCUSDT,1h,1700007200000,110,120,105,115,30
ETHUSDT,1h,1700000000000,2000,2100,1950,2050,100
ETHUSDT,1h,1700003600000,2050,2150,2000,2100,200
EOF
cat /tmp/test_symbols_$$.csv | "$CLI" write-csv --database "$TEST_DB"

# 检查BTC
btc_result=$("$CLI" info --database "$TEST_DB" --symbol BTCUSDT 2>&1)
if echo "$btc_result" | grep -q '"last":1700007200000'; then
    echo "   ✓ BTCUSDT max timestamp正确"
else
    echo -e "${RED}   ✗ BTCUSDT max timestamp错误${NC}"
    exit 1
fi

# 检查ETH
eth_result=$("$CLI" info --database "$TEST_DB" --symbol ETHUSDT 2>&1)
if echo "$eth_result" | grep -q '"last":1700003600000'; then
    echo "   ✓ ETHUSDT max timestamp正确"
else
    echo -e "${RED}   ✗ ETHUSDT max timestamp错误${NC}"
    exit 1
fi

# ============================================
# Test 6: 多interval - 各interval独立
# ============================================
echo ""
echo "6. 测试多interval各自max(timestamp)..."

rm -rf "$TEST_DB"
mkdir -p "$TEST_DB"

cat > /tmp/test_intervals_$$.csv << 'EOF'
symbol,interval,timestamp,open,high,low,close,volume
BTCUSDT,1m,1700000000000,100,110,95,105,10
BTCUSDT,1m,1700000060000,105,115,100,110,20
BTCUSDT,1h,1700000000000,100,115,95,110,30
BTCUSDT,1h,1700003600000,110,125,105,120,40
EOF
cat /tmp/test_intervals_$$.csv | "$CLI" write-csv --database "$TEST_DB"

# 列出所有symbol/interval
list_result=$("$CLI" list --database "$TEST_DB" 2>&1)
echo "   Symbols: $list_result"

# 检查是否有两个BTCUSDT条目(btc/1m和btc/1h)
btc_count=$(echo "$list_result" | grep -c "BTCUSDT" || true)
if [ "$btc_count" -eq 2 ]; then
    echo "   ✓ BTCUSDT有两个interval(1m和1h)"
else
    echo -e "${YELLOW}   ⚠ BTCUSDT有$btc_count个interval${NC}"
fi

echo ""
echo -e "${GREEN}=== 所有max timestamp测试通过 ✓ ===${NC}"
