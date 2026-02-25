// CLI读取验证脚本（Phase 2验收）
import * as ndtsdb from 'ndtsdb';

const dataDir = process.env.NDTS_DATA_DIR || './data';
const handle = ndtsdb.open(dataDir);  // 目录模式

// 查询 ETHUSDT 1h 数据
const startTime = 1700000000000n;
const endTime = startTime + 1000n * 3600000n;

const rows = ndtsdb.query(handle, 'ETHUSDT', '1h', 
    Number(startTime),  // start
    Number(endTime),    // end
    10000               // limit
);

if (rows.length !== 1000) {
    console.error(`❌ 记录数不匹配: 期望1000，实际${rows.length}`);
    ndtsdb.close(handle);
    process.exit(1);
}

// 按 timestamp 排序（query返回的数据可能不是有序的）
rows.sort((a, b) => Number(a.timestamp - b.timestamp));

// 验证数据完整性
for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const expectedTimestamp = startTime + BigInt(i * 3600000);

    if (BigInt(row.timestamp) !== expectedTimestamp) {
        console.error(`❌ timestamp不匹配: 期望${expectedTimestamp}，实际${row.timestamp}`);
        ndtsdb.close(handle);
        process.exit(1);
    }

    if (Math.abs(row.close - (3000.0 + i)) > 0.01) {
        console.error(`❌ close价格不匹配: 期望${3000.0 + i}，实际${row.close}`);
        ndtsdb.close(handle);
        process.exit(1);
    }
}

ndtsdb.close(handle);
console.log('[CLI→读取] 验证通过：1000条数据完整且正确 ✅');
