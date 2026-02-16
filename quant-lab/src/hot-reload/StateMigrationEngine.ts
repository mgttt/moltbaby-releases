/**
 * 状态迁移引擎
 * 
 * 职责：
 * - 保留runId/orderLinkId
 * - 订单状态追踪
 * - 持仓状态保持
 * - 缓存同步
 * 
 * 鲶鱼要求：
 * - 对账/幂等（runId/orderLinkId一致性）
 */

import type { StrategyContext } from '../types/strategy';
import type { Account, Position, Order } from '../types/market';

// ================================
// 类型定义
// ================================

export interface SerializedState {
  // 核心状态（必须保留）
  runId: number;              // ✅ 不变
  orderSeq: number;           // ✅ 不变
  positionNotional: number;   // ✅ 保留
  exchangePosition: number;   // ✅ 保留
  
  // 订单状态
  pendingOrders: PendingOrder[];
  openOrders: Order[];
  
  // 策略状态
  strategyState: Record<string, any>;
  
  // 缓存
  cachedAccount?: Account;
  cachedPositions: Position[];
  
  // 元数据
  snapshotTime: number;
  snapshotHash: string;       // 用于验证完整性
}

export interface PendingOrder {
  symbol: string;
  side: 'Buy' | 'Sell';
  qty: number;
  price?: number;
  orderLinkId?: string;
  gridId?: string;
  reduceOnly?: boolean;
}

export interface ReconcileResult {
  passed: boolean;
  diff?: any;
  message?: string;
}

// ================================
// StateMigrationEngine
// ================================

export class StateMigrationEngine {
  /**
   * 序列化状态
   */
  async serialize(context: StrategyContext): Promise<SerializedState> {
    // TODO: 从实际context提取状态
    const state: SerializedState = {
      runId: 0, // TODO: 从策略状态读取
      orderSeq: 0, // TODO: 从策略状态读取
      positionNotional: 0, // TODO: 从策略状态读取
      exchangePosition: 0, // TODO: 从缓存读取
      
      pendingOrders: [], // TODO: 从策略读取
      openOrders: [], // TODO: 从exchange拉取
      
      strategyState: {}, // TODO: 从策略读取
      
      cachedAccount: undefined, // TODO: 从缓存读取
      cachedPositions: [], // TODO: 从缓存读取
      
      snapshotTime: Date.now(),
      snapshotHash: '', // TODO: 计算hash
    };

    // 计算hash（用于验证完整性）
    state.snapshotHash = this.hashState(state);

    return state;
  }

  /**
   * 反序列化状态
   */
  async deserialize(state: SerializedState, newContext: StrategyContext): Promise<void> {
    // TODO: 恢复状态到newContext
    
    // 验证hash
    const expectedHash = this.hashState(state);
    if (state.snapshotHash !== expectedHash) {
      throw new Error('状态hash不匹配，可能已损坏');
    }

    console.log(`[StateMigration] 恢复状态:`);
    console.log(`  runId: ${state.runId} ✅（保留）`);
    console.log(`  orderSeq: ${state.orderSeq} ✅（保留）`);
    console.log(`  positionNotional: ${state.positionNotional} ✅（保留）`);
    console.log(`  exchangePosition: ${state.exchangePosition} ✅（保留）`);
    console.log(`  pendingOrders: ${state.pendingOrders.length}`);
    console.log(`  openOrders: ${state.openOrders.length}`);
    console.log(`  cachedPositions: ${state.cachedPositions.length}`);
  }

  /**
   * 订单对账
   */
  async reconcileOrders(oldOrders: Order[], newOrders: Order[]): Promise<ReconcileResult> {
    // 对账逻辑：检查订单一致性
    const oldOrderIds = new Set(oldOrders.map(o => o.id));
    const newOrderIds = new Set(newOrders.map(o => o.id));

    const missing = oldOrders.filter(o => !newOrderIds.has(o.id));
    const extra = newOrders.filter(o => !oldOrderIds.has(o.id));

    if (missing.length > 0 || extra.length > 0) {
      return {
        passed: false,
        diff: { missing, extra },
        message: `订单对账失败: missing=${missing.length}, extra=${extra.length}`,
      };
    }

    return {
      passed: true,
      message: '订单对账通过',
    };
  }

  /**
   * 持仓对账
   */
  async reconcilePosition(oldPosition: number, newPosition: number): Promise<ReconcileResult> {
    // 对账逻辑：检查持仓一致性
    const diff = Math.abs(newPosition - oldPosition);
    const threshold = 10; // 允许10 USDT误差

    if (diff > threshold) {
      return {
        passed: false,
        diff: { oldPosition, newPosition, diff },
        message: `持仓对账失败: diff=${diff.toFixed(2)} USDT > ${threshold} USDT`,
      };
    }

    return {
      passed: true,
      message: `持仓对账通过: diff=${diff.toFixed(2)} USDT`,
    };
  }

  /**
   * 计算状态hash（用于验证完整性）
   */
  private hashState(state: any): string {
    // 简单hash实现（可以改用crypto.createHash）
    const str = JSON.stringify(state, null, 0);
    let hash = 0;
    
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    
    return hash.toString(16);
  }

  /**
   * 验证runId一致性（幂等性保证）
   */
  validateRunId(oldRunId: number, newRunId: number): boolean {
    if (oldRunId !== newRunId) {
      console.error(`[StateMigration] runId不一致: ${oldRunId} → ${newRunId}`);
      return false;
    }
    
    console.log(`[StateMigration] runId一致: ${oldRunId} ✅`);
    return true;
  }

  /**
   * 验证orderSeq连续性（幂等性保证）
   */
  validateOrderSeq(oldSeq: number, newSeq: number): boolean {
    if (newSeq < oldSeq) {
      console.error(`[StateMigration] orderSeq倒退: ${oldSeq} → ${newSeq}`);
      return false;
    }
    
    console.log(`[StateMigration] orderSeq正常: ${oldSeq} → ${newSeq} ✅`);
    return true;
  }
}
