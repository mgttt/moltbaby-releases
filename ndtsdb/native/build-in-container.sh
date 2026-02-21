#!/bin/sh
# ============================================================
# Zig 容器内编译脚本
# 用于编译 libndts 到多平台
# ============================================================

set -e

echo "🔨 Building libndts with Zig..."
echo ""

# 进入源码目录
cd /src

# 清理旧的构建产物
rm -rf dist/
mkdir -p dist/

# 编译为静态库 (x86_64-linux-musl)
echo "📦 Compiling for x86_64-linux-musl..."
zig build-lib ndts.c \
    -target x86_64-linux-musl \
    -O ReleaseFast \
    -fPIC \
    -lc

# 移动产物到 dist/
mv libndts.a dist/libndts-x86_64-linux-musl.a

echo ""
echo "✅ Build complete!"
echo "📁 Output:"
ls -lh dist/
