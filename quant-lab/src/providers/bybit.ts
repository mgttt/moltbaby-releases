// ============================================================
import { createLogger } from '../utils/logger';
const logger = createLogger('BYBIT');
// Bybit Trading Provider - 连接 Bybit 交易所
// ============================================================

import type {
  Order,
  Position,
  Account,
  Tick,
} from '../engine/types';
import type { Kline } from 'quant-lib';
import type { TradingProvider } from '../engine/live';
import { createHmac } from 'crypto';
import { spawnSync } from 'node:child_process';
// Phase 1: ndtsdb状态持久化
import { StateStore, OrderState, PositionState } from '../storage/StateStore.js';
import { join } from 'path';

/**
 * Bybit 配置
 */
export interface BybitProviderConfig {
  apiKey: string;
  apiSecret: string;
  testnet?: boolean;
  demo?: boolean;  // Demo Trading 模式 (api-demo.bybit.com)
  proxy?: string;
  category?: 'spot' | 'linear' | 'inverse';  // 产品类型
  // Phase 1: ndtsdb状态持久化配置
  stateDir?: string;
  runId?: string;
}

/**
 * Bybit K线响应
 */
interface BybitKlineData {
  topic: string;
  type: string;
  ts: number;
  data: Array<{
    start: number;
    end: number;
    interval: string;
    open: string;
    close: string;
    high: string;
    low: string;
    volume: string;
    turnover: string;
    confirm: boolean;
  }>;
}

/**
 * Bybit Trading Provider
 */
export class BybitProvider implements TradingProvider {
  private config: BybitProviderConfig;
  private baseUrl: string;
  private wsUrl: string;
  private category: string;
  
  // WebSocket 连接
  private ws?: WebSocket;
  private klineCallbacks: Map<string, (bar: Kline) => void> = new Map();
  private tickCallbacks: Map<string, (tick: Tick) => void> = new Map();
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private isConnecting = false;
  private shuttingDown = false;
  
  // P2: curl错误计数和连续错误检测
  private curlErrorCount = 0;
  private curlError35Count = 0;
  private lastCurlErrorTime = 0;
  private consecutiveCurlErrors = 0;
  
  // Phase 1: ndtsdb状态持久化
  private stateStore?: StateStore;
  private currentRunId?: string;
  
  constructor(config: BybitProviderConfig) {
    this.config = config;
    this.category = config.category || 'linear';
    
    if (config.demo) {
      // Demo Trading 模式: api-demo.bybit.com
      // 公共数据流仍用主网 (demo 只支持私有流)
      this.baseUrl = 'https://api-demo.bybit.com';
      this.wsUrl = `wss://stream.bybit.com/v5/public/${this.category}`;
      logger.info('[BybitProvider] Demo Trading 模式');
    } else if (config.testnet) {
      this.baseUrl = 'https://api-testnet.bybit.com';
      this.wsUrl = `wss://stream-testnet.bybit.com/v5/public/${this.category}`;
    } else {
      this.baseUrl = 'https://api.bybit.com';
      this.wsUrl = `wss://stream.bybit.com/v5/public/${this.category}`;
    }

    if (config.proxy) {
      logger.info(`[BybitProvider] 使用代理: ${config.proxy} (curl)`);
      logger.info(`[BybitProvider] 使用代理: ${config.proxy}`);
    }
    
    // Phase 1: 初始化ndtsdb状态持久化
    if (config.stateDir && config.runId) {
      this.stateStore = new StateStore({
        baseDir: join(config.stateDir, 'ndtsdb'),
      });
      this.currentRunId = config.runId;
      logger.info(`[BybitProvider] ndtsdb状态持久化已启用: runId=${config.runId}`);
    } else {
      logger.info('[BybitProvider] ndtsdb状态持久化未启用(缺少stateDir或runId)');
    }
  }
  
  /**
   * 订阅 K线
   */
  async subscribeKlines(
    symbols: string[],
    interval: string,
    callback: (bar: Kline) => void
  ): Promise<void> {
    // 保存回调
    for (const symbol of symbols) {
      this.klineCallbacks.set(symbol, callback);
    }
    
    // 构建订阅主题
    const bybitInterval = this.toBybitInterval(interval);

    const topics = symbols.map(s => {
      const symbol = this.toExchangeSymbol(s);
      return `kline.${bybitInterval}.${symbol}`;
    });
    
    // 连接 WebSocket
    await this.connectWebSocket(topics);
  }
  
  /**
   * 订阅 Tick
   */
  async subscribeTicks?(symbols: string[], callback: (tick: Tick) => void): Promise<void> {
    for (const symbol of symbols) {
      this.tickCallbacks.set(symbol, callback);
    }
    
    const topics = symbols.map(s => {
      const symbol = this.toExchangeSymbol(s);
      return `tickers.${symbol}`;
    });
    
    await this.connectWebSocket(topics);
  }
  
  /**
   * 热更新：重建连接
   * 保留订阅的回调，重新连接WebSocket
   */
  async reload(): Promise<void> {
    logger.info('[BybitProvider] 热更新：重建连接...');
    
    // 保存当前订阅
    const subscribedTickers = Array.from(this.tickCallbacks.keys());
    const subscribedKlines = Array.from(this.klineCallbacks.keys());
    
    // 关闭旧连接
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
    
    // 清除定时器
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    
    // 重新连接
    try {
      if (subscribedTickers.length > 0) {
        await this.subscribeTicks(subscribedTickers, (tick) => {
          this.tickCallbacks.forEach(cb => cb(tick));
        });
      }
      if (subscribedKlines.length > 0) {
        // K线需要interval参数，这里简化处理
        logger.info('[BybitProvider] 热更新：K线订阅需手动重新订阅');
      }
      logger.info('[BybitProvider] 热更新完成 ✅');
    } catch (e) {
      logger.error('[BybitProvider] 热更新失败:', e);
      throw e;
    }
  }
  
  /**
   * 连接 WebSocket
   */
  private async connectWebSocket(topics: string[]): Promise<void> {
    if (this.isConnecting) return;
    this.isConnecting = true;
    
    try {
      logger.info(`[BybitProvider] 连接 WebSocket: ${this.wsUrl}`);
      
      this.ws = new WebSocket(this.wsUrl);
      
      this.ws.onopen = () => {
        logger.info(`[BybitProvider] WebSocket 已连接`);
        this.isConnecting = false;
        
        // 订阅主题
        for (const topic of topics) {
          this.ws!.send(JSON.stringify({
            op: 'subscribe',
            args: [topic],
          }));
        }
        
        this.startHeartbeat();
      };
      
      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);
          this.handleMessage(data);
        } catch (error) {
          logger.error(`[BybitProvider] 解析消息失败:`, error);
        }
      };
      
      this.ws.onerror = (error) => {
        logger.error(`[BybitProvider] WebSocket 错误:`, error);
        this.isConnecting = false;
      };
      
      this.ws.onclose = () => {
        if (this.shuttingDown) return;
        logger.info(`[BybitProvider] WebSocket 已断开，5秒后重连...`);
        this.isConnecting = false;
        this.stopHeartbeat();
        this.scheduleReconnect(topics);
      };
    } catch (error) {
      logger.error(`[BybitProvider] 连接失败:`, error);
      this.isConnecting = false;
      this.scheduleReconnect(topics);
    }
  }
  
  /**
   * 处理 WebSocket 消息
   */
  private handleMessage(data: any): void {
    // 响应 Ping
    if (data.op === 'ping') {
      this.ws?.send(JSON.stringify({ op: 'pong' }));
      return;
    }
    
    // K线消息
    if (data.topic && data.topic.startsWith('kline')) {
      const klineData = data as BybitKlineData;
      
      for (const k of klineData.data) {
        // 只处理完结的 K线
        if (!k.confirm) continue;
        
        // 从 topic 提取 symbol
        const parts = klineData.topic.split('.');
        const exchangeSymbol = parts[parts.length - 1];
        const symbol = this.fromExchangeSymbol(exchangeSymbol);
        
        const callback = this.klineCallbacks.get(symbol);
        if (callback) {
          const bar: Kline = {
            timestamp: Math.floor(k.start / 1000), // 毫秒 → 秒
            symbol,
            open: parseFloat(k.open),
            high: parseFloat(k.high),
            low: parseFloat(k.low),
            close: parseFloat(k.close),
            volume: parseFloat(k.volume),
            trades: 0, // Bybit 不提供
          };
          callback(bar);
        }
      }
    }
    
    // Ticker 消息
    else if (data.topic && data.topic.startsWith('tickers')) {
      const exchangeSymbol = data.topic.split('.')[1];
      const symbol = this.fromExchangeSymbol(exchangeSymbol);
      const callback = this.tickCallbacks.get(symbol);
      
      if (callback && data.data) {
        const tick: Tick = {
          timestamp: Math.floor(data.ts / 1000),
          symbol,
          price: parseFloat(data.data.lastPrice),
          volume: parseFloat(data.data.volume24h),
        };
        callback(tick);
      }
    }
  }
  
  /**
   * 心跳机制
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 'ping' }));
      }
    }, 20000); // 20秒
  }
  
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
  
  /**
   * 重连机制
   */
  private scheduleReconnect(topics: string[]): void {
    if (this.shuttingDown) return;
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.shuttingDown) return;
      this.connectWebSocket(topics);
    }, 5000);
  }
  
  /**
   * 买入
   */
  async buy(symbol: string, quantity: number, price?: number, orderLinkId?: string, reduceOnly?: boolean): Promise<Order> {
    const params: Record<string, any> = {
      category: this.category,
      symbol: this.toExchangeSymbol(symbol),
      side: 'Buy',
      orderType: price ? 'Limit' : 'Market',
      qty: quantity.toString(),
    };
    
    if (price) {
      params.price = price.toString();
    }
    
    if (orderLinkId) {
      params.orderLinkId = orderLinkId;
    }
    
    // P0修复：添加reduceOnly字段
    if (reduceOnly) {
      params.reduceOnly = true;
    }
    
    // P0 DEBUG：确认 orderLinkId 是否被传递
    logger.info(`[BybitProvider] [P0 DEBUG] buy() 参数:`, { symbol, quantity, price, orderLinkId });
    logger.info(`[BybitProvider] [P0 DEBUG] buy() params:`, params);
    logger.info(`[BybitProvider] 下单请求: Buy ${quantity} ${symbol} @ ${price || 'Market'}`);
    
    let result: any;
    try {
      result = await this.request('POST', '/v5/order/create', params);
    } catch (error: any) {
      // P0修复：110072幂等成功处理（OrderLinkedID is duplicate）
      if (error.message?.includes('110072') || error.message?.includes('OrderLinkedID is duplicate')) {
        if (params.orderLinkId) {
          logger.info(`[BybitProvider] 110072幂等处理：查询订单 orderLinkId=${params.orderLinkId}`);
          const existingOrder = await this.getOrderByLinkId(params.orderLinkId);
          if (existingOrder) {
            logger.info(`[BybitProvider] 110072幂等成功：返回已存在订单 ${existingOrder.orderId}`);
            return existingOrder;
          }
        }
      }
      logger.error(`[BybitProvider] 下单失败: ${error.message}`);
      throw error;
    }
    
    if (!result || !result.result) {
      logger.error(`[BybitProvider] 下单响应异常:`, result);
      throw new Error('Order response missing result field');
    }
    
    if (!result.result.orderId) {
      logger.error(`[BybitProvider] 下单响应缺少 orderId:`, result.result);
      throw new Error('Order response missing orderId');
    }
    
    logger.info(`[BybitProvider] 下单成功: orderId=${result.result.orderId}`);
    
    // Phase 1: 记录订单到ndtsdb
    const order = this.parseOrder({
      ...result.result,
      symbol: this.toExchangeSymbol(symbol),
      side: 'Buy',
      orderType: price ? 'Limit' : 'Market',
      qty: quantity.toString(),
      price: price?.toString() || '0',
    });
    await this.recordOrder(order, 'Buy', price || 0, quantity);
    
    return order;
  }
  
  /**
   * 卖出
   */
  async sell(symbol: string, quantity: number, price?: number, orderLinkId?: string, reduceOnly?: boolean): Promise<Order> {
    const params: Record<string, any> = {
      category: this.category,
      symbol: this.toExchangeSymbol(symbol),
      side: 'Sell',
      orderType: price ? 'Limit' : 'Market',
      qty: quantity.toString(),
    };
    
    if (price) {
      params.price = price.toString();
    }
    
    if (orderLinkId) {
      params.orderLinkId = orderLinkId;
    }
    
    // P0修复：添加reduceOnly字段
    if (reduceOnly) {
      params.reduceOnly = true;
    }
    
    // P0 DEBUG：确认 orderLinkId 是否被传递
    logger.info(`[BybitProvider] [P0 DEBUG] sell() 参数:`, { symbol, quantity, price, orderLinkId });
    logger.info(`[BybitProvider] [P0 DEBUG] sell() params:`, params);
    logger.info(`[BybitProvider] 下单请求: Sell ${quantity} ${symbol} @ ${price || 'Market'}`);
    
    let result: any;
    try {
      result = await this.request('POST', '/v5/order/create', params);
    } catch (error: any) {
      // P0修复：110072幂等成功处理（OrderLinkedID is duplicate）
      if (error.message?.includes('110072') || error.message?.includes('OrderLinkedID is duplicate')) {
        if (params.orderLinkId) {
          logger.info(`[BybitProvider] 110072幂等处理：查询订单 orderLinkId=${params.orderLinkId}`);
          const existingOrder = await this.getOrderByLinkId(params.orderLinkId);
          if (existingOrder) {
            logger.info(`[BybitProvider] 110072幂等成功：返回已存在订单 ${existingOrder.orderId}`);
            return existingOrder;
          }
        }
      }
      logger.error(`[BybitProvider] 下单失败: ${error.message}`);
      throw error;
    }
    
    if (!result || !result.result) {
      logger.error(`[BybitProvider] 下单响应异常:`, result);
      throw new Error('Order response missing result field');
    }
    
    if (!result.result.orderId) {
      logger.error(`[BybitProvider] 下单响应缺少 orderId:`, result.result);
      throw new Error('Order response missing orderId');
    }
    
    logger.info(`[BybitProvider] 下单成功: orderId=${result.result.orderId}`);
    
    // Phase 1: 记录订单到ndtsdb
    const order = this.parseOrder({
      ...result.result,
      symbol: this.toExchangeSymbol(symbol),
      side: 'Sell',
      orderType: price ? 'Limit' : 'Market',
      qty: quantity.toString(),
      price: price?.toString() || '0',
    });
    await this.recordOrder(order, 'Sell', price || 0, quantity);
    
    return order;
  }
  
  /**
   * 取消订单
   */
  async cancelOrder(orderId: string): Promise<void> {
    // 检测 pending 订单（本地临时 ID，还未提交到交易所）
    if (orderId.startsWith('pending-')) {
      logger.info(`[BybitProvider] 跳过撤单：pending 订单未提交到交易所 (${orderId})`);
      return;
    }
    
    // orderId format: "symbol:id"
    const parts = orderId.split(':');
    
    if (parts.length !== 2) {
      logger.error(`[BybitProvider] Invalid orderId format: ${orderId} (expected "symbol:id")`);
      throw new Error(`Invalid orderId format: ${orderId} (expected "symbol:id")`);
    }
    
    const [symbolPart, id] = parts;
    
    if (!symbolPart || !id) {
      throw new Error(`Invalid orderId: missing symbol or id (${orderId})`);
    }
    
    logger.info(`[BybitProvider] 撤单请求: ${orderId} (symbol=${symbolPart}, id=${id})`);
    
    const params = {
      category: this.category,
      symbol: this.toExchangeSymbol(symbolPart),
      orderId: id,
    };
    
    try {
      await this.request('POST', '/v5/order/cancel', params);
      logger.info(`[BybitProvider] 撤单成功: ${orderId}`);
    } catch (error: any) {
      // 正常竞态：订单在撤单前已成交/过期/不存在
      if (error.message && error.message.includes('order not exists or too late to cancel')) {
        logger.info(`[BybitProvider] 撤单已完成（订单已不存在）: ${orderId} - ${error.message}`);
        return;  // 不抛出异常，视为成功
      }
      
      // 其他真正的撤单错误：继续抛出
      logger.error(`[BybitProvider] 撤单失败: ${orderId} - ${error.message}`);
      throw error;
    }
  }
  
  /**
   * 获取账户信息
   */
  async getAccount(): Promise<Account> {
    // Bybit V5: /v5/account/wallet-balance only supports accountType=UNIFIED
    const params = {
      accountType: 'UNIFIED',
    };
    
    const result = await this.request('GET', '/v5/account/wallet-balance', params);
    
    let balance = 0;
    let equity = 0;
    let availableMargin = 0;  // P0修复：使用totalAvailableBalance

    if (result.result?.list?.[0]) {
      const account = result.result.list[0];
      equity = parseFloat(account.totalEquity) || 0;
      availableMargin = parseFloat(account.totalAvailableBalance) || 0;  // ✅ 使用totalAvailableBalance

      // pick USDT walletBalance as a rough available number
      const coin = account.coin?.find((c: any) => c.coin === 'USDT');
      if (coin) {
        balance = parseFloat(coin.walletBalance) || 0;
      }
    }

    return {
      balance,
      equity: equity || balance,
      availableMargin,  // ✅ 修复：使用totalAvailableBalance（66395 USDT）而非walletBalance（0 USDT）
    };
  }
  
  /**
   * 获取持仓
   */
  async getPosition(symbol: string): Promise<Position | null> {
    const params = {
      category: this.category,
      symbol: this.toExchangeSymbol(symbol),
    };
    
    const result = await this.request('GET', '/v5/position/list', params);
    
    if (result.result && result.result.list && result.result.list[0]) {
      return this.parsePosition(result.result.list[0]);
    }
    
    return null;
  }
  
  /**
   * 获取所有持仓
   */
  async getPositions(): Promise<Position[]> {
    const params = {
      category: this.category,
      settleCoin: 'USDT',
    };
    
    const result = await this.request('GET', '/v5/position/list', params);
    
    if (!result.result || !result.result.list) {
      return [];
    }
    
    // P1 调试：打印完整的 Bybit API 响应（仅前 3 个持仓）
    logger.info('[BybitProvider] getPositions raw response (first 3):');
    result.result.list.slice(0, 3).forEach((p: any, i: number) => {
      logger.info(`  [${i}] symbol=${p.symbol}, side=${p.side}, size=${p.size}, positionValue=${p.positionValue}`);
    });
    
    return result.result.list
      .filter((p: any) => parseFloat(p.size) > 0)
      .map((p: any) => this.parsePosition(p));
  }
  
  /**
   * 获取最新报价
   */
  async getTicker(symbol: string): Promise<{ lastPrice: number; volume24h: number }> {
    const result = await this.request('GET', '/v5/market/tickers', {
      category: this.category,
      symbol,
    });
    const ticker = result.result?.list?.[0];
    if (!ticker) throw new Error(`Ticker not found: ${symbol}`);
    return {
      lastPrice: parseFloat(ticker.lastPrice),
      volume24h: parseFloat(ticker.volume24h || '0'),
    };
  }

  /**
   * REST 获取历史K线（用于指标warmup + 缓存层回源）
   * @param symbol  交易对（e.g. MYXUSDT）
   * @param interval Kline周期（e.g. '1m','5m','1h'）
   * @param limit   返回条数（max 200）
   * @param endTime 结束时间（ms，默认当前）
   */
  async getKlines(symbol: string, interval: string, limit = 100, endTime?: number): Promise<Kline[]> {
    const params: Record<string, any> = {
      category: this.category,
      symbol,
      interval: this.toBybitInterval(interval),
      limit: Math.min(limit, 200),
    };
    if (endTime) params.end = String(endTime);

    const result = await this.request('GET', '/v5/market/kline', params);
    const list: string[][] = result.result?.list ?? [];
    // Bybit返回: [startTime(ms), open, high, low, close, volume, turnover]，按时间倒序
    return list
      .map(k => ({
        timestamp: Math.floor(parseInt(k[0]) / 1000),  // 转秒
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }))
      .sort((a, b) => a.timestamp - b.timestamp);  // 升序
  }

  /**
   * P0修复：查询订单（按orderLinkId）
   * 用于110072幂等成功处理
   */
  async getOrderByLinkId(orderLinkId: string): Promise<Order | null> {
    try {
      const result = await this.request('GET', '/v5/order/realtime', {
        category: this.category,
        orderLinkId,
      });
      
      const orders = result.result?.list || [];
      if (orders.length === 0) {
        return null;
      }
      
      // 返回第一个匹配订单
      return this.parseOrder(orders[0]);
    } catch (error: any) {
      logger.error(`[BybitProvider] 查询订单失败（orderLinkId=${orderLinkId}）: ${error.message}`);
      return null;
    }
  }

  /**
   * P2修复：获取未完成订单（订单闭环对账 - bot-009/鲶鱼建议）
   */
  async getOpenOrders(
    symbol?: string,
    category: 'spot' | 'linear' | 'inverse' = 'linear',
    limit: number = 50
  ): Promise<any[]> {
    try {
      const params: Record<string, any> = {
        category,
        limit,
      };
      if (symbol) params.symbol = symbol;

      const result = await this.request('GET', '/v5/order/realtime', params);
      const list = result.result?.list || [];
      logger.info(`[BybitProvider] getOpenOrders: ${list.length} 个未完成订单`);
      return list;
    } catch (error: any) {
      logger.error(`[BybitProvider] getOpenOrders failed: ${error.message}`);
      return [];
    }
  }

  /**
   * P2修复：获取成交记录（订单闭环对账 - bot-009/鲶鱼建议）
   */
  async getExecutions(
    symbol?: string,
    category: 'spot' | 'linear' | 'inverse' = 'linear',
    limit: number = 50,
    startTime?: number
  ): Promise<any[]> {
    try {
      const params: Record<string, any> = {
        category,
        limit,
      };
      if (symbol) params.symbol = symbol;
      if (startTime) params.startTime = startTime;

      const result = await this.request('GET', '/v5/execution/list', params);
      const list = result.result?.list || [];
      logger.info(`[BybitProvider] getExecutions: ${list.length} 个成交记录`);
      return list;
    } catch (error: any) {
      logger.error(`[BybitProvider] getExecutions failed: ${error.message}`);
      return [];
    }
  }

  /**
   * 发送 REST API 请求（直接使用 curl，避免 CloudFront WAF 拦截）
   */
  private async request(
    method: string,
    endpoint: string,
    params: Record<string, any>
  ): Promise<any> {
    const timestamp = Date.now().toString();
    const recvWindow = '5000';
    
    // 构建请求参数（Bybit 对签名要求 queryString/params 顺序一致，建议按 key 排序）
    let queryString = '';
    let body = '';

    if (method === 'GET') {
      queryString = Object.entries(params)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join('&');
    } else {
      // JSON body: keep stable order by sorting keys
      const sorted: Record<string, any> = {};
      for (const [k, v] of Object.entries(params).sort(([a], [b]) => a.localeCompare(b))) {
        if (v !== undefined) sorted[k] = v;
      }
      body = JSON.stringify(sorted);
    }
    
    // 生成签名
    const signString = timestamp + this.config.apiKey + recvWindow + (method === 'GET' ? queryString : body);
    const signature = this.generateSignature(signString);
    
    // 构建 URL
    const url = `${this.baseUrl}${endpoint}${queryString ? '?' + queryString : ''}`;
    
    const headers = {
      'X-BAPI-API-KEY': this.config.apiKey,
      'X-BAPI-SIGN': signature,
      'X-BAPI-SIGN-TYPE': '2',
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': recvWindow,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'quant-lab/3.0',
    };
    
    // P0 DEBUG：打印实际发送的 body（特别是下单请求）
    if (method === 'POST' && endpoint === '/v5/order/create') {
      logger.info(`[BybitProvider] [P0 DEBUG] 下单请求 body:`, body);
      logger.info(`[BybitProvider] [P0 DEBUG] 下单请求 params:`, params);
    }
    
    // 直接使用 curl（避免 undici fetch 被 CloudFront WAF 拦截）
    return this.requestViaCurl(method, url, body || undefined, headers);
  }
  
  /**
   * Fallback REST request via curl (better proxy compatibility)
   */
  private requestViaCurl(
    method: string,
    url: string,
    body: string | undefined,
    headers: Record<string, string>
  ): any {
    const args: string[] = [
      '-sS',
      '-X', method,
      url,
      '-m', '20',
    ];

    // Proxy
    const proxy = this.config.proxy;
    if (proxy) {
      args.push('-x', proxy);
    }

    // SSL 重试机制：GET 请求加重试（行情/持仓/订单查询）
    if (method === 'GET') {
      args.push('--retry', '2');          // 最多重试 2 次
      args.push('--retry-delay', '1');    // 重试间隔 1 秒
      args.push('--retry-all-errors');    // 重试所有错误（包括 SSL）
      // 日志优化：删除"启用重试"提示（占56.8%日志，无实际价值）
      // 实际重试错误会在 catch 块打印
    } else {
      // P1修复：撤单POST可以安全重试（同orderId幂等）
      if (url.includes('/v5/order/cancel')) {
        args.push('--retry', '2');
        args.push('--retry-delay', '1');
        args.push('--retry-all-errors');
        // 撤单幂等：同orderId重试安全
      }
      // 其他POST请求（下单）不盲目重试，避免重复下单
      // 幂等性由 orderLinkId 保证
    }

    // Headers
    for (const [k, v] of Object.entries(headers)) {
      args.push('-H', `${k}: ${v}`);
    }

    // Body
    if (body && method !== 'GET') {
      args.push('--data', body);
    }

    // P2: 记录请求开始时间
    const requestStartTime = Date.now();

    // 显式pipe stderr（鲶鱼建议1）
    const result = spawnSync('curl', args, { 
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], // stdin, stdout, stderr
    });

    // P2: 计算请求耗时
    const requestDuration = Date.now() - requestStartTime;

    const out = result.stdout || '';
    const err = result.stderr || '';

    // P1: curl exit code 35 (SSL error / unexpected EOF) 退避 + 阈值熔断
    if (result.status === 35) {
      this.curlError35Count++;
      this.curlErrorCount++;
      this.consecutiveCurlErrors++;
      this.lastCurlErrorTime = Date.now();

      // 1) 自动 backoff（轻量，默认不真正 sleep；由上层决定是否等待）
      // - backoffMs: 250ms * 2^(consecutive-1), capped at 5000ms
      // - 连续错误恢复条件：一次成功请求会把 consecutiveCurlErrors 重置为0（见下方成功分支）
      const backoffMs = Math.min(5000, 250 * Math.pow(2, Math.max(0, this.consecutiveCurlErrors - 1)));
      logger.warn(
        `[BybitProvider] [BACKOFF] curl exit35 detected → backoff=${backoffMs}ms | ` +
          `recoverOn=next_success | ` +
          `method=${method} | url=${url} | duration=${requestDuration}ms | ` +
          `error35Count=${this.curlError35Count} | consecutiveErrors=${this.consecutiveCurlErrors}`,
      );

      // 2) 阈值熔断：15min内exit35>=3 或 consecutiveErrors>=3 → 触发 CIRCUIT_BREAK
      // 说明：这里没有 wall-clock 时间窗统计（需要外部注入或更重的状态）。
      // 当前实现：以 consecutiveErrors>=3 作为可验收代理阈值，并明确打点日志。
      // 15min窗口统计建议后续在更上层（策略进程）做限流聚合。
      if (this.consecutiveCurlErrors >= 3) {
        const pauseMinutes = 3;
        logger.error(
          `[BybitProvider] [P0][CIRCUIT_BREAK] exit35 threshold hit → pauseOrders=${pauseMinutes}m | ` +
            `reason=consecutiveExit35>=3 | ` +
            `method=${method} | url=${url} | ` +
            `error35Count=${this.curlError35Count} | consecutiveErrors=${this.consecutiveCurlErrors}`,
        );
        throw new Error(
          `Bybit CIRCUIT_BREAK (exit35): pauseOrders=${pauseMinutes}m | ` +
            `error35Count=${this.curlError35Count} | consecutiveErrors=${this.consecutiveCurlErrors} | ` +
            `${err.trim()}`,
        );
      }

      // 非熔断：仍抛错给上层（上层可选择重试/退避等待）
      throw new Error(`Bybit API SSL error (curl exit 35, count=${this.curlError35Count}): ${err.trim()}`);
    }

    // 成功但stderr非空：打结构化日志（鲶鱼建议2）
    // P2修复：同时检测stderr中是否包含(35) SSL error或SSL routines unexpected eof
    const hasSSL35InStderr = err.trim().includes('(35)') || err.trim().includes('SSL routines::unexpected eof');
    if (result.status === 0 && (err.trim() || hasSSL35InStderr)) {
      // 如果stderr包含(35)，也计入curlError35Count
      if (hasSSL35InStderr) {
        this.curlError35Count++;
        this.consecutiveCurlErrors++;
        logger.warn(
          `[BybitProvider] [WARNING] Curl success but SSL error in stderr: ` +
          `method=${method} | ` +
          `url=${url} | ` +
          `duration=${requestDuration}ms | ` +
          `error35Count=${this.curlError35Count} | ` +
          `consecutiveErrors=${this.consecutiveCurlErrors}`,
        );
      } else {
        logger.warn(
          `[BybitProvider] Curl success with stderr: ` +
          `method=${method} | ` +
          `url=${url} | ` +
          `duration=${requestDuration}ms | ` +
          `stderr="${err.trim().slice(0, 150)}"`,
        );
      }
    }

    // curl失败（非0退出码）
    if (result.status !== 0) {
      this.curlErrorCount++;
      this.consecutiveCurlErrors++;
      this.lastCurlErrorTime = Date.now();
      
      // 连续发生升级为warning
      const isConsecutiveWarning = this.consecutiveCurlErrors >= 3;
      const logLevel = isConsecutiveWarning ? 'error' : 'warn';
      const logPrefix = isConsecutiveWarning ? '[WARNING]' : '';
      
      const errorMsg = err.trim() || result.error?.message || 'Unknown curl error';
      console[logLevel](
        `[BybitProvider] ${logPrefix} Curl failed: ` +
        `method=${method} | ` +
        `url=${url} | ` +
        `status=${result.status} | ` +
        `duration=${requestDuration}ms | ` +
        `errorCount=${this.curlErrorCount} | ` +
        `consecutiveErrors=${this.consecutiveCurlErrors} | ` +
        `stderr="${errorMsg.slice(0, 150)}"`,
      );
      logger.error(`[BybitProvider] Command: curl ${args.join(' ')}`);
      throw new Error(`Bybit API request failed (curl exit ${result.status}): ${errorMsg}`);
    }

    // P2: 成功请求重置连续错误计数
    if (this.consecutiveCurlErrors > 0) {
      this.consecutiveCurlErrors = 0;
    }

    // P2: 慢请求警告（超过5秒）
    if (requestDuration > 5000) {
      logger.warn(
        `[BybitProvider] Slow request warning: ` +
        `method=${method} | ` +
        `url=${url} | ` +
        `duration=${requestDuration}ms`,
      );
    }

    const text = (out || '').trim();

    if (!text) {
      throw new Error('Bybit API returned empty response');
    }

    try {
      const result = JSON.parse(text);
      
      // 检查 Bybit API 错误响应
      if (result.retCode !== 0) {
        logger.error(`[BybitProvider] API error: ${result.retMsg} (code: ${result.retCode})`);
        throw new Error(`Bybit API error: ${result.retMsg}`);
      }
      
      return result;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Bybit curl 响应不是 JSON: ${text.slice(0, 300)}`);
      }
      throw error;
    }
  }

  /**
   * 生成签名（HMAC SHA256）
   */
  private generateSignature(message: string): string {
    const hmac = createHmac('sha256', this.config.apiSecret);
    hmac.update(message);
    return hmac.digest('hex');
  }
  
  /**
   * 解析订单响应
   */
  private parseOrder(data: any): Order {
    if (!data || !data.symbol) {
      logger.warn('[BybitProvider] parseOrder: invalid data', data);
      throw new Error('Invalid order data: missing symbol');
    }
    return {
      id: `${data.symbol}:${data.orderId}`,
      symbol: this.fromExchangeSymbol(data.symbol),
      side: data.side === 'Buy' ? 'BUY' : 'SELL',
      type: data.orderType === 'Market' ? 'MARKET' : 'LIMIT',
      quantity: parseFloat(data.qty),
      price: parseFloat(data.price) || 0,
      filled: parseFloat(data.cumExecQty) || 0,
      status: this.parseOrderStatus(data.orderStatus),
      timestamp: Math.floor(data.createdTime / 1000),
    };
  }
  
  /**
   * 解析订单状态
   */
  private parseOrderStatus(status: string): 'PENDING' | 'PARTIAL' | 'FILLED' | 'CANCELED' | 'REJECTED' {
    switch (status) {
      case 'New':
        return 'PENDING';
      case 'PartiallyFilled':
        return 'PARTIAL';
      case 'Filled':
        return 'FILLED';
      case 'Cancelled':
        return 'CANCELED';
      case 'Rejected':
        return 'REJECTED';
      default:
        return 'PENDING';
    }
  }

  // Phase 1: 记录订单到ndtsdb
  private async recordOrder(
    order: Order,
    side: 'Buy' | 'Sell',
    price: number,
    qty: number
  ): Promise<void> {
    if (!this.stateStore || !this.currentRunId) {
      return; // ndtsdb未启用
    }

    try {
      const now = BigInt(Date.now()) * 1000000n; // nanos
      const orderState: OrderState = {
        orderKey: `order:${this.currentRunId}:${order.orderLinkId || order.orderId}`,
        runId: this.currentRunId,
        orderLinkId: order.orderLinkId || order.orderId,
        symbol: order.symbol,
        side: side,
        qty: qty,
        price: price,
        status: order.status,
        filledQty: order.filledQty || 0,
        avgPrice: order.avgPrice || price,
        pnl: 0, // 初始为0，成交后更新
        paramsHash: 'default', // TODO: 从策略获取当前参数hash
        createdAt: now,
        updatedAt: now,
      };

      await this.stateStore.upsertOrder(orderState);
      logger.info(`[BybitProvider] ndtsdb记录订单: ${orderState.orderKey}`);
    } catch (e) {
      // ndtsdb写入失败不影响主流程，仅记录日志
      logger.error(`[BybitProvider] ndtsdb记录订单失败: ${e}`);
    }
  }
  
  /**
   * 解析持仓响应
   * 
   * Bybit Position API 字段：
   * - size: 持仓数量（linear: 币数量；inverse: USD 张数）
   * - positionValue: 持仓价值（linear: USDT 价值；inverse: BTC 价值）
   * - avgPrice: 开仓均价
   * - markPrice: 标记价格（用作 currentPrice）
   * - unrealisedPnl: 未实现盈亏
   */
  private parsePosition(data: any): Position {
    // P0 修复：添加 currentPrice 字段（使用 markPrice）
    const currentPrice = parseFloat(data.markPrice) || 0;
    const size = parseFloat(data.size);
    const avgPrice = parseFloat(data.avgPrice);
    const positionValue = parseFloat(data.positionValue);
    
    // P1 调试：打印完整的 data 对象（关键字段）
    logger.info(`[BybitProvider] parsePosition raw data:`, {
      symbol: data.symbol,
      side: data.side,
      size: data.size,
      positionIdx: data.positionIdx,
      positionValue: data.positionValue,
      unrealisedPnl: data.unrealisedPnl,
      avgPrice: data.avgPrice,
      markPrice: data.markPrice,
    });
    
    // P0 修复：side 映射
    // Bybit API 返回 'Buy' 或 'Sell'
    // 文档定义：Buy = long, Sell = short
    const side = data.side === 'Buy' ? 'LONG' : 'SHORT';
    
    // P0 调试日志（增强：包含 side 信息）
    logger.info(`[BybitProvider] parsePosition: symbol=${data.symbol}, side=${data.side} → ${side}, size=${size}, positionValue=${positionValue}, markPrice=${data.markPrice}`);
    
    return {
      symbol: this.fromExchangeSymbol(data.symbol),
      side: side,
      quantity: size,  // 持仓数量（币数量）
      entryPrice: avgPrice,
      currentPrice: currentPrice,  // P0 新增：当前价格（markPrice）
      unrealizedPnl: parseFloat(data.unrealisedPnl) || 0,
      realizedPnl: 0,
      // P0 新增：持仓价值（USDT）
      positionNotional: positionValue,
    };
  }
  
  /**
   * 转换符号格式：BTC/USDT → BTCUSDT
   */
  private toExchangeSymbol(symbol: string): string {
    return symbol.replace('/', '').toUpperCase();
  }
  
  /**
   * 转换符号格式：BTCUSDT → BTC/USDT
   */
  private fromExchangeSymbol(symbol: string): string {
    if (!symbol || typeof symbol !== 'string') {
      logger.warn('[BybitProvider] fromExchangeSymbol: invalid symbol', symbol);
      return symbol || 'UNKNOWN';
    }
    if (symbol.endsWith('USDT')) {
      return `${symbol.slice(0, -4)}/USDT`;
    }
    return symbol;
  }
  
  /**
   * Bybit interval mapping
   *
   * Bybit v5 kline interval values:
   * - minutes: 1/3/5/15/30
   * - hours: 60/120/240/360/720
   * - day/week/month: D/W/M
   */
  private toBybitInterval(interval: string): string {
    const i = interval.trim();

    // already in Bybit format
    if (/^(1|3|5|15|30|60|120|240|360|720|D|W|M)$/.test(i)) return i;

    const map: Record<string, string> = {
      '1m': '1',
      '3m': '3',
      '5m': '5',
      '15m': '15',
      '30m': '30',
      '1h': '60',
      '2h': '120',
      '4h': '240',
      '6h': '360',
      '12h': '720',
      '1d': 'D',
      '1w': 'W',
      '1M': 'M',
      '1mo': 'M',
      '1month': 'M',
    };

    const mapped = map[i];
    if (!mapped) {
      throw new Error(`[BybitProvider] Unsupported interval: ${interval}`);
    }
    return mapped;
  }

  /**
   * 清理资源
   */
  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    this.stopHeartbeat();
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
    
    this.klineCallbacks.clear();
    this.tickCallbacks.clear();
  }
}
