import { QuickJSBacktest } from './engine/quickjs-backtest';
import { logger } from 'quant-lib';

async function test() {
  const backtest = new QuickJSBacktest({
    strategyPath: './strategies/gales-simple.js',
    symbol: 'BTCUSDT',
    from: Date.now() - 7 * 24 * 60 * 60 * 1000,
    to: Date.now(),
    interval: '1m',
    initialBalance: 10000,
  });

  try {
    await backtest.initialize();
    logger.info('[TEST] 初始化完成，准备运行...');
    const result = await backtest.run();
    logger.info('[TEST] 回测完成');
    logger.info(`[TEST] 总交易数: ${result.totalTrades}`);
    logger.info(`[TEST] 最终权益: ${result.finalEquity}`);
    if (result.totalTrades > 0) {
      logger.info('[TEST] ✅ 验证通过: totalTrades > 0');
    } else {
      logger.info('[TEST] ❌ 验证失败: totalTrades = 0');
    }
  } catch (e) {
    logger.error('[TEST] 错误:', e);
  }
}

test();
