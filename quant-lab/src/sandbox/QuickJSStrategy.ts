// ============================================================
import { createLogger } from '../utils/logger';
const logger = createLogger('QUICK_JSSTRATEGY');
// QuickJS 沙箱策略运行器 (v3)
//
// 将 .js 策略文件包装成 Strategy 接口
// 支持热重载、状态持久化、安全隔离
// ============================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, watchFile, unwatchFile, statSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { BarCacheLayer } from '../cache/BarCacheLayer.ts';
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';

// 兼容获取home目录
function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || '/tmp';
}
import type { QuickJSContext as QuickJSContextType } from 'quickjs-emscripten';
import type { Kline } from '../../../quant-lib/src';
import type { StrategyContext, Order, Position, Account } from '../engine/types';
import { sma, ema, rsi, macd, bollingerBands, atr, stdDev, wma } from '../../quant-lib/src/indicators/indicators';
import { OrderStateManager, globalOrderManager } from '../engine/OrderStateManager';
import { LegacyOrderTracker } from '../engine/LegacyOrderTracker';

/**
 * QuickJS 策略配置
 */
export interface QuickJSStrategyConfig {
  strategyId: string;
  strategyFile: string;
  params?: Record<string, any>;
  stateDir?: string;
  timeoutMs?: number;
  memoryLimitMB?: number;
  hotReload?: boolean;           // 热重载（监听文件变化）
  maxRetries?: number;           // 最大重试次数
  retryDelayMs?: number;         // 重试延迟
}

/**
 * 策略状态快照（用于热更新）
 */
export interface StrategySnapshot {
  timestamp: number;
  strategyId: string;
  state: Record<string, any>;    // 完整策略状态
  cachedAccount?: Account;       // 缓存的账户状态
  cachedPositions: Array<[string, Position]>; // 缓存的持仓
  cacheReady: boolean;           // 缓存就绪标志
  tickCount: number;             // 心跳计数
  lastPrice: number;             // 最后价格
  lastBar?: Kline;               // 最后K线
}

/**
 * QuickJS 策略运行器
 */
export class QuickJSStrategy {
  private config: Required<QuickJSStrategyConfig>;
  private vm?: Awaited<ReturnType<typeof getQuickJS>>;
  private ctx?: QuickJSContextType;
  private strategyCtx?: StrategyContext;
  private initialized = false;

  // 状态管理
  private strategyState = new Map<string, any>();
  private stateFile: string;
  private flushTimer?: NodeJS.Timeout;

  // 生命周期跟踪
  private tickCount = 0;
  private bootTimeMs = 0;  // 策略启动时间（用于Order Reconcile过滤）

  // 数据缓存（用于同步 bridge 调用）
  private lastPrice = 0;
  private lastBar?: Kline;
  private cachedAccount?: Account;
  private cachedPositions: Map<string, Position> = new Map();
  private cachedOpenOrders: any[] = [];  // P2修复：缓存openOrders（遗留订单检测）
  private cachedExecutions: any[] = [];  // P1修复：缓存成交记录（策略账本重建）
  
  // P2修复：缓存就绪门闸（bot-009建议）
  private cacheReady = false;

  // P2新增：模拟成交PnL追踪
  private simTrades: Array<{
    price: number;
    qty: number;
    side: 'BUY' | 'SELL';
    symbol: string;
    timestamp: number;
    pnl: number;
  }> = [];
  private simPosition: {
    symbol: string;
    side: 'LONG' | 'SHORT' | 'FLAT';
    qty: number;
    avgPrice: number;
  } = { symbol: '', side: 'FLAT', qty: 0, avgPrice: 0 };
  private runningSimPnl = 0;

  // P1新增：资金费检测状态
  private fundingRateCache: Map<string, { fundingRate: number; nextFundingTime: number; timestamp: number }> = new Map();
  private lastFundingFeeCheck: number = 0;

  // bridge_scheduleAt 定时任务注册表
  private scheduleRegistry: Map<string, { nextTrigger: number; callbackName: string; scheduleType: string }> = new Map();

  // P2新增：K线缓存（用于检测K线更新，触发st_prepareIndicators）
  private cachedKlines: any[] = [];
  private lastKlineTimestamp: number = 0;

  // bar 缓存层（历史K线 REST→ndtsdb，不影响WS tick路径）
  private barCache = new BarCacheLayer({
    logger: (msg) => logger.info(`[BarCache] ${msg}`),
  });
  
  // 待处理订单队列（异步执行）
  private pendingOrders: Array<{
    params: any;
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }> = [];

  // 错误隔离
  private errorCount = 0;

  // P0: 订单状态管理器
  private orderStateManager: OrderStateManager;
  // P1: 遗留订单追踪器（自动消警）
  private legacyOrderTracker?: LegacyOrderTracker;
  private lastError?: Error;
  private fileLastModified = 0;

  constructor(config: QuickJSStrategyConfig) {
    // 默认 state 目录：~/.quant-lab/state/ （支持环境变量覆盖）
    const defaultStateDir = process.env.QUANT_STATE_DIR || 
                           join(process.env.HOME || process.env.USERPROFILE || '.', '.quant-lab/state');
    
    this.config = {
      stateDir: defaultStateDir,
      timeoutMs: 60000,
      memoryLimitMB: 64,
      params: {},
      hotReload: false,
      maxRetries: 3,
      retryDelayMs: 5000,
      ...config,
    };

    this.stateFile = join(this.config.stateDir, `${this.config.strategyId}.json`);
    
    // 记录文件修改时间
    if (existsSync(this.config.strategyFile)) {
      this.fileLastModified = statSync(this.config.strategyFile).mtimeMs;
    }

    // P0: 初始化订单状态管理器
    this.orderStateManager = new OrderStateManager();
    this.orderStateManager.onAlert((alert) => {
      logger.error(`[QuickJSStrategy] 订单异常告警:`, alert);
    });
    
    // P1: 初始化遗留订单追踪器（从 state 恢复 runId）
    // 先加载状态，确保 strategyState 已填充
    this.loadState();
    const runId = this.strategyState.get('runId')?.toString() || Date.now().toString();
    this.legacyOrderTracker = new LegacyOrderTracker(runId, this.config.strategyId);
    logger.info(`[QuickJSStrategy] 遗留订单追踪器已初始化, runId=${runId}`);
  }

  /**
   * 初始化
   */
  async onInit(ctx: StrategyContext): Promise<void> {
    this.strategyCtx = ctx;
    this.bootTimeMs = Date.now();  // 记录启动时间（用于Order Reconcile过滤）

    logger.info(`[QuickJSStrategy] 初始化策略: ${this.config.strategyId}`);
    logger.info(`[QuickJSStrategy] 文件: ${this.config.strategyFile}`);

    // 启动热重载监听
    if (this.config.hotReload) {
      this.startHotReload();
    }

    // 初始化沙箱（带错误隔离）
    await this.initializeSandbox();
  }

  /**
   * 初始化沙箱（带错误隔离）
   */
  private async initializeSandbox(): Promise<void> {
    try {
      // 1. 创建 QuickJS VM
      this.vm = await getQuickJS();

      // 2. 创建上下文（带超时保护）
      const interruptCycles = 1024;
      this.ctx = this.vm.newContext({
        interruptHandler: shouldInterruptAfterDeadline(Date.now() + this.config.timeoutMs),
      });

      // 3. 加载状态
      this.loadState();

      // 4. 注入 bridge API
      if (!this.strategyCtx) throw new Error('StrategyContext not set');
      this.injectBridge(this.strategyCtx);

      // 5. 注入策略参数
      this.injectParams();

      // 6. 加载策略代码
      const code = readFileSync(this.config.strategyFile, 'utf-8');
      const result = this.ctx.evalCode(code, this.config.strategyFile);

      if (result.error) {
        const error = this.ctx.dump(result.error);
        result.error.dispose();
        throw new Error(`策略代码执行失败: ${JSON.stringify(error)}`);
      }
      result.value.dispose();

      // 6.5. P0 修复：在 st_init 之前刷新缓存，确保 bridge_getPosition 有数据
      // P1 修复：容错策略 - catch异常使用空缓存启动，避免SSL EOF导致进程退出
      try {
        await this.refreshCache(this.strategyCtx!);
      } catch (error: any) {
        logger.error(`[QuickJSStrategy] [Init] 缓存刷新失败，使用空缓存启动:`, error.message);
        logger.error(`[QuickJSStrategy] [Init] 策略将继续运行，onTick会定期重试刷新`);
        // P2修复：缓存未就绪门闸（bot-009建议）
        logger.error(`[QuickJSStrategy] [Init] [P2 GATE] cacheReady=false，禁止下单直到缓存刷新成功`);
        // 使用空缓存继续（稍后onTick每60心跳会重试）
      }

      // 7. 调用 st_init
      await this.callStrategyFunction('st_init');
      // P1修复：runId同步由bridge_onRunIdChange即时处理，无需此处代码

      this.initialized = true;
      this.errorCount = 0;
      this.lastError = undefined;
      
      logger.info(`[QuickJSStrategy] 策略初始化完成`);
    } catch (error: any) {
      this.errorCount++;
      this.lastError = error;
      logger.error(`[QuickJSStrategy] 初始化失败 (${this.errorCount}/${this.config.maxRetries}):`, error.message);
      
      // 自动重试
      if (this.errorCount < this.config.maxRetries!) {
        logger.info(`[QuickJSStrategy] ${this.config.retryDelayMs}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, this.config.retryDelayMs));
        await this.initializeSandbox();
      } else {
        throw new Error(`策略初始化失败，已重试 ${this.config.maxRetries} 次: ${error.message}`);
      }
    }
  }

  /**
   * 热重载监听
   */
  /**
   * 手动触发热重载（Day 2增强版）
   * 
   * 日志输出：策略ID/旧hash→新hash/触发人/时间戳
   */
  async reload(triggeredBy: string = 'manual'): Promise<{ success: boolean; oldHash: string; newHash: string; duration: number; error?: string }> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();
    
    // 计算旧版本hash
    const oldHash = this.calculateFileHash();
    
    logger.info(`[QuickJSStrategy] [RELOAD] =========================================`);
    logger.info(`[QuickJSStrategy] [RELOAD] 开始热重载`);
    logger.info(`[QuickJSStrategy] [RELOAD] 策略ID: ${this.config.strategyId}`);
    logger.info(`[QuickJSStrategy] [RELOAD] 触发人: ${triggeredBy}`);
    logger.info(`[QuickJSStrategy] [RELOAD] 时间戳: ${timestamp}`);
    logger.info(`[QuickJSStrategy] [RELOAD] 旧hash: ${oldHash}`);

    try {
      // 1. 保存完整状态快照（用于回滚）
      const snapshot = this.createSnapshot();
      snapshot.previousHash = oldHash;
      snapshot.triggeredBy = triggeredBy;
      snapshot.timestamp = Date.now();
      this.saveSnapshotForRollback(snapshot);
      logger.info(`[QuickJSStrategy] [RELOAD] 状态快照已创建`);

      // 2. 调用st_stop清理旧策略
      if (this.ctx && this.initialized) {
        await this.callStrategyFunction('st_stop').catch((err) => {
          logger.warn(`[QuickJSStrategy] st_stop失败:`, err.message);
        });
      }

      // 3. 释放旧QuickJS VM
      if (this.ctx) {
        this.ctx.dispose();
        this.ctx = undefined;
      }

      // 4. 重新初始化QuickJS VM + 加载策略文件
      this.initialized = false;
      await this.initializeSandbox();

      // 5. 计算新版本hash
      const newHash = this.calculateFileHash();
      logger.info(`[QuickJSStrategy] [RELOAD] 新hash: ${newHash}`);

      // 6. 恢复状态快照
      await this.restoreSnapshot(snapshot);

      // 7. 标记热重载模式（通过全局标志）
      if (this.ctx) {
        const hotReloadFlag = this.ctx.newNumber(1);
        this.ctx.setProp(this.ctx.global, '_hotReload', hotReloadFlag);
        hotReloadFlag.dispose();
      }

      // 8. 调用st_init（策略可检查_hotReload标志）
      if (this.strategyCtx) {
        await this.callStrategyFunction('st_init', this.strategyCtx);
      }
      // P1修复：runId同步由bridge_onRunIdChange即时处理

      const duration = Date.now() - startTime;
      
      logger.info(`[QuickJSStrategy] [RELOAD] 热重载完成 ✅ (${duration}ms)`);
      logger.info(`[QuickJSStrategy] [RELOAD] hash变化: ${oldHash} → ${newHash}`);
      logger.info(`[QuickJSStrategy] [RELOAD] =========================================`);

      return { success: true, oldHash, newHash, duration };
    } catch (error: any) {
      const duration = Date.now() - startTime;
      logger.error(`[QuickJSStrategy] [RELOAD] 热重载失败 ❌ (${duration}ms)`);
      logger.error(`[QuickJSStrategy] [RELOAD] 错误:`, error.message);
      logger.error(`[QuickJSStrategy] [RELOAD] =========================================`);
      throw error;
    }
  }

  /**
   * 计算策略文件hash
   */
  private calculateFileHash(): string {
    try {
      const content = readFileSync(this.config.strategyFile, 'utf-8');
      // 简单hash：取内容的前8位md5-like值
      let hash = 0;
      for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
      }
      return Math.abs(hash).toString(16).substring(0, 8);
    } catch (error) {
      return 'unknown';
    }
  }

  /**
   * 保存快照用于回滚
   */
  private saveSnapshotForRollback(snapshot: any): void {
    const snapshotDir = join(getHomeDir(), '.quant-lab', 'snapshots');
    if (!existsSync(snapshotDir)) {
      mkdirSync(snapshotDir, { recursive: true });
    }
    
    const filename = `${this.config.strategyId}-${snapshot.timestamp}.json`;
    const filepath = join(snapshotDir, filename);
    
    writeFileSync(filepath, JSON.stringify(snapshot, null, 2));
    logger.info(`[QuickJSStrategy] 快照已保存: ${filepath}`);
  }

  /**
   * 回滚到上一版本
   */
  async rollback(): Promise<{ success: boolean; restoredHash?: string; error?: string; rto: number }> {
    const startTime = Date.now();
    logger.info(`[QuickJSStrategy] [ROLLBACK] =========================================`);
    logger.info(`[QuickJSStrategy] [ROLLBACK] 开始回滚`);
    logger.info(`[QuickJSStrategy] [ROLLBACK] 策略ID: ${this.config.strategyId}`);
    
    try {
      // 获取上一版快照
      const snapshot = this.getPreviousSnapshot();
      if (!snapshot) {
        throw new Error('没有找到上一版快照');
      }
      
      logger.info(`[QuickJSStrategy] [ROLLBACK] 目标hash: ${snapshot.previousHash || 'unknown'}`);
      
      // 1. 调用st_stop清理当前策略
      if (this.ctx && this.initialized) {
        await this.callStrategyFunction('st_stop').catch((err) => {
          logger.warn(`[QuickJSStrategy] st_stop失败:`, err.message);
        });
      }

      // 2. 释放旧QuickJS VM
      if (this.ctx) {
        this.ctx.dispose();
        this.ctx = undefined;
      }

      // 3. 恢复上一版策略文件（从快照中的源代码）
      if (snapshot.sourceCode) {
        writeFileSync(this.config.strategyFile, snapshot.sourceCode);
        logger.info(`[QuickJSStrategy] [ROLLBACK] 策略文件已恢复`);
      }

      // 4. 重新初始化
      this.initialized = false;
      await this.initializeSandbox();

      // 5. 恢复状态
      await this.restoreSnapshot(snapshot);

      // 6. 调用st_init
      if (this.strategyCtx) {
        await this.callStrategyFunction('st_init', this.strategyCtx);
      }

      const duration = Date.now() - startTime;
      const rto = duration; // RTO = 实际恢复时间
      
      logger.info(`[QuickJSStrategy] [ROLLBACK] 回滚完成 ✅ (${duration}ms)`);
      logger.info(`[QuickJSStrategy] [ROLLBACK] RTO: ${rto}ms`);
      logger.info(`[QuickJSStrategy] [ROLLBACK] =========================================`);

      return { success: true, restoredHash: snapshot.previousHash, rto };
    } catch (error: any) {
      const duration = Date.now() - startTime;
      logger.error(`[QuickJSStrategy] [ROLLBACK] 回滚失败 ❌ (${duration}ms)`);
      logger.error(`[QuickJSStrategy] [ROLLBACK] 错误:`, error.message);
      logger.error(`[QuickJSStrategy] [ROLLBACK] =========================================`);
      return { success: false, error: error.message, rto: duration };
    }
  }

  /**
   * 获取上一版快照
   */
  private getPreviousSnapshot(): any | null {
    const snapshotDir = join(getHomeDir(), '.quant-lab', 'snapshots');
    if (!existsSync(snapshotDir)) {
      return null;
    }
    
    const files = require('fs').readdirSync(snapshotDir)
      .filter((f: string) => f.startsWith(`${this.config.strategyId}-`) && f.endsWith('.json'))
      .sort()
      .reverse();
    
    if (files.length < 2) {
      return null;
    }
    
    // 返回倒数第二个（上一版）
    const path = join(snapshotDir, files[1]);
    return JSON.parse(readFileSync(path, 'utf-8'));
  }

  private startHotReload(): void {
    logger.info(`[QuickJSStrategy] 启动热重载监听: ${this.config.strategyFile}`);

    watchFile(this.config.strategyFile, { interval: 2000 }, async (curr, prev) => {
      if (curr.mtimeMs !== this.fileLastModified) {
        logger.info(`[QuickJSStrategy] 检测到文件变化，触发自动重新加载...`);
        this.fileLastModified = curr.mtimeMs;

        try {
          // 使用新的reload()方法
          await this.reload();
        } catch (error: any) {
          logger.error(`[QuickJSStrategy] 自动热重载失败:`, error.message);
        }
      }
    });
  }

  /**
   * P1新增：检查并执行定时任务
   * 在每次心跳前调用，检查scheduleRegistry中是否有到期的任务
   */
  private checkAndExecuteScheduledTasks(): void {
    if (!this.ctx || this.scheduleRegistry.size === 0) return;
    
    const now = Date.now();
    const dueTasks: Array<{ callbackName: string; scheduleType: string; registryKey: string }> = [];
    
    // 检查所有注册的任务
    for (const [registryKey, task] of this.scheduleRegistry.entries()) {
      if (now >= task.nextTrigger) {
        dueTasks.push({ callbackName: task.callbackName, scheduleType: task.scheduleType, registryKey });
        
        // 更新下次触发时间
        let nextTrigger = task.nextTrigger;
        switch (task.scheduleType) {
          case 'HOURLY':
            nextTrigger += 3600000; // +1小时
            break;
          case 'DAILY_UTC':
            nextTrigger += 86400000; // +1天
            break;
          default:
            if (task.scheduleType.startsWith('EVERY_N_MIN:')) {
              const minutes = parseInt(task.scheduleType.split(':')[1], 10);
              nextTrigger += minutes * 60000;
            }
        }
        task.nextTrigger = nextTrigger;
        
        const nextTriggerStr = new Date(nextTrigger).toISOString();
        logger.info(`[QuickJSStrategy] 定时任务 ${registryKey} 下次触发: ${nextTriggerStr}`);
      }
    }
    
    // 执行到期的任务
    for (const task of dueTasks) {
      try {
        // 检查策略是否实现了对应的回调函数
        const fnHandle = this.ctx!.getProp(this.ctx!.global, task.callbackName);
        const fnType = this.ctx!.typeof(fnHandle);
        
        if (fnType === 'function') {
          logger.info(`[QuickJSStrategy] 执行定时任务: ${task.callbackName} (${task.scheduleType})`);
          const result = this.ctx!.callFunction(fnHandle, this.ctx!.undefined);
          fnHandle.dispose();
          
          if (result.error) {
            const errorMsg = this.ctx!.dump(result.error);
            logger.error(`[QuickJSStrategy] 定时任务 ${task.callbackName} 执行失败:`, errorMsg);
            result.error.dispose();
          } else {
            result.value.dispose();
          }
        } else {
          fnHandle.dispose();
          logger.warn(`[QuickJSStrategy] 定时任务回调函数不存在: ${task.callbackName}`);
        }
      } catch (error: any) {
        logger.error(`[QuickJSStrategy] 执行定时任务 ${task.callbackName} 异常:`, error.message);
      }
    }
  }

  /**
   * P2新增：调用策略的st_prepareIndicators准备指标
   * 只在K线更新时才调用，避免重复计算
   */
  private async prepareIndicators(symbol: string): Promise<void> {
    if (!this.ctx || !this.strategyCtx?.getKlines) return;
    
    try {
      // 获取K线数据（例如5分钟K线）
      const klines = await this.strategyCtx.getKlines(symbol, '5', 100);
      
      if (!klines || klines.length === 0) return;
      
      // 检测K线是否更新（比较最后一根K线的时间戳）
      const lastKline = klines[klines.length - 1];
      const lastTimestamp = lastKline?.timestamp || 0;
      
      if (lastTimestamp <= this.lastKlineTimestamp) {
        // K线未更新，跳过
        return;
      }
      
      // K线已更新，更新缓存
      this.lastKlineTimestamp = lastTimestamp;
      this.cachedKlines = klines;
      
      // 检查策略是否实现了st_prepareIndicators
      const fnHandle = this.ctx.getProp(this.ctx.global, 'st_prepareIndicators');
      const isFunction = this.ctx.typeof(fnHandle) === 'function';
      
      if (isFunction) {
        const klinesJson = JSON.stringify(klines);
        const argHandle = this.ctx.newString(klinesJson);
        const result = this.ctx.callFunction(fnHandle, this.ctx.undefined, argHandle);
        
        fnHandle.dispose();
        argHandle.dispose();
        
        if (result.error) {
          const errorMsg = this.ctx.dump(result.error);
          logger.warn(`[QuickJSStrategy] st_prepareIndicators 执行失败:`, errorMsg);
          result.error.dispose();
        } else {
          result.value.dispose();
          logger.debug(`[QuickJSStrategy] st_prepareIndicators 执行成功 (${klines.length} 根K线)`);
        }
      } else {
        fnHandle.dispose();
        // 策略未实现st_prepareIndicators，静默跳过
      }
    } catch (error: any) {
      logger.warn(`[QuickJSStrategy] prepareIndicators 失败:`, error.message);
    }
  }

  /**
   * K线更新
   */
  async onBar(bar: Kline, ctx: StrategyContext): Promise<void> {
    if (!this.initialized) return;

    try {

    this.tickCount++;

    // 更新缓存
    this.lastPrice = bar.close;
    this.lastBar = bar;

    // 刷新账户和持仓缓存（每10根K线刷新一次）
    if (this.tickCount % 10 === 0) {
      await this.refreshCache(ctx);
    }

    // 构造 tick 对象
    const tick = {
      count: this.tickCount,
      timestamp: bar.timestamp,
      price: bar.close,
      volume: bar.volume,
    };

      // P1新增：资金费检测（在heartbeat之前）
      await this.checkAndNotifyFundingFee(bar.symbol || 'UNKNOWN');

      // P1新增：检查并执行定时任务（在heartbeat之前）
      this.checkAndExecuteScheduledTasks();

      // P2新增：准备指标数据（只在K线更新时调用）
      await this.prepareIndicators(bar.symbol || 'UNKNOWN');

      // 调用 st_heartbeat
      await this.callStrategyFunction('st_heartbeat', tick);

      // 处理待处理订单
      await this.processPendingOrders();
    } catch (error: any) {
      this.errorCount++;
      this.lastError = error;
      logger.error(`[QuickJSStrategy] onBar 错误 (${this.errorCount}):`, error.message);

      // 错误隔离：记录但不中断
      if (this.errorCount > 10) {
        logger.error(`[QuickJSStrategy] 错误次数过多，尝试重启沙箱...`);
        await this.recoverSandbox();
      }
    }
  }

  /**
   * 沙箱恢复（错误后重启）
   */
  private async recoverSandbox(): Promise<void> {
    logger.info(`[QuickJSStrategy] 开始沙箱恢复...`);

    try {
      // 清理旧沙箱
      if (this.ctx) {
        this.ctx.dispose();
        this.ctx = undefined;
      }

      // 重置状态
      this.initialized = false;
      this.errorCount = 0;

      // 重新初始化
      await this.initializeSandbox();

      logger.info(`[QuickJSStrategy] 沙箱恢复成功`);
    } catch (error: any) {
      logger.error(`[QuickJSStrategy] 沙箱恢复失败:`, error.message);
      throw error;
    }
  }

  /**
   * Tick 更新（可选）
   */
  async onTick?(tick: any, ctx: StrategyContext): Promise<void> {
    if (!this.initialized) return;

    this.tickCount++;

    // 更新价格缓存
    this.lastPrice = tick.price;

    // P0 修复：周期性刷新持仓缓存（每60心跳=5分钟）
    if (this.tickCount % 60 === 0) {
      const wasReady = this.cacheReady;
      try {
        await this.refreshCache(ctx);
        logger.info(`[QuickJSStrategy] [Cache Refresh] 持仓缓存已刷新 (tick #${this.tickCount})`);
        // P2修复：缓存刷新成功后记录门闸状态变化（bot-009建议）
        if (!wasReady && this.cacheReady) {
          logger.info(`[QuickJSStrategy] [P2 GATE] cacheReady: false → true，允许下单`);
        }
      } catch (error: any) {
        logger.error(`[QuickJSStrategy] [Cache Refresh] 刷新失败:`, error.message);
        // P2修复：缓存刷新失败后记录门闸状态（bot-009建议）
        if (wasReady && !this.cacheReady) {
          logger.error(`[QuickJSStrategy] [P2 GATE] cacheReady: true → false，禁止下单`);
        }
      }
      
      // P2修复：订单闭环对账（bot-009/鲶鱼建议）
      await this.reconcileOrders(ctx);
    }

    // P1新增：检查并执行定时任务（在heartbeat之前）
    this.checkAndExecuteScheduledTasks();

    // 调用 st_heartbeat
    await this.callStrategyFunction('st_heartbeat', {
      count: this.tickCount,
      timestamp: tick.timestamp,
      price: tick.price,
      volume: 0,
    });

    // 处理待处理订单
    await this.processPendingOrders();

    // P1新增：动态止损检查
    await this.checkAndExecuteStoploss();
  }

  /**
   * P0-3: 订单更新（通知策略）
   */
  async onOrder?(order: Order, ctx: StrategyContext): Promise<void> {
    if (!this.initialized || !this.ctx || !this.rt) {
      return;
    }

    // 检查策略是否定义了 st_onOrderUpdate 函数
    const globalHandle = this.ctx.global;
    const stOnOrderUpdateHandle = this.ctx.getProp(globalHandle, 'st_onOrderUpdate');
    const isFunction = this.ctx.typeof(stOnOrderUpdateHandle) === 'function';
    stOnOrderUpdateHandle.dispose();

    if (!isFunction) {
      // 策略没有定义 st_onOrderUpdate，跳过
      return;
    }

    try {
      // 调用 st_onOrderUpdate(order)
      const orderJson = JSON.stringify(order);
      const code = `st_onOrderUpdate(${orderJson})`;
      const result = this.ctx.evalCode(code);
      
      if (result.error) {
        const errorMsg = this.ctx.dump(result.error);
        logger.error(`[QuickJSStrategy] st_onOrderUpdate 执行失败:`, errorMsg);
        result.error.dispose();
      } else {
        result.value.dispose();
      }
    } catch (error: any) {
      logger.error(`[QuickJSStrategy] st_onOrderUpdate 调用异常:`, error.message);
    }
  }

  /**
   * P0 修复：通知策略订单更新（pending → 真实 orderId）
   */
  notifyOrderUpdate(orderUpdate: { orderId: string; gridId?: number; status?: string; cumQty?: number; avgPrice?: number }): void {
    if (!this.initialized || !this.ctx) {
      logger.warn(`[QuickJSStrategy] notifyOrderUpdate: 策略未初始化`);
      return;
    }

    logger.info(`[QuickJSStrategy] notifyOrderUpdate: 通知策略订单更新`, orderUpdate);

    try {
      // 调用沙箱里的 st_onOrderUpdate
      const orderJson = JSON.stringify(orderUpdate);
      const code = `st_onOrderUpdate(${orderJson})`;
      const result = this.ctx.evalCode(code);
      
      if (result.error) {
        const errorMsg = this.ctx.dump(result.error);
        logger.error(`[QuickJSStrategy] notifyOrderUpdate 执行失败:`, errorMsg);
        result.error.dispose();
      } else {
        logger.info(`[QuickJSStrategy] notifyOrderUpdate 执行成功`);
        result.value.dispose();
        
        // P0: 更新订单状态
        this.updateOrderStateFromNotification(orderUpdate);
      }
    } catch (error: any) {
      logger.error(`[QuickJSStrategy] notifyOrderUpdate 调用异常:`, error.message);
    }
  }

  /**
   * P0: 根据通知更新订单状态
   */
  private updateOrderStateFromNotification(orderUpdate: { 
    orderId: string; 
    orderLinkId?: string;
    status?: string; 
    cumQty?: number;
  }): void {
    const orderLinkId = orderUpdate.orderLinkId || orderUpdate.orderId;
    if (!orderLinkId) return;
    
    const order = this.orderStateManager.getOrder(orderLinkId);
    if (!order) return;
    
    // 根据状态更新
    switch (orderUpdate.status) {
      case 'Filled':
        this.orderStateManager.updateState(orderLinkId, 'FILLED', {
          filledQty: orderUpdate.cumQty || order.qty,
        });
        break;
      case 'Cancelled':
      case 'Canceled':
        this.orderStateManager.updateState(orderLinkId, 'CANCELLED', {
          filledQty: orderUpdate.cumQty || 0,
        });
        break;
      case 'PartiallyFilled':
        this.orderStateManager.updateFill(orderLinkId, orderUpdate.cumQty || 0);
        break;
    }
  }

  /**
   * P1新增：检测并通知资金费结算
   * 在距nextFundingTime<60s时，调用策略JS的st_onFundingFee
   */
  private async checkAndNotifyFundingFee(symbol: string): Promise<void> {
    if (!this.strategyCtx?.getFundingRate) {
      return;
    }

    const now = Date.now();

    // 避免过于频繁的检查（至少间隔30秒）
    if (now - this.lastFundingFeeCheck < 30000) {
      return;
    }
    this.lastFundingFeeCheck = now;

    try {
      // 获取资金费率信息
      const { fundingRate, nextFundingTime } = await this.strategyCtx.getFundingRate(symbol);

      // 更新缓存
      this.fundingRateCache.set(symbol, { fundingRate, nextFundingTime, timestamp: now });

      // 计算距资金费结算的时间
      const timeToFundingMs = nextFundingTime - now;

      // 如果距离结算时间<60s，触发回调
      if (timeToFundingMs > 0 && timeToFundingMs < 60000) {
        logger.info(`[QuickJSStrategy] 资金费即将结算: ${symbol}, rate=${fundingRate}, timeToFunding=${timeToFundingMs}ms`);

        // 检查策略是否实现了st_onFundingFee
        if (!this.ctx) return;

        const globalHandle = this.ctx.global;
        const stOnFundingFeeHandle = this.ctx.getProp(globalHandle, 'st_onFundingFee');
        const isFunction = this.ctx.typeof(stOnFundingFeeHandle) === 'function';
        stOnFundingFeeHandle.dispose();

        if (isFunction) {
          const feeData = {
            symbol,
            fundingRate,
            nextFundingTime,
            timeToFundingMs,
          };

          const feeJson = JSON.stringify(feeData);
          const code = `st_onFundingFee(${feeJson})`;
          const result = this.ctx.evalCode(code);

          if (result.error) {
            const errorMsg = this.ctx.dump(result.error);
            logger.error(`[QuickJSStrategy] st_onFundingFee 执行失败:`, errorMsg);
            result.error.dispose();
          } else {
            logger.info(`[QuickJSStrategy] st_onFundingFee 执行成功: ${symbol}`);
            result.value.dispose();
          }
        }
      }
    } catch (error: any) {
      logger.warn(`[QuickJSStrategy] 检测资金费失败:`, error.message);
    }
  }

  /**
   * P1新增：动态止损检查与执行
   * 调用策略JS的st_customStoploss并根据返回值执行减仓
   */
  private async checkAndExecuteStoploss(): Promise<void> {
    if (!this.ctx || !this.cachedPositions) return;

    // 检查策略是否实现了st_customStoploss
    const globalHandle = this.ctx.global;
    const stCustomStoplossHandle = this.ctx.getProp(globalHandle, 'st_customStoploss');
    const isFunction = this.ctx.typeof(stCustomStoplossHandle) === 'function';
    stCustomStoplossHandle.dispose();

    if (!isFunction) {
      return; // 策略未实现，跳过
    }

    for (const [symbol, position] of this.cachedPositions.entries()) {
      if (!position || position.quantity === 0) continue;

      try {
        // 计算持仓时长（基于第一个订单时间）
        const now = Date.now();
        const positionEntryTime = this.getPositionEntryTime(symbol);
        const holdingMinutes = positionEntryTime > 0 
          ? Math.floor((now - positionEntryTime) / 60000) 
          : 0;

        // 构造止损数据
        const stoplossData = {
          symbol,
          position: position.quantity,
          entryPrice: position.entryPrice,
          currentPrice: position.currentPrice,
          holdingMinutes,
          unrealizedPnl: position.unrealizedPnl,
          unrealizedPnlPct: position.entryPrice > 0 
            ? (position.currentPrice - position.entryPrice) / position.entryPrice * (position.side === 'SHORT' ? -1 : 1)
            : 0,
        };

        // 调用策略的st_customStoploss
        const code = `st_customStoploss(${JSON.stringify(stoplossData)})`;
        const result = this.ctx!.evalCode(code);

        if (result.error) {
          const errorMsg = this.ctx!.dump(result.error);
          logger.error(`[QuickJSStrategy] st_customStoploss 执行失败:`, errorMsg);
          result.error.dispose();
          continue;
        }

        const stoplossThreshold = this.ctx!.dump(result.value);
        result.value.dispose();

        // 检查是否触发止损
        if (stoplossData.unrealizedPnlPct < stoplossThreshold) {
          logger.warn(`[动态止损] ${symbol} 触发止损: 当前盈亏=${(stoplossData.unrealizedPnlPct * 100).toFixed(2)}% 阈值=${(stoplossThreshold * 100).toFixed(2)}%`);
          
          // 执行减仓（市价单平掉全部或部分仓位）
          await this.executeStoplossOrder(symbol, position);
        }
      } catch (error: any) {
        logger.error(`[QuickJSStrategy] 动态止损检查失败 ${symbol}:`, error.message);
      }
    }
  }

  /**
   * P1新增：获取持仓首次入场时间
   */
  private getPositionEntryTime(symbol: string): number {
    // 从订单历史中找到该品种最早的成交订单
    const orders = this.orderStateManager.getAllOrders();
    let earliestTime = 0;
    
    for (const order of orders) {
      if (order.product === symbol && order.state === 'FILLED' && order.updatedAt) {
        if (earliestTime === 0 || order.updatedAt < earliestTime) {
          earliestTime = order.updatedAt;
        }
      }
    }
    
    return earliestTime;
  }

  /**
   * P1新增：执行止损订单
   */
  private async executeStoplossOrder(symbol: string, position: Position): Promise<void> {
    try {
      if (!this.strategyCtx) return;

      const closeSide = position.side === 'LONG' ? 'SELL' : 'BUY';
      const closeQty = Math.abs(position.quantity);

      logger.warn(`[动态止损执行] ${symbol} ${closeSide} ${closeQty} @ 市价`);

      if (closeSide === 'SELL') {
        await this.strategyCtx.sell(symbol, closeQty);
      } else {
        await this.strategyCtx.buy(symbol, closeQty);
      }

      logger.info(`[动态止损执行] ${symbol} 减仓成功`);
    } catch (error: any) {
      logger.error(`[动态止损执行] ${symbol} 减仓失败:`, error.message);
    }
  }

  /**
   * 通过orderId查找orderLinkId（P1修复：撤单成功后更新状态机）
   */
  private findOrderLinkIdByOrderId(orderId: string): string | undefined {
    const orders = this.orderStateManager.getAllOrders();
    for (const order of orders) {
      if (order.orderId === orderId) {
        return order.orderLinkId;
      }
    }
    return undefined;
  }

  /**
   * 热更新参数（不重启沙箱）
   */
  async updateParams(newParams: Record<string, any>): Promise<void> {
    if (!this.initialized || !this.ctx) {
      throw new Error('策略未初始化，无法更新参数');
    }

    logger.info(`[QuickJSStrategy] 热更新参数:`, newParams);

    // 1. 更新内部参数存储
    this.config.params = { ...this.config.params, ...newParams };

    // 2. 更新 QuickJS 上下文中的 ctx.strategy.params
    const ctxHandle = this.ctx.getProp(this.ctx.global, 'ctx');
    const strategyHandle = this.ctx.getProp(ctxHandle, 'strategy');
    const paramsHandle = this.ctx.newString(JSON.stringify(this.config.params));
    
    this.ctx.setProp(strategyHandle, 'params', paramsHandle);
    
    paramsHandle.dispose();
    strategyHandle.dispose();
    ctxHandle.dispose();

    // 3. 调用策略的参数更新回调
    try {
      await this.callStrategyFunction('st_onParamsUpdate', this.config.params);
      logger.info(`[QuickJSStrategy] 参数更新完成`);
    } catch (error: any) {
      logger.warn(`[QuickJSStrategy] 策略未实现 st_onParamsUpdate:`, error.message);
    }

    // 4. 保存状态
    this.flushState();
  }

  /**
   * 停止
   */
  async onStop(ctx: StrategyContext): Promise<void> {
    logger.info(`[QuickJSStrategy] 停止策略: ${this.config.strategyId}`);

    // 停止热重载监听
    if (this.config.hotReload) {
      unwatchFile(this.config.strategyFile);
      logger.info(`[QuickJSStrategy] 已停止热重载监听`);
    }

    // 调用 st_stop（如果存在）
    await this.callStrategyFunction('st_stop').catch(() => {});

    // 刷新状态
    this.flushState();

    // 清理 QuickJS 上下文
    if (this.ctx) {
      this.ctx.dispose();
      this.ctx = undefined;
    }

    // vm 不需要手动 dispose（自动回收）
    this.vm = undefined;
  }

  /**
   * 刷新缓存（账户 + 持仓）
   * P0 修复：支持 BybitStrategyContext 的异步 API
   */
  private async refreshCache(ctx: StrategyContext): Promise<void> {
    try {
      // 检测 ctx 类型：如果有 getAccountAsync，说明是 BybitStrategyContext
      const hasAsyncAPI = 'getAccountAsync' in ctx && typeof (ctx as any).getAccountAsync === 'function';
      
      if (hasAsyncAPI) {
        // BybitStrategyContext: 使用异步 API
        this.cachedAccount = await (ctx as any).getAccountAsync();
        
        // 获取所有持仓
        const positions = await (ctx as any).getPositionsAsync();
        this.cachedPositions.clear();
        for (const pos of positions) {
          // P0 修复：同时存储两种 symbol 格式（兼容带/不带斜杠）
          this.cachedPositions.set(pos.symbol, pos);
          
          // 如果 symbol 包含斜杠（如 MYX/USDT），也存储无斜杠版本（MYXUSDT）
          if (pos.symbol.includes('/')) {
            const noSlash = pos.symbol.replace('/', '');
            this.cachedPositions.set(noSlash, pos);
          }
          // 如果 symbol 以 USDT 结尾且不含斜杠（如 MYXUSDT），也存储带斜杠版本（MYX/USDT）
          else if (pos.symbol.endsWith('USDT') && pos.symbol.length > 4) {
            const withSlash = `${pos.symbol.slice(0, -4)}/${pos.symbol.slice(-4)}`;
            this.cachedPositions.set(withSlash, pos);
          }
          
          logger.info(`[QuickJSStrategy] 持仓缓存: symbol=${pos.symbol}, quantity=${pos.quantity}`);
        }
        
        logger.info(`[QuickJSStrategy] 缓存刷新成功: ${positions.length} 个持仓`);
      } else {
        // LiveEngine/BacktestEngine: 使用同步 API
        this.cachedAccount = ctx.getAccount();
        
        // LiveEngine 没有 getPositions() 方法，需要从 Account 获取
        const account = this.cachedAccount;
        this.cachedPositions.clear();
        for (const pos of account.positions) {
          // P0 修复：同时存储两种 symbol 格式（兼容带/不带斜杠）
          this.cachedPositions.set(pos.symbol, pos);
          
          // 如果 symbol 包含斜杠（如 MYX/USDT），也存储无斜杠版本（MYXUSDT）
          if (pos.symbol.includes('/')) {
            const noSlash = pos.symbol.replace('/', '');
            this.cachedPositions.set(noSlash, pos);
          }
          // 如果 symbol 以 USDT 结尾且不含斜杠（如 MYXUSDT），也存储带斜杠版本（MYX/USDT）
          else if (pos.symbol.endsWith('USDT') && pos.symbol.length > 4) {
            const withSlash = `${pos.symbol.slice(0, -4)}/${pos.symbol.slice(-4)}`;
            this.cachedPositions.set(withSlash, pos);
          }
        }
        
        logger.info(`[QuickJSStrategy] 缓存刷新成功: ${account.positions.length} 个持仓`);
      }
      
      // P2修复：缓存刷新成功后设置门闸（bot-009建议）
      this.cacheReady = true;
    } catch (error: any) {
      logger.error(`[QuickJSStrategy] 缓存刷新失败:`, error.message);
      // P2修复：缓存刷新失败时门闸仍为false（bot-009建议）
      this.cacheReady = false;
      // P0 修复：抛出错误让调用者知道初始化失败
      throw error;
    }
  }

  /**
   * P2修复：订单闭环对账（bot-009/鲶鱼建议）
   */
  private async reconcileOrders(ctx: StrategyContext): Promise<void> {
    try {
      // 检测 ctx 类型：只有 BybitStrategyContext 有 getOpenOrders/getExecutions
      const hasOrderAPI = 'getOpenOrders' in ctx && typeof (ctx as any).getOpenOrders === 'function';
      
      if (!hasOrderAPI) {
        // LiveEngine/BacktestEngine 没有这些 API，跳过
        return;
      }
      
      // 拉取未完成订单
      const openOrders = await (ctx as any).getOpenOrders();
      this.cachedOpenOrders = openOrders;  // P2修复：缓存openOrders（遗留订单检测）
      logger.info(`[QuickJSStrategy] [Order Reconcile] 未完成订单: ${openOrders.length} 个`);
      
      if (openOrders.length > 0) {
        for (const order of openOrders.slice(0, 5)) {
          logger.info(`[QuickJSStrategy] [Order Reconcile] - orderId=${order.orderId}, orderLinkId=${order.orderLinkId}, symbol=${order.symbol}, side=${order.side}, qty=${order.qty}, price=${order.price}, status=${order.orderStatus}`);
        }
      }
      
      // 拉取成交记录（最近50条）
      // NOTE: Bybit API对execution/list的startTime有限制，报错"Can't query earlier than 2 years"
      // 临时回退不传startTime，恢复监控能力（TODO: 研究Bybit API文档找到正确用法）
      const executions = await (ctx as any).getExecutions();
      this.cachedExecutions = executions;
      logger.info(`[QuickJSStrategy] [Order Reconcile] 成交记录: ${executions.length} 个`);
      
      // P1修复：过滤只处理本策略execution（按策略方向前缀）
      const strategyId = this.config.strategyId || '';
      const direction = strategyId.split('-').pop() || 'neutral';
      const strategyPrefix = `gales-${direction}-`;
      const myExecutions = executions.filter((exec: any) => {
        if (!exec.orderLinkId) return false;
        return exec.orderLinkId.startsWith(strategyPrefix);
      });
      logger.info(`[QuickJSStrategy] [Order Reconcile] 本策略成交: ${myExecutions.length} 个 (过滤后)`);
      
      if (myExecutions.length > 0) {
        for (const exec of myExecutions.slice(0, 5)) {
          logger.info(`[QuickJSStrategy] [Order Reconcile] - execId=${exec.execId}, orderLinkId=${exec.orderLinkId}, symbol=${exec.symbol}, side=${exec.side}, execQty=${exec.execQty}, execPrice=${exec.execPrice}, execTime=${exec.execTime}`);
        }
        
        // NOTE: 不在Order Reconcile时处理历史executions，避免重复计算仓位
        // st_onExecution只在实时成交时通过WebSocket回调调用
      }
      
      // P0: 订单状态一致性检查
      this.checkOrderStateConsistency(openOrders);
      
      // P1: 遗留订单追踪（自动消警）
      if (this.legacyOrderTracker) {
        const alerts = this.legacyOrderTracker.check(openOrders);
        for (const alert of alerts) {
          logger.info(`[QuickJSStrategy] ${alert.message}`);
          // 发送 Telegram 告警（异步不阻塞）
          this.legacyOrderTracker.sendAlert(alert).catch(err => 
            logger.error(`[QuickJSStrategy] 遗留订单告警发送失败:`, err)
          );
        }
      }
      
      // P0: 启动异常单检测（首次调用）
      if (!this.orderStateManager['checkInterval']) {
        this.orderStateManager.startDetection(30000); // 30秒检测一次
      }
      
    } catch (error: any) {
      logger.error(`[QuickJSStrategy] [Order Reconcile] 对账失败:`, error.message);
      // 不抛出错误，避免影响策略运行
    }
  }
  
  /**
   * P0: 检查订单状态一致性
   */
  private checkOrderStateConsistency(exchangeOrders: any[]): void {
    const strategyOrders = this.orderStateManager.getActiveOrders();
    
    for (const strategyOrder of strategyOrders) {
      // 在交易所订单中查找
      const exchangeOrder = exchangeOrders.find(
        (e: any) => e.orderLinkId === strategyOrder.orderLinkId
      );
      
      if (!exchangeOrder) {
        // 策略有但交易所没有 - 可能已成交或已撤单
        // P1修复：不再标记ABNORMAL，而是标记为CANCELLED（假设已撤单）
        // 这是重挂/替换场景的正常情况：旧单被替换为新单(-0→-1)
        if (strategyOrder.state === 'SUBMITTED') {
          logger.warn(`[QuickJSStrategy] 订单在交易所不存在(假设已撤单): ${strategyOrder.orderLinkId}`);
          logger.warn(`  原状态: SUBMITTED → CANCELLED (重挂替换场景)`);
          this.orderStateManager.updateState(strategyOrder.orderLinkId, 'CANCELLED');
        }
        continue;
      }
      
      // 检查状态是否一致
      const check = this.orderStateManager.checkStateConsistency(
        strategyOrder,
        exchangeOrder.orderStatus
      );
      
      if (!check.consistent) {
        logger.warn(`[QuickJSStrategy] 订单状态不一致: ${strategyOrder.orderLinkId}`);
        logger.warn(`  策略状态: ${strategyOrder.state}`);
        logger.warn(`  交易所状态: ${exchangeOrder.orderStatus}`);
        
        // 延迟处理，给状态同步时间
        this.orderStateManager.handleInconsistency(
          strategyOrder.orderLinkId,
          exchangeOrder.orderStatus
        );
      }
    }
  }

  /**
   * 处理待处理订单（异步执行）
   */
  private async processPendingOrders(): Promise<void> {
    if (!this.strategyCtx) return;
    
    // P2修复：缓存就绪门闸检查（bot-009建议）
    if (!this.cacheReady) {
      logger.warn(`[QuickJSStrategy] [P2 GATE] 缓存未就绪，禁止下单（pending orders: ${this.pendingOrders.length}）`);
      logger.warn(`[QuickJSStrategy] [P2 GATE] 缓存刷新失败时未知真实仓位，强制拒绝下单避免风险`);
      
      // 拒绝所有pending orders
      const orders = [...this.pendingOrders];
      this.pendingOrders = [];
      for (const { reject } of orders) {
        reject(new Error('PositionCacheMissing: 缓存未就绪，禁止下单'));
      }
      return;
    }
    
    const orders = [...this.pendingOrders];
    this.pendingOrders = [];

    for (const { params, resolve, reject } of orders) {
      try {
        // 防御性检查：symbol 必须有效
        if (!params.symbol || typeof params.symbol !== 'string') {
          throw new Error(`Invalid symbol: ${params.symbol}`);
        }
        if (!params.qty || params.qty <= 0) {
          throw new Error(`Invalid qty: ${params.qty}`);
        }

        let order: Order;
        
        logger.info(`[QuickJSStrategy] processPendingOrders: 下单参数`, params);
        logger.info(`[QuickJSStrategy] [P0 DEBUG] 准备调用 ${params.side}(symbol=${params.symbol}, qty=${params.qty}, price=${params.price}, orderLinkId=${params.orderLinkId})`);
        logger.info(`[QuickJSStrategy] [P0 DEBUG] gridId=${params.gridId}`);
        
        if (params.side === 'Buy') {
          order = await this.strategyCtx.buy(
            params.symbol,
            params.qty,
            params.price,
            params.orderLinkId,  // P0 修复：传递 orderLinkId（幂等性）
            params.reduceOnly    // P0修复：传递reduceOnly
          );
        } else {
          order = await this.strategyCtx.sell(
            params.symbol,
            params.qty,
            params.price,
            params.orderLinkId,  // P0 修复：传递 orderLinkId（幂等性）
            params.reduceOnly    // P0修复：传递reduceOnly
          );
        }

        logger.info(`[QuickJSStrategy] processPendingOrders: 下单成功`, { orderId: order.id, symbol: order.symbol, gridId: params.gridId });

        // P0 关键修复：下单成功后必须通知策略（回写真实 orderId）
        if (params.gridId) {
          this.notifyOrderUpdate({
            orderId: order.id,
            gridId: params.gridId,
            status: order.status,
            cumQty: order.filledQty || 0,
            avgPrice: order.avgPrice || order.price || 0,
          });
          logger.info(`[QuickJSStrategy] processPendingOrders: 已通知策略 gridId=${params.gridId} orderId=${order.id}`);
        }

        resolve({ orderId: order.id });
      } catch (error: any) {
        logger.error(`[QuickJSStrategy] processPendingOrders: 下单失败`, error);
        reject(error);
      }
    }
  }

  /**
   * 注入 bridge API
   */
  private injectBridge(ctx: StrategyContext): void {
    if (!this.ctx) return;

    const vm = this.vm!;

    // bridge_log
    const bridge_log = this.ctx.newFunction('bridge_log', (levelHandle, messageHandle) => {
      const level = this.ctx!.getString(levelHandle);
      const message = this.ctx!.getString(messageHandle);
      logger.info(`[${this.config.strategyId}][${level}] ${message}`);
    });
    this.ctx.setProp(this.ctx.global, 'bridge_log', bridge_log);
    bridge_log.dispose();

    // bridge_stateGet
    const bridge_stateGet = this.ctx.newFunction('bridge_stateGet', (keyHandle, defaultHandle) => {
      const key = this.ctx!.getString(keyHandle);
      const defaultValue = this.ctx!.getString(defaultHandle);
      const value = this.strategyState.get(key);
      return this.ctx!.newString(value !== undefined ? JSON.stringify(value) : defaultValue);
    });
    this.ctx.setProp(this.ctx.global, 'bridge_stateGet', bridge_stateGet);
    bridge_stateGet.dispose();

    // bridge_stateSet
    const bridge_stateSet = this.ctx.newFunction('bridge_stateSet', (keyHandle, valueHandle) => {
      const key = this.ctx!.getString(keyHandle);
      const valueJson = this.ctx!.getString(valueHandle);
      this.strategyState.set(key, JSON.parse(valueJson));
      this.flushStateSoon();
    });
    this.ctx.setProp(this.ctx.global, 'bridge_stateSet', bridge_stateSet);
    bridge_stateSet.dispose();

    // bridge_getPrice - 获取最新价格
    const bridge_getPrice = this.ctx.newFunction('bridge_getPrice', (symbolHandle) => {
      const symbol = this.ctx!.getString(symbolHandle);
      // 返回缓存的最新价格
      return this.ctx!.newString(JSON.stringify({ price: this.lastPrice, symbol }));
    });
    this.ctx.setProp(this.ctx.global, 'bridge_getPrice', bridge_getPrice);
    bridge_getPrice.dispose();

    // bridge_getIndicator - 指标计算桥接（sma/ema/rsi/macd/bb/atr/stdDev/wma）
    const bridge_getIndicator = this.ctx.newFunction('bridge_getIndicator', (nameHandle, dataHandle, paramsHandle) => {
      const name = this.ctx!.getString(nameHandle);
      const dataJson = this.ctx!.getString(dataHandle);
      const paramsJson = this.ctx!.getString(paramsHandle);
      
      const data = JSON.parse(dataJson);
      const params = JSON.parse(paramsJson);
      
      let result: any;
      
      try {
        switch (name) {
          case 'sma':
            result = sma(data, params.period || 14);
            break;
          case 'ema':
            result = ema(data, params.period || 14);
            break;
          case 'rsi':
            result = rsi(data, params.period || 14);
            break;
          case 'macd':
            result = macd(data, params.fastPeriod || 12, params.slowPeriod || 26, params.signalPeriod || 9);
            break;
          case 'bb':
          case 'bollingerBands':
            result = bollingerBands(data, params.period || 20, params.stdDev || 2);
            break;
          case 'atr':
            // ATR需要high/low/close，这里简化处理：如果data是数组的数组，则解构
            if (Array.isArray(data) && data.length === 3 && Array.isArray(data[0])) {
              result = atr(data[0], data[1], data[2], params.period || 14);
            } else {
              throw new Error('atr requires [high[], low[], close[]] format');
            }
            break;
          case 'stdDev':
            result = stdDev(data, params.period || 14);
            break;
          case 'wma':
            result = wma(data, params.period || 14);
            break;
          default:
            throw new Error(`Unknown indicator: ${name}`);
        }
        return this.ctx!.newString(JSON.stringify({ success: true, data: result }));
      } catch (e: any) {
        return this.ctx!.newString(JSON.stringify({ success: false, error: e.message }));
      }
    });
    this.ctx.setProp(this.ctx.global, 'bridge_getIndicator', bridge_getIndicator);
    bridge_getIndicator.dispose();

    // bridge_getFundingRate - 获取资金费率
    const bridge_getFundingRate = this.ctx.newFunction('bridge_getFundingRate', (symbolHandle) => {
      const symbol = this.ctx!.getString(symbolHandle);
      
      // 返回 Promise handle（QuickJS async bridge）
      const promiseHandle = this.ctx!.newPromise();
      
      if (this.strategyCtx?.getFundingRate) {
        this.strategyCtx.getFundingRate(symbol).then((result) => {
          const response = JSON.stringify({ 
            fundingRate: result.fundingRate, 
            nextFundingTime: result.nextFundingTime,
            symbol 
          });
          promiseHandle.resolve(this.ctx!.newString(response));
          this.ctx!.runtime.executePendingJobs();
        }).catch((error: any) => {
          const response = JSON.stringify({ 
            fundingRate: 0, 
            nextFundingTime: 0,
            symbol,
            error: error.message 
          });
          promiseHandle.reject(this.ctx!.newString(response));
          this.ctx!.runtime.executePendingJobs();
        });
      } else {
        // 未实现时返回0值
        const response = JSON.stringify({ 
          fundingRate: 0, 
          nextFundingTime: 0,
          symbol 
        });
        promiseHandle.resolve(this.ctx!.newString(response));
        this.ctx!.runtime.executePendingJobs();
      }
      
      const h = promiseHandle.handle;
      promiseHandle.dispose();
      return h;
    });
    this.ctx.setProp(this.ctx.global, 'bridge_getFundingRate', bridge_getFundingRate);
    bridge_getFundingRate.dispose();

    // bridge_getBestBidAsk - 获取最优买卖价
    const bridge_getBestBidAsk = this.ctx.newFunction('bridge_getBestBidAsk', (symbolHandle) => {
      const symbol = this.ctx!.getString(symbolHandle);
      
      // 返回 Promise handle（QuickJS async bridge）
      const promiseHandle = this.ctx!.newPromise();
      
      if (this.strategyCtx?.getBestBidAsk) {
        this.strategyCtx.getBestBidAsk(symbol).then((result) => {
          const response = JSON.stringify({ 
            bid: result.bid, 
            ask: result.ask, 
            spread: result.spread,
            symbol 
          });
          promiseHandle.resolve(this.ctx!.newString(response));
          this.ctx!.runtime.executePendingJobs();
        }).catch((error: any) => {
          const response = JSON.stringify({ 
            bid: 0, 
            ask: 0, 
            spread: 0,
            symbol,
            error: error.message 
          });
          promiseHandle.reject(this.ctx!.newString(response));
          this.ctx!.runtime.executePendingJobs();
        });
      } else {
        // 未实现时基于lastPrice估算（假设spread为0.1%）
        const midPrice = this.lastPrice;
        const spreadPct = 0.001; // 0.1%
        const bid = midPrice * (1 - spreadPct / 2);
        const ask = midPrice * (1 + spreadPct / 2);
        const spread = ask - bid;
        
        const response = JSON.stringify({ 
          bid, 
          ask, 
          spread,
          symbol 
        });
        promiseHandle.resolve(this.ctx!.newString(response));
        this.ctx!.runtime.executePendingJobs();
      }
      
      const h = promiseHandle.handle;
      promiseHandle.dispose();
      return h;
    });
    this.ctx.setProp(this.ctx.global, 'bridge_getBestBidAsk', bridge_getBestBidAsk);
    bridge_getBestBidAsk.dispose();

    // bridge_getKlines - 获取历史K线（缓存层 → REST 回源）
    // 用于策略指标warmup；不影响WS tick实时路径
    // DISABLE_BAR_CACHE=1 → 直接REST bypass
    const bridge_getKlines = this.ctx.newFunction('bridge_getKlines', (symbolHandle, intervalHandle, limitHandle) => {
      const symbol   = this.ctx!.getString(symbolHandle);
      const interval = this.ctx!.getString(intervalHandle);
      const limit    = this.ctx!.getNumber(limitHandle) || 100;

      // 返回 Promise handle（QuickJS async bridge）
      const promiseHandle = this.ctx!.newPromise();

      // 异步执行：不阻塞事件循环
      this.barCache.getBars(symbol, interval, limit, async () => {
        if (typeof this.strategyCtx?.getKlines === 'function') {
          return await this.strategyCtx.getKlines(symbol, interval, limit);
        }
        throw new Error('bridge_getKlines: strategyCtx.getKlines not available (upgrade BybitStrategyContext)');
      }).then(({ bars, fromCache }) => {
        const result = JSON.stringify({ bars, fromCache, stats: this.barCache.getStats() });
        promiseHandle.resolve(this.ctx!.newString(result));
        this.ctx!.runtime.executePendingJobs();
      }).catch((e: Error) => {
        promiseHandle.reject(this.ctx!.newString(String(e)));
        this.ctx!.runtime.executePendingJobs();
      });

      const h = promiseHandle.handle;
      promiseHandle.dispose();
      return h;
    });
    this.ctx.setProp(this.ctx.global, 'bridge_getKlines', bridge_getKlines);
    bridge_getKlines.dispose();

    // bridge_getMultiKlines - 批量获取K线（并行请求多品种/多时间框架）
    const bridge_getMultiKlines = this.ctx.newFunction('bridge_getMultiKlines', (requestsHandle) => {
      const requestsJson = this.ctx!.getString(requestsHandle);
      const requests = JSON.parse(requestsJson) as Array<{symbol: string; interval: string; limit?: number}>;

      // 返回 Promise handle（QuickJS async bridge）
      const promiseHandle = this.ctx!.newPromise();

      // 并行执行所有K线请求
      const promises = requests.map(async (req) => {
        const { symbol, interval, limit = 100 } = req;
        const key = `${symbol}_${interval}`;

        try {
          const { bars, fromCache } = await this.barCache.getBars(symbol, interval, limit, async () => {
            if (typeof this.strategyCtx?.getKlines === 'function') {
              return await this.strategyCtx.getKlines(symbol, interval, limit);
            }
            throw new Error('bridge_getMultiKlines: strategyCtx.getKlines not available');
          });

          return { key, bars, fromCache, success: true };
        } catch (error: any) {
          return { key, bars: [], fromCache: false, success: false, error: error.message };
        }
      });

      Promise.all(promises).then((results) => {
        const resultMap: Record<string, { bars: any[]; fromCache: boolean; success: boolean; error?: string }> = {};
        for (const r of results) {
          resultMap[r.key] = { bars: r.bars, fromCache: r.fromCache, success: r.success, error: r.error };
        }
        const response = JSON.stringify(resultMap);
        promiseHandle.resolve(this.ctx!.newString(response));
        this.ctx!.runtime.executePendingJobs();
      }).catch((e: Error) => {
        promiseHandle.reject(this.ctx!.newString(String(e)));
        this.ctx!.runtime.executePendingJobs();
      });

      const h = promiseHandle.handle;
      promiseHandle.dispose();
      return h;
    });
    this.ctx.setProp(this.ctx.global, 'bridge_getMultiKlines', bridge_getMultiKlines);
    bridge_getMultiKlines.dispose();

    // bridge_getAccount - 获取账户信息
    const bridge_getAccount = this.ctx.newFunction('bridge_getAccount', () => {
      if (!this.cachedAccount) {
        return this.ctx!.newString(JSON.stringify({ balance: 0, equity: 0, availableMargin: 0 }));
      }
      return this.ctx!.newString(JSON.stringify(this.cachedAccount));
    });
    this.ctx.setProp(this.ctx.global, 'bridge_getAccount', bridge_getAccount);
    bridge_getAccount.dispose();

    // bridge_getPosition - 获取持仓
    const bridge_getPosition = this.ctx.newFunction('bridge_getPosition', (symbolHandle) => {
      const symbol = this.ctx!.getString(symbolHandle);
      const position = this.cachedPositions.get(symbol);
      
      // P0 调试日志
      logger.info(`[QuickJSStrategy] bridge_getPosition(${symbol}): found=${!!position}`);
      if (!position) {
        logger.info(`[QuickJSStrategy] bridge_getPosition: cachedPositions keys:`, Array.from(this.cachedPositions.keys()));
      }
      
      if (!position) {
        return this.ctx!.newString('null');
      }
      
      return this.ctx!.newString(JSON.stringify(position));
    });
    this.ctx.setProp(this.ctx.global, 'bridge_getPosition', bridge_getPosition);
    bridge_getPosition.dispose();

    // bridge_getAllPositions - 获取账户全部持仓（用于账户级风险指标）
    const bridge_getAllPositions = this.ctx.newFunction('bridge_getAllPositions', () => {
      return this.ctx!.newString(JSON.stringify(Array.from(this.cachedPositions.values())));
    });
    this.ctx.setProp(this.ctx.global, 'bridge_getAllPositions', bridge_getAllPositions);
    bridge_getAllPositions.dispose();

    // P2修复：bridge_getOpenOrders - 获取未完成订单（遗留订单检测）
    const bridge_getOpenOrders = this.ctx.newFunction('bridge_getOpenOrders', () => {
      logger.info(`[QuickJSStrategy] bridge_getOpenOrders: cached=${this.cachedOpenOrders.length} orders`);
      return this.ctx!.newString(JSON.stringify(this.cachedOpenOrders));
    });
    this.ctx.setProp(this.ctx.global, 'bridge_getOpenOrders', bridge_getOpenOrders);
    bridge_getOpenOrders.dispose();

    // P1修复：bridge_getExecutions - 获取最近成交（策略账本重建）
    const bridge_getExecutions = this.ctx.newFunction('bridge_getExecutions', () => {
      return this.ctx!.newString(JSON.stringify(this.cachedExecutions || []));
    });
    this.ctx.setProp(this.ctx.global, 'bridge_getExecutions', bridge_getExecutions);
    bridge_getExecutions.dispose();

    // bridge_placeOrder - 下单（队列化异步执行）
    const bridge_placeOrder = this.ctx.newFunction('bridge_placeOrder', (paramsHandle) => {
      const paramsJson = this.ctx!.getString(paramsHandle);
      const params = JSON.parse(paramsJson);

      logger.info(`[QuickJSStrategy] bridge_placeOrder 收到 paramsJson:`, paramsJson);
      logger.info(`[QuickJSStrategy] bridge_placeOrder 解析后 params:`, params);
      logger.info(`[QuickJSStrategy] [P0 DEBUG] gridId=${params.gridId}, orderLinkId=${params.orderLinkId}`);

      // P0: 注册订单到状态管理器
      if (params.orderLinkId) {
        this.orderStateManager.registerOrder({
          orderLinkId: params.orderLinkId,
          state: 'SUBMITTING',
          strategyId: this.config.strategyId,
          product: params.symbol,
          side: params.side,
          price: params.price,
          qty: params.qty,
          filledQty: 0,
        });
      }

      // 加入待处理队列（下次 tick 时执行）
      const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      
      this.pendingOrders.push({
        params,
        resolve: (result) => {
          logger.info(`[QuickJSStrategy] 下单成功:`, result);
          // P0: 更新订单状态为已提交
          if (params.orderLinkId) {
            this.orderStateManager.updateState(params.orderLinkId, 'SUBMITTED', {
              orderId: result.orderId,
            });
            // P1修复: 建立orderId到orderLinkId的映射
            if (result.orderId) {
              this.orderStateManager.setOrderId(params.orderLinkId, result.orderId);
            }
          }
        },
        reject: (error) => {
          logger.error(`[QuickJSStrategy] 下单失败:`, error.message);
          // P0: 更新订单状态为提交失败
          if (params.orderLinkId) {
            this.orderStateManager.updateState(params.orderLinkId, 'SUBMIT_FAILED', {
              error: error.message,
            });
          }
        },
      });

      // 返回临时 ID（实际 ID 会在下次 tick 时确定）
      return this.ctx!.newString(JSON.stringify({ orderId: tempId, status: 'pending' }));
    });
    this.ctx.setProp(this.ctx.global, 'bridge_placeOrder', bridge_placeOrder);
    bridge_placeOrder.dispose();

    // bridge_cancelOrder - 撤单（异步执行）
    const bridge_cancelOrder = this.ctx.newFunction('bridge_cancelOrder', (orderIdHandle) => {
      const orderId = this.ctx!.getString(orderIdHandle);
      logger.info(`[QuickJSStrategy] 撤单请求: ${orderId}`);

      // 异步执行撤单
      if (this.strategyCtx) {
        this.strategyCtx.cancelOrder(orderId).then((result: any) => {
          logger.info(`[QuickJSStrategy] 撤单成功: ${orderId}`);
          // P1修复：撤单成功后更新状态机
          // 尝试通过orderId查找orderLinkId
          const orderLinkId = this.findOrderLinkIdByOrderId(orderId);
          if (orderLinkId) {
            this.notifyOrderUpdate({ orderLinkId, orderId, status: 'Cancelled', cumQty: 0 });
          }
        }).catch((error: any) => {
          logger.error(`[QuickJSStrategy] 撤单失败:`, error.message);
        });
      }
    });
    this.ctx.setProp(this.ctx.global, 'bridge_cancelOrder', bridge_cancelOrder);
    bridge_cancelOrder.dispose();

    // bridge_amendOrder - 改单（异步执行）
    const bridge_amendOrder = this.ctx.newFunction('bridge_amendOrder', (orderIdHandle, priceHandle, qtyHandle) => {
      const orderId = this.ctx!.getString(orderIdHandle);
      const price = priceHandle ? this.ctx!.getNumber(priceHandle) : undefined;
      const qty = qtyHandle ? this.ctx!.getNumber(qtyHandle) : undefined;
      
      logger.info(`[QuickJSStrategy] 改单请求: ${orderId}, price=${price}, qty=${qty}`);

      // 返回 Promise handle（QuickJS async bridge）
      const promiseHandle = this.ctx!.newPromise();

      if (this.strategyCtx?.amendOrder) {
        this.strategyCtx.amendOrder(orderId, price, qty).then((result) => {
          logger.info(`[QuickJSStrategy] 改单成功: ${orderId}`);
          const response = JSON.stringify({ success: true, orderId: result.orderId });
          promiseHandle.resolve(this.ctx!.newString(response));
          this.ctx!.runtime.executePendingJobs();
        }).catch((error: any) => {
          logger.error(`[QuickJSStrategy] 改单失败:`, error.message);
          const response = JSON.stringify({ success: false, error: error.message });
          promiseHandle.reject(this.ctx!.newString(response));
          this.ctx!.runtime.executePendingJobs();
        });
      } else {
        // simMode或未实现：直接返回成功
        logger.info(`[QuickJSStrategy] 改单模拟模式: ${orderId}`);
        const response = JSON.stringify({ success: true, orderId });
        promiseHandle.resolve(this.ctx!.newString(response));
        this.ctx!.runtime.executePendingJobs();
      }

      const h = promiseHandle.handle;
      promiseHandle.dispose();
      return h;
    });
    this.ctx.setProp(this.ctx.global, 'bridge_amendOrder', bridge_amendOrder);
    bridge_amendOrder.dispose();

    // bridge_cancelAllOrders - 批量撤单（异步执行）
    const bridge_cancelAllOrders = this.ctx.newFunction('bridge_cancelAllOrders', (symbolHandle) => {
      const symbol = symbolHandle ? this.ctx!.getString(symbolHandle) : undefined;
      
      logger.info(`[QuickJSStrategy] 批量撤单请求: symbol=${symbol || 'all'}`);

      // 返回 Promise handle（QuickJS async bridge）
      const promiseHandle = this.ctx!.newPromise();

      if (this.strategyCtx?.cancelAllOrders) {
        this.strategyCtx.cancelAllOrders(symbol).then((result) => {
          logger.info(`[QuickJSStrategy] 批量撤单成功: ${result.cancelledCount} 单`);
          const response = JSON.stringify({ cancelledCount: result.cancelledCount });
          promiseHandle.resolve(this.ctx!.newString(response));
          this.ctx!.runtime.executePendingJobs();
        }).catch((error: any) => {
          logger.error(`[QuickJSStrategy] 批量撤单失败:`, error.message);
          const response = JSON.stringify({ cancelledCount: 0, error: error.message });
          promiseHandle.reject(this.ctx!.newString(response));
          this.ctx!.runtime.executePendingJobs();
        });
      } else {
        // simMode或未实现：清空本地openOrders
        logger.info(`[QuickJSStrategy] 批量撤单模拟模式: 清空 ${this.cachedOpenOrders.length} 单`);
        const count = this.cachedOpenOrders.length;
        this.cachedOpenOrders = [];
        const response = JSON.stringify({ cancelledCount: count });
        promiseHandle.resolve(this.ctx!.newString(response));
        this.ctx!.runtime.executePendingJobs();
      }

      const h = promiseHandle.handle;
      promiseHandle.dispose();
      return h;
    });
    this.ctx.setProp(this.ctx.global, 'bridge_cancelAllOrders', bridge_cancelAllOrders);
    bridge_cancelAllOrders.dispose();

    // P1新增：bridge_orderToTarget - 目标仓位下单
    const bridge_orderToTarget = this.ctx.newFunction('bridge_orderToTarget', (sideHandle, targetNotionalHandle) => {
      const side = this.ctx!.getString(sideHandle) as 'BUY' | 'SELL';
      const targetNotional = this.ctx!.getNumber(targetNotionalHandle);
      
      logger.info(`[QuickJSStrategy] 目标仓位下单: side=${side}, targetNotional=${targetNotional}`);

      // 返回 Promise handle（QuickJS async bridge）
      const promiseHandle = this.ctx!.newPromise();

      if (this.strategyCtx?.orderToTarget) {
        this.strategyCtx.orderToTarget(side, targetNotional).then((result) => {
          logger.info(`[QuickJSStrategy] 目标仓位下单成功: ${result.orderId}`);
          const response = JSON.stringify({ success: true, orderId: result.orderId, executedQty: result.executedQty });
          promiseHandle.resolve(this.ctx!.newString(response));
          this.ctx!.runtime.executePendingJobs();
        }).catch((error: any) => {
          logger.error(`[QuickJSStrategy] 目标仓位下单失败:`, error.message);
          const response = JSON.stringify({ success: false, error: error.message });
          promiseHandle.reject(this.ctx!.newString(response));
          this.ctx!.runtime.executePendingJobs();
        });
      } else {
        // 未实现时返回错误
        const response = JSON.stringify({ success: false, error: 'orderToTarget not available' });
        promiseHandle.reject(this.ctx!.newString(response));
        this.ctx!.runtime.executePendingJobs();
      }

      const h = promiseHandle.handle;
      promiseHandle.dispose();
      return h;
    });
    this.ctx.setProp(this.ctx.global, 'bridge_orderToTarget', bridge_orderToTarget);
    bridge_orderToTarget.dispose();

    // P2新增：bridge_recordSimTrade - 记录模拟成交并计算PnL
    const bridge_recordSimTrade = this.ctx.newFunction('bridge_recordSimTrade', (priceHandle, qtyHandle, sideHandle, symbolHandle) => {
      const price = this.ctx!.getNumber(priceHandle);
      const qty = this.ctx!.getNumber(qtyHandle);
      const side = this.ctx!.getString(sideHandle) as 'BUY' | 'SELL';
      const symbol = symbolHandle ? this.ctx!.getString(symbolHandle) : 'UNKNOWN';
      const timestamp = Date.now();
      
      // 计算本次成交PnL
      let tradePnl = 0;
      
      if (this.simPosition.side === 'FLAT' || this.simPosition.symbol !== symbol) {
        // 新开仓
        this.simPosition = { symbol, side: side === 'BUY' ? 'LONG' : 'SHORT', qty, avgPrice: price };
        tradePnl = 0;
      } else if (this.simPosition.side === 'LONG') {
        if (side === 'BUY') {
          // 加仓，更新均价
          const totalQty = this.simPosition.qty + qty;
          const totalCost = this.simPosition.qty * this.simPosition.avgPrice + qty * price;
          this.simPosition.avgPrice = totalCost / totalQty;
          this.simPosition.qty = totalQty;
          tradePnl = 0;
        } else {
          // 减仓/平仓，计算PnL
          const closeQty = Math.min(qty, this.simPosition.qty);
          tradePnl = (price - this.simPosition.avgPrice) * closeQty;
          this.simPosition.qty -= closeQty;
          if (this.simPosition.qty <= 0) {
            this.simPosition.side = 'FLAT';
            this.simPosition.qty = 0;
          }
        }
      } else if (this.simPosition.side === 'SHORT') {
        if (side === 'SELL') {
          // 加仓，更新均价
          const totalQty = this.simPosition.qty + qty;
          const totalCost = this.simPosition.qty * this.simPosition.avgPrice + qty * price;
          this.simPosition.avgPrice = totalCost / totalQty;
          this.simPosition.qty = totalQty;
          tradePnl = 0;
        } else {
          // 减仓/平仓，计算PnL
          const closeQty = Math.min(qty, this.simPosition.qty);
          tradePnl = (this.simPosition.avgPrice - price) * closeQty;
          this.simPosition.qty -= closeQty;
          if (this.simPosition.qty <= 0) {
            this.simPosition.side = 'FLAT';
            this.simPosition.qty = 0;
          }
        }
      }
      
      this.runningSimPnl += tradePnl;
      
      const trade = { price, qty, side, symbol, timestamp, pnl: tradePnl };
      this.simTrades.push(trade);
      
      // 保留最近1000条记录
      if (this.simTrades.length > 1000) {
        this.simTrades.shift();
      }
      
      logger.info(`[QuickJSStrategy] 模拟成交: ${symbol} ${side} ${qty}@${price}, PnL=${tradePnl.toFixed(4)}, 累计=${this.runningSimPnl.toFixed(4)}`);
      
      return this.ctx!.newString(JSON.stringify({ 
        success: true, 
        trade,
        runningPnl: this.runningSimPnl,
        position: this.simPosition 
      }));
    });
    this.ctx.setProp(this.ctx.global, 'bridge_recordSimTrade', bridge_recordSimTrade);
    bridge_recordSimTrade.dispose();

    // P2修复：bridge_tgSend - 发送Telegram通知
    // 2026-02-20 紧急策略：默认禁用策略系统直接调用 tg-cli，避免干扰；需显式开启 STRATEGY_TG_ENABLED=1
    const bridge_tgSend = this.ctx.newFunction('bridge_tgSend', (toHandle, messageHandle) => {
      const to = this.ctx!.getString(toHandle);
      const message = this.ctx!.getString(messageHandle);

      if (process.env.STRATEGY_TG_ENABLED !== '1') {
        logger.warn(`[QuickJSStrategy] bridge_tgSend blocked by policy (set STRATEGY_TG_ENABLED=1 to enable)`);
        return this.ctx!.newString('blocked');
      }
      
      try {
        // 调用tg命令发送消息
        const from = 'bot-001'; // 策略通知默认来自bot-001（投资组长）
        const cmd = `/usr/local/bin/tg send! ${from} ${to} "${message.replace(/"/g, '\\"')}"`;
        execSync(cmd, { encoding: 'utf-8', stdio: 'ignore' });
        logger.info(`[QuickJSStrategy] bridge_tgSend: ${from} → ${to}: ${message}`);
      } catch (error: any) {
        logger.error(`[QuickJSStrategy] bridge_tgSend failed:`, error.message);
      }
      
      return this.ctx!.newString('ok');
    });
    this.ctx.setProp(this.ctx.global, 'bridge_tgSend', bridge_tgSend);
    bridge_tgSend.dispose();

    // P0修复：bridge_onExecution - 成交明细回调
    const bridge_onExecution = this.ctx.newFunction('bridge_onExecution', (execJsonHandle) => {
      const execJson = this.ctx!.getString(execJsonHandle);
      
      // 调用策略的st_onExecution函数
      try {
        const fnHandle = this.ctx!.getProp(this.ctx!.global, 'st_onExecution');
        const fnType = this.ctx!.typeof(fnHandle);
        
        if (fnType === 'function') {
          const argHandle = this.ctx!.newString(execJson);
          const result = this.ctx!.callFunction(fnHandle, this.ctx!.undefined, argHandle);
          
          fnHandle.dispose();
          argHandle.dispose();
          
          if (result.error) {
            result.error.dispose();
          }
          result.value.dispose();
        } else {
          fnHandle.dispose();
        }
      } catch (error: any) {
        logger.error(`[QuickJSStrategy] bridge_onExecution failed:`, error.message);
      }
      
      return this.ctx!.newString('ok');
    });
    this.ctx.setProp(this.ctx.global, 'bridge_onExecution', bridge_onExecution);
    bridge_onExecution.dispose();
    
    // P1修复：bridge_onRunIdChange - runId变化时立即同步到tracker
    const bridge_onRunIdChange = this.ctx.newFunction('bridge_onRunIdChange', (runIdHandle) => {
      try {
        const newRunId = this.ctx!.getNumber(runIdHandle);
        if (!isNaN(newRunId) && this.legacyOrderTracker) {
          const runIdStr = String(newRunId);
          const prevRunId = (this.legacyOrderTracker as any).currentRunId || 'undefined';
          this.legacyOrderTracker.updateRunId(runIdStr);
          logger.info(`[QuickJSStrategy] bridge_onRunIdChange: ${prevRunId} -> ${runIdStr}`);
        }
      } catch (error: any) {
        logger.error(`[QuickJSStrategy] bridge_onRunIdChange failed:`, error.message);
      }
    });
    this.ctx.setProp(this.ctx.global, 'bridge_onRunIdChange', bridge_onRunIdChange);
    bridge_onRunIdChange.dispose();

    // bridge_scheduleAt - 通用定时任务注册
    const bridge_scheduleAt = this.ctx.newFunction('bridge_scheduleAt', (scheduleTypeHandle, callbackNameHandle) => {
      const scheduleType = this.ctx!.getString(scheduleTypeHandle);
      const callbackName = this.ctx!.getString(callbackNameHandle);
      
      const now = Date.now();
      let nextTrigger = 0;
      
      switch (scheduleType) {
        case 'HOURLY':
          // 下一个整点
          nextTrigger = new Date(now).setMinutes(0, 0, 0) + 3600000;
          break;
        case 'DAILY_UTC':
          // 下一个UTC 00:00
          const nowUtc = new Date(now);
          nextTrigger = Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate() + 1);
          break;
        default:
          // 解析 EVERY_N_MIN:30 格式
          if (scheduleType.startsWith('EVERY_N_MIN:')) {
            const minutes = parseInt(scheduleType.split(':')[1], 10);
            if (isNaN(minutes) || minutes <= 0) {
              logger.error(`[QuickJSStrategy] bridge_scheduleAt: 无效的时间间隔: ${scheduleType}`);
              return this.ctx!.newString(JSON.stringify({ success: false, error: 'Invalid interval' }));
            }
            // 对齐到分钟边界
            const currentMinute = Math.floor(now / 60000);
            const alignedMinute = Math.ceil((currentMinute + 1) / minutes) * minutes;
            nextTrigger = alignedMinute * 60000;
          } else {
            logger.error(`[QuickJSStrategy] bridge_scheduleAt: 未知的scheduleType: ${scheduleType}`);
            return this.ctx!.newString(JSON.stringify({ success: false, error: 'Unknown scheduleType' }));
          }
      }
      
      const registryKey = `${scheduleType}:${callbackName}`;
      this.scheduleRegistry.set(registryKey, { nextTrigger, callbackName, scheduleType });
      
      const nextTriggerStr = new Date(nextTrigger).toISOString();
      logger.info(`[QuickJSStrategy] bridge_scheduleAt: 注册定时任务 ${registryKey}, 下次触发: ${nextTriggerStr}`);
      
      return this.ctx!.newString(JSON.stringify({ success: true, nextTrigger, registryKey }));
    });
    this.ctx.setProp(this.ctx.global, 'bridge_scheduleAt', bridge_scheduleAt);
    bridge_scheduleAt.dispose();
  }

  /**
   * 注入策略参数
   */
  private injectParams(): void {
    if (!this.ctx) return;

    const ctxHandle = this.ctx.newObject();
    const strategyHandle = this.ctx.newObject();
    const paramsHandle = this.ctx.newString(JSON.stringify(this.config.params));

    this.ctx.setProp(strategyHandle, 'id', this.ctx.newString(this.config.strategyId));
    this.ctx.setProp(strategyHandle, 'params', paramsHandle);
    this.ctx.setProp(ctxHandle, 'strategy', strategyHandle);
    this.ctx.setProp(this.ctx.global, 'ctx', ctxHandle);

    ctxHandle.dispose();
    strategyHandle.dispose();
    paramsHandle.dispose();
  }

  /**
   * 调用策略函数
   */
  private async callStrategyFunction(name: string, ...args: any[]): Promise<any> {
    if (!this.ctx) return;

    const fnHandle = this.ctx.getProp(this.ctx.global, name);
    const fnType = this.ctx.typeof(fnHandle);

    if (fnType !== 'function') {
      fnHandle.dispose();
      return;
    }

    // 构造参数
    const argHandles = args.map(arg => this.ctx!.newString(JSON.stringify(arg)));

    // 调用函数
    const result = this.ctx.callFunction(fnHandle, this.ctx.undefined, ...argHandles);

    // 清理
    fnHandle.dispose();
    argHandles.forEach(h => h.dispose());

    if (result.error) {
      const error = this.ctx.dump(result.error);
      result.error.dispose();
      throw new Error(`策略函数 ${name} 执行失败: ${JSON.stringify(error)}`);
    }

    const value = this.ctx.dump(result.value);
    result.value.dispose();

    return value;
  }

  /**
   * 加载状态
   */
  private loadState(): void {
    if (!existsSync(this.config.stateDir)) {
      mkdirSync(this.config.stateDir, { recursive: true });
    }

    if (existsSync(this.stateFile)) {
      try {
        const raw = readFileSync(this.stateFile, 'utf-8');
        const obj = JSON.parse(raw || '{}');
        if (obj && typeof obj === 'object') {
          for (const [k, v] of Object.entries(obj)) {
            this.strategyState.set(k, v);
          }
          logger.info(`[QuickJSStrategy] 加载状态: ${Object.keys(obj).length} 个键`);
        }
      } catch (error: any) {
        logger.warn(`[QuickJSStrategy] 加载状态失败:`, error.message);
      }
    }
  }

  /**
   * 创建策略状态快照（用于热更新和回滚）
   */
  createSnapshot(): StrategySnapshot & { sourceCode?: string; previousHash?: string; triggeredBy?: string } {
    // 保存当前策略文件源代码（用于回滚）
    let sourceCode: string | undefined;
    try {
      sourceCode = readFileSync(this.config.strategyFile, 'utf-8');
    } catch (error) {
      logger.warn(`[QuickJSStrategy] 无法读取策略文件源代码:`, error);
    }

    return {
      timestamp: Date.now(),
      strategyId: this.config.strategyId,
      state: Object.fromEntries(this.strategyState.entries()),
      cachedAccount: this.cachedAccount,
      cachedPositions: Array.from(this.cachedPositions.entries()),
      cacheReady: this.cacheReady,
      tickCount: this.tickCount,
      lastPrice: this.lastPrice,
      lastBar: this.lastBar,
      sourceCode,  // 保存源代码用于回滚
    };
  }

  /**
   * 恢复策略状态快照（用于热更新）
   */
  async restoreSnapshot(snapshot: StrategySnapshot): Promise<void> {
    logger.info(`[QuickJSStrategy] 恢复快照: ${new Date(snapshot.timestamp).toISOString()}`);

    // 恢复策略状态
    this.strategyState.clear();
    for (const [k, v] of Object.entries(snapshot.state)) {
      this.strategyState.set(k, v);
    }

    // 恢复缓存
    this.cachedAccount = snapshot.cachedAccount;
    this.cachedPositions.clear();
    for (const [symbol, position] of snapshot.cachedPositions) {
      this.cachedPositions.set(symbol, position);
    }
    this.cacheReady = snapshot.cacheReady;

    // 恢复运行状态
    this.tickCount = snapshot.tickCount;
    this.lastPrice = snapshot.lastPrice;
    this.lastBar = snapshot.lastBar;

    // P1: 更新遗留订单追踪器的 runId（热更新后可能有新 runId）
    if (this.legacyOrderTracker && snapshot.state.runId) {
      this.legacyOrderTracker.updateRunId(snapshot.state.runId.toString());
    }

    logger.info(`[QuickJSStrategy] 快照恢复完成: ${Object.keys(snapshot.state).length} 个状态键`);
  }

  /**
   * 刷新状态（延迟写入）
   */
  private flushStateSoon(): void {
    if (this.flushTimer) return;

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushState();
    }, 250);
  }

  /**
   * 刷新状态（立即写入）
   */
  private flushState(): void {
    try {
      const out = Object.fromEntries(this.strategyState.entries());
      writeFileSync(this.stateFile, JSON.stringify(out, null, 2));
    } catch (error: any) {
      logger.warn(`[QuickJSStrategy] 写入状态失败:`, error.message);
    }
  }

  /**
   * P2新增：获取模拟PnL数据
   */
  getSimPnlData(): {
    trades: typeof this.simTrades;
    position: typeof this.simPosition;
    runningPnl: number;
    tradeCount: number;
  } {
    return {
      trades: this.simTrades,
      position: this.simPosition,
      runningPnl: this.runningSimPnl,
      tradeCount: this.simTrades.length,
    };
  }

  /**
   * P2新增：重置模拟PnL数据
   */
  resetSimPnl(): void {
    this.simTrades = [];
    this.simPosition = { symbol: '', side: 'FLAT', qty: 0, avgPrice: 0 };
    this.runningSimPnl = 0;
    logger.info(`[QuickJSStrategy] 模拟PnL已重置`);
  }
}
