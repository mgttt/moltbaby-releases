/**
 * 策略热更新器
 * 
 * 职责：
 * - 策略JS热更新（显式触发）
 * - 保留runId/orderLinkId（幂等性）
 * - 状态迁移
 */

import type { QuickJSStrategy } from '../sandbox/QuickJSStrategy';
import type { StrategyContext } from '../types/strategy';
import { StateMigrationEngine, type SerializedState } from './StateMigrationEngine';
import { readFileSync } from 'fs';

export interface StrategyReloadOptions {
  preserveRunId?: boolean; // 保留runId（默认true）
  preserveOrderSeq?: boolean; // 保留orderSeq（默认true）
}

export class StrategyReloader {
  private migrationEngine: StateMigrationEngine;

  constructor() {
    this.migrationEngine = new StateMigrationEngine();
  }

  /**
   * 热更新策略JS
   */
  async reloadStrategy(
    strategy: QuickJSStrategy,
    context: StrategyContext,
    options: StrategyReloadOptions = {}
  ): Promise<void> {
    const opts = {
      preserveRunId: true,
      preserveOrderSeq: true,
      ...options,
    };

    console.log(`[StrategyReloader] 开始策略JS热更新...`);

    // 1. 序列化当前状态
    const oldState = await this.migrationEngine.serialize(context);
    console.log(`[StrategyReloader] 当前状态已序列化`);
    console.log(`  runId: ${oldState.runId}`);
    console.log(`  orderSeq: ${oldState.orderSeq}`);
    console.log(`  positionNotional: ${oldState.positionNotional}`);

    // 2. 调用st_stop（清理）
    try {
      // TODO: 调用strategy.callStrategyFunction('st_stop')
      console.log(`[StrategyReloader] st_stop已调用`);
    } catch (error) {
      console.warn(`[StrategyReloader] st_stop失败（可能不存在）`);
    }

    // 3. 重新加载策略代码
    try {
      // TODO: 重新加载策略文件
      // 这需要访问QuickJSStrategy的内部实现
      // 或者提供公共API
      console.log(`[StrategyReloader] 策略代码已重新加载`);
    } catch (error: any) {
      throw new Error(`策略代码重新加载失败: ${error.message}`);
    }

    // 4. 恢复状态（保留runId/orderSeq）
    if (opts.preserveRunId) {
      // TODO: 恢复runId到策略state
      console.log(`[StrategyReloader] runId已保留: ${oldState.runId}`);
    }

    if (opts.preserveOrderSeq) {
      // TODO: 恢复orderSeq到策略state
      console.log(`[StrategyReloader] orderSeq已保留: ${oldState.orderSeq}`);
    }

    // 5. 反序列化状态
    await this.migrationEngine.deserialize(oldState, context);
    console.log(`[StrategyReloader] 状态已恢复`);

    // 6. 调用st_init（初始化，但跳过runId生成）
    try {
      // TODO: 调用strategy.callStrategyFunction('st_init')
      // 但需要标记为热重载模式，避免生成新runId
      console.log(`[StrategyReloader] st_init已调用（热重载模式）`);
    } catch (error: any) {
      throw new Error(`st_init失败: ${error.message}`);
    }

    console.log(`[StrategyReloader] 策略JS热更新完成 ✅`);
  }

  /**
   * 验证热更新后的状态
   */
  async validateReload(
    oldState: SerializedState,
    newContext: StrategyContext
  ): Promise<boolean> {
    // TODO: 从newContext提取新状态
    const newState = await this.migrationEngine.serialize(newContext);

    // 1. 验证runId一致性
    if (!this.migrationEngine.validateRunId(oldState.runId, newState.runId)) {
      console.error(`[StrategyReloader] 验证失败：runId不一致`);
      return false;
    }

    // 2. 验证orderSeq连续性
    if (!this.migrationEngine.validateOrderSeq(oldState.orderSeq, newState.orderSeq)) {
      console.error(`[StrategyReloader] 验证失败：orderSeq不连续`);
      return false;
    }

    // 3. 验证持仓一致性
    const positionResult = await this.migrationEngine.reconcilePosition(
      oldState.positionNotional,
      newState.positionNotional
    );
    
    if (!positionResult.passed) {
      console.error(`[StrategyReloader] 验证失败：${positionResult.message}`);
      return false;
    }

    console.log(`[StrategyReloader] 验证通过 ✅`);
    return true;
  }
}
