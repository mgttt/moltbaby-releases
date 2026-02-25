/**
 * ndtsdb-cli 基础示例
 * 
 * 这个示例演示了 ndtsdb-cli 的基本用法：
 * 1. 打开数据库
 * 2. 插入数据
 * 3. 查询数据
 * 4. 关闭数据库
 */

import * as ndtsdb from 'ndtsdb';

console.log('=== ndtsdb-cli 基础示例 ===\n');

// 1. 打开数据库
console.log('步骤 1: 打开数据库');
const dbPath = './data/example.ndts';
const db = ndtsdb.open(dbPath);
console.log(`✅ 数据库已打开: ${dbPath}\n`);

// 2. 插入数据
console.log('步骤 2: 插入数据');
const testData = {
    symbol_id: 'BTC',
    timestamp: 1700000000000n,
    open: 100.0,
    high: 101.0,
    low: 99.0,
    close: 100.5,
    volume: 1000
};

db.insert(testData);
console.log('✅ 数据已插入');
console.log(`   symbol_id: ${testData.symbol_id}`);
console.log(`   timestamp: ${testData.timestamp}`);
console.log(`   close: ${testData.close}\n`);

// 3. 查询数据
console.log('步骤 3: 查询数据');
const queryResult = db.query({
    symbol_id: 'BTC',
    start: 1700000000000n,
    end: 1700086400000n
});

console.log(`✅ 查询完成，共 ${queryResult.length} 条数据`);
if (queryResult.length > 0) {
    const firstRow = queryResult[0];
    console.log(`   第一条数据:`);
    console.log(`     timestamp: ${firstRow.timestamp}`);
    console.log(`     close: ${firstRow.close}`);
    console.log(`     volume: ${firstRow.volume}\n`);
}

// 4. 关闭数据库
console.log('步骤 4: 关闭数据库');
db.close();
console.log('✅ 数据库已关闭\n');

console.log('=== 示例完成 ===');
