// CLI读取验证脚本（BTCUSDT，用于场景1a内部一致性测试）
import * as ndtsdb from 'ndtsdb';

const dataDir = process.env.NDTS_DATA_DIR || './data';
const handle = ndtsdb.open(dataDir);

const startTime = 1700000000000n;
const endTime = startTime + 1000n * 3600000n;

const rows = ndtsdb.query(handle, 'BTCUSDT', '1h', Number(startTime), Number(endTime), 10000);

if (rows.length !== 1000) {
  console.error('❌ 记录数不匹配: 期望1000，实际' + rows.length);
  ndtsdb.close(handle);
  process.exit(1);
} else {
  console.log('[verify-btcusdt] ✅ PASS: 1000条BTCUSDT');
  ndtsdb.close(handle);
}
