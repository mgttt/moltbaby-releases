/**
 * SimulatedProvider - 模拟行情 Provider
 * 
 * 特性：
 * - 支持多种模式（random-walk/sine/trend/scenario）
 * - 时间加速（10x-1000x）
 * - 场景 DSL（自定义价格走势）
 * - 单步调试
 */

import { createLogger } from '../utils/logger';
const logger = createLogger('simulated');

import type { Scenario, ScenarioPhase } from './simulated/scenarios';
import { validateScenario } from './simulated/scenarios';

export interface SimulatedProviderConfig {
  mode: 'random-walk' | 'sine' | 'trend' | 'scenario';
  startPrice: number;
  
  // random-walk 模式
  volatility?: number;      // 波动率 (0.01 = 1%)
  
  // sine 模式
  amplitude?: number;       // 振幅 (百分比)
  period?: number;          // 周期 (秒)
  
  // trend 模式
  trendRate?: number;       // 趋势率 (每秒变化百分比)
  
  // scenario 模式
  scenario?: Scenario;
  
  // 通用
  speed?: number;           // 时间倍速 (默认 1)
  tickIntervalMs?: number;  // 基础 tick 间隔 (默认 1000ms)
  symbol?: string;          // 交易对
}

export class SimulatedProvider {
  private config: Required<SimulatedProviderConfig>;
  private currentPrice: number;
  private running = false;
  private paused = false;
  private timer?: any;
  
  // scenario 模式状态
  private phaseIndex = 0;
  private phaseElapsed = 0;
  private phaseStartPrice = 0;
  
  // sine 模式状态
  private sineTime = 0;
  
  // random-walk 状态
  private lastPrice: number;
  
  // 订单管理（简化版 PaperTrading）
  private openOrders = new Map<string, any>();
  private orderIdCounter = 0;
  
  // 监听器
  private priceListeners: Array<(price: number) => void> = [];
  private orderListeners: Array<(order: any) => void> = [];

  constructor(config: SimulatedProviderConfig) {
    this.config = {
      mode: config.mode,
      startPrice: config.startPrice,
      volatility: config.volatility ?? 0.01,
      amplitude: config.amplitude ?? 0.03,
      period: config.period ?? 120,
      trendRate: config.trendRate ?? 0.0001,
      scenario: config.scenario,
      speed: config.speed ?? 1,
      tickIntervalMs: config.tickIntervalMs ?? 1000,
      symbol: config.symbol ?? 'SIM/USDT',
    };

    this.currentPrice = config.startPrice;
    this.lastPrice = config.startPrice;
    this.phaseStartPrice = config.startPrice;

    if (this.config.mode === 'scenario' && this.config.scenario) {
      validateScenario(this.config.scenario);
    }
  }

  /**
   * 启动行情生成
   */
  start(): void {
    if (this.running) return;

    this.running = true;
    this.paused = false;

    const interval = this.config.tickIntervalMs / this.config.speed;

    this.timer = setInterval(() => {
      if (!this.paused) {
        this.tick();
      }
    }, interval);

    logger.info(`[SimulatedProvider] 启动 | 模式: ${this.config.mode} | 倍速: ${this.config.speed}x | 间隔: ${interval}ms`);
  }

  /**
   * 停止行情生成
   */
  stop(): void {
    if (!this.running) return;

    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    logger.info('[SimulatedProvider] 停止');
  }

  /**
   * 暂停
   */
  pause(): void {
    this.paused = true;
    logger.info('[SimulatedProvider] 暂停');
  }

  /**
   * 恢复
   */
  resume(): void {
    this.paused = false;
    logger.info('[SimulatedProvider] 恢复');
  }

  /**
   * 单步执行（调试用）
   */
  step(): number {
    this.tick();
    return this.currentPrice;
  }

  /**
   * 生成下一个价格
   */
  private tick(): void {
    const dt = (this.config.tickIntervalMs / 1000) * this.config.speed;

    switch (this.config.mode) {
      case 'random-walk':
        this.currentPrice = this.randomWalk(dt);
        break;

      case 'sine':
        this.currentPrice = this.sineWave(dt);
        break;

      case 'trend':
        this.currentPrice = this.trend(dt);
        break;

      case 'scenario':
        this.currentPrice = this.scenarioTick(dt);
        break;
    }

    // 通知监听器
    this.notifyPriceListeners(this.currentPrice);

    // 检查订单成交
    this.checkOrderFills(this.currentPrice);
  }

  /**
   * 随机游走
   */
  private randomWalk(dt: number): number {
    const drift = 0; // 无趋势
    const shock = (Math.random() - 0.5) * 2 * this.config.volatility * Math.sqrt(dt);
    const newPrice = this.lastPrice * (1 + drift * dt + shock);
    this.lastPrice = newPrice;
    return newPrice;
  }

  /**
   * 正弦波动
   */
  private sineWave(dt: number): number {
    this.sineTime += dt;
    const phase = (2 * Math.PI * this.sineTime) / this.config.period;
    const deviation = Math.sin(phase) * this.config.amplitude;
    return this.config.startPrice * (1 + deviation);
  }

  /**
   * 趋势
   */
  private trend(dt: number): number {
    return this.currentPrice * (1 + this.config.trendRate * dt);
  }

  /**
   * 场景模式
   */
  private scenarioTick(dt: number): number {
    if (!this.config.scenario) {
      throw new Error('Scenario mode requires a scenario');
    }

    const { phases } = this.config.scenario;

    // 检查是否需要切换阶段
    if (this.phaseElapsed >= phases[this.phaseIndex].durationSec) {
      this.phaseIndex++;
      this.phaseElapsed = 0;
      this.phaseStartPrice = this.currentPrice;

      if (this.phaseIndex >= phases.length) {
        // 场景结束，循环或停止
        logger.info('[SimulatedProvider] 场景完成，重新开始');
        this.phaseIndex = 0;
        this.phaseStartPrice = this.config.startPrice;
        this.currentPrice = this.config.startPrice;
      }
    }

    const phase = phases[this.phaseIndex];
    const progress = this.phaseElapsed / phase.durationSec;

    let price: number;

    switch (phase.type) {
      case 'range':
        // 区间震荡（正弦）
        price = this.rangePhase(phase, this.phaseElapsed);
        break;

      case 'trend':
      case 'pump':
      case 'dump':
        // 线性趋势
        price = this.trendPhase(phase, progress);
        break;

      case 'gap':
        // 瞬间跳空
        price = phase.targetPrice!;
        break;

      default:
        price = this.currentPrice;
    }

    this.phaseElapsed += dt;

    return price;
  }

  /**
   * 区间震荡阶段
   */
  private rangePhase(phase: ScenarioPhase, elapsed: number): number {
    const centerPrice = phase.price!;
    const range = phase.range!;
    
    // 使用正弦波模拟震荡
    const period = 60; // 1 分钟一个周期
    const phaseAngle = (2 * Math.PI * elapsed) / period;
    const deviation = Math.sin(phaseAngle) * range;
    
    // 添加随机噪声
    const noise = (Math.random() - 0.5) * range * 0.2;
    
    return centerPrice * (1 + deviation + noise);
  }

  /**
   * 趋势阶段
   */
  private trendPhase(phase: ScenarioPhase, progress: number): number {
    const change = phase.change!;
    const targetPrice = this.phaseStartPrice * (1 + change);
    
    // 线性插值 + 随机噪声
    const noise = (Math.random() - 0.5) * Math.abs(change) * 0.05;
    return this.phaseStartPrice + (targetPrice - this.phaseStartPrice) * progress + this.phaseStartPrice * noise;
  }

  // ============================================================
  // TradingProvider 接口实现
  // ============================================================

  async getPrice(symbol: string): Promise<number> {
    return this.currentPrice;
  }

  async placeOrder(params: {
    symbol: string;
    side: 'Buy' | 'Sell';
    qty: number;
    price: number;
    orderLinkId?: string;
  }): Promise<{ orderId: string }> {
    const orderId = `sim-${++this.orderIdCounter}`;
    
    const order = {
      orderId,
      symbol: params.symbol,
      side: params.side,
      price: params.price,
      qty: params.qty,
      status: 'New',
      createdAt: Date.now(),
    };

    this.openOrders.set(orderId, order);

    logger.info(`[SimulatedProvider] 下单: ${params.side} ${params.qty} @ ${params.price}`);

    return { orderId };
  }

  async cancelOrder(symbol: string, orderId: string): Promise<void> {
    const order = this.openOrders.get(orderId);
    
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    order.status = 'Cancelled';
    this.openOrders.delete(orderId);

    logger.info(`[SimulatedProvider] 撤单: ${orderId}`);

    this.notifyOrderListeners({ ...order, status: 'Cancelled' });
  }

  async getOpenOrders(symbol?: string): Promise<any[]> {
    return Array.from(this.openOrders.values());
  }

  async getPosition(symbol: string): Promise<{ size: number; entryPrice: number }> {
    // 简化实现：不追踪仓位
    return { size: 0, entryPrice: 0 };
  }

  async getAccount(): Promise<{ balance: number; equity: number }> {
    // 简化实现：固定余额
    return { balance: 10000, equity: 10000 };
  }

  /**
   * 检查订单成交
   */
  private checkOrderFills(currentPrice: number): void {
    for (const [orderId, order] of this.openOrders.entries()) {
      const filled = (order.side === 'Buy' && currentPrice <= order.price) ||
                    (order.side === 'Sell' && currentPrice >= order.price);

      if (filled) {
        order.status = 'Filled';
        order.filledAt = Date.now();
        order.filledPrice = currentPrice;

        logger.info(`[SimulatedProvider] 成交: ${order.side} ${order.qty} @ ${currentPrice} (订单价: ${order.price})`);

        this.notifyOrderListeners({ ...order });

        this.openOrders.delete(orderId);
      }
    }
  }

  // ============================================================
  // 监听器
  // ============================================================

  onPrice(listener: (price: number) => void): void {
    this.priceListeners.push(listener);
  }

  onOrder(listener: (order: any) => void): void {
    this.orderListeners.push(listener);
  }

  private notifyPriceListeners(price: number): void {
    for (const listener of this.priceListeners) {
      listener(price);
    }
  }

  private notifyOrderListeners(order: any): void {
    for (const listener of this.orderListeners) {
      listener(order);
    }
  }

  // ============================================================
  // 工具方法
  // ============================================================

  getCurrentPrice(): number {
    return this.currentPrice;
  }

  getConfig(): SimulatedProviderConfig {
    return { ...this.config };
  }

  getPhaseInfo(): { index: number; elapsed: number; phase: ScenarioPhase | null } | null {
    if (this.config.mode !== 'scenario' || !this.config.scenario) {
      return null;
    }

    return {
      index: this.phaseIndex,
      elapsed: this.phaseElapsed,
      phase: this.config.scenario.phases[this.phaseIndex] || null,
    };
  }
}
