/**
 * CANCEL_RACE 修复 - P1
 * 
 * 功能：
 * 1. 撤单幂等保护（Set 记录已撤订单）
 * 2. 110001 错误处理（order not exists）
 * 3. 状态机同步（本地 vs 交易所）
 * 
 * 位置：quant-lab/src/execution/cancel-race-handler.ts
 * 时间：4h
 */

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

  constructor() {
    console.log("[CancelRaceHandler] 初始化撤单竞态处理器");
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

    console.log(`[CancelRaceHandler] 尝试撤销订单: ${orderId}, orderLinkId: ${orderLinkId}`);

    // 1. 幂等检查：是否已撤销
    if (this.cancelledOrders.has(orderLinkId)) {
      console.warn(`[CancelRaceHandler] 重复撤单（幂等保护）: ${orderLinkId}`);
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
        console.warn(
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

      console.log(`[CancelRaceHandler] 撤单成功: ${orderId}`);

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
   * 执行撤单（模拟，实际需要调用交易所 API）
   */
  private async executeCancel(orderId: string, symbol: string): Promise<void> {
    console.log(`[CancelRaceHandler] 执行撤单: ${orderId}, symbol: ${symbol}`);

    // 模拟撤单
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        // 模拟 110001 错误（order not exists）
        const shouldFail = Math.random() < 0.1; // 10% 失败率

        if (shouldFail) {
          reject(new Error("110001: Order does not exist"));
        } else {
          resolve();
        }
      }, 100);
    });
  }

  /**
   * 错误处理
   */
  private handleError(
    error: Error,
    orderId: string,
    orderLinkId: string
  ): CancelResult {
    const errorMessage = error.message || "";
    console.error(`[CancelRaceHandler] 撤单失败: ${orderId}, 错误: ${errorMessage}`);

    // 110001 错误处理：订单不存在
    if (errorMessage.includes("110001") || errorMessage.includes("Order does not exist")) {
      console.warn(`[CancelRaceHandler] 订单不存在（110001）: ${orderId}`);
      this.events.onOrderNotExists?.(orderId);

      // 标记为已撤销（订单已不存在）
      this.cancelledOrders.add(orderLinkId);
      this.updateLocalStatus(orderId, "Cancelled");

      return {
        success: true,
        orderId,
        orderNotExists: true,
        errorCode: "110001",
      };
    }

    // 其他错误
    this.events.onError?.(error, orderId);

    return {
      success: false,
      orderId,
      error: errorMessage,
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
      console.log(`[CancelRaceHandler] 更新本地状态: ${orderId} -> ${status}`);
    }
  }

  /**
   * 同步交易所状态
   */
  async syncExchangeStatus(orderId: string): Promise<OrderStatus> {
    console.log(`[CancelRaceHandler] 同步交易所状态: ${orderId}`);

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
    console.log(`[CancelRaceHandler] 添加订单状态: ${orderId}`);
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
      console.log("[CancelRaceHandler] 清理已撤销订单（超过 1000 个）");
      this.cancelledOrders.clear();
      cleanedCount = 1000;
    }

    return cleanedCount;
  }
}

// ============ 导出 ============

export default CancelRaceHandler;
