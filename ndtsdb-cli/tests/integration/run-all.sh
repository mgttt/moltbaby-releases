#!/bin/bash
# ndtsdb-cli 集成测试统一运行脚本
# 运行所有测试并报告结果

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NDTSDB_CLI="${SCRIPT_DIR}/../../ndtsdb-cli"

# 颜色
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 检查ndtsdb-cli是否存在
if [ ! -f "$NDTSDB_CLI" ]; then
    echo -e "${RED}错误: ndtsdb-cli不存在${NC}"
    echo "请先构建: cd ndtsdb-cli && make"
    exit 1
fi

echo "=========================================="
echo "  ndtsdb-cli 集成测试套件"
echo "=========================================="
echo "CLI路径: $NDTSDB_CLI"
echo ""

# 测试结果统计
PASSED=0
FAILED=0
TOTAL=0

# 运行单个测试的函数
run_test() {
    local test_name=$1
    local test_script=$2
    
    TOTAL=$((TOTAL + 1))
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "测试 ${TOTAL}: ${test_name}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    
    # 使用环境变量传递CLI路径（同时设置CLI和BINARY以兼容不同脚本）
    if CLI="$NDTSDB_CLI" BINARY="$NDTSDB_CLI" bash "$test_script" 2>&1; then
        echo -e "${GREEN}✓ PASSED${NC}: $test_name"
        PASSED=$((PASSED + 1))
    else
        echo -e "${RED}✗ FAILED${NC}: $test_name"
        FAILED=$((FAILED + 1))
    fi
    echo ""
}

# 定义测试列表
# 优先级排序：基础功能 -> SQL -> 高级功能
TESTS=(
    "test-write-csv-roundtrip.sh:Write CSV往返"
    "test-export.sh:Export导出"
    "test-merge.sh:Merge合并"
    "test-resample.sh:Resample重采样"
    "test-max-timestamp.sh:MaxTimestamp边界"
    "test-quant-lib-integration.sh:quant-lib集成"
    "test-sma.sh:SMA指标"
    "test-sql.sh:SQL基础"
    "test-sql-groupby.sh:SQL GroupBy"
    "kline-interop.sh:K线互操作"
    "test-concurrent-write.sh:并发写入"
    "test-error-handling.sh:错误处理"
    "test-vector.sh:向量操作"
    "test-serve.sh:Serve端点"
    "test-websocket.sh:WebSocket"
    "test-phase2-e2e.sh:Phase2 E2E"
    "test-v0.2.2.sh:v0.2.2回归"
    "test-v0.3.0.sh:v0.3.0回归"
    "test-knowledge.sh:Knowledge DB"
)

# 运行所有测试
for test_entry in "${TESTS[@]}"; do
    IFS=':' read -r script_name test_name <<< "$test_entry"
    test_path="${SCRIPT_DIR}/${script_name}"
    
    if [ -f "$test_path" ]; then
        run_test "$test_name" "$test_path"
    else
        echo -e "${YELLOW}跳过: $script_name (不存在)${NC}"
    fi
done

# 总结
echo "=========================================="
echo "  测试结果总结"
echo "=========================================="
echo -e "总测试数: $TOTAL"
echo -e "${GREEN}通过: $PASSED${NC}"
echo -e "${RED}失败: $FAILED${NC}"
echo ""

PASS_RATE=$(( PASSED * 100 / TOTAL ))
echo "通过率: ${PASS_RATE}%"

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ 所有测试通过！${NC}"
    exit 0
else
    echo -e "${RED}✗ 有测试失败，请检查输出${NC}"
    exit 1
fi
