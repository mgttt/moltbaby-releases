#!/bin/bash
# test-knowledge.sh - 知识引擎集成测试

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="${CLI:-$SCRIPT_DIR/../../ndtsdb-cli}"
TMPDIR=$(mktemp -d)
DB="$TMPDIR/test_knowledge_db"

# 颜色
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo "=== Knowledge Engine Integration Test ==="

# 清理函数
cleanup() {
    rm -rf "$TMPDIR"
}
trap cleanup EXIT

# 准备测试数据
mkdir -p "$DB"

# 创建测试 facts JSONL
cat > "$TMPDIR/facts.jsonl" << 'EOF'
{"text":"Bitcoin is a cryptocurrency","embedding":[0.1,0.2,0.3,0.4],"tags":["crypto","bitcoin"]}
{"text":"Ethereum supports smart contracts","embedding":[0.2,0.3,0.4,0.5],"tags":["crypto","ethereum"]}
{"text":"Machine learning is a subset of AI","embedding":[0.8,0.7,0.6,0.5],"tags":["ai","ml"]}
EOF

echo "[TEST 1] facts import"
if $CLI facts import --database "$DB" --input "$TMPDIR/facts.jsonl" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ facts import passed${NC}"
else
    echo -e "${RED}✗ facts import failed${NC}"
    exit 1
fi

echo "[TEST 2] facts list"
if $CLI facts list --database "$DB" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ facts list passed${NC}"
else
    echo -e "${RED}✗ facts list failed${NC}"
    exit 1
fi

echo "[TEST 3] facts search"
if $CLI facts search --database "$DB" --query-vector '[0.1,0.2,0.3,0.4]' --top-k 2 > /dev/null 2>&1; then
    echo -e "${GREEN}✓ facts search passed${NC}"
else
    echo -e "${RED}✗ facts search failed${NC}"
    exit 1
fi

echo "[TEST 4] search command (semantic search)"
if $CLI search --database "$DB" --query-vector '[0.1,0.2,0.3,0.4]' --top-k 5 > /dev/null 2>&1; then
    echo -e "${GREEN}✓ search command passed${NC}"
else
    echo -e "${RED}✗ search command failed${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}=== All knowledge tests passed! ===${NC}"
exit 0