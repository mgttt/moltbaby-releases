// ============================================================
// 策略运行时类型定义
// ============================================================

import type { Kline } from '../../../quant-lib/src';

/**
 * 交易方向
 */
export type OrderSide = 'BUY' | 'SELL';

/**
 * 订单类型
 */
export type OrderType = 'MARKET' | 'LIMIT';

/**
 * 订单状态
 */
export type OrderStatus = 'PENDING' | 'FILLED' | 'PARTIAL' | 'CANCELED' | 'REJECTED';

/**
 * 仓位方向
 */
export type PositionSide = 'LONG' | 'SHORT' | 'FLAT';

/**
 * Tick 数据（实时价格）
 */
export interface Tick {
  symbol: string;
  timestamp: number;
  price: number;
  volume?: number;
  bidPrice?: number;
  askPrice?: number;
}

/**
 * 订单
 */
export interface Order {
  orderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price?: number;        // LIMIT 订单需要
  status: OrderStatus;
  filledQuantity: number;
  filledPrice?: number;  // 成交均价
  timestamp: number;
  fillTimestamp?: number;
  commission?: number;
  commissionAsset?: string;
}

/**
 * 持仓
 */
export interface Position {
  symbol: string;
  side: PositionSide;
  quantity: number;          // 持仓数量（币数量）
  entryPrice: number;        // 开仓均价
  currentPrice: number;      // 当前价格（markPrice）
  unrealizedPnl: number;     // 未实现盈亏
  realizedPnl: number;       // 已实现盈亏
  positionNotional?: number; // P0 新增：持仓名义价值（USDT），可选字段
}

/**
 * 账户状态
 */
export interface Account {
  balance: number;          // 账户余额
  equity: number;           // 账户净值（余额 + 未实现盈亏）
  availableMargin?: number; // 可用保证金（可选，用于杠杆交易）
  positions: Position[];    // 持仓列表
  totalRealizedPnl: number; // 总已实现盈亏
  totalUnrealizedPnl: number; // 总未实现盈亏
}

/**
 * 策略上下文（策略可访问的 API）
 */
export interface StrategyContext {
  // 账户信息
  getAccount(): Account;
  getPosition(symbol: string): Position | null;
  
  // 订单操作
  buy(symbol: string, quantity: number, price?: number, orderLinkId?: string): Promise<Order>;
  sell(symbol: string, quantity: number, price?: number, orderLinkId?: string): Promise<Order>;
  cancelOrder(orderId: string): Promise<void>;
  
  // 数据查询
  getLastBar(symbol: string): Kline | null;
  getBars(symbol: string, limit: number): Kline[];
  /** 历史K线（REST回源，供缓存层使用） */
  getKlines?(symbol: string, interval: string, limit: number): Promise<Kline[]>;
  
  // 指标访问（如果使用 StreamingIndicators）
  getIndicator?(symbol: string, name: string): number | undefined;
  
  // 日志
  log(message: string, level?: 'info' | 'warn' | 'error'): void;
}

/**
 * 策略接口
 */
export interface Strategy {
  /**
   * 策略名称
   */
  name: string;
  
  /**
   * 策略初始化（在开始交易前调用）
   */
  onInit(ctx: StrategyContext): Promise<void>;
  
  /**
   * K线更新（每根 K线收盘时调用）
   */
  onBar(bar: Kline, ctx: StrategyContext): Promise<void>;
  
  /**
   * Tick 更新（可选，实盘高频策略使用）
   */
  onTick?(tick: Tick, ctx: StrategyContext): Promise<void>;
  
  /**
   * 订单状态更新（可选）
   */
  onOrder?(order: Order, ctx: StrategyContext): Promise<void>;
  
  /**
   * 策略停止（清理资源）
   */
  onStop?(ctx: StrategyContext): Promise<void>;
}

/**
 * 回测配置
 */
export interface BacktestConfig {
  // 回测资金
  initialBalance: number;
  
  // 回测品种
  symbols: string[];
  
  // 回测周期
  interval: string;  // '1d', '4h', '1h', etc.
  
  // 回测时间范围
  startTime: number;
  endTime: number;
  
  // 手续费率
  commission: number;  // 0.001 = 0.1%
  
  // 滑点（模拟市价单的滑点）
  slippage?: number;   // 0.0005 = 0.05%
}

/**
 * 回测结果
 */
export interface BacktestResult {
  // 基础指标
  initialBalance: number;
  finalBalance: number;
  totalReturn: number;        // 总回报率
  annualizedReturn: number;   // 年化回报率
  
  // 风险指标
  maxDrawdown: number;        // 最大回撤
  sharpeRatio: number;        // 夏普比率
  winRate: number;            // 胜率
  
  // 交易统计
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  averageWin: number;
  averageLoss: number;
  profitFactor: number;       // 盈亏比
  
  // 权益曲线
  equityCurve: Array<{ timestamp: number; equity: number }>;
  
  // 交易记录
  trades: Array<{
    entryTime: number;
    exitTime: number;
    symbol: string;
    side: OrderSide;
    quantity: number;
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    pnlPercent: number;
  }>;
}

/**
 * 实盘配置
 */
export interface LiveConfig {
  // 交易品种
  symbols: string[];
  
  // K线周期
  interval: string;
  
  // 初始余额（模拟交易时使用）
  initialBalance?: number;
  
  // 数据库路径（可选，用于持久化 K线）
  dbPath?: string;
  
  // WebSocket 配置
  wsEndpoint?: string;
  
  // API 配置（用于下单）
  apiKey?: string;
  apiSecret?: string;
  
  // 风控配置
  maxPositionSize?: number;   // 单个品种最大仓位
  maxDrawdown?: number;       // 最大回撤限制（触发后停止交易）
  stopOnError?: boolean;      // 策略执行错误时是否停止
  
  // 指标配置（可选）
  indicators?: Record<string, import('quant-lib').IndicatorConfig>;
}
