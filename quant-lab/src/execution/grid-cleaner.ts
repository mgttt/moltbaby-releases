/**
 * 网格清理机制 - P1
 * 
 * 功能：
 * 1. 超时订单检测（60秒阈值）
 * 2. 自动取消逻辑
 * 3. GRID_TIMEOUT 触发器
 * 
 * 位置：quant-lab/src/execution/grid-cleaner.ts
 * 时间：4h
 */

import { createLogger } from '../utils/logger';
const logger = createLogger('grid-cleaner');

import { setInterval, clearInterval } from "timers";

// ============ 类型定义 ============

export interface GridOrder {
  orderId: string;
  orderLinkId: string;
  symbol: string;
  side: "Buy" | "Sell";
  price: number;
  qty: number;
  status: "New" | "PartiallyFilled" | "Filled" | "Cancelled";
  createdAt: number;
  gridId: string;
}

export interface GridCleanerConfig {
  maxOrderAge: number; // 超时阈值（毫秒），默认 60秒
  checkInterval: number; // 检查间隔（毫秒），默认 5秒
  enableAutoCancel: boolean; // 是否自动取消
}

export interface GridCleanerEvents {
  onTimeoutDetected: (order: GridOrder) => void;
  onOrderCancelled: (order: GridOrder) => void;
  onGridCleaned: (gridId: string, cancelledCount: number) => void;
  onError: (error: Error, order?: GridOrder) => void;
}

// ============ 网格清理器 ============

export class GridCleaner {
  private orders: Map<string, GridOrder> = new Map();
  private config: GridCleanerConfig;
  private events: Partial<GridCleanerEvents> = {};
  private checkTimer: NodeJS.Timeout | null = null;

  constructor(config?: Partial<GridCleanerConfig>) {
    this.config = {
      maxOrderAge: 60 * 1000, // 60秒
      checkInterval: 5 * 1000, // 5秒
      enableAutoCancel: true,
      ...config,
    };
  }

  /**
   * 设置事件回调
   */
  setEvents(events: Partial<GridCleanerEvents>): void {
    this.events = { ...this.events, ...events };
  }

  /**
   * 添加订单
   */
  addOrder(order: GridOrder): void {
    this.orders.set(order.orderId, order);
    logger.info(`[GridCleaner] 添加订单: ${order.orderId}, 网格: ${order.gridId}`);
  }

  /**
   * 移除订单
   */
  removeOrder(orderId: string): void {
    this.orders.delete(orderId);
    logger.info(`[GridCleaner] 移除订单: ${orderId}`);
  }

  /**
   * 获取订单
   */
  getOrder(orderId: string): GridOrder | undefined {
    return this.orders.get(orderId);
  }

  /**
   * 获取所有订单
   */
  getAllOrders(): GridOrder[] {
    return Array.from(this.orders.values());
  }

  /**
   * 启动定时清理任务
   */
  startCleaner(): void {
    if (this.checkTimer) {
      logger.warn("[GridCleaner] 清理任务已在运行");
      return;
    }

    logger.info("[GridCleaner] 启动定时清理任务");
    logger.info(`[GridCleaner] 检查间隔: ${this.config.checkInterval}ms`);
    logger.info(`[GridCleaner] 超时阈值: ${this.config.maxOrderAge}ms`);

    this.checkTimer = setInterval(() => {
      this.cleanTimeoutOrders().catch((error) => {
        logger.error("[GridCleaner] 清理失败:", error);
        this.events.onError?.(error);
      });
    }, this.config.checkInterval);
  }

  /**
   * 停止定时清理任务
   */
  stopCleaner(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
      logger.info("[GridCleaner] 停止定时清理任务");
    }
  }

  /**
   * 清理超时订单
   */
  async cleanTimeoutOrders(): Promise<number> {
    const now = Date.now();
    const timeoutOrders: GridOrder[] = [];

    // 检测超时订单
    for (const order of this.orders.values()) {
      const age = now - order.createdAt;

      if (age > this.config.maxOrderAge && order.status === "New") {
        timeoutOrders.push(order);
        logger.info(
          `[GridCleaner] 检测到超时订单: ${order.orderId}, 年龄: ${age}ms`
        );
        this.events.onTimeoutDetected?.(order);
      }
    }

    // 取消超时订单
    let cancelledCount = 0;
    if (this.config.enableAutoCancel) {
      for (const order of timeoutOrders) {
        try {
          await this.cancelOrder(order);
          cancelledCount++;
        } catch (error: any) {
          logger.error(
            `[GridCleaner] 取消订单失败: ${order.orderId}, 错误: ${error.message}`
          );
          this.events.onError?.(error, order);
        }
      }
    }

    if (cancelledCount > 0) {
      logger.info(`[GridCleaner] 清理完成，取消 ${cancelledCount} 个超时订单`);
    }

    return cancelledCount;
  }

  /**
   * 取消订单
   */
  private async cancelOrder(order: GridOrder): Promise<void> {
    logger.info(`[GridCleaner] 取消订单: ${order.orderId}`);

    // 模拟取消订单（实际实现需要调用交易所 API）
    await this.simulateCancelOrder(order);

    // 更新订单状态
    order.status = "Cancelled";
    this.orders.set(order.orderId, order);

    // 触发事件
    this.events.onOrderCancelled?.(order);
  }

  /**
   * 模拟取消订单（实际实现需要调用交易所 API）
   */
  private async simulateCancelOrder(order: GridOrder): Promise<void> {
    return new Promise((resolve, reject) => {
      // 模拟取消延迟
      setTimeout(() => {
        // 模拟取消成功
        const success = Math.random() > 0.1; // 90% 成功率

        if (success) {
          resolve();
        } else {
          reject(new Error("取消订单失败（模拟）"));
        }
      }, 100);
    });
  }

  /**
   * 清理整个网格
   */
  async cleanGrid(gridId: string): Promise<number> {
    logger.info(`[GridCleaner] 清理网格: ${gridId}`);

    const gridOrders = Array.from(this.orders.values()).filter(
      (order) => order.gridId === gridId
    );

    let cancelledCount = 0;
    for (const order of gridOrders) {
      if (order.status === "New") {
        try {
          await this.cancelOrder(order);
          cancelledCount++;
        } catch (error: any) {
          logger.error(
            `[GridCleaner] 取消订单失败: ${order.orderId}, 错误: ${error.message}`
          );
          this.events.onError?.(error, order);
        }
      }
    }

    logger.info(
      `[GridCleaner] 网格清理完成: ${gridId}, 取消 ${cancelledCount} 个订单`
    );
    this.events.onGridCleaned?.(gridId, cancelledCount);

    return cancelledCount;
  }

  /**
   * GRID_TIMEOUT 触发器
   */
  async triggerGridTimeout(gridId: string): Promise<void> {
    logger.error(`[GridCleaner] GRID_TIMEOUT 触发: ${gridId}`);

    // 清理整个网格
    const cancelledCount = await this.cleanGrid(gridId);

    logger.info(
      `[GridCleaner] GRID_TIMEOUT 处理完成: ${gridId}, 取消 ${cancelledCount} 个订单`
    );
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalOrders: number;
    newOrders: number;
    filledOrders: number;
    cancelledOrders: number;
    timeoutOrders: number;
  } {
    const orders = Array.from(this.orders.values());
    const now = Date.now();

    return {
      totalOrders: orders.length,
      newOrders: orders.filter((o) => o.status === "New").length,
      filledOrders: orders.filter((o) => o.status === "Filled").length,
      cancelledOrders: orders.filter((o) => o.status === "Cancelled").length,
      timeoutOrders: orders.filter(
        (o) =>
          o.status === "New" && now - o.createdAt > this.config.maxOrderAge
      ).length,
    };
  }
}

// ============ 导出 ============

export default GridCleaner;
