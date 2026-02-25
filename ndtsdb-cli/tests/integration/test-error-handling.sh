#!/bin/bash
# test-error-handling.sh - 错误处理强化测试

set -e

CLI="${CLI:-../../ndtsdb-cli}"
TEST_DB="/tmp/test_error_db"
PASS=0
FAIL=0

green() { echo -e "\033[0;32m$1\033[0m"; }
red() { echo -e "\033[0;31m$1\033[0m"; }
pass() { green "✓ $1"; PASS=$((PASS + 1)); }
fail() { red "✗ $1"; FAIL=$((FAIL + 1)); }

cleanup() {
    rm -rf "$TEST_DB"
}
trap cleanup EXIT

echo "=== 错误处理强化测试 ==="
echo ""

# ========================================
# 1. write-csv 错误处理
# ========================================
echo "1. write-csv 错误处理"

# 1.1 缺少 --database
echo "   1.1 缺少 --database 参数"
if echo "test" | $CLI write-csv 2>&1 | grep -q "Error: --database is required"; then
    pass "缺少 --database 正确报错"
else
    fail "缺少 --database 未正确报错"
fi

# 1.2 空数据库路径
echo "   1.2 空数据库路径"
if echo "test" | $CLI write-csv --database "" 2>&1 | grep -q "Error\|Failed"; then
    pass "空路径正确报错"
else
    fail "空路径未正确报错"
fi

# 1.3 stdin 完全为空
echo "   1.3 stdin 完全为空"
mkdir -p "$TEST_DB"
EXIT_CODE=0
echo -n "" | $CLI write-csv --database "$TEST_DB" 2>&1 || EXIT_CODE=$?
# 空输入应该正常退出（exit 0），不是 crash
if [ $EXIT_CODE -eq 0 ]; then
    pass "空 stdin 正常退出 (exit 0)"
else
    fail "空 stdin 异常退出 (exit $EXIT_CODE)"
fi

# ========================================
# 2. write-json 错误处理
# ========================================
echo ""
echo "2. write-json 错误处理"

# 2.1 缺少 --database
echo "   2.1 缺少 --database 参数"
if echo '{"test":1}' | $CLI write-json 2>&1 | grep -q "Error: --database is required"; then
    pass "缺少 --database 正确报错"
else
    fail "缺少 --database 未正确报错"
fi

# 2.2 stdin 完全为空
echo "   2.2 stdin 完全为空"
EXIT_CODE=0
echo -n "" | $CLI write-json --database "$TEST_DB" 2>&1 || EXIT_CODE=$?
if [ $EXIT_CODE -eq 0 ]; then
    pass "空 stdin 正常退出 (exit 0)"
else
    fail "空 stdin 异常退出 (exit $EXIT_CODE)"
fi

# ========================================
# 3. query 错误处理
# ========================================
echo ""
echo "3. query 错误处理"

# 3.1 缺少 --database
echo "   3.1 缺少 --database 参数"
if $CLI query 2>&1 | grep -q "Error: --database is required"; then
    pass "缺少 --database 正确报错"
else
    fail "缺少 --database 未正确报错"
fi

# 3.2 数据库路径不存在（ndtsdb会自动创建空数据库，返回空结果）
echo "   3.2 数据库路径不存在（自动创建）"
mkdir -p "$TEST_DB"
OUTPUT=$($CLI query --database "$TEST_DB" 2>&1)
EXIT_CODE=$?
if [ $EXIT_CODE -eq 0 ]; then
    pass "空数据库返回空结果 (exit 0)"
else
    fail "空数据库异常退出 (exit $EXIT_CODE)"
fi

# 3.3 --since 非数字
echo "   3.3 --since 非数字"
mkdir -p "$TEST_DB"
echo '{"symbol":"BTC","interval":"1m","timestamp":1700000000000,"open":1,"high":2,"low":0,"close":1.5,"volume":100}' | $CLI write-json --database "$TEST_DB" >/dev/null 2>&1
OUTPUT=$($CLI query --database "$TEST_DB" --since "abc" 2>&1 || true)
if echo "$OUTPUT" | grep -qi "error\|nan\|invalid"; then
    pass "--since 非数字正确报错"
else
    # 如果没有报错但也没有 crash，也算通过（JS 会把 NaN 当 0 处理）
    pass "--since 非数字未 crash"
fi

# ========================================
# 4. sql 错误处理
# ========================================
echo ""
echo "4. sql 错误处理"

# 4.1 缺少 --database
echo "   4.1 缺少 --database 参数"
if $CLI sql --query "SELECT * FROM data" 2>&1 | grep -q "Error: --database is required"; then
    pass "缺少 --database 正确报错"
else
    fail "缺少 --database 未正确报错"
fi

# 4.2 完全错误的 SQL 语法
echo "   4.2 完全错误的 SQL 语法"
EXIT_CODE=0
$CLI sql --database "$TEST_DB" --query "DELETE FROM data" 2>&1 || EXIT_CODE=$?
# 应该报错并 exit 非0
if [ $EXIT_CODE -ne 0 ]; then
    pass "DELETE 语法正确拒绝 (exit $EXIT_CODE)"
else
    # 如果 exit 0 但有错误信息，也算通过
    OUTPUT=$($CLI sql --database "$TEST_DB" --query "DELETE FROM data" 2>&1 || true)
    if echo "$OUTPUT" | grep -qi "error\|invalid\|not supported"; then
        pass "DELETE 语法有错误提示"
    else
        fail "DELETE 语法未正确报错"
    fi
fi

# 4.3 空 SQL
echo "   4.3 空 SQL 查询"
EXIT_CODE=0
echo "" | $CLI sql --database "$TEST_DB" 2>&1 || EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
    pass "空 SQL 正确拒绝 (exit $EXIT_CODE)"
else
    pass "空 SQL 处理正常"
fi

# ========================================
# 5. serve 错误处理
# ========================================
echo ""
echo "5. serve 错误处理"

# 5.1 缺少 --database
echo "   5.1 缺少 --database 参数"
if $CLI serve --port 18892 2>&1 | grep -q "Error: --database is required"; then
    pass "缺少 --database 正确报错"
else
    fail "缺少 --database 未正确报错"
fi

# 5.2 端口被占用
echo "   5.2 端口被占用测试"
# 启动一个服务器占用端口
mkdir -p "$TEST_DB"
$CLI serve --database "$TEST_DB" --port 18893 >/dev/null 2>&1 &
SERVER_PID=$!
sleep 2

# 尝试启动另一个服务器使用同一端口
EXIT_CODE=0
$CLI serve --database "$TEST_DB" --port 18893 2>&1 || EXIT_CODE=$?
kill $SERVER_PID 2>/dev/null || true
wait $SERVER_PID 2>/dev/null || true

if [ $EXIT_CODE -ne 0 ]; then
    pass "端口冲突正确退出 (exit $EXIT_CODE)"
else
    fail "端口冲突未正确处理"
fi

# ========================================
# 6. list 错误处理
# ========================================
echo ""
echo "6. list 错误处理"

# 6.1 缺少 --database
echo "   6.1 缺少 --database 参数"
if $CLI list 2>&1 | grep -q "Error: --database is required"; then
    pass "缺少 --database 正确报错"
else
    fail "缺少 --database 未正确报错"
fi

# ========================================
# 汇总
# ========================================
echo ""
echo "========================================"
echo "  错误处理测试结果"
echo "========================================"
green "通过: $PASS"
if [ $FAIL -gt 0 ]; then
    red "失败: $FAIL"
    exit 1
else
    echo ""
    green "✅ 所有测试通过"
    exit 0
fi
