// benchmark-rpc.js: RPC 性能基准测试

import { NdtsdbRpcClient } from './ndtsdb-rpc-client.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function benchmark(name, fn, iterations = 1000) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await fn(i);
  }
  const elapsed = performance.now() - start;
  const opsPerSec = (iterations / elapsed * 1000).toFixed(0);
  console.log(`${name}: ${elapsed.toFixed(2)}ms (${opsPerSec} ops/sec)`);
  return elapsed;
}

async function main() {
  console.log('RPC Performance Benchmark\n');
  console.log('===========================\n');
  
  const client = new NdtsdbRpcClient(join(__dirname, 'qjs-ndtsdb-rpc'));
  await client.start();
  
  const db = await client.open('/tmp/benchmark.ndts');
  const now = Date.now();
  
  // 1. 单条插入压测
  console.log('1. Single Insert (1000 ops):');
  await benchmark('   ', async (i) => {
    await client.insert(db, 'BTCUSDT', '1m', {
      timestamp: now + i * 60000,
      open: 50000,
      high: 50200,
      low: 49800,
      close: 50100,
      volume: 10
    });
  }, 1000);
  console.log();
  
  // 2. 查询压测
  console.log('2. Query (100 ops):');
  await benchmark('   ', async () => {
    await client.query(db, 'BTCUSDT', '1m', now, now + 3600000, 100);
  }, 100);
  console.log();
  
  // 3. 并发压测
  console.log('3. Concurrent Insert (10x100 parallel):');
  const start = performance.now();
  const batch = [];
  for (let b = 0; b < 10; b++) {
    batch.push((async () => {
      for (let i = 0; i < 100; i++) {
        await client.insert(db, 'ETHUSDT', '1m', {
          timestamp: now + b * 100000 + i * 60000,
          open: 3000,
          high: 3050,
          low: 2950,
          close: 3020,
          volume: 5
        });
      }
    })());
  }
  await Promise.all(batch);
  const elapsed = performance.now() - start;
  console.log(`   ${elapsed.toFixed(2)}ms (${(1000 / elapsed * 1000).toFixed(0)} ops/sec)\n`);
  
  // 统计
  const rows = await client.query(db, 'BTCUSDT', '1m', 0, now + 999999999, 10000);
  const ethRows = await client.query(db, 'ETHUSDT', '1m', 0, now + 999999999, 10000);
  console.log('4. Data verification:');
  console.log(`   BTCUSDT rows: ${rows.length}`);
  console.log(`   ETHUSDT rows: ${ethRows.length}`);
  console.log(`   Total: ${rows.length + ethRows.length}\n`);
  
  await client.close(db);
  await client.stop();
  
  console.log('✅ Benchmark complete');
}

main().catch(console.error);
