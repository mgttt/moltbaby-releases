// CLI写入样本数据（目录模式，用于文件格式对比）
import * as ndtsdb from 'ndtsdb';

const dataDir = process.env.NDTS_DATA_DIR || './data';
const handle = ndtsdb.open(`${dataDir}/`);

// 写入10条标准数据
const startTime = 1700000000000n;
for (let i = 0; i < 10; i++) {
  ndtsdb.insert(handle, 'SAMPLE', '1h', {
    timestamp: startTime + BigInt(i * 3600000),
    open: 100.0 + i * 0.1,
    high: 100.5 + i * 0.1,
    low: 99.5 + i * 0.1,
    close: 100.0 + i * 0.1,
    volume: 1000 + i * 10,
  });
}

ndtsdb.close(handle);
console.log('[CLI] 写入10条样本数据完成');
