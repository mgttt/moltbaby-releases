// ============================================================
// QuickJS 沙箱策略运行器 (v3)
//
// 将 .js 策略文件包装成 Strategy 接口
// 支持热重载、状态持久化、安全隔离
// ============================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, watchFile, unwatchFile, statSync } from 'fs';
import { join } from 'path';
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';
import type { QuickJSContext as QuickJSContextType } from 'quickjs-emscripten';
import type { Kline } from 'quant-lib';
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

  // 数据缓存（用于同步 bridge 调用）
  private lastPrice = 0;
  private lastBar?: Kline;
  private cachedAccount?: Account;
  private cachedPositions: Map<string, Position> = new Map();
  
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
  private startHotReload(): void {
    console.log(`[QuickJSStrategy] 启动热重载监听: ${this.config.strategyFile}`);

    watchFile(this.config.strategyFile, { interval: 2000 }, async (curr, prev) => {
      if (curr.mtimeMs !== this.fileLastModified) {
        console.log(`[QuickJSStrategy] 检测到文件变化，重新加载...`);
        this.fileLastModified = curr.mtimeMs;

        try {
          // 清理旧沙箱
          if (this.ctx) {
            await this.callStrategyFunction('st_stop').catch(() => {});
            this.ctx.dispose();
            this.ctx = undefined;
          }

          // 重新初始化
          this.initialized = false;
          await this.initializeSandbox();

          console.log(`[QuickJSStrategy] 热重载完成`);
        } catch (error: any) {
          console.error(`[QuickJSStrategy] 热重载失败:`, error.message);
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
      try {
        await this.refreshCache(ctx);
        console.log(`[QuickJSStrategy] [Cache Refresh] 持仓缓存已刷新 (tick #${this.tickCount})`);
      } catch (error: any) {
        console.error(`[QuickJSStrategy] [Cache Refresh] 刷新失败:`, error.message);
      }
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
    } catch (error: any) {
      console.error(`[QuickJSStrategy] 缓存刷新失败:`, error.message);
      // P0 修复：抛出错误让调用者知道初始化失败
      throw error;
    }
  }

  /**
   * 处理待处理订单（异步执行）
   */
  private async processPendingOrders(): Promise<void> {
    if (!this.strategyCtx) return;
    
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
