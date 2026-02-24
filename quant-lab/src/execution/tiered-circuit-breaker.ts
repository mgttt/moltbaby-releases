/**

import { env } from '../config/env';

 * 统一分级熔断框架
 * 
 * 支持A/B/C/D四级熔断，对应不同严重程度：
 * - A类（严重）: API关键失败、系统错误 - 立即熔断，需人工介入
 * - B类（高）: 状态不可置信、持仓异常 - 快速熔断，自动恢复谨慎
 * - C类（中）: 风控阈值触及、参数异常 - 限制交易，可自动恢复
 * - D类（低）: 告警通知、性能下降 - 仅记录，不阻断
 * 
 * 兼容现有circuitBreakerState格式
 */

import { createLogger } from '../utils/logger';
const logger = createLogger('TieredCircuitBreaker');

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

// ============ 类型定义 ============

/** 熔断等级 */
export type CircuitLevel = 'A' | 'B' | 'C' | 'D';

/** 熔断状态 */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** 熔断原因 */
export interface CircuitTripReason {
  level: CircuitLevel;
  code: string;
  message: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

/** 分级熔断配置 */
export interface TieredCircuitConfig {
  // A类熔断（最严重）
  classA: {
    enabled: boolean;
    autoReset: boolean;           // A类默认不自动恢复
    resetTimeoutMs: number;       // 如允许自动恢复，冷却时间
    maxConsecutiveFailures: number;
  };
  // B类熔断（高）
  classB: {
    enabled: boolean;
    autoReset: boolean;
    resetTimeoutMs: number;
    maxConsecutiveFailures: number;
  };
  // C类熔断（中）
  classC: {
    enabled: boolean;
    autoReset: boolean;
    resetTimeoutMs: number;
    maxConsecutiveFailures: number;
    maxDrawdownPercent: number;   // 最大回撤百分比
  };
  // D类（仅告警）
  classD: {
    enabled: boolean;
    logOnly: boolean;             // D类只记录，不熔断
  };
  // 通用配置
  statePersistence: {
    enabled: boolean;
    filePath: string;
    saveIntervalMs: number;
  };
  notification: {
    onTrip: boolean;
    onReset: boolean;
    onHalfOpen: boolean;
    minLevel: CircuitLevel;       // 最低通知等级
  };
}

/** 持久化状态格式（兼容现有circuitBreakerState） */
export interface CircuitStatePersistence {
  version: string;
  strategyId: string;
  lastUpdated: number;
  globalState: CircuitState;
  classA: {
    state: CircuitState;
    triggeredAt: number | null;
    reason: CircuitTripReason | null;
    failCount: number;
  };
  classB: {
    state: CircuitState;
    triggeredAt: number | null;
    reason: CircuitTripReason | null;
    failCount: number;
  };
  classC: {
    state: CircuitState;
    triggeredAt: number | null;
    reason: CircuitTripReason | null;
    failCount: number;
    peakNetEq: number;            // 峰值权益（用于回撤计算）
    highWaterMark: number;
  };
  classD: {
    alertCount: number;
    lastAlertAt: number | null;
  };
  // 兼容旧格式
  active?: boolean;
  tripped?: boolean;
  blockedSide?: string;
  peakNetEq?: number;
}

/** 熔断事件 */
export interface CircuitBreakerEvents {
  onTrip: (level: CircuitLevel, reason: CircuitTripReason, state: CircuitStatePersistence) => void;
  onReset: (level: CircuitLevel, state: CircuitStatePersistence) => void;
  onHalfOpen: (level: CircuitLevel, state: CircuitStatePersistence) => void;
  onStateChange: (level: CircuitLevel, oldState: CircuitState, newState: CircuitState) => void;
  onAlert: (level: CircuitLevel, message: string) => void;
}

// ============ 默认配置 ============

const DEFAULT_CONFIG: TieredCircuitConfig = {
  classA: {
    enabled: true,
    autoReset: false,           // A类需人工介入
    resetTimeoutMs: 3600000,    // 1小时（如开启自动恢复）
    maxConsecutiveFailures: 3,
  },
  classB: {
    enabled: true,
    autoReset: true,
    resetTimeoutMs: 600000,     // 10分钟
    maxConsecutiveFailures: 5,
  },
  classC: {
    enabled: true,
    autoReset: true,
    resetTimeoutMs: 300000,     // 5分钟
    maxConsecutiveFailures: 10,
    maxDrawdownPercent: 0.40,   // 40%回撤
  },
  classD: {
    enabled: true,
    logOnly: true,
  },
  statePersistence: {
    enabled: true,
    filePath: '',               // 运行时设置
    saveIntervalMs: 5000,       // 5秒保存一次
  },
  notification: {
    onTrip: true,
    onReset: true,
    onHalfOpen: true,
    minLevel: 'C',
  },
};

// ============ 分级熔断管理器 ============

export class TieredCircuitBreaker {
  private config: TieredCircuitConfig;
  private state: CircuitStatePersistence;
  private events: Partial<CircuitBreakerEvents> = {};
  private strategyId: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private resetTimers: Map<CircuitLevel, NodeJS.Timeout> = new Map();

  constructor(strategyId: string, config?: Partial<TieredCircuitConfig>) {
    this.strategyId = strategyId;
    this.config = this.mergeConfig(config);
    
    // 设置默认状态文件路径
    if (!this.config.statePersistence.filePath) {
      const homeDir = env.HOME;
      this.config.statePersistence.filePath = join(
        homeDir, 
        '.quant-lab', 
        `circuit-breaker-${strategyId}.json`
      );
    }

    // 初始化状态
    this.state = this.createInitialState();

    logger.info(`[TieredCircuitBreaker] 初始化分级熔断器: ${strategyId}`);
    logger.info(`[TieredCircuitBreaker] A类自动恢复: ${this.config.classA.autoReset}`);
    logger.info(`[TieredCircuitBreaker] B类自动恢复: ${this.config.classB.autoReset}`);
    logger.info(`[TieredCircuitBreaker] C类最大回撤: ${this.config.classC.maxDrawdownPercent * 100}%`);

    // 尝试恢复持久化状态
    this.loadState();

    // 启动自动保存
    if (this.config.statePersistence.enabled) {
      this.startAutoSave();
    }
  }

  // ============ 配置管理 ============

  private mergeConfig(config?: Partial<TieredCircuitConfig>): TieredCircuitConfig {
    return {
      ...DEFAULT_CONFIG,
      ...config,
      classA: { ...DEFAULT_CONFIG.classA, ...config?.classA },
      classB: { ...DEFAULT_CONFIG.classB, ...config?.classB },
      classC: { ...DEFAULT_CONFIG.classC, ...config?.classC },
      classD: { ...DEFAULT_CONFIG.classD, ...config?.classD },
      statePersistence: { ...DEFAULT_CONFIG.statePersistence, ...config?.statePersistence },
      notification: { ...DEFAULT_CONFIG.notification, ...config?.notification },
    };
  }

  // ============ 状态管理 ============

  private createInitialState(): CircuitStatePersistence {
    return {
      version: '2.0',
      strategyId: this.strategyId,
      lastUpdated: Date.now(),
      globalState: 'CLOSED',
      classA: {
        state: 'CLOSED',
        triggeredAt: null,
        reason: null,
        failCount: 0,
      },
      classB: {
        state: 'CLOSED',
        triggeredAt: null,
        reason: null,
        failCount: 0,
      },
      classC: {
        state: 'CLOSED',
        triggeredAt: null,
        reason: null,
        failCount: 0,
        peakNetEq: 0,
        highWaterMark: 0,
      },
      classD: {
        alertCount: 0,
        lastAlertAt: null,
      },
    };
  }

  /**
   * 加载持久化状态
   */
  loadState(): boolean {
    try {
      const filePath = this.config.statePersistence.filePath;
      if (!existsSync(filePath)) {
        logger.info(`[TieredCircuitBreaker] 状态文件不存在: ${filePath}`);
        return false;
      }

      const content = readFileSync(filePath, 'utf-8');
      const loadedState = JSON.parse(content);

      // 兼容旧格式转换
      if (loadedState.version === undefined) {
        this.migrateFromOldFormat(loadedState);
      } else {
        // 深度合并状态
        this.state = {
          ...this.state,
          ...loadedState,
          classA: { ...this.state.classA, ...loadedState.classA },
          classB: { ...this.state.classB, ...loadedState.classB },
          classC: { ...this.state.classC, ...loadedState.classC },
          classD: { ...this.state.classD, ...loadedState.classD },
        };
      }

      logger.info(`[TieredCircuitBreaker] 已恢复熔断状态: global=${this.state.globalState}`);
      logger.info(`[TieredCircuitBreaker]   A=${this.state.classA.state}, B=${this.state.classB.state}, C=${this.state.classC.state}`);

      return true;
    } catch (error: any) {
      logger.error(`[TieredCircuitBreaker] 加载状态失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 保存状态到文件
   */
  saveState(): boolean {
    try {
      const filePath = this.config.statePersistence.filePath;
      const dir = dirname(filePath);
      
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      this.state.lastUpdated = Date.now();
      writeFileSync(filePath, JSON.stringify(this.state, null, 2));
      return true;
    } catch (error: any) {
      logger.error(`[TieredCircuitBreaker] 保存状态失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 从旧格式迁移
   */
  private migrateFromOldFormat(oldState: any): void {
    logger.info('[TieredCircuitBreaker] 从旧格式迁移熔断状态');
    
    // 兼容策略中的circuitBreakerState格式
    this.state.classC.peakNetEq = oldState.peakNetEq || 0;
    this.state.classC.highWaterMark = oldState.highWaterMark || 0;
    
    if (oldState.tripped || oldState.active === false) {
      this.state.globalState = 'OPEN';
      this.state.classC.state = 'OPEN';
      this.state.classC.triggeredAt = oldState.trippedAt || Date.now();
    }
    
    this.state.blockedSide = oldState.blockedSide || '';
    this.state.active = oldState.active !== false;
  }

  /**
   * 启动自动保存
   */
  private startAutoSave(): void {
    this.saveTimer = setInterval(() => {
      this.saveState();
    }, this.config.statePersistence.saveIntervalMs);
  }

  /**
   * 停止自动保存
   */
  stopAutoSave(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
  }

  // ============ 熔断操作 ============

  /**
   * 触发熔断
   */
  trip(level: CircuitLevel, code: string, message: string, metadata?: Record<string, any>): void {
    if (level === 'D') {
      // D类只记录，不熔断
      this.recordAlert(code, message, metadata);
      return;
    }

    const config = this.getLevelConfig(level);
    if (!config.enabled) {
      logger.info(`[TieredCircuitBreaker] ${level}类熔断已禁用，跳过`);
      return;
    }

    const reason: CircuitTripReason = {
      level,
      code,
      message,
      timestamp: Date.now(),
      metadata,
    };

    const levelState = this.getLevelState(level);
    const oldState = levelState.state;
    
    levelState.state = 'OPEN';
    levelState.triggeredAt = Date.now();
    levelState.reason = reason;
    
    this.updateGlobalState();

    logger.error(`[TieredCircuitBreaker] ${level}类熔断触发: ${code} - ${message}`);

    // 事件通知
    this.events.onTrip?.(level, reason, this.state);
    this.events.onStateChange?.(level, oldState, 'OPEN');
    
    if (this.shouldNotify(level, 'trip')) {
      this.notify(level, `熔断触发: ${message}`);
    }

    // 启动自动恢复定时器
    if (config.autoReset && config.resetTimeoutMs > 0) {
      this.scheduleReset(level, config.resetTimeoutMs);
    }

    // 立即保存状态
    this.saveState();
  }

  /**
   * 尝试恢复（半开状态）
   */
  attemptReset(level: CircuitLevel): boolean {
    const levelState = this.getLevelState(level);
    
    if (levelState.state !== 'OPEN') {
      return false;
    }

    const config = this.getLevelConfig(level);
    if (!config.autoReset) {
      logger.info(`[TieredCircuitBreaker] ${level}类熔断不允许自动恢复`);
      return false;
    }

    // 检查冷却时间
    if (levelState.triggeredAt) {
      const elapsed = Date.now() - levelState.triggeredAt;
      if (elapsed < config.resetTimeoutMs) {
        const remaining = Math.ceil((config.resetTimeoutMs - elapsed) / 1000);
        logger.info(`[TieredCircuitBreaker] ${level}类熔断冷却中，剩余${remaining}秒`);
        return false;
      }
    }

    const oldState = levelState.state;
    levelState.state = 'HALF_OPEN';
    this.updateGlobalState();

    logger.info(`[TieredCircuitBreaker] ${level}类熔断进入半开状态`);

    this.events.onHalfOpen?.(level, this.state);
    this.events.onStateChange?.(level, oldState, 'HALF_OPEN');
    
    if (this.shouldNotify(level, 'halfOpen')) {
      this.notify(level, '熔断进入半开状态，谨慎恢复');
    }

    this.saveState();
    return true;
  }

  /**
   * 确认恢复（从半开到关闭）
   */
  confirmReset(level: CircuitLevel): void {
    const levelState = this.getLevelState(level);
    
    if (levelState.state !== 'HALF_OPEN') {
      return;
    }

    const oldState = levelState.state;
    levelState.state = 'CLOSED';
    levelState.triggeredAt = null;
    levelState.reason = null;
    levelState.failCount = 0;
    
    this.updateGlobalState();

    logger.info(`[TieredCircuitBreaker] ${level}类熔断已恢复`);

    this.events.onReset?.(level, this.state);
    this.events.onStateChange?.(level, oldState, 'CLOSED');
    
    if (this.shouldNotify(level, 'reset')) {
      this.notify(level, '熔断已恢复，正常交易');
    }

    // 清除恢复定时器
    const timer = this.resetTimers.get(level);
    if (timer) {
      clearTimeout(timer);
      this.resetTimers.delete(level);
    }

    this.saveState();
  }

  /**
   * 记录失败（用于连续失败计数）
   */
  recordFailure(level: CircuitLevel, error?: string): void {
    if (level === 'D') return;

    const levelState = this.getLevelState(level);
    levelState.failCount++;

    logger.info(`[TieredCircuitBreaker] ${level}类失败计数: ${levelState.failCount}`);

    // 检查是否达到熔断阈值
    const config = this.getLevelConfig(level);
    if (levelState.failCount >= config.maxConsecutiveFailures) {
      this.trip(level, 'MAX_FAILURES', `连续失败${levelState.failCount}次`, { error });
    }
  }

  /**
   * 记录成功（重置失败计数）
   */
  recordSuccess(level: CircuitLevel): void {
    if (level === 'D') return;

    const levelState = this.getLevelState(level);
    
    if (levelState.failCount > 0) {
      levelState.failCount = 0;
      logger.info(`[TieredCircuitBreaker] ${level}类失败计数重置`);
    }

    // 如果在半开状态，确认恢复
    if (levelState.state === 'HALF_OPEN') {
      this.confirmReset(level);
    }
  }

  /**
   * 记录D类告警
   */
  recordAlert(code: string, message: string, metadata?: Record<string, any>): void {
    this.state.classD.alertCount++;
    this.state.classD.lastAlertAt = Date.now();

    logger.info(`[TieredCircuitBreaker] [D类告警] ${code}: ${message}`);
    
    this.events.onAlert?.('D', `[${code}] ${message}`);
  }

  /**
   * 检查回撤并触发C类熔断
   */
  checkDrawdown(currentNetEq: number): boolean {
    const config = this.config.classC;
    const levelState = this.state.classC;

    // 更新峰值
    if (currentNetEq > levelState.peakNetEq) {
      levelState.peakNetEq = currentNetEq;
      levelState.highWaterMark = currentNetEq;
    }

    // 计算回撤
    if (levelState.peakNetEq > 0) {
      const drawdown = (levelState.peakNetEq - currentNetEq) / levelState.peakNetEq;
      
      if (drawdown >= config.maxDrawdownPercent) {
        this.trip('C', 'MAX_DRAWDOWN', 
          `回撤达到${(drawdown * 100).toFixed(2)}%，超过阈值${(config.maxDrawdownPercent * 100).toFixed(0)}%`,
          { currentNetEq, peakNetEq: levelState.peakNetEq, drawdown }
        );
        return true;
      }
    }

    return false;
  }

  // ============ 查询方法 ============

  /**
   * 检查是否允许交易
   */
  canTrade(): boolean {
    return this.state.globalState !== 'OPEN';
  }

  /**
   * 检查特定等级是否熔断
   */
  isTripped(level: CircuitLevel): boolean {
    return this.getLevelState(level).state === 'OPEN';
  }

  /**
   * 获取全局状态
   */
  getGlobalState(): CircuitState {
    return this.state.globalState;
  }

  /**
   * 获取完整状态
   */
  getState(): CircuitStatePersistence {
    return { ...this.state };
  }

  /**
   * 获取等级配置
   */
  getLevelConfig(level: CircuitLevel): any {
    switch (level) {
      case 'A': return this.config.classA;
      case 'B': return this.config.classB;
      case 'C': return this.config.classC;
      case 'D': return this.config.classD;
    }
  }

  /**
   * 获取等级状态
   */
  private getLevelState(level: CircuitLevel) {
    switch (level) {
      case 'A': return this.state.classA;
      case 'B': return this.state.classB;
      case 'C': return this.state.classC;
      case 'D': return this.state.classD;
    }
  }

  // ============ 私有方法 ============

  /**
   * 更新全局状态
   */
  private updateGlobalState(): void {
    // 只要有任何等级的熔断是OPEN，全局就是OPEN
    if (this.state.classA.state === 'OPEN' || 
        this.state.classB.state === 'OPEN' || 
        this.state.classC.state === 'OPEN') {
      this.state.globalState = 'OPEN';
    } else if (this.state.classA.state === 'HALF_OPEN' || 
               this.state.classB.state === 'HALF_OPEN' || 
               this.state.classC.state === 'HALF_OPEN') {
      this.state.globalState = 'HALF_OPEN';
    } else {
      this.state.globalState = 'CLOSED';
    }
  }

  /**
   * 调度自动恢复
   */
  private scheduleReset(level: CircuitLevel, timeoutMs: number): void {
    // 清除旧定时器
    const oldTimer = this.resetTimers.get(level);
    if (oldTimer) {
      clearTimeout(oldTimer);
    }

    const timer = setTimeout(() => {
      logger.info(`[TieredCircuitBreaker] ${level}类熔断自动恢复定时器触发`);
      this.attemptReset(level);
    }, timeoutMs);

    this.resetTimers.set(level, timer);
    logger.info(`[TieredCircuitBreaker] ${level}类熔断${timeoutMs}ms后尝试恢复`);
  }

  /**
   * 检查是否应该通知
   */
  private shouldNotify(level: CircuitLevel, event: 'trip' | 'reset' | 'halfOpen'): boolean {
    const minLevel = this.config.notification.minLevel;
    const levelPriority = { 'A': 0, 'B': 1, 'C': 2, 'D': 3 };
    
    if (levelPriority[level] > levelPriority[minLevel]) {
      return false;
    }

    switch (event) {
      case 'trip': return this.config.notification.onTrip;
      case 'reset': return this.config.notification.onReset;
      case 'halfOpen': return this.config.notification.onHalfOpen;
    }
  }

  /**
   * 发送通知
   */
  private notify(level: CircuitLevel, message: string): void {
    const prefix = `[熔断][${level}类]`;
    logger.info(`${prefix} ${message}`);
    // 这里可以集成TG通知等
  }

  /**
   * 设置事件监听
   */
  setEvents(events: Partial<CircuitBreakerEvents>): void {
    this.events = { ...this.events, ...events };
  }

  /**
   * 销毁（清理定时器）
   */
  destroy(): void {
    this.stopAutoSave();
    
    for (const [level, timer] of this.resetTimers) {
      clearTimeout(timer);
    }
    this.resetTimers.clear();
    
    logger.info(`[TieredCircuitBreaker] 已销毁: ${this.strategyId}`);
  }
}

// ============ 导出 ============

export default TieredCircuitBreaker;
