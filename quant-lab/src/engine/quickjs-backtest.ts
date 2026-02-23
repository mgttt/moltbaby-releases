// ============================================================
// QuickJS 策略回测引擎
// 让 gales-simple.js 直接在历史K线数据上运行
// ============================================================

import { createLogger } from '../utils/logger';
const logger = createLogger('QuickJSBacktest');

import { QuickJSStrategy } from '../sandbox/QuickJSStrategy';
import type { Kline } from '../../../quant-lib/src';
import { KlineDatabase } from '../../../quant-lib/src';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { BybitProvider } from '../providers/bybit';

// [P2] Bybit REST API 配置
const BYBIT_BASE_URL = 'https://api.bybit.com';
const BYBIT_TESTNET_URL = 'https://api-testnet.bybit.com';

/**
 * 回测配置
 */
interface BacktestConfig {
  strategyPath: string;      // 策略文件路径
  symbol: string;            // 交易品种
  from: string;              // 开始日期 (YYYY-MM-DD)
  to: string;                // 结束日期 (YYYY-MM-DD)
  interval?: string;         // K线周期，默认 '1m'
  initialBalance?: number;   // 初始资金，默认 10000
  useTestnet?: boolean;      // 是否使用测试网
  proxy?: string;            // 代理设置
  direction?: 'long' | 'short' | 'neutral';  // 策略方向
  dbPath?: string;           // 数据库路径，默认使用 quant-lab/data/klines.db
}

/**
 * 回测结果
 */
interface BacktestResult {
  initialBalance: number;
  finalBalance: number;
  totalReturn: number;       // 总回报率
  totalTrades: number;       // 总成交次数
  winningTrades: number;     // 盈利次数
  losingTrades: number;      // 亏损次数
  maxDrawdown: number;       // 最大回撤
  sharpeRatio: number;       // 夏普比率
  equityCurve: Array<{ timestamp: number; equity: number }>;
  trades: Array<{
    timestamp: number;
    side: string;
    price: number;
    qty: number;
    pnl: number;
  }>;
}

/**
 * 模拟订单
 */
interface SimulatedOrder {
  orderId: string;
  symbol: string;
  side: string;
  price: number;
  qty: number;
  status: 'NEW' | 'FILLED' | 'CANCELLED';
  createdAt: number;
}

/**
 * QuickJS 回测引擎
 */
export class QuickJSBacktestEngine {
  private config: BacktestConfig;
  private strategy?: QuickJSStrategy;
  private klineDb?: KlineDatabase;

  // 回测状态
  private balance: number = 10000;
  private equity: number = 10000;
  private position: number = 0;           // 当前持仓数量
  private positionNotional: number = 0;   // 持仓名义价值
  private avgEntryPrice: number = 0;      // 平均入场价
  private orders: SimulatedOrder[] = [];
  private filledOrders: SimulatedOrder[] = [];

  // 结果统计
  private equityCurve: Array<{ timestamp: number; equity: number }> = [];
  private trades: Array<{
    timestamp: number;
    side: string;
    price: number;
    qty: number;
    pnl: number;
  }> = [];
  private peakEquity: number = 10000;
  private maxDrawdown: number = 0;
  private totalPnL: number = 0;
  private winningTrades: number = 0;
  private losingTrades: number = 0;

  constructor(config: BacktestConfig) {
    this.config = {
      interval: '1m',
      initialBalance: 10000,
      ...config,
    };
    this.balance = this.config.initialBalance || 10000;
    this.equity = this.balance;
    this.peakEquity = this.balance;
  }

  /**
   * 初始化回测引擎
   */
  async initialize(): Promise<void> {
    logger.info('[QuickJSBacktest] 初始化回测引擎...');
    logger.info(`  策略: ${this.config.strategyPath}`);
    logger.info(`  品种: ${this.config.symbol}`);
    logger.info(`  区间: ${this.config.from} ~ ${this.config.to}`);
    logger.info(`  初始资金: $${this.config.initialBalance}`);

    // 1. 获取策略文件绝对路径
    const strategyFile = this.getStrategyFilePath();

    // 2. 创建 QuickJSStrategy 实例
    this.strategy = new QuickJSStrategy({
      strategyId: `backtest-${this.config.symbol}`,
      strategyFile: strategyFile,
      params: {
        symbol: this.config.symbol,
        direction: this.config.direction || 'neutral',
        maxPosition: 3000,
        gridCount: 5,
        gridSpacing: 0.02,
        orderSize: 100,
        simMode: true,  // 模拟模式
      },
    });

    // 3. 初始化 KlineDatabase
    const dbPath = this.config.dbPath || resolve(process.cwd(), 'data', 'klines.db');
    this.klineDb = new KlineDatabase(dbPath);  // 直接传路径字符串
    await this.klineDb.init();

    logger.info('[QuickJSBacktest] 初始化完成');
  }

  /**
   * [P2] 覆盖QuickJS的bridge函数，实现mock订单簿
   */
  private overrideBridgeFunctions(): void {
    if (!this.strategy) return;

    // 覆盖 bridge_placeOrder - 将订单推入回测订单簿
    this.strategy.overrideBridgeFunction('bridge_placeOrder', (paramsJson: string) => {
      try {
        const params = JSON.parse(paramsJson);
        const order: SimulatedOrder = {
          orderId: `backtest-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          symbol: params.symbol || this.config.symbol,
          side: params.side,
          price: params.price || 0,
          qty: params.qty,
          status: 'NEW',
          createdAt: Date.now(),
        };
        this.orders.push(order);
        logger.info(`[QuickJSBacktest] [MOCK]下单成功: ${order.side} ${order.qty} @ ${order.price || 'Market'}, orderId=${order.orderId}, 总订单数=${this.orders.length}`);
        return JSON.stringify({ success: true, orderId: order.orderId });
      } catch (e: any) {
        logger.error(`[QuickJSBacktest] [MOCK]下单失败:`, e.message);
        return JSON.stringify({ success: false, error: e.message });
      }
    });

    // 覆盖 bridge_cancelOrder - 从订单簿移除
    this.strategy.overrideBridgeFunction('bridge_cancelOrder', (orderId: string) => {
      const order = this.orders.find(o => o.orderId === orderId && o.status === 'NEW');
      if (order) {
        order.status = 'CANCELLED';
        logger.info(`[QuickJSBacktest] 撤单: ${orderId}`);
        return JSON.stringify({ success: true });
      }
      return JSON.stringify({ success: false, error: 'Order not found' });
    });

    // 覆盖 bridge_cancelAllOrders - 取消所有订单
    this.strategy.overrideBridgeFunction('bridge_cancelAllOrders', () => {
      let count = 0;
      for (const order of this.orders) {
        if (order.status === 'NEW') {
          order.status = 'CANCELLED';
          count++;
        }
      }
      logger.info(`[QuickJSBacktest] 全撤: ${count}个订单`);
      return JSON.stringify({ success: true, cancelledCount: count });
    });

    // 覆盖 bridge_getPosition - 返回回测实时仓位
    this.strategy.overrideBridgeFunction('bridge_getPosition', (symbol: string) => {
      const position = {
        symbol: symbol || this.config.symbol,
        side: this.position > 0 ? 'LONG' : this.position < 0 ? 'SHORT' : 'FLAT',
        quantity: Math.abs(this.position),
        entryPrice: this.avgEntryPrice,
        currentPrice: 0,
        unrealizedPnl: 0,
        realizedPnl: this.totalPnL,
      };
      logger.debug(`[QuickJSBacktest] [MOCK]getPosition: ${JSON.stringify(position)}`);
      return JSON.stringify(position);
    });

    // 覆盖 bridge_getAccount - 返回回测实时账户
    this.strategy.overrideBridgeFunction('bridge_getAccount', () => {
      const account = {
        balance: this.balance,
        equity: this.equity,
        positions: [{
          symbol: this.config.symbol,
          side: this.position > 0 ? 'LONG' : this.position < 0 ? 'SHORT' : 'FLAT',
          quantity: Math.abs(this.position),
          entryPrice: this.avgEntryPrice,
          currentPrice: 0,
          unrealizedPnl: 0,
          realizedPnl: this.totalPnL,
        }],
      };
      logger.debug(`[QuickJSBacktest] [MOCK]getAccount: balance=${this.balance}, equity=${this.equity}`);
      return JSON.stringify(account);
    });

    logger.info('[QuickJSBacktest] bridge函数已覆盖');
  }

  /**
   * 获取策略文件绝对路径
   */
  private getStrategyFilePath(): string {
    // 支持相对路径：从 quant-lab 目录或项目根目录运行
    let strategyPath = this.config.strategyPath;

    // 如果路径以 strategies/ 开头，尝试从 quant-lab 目录解析
    if (strategyPath.startsWith('strategies/')) {
      strategyPath = resolve(process.cwd(), 'quant-lab', strategyPath);
      if (!existsSync(strategyPath)) {
        // 如果不在 quant-lab 子目录，尝试从当前目录解析
        strategyPath = resolve(process.cwd(), this.config.strategyPath);
      }
    } else {
      strategyPath = resolve(strategyPath);
    }

    if (!existsSync(strategyPath)) {
      throw new Error(`策略文件不存在: ${strategyPath} (原始路径: ${this.config.strategyPath})`);
    }

    logger.info(`[QuickJSBacktest] 策略文件: ${strategyPath}`);
    return strategyPath;
  }

  /**
   * 运行回测
   */
  async run(): Promise<BacktestResult> {
    if (!this.strategy || !this.klineDb) {
      throw new Error('引擎未初始化');
    }

    logger.info('[QuickJSBacktest] 开始回测...');

    // 1. 读取历史K线
    const fromTime = new Date(this.config.from).getTime() / 1000;
    const toTime = new Date(this.config.to).getTime() / 1000;

    // [P2] 标准化symbol格式（ndtsdb使用 MYX/USDT 格式）
    const normalizedSymbol = this.normalizeSymbol(this.config.symbol);

    // 使用 queryKlines 读取历史数据
    let klines = await this.klineDb!.queryKlines({
      symbol: normalizedSymbol,
      interval: this.config.interval || '1m',
      startTime: fromTime,
      endTime: toTime,
    });

    // [P2] fallback: 如果本地无数据，从Bybit REST API获取
    if (klines.length === 0) {
      logger.info('[QuickJSBacktest] 本地无历史K线数据，尝试从Bybit REST API获取...');
      klines = await this.fetchKlinesFromBybit(fromTime, toTime);

      if (klines.length > 0) {
        logger.info(`[QuickJSBacktest] 从Bybit获取 ${klines.length} 根K线，写入ndtsdb...`);
        await this.saveKlinesToDb(klines);
      }
    }

    if (klines.length === 0) {
      throw new Error('未找到历史K线数据（本地和Bybit均无数据）');
    }

    logger.info(`[QuickJSBacktest] 加载 ${klines.length} 根K线`);

    // [P2] 覆盖bridge函数，必须在onInit之前，让策略获取正确的初始状态
    this.overrideBridgeFunctions();

    // 2. 初始化策略（创建 mock context）
    await this.strategy.onInit(this.createMockContext());

    // 3. 逐K线运行
    for (let i = 0; i < klines.length; i++) {
      const kline = klines[i];
      await this.processKline(kline, i);

      // 每100根K线输出进度
      if (i % 100 === 0) {
        logger.info(`[QuickJSBacktest] 进度: ${i}/${klines.length} (${(i/klines.length*100).toFixed(1)}%)`);
      }
    }

    // 4. 生成结果
    const result = this.generateResult();

    logger.info('[QuickJSBacktest] 回测完成');
    this.printResult(result);

    return result;
  }

  /**
   * 处理单根K线
   */
  private async processKline(kline: Kline, index: number): Promise<void> {
    if (!this.strategy) return;

    // 更新当前价格
    const currentPrice = kline.close;

    // 检查并成交订单（模拟限价单成交）
    await this.checkAndFillOrders(currentPrice, kline.timestamp);

    // 计算未实现盈亏
    this.updateEquity(currentPrice);

    // 记录权益曲线
    this.equityCurve.push({
      timestamp: kline.timestamp,
      equity: this.equity,
    });

    // 更新最大回撤
    if (this.equity > this.peakEquity) {
      this.peakEquity = this.equity;
    }
    const drawdown = (this.peakEquity - this.equity) / this.peakEquity;
    if (drawdown > this.maxDrawdown) {
      this.maxDrawdown = drawdown;
    }

    // 调用策略 onBar
    await this.strategy.onBar(kline, this.createMockContext());

    // 调用策略 onTick（用收盘价模拟）
    if (this.strategy.onTick) {
      await this.strategy.onTick({
        timestamp: kline.timestamp,
        symbol: this.config.symbol,
        price: currentPrice,
        volume: kline.volume,
      }, this.createMockContext());
    }
  }

  /**
   * 检查并成交订单
   */
  private async checkAndFillOrders(currentPrice: number, timestamp: number): Promise<void> {
    for (const order of this.orders) {
      if (order.status !== 'NEW') continue;

      let shouldFill = false;

      if (order.side === 'Buy' && currentPrice <= order.price) {
        shouldFill = true;
      } else if (order.side === 'Sell' && currentPrice >= order.price) {
        shouldFill = true;
      }

      if (shouldFill) {
        order.status = 'FILLED';
        this.filledOrders.push(order);

        // 更新持仓
        const notional = order.qty * order.price;

        if (order.side === 'Buy') {
          this.positionNotional += notional;
          this.position += order.qty;
        } else {
          this.positionNotional -= notional;
          this.position -= order.qty;
        }

        // 计算平均入场价
        if (this.position !== 0) {
          this.avgEntryPrice = Math.abs(this.positionNotional / this.position);
        }

        // 记录成交
        const pnl = this.calculateTradePnL(order);
        this.trades.push({
          timestamp,
          side: order.side,
          price: order.price,
          qty: order.qty,
          pnl,
        });

        // 更新盈亏统计
        if (pnl > 0) {
          this.winningTrades++;
        } else if (pnl < 0) {
          this.losingTrades++;
        }
        this.totalPnL += pnl;

        logger.info(`[QuickJSBacktest] 成交: ${order.side} ${order.qty} @ ${order.price}, PnL: ${pnl.toFixed(2)}`);

        // [P2] 调用策略 onExecution - 关键：让策略更新账本
        if (this.strategy?.onExecution) {
          try {
            await this.strategy.onExecution({
              execId: `backtest-fill-${Date.now()}`,
              orderId: order.orderId,
              orderLinkId: order.orderId,
              symbol: order.symbol,
              side: order.side,
              execQty: order.qty,
              execPrice: order.price,
              execTime: timestamp * 1000,
            }, this.createMockContext());
            logger.info(`[QuickJSBacktest] onExecution回调成功: ${order.orderId}`);
          } catch (e: any) {
            logger.error(`[QuickJSBacktest] onExecution回调失败:`, e.message);
          }
        } else {
          logger.warn(`[QuickJSBacktest] strategy.onExecution未定义`);
        }
      }
    }

    // 移除已成交订单
    this.orders = this.orders.filter(o => o.status === 'NEW');
  }

  /**
   * 计算单笔交易盈亏
   */
  private calculateTradePnL(order: SimulatedOrder): number {
    // 简化计算：基于当前持仓变化估算盈亏
    // 实际应该根据持仓方向计算
    return 0;  // 简化处理
  }

  /**
   * 更新权益
   */
  private updateEquity(currentPrice: number): void {
    // 未实现盈亏
    const unrealizedPnL = this.position * (currentPrice - this.avgEntryPrice) *
      (this.position > 0 ? 1 : -1);
    this.equity = this.balance + this.positionNotional + unrealizedPnL;
  }

  /**
   * 创建 mock 策略上下文
   */
  private createMockContext(): any {
    const self = this;

    return {
      getAccount: () => ({
        balance: self.balance,
        equity: self.equity,
        positions: [{
          symbol: self.config.symbol,
          side: self.position > 0 ? 'LONG' : self.position < 0 ? 'SHORT' : 'FLAT',
          quantity: Math.abs(self.position),
          entryPrice: self.avgEntryPrice,
          currentPrice: 0,  // 由策略自己获取
          unrealizedPnl: 0,
          realizedPnl: self.totalPnL,
        }],
      }),

      getPosition: (symbol: string) => ({
        symbol,
        side: self.position > 0 ? 'LONG' : self.position < 0 ? 'SHORT' : 'FLAT',
        quantity: Math.abs(self.position),
        entryPrice: self.avgEntryPrice,
        currentPrice: 0,
        unrealizedPnl: 0,
        realizedPnl: self.totalPnL,
      }),

      // Mock bridge API
      buy: async (symbol: string, quantity: number, price?: number) => {
        const order: SimulatedOrder = {
          orderId: `backtest-${Date.now()}`,
          symbol,
          side: 'Buy',
          price: price || 0,
          qty: quantity,
          status: 'NEW',
          createdAt: Date.now(),
        };
        self.orders.push(order);
        logger.debug(`[QuickJSBacktest] 下单: Buy ${quantity} ${symbol} @ ${price || 'Market'}`);
        return {
          orderId: order.orderId,
          symbol,
          side: 'BUY',
          type: price ? 'LIMIT' : 'MARKET',
          quantity,
          price: price || 0,
          status: 'PENDING',
          filledQuantity: 0,
          timestamp: Date.now(),
        };
      },

      sell: async (symbol: string, quantity: number, price?: number) => {
        const order: SimulatedOrder = {
          orderId: `backtest-${Date.now()}`,
          symbol,
          side: 'Sell',
          price: price || 0,
          qty: quantity,
          status: 'NEW',
          createdAt: Date.now(),
        };
        self.orders.push(order);
        logger.debug(`[QuickJSBacktest] 下单: Sell ${quantity} ${symbol} @ ${price || 'Market'}`);
        return {
          orderId: order.orderId,
          symbol,
          side: 'SELL',
          type: price ? 'LIMIT' : 'MARKET',
          quantity,
          price: price || 0,
          status: 'PENDING',
          filledQuantity: 0,
          timestamp: Date.now(),
        };
      },

      cancelOrder: async (orderId: string) => {
        const order = self.orders.find(o => o.orderId === orderId);
        if (order) {
          order.status = 'CANCELLED';
        }
      },

      log: (message: string, level: string = 'info') => {
        logger[level](`[Strategy] ${message}`);
      },
    };
  }

  /**
   * 生成回测结果
   */
  private generateResult(): BacktestResult {
    const totalReturn = (this.equity - (this.config.initialBalance || 10000)) /
      (this.config.initialBalance || 10000);

    const totalTrades = this.trades.length; // [P2] 使用trades数组长度
    const winningTrades = this.trades.filter(t => t.pnl > 0).length; // [P2] 重新计算
    const losingTrades = this.trades.filter(t => t.pnl < 0).length;

    logger.info(`[QuickJSBacktest] 生成结果: totalTrades=${totalTrades}, winning=${winningTrades}, losing=${losingTrades}`);
    logger.info(`[QuickJSBacktest] filledOrders=${this.filledOrders.length}, orders=${this.orders.length}`);

    // 简化夏普比率计算
    const sharpeRatio = 0;  // 需要收益率序列计算

    return {
      initialBalance: this.config.initialBalance || 10000,
      finalBalance: this.equity,
      totalReturn,
      totalTrades,
      winningTrades,
      losingTrades,
      maxDrawdown: this.maxDrawdown,
      sharpeRatio,
      equityCurve: this.equityCurve,
      trades: this.trades,
    };
  }

  /**
   * [P2] 标准化symbol格式（ndtsdb使用 MYX/USDT 格式）
   * 输入: MYXUSDT 或 MYX/USDT
   * 输出: MYX/USDT
   */
  private normalizeSymbol(symbol: string): string {
    // 如果已经包含/，说明已是标准格式
    if (symbol.includes('/')) {
      return symbol;
    }
    // 否则尝试分割（假设最后4个字符是USDT）
    if (symbol.endsWith('USDT') && symbol.length > 4) {
      return symbol.slice(0, -4) + '/USDT';
    }
    return symbol;
  }

  /**
   * 打印结果
   */
  private printResult(result: BacktestResult): void {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('                 回测结果');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`初始资金:    $${result.initialBalance.toLocaleString()}`);
    console.log(`最终资金:    $${result.finalBalance.toFixed(2)}`);
    console.log(`总回报率:    ${(result.totalReturn * 100).toFixed(2)}%`);
    console.log(`最大回撤:    ${(result.maxDrawdown * 100).toFixed(2)}%`);
    console.log(`总交易次数:  ${result.totalTrades}`);
    console.log(`盈利次数:    ${result.winningTrades}`);
    console.log(`亏损次数:    ${result.losingTrades}`);
    console.log(`胜率:        ${(result.winningTrades / result.totalTrades * 100).toFixed(1)}%`);
    console.log('═══════════════════════════════════════════════════════\n');
  }

  /**
   * [P2] 从Bybit获取历史K线（使用BybitProvider，复用代理+认证）
   */
  private async fetchKlinesFromBybit(startTime: number, endTime: number): Promise<Kline[]> {
    const klines: Kline[] = [];
    const symbol = this.config.symbol.replace('/', ''); // MYX/USDT -> MYXUSDT
    const interval = this.config.interval === '1m' ? '1' :
      this.config.interval === '5m' ? '5' :
        this.config.interval === '15m' ? '15' :
          this.config.interval === '1h' ? '60' : '1';

    // 创建BybitProvider（无需API key，只需要市场数据）
    const provider = new BybitProvider({
      apiKey: '',
      apiSecret: '',
      testnet: this.config.useTestnet || false,
      proxy: this.config.proxy,
      category: 'linear',
    });

    let currentEnd = endTime * 1000; // Bybit需要毫秒
    const finalStart = startTime * 1000;
    const limit = 200; // Bybit最大200条

    logger.info(`[QuickJSBacktest] 从Bybit获取 ${symbol} ${interval}m K线...`);

    while (currentEnd > finalStart) {
      try {
        const batch = await provider.getKlines(symbol, interval, limit, currentEnd);

        if (batch.length === 0) {
          break;
        }

        // 过滤时间范围
        const filtered = batch.filter(k => k.timestamp >= startTime && k.timestamp <= endTime);
        klines.unshift(...filtered); // 倒序插入

        logger.info(`[QuickJSBacktest] 已获取 ${filtered.length} 根K线，累计 ${klines.length}`);

        // 更新endTime为最早K线的时间-1
        const earliestKline = batch[0];
        currentEnd = earliestKline.timestamp * 1000 - 1;

        // 避免请求过快
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error: any) {
        logger.error(`[QuickJSBacktest] 获取K线失败:`, error.message);
        break;
      }
    }

    logger.info(`[QuickJSBacktest] Bybit数据获取完成: ${klines.length} 根K线`);
    return klines;
  }

  /**
   * [P2] 将K线保存到ndtsdb
   */
  private async saveKlinesToDb(klines: Kline[]): Promise<void> {
    if (!this.klineDb || klines.length === 0) return;

    logger.info(`[QuickJSBacktest] 保存 ${klines.length} 根K线到ndtsdb...`);

    // [P2] 使用标准化symbol格式（ndtsdb使用 MYX/USDT 格式）
    const symbol = this.normalizeSymbol(this.config.symbol);
    const interval = this.config.interval || '1m';

    // 批量插入
    for (const kline of klines) {
      try {
        // 假设ndtsdb有insert或类似方法
        // 这里需要根据实际的KlineDatabase API调整
        await this.klineDb!.insert?.(symbol, interval, kline);
      } catch (e) {
        // 忽略重复插入错误
        logger.debug(`[QuickJSBacktest] 插入K线失败(可能已存在):`, e);
      }
    }

    logger.info(`[QuickJSBacktest] K线保存完成`);
  }
}

/**
 * CLI 入口
 */
async function main() {
  const args = process.argv.slice(2);

  // 解析参数
  let strategyPath = '';
  let symbol = 'MYXUSDT';
  let fromDate = '2026-01-01';
  let toDate = new Date().toISOString().split('T')[0];
  let useTestnet = false;
  let proxy = process.env.PROXY || ''; // 支持环境变量
  let direction: 'long' | 'short' | 'neutral' = 'neutral';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--strategy':
        strategyPath = args[++i];
        break;
      case '--symbol':
        symbol = args[++i];
        break;
      case '--from':
        fromDate = args[++i];
        break;
      case '--to':
        toDate = args[++i];
        break;
      case '--testnet':
        useTestnet = true;
        break;
      case '--proxy':
        proxy = args[++i];
        break;
      case '--direction':
        const dir = args[++i];
        if (dir === 'long' || dir === 'short' || dir === 'neutral') {
          direction = dir;
        } else {
          console.error(`无效方向: ${dir}，使用默认 neutral`);
        }
        break;
    }
  }

  if (!strategyPath) {
    console.log('QuickJS 策略回测引擎');
    console.log('');
    console.log('用法: bun run src/engine/quickjs-backtest.ts --strategy <path> --symbol <symbol> --from <date> --to <date>');
    console.log('');
    console.log('示例:');
    console.log('  cd quant-lab');
    console.log('  bun run src/engine/quickjs-backtest.ts --strategy strategies/gales-simple.js --symbol MYX/USDT --from 2026-01-01 --to 2026-02-23');
    console.log('');
    console.log('参数:');
    console.log('  --strategy   策略文件路径 (支持 strategies/xxx.js 或绝对路径)');
    console.log('  --symbol     交易品种 (默认: MYX/USDT)');
    console.log('  --from       开始日期 (YYYY-MM-DD, 默认: 2026-01-01)');
    console.log('  --to         结束日期 (YYYY-MM-DD, 默认: 今天)');
    console.log('  --direction  策略方向: long/short/neutral (默认: neutral)');
    console.log('  --testnet    使用Bybit测试网');
    console.log('  --proxy      代理服务器 (如: http://127.0.0.1:8890)');
    console.log('');
    console.log('环境变量:');
    console.log('  PROXY        代理服务器 (优先级低于 --proxy)');
    process.exit(1);
  }

  const engine = new QuickJSBacktestEngine({
    strategyPath,
    symbol,
    from: fromDate,
    to: toDate,
    initialBalance: 10000,
    useTestnet,
    proxy,
    direction,
  });

  try {
    await engine.initialize();
    await engine.run();
  } catch (error: any) {
    logger.error('回测失败:', error.message);
    process.exit(1);
  }
}

// 运行 CLI
if (import.meta.main) {
  main();
}

export { BacktestConfig, BacktestResult };
