// CLI查询不存在的symbol
import * as ndtsdb from 'ndtsdb';

const dataDir = process.env.NDTS_DATA_DIR || './data';
const handle = ndtsdb.open(`${dataDir}/NONEXIST-1h.ndts`);

const rows = ndtsdb.query(handle, 'NONEXIST_SYMBOL', '1h', 0n, 9999999999999n);

if (rows.length !== 0) {
  console.error(`❌ 空查询应返回0条，实际返回${rows.length}条`);
  process.exit(1);
}

ndtsdb.close(handle);
console.log('[CLI] 空查询测试通过 ✅');
