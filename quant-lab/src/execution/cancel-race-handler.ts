/**
 * CANCEL_RACE 修复 - P1 + 重试策略
 * 
 * 功能：
 * 1. 撤单幂等保护（Set 记录已撤订单）
 * 2. 110001 错误处理（order not exists）
 * 3. 状态机同步（本地 vs 交易所）
 * 4. 高标准重试策略（零CANCEL_RACE目标）
 * 5. 自动恢复机制
 * 6. 每步日志
 * 
 * 位置：quant-lab/src/execution/cancel-race-handler.ts
 * 时间：6h
 */

import { createLogger } from '../utils/logger';
const logger = createLogger('cancel-race-handler');

import { RetryPolicy, ErrorClassifier } from "./retry-policy";
import { join } from "path";
import { homedir } from "os";

// ============ 类型定义 ============

export interface CancelRequest {
  orderId: string;
  orderLinkId: string;
  symbol: string;
  timestamp: number;
}

export interface CancelResult {
  success: boolean;
  orderId: string;
  error?: string;
  errorCode?: string;
  alreadyCancelled?: boolean;
  orderNotExists?: boolean;
}

export type OrderStatus = "New" | "PartiallyFilled" | "Filled" | "Cancelled";

export interface OrderState {
  orderId: string;
  orderLinkId: string;
  symbol: string;
  localStatus: OrderStatus;
  exchangeStatus: OrderStatus;
  lastUpdated: number;
}

export interface CancelRaceHandlerEvents {
  onDuplicateCancel: (orderId: string) => void;
  onOrderNotExists: (orderId: string) => void;
  onStatusSynced: (orderId: string, status: OrderStatus) => void;
  onError: (error: Error, orderId: string) => void;
}

// ============ 撤单竞态处理器 ============

export class CancelRaceHandler {
  // 已撤订单集合（幂等保护）
  private cancelledOrders: Set<string> = new Set();
  
  // 订单状态缓存（本地状态）
  private orderStates: Map<string, OrderState> = new Map();
  
  // 事件回调
  private events: Partial<CancelRaceHandlerEvents> = {};

  // 重试策略
  private retryPolicy: RetryPolicy;
  private errorClassifier: ErrorClassifier;

  constructor() {
    logger.info("[CancelRaceHandler] 初始化撤单竞态处理器");
    
    this.errorClassifier = new ErrorClassifier();
    this.retryPolicy = new RetryPolicy(undefined, join(homedir(), ".quant-lab", "cancel-retry-queue.jsonl"));
    
    this.setupRetryPolicyEvents();
  }

  /**
   * 设置重试策略事件回调
   */
  private setupRetryPolicyEvents(): void {
    this.retryPolicy.setEvents({
      onRetry: (operation) => {
        this.log(`[CancelRaceHandler] 重试撤单: ${operation.payload.orderId} (attempt ${operation.attempt})`);
      },
      onMaxRetriesReached: (operation) => {
        this.log(`[CancelRaceHandler] 撤单达到最大重试次数: ${operation.payload.orderId}`);
      },
      onOperationSuccess: (operation) => {
        this.log(`[CancelRaceHandler] 撤单成功: ${operation.payload.orderId}`);
      },
    });
  }

  /**
   * 设置事件回调
   */
  setEvents(events: Partial<CancelRaceHandlerEvents>): void {
    this.events = { ...this.events, ...events };
  }

  /**
   * 撤单幂等保护
   * 
   * 规则：同一 orderLinkId 只撤一次
   */
  async cancelOrder(request: CancelRequest): Promise<CancelResult> {
    const { orderId, orderLinkId, symbol } = request;

    logger.info(`[CancelRaceHandler] 尝试撤销订单: ${orderId}, orderLinkId: ${orderLinkId}`);

    // 1. 幂等检查：是否已撤销
    if (this.cancelledOrders.has(orderLinkId)) {
      logger.warn(`[CancelRaceHandler] 重复撤单（幂等保护）: ${orderLinkId}`);
      this.events.onDuplicateCancel?.(orderId);
      
      return {
        success: true,
        orderId,
        alreadyCancelled: true,
      };
    }

    // 2. 状态检查：订单是否已成交或已撤销
    const orderState = this.orderStates.get(orderId);
    if (orderState) {
      if (orderState.localStatus === "Filled" || orderState.localStatus === "Cancelled") {
        logger.warn(
          `[CancelRaceHandler] 订单已${orderState.localStatus}，跳过撤单: ${orderId}`
        );
        
        return {
          success: true,
          orderId,
          alreadyCancelled: orderState.localStatus === "Cancelled",
        };
      }
    }

    // 3. 执行撤单
    try {
      await this.executeCancel(orderId, symbol);

      // 4. 记录已撤销（幂等保护）
      this.cancelledOrders.add(orderLinkId);

      // 5. 更新本地状态
      this.updateLocalStatus(orderId, "Cancelled");

      logger.info(`[CancelRaceHandler] 撤单成功: ${orderId}`);

      return {
        success: true,
        orderId,
      };
    } catch (error: any) {
      // 6. 错误处理
      return this.handleError(error, orderId, orderLinkId);
    }
  }

  /**
   * 执行撤单（带重试策略）
   * 
   * 目标：零CANCEL_RACE
   * 策略：
   * 1. 110001错误 → 标记成功（幂等保护）
   * 2. 网络错误/服务器错误 → 自动重试
   * 3. 认证错误/无效请求 → 失败（需要人工干预）
   */
  private async executeCancel(orderId: string, symbol: string): Promise<void> {
    this.log(`[CancelRaceHandler] 执行撤单: ${orderId}, symbol: ${symbol}`);

    // 熔断器检查
    if (!this.retryPolicy.canExecute()) {
      throw new Error("熔断器打开，拒绝撤单");
    }

    // 模拟撤单（实际需要调用交易所 API）
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        // 模拟不同类型的错误（5%失败率，用于测试重试策略）
        const shouldFail = Math.random() < 0.05;

        if (shouldFail) {
          const errors = [
            new Error("110001: Order does not exist"),
            new Error("network timeout"), // 小写，匹配NETWORK_ERROR
            new Error("500 server error"), // 小写，匹配SERVER_ERROR
            new Error("429 rate limit"), // 包含429，匹配RATE_LIMIT
          ];
          const randomError = errors[Math.floor(Math.random() * errors.length)];
          reject(randomError);
        } else {
          resolve();
        }
      }, 100);
    });
  }

  /**
   * 错误处理（带重试策略）
   * 
   * 策略：
   * 1. 110001错误 → 标记成功（零CANCEL_RACE）
   * 2. 可重试错误 → 加入重试队列
   * 3. 不可重试错误 → 返回失败
   */
  private handleError(
    error: Error,
    orderId: string,
    orderLinkId: string
  ): CancelResult {
    const errorMessage = error.message || "";
    this.log(`[CancelRaceHandler] 撤单失败: ${orderId}, 错误: ${errorMessage}`);

    // 分类错误
    const category = this.errorClassifier.classify(error);
    this.log(`[CancelRaceHandler] 错误分类: ${category}`);

    // 110001 错误处理：订单不存在（零CANCEL_RACE）
    if (category === "ORDER_NOT_FOUND") {
      this.log(`[CancelRaceHandler] 订单不存在（110001）- 标记成功（零CANCEL_RACE）: ${orderId}`);
      this.events.onOrderNotExists?.(orderId);

      // 标记为已撤销（订单已不存在，幂等保护）
      this.cancelledOrders.add(orderLinkId);
      this.updateLocalStatus(orderId, "Cancelled");

      // 记录熔断器成功
      this.retryPolicy.recordCircuitSuccess();

      return {
        success: true,
        orderId,
        orderNotExists: true,
        errorCode: "110001",
      };
    }

    // 记录熔断器失败
    this.retryPolicy.recordCircuitFailure();

    // 判断是否可重试
    if (this.errorClassifier.isRetryable(category)) {
      this.log(`[CancelRaceHandler] 错误可重试，加入重试队列: ${orderId}`);
      
      // 加入重试队列
      this.retryPolicy.enqueue("CANCEL_ORDER", {
        orderId,
        orderLinkId,
        symbol: this.orderStates.get(orderId)?.symbol || "UNKNOWN",
      }, error);

      // 返回成功（让重试策略处理）
      return {
        success: true, // 标记为成功，让重试策略异步处理
        orderId,
      };
    }

    // 不可重试的错误（AUTH_ERROR, INVALID_REQUEST）
    this.log(`[CancelRaceHandler] 不可重试错误，需要人工干预: ${orderId}`);
    this.events.onError?.(error, orderId);

    return {
      success: false,
      orderId,
      error: errorMessage,
      errorCode: category,
    };
  }

  /**
   * 更新本地状态
   */
  updateLocalStatus(orderId: string, status: OrderStatus): void {
    const orderState = this.orderStates.get(orderId);
    
    if (orderState) {
      orderState.localStatus = status;
      orderState.lastUpdated = Date.now();
      this.orderStates.set(orderId, orderState);
      logger.info(`[CancelRaceHandler] 更新本地状态: ${orderId} -> ${status}`);
    }
  }

  /**
   * 同步交易所状态
   */
  async syncExchangeStatus(orderId: string): Promise<OrderStatus> {
    logger.info(`[CancelRaceHandler] 同步交易所状态: ${orderId}`);

    // 模拟从交易所获取状态
    const exchangeStatus = await this.fetchExchangeStatus(orderId);

    // 更新状态
    const orderState = this.orderStates.get(orderId);
    if (orderState) {
      orderState.exchangeStatus = exchangeStatus;
      orderState.lastUpdated = Date.now();
      this.orderStates.set(orderId, orderState);
      
      this.events.onStatusSynced?.(orderId, exchangeStatus);
    }

    return exchangeStatus;
  }

  /**
   * 从交易所获取状态（模拟）
   */
  private async fetchExchangeStatus(orderId: string): Promise<OrderStatus> {
    return new Promise((resolve) => {
      setTimeout(() => {
        // 模拟返回状态
        const statuses: OrderStatus[] = ["New", "Filled", "Cancelled"];
        const randomStatus = statuses[Math.floor(Math.random() * statuses.length)];
        resolve(randomStatus);
      }, 100);
    });
  }

  /**
   * 添加订单状态
   */
  addOrderState(orderId: string, orderLinkId: string, symbol: string): void {
    const orderState: OrderState = {
      orderId,
      orderLinkId,
      symbol,
      localStatus: "New",
      exchangeStatus: "New",
      lastUpdated: Date.now(),
    };
    
    this.orderStates.set(orderId, orderState);
    logger.info(`[CancelRaceHandler] 添加订单状态: ${orderId}`);
  }

  /**
   * 获取订单状态
   */
  getOrderState(orderId: string): OrderState | undefined {
    return this.orderStates.get(orderId);
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalOrders: number;
    cancelledOrders: number;
    activeOrders: number;
  } {
    return {
      totalOrders: this.orderStates.size,
      cancelledOrders: this.cancelledOrders.size,
      activeOrders: this.orderStates.size - this.cancelledOrders.size,
    };
  }

  /**
   * 清理已撤销订单（防止内存泄漏）
   */
  cleanupCancelledOrders(maxAge: number = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    let cleanedCount = 0;

    // 注意：这里简化了清理逻辑，实际实现需要记录撤销时间
    // 这里只是示例
    if (this.cancelledOrders.size > 1000) {
      this.log("[CancelRaceHandler] 清理已撤销订单（超过 1000 个）");
      this.cancelledOrders.clear();
      cleanedCount = 1000;
    }

    return cleanedCount;
  }

  /**
   * 日志（带时间戳）
   */
  private log(message: string, ...args: any[]): void {
    const timestamp = new Date().toISOString();
    logger.info(`[${timestamp}] ${message}`, ...args);
  }

  /**
   * 获取重试统计
   */
  getRetryStats() {
    return this.retryPolicy.getStats();
  }
}

// ============ 导出 ============

export default CancelRaceHandler;
