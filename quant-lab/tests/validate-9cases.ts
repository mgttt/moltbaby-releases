#!/usr/bin/env bun
/**
 * 极简回测验证 - 9组参数
 */

import { QuickJSBacktestEngine } from '../legacy/quickjs-backtest';
import { KlineDatabase } from '../../quant-lib/src';

const DB_PATH = '/home/devali/moltbaby/data/klines.db';

// 9组参数：3方向 × 3组参数
const testCases = [
  // Long方向
  { direction: 'long', spacing: 0.01, orderSize: 50, magnet: 0.01, name: 'L1' },
  { direction: 'long', spacing: 0.02, orderSize: 100, magnet: 0.015, name: 'L2' },
  { direction: 'long', spacing: 0.03, orderSize: 150, magnet: 0.02, name: 'L3' },
  // Short方向  
  { direction: 'short', spacing: 0.01, orderSize: 50, magnet: 0.01, name: 'S1' },
  { direction: 'short', spacing: 0.02, orderSize: 100, magnet: 0.015, name: 'S2' },
  { direction: 'short', spacing: 0.03, orderSize: 150, magnet: 0.02, name: 'S3' },
  // Neutral方向
  { direction: 'neutral', spacing: 0.01, orderSize: 50, magnet: 0.01, name: 'N1' },
  { direction: 'neutral', spacing: 0.02, orderSize: 100, magnet: 0.015, name: 'N2' },
  { direction: 'neutral', spacing: 0.03, orderSize: 150, magnet: 0.02, name: 'N3' },
];

async function runTest(tc: typeof testCases[0]) {
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
    direction: tc.direction,
    proxy: 'http://127.0.0.1:8890',
    dbPath: DB_PATH,
  });

  await engine.initialize();

  // 注入参数
  const strategy = (engine as any).strategy;
  if (strategy?.config?.params) {
    strategy.config.params.direction = tc.direction;  // 【修复】注入direction
    strategy.config.params.gridSpacing = tc.spacing;
    strategy.config.params.orderSize = tc.orderSize;
    strategy.config.params.magnetDistance = tc.magnet;
    strategy.config.params.gridSpacingUp = tc.spacing;
    strategy.config.params.gridSpacingDown = tc.spacing;
    console.log(`  [DEBUG] 参数注入: direction=${tc.direction}, spacing=${tc.spacing}, orderSize=${tc.orderSize}`);
  } else {
    console.log(`  [WARN] 无法注入参数，strategy.config.params不存在`);
  }

  const result = await engine.run();
  
  // 【DEBUG】统计订单方向
  const buyTrades = result.trades.filter((t: any) => t.side === 'Buy').length;
  const sellTrades = result.trades.filter((t: any) => t.side === 'Sell').length;
  console.log(`  [DEBUG] 交易统计: Buy=${buyTrades}, Sell=${sellTrades}, Total=${result.totalTrades}`);
  
  await engine.cleanup();

  const winRate = result.totalTrades > 0 ? (result.winningTrades / result.totalTrades) * 100 : 0;
  
  return {
    name: tc.name,
    direction: tc.direction,
    params: `s=${tc.spacing},o=${tc.orderSize}`,
    finalEquity: result.finalBalance,
    totalReturn: result.totalReturn * 100,
    maxDrawdown: result.maxDrawdown * 100,
    winRate,
    trades: result.totalTrades,
    abnormal: result.maxDrawdown > 1 || winRate < 0 || winRate > 100 || Math.abs(result.totalReturn) > 10
  };
}

import { writeFileSync } from 'fs';
import { resolve } from 'path';

async function main() {
  console.log('回测引擎验证 - 9组参数');
  console.log('='.repeat(80));
  
  const results: any[] = [];
  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    console.log(`\n[${i+1}/9] 测试 ${tc.name} (${tc.direction})...`);
    try {
      const r = await runTest(tc);
      results.push(r);
      const status = r.abnormal ? '❌ 异常' : '✓';
      console.log(`  ${status} Equity=${r.finalEquity.toFixed(2)}, Return=${r.totalReturn.toFixed(2)}%, DD=${r.maxDrawdown.toFixed(2)}%, WinRate=${r.winRate.toFixed(1)}%`);
    } catch (e: any) {
      console.log(`  ❌ 失败: ${e.message}`);
      results.push({ name: tc.name, direction: tc.direction, params: `s=${tc.spacing},o=${tc.orderSize}`, error: e.message });
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('汇总结果:');
  console.log('-'.repeat(80));
  console.log('测试|方向  |参数          |最终Equity|回报率  |最大回撤|胜率   |交易数');
  console.log('-'.repeat(80));
  
  let abnormalCount = 0;
  for (const r of results) {
    if ('error' in r) {
      console.log(`${r.name}  |${r.direction.padEnd(6)}|${r.params.padEnd(14)}|失败: ${r.error}`);
      abnormalCount++;
    } else {
      const status = r.abnormal ? '❌' : '✓';
      console.log(`${r.name}${status}|${r.direction.padEnd(6)}|${r.params.padEnd(14)}|${r.finalEquity.toFixed(2).padStart(10)}|${r.totalReturn.toFixed(2).padStart(7)}%|${r.maxDrawdown.toFixed(2).padStart(7)}%|${r.winRate.toFixed(1).padStart(6)}%|${r.trades}`);
      if (r.abnormal) abnormalCount++;
    }
  }
  
  console.log('-'.repeat(80));
  if (abnormalCount === 0) {
    console.log('✓ 全部9组参数验证通过，数据合理');
    console.log('→ 可以放行全量sweep');
  } else {
    console.log(`❌ 发现${abnormalCount}组异常，需要排查`);
  }
  
  // 写入结果文件
  const outputPath = resolve(process.cwd(), 'tests', '.temp', '9cases-results.json');
  writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n结果已保存: ${outputPath}`);
}

main().catch(console.error);
