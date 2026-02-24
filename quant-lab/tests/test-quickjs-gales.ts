#!/usr/bin/env bun
/**
 * 测试 QuickJS Gales 策略
 */

import { QuickJSStrategy } from '../legacy/QuickJSStrategy';
import { LiveEngine } from '../src/engine/live';
import { PaperTradingProvider } from '../../quant-lib/src/providers/paper-trading';
import { PaperTradingProviderAdapter } from '../src/adapters/PaperTradingProviderAdapter';
import type { Kline } from '../../quant-lib/src';

async function main() {
  console.log('='.repeat(70));
  console.log('   QuickJS Gales 策略测试');
  console.log('='.repeat(70));
  console.log();

  // 1. 创建策略
  const strategy = new QuickJSStrategy({
    strategyId: 'gales-quickjs-test',
    strategyFile: './strategies/grid/gales-simple.js',
    params: {
      symbol: 'MYXUSDT',
      gridCount: 5,
      simMode: true,
    },
    stateDir: './quant-lab/state',
  });

  // 2. 创建 Provider
  const paperProvider = new PaperTradingProvider({
    initialBalance: 1000,
  });

  // 用适配器包装（桥接quant-lib和quant-lab接口）
  const provider = new PaperTradingProviderAdapter(paperProvider);

  // 3. 创建引擎
  const engine = new LiveEngine(
    strategy as any,
    {
      symbols: ['MYX/USDT'],
      intervals: ['1m'],
    },
    provider
  );

  // 4. 启动
  console.log('[测试] 启动引擎...');
  await engine.start();

  // 5. 模拟推送 K线
  console.log('[测试] 推送模拟 K线...');
  
  const basePrice = 5.717;
  for (let i = 0; i < 10; i++) {
    const bar: Kline = {
      timestamp: Math.floor(Date.now() / 1000) + i * 60,
      open: basePrice + (Math.random() - 0.5) * 0.1,
      high: basePrice + Math.random() * 0.15,
      low: basePrice - Math.random() * 0.15,
      close: basePrice + (Math.random() - 0.5) * 0.1,
      volume: 1000 + Math.random() * 500,
      trades: 0,
    };

    await provider.pushKline(bar);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // 6. 停止
  console.log('\n[测试] 停止引擎...');
  await engine.stop();

  console.log('\n✅ 测试完成');
}

main().catch((error) => {
  console.error('\n❌ 测试失败:', error);
  process.exit(1);
});
