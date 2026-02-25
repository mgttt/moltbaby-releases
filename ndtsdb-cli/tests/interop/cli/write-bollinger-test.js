// 写入大量样本数据用于bollinger测试
import * as ndtsdb from 'ndtsdb';

const dataDir = process.env.NDTS_DATA_DIR || './data';
const handle = ndtsdb.open(`${dataDir}/`);

const startTime = 1700000000000n;
const basePrice = 100.0;

// 写入50条数据，价格有波动
for (let i = 0; i < 50; i++) {
  // 模拟价格波动（正弦波 + 随机噪声）
  const noise = (Math.random() - 0.5) * 2.0;
  const trend = Math.sin(i * 0.3) * 5.0;
  const price = basePrice + trend + noise;
  
  const open = price + (Math.random() - 0.5) * 0.5;
  const close = price + (Math.random() - 0.5) * 0.5;
  const high = Math.max(open, close) + Math.random() * 0.5;
  const low = Math.min(open, close) - Math.random() * 0.5;
  
  ndtsdb.insert(handle, 'BTCUSDT', '1h', {
    timestamp: startTime + BigInt(i * 3600000),
    open: open,
    high: high,
    low: low,
    close: close,
    volume: 1000 + i * 10,
  });
}

ndtsdb.close(handle);
console.log('[CLI] 写入50条BTCUSDT样本数据完成');
