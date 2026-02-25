/**
 * StreamingMACD 单元测试
 * 测试用例数：≥15个
 * 
 * 运行：./ndtsdb-cli tests/indicators-macd.test.js
 */

// 内联引入指标实现（测试独立运行）
class StreamingEMA {
    constructor(period = 20) {
        if (period <= 0) throw new Error('Period must be positive');
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
    get value() { return this._value; }
    get isReady() { return this._initialized; }
    update(close) {
        if (typeof close !== 'number' || isNaN(close)) return this._value;
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
}

class StreamingMACD {
    constructor(fast = 12, slow = 26, signal = 9) {
        if (fast <= 0 || slow <= 0 || signal <= 0) throw new Error('Periods must be positive');
        if (fast >= slow) throw new Error('Fast period must be less than slow period');
        this.fastPeriod = fast;
        this.slowPeriod = slow;
        this.signalPeriod = signal;
        this.reset();
    }
    reset() {
        this._fastEMA = new StreamingEMA(this.fastPeriod);
        this._slowEMA = new StreamingEMA(this.slowPeriod);
        this._signalEMA = new StreamingEMA(this.signalPeriod);
        this._value = null;
    }
    get value() { return this._value; }
    get isReady() { return this._value !== null; }
    update(close) {
        if (typeof close !== 'number' || isNaN(close)) return this._value;
        this._fastEMA.update(close);
        const slowValue = this._slowEMA.update(close);
        if (slowValue === null) return null;
        const macdValue = this._fastEMA.value - this._slowEMA.value;
        const signalValue = this._signalEMA.update(macdValue);
        if (signalValue === null) return null;
        const histogram = macdValue - signalValue;
        this._value = { macd: macdValue, signal: signalValue, histogram: histogram };
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

// ====== 测试用例 ======
console.log('=== StreamingMACD 单元测试 ===\n');

// 构造测试数据：上升趋势，便于验证
const testData = [];
for (let i = 0; i < 50; i++) {
    testData.push(100 + i * 0.5);  // 100, 100.5, 101, ...
}

// 1. 构造函数参数验证
test('构造函数接受正整数参数', () => {
    const macd = new StreamingMACD(12, 26, 9);
    assertTrue(macd.fastPeriod === 12);
    assertTrue(macd.slowPeriod === 26);
    assertTrue(macd.signalPeriod === 9);
});

// 2. 默认值测试
test('默认参数为 (12, 26, 9)', () => {
    const macd = new StreamingMACD();
    assertTrue(macd.fastPeriod === 12);
    assertTrue(macd.slowPeriod === 26);
    assertTrue(macd.signalPeriod === 9);
});

// 3. 无效参数检测
test('fast >= slow 应抛出错误', () => {
    try {
        new StreamingMACD(26, 12, 9);
        throw new Error('应抛出错误');
    } catch (e) {
        if (!e.message.includes('Fast period must be less')) throw e;
    }
});

// 4. 负数参数检测
test('负数period应抛出错误', () => {
    try {
        new StreamingMACD(-12, 26, 9);
        throw new Error('应抛出错误');
    } catch (e) {
        if (!e.message.includes('Periods must be positive')) throw e;
    }
});

// 5. 未就绪时返回null
test('数据不足时update返回null', () => {
    const macd = new StreamingMACD(2, 4, 2);
    for (let i = 0; i < 4; i++) {
        macd.update(testData[i]);
    }
    // slow=4就绪，但signal=2需要额外1个macd值
    const result = macd.update(testData[4]);
    // 第5个数据应该刚好满足 slow+signal-1 = 4+2-1 = 5
    // 实际逻辑：slowEMA在4个数据后就绪，macd line开始计算
    // signalEMA在2个macd值后就绪，所以在第5个close后返回非null
    assertTrue(result !== null);
});

// 6. 检查isReady属性
test('isReady在数据不足时为false', () => {
    const macd = new StreamingMACD(12, 26, 9);
    for (let i = 0; i < 25; i++) {
        macd.update(testData[i]);
    }
    assertTrue(!macd.isReady);
});

// 7. 数据足够后isReady为true
test('isReady在数据足够时为true', () => {
    const macd = new StreamingMACD(12, 26, 9);
    for (let i = 0; i < 34; i++) {
        macd.update(testData[i]);
    }
    assertTrue(macd.isReady);
});

// 8. 返回值结构检查
test('返回值包含macd/signal/histogram', () => {
    const macd = new StreamingMACD(2, 4, 2);
    for (let i = 0; i < 6; i++) {
        macd.update(testData[i]);
    }
    const result = macd.value;
    assertTrue(result !== null);
    assertTrue(typeof result.macd === 'number');
    assertTrue(typeof result.signal === 'number');
    assertTrue(typeof result.histogram === 'number');
});

// 9. histogram计算验证
test('histogram = macd - signal', () => {
    const macd = new StreamingMACD(2, 4, 2);
    for (let i = 0; i < 10; i++) {
        macd.update(testData[i]);
    }
    const result = macd.value;
    assertEqual(result.histogram, result.macd - result.signal, 0.0001);
});

// 10. value属性与update返回值一致
test('value属性与update返回值一致', () => {
    const macd = new StreamingMACD(2, 4, 2);
    let lastResult = null;
    for (let i = 0; i < 10; i++) {
        lastResult = macd.update(testData[i]);
    }
    assertEqual(lastResult.macd, macd.value.macd, 0.0001);
    assertEqual(lastResult.signal, macd.value.signal, 0.0001);
    assertEqual(lastResult.histogram, macd.value.histogram, 0.0001);
});

// 11. reset后状态清空
test('reset后value为null', () => {
    const macd = new StreamingMACD(2, 4, 2);
    for (let i = 0; i < 10; i++) {
        macd.update(testData[i]);
    }
    assertTrue(macd.value !== null);
    macd.reset();
    assertNull(macd.value);
});

// 12. reset后isReady为false
test('reset后isReady为false', () => {
    const macd = new StreamingMACD(2, 4, 2);
    for (let i = 0; i < 10; i++) {
        macd.update(testData[i]);
    }
    assertTrue(macd.isReady);
    macd.reset();
    assertTrue(!macd.isReady);
});

// 13. reset后可重新计算
test('reset后可重新计算', () => {
    const macd = new StreamingMACD(2, 4, 2);
    for (let i = 0; i < 10; i++) {
        macd.update(testData[i]);
    }
    macd.reset();
    for (let i = 0; i < 10; i++) {
        macd.update(testData[i]);
    }
    assertTrue(macd.isReady);
    assertTrue(macd.value !== null);
});

// 14. 处理NaN输入
test('NaN输入不破坏状态', () => {
    const macd = new StreamingMACD(2, 4, 2);
    for (let i = 0; i < 6; i++) {
        macd.update(testData[i]);
    }
    const prevValue = macd.value;
    macd.update(NaN);
    assertEqual(macd.value.macd, prevValue.macd, 0.0001);
});

// 15. 自定义参数工作正常
test('自定义参数(5,10,3)工作正常', () => {
    const macd = new StreamingMACD(5, 10, 3);
    for (let i = 0; i < 15; i++) {
        macd.update(testData[i]);
    }
    assertTrue(macd.isReady);
    assertTrue(macd.value.macd !== undefined);
    assertTrue(macd.value.signal !== undefined);
    assertTrue(macd.value.histogram !== undefined);
});

// 16. MACD值范围合理性检查（上升趋势中fast > slow，macd应为正）
test('上升趋势中macd为正', () => {
    const macd = new StreamingMACD(2, 5, 3);
    // 使用明显的上升趋势数据
    const upTrend = [100, 102, 105, 110, 115, 120, 125, 130];
    for (let i = 0; i < upTrend.length; i++) {
        macd.update(upTrend[i]);
    }
    if (macd.isReady) {
        assertTrue(macd.value.macd > 0);
    }
});

// 17. 下降趋势中macd为负
test('下降趋势中macd为负', () => {
    const macd = new StreamingMACD(2, 5, 3);
    const downTrend = [130, 125, 120, 115, 110, 105, 100, 95];
    for (let i = 0; i < downTrend.length; i++) {
        macd.update(downTrend[i]);
    }
    if (macd.isReady) {
        assertTrue(macd.value.macd < 0);
    }
});

// 18. 计算稳定性测试（多次update结果一致）
test('多次计算结果稳定', () => {
    const macd = new StreamingMACD(3, 6, 3);
    const results = [];
    for (let i = 0; i < 20; i++) {
        const r = macd.update(testData[i]);
        if (r !== null) {
            results.push({ ...r });
        }
    }
    // 重新计算一遍，结果应该相同
    macd.reset();
    let idx = 0;
    for (let i = 0; i < 20; i++) {
        const r = macd.update(testData[i]);
        if (r !== null) {
            assertEqual(r.macd, results[idx].macd, 0.0001);
            assertEqual(r.signal, results[idx].signal, 0.0001);
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
