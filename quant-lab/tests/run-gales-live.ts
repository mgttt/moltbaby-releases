#!/usr/bin/env bun
/**
 * Gales 策略 - Bybit 实盘启动脚本
 * 
 * 使用 wjcgm@bybit-sub1 账号在 Bybit 运行磁铁限价网格策略
 */

import { LiveEngine } from '../src/engine/live';
import { BybitProvider } from '../../quant-lib/src/providers/bybit';
import { GalesStrategy } from '../src/strategies/GalesStrategy';
import { requireAccountConfig, redactAccount } from '../src/config/accounts';

async function main() {
  console.log('='.repeat(70));
  console.log('   Gales 策略 - Bybit 实盘');
  console.log('='.repeat(70));
  console.log();

  // 1. 加载账号配置
  const account = requireAccountConfig('wjcgm@bybit-sub1', ['wjcgm@bbt-sub1']);
  
  if (account.exchange !== 'bybit') {
    throw new Error(`Expected bybit account, got: ${account.exchange}`);
  }

  console.log('[账号配置]', redactAccount(account));
  console.log();

  // 2. 创建 Provider
  const provider = new BybitProvider({
    apiKey: account.apiKey,
    apiSecret: account.apiSecret,
    testnet: account.testnet,
    proxy: account.proxy,
    category: account.category || 'linear',
  });

  // 3. 创建策略
  const strategy = new GalesStrategy({
    symbol: 'BTC/USDT',
    gridCount: 5,
    gridSpacing: 0.01,       // 1% 间距
    orderSize: 10,           // 每单 10 USDT
    maxPosition: 100,        // 最大仓位 100 USDT

    magnetDistance: 0.002,   // 0.2% 磁铁距离
    cancelDistance: 0.005,   // 0.5% 取消距离
    priceOffset: 0.0005,     // 0.05% 价格偏移
    postOnly: true,

    simMode: true,           // ⚠️ 默认模拟模式，确认后手动改为 false
  });

  // 4. 创建引擎
  const engine = new LiveEngine(
    strategy as any,
    {
      symbols: ['BTC/USDT'],
      intervals: ['1m'],
    },
    provider
  );

  // 5. 启动
  console.log('[策略] 启动中...');
  console.log('[⚠️  模拟模式] simMode=true，不会真实下单');
  console.log('[提示] 确认无误后，修改脚本中 simMode=false 并重启');
  console.log();

  await engine.start();

  console.log('[策略] 运行中...');
  console.log('[按 Ctrl+C 停止]');
  console.log();

  // 6. 优雅停止
  process.on('SIGINT', async () => {
    console.log('\n[策略] 停止信号接收，清理中...');
    await engine.stop();
    await provider.disconnect();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[策略] 停止信号接收，清理中...');
    await engine.stop();
    await provider.disconnect();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('\n❌ 策略启动失败:', error);
  process.exit(1);
});
