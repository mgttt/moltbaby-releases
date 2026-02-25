#!/bin/bash
# test-vector-cosine.sh — COSINE_SIM 端到端测试

set -e

DB_DIR="/tmp/test_cosine_$$"
mkdir -p "$DB_DIR"

echo "=== COSINE_SIM 端到端测试 ==="
echo "数据库: $DB_DIR"

# 创建测试数据（通过 write-json 写入向量格式）
# 注意：write-json 目前只支持 KlineRow，这里用 ndtsdb-cli 的 REPL 模式写入

cat > "$DB_DIR/test.js" << 'EOF'
import * as ndtsdb from 'ndtsdb';
const db = ndtsdb.open('/tmp/test_cosine_XX');

// 写入向量记录（通过 insertVector - 需要实现）
// 目前 queryVectors 可以读取 .ndtv 文件

ndtsdb.close(db);
EOF

echo ""
echo "测试 1: SQL COSINE_SIM 语法解析"
./zig-out/bin/ndtsdb-cli sql --database "$DB_DIR" --query "SELECT * FROM vectors WHERE COSINE_SIM(embedding, [0.1, 0.2, 0.3]) > 0.8" 2>&1 || true

echo ""
echo "测试 2: queryVectors API（空数据库）"
./zig-out/bin/ndtsdb-cli -e "import * as ndtsdb from 'ndtsdb'; const db = ndtsdb.open('$DB_DIR'); print(JSON.stringify(ndtsdb.queryVectors(db, 'BTC', '1m'))); ndtsdb.close(db);" 2>&1 || true

# 清理
rm -rf "$DB_DIR"

echo ""
echo "================================"
echo "测试完成"
echo "================================"
