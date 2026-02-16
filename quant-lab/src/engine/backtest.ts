// ============================================================
// 回测引擎
// ============================================================

import type {
  Strategy,
  StrategyContext,
  BacktestConfig,
  BacktestResult,
  Order,
  Position,
  Account,
  OrderSide,
  PositionSide,
  OrderStatus,
} from './types';
import type { Kline } from '../../../quant-lib/src';
import { KlineDatabase } from '../../../quant-lib/src';

/**
 * 回测引擎
 */
export class BacktestEngine {
  private db: KlineDatabase;
  private strategy: Strategy;
  private config: BacktestConfig;
  
  // 账户状态
  private balance: number;
  private equity: number;
  private positions: Map<string, Position> = new Map();
  private orders: Order[] = [];
  
  // 交易记录
  private trades: Array<{
    entryTime: number;
    exitTime: number;
    symbol: string;
    side: OrderSide;
    quantity: number;
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    pnlPercent: number;
  }> = [];
  
  // 权益曲线
  private equityCurve: Array<{ timestamp: number; equity: number }> = [];
  
  // 最大权益（用于计算回撤）
  private maxEquity: number;
  private maxDrawdown: number = 0;
  
  // K线缓存（每个 symbol 最近的 K线）
  private barCache: Map<string, Kline[]> = new Map();
  private lastBarCache: Map<string, Kline> = new Map();
  
  constructor(db: KlineDatabase, strategy: Strategy, config: BacktestConfig) {
    this.db = db;
    this.strategy = strategy;
    this.config = config;
    this.balance = config.initialBalance;
    this.equity = config.initialBalance;
    this.maxEquity = config.initialBalance;
  }
  
  /**
   * 运行回测
   */
  async run(): Promise<BacktestResult> {
    console.log(`[BacktestEngine] 开始回测: ${this.strategy.name}`);
    console.log(`  品种: ${this.config.symbols.join(', ')}`);
    console.log(`  周期: ${this.config.interval}`);
    console.log(`  时间: ${new Date(this.config.startTime * 1000).toISOString()} ~ ${new Date(this.config.endTime * 1000).toISOString()}`);
    console.log(`  初始资金: $${this.config.initialBalance.toLocaleString()}`);
    
    // 初始化策略
    const ctx = this.createContext();
    await this.strategy.onInit(ctx);
    
    // 加载历史数据
    const allBars = await this.loadHistoryBars();
    console.log(`  总 K线数: ${allBars.length}`);
    
    // 按时间排序
    allBars.sort((a, b) => a.timestamp - b.timestamp);
    
    // 逐根 K线回放
    for (const bar of allBars) {
      // 更新缓存
      this.updateBarCache(bar);
      
      // 更新持仓价格 + 未实现盈亏
      this.updatePositions(bar);
      
      // 调用策略
      await this.strategy.onBar(bar, ctx);
      
      // 记录权益曲线
      this.equityCurve.push({
        timestamp: bar.timestamp,
        equity: this.equity,
      });
      
      // 更新最大回撤
      if (this.equity > this.maxEquity) {
        this.maxEquity = this.equity;
      }
      const drawdown = (this.maxEquity - this.equity) / this.maxEquity;
      if (drawdown > this.maxDrawdown) {
        this.maxDrawdown = drawdown;
      }
    }
    
    // 调用策略停止
    if (this.strategy.onStop) {
      await this.strategy.onStop(ctx);
    }
    
    // 计算回测结果
    const result = this.computeResult();
    
    console.log(`[BacktestEngine] 回测完成`);
    console.log(`  最终权益: $${result.finalBalance.toLocaleString()}`);
    console.log(`  总回报: ${(result.totalReturn * 100).toFixed(2)}%`);
    console.log(`  最大回撤: ${(result.maxDrawdown * 100).toFixed(2)}%`);
    console.log(`  胜率: ${(result.winRate * 100).toFixed(2)}%`);
    console.log(`  总交易: ${result.totalTrades}`);
    
    return result;
  }
  
  /**
   * 加载历史 K线
   */
  private async loadHistoryBars(): Promise<Kline[]> {
    const allBars: Kline[] = [];
    
    for (const symbol of this.config.symbols) {
      const bars = await this.db.queryKlines({
        symbol,
        interval: this.config.interval,
        startTime: this.config.startTime,
        endTime: this.config.endTime,
      });
      
      allBars.push(...bars);
    }
    
    return allBars;
  }
  
  /**
   * 更新 K线缓存
   */
  private updateBarCache(bar: Kline): void {
    if (!this.barCache.has(bar.symbol)) {
      this.barCache.set(bar.symbol, []);
    }
    
    const cache = this.barCache.get(bar.symbol)!;
    cache.push(bar);
    
    // 保留最近 1000 根（足够大部分指标计算）
    if (cache.length > 1000) {
      cache.shift();
    }
    
    this.lastBarCache.set(bar.symbol, bar);
  }
  
  /**
   * 更新持仓价格和未实现盈亏
   */
  private updatePositions(bar: Kline): void {
    const position = this.positions.get(bar.symbol);
    if (!position || position.side === 'FLAT') return;
    
    position.currentPrice = bar.close;
    
    if (position.side === 'LONG') {
      position.unrealizedPnl = (position.currentPrice - position.entryPrice) * position.quantity;
    } else if (position.side === 'SHORT') {
      position.unrealizedPnl = (position.entryPrice - position.currentPrice) * position.quantity;
    }
    
    // 更新账户权益
    let totalUnrealizedPnl = 0;
    for (const pos of this.positions.values()) {
      totalUnrealizedPnl += pos.unrealizedPnl;
    }
    
    this.equity = this.balance + totalUnrealizedPnl;
  }
  
  /**
   * 创建策略上下文
   */
  private createContext(): StrategyContext {
    return {
      getAccount: () => this.getAccount(),
      getPosition: (symbol: string) => this.getPosition(symbol),
      buy: (symbol: string, quantity: number, price?: number) => this.buy(symbol, quantity, price),
      sell: (symbol: string, quantity: number, price?: number) => this.sell(symbol, quantity, price),
      cancelOrder: async (orderId: string) => {
        throw new Error('cancelOrder not supported in backtest');
      },
      getLastBar: (symbol: string) => this.lastBarCache.get(symbol) || null,
      getBars: (symbol: string, limit: number) => {
        const cache = this.barCache.get(symbol) || [];
        return cache.slice(-limit);
      },
      log: (message: string, level: 'info' | 'warn' | 'error' = 'info') => {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
      },
    };
  }
  
  /**
   * 获取账户信息
   */
  private getAccount(): Account {
    let totalRealizedPnl = 0;
    let totalUnrealizedPnl = 0;
    
    for (const pos of this.positions.values()) {
      totalRealizedPnl += pos.realizedPnl;
      totalUnrealizedPnl += pos.unrealizedPnl;
    }
    
    return {
      balance: this.balance,
      equity: this.equity,
      positions: Array.from(this.positions.values()),
      totalRealizedPnl,
      totalUnrealizedPnl,
    };
  }
  
  /**
   * 获取持仓
   */
  private getPosition(symbol: string): Position | null {
    return this.positions.get(symbol) || null;
  }
  
  /**
   * 买入（开多仓或平空仓）
   */
  private async buy(symbol: string, quantity: number, price?: number): Promise<Order> {
    const bar = this.lastBarCache.get(symbol);
    if (!bar) {
      throw new Error(`No bar data for ${symbol}`);
    }
    
    // 成交价格（市价单用收盘价 + 滑点）
    const fillPrice = price || bar.close * (1 + (this.config.slippage || 0));
    
    // 检查余额
    const cost = fillPrice * quantity * (1 + this.config.commission);
    if (cost > this.balance) {
      throw new Error(`Insufficient balance: need $${cost.toFixed(2)}, have $${this.balance.toFixed(2)}`);
    }
    
    // 创建订单
    const order: Order = {
      orderId: `${Date.now()}-${Math.random()}`,
      symbol,
      side: 'BUY',
      type: price ? 'LIMIT' : 'MARKET',
      quantity,
      price,
      status: 'FILLED',
      filledQuantity: quantity,
      filledPrice: fillPrice,
      timestamp: bar.timestamp,
      fillTimestamp: bar.timestamp,
      commission: fillPrice * quantity * this.config.commission,
      commissionAsset: 'USDT',
    };
    
    this.orders.push(order);
    
    // 更新持仓
    this.updatePositionAfterBuy(symbol, quantity, fillPrice, order.commission!);
    
    return order;
  }
  
  /**
   * 卖出（开空仓或平多仓）
   */
  private async sell(symbol: string, quantity: number, price?: number): Promise<Order> {
    const bar = this.lastBarCache.get(symbol);
    if (!bar) {
      throw new Error(`No bar data for ${symbol}`);
    }
    
    // 成交价格（市价单用收盘价 - 滑点）
    const fillPrice = price || bar.close * (1 - (this.config.slippage || 0));
    
    // 创建订单
    const order: Order = {
      orderId: `${Date.now()}-${Math.random()}`,
      symbol,
      side: 'SELL',
      type: price ? 'LIMIT' : 'MARKET',
      quantity,
      price,
      status: 'FILLED',
      filledQuantity: quantity,
      filledPrice: fillPrice,
      timestamp: bar.timestamp,
      fillTimestamp: bar.timestamp,
      commission: fillPrice * quantity * this.config.commission,
      commissionAsset: 'USDT',
    };
    
    this.orders.push(order);
    
    // 更新持仓
    this.updatePositionAfterSell(symbol, quantity, fillPrice, order.commission!);
    
    return order;
  }
  
  /**
   * 买入后更新持仓
   */
  private updatePositionAfterBuy(symbol: string, quantity: number, price: number, commission: number): void {
    let position = this.positions.get(symbol);
    
    if (!position) {
      // 新建多仓
      position = {
        symbol,
        side: 'LONG',
        quantity,
        entryPrice: price,
        currentPrice: price,
        unrealizedPnl: 0,
        realizedPnl: 0,
      };
      this.positions.set(symbol, position);
      this.balance -= price * quantity + commission;
    } else if (position.side === 'FLAT') {
      // 开多仓
      position.side = 'LONG';
      position.quantity = quantity;
      position.entryPrice = price;
      position.currentPrice = price;
      position.unrealizedPnl = 0;
      this.balance -= price * quantity + commission;
    } else if (position.side === 'SHORT') {
      // 平空仓
      const pnl = (position.entryPrice - price) * Math.min(quantity, position.quantity) - commission;
      position.realizedPnl += pnl;
      this.balance += pnl;
      
      // 记录交易
      this.trades.push({
        entryTime: 0, // TODO: 记录开仓时间
        exitTime: this.lastBarCache.get(symbol)!.timestamp,
        symbol,
        side: 'SHORT',
        quantity: Math.min(quantity, position.quantity),
        entryPrice: position.entryPrice,
        exitPrice: price,
        pnl,
        pnlPercent: pnl / (position.entryPrice * Math.min(quantity, position.quantity)),
      });
      
      if (quantity >= position.quantity) {
        // 完全平仓 + 反手开多
        const remaining = quantity - position.quantity;
        if (remaining > 0) {
          position.side = 'LONG';
          position.quantity = remaining;
          position.entryPrice = price;
          position.currentPrice = price;
          position.unrealizedPnl = 0;
          this.balance -= price * remaining + commission;
        } else {
          position.side = 'FLAT';
          position.quantity = 0;
        }
      } else {
        // 部分平仓
        position.quantity -= quantity;
      }
    } else if (position.side === 'LONG') {
      // 加多仓
      const totalCost = position.entryPrice * position.quantity + price * quantity;
      position.quantity += quantity;
      position.entryPrice = totalCost / position.quantity;
      this.balance -= price * quantity + commission;
    }
  }
  
  /**
   * 卖出后更新持仓
   */
  private updatePositionAfterSell(symbol: string, quantity: number, price: number, commission: number): void {
    let position = this.positions.get(symbol);
    
    if (!position) {
      // 新建空仓（现货不支持，这里仅演示）
      position = {
        symbol,
        side: 'SHORT',
        quantity,
        entryPrice: price,
        currentPrice: price,
        unrealizedPnl: 0,
        realizedPnl: 0,
      };
      this.positions.set(symbol, position);
      this.balance += price * quantity - commission;
    } else if (position.side === 'FLAT') {
      // 开空仓
      position.side = 'SHORT';
      position.quantity = quantity;
      position.entryPrice = price;
      position.currentPrice = price;
      position.unrealizedPnl = 0;
      this.balance += price * quantity - commission;
    } else if (position.side === 'LONG') {
      // 平多仓
      const pnl = (price - position.entryPrice) * Math.min(quantity, position.quantity) - commission;
      position.realizedPnl += pnl;
      this.balance += position.entryPrice * Math.min(quantity, position.quantity) + pnl;
      
      // 记录交易
      this.trades.push({
        entryTime: 0, // TODO: 记录开仓时间
        exitTime: this.lastBarCache.get(symbol)!.timestamp,
        symbol,
        side: 'LONG',
        quantity: Math.min(quantity, position.quantity),
        entryPrice: position.entryPrice,
        exitPrice: price,
        pnl,
        pnlPercent: pnl / (position.entryPrice * Math.min(quantity, position.quantity)),
      });
      
      if (quantity >= position.quantity) {
        // 完全平仓 + 反手开空
        const remaining = quantity - position.quantity;
        if (remaining > 0) {
          position.side = 'SHORT';
          position.quantity = remaining;
          position.entryPrice = price;
          position.currentPrice = price;
          position.unrealizedPnl = 0;
          this.balance += price * remaining - commission;
        } else {
          position.side = 'FLAT';
          position.quantity = 0;
        }
      } else {
        // 部分平仓
        position.quantity -= quantity;
      }
    } else if (position.side === 'SHORT') {
      // 加空仓
      const totalNotional = position.entryPrice * position.quantity + price * quantity;
      position.quantity += quantity;
      position.entryPrice = totalNotional / position.quantity;
      this.balance += price * quantity - commission;
    }
  }
  
  /**
   * 计算回测结果
   */
  private computeResult(): BacktestResult {
    const finalBalance = this.equity;
    const totalReturn = (finalBalance - this.config.initialBalance) / this.config.initialBalance;
    
    // 年化回报率
    const days = (this.config.endTime - this.config.startTime) / (24 * 60 * 60);
    const years = days / 365;
    const annualizedReturn = Math.pow(1 + totalReturn, 1 / years) - 1;
    
    // 胜率
    const winningTrades = this.trades.filter(t => t.pnl > 0).length;
    const losingTrades = this.trades.filter(t => t.pnl <= 0).length;
    const winRate = this.trades.length > 0 ? winningTrades / this.trades.length : 0;
    
    // 平均盈利/亏损
    const wins = this.trades.filter(t => t.pnl > 0);
    const losses = this.trades.filter(t => t.pnl <= 0);
    const averageWin = wins.length > 0 ? wins.reduce((sum, t) => sum + t.pnl, 0) / wins.length : 0;
    const averageLoss = losses.length > 0 ? Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0) / losses.length) : 0;
    
    // 盈亏比
    const totalWin = wins.reduce((sum, t) => sum + t.pnl, 0);
    const totalLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
    const profitFactor = totalLoss > 0 ? totalWin / totalLoss : 0;
    
    // 夏普比率（简化版：假设无风险利率 = 0）
    const returns = this.equityCurve.map((p, i) => {
      if (i === 0) return 0;
      return (p.equity - this.equityCurve[i - 1].equity) / this.equityCurve[i - 1].equity;
    });
    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0;
    
    return {
      initialBalance: this.config.initialBalance,
      finalBalance,
      totalReturn,
      annualizedReturn,
      maxDrawdown: this.maxDrawdown,
      sharpeRatio,
      winRate,
      totalTrades: this.trades.length,
      winningTrades,
      losingTrades,
      averageWin,
      averageLoss,
      profitFactor,
      equityCurve: this.equityCurve,
      trades: this.trades,
    };
  }
}
