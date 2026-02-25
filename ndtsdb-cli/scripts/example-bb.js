/**
 * StreamingBB 示例
 *
 * 读取 ndts 数据，计算布林带(20,2)，输出结果
 *
 * 用法:
 *   ./ndtsdb-cli scripts/example-bb.js --database ./data/btc
 */

import * as ndtsdb from 'ndtsdb';
import { StreamingBB } from 'stdlib/indicators.js';

// 解析命令行参数
function parseArgs() {
    const args = {};
    for (let i = 0; i < scriptArgs.length; i++) {
        if (scriptArgs[i] === '--database' || scriptArgs[i] === '-d') {
            args.database = scriptArgs[i + 1];
        }
        if (scriptArgs[i] === '--symbol') {
            args.symbol = scriptArgs[i + 1];
        }
        if (scriptArgs[i] === '--period') {
            args.period = parseInt(scriptArgs[i + 1]);
        }
        if (scriptArgs[i] === '--stddev') {
            args.stdDev = parseFloat(scriptArgs[i + 1]);
        }
    }
    return args;
}

const args = parseArgs();
const dbPath = args.database || './data/example.ndts';
const symbol = args.symbol || 'BTCUSDT';
const period = args.period || 20;
const stdDev = args.stdDev || 2;

console.log('=== StreamingBB (布林带) 示例 ===\n');
console.log(`配置: database=${dbPath}, symbol=${symbol}`);
console.log(`BB参数: period=${period}, stdDev=${stdDev}\n`);

// 打开数据库
const db = ndtsdb.open(dbPath + '/');

// 查询数据
console.log(`查询 ${symbol} 数据...`);
const data = ndtsdb.queryFiltered(db, [symbol]);
console.log(`✅ 获取 ${data.length} 条K线数据\n`);

if (data.length === 0) {
    console.log('⚠️  无数据，请先写入数据');
    ndtsdb.close(db);
    exit(0);
}

// 按时间排序（旧->新）
data.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));

// 创建BB指标
const bb = new StreamingBB(period, stdDev);

console.log('计算 布林带...');
console.log('-'.repeat(90));
console.log(`${'Index'.padEnd(8)} ${'Close'.padEnd(12)} ${'Upper'.padEnd(12)} ${'Middle'.padEnd(12)} ${'Lower'.padEnd(12)} ${'%B'.padEnd(10)} Status`);
console.log('-'.repeat(90));

let readyCount = 0;
const results = [];

// 流式计算BB
for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const result = bb.update(row.close);

    if (result !== null) {
        readyCount++;
        results.push({
            index: i,
            close: row.close,
            upper: result.upper,
            middle: result.middle,
            lower: result.lower,
            bandwidth: result.bandwidth,
            percentB: result.percentB,
            timestamp: row.timestamp
        });
    }

    // 只打印前3条和最后3条
    const shouldPrint = i < 3 || i >= data.length - 3 || (result !== null && readyCount <= 3);

    if (shouldPrint) {
        const close = String(row.close.toFixed(2)).padEnd(12);
        if (result !== null) {
            const upper = String(result.upper.toFixed(2)).padEnd(12);
            const middle = String(result.middle.toFixed(2)).padEnd(12);
            const lower = String(result.lower.toFixed(2)).padEnd(12);
            const pctB = String(result.percentB.toFixed(4)).padEnd(10);
            console.log(`${String(i).padEnd(8)} ${close} ${upper} ${middle} ${lower} ${pctB} ✓`);
        } else {
            console.log(`${String(i).padEnd(8)} ${close} ${'-'.padEnd(12)} ${'-'.padEnd(12)} ${'-'.padEnd(12)} ${'-'.padEnd(10)} ...`);
        }

        if (i === 3 && data.length > 10) {
            console.log('... (中间省略) ...');
        }
    }
}

console.log('-'.repeat(90));

// 分析结果
const lastResult = results[results.length - 1];
console.log(`\n结果统计:`);
console.log(`  总数据: ${data.length}`);
console.log(`  BB就绪: ${readyCount} 条 (需要 ${period} 个数据点)`);
console.log(`  未就绪: ${data.length - readyCount} 条`);

if (lastResult) {
    console.log(`\n最新值:`);
    console.log(`  Close: ${lastResult.close.toFixed(4)}`);
    console.log(`  Upper: ${lastResult.upper.toFixed(4)}`);
    console.log(`  Middle: ${lastResult.middle.toFixed(4)}`);
    console.log(`  Lower: ${lastResult.lower.toFixed(4)}`);
    console.log(`  Bandwidth: ${lastResult.bandwidth.toFixed(4)}`);
    console.log(`  %B: ${lastResult.percentB.toFixed(4)}`);

    // 分析
    console.log(`\n  分析:`);
    if (lastResult.percentB > 0.8) {
        console.log(`  ⚠️ 价格接近上轨（超买区域，%B=${lastResult.percentB.toFixed(2)}）`);
    } else if (lastResult.percentB < 0.2) {
        console.log(`  ⚠️ 价格接近下轨（超卖区域，%B=${lastResult.percentB.toFixed(2)}）`);
    } else {
        console.log(`  ✅ 价格在布林带中间区域（%B=${lastResult.percentB.toFixed(2)}）`);
    }

    if (lastResult.bandwidth > 0.1) {
        console.log(`  📊 带宽较宽（高波动率）`);
    } else {
        console.log(`  📊 带宽较窄（低波动率，可能即将突破）`);
    }
}

// 关闭数据库
ndtsdb.close(db);
console.log('\n=== 示例完成 ===');
