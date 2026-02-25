#!/bin/bash
# ============================================================
# bench-report.sh - 性能趋势报告生成器 (ndtsdb-cli)
# 读取历史数据，生成性能趋势报告
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$HOME/.ndtsdb-cli"
HISTORY_FILE="$DATA_DIR/bench-history.jsonl"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
    echo "[bench-report] $1"
}

# 检查历史文件
if [ ! -f "$HISTORY_FILE" ]; then
    log "历史记录文件不存在: $HISTORY_FILE"
    log "请先运行 bench-ci.sh 生成历史数据"
    exit 1
fi

# 统计记录数
RECORD_COUNT=$(wc -l < "$HISTORY_FILE" | tr -d ' ')
log "找到 $RECORD_COUNT 条历史记录"

if [ "$RECORD_COUNT" -eq 0 ]; then
    log "历史记录为空"
    exit 1
fi

# 生成报告
echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║           ndtsdb-cli 性能趋势报告                           ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# 表头
printf "%-20s %-15s %-15s %-12s\n" "时间" "写入(rows/s)" "读取(rows/s)" "版本"
echo "────────────────────────────────────────────────────────────"

# 读取并显示最近10条记录
tail -10 "$HISTORY_FILE" | while read -r line; do
    if command -v jq &> /dev/null; then
        TS=$(echo "$line" | jq -r '.timestamp // "N/A"' | cut -d'T' -f1)
        WRITE=$(echo "$line" | jq -r '.write_rows_per_sec // 0')
        READ=$(echo "$line" | jq -r '.read_rows_per_sec // 0')
        VER=$(echo "$line" | jq -r '.version // "unknown"' | cut -d' ' -f1)
    else
        TS="N/A"
        WRITE=0
        READ=0
        VER="unknown"
    fi
    
    WRITE_FMT=$(printf "%'d" "$WRITE" 2>/dev/null || echo "$WRITE")
    READ_FMT=$(printf "%'d" "$READ" 2>/dev/null || echo "$READ")
    VER_SHORT=$(echo "$VER" | cut -c1-10)
    
    printf "%-20s %-15s %-15s %-12s\n" "$TS" "$WRITE_FMT" "$READ_FMT" "$VER_SHORT"
done

echo ""

# 计算趋势（如果有至少2条记录）
if [ "$RECORD_COUNT" -ge 2 ]; then
    log "趋势分析 (最近 vs 最早):"
    
    if command -v jq &> /dev/null; then
        FIRST_WRITE=$(head -1 "$HISTORY_FILE" | jq -r '.write_rows_per_sec // 0')
        FIRST_READ=$(head -1 "$HISTORY_FILE" | jq -r '.read_rows_per_sec // 0')
        LAST_WRITE=$(tail -1 "$HISTORY_FILE" | jq -r '.write_rows_per_sec // 0')
        LAST_READ=$(tail -1 "$HISTORY_FILE" | jq -r '.read_rows_per_sec // 0')
        
        if [ "$FIRST_WRITE" -gt 0 ] 2>/dev/null; then
            WRITE_TREND=$(awk "BEGIN {printf \"%.1f\", (($LAST_WRITE - $FIRST_WRITE) / $FIRST_WRITE) * 100}")
            if (( $(echo "$WRITE_TREND >= 0" | bc -l 2>/dev/null || echo "1") )); then
                echo -e "  写入性能: ${GREEN}+${WRITE_TREND}%${NC} (上升)"
            else
                echo -e "  写入性能: ${RED}${WRITE_TREND}%${NC} (下降)"
            fi
        fi
        
        if [ "$FIRST_READ" -gt 0 ] 2>/dev/null; then
            READ_TREND=$(awk "BEGIN {printf \"%.1f\", (($LAST_READ - $FIRST_READ) / $FIRST_READ) * 100}")
            if (( $(echo "$READ_TREND >= 0" | bc -l 2>/dev/null || echo "1") )); then
                echo -e "  读取性能: ${GREEN}+${READ_TREND}%${NC} (上升)"
            else
                echo -e "  读取性能: ${RED}${READ_TREND}%${NC} (下降)"
            fi
        fi
    fi
fi

echo ""
log "历史数据位置: $HISTORY_FILE"
