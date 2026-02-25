// CLI循环读取（并发测试）
import * as ndtsdb from 'ndtsdb';

const dataDir = process.env.NDTS_DATA_DIR || './data';
const handle = ndtsdb.open(`${dataDir}/SHARED-1h.ndts`);

let readCount = 0;
const maxReads = 100; // 最多读取100次

const interval = setInterval(() => {
  try {
    const rows = ndtsdb.query(handle, 'SHARED', '1h', 0n, 9999999999999n);

    readCount++;
    console.log(`[CLI] 第${readCount}次读取: ${rows.length}条数据`);

    if (readCount >= maxReads) {
      clearInterval(interval);
      ndtsdb.close(handle);
      console.log('[CLI] 并发读取测试完成');
    }
  } catch (e) {
    console.error(`[CLI] 读取错误: ${e.message}`);
    clearInterval(interval);
    ndtsdb.close(handle);
    process.exit(1);
  }
}, 100); // 每100ms读取一次
