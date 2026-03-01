// Bun循环读取（并发测试）
import { createTable } from './common.ts';
import { PartitionedTable } from '../../../../ndtsdb-bun/src/index.ts';

const dataDir = process.env.NDTS_DATA_DIR || './data';
const table = createTable(dataDir);

let readCount = 0;
const maxReads = 100; // 最多读取100次

const interval = setInterval(() => {
  try {
    const rows = table.query(
      (row) => row.symbol === 'SHARED' && row.interval === '1h',
      { timeRange: { min: 0n, max: 9999999999999n } }
    );

    readCount++;
    console.log(`[Bun] 第${readCount}次读取: ${rows.length}条数据`);

    if (readCount >= maxReads) {
      clearInterval(interval);
      console.log('[Bun] 并发读取测试完成');
    }
  } catch (e) {
    console.error(`[Bun] 读取错误: ${(e as Error).message}`);
    clearInterval(interval);
    process.exit(1);
  }
}, 100); // 每100ms读取一次
