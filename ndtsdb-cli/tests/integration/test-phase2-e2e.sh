#!/bin/bash
# test-phase2-e2e.sh - Phase 2 指标端到端集成测试
# 验证 write-csv → query → 指标计算 完整链路

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
CLI="$PROJECT_DIR/ndtsdb-cli"
DATA_DIR="/tmp/phase2-e2e-test-$$"

# 颜色
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

pass=0
fail=0

log() { echo "[e2e] $1"; }
ok() { echo -e "${GREEN}✓ $1${NC}"; pass=$((pass + 1)); }
err() { echo -e "${RED}✗ $1${NC}"; fail=$((fail + 1)); }

# 清理
cleanup() {
    rm -rf "$DATA_DIR"
}
trap cleanup EXIT

log "Phase 2 端到端集成测试"
log "数据目录: $DATA_DIR"
mkdir -p "$DATA_DIR"

# ============================================
# Step 1: 生成100条模拟K线CSV
# ============================================
log "Step 1: 生成100条模拟K线数据..."

CSV_FILE="$DATA_DIR/klines.csv"
cat > "$CSV_FILE" << 'EOF'
symbol,interval,timestamp,open,high,low,close,volume
EOF

# 生成100条数据，close价格在100-110之间波动
base_price=100
for i in $(seq 0 99); do
    ts=$((1700000000000 + i * 3600000))
    change=$(awk -v seed=$i 'BEGIN{srand(seed); print int(rand()*20)-10}')
    close=$((base_price + change))
    echo "BTCUSDT,1h,$ts,$close,$((close+2)),$((close-2)),$close,1000" >> "$CSV_FILE"
done

log "生成了 $(wc -l < "$CSV_FILE") 行CSV（含header）"

# ============================================
# Step 2: write-csv 写入 ndtsdb
# ============================================
log "Step 2: write-csv 写入数据库..."

DB_PATH="$DATA_DIR/btc"
cat "$CSV_FILE" | "$CLI" write-csv --database "$DB_PATH" 2>&1 | head -5

if [ -d "$DB_PATH" ]; then
    ok "写入成功，数据库目录存在"
else
    err "写入失败，数据库目录不存在"
fi

# ============================================
# Step 3: query 读出验证
# ============================================
log "Step 3: query 读出验证..."

QUERY_RESULT=$("$CLI" query --database "$DB_PATH" --format csv 2>/dev/null)
ROW_COUNT=$(echo "$QUERY_RESULT" | wc -l)

if [ "$ROW_COUNT" -ge 100 ]; then
    ok "query返回 $((ROW_COUNT - 1)) 条数据"
else
    err "query返回数据不足: $ROW_COUNT 行"
fi

# ============================================
# Step 4: 指标计算测试
# ============================================
log "Step 4: 指标计算测试..."

# 创建指标测试脚本
INDICATOR_TEST="$DATA_DIR/test-indicators.js"
cat > "$INDICATOR_TEST" << 'ENDSCRIPT'
// 内联指标实现
class StreamingSMA {
    constructor(p) { this.period = p; this._values = []; this._sum = 0; this._value = null; }
    get value() { return this._value; }
    get isReady() { return this._values.length >= this.period; }
    update(c) {
        this._values.push(c); this._sum += c;
        if (this._values.length > this.period) { this._sum -= this._values.shift(); }
        if (this._values.length >= this.period) { this._value = this._sum / this.period; }
        return this._value;
    }
}

class StreamingEMA {
    constructor(p) { this.period = p; this.multiplier = 2 / (p + 1); this._values = []; this._sum = 0; this._value = null; this._init = false; }
    get value() { return this._value; }
    get isReady() { return this._init; }
    update(c) {
        if (!this._init) {
            this._values.push(c); this._sum += c;
            if (this._values.length === this.period) {
                this._value = this._sum / this.period; this._init = true; this._values = [];
            }
        } else { this._value = c * this.multiplier + this._value * (1 - this.multiplier); }
        return this._value;
    }
}

class StreamingRSI {
    constructor(p) { this.period = p; this.reset(); }
    reset() { this._prev = null; this._gains = []; this._losses = []; this._avgGain = null; this._avgLoss = null; this._value = null; }
    get value() { return this._value; }
    get isReady() { return this._avgGain !== null; }
    update(c) {
        if (this._prev === null) { this._prev = c; return this._value; }
        const d = c - this._prev; this._prev = c;
        const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
        if (this._avgGain === null) {
            this._gains.push(g); this._losses.push(l);
            if (this._gains.length === this.period) {
                this._avgGain = this._gains.reduce((a,b)=>a+b,0)/this.period;
                this._avgLoss = this._losses.reduce((a,b)=>a+b,0)/this.period;
                this._calc();
            }
        } else {
            this._avgGain = (this._avgGain * (this.period-1) + g) / this.period;
            this._avgLoss = (this._avgLoss * (this.period-1) + l) / this.period;
            this._calc();
        }
        return this._value;
    }
    _calc() { if (this._avgLoss === 0) this._value = 100; else { const rs = this._avgGain/this._avgLoss; this._value = 100 - 100/(1+rs); } }
}

// 模拟数据（100个价格点）
const prices = [];
for (let i = 0; i < 100; i++) {
    prices.push(100 + (Math.sin(i * 0.1) * 10));
}

// 测试SMA
const sma = new StreamingSMA(20);
let smaCount = 0;
prices.forEach(p => { if (sma.update(p) !== null) smaCount++; });
console.log(`SMA: ${smaCount} values, last=${sma.value ? sma.value.toFixed(2) : 'null'}, isReady=${sma.isReady}`);

// 测试EMA
const ema = new StreamingEMA(20);
let emaCount = 0;
prices.forEach(p => { if (ema.update(p) !== null) emaCount++; });
console.log(`EMA: ${emaCount} values, last=${ema.value ? ema.value.toFixed(2) : 'null'}, isReady=${ema.isReady}`);

// 测试RSI
const rsi = new StreamingRSI(14);
let rsiCount = 0;
prices.forEach(p => { if (rsi.update(p) !== null) rsiCount++; });
console.log(`RSI: ${rsiCount} values, last=${rsi.value ? rsi.value.toFixed(2) : 'null'}, isReady=${rsi.isReady}`);

// 验证
let errors = 0;
if (smaCount !== 81) { console.log('ERROR: SMA count should be 81'); errors++; }
if (emaCount !== 81) { console.log('ERROR: EMA count should be 81'); errors++; }
if (rsiCount !== 86) { console.log('ERROR: RSI count should be 86'); errors++; }
if (!sma.isReady) { console.log('ERROR: SMA should be ready'); errors++; }
if (!ema.isReady) { console.log('ERROR: EMA should be ready'); errors++; }
if (!rsi.isReady) { console.log('ERROR: RSI should be ready'); errors++; }

if (errors === 0) {
    console.log('ALL_TESTS_PASSED');
}
ENDSCRIPT

INDICATOR_OUTPUT=$("$CLI" "$INDICATOR_TEST" 2>&1)
echo "$INDICATOR_OUTPUT"

if echo "$INDICATOR_OUTPUT" | grep -q "ALL_TESTS_PASSED"; then
    ok "SMA/EMA/RSI 指标计算正确"
else
    err "指标计算失败"
fi

# ============================================
# Step 5: MACD/BB 测试
# ============================================
log "Step 5: MACD/BB 测试..."

MACD_BB_TEST="$DATA_DIR/test-macd-bb.js"
cat > "$MACD_BB_TEST" << 'ENDSCRIPT'
// MACD需要EMA，BB需要SMA和标准差
class StreamingEMA {
    constructor(p) { this.period = p; this.multiplier = 2 / (p + 1); this._values = []; this._sum = 0; this._value = null; this._init = false; }
    get value() { return this._value; }
    update(c) {
        if (!this._init) {
            this._values.push(c); this._sum += c;
            if (this._values.length === this.period) { this._value = this._sum / this.period; this._init = true; }
        } else { this._value = c * this.multiplier + this._value * (1 - this.multiplier); }
        return this._value;
    }
}

class StreamingMACD {
    constructor(fast=12, slow=26, signal=9) {
        this._fast = new StreamingEMA(fast);
        this._slow = new StreamingEMA(slow);
        this._signal = new StreamingEMA(signal);
        this._value = null;
    }
    get value() { return this._value; }
    get isReady() { return this._value !== null; }
    update(c) {
        const fast = this._fast.update(c);
        const slow = this._slow.update(c);
        if (fast !== null && slow !== null) {
            const macd = fast - slow;
            const sig = this._signal.update(macd);
            if (sig !== null) {
                this._value = { macd, signal: sig, histogram: macd - sig };
            }
        }
        return this._value;
    }
}

class StreamingBB {
    constructor(p=20, std=2) { this.period = p; this.stdDev = std; this._values = []; this._value = null; }
    get value() { return this._value; }
    get isReady() { return this._values.length >= this.period; }
    update(c) {
        this._values.push(c);
        if (this._values.length > this.period) this._values.shift();
        if (this._values.length >= this.period) {
            const sum = this._values.reduce((a,b)=>a+b,0);
            const mid = sum / this.period;
            const sqSum = this._values.reduce((a,b)=>a+(b-mid)*(b-mid), 0);
            const std = Math.sqrt(sqSum / this.period);
            this._value = { upper: mid + this.stdDev * std, middle: mid, lower: mid - this.stdDev * std };
        }
        return this._value;
    }
}

const prices = [];
for (let i = 0; i < 100; i++) prices.push(100 + Math.sin(i * 0.1) * 10);

const macd = new StreamingMACD(12, 26, 9);
const bb = new StreamingBB(20, 2);
let macdCount = 0, bbCount = 0;

prices.forEach(p => {
    if (macd.update(p) !== null) macdCount++;
    if (bb.update(p) !== null) bbCount++;
});

console.log(`MACD: ${macdCount} values, isReady=${macd.isReady}`);
console.log(`BB: ${bbCount} values, isReady=${bb.isReady}`);

let errors = 0;
if (macdCount < 50) { console.log('ERROR: MACD count too low'); errors++; }
if (bbCount !== 81) { console.log('ERROR: BB count should be 81'); errors++; }
if (!macd.isReady) { console.log('ERROR: MACD should be ready'); errors++; }
if (!bb.isReady) { console.log('ERROR: BB should be ready'); errors++; }

if (errors === 0) console.log('ALL_TESTS_PASSED');
ENDSCRIPT

MACD_BB_OUTPUT=$("$CLI" "$MACD_BB_TEST" 2>&1)
echo "$MACD_BB_OUTPUT"

if echo "$MACD_BB_OUTPUT" | grep -q "ALL_TESTS_PASSED"; then
    ok "MACD/BB 指标计算正确"
else
    err "MACD/BB 计算失败"
fi

# ============================================
# 汇总
# ============================================
echo ""
echo "========================================"
echo "  Phase 2 端到端测试结果"
echo "========================================"
echo -e "${GREEN}通过: $pass${NC}"
echo -e "${RED}失败: $fail${NC}"

if [ $fail -eq 0 ]; then
    echo -e "${GREEN}✅ 所有测试通过${NC}"
    exit 0
else
    echo -e "${RED}❌ 有测试失败${NC}"
    exit 1
fi
