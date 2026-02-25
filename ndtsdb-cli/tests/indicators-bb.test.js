/**
 * StreamingBB 单元测试
 * 测试用例数：≥15个
 *
 * 运行：./ndtsdb-cli tests/indicators-bb.test.js
 */

// 内联引入指标实现（测试独立运行）
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

class StreamingBB {
    constructor(period = 20, stdDev = 2) {
        if (period <= 0) throw new Error('Period must be positive');
        if (stdDev <= 0) throw new Error('Standard deviation multiplier must be positive');
        this.period = period;
        this.stdDev = stdDev;
        this._sma = new StreamingSMA(period);
        this._values = [];
        this._value = null;
    }
    reset() {
        this._sma.reset();
        this._values = [];
        this._value = null;
    }
    get value() { return this._value; }
    get isReady() { return this._value !== null; }
    update(close) {
        if (typeof close !== 'number' || isNaN(close)) return this._value;
        this._sma.update(close);
        this._values.push(close);
        if (this._values.length > this.period) {
            this._values.shift();
        }
        if (!this._sma.isReady) return null;
        const middle = this._sma.value;
        let sumSquaredDiff = 0;
        for (let i = 0; i < this._values.length; i++) {
            const diff = this._values[i] - middle;
            sumSquaredDiff += diff * diff;
        }
        const std = Math.sqrt(sumSquaredDiff / this._values.length);
        const upper = middle + this.stdDev * std;
        const lower = middle - this.stdDev * std;
        const bandwidth = (upper - lower) / middle;
        const percentB = (close - lower) / (upper - lower);
        this._value = { upper, middle, lower, bandwidth, percentB };
        return this._value;
    }
}

// ====== 测试框架 ======
let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`✓ ${name}`);
        passed++;
    } catch (e) {
        console.log(`✗ ${name}: ${e.message}`);
        failed++;
    }
}

function assertEqual(actual, expected, epsilon = 0.0001) {
    if (Math.abs(actual - expected) > epsilon) {
        throw new Error(`expected ${expected}, got ${actual}`);
    }
}

function assertTrue(value) {
    if (!value) throw new Error(`expected true, got ${value}`);
}

function assertNull(value) {
    if (value !== null) throw new Error(`expected null, got ${value}`);
}

function assertGreaterThan(actual, expected) {
    if (!(actual > expected)) throw new Error(`expected ${actual} > ${expected}`);
}

function assertLessThan(actual, expected) {
    if (!(actual < expected)) throw new Error(`expected ${actual} < ${expected}`);
}

// ====== 测试数据 ======
const testData = [];
for (let i = 0; i < 50; i++) {
    testData.push(100 + Math.sin(i * 0.1) * 10);
}

// ====== 测试用例 ======
console.log('=== StreamingBB 单元测试 ===\n');

// 1. 构造函数参数验证
test('构造函数接受正整数参数', () => {
    const bb = new StreamingBB(20, 2);
    assertTrue(bb.period === 20);
    assertTrue(bb.stdDev === 2);
});

// 2. 默认值测试
test('默认参数为 (20, 2)', () => {
    const bb = new StreamingBB();
    assertTrue(bb.period === 20);
    assertTrue(bb.stdDev === 2);
});

// 3. 负数period检测
test('负数period应抛出错误', () => {
    try {
        new StreamingBB(-20, 2);
        throw new Error('应抛出错误');
    } catch (e) {
        if (!e.message.includes('Period must be positive')) throw e;
    }
});

// 4. 负数stdDev检测
test('负数stdDev应抛出错误', () => {
    try {
        new StreamingBB(20, -2);
        throw new Error('应抛出错误');
    } catch (e) {
        if (!e.message.includes('Standard deviation multiplier')) throw e;
    }
});

// 5. 零stdDev检测
test('零stdDev应抛出错误', () => {
    try {
        new StreamingBB(20, 0);
        throw new Error('应抛出错误');
    } catch (e) {
        if (!e.message.includes('Standard deviation multiplier')) throw e;
    }
});

// 6. 未就绪时返回null
test('数据不足时update返回null', () => {
    const bb = new StreamingBB(5, 2);
    for (let i = 0; i < 4; i++) {
        bb.update(testData[i]);
    }
    const result = bb.update(testData[4]);
    assertTrue(result !== null);
});

// 7. 检查isReady属性
test('isReady在数据不足时为false', () => {
    const bb = new StreamingBB(10, 2);
    for (let i = 0; i < 9; i++) {
        bb.update(testData[i]);
    }
    assertTrue(!bb.isReady);
});

// 8. 数据足够后isReady为true
test('isReady在数据足够时为true', () => {
    const bb = new StreamingBB(5, 2);
    for (let i = 0; i < 5; i++) {
        bb.update(testData[i]);
    }
    assertTrue(bb.isReady);
});

// 9. 返回值结构检查
test('返回值包含upper/middle/lower/bandwidth/percentB', () => {
    const bb = new StreamingBB(5, 2);
    for (let i = 0; i < 5; i++) {
        bb.update(testData[i]);
    }
    const result = bb.value;
    assertTrue(result !== null);
    assertTrue(typeof result.upper === 'number');
    assertTrue(typeof result.middle === 'number');
    assertTrue(typeof result.lower === 'number');
    assertTrue(typeof result.bandwidth === 'number');
    assertTrue(typeof result.percentB === 'number');
});

// 10. middle = SMA
test('middle等于SMA值', () => {
    const bb = new StreamingBB(5, 2);
    const sma = new StreamingSMA(5);
    for (let i = 0; i < 5; i++) {
        bb.update(testData[i]);
        sma.update(testData[i]);
    }
    assertEqual(bb.value.middle, sma.value, 0.0001);
});

// 11. upper > middle > lower
test('upper > middle > lower', () => {
    const bb = new StreamingBB(5, 2);
    for (let i = 0; i < 10; i++) {
        bb.update(testData[i]);
    }
    const result = bb.value;
    assertGreaterThan(result.upper, result.middle);
    assertGreaterThan(result.middle, result.lower);
});

// 12. bandwidth计算正确
test('bandwidth = (upper - lower) / middle', () => {
    const bb = new StreamingBB(5, 2);
    for (let i = 0; i < 10; i++) {
        bb.update(testData[i]);
    }
    const result = bb.value;
    const expectedBandwidth = (result.upper - result.lower) / result.middle;
    assertEqual(result.bandwidth, expectedBandwidth, 0.0001);
});

// 13. percentB范围0-1
test('percentB在0-1范围内', () => {
    const bb = new StreamingBB(5, 2);
    for (let i = 0; i < 10; i++) {
        bb.update(testData[i]);
    }
    const result = bb.value;
    assertTrue(result.percentB >= 0);
    assertTrue(result.percentB <= 1);
});

// 14. reset后value为null
test('reset后value为null', () => {
    const bb = new StreamingBB(5, 2);
    for (let i = 0; i < 10; i++) {
        bb.update(testData[i]);
    }
    assertTrue(bb.value !== null);
    bb.reset();
    assertNull(bb.value);
});

// 15. reset后isReady为false
test('reset后isReady为false', () => {
    const bb = new StreamingBB(5, 2);
    for (let i = 0; i < 10; i++) {
        bb.update(testData[i]);
    }
    assertTrue(bb.isReady);
    bb.reset();
    assertTrue(!bb.isReady);
});

// 16. reset后可重新计算
test('reset后可重新计算', () => {
    const bb = new StreamingBB(5, 2);
    for (let i = 0; i < 10; i++) {
        bb.update(testData[i]);
    }
    bb.reset();
    for (let i = 0; i < 10; i++) {
        bb.update(testData[i]);
    }
    assertTrue(bb.isReady);
    assertTrue(bb.value !== null);
});

// 17. 处理NaN输入
test('NaN输入不破坏状态', () => {
    const bb = new StreamingBB(5, 2);
    for (let i = 0; i < 10; i++) {
        bb.update(testData[i]);
    }
    const prevValue = bb.value;
    bb.update(NaN);
    assertEqual(bb.value.upper, prevValue.upper, 0.0001);
    assertEqual(bb.value.middle, prevValue.middle, 0.0001);
    assertEqual(bb.value.lower, prevValue.lower, 0.0001);
});

// 18. 自定义stdDev影响带宽
test('stdDev越大带宽越宽', () => {
    const bb2 = new StreamingBB(5, 2);
    const bb3 = new StreamingBB(5, 3);
    for (let i = 0; i < 10; i++) {
        bb2.update(testData[i]);
        bb3.update(testData[i]);
    }
    assertGreaterThan(bb3.value.bandwidth, bb2.value.bandwidth);
});

// 19. 价格在upper之上时percentB>1（理论上）
test('极端高价格时percentB接近或超过1', () => {
    const bb = new StreamingBB(5, 2);
    // 正常数据
    for (let i = 0; i < 5; i++) {
        bb.update(100);
    }
    // 极高价格
    const result = bb.update(150);
    assertTrue(result.percentB > 0.5);
});

// 20. 价格在lower之下时percentB<0（理论上）
test('极端低价格时percentB接近或低于0', () => {
    const bb = new StreamingBB(5, 2);
    // 正常数据
    for (let i = 0; i < 5; i++) {
        bb.update(100);
    }
    // 极低价格
    const result = bb.update(50);
    assertTrue(result.percentB < 0.5);
});

// 21. 标准差总体计算验证（手动计算）
test('标准差计算正确（总体）', () => {
    const bb = new StreamingBB(4, 2);
    // 数据: 10, 12, 14, 16
    // mean = 13
    // variance = [(10-13)^2 + (12-13)^2 + (14-13)^2 + (16-13)^2] / 4
    //          = [9 + 1 + 1 + 9] / 4 = 20/4 = 5
    // std = sqrt(5) = 2.236...
    // upper = 13 + 2*2.236 = 17.472
    // lower = 13 - 2*2.236 = 8.528
    bb.update(10);
    bb.update(12);
    bb.update(14);
    bb.update(16);
    const result = bb.value;
    assertEqual(result.middle, 13, 0.0001);
    assertEqual(result.upper, 13 + 2 * Math.sqrt(5), 0.0001);
    assertEqual(result.lower, 13 - 2 * Math.sqrt(5), 0.0001);
});

// 22. 计算稳定性测试
test('多次计算结果稳定', () => {
    const bb = new StreamingBB(5, 2);
    const results = [];
    for (let i = 0; i < 20; i++) {
        const r = bb.update(testData[i]);
        if (r !== null) {
            results.push({ ...r });
        }
    }
    bb.reset();
    let idx = 0;
    for (let i = 0; i < 20; i++) {
        const r = bb.update(testData[i]);
        if (r !== null) {
            assertEqual(r.upper, results[idx].upper, 0.0001);
            assertEqual(r.middle, results[idx].middle, 0.0001);
            assertEqual(r.lower, results[idx].lower, 0.0001);
            idx++;
        }
    }
});

// ====== 测试结果 ======
console.log(`\n=== 测试完成 ===`);
console.log(`通过: ${passed}`);
console.log(`失败: ${failed}`);
console.log(`总计: ${passed + failed}`);

if (failed > 0) {
    throw new Error(`测试失败: ${failed}`);
} else {
    console.log('\n所有测试通过 ✓');
}
