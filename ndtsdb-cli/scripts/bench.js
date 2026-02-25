// scripts/bench.js - ndtsdb-cli 性能基准测试
// 测量 insertBatch 和 query 的吞吐量

import * as ndtsdb from 'ndtsdb';

const TEST_DB = '/tmp/bench.ndts';
const SYMBOL = 'BTCUSDT';
const INTERVAL = '1m';
const BATCH_SIZE = 50000;  // 增加到50k减少测量误差
const ITERATIONS = 3;

function log(msg, ...args) {
    console.log(`[BENCH] ${msg}`, ...args);
}

// 格式化数字
function formatNum(n) {
    return n.toLocaleString('en-US');
}

// 生成测试数据
function generateBatch(count, startTime) {
    const rows = [];
    for (let i = 0; i < count; i++) {
        const basePrice = 50000 + Math.sin(i * 0.01) * 5000;
        rows.push({
            timestamp: startTime + i * 60000,
            open: basePrice,
            high: basePrice + Math.random() * 200,
            low: basePrice - Math.random() * 200,
            close: basePrice + (Math.random() - 0.5) * 100,
            volume: Math.random() * 100
        });
    }
    return rows;
}

// 测量单次写入
function benchmarkWrite(db, rows) {
    const start = Date.now();
    const result = ndtsdb.insertBatch(db, SYMBOL, INTERVAL, rows);
    const elapsed = Date.now() - start;
    return { elapsed, count: result };
}

// 测量单次查询（全量）
function benchmarkRead(db, startTime, count) {
    const endTime = startTime + (count - 1) * 60000;
    const start = Date.now();
    const results = ndtsdb.query(db, SYMBOL, INTERVAL, startTime, endTime, count);
    const elapsed = Date.now() - start;
    return { elapsed, count: results.length };
}

// 运行一轮基准测试
function runBenchmark(round) {
    log(`\n=== Round ${round}/${ITERATIONS} ===`);
    
    // 清理并打开新 db
    try {
        // 清理旧文件（如果存在）
        if (typeof __removeFile === 'function') {
            __removeFile(TEST_DB);
        }
    } catch (e) {}
    
    const db = ndtsdb.open(TEST_DB);
    const startTime = 1700000000000;
    const rows = generateBatch(BATCH_SIZE, startTime);
    
    // 写入测试
    const writeResult = benchmarkWrite(db, rows);
    log(`  Write: ${formatNum(writeResult.count)} rows in ${writeResult.elapsed}ms`);
    
    // 读取测试
    const readResult = benchmarkRead(db, startTime, BATCH_SIZE);
    log(`  Read:  ${formatNum(readResult.count)} rows in ${readResult.elapsed}ms`);
    
    ndtsdb.close(db);
    
    return {
        writeMs: writeResult.elapsed,
        writeRows: writeResult.count,
        readMs: readResult.elapsed,
        readRows: readResult.count
    };
}

// 主函数
function main() {
    log('=== ndtsdb-cli Performance Benchmark ===');
    log(`Batch size: ${formatNum(BATCH_SIZE)} rows`);
    log(`Iterations: ${ITERATIONS}\n`);
    
    const results = [];
    for (let i = 1; i <= ITERATIONS; i++) {
        results.push(runBenchmark(i));
    }
    
    // 计算平均值
    const avgWriteMs = Math.round(results.reduce((a, r) => a + r.writeMs, 0) / ITERATIONS);
    const avgReadMs = Math.round(results.reduce((a, r) => a + r.readMs, 0) / ITERATIONS);
    const avgWriteSpeed = Math.round((BATCH_SIZE / avgWriteMs) * 1000);
    const avgReadSpeed = Math.round((BATCH_SIZE / avgReadMs) * 1000);
    
    // 输出表格
    console.log('\n========================================');
    console.log('           BENCHMARK RESULTS           ');
    console.log('========================================');
    console.log('| Operation   |  Rows   | Time(ms) | Speed(rows/s) |');
    console.log('|-------------|---------|----------|---------------|');
    console.log(`| write batch | ${formatNum(BATCH_SIZE).padStart(7)} | ${avgWriteMs.toString().padStart(8)} | ${formatNum(avgWriteSpeed).padStart(13)} |`);
    console.log(`| read all    | ${formatNum(BATCH_SIZE).padStart(7)} | ${avgReadMs.toString().padStart(8)} | ${formatNum(avgReadSpeed).padStart(13)} |`);
    console.log('========================================');
    
    // 详细数据
    console.log('\n--- Raw Data ---');
    results.forEach((r, i) => {
        console.log(`Round ${i + 1}: write=${r.writeMs}ms, read=${r.readMs}ms`);
    });
    
    // 清理
    try {
        if (typeof __removeFile === 'function') {
            __removeFile(TEST_DB);
        }
    } catch (e) {}
    
    log('\nBenchmark completed.');
}

// 兼容性：如果 Date.now() 不存在，使用 performance.now() 或简化版
if (typeof Date.now === 'undefined') {
    Date.now = function() {
        if (typeof performance !== 'undefined' && performance.now) {
            return Math.floor(performance.now());
        }
        // 备用：使用微秒级时间（如果可用）
        if (typeof __getTimeMs === 'function') {
            return __getTimeMs();
        }
        return 0;
    };
}

main();
