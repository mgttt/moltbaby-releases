/**
 * 多策略对比报告CLI
 * 基于performance-metrics，输出4策略对比表格
 * 用法: bun run compare-strategies.ts [strategyId]
 */

import { aggregateStrategyMetrics, StrategyMetrics } from './performance-metrics';
import { resolve } from 'path';

const STATE_DIR = process.env.QUANT_LAB_STATE_DIR || '/home/devali/.quant-lab/state';

// 策略列表
const STRATEGIES = ['gales-short', 'gales-sim-b', 'gales-sim-c', 'gales-sim-d'];

interface StrategyComparison {
  strategyId: string;
  metrics: StrategyMetrics;
}

function formatNumber(n: number, decimals: number = 2): string {
  return n.toFixed(decimals);
}

function formatU(n: number): string {
  return n >= 0 ? `+${formatNumber(n)}U` : `${formatNumber(n)}U`;
}

function printTable(comparisons: StrategyComparison[]) {
  // 表头
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('📊 多策略对比报告');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('');
  
  // 列标题
  const header = [
    '策略'.padEnd(15),
    '盈亏(PnL)'.padEnd(12),
    '持仓(Pos)'.padEnd(12),
    '均价'.padEnd(10),
    '运行(h)'.padEnd(10),
    '健康'.padEnd(10),
    'Gap'.padEnd(8)
  ].join(' | ');
  
  console.log(header);
  console.log('─'.repeat(90));
  
  // 数据行
  for (const comp of comparisons) {
    const { strategyId, metrics } = comp;
    
    // 健康状态emoji
    const healthEmoji = {
      'normal': '🟢',
      'warning': '🟡',
      'critical': '🔴'
    }[metrics.healthStatus] || '⚪';
    
    // 盈亏颜色（通过符号表示）
    const pnlStr = formatU(metrics.totalPnl).padEnd(12);
    
    const row = [
      strategyId.padEnd(15),
      pnlStr,
      formatNumber(metrics.positionSize).padEnd(12),
      formatNumber(metrics.avgEntryPrice, 4).padEnd(10),
      formatNumber(metrics.runningHours).padEnd(10),
      (healthEmoji + ' ' + metrics.healthStatus).padEnd(10),
      formatNumber(Math.abs(metrics.positionSize - metrics.maxPositionReached)).padEnd(8)
    ].join(' | ');
    
    console.log(row);
  }
  
  // 汇总
  console.log('─'.repeat(90));
  const totalPnl = comparisons.reduce((sum, c) => sum + c.metrics.totalPnl, 0);
  const avgRunH = comparisons.reduce((sum, c) => sum + c.metrics.runningHours, 0) / comparisons.length;
  
  console.log(`总盈亏: ${formatU(totalPnl)} | 平均运行: ${formatNumber(avgRunH)}h`);
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('');
}

function main() {
  const strategyId = process.argv[2];
  
  if (strategyId) {
    // 单策略模式
    const stateFile = resolve(STATE_DIR, `${strategyId}.json`);
    const metrics = aggregateStrategyMetrics(stateFile);
    
    console.log(`[CompareStrategies] 策略: ${strategyId}`);
    console.log(JSON.stringify(metrics, null, 2));
  } else {
    // 全部策略对比模式
    const comparisons: StrategyComparison[] = [];
    
    for (const strategy of STRATEGIES) {
      const stateFile = resolve(STATE_DIR, `${strategy}.json`);
      const metrics = aggregateStrategyMetrics(stateFile);
      comparisons.push({ strategyId: strategy, metrics });
    }
    
    printTable(comparisons);
  }
}

main();
