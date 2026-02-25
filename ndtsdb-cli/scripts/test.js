// scripts/test.js - ndtsdb-cli 功能测试
// 验证: open → insert 100条 → query → 结果正确 → close

import * as ndtsdb from 'ndtsdb';

const TEST_DB = '/tmp/test.ndts';
const SYMBOL = 'BTCUSDT';
const INTERVAL = '1m';

function log(msg, ...args) {
    console.log(`[TEST] ${msg}`, ...args);
}

function assert(cond, message) {
    if (!cond) {
        throw new Error(`ASSERTION FAILED: ${message}`);
    }
}

// 生成测试数据
function generateTestData(count, startTime) {
    const rows = [];
    for (let i = 0; i < count; i++) {
        const basePrice = 50000 + Math.sin(i * 0.1) * 1000;
        rows.push({
            timestamp: startTime + i * 60000,  // 每分钟一条
            open: basePrice,
            high: basePrice + Math.random() * 100,
            low: basePrice - Math.random() * 100,
            close: basePrice + (Math.random() - 0.5) * 50,
            volume: Math.random() * 10
        });
    }
    return rows;
}

// 主测试函数
function runTest() {
    log('=== ndtsdb-cli Test Suite ===\n');

    // 1. 打开数据库
    log('Step 1: Opening database...');
    const db = ndtsdb.open(TEST_DB);
    log(`  Database opened, handle: ${db}`);
    assert(db > 0, 'Database handle should be positive');

    // 2. 批量插入 100 条
    log('\nStep 2: Generating and inserting 100 rows...');
    const startTime = 1700000000000;  // 2023-11-14 22:13:20 UTC
    const rows = generateTestData(100, startTime);
    
    const insertCount = ndtsdb.insertBatch(db, SYMBOL, INTERVAL, rows);
    log(`  Inserted ${insertCount} rows`);
    assert(insertCount === 100, `Should insert 100 rows, got ${insertCount}`);

    // 3. 单条插入测试
    log('\nStep 3: Testing single insert...');
    const singleRow = {
        timestamp: startTime + 100 * 60000,
        open: 51000,
        high: 51100,
        low: 50900,
        close: 51050,
        volume: 5.5
    };
    const singleResult = ndtsdb.insert(db, SYMBOL, INTERVAL, singleRow);
    log(`  Single insert result: ${singleResult}`);
    assert(singleResult === 0, 'Single insert should return 0');

    // 4. 查询验证
    log('\nStep 4: Querying data...');
    const queryStart = startTime;
    const queryEnd = startTime + 50 * 60000;  // 前50条
    const queryLimit = 100;
    
    const results = ndtsdb.query(db, SYMBOL, INTERVAL, queryStart, queryEnd, queryLimit);
    log(`  Query returned ${results.length} rows`);
    assert(results.length === 51, `Should return 51 rows (0-50), got ${results.length}`);
    
    // 验证第一条和最后一条
    const first = results[0];
    const last = results[results.length - 1];
    log(`  First row timestamp: ${first.timestamp} (expected ${startTime})`);
    log(`  Last row timestamp: ${last.timestamp} (expected ${startTime + 50 * 60000})`);
    assert(first.timestamp === startTime, 'First row timestamp mismatch');
    assert(last.timestamp === startTime + 50 * 60000, 'Last row timestamp mismatch');

    // 5. 验证数据结构
    log('\nStep 5: Validating row structure...');
    const sample = results[10];
    assert(typeof sample.timestamp === 'number', 'timestamp should be number');
    assert(typeof sample.open === 'number', 'open should be number');
    assert(typeof sample.high === 'number', 'high should be number');
    assert(typeof sample.low === 'number', 'low should be number');
    assert(typeof sample.close === 'number', 'close should be number');
    assert(typeof sample.volume === 'number', 'volume should be number');
    log('  Row structure validation passed');

    // 6. 获取最新时间戳
    log('\nStep 6: Getting latest timestamp...');
    const latestTs = ndtsdb.getLatestTimestamp(db, SYMBOL, INTERVAL);
    log(`  Latest timestamp: ${latestTs}`);
    assert(latestTs === startTime + 100 * 60000, 'Latest timestamp mismatch');

    // 7. 全范围查询
    log('\nStep 7: Full range query...');
    const allResults = ndtsdb.query(
        db, SYMBOL, INTERVAL, 
        startTime, 
        startTime + 200 * 60000,
        200
    );
    log(`  Full query returned ${allResults.length} rows (expected 101)`);
    assert(allResults.length === 101, 'Should have 101 total rows');

    // 8. 关闭数据库
    log('\nStep 8: Closing database...');
    ndtsdb.close(db);
    log('  Database closed successfully');

    log('\n=== All Tests Passed! ===');
    return true;
}

// 运行测试
try {
    runTest();
    // 清理测试文件
    if (typeof __removeFile === 'function') {
        __removeFile(TEST_DB);
    }
} catch (error) {
    console.error('[TEST FAILED]', error.message);
    // 打印堆栈（如果有）
    if (error.stack) {
        console.error(error.stack);
    }
    // 返回非零退出码
    if (typeof std !== 'undefined') {
        std.exit(1);
    } else {
        throw error;
    }
}
