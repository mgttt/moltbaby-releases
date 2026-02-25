// 测试动态扩容 - 写入15000条（超过原10000限制）
import * as ndtsdb from 'ndtsdb';

const dataDir = process.env.NDTS_DATA_DIR || './data';
console.log(`[CLI] 打开目录: ${dataDir}/`);

const handle = ndtsdb.open(`${dataDir}/`);
console.log(`[CLI] handle: ${handle}`);

const startTime = 1700000000000n;  // 2023-11-14
const count = 15000;

console.log(`[CLI] 开始写入${count}条数据...`);

for (let i = 0; i < count; i++) {
  const result = ndtsdb.insert(handle, 'STRESS', '1m', {
    timestamp: startTime + BigInt(i * 60000),
    open: 50000.0 + i * 0.1,
    high: 50001.0 + i * 0.1,
    low: 49999.0 + i * 0.1,
    close: 50000.0 + i * 0.1,
    volume: 1000 + i,
  });
  
  if (result !== 0) {
    console.log(`[CLI] 写入失败 at ${i}: ${result}`);
    break;
  }
}

console.log(`[CLI] 调用close...`);
ndtsdb.close(handle);
console.log(`[CLI] ✅ 写入${count}条数据完成！`);
