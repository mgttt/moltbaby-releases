// ============================================================
import { createLogger } from '../utils/logger';
const logger = createLogger('GalesStrategy');
// Gales Strategy - 磁铁限价网格策略 + 波动率自适应
// 
// Grid + Martingale = Gales (大风大浪中收益)
// 核心思路：只在价格接近网格档位时挂限价单（磁铁吸附），避免滑点
// 新增：基于波动率动态调整网格间距
// ============================================================

import type { Kline, Tick } from '../../../quant-lib/src';
import type { Order, StrategyContext } from '../engine/types';
import { VolatilityAdaptiveGridManager, VolatilityConfig } from './volatility-adaptive-grid';
import { fetchSymbolInfo, formatPrice, SymbolInfo } from './symbol-info';
import { MarketRegimeDetector, MarketRegimeConfig, MarketRegime } from './market-regime-detector';

/**
 * Gales 策略配置
 */
export interface GalesConfig {
  // 基础参数
  symbol: string;
  gridCount: number;
  gridSpacing: number;      // 网格间距（百分比，如 0.01 = 1%）
  orderSize: number;        // 每单 USDT 金额
  maxPosition: number;      // 最大仓位 USDT

  // 🧲 磁铁参数
  magnetDistance: number;   // 磁铁距离：价格接近此距离时挂单
  cancelDistance: number;   // 取消距离：偏离此距离时撤单
  priceOffset: number;      // 限价单价格偏移
  postOnly?: boolean;       // 默认 true，做 maker
  orderTimeout?: number;    // 订单超时（秒）

  // 📊 波动率自适应参数（可选）
  enableVolatilityAdaptive?: boolean; // 是否启用波动率自适应（默认false）
  volatilityConfig?: Partial<VolatilityConfig>; // 波动率配置

  // 📈 市场状态检测参数（可选）
  enableMarketRegime?: boolean; // 是否启用市场状态检测（默认false）
  marketRegimeConfig?: Partial<MarketRegimeConfig>; // 市场状态配置

  // 价格精度（自动获取，也可手动指定）
  priceTick?: number;       // 最小价格变动单位，如未指定则自动获取

  // 安全开关
  simMode?: boolean;        // 模拟模式（不真实下单）
}

/**
 * 网格档位
 */
interface GridLevel {
  id: number;
  price: number;
  side: 'BUY' | 'SELL';
  state: 'IDLE' | 'PLACING' | 'ACTIVE' | 'CANCELING' | 'FILLED';
  
  orderId?: string;
  orderLinkId?: string;
  orderPrice?: number;
  createdAt?: number;
  attempts: number;
}

/**
 * Gales Strategy
 */
export class GalesStrategy {
  private config: Required<GalesConfig>;
  private ctx?: StrategyContext;

  // 状态
  private initialized = false;
  private centerPrice = 0;
  private lastPrice = 0;
  private positionNotional = 0;
  private gridLevels: GridLevel[] = [];
  private nextGridId = 1;
  private tickCount = 0;

  // 订单追踪
  private pendingOrders = new Map<string, GridLevel>();

  // 波动率自适应网格管理器
  private volatilityManager?: VolatilityAdaptiveGridManager;
  private currentGridSpacing: number;

  // 市场状态检测器
  private marketRegimeDetector?: MarketRegimeDetector;
  private currentRegime: MarketRegime = 'RANGING';

  // 品种信息（动态获取）
  private symbolInfo?: SymbolInfo;

  constructor(config: GalesConfig) {
    this.config = {
      postOnly: true,
      orderTimeout: 300,
      simMode: true,
      enableVolatilityAdaptive: false,
      ...config,
    };
    
    this.currentGridSpacing = this.config.gridSpacing;

    // 初始化波动率管理器（如果启用）
    if (this.config.enableVolatilityAdaptive) {
      this.volatilityManager = new VolatilityAdaptiveGridManager(
        this.config.volatilityConfig || {
          baseGridSpacing: this.config.gridSpacing,
        }
      );
      console.log('[GalesStrategy] 波动率自适应网格已启用');
    }

    // 初始化市场状态检测器（如果启用）
    if (this.config.enableMarketRegime) {
      this.marketRegimeDetector = new MarketRegimeDetector(
        this.config.marketRegimeConfig
      );

      // 设置事件回调
      this.marketRegimeDetector.setEvents({
        onTrendWarning: (adx: number) => {
          console.warn(`[GalesStrategy] ⚡ 市场趋势警告！ADX=${adx.toFixed(2)}, 建议谨慎操作`);
        },
        onSuspendSuggestion: (adx: number) => {
          console.warn(`[GalesStrategy] ⚠️ 极强趋势检测！ADX=${adx.toFixed(2)}, 建议暂停挂新单`);
        },
        onRegimeChange: (regime: MarketRegime, adx: number) => {
          console.log(`[GalesStrategy] 市场状态变化: ${regime}, ADX=${adx.toFixed(2)}`);
        },
      });

      console.log('[GalesStrategy] 市场状态检测已启用');
    }
  }

  /**
   * 初始化
   */
  async onInit(ctx: StrategyContext): Promise<void> {
    this.ctx = ctx;
    console.log('[GalesStrategy] 初始化...');

    // 获取品种信息（priceTick等）
    if (this.config.priceTick) {
      // 使用手动指定的priceTick
      this.symbolInfo = {
        symbol: this.config.symbol,
        priceTick: this.config.priceTick,
        quantityTick: 0.001,
        minQuantity: 0.001,
        maxQuantity: 100000,
        pricePrecision: Math.max(0, Math.ceil(-Math.log10(this.config.priceTick))),
        quantityPrecision: 3,
      };
      console.log(`[GalesStrategy] 使用手动指定 priceTick: ${this.config.priceTick}`);
    } else {
      // 从交易所API获取
      try {
        this.symbolInfo = await fetchSymbolInfo(this.config.symbol);
        console.log(`[GalesStrategy] 自动获取品种信息:`, {
          symbol: this.symbolInfo.symbol,
          priceTick: this.symbolInfo.priceTick,
          quantityTick: this.symbolInfo.quantityTick,
        });
      } catch (error) {
        console.warn(`[GalesStrategy] 获取品种信息失败，使用默认值:`, error);
        this.symbolInfo = await fetchSymbolInfo(this.config.symbol);
      }
    }

    console.log('[GalesStrategy] 配置:', {
      symbol: this.config.symbol,
      gridCount: this.config.gridCount,
      gridSpacing: `${(this.config.gridSpacing * 100).toFixed(2)}%`,
      magnetDistance: `${(this.config.magnetDistance * 100).toFixed(2)}%`,
      priceTick: this.symbolInfo?.priceTick,
      simMode: this.config.simMode,
    });

    this.initialized = false;
  }

  /**
   * K线更新（用于初始化中心价格 + 波动率自适应 + 市场状态检测）
   */
  onBar(bar: Kline, ctx: StrategyContext): void {
    // 1. 更新波动率（如果启用）
    if (this.volatilityManager) {
      const newGridSpacing = this.volatilityManager.update(bar);

      // 检查网格间距是否显著变化（>5%）
      const changeRatio = Math.abs(newGridSpacing - this.currentGridSpacing) / this.currentGridSpacing;
      if (changeRatio > 0.05) {
        console.log(
          `[GalesStrategy] 波动率自适应调整: gridSpacing ${(this.currentGridSpacing * 100).toFixed(2)}% → ${(newGridSpacing * 100).toFixed(2)}%`
        );
        this.currentGridSpacing = newGridSpacing;

        // 如果已初始化，重新生成网格
        if (this.initialized) {
          this.initializeGrids();
          console.log(`[GalesStrategy] 网格已重新生成，新中心价格: ${this.centerPrice}`);
        }
      }
    }

    // 2. 更新市场状态（如果启用）
    if (this.marketRegimeDetector) {
      this.currentRegime = this.marketRegimeDetector.update(bar);

      // 极强趋势时，取消所有挂单并暂停
      if (this.currentRegime === 'STRONG_TREND' && this.marketRegimeDetector.shouldSuspend()) {
        console.warn(`[GalesStrategy] ⚠️ 极强趋势，暂停挂新单，取消现有挂单...`);
        this.cancelAllOrders();
      }
    }

    // 3. 初始化（如果未初始化）
    if (!this.initialized) {
      this.centerPrice = bar.close;
      this.initializeGrids();
      this.initialized = true;
      console.log(`[GalesStrategy] 网格初始化完成，中心价格: ${this.centerPrice}`);
    }

    this.lastPrice = bar.close;
    this.onHeartbeat();
  }

  /**
   * Tick 更新（心跳）
   */
  onTick(tick: Tick, ctx: StrategyContext): void {
    this.lastPrice = tick.price;
    this.tickCount++;

    // 每 5 次 tick 检查一次
    if (this.tickCount % 5 === 0) {
      this.onHeartbeat();
    }
  }

  /**
   * 订单更新
   */
  onOrder(order: Order, ctx: StrategyContext): void {
    const grid = this.pendingOrders.get(order.id);
    if (!grid) return;

    console.log(`[GalesStrategy] 订单更新:`, {
      gridId: grid.id,
      side: grid.side,
      status: order.status,
      filled: order.filled,
      quantity: order.quantity,
    });

    switch (order.status) {
      case 'FILLED':
        this.handleOrderFilled(grid, order);
        break;

      case 'CANCELLED':
        this.handleOrderCancelled(grid);
        break;
    }
  }

  /**
   * 停止（优雅停机）
   * 
   * 修复：确保所有订单取消完成后再退出
   */
  async onStop(ctx: StrategyContext): Promise<void> {
    console.log('[GalesStrategy] 开始优雅停机，取消所有挂单...');

    // 1. 收集所有需要取消的订单
    const activeGrids = this.gridLevels.filter(
      (grid) => grid.state === 'ACTIVE' && grid.orderId
    );

    if (activeGrids.length === 0) {
      console.log('[GalesStrategy] 无活跃订单，停机完成');
      return;
    }

    console.log(`[GalesStrategy] 发现 ${activeGrids.length} 个活跃订单，开始取消...`);

    // 2. 并发取消所有订单（带超时保护）
    const cancelPromises = activeGrids.map((grid) =>
      this.cancelGridOrderWithTimeout(grid, 10) // 最多等10秒
    );

    try {
      // 3. 等待所有取消操作完成（带总超时保护）
      const overallTimeout = 15; // 总超时15秒
      await Promise.race([
        Promise.all(cancelPromises),
        this.createTimeout(overallTimeout * 1000, '总超时'),
      ]);

      console.log('[GalesStrategy] 所有订单取消操作已完成');
    } catch (error: any) {
      console.error('[GalesStrategy] 停机超时或出错:', error.message);
    }

    // 4. 验证所有订单已取消
    const remainingActive = this.gridLevels.filter(
      (grid) => grid.state === 'ACTIVE' && grid.orderId
    );

    if (remainingActive.length > 0) {
      console.warn(
        `[GalesStrategy] ⚠️ 停机警告: 仍有 ${remainingActive.length} 个订单未取消`
      );
      remainingActive.forEach((grid) => {
        console.warn(
          `  - gridId=${grid.id} orderId=${grid.orderId} side=${grid.side}`
        );
      });
    } else {
      console.log('[GalesStrategy] ✅ 停机验证通过: 所有订单已取消');
    }

    console.log('[GalesStrategy] 优雅停机完成');
  }

  /**
   * 取消网格订单（带超时保护）
   */
  private async cancelGridOrderWithTimeout(
    grid: GridLevel,
    timeoutSeconds: number
  ): Promise<void> {
    try {
      await Promise.race([
        this.cancelGridOrder(grid),
        this.createTimeout(
          timeoutSeconds * 1000,
          `取消订单超时 gridId=${grid.id}`
        ),
      ]);
    } catch (error: any) {
      console.error(
        `[GalesStrategy] 取消订单失败 gridId=${grid.id}:`,
        error.message
      );
    }
  }

  /**
   * 创建超时Promise
   */
  private createTimeout(ms: number, message: string): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    });
  }

  /**
   * 心跳检查
   */
  private onHeartbeat(): void {
    if (!this.initialized || !this.ctx) return;

    const price = this.lastPrice;
    if (price <= 0) return;

    // 检查每个网格档位
    for (const grid of this.gridLevels) {
      const distance = Math.abs(price - grid.price) / grid.price;

      switch (grid.state) {
        case 'IDLE':
          // 市场状态检查：强趋势时不挂新单
          if (this.currentRegime === 'TRENDING' || this.currentRegime === 'STRONG_TREND') {
            // 跳过挂单
            break;
          }

          // 价格接近，准备挂单
          if (this.shouldPlaceOrder(grid, price, distance)) {
            this.placeGridOrder(grid, price);
          }
          break;

        case 'ACTIVE':
          // 价格偏离，取消订单
          if (distance > this.config.cancelDistance) {
            console.log(`[GalesStrategy] 价格偏离，取消订单 gridId=${grid.id} distance=${(distance * 100).toFixed(3)}%`);
            this.cancelGridOrder(grid);
          }

          // 订单超时
          if (grid.createdAt && this.config.orderTimeout) {
            const age = (Date.now() - grid.createdAt) / 1000;
            if (age > this.config.orderTimeout) {
              console.log(`[GalesStrategy] 订单超时，取消 gridId=${grid.id} age=${age.toFixed(0)}s`);
              this.cancelGridOrder(grid);
            }
          }
          break;
      }
    }
  }

  /**
   * 初始化网格（使用动态gridSpacing）
   */
  private initializeGrids(): void {
    this.gridLevels = [];
    const center = this.centerPrice;

    // 生成买单网格（中心价格下方）
    for (let i = 1; i <= this.config.gridCount; i++) {
      const price = center * (1 - this.currentGridSpacing * i);
      this.gridLevels.push({
        id: this.nextGridId++,
        price,
        side: 'BUY',
        state: 'IDLE',
        attempts: 0,
      });
    }

    // 生成卖单网格（中心价格上方）
    for (let i = 1; i <= this.config.gridCount; i++) {
      const price = center * (1 + this.currentGridSpacing * i);
      this.gridLevels.push({
        id: this.nextGridId++,
        price,
        side: 'SELL',
        state: 'IDLE',
        attempts: 0,
      });
    }

    console.log(
      `[GalesStrategy] 生成网格: ${this.gridLevels.length} 个档位, gridSpacing=${(this.currentGridSpacing * 100).toFixed(2)}%`
    );
  }

  /**
   * 是否应该挂单
   */
  private shouldPlaceOrder(grid: GridLevel, price: number, distance: number): boolean {
    // 距离检查
    if (distance > this.config.magnetDistance) return false;

    // 方向检查：买单要价格在目标上方接近，卖单要在下方接近
    if (grid.side === 'BUY' && price < grid.price) return false;
    if (grid.side === 'SELL' && price > grid.price) return false;

    // 仓位检查
    if (grid.side === 'BUY' && this.positionNotional >= this.config.maxPosition) return false;
    if (grid.side === 'SELL' && this.positionNotional <= -this.config.maxPosition) return false;

    return true;
  }

  /**
   * 挂网格订单
   */
  private async placeGridOrder(grid: GridLevel, currentPrice: number): Promise<void> {
    if (!this.ctx) return;

    grid.state = 'PLACING';
    grid.attempts++;

    // 计算订单价格（带偏移）
    let orderPrice = grid.price;
    if (grid.side === 'BUY') {
      orderPrice = grid.price * (1 - this.config.priceOffset);
    } else {
      orderPrice = grid.price * (1 + this.config.priceOffset);
    }

    // postOnly 保护：如果会吃单，外移 1 tick
    // 优先从symbolInfo获取，其次从config获取，最后才用默认值
    const priceTick = this.symbolInfo?.priceTick ?? this.config.priceTick ?? 0.01;
    if (this.config.postOnly) {
      if (grid.side === 'BUY' && orderPrice >= currentPrice) {
        orderPrice = formatPrice(currentPrice - priceTick, priceTick);
      } else if (grid.side === 'SELL' && orderPrice <= currentPrice) {
        orderPrice = formatPrice(currentPrice + priceTick, priceTick);
      }
    }

    // 确保价格符合精度要求
    orderPrice = formatPrice(orderPrice, priceTick);

    // 计算数量
    const quantity = this.config.orderSize / orderPrice;

    console.log(`[GalesStrategy] ${this.config.simMode ? '[SIM] ' : ''}挂单 gridId=${grid.id} ${grid.side} ${quantity.toFixed(4)} @ ${orderPrice}`);

    if (this.config.simMode) {
      // 模拟模式：直接标记为 ACTIVE
      grid.state = 'ACTIVE';
      grid.orderPrice = orderPrice;
      grid.createdAt = Date.now();
      grid.orderId = `sim-${grid.id}`;
      grid.orderLinkId = `gales-${grid.id}-${grid.side}`;
      this.pendingOrders.set(grid.orderId, grid);
      return;
    }

    try {
      let order: Order;
      if (grid.side === 'BUY') {
        order = await this.ctx.buy(this.config.symbol, quantity, orderPrice);
      } else {
        order = await this.ctx.sell(this.config.symbol, quantity, orderPrice);
      }

      grid.state = 'ACTIVE';
      grid.orderId = order.id;
      grid.orderLinkId = `gales-${grid.id}-${grid.side}`;
      grid.orderPrice = orderPrice;
      grid.createdAt = Date.now();
      this.pendingOrders.set(order.id, grid);

      console.log(`[GalesStrategy] 挂单成功 orderId=${order.id}`);
    } catch (error: any) {
      console.error(`[GalesStrategy] 挂单失败 gridId=${grid.id}:`, error.message);
      grid.state = 'IDLE';
    }
  }

  /**
   * 取消网格订单
   */
  private async cancelGridOrder(grid: GridLevel): Promise<void> {
    if (!this.ctx || !grid.orderId) return;

    grid.state = 'CANCELING';

    if (this.config.simMode) {
      // 模拟模式：直接标记为 IDLE
      this.pendingOrders.delete(grid.orderId);
      grid.state = 'IDLE';
      grid.orderId = undefined;
      grid.orderLinkId = undefined;
      grid.orderPrice = undefined;
      return;
    }

    try {
      await this.ctx.cancelOrder(grid.orderId);
      console.log(`[GalesStrategy] 取消订单成功 orderId=${grid.orderId}`);
    } catch (error: any) {
      console.error(`[GalesStrategy] 取消订单失败 orderId=${grid.orderId}:`, error.message);
    }
  }

  /**
   * 取消所有订单（市场状态异常时使用）
   */
  private async cancelAllOrders(): Promise<void> {
    const activeGrids = this.gridLevels.filter(
      (grid) => grid.state === 'ACTIVE' && grid.orderId
    );

    if (activeGrids.length === 0) {
      console.log('[GalesStrategy] 无活跃订单需要取消');
      return;
    }

    console.log(`[GalesStrategy] 取消所有 ${activeGrids.length} 个活跃订单...`);

    const cancelPromises = activeGrids.map((grid) => this.cancelGridOrder(grid));

    try {
      await Promise.all(cancelPromises);
      console.log('[GalesStrategy] 所有订单已取消');
    } catch (error: any) {
      console.error('[GalesStrategy] 取消订单时出错:', error.message);
    }
  }

  /**
   * 处理订单成交
   */
  private handleOrderFilled(grid: GridLevel, order: Order): void {
    console.log(`[GalesStrategy] 订单成交 gridId=${grid.id} ${grid.side} ${order.filled}@${order.price}`);

    // 更新仓位
    if (grid.side === 'BUY') {
      this.positionNotional += order.filled * (order.price || grid.price);
    } else {
      this.positionNotional -= order.filled * (order.price || grid.price);
    }

    // 重置网格（刷新中心价格 & 重新生成网格）
    this.centerPrice = this.lastPrice;
    this.initializeGrids();

    console.log(`[GalesStrategy] 网格已刷新，新中心价格: ${this.centerPrice}, 当前仓位: ${this.positionNotional.toFixed(2)} USDT`);
  }

  /**
   * 处理订单取消
   */
  private handleOrderCancelled(grid: GridLevel): void {
    this.pendingOrders.delete(grid.orderId!);
    grid.state = 'IDLE';
    grid.orderId = undefined;
    grid.orderLinkId = undefined;
    grid.orderPrice = undefined;
  }
}
