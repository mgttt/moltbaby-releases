/**
 * Mock Exchange Adapter - 交易所适配器Mock
 * 
 * 功能：
 * 1. 模拟交易所API行为（正常/异常/超时三种模式）
 * 2. 支持订单状态查询、提交、撤单操作
 * 3. 模拟网络异常、超时、部分成交等场景
 * 4. 用于OrderStateManager单元测试
 * 
 * 位置：quant-lab/src/engine/__mocks__/mock-exchange-adapter.ts
 */

export type MockMode = 'normal' | 'error' | 'timeout' | 'partial_fill' | 'network_disconnect';

export interface MockOrder {
  orderId: string;
  orderLinkId: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  type: 'Market' | 'Limit';
  qty: number;
  price?: number;
  filledQty: number;
  status: 'New' | 'PartiallyFilled' | 'Filled' | 'Cancelled' | 'Rejected';
  createdAt: number;
  updatedAt: number;
}

export interface MockExchangeConfig {
  mode: MockMode;
  latencyMs?: number;           // 模拟网络延迟
  errorRate?: number;           // 错误率 (0-1)
  timeoutMs?: number;           // 超时阈值
  partialFillRate?: number;     // 部分成交率
  disconnectDurationMs?: number; // 断连持续时间
}

export class MockExchangeAdapter {
  private orders = new Map<string, MockOrder>();      // orderId -> MockOrder
  private linkIdToOrderId = new Map<string, string>(); // orderLinkId -> orderId
  private config: MockExchangeConfig;
  private isConnected = true;
  private disconnectTimer?: NodeJS.Timeout;
  private requestLog: Array<{ method: string; timestamp: number; success: boolean; error?: string }> = [];

  constructor(config: MockExchangeConfig = { mode: 'normal' }) {
    this.config = {
      latencyMs: 10,
      errorRate: 0,
      timeoutMs: 5000,
      partialFillRate: 0.3,
      disconnectDurationMs: 30000,
      ...config,
    };
  }

  /**
   * 设置Mock模式
   */
  setMode(mode: MockMode, options?: Partial<MockExchangeConfig>): void {
    this.config = { ...this.config, mode, ...options };
    
    // 网络断连模式特殊处理
    if (mode === 'network_disconnect') {
      this.simulateNetworkDisconnect();
    }
  }

  /**
   * 模拟网络断连
   */
  private simulateNetworkDisconnect(): void {
    this.isConnected = false;
    
    // 清除之前的定时器
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
    }
    
    // 自动恢复连接
    this.disconnectTimer = setTimeout(() => {
      this.isConnected = true;
    }, this.config.disconnectDurationMs);
  }

  /**
   * 恢复网络连接（用于测试手动恢复）
   */
  reconnect(): void {
    this.isConnected = true;
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = undefined;
    }
  }

  /**
   * 模拟网络延迟
   */
  private async simulateLatency(): Promise<void> {
    if (this.config.latencyMs && this.config.latencyMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.config.latencyMs));
    }
  }

  /**
   * 检查是否应该超时
   */
  private shouldTimeout(): boolean {
    return this.config.mode === 'timeout' || Math.random() < (this.config.errorRate || 0);
  }

  /**
   * 检查是否应该报错
   */
  private shouldError(): boolean {
    return this.config.mode === 'error' && Math.random() < 0.5;
  }

  /**
   * 检查网络是否连接
   */
  private checkConnection(): void {
    if (!this.isConnected) {
      const error = new Error('NETWORK_ERROR: Connection reset by peer');
      (error as any).code = 'ECONNRESET';
      throw error;
    }
  }

  /**
   * 提交订单（模拟）
   */
  async submitOrder(params: {
    orderLinkId: string;
    symbol: string;
    side: 'Buy' | 'Sell';
    type: 'Market' | 'Limit';
    qty: number;
    price?: number;
  }): Promise<MockOrder> {
    const startTime = Date.now();
    
    try {
      // 模拟延迟
      await this.simulateLatency();
      
      // 检查网络连接
      this.checkConnection();
      
      // 模拟超时
      if (this.shouldTimeout()) {
        const timeoutError = new Error('REQUEST_TIMEOUT: Order submission timeout');
        (timeoutError as any).code = 'ETIMEDOUT';
        throw timeoutError;
      }
      
      // 模拟错误
      if (this.shouldError()) {
        const error = new Error('ORDER_REJECTED: Insufficient balance');
        (error as any).code = '110001';
        throw error;
      }

      const orderId = `mock-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      // 部分成交模式：直接创建部分成交订单
      const filledQty = this.config.mode === 'partial_fill' 
        ? Math.floor(params.qty * (this.config.partialFillRate || 0.3) * 100) / 100
        : 0;
      
      const status: MockOrder['status'] = filledQty > 0 ? 'PartiallyFilled' : 'New';
      
      const order: MockOrder = {
        orderId,
        orderLinkId: params.orderLinkId,
        symbol: params.symbol,
        side: params.side,
        type: params.type,
        qty: params.qty,
        price: params.price,
        filledQty,
        status,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      this.orders.set(orderId, order);
      this.linkIdToOrderId.set(params.orderLinkId, orderId);
      
      this.logRequest('submitOrder', true);
      
      return order;
    } catch (error: any) {
      this.logRequest('submitOrder', false, error.message);
      throw error;
    }
  }

  /**
   * 查询订单状态（模拟）
   */
  async getOrderStatus(orderLinkId: string): Promise<MockOrder | null> {
    const startTime = Date.now();
    
    try {
      await this.simulateLatency();
      this.checkConnection();
      
      if (this.shouldTimeout()) {
        const timeoutError = new Error('REQUEST_TIMEOUT: Query timeout');
        (timeoutError as any).code = 'ETIMEDOUT';
        throw timeoutError;
      }

      const orderId = this.linkIdToOrderId.get(orderLinkId);
      if (!orderId) {
        return null;
      }

      const order = this.orders.get(orderId);
      this.logRequest('getOrderStatus', !!order);
      
      return order || null;
    } catch (error: any) {
      this.logRequest('getOrderStatus', false, error.message);
      throw error;
    }
  }

  /**
   * 撤单（模拟）
   */
  async cancelOrder(orderLinkId: string): Promise<boolean> {
    const startTime = Date.now();
    
    try {
      await this.simulateLatency();
      this.checkConnection();
      
      if (this.shouldTimeout()) {
        const timeoutError = new Error('REQUEST_TIMEOUT: Cancel timeout');
        (timeoutError as any).code = 'ETIMEDOUT';
        throw timeoutError;
      }
      
      // 模拟撤单失败（部分成交订单可能无法撤单）
      const orderId = this.linkIdToOrderId.get(orderLinkId);
      if (orderId) {
        const order = this.orders.get(orderId);
        if (order && order.status === 'PartiallyFilled' && this.config.mode === 'error') {
          const error = new Error('ORDER_NOT_CANCELABLE: Order already partially filled');
          (error as any).code = '110025';
          throw error;
        }
      }

      const orderIdFromMap = this.linkIdToOrderId.get(orderLinkId);
      if (orderIdFromMap) {
        const order = this.orders.get(orderIdFromMap);
        if (order) {
          order.status = 'Cancelled';
          order.updatedAt = Date.now();
        }
      }

      this.logRequest('cancelOrder', true);
      return true;
    } catch (error: any) {
      this.logRequest('cancelOrder', false, error.message);
      throw error;
    }
  }

  /**
   * 获取所有订单
   */
  getAllOrders(): MockOrder[] {
    return Array.from(this.orders.values());
  }

  /**
   * 模拟订单成交（用于测试）
   */
  simulateFill(orderLinkId: string, filledQty?: number): boolean {
    const orderId = this.linkIdToOrderId.get(orderLinkId);
    if (!orderId) return false;

    const order = this.orders.get(orderId);
    if (!order) return false;

    const targetFill = filledQty !== undefined ? filledQty : order.qty;
    order.filledQty = Math.min(targetFill, order.qty);
    
    if (order.filledQty >= order.qty) {
      order.status = 'Filled';
    } else {
      order.status = 'PartiallyFilled';
    }
    order.updatedAt = Date.now();
    
    return true;
  }

  /**
   * 模拟订单状态变更（用于测试）
   */
  simulateStatusChange(orderLinkId: string, status: MockOrder['status']): boolean {
    const orderId = this.linkIdToOrderId.get(orderLinkId);
    if (!orderId) return false;

    const order = this.orders.get(orderId);
    if (!order) return false;

    order.status = status;
    order.updatedAt = Date.now();
    return true;
  }

  /**
   * 获取请求日志
   */
  getRequestLog(): Array<{ method: string; timestamp: number; success: boolean; error?: string }> {
    return [...this.requestLog];
  }

  /**
   * 清空请求日志
   */
  clearRequestLog(): void {
    this.requestLog = [];
  }

  /**
   * 重置所有状态
   */
  reset(): void {
    this.orders.clear();
    this.linkIdToOrderId.clear();
    this.requestLog = [];
    this.isConnected = true;
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = undefined;
    }
  }

  /**
   * 记录请求日志
   */
  private logRequest(method: string, success: boolean, error?: string): void {
    this.requestLog.push({
      method,
      timestamp: Date.now(),
      success,
      error,
    });
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalOrders: number;
    byStatus: Record<string, number>;
    totalRequests: number;
    successRate: number;
    isConnected: boolean;
  } {
    const byStatus: Record<string, number> = {};
    for (const order of this.orders.values()) {
      byStatus[order.status] = (byStatus[order.status] || 0) + 1;
    }

    const totalRequests = this.requestLog.length;
    const successfulRequests = this.requestLog.filter(r => r.success).length;
    
    return {
      totalOrders: this.orders.size,
      byStatus,
      totalRequests,
      successRate: totalRequests > 0 ? successfulRequests / totalRequests : 1,
      isConnected: this.isConnected,
    };
  }
}

// 导出单例用于快速测试
export const mockExchange = new MockExchangeAdapter();
