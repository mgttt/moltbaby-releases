#!/bin/bash
# ============================================================
# Zig 交叉编译脚本 - libndts (N-Dimensional Time Series)
# 支持: Linux (x64, ARM64, musl), macOS (x64, ARM64), Windows (x64)
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

NATIVE_DIR="$PWD/native"
OUTPUT_DIR="$NATIVE_DIR/dist"

mkdir -p "$OUTPUT_DIR"

# 查找 Zig
find_zig() {
    # 优先使用本地下载的 Zig
    LOCAL_ZIG="$NATIVE_DIR/zig-linux-x86_64-0.13.0/zig"
    if [ -f "$LOCAL_ZIG" ]; then
        echo "$LOCAL_ZIG"
        return
    fi
    
    if command -v zig &> /dev/null; then
        echo "zig"
        return
    fi
    
    echo "❌ Zig not found. Run: cd native && curl -L -o zig.tar.xz 'https://ziglang.org/download/0.13.0/zig-linux-x86_64-0.13.0.tar.xz' && tar -xf zig.tar.xz"
    exit 1
}

ZIG=$(find_zig)
echo "🚀 Zig Cross Compilation for libndts"
echo "======================================"
echo "Using: $ZIG"
echo ""

# 编译目标
TARGETS=(
    "x86_64-linux-gnu:libndts-linux-x64.so"
    "aarch64-linux-gnu:libndts-linux-arm64.so"
    "x86_64-linux-musl:libndts-linux-musl-x64.so"
    "x86_64-macos:libndts-macos-x64.dylib"
    "aarch64-macos:libndts-macos-arm64.dylib"
    "x86_64-windows-gnu:libndts-windows-x64.dll"
)

echo "🔨 Compiling ndts.c for multiple targets..."
echo ""

SUCCESS=0
FAILED=0

for TARGET_PAIR in "${TARGETS[@]}"; do
    IFS=':' read -r TARGET OUTPUT <<< "$TARGET_PAIR"
    
    printf "📦 %-25s -> %s ... " "$TARGET" "$OUTPUT"
    
    if $ZIG cc -O3 -ffast-math -shared -target "$TARGET" -o "$OUTPUT_DIR/$OUTPUT" "$NATIVE_DIR/ndts.c" 2>/dev/null; then
        SIZE=$(ls -lh "$OUTPUT_DIR/$OUTPUT" | awk '{print $5}')
        echo "✅ ($SIZE)"
        ((SUCCESS++))
    else
        echo "⚠️ failed"
        ((FAILED++))
    fi
done

echo ""
echo "════════════════════════════════════"
echo "📊 Results: $SUCCESS success, $FAILED failed"
echo ""
echo "📁 Output files:"
ls -lh "$OUTPUT_DIR/libndts-"* 2>/dev/null || echo "No output files"
echo ""
echo "✅ Cross compilation complete!"
