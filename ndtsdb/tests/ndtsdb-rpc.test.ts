import { describe, it, expect } from 'bun:test';
import { QjsNdtsdbRpcClient } from './qjs-rpc-client';

describe('qjs-ndtsdb-rpc', () => {
  it('open/insert/query/close round-trip', async () => {
    const client = new QjsNdtsdbRpcClient();

    const db = await client.open('/tmp/ndtsdb-rpc-test.ndts');
    const now = Date.now();

    const rows = [
      { symbol: 'BTCUSDT', interval: '1m', timestamp: now - 2, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
      { symbol: 'BTCUSDT', interval: '1m', timestamp: now - 1, open: 1.2, high: 2.2, low: 0.8, close: 1.8, volume: 12 },
      { symbol: 'BTCUSDT', interval: '1m', timestamp: now, open: 1.4, high: 2.5, low: 1.0, close: 2.1, volume: 15 },
    ];

    for (const row of rows) {
      await client.insert({ db, ...row });
    }

    const got = await client.query({
      db,
      symbol: 'BTCUSDT',
      interval: '1m',
      start: now - 10,
      end: now + 10,
      limit: 10,
    });

    expect(got).toHaveLength(3);
    expect(got[0]).toMatchObject({
      timestamp: rows[0].timestamp,
      open: rows[0].open,
      close: rows[0].close,
    });

    await client.close(db);
    await client.closeProcess();
  });

  it('handles concurrent insert + query', async () => {
    const client = new QjsNdtsdbRpcClient();
    const db = await client.open('/tmp/ndtsdb-rpc-test-concurrent.ndts');
    const now = Date.now();

    await Promise.all(
      Array.from({ length: 20 }, (_, idx) =>
        client.insert({
          db,
          symbol: 'ETHUSDT',
          interval: '1m',
          timestamp: now + idx,
          open: 100 + idx,
          high: 110 + idx,
          low: 90 + idx,
          close: 105 + idx,
          volume: 2 + idx,
        }),
      ),
    );

    const res = await client.query({
      db,
      symbol: 'ETHUSDT',
      interval: '1m',
      start: now,
      end: now + 100,
      limit: 100,
    });

    expect(res).toHaveLength(20);

    await client.close(db);
    await client.closeProcess();
  });

  it('close and reopen independent handlers', async () => {
    const client = new QjsNdtsdbRpcClient();

    const dbA = await client.open('/tmp/ndtsdb-rpc-multi-a.ndts');
    const dbB = await client.open('/tmp/ndtsdb-rpc-multi-b.ndts');

    await Promise.all([
      client.insert({ db: dbA, symbol: 'BTC', interval: '1m', timestamp: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }),
      client.insert({ db: dbB, symbol: 'ETH', interval: '1m', timestamp: 1, open: 2, high: 2, low: 2, close: 2, volume: 2 }),
    ]);

    const a = await client.query({ db: dbA, symbol: 'BTC', interval: '1m', start: 0, end: 10, limit: 10 });
    const b = await client.query({ db: dbB, symbol: 'ETH', interval: '1m', start: 0, end: 10, limit: 10 });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);

    await client.close(dbA);
    await client.close(dbB);
    await client.closeProcess();
  });
});
