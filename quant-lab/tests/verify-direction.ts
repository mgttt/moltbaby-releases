/**
 * 快速验证：L3 vs S3 方向区分测试
 */

import { QuickJSBacktestEngine } from '../legacy/quickjs-backtest';

const DB_PATH = '/home/devali/moltbaby/data/klines.db';

async function runTest(name: string, direction: 'long' | 'short', spacing: number, orderSize: number) {
  console.log(`\n========== ${name} (${direction}) ==========`);
  
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fromDate = startDate.toISOString().split('T')[0];
  const toDate = endDate.toISOString().split('T')[0];

  const engine = new QuickJSBacktestEngine({
    strategyPath: 'strategies/grid/gales-simple.js',
    symbol: 'MYX/USDT',
    from: fromDate,
    to: toDate,
    interval: '1m',
    initialBalance: 10000,
    direction: direction,
    proxy: 'http://127.0.0.1:8890',
    dbPath: DB_PATH,
  });

  // 【修复】在initialize之前注入参数
  const engineAny = engine as any;
  if (!engineAny.strategy) {
    // 创建策略实例（不初始化）
    const { QuickJSStrategy } = require('../legacy/QuickJSStrategy');
    const strategyFile = require('path').resolve(process.cwd(), 'strategies', 'gales-simple.js');
    engineAny.strategy = new QuickJSStrategy({
      strategyId: `backtest-MYX/USDT`,
      strategyFile: strategyFile,
      params: {
        symbol: 'MYX/USDT',
        direction: direction,
        gridSpacing: spacing,
        orderSize: orderSize,
        gridCount: 5,
        maxPosition: 3000,
      },
    });
    console.log(`[DEBUG] 策略预创建，direction=${direction}`);
  }

  await engine.initialize();
  
  // 再次确认参数注入
  const strategy = engineAny.strategy;
  if (strategy?.ctx?.strategy) {
    const params = {
      symbol: 'MYX/USDT',
      direction: direction,
      gridSpacing: spacing,
      orderSize: orderSize,
    };
    strategy.ctx.strategy.params = JSON.stringify(params);
    console.log(`[DEBUG] 参数二次注入: direction=${direction}`);
  }

  const result = await engine.run();
  
  // 统计订单方向
  const buyTrades = result.trades.filter((t: any) => t.side === 'Buy').length;
  const sellTrades = result.trades.filter((t: any) => t.side === 'Sell').length;
  
  console.log(`[结果] Equity=${result.finalBalance.toFixed(2)}, DD=${(result.maxDrawdown*100).toFixed(2)}%`);
  console.log(`[交易] Buy=${buyTrades}, Sell=${sellTrades}, Total=${result.totalTrades}`);
  console.log(`[爆仓] ${result.liquidated ? '是' : '否'}`);
  
  await engine.cleanup();
  
  return {
    name,
    direction,
    equity: result.finalBalance,
    maxDrawdown: result.maxDrawdown,
    buyTrades,
    sellTrades,
    totalTrades: result.totalTrades,
    liquidated: result.liquidated,
  };
}

async function main() {
  // 只跑L3和S3对比
  const l3 = await runTest('L3', 'long', 0.03, 150);
  const s3 = await runTest('S3', 'short', 0.03, 150);
  
  console.log('\n========== 对比 ==========');
  console.log(`L3 (long):  Equity=${l3.equity.toFixed(2)}, Buy=${l3.buyTrades}, Sell=${l3.sellTrades}`);
  console.log(`S3 (short): Equity=${s3.equity.toFixed(2)}, Buy=${s3.buyTrades}, Sell=${s3.sellTrades}`);
  
  if (l3.equity === s3.equity && l3.totalTrades === s3.totalTrades) {
    console.log('❌ 警告：L3和S3结果完全相同，direction参数可能未生效！');
  } else {
    console.log('✅ L3和S3结果不同，direction参数已生效');
  }
}

main().catch(console.error);
