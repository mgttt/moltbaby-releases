// CLI追加数据脚本
import * as ndtsdb from 'ndtsdb';

const dataDir = process.env.NDTS_DATA_DIR || './data';
const handle = ndtsdb.open(`${dataDir}/SHARED-1h.ndts`);

// 获取最后一条记录的timestamp
const allRows = ndtsdb.query(handle, 'SHARED', '1h', 0n, 9999999999999n);

const lastTimestamp = allRows.length > 0 ? allRows[allRows.length - 1].timestamp : 1700000000000n;
const startTime = lastTimestamp + 3600000n; // 从下一个小时开始

// 追加100条数据
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
console.log(`[CLI] 追加100条数据完成，从 ${startTime} 开始`);
