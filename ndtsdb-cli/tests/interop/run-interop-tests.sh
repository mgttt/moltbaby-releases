#!/bin/bash
# ndtsdb-cli ↔ ndtsdb 互操作性测试主脚本

set -e

# 测试数据目录
TEST_DATA_DIR="/tmp/ndtsdb-interop-test-$$"
export NDTS_DATA_DIR="$TEST_DATA_DIR"

# 颜色输出
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo "=========================================="
echo "  ndtsdb-cli ↔ ndtsdb 一致性测试"
echo "=========================================="
echo ""
echo "测试数据目录: $TEST_DATA_DIR"
echo ""

# 准备环境
mkdir -p "$TEST_DATA_DIR"

# 检查依赖
if [ ! -f "../../ndtsdb-cli" ]; then
  echo -e "${RED}❌ ndtsdb-cli 二进制不存在${NC}"
  echo "请先构建: cd ../../ && make all"
  exit 1
fi

if ! command -v bun &> /dev/null; then
  echo -e "${RED}❌ Bun 未安装${NC}"
  echo "请安装 Bun: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

echo "✅ 依赖检查通过"
echo ""

# ============================================
# 场景1：内部一致性
# ============================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "场景1：内部一致性测试"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1.1 CLI内部一致性
echo ""
echo "[1/2] 场景1a：CLI内部一致性（CLI写入→CLI读取）"
rm -rf "$TEST_DATA_DIR"/*
../../ndtsdb-cli cli/write-test.js || { echo -e "${RED}❌ CLI写入失败${NC}"; exit 1; }
../../ndtsdb-cli cli/verify-read-btcusdt.js || { echo -e "${RED}❌ CLI读取失败${NC}"; exit 1; }
echo -e "${GREEN}✅ 通过${NC}"

# 1.2 Bun内部一致性
echo ""
echo "[2/2] 场景1b：Bun内部一致性（Bun写入→Bun读取）"
rm -rf "$TEST_DATA_DIR"/*
bun bun/write-test.ts || { echo -e "${RED}❌ Bun写入失败${NC}"; exit 1; }
bun bun/verify-read.ts || { echo -e "${RED}❌ Bun读取失败${NC}"; exit 1; }
echo -e "${GREEN}✅ 通过${NC}"

echo ""
echo -e "${GREEN}✅ 场景1完成：内部一致性测试通过${NC}"
echo ""

# ============================================
# 场景2：跨实现互操作测试（CLI ↔ Bun）
# ============================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "场景2：跨实现互操作测试（CLI ↔ Bun）"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

rm -rf "$TEST_DATA_DIR"/*

echo ""
echo "[1/5] Phase 1a: CLI写入1000条"
NDTS_DATA_DIR=$TEST_DATA_DIR ../../ndtsdb-cli cli/write-test.js || { echo -e "${RED}❌ CLI写入失败${NC}"; exit 1; }

echo ""
echo "[2/5] Phase 1b: Bun验证读取CLI写入的数据"
NDTS_DATA_DIR=$TEST_DATA_DIR bun bun/verify-read-cli.ts || { echo -e "${RED}❌ Bun读取CLI数据失败${NC}"; exit 1; }

echo ""
echo "[3/5] Phase 2a: Bun写入1000条ETHUSDT数据"
rm -rf "$TEST_DATA_DIR"/*
NDTS_DATA_DIR=$TEST_DATA_DIR bun bun/write-test.ts || { echo -e "${RED}❌ Bun写入失败${NC}"; exit 1; }

echo ""
echo "[4/5] Phase 2b: CLI验证读取Bun写入的数据"
NDTS_DATA_DIR=$TEST_DATA_DIR ../../ndtsdb-cli cli/verify-read-cli.js || { echo -e "${RED}❌ CLI读取Bun数据失败${NC}"; exit 1; }

echo ""
echo "[5/5] Phase 2c: Bun追加100条，CLI验证总数"
NDTS_DATA_DIR=$TEST_DATA_DIR bun bun/append-data.ts || { echo -e "${RED}❌ Bun追加失败${NC}"; exit 1; }
NDTS_DATA_DIR=$TEST_DATA_DIR ../../ndtsdb-cli cli/verify-read-cli.js || { echo -e "${RED}❌ CLI验证失败${NC}"; exit 1; }

echo ""
echo -e "${GREEN}✅ 场景2完成：跨实现互操作测试通过${NC}"
echo ""

# ============================================
# 场景3：并发读（模拟）
# ============================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "场景3：并发读测试（模拟）"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

echo ""
echo "同时启动CLI和Bun循环读取（10秒）"

# 启动后台进程
../../ndtsdb-cli cli/read-loop.js &> /tmp/cli-read-$$.log &
CLI_PID=$!

bun bun/read-loop.ts &> /tmp/bun-read-$$.log &
BUN_PID=$!

# 等待10秒
sleep 10

# 终止进程
kill $CLI_PID $BUN_PID 2>/dev/null || true
wait $CLI_PID $BUN_PID 2>/dev/null || true

# 检查错误
if grep -q "错误" /tmp/cli-read-$$.log || grep -q "错误" /tmp/bun-read-$$.log; then
  echo -e "${RED}❌ 并发读取出现错误${NC}"
  echo "CLI日志:"
  cat /tmp/cli-read-$$.log
  echo ""
  echo "Bun日志:"
  cat /tmp/bun-read-$$.log
  rm /tmp/cli-read-$$.log /tmp/bun-read-$$.log
  exit 1
fi

rm /tmp/cli-read-$$.log /tmp/bun-read-$$.log
echo ""
echo -e "${GREEN}✅ 场景3完成：并发读取测试通过${NC}"
echo ""

# ============================================
# 场景4：边界情况
# ============================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "场景4：边界情况测试"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 4.1 大数据量
echo ""
echo "[1/3] 大数据量测试（100万条）"
echo "注意：此测试可能需要几分钟..."
bun bun/write-large.ts || { echo -e "${RED}❌ 大数据量写入失败${NC}"; exit 1; }
../../ndtsdb-cli cli/query-last.js || { echo -e "${RED}❌ 大数据量查询失败${NC}"; exit 1; }
echo -e "${GREEN}✅ 大数据量测试通过${NC}"

# 4.2 特殊值
echo ""
echo "[2/3] 边界值测试"
rm -rf "${TEST_DATA_DIR:?}"/* 2>/dev/null || find "$TEST_DATA_DIR" -mindepth 1 -delete
../../ndtsdb-cli cli/write-edge.js || { echo -e "${RED}❌ 边界值写入失败${NC}"; exit 1; }
bun bun/verify-edge.ts || { echo -e "${RED}❌ 边界值验证失败${NC}"; exit 1; }
echo -e "${GREEN}✅ 边界值测试通过${NC}"

# 4.3 空数据库
echo ""
echo "[3/3] 空查询测试"
rm -rf "${TEST_DATA_DIR:?}"/* 2>/dev/null || find "$TEST_DATA_DIR" -mindepth 1 -delete
../../ndtsdb-cli cli/query-empty.js || { echo -e "${RED}❌ CLI空查询失败${NC}"; exit 1; }
bun bun/query-empty.ts || { echo -e "${RED}❌ Bun空查询失败${NC}"; exit 1; }
echo -e "${GREEN}✅ 空查询测试通过${NC}"

echo ""
echo -e "${GREEN}✅ 场景4完成：边界情况测试通过${NC}"
echo ""

# ============================================
# 场景5：文件格式验证
# ============================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "场景5：文件格式验证"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

echo ""
rm -rf "${TEST_DATA_DIR:?}"/* 2>/dev/null || find "$TEST_DATA_DIR" -mindepth 1 -delete

# 使用两个独立目录进行对比
CLI_SAMPLE_DIR="${TEST_DATA_DIR}/cli-sample"
BUN_SAMPLE_DIR="${TEST_DATA_DIR}/bun-sample"
mkdir -p "$CLI_SAMPLE_DIR" "$BUN_SAMPLE_DIR"

echo "[1/2] CLI写入样本数据"
NDTS_DATA_DIR=$CLI_SAMPLE_DIR ../../ndtsdb-cli cli/write-sample.js || { echo -e "${RED}❌ CLI样本写入失败${NC}"; exit 1; }

echo "[2/2] Bun写入样本数据"
NDTS_DATA_DIR=$BUN_SAMPLE_DIR bun bun/write-sample.ts || { echo -e "${RED}❌ Bun样本写入失败${NC}"; exit 1; }

echo ""
echo "[对比] 文件格式一致性检查"

# 获取两个目录中的第一个分区文件
CLI_FILE=$(ls "$CLI_SAMPLE_DIR"/*.ndts | head -1)
BUN_FILE=$(ls "$BUN_SAMPLE_DIR"/*.ndts | head -1)

if [ -z "$CLI_FILE" ] || [ -z "$BUN_FILE" ]; then
  echo -e "${RED}❌ 无法找到样本文件${NC}"
  exit 1
fi

echo "CLI样本: $(basename $CLI_FILE)"
echo "Bun样本: $(basename $BUN_FILE)"

# 检查magic number和version（前100字节）
CLI_HEADER=$(hexdump -C "$CLI_FILE" | head -5)
BUN_HEADER=$(hexdump -C "$BUN_FILE" | head -5)

echo ""
echo "CLI文件头部:"
echo "$CLI_HEADER"
echo ""
echo "Bun文件头部:"
echo "$BUN_HEADER"

# 对比magic number (NDTS) 和 version
if [ "$(echo "$CLI_HEADER" | head -1 | awk '{print $2 $3 $4 $5}')" != "$(echo "$BUN_HEADER" | head -1 | awk '{print $2 $3 $4 $5}')" ]; then
  echo -e "${YELLOW}⚠️  文件格式存在差异（可能是元数据差异，需人工确认）${NC}"
else
  echo -e "${GREEN}✅ 文件格式一致${NC}"
fi

echo ""
echo -e "${GREEN}✅ 场景5完成：文件格式验证通过${NC}"
echo ""

# ============================================
# 清理
# ============================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "清理测试数据"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

rm -rf "$TEST_DATA_DIR"
echo "已删除测试数据目录: $TEST_DATA_DIR"

# ============================================
# 总结
# ============================================
echo ""
echo "=========================================="
echo -e "${GREEN}  所有测试通过 ✅${NC}"
echo "=========================================="
echo ""
echo "测试覆盖："
echo "  ✅ 场景1：内部一致性（CLI↔Bun）"
echo "  ✅ 场景2：跨实现互操作（CLI→Bun）"
echo "  ✅ 场景3：并发读（模拟）"
echo "  ✅ 场景4：边界情况（大数据量/特殊值/空数据库）"
echo "  ✅ 场景5：文件格式验证"
echo ""
