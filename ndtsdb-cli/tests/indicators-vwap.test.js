// tests/indicators-vwap.test.js - StreamingVWAP 指标测试
// 验收标准：≥10个用例

import { StreamingVWAP, calculateVWAP } from '../stdlib/indicators.js';

// 测试工具函数
function assert(condition, message) {
    if (!condition) {
        throw new Error(`Assertion failed: ${message}`);
    }
}

function assertClose(actual, expected, tolerance = 0.0001, message) {
    const diff = Math.abs(actual - expected);
    if (diff > tolerance) {
        throw new Error(`${message}: expected ${expected}, got ${actual}, diff ${diff}`);
    }
}

// 测试计数
let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`✅ ${name}`);
        passed++;
    } catch (e) {
        console.log(`❌ ${name}: ${e.message}`);
        failed++;
    }
}

console.log('=== StreamingVWAP 指标测试 ===\n');

// 测试1: 基础累积 VWAP
test('无 period - 基础累积 VWAP', () => {
    const vwap = new StreamingVWAP();
    vwap.update(100, 10);
    vwap.update(110, 20);
    // VWAP = (100*10 + 110*20) / (10+20) = 3200/30 = 106.67
    assertClose(vwap.value, 3200/30, 0.001, 'VWAP should be 106.67');
});

// 测试2: 无 period - 三次更新
test('无 period - 三次更新', () => {
    const vwap = new StreamingVWAP();
    vwap.update(100, 10);  // 1000 / 10 = 100
    vwap.update(110, 20);  // 3200 / 30 = 106.67
    vwap.update(120, 30);  // 6800 / 60 = 113.33
    assertClose(vwap.value, 6800/60, 0.001, 'VWAP should be 113.33');
});

// 测试3: 滑动窗口 VWAP (period=2)
test('滑动窗口 VWAP (period=2)', () => {
    const vwap = new StreamingVWAP(2);
    vwap.update(100, 10);  // 窗口: [100,10] -> VWAP=100
    vwap.update(110, 20);  // 窗口: [100,10], [110,20] -> VWAP=110
    vwap.update(120, 30);  // 窗口: [110,20], [120,30] -> VWAP=(2200+3600)/(20+30)=116
    assertClose(vwap.value, 116, 0.001, 'VWAP should be 116');
});

// 测试4: 滑动窗口 VWAP (period=3)
test('滑动窗口 VWAP (period=3)', () => {
    const vwap = new StreamingVWAP(3);
    vwap.update(100, 10);
    vwap.update(110, 20);
    vwap.update(120, 30);
    vwap.update(130, 40);  // 移除第一个点
    // 窗口: 110*20 + 120*30 + 130*40 = 2200+3600+5200=11000 / 90 = 122.22...
    assertClose(vwap.value, 11000/90, 0.001, 'VWAP should be 122.22...');
});

// 测试5: 初始值为 null
test('初始值为 null', () => {
    const vwap = new StreamingVWAP();
    assert(vwap.value === null, 'Initial value should be null');
    assert(vwap.isReady === false, 'Initial isReady should be false');
});

// 测试6: isReady 状态
test('isReady 状态', () => {
    const vwap = new StreamingVWAP();
    assert(vwap.isReady === false, 'isReady should be false initially');
    vwap.update(100, 10);
    assert(vwap.isReady === true, 'isReady should be true after first update');
});

// 测试7: reset 功能
test('reset 功能', () => {
    const vwap = new StreamingVWAP();
    vwap.update(100, 10);
    vwap.update(110, 20);
    vwap.reset();
    assert(vwap.value === null, 'Value should be null after reset');
    assert(vwap.isReady === false, 'isReady should be false after reset');
    assert(vwap.count === 0, 'Count should be 0 after reset');
});

// 测试8: 零成交量处理
test('零成交量处理', () => {
    const vwap = new StreamingVWAP();
    vwap.update(100, 0);  // 零成交量
    assert(vwap.value === null, 'VWAP should be null with zero volume');
    vwap.update(110, 10);
    assertClose(vwap.value, 110, 0.001, 'VWAP should be 110');
});

// 测试9: 无效输入处理
test('无效输入处理', () => {
    const vwap = new StreamingVWAP();
    vwap.update(100, 10);
    const prevValue = vwap.value;
    vwap.update(NaN, 10);  // 无效 close
    assert(vwap.value === prevValue, 'Value should not change with NaN close');
    vwap.update(110, NaN);  // 无效 volume
    assert(vwap.value === prevValue, 'Value should not change with NaN volume');
});

// 测试10: totalVolume 属性
test('totalVolume 属性', () => {
    const vwap = new StreamingVWAP();
    vwap.update(100, 10);
    vwap.update(110, 20);
    assert(vwap.totalVolume === 30, 'Total volume should be 30');
});

// 测试11: 批量计算 VWAP
test('批量计算 VWAP', () => {
    const data = [
        { close: 100, volume: 10 },
        { close: 110, volume: 20 },
        { close: 120, volume: 30 }
    ];
    const results = calculateVWAP(data);
    assert(results.length === 3, 'Should have 3 results');
    assertClose(results[0].value, 100, 0.001, 'First VWAP should be 100');
    assertClose(results[1].value, 3200/30, 0.001, 'Second VWAP should be 106.67');
    assertClose(results[2].value, 6800/60, 0.001, 'Third VWAP should be 113.33');
});

// 测试12: 批量计算滑动窗口 VWAP
test('批量计算滑动窗口 VWAP (period=2)', () => {
    const data = [
        { close: 100, volume: 10 },
        { close: 110, volume: 20 },
        { close: 120, volume: 30 }
    ];
    const results = calculateVWAP(data, 2);
    assert(results.length === 3, 'Should have 3 results');
    assertClose(results[0].value, 100, 0.001, 'First VWAP should be 100');
    assertClose(results[1].value, 3200/30, 0.001, 'Second VWAP should be 106.67');
    assertClose(results[2].value, 116, 0.001, 'Third VWAP should be 116');
});

// 测试结果
console.log('\n=== 测试结果 ===');
console.log(`通过: ${passed}`);
console.log(`失败: ${failed}`);
console.log('================');

if (failed > 0) {
    process.exit(1);
}
