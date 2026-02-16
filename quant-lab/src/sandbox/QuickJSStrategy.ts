// ============================================================
// QuickJS 沙箱策略运行器 (v3)
//
// 将 .js 策略文件包装成 Strategy 接口
// 支持热重载、状态持久化、安全隔离
// ============================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, watchFile, unwatchFile, statSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';
import type { QuickJSContext as QuickJSContextType } from 'quickjs-emscripten';
import type { Kline } from '../../../quant-lib/src';
import type { StrategyContext, Order, Position, Account } from '../engine/types';

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
  
  // P2修复：缓存就绪门闸（bot-009建议）
  private cacheReady = false;
  
  // 待处理订单队列（异步执行）
  private pendingOrders: Array<{
    params: any;
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }> = [];

  // 错误隔离
  private errorCount = 0;
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
  }

  /**
   * 初始化
   */
  async onInit(ctx: StrategyContext): Promise<void> {
    this.strategyCtx = ctx;
    this.bootTimeMs = Date.now();  // 记录启动时间（用于Order Reconcile过滤）

    console.log(`[QuickJSStrategy] 初始化策略: ${this.config.strategyId}`);
    console.log(`[QuickJSStrategy] 文件: ${this.config.strategyFile}`);

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
        console.error(`[QuickJSStrategy] [Init] 缓存刷新失败，使用空缓存启动:`, error.message);
        console.error(`[QuickJSStrategy] [Init] 策略将继续运行，onTick会定期重试刷新`);
        // P2修复：缓存未就绪门闸（bot-009建议）
        console.error(`[QuickJSStrategy] [Init] [P2 GATE] cacheReady=false，禁止下单直到缓存刷新成功`);
        // 使用空缓存继续（稍后onTick每60心跳会重试）
      }

      // 7. 调用 st_init
      await this.callStrategyFunction('st_init');

      this.initialized = true;
      this.errorCount = 0;
      this.lastError = undefined;
      
      console.log(`[QuickJSStrategy] 策略初始化完成`);
    } catch (error: any) {
      this.errorCount++;
      this.lastError = error;
      console.error(`[QuickJSStrategy] 初始化失败 (${this.errorCount}/${this.config.maxRetries}):`, error.message);
      
      // 自动重试
      if (this.errorCount < this.config.maxRetries!) {
        console.log(`[QuickJSStrategy] ${this.config.retryDelayMs}ms 后重试...`);
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
   * 手动触发热重载（Day 1实现）
   */
  async reload(): Promise<void> {
    console.log(`[QuickJSStrategy] 开始手动热重载: ${this.config.strategyFile}`);

    try {
      // 1. 保存完整状态快照
      const snapshot = this.createSnapshot();
      console.log(`[QuickJSStrategy] 状态快照已创建`);

      // 2. 调用st_stop清理旧策略
      if (this.ctx && this.initialized) {
        await this.callStrategyFunction('st_stop').catch((err) => {
          console.warn(`[QuickJSStrategy] st_stop失败:`, err.message);
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

      // 5. 恢复状态快照
      await this.restoreSnapshot(snapshot);

      // 6. 标记热重载模式（通过全局标志）
      if (this.ctx) {
        const hotReloadFlag = this.ctx.newNumber(1);
        this.ctx.setProp(this.ctx.global, '_hotReload', hotReloadFlag);
        hotReloadFlag.dispose();
      }

      // 7. 调用st_init（策略可检查_hotReload标志）
      if (this.strategyCtx) {
        await this.callStrategyFunction('st_init', this.strategyCtx);
      }

      console.log(`[QuickJSStrategy] 热重载完成 ✅`);
    } catch (error: any) {
      console.error(`[QuickJSStrategy] 热重载失败:`, error.message);
      throw error;
    }
  }

  private startHotReload(): void {
    console.log(`[QuickJSStrategy] 启动热重载监听: ${this.config.strategyFile}`);

    watchFile(this.config.strategyFile, { interval: 2000 }, async (curr, prev) => {
      if (curr.mtimeMs !== this.fileLastModified) {
        console.log(`[QuickJSStrategy] 检测到文件变化，触发自动重新加载...`);
        this.fileLastModified = curr.mtimeMs;

        try {
          // 使用新的reload()方法
          await this.reload();
        } catch (error: any) {
          console.error(`[QuickJSStrategy] 自动热重载失败:`, error.message);
        }
      }
    });
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

      // 调用 st_heartbeat
      await this.callStrategyFunction('st_heartbeat', tick);

      // 处理待处理订单
      await this.processPendingOrders();
    } catch (error: any) {
      this.errorCount++;
      this.lastError = error;
      console.error(`[QuickJSStrategy] onBar 错误 (${this.errorCount}):`, error.message);

      // 错误隔离：记录但不中断
      if (this.errorCount > 10) {
        console.error(`[QuickJSStrategy] 错误次数过多，尝试重启沙箱...`);
        await this.recoverSandbox();
      }
    }
  }

  /**
   * 沙箱恢复（错误后重启）
   */
  private async recoverSandbox(): Promise<void> {
    console.log(`[QuickJSStrategy] 开始沙箱恢复...`);

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

      console.log(`[QuickJSStrategy] 沙箱恢复成功`);
    } catch (error: any) {
      console.error(`[QuickJSStrategy] 沙箱恢复失败:`, error.message);
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
        console.log(`[QuickJSStrategy] [Cache Refresh] 持仓缓存已刷新 (tick #${this.tickCount})`);
        // P2修复：缓存刷新成功后记录门闸状态变化（bot-009建议）
        if (!wasReady && this.cacheReady) {
          console.log(`[QuickJSStrategy] [P2 GATE] cacheReady: false → true，允许下单`);
        }
      } catch (error: any) {
        console.error(`[QuickJSStrategy] [Cache Refresh] 刷新失败:`, error.message);
        // P2修复：缓存刷新失败后记录门闸状态（bot-009建议）
        if (wasReady && !this.cacheReady) {
          console.error(`[QuickJSStrategy] [P2 GATE] cacheReady: true → false，禁止下单`);
        }
      }
      
      // P2修复：订单闭环对账（bot-009/鲶鱼建议）
      await this.reconcileOrders(ctx);
    }

    // 调用 st_heartbeat
    await this.callStrategyFunction('st_heartbeat', {
      count: this.tickCount,
      timestamp: tick.timestamp,
      price: tick.price,
      volume: 0,
    });

    // 处理待处理订单
    await this.processPendingOrders();
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
        console.error(`[QuickJSStrategy] st_onOrderUpdate 执行失败:`, errorMsg);
        result.error.dispose();
      } else {
        result.value.dispose();
      }
    } catch (error: any) {
      console.error(`[QuickJSStrategy] st_onOrderUpdate 调用异常:`, error.message);
    }
  }

  /**
   * P0 修复：通知策略订单更新（pending → 真实 orderId）
   */
  notifyOrderUpdate(orderUpdate: { orderId: string; gridId?: number; status?: string; cumQty?: number; avgPrice?: number }): void {
    if (!this.initialized || !this.ctx) {
      console.warn(`[QuickJSStrategy] notifyOrderUpdate: 策略未初始化`);
      return;
    }

    console.log(`[QuickJSStrategy] notifyOrderUpdate: 通知策略订单更新`, orderUpdate);

    try {
      // 调用沙箱里的 st_onOrderUpdate
      const orderJson = JSON.stringify(orderUpdate);
      const code = `st_onOrderUpdate(${orderJson})`;
      const result = this.ctx.evalCode(code);
      
      if (result.error) {
        const errorMsg = this.ctx.dump(result.error);
        console.error(`[QuickJSStrategy] notifyOrderUpdate 执行失败:`, errorMsg);
        result.error.dispose();
      } else {
        console.log(`[QuickJSStrategy] notifyOrderUpdate 执行成功`);
        result.value.dispose();
      }
    } catch (error: any) {
      console.error(`[QuickJSStrategy] notifyOrderUpdate 调用异常:`, error.message);
    }
  }

  /**
   * 热更新参数（不重启沙箱）
   */
  async updateParams(newParams: Record<string, any>): Promise<void> {
    if (!this.initialized || !this.ctx) {
      throw new Error('策略未初始化，无法更新参数');
    }

    console.log(`[QuickJSStrategy] 热更新参数:`, newParams);

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
      console.log(`[QuickJSStrategy] 参数更新完成`);
    } catch (error: any) {
      console.warn(`[QuickJSStrategy] 策略未实现 st_onParamsUpdate:`, error.message);
    }

    // 4. 保存状态
    this.flushState();
  }

  /**
   * 停止
   */
  async onStop(ctx: StrategyContext): Promise<void> {
    console.log(`[QuickJSStrategy] 停止策略: ${this.config.strategyId}`);

    // 停止热重载监听
    if (this.config.hotReload) {
      unwatchFile(this.config.strategyFile);
      console.log(`[QuickJSStrategy] 已停止热重载监听`);
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
          
          console.log(`[QuickJSStrategy] 持仓缓存: symbol=${pos.symbol}, quantity=${pos.quantity}`);
        }
        
        console.log(`[QuickJSStrategy] 缓存刷新成功: ${positions.length} 个持仓`);
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
        
        console.log(`[QuickJSStrategy] 缓存刷新成功: ${account.positions.length} 个持仓`);
      }
      
      // P2修复：缓存刷新成功后设置门闸（bot-009建议）
      this.cacheReady = true;
    } catch (error: any) {
      console.error(`[QuickJSStrategy] 缓存刷新失败:`, error.message);
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
      console.log(`[QuickJSStrategy] [Order Reconcile] 未完成订单: ${openOrders.length} 个`);
      
      if (openOrders.length > 0) {
        for (const order of openOrders.slice(0, 5)) {
          console.log(`[QuickJSStrategy] [Order Reconcile] - orderId=${order.orderId}, orderLinkId=${order.orderLinkId}, symbol=${order.symbol}, side=${order.side}, qty=${order.qty}, price=${order.price}, status=${order.orderStatus}`);
        }
      }
      
      // 拉取成交记录（过滤startTime=bootTimeMs，避免历史数据）
      const executions = await (ctx as any).getExecutions(
        undefined,  // symbol
        'linear',   // category
        50,         // limit
        this.bootTimeMs  // startTime（过滤启动前的历史数据）
      );
      console.log(`[QuickJSStrategy] [Order Reconcile] 成交记录: ${executions.length} 个 (startTime=${this.bootTimeMs})`);
      
      if (executions.length > 0) {
        for (const exec of executions.slice(0, 5)) {
          console.log(`[QuickJSStrategy] [Order Reconcile] - execId=${exec.execId}, orderLinkId=${exec.orderLinkId}, symbol=${exec.symbol}, side=${exec.side}, execQty=${exec.execQty}, execPrice=${exec.execPrice}, execTime=${exec.execTime}`);
        }
      }
    } catch (error: any) {
      console.error(`[QuickJSStrategy] [Order Reconcile] 对账失败:`, error.message);
      // 不抛出错误，避免影响策略运行
    }
  }

  /**
   * 处理待处理订单（异步执行）
   */
  private async processPendingOrders(): Promise<void> {
    if (!this.strategyCtx) return;
    
    // P2修复：缓存就绪门闸检查（bot-009建议）
    if (!this.cacheReady) {
      console.warn(`[QuickJSStrategy] [P2 GATE] 缓存未就绪，禁止下单（pending orders: ${this.pendingOrders.length}）`);
      console.warn(`[QuickJSStrategy] [P2 GATE] 缓存刷新失败时未知真实仓位，强制拒绝下单避免风险`);
      
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
        
        console.log(`[QuickJSStrategy] processPendingOrders: 下单参数`, params);
        console.log(`[QuickJSStrategy] [P0 DEBUG] 准备调用 ${params.side}(symbol=${params.symbol}, qty=${params.qty}, price=${params.price}, orderLinkId=${params.orderLinkId})`);
        console.log(`[QuickJSStrategy] [P0 DEBUG] gridId=${params.gridId}`);
        
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

        console.log(`[QuickJSStrategy] processPendingOrders: 下单成功`, { orderId: order.id, symbol: order.symbol, gridId: params.gridId });

        // P0 关键修复：下单成功后必须通知策略（回写真实 orderId）
        if (params.gridId) {
          this.notifyOrderUpdate({
            orderId: order.id,
            gridId: params.gridId,
            status: order.status,
            cumQty: order.filledQty || 0,
            avgPrice: order.avgPrice || order.price || 0,
          });
          console.log(`[QuickJSStrategy] processPendingOrders: 已通知策略 gridId=${params.gridId} orderId=${order.id}`);
        }

        resolve({ orderId: order.id });
      } catch (error: any) {
        console.error(`[QuickJSStrategy] processPendingOrders: 下单失败`, error);
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
      console.log(`[${this.config.strategyId}][${level}] ${message}`);
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
      console.log(`[QuickJSStrategy] bridge_getPosition(${symbol}): found=${!!position}`);
      if (!position) {
        console.log(`[QuickJSStrategy] bridge_getPosition: cachedPositions keys:`, Array.from(this.cachedPositions.keys()));
      }
      
      if (!position) {
        return this.ctx!.newString('null');
      }
      
      return this.ctx!.newString(JSON.stringify(position));
    });
    this.ctx.setProp(this.ctx.global, 'bridge_getPosition', bridge_getPosition);
    bridge_getPosition.dispose();

    // bridge_placeOrder - 下单（队列化异步执行）
    const bridge_placeOrder = this.ctx.newFunction('bridge_placeOrder', (paramsHandle) => {
      const paramsJson = this.ctx!.getString(paramsHandle);
      const params = JSON.parse(paramsJson);

      console.log(`[QuickJSStrategy] bridge_placeOrder 收到 paramsJson:`, paramsJson);
      console.log(`[QuickJSStrategy] bridge_placeOrder 解析后 params:`, params);
      console.log(`[QuickJSStrategy] [P0 DEBUG] gridId=${params.gridId}, orderLinkId=${params.orderLinkId}`);

      // 加入待处理队列（下次 tick 时执行）
      const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      
      this.pendingOrders.push({
        params,
        resolve: (result) => {
          console.log(`[QuickJSStrategy] 下单成功:`, result);
        },
        reject: (error) => {
          console.error(`[QuickJSStrategy] 下单失败:`, error.message);
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
      console.log(`[QuickJSStrategy] 撤单请求: ${orderId}`);

      // 异步执行撤单
      if (this.strategyCtx) {
        this.strategyCtx.cancelOrder(orderId).catch((error) => {
          console.error(`[QuickJSStrategy] 撤单失败:`, error.message);
        });
      }
    });
    this.ctx.setProp(this.ctx.global, 'bridge_cancelOrder', bridge_cancelOrder);
    bridge_cancelOrder.dispose();

    // P2修复：bridge_tgSend - 发送Telegram通知
    const bridge_tgSend = this.ctx.newFunction('bridge_tgSend', (toHandle, messageHandle) => {
      const to = this.ctx!.getString(toHandle);
      const message = this.ctx!.getString(messageHandle);
      
      try {
        // 调用tg命令发送消息
        const from = 'bot-001'; // 策略通知默认来自bot-001（投资组长）
        const cmd = `/usr/local/bin/tg send! ${from} ${to} "${message.replace(/"/g, '\\"')}"`;
        execSync(cmd, { encoding: 'utf-8', stdio: 'ignore' });
        console.log(`[QuickJSStrategy] bridge_tgSend: ${from} → ${to}: ${message}`);
      } catch (error: any) {
        console.error(`[QuickJSStrategy] bridge_tgSend failed:`, error.message);
      }
      
      return this.ctx!.newString('ok');
    });
    this.ctx.setProp(this.ctx.global, 'bridge_tgSend', bridge_tgSend);
    bridge_tgSend.dispose();
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
          console.log(`[QuickJSStrategy] 加载状态: ${Object.keys(obj).length} 个键`);
        }
      } catch (error: any) {
        console.warn(`[QuickJSStrategy] 加载状态失败:`, error.message);
      }
    }
  }

  /**
   * 创建策略状态快照（用于热更新）
   */
  createSnapshot(): StrategySnapshot {
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
    };
  }

  /**
   * 恢复策略状态快照（用于热更新）
   */
  async restoreSnapshot(snapshot: StrategySnapshot): Promise<void> {
    console.log(`[QuickJSStrategy] 恢复快照: ${new Date(snapshot.timestamp).toISOString()}`);

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

    console.log(`[QuickJSStrategy] 快照恢复完成: ${Object.keys(snapshot.state).length} 个状态键`);
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
      console.warn(`[QuickJSStrategy] 写入状态失败:`, error.message);
    }
  }
}
