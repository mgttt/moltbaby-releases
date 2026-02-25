// CLI写入测试脚本（目录模式，兼容Bun PartitionedTable）
import * as ndtsdb from 'ndtsdb';

// 从环境变量读取（main.c已注入process.env）
const dataDir = process.env.NDTS_DATA_DIR || './data';
const openPath = `${dataDir}/`;

console.log('[CLI] 打开目录:', openPath);
const handle = ndtsdb.open(openPath);
console.log('[CLI] handle:', handle);

// 写入1000条测试数据
const startTime = 1700000000000n;
console.log('[CLI] 开始写入1000条数据...');

for (let i = 0; i < 1000; i++) {
  ndtsdb.insert(handle, 'BTCUSDT', '1h', {
    timestamp: startTime + BigInt(i * 3600000), // 每小时一条
    open: 50000.0 + i,
    high: 50100.0 + i,
    low: 49900.0 + i,
    close: 50000.0 + i,
    volume: 1000 + i,
  });
  if (i % 100 === 0) {
    console.log(`[CLI] 已写入 ${i} 条...`);
  }
}

console.log('[CLI] 调用close...');
ndtsdb.close(handle);
console.log('[CLI] 写入1000条BTCUSDT数据完成（目录模式）');
