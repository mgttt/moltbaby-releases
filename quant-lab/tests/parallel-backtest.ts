#!/usr/bin/env bun
import { createLogger } from '../utils/logger';
const logger = createLogger('PARALLEL_BACKTEST');
/**
 * 并行回测测试
 * 测试 100 组参数，验证并行加速效果
 */

import { StrategyScheduler } from '../src/scheduler/StrategyScheduler';
import type { BacktestTask } from '../src/workers/BacktestWorker';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// 简单的网格策略（用于测试）
const SIMPLE_GRID_STRATEGY = `
/**
 * 简单网格策略 - 测试用
 */
class GridStrategy {
  constructor(params) {
    this.params = params;
    this.orders = [];
    this.position = 0;
    this.entryPrice = 0;
  }

  async onBar(bar, ctx) {
    const { gridCount, gridSpacing, magnetDistance, cancelDistance } = this.params;

    // 简单的买卖逻辑
    if (this.position === 0) {
      // 开多
      if (Math.random() > 0.5) {
        await ctx.buy(bar.symbol, 0.1, bar.close);
        this.position = 1;
        this.entryPrice = bar.close;
      }
    } else {
      // 止盈/止损
      const change = (bar.close - this.entryPrice) / this.entryPrice;

      if (change > gridSpacing || change < -gridSpacing * 0.5) {
        await ctx.sell(bar.symbol, 0.1, bar.close);
        this.position = 0;
        this.entryPrice = 0;
      }
    }
  }
}

module.exports = { GridStrategy };
`;

/**
 * 创建测试策略文件
 */
function createTestStrategyFile(): string {
  const strategyDir = './quant-lab/tests/strategies';
  if (!existsSync(strategyDir)) {
    mkdirSync(strategyDir, { recursive: true });
  }

  const strategyFile = join(strategyDir, 'test-grid-strategy.js');
  writeFileSync(strategyFile, SIMPLE_GRID_STRATEGY);

  return strategyFile;
}

/**
 * 生成测试任务
 */
function generateTasks(strategyFile: string, count: number): BacktestTask[] {
  const tasks: BacktestTask[] = [];
  const now = Date.now();
  const thirtyDaysMs = 30 * 86400 * 1000;

  // 网格参数组合
  const gridCounts = [5, 10, 15, 20];
  const spacings = [0.005, 0.01, 0.015];
  const magnetDistances = [0.001, 0.002];
  const cancelDistances = [0.003, 0.005];

  let taskIndex = 0;

  for (const gridCount of gridCounts) {
    for (const gridSpacing of spacings) {
      for (const magnetDistance of magnetDistances) {
        for (const cancelDistance of cancelDistances) {
          if (taskIndex >= count) break;

          tasks.push({
            taskId: `backtest-${taskIndex.toString().padStart(3, '0')}`,
            strategyId: 'grid-test',
            strategyFile,
            params: {
              symbol: 'BTCUSDT',
              gridCount,
              gridSpacing,
              magnetDistance,
              cancelDistance,
            },
            dataRange: {
              symbol: 'BTCUSDT',
              interval: '1h',
              start: now - thirtyDaysMs,
              end: now,
            },
            backtestConfig: {
              initialBalance: 10000,
              feeRate: 0.001,
            },
          });

          taskIndex++;
        }
      }
    }
  }

  return tasks.slice(0, count);
}

/**
 * 串行回测（用于对比）
 */
async function runSerialBacktests(tasks: BacktestTask[]): Promise<{ results: any[]; durationMs: number }> {
  const { BacktestWorker } = await import('../src/workers/BacktestWorker');

  const worker = new BacktestWorker({ dataDir: './data' });
  const results: any[] = [];

  const startTime = Date.now();

  for (const task of tasks) {
    logger.info(`  [串行] 执行: ${task.taskId}`);
    const result = await worker.execute(task);
    results.push(result);
  }

  const durationMs = Date.now() - startTime;

  return { results, durationMs };
}

/**
 * 并行回测
 */
async function runParallelBacktests(tasks: BacktestTask[], maxWorkers: number): Promise<{ results: any[]; durationMs: number }> {
  const scheduler = new StrategyScheduler({
    maxWorkers,
    dataDir: './data',
    ipcDir: '.ipc/test-backtest-pool',
  });

  const startTime = Date.now();

  const results = await scheduler.runParallelBacktests(tasks);

  const durationMs = Date.now() - startTime;

  await scheduler.shutdown();

  return { results, durationMs };
}

/**
 * 分析结果
 */
function analyzeResults(results: any[]) {
  // 过滤掉失败的
  const successful = results.filter(r => !r.error);
  const failed = results.filter(r => r.error);

  logger.info(`\n  成功: ${successful.length}/${results.length}`);
  if (failed.length > 0) {
    logger.info(`  失败: ${failed.length}`);
    for (const f of failed.slice(0, 3)) {
      logger.info(`    - ${f.taskId}: ${f.error}`);
    }
  }

  if (successful.length === 0) {
    logger.info('  没有成功的结果');
    return;
  }

  // 找最优
  const best = successful.reduce((a, b) =>
    (b.metrics?.sharpe || 0) > (a.metrics?.sharpe || 0) ? b : a
  );

  logger.info(`\n  最优参数:`);
  logger.info(`    网格数: ${best.params.gridCount}`);
  logger.info(`    网格间距: ${best.params.gridSpacing}`);
  logger.info(`    磁吸距离: ${best.params.magnetDistance}`);
  logger.info(`    取消距离: ${best.params.cancelDistance}`);

  logger.info(`\n  最优指标:`);
  logger.info(`    Sharpe: ${best.metrics.sharpe.toFixed(2)}`);
  logger.info(`    回报率: ${(best.metrics.totalReturn * 100).toFixed(2)}%`);
  logger.info(`    最大回撤: ${(best.metrics.maxDrawdown * 100).toFixed(2)}%`);
  logger.info(`    胜率: ${(best.metrics.winRate * 100).toFixed(2)}%`);
  logger.info(`    交易次数: ${best.metrics.trades}`);

  // 统计
  const sharpeValues = successful.map(r => r.metrics.sharpe);
  const returnValues = successful.map(r => r.metrics.totalReturn);

  logger.info(`\n  Sharpe 统计:`);
  logger.info(`    平均: ${(sharpeValues.reduce((a, b) => a + b, 0) / sharpeValues.length).toFixed(2)}`);
  logger.info(`    最高: ${Math.max(...sharpeValues).toFixed(2)}`);
  logger.info(`    最低: ${Math.min(...sharpeValues).toFixed(2)}`);
}

/**
 * 主函数
 */
async function main() {
  logger.info('='.repeat(70));
  logger.info('   并行回测测试');
  logger.info('='.repeat(70));

  const TEST_COUNT = 20; // 先测试 20 组，避免太慢
  const MAX_WORKERS = 4;

  // 创建测试策略
  logger.info('\n[准备] 创建测试策略...');
  const strategyFile = createTestStrategyFile();
  logger.info(`  策略文件: ${strategyFile}`);

  // 生成任务
  logger.info(`\n[准备] 生成 ${TEST_COUNT} 组测试参数...`);
  const tasks = generateTasks(strategyFile, TEST_COUNT);
  logger.info(`  实际生成: ${tasks.length} 组`);

  // 串行测试（可选，小样本对比）
  logger.info('\n' + '='.repeat(70));
  logger.info('   串行回测（基准）');
  logger.info('='.repeat(70));

  const serialTasks = tasks.slice(0, 4); // 只测 4 组串行
  const { durationMs: serialDuration } = await runSerialBacktests(serialTasks);
  logger.info(`\n  总耗时: ${(serialDuration / 1000).toFixed(2)}s`);
  logger.info(`  平均: ${(serialDuration / serialTasks.length).toFixed(0)}ms/任务`);

  // 并行测试
  logger.info('\n' + '='.repeat(70));
  logger.info(`   并行回测 (${MAX_WORKERS} Workers)`);
  logger.info('='.repeat(70));

  const { results, durationMs: parallelDuration } = await runParallelBacktests(tasks, MAX_WORKERS);

  logger.info(`\n  总耗时: ${(parallelDuration / 1000).toFixed(2)}s`);
  logger.info(`  平均: ${(parallelDuration / tasks.length).toFixed(0)}ms/任务`);

  // 结果分析
  logger.info('\n' + '='.repeat(70));
  logger.info('   结果分析');
  logger.info('='.repeat(70));
  analyzeResults(results);

  // 加速比
  logger.info('\n' + '='.repeat(70));
  logger.info('   性能对比');
  logger.info('='.repeat(70));

  const estimatedSerialDuration = (serialDuration / serialTasks.length) * tasks.length;
  const speedup = estimatedSerialDuration / parallelDuration;

  logger.info(`  串行预估: ${(estimatedSerialDuration / 1000).toFixed(2)}s (${tasks.length} 组)`);
  logger.info(`  并行实际: ${(parallelDuration / 1000).toFixed(2)}s`);
  logger.info(`  加速比: ${speedup.toFixed(2)}x`);
  logger.info(`  效率: ${((speedup / MAX_WORKERS) * 100).toFixed(1)}%`);

  logger.info('\n' + '='.repeat(70));
  logger.info('   测试完成！');
  logger.info('='.repeat(70));
}

// 运行
main().catch(error => {
  logger.error('\n❌ 测试失败:', error);
  logger.error(error.stack);
  process.exit(1);
});
