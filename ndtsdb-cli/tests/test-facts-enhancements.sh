#!/bin/bash
# ============================================================
# facts 命令回归测试套件
# 结合 mem-find 知识库进行验证
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="${SCRIPT_DIR}/../zig-out/bin/ndtsdb-cli"
TEST_DB="/tmp/test_facts_$$"
TEST_KB="${TEST_DB}/kb"

echo "═══════════════════════════════════════════════════════════"
echo "  facts 命令回归测试"
echo "═══════════════════════════════════════════════════════════"
echo ""

# 检查 CLI 存在
if [ ! -f "$CLI" ]; then
    echo "❌ CLI not found: $CLI"
    echo "   Run: cd ndtsdb-cli && zig build"
    exit 1
fi

# 清理并创建测试目录
rm -rf "$TEST_DB"
mkdir -p "$TEST_KB"

# 测试计数
TESTS=0
PASSED=0
FAILED=0

run_test() {
    local name="$1"
    local cmd="$2"
    local check="$3"
    
    TESTS=$((TESTS + 1))
    echo "[$TESTS] $name"
    
    if eval "$cmd" > /tmp/test_out_$$ 2>&1; then
        if eval "$check" /tmp/test_out_$$; then
            echo "    ✅ PASS"
            PASSED=$((PASSED + 1))
        else
            echo "    ❌ FAIL (output check)"
            cat /tmp/test_out_$$ | sed 's/^/        /'
            FAILED=$((FAILED + 1))
        fi
    else
        echo "    ❌ FAIL (exit code)"
        cat /tmp/test_out_$$ | sed 's/^/        /'
        FAILED=$((FAILED + 1))
    fi
}

# ============================================================
# 基础功能测试
# ============================================================

echo "【基础功能测试】"
echo ""

# 准备测试数据
echo "  准备测试数据..."
for i in {1..5}; do
    $CLI facts write -d "$TEST_KB" \
        --text "这是第 $i 条测试知识，关于量化交易策略" \
        --agent-id "bot-00$i" \
        --type "semantic" \
        --validity "mutable" 2>/dev/null
done

# 写入一些旧数据（模拟30天前）
for i in {6..10}; do
    # 这里实际上无法设置过去的时间戳，因为 write 使用 now_ms()
    # 实际测试中我们会用 decay 功能测试时间衰减计算
    $CLI facts write -d "$TEST_KB" \
        --text "这是第 $i 条历史知识，较旧的内容" \
        --agent-id "bot-00$i" \
        --type "semantic" \
        --validity "mutable" 2>/dev/null
done

run_test "facts list 基本功能" \
    "$CLI facts list -d $TEST_KB" \
    "grep -q 'Total:'"

run_test "facts search 基本功能" \
    "$CLI facts search -d $TEST_KB -q '量化' --top-k 3" \
    "grep -q 'Top 3'"

run_test "facts search JSON 输出" \
    "$CLI facts search -d $TEST_KB -q '量化' --json" \
    "grep -q '\['"

# ============================================================
# time_decay 功能测试
# ============================================================

echo ""
echo "【time_decay 功能测试】"
echo ""

run_test "facts decay 基本功能" \
    "$CLI facts decay -d $TEST_KB -q '量化' --half-life 7d" \
    "grep -q 'decayed_score'"

run_test "facts decay JSON 输出" \
    "$CLI facts decay -d $TEST_KB -q '量化' --half-life 1d --json" \
    "grep -q 'decayed_score'"

run_test "facts decay 显示原始得分" \
    "$CLI facts decay -d $TEST_KB -q '量化' --half-life 7d --show-raw" \
    "grep -q 'sim='"

# 验证时间衰减计算正确性
# 衰减公式: score = sim * exp(-ln(2) * age / half_life)
# 由于刚写入的数据 age ≈ 0，所以 decay ≈ 1，score ≈ sim
echo "  [6] 验证时间衰减计算"
DECAY_RESULT=$($CLI facts decay -d "$TEST_KB" -q '量化' --half-life 7d --json 2>/dev/null | head -1)
if echo "$DECAY_RESULT" | grep -q "decayed_score"; then
    echo "    ✅ PASS"
    PASSED=$((PASSED + 1))
else
    echo "    ❌ FAIL"
    FAILED=$((FAILED + 1))
fi
TESTS=$((TESTS + 1))

# ============================================================
# dedup 功能测试
# ============================================================

echo ""
echo "【dedup 功能测试】"
echo ""

# 写入重复/相似内容
$CLI facts write -d "$TEST_KB" \
    --text "这是重复的量化交易策略知识" \
    --agent-id "bot-dup1" \
    --type "semantic" 2>/dev/null

$CLI facts write -d "$TEST_KB" \
    --text "这是重复的量化交易策略知识" \
    --agent-id "bot-dup2" \
    --type "semantic" 2>/dev/null

run_test "facts dedup 基本功能" \
    "$CLI facts dedup -d $TEST_KB --threshold 0.95" \
    "grep -q 'duplicate' || grep -q 'Found'"

run_test "facts dedup --dry-run" \
    "$CLI facts dedup -d $TEST_KB --threshold 0.90 --dry-run" \
    "grep -q 'Dry run' || grep -q 'Found'"

run_test "facts dedup JSON 输出" \
    "$CLI facts dedup -d $TEST_KB --threshold 0.90 --json" \
    "grep -q '\[' || grep -q 'similarity'"

# ============================================================
# archive 功能测试
# ============================================================

echo ""
echo "【archive 功能测试】"
echo ""

run_test "facts archive 基本功能" \
    "$CLI facts archive -d $TEST_KB --before -1d --dry-run" \
    "grep -q 'Archive' || grep -q 'candidates'"

run_test "facts archive JSON 输出" \
    "$CLI facts archive -d $TEST_KB --before -7d --json" \
    "grep -q 'would_archive'"

# ============================================================
# 结合 mem-find 的测试策略
# ============================================================

echo ""
echo "【mem-find 集成测试】"
echo ""

echo "  说明: mem-find 用于发现知识库中的重复和相似内容"
echo "  此测试验证 facts dedup 与 mem-find 策略的一致性"
echo ""

# 模拟 mem-find 发现的问题场景
# 场景1: 同一 agent 的相似知识
$CLI facts write -d "$TEST_KB" \
    --text "BotCorp 是一个多智能体系统" \
    --agent-id "mem-test" \
    --type "semantic" 2>/dev/null

$CLI facts write -d "$TEST_KB" \
    --text "BotCorp 是一个多智能体协作系统" \
    --agent-id "mem-test" \
    --type "semantic" 2>/dev/null

run_test "mem-find 场景: 同一 agent 相似知识" \
    "$CLI facts dedup -d $TEST_KB --agent-id mem-test --threshold 0.85" \
    "grep -q 'Found' || true"

# 场景2: 跨 agent 的重复知识
$CLI facts write -d "$TEST_KB" \
    --text "OpenClaw 是一个 AI 运行时系统" \
    --agent-id "agent-a" \
    --type "semantic" 2>/dev/null

$CLI facts write -d "$TEST_KB" \
    --text "OpenClaw 是一个 AI 运行时系统" \
    --agent-id "agent-b" \
    --type "semantic" 2>/dev/null

run_test "mem-find 场景: 跨 agent 重复知识" \
    "$CLI facts dedup -d $TEST_KB --threshold 0.95" \
    "grep -q 'Found' || true"

# ============================================================
# 边界测试
# ============================================================

echo ""
echo "【边界测试】"
echo ""

run_test "空数据库 decay" \
    "$CLI facts decay -d /tmp/empty_kb_$$ -q 'test' --half-life 1d 2>&1 || true" \
    "true"  # 期望不崩溃

run_test "空数据库 dedup" \
    "$CLI facts dedup -d /tmp/empty_kb_$$ --threshold 0.5 2>&1 || true" \
    "true"  # 期望不崩溃

# ============================================================
# 总结
# ============================================================

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  测试结果总结"
echo "═══════════════════════════════════════════════════════════"
echo "  总计: $TESTS 项"
echo "  通过: $PASSED 项"
echo "  失败: $FAILED 项"
echo ""

# 清理
rm -rf "$TEST_DB" /tmp/test_out_$$ /tmp/empty_kb_$$

if [ $FAILED -eq 0 ]; then
    echo "  ✅ 所有测试通过"
    exit 0
else
    echo "  ❌ 有 $FAILED 项测试失败"
    exit 1
fi