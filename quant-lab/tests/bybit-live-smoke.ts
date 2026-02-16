#!/usr/bin/env bun
/**
 * Live smoke test for BybitProvider
 *
 * Uses external accounts config: ~/.config/quant-lab/accounts.json
 *
 * Default account (requested): wjcgm@bybit-sub1
 * Actual existing id in config: wjcgm@bbt-sub1
 */

import { BybitProvider } from '../../quant-lib/src/providers/bybit';
import { requireAccountConfig, redactAccount } from '../src/config/accounts';

async function main() {
  const account = requireAccountConfig('wjcgm@bybit-sub1', ['wjcgm@bbt-sub1']);

  if (account.exchange !== 'bybit') {
    throw new Error(`Expected bybit account, got: ${account.exchange}`);
  }

  console.log('[Bybit smoke] Using account:', redactAccount(account));

  const provider = new BybitProvider({
    apiKey: account.apiKey,
    apiSecret: account.apiSecret,
    testnet: account.testnet,
    proxy: account.proxy,
    category: account.category || 'linear',
  });

  // REST smoke
  console.log('\n[REST] getAccount...');
  const acct = await provider.getAccount();
  console.log('[REST] balance/equity:', acct);

  console.log('\n[REST] getPositions...');
  const positions = await provider.getPositions();
  console.log(`[REST] positions: ${positions.length}`);
  if (positions.length) console.log('[REST] first position:', positions[0]);

  // WS smoke: subscribe 1m klines, wait for first confirmed bar
  console.log('\n[WS] subscribeKlines BTC/USDT 1m (wait for 1 confirmed bar)...');

  let resolved = false;

  const done = new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (!resolved) {
        console.log('[WS] timeout (no confirmed bar within 90s)');
        resolved = true;
        clearTimeout(timeout);
        resolve();
      }
    }, 90_000);

    provider.subscribeKlines(['BTC/USDT'], '1m', (bar) => {
      if (resolved) return;
      console.log('[WS] bar:', bar);
      resolved = true;
      clearTimeout(timeout);
      resolve();
    }).catch((e) => {
      console.error('[WS] subscribe error:', e);
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  await done;

  await provider.disconnect();
  console.log('\n✅ BybitProvider live smoke test done');
}

main().catch((e) => {
  console.error('❌ Bybit smoke failed:', e);
  process.exit(1);
});
