#!/usr/bin/env bash
# ============================================================
# ndtsdb 版本号同步脚本
# 用法: ./scripts/sync-version.sh
# 功能: 读取 VERSION 文件，同步到 README.md 和 package.json
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

VERSION_FILE="$PROJECT_ROOT/VERSION"
README_FILE="$PROJECT_ROOT/README.md"
PACKAGE_FILE="$PROJECT_ROOT/package.json"

# 读取版本号
if [ ! -f "$VERSION_FILE" ]; then
    echo "❌ VERSION file not found: $VERSION_FILE"
    exit 1
fi

VERSION=$(cat "$VERSION_FILE" | tr -d '[:space:]')

if [ -z "$VERSION" ]; then
    echo "❌ VERSION file is empty"
    exit 1
fi

echo "📦 Syncing version: $VERSION"

# 1. 同步到 README.md
if [ -f "$README_FILE" ]; then
    # 检查是否有 VERSION_START/VERSION_END 标记
    if grep -q "VERSION_START" "$README_FILE"; then
        # 使用标记替换
        sed -i "s/<!-- VERSION_START -->.*<!-- VERSION_END -->/<!-- VERSION_START -->\n**Version: $VERSION**\n<!-- VERSION_END -->/" "$README_FILE"
        echo "  ✅ Updated README.md (VERSION markers)"
    else
        echo "  ⚠️ README.md missing VERSION_START/END markers"
    fi
else
    echo "  ⚠️ README.md not found"
fi

# 2. 同步到 package.json
if [ -f "$PACKAGE_FILE" ]; then
    # 更新 package.json 中的 version 字段
    if command -v jq &> /dev/null; then
        jq ".version = \"$VERSION\"" "$PACKAGE_FILE" > "$PACKAGE_FILE.tmp" && mv "$PACKAGE_FILE.tmp" "$PACKAGE_FILE"
        echo "  ✅ Updated package.json"
    else
        # fallback: 使用 sed
        sed -i "s/\"version\": *\"[^\"]*\"/\"version\": \"$VERSION\"/" "$PACKAGE_FILE"
        echo "  ✅ Updated package.json (sed fallback)"
    fi
else
    echo "  ⚠️ package.json not found"
fi

echo "✨ Version sync complete: $VERSION"
