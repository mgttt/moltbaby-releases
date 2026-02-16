#!/usr/bin/env bun
/**
 * Gales 策略 - QuickJS 沙箱版本 + Bybit 实盘
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHmac } from 'crypto';
import { spawnSync } from 'node:child_process';

// ============================================================
// 简化版 QuickJS 集成（独立运行，不依赖复杂类型系统）
// ============================================================

import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';

// ============================================================
// Bybit API 客户端
// ============================================================

class BybitClient {
  private apiKey: string;
  private apiSecret: string;
  private baseUrl = 'https://api.bybit.com';
  private proxy?: string;

  constructor(config: { apiKey: string; apiSecret: string; proxy?: string }) {
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.proxy = config.proxy;
  }

  async getTicker(symbol: string): Promise<{ lastPrice: number }> {
    const result = await this.request('GET', '/v5/market/tickers', {
      category: 'linear',
      symbol,
    });
    
    const ticker = result.result?.list?.[0];
    if (!ticker) throw new Error('Ticker not found');
    
    return { lastPrice: parseFloat(ticker.lastPrice) };
  }

  async placeOrder(params: {
    symbol: string;
    side: 'Buy' | 'Sell';
    qty: number;
    price: number;
    orderLinkId: string;
  }): Promise<{ orderId: string }> {
    const result = await this.request('POST', '/v5/order/create', {
      category: 'linear',
      symbol: params.symbol,
      side: params.side,
      orderType: 'Limit',
      qty: params.qty.toString(),
      price: params.price.toString(),
      orderLinkId: params.orderLinkId,
      timeInForce: 'PostOnly',
    });

    return { orderId: result.result.orderId };
  }

  async cancelOrder(symbol: string, orderId: string): Promise<void> {
    await this.request('POST', '/v5/order/cancel', {
      category: 'linear',
      symbol,
      orderId,
    });
  }

  async getOpenOrders(symbol?: string): Promise<any[]> {
    const params: Record<string, any> = {
      category: 'linear',
      openOnly: 0, // 0=all, 1=open only
      limit: 50,
    };
    
    if (symbol) params.symbol = symbol;
    
    const result = await this.request('GET', '/v5/order/realtime', params);
    return result.result?.list || [];
  }

  private async request(method: string, endpoint: string, params: Record<string, any>, retries = 3): Promise<any> {
    const timestamp = Date.now().toString();
    const recvWindow = '5000';

    let queryString = '';
    let body = '';

    if (method === 'GET') {
      queryString = Object.entries(params)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join('&');
    } else {
      const sorted: Record<string, any> = {};
      for (const [k, v] of Object.entries(params).sort(([a], [b]) => a.localeCompare(b))) {
        if (v !== undefined) sorted[k] = v;
      }
      body = JSON.stringify(sorted);
    }

    const signString = timestamp + this.apiKey + recvWindow + (method === 'GET' ? queryString : body);
    const signature = createHmac('sha256', this.apiSecret).update(signString).digest('hex');

    const url = `${this.baseUrl}${endpoint}${queryString ? '?' + queryString : ''}`;

    const args: string[] = [
      '-sS', '-X', method, url, '-m', '20',
      '-H', `X-BAPI-API-KEY: ${this.apiKey}`,
      '-H', `X-BAPI-SIGN: ${signature}`,
      '-H', `X-BAPI-SIGN-TYPE: 2`,
      '-H', `X-BAPI-TIMESTAMP: ${timestamp}`,
      '-H', `X-BAPI-RECV-WINDOW: ${recvWindow}`,
      '-H', 'Content-Type: application/json',
      '-H', 'Accept: application/json',
      '-H', 'User-Agent: quant-lab/3.0',
    ];

    if (this.proxy) args.push('-x', this.proxy);
    if (body && method !== 'GET') args.push('--data', body);

    // P0 修复：指数退避重试
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        // 显式pipe stderr（鲶鱼建议1）
        const res = spawnSync('curl', args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'], // stdin, stdout, stderr
        });

        const out = res.stdout || '';
        const err = res.stderr || '';

        // 成功但stderr非空：打结构化日志（鲶鱼建议2）
        if (res.status === 0 && err.trim()) {
          console.warn(
            `[Bybit] Curl success with stderr: ` +
            `method=${method} | ` +
            `url=${url} | ` +
            `stderr="${err.trim().slice(0, 150)}"`,
          );
        }

        // curl失败（非0退出码）
        if (res.status !== 0) {
          const errorMsg = err.trim() || res.error?.message || 'Unknown curl error';
          throw new Error(`Curl failed: ${errorMsg}`);
        }

        const result = JSON.parse(out);

        if (result.retCode !== 0) {
          throw new Error(`Bybit API error: ${result.retMsg}`);
        }

        return result;
      } catch (error: any) {
        const isLastAttempt = attempt === retries;
        const isNetworkError = error.message.includes('timeout') || 
                              error.message.includes('SSL') ||
                              error.message.includes('EOF') ||
                              error.message.includes('proxy');
        
        if (isNetworkError && !isLastAttempt) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 10000); // 1s, 2s, 4s, 8s, 10s
          console.warn(`[Bybit] 网络错误（${error.message.slice(0, 50)}），${delay}ms 后重试 (${attempt + 1}/${retries})...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          throw error;
        }
      }
    }

    throw new Error('Unreachable');
  }
}

// ============================================================
// QuickJS 策略引擎
// ============================================================

class QuickJSStrategyEngine {
  private vm?: Awaited<ReturnType<typeof getQuickJS>>;
  private ctx?: any;
  private client: BybitClient;
  private strategyFile: string;
  private lastPrice = 0;
  private running = false;
  private state = new Map<string, any>();
  private tickCount = 0;
  
  // P0 修复：订单 ID 映射与状态管理
  private orderIdMap = new Map<string, string>(); // pending → real orderId
  private orderSymbolMap = new Map<string, string>(); // orderId → symbol
  private openOrders = new Map<string, any>(); // orderId → order info
  private dryRun: boolean; // Paper Trade 模式

  constructor(client: BybitClient, strategyFile: string, dryRun = false) {
    this.client = client;
    this.strategyFile = strategyFile;
    this.dryRun = dryRun;
    
    console.log(`[QuickJS] 模式: ${dryRun ? 'Paper Trade (DRY RUN)' : 'Live Trading'}`);
  }

  async initialize() {
    console.log('[QuickJS] 初始化沙箱...');

    // 创建 VM
    this.vm = await getQuickJS();

    // 创建上下文
    this.ctx = this.vm.newContext({
      interruptHandler: shouldInterruptAfterDeadline(Date.now() + 60000),
    });

    // 注入 bridge API
    this.injectBridge();

    // 加载策略代码
    const code = readFileSync(this.strategyFile, 'utf-8');
    const result = this.ctx.evalCode(code, this.strategyFile);

    if (result.error) {
      const error = this.ctx.dump(result.error);
      result.error.dispose();
      throw new Error(`策略代码执行失败: ${JSON.stringify(error)}`);
    }
    result.value.dispose();

    console.log('[QuickJS] 策略代码加载成功');

    // 调用 st_init
    await this.callFunction('st_init');
    console.log('[QuickJS] 策略初始化完成');
  }

  private injectBridge() {
    // bridge_log
    const bridge_log = this.ctx.newFunction('bridge_log', (levelHandle: any, messageHandle: any) => {
      const level = this.ctx.getString(levelHandle);
      const message = this.ctx.getString(messageHandle);
      console.log(`[Strategy][${level}] ${message}`);
    });
    this.ctx.setProp(this.ctx.global, 'bridge_log', bridge_log);
    bridge_log.dispose();

    // bridge_stateGet/Set
    const bridge_stateGet = this.ctx.newFunction('bridge_stateGet', (keyHandle: any, defaultHandle: any) => {
      const key = this.ctx.getString(keyHandle);
      const defaultValue = this.ctx.getString(defaultHandle);
      const value = this.state.get(key);
      return this.ctx.newString(value !== undefined ? JSON.stringify(value) : defaultValue);
    });
    this.ctx.setProp(this.ctx.global, 'bridge_stateGet', bridge_stateGet);
    bridge_stateGet.dispose();

    const bridge_stateSet = this.ctx.newFunction('bridge_stateSet', (keyHandle: any, valueHandle: any) => {
      const key = this.ctx.getString(keyHandle);
      const valueJson = this.ctx.getString(valueHandle);
      this.state.set(key, JSON.parse(valueJson));
    });
    this.ctx.setProp(this.ctx.global, 'bridge_stateSet', bridge_stateSet);
    bridge_stateSet.dispose();

    // bridge_getPrice
    const bridge_getPrice = this.ctx.newFunction('bridge_getPrice', (symbolHandle: any) => {
      const symbol = this.ctx.getString(symbolHandle);
      return this.ctx.newString(JSON.stringify({ price: this.lastPrice, symbol }));
    });
    this.ctx.setProp(this.ctx.global, 'bridge_getPrice', bridge_getPrice);
    bridge_getPrice.dispose();

    // bridge_placeOrder（P0 修复：支持 DRY_RUN + 订单 ID 映射）
    const bridge_placeOrder = this.ctx.newFunction('bridge_placeOrder', (paramsHandle: any) => {
      const paramsJson = this.ctx.getString(paramsHandle);
      const params = JSON.parse(paramsJson);
      
      const pendingId = 'pending-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      
      if (this.dryRun) {
        // Paper Trade 模式：不调用真实 API
        console.log(`[bridge][DRY RUN] placeOrder:`, params);
        
        // 模拟订单（保存到 openOrders）
        const simulatedOrder = {
          orderId: pendingId,
          symbol: params.symbol,
          side: params.side,
          price: params.price,
          qty: params.qty,
          status: 'New',
          createdAt: Date.now(),
        };
        
        this.openOrders.set(pendingId, simulatedOrder);
        this.orderSymbolMap.set(pendingId, params.symbol);
        
        return this.ctx.newString(JSON.stringify({ orderId: pendingId, status: 'New' }));
      } else {
        // Live 模式：调用真实 API
        // 精度截断：MYX qtyStep=1（整数），tickSize=0.001（3位小数）
        params.qty = Math.floor(params.qty);
        params.price = Math.round(params.price * 1000) / 1000;
        
        if (params.qty < 1) {
          console.warn(`[bridge] 数量不足最小值 (${params.qty}), 跳过`);
          return this.ctx.newString(JSON.stringify({ orderId: 'skip', status: 'rejected', reason: 'qty < 1' }));
        }
        
        console.log(`[bridge][LIVE] placeOrder:`, params);
        
        // 异步下单（不阻塞策略）
        this.client.placeOrder(params)
          .then(result => {
            console.log(`[bridge] 下单成功:`, result);
            
            // 映射 pending → real orderId
            this.orderIdMap.set(pendingId, result.orderId);
            this.orderSymbolMap.set(result.orderId, params.symbol);
            
            // 保存订单信息
            this.openOrders.set(result.orderId, {
              orderId: result.orderId,
              symbol: params.symbol,
              side: params.side,
              price: params.price,
              qty: params.qty,
              status: 'New',
              createdAt: Date.now(),
            });
          })
          .catch(err => console.error(`[bridge] 下单失败:`, err.message));
        
        return this.ctx.newString(JSON.stringify({ orderId: pendingId, status: 'pending' }));
      }
    });
    this.ctx.setProp(this.ctx.global, 'bridge_placeOrder', bridge_placeOrder);
    bridge_placeOrder.dispose();

    // bridge_cancelOrder（P0 修复：支持 orderId → symbol 映射）
    const bridge_cancelOrder = this.ctx.newFunction('bridge_cancelOrder', (orderIdHandle: any) => {
      const orderId = this.ctx.getString(orderIdHandle);
      
      // 解析 orderId（可能是 pending-* 或真实 orderId）
      let realOrderId = orderId;
      if (orderId.startsWith('pending-')) {
        // 查找映射的真实 orderId
        realOrderId = this.orderIdMap.get(orderId) || orderId;
      }
      
      // 查找 symbol
      const symbol = this.orderSymbolMap.get(realOrderId);
      if (!symbol) {
        console.error(`[bridge] cancelOrder 失败: 找不到 symbol (orderId=${orderId})`);
        return this.ctx.newString(JSON.stringify({ success: false, error: 'symbol not found' }));
      }
      
      if (this.dryRun) {
        // Paper Trade 模式：不调用真实 API
        console.log(`[bridge][DRY RUN] cancelOrder: ${realOrderId} (${symbol})`);
        
        // 从 openOrders 移除
        this.openOrders.delete(realOrderId);
        this.orderSymbolMap.delete(realOrderId);
        
        return this.ctx.newString(JSON.stringify({ success: true, orderId: realOrderId }));
      } else {
        // Live 模式：调用真实 API
        console.log(`[bridge][LIVE] cancelOrder: ${realOrderId} (${symbol})`);
        
        // 异步撤单（不阻塞策略）
        this.client.cancelOrder(symbol, realOrderId)
          .then(() => {
            console.log(`[bridge] 撤单成功: ${realOrderId}`);
            
            // 从 openOrders 移除
            this.openOrders.delete(realOrderId);
            this.orderSymbolMap.delete(realOrderId);
          })
          .catch(err => console.error(`[bridge] 撤单失败:`, err.message));
        
        return this.ctx.newString(JSON.stringify({ success: true, orderId: realOrderId }));
      }
    });
    this.ctx.setProp(this.ctx.global, 'bridge_cancelOrder', bridge_cancelOrder);
    bridge_cancelOrder.dispose();

    // 注入 ctx.strategy.params
    const ctxHandle = this.ctx.newObject();
    const strategyHandle = this.ctx.newObject();
    const paramsHandle = this.ctx.newString(JSON.stringify({
      symbol: 'MYXUSDT',
      direction: 'short',
      gridSpacingUp: 0.02,
      gridSpacingDown: 0.04,
      orderSizeUp: 50,
      orderSizeDown: 100,
      simMode: false, // 实盘
    }));

    this.ctx.setProp(strategyHandle, 'id', this.ctx.newString('gales-quickjs'));
    this.ctx.setProp(strategyHandle, 'params', paramsHandle);
    this.ctx.setProp(ctxHandle, 'strategy', strategyHandle);
    this.ctx.setProp(this.ctx.global, 'ctx', ctxHandle);

    ctxHandle.dispose();
    strategyHandle.dispose();
    paramsHandle.dispose();
  }

  async start() {
    this.running = true;
    console.log('[QuickJS] 策略启动...');

    // 启动订单状态轮询（每 10 秒）
    const pollInterval = setInterval(() => {
      if (this.running) {
        this.pollOrderStatus().catch(err => 
          console.error('[QuickJS] 订单轮询错误:', err.message)
        );
      }
    }, 10000);

    while (this.running) {
      try {
        await this.heartbeat();
        await new Promise(resolve => setTimeout(resolve, 5000));
      } catch (error: any) {
        console.error('[QuickJS] 心跳错误:', error.message);
        
        // 异常自动恢复
        console.log('[QuickJS] 5秒后重试...');
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
    
    clearInterval(pollInterval);
  }

  stop() {
    this.running = false;
    console.log('[QuickJS] 策略停止');

    // 调用 st_stop
    this.callFunction('st_stop').catch(() => {});

    // 清理
    if (this.ctx) {
      this.ctx.dispose();
      this.ctx = undefined;
    }
  }

  private async heartbeat() {
    // 获取最新价格
    const ticker = await this.client.getTicker('MYXUSDT');
    this.lastPrice = ticker.lastPrice;

    this.tickCount++;
    
    // 每 10 次心跳输出一次状态
    if (this.tickCount % 10 === 0) {
      console.log(`[QuickJS] 心跳 #${this.tickCount} - 价格: ${this.lastPrice}`);
    }

    // 构造 tick
    const tick = {
      count: this.tickCount,
      timestamp: Math.floor(Date.now() / 1000),
      price: this.lastPrice,
      volume: 1000,
    };

    // 调用 st_heartbeat
    await this.callFunction('st_heartbeat', tick);
  }

  /**
   * P0 修复：轮询订单状态并回推到策略
   */
  private async pollOrderStatus() {
    if (this.dryRun) {
      // Paper Trade 模式：模拟成交（价格触及 → FILLED）
      for (const [orderId, order] of this.openOrders.entries()) {
        const priceMatch = (order.side === 'Buy' && this.lastPrice <= order.price) ||
                          (order.side === 'Sell' && this.lastPrice >= order.price);
        
        if (priceMatch && order.status === 'New') {
          console.log(`[QuickJS][DRY RUN] 模拟成交: ${orderId} @ ${order.price}`);
          
          order.status = 'Filled';
          order.filledAt = Date.now();
          
          // 调用 st_onOrderUpdate
          await this.callFunction('st_onOrderUpdate', {
            orderId,
            status: 'Filled',
            symbol: order.symbol,
            side: order.side,
            price: order.price,
            qty: order.qty,
            filledQty: order.qty,
          });
          
          // 从 openOrders 移除
          this.openOrders.delete(orderId);
          this.orderSymbolMap.delete(orderId);
        }
      }
    } else {
      // Live 模式：查询真实订单状态
      try {
        const orders = await this.client.getOpenOrders('MYXUSDT');
        
        for (const apiOrder of orders) {
          const orderId = apiOrder.orderId;
          const status = apiOrder.orderStatus;
          
          // 检查是否有状态变化
          const localOrder = this.openOrders.get(orderId);
          if (localOrder && localOrder.status !== status) {
            console.log(`[QuickJS][LIVE] 订单状态变化: ${orderId} ${localOrder.status} → ${status}`);
            
            localOrder.status = status;
            
            // 调用 st_onOrderUpdate
            await this.callFunction('st_onOrderUpdate', {
              orderId,
              status,
              symbol: apiOrder.symbol,
              side: apiOrder.side,
              price: parseFloat(apiOrder.price),
              qty: parseFloat(apiOrder.qty),
              filledQty: parseFloat(apiOrder.cumExecQty || '0'),
            });
            
            // 如果订单完成，从 openOrders 移除
            if (status === 'Filled' || status === 'Cancelled') {
              this.openOrders.delete(orderId);
              this.orderSymbolMap.delete(orderId);
            }
          }
        }
      } catch (error: any) {
        console.error(`[QuickJS] 订单轮询失败:`, error.message);
      }
    }
  }

  private async callFunction(name: string, ...args: any[]): Promise<any> {
    if (!this.ctx) return;

    const fnHandle = this.ctx.getProp(this.ctx.global, name);
    const fnType = this.ctx.typeof(fnHandle);

    if (fnType !== 'function') {
      fnHandle.dispose();
      return;
    }

    const argHandles = args.map((arg: any) => this.ctx.newString(JSON.stringify(arg)));
    const result = this.ctx.callFunction(fnHandle, this.ctx.undefined, ...argHandles);

    fnHandle.dispose();
    argHandles.forEach((h: any) => h.dispose());

    if (result.error) {
      const error = this.ctx.dump(result.error);
      result.error.dispose();
      throw new Error(`策略函数 ${name} 执行失败: ${JSON.stringify(error)}`);
    }

    const value = this.ctx.dump(result.value);
    result.value.dispose();

    return value;
  }
}

// ============================================================
// 主程序
// ============================================================

async function main() {
  // P0 修复：明确 Paper Trade 模式
  const dryRun = process.env.DRY_RUN !== 'false'; // 默认 true（Paper Trade）
  const mode = dryRun ? 'Paper Trade (DRY RUN)' : 'Live Trading';
  
  console.log('='.repeat(70));
  console.log(`   Gales 策略 - QuickJS 沙箱 + Bybit ${mode}`);
  console.log('='.repeat(70));
  console.log();
  
  if (dryRun) {
    console.log('🛡️  [DRY RUN] Paper Trade 模式：不会调用真实下单 API');
  } else {
    console.log('⚠️  [LIVE] 真实交易模式：将调用真实下单 API');
    console.log('⚠️  设置 DRY_RUN=true 切换到 Paper Trade 模式');
  }
  console.log();

  // 加载账号
  const path = process.env.QUANT_LAB_ACCOUNTS || join(homedir(), '.config', 'quant-lab', 'accounts.json');
  const accounts = JSON.parse(readFileSync(path, 'utf8'));
  const account = accounts.find((a: any) => a.id === 'wjcgm@bybit-sub1' || a.id === 'wjcgm@bbt-sub1');

  if (!account) throw new Error('Account not found');

  console.log('[账号]', {
    id: account.id,
    exchange: account.exchange,
    region: account.region,
    hasProxy: !!account.proxy,
  });
  console.log();

  // 创建客户端
  const client = new BybitClient({
    apiKey: account.apiKey,
    apiSecret: account.apiSecret,
    proxy: account.proxy,
  });

  // 创建策略引擎（传递 dryRun 参数）
  const engine = new QuickJSStrategyEngine(
    client,
    './strategies/gales-simple.js',
    dryRun
  );

  // 初始化
  await engine.initialize();

  console.log();
  console.log('[按 Ctrl+C 停止]');
  console.log();

  // 启动
  const startPromise = engine.start();

  // 优雅停止
  process.on('SIGINT', () => {
    console.log('\n[停止] 清理中...');
    engine.stop();
    process.exit(0);
  });

  await startPromise;
}

main().catch((error) => {
  console.error('\n❌ 错误:', error);
  process.exit(1);
});
