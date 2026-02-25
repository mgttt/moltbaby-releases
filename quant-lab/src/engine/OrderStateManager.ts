/**
 * 订单状态管理器 (P0实施 - 异常单检测机制)
 * 
 * 功能：
 * 1. 订单状态跟踪
 * 2. 超时检测（30秒提交/5分钟无成交/10分钟挂单）
 * 3. 异常单告警
 * 4. 状态一致性检查
 */

import { createLogger } from '../utils/logger';
const logger = createLogger('OrderStateManager');

export type OrderStateEnum = 
  | 'OUTSIDE_MAGNET'   // 磁性外未提交
  | 'SUBMITTING'       // 尝试提交
  | 'SUBMITTED'        // 已提交
  | 'FILLED'           // 已成交
  | 'CANCELLED'        // 已撤单
  | 'SUBMIT_FAILED'    // 提交失败
  | 'ABNORMAL';        // 异常单

export interface OrderState {
  orderLinkId: string;
  orderId?: string;       // 交易所返回的订单ID（如MYXUSDT:xxx）
  state: OrderStateEnum;
  strategyId: string;
  product: string;
  side: 'Buy' | 'Sell';
  price: number;
  qty: number;
  filledQty: number;
  
  // 时间戳
  createdAt: number;      // 创建时间
  submittedAt?: number;   // 提交时间
  lastUpdateAt: number;   // 最后更新时间
  
  // 异常检测标记
  timeoutWarningSent?: boolean;  // 已发送超时警告
  abnormalReason?: string;       // 异常原因
}

export interface AbnormalOrderAlert {
  orderLinkId: string;
  strategyId: string;
  product: string;
  reason: string;
  oldState: OrderStateEnum;
  duration: number;  // 持续时间（毫秒）
}

export class OrderStateManager {
  private orders = new Map<string, OrderState>();  // orderLinkId -> OrderState
  private orderIdToLinkId = new Map<string, string>();  // orderId -> orderLinkId
  private checkInterval?: NodeJS.Timeout;
  private alertCallbacks: ((alert: AbnormalOrderAlert) => void)[] = [];
  
  // 统计指标
  private stats = {
    totalOrders: 0,
    abnormalOrders: 0,
    timeoutWarnings: 0,
  };

  /**
   * 启动异常检测定时器
   */
  startDetection(intervalMs = 30000) {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
    
    this.checkInterval = setInterval(() => {
      this.checkAbnormalOrders();
    }, intervalMs);
    
    logger.info(`[OrderStateManager] 异常检测已启动，间隔 ${intervalMs}ms`);
  }

  /**
   * 停止检测
   */
  stopDetection() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
      logger.info('[OrderStateManager] 异常检测已停止');
    }
  }

  /**
   * 注册订单
   */
  registerOrder(order: Omit<OrderState, 'createdAt' | 'lastUpdateAt'>): OrderState {
    const now = Date.now();
    const fullOrder: OrderState = {
      ...order,
      createdAt: now,
      lastUpdateAt: now,
    };
    
    this.orders.set(order.orderLinkId, fullOrder);
    this.stats.totalOrders++;
    
    logger.info(`[OrderStateManager] 订单注册: ${order.orderLinkId} [${order.state}]`);
    return fullOrder;
  }

  /**
   * 更新订单状态
   */
  updateState(orderLinkId: string, newState: OrderStateEnum, updates?: Partial<OrderState>): boolean {
    const order = this.orders.get(orderLinkId);
    if (!order) {
      logger.warn(`[OrderStateManager] 订单不存在: ${orderLinkId}`);
      return false;
    }
    
    const oldState = order.state;
    order.state = newState;
    order.lastUpdateAt = Date.now();
    
    // 特殊状态更新时间戳
    if (newState === 'SUBMITTED' && !order.submittedAt) {
      order.submittedAt = Date.now();
    }
    
    // 应用其他更新
    if (updates) {
      Object.assign(order, updates);
    }
    
    // 重置警告标记（状态变化时）
    if (oldState !== newState) {
      order.timeoutWarningSent = false;
    }
    
    logger.info(`[OrderStateManager] 状态更新: ${orderLinkId} [${oldState} -> ${newState}]`);
    return true;
  }

  /**
   * P1修复: 通过orderId更新订单状态
   */
  updateStateByOrderId(orderId: string, newState: OrderStateEnum, updates?: Partial<OrderState>): boolean {
    const orderLinkId = this.orderIdToLinkId.get(orderId);
    if (!orderLinkId) {
      logger.warn(`[OrderStateManager] orderId未找到映射: ${orderId}`);
      return false;
    }
    return this.updateState(orderLinkId, newState, updates);
  }

  /**
   * P1修复: 设置orderId并建立映射
   */
  setOrderId(orderLinkId: string, orderId: string): boolean {
    const order = this.orders.get(orderLinkId);
    if (!order) {
      logger.warn(`[OrderStateManager] 订单不存在: ${orderLinkId}`);
      return false;
    }
    
    order.orderId = orderId;
    this.orderIdToLinkId.set(orderId, orderLinkId);
    logger.info(`[OrderStateManager] orderId映射: ${orderId} -> ${orderLinkId}`);
    return true;
  }

  /**
   * 更新成交数量
   */
  updateFill(orderLinkId: string, filledQty: number, execPrice?: number): boolean {
    const order = this.orders.get(orderLinkId);
    if (!order) return false;
    
    order.filledQty = filledQty;
    order.lastUpdateAt = Date.now();
    
    // 检查是否完全成交
    if (order.filledQty >= order.qty && order.state !== 'FILLED') {
      this.updateState(orderLinkId, 'FILLED');
    }
    
    return true;
  }

  /**
   * 获取订单
   */
  getOrder(orderLinkId: string): OrderState | undefined {
    return this.orders.get(orderLinkId);
  }

  /**
   * 获取所有订单
   */
  getAllOrders(): OrderState[] {
    return Array.from(this.orders.values());
  }

  /**
   * 获取活跃订单（非终态）
   */
  getActiveOrders(): OrderState[] {
    const terminalStates: OrderStateEnum[] = ['FILLED', 'CANCELLED', 'ABNORMAL'];
    return this.getAllOrders().filter(o => !terminalStates.includes(o.state));
  }

  /**
   * 获取异常单
   */
  getAbnormalOrders(): OrderState[] {
    return this.getAllOrders().filter(o => o.state === 'ABNORMAL');
  }

  /**
   * 注册告警回调
   */
  onAlert(callback: (alert: AbnormalOrderAlert) => void) {
    this.alertCallbacks.push(callback);
  }

  /**
   * 异常单检测主逻辑
   */
  private checkAbnormalOrders() {
    const now = Date.now();
    let checkedCount = 0;
    let abnormalCount = 0;
    
    for (const order of this.orders.values()) {
      checkedCount++;
      
      switch (order.state) {
        case 'SUBMITTING':
          if (this.checkSubmitTimeout(order, now)) {
            abnormalCount++;
          }
          break;
          
        case 'SUBMITTED':
          if (this.checkSubmittedTimeout(order, now)) {
            abnormalCount++;
          }
          break;
      }
    }
    
    if (abnormalCount > 0) {
      logger.info(`[OrderStateManager] 检测完成: ${checkedCount} 个订单, ${abnormalCount} 个异常`);
    }
  }

  /**
   * 检查提交超时（30秒）
   */
  private checkSubmitTimeout(order: OrderState, now: number): boolean {
    const timeout = 30000; // 30秒
    const elapsed = now - order.createdAt;
    
    if (elapsed > timeout) {
      this.markAbnormal(order, 'SUBMIT_TIMEOUT', {
        duration: elapsed,
        threshold: timeout,
      });
      return true;
    }
    return false;
  }

  /**
   * 检查已提交订单超时（5分钟警告/10分钟异常）
   */
  private checkSubmittedTimeout(order: OrderState, now: number): boolean {
    const submittedAt = order.submittedAt || order.createdAt;
    const elapsed = now - submittedAt;
    
    // 5分钟无成交警告
    const warningThreshold = 5 * 60 * 1000; // 5分钟
    if (elapsed > warningThreshold && !order.timeoutWarningSent && order.filledQty === 0) {
      this.sendTimeoutWarning(order, 'NO_FILL_5MIN', elapsed);
      order.timeoutWarningSent = true;
      this.stats.timeoutWarnings++;
    }
    
    // 10分钟挂单异常
    const abnormalThreshold = 10 * 60 * 1000; // 10分钟
    if (elapsed > abnormalThreshold) {
      this.markAbnormal(order, 'HANGING_10MIN', {
        duration: elapsed,
        filledQty: order.filledQty,
        qty: order.qty,
      });
      return true;
    }
    
    return false;
  }

  /**
   * 标记异常单
   */
  private markAbnormal(
    order: OrderState, 
    reason: string, 
    details?: Record<string, any>
  ) {
    const oldState = order.state;
    order.state = 'ABNORMAL';
    order.abnormalReason = reason;
    order.lastUpdateAt = Date.now();
    this.stats.abnormalOrders++;
    
    const duration = Date.now() - order.createdAt;
    
    // 打印日志
    logger.error(`[OrderStateManager] [ABNORMAL] 异常单检测: ${order.orderLinkId}`);
    logger.error(`  原因: ${reason}`);
    logger.error(`  状态: ${oldState} -> ABNORMAL`);
    logger.error(`  策略: ${order.strategyId}`);
    logger.error(`  产品: ${order.product}`);
    logger.error(`  方向: ${order.side}`);
    logger.error(`  持续时间: ${(duration / 1000).toFixed(1)}s`);
    if (details) {
      logger.error(`  详情:`, details);
    }
    
    // 发送告警
    const alert: AbnormalOrderAlert = {
      orderLinkId: order.orderLinkId,
      strategyId: order.strategyId,
      product: order.product,
      reason,
      oldState,
      duration,
    };
    
    this.sendAlert(alert);
  }

  /**
   * 发送超时警告
   */
  private sendTimeoutWarning(order: OrderState, reason: string, elapsed: number) {
    logger.warn(`[OrderStateManager] [WARNING] 订单超时警告: ${order.orderLinkId}`);
    logger.warn(`  原因: ${reason}`);
    logger.warn(`  策略: ${order.strategyId}`);
    logger.warn(`  已挂单: ${(elapsed / 1000).toFixed(1)}s`);
    logger.warn(`  成交: ${order.filledQty}/${order.qty}`);
  }

  /**
   * 发送告警
   */
  private sendAlert(alert: AbnormalOrderAlert) {
    // 调用注册的回调
    for (const callback of this.alertCallbacks) {
      try {
        callback(alert);
      } catch (error) {
        logger.error('[OrderStateManager] 告警回调失败:', error);
      }
    }
    
    // 发送Telegram告警（如果有tg命令）
    this.sendTelegramAlert(alert);
  }

  /**
   * 发送Telegram告警
   */
  private sendTelegramAlert(alert: AbnormalOrderAlert) {
    // 2026-02-23 总裁指令：严禁策略系统直接调用tg-cli发信息
    // 告警仅记录到日志，不发tg消息
    const message = `[异常单] ${alert.product} ${alert.strategyId} | ` +
                    `订单: ${alert.orderLinkId} | 原因: ${alert.reason} | ` +
                    `原状态: ${alert.oldState} | 持续: ${(alert.duration / 1000).toFixed(1)}s`;
    logger.warn(`[OrderStateManager][仅日志] ${message}`);
  }

  /**
   * 状态一致性检查
   * 对比策略状态和交易所状态
   */
  checkStateConsistency(
    strategyOrder: OrderState,
    exchangeStatus: string
  ): { consistent: boolean; reason?: string } {
    const stateMapping: Record<string, string[]> = {
      'SUBMITTED': ['New', 'PartiallyFilled', 'Created'],
      'FILLED': ['Filled'],
      'CANCELLED': ['Cancelled', 'Canceled'],
    };
    
    const expectedStatuses = stateMapping[strategyOrder.state];
    if (!expectedStatuses) {
      return { consistent: true }; // 未知状态不做检查
    }
    
    if (!expectedStatuses.includes(exchangeStatus)) {
      return {
        consistent: false,
        reason: `状态不一致: 策略=${strategyOrder.state}, 交易所=${exchangeStatus}`,
      };
    }
    
    return { consistent: true };
  }

  /**
   * 处理状态不一致
   */
  handleInconsistency(orderLinkId: string, exchangeStatus: string) {
    const order = this.orders.get(orderLinkId);
    if (!order) return;
    
    // 1分钟延迟后仍不一致则标记异常
    const now = Date.now();
    const timeSinceUpdate = now - order.lastUpdateAt;
    const threshold = 60000; // 1分钟
    
    if (timeSinceUpdate > threshold) {
      this.markAbnormal(order, 'STATE_MISMATCH', {
        strategyState: order.state,
        exchangeStatus,
        timeSinceUpdate,
      });
    } else {
      logger.warn(`[OrderStateManager] 状态不一致(观察中): ${orderLinkId}`);
      logger.warn(`  策略: ${order.state}, 交易所: ${exchangeStatus}`);
      logger.warn(`  等待 ${((threshold - timeSinceUpdate) / 1000).toFixed(0)}s 后检查`);
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.stats,
      activeOrders: this.getActiveOrders().length,
      abnormalOrders: this.getAbnormalOrders().length,
    };
  }

  /**
   * 清理已完成订单（保留最近100条）
   * @returns 删除的订单数量
   */
  cleanupCompletedOrders(maxHistory = 100): number {
    const terminalStates: OrderStateEnum[] = ['FILLED', 'CANCELLED'];
    const completedOrders = this.getAllOrders()
      .filter(o => terminalStates.includes(o.state))
      .sort((a, b) => b.lastUpdateAt - a.lastUpdateAt);
    
    if (completedOrders.length > maxHistory) {
      const toDelete = completedOrders.slice(maxHistory);
      for (const order of toDelete) {
        this.orders.delete(order.orderLinkId);
      }
      logger.info(`[OrderStateManager] 清理完成: 删除 ${toDelete.length} 个历史订单`);
      return toDelete.length;
    }
    return 0;
  }

  /**
   * 重置管理器状态（用于测试）
   */
  reset() {
    this.orders.clear();
    this.orderIdToLinkId.clear();
    this.alertCallbacks = [];
    this.stats = {
      totalOrders: 0,
      abnormalOrders: 0,
      timeoutWarnings: 0,
    };
    this.stopDetection();
    logger.info('[OrderStateManager] 管理器已重置');
  }

  // ============ 异常回滚机制 (P2新增) ============

  /**
   * 异常回滚：订单提交超时
   * 场景：订单在SUBMITTING状态超时，需要回滚到OUTSIDE_MAGNET或标记失败
   */
  rollbackSubmitTimeout(orderLinkId: string): boolean {
    const order = this.orders.get(orderLinkId);
    if (!order) {
      logger.warn(`[OrderStateManager] 回滚失败: 订单不存在 ${orderLinkId}`);
      return false;
    }

    // 只有SUBMITTING或ABNORMAL(SUBMIT_TIMEOUT)状态可以回滚
    if (order.state !== 'SUBMITTING' && !(order.state === 'ABNORMAL' && order.abnormalReason === 'SUBMIT_TIMEOUT')) {
      logger.warn(`[OrderStateManager] 回滚失败: 订单状态不允许回滚 ${orderLinkId} [${order.state}]`);
      return false;
    }

    const oldState = order.state;
    order.state = 'SUBMIT_FAILED';
    order.lastUpdateAt = Date.now();
    
    logger.info(`[OrderStateManager] 回滚完成: ${orderLinkId} [${oldState} -> SUBMIT_FAILED]`);
    return true;
  }

  /**
   * 异常回滚：部分成交后撤单
   * 场景：订单部分成交后需要撤单，处理残余仓位
   */
  rollbackPartialFill(orderLinkId: string, filledQty: number): { success: boolean; remainingQty: number } {
    const order = this.orders.get(orderLinkId);
    if (!order) {
      logger.warn(`[OrderStateManager] 部分成交回滚失败: 订单不存在 ${orderLinkId}`);
      return { success: false, remainingQty: 0 };
    }

    // 更新实际成交数量
    order.filledQty = filledQty;
    const remainingQty = order.qty - filledQty;

    // 如果完全成交，标记为FILLED
    if (remainingQty <= 0) {
      order.state = 'FILLED';
      order.lastUpdateAt = Date.now();
      logger.info(`[OrderStateManager] 部分成交回滚: 订单已完全成交 ${orderLinkId}`);
      return { success: true, remainingQty: 0 };
    }

    // 部分成交，标记为CANCELLED并记录残余
    order.state = 'CANCELLED';
    order.lastUpdateAt = Date.now();
    order.abnormalReason = `PARTIAL_FILL_CANCELLED: 成交${filledQty}/${order.qty}, 残余${remainingQty}`;
    
    logger.info(`[OrderStateManager] 部分成交回滚完成: ${orderLinkId} [成交${filledQty}, 残余${remainingQty}]`);
    return { success: true, remainingQty };
  }

  /**
   * 异常回滚：网络断连恢复
   * 场景：网络断连后恢复，需要同步订单状态
   */
  async rollbackNetworkDisconnect(
    orderLinkId: string,
    queryExchangeStatus: () => Promise<{ status: string; filledQty: number } | null>
  ): Promise<{ success: boolean; action: 'synced' | 'cancelled' | 'failed'; message: string }> {
    const order = this.orders.get(orderLinkId);
    if (!order) {
      return { success: false, action: 'failed', message: '订单不存在' };
    }

    try {
      // 查询交易所实际状态
      const exchangeState = await queryExchangeStatus();
      
      if (!exchangeState) {
        // 交易所无此订单，可能从未提交成功
        if (order.state === 'SUBMITTING') {
          order.state = 'SUBMIT_FAILED';
          order.abnormalReason = 'NETWORK_DISCONNECT: 提交失败，交易所无记录';
          order.lastUpdateAt = Date.now();
          return { 
            success: true, 
            action: 'synced', 
            message: '交易所无记录，标记为提交失败' 
          };
        }
        return { 
          success: false, 
          action: 'failed', 
          message: '交易所无记录且订单状态异常' 
        };
      }

      // 同步成交数量
      if (exchangeState.filledQty > order.filledQty) {
        order.filledQty = exchangeState.filledQty;
      }

      // 根据交易所状态更新本地状态
      switch (exchangeState.status) {
        case 'Filled':
          order.state = 'FILLED';
          order.lastUpdateAt = Date.now();
          return { 
            success: true, 
            action: 'synced', 
            message: '订单已完全成交' 
          };

        case 'Cancelled':
        case 'Canceled':
          order.state = 'CANCELLED';
          order.lastUpdateAt = Date.now();
          return { 
            success: true, 
            action: 'cancelled', 
            message: '订单已撤单' 
          };

        case 'PartiallyFilled':
          // 部分成交，尝试撤单残余
          order.state = 'SUBMITTED';
          order.lastUpdateAt = Date.now();
          return { 
            success: true, 
            action: 'synced', 
            message: `订单部分成交 ${order.filledQty}/${order.qty}` 
          };

        case 'New':
          // 订单仍在挂单中
          order.state = 'SUBMITTED';
          order.lastUpdateAt = Date.now();
          return { 
            success: true, 
            action: 'synced', 
            message: '订单仍在挂单中' 
          };

        default:
          return { 
            success: false, 
            action: 'failed', 
            message: `未知交易所状态: ${exchangeState.status}` 
          };
      }
    } catch (error: any) {
      logger.error(`[OrderStateManager] 网络断连回滚失败: ${orderLinkId}`, error);
      return { 
        success: false, 
        action: 'failed', 
        message: `查询失败: ${error.message}` 
      };
    }
  }

  /**
   * 获取需要回滚的订单列表
   */
  getOrdersNeedingRollback(): OrderState[] {
    return this.getAllOrders().filter(order => {
      // SUBMITTING状态超过30秒
      if (order.state === 'SUBMITTING') {
        const elapsed = Date.now() - order.createdAt;
        if (elapsed > 30000) return true;
      }
      
      // ABNORMAL状态
      if (order.state === 'ABNORMAL') return true;
      
      return false;
    });
  }

  /**
   * 批量执行回滚
   */
  async batchRollback(
    handlers: {
      onSubmitTimeout?: (order: OrderState) => Promise<boolean>;
      onPartialFill?: (order: OrderState) => Promise<{ filledQty: number }>;
      onNetworkDisconnect?: (order: OrderState) => Promise<{ status: string; filledQty: number } | null>;
    }
  ): Promise<{
    total: number;
    success: number;
    failed: number;
    details: Array<{ orderLinkId: string; action: string; message: string }>;
  }> {
    const orders = this.getOrdersNeedingRollback();
    const result = {
      total: orders.length,
      success: 0,
      failed: 0,
      details: [] as Array<{ orderLinkId: string; action: string; message: string }>,
    };

    for (const order of orders) {
      try {
        let success = false;
        let message = '';

        if (order.state === 'SUBMITTING' || order.abnormalReason === 'SUBMIT_TIMEOUT') {
          // 提交超时回滚
          success = this.rollbackSubmitTimeout(order.orderLinkId);
          message = success ? '提交超时回滚成功' : '提交超时回滚失败';
        } else if (order.abnormalReason?.includes('PARTIAL_FILL')) {
          // 部分成交回滚
          if (handlers.onPartialFill) {
            const fillInfo = await handlers.onPartialFill(order);
            const rollbackResult = this.rollbackPartialFill(order.orderLinkId, fillInfo.filledQty);
            success = rollbackResult.success;
            message = `部分成交回滚: 残余${rollbackResult.remainingQty}`;
          }
        } else if (order.abnormalReason?.includes('NETWORK')) {
          // 网络断连回滚
          if (handlers.onNetworkDisconnect) {
            const rollbackResult = await this.rollbackNetworkDisconnect(
              order.orderLinkId,
              () => handlers.onNetworkDisconnect!(order)
            );
            success = rollbackResult.success;
            message = rollbackResult.message;
          }
        }

        if (success) {
          result.success++;
        } else {
          result.failed++;
        }
        
        result.details.push({
          orderLinkId: order.orderLinkId,
          action: success ? 'SUCCESS' : 'FAILED',
          message,
        });
      } catch (error: any) {
        result.failed++;
        result.details.push({
          orderLinkId: order.orderLinkId,
          action: 'ERROR',
          message: error.message,
        });
      }
    }

    return result;
  }
}

// 导出单例
export const globalOrderManager = new OrderStateManager();
