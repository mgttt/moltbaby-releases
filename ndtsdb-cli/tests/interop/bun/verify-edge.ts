// Bun验证边界值
import { createTable } from './common.ts';
import { PartitionedTable } from '../../../../ndtsdb-bun/src/index.ts';

const dataDir = process.env.NDTS_DATA_DIR || './data';
const table = createTable(dataDir);

const rows = table.query(
  (row) => row.symbol === 'EDGE' && row.interval === '1h',
  { timeRange: { min: 0n, max: 9999999999999n } }
);

if (rows.length !== 5) {
  console.error(`❌ 边界值记录数不匹配: 期望5，实际${rows.length}`);
  process.exit(1);
}

// 按timestamp排序（query返回顺序不保证）
rows.sort((a, b) => Number(a.timestamp - b.timestamp));

// 验证各个边界值（按timestamp升序排序后）
const tests = [
  { index: 0, expectedTimestamp: 0n, expectedClose: 0.01, desc: '最小timestamp' },
  { index: 1, expectedTimestamp: 1700000000000n, expectedClose: 0.00000001, desc: '极小价格' },
  { index: 2, expectedTimestamp: 1700000036000n, expectedClose: 1000000.00, desc: '极大价格' },
  { index: 3, expectedTimestamp: 1700000072000n, expectedClose: 100.0, desc: '极大交易量' },
  { index: 4, expectedTimestamp: 9999999999000n, expectedClose: 0.01, desc: '最大timestamp' },
];

for (const test of tests) {
  const row = rows[test.index];

  if (row.timestamp !== test.expectedTimestamp) {
    console.error(`❌ ${test.desc} timestamp不匹配: 期望${test.expectedTimestamp}，实际${row.timestamp}`);
    process.exit(1);
  }

  if (Math.abs(row.close - test.expectedClose) > 0.00000001) {
    console.error(`❌ ${test.desc} close价格不匹配: 期望${test.expectedClose}，实际${row.close}`);
    process.exit(1);
  }
}

console.log('[Bun] 边界值验证通过 ✅');
