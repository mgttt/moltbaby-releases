#!/bin/bash
# test-merge.sh - 测试 merge 命令
# 验证: 两库合并数据完整, 重复数据去重, 合并后query验证

set -e

CLI="${CLI:-../../ndtsdb-cli}"
SRC_DB="/tmp/test_ndtsdb_merge_src_$$"
DST_DB="/tmp/test_ndtsdb_merge_dst_$$"

# 颜色
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo "=== ndtsdb-cli merge 命令测试 ==="

# 清理函数
cleanup() {
    rm -rf "$SRC_DB" "$DST_DB" /tmp/test_merge_*.csv
}
trap cleanup EXIT

# 创建源数据库数据
mkdir -p "$SRC_DB"
cat > /tmp/test_merge_src_$$.csv << 'EOF'
symbol,interval,timestamp,open,high,low,close,volume
BTCUSDT,1m,1700000000000,30000,30100,29900,30050,100
BTCUSDT,1m,1700000060000,30050,30200,30000,30100,200
ETHUSDT,5m,1700000000000,2000,2010,1990,2005,500
EOF

echo "1. 准备源数据库..."
cat /tmp/test_merge_src_$$.csv | "$CLI" write-csv --database "$SRC_DB"
src_count=$("$CLI" query --database "$SRC_DB" --format json | wc -l)
echo "   ✓ 源库数据: $src_count 条"

# 创建目标数据库数据（部分重叠）
mkdir -p "$DST_DB"
cat > /tmp/test_merge_dst_$$.csv << 'EOF'
symbol,interval,timestamp,open,high,low,close,volume
BTCUSDT,1m,1700000000000,30000,30100,29900,30050,100
BTCUSDT,1m,1700000120000,30100,30300,30050,30250,150
SOLUSDT,1m,1700000000000,100,105,95,102,1000
EOF

echo ""
echo "2. 准备目标数据库(含重叠数据)..."
cat /tmp/test_merge_dst_$$.csv | "$CLI" write-csv --database "$DST_DB"
dst_count=$("$CLI" query --database "$DST_DB" --format json | wc -l)
echo "   ✓ 目标库初始数据: $dst_count 条"

# 验证重叠数据: BTCUSDT/1m/1700000000000 在两库都存在

echo ""
echo "3. 执行 merge..."
merge_output=$("$CLI" merge --from "$SRC_DB" --to "$DST_DB" 2>&1)
echo "   $merge_output"

# 检查输出包含合并统计
if echo "$merge_output" | grep -q "Merged"; then
    echo "   ✓ merge命令执行成功"
else
    echo -e "${RED}   ✗ merge命令输出异常${NC}"
    exit 1
fi

echo ""
echo "4. 验证合并后数据完整性..."
# 查询合并后的数据库
"$CLI" query --database "$DST_DB" --format json > /tmp/test_merge_result_$$.json

# merge命令现在会对重复数据进行去重
# 源库: BTCUSDT(2条) + ETHUSDT(1条) = 3条
# 目标库原有: BTCUSDT(1条重叠+1条新) + SOLUSDT(1条) = 3条
# 合并后: 3 + 3 - 1(重叠) = 5条 (BTCUSDT重叠的去重，保留目标库版本)
total_count=$(wc -l < /tmp/test_merge_result_$$.json)
echo "   合并后总记录数: $total_count"

if [ "$total_count" -eq 5 ]; then
    echo "   ✓ 合并后记录数正确(5条，已去重)"
else
    echo -e "${RED}   ✗ 合并后记录数错误: $total_count (期望5条)${NC}"
    cat /tmp/test_merge_result_$$.json
    exit 1
fi

# 验证各symbol都存在
if grep -q "BTCUSDT" /tmp/test_merge_result_$$.json && \
   grep -q "ETHUSDT" /tmp/test_merge_result_$$.json && \
   grep -q "SOLUSDT" /tmp/test_merge_result_$$.json; then
    echo "   ✓ 所有symbol都存在"
else
    echo -e "${RED}   ✗ 缺少某些symbol${NC}"
    exit 1
fi

echo ""
echo "5. 测试 merge --symbol 过滤..."
# 新建一个干净的目标库
rm -rf "$DST_DB"
mkdir -p "$DST_DB"
"$CLI" merge --from "$SRC_DB" --to "$DST_DB" --symbol BTCUSDT 2>&1

# 验证只合并了BTCUSDT
"$CLI" query --database "$DST_DB" --format json > /tmp/test_merge_filtered_$$.json
if grep -q "BTCUSDT" /tmp/test_merge_filtered_$$.json && ! grep -q "ETHUSDT" /tmp/test_merge_filtered_$$.json; then
    echo "   ✓ --symbol过滤生效"
else
    echo -e "${RED}   ✗ --symbol过滤失败${NC}"
    cat /tmp/test_merge_filtered_$$.json
    exit 1
fi

echo ""
echo "6. 测试 merge 去重功能..."
# 创建两个有重叠数据的数据库
OVERLAP_SRC="/tmp/test_overlap_src_$$"
OVERLAP_DST="/tmp/test_overlap_dst_$$"
mkdir -p "$OVERLAP_SRC" "$OVERLAP_DST"

# 源库：BTC 3条（ts=1000,2000,3000）
cat > /tmp/overlap_src.csv << 'EOF'
symbol,interval,timestamp,open,high,low,close,volume
BTCUSDT,1m,1000,100,110,90,105,1000
BTCUSDT,1m,2000,200,210,190,205,2000
BTCUSDT,1m,3000,300,310,290,305,3000
EOF
cat /tmp/overlap_src.csv | "$CLI" write-csv --database "$OVERLAP_SRC"

# 目标库：BTC 2条（ts=1000,4000）- ts=1000是重叠的
cat > /tmp/overlap_dst.csv << 'EOF'
symbol,interval,timestamp,open,high,low,close,volume
BTCUSDT,1m,1000,999,999,999,999,9999
BTCUSDT,1m,4000,400,410,390,405,4000
EOF
cat /tmp/overlap_dst.csv | "$CLI" write-csv --database "$OVERLAP_DST"

# 执行 merge
merge_out=$("$CLI" merge --from "$OVERLAP_SRC" --to "$OVERLAP_DST" 2>&1)
echo "   $merge_out"

# 验证合并后数据：应该有 4 条（ts=1000保留目标库版本，ts=2000,3000从源库，ts=4000目标库原有）
"$CLI" query --database "$OVERLAP_DST" --format json > /tmp/overlap_result_$$.json
total_after=$(wc -l < /tmp/overlap_result_$$.json)

# 检查 ts=1000 的数据是目标库版本（close=999）
if grep -q '"close":999' /tmp/overlap_result_$$.json; then
    echo "   ✓ 重叠数据保留目标库版本（后写入优先）"
else
    echo -e "${RED}   ✗ 重叠数据未正确处理${NC}"
    cat /tmp/overlap_result_$$.json
    rm -rf "$OVERLAP_SRC" "$OVERLAP_DST"
    exit 1
fi

# 检查总记录数
if [ "$total_after" -eq 4 ]; then
    echo "   ✓ 去重后总记录数正确: $total_after (源库3条+目标库2条-重叠1条)"
else
    echo -e "${RED}   ✗ 去重后记录数错误: $total_after (期望4)${NC}"
    cat /tmp/overlap_result_$$.json
    rm -rf "$OVERLAP_SRC" "$OVERLAP_DST"
    exit 1
fi

# 检查 merge 输出包含 duplicates 统计
if echo "$merge_out" | grep -q "duplicates"; then
    echo "   ✓ merge 输出包含重复统计"
else
    echo -e "${RED}   ✗ merge 输出缺少重复统计${NC}"
    rm -rf "$OVERLAP_SRC" "$OVERLAP_DST"
    exit 1
fi

rm -rf "$OVERLAP_SRC" "$OVERLAP_DST"

echo ""
echo "7. 测试 merge --symbol --interval 双重过滤..."
# 准备新源数据（含不同interval）
mkdir -p "$SRC_DB"
rm -rf "$SRC_DB"/* 2>/dev/null || true
cat > /tmp/test_merge_src2_$$.csv << 'EOF'
symbol,interval,timestamp,open,high,low,close,volume
BTCUSDT,1m,1700000000000,30000,30100,29900,30050,100
BTCUSDT,5m,1700000000000,30000,30100,29900,30050,500
BTCUSDT,15m,1700000000000,30000,30100,29900,30050,1000
EOF
cat /tmp/test_merge_src2_$$.csv | "$CLI" write-csv --database "$SRC_DB"

rm -rf "$DST_DB"
mkdir -p "$DST_DB"
"$CLI" merge --from "$SRC_DB" --to "$DST_DB" --symbol BTCUSDT --interval 1m 2>&1

"$CLI" query --database "$DST_DB" --format json > /tmp/test_merge_filtered2_$$.json
only_1m=$(grep -c '"interval":"1m"' /tmp/test_merge_filtered2_$$.json || true)
other_intervals=$(grep -v '"interval":"1m"' /tmp/test_merge_filtered2_$$.json | grep -c "BTCUSDT" || true)

if [ "$only_1m" -eq 1 ] && [ "$other_intervals" -eq 0 ]; then
    echo "   ✓ --symbol + --interval双重过滤生效"
else
    echo -e "${RED}   ✗ 双重过滤失败${NC}"
    cat /tmp/test_merge_filtered2_$$.json
    exit 1
fi

echo ""
echo -e "${GREEN}=== 所有merge测试通过 ✓ ===${NC}"
