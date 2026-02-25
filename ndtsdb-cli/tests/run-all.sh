#!/bin/bash
# tests/run-all.sh - ndtsdb-cli 全量集成测试
#
# 一键运行所有集成测试并统计结果
#
# Usage:
#   bash tests/run-all.sh                    # 运行所有测试
#   bash tests/run-all.sh --verbose          # 详细输出
#   bash tests/run-all.sh --quick            # 仅运行核心测试

set -o pipefail

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/.."

# 参数解析
VERBOSE=false
QUICK=false

for arg in "$@"; do
    case "$arg" in
        --verbose|-v) VERBOSE=true ;;
        --quick|-q) QUICK=true ;;
    esac
done

# 统计变量
TOTAL_PASSED=0
TOTAL_FAILED=0
TOTAL_SKIPPED=0

# 辅助函数
log() {
    echo -e "${BLUE}==>${NC} $1"
}

ok() {
    echo -e "${GREEN}✓${NC} $1"
}

fail() {
    echo -e "${RED}✗${NC} $1"
}

warn() {
    echo -e "${YELLOW}⚠${NC} $1"
}

# 运行单个测试
run_test() {
    local name="$1"
    local script="$2"
    
    log "Running: $name"
    
    local output
    local exit_code
    
    if [ "$VERBOSE" = true ]; then
        bash "$script"
        exit_code=$?
    else
        output=$(bash "$script" 2>&1)
        exit_code=$?
        
        # 提取 passed/failed 数量
        local passed=$(echo "$output" | grep -oE '[0-9]+ passed' | head -1 | cut -d' ' -f1)
        local failed=$(echo "$output" | grep -oE '[0-9]+ failed' | head -1 | cut -d' ' -f1)
        
        if [ -n "$passed" ]; then
            echo "    Passed: $passed"
        fi
        if [ -n "$failed" ] && [ "$failed" -gt 0 ]; then
            echo "    Failed: $failed"
        fi
    fi
    
    if [ $exit_code -eq 0 ]; then
        ok "$name passed"
        return 0
    else
        fail "$name failed (exit $exit_code)"
        if [ "$VERBOSE" = false ] && [ -n "$output" ]; then
            echo "    Last 10 lines:"
            echo "$output" | tail -10 | sed 's/^/      /'
        fi
        return 1
    fi
}

# 主流程
echo ""
echo "================================"
echo "  ndtsdb-cli 全量集成测试"
echo "================================"
echo ""

# 检查 ndtsdb-cli
if [ -f "$PROJECT_ROOT/ndtsdb-cli" ]; then
    NDTSDB_BIN="$PROJECT_ROOT/ndtsdb-cli"
elif [ -f "$PROJECT_ROOT/zig-out/bin/ndtsdb-cli" ]; then
    NDTSDB_BIN="$PROJECT_ROOT/zig-out/bin/ndtsdb-cli"
else
    warn "ndtsdb-cli 未找到，尝试编译..."
    if [ -f "$PROJECT_ROOT/Makefile" ]; then
        (cd "$PROJECT_ROOT" && make) || {
            fail "编译失败，请手动编译: cd ndtsdb-cli && make"
            exit 1
        }
        NDTSDB_BIN="$PROJECT_ROOT/ndtsdb-cli"
    else
        fail "Makefile 未找到，无法自动编译"
        exit 1
    fi
fi

# Export paths for sub-scripts (they use CLI, BINARY, or EXAMPLES_DIR variable names)
export CLI="$NDTSDB_BIN"
export BINARY="$NDTSDB_BIN"
export EXAMPLES_DIR="$PROJECT_ROOT/examples"

# 核心测试 (必须)
echo ""
log "=== 核心功能测试 ==="
echo ""

run_test "v0.3.0 综合测试" "$SCRIPT_DIR/integration/test-v0.3.0.sh"
if [ $? -eq 0 ]; then ((TOTAL_PASSED++)); else ((TOTAL_FAILED++)); fi

# 向量/知识测试 (必须)
echo ""
log "=== 向量与知识引擎测试 ==="
echo ""

run_test "向量字段测试" "$SCRIPT_DIR/integration/test-vector.sh"
if [ $? -eq 0 ]; then ((TOTAL_PASSED++)); else ((TOTAL_FAILED++)); fi

run_test "知识引擎测试" "$SCRIPT_DIR/integration/test-knowledge.sh"
if [ $? -eq 0 ]; then ((TOTAL_PASSED++)); else ((TOTAL_FAILED++)); fi

# 扩展测试 (quick 模式跳过)
if [ "$QUICK" = false ]; then
    echo ""
    log "=== 扩展功能测试 ==="
    echo ""
    
    # v0.2.2 向后兼容测试
    if [ -f "$SCRIPT_DIR/integration/test-v0.2.2.sh" ]; then
        run_test "v0.2.2 兼容测试" "$SCRIPT_DIR/integration/test-v0.2.2.sh"
        if [ $? -eq 0 ]; then ((TOTAL_PASSED++)); else ((TOTAL_FAILED++)); fi
    else
        ((TOTAL_SKIPPED++))
        warn "test-v0.2.2.sh 未找到，跳过"
    fi
    
    # SQL 测试
    if [ -f "$SCRIPT_DIR/integration/test-sql.sh" ]; then
        run_test "SQL 功能测试" "$SCRIPT_DIR/integration/test-sql.sh"
        if [ $? -eq 0 ]; then ((TOTAL_PASSED++)); else ((TOTAL_FAILED++)); fi
    fi
    
    # HTTP Serve 测试
    if [ -f "$SCRIPT_DIR/integration/test-serve.sh" ]; then
        run_test "HTTP Serve 测试" "$SCRIPT_DIR/integration/test-serve.sh"
        if [ $? -eq 0 ]; then ((TOTAL_PASSED++)); else ((TOTAL_FAILED++)); fi
    fi

    # Export 测试
    if [ -f "$SCRIPT_DIR/integration/test-export.sh" ]; then
        run_test "Export导出测试" "$SCRIPT_DIR/integration/test-export.sh"
        if [ $? -eq 0 ]; then ((TOTAL_PASSED++)); else ((TOTAL_FAILED++)); fi
    fi

    # Merge 测试
    if [ -f "$SCRIPT_DIR/integration/test-merge.sh" ]; then
        run_test "Merge合并测试" "$SCRIPT_DIR/integration/test-merge.sh"
        if [ $? -eq 0 ]; then ((TOTAL_PASSED++)); else ((TOTAL_FAILED++)); fi
    fi

    # Resample 测试
    if [ -f "$SCRIPT_DIR/integration/test-resample.sh" ]; then
        run_test "Resample重采样测试" "$SCRIPT_DIR/integration/test-resample.sh"
        if [ $? -eq 0 ]; then ((TOTAL_PASSED++)); else ((TOTAL_FAILED++)); fi
    fi

    # Embedding 测试
    if [ -f "$SCRIPT_DIR/integration/test-embed.sh" ]; then
        run_test "Embedding生成测试" "$SCRIPT_DIR/integration/test-embed.sh"
        if [ $? -eq 0 ]; then ((TOTAL_PASSED++)); else ((TOTAL_FAILED++)); fi
    fi

    # 知识引擎测试
    if [ -f "$SCRIPT_DIR/integration/test-knowledge.sh" ]; then
        run_test "知识引擎测试" "$SCRIPT_DIR/integration/test-knowledge.sh"
        if [ $? -eq 0 ]; then ((TOTAL_PASSED++)); else ((TOTAL_FAILED++)); fi
    fi

    # Facts命令测试
    if [ -f "$SCRIPT_DIR/integration/test-facts.sh" ]; then
        run_test "Facts命令测试" "$SCRIPT_DIR/integration/test-facts.sh"
        if [ $? -eq 0 ]; then ((TOTAL_PASSED++)); else ((TOTAL_FAILED++)); fi
    fi
fi

# 总结
echo ""
echo "================================"
log "测试结果汇总"
echo "================================"
echo ""

ok "通过: $TOTAL_PASSED"

if [ $TOTAL_FAILED -gt 0 ]; then
    fail "失败: $TOTAL_FAILED"
fi

if [ $TOTAL_SKIPPED -gt 0 ]; then
    warn "跳过: $TOTAL_SKIPPED"
fi

echo ""

if [ $TOTAL_FAILED -eq 0 ]; then
    echo -e "${GREEN}=== 所有测试通过 ===${NC}"
    exit 0
else
    echo -e "${RED}=== 部分测试失败 ===${NC}"
    exit 1
fi
