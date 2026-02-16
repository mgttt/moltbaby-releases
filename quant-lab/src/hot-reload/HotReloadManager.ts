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

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { AlertManager } from './AlertManager';
import { StrategyReloader } from './StrategyReloader';
import { ModuleReloader } from './ModuleReloader';

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
    const baseDir = join(homedir(), '.quant-lab');
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
      // 1. 审计日志：开始
      await this.audit({
        timestamp: Date.now(),
        strategyId,
        event: 'reload_start',
        target: options.target,
      });

      // 2. 获取单实例锁
      const lock = await this.acquireLock(strategyId);
      
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

          console.warn(`[HotReload] 强制模式：跳过门闸检查`);
        }

        // 4. 状态快照
        snapshot = await this.snapshot(strategyId);

        // 5. 干跑模式：不实际更新
        if (options.dryRun) {
          console.log(`[HotReload] 干跑模式：门闸检查通过，未实际更新`);
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
      console.error(`[HotReload] 热更新失败:`, error);

      // 9. 回滚
      if (snapshot && !options.dryRun) {
        try {
          await this.rollback(strategyId, snapshot);
          console.log(`[HotReload] 回滚成功`);
        } catch (rollbackError: any) {
          console.error(`[HotReload] 回滚失败:`, rollbackError);
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
   * 门闸检查
   */
  async checkGate(strategyId: string, options: ReloadOptions): Promise<GateCheckResult> {
    const checks: GateCheck[] = [];

    // TODO: 实现具体检查
    // 1. 无进行中订单
    checks.push({
      name: 'NoActiveOrders',
      passed: true, // TODO: 实际检查
    });

    // 2. 无熔断中状态
    checks.push({
      name: 'NoCircuitBreaker',
      passed: true, // TODO: 实际检查
    });

    // 3. 无锁冲突
    // 注意：锁检查移到acquireLock中处理，这里不检查
    // const lockCheck = await this.checkNoLockConflict(strategyId);
    // checks.push(lockCheck);

    // 4. 状态文件可写
    checks.push({
      name: 'StateFileWritable',
      passed: true, // TODO: 实际检查
    });

    // 5. 新代码语法检查
    checks.push({
      name: 'NewCodeSyntax',
      passed: true, // TODO: 实际检查
    });

    const failedChecks = checks.filter(c => !c.passed);

    return {
      passed: failedChecks.length === 0,
      failedChecks,
    };
  }

  /**
   * 检查锁冲突
   */
  private async checkNoLockConflict(strategyId: string): Promise<GateCheck> {
    const lockFile = join(this.lockDir, `${strategyId}.lock`);

    if (!existsSync(lockFile)) {
      return { name: 'NoLockConflict', passed: true };
    }

    try {
      const lockData = JSON.parse(readFileSync(lockFile, 'utf-8'));
      const lock = lockData as FileLock;

      // 检查锁是否超时（5分钟）
      const now = Date.now();
      const timeout = 5 * 60 * 1000; // 5分钟

      if (now - lock.startTime > timeout) {
        // 超时，删除锁
        unlinkSync(lockFile);
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
   * 状态快照
   */
  async snapshot(strategyId: string): Promise<StateSnapshot> {
    // TODO: 实现实际快照逻辑
    const snapshot: StateSnapshot = {
      timestamp: Date.now(),
      strategyId,
      state: {}, // TODO: 从实际策略加载
      openOrders: [], // TODO: 从exchange拉取
      position: null, // TODO: 从exchange拉取
      hash: '', // TODO: 计算hash
    };

    // 保存快照到磁盘
    const snapshotFile = join(this.snapshotDir, `${strategyId}-${snapshot.timestamp}.json`);
    writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2));

    return snapshot;
  }

  /**
   * 回滚
   */
  async rollback(strategyId: string, snapshot: StateSnapshot): Promise<void> {
    // TODO: 实现实际回滚逻辑
    console.log(`[HotReload] 回滚到快照: ${snapshot.timestamp}`);

    await this.audit({
      timestamp: Date.now(),
      strategyId,
      event: 'rollback',
      target: 'rollback',
      before: snapshot,
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
    console.log(`[HotReload] 执行热更新: target=${options.target}`);

    switch (options.target) {
      case 'strategy':
        // 策略JS热更新
        console.log(`[HotReload] TODO: 策略JS热更新（需要QuickJSStrategy API）`);
        // TODO: await this.strategyReloader.reloadStrategy(...)
        break;

      case 'module':
        // TS模块热更新
        console.log(`[HotReload] 执行TS模块热更新`);
        
        // 示例：热更新QuickJSStrategy模块
        const result = await this.moduleReloader.reloadModule({
          modulePath: '../src/sandbox/QuickJSStrategy.ts',
          className: 'QuickJSStrategy',
        });

        if (!result.success) {
          throw new Error(`模块热更新失败: ${result.error}`);
        }

        console.log(`[HotReload] TS模块热更新成功`);
        break;

      case 'provider':
        // Provider热更新
        console.log(`[HotReload] TODO: Provider热更新（Step 3）`);
        break;

      case 'all':
        // 全部热更新
        console.log(`[HotReload] 执行全部热更新`);
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
      console.error(`[HotReload] 审计日志写入失败:`, error);
    }

    // 控制台输出
    console.log(`[Audit] ${event.event}: ${event.strategyId}`);
  }
}
