/**
 * 遗留订单追踪器 (P1 - 自动消警)
 * 
 * 功能：
 * 1. 追踪旧 runId 的遗留订单
 * 2. 检测 openOrders 跳变（订单消失）
 * 3. 达到 N 次确认后自动消警（输出 RESOLVED 事件）
 * 4. 2h 窗口去重，防止刷屏
 */

import { execFileSync } from 'child_process';

export interface LegacyOrderInfo {
  orderLinkId: string;
  firstSeenAt: number;      // 首次发现时间
  lastSeenAt: number;       // 最后一次看到的时间
  missingCount: number;     // 连续缺失次数
  state: 'ACTIVE' | 'RESOLVED';
  resolveReason?: 'NOT_FOUND' | 'CANCELLED' | 'FILLED' | 'REPLACED';
  isReduceOnly?: boolean;   // reduceOnly 订单走不同通道
}

export interface LegacyOrderAlert {
  type: 'LEGACY_ALERT' | 'LEGACY_RESOLVED' | 'LONG_LIVED_INFO';
  orderLinkId: string;
  message: string;
  timestamp: number;
  details?: {
    missingCount?: number;
    firstSeenAt?: number;
    lastSeenAt?: number;
    resolveReason?: string;
  };
}

export class LegacyOrderTracker {
  // 配置
  private currentRunId: string;
  private strategyId: string; // P1修复：按策略隔离
  private dedupWindowMs = 2 * 60 * 60 * 1000; // 2小时
  private resolveThreshold = 3; // 连续 3 次检测不到则消警
  
  // 状态
  private legacyOrders = new Map<string, LegacyOrderInfo>(); // orderLinkId -> info
  private lastAlertTime = new Map<string, number>(); // orderLinkId -> 上次告警时间
  
  // 通知目标
  private tgTarget = 'bot-000';
  
  constructor(currentRunId: string, strategyId: string, config?: { dedupWindowMs?: number; resolveThreshold?: number; tgTarget?: string }) {
    this.currentRunId = currentRunId;
    this.strategyId = strategyId;
    console.log(`[LegacyOrderTracker] 初始化: strategyId=${strategyId}, runId=${currentRunId}`);
    if (config) {
      if (config.dedupWindowMs) this.dedupWindowMs = config.dedupWindowMs;
      if (config.resolveThreshold) this.resolveThreshold = config.resolveThreshold;
      if (config.tgTarget) this.tgTarget = config.tgTarget;
    }
  }
  
  /**
   * 判断是否为遗留订单（先检查direction，再检查runId）
   * P1修复：orderLinkId格式 gales-{direction}-{runId}-{seq}-{side}
   * strategyId可能是 'gales-MYXUSDT-neutral' 或 'neutral'，需要兼容处理
   */
  isLegacyOrder(orderLinkId: string): boolean {
    // 新格式: gales-{direction}-{runId}-{seq}-{side}
    const parts = orderLinkId.split('-');
    if (parts.length < 3) return false; // 不符合格式则忽略
    
    // 先检查direction是否匹配
    const orderDirection = parts[1]; // neutral/short
    
    // 从 strategyId 提取 direction (可能是 'gales-MYXUSDT-neutral' -> 'neutral')
    let strategyDirection = this.strategyId;
    if (strategyDirection.includes('-')) {
      strategyDirection = strategyDirection.split('-').pop() || strategyDirection;
    }
    
    if (orderDirection !== strategyDirection) {
      // direction不同，说明是其他策略的订单，直接忽略（不是本策略的遗留单）
      return false;
    }
    
    // P1紧急修复：direction匹配后，再检查runId是否为本策略当前runId
    const orderRunId = parts[2];
    const isCurrentRunId = orderRunId === this.currentRunId;
    
    // P1调试日志
    console.log(`[LegacyOrderTracker] 订单检查: orderLinkId=${orderLinkId}, direction=${orderDirection}==${strategyDirection}, orderRunId=${orderRunId} vs currentRunId=${this.currentRunId}, isLegacy=${!isCurrentRunId}`);
    
    return !isCurrentRunId; // 只有runId不同才算遗留
  }
  
  /**
   * 从 orderLinkId 提取 runId（新格式: gales-{direction}-{runId}-{seq}-{side}）
   */
  extractRunId(orderLinkId: string): string | null {
    const parts = orderLinkId.split('-');
    if (parts.length < 3) return null;
    return parts[2];
  }
  
  /**
   * 从 orderLinkId 提取 direction
   */
  extractDirection(orderLinkId: string): string | null {
    const parts = orderLinkId.split('-');
    if (parts.length < 2) return null;
    return parts[1];
  }
  
  /**
   * 检查并更新遗留订单状态
   * @param exchangeOrders 当前交易所订单列表
   * @returns 需要发送的告警列表
   */
  check(exchangeOrders: { orderLinkId: string; reduceOnly?: boolean }[]): LegacyOrderAlert[] {
    const alerts: LegacyOrderInfo[] = [];
    const now = Date.now();
    
    // 构建当前订单 Map
    const currentOrderIds = new Set(exchangeOrders.map(o => o.orderLinkId));
    
    // 1. 处理已有的遗留订单
    for (const [orderLinkId, info] of Array.from(this.legacyOrders.entries())) {
      if (info.state === 'RESOLVED') continue;
      
      const isStillPresent = currentOrderIds.has(orderLinkId);
      
      if (isStillPresent) {
        // 订单仍然存在，更新 lastSeenAt，重置 missingCount
        info.lastSeenAt = now;
        info.missingCount = 0;
      } else {
        // 订单消失，增加 missingCount
        info.missingCount++;
        console.log(`[LegacyOrderTracker] 订单消失检测: ${orderLinkId}, missingCount=${info.missingCount}/${this.resolveThreshold}`);
        
        // 检查是否达到消警阈值
        if (info.missingCount >= this.resolveThreshold) {
          info.state = 'RESOLVED';
          info.resolveReason = 'NOT_FOUND';
          // P3改进：RESOLVED时立即输出明确日志，便于线上grep验收
          console.log(`[LegacyOrder][RESOLVED] orderLinkId=${info.orderLinkId} confirm=${info.missingCount} reason=${info.resolveReason} lastSeenAt=${new Date(info.lastSeenAt).toISOString()}`);
          alerts.push(info);
        }
      }
    }
    
    // 2. 检测新的遗留订单
    for (const order of exchangeOrders) {
      if (this.isLegacyOrder(order.orderLinkId)) {
        if (!this.legacyOrders.has(order.orderLinkId)) {
          // 新发现的遗留订单
          // 新发现的遗留订单
          const info: LegacyOrderInfo = {
            orderLinkId: order.orderLinkId,
            firstSeenAt: now,
            lastSeenAt: now,
            missingCount: 0,
            state: 'ACTIVE',
            isReduceOnly: order.reduceOnly,
          };
          this.legacyOrders.set(order.orderLinkId, info);
          console.log(`[LegacyOrderTracker] 发现新遗留订单: ${order.orderLinkId}, reduceOnly=${order.reduceOnly}`);
        }
      }
    }
    
    // 3. 生成告警
    const result: LegacyOrderAlert[] = [];
    for (const info of alerts) {
      // 检查去重窗口
      const lastAlert = this.lastAlertTime.get(info.orderLinkId) || 0;
      if (now - lastAlert < this.dedupWindowMs) {
        console.log(`[LegacyOrderTracker] 跳过告警（去重窗口）: ${info.orderLinkId}`);
        continue;
      }
      
      this.lastAlertTime.set(info.orderLinkId, now);
      
      const alert: LegacyOrderAlert = {
        type: 'LEGACY_RESOLVED',
        orderLinkId: info.orderLinkId,
        message: `[LegacyOrder][RESOLVED] ${info.orderLinkId} | lastSeenAt=${new Date(info.lastSeenAt).toISOString()} | confirmCount=${info.missingCount}`,
        timestamp: now,
        details: {
          missingCount: info.missingCount,
          firstSeenAt: info.firstSeenAt,
          lastSeenAt: info.lastSeenAt,
          resolveReason: info.resolveReason,
        },
      };
      result.push(alert);
    }
    
    // 4. 对 ACTIVE 遗留订单检查是否需要发送告警（首次发现时）
    for (const [orderLinkId, info] of Array.from(this.legacyOrders.entries())) {
      if (info.state !== 'ACTIVE') continue;
      
      // 检查去重
      const lastAlert = this.lastAlertTime.get(orderLinkId) || 0;
      if (now - lastAlert < this.dedupWindowMs) continue;
      
      // 分类：reduceOnly 走低频 Info 通道，其他走告警通道
      const alertType = info.isReduceOnly ? 'LONG_LIVED_INFO' : 'LEGACY_ALERT';
      
      // 首次告警
      if (!this.lastAlertTime.has(orderLinkId)) {
        this.lastAlertTime.set(orderLinkId, now);
        
        const alert: LegacyOrderAlert = {
          type: alertType,
          orderLinkId: orderLinkId,
          message: info.isReduceOnly 
            ? `[LongLived][Info] ${orderLinkId} | reduceOnly=true | firstSeenAt=${new Date(info.firstSeenAt).toISOString()}`
            : `[LegacyOrder][Alert] ${orderLinkId} | firstSeenAt=${new Date(info.firstSeenAt).toISOString()}`,
          timestamp: now,
          details: {
            firstSeenAt: info.firstSeenAt,
            lastSeenAt: info.lastSeenAt,
          },
        };
        result.push(alert);
      }
    }
    
    return result;
  }
  
  /**
   * 发送 Telegram 告警
   */
  async sendAlert(alert: LegacyOrderAlert): Promise<void> {
    const target = alert.type === 'LONG_LIVED_INFO' ? 'bot-008' : this.tgTarget;
    
    try {
      execFileSync('tg', ['send!', 'bot-001', target, alert.message], {
        encoding: 'utf-8',
        stdio: 'ignore',
      });
      console.log(`[LegacyOrderTracker] 已发送告警: ${alert.type} -> ${target}`);
    } catch (error: any) {
      console.error(`[LegacyOrderTracker] Telegram告警发送失败:`, error.message);
    }
  }
  
  /**
   * 获取当前遗留订单状态（用于调试/日志）
   */
  getStatus(): { active: LegacyOrderInfo[]; resolved: LegacyOrderInfo[] } {
    const active: LegacyOrderInfo[] = [];
    const resolved: LegacyOrderInfo[] = [];
    
    for (const info of Array.from(this.legacyOrders.values())) {
      if (info.state === 'ACTIVE') {
        active.push(info);
      } else {
        resolved.push(info);
      }
    }
    
    return { active, resolved };
  }
  
  /**
   * 更新当前 runId（热更新时调用）
   */
  updateRunId(newRunId: string): void {
    const oldRunId = this.currentRunId;
    this.currentRunId = newRunId;
    console.log(`[LegacyOrderTracker] runId 更新: ${oldRunId} -> ${newRunId}`);
  }
}
