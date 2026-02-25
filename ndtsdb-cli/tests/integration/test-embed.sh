#!/bin/bash
# test-embed.sh - embedding生成测试（纯bash，零依赖）
set -e

BINARY="${BINARY:-${CLI:-../../ndtsdb-cli}}"
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

echo "=== Embedding 生成测试 ==="

# 1. 基本输出格式
OUT=$($BINARY embed --text "hello world" --dim 64 2>/dev/null)
echo "$OUT" | grep -q '"embedding"' && ok "embed输出包含embedding字段" || fail "embed输出格式错误"

# 2. 维度正确（64）
DIM=$(echo "$OUT" | grep -o '\[.*\]' | tr ',' '\n' | wc -l)
[ "$DIM" -eq 64 ] && ok "64维向量维度正确" || fail "维度错误: 期望64, 实际$DIM"

# 3. 128维
OUT128=$($BINARY embed --text "hello world" --dim 128 2>/dev/null)
DIM128=$(echo "$OUT128" | grep -o '\[.*\]' | tr ',' '\n' | wc -l)
[ "$DIM128" -eq 128 ] && ok "128维向量维度正确" || fail "128维错误: $DIM128"

# 4. 非零值比例（向量不应太稀疏）
NONZERO=$(echo "$OUT" | grep -o '\[.*\]' | tr ',' '\n' | grep -v '0\.000000' | wc -l)
[ "$NONZERO" -gt 10 ] && ok "非零值>10个 (实际$NONZERO/64)" || fail "向量太稀疏: 仅$NONZERO个非零值"

# 5. 相同文本输出一致
OUT2=$($BINARY embed --text "hello world" --dim 64 2>/dev/null)
[ "$OUT" = "$OUT2" ] && ok "相同文本输出一致" || fail "相同文本输出不一致"

# 6. 不同文本输出不同
OUT3=$($BINARY embed --text "量化交易系统" --dim 64 2>/dev/null)
[ "$OUT" != "$OUT3" ] && ok "不同文本输出不同" || fail "不同文本输出相同"

echo ""
echo "  Passed: $PASS"
[ $FAIL -gt 0 ] && echo "  Failed: $FAIL"
exit $FAIL
