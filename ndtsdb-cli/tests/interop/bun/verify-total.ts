// Bun验证总数脚本
import { createTable } from './common.ts';
import { PartitionedTable } from '../../../../ndtsdb-bun/src/index.ts';

const dataDir = process.env.NDTS_DATA_DIR || './data';
const table = createTable(dataDir);

const rows = table.query(
  (row) => row.symbol === 'SHARED' && row.interval === '1h',
  { timeRange: { min: 0n, max: 9999999999999n } }
);

if (rows.length !== 300) {
  console.error(`❌ 总记录数不匹配: 期望300，实际${rows.length}`);
  process.exit(1);
}

// 按timestamp排序（query返回的数据可能不是有序的）
rows.sort((a, b) => Number(a.timestamp - b.timestamp));

// 验证timestamp严格递增
for (let i = 1; i < rows.length; i++) {
  if (rows[i].timestamp <= rows[i - 1].timestamp) {
    console.error(`❌ timestamp未严格递增: ${rows[i - 1].timestamp} >= ${rows[i].timestamp}`);
    process.exit(1);
  }
}

// 验证无重复记录
const timestamps = rows.map(r => r.timestamp);
const uniqueTimestamps = new Set(timestamps);
if (uniqueTimestamps.size !== timestamps.length) {
  console.error(`❌ 存在重复的timestamp`);
  process.exit(1);
}

console.log('[Bun] 验证通过：300条数据，timestamp严格递增，无重复 ✅');
