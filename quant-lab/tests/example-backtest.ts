/**
 * 示例策略回测运行器
 * 
 * 验证示例策略能在回测引擎中正常运行
 */

import { createLogger } from '../src/utils/logger';
const logger = createLogger('EXAMPLE_BACKTEST');

import { BacktestEngine } from '../src/engine/backtest';
import { KlineDatabase } from '../../quant-lib/src';
import { MovingAverageCrossStrategy } from '../strategies/examples/ma-cross-strategy';

async function main() {
  logger.info('========================================');
  logger.info('   示例策略回测验证');
  logger.info('========================================\n');

  // 1. 初始化数据库
  const db = new KlineDatabase();
  
  // 2. 准备测试数据（模拟30天的1小时K线）
  const symbol = 'BTCUSDT';
  const interval = '1h';
  const startTime = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
  const endTime = Math.floor(Date.now() / 1000);
  
  logger.info(`[Setup] 准备测试数据: ${symbol} ${interval}`);
  logger.info(`[Setup] 时间范围: ${new Date(startTime * 1000).toISOString()} ~ ${new Date(endTime * 1000).toISOString()}`);
  
  // 生成模拟K线数据（带趋势的随机游走）
  const mockKlines = generateMockKlines(symbol, startTime, 30 * 24); // 30天，每小时一根
  logger.info(`[Setup] 生成模拟K线: ${mockKlines.length} 根\n`);
  
  // 3. 创建策略实例
  const strategy = new MovingAverageCrossStrategy();
  logger.info(`[Strategy] 策略名称: ${strategy.name}`);
  logger.info(`[Strategy] 策略版本: ${strategy.version}\n`);
  
  // 4. 配置回测
  const backtestConfig = {
    initialBalance: 10000,
    symbols: [symbol],
    interval,
    startTime,
    endTime,
    commission: 0.001, // 0.1% 手续费
    slippage: 0.0005,  // 0.05% 滑点
  };
  
  // 5. 创建回测引擎
  const engine = new BacktestEngine(db, strategy, backtestConfig);
  logger.info('[Backtest] 回测引擎创建成功');
  logger.info(`[Backtest] 初始资金: $${backtestConfig.initialBalance.toLocaleString()}`);
  logger.info(`[Backtest] 手续费: ${(backtestConfig.commission * 100).toFixed(2)}%`);
  logger.info(`[Backtest] 滑点: ${(backtestConfig.slippage * 100).toFixed(2)}%\n`);
  
  // 6. 运行回测
  try {
    logger.info('[Backtest] 开始回测...\n');
    const result = await engine.run();
    
    // 7. 输出结果
    logger.info('========================================');
    logger.info('   回测结果');
    logger.info('========================================');
    logger.info(`总回报率: ${(result.totalReturn * 100).toFixed(2)}%`);
    logger.info(`最大回撤: ${(result.maxDrawdown * 100).toFixed(2)}%`);
    logger.info(`夏普比率: ${result.sharpeRatio.toFixed(2)}`);
    logger.info(`胜率: ${(result.winRate * 100).toFixed(2)}%`);
    logger.info(`总交易次数: ${result.totalTrades}`);
    logger.info(`盈利次数: ${result.winningTrades}`);
    logger.info(`亏损次数: ${result.losingTrades}`);
    logger.info(`盈亏比: ${result.profitFactor.toFixed(2)}`);
    logger.info(`初始资金: $${result.initialBalance.toLocaleString()}`);
    logger.info(`最终资金: $${result.finalBalance.toLocaleString()}`);
    logger.info(`权益曲线点数: ${result.equityCurve.length}`);
    logger.info('========================================');
    
    logger.info('\n✅ 示例策略回测验证通过！');
    process.exit(0);
  } catch (error: any) {
    logger.error('[Backtest] 回测失败:', error.message);
    logger.error(error.stack);
    process.exit(1);
  }
}

/**
 * 生成模拟K线数据（带趋势的随机游走）
 */
function generateMockKlines(symbol: string, startTime: number, count: number) {
  const klines = [];
  let price = 50000; // 起始价格
  let trend = 0;
  let trendDuration = 0;
  
  for (let i = 0; i < count; i++) {
    // 随机改变趋势
    if (trendDuration <= 0) {
      trend = (Math.random() - 0.5) * 0.002; // -0.1% ~ +0.1% 趋势
      trendDuration = 10 + Math.floor(Math.random() * 20); // 持续10-30根K线
    }
    trendDuration--;
    
    // 生成OHLCV
    const open = price;
    const change = trend + (Math.random() - 0.5) * 0.01; // 趋势 + 随机波动
    const close = open * (1 + change);
    const high = Math.max(open, close) * (1 + Math.random() * 0.005);
    const low = Math.min(open, close) * (1 - Math.random() * 0.005);
    const volume = 100 + Math.random() * 900;
    
    klines.push({
      symbol,
      timestamp: startTime + i * 3600, // 每小时一根
      open,
      high,
      low,
      close,
      volume,
    });
    
    price = close;
  }
  
  return klines;
}

// 运行
main().catch((error) => {
  logger.error('[Fatal]', error);
  process.exit(1);
});
