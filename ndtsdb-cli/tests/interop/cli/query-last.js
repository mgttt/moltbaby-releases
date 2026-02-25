// CLI查询最后N条数据
import * as ndtsdb from 'ndtsdb';

const dataDir = process.env.NDTS_DATA_DIR || './data';
const handle = ndtsdb.open(`${dataDir}/LARGE-1h.ndts`);

// 查询最后1000条
const allRows = ndtsdb.query(handle, 'LARGE', '1h', 0n, 9999999999999n);

if (allRows.length === 0) {
  console.error('❌ 数据库为空');
  process.exit(1);
}

const last1000 = allRows.slice(-1000);
console.log(`[CLI] 查询成功：共${allRows.length}条，最后1000条时间范围: ${last1000[0].timestamp} - ${last1000[999].timestamp}`);

ndtsdb.close(handle);
