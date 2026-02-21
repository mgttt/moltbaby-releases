/**
 * 订单通道重试策略 - 高标准实现
 * 
 * 目标：
 * 1. 成功率目标: 99.99% (非99%)
 * 2. CANCEL_RACE目标: 零 (非减少)
 * 3. 自动恢复: 无需人工
 * 4. 可观测: 每步日志
 * 
 * 位置：quant-lab/src/execution/retry-policy.ts
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

// ============ 类型定义 ============

export type ErrorCategory = 
  | "NETWORK_ERROR"
  | "AUTH_ERROR"
  | "RATE_LIMIT"
  | "SERVER_ERROR"
  | "INVALID_REQUEST"
  | "ORDER_NOT_FOUND"
  | "UNKNOWN";

export interface RetryableOperation {
  id: string;
  type: "SUBMIT_ORDER" | "CANCEL_ORDER" | "QUERY_ORDER" | "CONNECT" | "SYNC_STATE";
  payload: any;
  attempt: number;
  maxAttempts: number;
  nextRetryAt: number;
  lastError?: string;
  lastErrorCategory?: ErrorCategory;
  createdAt: number;
  updatedAt: number;
}

export interface RetryPolicyConfig {
  maxAttempts: {
    NETWORK_ERROR: number;
    AUTH_ERROR: number;
    RATE_LIMIT: number;
    SERVER_ERROR: number;
    INVALID_REQUEST: number;
    ORDER_NOT_FOUND: number;
    UNKNOWN: number;
  };
  baseDelay: {
    NETWORK_ERROR: number;
    AUTH_ERROR: number;
    RATE_LIMIT: number;
    SERVER_ERROR: number;
    INVALID_REQUEST: number;
    ORDER_NOT_FOUND: number;
    UNKNOWN: number;
  };
  maxDelay: number;
  jitter: number; // 抖动因子，避免惊群效应
}

export interface CircuitBreakerState {
  failures: number;
  lastFailureTime: number;
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  nextAttemptTime: number;
}

export interface RetryPolicyEvents {
  onRetry: (operation: RetryableOperation) => void;
  onMaxRetriesReached: (operation: RetryableOperation) => void;
  onCircuitBreakerOpen: () => void;
  onCircuitBreakerClose: () => void;
  onOperationSuccess: (operation: RetryableOperation) => void;
}

// ============ 错误分类器 ============

export class ErrorClassifier {
  /**
   * 根据错误信息分类错误
   */
  classify(error: Error): ErrorCategory {
    const message = error.message.toLowerCase();
    const code = (error as any).code || "";

    // 网络错误
    if (
      message.includes("network") ||
      message.includes("timeout") ||
      message.includes("econnrefused") ||
      message.includes("enotfound") ||
      code === "ETIMEDOUT" ||
      code === "ENETDOWN" ||
      code === "ECONNRESET"
    ) {
      return "NETWORK_ERROR";
    }

    // 认证错误
    if (
      message.includes("unauthorized") ||
      message.includes("401") ||
      message.includes("403") ||
      message.includes("api key") ||
      message.includes("signature")
    ) {
      return "AUTH_ERROR";
    }

    // 限流
    if (
      message.includes("rate limit") ||
      message.includes("429") ||
      message.includes("too many requests")
    ) {
      return "RATE_LIMIT";
    }

    // 服务器错误
    if (
      message.includes("500") ||
      message.includes("502") ||
      message.includes("503") ||
      message.includes("504") ||
      message.includes("server error") ||
      message.includes("internal error")
    ) {
      return "SERVER_ERROR";
    }

    // 订单不存在
    if (
      message.includes("110001") ||
      message.includes("order does not exist") ||
      message.includes("order not found")
    ) {
      return "ORDER_NOT_FOUND";
    }

    // 无效请求
    if (
      message.includes("400") ||
      message.includes("invalid") ||
      message.includes("bad request")
    ) {
      return "INVALID_REQUEST";
    }

    return "UNKNOWN";
  }

  /**
   * 判断错误是否可重试
   */
  isRetryable(category: ErrorCategory): boolean {
    // AUTH_ERROR 和 INVALID_REQUEST 不应该重试
    // ORDER_NOT_FOUND 是特殊错误，已经处理过，不算失败
    return (
      category === "NETWORK_ERROR" ||
      category === "RATE_LIMIT" ||
      category === "SERVER_ERROR" ||
      category === "UNKNOWN"
    );
  }
}

// ============ 重试策略 ============

export class RetryPolicy {
  private config: RetryPolicyConfig;
  private classifier: ErrorClassifier;
  private queue: RetryableOperation[] = [];
  private queuePath: string;
  private processingTimer: NodeJS.Timeout | null = null;
  private circuitBreaker: CircuitBreakerState;
  private events: Partial<RetryPolicyEvents> = {};
  private stats = {
    total: 0,
    success: 0,
    failed: 0,
    retried: 0,
  };

  constructor(config?: Partial<RetryPolicyConfig>, queuePath?: string) {
    this.config = {
      maxAttempts: {
        NETWORK_ERROR: 10,
        AUTH_ERROR: 0, // 不重试
        RATE_LIMIT: 5,
        SERVER_ERROR: 8,
        INVALID_REQUEST: 0, // 不重试
        ORDER_NOT_FOUND: 0, // 特殊处理，不算失败
        UNKNOWN: 5,
        ...config?.maxAttempts,
      },
      baseDelay: {
        NETWORK_ERROR: 1000,
        AUTH_ERROR: 0,
        RATE_LIMIT: 5000,
        SERVER_ERROR: 2000,
        INVALID_REQUEST: 0,
        ORDER_NOT_FOUND: 0,
        UNKNOWN: 3000,
        ...config?.baseDelay,
      },
      maxDelay: config?.maxDelay || 60000, // 最大1分钟
      jitter: config?.jitter || 0.1, // 10% 抖动
    };

    this.classifier = new ErrorClassifier();
    this.queuePath = queuePath || join(homedir(), ".quant-lab", "retry-queue.jsonl");
    this.circuitBreaker = {
      failures: 0,
      lastFailureTime: 0,
      state: "CLOSED",
      nextAttemptTime: 0,
    };

    this.loadQueue();
    this.startProcessing();
  }

  /**
   * 设置事件回调
   */
  setEvents(events: Partial<RetryPolicyEvents>): void {
    this.events = { ...this.events, ...events };
  }

  /**
   * 添加操作到重试队列
   */
  enqueue(
    type: RetryableOperation["type"],
    payload: any,
    error?: Error
  ): RetryableOperation {
    const category = error ? this.classifier.classify(error) : "UNKNOWN";
    const maxAttempts = this.config.maxAttempts[category];

    const operation: RetryableOperation = {
      id: `${type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      payload,
      attempt: 0,
      maxAttempts,
      nextRetryAt: Date.now(),
      lastError: error?.message,
      lastErrorCategory: category,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.queue.push(operation);
    this.saveQueue();
    this.log("[RetryPolicy] 操作已加入队列", operation);

    return operation;
  }

  /**
   * 处理失败的操作
   */
  async handleFailure(
    operation: RetryableOperation,
    error: Error
  ): Promise<boolean> {
    const category = this.classifier.classify(error);
    operation.attempt++;
    operation.lastError = error.message;
    operation.lastErrorCategory = category;
    operation.updatedAt = Date.now();

    this.stats.total++;

    // ORDER_NOT_FOUND 是特殊错误，标记为成功
    if (category === "ORDER_NOT_FOUND") {
      this.stats.success++;
      this.events.onOperationSuccess?.(operation);
      this.log("[RetryPolicy] ORDER_NOT_FOUND - 标记为成功", operation);
      return true;
    }

    // 不可重试的错误，直接失败
    if (!this.classifier.isRetryable(category)) {
      this.stats.failed++;
      this.events.onMaxRetriesReached?.(operation);
      this.log("[RetryPolicy] 不可重试错误 - 失败", operation);
      return false;
    }

    // 达到最大重试次数
    if (operation.attempt >= operation.maxAttempts) {
      this.stats.failed++;
      this.events.onMaxRetriesReached?.(operation);
      this.log("[RetryPolicy] 达到最大重试次数 - 失败", operation);
      return false;
    }

    // 计算下次重试时间（指数退避 + 抖动）
    const baseDelay = this.config.baseDelay[category];
    const delay = Math.min(
      baseDelay * Math.pow(2, operation.attempt - 1),
      this.config.maxDelay
    );
    const jitter = delay * this.config.jitter * (Math.random() * 2 - 1);
    operation.nextRetryAt = Date.now() + delay + jitter;

    // 加入队列
    this.queue.push(operation);
    this.saveQueue();

    this.stats.retried++;
    this.events.onRetry?.(operation);
    this.log("[RetryPolicy] 操作已重新加入队列", operation);

    return true;
  }

  /**
   * 记录成功
   */
  recordSuccess(operation: RetryableOperation): void {
    this.stats.success++;
    this.circuitBreaker.failures = 0;
    this.events.onOperationSuccess?.(operation);
    this.log("[RetryPolicy] 操作成功", operation);
  }

  /**
   * 获取待重试的操作
   */
  getNextRetry(): RetryableOperation | undefined {
    const now = Date.now();
    const index = this.queue.findIndex((op) => op.nextRetryAt <= now);

    if (index >= 0) {
      const operation = this.queue.splice(index, 1)[0];
      this.saveQueue();
      return operation;
    }

    return undefined;
  }

  /**
   * 熔断器检查
   */
  canExecute(): boolean {
    const now = Date.now();

    if (this.circuitBreaker.state === "OPEN") {
      // 半开状态尝试
      if (now >= this.circuitBreaker.nextAttemptTime) {
        this.circuitBreaker.state = "HALF_OPEN";
        this.log("[RetryPolicy] 熔断器进入半开状态");
        return true;
      }
      return false;
    }

    return true;
  }

  /**
   * 记录熔断器失败
   */
  recordCircuitFailure(): void {
    this.circuitBreaker.failures++;
    this.circuitBreaker.lastFailureTime = Date.now();

    // 连续5次失败后打开熔断器
    if (this.circuitBreaker.failures >= 5) {
      this.circuitBreaker.state = "OPEN";
      this.circuitBreaker.nextAttemptTime = Date.now() + 30000; // 30秒后尝试
      this.events.onCircuitBreakerOpen?.();
      this.log("[RetryPolicy] 熔断器打开，暂停操作");
    }
  }

  /**
   * 记录熔断器成功
   */
  recordCircuitSuccess(): void {
    this.circuitBreaker.failures = 0;
    if (this.circuitBreaker.state === "HALF_OPEN") {
      this.circuitBreaker.state = "CLOSED";
      this.events.onCircuitBreakerClose?.();
      this.log("[RetryPolicy] 熔断器关闭，恢复正常");
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    queueLength: number;
    total: number;
    success: number;
    failed: number;
    retried: number;
    successRate: number;
    circuitBreakerState: string;
  } {
    const successRate =
      this.stats.total > 0
        ? (this.stats.success / this.stats.total) * 100
        : 100;

    return {
      queueLength: this.queue.length,
      total: this.stats.total,
      success: this.stats.success,
      failed: this.stats.failed,
      retried: this.stats.retried,
      successRate,
      circuitBreakerState: this.circuitBreaker.state,
    };
  }

  /**
   * 启动队列处理
   */
  private startProcessing(): void {
    // 每秒检查一次队列
    this.processingTimer = setInterval(() => {
      this.processQueue();
    }, 1000);
  }

  /**
   * 停止队列处理
   */
  stopProcessing(): void {
    if (this.processingTimer) {
      clearInterval(this.processingTimer);
      this.processingTimer = null;
    }
  }

  /**
   * 处理队列
   */
  private processQueue(): void {
    if (!this.canExecute()) {
      return;
    }

    const operation = this.getNextRetry();
    if (operation) {
      this.executeOperation(operation);
    }
  }

  /**
   * 执行操作（需要外部提供执行器）
   */
  private async executeOperation(operation: RetryableOperation): Promise<void> {
    this.log("[RetryPolicy] 执行重试操作", operation);

    // 注意：这里需要外部提供执行器
    // 实际实现中，应该通过事件回调让外部执行
    // 这里只是示例
  }

  /**
   * 加载队列
   */
  private loadQueue(): void {
    if (existsSync(this.queuePath)) {
      try {
        const content = readFileSync(this.queuePath, "utf-8");
        const lines = content.trim().split("\n");
        this.queue = lines
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));
        this.log(`[RetryPolicy] 加载队列: ${this.queue.length} 个操作`);
      } catch (error) {
        this.log("[RetryPolicy] 加载队列失败:", error);
        this.queue = [];
      }
    }
  }

  /**
   * 保存队列
   */
  private saveQueue(): void {
    try {
      const dir = dirname(this.queuePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const content = this.queue.map((op) => JSON.stringify(op)).join("\n");
      writeFileSync(this.queuePath, content);
      this.log(`[RetryPolicy] 保存队列: ${this.queue.length} 个操作`);
    } catch (error) {
      this.log("[RetryPolicy] 保存队列失败:", error);
    }
  }

  /**
   * 日志
   */
  private log(message: string, ...args: any[]): void {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`, ...args);
  }
}

// ============ 导出 ============

export default RetryPolicy;
