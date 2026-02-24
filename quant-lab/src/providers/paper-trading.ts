/**
 * Paper Trading Provider - 模拟交易提供者
 * 
 * 功能：
 * - 使用公开 API 获取真实行情
 * - 模拟交易（下单、撤单、持仓）
 * - 本地状态持久化（JSON + ndtsdb 双轨）
 * - 简单撮合逻辑
 * - 实时落盘到 ndtsdb（AppendWriter 增量写入）
 */

import { createLogger } from '../utils/logger';
const logger = createLogger('paper-trading');

import { BybitProvider } from './bybit.js';
import type { 
  CoinBalance, 
  Position as BybitPosition 
} from './bybit.js';
// import { TradeAnalytics } from '../analytics/index.js';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * 订单类型
 */
export type OrderType = 'Market' | 'Limit';
export type OrderSide = 'Buy' | 'Sell';
export type OrderStatus = 'Pending' | 'Filled' | 'PartiallyFilled' | 'Cancelled';

/**
 * 模拟订单
 */
export interface PaperOrder {
  orderId: string;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  qty: number;
  price: number;
  filledQty: number;
  avgPrice: number;
  status: OrderStatus;
  createdAt: number;
  updatedAt: number;
}

/**
 * 模拟持仓
 */
export interface PaperPosition {
  symbol: string;
  side: 'Buy' | 'Sell';
  size: number;
  avgPrice: number;
  markPrice: number;
  unrealisedPnl: number;
  positionValue: number;
  updatedAt: number;
}

/**
 * 成交记录
 */
export interface PaperTrade {
  tradeId: string;
  orderId: string;
  symbol: string;
  side: OrderSide;
  qty: number;
  price: number;
  fee: number;
  timestamp: number;
}

/**
 * 账户配置
 */
export interface PaperTradingConfig {
  /** 账户名称 */
  accountName: string;
  
  /** 初始资金（USDT） */
  initialBalance: number;
  
  /** 手续费率（Maker，默认 0.02%） */
  makerFeeRate: number;
  
  /** 手续费率（Taker，默认 0.055%） */
  takerFeeRate: number;
  
  /** 状态文件保存目录 */
  stateDir: string;
  
  /** 代理地址（可选） */
  proxy?: string;
}

/**
 * 账户状态
 */
export interface PaperAccountState {
  /** 账户配置 */
  config: PaperTradingConfig;
  
  /** 当前余额（按币种） */
  balances: Record<string, CoinBalance>;
  
  /** 持仓 */
  positions: PaperPosition[];
  
  /** 活跃订单 */
  activeOrders: PaperOrder[];
  
  /** 历史订单 */
  orderHistory: PaperOrder[];
  
  /** 成交记录 */
  trades: PaperTrade[];
  
  /** 资金曲线 */
  equityCurve: EquityPoint[];
  
  /** 统计 */
  stats: PaperStats;
  
  /** 最后更新时间 */
  lastUpdated: number;
}

/**
 * 资金曲线点
 */
export interface EquityPoint {
  timestamp: number;
  totalEquity: number;
  availableBalance: number;
  positionValue: number;
  unrealisedPnl: number;
}

/**
 * 交易统计
 */
export interface PaperStats {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  totalVolume: number;
  totalFee: number;
  realisedPnl: number;
  maxDrawdown: number;
  maxEquity: number;
}

/**
 * 下单参数
 */
export interface PlaceOrderParams {
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  qty: number;
  price?: number;
}

/**
 * 下单结果
 */
export interface PlaceOrderResult {
  success: boolean;
  order?: PaperOrder;
  error?: string;
  trades?: PaperTrade[];
}

/**
 * Paper Trading 提供者
 * 
 * 实现原理：
 * 1. 复用 BybitProvider 获取真实行情（公开 API，无需 Key）
 * 2. 本地维护订单簿、持仓、资金状态
 * 3. 定时同步状态到 JSON 文件
 */
export class PaperTradingProvider {
  private config: PaperTradingConfig;
  private bybit: BybitProvider;
  private state: PaperAccountState;
  private stateFile: string;
  private orderIdCounter: number = 0;
  private tradeIdCounter: number = 0;
  private saveInterval: NodeJS.Timeout | null = null;
  private analytics: TradeAnalytics | null = null;
  private enableAnalytics: boolean;

  constructor(config: Partial<PaperTradingConfig> & { accountName: string; enableAnalytics?: boolean }) {
    this.config = {
      accountName: config.accountName,
      initialBalance: config.initialBalance ?? 10000,
      makerFeeRate: config.makerFeeRate ?? 0.0002,
      takerFeeRate: config.takerFeeRate ?? 0.00055,
      stateDir: config.stateDir ?? './runtime/paper-state',
      proxy: config.proxy
    };
    this.enableAnalytics = config.enableAnalytics ?? true;

    // 创建 Bybit Provider（用于获取行情，不需要 API Key）
    this.bybit = new BybitProvider({
      apiKey: 'dummy',
      apiSecret: 'dummy',
      proxy: this.config.proxy
    });

    // 状态文件路径
    this.stateFile = join(
      this.config.stateDir, 
      `paper-${this.config.accountName}.json`
    );

    // 初始化状态
    this.state = this.createInitialState();
  }

  /**
   * 初始化（加载或创建状态）
   */
  async init(): Promise<void> {
    await this.loadState();
    
    // 初始化分析数据库（实时落盘）
    if (this.enableAnalytics) {
      this.analytics = new TradeAnalytics({
        dataDir: join(this.config.stateDir, 'analytics'),
        batchSize: 50,
        flushIntervalMs: 3000,
        jsonBackupDir: join(this.config.stateDir, 'backup')
      });
      await this.analytics.init();
    }
    
    this.startAutoSave();
  }

  /**
   * 清理资源
   */
  async destroy(): Promise<void> {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
    
    // 关闭 analytics（会落盘所有缓冲区数据）
    if (this.analytics) {
      await this.analytics.close();
      this.analytics = null;
    }
    
    await this.saveState();
  }

  /**
   * 获取账户名称
   */
  get accountName(): string {
    return this.config.accountName;
  }

  /**
   * 获取最新价格
   */
  async getPrice(symbol: string): Promise<number> {
    // 使用 Bybit 公开 API 获取行情
    try {
      const response = await this.bybit.getTickers(symbol);
      // Bybit API 返回结构: { retCode, retMsg, result: { list: [{ lastPrice }] } }
      const ticker = response?.result?.list?.[0];
      if (ticker && ticker.lastPrice) {
        return parseFloat(ticker.lastPrice);
      }
      throw new Error('Invalid ticker response');
    } catch (error) {
      // 如果失败，尝试从持仓中获取标记价格
      const position = this.state.positions.find(p => p.symbol === symbol);
      if (position && position.markPrice > 0) {
        return position.markPrice;
      }
      throw error;
    }
  }

  /**
   * 获取完整行情
   */
  async getTicker(symbol: string): Promise<any> {
    const response = await this.bybit.getTickers(symbol);
    return response?.result?.list?.[0] || null;
  }

  /**
   * 获取 K 线数据
   */
  async getKlines(symbol: string, interval: string, limit?: number) {
    // 转换 symbol 格式 BTC/USDT -> BTCUSDT
    const formattedSymbol = symbol.replace('/', '');
    return this.bybit.getKlines({
      category: 'linear',
      symbol: formattedSymbol,
      interval,
      limit
    });
  }

  /**
   * 下单
   */
  async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
    const { symbol, side, orderType, qty, price } = params;

    // 验证参数
    if (qty <= 0) {
      return { success: false, error: 'Quantity must be positive' };
    }

    if (orderType === 'Limit' && (!price || price <= 0)) {
      return { success: false, error: 'Limit order requires valid price' };
    }

    // 获取当前价格
    const currentPrice = await this.getPrice(symbol);

    // 计算订单价值
    const orderValue = qty * (orderType === 'Market' ? currentPrice : price!);

    // 检查资金（买入需要 USDT，卖出需要持仓）
    if (side === 'Buy') {
      const usdtBalance = this.state.balances['USDT']?.availableToWithdraw ?? 0;
      if (usdtBalance < orderValue) {
        return { success: false, error: `Insufficient USDT balance: ${usdtBalance} < ${orderValue}` };
      }
    } else {
      // 卖出：检查持仓
      const position = this.state.positions.find(p => p.symbol === symbol);
      if (!position || position.size < qty) {
        return { success: false, error: `Insufficient position: ${position?.size ?? 0} < ${qty}` };
      }
    }

    // 创建订单
    const order: PaperOrder = {
      orderId: this.generateOrderId(),
      symbol,
      side,
      orderType,
      qty,
      price: orderType === 'Market' ? currentPrice : price!,
      filledQty: 0,
      avgPrice: 0,
      status: 'Pending',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    // 撮合
    const trades: PaperTrade[] = [];

    if (orderType === 'Market') {
      // 市价单立即成交
      const trade = this.executeTrade(order, currentPrice, qty);
      trades.push(trade);
      order.filledQty = qty;
      order.avgPrice = currentPrice;
      order.status = 'Filled';
    } else {
      // 限价单：检查是否立即成交
      if ((side === 'Buy' && price! >= currentPrice) ||
          (side === 'Sell' && price! <= currentPrice)) {
        const trade = this.executeTrade(order, price!, qty);
        trades.push(trade);
        order.filledQty = qty;
        order.avgPrice = price!;
        order.status = 'Filled';
      } else {
        // 挂起订单
        this.state.activeOrders.push(order);
      }
    }

    // 更新订单历史
    if (order.status === 'Filled') {
      this.state.orderHistory.push(order);
    }

    // 更新资金曲线
    this.updateEquityCurve();

    return { success: true, order, trades };
  }

  /**
   * 撤单
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    const index = this.state.activeOrders.findIndex(o => o.orderId === orderId);
    if (index === -1) {
      return false;
    }

    const order = this.state.activeOrders[index];
    order.status = 'Cancelled';
    order.updatedAt = Date.now();

    // 从活跃订单移除，加入历史
    this.state.activeOrders.splice(index, 1);
    this.state.orderHistory.push(order);

    return true;
  }

  /**
   * 获取订单
   */
  async getOrder(orderId: string): Promise<PaperOrder | null> {
    // 先在活跃订单中查找
    const active = this.state.activeOrders.find(o => o.orderId === orderId);
    if (active) return active;

    // 在历史订单中查找
    return this.state.orderHistory.find(o => o.orderId === orderId) ?? null;
  }

  /**
   * 获取所有活跃订单
   */
  async getActiveOrders(symbol?: string): Promise<PaperOrder[]> {
    if (symbol) {
      return this.state.activeOrders.filter(o => o.symbol === symbol);
    }
    return [...this.state.activeOrders];
  }

  /**
   * 获取持仓
   */
  async getPosition(symbol: string): Promise<PaperPosition | null> {
    const position = this.state.positions.find(p => p.symbol === symbol);
    if (!position) return null;

    // 更新标记价格和未实现盈亏
    try {
      const currentPrice = await this.getPrice(symbol);
      position.markPrice = currentPrice;
      
      const priceDiff = position.side === 'Buy' 
        ? currentPrice - position.avgPrice
        : position.avgPrice - currentPrice;
      
      position.unrealisedPnl = priceDiff * position.size;
      position.positionValue = position.size * currentPrice;
      position.updatedAt = Date.now();
    } catch (error) {
      // 如果获取价格失败，使用之前的标记价格
    }

    return { ...position };
  }

  /**
   * 获取所有持仓
   */
  async getPositions(): Promise<PaperPosition[]> {
    const positions: PaperPosition[] = [];
    for (const pos of this.state.positions) {
      const updated = await this.getPosition(pos.symbol);
      if (updated && updated.size > 0) {
        positions.push(updated);
      }
    }
    return positions;
  }

  /**
   * 获取余额
   */
  async getBalance(coin?: string): Promise<CoinBalance | Record<string, CoinBalance>> {
    if (coin) {
      return this.state.balances[coin] ?? {
        coin,
        walletBalance: 0,
        availableToWithdraw: 0,
        usdValue: 0,
        unrealisedPnl: 0
      };
    }
    return { ...this.state.balances };
  }

  /**
   * 获取账户概览
   */
  async getAccountOverview(): Promise<{
    totalEquity: number;
    availableBalance: number;
    positionValue: number;
    unrealisedPnl: number;
    realisedPnl: number;
  }> {
    const positions = await this.getPositions();
    const positionValue = positions.reduce((sum, p) => sum + p.positionValue, 0);
    const unrealisedPnl = positions.reduce((sum, p) => sum + p.unrealisedPnl, 0);
    const usdtBalance = this.state.balances['USDT']?.walletBalance ?? 0;

    return {
      totalEquity: usdtBalance + positionValue,
      availableBalance: this.state.balances['USDT']?.availableToWithdraw ?? 0,
      positionValue,
      unrealisedPnl,
      realisedPnl: this.state.stats.realisedPnl
    };
  }

  /**
   * 获取资金曲线
   */
  async getEquityCurve(points?: number): Promise<EquityPoint[]> {
    if (points && points < this.state.equityCurve.length) {
      return this.state.equityCurve.slice(-points);
    }
    return [...this.state.equityCurve];
  }

  /**
   * 获取交易统计
   */
  async getStats(): Promise<PaperStats> {
    return { ...this.state.stats };
  }

  /**
   * 获取成交记录
   */
  async getTrades(symbol?: string, limit?: number): Promise<PaperTrade[]> {
    let trades = [...this.state.trades];
    
    if (symbol) {
      trades = trades.filter(t => t.symbol === symbol);
    }
    
    // 按时间倒序
    trades.sort((a, b) => b.timestamp - a.timestamp);
    
    if (limit) {
      trades = trades.slice(0, limit);
    }
    
    return trades;
  }

  /**
   * 检查并撮合限价单
   * 应该在每次价格更新时调用
   */
  async checkAndFillOrders(): Promise<void> {
    const currentPrices = new Map<string, number>();

    for (const order of this.state.activeOrders) {
      // 获取当前价格（缓存）
      if (!currentPrices.has(order.symbol)) {
        try {
          const price = await this.getPrice(order.symbol);
          currentPrices.set(order.symbol, price);
        } catch (error) {
          continue; // 跳过无法获取价格的订单
        }
      }

      const currentPrice = currentPrices.get(order.symbol)!;

      // 检查是否成交
      let shouldFill = false;
      if (order.side === 'Buy' && order.price >= currentPrice) {
        shouldFill = true;
      } else if (order.side === 'Sell' && order.price <= currentPrice) {
        shouldFill = true;
      }

      if (shouldFill) {
        const trade = this.executeTrade(order, currentPrice, order.qty - order.filledQty);
        order.filledQty = order.qty;
        order.avgPrice = order.price;
        order.status = 'Filled';
        order.updatedAt = Date.now();

        this.state.trades.push(trade);
        this.state.orderHistory.push(order);
      }
    }

    // 移除已成交的订单
    this.state.activeOrders = this.state.activeOrders.filter(o => o.status === 'Pending');

    // 更新资金曲线
    this.updateEquityCurve();
  }

  /**
   * 重置账户（清空所有数据）
   */
  async reset(): Promise<void> {
    this.state = this.createInitialState();
    await this.saveState();
  }

  // ============== 私有方法 ==============

  private createInitialState(): PaperAccountState {
    return {
      config: this.config,
      balances: {
        USDT: {
          coin: 'USDT',
          walletBalance: this.config.initialBalance,
          availableToWithdraw: this.config.initialBalance,
          usdValue: this.config.initialBalance,
          unrealisedPnl: 0
        }
      },
      positions: [],
      activeOrders: [],
      orderHistory: [],
      trades: [],
      equityCurve: [{
        timestamp: Date.now(),
        totalEquity: this.config.initialBalance,
        availableBalance: this.config.initialBalance,
        positionValue: 0,
        unrealisedPnl: 0
      }],
      stats: {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        totalVolume: 0,
        totalFee: 0,
        realisedPnl: 0,
        maxDrawdown: 0,
        maxEquity: this.config.initialBalance
      },
      lastUpdated: Date.now()
    };
  }

  private generateOrderId(): string {
    return `paper-${this.config.accountName}-${++this.orderIdCounter}-${Date.now()}`;
  }

  private generateTradeId(): string {
    return `trade-${this.config.accountName}-${++this.tradeIdCounter}-${Date.now()}`;
  }

  /**
   * 清除所有数据（重置账户）
   */
  async clear(): Promise<void> {
    // 重置状态
    this.state = this.createInitialState();
    this.orderIdCounter = 0;
    this.tradeIdCounter = 0;
    
    // 清空 analytics 数据
    if (this.analytics) {
      await this.analytics.reset();
    }
    
    // 保存空状态
    await this.saveState();
    
    logger.info(`[PaperTrading] Account ${this.config.accountName} cleared`);
  }

  private executeTrade(order: PaperOrder, price: number, qty: number): PaperTrade {
    // 计算手续费（市价单用 Taker 费率，限价单用 Maker 费率）
    const feeRate = order.orderType === 'Market' 
      ? this.config.takerFeeRate 
      : this.config.makerFeeRate;
    const tradeValue = qty * price;
    const fee = tradeValue * feeRate;

    const trade: PaperTrade = {
      tradeId: this.generateTradeId(),
      orderId: order.orderId,
      symbol: order.symbol,
      side: order.side,
      qty,
      price,
      fee,
      timestamp: Date.now()
    };

    // 更新余额
    if (order.side === 'Buy') {
      // 买入：扣除 USDT，获得币种
      const cost = tradeValue + fee;
      this.state.balances['USDT'].walletBalance -= cost;
      this.state.balances['USDT'].availableToWithdraw -= cost;
      
      const baseCoin = order.symbol.replace('USDT', '');
      if (!this.state.balances[baseCoin]) {
        this.state.balances[baseCoin] = {
          coin: baseCoin,
          walletBalance: 0,
          availableToWithdraw: 0,
          usdValue: 0,
          unrealisedPnl: 0
        };
      }
      this.state.balances[baseCoin].walletBalance += qty;
      this.state.balances[baseCoin].availableToWithdraw += qty;
    } else {
      // 卖出：扣除币种，获得 USDT
      const proceeds = tradeValue - fee;
      this.state.balances['USDT'].walletBalance += proceeds;
      this.state.balances['USDT'].availableToWithdraw += proceeds;
      
      const baseCoin = order.symbol.replace('USDT', '');
      if (this.state.balances[baseCoin]) {
        this.state.balances[baseCoin].walletBalance -= qty;
        this.state.balances[baseCoin].availableToWithdraw -= qty;
      }
    }

    // 更新持仓
    this.updatePosition(order.symbol, order.side, qty, price);

    // 更新统计
    this.state.stats.totalTrades++;
    this.state.stats.totalVolume += tradeValue;
    this.state.stats.totalFee += fee;

    this.state.trades.push(trade);

    // 实时落盘到 ndtsdb（异步，不阻塞）
    if (this.analytics) {
      // 计算这笔交易的实现盈亏（如果是平仓）
      const pnl = this.calculateTradePnl(order, qty, price);

      this.analytics.recordTrade({
        tradeId: trade.tradeId,
        orderId: trade.orderId,
        symbol: trade.symbol,
        side: trade.side,
        qty: trade.qty,
        price: trade.price,
        fee: trade.fee,
        pnl: pnl,
        timestamp: new Date(trade.timestamp)
      });
    }

    return trade;
  }

  /**
   * 计算单笔交易的实现盈亏
   */
  private calculateTradePnl(order: PaperOrder, qty: number, price: number): number {
    // 找到对应持仓
    const position = this.state.positions.find(p => p.symbol === order.symbol);
    if (!position) return 0;

    // 只有反向操作（卖出多头或买入空头）才产生实现盈亏
    if (position.side === 'Buy' && order.side === 'Sell') {
      return (price - position.avgPrice) * qty;
    } else if (position.side === 'Sell' && order.side === 'Buy') {
      return (position.avgPrice - price) * qty;
    }

    return 0;
  }

  private updatePosition(symbol: string, side: OrderSide, qty: number, price: number): void {
    const existingIndex = this.state.positions.findIndex(p => p.symbol === symbol);
    
    if (existingIndex === -1) {
      // 新建持仓
      this.state.positions.push({
        symbol,
        side: side === 'Buy' ? 'Buy' : 'Sell',
        size: qty,
        avgPrice: price,
        markPrice: price,
        unrealisedPnl: 0,
        positionValue: qty * price,
        updatedAt: Date.now()
      });
    } else {
      const position = this.state.positions[existingIndex];
      
      if (position.side === side) {
        // 加仓：更新均价
        const totalValue = position.avgPrice * position.size + price * qty;
        position.size += qty;
        position.avgPrice = totalValue / position.size;
      } else {
        // 减仓或平仓
        if (position.size <= qty) {
          // 完全平仓或反手
          const realizedPnl = position.side === 'Buy'
            ? (price - position.avgPrice) * position.size
            : (position.avgPrice - price) * position.size;
          
          this.state.stats.realisedPnl += realizedPnl;
          
          if (realizedPnl > 0) {
            this.state.stats.winningTrades++;
          } else {
            this.state.stats.losingTrades++;
          }

          if (position.size < qty) {
            // 反手：创建反向持仓
            const remaining = qty - position.size;
            this.state.positions[existingIndex] = {
              symbol,
              side: side === 'Buy' ? 'Buy' : 'Sell',
              size: remaining,
              avgPrice: price,
              markPrice: price,
              unrealisedPnl: 0,
              positionValue: remaining * price,
              updatedAt: Date.now()
            };
          } else {
            // 完全平仓
            this.state.positions.splice(existingIndex, 1);
          }
        } else {
          // 部分减仓
          const realizedPnl = position.side === 'Buy'
            ? (price - position.avgPrice) * qty
            : (position.avgPrice - price) * qty;
          
          this.state.stats.realisedPnl += realizedPnl;
          
          if (realizedPnl > 0) {
            this.state.stats.winningTrades++;
          } else {
            this.state.stats.losingTrades++;
          }

          position.size -= qty;
          position.positionValue = position.size * price;
        }
      }
      
      position.updatedAt = Date.now();
    }
  }

  private updateEquityCurve(): void {
    const overview = this.getAccountOverviewSync();
    const point: EquityPoint = {
      timestamp: Date.now(),
      totalEquity: overview.totalEquity,
      availableBalance: overview.availableBalance,
      positionValue: overview.positionValue,
      unrealisedPnl: overview.unrealisedPnl
    };

    this.state.equityCurve.push(point);

    // 实时落盘资金快照到 ndtsdb
    if (this.analytics) {
      this.analytics.recordEquity({
        accountName: this.config.accountName,
        timestamp: new Date(),
        totalEquity: overview.totalEquity,
        availableBalance: overview.availableBalance,
        positionValue: overview.positionValue,
        unrealisedPnl: overview.unrealisedPnl,
        positionsJson: JSON.stringify(this.state.positions)
      });
    }

    // 更新最大权益和最大回撤
    if (overview.totalEquity > this.state.stats.maxEquity) {
      this.state.stats.maxEquity = overview.totalEquity;
    }
    const drawdown = (this.state.stats.maxEquity - overview.totalEquity) / this.state.stats.maxEquity;
    if (drawdown > this.state.stats.maxDrawdown) {
      this.state.stats.maxDrawdown = drawdown;
    }

    this.state.lastUpdated = Date.now();
  }

  private getAccountOverviewSync(): {
    totalEquity: number;
    availableBalance: number;
    positionValue: number;
    unrealisedPnl: number;
  } {
    const positionValue = this.state.positions.reduce((sum, p) => sum + p.positionValue, 0);
    const unrealisedPnl = this.state.positions.reduce((sum, p) => sum + p.unrealisedPnl, 0);
    const usdtBalance = this.state.balances['USDT']?.walletBalance ?? 0;

    return {
      totalEquity: usdtBalance + positionValue,
      availableBalance: this.state.balances['USDT']?.availableToWithdraw ?? 0,
      positionValue,
      unrealisedPnl
    };
  }

  private async loadState(): Promise<void> {
    try {
      const content = await readFile(this.stateFile, 'utf-8');
      const loaded = JSON.parse(content) as PaperAccountState;
      
      // 合并配置（保留当前配置）
      this.state = {
        ...loaded,
        config: this.config
      };

      // 恢复计数器
      const maxOrderId = Math.max(
        ...this.state.orderHistory.map(o => {
          const parts = o.orderId.split('-');
          return parseInt(parts[parts.length - 2] ?? '0');
        }),
        0
      );
      this.orderIdCounter = maxOrderId;

      const maxTradeId = Math.max(
        ...this.state.trades.map(t => {
          const parts = t.tradeId.split('-');
          return parseInt(parts[parts.length - 2] ?? '0');
        }),
        0
      );
      this.tradeIdCounter = maxTradeId;

    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // 文件不存在，使用初始状态
        logger.info(`[PaperTrading] Creating new account: ${this.config.accountName}`);
        await this.saveState();
      } else {
        throw error;
      }
    }
  }

  private async saveState(): Promise<void> {
    try {
      await mkdir(dirname(this.stateFile), { recursive: true });
      // 原子写入：先写 .tmp，再 rename（POSIX 保证原子性）
      const tmpPath = this.stateFile + '.tmp';
      await writeFile(tmpPath, JSON.stringify(this.state, null, 2), 'utf-8');
      await rename(tmpPath, this.stateFile);
    } catch (error) {
      logger.error('[PaperTrading] Failed to save state:', error);
    }
  }

  private startAutoSave(): void {
    // 每 30 秒自动保存
    this.saveInterval = setInterval(() => {
      this.saveState();
    }, 30000);
  }
}

export default PaperTradingProvider;
