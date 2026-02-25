/**
 * Neutral方向验证（BTC下跌段）
 * 验证回测引擎能正确产生交易
 */

import { QuickJSBacktestEngine, BacktestConfig } from '../legacy/quickjs-backtest';
import { resolve } from 'path';
import { writeFileSync } from 'fs';

const DB_PATH = resolve(process.cwd(), '..', 'quant-lib', 'data', 'ndtsdb');
const INTERVAL = '15m';

// 测试neutral方向，不同spacing
const testCases = [
  { lean: 'neutral' as const, spacing: 0.01, orderSize: 100, name: 'S1-neutral' },
  { lean: 'neutral' as const, spacing: 0.02, orderSize: 200, name: 'S2-neutral' },
  { lean: 'neutral' as const, spacing: 0.03, orderSize: 300, name: 'S3-neutral' },
];

async function runTest(tc: typeof testCases[0]) {
  const engine = new QuickJSBacktestEngine({
    strategyPath: 'strategies/grid/gales-simple.js',
    symbol: 'BTC/USDT',
    from: '2026-01-15',
    to: '2026-02-15',
    interval: INTERVAL,
    initialBalance: 10000,
    direction: 'neutral',
    proxy: 'http://127.0.0.1:8890',
    dbPath: DB_PATH,
    params: {
      lean: tc.lean,
      gridSpacing: tc.spacing,
      orderSize: tc.orderSize,
      gridCount: 5,
      maxPosition: 10000,
      priceTick: 0.01,
      symbol: 'BTCUSDT',
    },
  } as BacktestConfig);

  try {
    await engine.initialize();
    const result = await engine.run();
    await engine.cleanup();

    const buyTrades = result.trades.filter((t: any) => t.side === 'Buy').length;
    const sellTrades = result.trades.filter((t: any) => t.side === 'Sell').length;
    
    return {
      name: tc.name,
      lean: tc.lean,
      spacing: tc.spacing,
      orderSize: tc.orderSize,
      equity: result.finalBalance,
      maxDrawdown: result.maxDrawdown,
      totalTrades: result.totalTrades,
      buyTrades,
      sellTrades,
      liquidated: result.liquidated,
      success: true,
    };
  } catch (e: any) {
    await engine.cleanup().catch(() => {});
    return {
      name: tc.name,
      lean: tc.lean,
      spacing: tc.spacing,
      orderSize: tc.orderSize,
      error: e.message,
      success: false,
    };
  }
}

async function main() {
  console.log('Neutral方向验证（BTC 2026-01-15~2026-02-15）');
  console.log('='.repeat(100));
  
  const results = [];
  for (const tc of testCases) {
    console.log(`\n[${tc.name}] lean=${tc.lean} spacing=${tc.spacing} orderSize=${tc.orderSize}...`);
    const r = await runTest(tc);
    results.push(r);
    
    if (r.success) {
      console.log(`  Equity=${r.equity?.toFixed(2)}, DD=${(r.maxDrawdown * 100).toFixed(2)}%`);
      console.log(`  Buy=${r.buyTrades}, Sell=${r.sellTrades}, Total=${r.totalTrades}`);
      console.log(`  Liquidated=${r.liquidated}`);
      
      if (r.totalTrades > 0) {
        console.log(`  ✅ 有交易，验证通过`);
      } else {
        console.log(`  ⚠️ 无交易`);
      }
    } else {
      console.log(`  ❌ 失败: ${r.error}`);
    }
  }
  
  console.log('\n' + '='.repeat(100));
  console.log('汇总:');
  console.log('-'.repeat(100));
  console.log('测试|lean     |间距  |单量|Equity  |DD%   |Buy|Sell|爆仓|状态');
  console.log('-'.repeat(100));
  
  for (const r of results) {
    if (r.success) {
      const equity = r.equity!.toFixed(2).padStart(8);
      const dd = (r.maxDrawdown! * 100).toFixed(1).padStart(5);
      const buy = String(r.buyTrades).padStart(2);
      const sell = String(r.sellTrades).padStart(2);
      const liq = r.liquidated ? '是' : '否';
      const status = r.totalTrades > 0 ? '✓' : '○';
      console.log(`${r.name} |${r.lean.padEnd(8)}|${r.spacing.toFixed(2)}|${r.orderSize.toString().padStart(4)}|${equity}|${dd}|${buy}|${sell}|${liq.padStart(2)}|${status}`);
    } else {
      console.log(`${r.name} |${r.lean.padEnd(8)}|${r.spacing.toFixed(2)}|${r.orderSize.toString().padStart(4)}|失败: ${r.error}`);
    }
  }
  
  // 保存结果
  const outputPath = resolve(process.cwd(), 'tests', '.temp', 'neutral-btc-results.json');
  writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n结果保存: ${outputPath}`);
}

main().catch(console.error);
