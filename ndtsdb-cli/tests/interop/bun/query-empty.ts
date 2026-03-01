// Bun查询空数据
import { createTable } from './common.ts';
import { PartitionedTable } from '../../../../ndtsdb-bun/src/index.ts';

const dataDir = process.env.NDTS_DATA_DIR || './data';
const table = createTable(dataDir);

const rows = table.query(
  (row) => row.symbol === 'NONEXIST_SYMBOL' && row.interval === '1h',
  { timeRange: { min: 0n, max: 9999999999999n } }
);

if (rows.length !== 0) {
  console.error(`❌ 空查询应返回0条，实际返回${rows.length}条`);
  process.exit(1);
}

console.log('[Bun] 空查询测试通过 ✅');
