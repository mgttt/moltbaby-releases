import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { NdtsdbRpcKlineStore } from '../src/storage/ndtsdb-rpc-store';

const rpcBinary = join(process.cwd(), '..', 'ndtsdb', 'docs', 'poc', 'qjs-ndtsdb-rpc');

function nowTs() {
  return Date.now();
}

describe('ndtsdb rpc kline store', () => {
  it('bootstrap + open/insert/query/close', async () => {
    const dbPath = '/tmp/quant-lab-rpc-smoke.ndts';
    const store = new NdtsdbRpcKlineStore({
      dbPath,
      binaryPath: rpcBinary,
      maxRetries: 2,
      retryDelayMs: 20,
      fallbackEnabled: false,
    });

    await store.init();

    await store.upsertKlines([
      {
        symbol: 'BTCUSDT',
        exchange: 'OKX',
        baseCurrency: 'BTC',
        quoteCurrency: 'USDT',
        interval: '1m',
        timestamp: nowTs(),
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5,
        volume: 10,
      },
    ]);

    const got = await store.queryKlines({
      symbol: 'BTCUSDT',
      interval: '1m',
      limit: 10,
    });

    expect(got).toHaveLength(1);
    expect(got[0].symbol).toBe('BTCUSDT');

    await store.close();
  });

  it('concurrent insert path', async () => {
    const dbPath = '/tmp/quant-lab-rpc-concurrent.ndts';
    const store = new NdtsdbRpcKlineStore({
      dbPath,
      binaryPath: rpcBinary,
      maxRetries: 3,
      fallbackEnabled: false,
    });

    await store.init();

    const base = nowTs();
    const rows = Array.from({ length: 20 }, (_, i) => ({
      symbol: 'ETHUSDT',
      exchange: 'OKX',
      baseCurrency: 'ETH',
      quoteCurrency: 'USDT',
      interval: '1m',
      timestamp: base + i * 1000,
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100.5 + i,
      volume: 2 + i,
    }));

    await Promise.all(rows.map((r) => store.upsertKlines([r])));

    const got = await store.queryKlines({
      symbol: 'ETHUSDT',
      interval: '1m',
      limit: 100,
    });

    expect(got).toHaveLength(20);
    await store.close();
  });
});
