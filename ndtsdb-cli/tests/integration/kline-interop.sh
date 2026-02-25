#!/bin/bash
# kline-cli ↔ ndtsdb-cli 跨工具集成测试
# 验证: kline-cli(Bun PartitionedTable写) ↔ ndtsdb-cli(C native读)

set -e

# 颜色输出
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

TEST_DIR="/tmp/kline-interop-test-$$"
KLINE_CLI="/home/devali/moltbaby/tools/kline-cli/kline.ts"
NDTSDB_CLI="/home/devali/moltbaby/ndtsdb-cli/ndtsdb-cli"

echo "=========================================="
echo "  kline-cli ↔ ndtsdb-cli 跨工具集成测试"
echo "=========================================="
echo ""
echo "测试目录: $TEST_DIR"
echo ""

# 清理函数
cleanup() {
    if [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
        echo ""
        echo "清理测试目录: $TEST_DIR"
    fi
}
trap cleanup EXIT

# 检查依赖
if [ ! -f "$KLINE_CLI" ]; then
    echo -e "${RED}❌ kline-cli 不存在: $KLINE_CLI${NC}"
    exit 1
fi

if [ ! -f "$NDTSDB_CLI" ]; then
    echo -e "${RED}❌ ndtsdb-cli 不存在: $NDTSDB_CLI${NC}"
    exit 1
fi

echo "✅ 依赖检查通过"
echo ""

# ============================================
# 步骤1: kline-cli fetch 写入数据
# ============================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步骤1: kline-cli fetch BTCUSDT 1h --limit 50 --format ndtsdb"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

mkdir -p "$TEST_DIR"

cd /home/devali/moltbaby/tools/kline-cli
bun kline.ts fetch BTCUSDT 1h --limit 50 --format ndtsdb --output "$TEST_DIR" 2>&1

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ 步骤1失败: kline-cli fetch 执行失败${NC}"
    exit 1
fi

echo -e "${GREEN}✅ 步骤1通过: kline-cli fetch 完成${NC}"
echo ""

# 检查数据文件是否创建 (ndtsdb-cli按日期分区输出.ndts文件)
NDTS_COUNT=$(ls -1 "$TEST_DIR"/*.ndts 2>/dev/null | wc -l)
if [ "$NDTS_COUNT" -eq 0 ]; then
    echo -e "${RED}❌ 数据文件未创建: $TEST_DIR/*.ndts${NC}"
    ls -la "$TEST_DIR/" 2>&1 || true
    exit 1
fi

echo "数据文件列表:"
ls -la "$TEST_DIR/" 2>&1
echo ""

# ============================================
# 步骤2: ndtsdb-cli list 验证能读到BTCUSDT
# ============================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步骤2: ndtsdb-cli list --database $TEST_DIR"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

LIST_OUTPUT=$("$NDTSDB_CLI" list --database "$TEST_DIR" 2>&1)
LIST_EXIT=$?

echo "输出: $LIST_OUTPUT"

if [ $LIST_EXIT -ne 0 ]; then
    echo -e "${RED}❌ 步骤2失败: ndtsdb-cli list 返回错误${NC}"
    exit 1
fi

# 验证输出包含BTCUSDT (kline-cli通过ndtsdb-cli write-json写入正确symbol)
if echo "$LIST_OUTPUT" | grep -q "BTCUSDT"; then
    echo -e "${GREEN}✅ 步骤2通过: 成功读取到BTCUSDT${NC}"
else
    echo -e "${RED}❌ 步骤2失败: 未找到BTCUSDT${NC}"
    echo "实际输出: $LIST_OUTPUT"
    exit 1
fi
echo ""

# ============================================
# 步骤3: ndtsdb-cli query 验证能查数据
# ============================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步骤3: ndtsdb-cli query --symbols BTCUSDT --limit 5"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

QUERY_OUTPUT=$("$NDTSDB_CLI" query --database "$TEST_DIR" --symbols BTCUSDT --limit 5 2>&1)
QUERY_EXIT=$?

echo "输出 (前5行):"
echo "$QUERY_OUTPUT" | head -5

if [ $QUERY_EXIT -ne 0 ]; then
    echo -e "${RED}❌ 步骤3失败: ndtsdb-cli query 返回错误${NC}"
    exit 1
fi

# 验证输出行数和symbol
LINE_COUNT=$(echo "$QUERY_OUTPUT" | wc -l)
if [ "$LINE_COUNT" -ge 5 ] && echo "$QUERY_OUTPUT" | grep -q "BTCUSDT"; then
    echo -e "${GREEN}✅ 步骤3通过: 成功查询到BTCUSDT数据 ($LINE_COUNT 行)${NC}"
else
    echo -e "${RED}❌ 步骤3失败: 数据行数不足或symbol不正确${NC}"
    exit 1
fi
echo ""

# ============================================
# 步骤4: ndtsdb-cli query --format csv 验证CSV输出
# ============================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步骤4: ndtsdb-cli query --format csv --limit 3"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

CSV_OUTPUT=$("$NDTSDB_CLI" query --format csv --database "$TEST_DIR" --limit 3 2>&1)
CSV_EXIT=$?

echo "输出:"
echo "$CSV_OUTPUT"

if [ $CSV_EXIT -ne 0 ]; then
    echo -e "${RED}❌ 步骤4失败: ndtsdb-cli query --format csv 返回错误${NC}"
    exit 1
fi

# 验证CSV格式: 首行应为header
if echo "$CSV_OUTPUT" | head -1 | grep -q "timestamp,symbol,interval,open,high,low,close,volume"; then
    echo -e "${GREEN}✅ 步骤4通过: CSV格式正确${NC}"
else
    echo -e "${RED}❌ 步骤4失败: CSV header格式不正确${NC}"
    echo "期望: timestamp,symbol,interval,open,high,low,close,volume"
    echo "实际: $(echo "$CSV_OUTPUT" | head -1)"
    exit 1
fi

# 验证数据行数 (header + 3行数据 = 4行)
CSV_LINE_COUNT=$(echo "$CSV_OUTPUT" | wc -l)
if [ "$CSV_LINE_COUNT" -ge 4 ]; then
    echo -e "${GREEN}✅ 步骤4通过: CSV数据行数正确 ($CSV_LINE_COUNT 行)${NC}"
else
    echo -e "${RED}❌ 步骤4失败: CSV数据行数不足 ($CSV_LINE_COUNT 行)${NC}"
    exit 1
fi
echo ""

# ============================================
# 全部通过
# ============================================
echo "=========================================="
echo -e "${GREEN}  所有步骤通过 ✅${NC}"
echo "=========================================="
echo ""
echo "测试覆盖:"
echo "  ✅ 步骤1: kline-cli fetch 写入ndtsdb格式"
echo "  ✅ 步骤2: ndtsdb-cli list 读取symbol列表"
echo "  ✅ 步骤3: ndtsdb-cli query 查询数据"
echo "  ✅ 步骤4: ndtsdb-cli query --format csv CSV输出"
echo ""
echo "跨工具互通性验证通过:"
echo "  kline-cli (Bun PartitionedTable写) ↔ ndtsdb-cli (C native读)"

exit 0
