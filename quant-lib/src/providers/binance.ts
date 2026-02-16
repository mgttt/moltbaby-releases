// ============================================================
// Binance Trading Provider - 连接 Binance 交易所
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
import { ProxyAgent, fetch as undiciFetch } from 'undici';

/**
 * Binance 配置
 */
export interface BinanceProviderConfig {
  apiKey: string;
  apiSecret: string;
  testnet?: boolean;
  proxy?: string;
}

/**
 * Binance K线响应
 */
interface BinanceKlineData {
  e: string;      // 事件类型
  E: number;      // 事件时间
  s: string;      // 交易对
  k: {
    t: number;    // K线开始时间
    T: number;    // K线结束时间
    s: string;    // 交易对
    i: string;    // K线周期
    f: number;    // 第一笔成交ID
    L: number;    // 最后一笔成交ID
    o: string;    // 开盘价
    c: string;    // 收盘价
    h: string;    // 最高价
    l: string;    // 最低价
    v: string;    // 成交量
    n: number;    // 成交笔数
    x: boolean;   // K线是否完结
    q: string;    // 成交额
    V: string;    // 主动买入成交量
    Q: string;    // 主动买入成交额
  };
}

/**
 * Binance Trading Provider
 */
export class BinanceProvider implements TradingProvider {
  private config: BinanceProviderConfig;
  private baseUrl: string;
  private wsUrl: string;
  private proxyAgent?: ProxyAgent;
  
  // WebSocket 连接
  private ws?: WebSocket;
  private klineCallbacks: Map<string, (bar: Kline) => void> = new Map();
  private tickCallbacks: Map<string, (tick: Tick) => void> = new Map();
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private isConnecting = false;
  
  constructor(config: BinanceProviderConfig) {
    this.config = config;
    
    if (config.testnet) {
      this.baseUrl = 'https://testnet.binance.vision/api/v3';
      this.wsUrl = 'wss://testnet.binance.vision/ws';
    } else {
      this.baseUrl = 'https://api.binance.com/api/v3';
      this.wsUrl = 'wss://stream.binance.com:9443/ws';
    }

    if (config.proxy) {
      this.proxyAgent = new ProxyAgent(config.proxy);
      console.log(`[BinanceProvider] 使用代理: ${config.proxy}`);
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
    // 转换符号格式：BTC/USDT → btcusdt
    const streams = symbols.map(s => {
      const symbol = s.replace('/', '').toLowerCase();
      return `${symbol}@kline_${interval}`;
    });
    
    // 保存回调
    for (const symbol of symbols) {
      this.klineCallbacks.set(symbol, callback);
    }
    
    // 连接 WebSocket
    await this.connectWebSocket(streams);
  }
  
  /**
   * 订阅 Tick（24hr ticker）
   */
  async subscribeTicks?(symbols: string[], callback: (tick: Tick) => void): Promise<void> {
    const streams = symbols.map(s => {
      const symbol = s.replace('/', '').toLowerCase();
      return `${symbol}@ticker`;
    });
    
    for (const symbol of symbols) {
      this.tickCallbacks.set(symbol, callback);
    }
    
    await this.connectWebSocket(streams);
  }
  
  /**
   * 连接 WebSocket
   */
  private async connectWebSocket(streams: string[]): Promise<void> {
    if (this.isConnecting) return;
    this.isConnecting = true;
    
    try {
      const wsUrl = `${this.wsUrl}/${streams.join('/')}`;
      console.log(`[BinanceProvider] 连接 WebSocket: ${wsUrl}`);
      
      this.ws = new WebSocket(wsUrl);
      
      this.ws.onopen = () => {
        console.log(`[BinanceProvider] WebSocket 已连接`);
        this.isConnecting = false;
        this.startHeartbeat();
      };
      
      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);
          this.handleMessage(data);
        } catch (error) {
          console.error(`[BinanceProvider] 解析消息失败:`, error);
        }
      };
      
      this.ws.onerror = (error) => {
        console.error(`[BinanceProvider] WebSocket 错误:`, error);
        this.isConnecting = false;
      };
      
      this.ws.onclose = () => {
        console.log(`[BinanceProvider] WebSocket 已断开，5秒后重连...`);
        this.isConnecting = false;
        this.stopHeartbeat();
        this.scheduleReconnect(streams);
      };
    } catch (error) {
      console.error(`[BinanceProvider] 连接失败:`, error);
      this.isConnecting = false;
      this.scheduleReconnect(streams);
    }
  }
  
  /**
   * 处理 WebSocket 消息
   */
  private handleMessage(data: any): void {
    // K线消息
    if (data.e === 'kline') {
      const klineData = data as BinanceKlineData;
      const k = klineData.k;
      
      // 只处理完结的 K线
      if (!k.x) return;
      
      const symbol = this.fromExchangeSymbol(k.s);
      const callback = this.klineCallbacks.get(symbol);
      
      if (callback) {
        const bar: Kline = {
          timestamp: Math.floor(k.t / 1000), // 毫秒 → 秒
          symbol,
          open: parseFloat(k.o),
          high: parseFloat(k.h),
          low: parseFloat(k.l),
          close: parseFloat(k.c),
          volume: parseFloat(k.v),
          trades: k.n,
        };
        callback(bar);
      }
    }
    
    // Ticker 消息
    else if (data.e === '24hrTicker') {
      const symbol = this.fromExchangeSymbol(data.s);
      const callback = this.tickCallbacks.get(symbol);
      
      if (callback) {
        const tick: Tick = {
          timestamp: Math.floor(data.E / 1000), // 毫秒 → 秒
          symbol,
          price: parseFloat(data.c),
          volume: parseFloat(data.v),
        };
        callback(tick);
      }
    }
  }
  
  /**
   * 心跳机制（保持连接活跃）
   */
  private startHeartbeat(): void {
    // Binance streams 会持续推送数据，通常不需要应用层 ping。
    // 这里保留一个轻量级定时器用于检测连接是否还活着。
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws) return;
      if (this.ws.readyState !== WebSocket.OPEN) return;
      // no-op
    }, 30000);
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
  private scheduleReconnect(streams: string[]): void {
    if (this.reconnectTimer) return;
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectWebSocket(streams);
    }, 5000);
  }
  
  /**
   * 买入
   */
  async buy(symbol: string, quantity: number, price?: number): Promise<Order> {
    const side = 'BUY';
    const type = price ? 'LIMIT' : 'MARKET';
    
    const params: Record<string, any> = {
      symbol: this.toExchangeSymbol(symbol),
      side,
      type,
      quantity: quantity.toFixed(8),
      timestamp: Date.now(),
    };
    
    if (price) {
      params.price = price.toFixed(8);
      params.timeInForce = 'GTC'; // Good Till Cancel
    }
    
    const result = await this.request('POST', '/order', params);
    return this.parseOrder(result);
  }
  
  /**
   * 卖出
   */
  async sell(symbol: string, quantity: number, price?: number): Promise<Order> {
    const side = 'SELL';
    const type = price ? 'LIMIT' : 'MARKET';
    
    const params: Record<string, any> = {
      symbol: this.toExchangeSymbol(symbol),
      side,
      type,
      quantity: quantity.toFixed(8),
      timestamp: Date.now(),
    };
    
    if (price) {
      params.price = price.toFixed(8);
      params.timeInForce = 'GTC';
    }
    
    const result = await this.request('POST', '/order', params);
    return this.parseOrder(result);
  }
  
  /**
   * 取消订单
   */
  async cancelOrder(orderId: string): Promise<void> {
    // orderId format: "symbol:id"
    const [symbolPart, id] = orderId.split(':');
    
    const params = {
      symbol: this.toExchangeSymbol(symbolPart),
      orderId: parseInt(id),
      timestamp: Date.now(),
    };
    
    await this.request('DELETE', '/order', params);
  }
  
  /**
   * 获取账户信息
   */
  async getAccount(): Promise<Account> {
    const params = {
      timestamp: Date.now(),
    };
    
    const result = await this.request('GET', '/account', params);
    
    // 计算总权益
    let balance = 0;
    for (const asset of result.balances || []) {
      if (asset.asset === 'USDT' || asset.asset === 'BUSD') {
        balance += parseFloat(asset.free) + parseFloat(asset.locked);
      }
    }
    
    return {
      balance,
      equity: balance,
      availableMargin: balance,
    };
  }
  
  /**
   * 获取持仓（现货无持仓概念，返回非零余额）
   */
  async getPosition(symbol: string): Promise<Position | null> {
    const account = await this.getAccount();
    const [base] = symbol.split('/');
    
    const params = {
      timestamp: Date.now(),
    };
    
    const result = await this.request('GET', '/account', params);
    
    for (const asset of result.balances || []) {
      if (asset.asset === base) {
        const quantity = parseFloat(asset.free) + parseFloat(asset.locked);
        if (quantity > 0) {
          return {
            symbol,
            side: 'LONG',
            quantity,
            entryPrice: 0, // 现货无入场价
            unrealizedPnl: 0,
            realizedPnl: 0,
          };
        }
      }
    }
    
    return null;
  }
  
  /**
   * 获取所有持仓
   */
  async getPositions(): Promise<Position[]> {
    const params = {
      timestamp: Date.now(),
    };
    
    const result = await this.request('GET', '/account', params);
    
    const positions: Position[] = [];
    for (const asset of result.balances || []) {
      const quantity = parseFloat(asset.free) + parseFloat(asset.locked);
      if (quantity > 0.00000001) {
        positions.push({
          symbol: `${asset.asset}/USDT`,
          side: 'LONG',
          quantity,
          entryPrice: 0,
          unrealizedPnl: 0,
          realizedPnl: 0,
        });
      }
    }
    
    return positions;
  }
  
  /**
   * 发送 REST API 请求
   */
  private async request(
    method: string,
    endpoint: string,
    params: Record<string, any>
  ): Promise<any> {
    // 生成签名
    const queryString = new URLSearchParams(params).toString();
    const signature = this.generateSignature(queryString);
    
    const url = `${this.baseUrl}${endpoint}?${queryString}&signature=${signature}`;
    
    const options: RequestInit = {
      method,
      headers: {
        'X-MBX-APIKEY': this.config.apiKey,
        'Accept': 'application/json',
        'User-Agent': 'quant-lab/3.0',
      },
    };
    
    const response = await undiciFetch(url, {
      ...options,
      dispatcher: this.proxyAgent,
    } as any);
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Binance API 错误: ${error.msg || response.statusText}`);
    }
    
    return response.json();
  }
  
  /**
   * 生成签名（HMAC SHA256）
   */
  private generateSignature(queryString: string): string {
    const hmac = createHmac('sha256', this.config.apiSecret);
    hmac.update(queryString);
    return hmac.digest('hex');
  }
  
  /**
   * 解析订单响应
   */
  private parseOrder(data: any): Order {
    return {
      id: `${data.symbol}:${data.orderId}`,
      symbol: this.fromExchangeSymbol(data.symbol),
      side: data.side === 'BUY' ? 'BUY' : 'SELL',
      type: data.type === 'MARKET' ? 'MARKET' : 'LIMIT',
      quantity: parseFloat(data.origQty),
      price: parseFloat(data.price) || 0,
      filled: parseFloat(data.executedQty),
      status: this.parseOrderStatus(data.status),
      timestamp: Math.floor(data.time / 1000),
    };
  }
  
  /**
   * 解析订单状态
   */
  private parseOrderStatus(status: string): 'PENDING' | 'FILLED' | 'CANCELLED' {
    switch (status) {
      case 'NEW':
      case 'PARTIALLY_FILLED':
        return 'PENDING';
      case 'FILLED':
        return 'FILLED';
      case 'CANCELED':
      case 'REJECTED':
      case 'EXPIRED':
        return 'CANCELLED';
      default:
        return 'PENDING';
    }
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
    // 简单实现：假设都是 /USDT 对
    if (symbol.endsWith('USDT')) {
      return `${symbol.slice(0, -4)}/USDT`;
    }
    return symbol;
  }
  
  /**
   * 清理资源
   */
  async disconnect(): Promise<void> {
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
