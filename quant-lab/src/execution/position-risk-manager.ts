/**
 * position-risk-manager.ts - 仓位风险管理集成层
 * 
 * 整合 LeverageLimiter + PositionReducer
 * 提供统一的仓位风险检查与自动降仓能力
 */

import { LeverageLimiter, PositionRisk } from './leverage-limiter';
import {
  PositionReducer,
  ReducePositionState,
  type PositionSnapshot,
  type ReduceAction,
} from './position-reducer';

// ==================== 配置类型 ====================

export interface PositionRiskManagerConfig {
  symbol: string;
  
  // LeverageLimiter 配置
  maxLeverage: number;          // 最大杠杆 (如 5x)
  maxPositionValue: number;     // 最大持仓价值
  maxMarginUsage: number;       // 最大保证金使用率
  
  // PositionReducer 配置
  warningLeverage: number;      // 预警阈值 (默认 3.0)
  reduceLeverage: number;       // 强制降仓阈值 (默认 3.5)
  targetLeverage: number;       // 目标杠杆 (默认 2.5)
  maxReduceRatio: number;       // 单次最大减仓比例
  reduceCooldownMs: number;     // 降仓冷却时间
}

export interface RiskCheckResult {
  allowed: boolean;             // 是否允许操作
  riskLevel: 'SAFE' | 'WARNING' | 'CRITICAL' | 'HARD_LIMIT';
  reason?: string;
  reduceAction?: ReduceAction;  // 如果有降仓指令
  riskMetrics: {
    currentLeverage: number;
    marginUsage: number;
    positionValue: number;
    reducerState: ReducePositionState;
  };
}

export interface PositionUpdateResult {
  riskCheck: RiskCheckResult;
  hardLimitTriggered: boolean;
  reduceInitiated: boolean;
  auditLog: string;
}

// ==================== 主类 ====================

export class PositionRiskManager {
  private limiter: LeverageLimiter;
  private reducer: PositionReducer;
  private config: PositionRiskManagerConfig;
  private onReduceCallback?: (action: ReduceAction) => Promise<boolean>;

  constructor(config: PositionRiskManagerConfig) {
    this.config = config;
    
    // 初始化 LeverageLimiter
    this.limiter = new LeverageLimiter({
      symbol: config.symbol,
      maxLeverage: config.maxLeverage,
      maxPositionValue: config.maxPositionValue,
      maxMarginUsage: config.maxMarginUsage,
    });

    // 初始化 PositionReducer
    this.reducer = new PositionReducer({
      symbol: config.symbol,
      warningLeverage: config.warningLeverage ?? 3.0,
      reduceLeverage: config.reduceLeverage ?? 3.5,
      targetLeverage: config.targetLeverage ?? 2.5,
      maxReduceRatio: config.maxReduceRatio ?? 0.3,
      cooldownMs: config.reduceCooldownMs ?? 60000,
    });

    // 监听降仓事件
    this.reducer.on('reduce:initiated', this.handleReduceInitiated.bind(this));
    this.reducer.on('reduce:completed', this.handleReduceCompleted.bind(this));
    this.reducer.on('reduce:failed', this.handleReduceFailed.bind(this));

    console.log(`[PositionRiskManager] 初始化完成 [${config.symbol}]`);
    console.log(`  硬顶限制: ${config.maxLeverage}x / ${config.maxPositionValue} USDT`);
    console.log(`  降仓阈值: WARNING ${config.warningLeverage ?? 3.0}x / REDUCE ${config.reduceLeverage ?? 3.5}x`);
  }

  // ==================== 公共API ====================

  /**
   * 检查订单是否允许执行（预检查）
   */
  checkOrder(
    orderQty: number,
    orderPrice: number,
    availableMargin: number
  ): RiskCheckResult {
    // 先检查硬顶限制
    const limiterResult = this.limiter.checkOrder(orderQty, orderPrice, availableMargin);
    
    // 获取当前风险状态
    const riskStatus = this.limiter.getRiskStatus(availableMargin);
    const reducerState = this.reducer.getState();

    // 如果硬顶触发，直接拒绝
    if (!limiterResult.allowed) {
      return {
        allowed: false,
        riskLevel: 'HARD_LIMIT',
        reason: limiterResult.reason,
        riskMetrics: {
          currentLeverage: riskStatus?.leverage ?? 0,
          marginUsage: riskStatus?.marginUsage ?? 0,
          positionValue: riskStatus?.positionValue ?? 0,
          reducerState,
        },
      };
    }

    // 根据降仓状态机状态判断风险等级
    let riskLevel: RiskCheckResult['riskLevel'] = 'SAFE';
    if (reducerState === ReducePositionState.WARNING) {
      riskLevel = 'WARNING';
    } else if (reducerState === ReducePositionState.REDUCE) {
      riskLevel = 'CRITICAL';
    }

    return {
      allowed: true,
      riskLevel,
      riskMetrics: {
        currentLeverage: riskStatus?.leverage ?? 0,
        marginUsage: riskStatus?.marginUsage ?? 0,
        positionValue: riskStatus?.positionValue ?? 0,
        reducerState,
      },
    };
  }

  /**
   * 更新持仓（实际持仓变化后调用）
   * 
   * 这是核心方法：
   * 1. 更新 LeverageLimiter 的持仓记录
   * 2. 触发 PositionReducer 的状态机流转
   * 3. 如有降仓指令，自动执行
   */
  async updatePosition(
    position: {
      size: number;
      entryPrice: number;
      side: 'LONG' | 'SHORT';
      markPrice: number;
      availableMargin: number;
    }
  ): Promise<PositionUpdateResult> {
    const { size, entryPrice, side, markPrice, availableMargin } = position;

    // 1. 更新 LeverageLimiter
    this.limiter.updatePosition(size, entryPrice, side);

    // 2. 计算当前风险指标
    const positionValue = size * markPrice;
    const marginUsed = positionValue / this.config.maxLeverage;
    const leverage = positionValue / availableMargin;
    const marginUsage = (marginUsed / availableMargin) * 100;

    // 3. 创建 PositionSnapshot
    const snapshot: PositionSnapshot = {
      timestamp: Date.now(),
      symbol: this.config.symbol,
      positionSize: size,
      positionValue,
      entryPrice,
      markPrice,
      leverage,
      marginUsed,
      availableMargin,
      side,
    };

    // 4. 触发状态机
    const reduceResult = this.reducer.updatePosition(snapshot);

    // 5. 如果有降仓指令，标记为已发起
    // 注意：实际执行由事件监听 handleReduceInitiated 处理，避免重复调用
    const reduceInitiated = !!reduceResult.action;

    // 6. 构建结果（使用触发后的状态，因为执行回调后状态可能已经变为RECOVERY）
    const riskCheck: RiskCheckResult = {
      allowed: leverage <= this.config.maxLeverage,
      riskLevel: this.calculateRiskLevel(leverage, reduceResult.state),
      reduceAction: reduceResult.action,
      riskMetrics: {
        currentLeverage: leverage,
        marginUsage,
        positionValue,
        reducerState: reduceResult.state,
      },
    };

    // 7. 检查硬顶
    const hardLimitTriggered = leverage > this.config.maxLeverage ||
                               positionValue > this.config.maxPositionValue ||
                               marginUsage > this.config.maxMarginUsage;

    return {
      riskCheck,
      hardLimitTriggered,
      reduceInitiated,
      auditLog: this.generateAuditLog(snapshot, reduceResult.action),
    };
  }

  /**
   * 注册降仓执行回调
   * 当状态机触发降仓时，会调用此回调执行实际减仓操作
   */
  onReduce(callback: (action: ReduceAction) => Promise<boolean>): void {
    this.onReduceCallback = callback;
  }

  /**
   * 确认降仓完成
   * 执行层完成降仓后调用
   */
  confirmReduce(actionId: string, result: {
    executed: boolean;
    executionPrice?: number;
    txHash?: string;
    error?: string;
  }): void {
    this.reducer.confirmReduce(actionId, result);
  }

  /**
   * 强制降仓（紧急风控）
   */
  forceReduce(reason: string): ReduceAction | null {
    return this.reducer.forceReduce(reason);
  }

  /**
   * 获取当前状态
   */
  getStatus(): {
    symbol: string;
    reducerState: ReducePositionState;
    position: ReturnType<typeof this.reducer.getPosition>;
    audit: ReturnType<typeof this.reducer.getAudit>;
  } {
    return {
      symbol: this.config.symbol,
      reducerState: this.reducer.getState(),
      position: this.reducer.getPosition(),
      audit: this.reducer.getAudit(),
    };
  }

  /**
   * 获取状态机可视化图
   */
  getStateDiagram(): string {
    return this.reducer.getStateDiagram();
  }

  /**
   * 重置（仅用于测试）
   */
  reset(): void {
    this.reducer.reset();
    console.log(`[PositionRiskManager] 已重置`);
  }

  // ==================== 私有方法 ====================

  private calculateRiskLevel(
    leverage: number,
    reducerState: ReducePositionState
  ): RiskCheckResult['riskLevel'] {
    if (reducerState === ReducePositionState.REDUCE) return 'CRITICAL';
    if (reducerState === ReducePositionState.WARNING) return 'WARNING';
    if (leverage > this.config.maxLeverage) return 'HARD_LIMIT';
    return 'SAFE';
  }

  private async handleReduceInitiated(action: ReduceAction): Promise<void> {
    console.log(`[PositionRiskManager] 🎯 降仓指令已生成: ${action.actionId}`);
    
    // 如果有注册的回调，自动执行
    if (this.onReduceCallback) {
      try {
        const success = await this.onReduceCallback(action);
        if (success) {
          console.log(`[PositionRiskManager] ✅ 降仓执行成功`);
        } else {
          console.log(`[PositionRiskManager] ⚠️ 降仓执行被跳过`);
        }
      } catch (error) {
        console.error(`[PositionRiskManager] ❌ 降仓执行失败:`, error);
      }
    }
  }

  private handleReduceCompleted(action: ReduceAction): void {
    console.log(`[PositionRiskManager] ✅ 降仓完成确认: ${action.actionId}`);
  }

  private handleReduceFailed(action: ReduceAction, error?: string): void {
    console.error(`[PositionRiskManager] ❌ 降仓失败: ${action.actionId}, 错误: ${error}`);
  }

  private generateAuditLog(snapshot: PositionSnapshot, action?: ReduceAction): string {
    const lines = [
      `[${new Date().toISOString()}] ${this.config.symbol}`,
      `  杠杆: ${snapshot.leverage.toFixed(2)}x`,
      `  持仓: ${snapshot.positionSize} @ ${snapshot.entryPrice}`,
      `  状态: ${this.reducer.getState()}`,
    ];

    if (action) {
      lines.push(`  降仓: -${action.reduceQty} (${(action.reduceRatio * 100).toFixed(1)}%) → ${action.expectedLeverageAfter}x`);
    }

    return lines.join('\n');
  }
}

// ==================== 工厂函数 ====================

export function createPositionRiskManager(
  config: PositionRiskManagerConfig
): PositionRiskManager {
  return new PositionRiskManager(config);
}

// ==================== 导出类型 ====================

export { ReducePositionState, PositionSnapshot, ReduceAction };
export default PositionRiskManager;
