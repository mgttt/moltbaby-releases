#!/bin/bash
# test-facts.sh - facts命令边界测试（纯bash，零依赖）
set -e

BINARY="${BINARY:-${CLI:-../../ndtsdb-cli}}"
DB=$(mktemp -d)
trap "rm -rf $DB" EXIT
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

echo "=== Facts 命令测试 ==="

# 1. facts help
$BINARY facts --help 2>&1 | grep -q "import" && ok "facts --help可用" || fail "facts --help失败"

# 2. 空JSONL导入（应该不报错）
touch $DB/empty.jsonl
$BINARY facts import --database $DB --input $DB/empty.jsonl 2>/dev/null && ok "空JSONL导入不报错" || fail "空JSONL导入报错"

# 3. 批量导入（50条）
for i in $(seq 1 50); do
    V1=$(awk "BEGIN{printf \"%.6f\", $i/50.0}")
    V2=$(awk "BEGIN{printf \"%.6f\", (50-$i)/50.0}")
    V3=$(awk "BEGIN{printf \"%.6f\", ($i%10)/10.0}")
    echo "{\"timestamp\":${i}000,\"agent_id\":\"batch\",\"type\":\"fact\",\"confidence\":0.9,\"embedding\":[$V1,$V2,$V3]}"
done > $DB/batch.jsonl
$BINARY facts import --database $DB --input $DB/batch.jsonl 2>/dev/null && ok "批量导入50条" || fail "批量导入失败"

# 4. facts list有输出
LIST_OUT=$($BINARY facts list --database $DB 2>/dev/null)
LIST_LINES=$(echo "$LIST_OUT" | wc -l)
[ "$LIST_LINES" -ge 2 ] && ok "facts list有输出 ($LIST_LINES行)" || fail "facts list无输出"

# 5. facts search相似度排序
SEARCH_OUT=$($BINARY facts search --database $DB --query-vector '[1.0,0.0,0.0]' --top-k 3 2>/dev/null)
RCOUNT=$(echo "$SEARCH_OUT" | grep -c "similarity\|sim" || true)
[ "$RCOUNT" -ge 1 ] && ok "facts search返回结果 ($RCOUNT条)" || fail "facts search无结果"

# 6. facts import子命令help
$BINARY facts import --help 2>&1 | grep -q "database" && ok "facts import --help可用" || fail "facts import --help失败"

# 7. facts search子命令help
$BINARY facts search --help 2>&1 | grep -q "database" && ok "facts search --help可用" || fail "facts search --help失败"

echo ""
echo "  Passed: $PASS"
[ $FAIL -gt 0 ] && echo "  Failed: $FAIL"
exit $FAIL
