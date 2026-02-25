// tests/indicators-ema.test.js - EMA 单元测试
// 运行: ./ndtsdb-cli tests/indicators-ema.test.js

// 内联导入indicators.js内容（QuickJS单二进制限制）
// 这里直接包含EMA实现

class StreamingEMA {
    constructor(period = 20) {
        if (period <= 0) {
            throw new Error('Period must be positive');
        }
        this.period = period;
        this.multiplier = 2 / (period + 1);
        this.reset();
    }

    reset() {
        this._values = [];
        this._sum = 0;
        this._value = null;
        this._initialized = false;
    }

    get value() {
        return this._value;
    }

    update(close) {
        if (typeof close !== 'number' || isNaN(close)) {
            return this._value;
        }

        if (!this._initialized) {
            this._values.push(close);
            this._sum += close;

            if (this._values.length === this.period) {
                this._value = this._sum / this.period;
                this._initialized = true;
                this._values = [];
            }
        } else {
            this._value = close * this.multiplier + this._value * (1 - this.multiplier);
        }

        return this._value;
    }

    get isReady() {
        return this._initialized;
    }
}

function calculateEMA(data, period = 20) {
    const ema = new StreamingEMA(period);
    const results = [];
    for (let i = 0; i < data.length; i++) {
        const value = ema.update(data[i]);
        if (value !== null) {
            results.push({ index: i, value: value });
        }
    }
    return results;
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        passed++;
        console.log(`  ✓ ${message}`);
    } else {
        failed++;
        console.log(`  ✗ ${message}`);
    }
}

function assertClose(actual, expected, tolerance, message) {
    const diff = Math.abs(actual - expected);
    assert(diff <= tolerance, `${message} (expected: ${expected}, got: ${actual}, diff: ${diff})`);
}

console.log('=== StreamingEMA 单元测试 ===\n');

// 测试1: 基本功能
console.log('测试1: 基本功能');
const ema1 = new StreamingEMA(5);
assert(ema1.value === null, '初始值为null');
assert(ema1.isReady === false, '初始未准备好');

// 测试2: 前4个返回null
console.log('\n测试2: 前period-1个返回null');
const ema2 = new StreamingEMA(5);
assert(ema2.update(10) === null, '第1个返回null');
assert(ema2.update(11) === null, '第2个返回null');
assert(ema2.update(12) === null, '第3个返回null');
assert(ema2.update(11) === null, '第4个返回null');
assert(ema2.isReady === false, '4个数据后仍未准备好');

// 测试3: 第5个返回SMA
console.log('\n测试3: 第period个返回SMA初始化值');
const ema3 = new StreamingEMA(5);
[10, 11, 12, 11, 10].forEach(p => ema3.update(p));
// SMA = (10+11+12+11+10)/5 = 10.8
assertClose(ema3.value, 10.8, 0.0001, '第5个返回SMA=10.8');
assert(ema3.isReady === true, '5个数据后准备好');

// 测试4: EMA计算验证
console.log('\n测试4: EMA公式验证');
const ema4 = new StreamingEMA(5);
const multiplier = 2 / 6;  // = 0.333...
const data = [100, 101, 102, 101, 103];  // SMA = (100+101+102+101+103)/5 = 101.4

data.forEach(p => ema4.update(p));
assertClose(ema4.value, 101.4, 0.0001, 'SMA初始化=101.4');

// 下一个EMA: close × k + prevEMA × (1-k)
// = 105 × 0.333 + 101.4 × 0.667
// = 35 + 67.6 = 102.6 (approx)
const nextValue = ema4.update(105);
const expectedEMA = 105 * multiplier + 101.4 * (1 - multiplier);
assertClose(nextValue, expectedEMA, 0.0001, 'EMA计算正确');

// 测试5: 批量计算
console.log('\n测试5: 批量计算');
const prices = [10, 11, 12, 11, 10, 9, 8];
const results = calculateEMA(prices, 5);
assert(results.length === 3, '返回3个结果（从第5个开始）');
assert(results[0].index === 4, '第一个结果index=4');

// 测试6: 重置功能
console.log('\n测试6: 重置功能');
const ema6 = new StreamingEMA(3);
[1, 2, 3].forEach(p => ema6.update(p));
assert(ema6.value === 2, '3个数据后value=2');
ema6.reset();
assert(ema6.value === null, '重置后value=null');
assert(ema6.isReady === false, '重置后未准备好');

// 测试7: 边界条件
console.log('\n测试7: 边界条件');
try {
    new StreamingEMA(0);
    assert(false, 'period=0应该抛出错误');
} catch (e) {
    assert(true, 'period=0抛出错误');
}

try {
    new StreamingEMA(-1);
    assert(false, 'period<0应该抛出错误');
} catch (e) {
    assert(true, 'period<0抛出错误');
}

// 测试8: NaN处理
console.log('\n测试8: NaN处理');
const ema8 = new StreamingEMA(3);
ema8.update(1);
ema8.update(2);
const nanResult = ema8.update(NaN);
assert(nanResult === null, 'NaN返回当前值不变');
ema8.update(3);
assert(ema8.value === 2, '正常值继续计算');

// 汇总
console.log('\n====================');
console.log(`通过: ${passed}, 失败: ${failed}`);
if (failed === 0) {
    console.log('✅ 所有测试通过');
} else {
    console.log('❌ 有测试失败');
}
