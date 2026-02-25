// Bun追加数据脚本
import { createTable } from './common.ts';
import { PartitionedTable } from '../../../../ndtsdb/src/index.ts';

const dataDir = process.env.NDTS_DATA_DIR || './data';
const table = createTable(dataDir);

// 获取最后一条记录的timestamp
const allRows = table.query(
  (row) => row.symbol === 'SHARED' && row.interval === '1h',
  { timeRange: { min: 0n, max: 9999999999999n } }
);

// 按timestamp排序后取最大值
if (allRows.length > 0) {
  allRows.sort((a, b) => Number(a.timestamp - b.timestamp));
}
const lastTimestamp = allRows.length > 0 ? allRows[allRows.length - 1].timestamp : 1700000000000n;
const startTime = lastTimestamp + 3600000n; // 从下一个小时开始

// 追加100条数据
for (let i = 0; i < 100; i++) {
  table.append([{
    symbol: 'SHARED',
    interval: '1h',
    timestamp: startTime + BigInt(i * 3600000),
    open: 100.0 + i,
    high: 101.0 + i,
    low: 99.0 + i,
    close: 100.0 + i,
    volume: 1000 + i,
  }]);
}

console.log(`[Bun] 追加100条数据完成，从 ${startTime} 开始`);
