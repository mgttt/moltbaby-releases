// 测试动态扩容 - 写入10500条（刚好超过原10000限制）
import * as ndtsdb from 'ndtsdb';

const dataDir = process.env.NDTS_DATA_DIR || './data';
const handle = ndtsdb.open(`${dataDir}/`);

const startTime = 1700000000000n;
const count = 10500;  // 刚好超过原10000限制

console.log(`[CLI] 开始写入${count}条数据...`);

for (let i = 0; i < count; i++) {
  const result = ndtsdb.insert(handle, 'TEST', '1m', {
    timestamp: startTime + BigInt(i * 60000),
    open: 50000.0 + i,
    high: 50100.0 + i,
    low: 49900.0 + i,
    close: 50000.0 + i,
    volume: 1000 + i,
  });
  
  if (result !== 0) {
    console.log(`[CLI] 写入失败 at ${i}: ${result}`);
    break;
  }
}

ndtsdb.close(handle);
console.log(`[CLI] ✅ 完成！`);
