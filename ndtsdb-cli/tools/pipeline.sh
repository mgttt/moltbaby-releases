#!/usr/bin/env bash
# tools/pipeline.sh — 端到端数据→分析流水线
# 用法: bash tools/pipeline.sh BTC 2026-01-01 2026-01-31
# 依赖: ndtsdb-cli, tools/ingest-binance.ts(bun), bun

set -e

SYMBOL=${1:-BTC}
SINCE=${2:-}
UNTIL=${3:-}
BINARY=${BINARY:-./zig-out/bin/ndtsdb-cli}
DB_1M=${DB_1M:-/tmp/pipeline-1m}
DB_5M=${DB_5M:-/tmp/pipeline-5m}

# 清理旧数据
rm -rf "$DB_1M" "$DB_5M"

echo "[pipeline] 1. 接入 ${SYMBOL} 1m 数据..."
bun tools/ingest-binance.ts --symbol ${SYMBOL}USDT --interval 1m --database "$DB_1M" ${SINCE:+--since $SINCE} ${UNTIL:+--until $UNTIL}

echo "[pipeline] 2. 重采样 1m → 5m..."
$BINARY resample --database "$DB_1M" --symbol ${SYMBOL} --from 1m --to 5m --output "$DB_5M"

echo "[pipeline] 3. 运行策略脚本..."
$BINARY script examples/strategy-demo.js --database "$DB_5M"

echo "[pipeline] 完成"
