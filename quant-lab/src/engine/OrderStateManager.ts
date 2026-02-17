/**
 * 订单状态管理器 (P0实施 - 异常单检测机制)
 * 
 * 功能：
 * 1. 订单状态跟踪
 * 2. 超时检测（30秒提交/5分钟无成交/10分钟挂单）
 * 3. 异常单告警
 * 4. 状态一致性检查
 */

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
  private orders = new Map<string, OrderState>();
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
    
    console.log(`[OrderStateManager] 异常检测已启动，间隔 ${intervalMs}ms`);
  }

  /**
   * 停止检测
   */
  stopDetection() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
      console.log('[OrderStateManager] 异常检测已停止');
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
    
    console.log(`[OrderStateManager] 订单注册: ${order.orderLinkId} [${order.state}]`);
    return fullOrder;
  }

  /**
   * 更新订单状态
   */
  updateState(orderLinkId: string, newState: OrderStateEnum, updates?: Partial<OrderState>): boolean {
    const order = this.orders.get(orderLinkId);
    if (!order) {
      console.warn(`[OrderStateManager] 订单不存在: ${orderLinkId}`);
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
    
    console.log(`[OrderStateManager] 状态更新: ${orderLinkId} [${oldState} -> ${newState}]`);
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
      console.log(`[OrderStateManager] 检测完成: ${checkedCount} 个订单, ${abnormalCount} 个异常`);
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
    console.error(`[OrderStateManager] [ABNORMAL] 异常单检测: ${order.orderLinkId}`);
    console.error(`  原因: ${reason}`);
    console.error(`  状态: ${oldState} -> ABNORMAL`);
    console.error(`  策略: ${order.strategyId}`);
    console.error(`  产品: ${order.product}`);
    console.error(`  方向: ${order.side}`);
    console.error(`  持续时间: ${(duration / 1000).toFixed(1)}s`);
    if (details) {
      console.error(`  详情:`, details);
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
    console.warn(`[OrderStateManager] [WARNING] 订单超时警告: ${order.orderLinkId}`);
    console.warn(`  原因: ${reason}`);
    console.warn(`  策略: ${order.strategyId}`);
    console.warn(`  已挂单: ${(elapsed / 1000).toFixed(1)}s`);
    console.warn(`  成交: ${order.filledQty}/${order.qty}`);
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
        console.error('[OrderStateManager] 告警回调失败:', error);
      }
    }
    
    // 发送Telegram告警（如果有tg命令）
    this.sendTelegramAlert(alert);
  }

  /**
   * 发送Telegram告警
   */
  private sendTelegramAlert(alert: AbnormalOrderAlert) {
    try {
      const { execSync } = require('child_process');
      
      const message = `[异常单] ${alert.product} ${alert.strategyId}\n` +
                      `订单: ${alert.orderLinkId}\n` +
                      `原因: ${alert.reason}\n` +
                      `原状态: ${alert.oldState}\n` +
                      `持续时间: ${(alert.duration / 1000).toFixed(1)}s`;
      
      const cmd = `/usr/local/bin/tg send! bot-001 9号 "${message.replace(/"/g, '\\"')}"`;
      execSync(cmd, { stdio: 'ignore' });
    } catch (error) {
      // tg命令失败不影响主流程
      console.warn('[OrderStateManager] Telegram告警发送失败');
    }
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
      console.warn(`[OrderStateManager] 状态不一致(观察中): ${orderLinkId}`);
      console.warn(`  策略: ${order.state}, 交易所: ${exchangeStatus}`);
      console.warn(`  等待 ${((threshold - timeSinceUpdate) / 1000).toFixed(0)}s 后检查`);
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
   */
  cleanupCompletedOrders(maxHistory = 100) {
    const terminalStates: OrderStateEnum[] = ['FILLED', 'CANCELLED'];
    const completedOrders = this.getAllOrders()
      .filter(o => terminalStates.includes(o.state))
      .sort((a, b) => b.lastUpdateAt - a.lastUpdateAt);
    
    if (completedOrders.length > maxHistory) {
      const toDelete = completedOrders.slice(maxHistory);
      for (const order of toDelete) {
        this.orders.delete(order.orderLinkId);
      }
      console.log(`[OrderStateManager] 清理完成: 删除 ${toDelete.length} 个历史订单`);
    }
  }
}

// 导出单例
export const globalOrderManager = new OrderStateManager();
