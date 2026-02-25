// CLI初始化数据（场景2第一步）
import * as ndtsdb from 'ndtsdb';

const dataDir = process.env.NDTS_DATA_DIR || './data';
const handle = ndtsdb.open(`${dataDir}/SHARED-1h.ndts`);

// 写入初始100条数据
const startTime = 1700000000000n;
for (let i = 0; i < 100; i++) {
  ndtsdb.insert(handle, 'SHARED', '1h', {
    timestamp: startTime + BigInt(i * 3600000),
    open: 100.0 + i,
    high: 101.0 + i,
    low: 99.0 + i,
    close: 100.0 + i,
    volume: 1000 + i,
  });
}

ndtsdb.close(handle);
console.log('[CLI] 初始化100条数据完成');
