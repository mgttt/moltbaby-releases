// Bun读取验证脚本
import { createTable } from './common.ts';
import { PartitionedTable } from '../../../../ndtsdb/src/index.ts';

const dataDir = process.env.NDTS_DATA_DIR || './data';
const table = createTable(dataDir);

const startTime = 1700000000000n;
const endTime = startTime + 1000n * 3600000n;

const rows = table.query(
  (row) => row.symbol === 'ETHUSDT' && row.interval === '1h',
  { timeRange: { min: startTime, max: endTime } }
);

if (rows.length !== 1000) {
  console.error(`❌ 记录数不匹配: 期望1000，实际${rows.length}`);
  process.exit(1);
}

// 按timestamp排序（query返回的数据可能不是有序的）
rows.sort((a, b) => Number(a.timestamp - b.timestamp));

// 验证数据完整性
for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  const expectedTimestamp = startTime + BigInt(i * 3600000);

  if (row.timestamp !== expectedTimestamp) {
    console.error(`❌ timestamp不匹配: 期望${expectedTimestamp}，实际${row.timestamp}`);
    process.exit(1);
  }

  if (Math.abs(row.close - (3000.0 + i)) > 0.01) {
    console.error(`❌ close价格不匹配: 期望${3000.0 + i}，实际${row.close}`);
    process.exit(1);
  }
}

console.log('[Bun] 验证通过：1000条ETHUSDT数据完整且正确 ✅');
