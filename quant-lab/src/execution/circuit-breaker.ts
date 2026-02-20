/**
 * 限流熔断框架
 * 
 * 功能：
 * 1. 请求限流
 * 2. 熔断保护
 * 3. 自动恢复
 * 
 * 位置：quant-lab/src/execution/circuit-breaker.ts
 * 协作模式：b号搭框架，a号填业务逻辑
 */

// ============ 类型定义 ============

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerConfig {
  failureThreshold: number; // 失败阈值
  successThreshold: number; // 成功阈值（半开状态）
  timeout: number; // 超时时间（毫秒）
  resetTimeout: number; // 重置超时（毫秒）
  enableAutoReset: boolean; // 是否自动重置
}

export interface CircuitBreakerStats {
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
}

export interface CircuitBreakerEvents {
  onStateChange: (oldState: CircuitState, newState: CircuitState) => void;
  onOpen: () => void;
  onHalfOpen: () => void;
  onClose: () => void;
  onFailure: (error: Error) => void;
  onSuccess: () => void;
  onTimeout: () => void;
}

// ============ 限流熔断器 ============

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private config: CircuitBreakerConfig;
  private stats: CircuitBreakerStats;
  private events: Partial<CircuitBreakerEvents> = {};
  private resetTimer: NodeJS.Timeout | null = null;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = {
      failureThreshold: 5,
      successThreshold: 3,
      timeout: 5000, // 5秒
      resetTimeout: 60000, // 60秒
      enableAutoReset: true,
      ...config,
    };

    this.stats = {
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      lastFailureTime: null,
      lastSuccessTime: null,
    };

    console.log("[CircuitBreaker] 初始化限流熔断器");
    console.log(`[CircuitBreaker] 失败阈值: ${this.config.failureThreshold}`);
    console.log(`[CircuitBreaker] 成功阈值: ${this.config.successThreshold}`);
    console.log(`[CircuitBreaker] 超时时间: ${this.config.timeout}ms`);
    console.log(`[CircuitBreaker] 重置超时: ${this.config.resetTimeout}ms`);
  }

  /**
   * 设置事件回调
   */
  setEvents(events: Partial<CircuitBreakerEvents>): void {
    this.events = { ...this.events, ...events };
  }

  /**
   * 检查是否允许请求
   */
  canRequest(): boolean {
    if (this.state === "CLOSED") {
      return true;
    }

    if (this.state === "OPEN") {
      // 检查是否可以进入半开状态
      const now = Date.now();
      if (
        this.stats.lastFailureTime &&
        now - this.stats.lastFailureTime >= this.config.resetTimeout
      ) {
        this.transitionTo("HALF_OPEN");
        return true;
      }

      return false;
    }

    if (this.state === "HALF_OPEN") {
      return true;
    }

    return false;
  }

  /**
   * 记录成功
   */
  recordSuccess(): void {
    this.stats.totalRequests++;
    this.stats.successRequests++;
    this.stats.consecutiveSuccesses++;
    this.stats.consecutiveFailures = 0;
    this.stats.lastSuccessTime = Date.now();

    console.log("[CircuitBreaker] 记录成功");
    this.events.onSuccess?.();

    // 半开状态下，连续成功达到阈值，关闭熔断器
    if (
      this.state === "HALF_OPEN" &&
      this.stats.consecutiveSuccesses >= this.config.successThreshold
    ) {
      this.transitionTo("CLOSED");
    }
  }

  /**
   * 记录失败
   */
  recordFailure(error: Error): void {
    this.stats.totalRequests++;
    this.stats.failedRequests++;
    this.stats.consecutiveFailures++;
    this.stats.consecutiveSuccesses = 0;
    this.stats.lastFailureTime = Date.now();

    console.log(`[CircuitBreaker] 记录失败: ${error.message}`);
    this.events.onFailure?.(error);

    // 关闭状态下，连续失败达到阈值，打开熔断器
    if (
      this.state === "CLOSED" &&
      this.stats.consecutiveFailures >= this.config.failureThreshold
    ) {
      this.transitionTo("OPEN");
    }

    // 半开状态下，任何失败都打开熔断器
    if (this.state === "HALF_OPEN") {
      this.transitionTo("OPEN");
    }
  }

  /**
   * 记录超时
   */
  recordTimeout(): void {
    console.log("[CircuitBreaker] 记录超时");
    this.events.onTimeout?.();
    this.recordFailure(new Error("Request timeout"));
  }

  /**
   * 状态转换
   */
  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;

    console.log(`[CircuitBreaker] 状态转换: ${oldState} -> ${newState}`);
    this.events.onStateChange?.(oldState, newState);

    if (newState === "OPEN") {
      this.events.onOpen?.();
      this.scheduleReset();
    } else if (newState === "HALF_OPEN") {
      this.events.onHalfOpen?.();
    } else if (newState === "CLOSED") {
      this.events.onClose?.();
      this.resetStats();
    }
  }

  /**
   * 调度自动重置
   */
  private scheduleReset(): void {
    if (!this.config.enableAutoReset) {
      return;
    }

    // 清除旧的定时器
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
    }

    this.resetTimer = setTimeout(() => {
      if (this.state === "OPEN") {
        console.log("[CircuitBreaker] 自动重置到半开状态");
        this.transitionTo("HALF_OPEN");
      }
    }, this.config.resetTimeout);
  }

  /**
   * 重置统计信息
   */
  private resetStats(): void {
    this.stats = {
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      lastFailureTime: null,
      lastSuccessTime: null,
    };

    console.log("[CircuitBreaker] 重置统计信息");
  }

  /**
   * 强制打开熔断器
   */
  forceOpen(): void {
    this.transitionTo("OPEN");
  }

  /**
   * 强制关闭熔断器
   */
  forceClose(): void {
    this.transitionTo("CLOSED");
  }

  /**
   * 获取当前状态
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * 获取统计信息
   */
  getStats(): CircuitBreakerStats {
    return { ...this.stats };
  }

  /**
   * 获取配置
   */
  getConfig(): CircuitBreakerConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(updates: Partial<CircuitBreakerConfig>): void {
    this.config = { ...this.config, ...updates };
    console.log("[CircuitBreaker] 更新配置:", updates);
  }

  /**
   * 执行请求（带熔断保护）
   */
  async execute<T>(request: () => Promise<T>): Promise<T> {
    // 检查是否允许请求
    if (!this.canRequest()) {
      throw new Error("Circuit breaker is OPEN");
    }

    try {
      // 执行请求（带超时）
      const result = await this.executeWithTimeout(request);
      this.recordSuccess();
      return result;
    } catch (error: any) {
      if (error.message === "Request timeout") {
        this.recordTimeout();
      } else {
        this.recordFailure(error);
      }
      throw error;
    }
  }

  /**
   * 带超时执行请求
   */
  private async executeWithTimeout<T>(request: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Request timeout"));
      }, this.config.timeout);

      request()
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }
}

// ============ 导出 ============

export default CircuitBreaker;
