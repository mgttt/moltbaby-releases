/**
 * PaperTradingProviderAdapter
 * 
 * 适配器模式：桥接quant-lib PaperTradingProvider和quant-lab TradingProvider接口
 * 
 * 问题：
 * - quant-lab LiveEngine要求TradingProvider接口（getAccount/getPosition/getPositions/buy/sell等）
 * - quant-lib PaperTradingProvider提供不同API（placeOrder/getAccountOverview/getBalance等）
 * 
 * 解决（按鲶鱼5点建议）：
 * 1. getAccount映射：getAccountOverview + getPositions + getBalance
 * 2. buy/sell映射：placeOrder({side:'Buy'|'Sell'})
 * 3. cancelOrder映射：boolean → void/throw
 * 4. subscribeKlines处理：手动feed（注册callback，提供pushKline）
 * 5. 类型对齐：使用engine/types.ts的Account/Order/Position
 */

import type { TradingProvider } from '../engine/live';
import type { Account, Position, Order } from '../engine/types';
import type { Kline, Tick } from '../../../quant-lib/src';
import { PaperTradingProvider } from '../../../quant-lib/src/providers/paper-trading';

export class PaperTradingProviderAdapter implements TradingProvider {
  private provider: PaperTradingProvider;
  private klineCallbacks: Map<string, (bar: Kline) => void> = new Map();

  constructor(provider: PaperTradingProvider) {
    this.provider = provider;
  }

  /**
   * 订阅K线（手动feed模式）
   * 
   * PaperTradingProvider不支持subscribeKlines
   * 方案A：Adapter内提供pushKline方法供测试调用
   */
  async subscribeKlines(
    symbols: string[],
    interval: string,
    callback: (bar: Kline) => void
  ): Promise<void> {
    // 注册callback
    const key = `${symbols.join(',')}-${interval}`;
    this.klineCallbacks.set(key, callback);
  }

  /**
   * 推送K线（供测试调用）
   */
  pushKline(bar: Kline): void {
    // 触发所有匹配的callback
    for (const [key, callback] of this.klineCallbacks) {
      callback(bar);
    }
  }

  /**
   * 订阅Tick（可选，PaperTradingProvider不支持）
   */
  async subscribeTicks(symbols: string[], callback: (tick: Tick) => void): Promise<void> {
    // PaperTradingProvider不支持subscribeTicks，忽略
  }

  /**
   * 买入（映射：placeOrder）
   * 
   * C项修正（鲶鱼建议）：
   * - filledQuantity = filledQty
   * - filledPrice = avgPrice
   * - status映射：Pending→PENDING, Filled→FILLED, PartiallyFilled→PARTIAL, Cancelled→CANCELED
   * - timestamp = createdAt
   */
  async buy(
    symbol: string,
    quantity: number,
    price?: number,
    orderLinkId?: string
  ): Promise<Order> {
    const result = await this.provider.placeOrder({
      symbol,
      side: 'Buy',
      orderType: price ? 'Limit' : 'Market',
      qty: quantity,
      price,
    });

    // 检查结果
    if (!result.success || !result.order) {
      throw new Error(`Buy order failed: ${result.error || 'unknown'}`);
    }

    // 映射PaperOrder → quant-lab Order
    const order = result.order;
    return {
      orderId: order.orderId,
      symbol: order.symbol,
      side: 'BUY',
      type: order.orderType === 'Limit' ? 'LIMIT' : 'MARKET',
      quantity: order.qty,
      price: order.price,
      filledQuantity: order.filledQty,
      filledPrice: order.avgPrice,
      status: this.mapOrderStatus(order.status),
      timestamp: order.createdAt,
    };
  }

  /**
   * 卖出（映射：placeOrder）
   * 
   * C项修正（鲶鱼建议）：同buy
   */
  async sell(
    symbol: string,
    quantity: number,
    price?: number,
    orderLinkId?: string
  ): Promise<Order> {
    const result = await this.provider.placeOrder({
      symbol,
      side: 'Sell',
      orderType: price ? 'Limit' : 'Market',
      qty: quantity,
      price,
    });

    // 检查结果
    if (!result.success || !result.order) {
      throw new Error(`Sell order failed: ${result.error || 'unknown'}`);
    }

    // 映射PaperOrder → quant-lab Order
    const order = result.order;
    return {
      orderId: order.orderId,
      symbol: order.symbol,
      side: 'SELL',
      type: order.orderType === 'Limit' ? 'LIMIT' : 'MARKET',
      quantity: order.qty,
      price: order.price,
      filledQuantity: order.filledQty,
      filledPrice: order.avgPrice,
      status: this.mapOrderStatus(order.status),
      timestamp: order.createdAt,
    };
  }

  /**
   * 映射订单状态（C项修正）
   */
  private mapOrderStatus(status: string): string {
    const statusMap: Record<string, string> = {
      'Pending': 'PENDING',
      'Filled': 'FILLED',
      'PartiallyFilled': 'PARTIAL',
      'Cancelled': 'CANCELED',
      'Rejected': 'REJECTED',
    };
    return statusMap[status] || status.toUpperCase();
  }

  /**
   * 取消订单（映射：boolean → void/throw）
   */
  async cancelOrder(orderId: string): Promise<void> {
    const success = await this.provider.cancelOrder(orderId);
    if (!success) {
      throw new Error(`Failed to cancel order: ${orderId}`);
    }
  }

  /**
   * 获取账户（映射：getAccountOverview + getPositions）
   * 
   * A项修正（鲶鱼建议）：
   * - balance = availableBalance
   * - equity = totalEquity
   * - PnL用realisedPnl/unrealisedPnl
   */
  async getAccount(): Promise<Account> {
    // 1. 获取账户概览
    const overview = await this.provider.getAccountOverview();

    // 2. 获取所有持仓
    const paperPositions = await this.provider.getPositions();

    // 3. 映射成quant-lab Account（类型对齐engine/types.ts）
    return {
      balance: overview.availableBalance,
      equity: overview.totalEquity,
      positions: paperPositions.map(p => ({
        symbol: p.symbol,
        side: p.side === 'Buy' ? 'LONG' : 'SHORT',
        quantity: p.size,
        entryPrice: p.avgPrice,
        currentPrice: p.markPrice,
        unrealizedPnl: p.unrealisedPnl,
        realizedPnl: 0, // PaperPosition没有单独的realizedPnl字段
      })),
      totalRealizedPnl: overview.realisedPnl,
      totalUnrealizedPnl: overview.unrealisedPnl,
    };
  }

  /**
   * 获取单个持仓（映射：getPosition）
   * 
   * B项修正（鲶鱼建议）：
   * - quantity = size
   * - entryPrice = avgPrice
   * - currentPrice = markPrice
   * - unrealizedPnl = unrealisedPnl
   */
  async getPosition(symbol: string): Promise<Position | null> {
    const position = await this.provider.getPosition(symbol);
    if (!position) return null;

    return {
      symbol: position.symbol,
      side: position.side === 'Buy' ? 'LONG' : 'SHORT',
      quantity: position.size,
      entryPrice: position.avgPrice,
      currentPrice: position.markPrice,
      unrealizedPnl: position.unrealisedPnl,
      realizedPnl: 0, // PaperPosition没有单独的realizedPnl字段
    };
  }

  /**
   * 获取所有持仓（映射：getPositions）
   * 
   * B项修正（鲶鱼建议）：字段映射同getPosition
   */
  async getPositions(): Promise<Position[]> {
    const positions = await this.provider.getPositions();
    return positions.map(p => ({
      symbol: p.symbol,
      side: p.side === 'Buy' ? 'LONG' : 'SHORT',
      quantity: p.size,
      entryPrice: p.avgPrice,
      currentPrice: p.markPrice,
      unrealizedPnl: p.unrealisedPnl,
      realizedPnl: 0,
    }));
  }

  /**
   * 获取订单列表（可选，PaperTradingProvider可能没有）
   */
  async getOrders(): Promise<Order[]> {
    // PaperTradingProvider没有getOrders，返回空数组
    return [];
  }

  /**
   * 获取单个订单（可选，PaperTradingProvider可能没有）
   */
  async getOrder(orderId: string): Promise<Order | null> {
    // PaperTradingProvider没有getOrder，返回null
    return null;
  }
}
