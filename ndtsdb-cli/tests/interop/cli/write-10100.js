// 测试动态扩容 - 写入10100条
import * as ndtsdb from 'ndtsdb';

const dataDir = process.env.NDTS_DATA_DIR || './data';
const handle = ndtsdb.open(`${dataDir}/`);

const startTime = 1700000000000n;
const count = 10100;

console.log(`[CLI] 开始写入${count}条数据...`);

for (let i = 0; i < count; i++) {
  ndtsdb.insert(handle, 'TEST', '1m', {
    timestamp: startTime + BigInt(i * 60000),
    open: 50000.0 + i,
    high: 50100.0 + i,
    low: 49900.0 + i,
    close: 50000.0 + i,
    volume: 1000 + i,
  });
}

ndtsdb.close(handle);
console.log(`[CLI] ✅ 写入${count}条数据完成！`);
