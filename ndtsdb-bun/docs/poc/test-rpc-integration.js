// test-rpc-integration.js: 验证 RPC 客户端可用性

import { NdtsdbRpcClient } from './ndtsdb-rpc-client.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('Testing ndtsdb RPC integration...\n');
  
  const client = new NdtsdbRpcClient(join(__dirname, 'qjs-ndtsdb-rpc'));
  
  try {
    // 1. 启动 RPC
    console.log('1. Starting RPC process...');
    await client.start();
    console.log('   ✅ RPC started\n');
    
    // 2. 打开数据库
    console.log('2. Opening database...');
    const db = await client.open('/tmp/test-integration.ndts');
    console.log(`   ✅ DB handle: ${db}\n`);
    
    // 3. 插入数据
    console.log('3. Inserting kline data...');
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await client.insert(db, 'BTCUSDT', '1m', {
        timestamp: now - (5 - i) * 60000,
        open: 50000 + i * 100,
        high: 50200 + i * 100,
        low: 49800 + i * 100,
        close: 50100 + i * 100,
        volume: 10 + i
      });
    }
    console.log('   ✅ Inserted 5 rows\n');
    
    // 4. 查询数据
    console.log('4. Querying data...');
    const rows = await client.query(db, 'BTCUSDT', '1m', now - 3600000, now + 3600000, 10);
    console.log(`   ✅ Retrieved ${rows.length} rows`);
    console.log('   Sample:', rows[0]);
    console.log();
    
    // 5. 关闭数据库
    console.log('5. Closing database...');
    await client.close(db);
    console.log('   ✅ DB closed\n');
    
    // 6. 停止 RPC
    console.log('6. Stopping RPC...');
    await client.stop();
    console.log('   ✅ RPC stopped\n');
    
    console.log('✅ All tests passed!');
    
  } catch (err) {
    console.error('❌ Test failed:', err.message);
    await client.stop().catch(() => {});
    process.exit(1);
  }
}

main();
