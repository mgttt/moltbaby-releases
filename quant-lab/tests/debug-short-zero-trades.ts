/**
 * Short方向单独测试 - 排查0交易根因
 */

import { QuickJSBacktestEngine, BacktestConfig } from '../legacy/quickjs-backtest';
import { resolve } from 'path';
import { writeFileSync } from 'fs';

const DB_PATH = resolve(process.cwd(), '..', 'quant-lib', 'data', 'ndtsdb');

async function runShortTest() {
  console.log('Short方向单独测试 - 排查0交易根因');
  console.log('='.repeat(80));

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 3 * 24 * 60 * 60 * 1000); // 只取3天数据，加快测试

  const engine = new QuickJSBacktestEngine({
    strategyPath: 'strategies/grid/gales-simple.js',
    symbol: 'MYX/USDT',
    from: startDate.toISOString().split('T')[0],
    to: endDate.toISOString().split('T')[0],
    interval: '1m',
    initialBalance: 10000,
    direction: 'short',
    proxy: 'http://127.0.0.1:8890',
    dbPath: DB_PATH,
    params: {
      direction: 'negative',  // short对应negative
      gridSpacing: 0.02,
      gridSpacingUp: 0.02,
      gridSpacingDown: 0.02,
      orderSize: 100,
      orderSizeUp: 100,
      orderSizeDown: 100,
      gridCount: 3,  // 减少网格数量，简化测试
      maxPosition: 3000,
      simMode: false,
      // 禁用自动重心，避免干扰
      autoRecenter: false,
    },
  } as BacktestConfig);

  try {
    await engine.initialize();
    console.log('✓ 引擎初始化完成');

    const result = await engine.run();
    console.log('\n' + '='.repeat(80));
    console.log('回测结果:');
    console.log(`  初始资金: $${result.initialBalance}`);
    console.log(`  最终资金: $${result.finalBalance.toFixed(2)}`);
    console.log(`  总交易次数: ${result.totalTrades}`);
    console.log(`  爆仓: ${result.liquidated ? '是' : '否'}`);

    if (result.trades.length > 0) {
      console.log('\n  交易明细:');
      result.trades.slice(0, 10).forEach((t, i) => {
        console.log(`    ${i+1}. ${t.side} ${t.qty.toFixed(4)} @ ${t.price.toFixed(4)}`);
      });
      if (result.trades.length > 10) {
        console.log(`    ... 还有 ${result.trades.length - 10} 笔交易`);
      }
    } else {
      console.log('\n  ⚠️ 没有交易记录');
    }

    await engine.cleanup();
    return result;
  } catch (e: any) {
    console.error('❌ 测试失败:', e.message);
    await engine.cleanup().catch(() => {});
    throw e;
  }
}

runShortTest().catch(console.error);
