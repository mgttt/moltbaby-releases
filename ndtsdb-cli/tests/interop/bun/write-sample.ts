// Bun写入样本数据（用于文件格式对比）
import { createTable } from './common.ts';
import { PartitionedTable } from '../../../../ndtsdb-bun/src/index.ts';

const dataDir = process.env.NDTS_DATA_DIR || './data';
const table = createTable(dataDir);

// 写入10条标准数据
const startTime = 1700000000000n;
for (let i = 0; i < 10; i++) {
  table.append([{
    symbol: 'SAMPLE',
    interval: '1h',
    timestamp: startTime + BigInt(i * 3600000),
    open: 100.0 + i * 0.1,
    high: 100.5 + i * 0.1,
    low: 99.5 + i * 0.1,
    close: 100.0 + i * 0.1,
    volume: 1000 + i * 10,
  }]);
}

console.log('[Bun] 写入10条样本数据完成');
