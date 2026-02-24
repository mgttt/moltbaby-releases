/**
 * risk-aggregator.ts - 全局风险聚合器
 * 
 * 产品背景：多策略同跑时，每个策略独立风控，但无全局视图。
 * 若gales-neutral+gales-short同时运行，总杠杆可能超过安全线却无人知晓。
 * 
 * 核心能力：
 * 1. 聚合所有运行中策略的持仓/杠杆
 * 2. 全局总杠杆限制（跨策略硬顶）
 * 3. 总持仓超限→告警+阻止新策略启动
 * 4. 实时风险视图接口
 */

import { createLogger } from '../utils/logger';
const logger = createLogger('risk-aggregator');

import { EventEmitter } from 'events';

// ==================== 类型定义 ====================

export interface StrategyRiskSnapshot {
  strategyId: string;
  sessionId: string;
  symbol: string;
  side: 'LONG' | 'SHORT' | 'NEUTRAL';
  positionSize: number;         // 持仓数量
  positionValue: number;        // 持仓价值(USDT)
  leverage: number;             // 当前杠杆
  marginUsed: number;           // 占用保证金
  timestamp: number;            // 更新时间
}

export interface GlobalRiskLimits {
  maxTotalLeverage: number;     // 全局最大总杠杆
  maxTotalPositionValue: number; // 全局最大持仓价值
  maxTotalMarginUsage: number;   // 全局最大保证金使用率
  maxStrategyCount: number;      // 最大策略数量
}

export interface GlobalRiskState {
  strategies: Map<string, StrategyRiskSnapshot>;  // 策略ID -> 风险快照
  totalPositionValue: number;   // 总持仓价值
  totalMarginUsed: number;      // 总占用保证金
  totalLeverage: number;        // 总杠杆(加权)
  strategyCount: number;        // 当前策略数量
  lastUpdated: number;          // 最后更新时间
}

export interface GlobalRiskCheckResult {
  allowed: boolean;
  currentState: GlobalRiskState;
  violations: string[];
  warnings: string[];
}

export interface RiskAggregatorConfig {
  limits: GlobalRiskLimits;
  alertConfig?: {
    enabled: boolean;
    tgChatId?: string;
    onViolation?: (result: GlobalRiskCheckResult) => Promise<void>;
    onWarning?: (result: GlobalRiskCheckResult) => Promise<void>;
  };
}

// ==================== 全局风险聚合器 ====================

export class GlobalRiskAggregator extends EventEmitter {
  private config: RiskAggregatorConfig;
  private state: GlobalRiskState;

  constructor(config: RiskAggregatorConfig) {
    super();
    this.config = config;
    this.state = {
      strategies: new Map(),
      totalPositionValue: 0,
      totalMarginUsed: 0,
      totalLeverage: 0,
      strategyCount: 0,
      lastUpdated: Date.now(),
    };

    logger.info('[GlobalRiskAggregator] 初始化完成');
    logger.info(`  全局杠杆限制: ${config.limits.maxTotalLeverage}x`);
    logger.info(`  全局持仓限制: ${config.limits.maxTotalPositionValue} USDT`);
    logger.info(`  最大策略数量: ${config.limits.maxStrategyCount}`);
  }

  /**
   * 注册策略（启动时调用）
   * 
   * @returns 是否允许启动
   */
  async registerStrategy(snapshot: StrategyRiskSnapshot): Promise<boolean> {
    logger.info(`[GlobalRiskAggregator] 📝 注册策略: ${snapshot.strategyId}`);

    // 检查策略数量限制
    if (this.state.strategyCount >= this.config.limits.maxStrategyCount) {
      const reason = `策略数量超限: ${this.state.strategyCount}/${this.config.limits.maxStrategyCount}`;
      logger.error(`[GlobalRiskAggregator] ❌ ${reason}`);
      this.emit('strategy:rejected', { snapshot, reasons: [reason] });
      await this.sendAlert('strategy_count_exceeded', reason);
      return false;
    }

    // 模拟添加后的状态进行检查
    const simulatedState = this.simulateAddStrategy(snapshot);
    const checkResult = this.checkLimits(simulatedState);

    if (!checkResult.allowed) {
      logger.error(`[GlobalRiskAggregator] ❌ 策略注册被拒绝: ${checkResult.violations.join(', ')}`);
      await this.sendAlert('registration_rejected', checkResult.violations.join('; '));
      this.emit('strategy:rejected', { snapshot, reasons: checkResult.violations });
      return false;
    }

    // 实际添加策略
    this.state.strategies.set(snapshot.strategyId, snapshot);
    this.recalculateTotals();

    logger.info(`[GlobalRiskAggregator] ✅ 策略注册成功: ${snapshot.strategyId}`);
    logger.info(`  当前策略数: ${this.state.strategyCount}`);
    logger.info(`  总持仓价值: ${this.state.totalPositionValue.toFixed(2)} USDT`);
    logger.info(`  总杠杆: ${this.state.totalLeverage.toFixed(2)}x`);

    this.emit('strategy:registered', snapshot);
    
    // 检查警告
    if (checkResult.warnings.length > 0) {
      logger.warn(`[GlobalRiskAggregator] ⚠️ 警告: ${checkResult.warnings.join(', ')}`);
      await this.sendAlert('warning', checkResult.warnings.join('; '));
    }

    return true;
  }

  /**
   * 更新策略风险快照
   */
  updateStrategySnapshot(strategyId: string, snapshot: Partial<StrategyRiskSnapshot>): void {
    const existing = this.state.strategies.get(strategyId);
    if (!existing) {
      logger.warn(`[GlobalRiskAggregator] ⚠️ 策略不存在: ${strategyId}`);
      return;
    }

    const updated = { ...existing, ...snapshot, timestamp: Date.now() };
    this.state.strategies.set(strategyId, updated);
    this.recalculateTotals();

    // 检查是否触发限制
    const checkResult = this.checkLimits(this.state);
    if (!checkResult.allowed) {
      logger.error(`[GlobalRiskAggregator] 🚨 全局风险超限!`);
      logger.error(`  违规项: ${checkResult.violations.join(', ')}`);
      this.sendAlert('limit_exceeded', checkResult.violations.join('; '));
      this.emit('risk:limit_exceeded', checkResult);
    }

    this.emit('strategy:updated', updated);
  }

  /**
   * 注销策略（停止时调用）
   */
  unregisterStrategy(strategyId: string): void {
    if (!this.state.strategies.has(strategyId)) {
      return;
    }

    this.state.strategies.delete(strategyId);
    this.recalculateTotals();

    logger.info(`[GlobalRiskAggregator] 🗑️ 策略注销: ${strategyId}`);
    logger.info(`  当前策略数: ${this.state.strategyCount}`);
    logger.info(`  总持仓价值: ${this.state.totalPositionValue.toFixed(2)} USDT`);

    this.emit('strategy:unregistered', { strategyId });
  }

  /**
   * 获取当前全局风险状态
   */
  getGlobalState(): GlobalRiskState {
    return {
      ...this.state,
      strategies: new Map(this.state.strategies), // 返回副本
    };
  }

  /**
   * 获取实时风险视图
   */
  getRiskView(): {
    summary: {
      totalPositionValue: number;
      totalMarginUsed: number;
      totalLeverage: number;
      strategyCount: number;
    };
    limits: GlobalRiskLimits;
    utilization: {
      positionValuePct: number;
      leveragePct: number;
      strategyCountPct: number;
    };
    strategies: StrategyRiskSnapshot[];
    status: 'SAFE' | 'WARNING' | 'CRITICAL';
  } {
    const limits = this.config.limits;
    
    const positionValuePct = (this.state.totalPositionValue / limits.maxTotalPositionValue) * 100;
    const leveragePct = (this.state.totalLeverage / limits.maxTotalLeverage) * 100;
    const strategyCountPct = (this.state.strategyCount / limits.maxStrategyCount) * 100;

    let status: 'SAFE' | 'WARNING' | 'CRITICAL' = 'SAFE';
    if (leveragePct >= 100 || positionValuePct >= 100) {
      status = 'CRITICAL';
    } else if (leveragePct >= 80 || positionValuePct >= 80) {
      status = 'WARNING';
    }

    return {
      summary: {
        totalPositionValue: this.state.totalPositionValue,
        totalMarginUsed: this.state.totalMarginUsed,
        totalLeverage: this.state.totalLeverage,
        strategyCount: this.state.strategyCount,
      },
      limits,
      utilization: {
        positionValuePct,
        leveragePct,
        strategyCountPct,
      },
      strategies: Array.from(this.state.strategies.values()),
      status,
    };
  }

  /**
   * 检查是否允许新策略启动（供pre-flight check调用）
   */
  checkNewStrategy(snapshot: StrategyRiskSnapshot): GlobalRiskCheckResult {
    const simulatedState = this.simulateAddStrategy(snapshot);
    return this.checkLimits(simulatedState);
  }

  /**
   * 生成风险报告
   */
  generateReport(): string {
    const view = this.getRiskView();
    
    const lines = [
      '========================================',
      '        全局风险聚合器报告',
      '========================================',
      `状态: ${view.status}`,
      `策略数量: ${view.summary.strategyCount}/${view.limits.maxStrategyCount} (${view.utilization.strategyCountPct.toFixed(1)}%)`,
      '',
      '--- 持仓概况 ---',
      `总持仓价值: ${view.summary.totalPositionValue.toFixed(2)} / ${view.limits.maxTotalPositionValue} USDT (${view.utilization.positionValuePct.toFixed(1)}%)`,
      `总保证金: ${view.summary.totalMarginUsed.toFixed(2)} USDT`,
      `总杠杆: ${view.summary.totalLeverage.toFixed(2)}x / ${view.limits.maxTotalLeverage}x (${view.utilization.leveragePct.toFixed(1)}%)`,
      '',
      '--- 策略明细 ---',
    ];

    view.strategies.forEach(s => {
      lines.push(`  ${s.strategyId}:`);
      lines.push(`    ${s.symbol} ${s.side} ${s.positionSize} @ ${s.leverage.toFixed(2)}x`);
      lines.push(`    价值: ${s.positionValue.toFixed(2)} USDT`);
    });

    lines.push('========================================');

    return lines.join('\n');
  }

  // ==================== 私有方法 ====================

  /**
   * 模拟添加策略后的状态（用于预检）
   */
  private simulateAddStrategy(newSnapshot: StrategyRiskSnapshot): GlobalRiskState {
    const simulatedStrategies = new Map(this.state.strategies);
    simulatedStrategies.set(newSnapshot.strategyId, newSnapshot);

    let totalPositionValue = 0;
    let totalMarginUsed = 0;
    let totalLeverage = 0;

    for (const s of simulatedStrategies.values()) {
      totalPositionValue += s.positionValue;
      totalMarginUsed += s.marginUsed;
      totalLeverage += s.leverage;
    }

    return {
      strategies: simulatedStrategies,
      totalPositionValue,
      totalMarginUsed,
      totalLeverage,
      strategyCount: simulatedStrategies.size,
      lastUpdated: Date.now(),
    };
  }

  /**
   * 检查是否超过限制
   */
  private checkLimits(state: GlobalRiskState): GlobalRiskCheckResult {
    const violations: string[] = [];
    const warnings: string[] = [];
    const limits = this.config.limits;

    // 检查策略数量
    if (state.strategyCount > limits.maxStrategyCount) {
      violations.push(`策略数量超限: ${state.strategyCount} > ${limits.maxStrategyCount}`);
    } else if (state.strategyCount >= limits.maxStrategyCount * 0.9) {
      warnings.push(`策略数量接近上限: ${state.strategyCount}/${limits.maxStrategyCount}`);
    }

    // 检查总持仓价值
    if (state.totalPositionValue > limits.maxTotalPositionValue) {
      violations.push(`总持仓价值超限: ${state.totalPositionValue.toFixed(2)} > ${limits.maxTotalPositionValue}`);
    } else if (state.totalPositionValue >= limits.maxTotalPositionValue * 0.9) {
      warnings.push(`总持仓价值接近上限: ${(state.totalPositionValue/limits.maxTotalPositionValue*100).toFixed(1)}%`);
    }

    // 检查总杠杆
    if (state.totalLeverage > limits.maxTotalLeverage) {
      violations.push(`总杠杆超限: ${state.totalLeverage.toFixed(2)}x > ${limits.maxTotalLeverage}x`);
    } else if (state.totalLeverage >= limits.maxTotalLeverage * 0.9) {
      warnings.push(`总杠杆接近上限: ${(state.totalLeverage/limits.maxTotalLeverage*100).toFixed(1)}%`);
    }

    return {
      allowed: violations.length === 0,
      currentState: state,
      violations,
      warnings,
    };
  }

  /**
   * 重新计算总量
   */
  private recalculateTotals(): void {
    let totalPositionValue = 0;
    let totalMarginUsed = 0;
    let totalLeverage = 0;

    for (const s of this.state.strategies.values()) {
      totalPositionValue += s.positionValue;
      totalMarginUsed += s.marginUsed;
      totalLeverage += s.leverage;
    }

    this.state.totalPositionValue = totalPositionValue;
    this.state.totalMarginUsed = totalMarginUsed;
    this.state.totalLeverage = totalLeverage;
    this.state.strategyCount = this.state.strategies.size;
    this.state.lastUpdated = Date.now();
  }

  /**
   * 发送告警
   */
  private async sendAlert(type: string, message: string): Promise<void> {
    if (!this.config.alertConfig?.enabled) {
      return;
    }

    logger.error(`[GlobalRiskAggregator] 🚨 告警[${type}]: ${message}`);

    try {
      if (this.config.alertConfig.onViolation) {
        await this.config.alertConfig.onViolation({
          allowed: false,
          currentState: this.state,
          violations: [message],
          warnings: [],
        });
      }
      this.emit('alert:sent', { type, message });
    } catch (error) {
      logger.error('[GlobalRiskAggregator] ❌ 告警发送失败:', error);
    }
  }
}

// ==================== 工厂函数 ====================

export function createGlobalRiskAggregator(
  config: RiskAggregatorConfig
): GlobalRiskAggregator {
  return new GlobalRiskAggregator(config);
}

// ==================== 单例实例（可选） ====================

let globalAggregator: GlobalRiskAggregator | null = null;

export function getGlobalRiskAggregator(config?: RiskAggregatorConfig): GlobalRiskAggregator {
  if (!globalAggregator && config) {
    globalAggregator = createGlobalRiskAggregator(config);
  }
  if (!globalAggregator) {
    throw new Error('GlobalRiskAggregator未初始化');
  }
  return globalAggregator;
}

export function resetGlobalRiskAggregator(): void {
  globalAggregator = null;
}

// ==================== 默认导出 ====================

export default GlobalRiskAggregator;
