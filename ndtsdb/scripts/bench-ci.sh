#!/bin/bash
# ============================================================
# bench-ci.sh - 性能基准自动化脚本
# 自动运行基准测试，记录历史，检测性能回退
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$HOME/.ndtsdb-cli"
HISTORY_FILE="$DATA_DIR/bench-history.jsonl"

# 配置
ALERT_THRESHOLD="${BENCH_ALERT_THRESHOLD:-0.1}"  # 默认10%

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() {
    echo "[bench-ci] $1"
}

warn() {
    echo -e "${YELLOW}[bench-ci] ⚠️  $1${NC}"
}

error() {
    echo -e "${RED}[bench-ci] ❌ $1${NC}"
}

success() {
    echo -e "${GREEN}[bench-ci] ✅ $1${NC}"
}

# 确保数据目录存在
mkdir -p "$DATA_DIR"

log "运行性能基准测试..."

# 清理旧数据库
log "清理环境..."
rm -rf "$PROJECT_DIR/data/benchmark"

# 运行基准测试
cd "$PROJECT_DIR"
BENCH_OUTPUT=$(bun run scripts/bench.js 2>&1) || {
    error "基准测试运行失败"
    echo "$BENCH_OUTPUT"
    exit 1
}

# 解析JSON结果
RESULT=$(echo "$BENCH_OUTPUT" | grep -E '^\{.*\}$' | tail -1)

if [ -z "$RESULT" ]; then
    error "无法解析基准测试输出"
    echo "$BENCH_OUTPUT"
    exit 1
fi

# 提取关键指标
WRITE_SPEED=$(echo "$RESULT" | bun -e "const d = JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.write_rows_per_sec || 0)" <<< "$RESULT" 2>/dev/null || echo "0")
READ_SPEED=$(echo "$RESULT" | bun -e "const d = JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.read_rows_per_sec || 0)" <<< "$RESULT" 2>/dev/null || echo "0")
BINARY_SIZE=$(echo "$RESULT" | bun -e "const d = JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.binary_size_mb || 0)" <<< "$RESULT" 2>/dev/null || echo "0")

# 使用jq如果可用，否则用bun
if command -v jq &> /dev/null; then
    WRITE_SPEED=$(echo "$RESULT" | jq -r '.write_rows_per_sec // 0')
    READ_SPEED=$(echo "$RESULT" | jq -r '.read_rows_per_sec // 0')
    BINARY_SIZE=$(echo "$RESULT" | jq -r '.binary_size_mb // 0')
fi

log "写入吞吐量: $(printf "%'d" $WRITE_SPEED) rows/s"
log "读取吞吐量: $(printf "%'d" $READ_SPEED) rows/s"
log "二进制大小: ${BINARY_SIZE} MB"

# 读取上次结果进行性能对比
if [ -f "$HISTORY_FILE" ]; then
    LAST_ENTRY=$(tail -1 "$HISTORY_FILE")
    
    if command -v jq &> /dev/null; then
        LAST_WRITE=$(echo "$LAST_ENTRY" | jq -r '.write_rows_per_sec // 0')
        LAST_READ=$(echo "$LAST_ENTRY" | jq -r '.read_rows_per_sec // 0')
    else
        LAST_WRITE=$(echo "$LAST_ENTRY" | bun -e "const d = JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.write_rows_per_sec || 0)" 2>/dev/null || echo "0")
        LAST_READ=$(echo "$LAST_ENTRY" | bun -e "const d = JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.read_rows_per_sec || 0)" 2>/dev/null || echo "0")
    fi
    
    if [ "$LAST_WRITE" -gt 0 ]; then
        WRITE_CHANGE=$(awk "BEGIN {printf \"%.2f\", ($WRITE_SPEED - $LAST_WRITE) / $LAST_WRITE}")
        if (( $(echo "$WRITE_CHANGE < -$ALERT_THRESHOLD" | bc -l 2>/dev/null || echo "0") )); then
            DEGRADATION_PCT=$(echo "$WRITE_CHANGE" | awk '{printf "%.0f", -$1 * 100}')
            warn "写入性能下降 ${DEGRADATION_PCT}% (上次: $(printf "%'d" $LAST_WRITE) rows/s)"
        elif (( $(echo "$WRITE_CHANGE > $ALERT_THRESHOLD" | bc -l 2>/dev/null || echo "0") )); then
            IMPROVE_PCT=$(echo "$WRITE_CHANGE" | awk '{printf "%.0f", $1 * 100}')
            success "写入性能提升 ${IMPROVE_PCT}%"
        fi
    fi
    
    if [ "$LAST_READ" -gt 0 ]; then
        READ_CHANGE=$(awk "BEGIN {printf \"%.2f\", ($READ_SPEED - $LAST_READ) / $LAST_READ}")
        if (( $(echo "$READ_CHANGE < -$ALERT_THRESHOLD" | bc -l 2>/dev/null || echo "0") )); then
            DEGRADATION_PCT=$(echo "$READ_CHANGE" | awk '{printf "%.0f", -$1 * 100}')
            warn "读取性能下降 ${DEGRADATION_PCT}% (上次: $(printf "%'d" $LAST_READ) rows/s)"
        elif (( $(echo "$READ_CHANGE > $ALERT_THRESHOLD" | bc -l 2>/dev/null || echo "0") )); then
            IMPROVE_PCT=$(echo "$READ_CHANGE" | awk '{printf "%.0f", $1 * 100}')
            success "读取性能提升 ${IMPROVE_PCT}%"
        fi
    fi
fi

# 保存结果到历史记录
echo "$RESULT" >> "$HISTORY_FILE"
success "结果已保存到 $HISTORY_FILE"

# 输出摘要
log "--- 本次运行摘要 ---"
echo "  时间: $(echo "$RESULT" | jq -r '.timestamp // "N/A"' 2>/dev/null || echo "N/A")"
echo "  版本: $(echo "$RESULT" | jq -r '.version // "N/A"' 2>/dev/null || echo "N/A")"
echo "  写入: $(printf "%'d" $WRITE_SPEED) rows/s"
echo "  读取: $(printf "%'d" $READ_SPEED) rows/s"
