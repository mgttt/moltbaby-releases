#!/bin/bash
# ndtsdb-cli 性能基准测试脚本 - 百万级数据版本

set -e

# 颜色输出
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 测试数据目录
TEST_DATA_DIR="/tmp/ndtsdb-bench-$$"
mkdir -p "$TEST_DATA_DIR"

# ndtsdb-cli 路径
CLI="../../ndtsdb-cli"

# ============================================
# 配置参数 - 百万级数据
# ============================================
SYMBOL_COUNT=1000
KLINES_PER_SYMBOL=1000
TOTAL_RECORDS=$((SYMBOL_COUNT * KLINES_PER_SYMBOL))

# 转换为K/M显示
if [ $TOTAL_RECORDS -ge 1000000 ]; then
  RECORDS_DISPLAY="$(echo "scale=1; $TOTAL_RECORDS / 1000000" | bc)M"
else
  RECORDS_DISPLAY="$(echo "scale=1; $TOTAL_RECORDS / 1000" | bc)K"
fi

echo "=========================================="
echo "  ndtsdb-cli 百万级性能基准测试"
echo "=========================================="
echo ""
echo "测试数据目录: $TEST_DATA_DIR"
echo "配置: $SYMBOL_COUNT symbols × $KLINES_PER_SYMBOL klines = $RECORDS_DISPLAY 条数据"
echo ""

# ============================================
# 场景1: 写入Benchmark
# ============================================
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}场景1: 写入Benchmark (百万级)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# 创建写入测试脚本
cat > "$TEST_DATA_DIR/write-bench.js" << EOF
import * as ndtsdb from 'ndtsdb';

const dataDir = process.env.TEST_DATA_DIR;
const handle = ndtsdb.open(\`\${dataDir}/\`);

const startTime = 1700000000000n;
const symbolCount = $SYMBOL_COUNT;
const klinesPerSymbol = $KLINES_PER_SYMBOL;

// 写入数据
for (let s = 0; s < symbolCount; s++) {
  const symbol = \`SYM\${String(s).padStart(4, '0')}\`;
  for (let k = 0; k < klinesPerSymbol; k++) {
    ndtsdb.insert(handle, symbol, '1h', {
      timestamp: startTime + BigInt(k * 3600000),
      open: 50000.0 + s + k,
      high: 50100.0 + s + k,
      low: 49900.0 + s + k,
      close: 50000.0 + s + k,
      volume: 1000 + s + k,
    });
  }
}

ndtsdb.close(handle);
EOF

echo "开始写入 $RECORDS_DISPLAY 条数据..."
START_TIME=$(date +%s%N)
TEST_DATA_DIR="$TEST_DATA_DIR" $CLI "$TEST_DATA_DIR/write-bench.js" > /dev/null 2>&1
END_TIME=$(date +%s%N)

WRITE_TIME_MS=$(( (END_TIME - START_TIME) / 1000000 ))
WRITE_RATE=$(( TOTAL_RECORDS * 1000 / WRITE_TIME_MS ))

# 转换为K/M显示速率
if [ $WRITE_RATE -ge 1000000 ]; then
  RATE_DISPLAY="$(echo "scale=2; $WRITE_RATE / 1000000" | bc)M"
elif [ $WRITE_RATE -ge 1000 ]; then
  RATE_DISPLAY="$(echo "scale=1; $WRITE_RATE / 1000" | bc)K"
else
  RATE_DISPLAY="$WRITE_RATE"
fi

echo -e "${GREEN}✓ 写入完成${NC}"
echo "  数据量: $RECORDS_DISPLAY 条 ($SYMBOL_COUNT symbols × $KLINES_PER_SYMBOL klines)"
echo "  耗时: ${WRITE_TIME_MS}ms"
echo "  速率: ~${RATE_DISPLAY}条/秒"
echo ""

# ============================================
# 场景2: Query Benchmark
# ============================================
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}场景2: Query Benchmark (百万级数据)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# 2a: 全量查询
echo "2a. 全量查询 (10次取平均)..."
TOTAL_TIME=0
for i in {1..10}; do
  START=$(date +%s%N)
  $CLI query --database "$TEST_DATA_DIR" > /dev/null 2>&1
  END=$(date +%s%N)
  TOTAL_TIME=$((TOTAL_TIME + (END - START) / 1000000))
done
AVG_TIME=$((TOTAL_TIME / 10))
echo -e "  ${GREEN}✓ 平均耗时: ${AVG_TIME}ms${NC}"
echo ""

# 2b: 单一symbol查询
echo "2b. 单一symbol查询 SYM0001 (10次取平均)..."
TOTAL_TIME=0
for i in {1..10}; do
  START=$(date +%s%N)
  $CLI query --database "$TEST_DATA_DIR" --symbols SYM0001 > /dev/null 2>&1
  END=$(date +%s%N)
  TOTAL_TIME=$((TOTAL_TIME + (END - START) / 1000000))
done
AVG_TIME=$((TOTAL_TIME / 10))
echo -e "  ${GREEN}✓ 平均耗时: ${AVG_TIME}ms${NC}"
echo ""

# 2c: limit 100查询
echo "2c. Limit 100查询 (10次取平均)..."
TOTAL_TIME=0
for i in {1..10}; do
  START=$(date +%s%N)
  $CLI query --database "$TEST_DATA_DIR" --limit 100 > /dev/null 2>&1
  END=$(date +%s%N)
  TOTAL_TIME=$((TOTAL_TIME + (END - START) / 1000000))
done
AVG_TIME=$((TOTAL_TIME / 10))
echo -e "  ${GREEN}✓ 平均耗时: ${AVG_TIME}ms${NC}"
echo ""

# 2d: 大数据量limit查询
echo "2d. Limit 10,000查询 (5次取平均)..."
TOTAL_TIME=0
for i in {1..5}; do
  START=$(date +%s%N)
  $CLI query --database "$TEST_DATA_DIR" --limit 10000 > /dev/null 2>&1
  END=$(date +%s%N)
  TOTAL_TIME=$((TOTAL_TIME + (END - START) / 1000000))
done
AVG_TIME=$((TOTAL_TIME / 5))
echo -e "  ${GREEN}✓ 平均耗时: ${AVG_TIME}ms${NC}"
echo ""

# ============================================
# 场景3: List Benchmark
# ============================================
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}场景3: List Benchmark${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "配置: $SYMBOL_COUNT symbols"
echo ""

echo "开始list..."
START_TIME=$(date +%s%N)
$CLI list --database "$TEST_DATA_DIR" > /dev/null 2>&1
END_TIME=$(date +%s%N)

LIST_TIME_MS=$(( (END_TIME - START_TIME) / 1000000 ))

echo -e "${GREEN}✓ list完成${NC}"
echo "  symbols数: $SYMBOL_COUNT"
echo "  耗时: ${LIST_TIME_MS}ms"
echo ""

# ============================================
# 场景4: 数据文件大小
# ============================================
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}场景4: 数据文件大小${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

DATA_SIZE=$(du -sh "$TEST_DATA_DIR" | cut -f1)
echo -e "${GREEN}✓ 数据目录大小: $DATA_SIZE${NC}"
echo ""

# ============================================
# 清理
# ============================================
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}清理测试数据${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
rm -rf "$TEST_DATA_DIR"
echo "已删除测试数据目录"
echo ""

# ============================================
# 总结
# ============================================
echo "=========================================="
echo -e "${GREEN}  百万级性能基准测试完成${NC}"
echo "=========================================="
echo ""
echo "配置: $SYMBOL_COUNT symbols × $KLINES_PER_SYMBOL klines = $RECORDS_DISPLAY 条"
echo ""
echo "场景1 - 写入性能:"
echo "  数据量: $RECORDS_DISPLAY 条"
echo "  耗时: ${WRITE_TIME_MS}ms"
echo "  速率: ~${RATE_DISPLAY}条/秒"
echo ""
echo "场景2 - 查询性能:"
echo "  2a. 全量查询: ${AVG_TIME}ms (10次平均)"
echo "  2b. 单一symbol: 见上方输出"
echo "  2c. Limit 100: 见上方输出"
echo "  2d. Limit 10,000: 见上方输出"
echo ""
echo "场景3 - List性能:"
echo "  symbols: $SYMBOL_COUNT"
echo "  耗时: ${LIST_TIME_MS}ms"
echo ""
echo "场景4 - 存储大小:"
echo "  数据目录: $DATA_SIZE"
echo ""
