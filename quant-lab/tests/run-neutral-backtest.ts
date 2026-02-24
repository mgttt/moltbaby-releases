/**
 * 方案A回测验证：使用本地K线数据
 * 参数: neutral + spacing=0.01 + orderSize=50
 */

import { QuickJSBacktestEngine, BacktestConfig } from '../legacy/quickjs-backtest';
import { resolve } from 'path';

const STRATEGY_PATH = resolve(process.cwd(), 'strategies', 'grid', 'gales-simple.js');

async function runBacktest() {
  const engine = new QuickJSBacktestEngine({
    strategyPath: STRATEGY_PATH,
    symbol: 'BTC/USDT',  // 使用ndtsdb格式
    from: '2024-01-01',  // 扩大时间范围
    to: '2025-12-31',
    interval: '15m',
    initialBalance: 10000,
    direction: 'neutral',
    dbPath: resolve(process.cwd(), '..', 'quant-lib', 'data', 'ndtsdb'),
  } as BacktestConfig);

  try {
    await engine.initialize();
    
    const result = await engine.run();
    
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('    方案A回测结果 (neutral + spacing=0.01 + orderSize=50)');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`标的:        BTC/USDT (15m)`);
    console.log(`初始资金:    $${result.initialBalance.toLocaleString()}`);
    console.log(`最终资金:    $${result.finalBalance.toFixed(2)}`);
    console.log(`总回报率:    ${(result.totalReturn * 100).toFixed(2)}%`);
    console.log(`最大回撤:    ${(result.maxDrawdown * 100).toFixed(2)}%`);
    console.log(`总交易次数:  ${result.totalTrades}`);
    console.log(`盈利次数:    ${result.winningTrades}`);
    console.log(`亏损次数:    ${result.losingTrades}`);
    console.log(`爆仓退出:    ${result.liquidated ? '是' : '否'}`);
    console.log('═══════════════════════════════════════════════════════\n');
    
    const passed = 
      result.finalBalance > 0 &&
      result.maxDrawdown < 1.0 &&
      !result.liquidated;
    
    console.log('验收标准:');
    console.log(`  ✅ equity > 0:     ${result.finalBalance > 0 ? 'PASS' : 'FAIL'} (${result.finalBalance.toFixed(2)})`);
    console.log(`  ✅ maxDD < 100%:   ${result.maxDrawdown < 1.0 ? 'PASS' : 'FAIL'} (${(result.maxDrawdown * 100).toFixed(2)}%)`);
    console.log(`  ✅ 未爆仓:         ${!result.liquidated ? 'PASS' : 'FAIL'}`);
    console.log(`\n总体结果: ${passed ? '✅ 通过' : '❌ 未通过'}`);
    
    await engine.cleanup();
    
    return {
      passed,
      finalBalance: result.finalBalance,
      maxDrawdown: result.maxDrawdown,
      totalReturn: result.totalReturn,
      totalTrades: result.totalTrades,
    };
  } catch (e: any) {
    console.error('回测失败:', e.message);
    await engine.cleanup();
    throw e;
  }
}

runBacktest().then(result => {
  process.exit(result.passed ? 0 : 1);
}).catch(e => {
  console.error(e);
  process.exit(1);
});
