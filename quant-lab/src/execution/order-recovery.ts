/**
 * 未完成订单补偿机制 - 自动恢复链路核心
 * 
 * 功能：
 * 1. 系统重启后扫描未完成订单
 * 2. 查询交易所订单状态
 * 3. 同步本地状态
 * 4. 补偿未完成操作（撤单/重试）
 * 
 * 位置：quant-lab/src/execution/order-recovery.ts
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { RetryPolicy, ErrorClassifier } from "./retry-policy";

// ============ 类型定义 ============

export interface PendingOrder {
  orderId: string;
  orderLinkId: string;
  symbol: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT";
  qty: number;
  price?: number;
  status: "PENDING" | "SUBMITTED" | "FILLED" | "CANCELLED" | "FAILED";
  createdAt: number;
  updatedAt: number;
  retryCount: number;
  lastError?: string;
}

export interface RecoveryResult {
  total: number;
  recovered: number;
  failed: number;
  skipped: number;
  details: Array<{
    orderId: string;
    action: "SYNCED" | "RECOVERED" | "FAILED" | "SKIPPED";
    message: string;
  }>;
}

export interface OrderRecoveryEvents {
  onRecoveryStart: (total: number) => void;
  onRecoveryProgress: (orderId: string, action: string) => void;
  onRecoveryComplete: (result: RecoveryResult) => void;
  onError: (error: Error, orderId: string) => void;
}

// ============ 订单恢复管理器 ============

export class OrderRecoveryManager {
  private pendingOrdersPath: string;
  private pendingOrders: Map<string, PendingOrder> = new Map();
  private retryPolicy: RetryPolicy;
  private errorClassifier: ErrorClassifier;
  private events: Partial<OrderRecoveryEvents> = {};

  constructor(pendingOrdersPath?: string) {
    this.pendingOrdersPath =
      pendingOrdersPath ||
      join(homedir(), ".quant-lab", "pending-orders.jsonl");
    this.retryPolicy = new RetryPolicy(
      undefined,
      join(homedir(), ".quant-lab", "recovery-retry-queue.jsonl")
    );
    this.errorClassifier = new ErrorClassifier();

    this.loadPendingOrders();
    // 注意：OrderRecoveryManager不需要setupRetryPolicyEvents
    // 因为retryPolicy的事件在需要时才设置
  }

  /**
   * 设置事件回调
   */
  setEvents(events: Partial<OrderRecoveryEvents>): void {
    this.events = { ...this.events, ...events };
  }

  /**
   * 添加待处理订单
   */
  addPendingOrder(order: Omit<PendingOrder, "createdAt" | "updatedAt" | "retryCount">): void {
    const pendingOrder: PendingOrder = {
      ...order,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      retryCount: 0,
    };

    this.pendingOrders.set(order.orderId, pendingOrder);
    this.savePendingOrders();

    this.log(`[OrderRecovery] 添加待处理订单: ${order.orderId}`);
  }

  /**
   * 更新订单状态
   */
  updateOrderStatus(orderId: string, status: PendingOrder["status"], error?: string): void {
    const order = this.pendingOrders.get(orderId);
    if (order) {
      order.status = status;
      order.updatedAt = Date.now();
      if (error) {
        order.lastError = error;
      }
      this.pendingOrders.set(orderId, order);
      this.savePendingOrders();

      this.log(`[OrderRecovery] 更新订单状态: ${orderId} -> ${status}`);
    }
  }

  /**
   * 移除已完成的订单
   */
  removeCompletedOrder(orderId: string): void {
    if (this.pendingOrders.has(orderId)) {
      this.pendingOrders.delete(orderId);
      this.savePendingOrders();

      this.log(`[OrderRecovery] 移除已完成订单: ${orderId}`);
    }
  }

  /**
   * 执行订单恢复
   * 
   * 流程：
   * 1. 扫描所有未完成订单
   * 2. 查询交易所订单状态
   * 3. 同步本地状态
   * 4. 补偿未完成操作
   */
  async recoverOrders(): Promise<RecoveryResult> {
    const result: RecoveryResult = {
      total: this.pendingOrders.size,
      recovered: 0,
      failed: 0,
      skipped: 0,
      details: [],
    };

    this.log(`[OrderRecovery] 开始恢复订单，总数: ${result.total}`);
    this.events.onRecoveryStart?.(result.total);

    if (this.pendingOrders.size === 0) {
      this.log("[OrderRecovery] 无待恢复订单");
      this.events.onRecoveryComplete?.(result);
      return result;
    }

    // 遍历所有待处理订单
    for (const [orderId, order] of this.pendingOrders) {
      try {
        const action = await this.recoverSingleOrder(order);

        result.details.push({
          orderId,
          action,
          message: this.getActionMessage(action),
        });

        switch (action) {
          case "RECOVERED":
            result.recovered++;
            break;
          case "FAILED":
            result.failed++;
            break;
          case "SKIPPED":
            result.skipped++;
            break;
          case "SYNCED":
            result.recovered++;
            break;
        }

        this.events.onRecoveryProgress?.(orderId, action);
      } catch (error: any) {
        this.log(`[OrderRecovery] 恢复订单失败: ${orderId}, 错误: ${error.message}`);
        result.failed++;
        result.details.push({
          orderId,
          action: "FAILED",
          message: error.message,
        });
        this.events.onError?.(error, orderId);
      }
    }

    this.log(
      `[OrderRecovery] 恢复完成: 总数=${result.total}, 恢复=${result.recovered}, 失败=${result.failed}, 跳过=${result.skipped}`
    );
    this.events.onRecoveryComplete?.(result);

    return result;
  }

  /**
   * 恢复单个订单
   */
  private async recoverSingleOrder(order: PendingOrder): Promise<"SYNCED" | "RECOVERED" | "FAILED" | "SKIPPED"> {
    this.log(`[OrderRecovery] 恢复订单: ${order.orderId}, 状态: ${order.status}`);

    // 1. 查询交易所订单状态
    const exchangeStatus = await this.queryExchangeStatus(order.orderId);

    // 2. 同步本地状态
    if (exchangeStatus !== order.status) {
      this.updateOrderStatus(order.orderId, this.mapExchangeStatus(exchangeStatus));
      this.log(`[OrderRecovery] 状态同步: ${order.orderId} ${order.status} -> ${exchangeStatus}`);
    }

    // 3. 根据状态决定恢复策略
    switch (exchangeStatus) {
      case "Filled":
        // 已成交，标记完成
        this.removeCompletedOrder(order.orderId);
        return "SYNCED";

      case "Cancelled":
        // 已撤销，标记完成
        this.removeCompletedOrder(order.orderId);
        return "SYNCED";

      case "New":
      case "PartiallyFilled":
        // 未成交或部分成交，尝试撤单补偿
        const cancelSuccess = await this.compensateCancel(order);
        if (cancelSuccess) {
          this.removeCompletedOrder(order.orderId);
          return "RECOVERED";
        } else {
          return "FAILED";
        }

      case "NotFound":
        // 订单不存在，标记完成（零CANCEL_RACE）
        this.removeCompletedOrder(order.orderId);
        return "SYNCED";

      default:
        // 未知状态，跳过
        return "SKIPPED";
    }
  }

  /**
   * 查询交易所订单状态（模拟）
   */
  private async queryExchangeStatus(orderId: string): Promise<string> {
    this.log(`[OrderRecovery] 查询交易所订单状态: ${orderId}`);

    // 模拟查询（实际需要调用交易所API）
    return new Promise((resolve) => {
      setTimeout(() => {
        // 模拟返回不同状态
        const statuses = ["New", "Filled", "Cancelled", "PartiallyFilled", "NotFound"];
        const randomStatus = statuses[Math.floor(Math.random() * statuses.length)];
        resolve(randomStatus);
      }, 100);
    });
  }

  /**
   * 补偿撤单
   */
  private async compensateCancel(order: PendingOrder): Promise<boolean> {
    this.log(`[OrderRecovery] 补偿撤单: ${order.orderId}`);

    try {
      // 调用撤单API（实际需要实现）
      await this.executeCancel(order.orderId, order.symbol);
      return true;
    } catch (error: any) {
      this.log(`[OrderRecovery] 补偿撤单失败: ${order.orderId}, 错误: ${error.message}`);

      // 判断错误类型
      const category = this.errorClassifier.classify(error);

      // ORDER_NOT_FOUND 也算成功（零CANCEL_RACE）
      if (category === "ORDER_NOT_FOUND") {
        return true;
      }

      // 可重试错误，加入重试队列
      if (this.errorClassifier.isRetryable(category)) {
        this.retryPolicy.enqueue("CANCEL_ORDER", {
          orderId: order.orderId,
          orderLinkId: order.orderLinkId,
          symbol: order.symbol,
        }, error);
      }

      return false;
    }
  }

  /**
   * 执行撤单（模拟）
   */
  private async executeCancel(orderId: string, symbol: string): Promise<void> {
    this.log(`[OrderRecovery] 执行撤单: ${orderId}, symbol: ${symbol}`);

    // 模拟撤单（实际需要调用交易所API）
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        // 模拟95%成功率
        const success = Math.random() > 0.05;

        if (success) {
          resolve();
        } else {
          const errors = [
            new Error("110001: Order does not exist"),
            new Error("network timeout"),
            new Error("500 server error"),
          ];
          const randomError = errors[Math.floor(Math.random() * errors.length)];
          reject(randomError);
        }
      }, 100);
    });
  }

  /**
   * 映射交易所状态到本地状态
   */
  private mapExchangeStatus(exchangeStatus: string): PendingOrder["status"] {
    switch (exchangeStatus) {
      case "New":
        return "SUBMITTED";
      case "Filled":
        return "FILLED";
      case "Cancelled":
        return "CANCELLED";
      case "PartiallyFilled":
        return "SUBMITTED";
      case "NotFound":
        return "FAILED";
      default:
        return "PENDING";
    }
  }

  /**
   * 获取动作消息
   */
  private getActionMessage(action: "SYNCED" | "RECOVERED" | "FAILED" | "SKIPPED"): string {
    switch (action) {
      case "SYNCED":
        return "状态已同步";
      case "RECOVERED":
        return "订单已恢复";
      case "FAILED":
        return "恢复失败";
      case "SKIPPED":
        return "跳过处理";
      default:
        return "未知";
    }
  }

  /**
   * 加载待处理订单
   */
  private loadPendingOrders(): void {
    if (existsSync(this.pendingOrdersPath)) {
      try {
        const content = readFileSync(this.pendingOrdersPath, "utf-8");
        const lines = content.trim().split("\n");
        this.pendingOrders = new Map(
          lines
            .filter((line) => line.trim())
            .map((line) => {
              const order = JSON.parse(line);
              return [order.orderId, order];
            })
        );
        this.log(`[OrderRecovery] 加载待处理订单: ${this.pendingOrders.size} 个`);
      } catch (error) {
        this.log("[OrderRecovery] 加载待处理订单失败:", error);
        this.pendingOrders = new Map();
      }
    }
  }

  /**
   * 保存待处理订单
   */
  private savePendingOrders(): void {
    try {
      const dir = dirname(this.pendingOrdersPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const content = Array.from(this.pendingOrders.values())
        .map((order) => JSON.stringify(order))
        .join("\n");
      writeFileSync(this.pendingOrdersPath, content);

      this.log(`[OrderRecovery] 保存待处理订单: ${this.pendingOrders.size} 个`);
    } catch (error) {
      this.log("[OrderRecovery] 保存待处理订单失败:", error);
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    total: number;
    byStatus: Record<string, number>;
  } {
    const byStatus: Record<string, number> = {};

    for (const order of this.pendingOrders.values()) {
      byStatus[order.status] = (byStatus[order.status] || 0) + 1;
    }

    return {
      total: this.pendingOrders.size,
      byStatus,
    };
  }

  /**
   * 清理已完成的订单（定期清理）
   */
  cleanupCompletedOrders(maxAge: number = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [orderId, order] of this.pendingOrders) {
      if (
        (order.status === "FILLED" || order.status === "CANCELLED" || order.status === "FAILED") &&
        now - order.updatedAt > maxAge
      ) {
        this.pendingOrders.delete(orderId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.savePendingOrders();
      this.log(`[OrderRecovery] 清理已完成订单: ${cleanedCount} 个`);
    }

    return cleanedCount;
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

export default OrderRecoveryManager;
