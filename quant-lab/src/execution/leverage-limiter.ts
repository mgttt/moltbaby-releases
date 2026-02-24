// leverage-limiter.ts - 杠杆硬顶机制

import { createLogger } from '../utils/logger';
const logger = createLogger('$(basename $f .ts)');

// P1: 杠杆硬顶机制实现

export interface LeverageLimitConfig {
  maxLeverage: number;        // 最大杠杆倍数 (如 5x)
  maxPositionValue: number;   // 最大持仓价值 (USDT)
  maxMarginUsage: number;     // 最大保证金使用率 (如 80%)
  symbol: string;             // 交易对
}

export interface PositionRisk {
  symbol: string;
  positionValue: number;      // 持仓价值
  marginUsed: number;         // 已用保证金
  leverage: number;           // 当前杠杆
  marginUsage: number;        // 保证金使用率
  isHardLimitTriggered: boolean;  // 是否触发硬顶
}

export class LeverageLimiter {
  private config: LeverageLimitConfig;
  private currentPosition: { size: number; entryPrice: number; side: 'LONG' | 'SHORT' } | null = null;

  constructor(config: LeverageLimitConfig) {
    this.config = config;
    logger.info(`[LeverageLimiter] 初始化: ${config.symbol}, 最大杠杆=${config.maxLeverage}x`);
  }

  /**
   * 检查订单是否违反硬顶限制
   */
  checkOrder(
    orderQty: number,
    orderPrice: number,
    availableMargin: number
  ): { allowed: boolean; reason?: string; risk?: PositionRisk } {
    
    // 计算新仓位
    const newPositionSize = this.currentPosition 
      ? this.currentPosition.size + orderQty
      : orderQty;
    
    const positionValue = newPositionSize * orderPrice;
    const marginUsed = positionValue / this.config.maxLeverage;
    const leverage = positionValue / availableMargin;
    const marginUsage = (marginUsed / availableMargin) * 100;

    // 检查硬顶条件
    if (leverage > this.config.maxLeverage) {
      return {
        allowed: false,
        reason: `杠杆超限: ${leverage.toFixed(2)}x > ${this.config.maxLeverage}x`,
        risk: this.calculateRisk(positionValue, marginUsed, leverage, marginUsage)
      };
    }

    if (positionValue > this.config.maxPositionValue) {
      return {
        allowed: false,
        reason: `持仓价值超限: ${positionValue.toFixed(2)} > ${this.config.maxPositionValue}`,
        risk: this.calculateRisk(positionValue, marginUsed, leverage, marginUsage)
      };
    }

    if (marginUsage > this.config.maxMarginUsage) {
      return {
        allowed: false,
        reason: `保证金使用率超限: ${marginUsage.toFixed(2)}% > ${this.config.maxMarginUsage}%`,
        risk: this.calculateRisk(positionValue, marginUsed, leverage, marginUsage)
      };
    }

    return {
      allowed: true,
      risk: this.calculateRisk(positionValue, marginUsed, leverage, marginUsage)
    };
  }

  /**
   * 更新当前持仓
   */
  updatePosition(size: number, entryPrice: number, side: 'LONG' | 'SHORT'): void {
    this.currentPosition = { size, entryPrice, side };
    logger.info(`[LeverageLimiter] 持仓更新: ${side} ${size} @ ${entryPrice}`);
  }

  /**
   * 获取当前风险状态
   */
  getRiskStatus(availableMargin: number): PositionRisk | null {
    if (!this.currentPosition) return null;

    const positionValue = this.currentPosition.size * this.currentPosition.entryPrice;
    const marginUsed = positionValue / this.config.maxLeverage;
    const leverage = positionValue / availableMargin;
    const marginUsage = (marginUsed / availableMargin) * 100;

    return this.calculateRisk(positionValue, marginUsed, leverage, marginUsage);
  }

  private calculateRisk(
    positionValue: number,
    marginUsed: number,
    leverage: number,
    marginUsage: number
  ): PositionRisk {
    return {
      symbol: this.config.symbol,
      positionValue,
      marginUsed,
      leverage,
      marginUsage,
      isHardLimitTriggered: leverage > this.config.maxLeverage ||
                           positionValue > this.config.maxPositionValue ||
                           marginUsage > this.config.maxMarginUsage
    };
  }
}

// 硬顶触发器 - 当触及硬顶时执行的动作
export class HardLimitTrigger {
  private actions: Array<() => void> = [];

  onHardLimit(callback: () => void): void {
    this.actions.push(callback);
  }

  trigger(): void {
    logger.info('[HardLimitTrigger] 硬顶触发！执行保护动作...');
    this.actions.forEach(action => {
      try {
        action();
      } catch (e) {
        logger.error('[HardLimitTrigger] 动作执行失败:', e);
      }
    });
  }
}

// 测试函数
async function testLeverageLimiter() {
  logger.info('=== 杠杆硬顶机制测试 ===\n');

  // 创建限制器: BTCUSDT, 最大5x杠杆, 最大持仓100000 USDT, 最大保证金使用率80%
  const limiter = new LeverageLimiter({
    symbol: 'BTCUSDT',
    maxLeverage: 5,
    maxPositionValue: 100000,
    maxMarginUsage: 80,
  });

  const availableMargin = 10000; // 可用保证金10000 USDT

  // 测试1: 正常订单
  logger.info('测试1: 正常订单 (1 BTC @ 50000)');
  const result1 = limiter.checkOrder(1, 50000, availableMargin);
  logger.info('  允许:', result1.allowed);
  logger.info('  风险:', JSON.stringify(result1.risk, null, 2));
  logger.info();

  // 测试2: 杠杆超限
  logger.info('测试2: 杠杆超限 (2 BTC @ 50000)');
  const result2 = limiter.checkOrder(2, 50000, availableMargin);
  logger.info('  允许:', result2.allowed);
  logger.info('  原因:', result2.reason);
  logger.info();

  // 测试3: 持仓价值超限
  logger.info('测试3: 持仓价值超限 (3 BTC @ 50000 = 150000 USDT)');
  const result3 = limiter.checkOrder(3, 50000, availableMargin);
  logger.info('  允许:', result3.allowed);
  logger.info('  原因:', result3.reason);
  logger.info();

  // 测试4: 硬顶触发器
  logger.info('测试4: 硬顶触发器');
  const trigger = new HardLimitTrigger();
  trigger.onHardLimit(() => logger.info('  ✅ 触发保护: 禁止新开仓'));
  trigger.onHardLimit(() => logger.info('  ✅ 触发保护: 发送告警'));
  trigger.trigger();
  logger.info();

  logger.info('=== 测试完成 ===');
}

// 运行测试
testLeverageLimiter().catch((err) => logger.error(err));
