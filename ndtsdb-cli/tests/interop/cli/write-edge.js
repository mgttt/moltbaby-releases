// CLI写入边界值（目录模式）
import * as ndtsdb from 'ndtsdb';

const dataDir = process.env.NDTS_DATA_DIR || './data';
const handle = ndtsdb.open(`${dataDir}/`);

// 极值测试
const edgeCases = [
  // 最小timestamp
  { timestamp: 0n, open: 0.01, high: 0.01, low: 0.01, close: 0.01, volume: 0 },
  // 最大timestamp (2262年)
  { timestamp: 9999999999000n, open: 0.01, high: 0.01, low: 0.01, close: 0.01, volume: 0 },
  // 极小价格
  { timestamp: 1700000000000n, open: 0.00000001, high: 0.00000002, low: 0.00000001, close: 0.00000001, volume: 1000000 },
  // 极大价格
  { timestamp: 1700000036000n, open: 999999.99, high: 1000000.00, low: 999999.99, close: 1000000.00, volume: 1 },
  // 极大交易量
  { timestamp: 1700000072000n, open: 100.0, high: 101.0, low: 99.0, close: 100.0, volume: 999999999999 },
];

for (const row of edgeCases) {
  ndtsdb.insert(handle, 'EDGE', '1h', row);
}

ndtsdb.close(handle);
console.log(`[CLI] 写入${edgeCases.length}个边界值完成`);
