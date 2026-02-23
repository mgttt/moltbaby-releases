// ============================================================
import { createLogger } from '../utils/logger';
const logger = createLogger('LiveEngine');
// 实盘引擎
// ============================================================

import { join } from 'node:path';
import type {
  Strategy,
  StrategyContext,
  LiveConfig,
  Order,
  Position,
  Account,
  OrderSide,
  PositionSide,
  Tick,
} from './types';
import type { Kline } from '../../../quant-lib/src';
import { KlineDatabase, StreamingIndicators } from '../../../quant-lib/src';
import { NdtsdbRpcKlineStore } from '../storage/ndtsdb-rpc-store';

/**
 * Trading Provider 接口（可选）
 */
export interface TradingProvider {
  subscribeKlines(symbols: string[], interval: string, callback: (bar: Kline) => void): Promise<void>;
  subscribeTicks?(symbols: string[], callback: (tick: Tick) => void): Promise<void>;
  subscribeExecutions?(callback: (execution: any) => void): Promise<void>;  // [P1] 实时成交订阅
  buy(symbol: string, quantity: number, price?: number, orderLinkId?: string): Promise<Order>;
  sell(symbol: string, quantity: number, price?: number, orderLinkId?: string): Promise<Order>;
  cancelOrder(orderId: string): Promise<void>;
  amendOrder?(orderId: string, price?: number, qty?: number): Promise<{ success: boolean; orderId: string }>;
  cancelAllOrders?(symbol?: string): Promise<{ cancelledCount: number }>;
  getFundingRate?(symbol: string): Promise<{ fundingRate: number; nextFundingTime: number }>;
  getBestBidAsk?(symbol: string): Promise<{ bid: number; ask: number; spread: number }>;
  getAccount(): Promise<Account>;
  getPosition(symbol: string): Promise<Position | null>;
  getPositions(): Promise<Position[]>;
  // P0-3: 订单状态轮询
  getOrders?(): Promise<Order[]>;
  getOrder?(orderId: string): Promise<Order | null>;
}

/**
 * 实盘引擎
 */
export class LiveEngine {
  private strategy: Strategy;
  private config: LiveConfig;
  private db?: KlineDatabase | NdtsdbRpcKlineStore;
  private provider?: TradingProvider;

  // 运行状态
  private running = false;
  private stopped = false;

  // 账户状态（如果没有 Provider，则自己管理）
  private balance: number = 0;
  private equity: number = 0;
  private positions: Map<string, Position> = new Map();
  private orders: Order[] = [];

  // K线缓存
  private lastBarCache: Map<string, Kline> = new Map();
  private barCache: Map<string, Kline[]> = new Map();

  // 指标管理器（可选）
  private indicators?: StreamingIndicators;

  // WebSocket 连接（抽象，实际由 Provider 提供）
  private wsHandlers: Map<string, (data: any) => void> = new Map();

  // P0-3: 订单状态轮询
  private orderPollInterval: number = 5000; // 5秒轮询一次
  private orderPollTimer?: NodeJS.Timeout;
  private trackedOrderIds: Set<string> = new Set(); // 跟踪未完成订单

  // P1新增：资金费结算检测
  private fundingFeeCheckInterval: number = 60000; // 1分钟检查一次
  private fundingFeeCheckTimer?: NodeJS.Timeout;
  private lastFundingFeeTime: Map<string, number> = new Map(); // symbol -> last checked timestamp

  constructor(strategy: Strategy, config: LiveConfig, provider?: TradingProvider) {
    this.strategy = strategy;
    this.config = config;
    this.provider = provider;

    // 如果配置了数据库，则初始化
    if (config.dbPath) {
      if (config.dbPath.startsWith('rpc://')) {
        const url = new URL(config.dbPath);
        const binaryPath = url.searchParams.get('binary') || undefined;
        this.db = new NdtsdbRpcKlineStore({
          dbPath: url.pathname || join(process.cwd(), 'runtime/quant-lab/rpc-ndtsdb'),
          binaryPath,
          requestTimeoutMs: Number(url.searchParams.get('requestTimeoutMs') || '3000'),
          maxRetries: Number(url.searchParams.get('retries') || '3'),
          retryDelayMs: Number(url.searchParams.get('retryDelayMs') || '120'),
          fallbackEnabled: url.searchParams.get('fallback') !== 'false',
        });
      } else {
        this.db = new KlineDatabase({ path: config.dbPath });
      }
    }

    // 初始化指标管理器
    if (config.indicators) {
      this.indicators = new StreamingIndicators();
      for (const [symbol, indicatorConfig] of Object.entries(config.indicators)) {
        this.indicators.addSymbol(symbol, indicatorConfig);
      }
    }
  }

  /**
   * 启动实盘引擎
   */
  async start(): Promise<void> {
    logger.info(`[LiveEngine] 启动实盘引擎: ${this.strategy.name}`);
    console.log(`  品种: ${this.config.symbols.join(', ')}`);
    console.log(`  周期: ${this.config.interval}`);

    this.running = true;
    this.stopped = false;

    // 初始化数据库
    if (this.db) {
      await this.db.init();
    }

    // 加载初始账户状态（从 Provider）
    await this.loadAccount();

    // 初始化策略
    const ctx = this.createContext();
    await this.strategy.onInit(ctx);

    // 订阅 K线（需要外部 Provider 实现）
    await this.subscribeKlines();

    // P0-3: 启动订单状态轮询
    this.startOrderPolling();

    // [P1] 启动实时 execution 订阅（消除accountGap根源）
    this.startExecutionSubscription();

    // P1新增：启动资金费结算检测
    this.startFundingFeeCheck();

    console.log(`[LiveEngine] 实盘引擎启动完成`);
  }

  /**
   * 停止实盘引擎
   */
  async stop(): Promise<void> {
    console.log(`[LiveEngine] 停止实盘引擎`);

    this.running = false;
    this.stopped = true;

    // P0-3: 停止订单轮询
    if (this.orderPollTimer) {
      clearInterval(this.orderPollTimer);
      this.orderPollTimer = undefined;
    }

    // P1新增：停止资金费结算检测
    this.stopFundingFeeCheck();

    // 调用策略停止
    const ctx = this.createContext();
    if (this.strategy.onStop) {
      await this.strategy.onStop(ctx);
    }

    // 关闭数据库
    if (this.db) {
      await this.db.close();
    }

    console.log(`[LiveEngine] 实盘引擎已停止`);
  }

  /**
   * 加载账户状态（从 Provider）
   */
  private async loadAccount(): Promise<void> {
    if (this.provider) {
      const account = await this.provider.getAccount();
      this.balance = account.balance;
      this.equity = account.equity;
      this.positions = new Map(account.positions.map(p => [p.symbol, p]));
      console.log(`[LiveEngine] 账户初始化（Provider）: $${this.balance.toLocaleString()}`);
    } else {
      // 无 Provider：使用配置的初始余额
      this.balance = this.config.initialBalance || 10000;
      this.equity = this.balance;
      console.log(`[LiveEngine] 账户初始化（模拟）: $${this.balance.toLocaleString()}`);
    }
  }

  /**
   * 订阅 K线（需要外部 Provider 实现）
   */
  private async subscribeKlines(): Promise<void> {
    if (this.provider) {
      // 使用 Provider 订阅
      await this.provider.subscribeKlines(
        this.config.symbols,
        this.config.interval,
        (bar) => this.onKlineUpdate(bar)
      );
      console.log(`[LiveEngine] 订阅 K线（Provider）: ${this.config.symbols.join(', ')} ${this.config.interval}`);
    } else {
      // 无 Provider：注册回调（由外部推送）
      for (const symbol of this.config.symbols) {
        const topic = `kline_${this.config.interval}_${symbol}`;

        this.wsHandlers.set(topic, async (data: any) => {
          await this.onKlineUpdate(data);
        });

        console.log(`[LiveEngine] 订阅 K线（手动）: ${symbol} ${this.config.interval}`);
      }
    }
  }

  /**
   * K线更新回调（由 Provider 调用）
   */
  async onKlineUpdate(bar: Kline): Promise<void> {
    if (!this.running) return;

    // 更新缓存
    this.updateBarCache(bar);

    // 更新持仓价格
    this.updatePositions(bar);

    // 更新指标
    if (this.indicators) {
      this.indicators.update(bar.symbol, bar.close, bar.timestamp);
    }

    // 持久化到数据库（可选）
    if (this.db) {
      await this.db.upsertKlines([bar]);
    }

    // 调用策略
    const ctx = this.createContext();
    try {
      await this.strategy.onBar(bar, ctx);
    } catch (error: any) {
      console.error(`[LiveEngine] 策略执行错误:`, error.message);

      // 风控：如果策略执行失败，是否停止？
      if (this.config.stopOnError) {
        await this.stop();
      }
    }

    // 检查风控
    this.checkRiskControl();
  }

  /**
   * Tick 更新回调（可选，高频策略使用）
   */
  async onTickUpdate(tick: Tick): Promise<void> {
    if (!this.running) return;
    if (!this.strategy.onTick) return;

    const ctx = this.createContext();
    try {
      await this.strategy.onTick(tick, ctx);
    } catch (error: any) {
      console.error(`[LiveEngine] 策略 Tick 处理错误:`, error.message);
    }
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

    // 保留最近 1000 根
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
      cancelOrder: async (orderId: string) => this.cancelOrder(orderId),
      getLastBar: (symbol: string) => this.lastBarCache.get(symbol) || null,
      getBars: (symbol: string, limit: number) => {
        const cache = this.barCache.get(symbol) || [];
        return cache.slice(-limit);
      },
      getFundingRate: async (symbol: string) => {
        if (this.provider?.getFundingRate) {
          return await this.provider.getFundingRate(symbol);
        }
        return { fundingRate: 0, nextFundingTime: 0 };
      },
      getBestBidAsk: async (symbol: string) => {
        if (this.provider?.getBestBidAsk) {
          return await this.provider.getBestBidAsk(symbol);
        }
        const bar = this.lastBarCache.get(symbol);
        if (bar) {
          const spreadPct = 0.001;
          const bid = bar.close * (1 - spreadPct / 2);
          const ask = bar.close * (1 + spreadPct / 2);
          return { bid, ask, spread: ask - bid };
        }
        return { bid: 0, ask: 0, spread: 0 };
      },
      orderToTarget: async (side: 'BUY' | 'SELL', targetNotional: number) => {
        // P1新增：目标仓位下单
        try {
          // 获取当前持仓
          const symbol = this.config.symbols[0]; // 默认使用第一个品种
          const position = this.positions.get(symbol);
          const currentNotional = position ? position.quantity * position.currentPrice : 0;

          // 计算需要调整的仓位
          let deltaNotional = 0;
          if (side === 'BUY') {
            deltaNotional = targetNotional - currentNotional;
          } else {
            deltaNotional = currentNotional - targetNotional;
          }

          if (Math.abs(deltaNotional) < 1) {
            return { success: true, executedQty: 0, message: 'No adjustment needed' };
          }

          // 获取当前价格
          const bar = this.lastBarCache.get(symbol);
          if (!bar) {
            return { success: false, error: 'No price available' };
          }

          const price = side === 'BUY' ? bar.close * 1.001 : bar.close * 0.999; // 轻微滑点
          const qty = deltaNotional / price;

          // 执行订单
          let order: Order;
          if (side === 'BUY') {
            order = await this.buy(symbol, qty, price);
          } else {
            order = await this.sell(symbol, qty, price);
          }

          return {
            success: true,
            orderId: order.orderId,
            executedQty: order.filledQuantity
          };
        } catch (error: any) {
          return { success: false, error: error.message };
        }
      },
      getIndicator: this.indicators ? (symbol: string, name: string) => {
        // TODO: 实现指标访问
        return undefined;
      } : undefined,
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
    // 如果有 Provider，应该从 Provider 同步（但这里为了简化，直接返回本地缓存）
    // 在实际使用中，可以定期从 Provider 同步账户状态

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
   * 从 Provider 同步账户状态（可选，定期调用）
   */
  async syncAccount(): Promise<void> {
    if (!this.provider) return;

    const account = await this.provider.getAccount();
    this.balance = account.balance;
    this.equity = account.equity;
    this.positions = new Map(account.positions.map(p => [p.symbol, p]));

    console.log(`[LiveEngine] 账户同步完成: 余额=$${this.balance.toFixed(2)}, 权益=$${this.equity.toFixed(2)}`);
  }

  /**
   * 买入（开多仓或平空仓）
   */
  private async buy(symbol: string, quantity: number, price?: number, orderLinkId?: string): Promise<Order> {
    // 检查风控
    if (this.config.maxPositionSize && quantity > this.config.maxPositionSize) {
      throw new Error(`Position size ${quantity} exceeds max ${this.config.maxPositionSize}`);
    }

    logger.debug(`buy() symbol=${symbol} qty=${quantity} price=${price} orderLinkId=${orderLinkId}`);

    let order: Order;

    if (this.provider) {
      // 使用 Provider 执行订单
      order = await this.provider.buy(symbol, quantity, price, orderLinkId);
      console.log(`[LiveEngine] 买入订单成交（Provider）: ${symbol} ${quantity} @ ${order.filledPrice}`);
    } else {
      // 无 Provider：模拟成交
      const bar = this.lastBarCache.get(symbol);
      if (!bar) {
        throw new Error(`No price available for ${symbol}`);
      }

      order = {
        orderId: `${Date.now()}-${Math.random()}`,
        symbol,
        side: 'BUY',
        type: price ? 'LIMIT' : 'MARKET',
        quantity,
        price,
        status: 'FILLED',
        filledQuantity: quantity,
        filledPrice: price || bar.close,
        timestamp: Date.now(),
        fillTimestamp: Date.now(),
      };

      // 更新持仓（简化版）
      this.updatePositionAfterBuy(symbol, quantity, order.filledPrice!);

      console.log(`[LiveEngine] 买入订单成交（模拟）: ${symbol} ${quantity} @ ${order.filledPrice}`);
    }

    this.orders.push(order);

    // P0-3: 如果订单未完成，加入跟踪列表
    if (order.status === 'PENDING' || order.status === 'PARTIAL_FILLED') {
      this.trackedOrderIds.add(order.orderId);
      console.log(`[LiveEngine] 开始跟踪订单: ${order.orderId}`);
    }

    // 调用策略的 onOrder 回调（如果有）
    if (this.strategy.onOrder) {
      const ctx = this.createContext();
      await this.strategy.onOrder(order, ctx);
    }

    return order;
  }

  /**
   * 卖出（开空仓或平多仓）
   */
  private async sell(symbol: string, quantity: number, price?: number, orderLinkId?: string): Promise<Order> {
    logger.debug(`sell() symbol=${symbol} qty=${quantity} price=${price} orderLinkId=${orderLinkId}`);

    let order: Order;

    if (this.provider) {
      // 使用 Provider 执行订单
      order = await this.provider.sell(symbol, quantity, price, orderLinkId);
      console.log(`[LiveEngine] 卖出订单成交（Provider）: ${symbol} ${quantity} @ ${order.filledPrice}`);
    } else {
      // 无 Provider：模拟成交
      const bar = this.lastBarCache.get(symbol);
      if (!bar) {
        throw new Error(`No price available for ${symbol}`);
      }

      order = {
        orderId: `${Date.now()}-${Math.random()}`,
        symbol,
        side: 'SELL',
        type: price ? 'LIMIT' : 'MARKET',
        quantity,
        price,
        status: 'FILLED',
        filledQuantity: quantity,
        filledPrice: price || bar.close,
        timestamp: Date.now(),
        fillTimestamp: Date.now(),
      };

      // 更新持仓（简化版）
      this.updatePositionAfterSell(symbol, quantity, order.filledPrice!);

      console.log(`[LiveEngine] 卖出订单成交（模拟）: ${symbol} ${quantity} @ ${order.filledPrice}`);
    }

    this.orders.push(order);

    // P0-3: 如果订单未完成，加入跟踪列表
    if (order.status === 'PENDING' || order.status === 'PARTIAL_FILLED') {
      this.trackedOrderIds.add(order.orderId);
      console.log(`[LiveEngine] 开始跟踪订单: ${order.orderId}`);
    }

    // 调用策略的 onOrder 回调（如果有）
    if (this.strategy.onOrder) {
      const ctx = this.createContext();
      await this.strategy.onOrder(order, ctx);
    }

    return order;
  }

  /**
   * 取消订单
   */
  private async cancelOrder(orderId: string): Promise<void> {
    if (this.provider) {
      // 使用 Provider 取消订单
      await this.provider.cancelOrder(orderId);
      console.log(`[LiveEngine] 订单已取消（Provider）: ${orderId}`);
    } else {
      // 无 Provider：本地取消
      const order = this.orders.find(o => o.orderId === orderId);
      if (!order) {
        throw new Error(`Order ${orderId} not found`);
      }

      if (order.status === 'FILLED') {
        throw new Error(`Order ${orderId} already filled`);
      }

      order.status = 'CANCELED';
      console.log(`[LiveEngine] 订单已取消（本地）: ${orderId}`);
    }
  }

  /**
   * 买入后更新持仓（简化版）
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
      this.balance -= price * quantity;
    } else if (position.side === 'FLAT') {
      // 开多仓
      position.side = 'LONG';
      position.quantity = quantity;
      position.entryPrice = price;
      position.currentPrice = price;
      position.unrealizedPnl = 0;
      this.balance -= price * quantity;
    } else if (position.side === 'LONG') {
      // 加多仓
      const totalCost = position.entryPrice * position.quantity + price * quantity;
      position.quantity += quantity;
      position.entryPrice = totalCost / position.quantity;
      this.balance -= price * quantity;
    } else if (position.side === 'SHORT') {
      // 平空仓
      const pnl = (position.entryPrice - price) * Math.min(quantity, position.quantity);
      position.realizedPnl += pnl;
      this.balance += pnl;

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
   * 卖出后更新持仓（简化版）
   */
  private updatePositionAfterSell(symbol: string, quantity: number, price: number): void {
    let position = this.positions.get(symbol);

    if (!position || position.side === 'FLAT') {
      // 现货不支持开空仓
      throw new Error('Cannot short spot assets');
    }

    if (position.side === 'LONG') {
      // 平多仓
      const pnl = (price - position.entryPrice) * Math.min(quantity, position.quantity);
      position.realizedPnl += pnl;
      this.balance += position.entryPrice * Math.min(quantity, position.quantity) + pnl;

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
   * 风控检查
   */
  private checkRiskControl(): void {
    // 检查最大回撤
    if (this.config.maxDrawdown) {
      const initialEquity = this.config.initialBalance || this.balance;
      const drawdown = (initialEquity - this.equity) / initialEquity;

      if (drawdown > this.config.maxDrawdown) {
        console.error(`[LiveEngine] 触发最大回撤限制: ${(drawdown * 100).toFixed(2)}% > ${(this.config.maxDrawdown * 100).toFixed(2)}%`);
        console.error(`[LiveEngine] 停止交易`);

        // 停止引擎
        this.stop();
      }
    }
  }

  /**
   * 注册外部 WebSocket 回调（由 Provider 调用）
   */
  registerKlineHandler(symbol: string, interval: string, handler: (bar: Kline) => Promise<void>): void {
    const topic = `kline_${interval}_${symbol}`;
    this.wsHandlers.set(topic, handler);
  }

  /**
   * 获取运行状态
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * 获取所有订单
   */
  getOrders(): Order[] {
    return [...this.orders];
  }

  /**
   * P0-3: 启动订单状态轮询
   */
  private startOrderPolling(): void {
    if (!this.provider || !this.provider.getOrders) {
      console.log(`[LiveEngine] Provider 不支持订单轮询，跳过`);
      return;
    }

    console.log(`[LiveEngine] 启动订单状态轮询（间隔 ${this.orderPollInterval}ms）`);

    this.orderPollTimer = setInterval(() => {
      this.pollOrderStatus().catch((err) => {
        console.error(`[LiveEngine] 订单状态轮询失败:`, err.message);
      });
    }, this.orderPollInterval);
  }

  /**
   * P0-3: 轮询订单状态
   */
  private async pollOrderStatus(): Promise<void> {
    if (!this.provider || !this.provider.getOrders) {
      return;
    }

    // 如果没有跟踪的订单，跳过
    if (this.trackedOrderIds.size === 0) {
      return;
    }

    try {
      // 获取所有订单
      const orders = await this.provider.getOrders();

      // 检查跟踪的订单
      for (const orderId of this.trackedOrderIds) {
        const order = orders.find(o => o.orderId === orderId);

        if (!order) {
          console.warn(`[LiveEngine] 订单 ${orderId} 未找到，移除跟踪`);
          this.trackedOrderIds.delete(orderId);
          continue;
        }

        // 检查订单状态变化
        const localOrder = this.orders.find(o => o.orderId === orderId);
        if (!localOrder) {
          continue;
        }

        // 如果状态发生变化，触发回调
        if (localOrder.status !== order.status) {
          console.log(`[LiveEngine] 订单状态更新: ${orderId} ${localOrder.status} → ${order.status}`);

          // 更新本地订单
          Object.assign(localOrder, order);

          // 调用策略的 onOrder 回调
          if (this.strategy.onOrder) {
            const ctx = this.createContext();
            await this.strategy.onOrder(order, ctx);
          }

          // 如果订单已完成，移除跟踪
          if (order.status === 'FILLED' || order.status === 'CANCELED') {
            this.trackedOrderIds.delete(orderId);
          }
        }
      }
    } catch (error: any) {
      console.error(`[LiveEngine] 订单状态轮询异常:`, error.message);
    }
  }

  /**
   * [P1] 启动实时 execution 订阅
   * 根治accountGap：通过WebSocket实时接收成交事件
   */
  private startExecutionSubscription(): void {
    if (!this.provider || !this.provider.subscribeExecutions) {
      logger.info(`[LiveEngine] Provider 不支持 execution 订阅，跳过`);
      return;
    }

    logger.info(`[LiveEngine] 启动 execution 实时订阅`);

    this.provider.subscribeExecutions(async (execution) => {
      logger.info(`[LiveEngine] 收到 execution 事件: execId=${execution.execId}, symbol=${execution.symbol}`);

      // 转换为策略需要的格式
      const execData = {
        execId: execution.execId,
        orderId: execution.orderId,
        orderLinkId: execution.orderLinkId,
        symbol: execution.symbol,
        side: execution.side,
        execQty: execution.execQty,
        execPrice: execution.execPrice,
        execTime: execution.execTime,
      };

      // 调用策略的 onExecution 回调（如果实现了）
      if (this.strategy.onExecution) {
        const ctx = this.createContext();
        try {
          await this.strategy.onExecution(execData, ctx);
          logger.info(`[LiveEngine] 策略 onExecution 处理完成`);
        } catch (error: any) {
          logger.error(`[LiveEngine] 策略 onExecution 失败:`, error.message);
        }
      }
    }).catch((err: any) => {
      logger.error(`[LiveEngine] execution 订阅失败:`, err.message);
    });
  }

  /**
   * P1新增：启动资金费结算检测
   */
  private startFundingFeeCheck(): void {
    if (!this.provider || !this.provider.getFundingRate) {
      console.log(`[LiveEngine] Provider 不支持资金费率查询，跳过资金费检测`);
      return;
    }

    if (!this.strategy.onFundingFee) {
      console.log(`[LiveEngine] 策略未实现 onFundingFee，跳过资金费检测`);
      return;
    }

    console.log(`[LiveEngine] 启动资金费结算检测（间隔 ${this.fundingFeeCheckInterval}ms）`);

    this.fundingFeeCheckTimer = setInterval(() => {
      this.checkFundingFee().catch((err) => {
        console.error(`[LiveEngine] 资金费检测失败:`, err.message);
      });
    }, this.fundingFeeCheckInterval);
  }

  /**
   * P1新增：检测资金费结算
   * Bybit每8小时结算一次（08:00, 16:00, 00:00 UTC）
   */
  private async checkFundingFee(): Promise<void> {
    if (!this.provider || !this.provider.getFundingRate || !this.strategy.onFundingFee) {
      return;
    }

    const symbols = this.config.symbols;
    const now = Date.now();

    for (const symbol of symbols) {
      try {
        // 获取资金费率信息
        const { fundingRate, nextFundingTime } = await this.provider.getFundingRate(symbol);

        // 检查是否已经过了结算时间
        const lastChecked = this.lastFundingFeeTime.get(symbol) || 0;

        // 如果当前时间已经超过了nextFundingTime，说明已经结算
        if (now >= nextFundingTime && lastChecked < nextFundingTime) {
          // 计算资金费（需要持仓信息）
          const position = this.positions.get(symbol);
          let fundingFee = 0;

          if (position && position.quantity > 0) {
            // 资金费 = 持仓价值 * 资金费率
            const positionValue = position.quantity * position.currentPrice;
            fundingFee = positionValue * fundingRate * (position.side === 'LONG' ? -1 : 1);
          }

          console.log(`[LiveEngine] 资金费结算: ${symbol}, rate=${fundingRate}, fee=${fundingFee}`);

          // 触发策略回调
          const ctx = this.createContext();
          await this.strategy.onFundingFee!({
            symbol,
            fundingRate,
            fundingFee,
            timestamp: nextFundingTime,
          }, ctx);

          // 更新最后检查时间
          this.lastFundingFeeTime.set(symbol, now);
        }
      } catch (error: any) {
        console.error(`[LiveEngine] 检测 ${symbol} 资金费失败:`, error.message);
      }
    }
  }

  /**
   * P1新增：停止资金费结算检测
   */
  private stopFundingFeeCheck(): void {
    if (this.fundingFeeCheckTimer) {
      clearInterval(this.fundingFeeCheckTimer);
      this.fundingFeeCheckTimer = undefined;
      console.log(`[LiveEngine] 资金费结算检测已停止`);
    }
  }
}
