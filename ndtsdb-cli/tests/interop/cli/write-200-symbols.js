// 测试MAX_SYMBOLS动态化 - 写入200个不同symbol
import * as ndtsdb from 'ndtsdb';

const dataDir = process.env.NDTS_DATA_DIR || './data';
const handle = ndtsdb.open(`${dataDir}/`);

const startTime = 1700000000000n;
const symbolCount = 200;  // 超过原MAX_SYMBOLS=100

console.log(`[CLI] 开始写入${symbolCount}个不同symbol各1条...`);

for (let i = 0; i < symbolCount; i++) {
  const symbol = `SYM${String(i).padStart(3, '0')}`;
  const result = ndtsdb.insert(handle, symbol, '1h', {
    timestamp: startTime + BigInt(i * 3600000),
    open: 50000.0 + i,
    high: 50100.0 + i,
    low: 49900.0 + i,
    close: 50000.0 + i,
    volume: 1000 + i,
  });
  
  if (result !== 0) {
    console.log(`[CLI] ❌ 写入失败 at ${symbol}: ${result}`);
    break;
  }
  
  if (i % 50 === 0) {
    console.log(`[CLI] 已写入 ${i} 个symbol...`);
  }
}

ndtsdb.close(handle);
console.log(`[CLI] ✅ 写入${symbolCount}个symbol完成！`);
