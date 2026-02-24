/**
 * 策略热更新器
 * 
 * 职责：
 * - 策略JS热更新（显式触发）
 * - 保留runId/orderLinkId（幂等性）
 * - 状态迁移
 * - 失败回滚
 */

import { createLogger } from '../utils/logger';
const logger = createLogger('StrategyReloader');

import type { QuickJSStrategy } from '../legacy/QuickJSStrategy';
import type { StrategyContext } from '../types/strategy';
import { StateMigrationEngine, type SerializedState } from './StateMigrationEngine';
import { readFileSync } from 'fs';

export interface StrategyReloadOptions {
  preserveRunId?: boolean; // 保留runId（默认true）
  preserveOrderSeq?: boolean; // 保留orderSeq（默认true）
  skipValidation?: boolean; // 跳过验证（默认false）
}

export interface StrategyReloadResult {
  success: boolean;
  oldState: SerializedState;
  newState?: SerializedState;
  duration: number;
  error?: string;
  rolledBack?: boolean;
}

export class StrategyReloader {
  private migrationEngine: StateMigrationEngine;

  constructor() {
    this.migrationEngine = new StateMigrationEngine();
  }

  /**
   * 热更新策略JS
   * 
   * 完整流程：
   * 1. 序列化当前状态
   * 2. 调用st_stop清理
   * 3. 重新加载策略代码（通过QuickJSStrategy.reload()）
   * 4. 反序列化恢复状态
   * 5. 调用st_init初始化（热重载模式）
   * 6. 验证状态一致性
   * 
   * @param strategy QuickJSStrategy实例
   * @param context 策略上下文
   * @param options 热重载选项
   * @returns 热重载结果
   */
  async reloadStrategy(
    strategy: QuickJSStrategy,
    context: StrategyContext,
    options: StrategyReloadOptions = {}
  ): Promise<StrategyReloadResult> {
    const startTime = Date.now();
    
    const opts = {
      preserveRunId: true,
      preserveOrderSeq: true,
      skipValidation: false,
      ...options,
    };

    logger.info(`[StrategyReloader] 开始策略JS热更新...`);
    logger.info(`[StrategyReloader] 选项: preserveRunId=${opts.preserveRunId}, preserveOrderSeq=${opts.preserveOrderSeq}`);

    let oldState: SerializedState;
    let newState: SerializedState | undefined;

    try {
      // 1. 序列化当前状态（用于回滚）
      oldState = await this.migrationEngine.serialize(context);
      logger.info(`[StrategyReloader] 当前状态已序列化`);
      logger.info(`  runId: ${oldState.runId}`);
      logger.info(`  orderSeq: ${oldState.orderSeq}`);
      logger.info(`  positionNotional: ${oldState.positionNotional}`);
      logger.info(`  strategyState keys: ${Object.keys(oldState.strategyState).length}`);

      // 2. 调用st_stop（清理旧策略状态）
      try {
        await strategy.callStrategyFunction('st_stop');
        logger.info(`[StrategyReloader] st_stop执行成功`);
      } catch (error: any) {
        logger.warn(`[StrategyReloader] st_stop执行失败（可能不存在）: ${error.message}`);
        // 不中断流程，继续执行
      }

      // 3. 重新加载策略代码
      // 使用QuickJSStrategy内置的reload()方法，它会更优雅地处理VM重建
      try {
        const reloadResult = await strategy.reload('hot-reload');
        logger.info(`[StrategyReloader] 策略代码重新加载成功`);
        logger.info(`  oldHash: ${reloadResult.oldHash}`);
        logger.info(`  newHash: ${reloadResult.newHash}`);
        logger.info(`  duration: ${reloadResult.duration}ms`);
      } catch (error: any) {
        throw new Error(`策略代码重新加载失败: ${error.message}`);
      }

      // 4. 反序列化恢复状态（保留runId/orderSeq）
      // 设置热重载标记，让st_init知道不要生成新runId
      if (opts.preserveRunId && oldState.runId > 0) {
        strategy.setRunId(oldState.runId);
        logger.info(`[StrategyReloader] runId已保留: ${oldState.runId}`);
      }

      if (opts.preserveOrderSeq && oldState.orderSeq > 0) {
        strategy.setOrderSeq(oldState.orderSeq);
        logger.info(`[StrategyReloader] orderSeq已保留: ${oldState.orderSeq}`);
      }

      await this.migrationEngine.deserialize(oldState, context);
      logger.info(`[StrategyReloader] 状态已恢复`);

      // 5. 调用st_init（初始化，热重载模式）
      // QuickJSStrategy.reload()已经调用了st_init，这里可以选择性再次调用
      // 如果需要传递特定参数，可以在这里调用
      try {
        // 设置热重载标志，策略可以通过ctx._hotReload检查
        await strategy.callStrategyFunction('st_init', context);
        logger.info(`[StrategyReloader] st_init执行成功（热重载模式）`);
      } catch (error: any) {
        throw new Error(`st_init执行失败: ${error.message}`);
      }

      // 6. 验证热更新后的状态
      if (!opts.skipValidation) {
        const validated = await this.validateReload(oldState, context);
        if (!validated) {
          throw new Error('热更新后状态验证失败');
        }
      }

      // 获取新状态用于返回
      newState = await this.migrationEngine.serialize(context);

      const duration = Date.now() - startTime;
      logger.info(`[StrategyReloader] 策略JS热更新完成 ✅ (${duration}ms)`);

      return {
        success: true,
        oldState,
        newState,
        duration,
      };

    } catch (error: any) {
      const duration = Date.now() - startTime;
      logger.error(`[StrategyReloader] 热更新失败 ❌ (${duration}ms): ${error.message}`);

      // 尝试回滚
      let rolledBack = false;
      if (oldState!) {
        try {
          logger.info(`[StrategyReloader] 开始回滚...`);
          await this.rollback(strategy, context, oldState!);
          rolledBack = true;
          logger.info(`[StrategyReloader] 回滚成功 ✅`);
        } catch (rollbackError: any) {
          logger.error(`[StrategyReloader] 回滚失败 ❌: ${rollbackError.message}`);
        }
      }

      return {
        success: false,
        oldState: oldState!,
        duration,
        error: error.message,
        rolledBack,
      };
    }
  }

  /**
   * 回滚到之前的状态
   * 
   * @param strategy QuickJSStrategy实例
   * @param context 策略上下文
   * @param targetState 目标状态
   */
  async rollback(
    strategy: QuickJSStrategy,
    context: StrategyContext,
    targetState: SerializedState
  ): Promise<void> {
    logger.info(`[StrategyReloader] 开始回滚到状态 (runId=${targetState.runId})...`);

    try {
      // 1. 尝试使用QuickJSStrategy的rollback方法（如果存在源代码快照）
      const rollbackResult = await strategy.rollback();
      
      if (rollbackResult.success) {
        logger.info(`[StrategyReloader] QuickJSStrategy.rollback()成功，RTO=${rollbackResult.rto}ms`);
      } else {
        logger.warn(`[StrategyReloader] QuickJSStrategy.rollback()失败: ${rollbackResult.error}`);
        // 继续尝试手动恢复状态
      }
    } catch (error: any) {
      logger.warn(`[StrategyReloader] QuickJSStrategy.rollback()不可用: ${error.message}`);
      // 继续尝试手动恢复状态
    }

    // 2. 手动恢复状态
    await this.migrationEngine.deserialize(targetState, context);
    logger.info(`[StrategyReloader] 状态已手动恢复`);

    // 3. 重新初始化
    try {
      await strategy.callStrategyFunction('st_init', context);
      logger.info(`[StrategyReloader] st_init重新执行成功`);
    } catch (error: any) {
      logger.warn(`[StrategyReloader] st_init重新执行失败: ${error.message}`);
    }

    logger.info(`[StrategyReloader] 回滚完成 ✅`);
  }

  /**
   * 验证热更新后的状态
   * 
   * 检查点：
   * 1. runId一致性（幂等性保证）
   * 2. orderSeq连续性
   * 3. 持仓一致性
   * 
   * @param oldState 热更新前的状态
   * @param newContext 热更新后的策略上下文
   * @returns 验证是否通过
   */
  async validateReload(
    oldState: SerializedState,
    newContext: StrategyContext
  ): Promise<boolean> {
    // 从newContext提取新状态
    const newState = await this.migrationEngine.serialize(newContext);

    logger.info(`[StrategyReloader] 开始验证热更新后的状态...`);
    logger.info(`  旧runId: ${oldState.runId}, 新runId: ${newState.runId}`);
    logger.info(`  旧orderSeq: ${oldState.orderSeq}, 新orderSeq: ${newState.orderSeq}`);
    logger.info(`  旧positionNotional: ${oldState.positionNotional}, 新positionNotional: ${newState.positionNotional}`);

    let allPassed = true;

    // 1. 验证runId一致性
    if (!this.migrationEngine.validateRunId(oldState.runId, newState.runId)) {
      logger.error(`[StrategyReloader] 验证失败：runId不一致`);
      allPassed = false;
    }

    // 2. 验证orderSeq连续性（新seq应该>=旧seq）
    if (!this.migrationEngine.validateOrderSeq(oldState.orderSeq, newState.orderSeq)) {
      logger.error(`[StrategyReloader] 验证失败：orderSeq不连续`);
      allPassed = false;
    }

    // 3. 验证持仓一致性
    const positionResult = await this.migrationEngine.reconcilePosition(
      oldState.positionNotional,
      newState.positionNotional
    );
    
    if (!positionResult.passed) {
      logger.error(`[StrategyReloader] 验证失败：${positionResult.message}`);
      allPassed = false;
    }

    if (allPassed) {
      logger.info(`[StrategyReloader] 验证通过 ✅`);
    }

    return allPassed;
  }
}
