/**
 * 示例策略 - 简单双均线交叉策略
 * 
 * 基于IStrategy接口的最小示例
 * 演示：初始化 → K线处理 → 订单操作 → 停止
 */

import type { IStrategy, IStrategyContext } from '../src/types';
import type { Kline } from '../../quant-lib/src';

/**
 * 双均线交叉策略
 * 
 * 逻辑：
 * - 短期MA上穿长期MA → 买入
 * - 短期MA下穿长期MA → 卖出
 */
export class MovingAverageCrossStrategy implements IStrategy {
  readonly name = 'MovingAverageCross';
  readonly version = '1.0.0';

  private shortPeriod = 5;
  private longPeriod = 20;
  private symbol = 'BTCUSDT';
  private quantity = 0.001;
  
  private prices: number[] = [];
  private position: 'LONG' | 'SHORT' | 'NONE' = 'NONE';
  private tradeCount = 0;

  async onInit(ctx: IStrategyContext): Promise<void> {
    ctx.logInfo(`[${this.name}] 策略初始化`);
    ctx.logInfo(`[${this.name}] 参数: shortPeriod=${this.shortPeriod}, longPeriod=${this.longPeriod}`);
    ctx.logInfo(`[${this.name}] 交易对: ${this.symbol}, 数量: ${this.quantity}`);
    
    // 初始化时读取已有持仓
    const pos = ctx.getPosition(this.symbol);
    if (pos && pos.quantity > 0) {
      this.position = pos.side === 'LONG' ? 'LONG' : 'SHORT';
      ctx.logInfo(`[${this.name}] 已有持仓: ${this.position} ${pos.quantity}`);
    }
  }

  async onBar(bar: Kline, ctx: IStrategyContext): Promise<void> {
    // 记录价格
    this.prices.push(bar.close);
    
    // 保持固定窗口
    if (this.prices.length > this.longPeriod) {
      this.prices.shift();
    }
    
    // 数据不足时不交易
    if (this.prices.length < this.longPeriod) {
      return;
    }
    
    // 计算均线
    const shortMA = this.calculateMA(this.shortPeriod);
    const longMA = this.calculateMA(this.longPeriod);
    
    // 获取上一周期均线（用于判断交叉）
    const prevShortMA = this.calculateMAAt(this.shortPeriod, 1);
    const prevLongMA = this.calculateMAAt(this.longPeriod, 1);
    
    // 金叉：短期上穿长期
    if (prevShortMA <= prevLongMA && shortMA > longMA) {
      if (this.position !== 'LONG') {
        ctx.logInfo(`[${this.name}] 金叉信号: ${shortMA.toFixed(2)} > ${longMA.toFixed(2)}`);
        
        // 平空仓
        if (this.position === 'SHORT') {
          await ctx.buy(this.symbol, this.quantity);
          ctx.logInfo(`[${this.name}] 平空仓 → 买入 ${this.quantity}`);
        }
        
        // 开多仓
        await ctx.buy(this.symbol, this.quantity);
        ctx.logInfo(`[${this.name}] 开多仓 → 买入 ${this.quantity}`);
        this.position = 'LONG';
        this.tradeCount++;
      }
    }
    
    // 死叉：短期下穿长期
    if (prevShortMA >= prevLongMA && shortMA < longMA) {
      if (this.position !== 'SHORT') {
        ctx.logInfo(`[${this.name}] 死叉信号: ${shortMA.toFixed(2)} < ${longMA.toFixed(2)}`);
        
        // 平多仓
        if (this.position === 'LONG') {
          await ctx.sell(this.symbol, this.quantity);
          ctx.logInfo(`[${this.name}] 平多仓 → 卖出 ${this.quantity}`);
        }
        
        // 开空仓
        await ctx.sell(this.symbol, this.quantity);
        ctx.logInfo(`[${this.name}] 开空仓 → 卖出 ${this.quantity}`);
        this.position = 'SHORT';
        this.tradeCount++;
      }
    }
  }

  async onStop(ctx: IStrategyContext): Promise<void> {
    ctx.logInfo(`[${this.name}] 策略停止`);
    ctx.logInfo(`[${this.name}] 总交易次数: ${this.tradeCount}`);
    ctx.logInfo(`[${this.name}] 最终持仓: ${this.position}`);
  }

  /**
   * 计算简单移动平均
   */
  private calculateMA(period: number): number {
    const slice = this.prices.slice(-period);
    return slice.reduce((sum, p) => sum + p, 0) / slice.length;
  }

  /**
   * 计算N周期前的MA
   */
  private calculateMAAt(period: number, offset: number): number {
    const slice = this.prices.slice(-period - offset, -offset);
    return slice.reduce((sum, p) => sum + p, 0) / slice.length;
  }
}

/**
 * 工厂函数 - 创建策略实例
 */
export function createStrategy(): IStrategy {
  return new MovingAverageCrossStrategy();
}

// 默认导出
export default MovingAverageCrossStrategy;
