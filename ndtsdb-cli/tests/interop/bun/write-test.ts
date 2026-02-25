// Bun写入测试脚本
import { createTable } from './common.ts';
import { PartitionedTable } from '../../../../ndtsdb/src/index.ts';

const dataDir = process.env.NDTS_DATA_DIR || './data';
const table = createTable(dataDir);

// 写入1000条测试数据
const startTime = 1700000000000n;
for (let i = 0; i < 1000; i++) {
  table.append([{
    symbol: 'ETHUSDT',
    interval: '1h',
    timestamp: startTime + BigInt(i * 3600000), // 每小时一条
    open: 3000.0 + i,
    high: 3010.0 + i,
    low: 2990.0 + i,
    close: 3000.0 + i,
    volume: 1000 + i,
  }]);
}

console.log('[Bun] 写入1000条ETHUSDT数据完成');
