/**
 * StreamingMACD 示例
 * 
 * 读取 ndts 数据，计算 MACD(12,26,9)，输出结果
 * 
 * 用法:
 *   ./ndtsdb-cli scripts/example-macd.js --database ./data/btc
 */

import * as ndtsdb from 'ndtsdb';
import { StreamingMACD } from 'stdlib/indicators.js';

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
        if (scriptArgs[i] === '--fast') {
            args.fast = parseInt(scriptArgs[i + 1]);
        }
        if (scriptArgs[i] === '--slow') {
            args.slow = parseInt(scriptArgs[i + 1]);
        }
        if (scriptArgs[i] === '--signal') {
            args.signal = parseInt(scriptArgs[i + 1]);
        }
    }
    return args;
}

const args = parseArgs();
const dbPath = args.database || './data/example.ndts';
const symbol = args.symbol || 'BTCUSDT';
const fast = args.fast || 12;
const slow = args.slow || 26;
const signal = args.signal || 9;

console.log('=== StreamingMACD 示例 ===\n');
console.log(`配置: database=${dbPath}, symbol=${symbol}`);
console.log(`MACD参数: fast=${fast}, slow=${slow}, signal=${signal}\n`);

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

// 创建MACD指标
const macd = new StreamingMACD(fast, slow, signal);

console.log('计算 MACD...');
console.log('-'.repeat(80));
console.log(`${'Index'.padEnd(8)} ${'Close'.padEnd(12)} ${'MACD'.padEnd(12)} ${'Signal'.padEnd(12)} ${'Histogram'.padEnd(12)} Status`);
console.log('-'.repeat(80));

let readyCount = 0;
const results = [];

// 流式计算MACD
for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const result = macd.update(row.close);
    
    if (result !== null) {
        readyCount++;
        results.push({
            index: i,
            close: row.close,
            macd: result.macd,
            signal: result.signal,
            histogram: result.histogram,
            timestamp: row.timestamp
        });
    }
    
    // 只打印前3条和最后3条
    const shouldPrint = i < 3 || i >= data.length - 3 || (result !== null && readyCount <= 3);
    
    if (shouldPrint) {
        const close = String(row.close.toFixed(2)).padEnd(12);
        if (result !== null) {
            const macdStr = String(result.macd.toFixed(4)).padEnd(12);
            const signalStr = String(result.signal.toFixed(4)).padEnd(12);
            const histStr = String(result.histogram.toFixed(4)).padEnd(12);
            console.log(`${String(i).padEnd(8)} ${close} ${macdStr} ${signalStr} ${histStr} ✓`);
        } else {
            console.log(`${String(i).padEnd(8)} ${close} ${'-'.padEnd(12)} ${'-'.padEnd(12)} ${'-'.padEnd(12)} ...`);
        }
        
        if (i === 3 && data.length > 10) {
            console.log('... (中间省略) ...');
        }
    }
}

console.log('-'.repeat(80));

// 分析结果
const lastResult = results[results.length - 1];
console.log(`\n结果统计:`);
console.log(`  总数据: ${data.length}`);
console.log(`  MACD就绪: ${readyCount} 条 (需要 ${slow + signal - 1} 个数据点)`);
console.log(`  未就绪: ${data.length - readyCount} 条`);

if (lastResult) {
    console.log(`\n最新值:`);
    console.log(`  Close: ${lastResult.close.toFixed(4)}`);
    console.log(`  MACD: ${lastResult.macd.toFixed(4)}`);
    console.log(`  Signal: ${lastResult.signal.toFixed(4)}`);
    console.log(`  Histogram: ${lastResult.histogram.toFixed(4)}`);
    
    const trend = lastResult.histogram > 0 ? '看涨' : '看跌';
    const crossover = lastResult.macd > lastResult.signal ? 'MACD > Signal (多头)' : 'MACD < Signal (空头)';
    console.log(`\n  趋势判断: ${trend}`);
    console.log(`  交叉状态: ${crossover}`);
}

// 关闭数据库
ndtsdb.close(db);
console.log('\n=== 示例完成 ===');
