// 创建有问题的测试数据（乱序、重复、OHLCV错误）
import * as ndtsdb from 'ndtsdb';

const dataDir = process.env.NDTS_DATA_DIR || './data';
const handle = ndtsdb.open(`${dataDir}/`);

// 写入有问题的数据
const startTime = 1700000000000n;

// 1. 正常数据
ndtsdb.insert(handle, 'BAD', '1h', {
  timestamp: startTime,
  open: 100.0, high: 100.5, low: 99.5, close: 100.0, volume: 1000,
});

// 2. 乱序数据（时间戳小于前一个）
ndtsdb.insert(handle, 'BAD', '1h', {
  timestamp: startTime - 3600000n,  // 前一个时间
  open: 101.0, high: 101.5, low: 100.5, close: 101.0, volume: 1100,
});

// 3. 重复时间戳
ndtsdb.insert(handle, 'BAD', '1h', {
  timestamp: startTime,  // 重复
  open: 102.0, high: 102.5, low: 101.5, close: 102.0, volume: 1200,
});

// 4. OHLCV 逻辑错误：high < open
ndtsdb.insert(handle, 'BAD', '1h', {
  timestamp: startTime + 3600000n,
  open: 100.0, high: 99.0, low: 98.0, close: 99.0, volume: 1300,
});

// 5. 负数 volume
ndtsdb.insert(handle, 'BAD', '1h', {
  timestamp: startTime + 7200000n,
  open: 100.0, high: 101.0, low: 99.0, close: 100.0, volume: -100,
});

ndtsdb.close(handle);
console.log('[CLI] 写入问题数据完成');
