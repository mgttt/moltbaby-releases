// 测试200个symbol性能 - 每个symbol 5条数据
import * as ndtsdb from 'ndtsdb';

const dataDir = process.env.NDTS_DATA_DIR || './data';
console.log('[CLI] 开始写入200个symbol（每个5条）...');

const handle = ndtsdb.open(`${dataDir}/`);
const startTime = 1700000000000n;
const symbolCount = 200;
const klinesPerSymbol = 5;

for (let s = 0; s < symbolCount; s++) {
  const symbol = `SYM${String(s).padStart(3, '0')}`;
  for (let k = 0; k < klinesPerSymbol; k++) {
    ndtsdb.insert(handle, symbol, '1h', {
      timestamp: startTime + BigInt(k * 3600000), // 每条间隔1小时，同一天
      open: 50000.0 + s + k,
      high: 50100.0 + s + k,
      low: 49900.0 + s + k,
      close: 50000.0 + s + k,
      volume: 1000 + s + k,
    });
  }
  
  if (s % 50 === 0) {
    console.log(`[CLI] 已写入 ${s} 个symbol...`);
  }
}

console.log('[CLI] 调用close...');
const startClose = Date.now();
ndtsdb.close(handle);
const closeTime = Date.now() - startClose;
console.log(`[CLI] ✅ 写入完成！close耗时: ${closeTime}ms`);
