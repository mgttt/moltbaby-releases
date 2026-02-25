// Bun写入大数据量
import { createTable } from './common.ts';
import { PartitionedTable } from '../../../../ndtsdb/src/index.ts';

const dataDir = process.env.NDTS_DATA_DIR || './data';
const table = createTable(dataDir);

const startTime = 1700000000000n;
const batchSize = 10000;
const totalBatches = 100; // 100万条数据

console.time('写入100万条数据');

for (let batch = 0; batch < totalBatches; batch++) {
  const rows = [];
  for (let i = 0; i < batchSize; i++) {
    const globalIndex = batch * batchSize + i;
    rows.push({
      symbol: 'LARGE',
      interval: '1h',
      timestamp: startTime + BigInt(globalIndex * 3600000),
      open: 100.0 + globalIndex * 0.001,
      high: 100.5 + globalIndex * 0.001,
      low: 99.5 + globalIndex * 0.001,
      close: 100.0 + globalIndex * 0.001,
      volume: 1000 + globalIndex,
    });
  }

  table.append(rows);

  if ((batch + 1) % 10 === 0) {
    console.log(`[Bun] 已写入 ${(batch + 1) * batchSize} 条数据`);
  }
}

console.timeEnd('写入100万条数据');
console.log('[Bun] 写入100万条数据完成');
