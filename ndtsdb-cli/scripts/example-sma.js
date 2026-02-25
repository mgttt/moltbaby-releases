/**
 * StreamingSMA 示例
 * 
 * 读取 ndts 数据，计算 SMA20，输出结果
 * 
 * 用法:
 *   ./ndtsdb-cli scripts/example-sma.js --database ./data/btc
 */

import * as ndtsdb from 'ndtsdb';
import { StreamingSMA } from 'stdlib/indicators.js';

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
    }
    return args;
}

const args = parseArgs();
const dbPath = args.database || './data/example.ndts';
const symbol = args.symbol || 'BTCUSDT';
const period = args.period || 20;

console.log('=== StreamingSMA 示例 ===\n');
console.log(`配置: database=${dbPath}, symbol=${symbol}, period=${period}\n`);

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

// 创建SMA指标
const sma = new StreamingSMA(period);

console.log('计算 SMA...');
console.log('-'.repeat(70));
console.log(`${'Index'.padEnd(8)} ${'Timestamp'.padEnd(16)} ${'Close'.padEnd(12)} ${'SMA'.padEnd(12)} Status`);
console.log('-'.repeat(70));

let readyCount = 0;

// 流式计算SMA
for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const smaValue = sma.update(row.close);
    const isReady = sma.isReady;
    
    if (isReady) readyCount++;
    
    // 只打印前5条和最后5条（避免输出过多）
    const shouldPrint = i < 5 || i >= data.length - 5 || (isReady && i === period - 1);
    
    if (shouldPrint) {
        const ts = String(row.timestamp).padEnd(16);
        const close = String(row.close.toFixed(2)).padEnd(12);
        const smaStr = smaValue !== null ? smaValue.toFixed(2).padEnd(12) : '-'.padEnd(12);
        const status = isReady ? '✓' : '...';
        console.log(`${String(i).padEnd(8)} ${ts} ${close} ${smaStr} ${status}`);
        
        if (i === 5 && data.length > 10) {
            console.log('... (中间省略) ...');
        }
    }
}

console.log('-'.repeat(70));
console.log(`\n结果统计:`);
console.log(`  总数据: ${data.length}`);
console.log(`  SMA就绪: ${readyCount} 条 (period=${period})`);
console.log(`  当前SMA值: ${sma.value !== null ? sma.value.toFixed(4) : 'N/A'}`);

// 关闭数据库
ndtsdb.close(db);
console.log('\n=== 示例完成 ===');
