// ============================================================
// Bybit Strategy Context - 实盘交易上下文
// ============================================================

import type { StrategyContext, Order, Position, Account } from '../engine/types';
import type { Kline } from '../../../quant-lib/src';
import type { BybitProvider } from '../../quant-lib/src/providers/bybit';

/**
 * Bybit 策略上下文配置
 */
export interface BybitStrategyContextConfig {
  provider: BybitProvider;
  symbol: string;
  
  // 精度配置（可选，默认 MYX 规格）
  qtyStep?: number;   // 数量步长（默认 1）
  tickSize?: number;  // 价格步长（默认 0.001）
  minQty?: number;    // 最小下单量（默认 1）
}

/**
 * Bybit 策略上下文 - 实现 StrategyContext 接口
 * 
 * 职责：
 * - 精度截断（qty/price）
 * - 下单前校验（minQty）
 * - 调用 BybitProvider API
 */
export class BybitStrategyContext implements StrategyContext {
  private provider: BybitProvider;
  private symbol: string;
  
  // 精度配置
  private qtyStep: number;
  private tickSize: number;
  private minQty: number;
  
  // K线缓存
  private lastBar: Kline | null = null;
  private barHistory: Kline[] = [];
  
  constructor(config: BybitStrategyContextConfig) {
    this.provider = config.provider;
    this.symbol = config.symbol;
    
    // 默认 MYX 规格
    this.qtyStep = config.qtyStep ?? 1;
    this.tickSize = config.tickSize ?? 0.001;
    this.minQty = config.minQty ?? 1;
  }
  
  // ============================================================
  // 账户信息
  // ============================================================
  
  getAccount(): Account {
    // QuickJS 沙箱不支持异步 getter，这里返回缓存值
    // 实际使用时需要定期更新缓存
    throw new Error('getAccount() must be called asynchronously via bridge API');
  }
  
  getPosition(symbol: string): Position | null {
    // 同上，需要异步调用
    throw new Error('getPosition() must be called asynchronously via bridge API');
  }
  
  // ============================================================
  // 订单操作（精度截断）
  // ============================================================
  
  /**
   * 买入（做多）
   * 
   * 精度截断：
   * - qty: Math.floor(qty / qtyStep) * qtyStep
   * - price: Math.round(price / tickSize) * tickSize
   * - qty < minQty → 跳过下单
   * 
   * P0修复：添加orderLinkId参数（幂等性保护）
   */
  async buy(symbol: string, quantity: number, price?: number, orderLinkId?: string): Promise<Order> {
    // 1. 数量截断（向下取整）
    const truncatedQty = Math.floor(quantity / this.qtyStep) * this.qtyStep;
    
    // 2. 检查最小下单量
    if (truncatedQty < this.minQty) {
      this.log(`[BybitContext] 跳过下单：qty=${truncatedQty} < minQty=${this.minQty}`, 'warn');
      throw new Error(`Order quantity ${truncatedQty} below minimum ${this.minQty}`);
    }
    
    // 3. 价格截断（四舍五入）
    let truncatedPrice: number | undefined;
    if (price !== undefined) {
      truncatedPrice = Math.round(price / this.tickSize) * this.tickSize;
    }
    
    // 4. 日志
    this.log(
      `[BybitContext] 买入 ${symbol}: qty=${truncatedQty} (原${quantity}), price=${truncatedPrice || 'Market'}, orderLinkId=${orderLinkId || 'auto'}`,
      'info'
    );
    
    // 5. 调用 Provider（P0：透传orderLinkId）
    return this.provider.buy(symbol, truncatedQty, truncatedPrice, orderLinkId);
  }
  
  /**
   * 卖出（做空）
   * 
   * 精度截断规则同 buy()
   * P0修复：添加orderLinkId参数（幂等性保护）
   */
  async sell(symbol: string, quantity: number, price?: number, orderLinkId?: string): Promise<Order> {
    // 1. 数量截断（向下取整）
    const truncatedQty = Math.floor(quantity / this.qtyStep) * this.qtyStep;
    
    // 2. 检查最小下单量
    if (truncatedQty < this.minQty) {
      this.log(`[BybitContext] 跳过下单：qty=${truncatedQty} < minQty=${this.minQty}`, 'warn');
      throw new Error(`Order quantity ${truncatedQty} below minimum ${this.minQty}`);
    }
    
    // 3. 价格截断（四舍五入）
    let truncatedPrice: number | undefined;
    if (price !== undefined) {
      truncatedPrice = Math.round(price / this.tickSize) * this.tickSize;
    }
    
    // 4. 日志
    this.log(
      `[BybitContext] 卖出 ${symbol}: qty=${truncatedQty} (原${quantity}), price=${truncatedPrice || 'Market'}, orderLinkId=${orderLinkId || 'auto'}`,
      'info'
    );
    
    // 5. 调用 Provider（P0：透传orderLinkId）
    return this.provider.sell(symbol, truncatedQty, truncatedPrice, orderLinkId);
  }
  
  /**
   * 取消订单
   */
  async cancelOrder(orderId: string): Promise<void> {
    this.log(`[BybitContext] 取消订单: ${orderId}`, 'info');
    return this.provider.cancelOrder(orderId);
  }
  
  // ============================================================
  // 数据查询
  // ============================================================
  
  getLastBar(symbol: string): Kline | null {
    return this.lastBar;
  }
  
  getBars(symbol: string, limit: number): Kline[] {
    return this.barHistory.slice(-limit);
  }
  
  /**
   * 更新 K线缓存（由外部调用）
   */
  updateBar(bar: Kline): void {
    this.lastBar = bar;
    this.barHistory.push(bar);
    
    // 保留最近 100 根
    if (this.barHistory.length > 100) {
      this.barHistory.shift();
    }
  }
  
  // ============================================================
  // 日志
  // ============================================================
  
  log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : 'ℹ️';
    console.log(`${prefix} ${message}`);
  }
  
  // ============================================================
  // 异步 API（供 Bridge 调用）
  // ============================================================
  
  /**
   * 获取账户信息（异步）
   */
  async getAccountAsync(): Promise<Account> {
    return this.provider.getAccount();
  }
  
  /**
   * 获取持仓（异步）
   */
  async getPositionAsync(symbol: string): Promise<Position | null> {
    return this.provider.getPosition(symbol);
  }
  
  /**
   * 获取所有持仓（异步）
   * P0 修复：供 QuickJSStrategy.refreshCache() 调用
   */
  async getPositionsAsync(): Promise<Position[]> {
    return this.provider.getPositions();
  }

  /**
   * P2修复：获取未完成订单（订单闭环对账 - bot-009/鲶鱼建议）
   */
  async getOpenOrders(symbol?: string, limit: number = 50): Promise<any[]> {
    // Bybit 要求至少提供 symbol / settleCoin / baseCoin；策略侧默认用当前 ctx.symbol
    return this.provider.getOpenOrders(symbol ?? this.symbol, 'linear', limit);
  }

  /**
   * P2修复：获取成交记录（订单闭环对账 - bot-009/鲶鱼建议）
   */
  async getExecutions(symbol?: string, limit: number = 50, startTime?: number): Promise<any[]> {
    return this.provider.getExecutions(symbol ?? this.symbol, 'linear', limit, startTime);
  }
}
