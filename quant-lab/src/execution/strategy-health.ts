/**
 * strategy-health.ts - 策略健康状态机
 * 
 * 背景：当前策略只有running/stopped，运营无法实时感知异常。
 * 
 * 实现：
 * 1. 状态定义：INIT→PREFLIGHT→RUNNING→DEGRADED→STOPPED
 * 2. 状态转换触发条件（错误率/延迟/连接断开）
 * 3. DEGRADED自动恢复逻辑
 * 4. 状态变更事件+告警
 * 5. 与健康检查端点集成
 */

import { createLogger } from '../utils/logger';
const logger = createLogger('strategy-health');

import { EventEmitter } from 'events';

// ==================== 类型定义 ====================

export enum StrategyHealthState {
  INIT = 'INIT',               // 初始化
  PREFLIGHT = 'PREFLIGHT',     // 前置检查
  RUNNING = 'RUNNING',         // 正常运行
  DEGRADED = 'DEGRADED',       // 降级运行
  STOPPED = 'STOPPED',         // 已停止
  ERROR = 'ERROR',             // 错误状态
}

export interface HealthMetrics {
  errorRate: number;           // 错误率 (0-1)
  avgLatency: number;          // 平均延迟 (ms)
  lastHeartbeat: number;       // 最后心跳时间戳
  connectionStatus: 'connected' | 'disconnected' | 'reconnecting';
  consecutiveErrors: number;   // 连续错误次数
  consecutiveSlowResponses: number; // 连续慢响应次数
}

export interface HealthThresholds {
  maxErrorRate: number;        // 最大错误率 (如 0.1 = 10%)
  maxLatency: number;          // 最大延迟 (ms)
  heartbeatTimeout: number;    // 心跳超时 (ms)
  maxConsecutiveErrors: number; // 最大连续错误次数
  maxConsecutiveSlowResponses: number; // 最大连续慢响应次数
  degradedRecoveryThreshold: {  // 降级恢复阈值
    maxErrorRate: number;
    maxLatency: number;
    minHealthyDuration: number; // 最小健康持续时间 (ms)
  };
}

export interface StrategyHealthConfig {
  strategyId: string;
  sessionId: string;
  thresholds: HealthThresholds;
  autoRecovery: boolean;       // 是否启用自动恢复
  maxRecoveryAttempts: number; // 最大恢复尝试次数
  alertConfig?: {
    enabled: boolean;
    onStateChange?: (oldState: StrategyHealthState, newState: StrategyHealthState, reason: string) => Promise<void>;
    onDegraded?: (metrics: HealthMetrics) => Promise<void>;
    onError?: (error: Error) => Promise<void>;
  };
}

export interface StateTransition {
  from: StrategyHealthState;
  to: StrategyHealthState;
  reason: string;
  timestamp: number;
  metrics?: HealthMetrics;
}

export interface HealthCheckResult {
  healthy: boolean;
  state: StrategyHealthState;
  metrics: HealthMetrics;
  issues: string[];
  recommendations: string[];
}

// ==================== 策略健康状态机 ====================

export class StrategyHealthStateMachine extends EventEmitter {
  private config: StrategyHealthConfig;
  private state: StrategyHealthState = StrategyHealthState.INIT;
  private metrics: HealthMetrics;
  private transitions: StateTransition[] = [];
  private recoveryAttempts = 0;
  private lastHealthyTime = 0;
  private checkInterval: Timer | null = null;

  constructor(config: StrategyHealthConfig) {
    super();
    this.config = config;
    this.metrics = {
      errorRate: 0,
      avgLatency: 0,
      lastHeartbeat: Date.now(),
      connectionStatus: 'disconnected',
      consecutiveErrors: 0,
      consecutiveSlowResponses: 0,
    };

    logger.info(`[StrategyHealth] 初始化 [${config.strategyId}]`);
    logger.info(`  自动恢复: ${config.autoRecovery}`);
    logger.info(`  错误率阈值: ${(config.thresholds.maxErrorRate * 100).toFixed(1)}%`);
    logger.info(`  延迟阈值: ${config.thresholds.maxLatency}ms`);
  }

  /**
   * 启动健康检查
   */
  start(): void {
    if (this.checkInterval) {
      return;
    }

    logger.info(`[StrategyHealth] 🟢 启动健康检查`);
    
    // 进入PREFLIGHT状态
    this.transitionTo(StrategyHealthState.PREFLIGHT, '启动前置检查');

    // 启动定期检查
    this.checkInterval = setInterval(() => {
      this.performHealthCheck();
    }, 5000); // 每5秒检查一次

    this.emit('health:started');
  }

  /**
   * 停止健康检查
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    this.transitionTo(StrategyHealthState.STOPPED, '健康检查停止');
    logger.info(`[StrategyHealth] 🛑 停止健康检查`);
    
    this.emit('health:stopped');
  }

  /**
   * 更新健康指标
   */
  updateMetrics(metrics: Partial<HealthMetrics>): void {
    this.metrics = { ...this.metrics, ...metrics, lastHeartbeat: Date.now() };
    
    // 检查是否需要触发状态转换
    this.evaluateStateTransition();
  }

  /**
   * 记录心跳
   */
  recordHeartbeat(): void {
    this.metrics.lastHeartbeat = Date.now();
    this.metrics.consecutiveErrors = 0;
    
    // 如果当前是DEGRADED，检查是否可以恢复
    if (this.state === StrategyHealthState.DEGRADED) {
      this.evaluateRecovery();
    }
  }

  /**
   * 记录错误
   */
  recordError(error?: Error): void {
    this.metrics.consecutiveErrors++;
    this.metrics.lastHeartbeat = Date.now();
    
    logger.warn(`[StrategyHealth] ⚠️ 记录错误 #${this.metrics.consecutiveErrors}: ${error?.message || 'Unknown'}`);

    // 检查是否需要降级
    if (this.metrics.consecutiveErrors >= this.config.thresholds.maxConsecutiveErrors) {
      if (this.state === StrategyHealthState.RUNNING) {
        this.transitionTo(StrategyHealthState.DEGRADED, `连续错误${this.metrics.consecutiveErrors}次`);
      }
    }

    // 检查是否需要进入ERROR状态
    if (this.metrics.consecutiveErrors >= this.config.thresholds.maxConsecutiveErrors * 2) {
      if (this.state !== StrategyHealthState.ERROR) {
        this.transitionTo(StrategyHealthState.ERROR, `严重错误: 连续错误${this.metrics.consecutiveErrors}次`);
      }
    }

    if (error && this.config.alertConfig?.onError) {
      this.config.alertConfig.onError(error).catch((err) => logger.error(err));
    }
  }

  /**
   * 记录响应延迟
   */
  recordLatency(latency: number): void {
    // 更新平均延迟（指数移动平均）
    this.metrics.avgLatency = this.metrics.avgLatency * 0.8 + latency * 0.2;

    if (latency > this.config.thresholds.maxLatency) {
      this.metrics.consecutiveSlowResponses++;
      logger.warn(`[StrategyHealth] ⚠️ 慢响应 #${this.metrics.consecutiveSlowResponses}: ${latency}ms`);

      if (this.metrics.consecutiveSlowResponses >= this.config.thresholds.maxConsecutiveSlowResponses) {
        if (this.state === StrategyHealthState.RUNNING) {
          this.transitionTo(StrategyHealthState.DEGRADED, `连续慢响应${this.metrics.consecutiveSlowResponses}次`);
        }
      }
    } else {
      this.metrics.consecutiveSlowResponses = 0;
    }

    this.metrics.lastHeartbeat = Date.now();
  }

  /**
   * 获取当前状态
   */
  getState(): StrategyHealthState {
    return this.state;
  }

  /**
   * 获取健康指标
   */
  getMetrics(): HealthMetrics {
    return { ...this.metrics };
  }

  /**
   * 获取状态转换历史
   */
  getTransitions(): StateTransition[] {
    return [...this.transitions];
  }

  /**
   * 执行健康检查（供外部调用或定时触发）
   */
  performHealthCheck(): HealthCheckResult {
    const issues: string[] = [];
    const recommendations: string[] = [];
    let healthy = true;

    // 检查心跳超时
    const timeSinceLastHeartbeat = Date.now() - this.metrics.lastHeartbeat;
    if (timeSinceLastHeartbeat > this.config.thresholds.heartbeatTimeout) {
      issues.push(`心跳超时: ${timeSinceLastHeartbeat}ms未收到心跳`);
      recommendations.push('检查策略是否正常运行，网络连接是否稳定');
      healthy = false;

      if (this.metrics.connectionStatus === 'connected') {
        this.metrics.connectionStatus = 'disconnected';
        if (this.state === StrategyHealthState.RUNNING) {
          this.transitionTo(StrategyHealthState.DEGRADED, '心跳超时');
        }
      }
    }

    // 检查错误率
    if (this.metrics.errorRate > this.config.thresholds.maxErrorRate) {
      issues.push(`错误率过高: ${(this.metrics.errorRate * 100).toFixed(1)}%`);
      recommendations.push('检查策略逻辑，查看日志定位错误原因');
      healthy = false;
    }

    // 检查延迟
    if (this.metrics.avgLatency > this.config.thresholds.maxLatency) {
      issues.push(`平均延迟过高: ${this.metrics.avgLatency.toFixed(0)}ms`);
      recommendations.push('优化策略计算逻辑，或减少数据处理量');
      healthy = false;
    }

    // 检查连接状态
    if (this.metrics.connectionStatus === 'disconnected') {
      issues.push('连接已断开');
      recommendations.push('检查网络连接，交易所API状态');
      healthy = false;
    }

    const result: HealthCheckResult = {
      healthy,
      state: this.state,
      metrics: { ...this.metrics },
      issues,
      recommendations,
    };

    this.emit('health:checked', result);
    return result;
  }

  /**
   * 生成健康报告
   */
  generateReport(): string {
    const checkResult = this.performHealthCheck();
    
    const lines = [
      '========================================',
      '        策略健康状态报告',
      '========================================',
      `策略ID: ${this.config.strategyId}`,
      `会话ID: ${this.config.sessionId}`,
      `当前状态: ${this.state}`,
      `检查时间: ${new Date().toISOString()}`,
      '',
      '--- 健康指标 ---',
      `错误率: ${(this.metrics.errorRate * 100).toFixed(2)}%`,
      `平均延迟: ${this.metrics.avgLatency.toFixed(2)}ms`,
      `连接状态: ${this.metrics.connectionStatus}`,
      `连续错误: ${this.metrics.consecutiveErrors}`,
      `连续慢响应: ${this.metrics.consecutiveSlowResponses}`,
      '',
      '--- 健康检查结果 ---',
      `整体健康: ${checkResult.healthy ? '✅' : '❌'}`,
    ];

    if (checkResult.issues.length > 0) {
      lines.push('问题:');
      checkResult.issues.forEach(issue => lines.push(`  • ${issue}`));
    }

    if (checkResult.recommendations.length > 0) {
      lines.push('建议:');
      checkResult.recommendations.forEach(rec => lines.push(`  • ${rec}`));
    }

    lines.push('');
    lines.push('--- 状态转换历史 ---');
    this.transitions.slice(-5).forEach(t => {
      lines.push(`  ${t.from} → ${t.to} | ${t.reason} | ${new Date(t.timestamp).toLocaleTimeString()}`);
    });

    lines.push('========================================');

    return lines.join('\n');
  }

  // ==================== 私有方法 ====================

  /**
   * 状态转换
   */
  private transitionTo(newState: StrategyHealthState, reason: string): void {
    if (this.state === newState) {
      return;
    }

    const oldState = this.state;
    this.state = newState;

    const transition: StateTransition = {
      from: oldState,
      to: newState,
      reason,
      timestamp: Date.now(),
      metrics: { ...this.metrics },
    };

    this.transitions.push(transition);

    const icon = this.getStateIcon(newState);
    logger.info(`[StrategyHealth] ${icon} 状态转换: ${oldState} → ${newState} | ${reason}`);

    // 发送告警
    if (this.config.alertConfig?.enabled) {
      if (this.config.alertConfig.onStateChange) {
        this.config.alertConfig.onStateChange(oldState, newState, reason).catch((err) => logger.error(err));
      }
      
      if (newState === StrategyHealthState.DEGRADED && this.config.alertConfig.onDegraded) {
        this.config.alertConfig.onDegraded(this.metrics).catch((err) => logger.error(err));
      }
    }

    this.emit('state:changed', transition);
    this.emit(`state:${newState.toLowerCase()}`, transition);
  }

  /**
   * 评估状态转换
   */
  private evaluateStateTransition(): void {
    // PREFLIGHT → RUNNING
    if (this.state === StrategyHealthState.PREFLIGHT) {
      if (this.metrics.connectionStatus === 'connected') {
        this.transitionTo(StrategyHealthState.RUNNING, '前置检查通过，连接成功');
        this.lastHealthyTime = Date.now();
      }
      return;
    }

    // 检查是否需要降级
    if (this.state === StrategyHealthState.RUNNING) {
      const issues = this.checkHealthIssues();
      if (issues.length > 0) {
        this.transitionTo(StrategyHealthState.DEGRADED, issues.join('; '));
      }
    }
  }

  /**
   * 评估恢复
   */
  private evaluateRecovery(): void {
    if (!this.config.autoRecovery) {
      return;
    }

    if (this.recoveryAttempts >= this.config.maxRecoveryAttempts) {
      logger.error(`[StrategyHealth] ❌ 恢复尝试次数超限: ${this.recoveryAttempts}`);
      this.transitionTo(StrategyHealthState.ERROR, '自动恢复失败次数超限');
      return;
    }

    // 检查是否满足恢复条件
    const recoveryThreshold = this.config.thresholds.degradedRecoveryThreshold;
    
    if (this.metrics.errorRate <= recoveryThreshold.maxErrorRate &&
        this.metrics.avgLatency <= recoveryThreshold.maxLatency) {
      
      const healthyDuration = Date.now() - this.lastHealthyTime;
      
      if (healthyDuration >= recoveryThreshold.minHealthyDuration) {
        this.recoveryAttempts++;
        this.transitionTo(StrategyHealthState.RUNNING, `自动恢复成功 (尝试${this.recoveryAttempts})`);
        logger.info(`[StrategyHealth] ✅ 从DEGRADED恢复至RUNNING`);
      }
    }
  }

  /**
   * 检查健康问题
   */
  private checkHealthIssues(): string[] {
    const issues: string[] = [];

    if (this.metrics.errorRate > this.config.thresholds.maxErrorRate) {
      issues.push(`错误率${(this.metrics.errorRate * 100).toFixed(1)}%`);
    }

    if (this.metrics.avgLatency > this.config.thresholds.maxLatency) {
      issues.push(`延迟${this.metrics.avgLatency.toFixed(0)}ms`);
    }

    if (this.metrics.connectionStatus === 'disconnected') {
      issues.push('连接断开');
    }

    return issues;
  }

  /**
   * 获取状态图标
   */
  private getStateIcon(state: StrategyHealthState): string {
    switch (state) {
      case StrategyHealthState.INIT: return '⚪';
      case StrategyHealthState.PREFLIGHT: return '🟡';
      case StrategyHealthState.RUNNING: return '🟢';
      case StrategyHealthState.DEGRADED: return '🟠';
      case StrategyHealthState.STOPPED: return '⚫';
      case StrategyHealthState.ERROR: return '🔴';
      default: return '⚪';
    }
  }
}

// ==================== 工厂函数 ====================

export function createStrategyHealthStateMachine(
  config: StrategyHealthConfig
): StrategyHealthStateMachine {
  return new StrategyHealthStateMachine(config);
}

// ==================== 默认导出 ====================

export default StrategyHealthStateMachine;
