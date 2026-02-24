/**
 * 9组参数验证（方案1修复版）
 * 每组附带Buy/Sell订单数量证明方向正确
 */

import { QuickJSBacktestEngine, BacktestConfig } from '../legacy/quickjs-backtest';
import { resolve } from 'path';
import { writeFileSync } from 'fs';

const DB_PATH = resolve(process.cwd(), '..', 'quant-lib', 'data', 'ndtsdb');

// 9组参数
// 【修复】策略使用 lean: 'negative'|'positive'|'neutral'，而非 'short'|'long'
const directionMap = {
  long: 'positive',
  short: 'negative',
  neutral: 'neutral',
} as const;

const testCases = [
  { lean: 'positive' as const, spacing: 0.01, orderSize: 50, name: 'L1', label: 'long' },
  { lean: 'positive' as const, spacing: 0.02, orderSize: 100, name: 'L2', label: 'long' },
  { lean: 'positive' as const, spacing: 0.03, orderSize: 150, name: 'L3', label: 'long' },
  { lean: 'negative' as const, spacing: 0.01, orderSize: 50, name: 'S1', label: 'short' },
  { lean: 'negative' as const, spacing: 0.02, orderSize: 100, name: 'S2', label: 'short' },
  { lean: 'negative' as const, spacing: 0.03, orderSize: 150, name: 'S3', label: 'short' },
  { lean: 'neutral' as const, spacing: 0.01, orderSize: 50, name: 'N1', label: 'neutral' },
  { lean: 'neutral' as const, spacing: 0.02, orderSize: 100, name: 'N2', label: 'neutral' },
  { lean: 'neutral' as const, spacing: 0.03, orderSize: 150, name: 'N3', label: 'neutral' },
];

async function runTest(tc: typeof testCases[0]) {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  
  const engine = new QuickJSBacktestEngine({
    strategyPath: 'strategies/grid/gales-simple.js',
    symbol: 'MYX/USDT',
    from: startDate.toISOString().split('T')[0],
    to: endDate.toISOString().split('T')[0],
    interval: '1m',
    initialBalance: 10000,
    direction: tc.label as any,
    proxy: 'http://127.0.0.1:8890',
    dbPath: DB_PATH,
    params: {
      // 【修复】使用lean参数，策略会自动处理gridSpacing覆盖Up/Down
      lean: tc.lean,
      gridSpacing: tc.spacing,
      orderSize: tc.orderSize,
      gridCount: 5,
      maxPosition: 3000,
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
      direction: tc.label,
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
      direction: tc.label,
      lean: tc.lean,
      spacing: tc.spacing,
      orderSize: tc.orderSize,
      error: e.message,
      success: false,
    };
  }
}

async function main() {
  console.log('9组参数验证（方案1修复版）');
  console.log('='.repeat(100));
  
  const results = [];
  for (const tc of testCases) {
    console.log(`\n[${tc.name}] ${tc.label} lean=${tc.lean} spacing=${tc.spacing} orderSize=${tc.orderSize}...`);
    const r = await runTest(tc);
    results.push(r);
    
    if (r.success) {
      console.log(`  Equity=${r.equity?.toFixed(2)}, DD=${(r.maxDrawdown * 100).toFixed(2)}%`);
      console.log(`  Buy=${r.buyTrades}, Sell=${r.sellTrades}, Total=${r.totalTrades}`);
      console.log(`  Liquidated=${r.liquidated}`);
      
      // 验证方向
      if (r.lean === 'positive' && r.buyTrades < r.sellTrades) {
        console.log(`  ⚠️ 警告: positive方向Sell单多于Buy单`);
      } else if (r.lean === 'negative' && r.sellTrades < r.buyTrades) {
        console.log(`  ⚠️ 警告: negative方向Buy单多于Sell单`);
      } else if (r.totalTrades > 0) {
        console.log(`  ✅ 方向验证通过`);
      }
    } else {
      console.log(`  ❌ 失败: ${r.error}`);
    }
  }
  
  console.log('\n' + '='.repeat(100));
  console.log('汇总:');
  console.log('-'.repeat(100));
  console.log('测试|方向  |间距  |单量|Equity  |DD%   |Buy|Sell|爆仓|状态');
  console.log('-'.repeat(100));
  
  for (const r of results) {
    if (r.success) {
      const equity = r.equity!.toFixed(2).padStart(8);
      const dd = (r.maxDrawdown! * 100).toFixed(1).padStart(5);
      const buy = String(r.buyTrades).padStart(2);
      const sell = String(r.sellTrades).padStart(2);
      const liq = r.liquidated ? '是' : '否';
      const dirLabel = (r.lean || r.direction).padEnd(8);
      console.log(`${r.name} |${dirLabel}|${r.spacing.toFixed(2)}|${r.orderSize.toString().padStart(4)}|${equity}|${dd}|${buy}|${sell}|${liq.padStart(2)}|✓`);
    } else {
      const dirLabel = (r.lean || r.direction).padEnd(8);
      console.log(`${r.name} |${dirLabel}|${r.spacing.toFixed(2)}|${r.orderSize.toString().padStart(4)}|失败: ${r.error}`);
    }
  }
  
  // 保存结果
  const outputPath = resolve(process.cwd(), 'tests', '.temp', '9cases-results-v2.json');
  writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n结果保存: ${outputPath}`);
}

main().catch(console.error);
