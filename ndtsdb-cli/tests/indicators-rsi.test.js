// tests/indicators-rsi.test.js - RSI 单元测试
// 运行: ./ndtsdb-cli tests/indicators-rsi.test.js

// 内联RSI实现
class StreamingRSI {
    constructor(period = 14) {
        if (period <= 0) throw new Error('Period must be positive');
        this.period = period;
        this.reset();
    }
    reset() {
        this._prevClose = null;
        this._gains = [];
        this._losses = [];
        this._avgGain = null;
        this._avgLoss = null;
        this._value = null;
        this._count = 0;
    }
    get value() { return this._value; }
    get isReady() { return this._avgGain !== null; }
    get count() { return this._count; }
    update(close) {
        if (typeof close !== 'number' || isNaN(close)) return this._value;
        this._count++;
        if (this._prevClose === null) {
            this._prevClose = close;
            return this._value;
        }
        const delta = close - this._prevClose;
        this._prevClose = close;
        const gain = delta > 0 ? delta : 0;
        const loss = delta < 0 ? -delta : 0;
        if (this._avgGain === null) {
            this._gains.push(gain);
            this._losses.push(loss);
            if (this._gains.length === this.period) {
                this._avgGain = this._gains.reduce((a, b) => a + b, 0) / this.period;
                this._avgLoss = this._losses.reduce((a, b) => a + b, 0) / this.period;
                this._gains = [];
                this._losses = [];
                this._calculateRSI();
            }
        } else {
            this._avgGain = (this._avgGain * (this.period - 1) + gain) / this.period;
            this._avgLoss = (this._avgLoss * (this.period - 1) + loss) / this.period;
            this._calculateRSI();
        }
        return this._value;
    }
    _calculateRSI() {
        if (this._avgLoss === 0) {
            this._value = 100;
        } else {
            const rs = this._avgGain / this._avgLoss;
            this._value = 100 - (100 / (1 + rs));
        }
    }
}

let passed = 0, failed = 0;

function assert(cond, msg) {
    if (cond) { passed++; console.log(`  ✓ ${msg}`); }
    else { failed++; console.log(`  ✗ ${msg}`); }
}

function assertClose(actual, expected, tol, msg) {
    const diff = Math.abs(actual - expected);
    assert(diff <= tol, `${msg} (expected: ${expected}, got: ${actual})`);
}

console.log('=== StreamingRSI 单元测试 ===\n');

// 测试1: 基本功能
console.log('测试1: 基本功能');
const rsi1 = new StreamingRSI(14);
assert(rsi1.value === null, '初始值为null');
assert(rsi1.isReady === false, '初始未准备好');

// 测试2: 持续上涨RSI=100
console.log('\n测试2: 持续上涨RSI=100');
const rsi2 = new StreamingRSI(5);
[100, 101, 102, 103, 104, 105].forEach(p => rsi2.update(p));
assert(rsi2.isReady === true, '5个数据后准备好');
assertClose(rsi2.value, 100, 0.01, '持续上涨RSI=100');

// 测试3: 持续下跌RSI=0
console.log('\n测试3: 持续下跌RSI=0');
const rsi3 = new StreamingRSI(5);
[100, 99, 98, 97, 96, 95].forEach(p => rsi3.update(p));
assertClose(rsi3.value, 0, 0.01, '持续下跌RSI=0');

// 测试4: 震荡市RSI≈50
console.log('\n测试4: 震荡市RSI≈50');
const rsi4 = new StreamingRSI(14);
// 交替涨跌
for (let i = 0; i < 20; i++) {
    rsi4.update(100 + (i % 2 === 0 ? 1 : -1));
}
assert(rsi4.value > 40 && rsi4.value < 60, '震荡市RSI在40-60之间');

// 测试5: 边界条件
console.log('\n测试5: 边界条件');
try { new StreamingRSI(0); assert(false, 'period=0应抛错'); }
catch (e) { assert(true, 'period=0抛错'); }
try { new StreamingRSI(-1); assert(false, 'period<0应抛错'); }
catch (e) { assert(true, 'period<0抛错'); }

// 测试6: 重置功能
console.log('\n测试6: 重置功能');
const rsi6 = new StreamingRSI(3);
[100, 101, 102, 103].forEach(p => rsi6.update(p));
assert(rsi6.isReady === true, '3+1个数据后准备好');
rsi6.reset();
assert(rsi6.value === null, '重置后value=null');
assert(rsi6.isReady === false, '重置后未准备好');

// 汇总
console.log('\n====================');
console.log(`通过: ${passed}, 失败: ${failed}`);
if (failed === 0) console.log('✅ 所有测试通过');
else console.log('❌ 有测试失败');
