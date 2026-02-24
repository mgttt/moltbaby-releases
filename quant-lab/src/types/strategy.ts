/**
 * 策略接口定义 - 规范化接口契约
 * 
 * 版本: v1.0
 * 日期: 2026-02-23
 * 
 * 该文件定义了策略系统与引擎之间的完整接口契约，包括：
 * - IStrategy: 策略接口
 * - IStrategyContext: 策略运行时上下文
 * - BridgeFunctions: 桥接函数类型声明
 */

import type { Kline } from '../../../quant-lib/src';
import type { 
  Order, 
  Position, 
  Account, 
  Tick,
  OrderSide,
  PositionSide,
  OrderStatus,
  BacktestConfig,
  BacktestResult,
  LiveConfig
} from './engine/types';

// ============================================================
// 核心策略接口
// ============================================================

/**
 * 策略接口 - 所有策略必须实现
 * 
 * 生命周期: onInit → (onBar/onTick/onOrder/onExecution)* → onStop
 */
export interface IStrategy {
  /** 策略唯一标识 */
  readonly name: string;
  
  /** 策略版本 */
  readonly version?: string;

  /**
   * 策略初始化
   * 在交易开始前调用一次，用于设置初始状态和订阅
   * 
   * @param ctx 策略上下文，提供账户、订单、数据等API
   * @throws 初始化失败应抛出错误，引擎将停止该策略
   */
  onInit(ctx: IStrategyContext): Promise<void>;

  /**
   * K线更新回调
   * 每根K线收盘时调用（由引擎驱动的离散时间步进）
   * 
   * @param bar 当前K线数据
   * @param ctx 策略上下文
   */
  onBar(bar: Kline, ctx: IStrategyContext): Promise<void>;

  /**
   * Tick更新回调（可选）
   * 实盘高频策略使用，每次价格变动触发
   * 
   * @param tick 实时价格数据
   * @param ctx 策略上下文
   */
  onTick?(tick: Tick, ctx: IStrategyContext): Promise<void>;

  /**
   * 订单状态更新回调（可选）
   * 订单状态变化时触发（PENDING→FILLED/CANCELED等）
   * 
   * @param order 订单对象
   * @param ctx 策略上下文
   */
  onOrder?(order: Order, ctx: IStrategyContext): Promise<void>;

  /**
   * 成交事件回调（可选）
   * 通过WebSocket实时接收成交事件（比onOrder更细粒度）
   * 
   * @param execution 成交详情
   * @param ctx 策略上下文
   */
  onExecution?(execution: ExecutionEvent, ctx: IStrategyContext): Promise<void>;

  /**
   * 资金费结算回调（可选）
   * Bybit每8小时结算一次（08:00, 16:00, 00:00 UTC）
   * 
   * @param data 资金费数据
   * @param ctx 策略上下文
   */
  onFundingFee?(data: FundingFeeEvent, ctx: IStrategyContext): Promise<void>;

  /**
   * 策略停止回调（可选）
   * 策略被停止时调用，用于清理资源和保存状态
   * 
   * @param ctx 策略上下文
   */
  onStop?(ctx: IStrategyContext): Promise<void>;
}

// ============================================================
// 策略上下文接口
// ============================================================

/**
 * 策略运行时上下文
 * 
 * 引擎注入到策略的运行时环境，提供：
 * - 账户信息查询
 * - 订单操作（买/卖/撤单）
 * - 市场数据查询
 * - 日志记录
 */
export interface IStrategyContext {
  // -------------------- 账户信息 --------------------
  
  /** 获取完整账户状态 */
  getAccount(): Account;
  
  /** 获取指定品种的持仓 */
  getPosition(symbol: string): Position | null;
  
  /** 获取所有持仓 */
  getAllPositions(): Position[];

  // -------------------- 订单操作 --------------------
  
  /**
   * 买入（开多/平空）
   * @param symbol 交易品种
   * @param quantity 数量
   * @param price 限价（不传为市价）
   * @param orderLinkId 客户端自定义ID（用于幂等去重）
   * @returns 创建的订单
   */
  buy(symbol: string, quantity: number, price?: number, orderLinkId?: string): Promise<Order>;
  
  /**
   * 卖出（开空/平多）
   * @param symbol 交易品种
   * @param quantity 数量
   * @param price 限价（不传为市价）
   * @param orderLinkId 客户端自定义ID（用于幂等去重）
   * @returns 创建的订单
   */
  sell(symbol: string, quantity: number, price?: number, orderLinkId?: string): Promise<Order>;
  
  /**
   * 撤单
   * @param orderId 订单ID
   */
  cancelOrder(orderId: string): Promise<void>;
  
  /**
   * 改单（可选）
   * @param orderId 订单ID
   * @param price 新价格
   * @param qty 新数量
   */
  amendOrder?(orderId: string, price?: number, qty?: number): Promise<AmendResult>;
  
  /**
   * 撤销所有订单（可选）
   * @param symbol 指定品种（不传则撤销所有）
   */
  cancelAllOrders?(symbol?: string): Promise<CancelAllResult>;
  
  /**
   * 目标仓位下单（可选）
   * 直接下单到目标名义价值，引擎计算需要调整的仓位
   * @param side 方向
   * @param targetNotional 目标名义价值（USDT）
   */
  orderToTarget?(side: 'BUY' | 'SELL', targetNotional: number): Promise<TargetOrderResult>;

  // -------------------- 数据查询 --------------------
  
  /** 获取最新K线 */
  getLastBar(symbol: string): Kline | null;
  
  /** 获取最近N根K线 */
  getBars(symbol: string, limit: number): Kline[];
  
  /** 获取历史K线（REST回源） */
  getKlines?(symbol: string, interval: string, limit: number): Promise<Kline[]>;
  
  /** 获取资金费率 */
  getFundingRate?(symbol: string): Promise<FundingRateInfo>;
  
  /** 获取最优买卖价 */
  getBestBidAsk?(symbol: string): Promise<BidAskInfo>;
  
  /** 获取指标值 */
  getIndicator?(symbol: string, name: string): number | undefined;

  // -------------------- 日志 --------------------
  
  /**
   * 记录日志
   * @param message 日志内容
   * @param level 日志级别
   */
  log(message: string, level?: LogLevel): void;
  
  /** 信息日志 */
  logInfo(message: string): void;
  
  /** 警告日志 */
  logWarn(message: string): void;
  
  /** 错误日志 */
  logError(message: string): void;

  // -------------------- 热重载支持（T4） --------------------
  
  /** 获取当前runId（热重载幂等性保证） */
  getRunId?(): number;
  
  /** 获取当前orderSeq（热重载幂等性保证） */
  getOrderSeq?(): number;
  
  /** 获取策略状态值（热重载状态迁移用） */
  getStrategyState?(key: string): any;
  
  /** 设置策略状态值（热重载状态恢复用） */
  setStrategyState?(key: string, value: any): void;
}

// ============================================================
// 事件类型定义
// ============================================================

/** 成交事件 */
export interface ExecutionEvent {
  execId: string;
  orderId: string;
  orderLinkId?: string;
  symbol: string;
  side: string;
  execQty: number;
  execPrice: number;
  execTime: number;
}

/** 资金费事件 */
export interface FundingFeeEvent {
  symbol: string;
  fundingRate: number;
  fundingFee: number;
  timestamp: number;
}

/** 改单结果 */
export interface AmendResult {
  success: boolean;
  orderId: string;
  error?: string;
}

/** 批量撤单结果 */
export interface CancelAllResult {
  cancelledCount: number;
  failedCount?: number;
}

/** 目标仓位下单结果 */
export interface TargetOrderResult {
  success: boolean;
  orderId?: string;
  executedQty?: number;
  error?: string;
}

/** 资金费率信息 */
export interface FundingRateInfo {
  fundingRate: number;
  nextFundingTime: number;
}

/** 买卖价信息 */
export interface BidAskInfo {
  bid: number;
  ask: number;
  spread: number;
}

/** 日志级别 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// ============================================================
// 桥接函数类型声明（QuickJS策略使用）
// ============================================================

/**
 * 桥接函数集合 - 注入到QuickJS沙箱的全局函数
 * 
 * 策略通过调用这些函数与宿主引擎通信
 */
export interface BridgeFunctions {
  // -------------------- 日志桥接 --------------------
  bridge_log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  bridge_logInfo(message: string): void;
  bridge_logWarn(message: string): void;
  bridge_logError(message: string): void;

  // -------------------- 账户桥接 --------------------
  bridge_getBalance(): number;
  bridge_getEquity(): number;
  bridge_getPosition(symbol: string): Position | null;
  bridge_getAllPositions(): Position[];

  // -------------------- 订单桥接 --------------------
  bridge_buy(symbol: string, quantity: number, price?: number, orderLinkId?: string): Order;
  bridge_sell(symbol: string, quantity: number, price?: number, orderLinkId?: string): Order;
  bridge_cancelOrder(orderId: string): boolean;
  bridge_cancelAllOrders(symbol?: string): { cancelledCount: number };
  bridge_getOpenOrders(symbol?: string): Order[];
  bridge_getOrderHistory(symbol?: string, limit?: number): Order[];

  // -------------------- 数据桥接 --------------------
  bridge_getLastPrice(symbol: string): number;
  bridge_getBestBidAsk(symbol: string): { bid: number; ask: number };
  bridge_getLastBar(symbol: string): Kline | null;
  bridge_getBars(symbol: string, limit: number): Kline[];
  bridge_getKlines(symbol: string, interval: string, limit: number): Kline[];

  // -------------------- 状态桥接 --------------------
  bridge_getState(): Record<string, any>;
  bridge_setState(state: Record<string, any>): void;
  bridge_saveState(): boolean;

  // -------------------- 定时桥接 --------------------
  bridge_scheduleAt(interval: 'HOURLY' | 'DAILY', callbackName: string): void;
  bridge_setTimeout(callbackName: string, delayMs: number): void;
  bridge_setInterval(callbackName: string, intervalMs: number): void;
  bridge_clearTimeout(id: number): void;
  bridge_clearInterval(id: number): void;

  // -------------------- 熔断桥接 --------------------
  bridge_circuitBreak(reason: string): void;
  bridge_getCircuitBreakerState(): { enabled: boolean; triggered: boolean; reason?: string };

  // -------------------- 指标桥接 --------------------
  bridge_recordMetric(name: string, value: number, tags?: Record<string, string>): void;
  bridge_recordSimTrade?(data: SimTradeRecord): void;

  // -------------------- 通知桥接 --------------------
  bridge_sendAlert(level: 'info' | 'warning' | 'error', message: string): void;
  bridge_tgSend?(message: string): void;
}

/** 模拟交易记录 */
export interface SimTradeRecord {
  strategyId: string;
  symbol: string;
  side: string;
  price: number;
  qty: number;
  notional: number;
  timestamp: number;
  pnl?: number;
  equity?: number;
  metadata?: Record<string, any>;
}

// ============================================================
// 策略配置接口
// ============================================================

/**
 * 策略配置
 */
export interface IStrategyConfig {
  /** 策略唯一标识 */
  id: string;
  
  /** 策略名称 */
  name?: string;
  
  /** 是否启用 */
  enabled: boolean;
  
  /** 账号名称（paper-开头为模拟交易） */
  account: string;
  
  /** 策略代码路径 */
  code: string;
  
  /** 策略参数 */
  params: Record<string, any>;
  
  /** 调度表达式（cron格式，可选） */
  schedule?: string;
  
  /** 元数据 */
  meta?: {
    author?: string;
    created_at?: string;
    risk_level?: 'none' | 'low' | 'medium' | 'high';
    [key: string]: any;
  };
}

/**
 * 策略引擎配置
 */
export interface IEngineConfig {
  /** 状态保存目录 */
  stateDir?: string;
  
  /** 日志输出目录 */
  logDir?: string;
  
  /** 是否启用调试模式 */
  debug?: boolean;
  
  /** 回测配置（回测模式使用） */
  backtest?: BacktestConfig;
  
  /** 实盘配置（实盘模式使用） */
  live?: LiveConfig;
}

// ============================================================
// 重导出引擎类型
// ============================================================

export type {
  Order,
  Position,
  Account,
  Tick,
  OrderSide,
  PositionSide,
  OrderStatus,
  BacktestConfig,
  BacktestResult,
  LiveConfig
} from './engine/types';
