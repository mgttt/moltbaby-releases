/**
 * Negative方向BTC上涨段验证
 * 使用2026年1月数据（BTC从92k涨到106k）
 * 验证negative策略在上涨段能产生Sell交易
 */

import { QuickJSBacktestEngine, BacktestConfig } from '../legacy/quickjs-backtest';
import { resolve } from 'path';
import { writeFileSync } from 'fs';

const DB_PATH = resolve(process.cwd(), '..', 'quant-lib', 'data', 'ndtsdb');

async function runTest() {
  // 【hardcode】2026年1月1日-1月31日，BTC从92k涨到106k
  const startDate = '2026-01-01';
  const endDate = '2026-01-31';
  
  console.log(`[S1-BTC-上涨段] lean=negative spacing=0.01 orderSize=50`);
  console.log(`  时间段: ${startDate} ~ ${endDate} (BTC 92k→106k)`);
  
  const engine = new QuickJSBacktestEngine({
    strategyPath: 'strategies/grid/gales-simple.js',
    symbol: 'BTC/USDT',
    from: startDate,
    to: endDate,
    interval: '1m',
    initialBalance: 10000,
    direction: 'short',
    proxy: 'http://127.0.0.1:8890',
    dbPath: DB_PATH,
    params: {
      lean: 'negative',
      gridSpacing: 0.01,
      orderSize: 50,
      gridCount: 5,
      maxPosition: 3000,
      priceTick: 0.01,
    },
  } as BacktestConfig);

  try {
    await engine.initialize();
    const result = await engine.run();
    await engine.cleanup();

    const buyTrades = result.trades.filter((t: any) => t.side === 'Buy').length;
    const sellTrades = result.trades.filter((t: any) => t.side === 'Sell').length;
    
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('                 回测结果');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`初始资金:    $${result.initialBalance.toLocaleString()}`);
    console.log(`最终资金:    $${result.finalBalance.toFixed(2)}`);
    console.log(`总回报率:    ${(result.totalReturn * 100).toFixed(2)}%`);
    console.log(`最大回撤:    ${(result.maxDrawdown * 100).toFixed(2)}%`);
    console.log(`总交易次数:  ${result.totalTrades}`);
    console.log(`  - Buy: ${buyTrades}`);
    console.log(`  - Sell: ${sellTrades}`);
    console.log('═══════════════════════════════════════════════════════');
    
    if (sellTrades > 0) {
      console.log('\n✅✅✅ 验证通过！negative策略在上涨段产生Sell交易');
    } else if (result.totalTrades > 0) {
      console.log('\n⚠️ 有交易但无Sell（仅Buy回补）');
    } else {
      console.log('\n○ 无交易');
    }
    
    return {
      success: true,
      totalTrades: result.totalTrades,
      buyTrades,
      sellTrades,
      equity: result.finalBalance,
    };
  } catch (e: any) {
    console.error('❌ 失败:', e.message);
    await engine.cleanup().catch(() => {});
    return { success: false, error: e.message };
  }
}

runTest().then(r => {
  const outputPath = resolve(process.cwd(), 'tests', '.temp', 'negative-btc-jan2026-result.json');
  writeFileSync(outputPath, JSON.stringify(r, null, 2));
  console.log(`\n结果保存: ${outputPath}`);
});
