#!/bin/bash
# test-plugin.sh - 插件系统测试

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="${CLI:-$SCRIPT_DIR/../../ndtsdb-cli}"
TMPDIR=$(mktemp -d)

# 颜色
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo "=== Plugin System Test ==="

# 清理函数
cleanup() {
    rm -rf "$TMPDIR"
}
trap cleanup EXIT

# 编译示例插件
echo "[TEST 1] Build example plugin"
cd "$SCRIPT_DIR/../../examples"
make my-plugin.so 2>&1 > /dev/null || gcc -shared -fPIC -o my-plugin.so my-plugin.c -I../include 2>&1
if [ -f my-plugin.so ]; then
    echo -e "${GREEN}✓ Example plugin built${NC}"
    cp my-plugin.so "$TMPDIR/"
else
    echo -e "${RED}✗ Failed to build plugin${NC}"
    exit 1
fi

# 测试 plugin list
echo "[TEST 2] plugin list"
if $CLI plugin list --plugin-dir "$TMPDIR" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ plugin list passed${NC}"
else
    echo -e "${RED}✗ plugin list failed${NC}"
    exit 1
fi

# 测试 plugin info
echo "[TEST 3] plugin info"
if $CLI plugin info my-plugin.so --plugin-dir "$TMPDIR" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ plugin info passed${NC}"
else
    echo -e "${RED}✗ plugin info failed${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}=== All plugin tests passed! ===${NC}"
exit 0