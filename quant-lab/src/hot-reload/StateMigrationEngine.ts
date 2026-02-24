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

import { createLogger } from '../utils/logger';
import { env } from '../config/env';
const logger = createLogger('StateMigrationEngine');

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
  strategyId?: string;        // 策略标识
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
   * 
   * 从StrategyContext提取完整状态用于热重载。
   * 支持两种模式：
   * 1. QuickJSStrategy实例（有getRunId等API）- 直接读取
   * 2. 普通StrategyContext - 通过state文件回退读取
   * 
   * @param context 策略上下文或QuickJSStrategy实例
   * @param strategyId 策略ID（用于state文件回退）
   * @param provider 数据提供者（用于拉取openOrders，可选）
   */
  async serialize(
    context: StrategyContext,
    strategyId?: string,
    provider?: { getOpenOrders: () => Promise<Order[]> }
  ): Promise<SerializedState> {
    
    // 检查是否是QuickJSStrategy（通过检测新API存在性）
    const isQuickJSStrategy = typeof (context as any).getRunId === 'function';
    
    let state: SerializedState;

    if (isQuickJSStrategy) {
      // 使用QuickJSStrategy API直接读取状态
      const qs = context as any;
      
      state = {
        runId: qs.getRunId() || 0,
        orderSeq: qs.getOrderSeq() || 0,
        positionNotional: qs.getStrategyState?.('positionNotional') || 0,
        exchangePosition: qs.getStrategyState?.('exchangePosition') || 0,
        
        pendingOrders: qs.getStrategyState?.('pendingOrders') || [],
        openOrders: provider ? await provider.getOpenOrders() : [],
        
        strategyState: qs.getAllStrategyState ? qs.getAllStrategyState() : {},
        
        cachedAccount: qs.getCachedAccount?.(),
        cachedPositions: qs.getCachedPositions ? Array.from(qs.getCachedPositions().values()) : [],
        
        snapshotTime: Date.now(),
        snapshotHash: '', // 将在下面计算
        strategyId: strategyId,
      };
      
      logger.info(`[StateMigration] 使用QuickJSStrategy API序列化完成`);
    } else {
      // 回退：从state文件读取
      state = await this.serializeFromStateFile(strategyId || 'unknown');
    }

    // 计算hash（用于验证完整性）
    state.snapshotHash = this.hashState(state);

    logger.info(`[StateMigration] 序列化完成:`);
    logger.info(`  runId: ${state.runId}`);
    logger.info(`  orderSeq: ${state.orderSeq}`);
    logger.info(`  pendingOrders: ${state.pendingOrders.length}`);
    logger.info(`  openOrders: ${state.openOrders.length}`);
    logger.info(`  strategyState keys: ${Object.keys(state.strategyState).length}`);
    
    return state;
  }

  /**
   * 从state文件序列化（回退方案）
   */
  private async serializeFromStateFile(strategyId: string): Promise<SerializedState> {
    const { existsSync, readFileSync } = await import('fs');
    const { join } = await import('path');
    
    const homeDir = env.HOME;
    const stateFile = join(homeDir, '.quant-lab/state', `${strategyId}.json`);
    
    let fileState: Record<string, any> = {};
    
    try {
      if (existsSync(stateFile)) {
        const raw = readFileSync(stateFile, 'utf-8');
        const data = JSON.parse(raw);
        fileState = data.state || data;
      }
    } catch (error) {
      logger.warn(`[StateMigration] 无法读取state文件: ${stateFile}`);
    }

    return {
      runId: fileState.runId || 0,
      orderSeq: fileState.orderSeq || 0,
      positionNotional: fileState.positionNotional || 0,
      exchangePosition: fileState.exchangePosition || 0,
      pendingOrders: fileState.pendingOrders || [],
      openOrders: [],
      strategyState: fileState,
      cachedAccount: undefined,
      cachedPositions: [],
      snapshotTime: Date.now(),
      snapshotHash: '',
      strategyId,
    };
  }

  /**
   * 反序列化状态
   * 
   * 将序列化的状态恢复到新策略实例。
   * 支持QuickJSStrategy实例直接恢复，普通StrategyContext回退到state文件。
   * 
   * @param state 序列化的状态
   * @param newContext 新策略上下文或QuickJSStrategy实例
   */
  async deserialize(state: SerializedState, newContext: StrategyContext): Promise<void> {
    // 验证hash
    const expectedHash = this.hashState(state);
    if (state.snapshotHash !== expectedHash) {
      throw new Error(`状态hash不匹配，可能已损坏 (expected: ${expectedHash}, got: ${state.snapshotHash})`);
    }

    logger.info(`[StateMigration] 开始恢复状态:`);
    logger.info(`  runId: ${state.runId} ✅（保留）`);
    logger.info(`  orderSeq: ${state.orderSeq} ✅（保留）`);
    logger.info(`  positionNotional: ${state.positionNotional} ✅（保留）`);
    logger.info(`  exchangePosition: ${state.exchangePosition} ✅（保留）`);
    logger.info(`  pendingOrders: ${state.pendingOrders.length}`);
    logger.info(`  openOrders: ${state.openOrders.length}`);
    logger.info(`  cachedPositions: ${state.cachedPositions.length}`);

    // 检查是否是QuickJSStrategy
    const isQuickJSStrategy = typeof (newContext as any).setRunId === 'function';

    if (isQuickJSStrategy) {
      const qs = newContext as any;
      
      // 恢复runId和orderSeq（幂等性关键）
      if (state.runId > 0) {
        qs.setRunId(state.runId);
      }
      if (state.orderSeq > 0) {
        qs.setOrderSeq(state.orderSeq);
      }

      // 恢复策略状态
      if (state.strategyState && Object.keys(state.strategyState).length > 0) {
        for (const [key, value] of Object.entries(state.strategyState)) {
          // 跳过已由setRunId/setOrderSeq设置的值，避免重复
          if (key !== 'runId' && key !== 'orderSeq') {
            qs.setStrategyState(key, value);
          }
        }
      }

      logger.info(`[StateMigration] 使用QuickJSStrategy API恢复状态完成`);
    } else {
      // 回退：写入state文件，策略下次启动时加载
      await this.saveToStateFile(state);
    }

    logger.info(`[StateMigration] 反序列化完成 ✅`);
  }

  /**
   * 保存状态到state文件（回退方案）
   */
  private async saveToStateFile(state: SerializedState): Promise<void> {
    const { existsSync, mkdirSync, writeFileSync, renameSync } = await import('fs');
    const { join } = await import('path');
    
    const homeDir = env.HOME;
    const stateDir = join(homeDir, '.quant-lab/state');
    const stateFile = join(stateDir, `${state.strategyId || 'unknown'}.json`);
    
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
    }

    const data = {
      ...state.strategyState,
      runId: state.runId,
      orderSeq: state.orderSeq,
      positionNotional: state.positionNotional,
      exchangePosition: state.exchangePosition,
      pendingOrders: state.pendingOrders,
      _snapshotTime: state.snapshotTime,
      _snapshotHash: state.snapshotHash,
    };

    // 原子写入
    const tmpPath = stateFile + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, stateFile);

    logger.info(`[StateMigration] 状态已保存到文件: ${stateFile}`);
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
   * 注意：snapshotHash字段本身不参与hash计算
   */
  private hashState(state: any): string {
    // 创建state的副本，排除snapshotHash字段
    const stateForHash = { ...state };
    delete stateForHash.snapshotHash;
    
    // 简单hash实现（可以改用crypto.createHash）
    const str = JSON.stringify(stateForHash, null, 0);
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
      logger.error(`[StateMigration] runId不一致: ${oldRunId} → ${newRunId}`);
      return false;
    }
    
    logger.info(`[StateMigration] runId一致: ${oldRunId} ✅`);
    return true;
  }

  /**
   * 验证orderSeq连续性（幂等性保证）
   */
  validateOrderSeq(oldSeq: number, newSeq: number): boolean {
    if (newSeq < oldSeq) {
      logger.error(`[StateMigration] orderSeq倒退: ${oldSeq} → ${newSeq}`);
      return false;
    }
    
    logger.info(`[StateMigration] orderSeq正常: ${oldSeq} → ${newSeq} ✅`);
    return true;
  }
}
