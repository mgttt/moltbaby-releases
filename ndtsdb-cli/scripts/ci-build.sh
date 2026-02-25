#!/bin/bash
# scripts/ci-build.sh - CI 构建验证脚本
# 用于自动化构建和基本功能测试

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$CLI_DIR/.." && pwd)"

COSMO_IMAGE="${COSMO_IMAGE:-localhost/cosmocc:latest}"
OUTPUT_BINARY="ndtsdb-cli-ci.com"

# 颜色
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo "=========================================="
echo "  ndtsdb-cli CI Build Verification"
echo "=========================================="
echo ""

# 检查 podman
if ! command -v podman &> /dev/null; then
    echo -e "${RED}Error: podman not found${NC}"
    exit 1
fi

# 检查 cosmocc 镜像
if ! podman image exists "$COSMO_IMAGE"; then
    echo -e "${RED}Error: cosmocc image not found: $COSMO_IMAGE${NC}"
    echo "Build it first: see skills/cosmocc/SKILL.md"
    exit 1
fi

echo "[1/3] Building APE binary with cosmocc..."
cd "$PROJECT_ROOT"
podman run --rm \
    -v "$PROJECT_ROOT":/workspace \
    -w /workspace \
    "$COSMO_IMAGE" \
    cosmocc -o "ndtsdb-cli/$OUTPUT_BINARY" \
        ndtsdb-cli/src/main.c ndtsdb-cli/src/common.c ndtsdb-cli/src/cmd_query.c \
        ndtsdb-cli/src/cmd_io.c ndtsdb-cli/src/cmd_indicators.c ndtsdb-cli/src/cmd_sql.c \
        ndtsdb-cli/src/cmd_serve.c ndtsdb-cli/src/ndtsdb_lock.c \
        ndtsdb-cli/src/bindings/qjs_ndtsdb.c \
        ndtsdb/native/ndts.c ndtsdb/native/ndtsdb_vector.c \
        ndtsdb-cli/vendor/quickjs-2024-01-13/quickjs.c \
        ndtsdb-cli/vendor/quickjs-2024-01-13/libregexp.c \
        ndtsdb-cli/vendor/quickjs-2024-01-13/libunicode.c \
        ndtsdb-cli/vendor/quickjs-2024-01-13/cutils.c \
        ndtsdb-cli/vendor/quickjs-2024-01-13/libbf.c \
        -I./ndtsdb-cli/src/bindings -I./ndtsdb-cli/include \
        -I./ndtsdb/native -I./ndtsdb-cli/vendor/quickjs-2024-01-13 \
        -DCONFIG_VERSION=\"2024-01-13\" -D_GNU_SOURCE -DCONFIG_BIGNUM -lm \
    2>&1 | tail -3

chmod +x "$CLI_DIR/$OUTPUT_BINARY"

echo ""
echo "[2/3] Binary info:"
echo "  File: $OUTPUT_BINARY"
echo "  Size: $(ls -lh "$CLI_DIR/$OUTPUT_BINARY" | awk '{print $5}')"
echo "  Type: $(file "$CLI_DIR/$OUTPUT_BINARY" | cut -d: -f2 | xargs)"

echo ""
echo "[3/3] Running basic tests..."

# Test 1: --help
echo -n "  Test --help... "
if "$CLI_DIR/$OUTPUT_BINARY" --help > /dev/null 2>&1; then
    echo -e "${GREEN}OK${NC}"
else
    echo -e "${RED}FAILED${NC}"
    exit 1
fi

# Test 2: write-json
echo -n "  Test write-json... "
TEST_DB="/tmp/ndtsdb_ci_test_$$"
mkdir -p "$TEST_DB"
if echo '{"symbol":"TEST","interval":"1m","timestamp":1700000000000,"open":100,"high":110,"low":90,"close":105,"volume":1000}' | \
   "$CLI_DIR/$OUTPUT_BINARY" write-json --database "$TEST_DB" > /dev/null 2>&1; then
    echo -e "${GREEN}OK${NC}"
else
    echo -e "${RED}FAILED${NC}"
    rm -rf "$TEST_DB"
    exit 1
fi

# Test 3: query
echo -n "  Test query... "
if "$CLI_DIR/$OUTPUT_BINARY" query --database "$TEST_DB" --format json > /dev/null 2>&1; then
    echo -e "${GREEN}OK${NC}"
else
    echo -e "${RED}FAILED${NC}"
    rm -rf "$TEST_DB"
    exit 1
fi

# Cleanup
rm -rf "$TEST_DB"

echo ""
echo "=========================================="
echo -e "${GREEN}  All CI tests passed!${NC}"
echo "=========================================="
echo ""
echo "Output binary: $OUTPUT_BINARY"
echo "Location: $CLI_DIR/$OUTPUT_BINARY"
echo "Size: $(ls -lh "$CLI_DIR/$OUTPUT_BINARY" | awk '{print $5}')"

exit 0