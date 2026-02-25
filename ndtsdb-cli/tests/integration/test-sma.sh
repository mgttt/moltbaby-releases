#!/bin/bash
# test-sma.sh - StreamingSMA 单元测试
# 验证 SMA 计算正确性

set -e

CLI="${CLI:-../../ndtsdb-cli}"
TEST_DB="/tmp/test_sma_db"

echo "=== StreamingSMA 单元测试 ==="

# 清理
cleanup() {
    rm -rf "$TEST_DB" /tmp/test_sma_*.js /tmp/test_data_*.csv
}
trap cleanup EXIT

rm -rf "$TEST_DB"
mkdir -p "$TEST_DB"

# 创建测试数据
echo "1. 准备测试数据..."
cat > /tmp/test_data.csv << 'EOF'
symbol,interval,timestamp,open,high,low,close,volume
BTCUSDT,1m,1700000000000,100,101,99,100,1000
BTCUSDT,1m,1700000060000,100,102,98,102,1100
BTCUSDT,1m,1700000120000,102,103,101,103,1200
BTCUSDT,1m,1700000180000,103,104,102,104,1300
BTCUSDT,1m,1700000240000,104,105,103,105,1400
BTCUSDT,1m,1700000300000,105,106,104,106,1500
BTCUSDT,1m,1700000360000,106,107,105,107,1600
BTCUSDT,1m,1700000420000,107,108,106,108,1700
BTCUSDT,1m,1700000480000,108,109,107,109,1800
BTCUSDT,1m,1700000540000,109,110,108,110,1900
EOF

cat /tmp/test_data.csv | "$CLI" write-csv --database "$TEST_DB"
echo "   ✓ 10条测试数据写入成功"

# 验证数据
count=$($CLI list --database "$TEST_DB" | grep -c BTCUSDT || true)
if [ "$count" -eq 0 ]; then
    echo "   ✗ 数据写入失败"
    exit 1
fi

# 内联测试脚本
echo ""
echo "2. 测试 StreamingSMA 计算..."

cat > /tmp/test_sma_run.js << 'SCRIPT'
import * as ndtsdb from 'ndtsdb';

class StreamingSMA {
    constructor(period = 20) {
        if (period <= 0) throw new Error('Period must be positive');
        this.period = period;
        this.reset();
    }
    reset() {
        this._values = [];
        this._sum = 0;
        this._count = 0;
        this._value = null;
    }
    get value() { return this._value; }
    get isReady() { return this._values.length >= this.period; }
    get count() { return this._count; }
    update(close) {
        if (typeof close !== 'number' || isNaN(close)) return this._value;
        this._values.push(close);
        this._sum += close;
        this._count++;
        if (this._values.length > this.period) {
            this._sum -= this._values.shift();
        }
        if (this._values.length >= this.period) {
            this._value = this._sum / this.period;
        }
        return this._value;
    }
}

const db = ndtsdb.open('/tmp/test_sma_db/');
const allData = ndtsdb.queryAll(db);
const data = allData.filter(r => r.symbol === 'BTCUSDT');
data.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));

console.log('   数据点: ' + data.length);

// 手动验证 SMA-3
const sma3 = new StreamingSMA(3);
const results3 = [];
for (const row of data) {
    const v = sma3.update(row.close);
    if (v !== null) results3.push(v);
}

let pass = true;
const expected1 = (100 + 102 + 103) / 3;  // 101.6667
const expected2 = (102 + 103 + 104) / 3;  // 103.0
const expected3 = (103 + 104 + 105) / 3;  // 104.0

console.log('   SMA-3 验证:');
console.log('     [0] calc=' + results3[0].toFixed(4) + ' expect=' + expected1.toFixed(4));
console.log('     [1] calc=' + results3[1].toFixed(4) + ' expect=' + expected2.toFixed(4));
console.log('     [2] calc=' + results3[2].toFixed(4) + ' expect=' + expected3.toFixed(4));

if (Math.abs(results3[0] - expected1) > 0.0001) pass = false;
if (Math.abs(results3[1] - expected2) > 0.0001) pass = false;
if (Math.abs(results3[2] - expected3) > 0.0001) pass = false;

if (pass) console.log('   ✓ SMA-3 计算正确');

// 测试 SMA-5
const sma5 = new StreamingSMA(5);
const results5 = [];
for (const row of data) {
    const v = sma5.update(row.close);
    if (v !== null) results5.push(v);
}

const expected5 = (100 + 102 + 103 + 104 + 105) / 5;  // 102.8
console.log('   SMA-5 验证:');
console.log('     [0] calc=' + results5[0].toFixed(4) + ' expect=' + expected5.toFixed(4));

if (Math.abs(results5[0] - expected5) > 0.0001) {
    console.log('   ✗ FAIL');
    pass = false;
} else {
    console.log('   ✓ SMA-5 计算正确');
}

// 测试未就绪返回null
const sma20 = new StreamingSMA(20);
const nullResults = [];
for (let i = 0; i < 5; i++) {
    nullResults.push(sma20.update(data[i].close));
}
if (nullResults.every(v => v === null)) {
    console.log('   ✓ 未满足period时正确返回null');
} else {
    console.log('   ✗ FAIL: 应返回null');
    pass = false;
}

// 测试reset
sma5.reset();
if (sma5.value === null && sma5.count === 0) {
    console.log('   ✓ reset() 工作正常');
} else {
    console.log('   ✗ FAIL: reset()');
    pass = false;
}

ndtsdb.close(db);

if (pass) {
    console.log('\n=== 所有测试通过 ===');
    exit(0);
} else {
    console.log('\n=== 测试失败 ===');
    exit(1);
}
SCRIPT

"$CLI" /tmp/test_sma_run.js
