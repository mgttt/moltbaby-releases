/**
 * 熔断框架集成模块
 * 
 * 将新的TieredCircuitBreaker与现有引擎集成
 * 提供向后兼容的接口
 */

import { createLogger } from '../utils/logger';
const logger = createLogger('circuit-breaker-integration');

import { TieredCircuitBreaker, CircuitLevel, CircuitState, CircuitStatePersistence } from './tiered-circuit-breaker';

// ============ 向后兼容接口 ============

export interface LegacyCircuitBreakerConfig {
  enabled: boolean;
  maxDrawdown: number;
  maxPositionRatio: number;
  cooldownAfterTrip: number;
}

export interface LegacyCircuitBreakerState {
  active: boolean;
  tripped: boolean;
  blockedSide: string;
  peakNetEq: number;
  highWaterMark: number;
  triggeredAt?: number;
  recoveryTickCount: number;
  blockNewOrders: boolean;
  leverageHardCapTriggeredAt: number;
}

// ============ 集成熔断器 ============

export class IntegratedCircuitBreaker {
  private tieredCB: TieredCircuitBreaker;
  private strategyId: string;
  private legacyState: LegacyCircuitBreakerState;

  constructor(strategyId: string, legacyConfig?: LegacyCircuitBreakerConfig) {
    this.strategyId = strategyId;
    
    // 转换旧配置到新配置
    const tieredConfig = this.convertLegacyConfig(legacyConfig);
    
    // 创建分级熔断器
    this.tieredCB = new TieredCircuitBreaker(strategyId, tieredConfig);
    
    // 初始化向后兼容的状态
    this.legacyState = {
      active: true,
      tripped: false,
      blockedSide: '',
      peakNetEq: 0,
      highWaterMark: 0,
      recoveryTickCount: 0,
      blockNewOrders: false,
      leverageHardCapTriggeredAt: 0,
    };

    // 同步分级熔断器状态到兼容状态
    this.syncLegacyState();

    logger.info(`[IntegratedCircuitBreaker] 初始化完成: ${strategyId}`);
  }

  // ============ 配置转换 ============

  private convertLegacyConfig(legacyConfig?: LegacyCircuitBreakerConfig) {
    if (!legacyConfig) {
      return undefined;
    }

    return {
      classC: {
        enabled: legacyConfig.enabled,
        autoReset: true,
        resetTimeoutMs: legacyConfig.cooldownAfterTrip * 1000,
        maxConsecutiveFailures: 10,
        maxDrawdownPercent: legacyConfig.maxDrawdown,
      },
      statePersistence: {
        enabled: true,
        filePath: '', // 使用默认路径
        saveIntervalMs: 5000,
      },
    };
  }

  // ============ 向后兼容方法 ============

  /**
   * 检查是否允许交易（向后兼容）
   */
  canTrade(): boolean {
    return this.tieredCB.canTrade();
  }

  /**
   * 检查是否熔断（向后兼容）
   */
  isTripped(): boolean {
    return this.tieredCB.getGlobalState() === 'OPEN';
  }

  /**
   * 获取兼容的状态对象
   */
  getLegacyState(): LegacyCircuitBreakerState {
    this.syncLegacyState();
    return { ...this.legacyState };
  }

  /**
   * 设置兼容状态（用于恢复）
   */
  setLegacyState(state: Partial<LegacyCircuitBreakerState>): void {
    Object.assign(this.legacyState, state);
    
    // 同步到分级熔断器
    if (state.peakNetEq !== undefined) {
      const tieredState = this.tieredCB.getState();
      tieredState.classC.peakNetEq = state.peakNetEq;
      tieredState.classC.highWaterMark = state.highWaterMark || state.peakNetEq;
    }
  }

  // ============ 新功能方法 ============

  /**
   * 触发熔断（新接口）
   */
  trip(level: CircuitLevel, code: string, message: string, metadata?: Record<string, any>): void {
    this.tieredCB.trip(level, code, message, metadata);
    this.syncLegacyState();
  }

  /**
   * 检查回撤（C类熔断）
   */
  checkDrawdown(currentNetEq: number): boolean {
    const tripped = this.tieredCB.checkDrawdown(currentNetEq);
    this.syncLegacyState();
    return tripped;
  }

  /**
   * 记录失败
   */
  recordFailure(level: CircuitLevel, error?: string): void {
    this.tieredCB.recordFailure(level, error);
    this.syncLegacyState();
  }

  /**
   * 记录成功
   */
  recordSuccess(level: CircuitLevel): void {
    this.tieredCB.recordSuccess(level);
    this.syncLegacyState();
  }

  /**
   * 获取分级熔断器实例（高级用法）
   */
  getTieredBreaker(): TieredCircuitBreaker {
    return this.tieredCB;
  }

  /**
   * 获取完整状态
   */
  getState(): CircuitStatePersistence {
    return this.tieredCB.getState();
  }

  // ============ 私有方法 ============

  private syncLegacyState(): void {
    const tieredState = this.tieredCB.getState();
    
    this.legacyState.active = tieredState.globalState !== 'OPEN';
    this.legacyState.tripped = tieredState.globalState === 'OPEN';
    this.legacyState.peakNetEq = tieredState.classC.peakNetEq;
    this.legacyState.highWaterMark = tieredState.classC.highWaterMark;
    
    if (tieredState.classC.triggeredAt) {
      this.legacyState.triggeredAt = tieredState.classC.triggeredAt;
    }
  }

  /**
   * 销毁（清理资源）
   */
  destroy(): void {
    this.tieredCB.destroy();
  }
}

// ============ 导出兼容类型 ============

export { CircuitLevel, CircuitState, CircuitStatePersistence } from './tiered-circuit-breaker';
export { TieredCircuitBreaker };

// 默认导出
export default IntegratedCircuitBreaker;
