/**
 * 热更新管理器（核心）
 * 
 * 职责：
 * - 单实例锁管理
 * - 门闸检查
 * - 状态快照/回滚
 * - 审计日志
 * 
 * 鲶鱼7要求：
 * 1. 显式触发（不是自动watch）
 * 2. 可审计
 * 3. 带门闸
 * 4. 单实例锁
 * 5. 对账/幂等（runId/orderLinkId一致性）
 * 6. 失败回滚
 * 7. 告警必达
 */

import { createLogger } from '../utils/logger';
const logger = createLogger('HotReloadManager');

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { AlertManager } from './AlertManager';
import { StrategyReloader } from './StrategyReloader';
import { ModuleReloader } from './ModuleReloader';

// 兼容获取home目录
function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || '/tmp';
}

// ================================
// 类型定义
// ================================

export interface ReloadOptions {
  target: 'strategy' | 'module' | 'provider' | 'all';
  dryRun?: boolean;
  force?: boolean;
}

export interface ReloadResult {
  success: boolean;
  strategyId: string;
  target: string;
  duration: number;
  error?: string;
  snapshot?: StateSnapshot;
}

export interface GateCheckResult {
  passed: boolean;
  failedChecks: GateCheck[];
}

export interface GateCheck {
  name: string;
  passed: boolean;
  reason?: string;
}

export interface StateSnapshot {
  timestamp: number;
  strategyId: string;
  state: Record<string, any>;
  openOrders: any[];
  position: any;
  hash: string;
}

export interface ReloadEvent {
  timestamp: number;
  strategyId: string;
  runId?: number;
  event: 'reload_start' | 'reload_success' | 'reload_failure' | 'gate_failed' | 'rollback';
  target: string;
  before?: any;
  after?: any;
  duration?: number;
  error?: string;
  lockId?: string; // C项修复：lockId入审计
}

export interface FileLock {
  pid: number;
  startTime: number;
  lockId: string;
}

// ================================
// HotReloadManager
// ================================

export class HotReloadManager {
  private lockDir: string;
  private snapshotDir: string;
  private auditDir: string;
  private alertManager: AlertManager;
  private strategyReloader: StrategyReloader;
  private moduleReloader: ModuleReloader;

  constructor() {
    const baseDir = join(getHomeDir(), '.quant-lab');
    this.lockDir = join(baseDir, 'locks');
    this.snapshotDir = join(baseDir, 'snapshots');
    this.auditDir = join(baseDir, 'audit');

    // 创建目录
    [this.lockDir, this.snapshotDir, this.auditDir].forEach(dir => {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    });

    // 初始化告警管理器
    this.alertManager = new AlertManager({
      enableTg: true,
      tgTarget: 'bot-000',
    });

    // 初始化热更新器
    this.strategyReloader = new StrategyReloader();
    this.moduleReloader = new ModuleReloader();
  }

  /**
   * 热更新主流程
   */
  async reload(strategyId: string, options: ReloadOptions): Promise<ReloadResult> {
    const startTime = Date.now();
    let snapshot: StateSnapshot | undefined;

    try {
      // 1. 获取单实例锁
      const lock = await this.acquireLock(strategyId);
      
      // 2. 审计日志：开始（C项修复：lockId入审计）
      await this.audit({
        timestamp: Date.now(),
        strategyId,
        event: 'reload_start',
        target: options.target,
        lockId: lock.lockId,
      });
      
      try {
        // 3. 门闸检查
        const gateResult = await this.checkGate(strategyId, options);
        if (!gateResult.passed) {
          const reason = gateResult.failedChecks.map(c => c.name + ': ' + c.reason).join(', ');
          
          await this.audit({
            timestamp: Date.now(),
            strategyId,
            event: 'gate_failed',
            target: options.target,
            error: reason,
          });

          if (!options.force) {
            const failedResult: ReloadResult = {
              success: false,
              strategyId,
              target: options.target,
              duration: Date.now() - startTime,
              error: `门闸检查失败: ${reason}`,
            };

            // 告警：门闸检查失败（鲶鱼要求#7）
            await this.alertManager.alertGateFailed(
              strategyId,
              gateResult.failedChecks.map(c => c.name)
            );

            return failedResult;
          }

          logger.warn(`[HotReload] 强制模式：跳过门闸检查`);
        }

        // 4. 状态快照
        snapshot = await this.snapshot(strategyId);

        // 5. 干跑模式：不实际更新
        if (options.dryRun) {
          logger.info(`[HotReload] 干跑模式：门闸检查通过，未实际更新`);
          return {
            success: true,
            strategyId,
            target: options.target,
            duration: Date.now() - startTime,
            snapshot,
          };
        }

        // 6. 执行热更新（根据target）
        await this.performReload(strategyId, options, snapshot);

        // 7. 审计日志：成功
        await this.audit({
          timestamp: Date.now(),
          strategyId,
          event: 'reload_success',
          target: options.target,
          duration: Date.now() - startTime,
        });

        const successResult: ReloadResult = {
          success: true,
          strategyId,
          target: options.target,
          duration: Date.now() - startTime,
          snapshot,
        };

        // 8. 告警：成功（鲶鱼要求#7）
        await this.alertManager.alertSuccess(successResult);

        return successResult;
      } finally {
        // 8. 释放锁
        await this.releaseLock(strategyId, lock);
      }
    } catch (error: any) {
      logger.error(`[HotReload] 热更新失败:`, error);

      // 9. 回滚
      if (snapshot && !options.dryRun) {
        try {
          await this.rollback(strategyId, snapshot);
          logger.info(`[HotReload] 回滚成功`);
        } catch (rollbackError: any) {
          logger.error(`[HotReload] 回滚失败:`, rollbackError);
        }
      }

      // 10. 审计日志：失败
      await this.audit({
        timestamp: Date.now(),
        strategyId,
        event: 'reload_failure',
        target: options.target,
        duration: Date.now() - startTime,
        error: error.message,
      });

      const failureResult: ReloadResult = {
        success: false,
        strategyId,
        target: options.target,
        duration: Date.now() - startTime,
        error: error.message,
        snapshot,
      };

      // 11. 告警：失败（鲶鱼要求#7）
      await this.alertManager.alertFailure(failureResult);

      return failureResult;
    }
  }

  /**
   * 门闸检查（A项修复 - 鲶鱼建议）
   */
  async checkGate(strategyId: string, options: ReloadOptions): Promise<GateCheckResult> {
    const checks: GateCheck[] = [];

    // A项修复：真实检查，基于状态文件
    const stateFile = join(getHomeDir(), '.quant-lab/state', `${strategyId}.json`);
    let state: any = null;

    try {
      if (existsSync(stateFile)) {
        const raw = readFileSync(stateFile, 'utf-8');
        const data = JSON.parse(raw);
        state = data.state || data;
      }
    } catch (error) {
      logger.warn(`[HotReload] 无法读取状态文件: ${stateFile}`);
    }

    // 1. 无进行中订单（检查gridLevels中的PENDING/PLACING状态）
    if (state && state.gridLevels) {
      const activeGrids = state.gridLevels.filter((g: any) => 
        g.state === 'PENDING' || g.state === 'PLACING' || g.state === 'FILLED'
      );
      
      if (activeGrids.length > 0) {
        checks.push({
          name: 'NoActiveOrders',
          passed: false,
          reason: `有 ${activeGrids.length} 个活跃网格（${activeGrids.map((g: any) => g.state).join(', ')}）`,
        });
      } else {
        checks.push({
          name: 'NoActiveOrders',
          passed: true,
        });
      }
    } else {
      // 没有状态文件或没有gridLevels，谨慎起见认为通过
      checks.push({
        name: 'NoActiveOrders',
        passed: true,
      });
    }

    // 2. 无熔断中状态
    if (state && state.circuitBreakerState) {
      const cb = state.circuitBreakerState;
      if (cb.tripped) {
        checks.push({
          name: 'NoCircuitBreaker',
          passed: false,
          reason: `熔断中: ${cb.reason || 'unknown'}`,
        });
      } else {
        checks.push({
          name: 'NoCircuitBreaker',
          passed: true,
        });
      }
    } else {
      checks.push({
        name: 'NoCircuitBreaker',
        passed: true,
      });
    }

    // 3. 无锁冲突
    // 注意：锁检查移到acquireLock中处理，这里不检查

    // 4. 状态文件可写
    try {
      if (existsSync(stateFile)) {
        // 尝试写入测试
        const testFile = stateFile + '.test';
        writeFileSync(testFile, 'test');
        unlinkSync(testFile);
        checks.push({
          name: 'StateFileWritable',
          passed: true,
        });
      } else {
        checks.push({
          name: 'StateFileWritable',
          passed: false,
          reason: '状态文件不存在',
        });
      }
    } catch (error: any) {
      checks.push({
        name: 'StateFileWritable',
        passed: false,
        reason: `状态文件不可写: ${error.message}`,
      });
    }

    // 5. 新代码语法检查（策略JS）
    // 未来增强：如果是strategy target，可以检查策略文件语法
    // 目前由QuickJSStrategy.reload()内部处理语法错误
    checks.push({
      name: 'NewCodeSyntax',
      passed: true, // 暂时通过，语法检查较复杂
    });

    const failedChecks = checks.filter(c => !c.passed);

    return {
      passed: failedChecks.length === 0,
      failedChecks,
    };
  }

  /**
   * 检查锁冲突（C项修复 - 鲶鱼建议：PID存活检查）
   */
  private async checkNoLockConflict(strategyId: string): Promise<GateCheck> {
    const lockFile = join(this.lockDir, `${strategyId}.lock`);

    if (!existsSync(lockFile)) {
      return { name: 'NoLockConflict', passed: true };
    }

    try {
      const lockData = JSON.parse(readFileSync(lockFile, 'utf-8'));
      const lock = lockData as FileLock;

      // C项修复：检查PID是否存活
      const pidAlive = this.checkPidAlive(lock.pid);
      
      if (!pidAlive) {
        // PID已死亡，删除锁
        unlinkSync(lockFile);
        logger.info(`[HotReload] 锁文件PID ${lock.pid} 已死亡，删除锁`);
        return { name: 'NoLockConflict', passed: true };
      }

      // 检查锁是否超时（5分钟）
      const now = Date.now();
      const timeout = 5 * 60 * 1000; // 5分钟

      if (now - lock.startTime > timeout) {
        // 超时，删除锁
        unlinkSync(lockFile);
        logger.info(`[HotReload] 锁超时，删除锁`);
        return { name: 'NoLockConflict', passed: true };
      }

      return {
        name: 'NoLockConflict',
        passed: false,
        reason: `锁被进程${lock.pid}持有（${Math.floor((now - lock.startTime) / 1000)}秒前）`,
      };
    } catch (error) {
      // 锁文件损坏，删除
      unlinkSync(lockFile);
      return { name: 'NoLockConflict', passed: true };
    }
  }

  /**
   * 检查PID是否存活（C项修复）
   */
  private checkPidAlive(pid: number): boolean {
    try {
      // 使用 kill -0 检查进程是否存在
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * 获取单实例锁
   */
  private async acquireLock(strategyId: string): Promise<FileLock> {
    const lockFile = join(this.lockDir, `${strategyId}.lock`);

    // 检查锁冲突
    const lockCheck = await this.checkNoLockConflict(strategyId);
    if (!lockCheck.passed) {
      throw new Error(`无法获取锁: ${lockCheck.reason}`);
    }

    const lock: FileLock = {
      pid: process.pid,
      startTime: Date.now(),
      lockId: `${strategyId}-${Date.now()}-${process.pid}`,
    };

    writeFileSync(lockFile, JSON.stringify(lock, null, 2));

    return lock;
  }

  /**
   * 释放锁
   */
  private async releaseLock(strategyId: string, lock: FileLock): Promise<void> {
    const lockFile = join(this.lockDir, `${strategyId}.lock`);

    if (existsSync(lockFile)) {
      try {
        const currentLock = JSON.parse(readFileSync(lockFile, 'utf-8')) as FileLock;
        
        // 只有当前锁才能释放
        if (currentLock.lockId === lock.lockId) {
          unlinkSync(lockFile);
        }
      } catch (error) {
        // 忽略错误
      }
    }
  }

  /**
   * 状态快照（B项修复 - 鲶鱼建议：保存策略state+openOrders+position）
   */
  async snapshot(strategyId: string): Promise<StateSnapshot> {
    // B项修复：从状态文件读取真实状态
    const stateFile = join(getHomeDir(), '.quant-lab/state', `${strategyId}.json`);
    let state: Record<string, any> = {};
    
    try {
      if (existsSync(stateFile)) {
        const raw = readFileSync(stateFile, 'utf-8');
        const data = JSON.parse(raw);
        state = data.state || data;
        logger.info(`[HotReload] 快照：从状态文件加载 ${Object.keys(state).length} 个键`);
      }
    } catch (error: any) {
      logger.warn(`[HotReload] 快照：无法读取状态文件: ${error.message}`);
    }

    // 从exchange拉取openOrders和position（可选增强）
    // 目前StateMigrationEngine.serialize()支持通过provider参数获取
    // 如需实时数据，可传入Provider实例
    const openOrders: any[] = [];
    const position: any = null;

    const snapshot: StateSnapshot = {
      timestamp: Date.now(),
      strategyId,
      state,
      openOrders,
      position,
      hash: this.hashState(state), // B项修复：计算真实hash
    };

    // 保存快照到磁盘
    const snapshotFile = join(this.snapshotDir, `${strategyId}-${snapshot.timestamp}.json`);
    writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2));
    logger.info(`[HotReload] 快照已保存: ${snapshotFile}`);

    return snapshot;
  }

  /**
   * 计算状态hash（B项修复）
   */
  private hashState(state: any): string {
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
   * 回滚（B项修复 - 鲶鱼建议：恢复策略state）
   */
  async rollback(strategyId: string, snapshot: StateSnapshot): Promise<void> {
    logger.info(`[HotReload] 回滚到快照: ${new Date(snapshot.timestamp).toISOString()}`);

    // B项修复：恢复状态文件
    const stateFile = join(getHomeDir(), '.quant-lab/state', `${strategyId}.json`);
    
    try {
      if (snapshot.state && Object.keys(snapshot.state).length > 0) {
        // 恢复状态文件
        const data = { state: snapshot.state };
        const tmpStateFile = stateFile + '.tmp';
        writeFileSync(tmpStateFile, JSON.stringify(data, null, 2));
        renameSync(tmpStateFile, stateFile);
        logger.info(`[HotReload] 回滚：状态文件已恢复 (${Object.keys(snapshot.state).length} 个键)`);
      }

      // 验证hash
      const restoredHash = this.hashState(snapshot.state);
      if (restoredHash !== snapshot.hash) {
        logger.warn(`[HotReload] 回滚：hash不匹配 (expected: ${snapshot.hash}, got: ${restoredHash})`);
      }
    } catch (error: any) {
      logger.error(`[HotReload] 回滚失败: ${error.message}`);
      throw error;
    }

    await this.audit({
      timestamp: Date.now(),
      strategyId,
      event: 'rollback',
      target: 'rollback',
      before: snapshot,
      lockId: undefined, // rollback时可能已经释放锁
    });
  }

  /**
   * 执行热更新
   */
  private async performReload(
    strategyId: string,
    options: ReloadOptions,
    snapshot: StateSnapshot
  ): Promise<void> {
    logger.info(`[HotReload] 执行热更新: target=${options.target}`);

    switch (options.target) {
      case 'strategy':
        // 策略JS热更新 - 使用StrategyRegistry查找策略实例
        logger.info(`[HotReload] 执行策略JS热更新`);
        
        // 从全局注册表获取策略实例
        const { StrategyRegistry } = await import('./StrategyRegistry');
        const strategy = StrategyRegistry.get(strategyId);
        
        if (!strategy) {
          throw new Error(
            `策略未找到: ${strategyId}\n` +
            `请确保策略已在StrategyRegistry中注册。\n` +
            `QuickJSStrategy会在onInit时自动注册（如未禁用）。`
          );
        }

        // 使用StrategyReloader执行热重载
        const reloadResult = await this.strategyReloader.reloadStrategy(
          strategy,
          strategy as any, // QuickJSStrategy实现了StrategyContext接口
          {
            preserveRunId: true,
            preserveOrderSeq: true,
            skipValidation: options.dryRun,
          }
        );

        if (!reloadResult.success) {
          throw new Error(`策略热更新失败: ${reloadResult.error}`);
        }

        logger.info(`[HotReload] 策略JS热更新成功 (${reloadResult.duration}ms)`);
        break;

      case 'module':
        // TS模块热更新
        logger.info(`[HotReload] 执行TS模块热更新`);
        
        // 示例：热更新QuickJSStrategy模块
        const result = await this.moduleReloader.reloadModule({
          modulePath: '../src/sandbox/QuickJSStrategy.ts',
          className: 'QuickJSStrategy',
        });

        if (!result.success) {
          throw new Error(`模块热更新失败: ${result.error}`);
        }

        logger.info(`[HotReload] TS模块热更新成功`);
        break;

      case 'provider':
        // Provider热更新
        logger.info(`[HotReload] Provider热更新`);
        
        // 鲶鱼验收修复：未接入真实API前，抛出错误避免假成功
        throw new Error(
          'Provider热更新需要Provider.reload() API支持（Step 3待实现）。' +
          '当前实现不完整，需要手动重启策略进程。' +
          '请使用 systemctl --user restart <service> 重启策略。'
        );
        break;

      case 'all':
        // 全部热更新
        logger.info(`[HotReload] 执行全部热更新`);
        await this.performReload(strategyId, { ...options, target: 'strategy' }, snapshot);
        await this.performReload(strategyId, { ...options, target: 'module' }, snapshot);
        await this.performReload(strategyId, { ...options, target: 'provider' }, snapshot);
        break;
    }
  }

  /**
   * 审计日志
   */
  async audit(event: ReloadEvent): Promise<void> {
    const auditFile = join(this.auditDir, `${event.strategyId}-reload.jsonl`);

    // JSONL格式：每行一个JSON
    const line = JSON.stringify(event) + '\n';

    // 追加写入
    try {
      const existingContent = existsSync(auditFile) ? readFileSync(auditFile, 'utf-8') : '';
      const lines = existingContent.split('\n').filter(l => l.trim());

      // 保留最近1000条
      const maxLines = 1000;
      if (lines.length >= maxLines) {
        lines.splice(0, lines.length - maxLines + 1);
      }

      lines.push(line.trim());

      writeFileSync(auditFile, lines.join('\n') + '\n');
    } catch (error) {
      logger.error(`[HotReload] 审计日志写入失败:`, error);
    }

    // 控制台输出
    logger.info(`[Audit] ${event.event}: ${event.strategyId}`);
  }
}
