/**
 * position-reducer.ts - 降仓触发状态机
 * 
 * 状态流转: IDLE → WARNING → REDUCE → RECOVERY → IDLE
 * 触发条件: 杠杆 > 3.0x 进入降仓流程
 */

import { createLogger } from '../utils/logger';
const logger = createLogger('position-reducer');

import { EventEmitter } from 'events';

// ==================== 类型定义 ====================

export enum ReducePositionState {
  IDLE = 'IDLE',           // 正常状态
  WARNING = 'WARNING',     // 预警状态 (lev > 3.0)
  REDUCE = 'REDUCE',       // 执行降仓
  RECOVERY = 'RECOVERY',   // 恢复观察
}

export interface PositionReducerConfig {
  symbol: string;
  warningLeverage: number;      // 预警阈值 (默认 3.0)
  reduceLeverage: number;       // 强制降仓阈值 (默认 3.5)
  targetLeverage: number;       // 目标杠杆 (默认 2.5)
  maxReduceRatio: number;       // 单次最大减仓比例 (默认 30%)
  cooldownMs: number;           // 降仓冷却时间 (默认 60秒)
  auditLogPath?: string;        // 审计日志路径
}

export interface PositionSnapshot {
  timestamp: number;
  symbol: string;
  positionSize: number;         // 持仓数量
  positionValue: number;        // 持仓价值
  entryPrice: number;           // 均价
  markPrice: number;            // 标记价
  leverage: number;             // 当前杠杆
  marginUsed: number;           // 占用保证金
  availableMargin: number;      // 可用保证金
  side: 'LONG' | 'SHORT';
}

export interface ReduceAction {
  actionId: string;
  timestamp: number;
  state: ReducePositionState;
  reason: string;
  reduceQty: number;            // 减仓数量
  reduceRatio: number;          // 减仓比例
  expectedLeverageAfter: number; // 预期降仓后杠杆
  executed: boolean;
  executionPrice?: number;
  executionTime?: number;
  txHash?: string;              // 交易哈希（可审计）
}

export interface StateTransition {
  from: ReducePositionState;
  to: ReducePositionState;
  trigger: string;
  timestamp: number;
  position: PositionSnapshot;
}

export interface AuditRecord {
  sessionId: string;
  transitions: StateTransition[];
  actions: ReduceAction[];
  createdAt: number;
  updatedAt: number;
}

// ==================== 配置默认值 ====================

const DEFAULT_CONFIG: Partial<PositionReducerConfig> = {
  warningLeverage: 3.0,
  reduceLeverage: 3.5,
  targetLeverage: 2.5,
  maxReduceRatio: 0.3,
  cooldownMs: 60000,
};

// ==================== 降仓状态机 ====================

export class PositionReducer extends EventEmitter {
  private config: PositionReducerConfig;
  private state: ReducePositionState = ReducePositionState.IDLE;
  private lastReduceTime: number = 0;
  private sessionId: string;
  private audit: AuditRecord;
  private currentPosition: PositionSnapshot | null = null;
  private reduceInProgress: boolean = false;

  constructor(config: PositionReducerConfig) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sessionId = this.generateSessionId();
    this.audit = {
      sessionId: this.sessionId,
      transitions: [],
      actions: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    logger.info(`[PositionReducer] 初始化 [${this.sessionId}]`);
    logger.info(`  预警阈值: ${this.config.warningLeverage}x`);
    logger.info(`  降仓阈值: ${this.config.reduceLeverage}x`);
    logger.info(`  目标杠杆: ${this.config.targetLeverage}x`);
  }

  // ==================== 公共API ====================

  /**
   * 获取当前状态
   */
  getState(): ReducePositionState {
    return this.state;
  }

  /**
   * 获取当前持仓快照
   */
  getPosition(): PositionSnapshot | null {
    return this.currentPosition;
  }

  /**
   * 获取审计记录
   */
  getAudit(): AuditRecord {
    return { ...this.audit, updatedAt: Date.now() };
  }

  /**
   * 更新持仓并检查状态流转
   * 核心业务逻辑：根据当前杠杆决定状态流转
   */
  updatePosition(position: PositionSnapshot): { stateChanged: boolean; state: ReducePositionState; action?: ReduceAction } {
    this.currentPosition = position;
    const prevState = this.state;

    // 根据当前杠杆计算目标状态
    const targetState = this.calculateTargetState(position.leverage);

    // 执行状态流转
    if (targetState !== prevState) {
      this.transitionTo(targetState, `杠杆=${position.leverage.toFixed(2)}x`);
    }

    // 根据当前状态执行相应动作
    let action: ReduceAction | undefined;
    if (this.state === ReducePositionState.REDUCE && !this.reduceInProgress) {
      if (this.canReduce()) {
        action = this.executeReduce(position);
      }
    }

    // 记录当前状态（事件触发前）
    const currentState = this.state;

    // 触发事件（在状态记录后，确保调用方能获取正确的状态）
    if (action) {
      this.emit('reduce:initiated', action);
    }

    return {
      stateChanged: currentState !== prevState,
      state: currentState,
      action,
    };
  }

  /**
   * 手动触发降仓（紧急情况下使用）
   */
  forceReduce(reason: string): ReduceAction | null {
    if (!this.currentPosition || this.reduceInProgress) {
      return null;
    }

    logger.info(`[PositionReducer] 🚨 强制降仓触发: ${reason}`);
    this.transitionTo(ReducePositionState.REDUCE, `FORCE: ${reason}`);
    return this.executeReduce(this.currentPosition, reason);
  }

  /**
   * 确认降仓完成（由执行层调用）
   */
  confirmReduce(actionId: string, executionResult: {
    executed: boolean;
    executionPrice?: number;
    txHash?: string;
    error?: string;
  }): void {
    const action = this.audit.actions.find(a => a.actionId === actionId);
    if (!action) {
      logger.error(`[PositionReducer] ❌ 未找到 action: ${actionId}`);
      return;
    }

    action.executed = executionResult.executed;
    action.executionPrice = executionResult.executionPrice;
    action.executionTime = Date.now();
    action.txHash = executionResult.txHash;

    this.reduceInProgress = false;

    if (executionResult.executed) {
      logger.info(`[PositionReducer] ✅ 降仓完成: ${actionId}`);
      this.transitionTo(ReducePositionState.RECOVERY, '降仓执行成功');
      this.emit('reduce:completed', action);
    } else {
      logger.error(`[PositionReducer] ❌ 降仓失败: ${executionResult.error}`);
      this.emit('reduce:failed', action, executionResult.error);
    }

    this.audit.updatedAt = Date.now();
  }

  /**
   * 重置为IDLE状态（仅用于测试或手动恢复）
   */
  reset(): void {
    logger.info(`[PositionReducer] 🔄 手动重置状态`);
    this.transitionTo(ReducePositionState.IDLE, 'MANUAL_RESET');
    this.reduceInProgress = false;
  }

  /**
   * 获取状态机可视化数据
   */
  getStateDiagram(): string {
    return `
┌─────────────────────────────────────────────────────────┐
│              降仓触发状态机 (ReducePositionState)        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│   ┌──────┐    lev>3.0    ┌─────────┐    lev>3.5    ┌───────┐
│   │ IDLE │ ─────────────→│ WARNING │ ─────────────→│ REDUCE│
│   └──┬───┘               └────┬────┘               └───┬───┘
│      │    lev≤3.0             │   lev≤3.0              │
│      │←───────────────────────┘                        │
│      │                        ┌─────────────────────────┘
│      │    lev≤2.5             │   降仓完成
│      │←───────────────────────┘
│   ┌──┴───┐
│   │RECOVERY│
│   └──┬───┘
│      │ lev>3.0
│      └────────────────────────────────────────────────→ [WARNING]
│                                                         │
└─────────────────────────────────────────────────────────┘
    `;
  }

  // ==================== 私有方法 ====================

  /**
   * 根据杠杆计算目标状态
   */
  private calculateTargetState(leverage: number): ReducePositionState {
    switch (this.state) {
      case ReducePositionState.IDLE:
        if (leverage > this.config.warningLeverage!) {
          return ReducePositionState.WARNING;
        }
        return ReducePositionState.IDLE;

      case ReducePositionState.WARNING:
        if (leverage > this.config.reduceLeverage!) {
          return ReducePositionState.REDUCE;
        }
        if (leverage <= this.config.warningLeverage!) {
          return ReducePositionState.IDLE;
        }
        return ReducePositionState.WARNING;

      case ReducePositionState.REDUCE:
        // REDUCE 状态需要等待降仓完成确认
        // 这里保持当前状态，由 confirmReduce 来流转
        return ReducePositionState.REDUCE;

      case ReducePositionState.RECOVERY:
        if (leverage > this.config.warningLeverage!) {
          return ReducePositionState.WARNING;
        }
        if (leverage <= this.config.targetLeverage!) {
          return ReducePositionState.IDLE;
        }
        return ReducePositionState.RECOVERY;

      default:
        return ReducePositionState.IDLE;
    }
  }

  /**
   * 执行状态流转
   */
  private transitionTo(newState: ReducePositionState, trigger: string): void {
    const oldState = this.state;
    this.state = newState;

    const transition: StateTransition = {
      from: oldState,
      to: newState,
      trigger,
      timestamp: Date.now(),
      position: this.currentPosition!,
    };

    this.audit.transitions.push(transition);
    this.audit.updatedAt = Date.now();

    const icon = this.getStateIcon(newState);
    logger.info(`[PositionReducer] ${icon} 状态流转: ${oldState} → ${newState} | 触发: ${trigger}`);

    this.emit('state:changed', transition);
    this.emit(`state:${newState.toLowerCase()}`, transition);
  }

  /**
   * 检查是否可以执行降仓
   */
  private canReduce(): boolean {
    const now = Date.now();
    if (now - this.lastReduceTime < this.config.cooldownMs!) {
      logger.info(`[PositionReducer] ⏳ 降仓冷却中，还需 ${Math.ceil((this.config.cooldownMs! - (now - this.lastReduceTime)) / 1000)}秒`);
      return false;
    }
    return true;
  }

  /**
   * 执行降仓计算（不触发事件）
   */
  private executeReduce(position: PositionSnapshot, customReason?: string): ReduceAction {
    this.reduceInProgress = true;
    this.lastReduceTime = Date.now();

    // 计算需要减仓的数量
    const reduceResult = this.calculateReduceQty(position);

    const defaultReason = `杠杆过高: ${position.leverage.toFixed(2)}x > ${this.config.reduceLeverage}x`;

    const action: ReduceAction = {
      actionId: `reduce_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      state: this.state,
      reason: customReason ?? defaultReason,
      reduceQty: reduceResult.qty,
      reduceRatio: reduceResult.ratio,
      expectedLeverageAfter: reduceResult.expectedLeverage,
      executed: false,
    };

    this.audit.actions.push(action);
    this.audit.updatedAt = Date.now();

    logger.info(`[PositionReducer] 🎯 生成降仓指令:`);
    logger.info(`  Action ID: ${action.actionId}`);
    logger.info(`  减仓数量: ${action.reduceQty}`);
    logger.info(`  减仓比例: ${(action.reduceRatio * 100).toFixed(2)}%`);
    logger.info(`  预期降仓后杠杆: ${action.expectedLeverageAfter.toFixed(2)}x`);

    // 注意：事件由调用方触发，确保状态记录先于事件处理

    return action;
  }

  /**
   * 计算减仓数量
   * 核心算法：根据目标杠杆反推需要减仓的数量
   */
  private calculateReduceQty(position: PositionSnapshot): {
    qty: number;
    ratio: number;
    expectedLeverage: number;
  } {
    const { positionSize, positionValue, leverage, marginUsed, availableMargin, side } = position;

    // 目标持仓价值 = 目标杠杆 * 保证金
    const targetPositionValue = this.config.targetLeverage! * marginUsed;
    
    // 需要减少的持仓价值
    const reduceValue = positionValue - targetPositionValue;
    
    // 需要减仓的数量
    let reduceQty = reduceValue / position.entryPrice;

    // 限制单次最大减仓比例
    const maxReduceQty = positionSize * this.config.maxReduceRatio!;
    if (reduceQty > maxReduceQty) {
      logger.info(`[PositionReducer] ⚠️ 减仓量超限，从 ${reduceQty.toFixed(4)} 调整为 ${maxReduceQty.toFixed(4)}`);
      reduceQty = maxReduceQty;
    }

    // 计算减仓比例
    const reduceRatio = reduceQty / positionSize;

    // 计算预期降仓后的杠杆
    const newPositionValue = positionValue - (reduceQty * position.entryPrice);
    const newLeverage = newPositionValue / marginUsed;

    return {
      qty: Number(reduceQty.toFixed(8)),
      ratio: Number(reduceRatio.toFixed(4)),
      expectedLeverage: Number(newLeverage.toFixed(2)),
    };
  }

  /**
   * 生成会话ID
   */
  private generateSessionId(): string {
    return `pr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 获取状态图标
   */
  private getStateIcon(state: ReducePositionState): string {
    switch (state) {
      case ReducePositionState.IDLE: return '🟢';
      case ReducePositionState.WARNING: return '🟡';
      case ReducePositionState.REDUCE: return '🔴';
      case ReducePositionState.RECOVERY: return '🔵';
      default: return '⚪';
    }
  }
}

// ==================== 工厂函数 ====================

export function createPositionReducer(config: Partial<PositionReducerConfig> & { symbol: string }): PositionReducer {
  return new PositionReducer(config as PositionReducerConfig);
}

// ==================== 默认导出 ====================

export default PositionReducer;
