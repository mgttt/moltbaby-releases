// 创建多symbol测试数据
import * as ndtsdb from 'ndtsdb';

const dataDir = process.env.NDTS_DATA_DIR || './data';
const handle = ndtsdb.open(`${dataDir}/`);

const startTime = 1700000000000n;

// 写入BTCUSDT
for (let i = 0; i < 5; i++) {
  ndtsdb.insert(handle, 'BTCUSDT', '1h', {
    timestamp: startTime + BigInt(i * 3600000),
    open: 50000.0 + i,
    high: 50100.0 + i,
    low: 49900.0 + i,
    close: 50000.0 + i,
    volume: 1000 + i,
  });
}

// 写入ETHUSDT
for (let i = 0; i < 5; i++) {
  ndtsdb.insert(handle, 'ETHUSDT', '1h', {
    timestamp: startTime + BigInt(i * 3600000),
    open: 3000.0 + i,
    high: 3100.0 + i,
    low: 2900.0 + i,
    close: 3000.0 + i,
    volume: 500 + i,
  });
}

// 写入SOLUSDT
for (let i = 0; i < 5; i++) {
  ndtsdb.insert(handle, 'SOLUSDT', '1h', {
    timestamp: startTime + BigInt(i * 3600000),
    open: 100.0 + i,
    high: 110.0 + i,
    low: 90.0 + i,
    close: 100.0 + i,
    volume: 100 + i,
  });
}

ndtsdb.close(handle);
console.log('[CLI] ✅ 多symbol测试数据创建完成');
