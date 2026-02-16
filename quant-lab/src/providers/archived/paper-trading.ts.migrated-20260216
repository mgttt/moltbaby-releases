// ============================================================
// 模拟交易 Provider - 用于测试和回测
// ============================================================

import type {
  Order,
  Position,
  Account,
  OrderSide,
  PositionSide,
  Tick,
} from '../engine/types';
import type { Kline } from 'quant-lib';

/**
 * 模拟交易配置
 */
export interface PaperTradingConfig {
  initialBalance: number;
  commission: number;       // 手续费率（如 0.001 = 0.1%）
  slippage?: number;        // 滑点（如 0.0005 = 0.05%）
}

/**
 * 模拟交易 Provider
 * 
 * 用于测试策略，不连接真实交易所
 */
export class PaperTradingProvider {
  private config: PaperTradingConfig;
  
  // 账户状态
  private balance: number;
  private equity: number;
  private positions: Map<string, Position> = new Map();
  private orders: Order[] = [];
  private nextOrderId = 1;
  
  // 最新价格缓存
  private lastPrices: Map<string, number> = new Map();
  
  // K线订阅回调
  private klineCallbacks: Array<{
    symbols: string[];
    interval: string;
    callback: (bar: Kline) => void;
  }> = [];
  
  constructor(config: PaperTradingConfig) {
    this.config = config;
    this.balance = config.initialBalance;
    this.equity = config.initialBalance;
  }
  
  /**
   * 订阅 K线（模拟，需要外部推送数据）
   */
  async subscribeKlines(
    symbols: string[],
    interval: string,
    callback: (bar: Kline) => void
  ): Promise<void> {
    this.klineCallbacks.push({ symbols, interval, callback });
    console.log(`[PaperTradingProvider] 订阅 K线: ${symbols.join(', ')} ${interval}`);
  }
  
  /**
   * 推送 K线数据（由测试代码调用）
   */
  async pushKline(bar: Kline): Promise<void> {
    // 更新价格缓存
    this.lastPrices.set(bar.symbol, bar.close);
    
    // 更新持仓未实现盈亏
    this.updatePositions(bar.symbol, bar.close);
    
    // 调用订阅回调
    for (const sub of this.klineCallbacks) {
      if (sub.symbols.includes(bar.symbol) && sub.interval === bar.interval) {
        sub.callback(bar);
      }
    }
  }
  
  /**
   * 买入
   */
  async buy(symbol: string, quantity: number, price?: number, orderLinkId?: string): Promise<Order> {
    const lastPrice = this.lastPrices.get(symbol);
    if (!lastPrice && !price) {
      throw new Error(`No price available for ${symbol}`);
    }
    
    // 成交价格
    const fillPrice = price || lastPrice! * (1 + (this.config.slippage || 0));
    
    // 计算成本
    const cost = fillPrice * quantity;
    const commission = cost * this.config.commission;
    const totalCost = cost + commission;
    
    // 检查余额
    if (totalCost > this.balance) {
      throw new Error(`Insufficient balance: need ${totalCost.toFixed(2)}, have ${this.balance.toFixed(2)}`);
    }
    
    // 创建订单
    const order: Order = {
      orderId: orderLinkId || `PAPER-${this.nextOrderId++}`,  // P0 修复：使用 orderLinkId（如果提供）
      symbol,
      side: 'BUY',
      type: price ? 'LIMIT' : 'MARKET',
      quantity,
      price,
      status: 'FILLED',
      filledQuantity: quantity,
      filledPrice: fillPrice,
      timestamp: Date.now(),
      fillTimestamp: Date.now(),
      commission,
      commissionAsset: 'USDT',
    };
    
    this.orders.push(order);
    
    // 更新账户
    this.balance -= totalCost;
    
    // 更新持仓
    this.updatePositionAfterBuy(symbol, quantity, fillPrice);
    
    console.log(`[PaperTradingProvider] 买入: ${symbol} ${quantity} @ ${fillPrice.toFixed(2)}, 手续费: ${commission.toFixed(2)}`);
    
    return order;
  }
  
  /**
   * 卖出
   */
  async sell(symbol: string, quantity: number, price?: number, orderLinkId?: string): Promise<Order> {
    const lastPrice = this.lastPrices.get(symbol);
    if (!lastPrice && !price) {
      throw new Error(`No price available for ${symbol}`);
    }
    
    // 成交价格
    const fillPrice = price || lastPrice! * (1 - (this.config.slippage || 0));
    
    // 计算收入
    const revenue = fillPrice * quantity;
    const commission = revenue * this.config.commission;
    const netRevenue = revenue - commission;
    
    // 创建订单
    const order: Order = {
      orderId: orderLinkId || `PAPER-${this.nextOrderId++}`,  // P0 修复：使用 orderLinkId（如果提供）
      symbol,
      side: 'SELL',
      type: price ? 'LIMIT' : 'MARKET',
      quantity,
      price,
      status: 'FILLED',
      filledQuantity: quantity,
      filledPrice: fillPrice,
      timestamp: Date.now(),
      fillTimestamp: Date.now(),
      commission,
      commissionAsset: 'USDT',
    };
    
    this.orders.push(order);
    
    // 更新账户
    this.balance += netRevenue;
    
    // 更新持仓
    this.updatePositionAfterSell(symbol, quantity, fillPrice);
    
    console.log(`[PaperTradingProvider] 卖出: ${symbol} ${quantity} @ ${fillPrice.toFixed(2)}, 手续费: ${commission.toFixed(2)}`);
    
    return order;
  }
  
  /**
   * 取消订单（模拟盘不支持，因为都是立即成交）
   */
  async cancelOrder(orderId: string): Promise<void> {
    throw new Error('Paper trading does not support order cancellation (orders fill immediately)');
  }
  
  /**
   * 获取账户信息
   */
  async getAccount(): Promise<Account> {
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
  async getPosition(symbol: string): Promise<Position | null> {
    return this.positions.get(symbol) || null;
  }
  
  /**
   * 获取所有持仓
   */
  async getPositions(): Promise<Position[]> {
    return Array.from(this.positions.values()).filter(p => p.side !== 'FLAT');
  }
  
  /**
   * 更新持仓价格和未实现盈亏
   */
  private updatePositions(symbol: string, currentPrice: number): void {
    const position = this.positions.get(symbol);
    if (!position || position.side === 'FLAT') return;
    
    position.currentPrice = currentPrice;
    
    if (position.side === 'LONG') {
      position.unrealizedPnl = (currentPrice - position.entryPrice) * position.quantity;
    } else if (position.side === 'SHORT') {
      position.unrealizedPnl = (position.entryPrice - currentPrice) * position.quantity;
    }
    
    // 更新总权益
    let totalUnrealizedPnl = 0;
    for (const pos of this.positions.values()) {
      totalUnrealizedPnl += pos.unrealizedPnl;
    }
    
    this.equity = this.balance + totalUnrealizedPnl;
  }
  
  /**
   * 买入后更新持仓
   */
  private updatePositionAfterBuy(symbol: string, quantity: number, price: number): void {
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
    } else if (position.side === 'FLAT') {
      // 开多仓
      position.side = 'LONG';
      position.quantity = quantity;
      position.entryPrice = price;
      position.currentPrice = price;
      position.unrealizedPnl = 0;
    } else if (position.side === 'LONG') {
      // 加多仓
      const totalCost = position.entryPrice * position.quantity + price * quantity;
      position.quantity += quantity;
      position.entryPrice = totalCost / position.quantity;
    } else if (position.side === 'SHORT') {
      // 平空仓
      const pnl = (position.entryPrice - price) * Math.min(quantity, position.quantity);
      position.realizedPnl += pnl;
      
      if (quantity >= position.quantity) {
        // 完全平仓
        position.side = 'FLAT';
        position.quantity = 0;
      } else {
        // 部分平仓
        position.quantity -= quantity;
      }
    }
  }
  
  /**
   * 卖出后更新持仓
   */
  private updatePositionAfterSell(symbol: string, quantity: number, price: number): void {
    let position = this.positions.get(symbol);
    
    if (!position || position.side === 'FLAT') {
      // 现货不支持开空
      throw new Error('Cannot short spot assets in paper trading');
    }
    
    if (position.side === 'LONG') {
      // 平多仓
      const pnl = (price - position.entryPrice) * Math.min(quantity, position.quantity);
      position.realizedPnl += pnl;
      
      if (quantity >= position.quantity) {
        // 完全平仓
        position.side = 'FLAT';
        position.quantity = 0;
      } else {
        // 部分平仓
        position.quantity -= quantity;
      }
    }
  }
  
  /**
   * 获取所有订单
   */
  getOrders(): Order[] {
    return [...this.orders];
  }
  
  /**
   * P0-3: 获取单个订单
   */
  getOrder(orderId: string): Order | null {
    return this.orders.find(o => o.orderId === orderId) || null;
  }
  
  /**
   * 重置状态（用于测试）
   */
  reset(): void {
    this.balance = this.config.initialBalance;
    this.equity = this.config.initialBalance;
    this.positions.clear();
    this.orders = [];
    this.nextOrderId = 1;
    this.lastPrices.clear();
  }
}
