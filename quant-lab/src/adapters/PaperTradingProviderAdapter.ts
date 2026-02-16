/**
 * PaperTradingProviderAdapter
 * 
 * 适配器模式：桥接quant-lib PaperTradingProvider和quant-lab TradingProvider接口
 * 
 * 问题：
 * - quant-lab LiveEngine要求TradingProvider接口（getAccount/getPosition/getPositions）
 * - quant-lib PaperTradingProvider提供不同API（getAccountOverview/getAccountState等）
 * 
 * 解决：
 * - 创建适配器实现TradingProvider接口
 * - 内部委托quant-lib PaperTradingProvider
 * - 补齐API映射
 */

import type { TradingProvider } from '../engine/live';
import type { Account, Position, Order, Kline, Tick } from '../types';
import { PaperTradingProvider } from '../../../quant-lib/src/providers/paper-trading';

export class PaperTradingProviderAdapter implements TradingProvider {
  private provider: PaperTradingProvider;

  constructor(provider: PaperTradingProvider) {
    this.provider = provider;
  }

  /**
   * 订阅K线（委托给底层provider）
   */
  async subscribeKlines(
    symbols: string[],
    interval: string,
    callback: (bar: Kline) => void
  ): Promise<void> {
    // PaperTradingProvider有subscribeKlines方法
    if (this.provider.subscribeKlines) {
      return this.provider.subscribeKlines(symbols, interval, callback);
    }
    throw new Error('PaperTradingProvider.subscribeKlines not implemented');
  }

  /**
   * 订阅Tick（委托给底层provider）
   */
  async subscribeTicks(symbols: string[], callback: (tick: Tick) => void): Promise<void> {
    if (this.provider.subscribeTicks) {
      return this.provider.subscribeTicks(symbols, callback);
    }
    // PaperTradingProvider可能没有subscribeTicks，忽略
  }

  /**
   * 买入（委托给底层provider）
   */
  async buy(
    symbol: string,
    quantity: number,
    price?: number,
    orderLinkId?: string
  ): Promise<Order> {
    return this.provider.buy(symbol, quantity, price, orderLinkId);
  }

  /**
   * 卖出（委托给底层provider）
   */
  async sell(
    symbol: string,
    quantity: number,
    price?: number,
    orderLinkId?: string
  ): Promise<Order> {
    return this.provider.sell(symbol, quantity, price, orderLinkId);
  }

  /**
   * 取消订单（委托给底层provider）
   */
  async cancelOrder(orderId: string): Promise<void> {
    return this.provider.cancelOrder(orderId);
  }

  /**
   * 获取账户（适配：getAccountState → Account）
   */
  async getAccount(): Promise<Account> {
    const accountState = this.provider.getAccountState();
    return {
      balance: accountState.balance,
      equity: accountState.equity,
      availableBalance: accountState.balance, // 模拟器没有margin，全部可用
      unrealizedPnl: accountState.unrealizedPnl,
    };
  }

  /**
   * 获取单个持仓（适配：getPosition → Position）
   */
  async getPosition(symbol: string): Promise<Position | null> {
    const position = this.provider.getPosition(symbol);
    if (!position) return null;

    return {
      symbol: position.symbol,
      side: position.side,
      quantity: position.quantity,
      entryPrice: position.entryPrice,
      currentPrice: position.currentPrice || position.entryPrice,
      unrealizedPnl: position.unrealizedPnl || 0,
      realizedPnl: position.realizedPnl || 0,
    };
  }

  /**
   * 获取所有持仓（适配：getPositions → Position[]）
   */
  async getPositions(): Promise<Position[]> {
    const positions = this.provider.getPositions();
    return positions.map(p => ({
      symbol: p.symbol,
      side: p.side,
      quantity: p.quantity,
      entryPrice: p.entryPrice,
      currentPrice: p.currentPrice || p.entryPrice,
      unrealizedPnl: p.unrealizedPnl || 0,
      realizedPnl: p.realizedPnl || 0,
    }));
  }

  /**
   * 获取订单列表（可选，PaperTradingProvider可能没有）
   */
  async getOrders(): Promise<Order[]> {
    // PaperTradingProvider可能没有getOrders，返回空数组
    return [];
  }

  /**
   * 获取单个订单（可选，PaperTradingProvider可能没有）
   */
  async getOrder(orderId: string): Promise<Order | null> {
    // PaperTradingProvider可能没有getOrder，返回null
    return null;
  }
}
