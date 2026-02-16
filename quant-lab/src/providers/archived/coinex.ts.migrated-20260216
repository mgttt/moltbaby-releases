// ============================================================
// CoinEx Trading Provider - 连接 CoinEx 交易所
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
import { execFileSync } from 'node:child_process';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

/**
 * CoinEx 配置
 */
export interface CoinExProviderConfig {
  apiKey: string;
  apiSecret: string;
  testnet?: boolean;
  proxy?: string;
}

/**
 * CoinEx Trading Provider
 */
export class CoinExProvider implements TradingProvider {
  private config: CoinExProviderConfig;
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
  private shuttingDown = false;

  constructor(config: CoinExProviderConfig) {
    this.config = config;

    // CoinEx v2 API
    this.baseUrl = 'https://api.coinex.com/v2';
    this.wsUrl = 'wss://socket.coinex.com/v2/futures';

    if (config.proxy) {
      this.proxyAgent = new ProxyAgent(config.proxy);
      console.log(`[CoinExProvider] 使用代理: ${config.proxy}`);
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
    const topics = symbols.map(s => {
      const symbol = this.toExchangeSymbol(s);
      const coinexInterval = this.toCoinExInterval(interval);
      return `kline_${symbol}_${coinexInterval}`;
    });

    // 连接 WebSocket
    await this.connectWebSocket(topics);
  }

  /**
   * 连接 WebSocket
   */
  private async connectWebSocket(topics: string[]): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.isConnecting) return;
    this.isConnecting = true;

    try {
      console.log(`[CoinExProvider] 连接 WebSocket: ${this.wsUrl}`);

      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        console.log(`[CoinExProvider] WebSocket 已连接`);
        this.isConnecting = false;

        // 订阅主题
        for (const topic of topics) {
          this.ws!.send(JSON.stringify({
            method: 'kline.subscribe',
            params: [topic],
            id: Date.now(),
          }));
        }

        this.startHeartbeat();
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);
          this.handleMessage(data);
        } catch (error) {
          console.error(`[CoinExProvider] 解析消息失败:`, error);
        }
      };

      this.ws.onerror = (error) => {
        console.error(`[CoinExProvider] WebSocket 错误:`, error);
        this.isConnecting = false;
      };

      this.ws.onclose = () => {
        if (this.shuttingDown) return;
        console.log(`[CoinExProvider] WebSocket 已断开，5秒后重连...`);
        this.isConnecting = false;
        this.stopHeartbeat();
        this.scheduleReconnect(topics);
      };
    } catch (error) {
      console.error(`[CoinExProvider] 连接失败:`, error);
      this.isConnecting = false;
      this.scheduleReconnect(topics);
    }
  }

  /**
   * 处理 WebSocket 消息
   */
  private handleMessage(data: any): void {
    // 响应 Ping
    if (data.method === 'server.ping') {
      this.ws?.send(JSON.stringify({ method: 'server.pong', params: [], id: Date.now() }));
      return;
    }

    // K线消息 (待实现具体格式)
    if (data.method === 'kline.update') {
      // TODO: 解析 CoinEx K线数据格式
      console.log('[CoinExProvider] K线更新:', data);
    }
  }

  /**
   * 心跳机制
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ method: 'server.ping', params: [], id: Date.now() }));
      }
    }, 30000); // 30秒
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
  async buy(symbol: string, quantity: number, price?: number): Promise<Order> {
    const params: Record<string, any> = {
      market: this.toExchangeSymbol(symbol),
      type: price ? 'limit' : 'market',
      side: 'buy',
      amount: quantity.toString(),
    };

    if (price) {
      params.price = price.toString();
    }

    const result = await this.request('POST', '/futures/order', params);

    return this.parseOrder(result.data);
  }

  /**
   * 卖出
   */
  async sell(symbol: string, quantity: number, price?: number): Promise<Order> {
    const params: Record<string, any> = {
      market: this.toExchangeSymbol(symbol),
      type: price ? 'limit' : 'market',
      side: 'sell',
      amount: quantity.toString(),
    };

    if (price) {
      params.price = price.toString();
    }

    const result = await this.request('POST', '/futures/order', params);

    return this.parseOrder(result.data);
  }

  /**
   * 取消订单
   */
  async cancelOrder(orderId: string): Promise<void> {
    const [symbol, id] = orderId.split(':');
    await this.request('POST', '/futures/cancel-order', {
      market: symbol,
      order_id: id,
    });
  }

  /**
   * 获取账户信息
   */
  async getAccount(): Promise<Account> {
    const result = await this.request('GET', '/assets/futures/balance', {});

    let balance = 0;
    let equity = 0;

    if (result.data) {
      // TODO: 解析 CoinEx balance 格式
      equity = parseFloat(result.data.total_balance || '0');
      balance = parseFloat(result.data.available || '0');
    }

    return {
      balance,
      equity,
      availableMargin: balance,
    };
  }

  /**
   * 获取持仓
   */
  async getPosition(symbol: string): Promise<Position | null> {
    const params = {
      market: this.toExchangeSymbol(symbol),
    };

    const result = await this.request('GET', '/futures/pending-position', params);

    if (result.data && result.data.length > 0) {
      return this.parsePosition(result.data[0]);
    }

    return null;
  }

  /**
   * 获取所有持仓
   */
  async getPositions(): Promise<Position[]> {
    const result = await this.request('GET', '/futures/pending-position', {});

    if (!result.data) {
      return [];
    }

    return result.data
      .filter((p: any) => parseFloat(p.amount) > 0)
      .map((p: any) => this.parsePosition(p));
  }

  /**
   * 发送 REST API 请求
   */
  private async request(
    method: string,
    endpoint: string,
    params: Record<string, any>
  ): Promise<any> {
    const timestamp = Date.now();
    const windowTime = 5000;

    // 构建请求参数（按 key 排序）
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

    // 生成签名
    const signString = method === 'GET' ? queryString : body;
    const signature = this.generateSignature(signString);

    // 构建 URL
    const url = `${this.baseUrl}${endpoint}${queryString ? '?' + queryString : ''}`;

    const options: any = {
      method,
      headers: {
        'X-COINEX-KEY': this.config.apiKey,
        'X-COINEX-SIGN': signature,
        'X-COINEX-TIMESTAMP': timestamp.toString(),
        'X-COINEX-WINDOWTIME': windowTime.toString(),
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'quant-lab/3.0',
      },
    };

    if (method !== 'GET') {
      options.body = body;
    }

    const response = await undiciFetch(url, {
      ...options,
      dispatcher: this.proxyAgent,
    });

    const text = await response.text();

    let result: any;
    try {
      result = text ? JSON.parse(text) : null;
    } catch {
      if (!response.ok) {
        throw new Error(`CoinEx API HTTP ${response.status}: ${text.slice(0, 300)}`);
      }
      throw new Error(`CoinEx API 响应不是 JSON: ${text.slice(0, 300)}`);
    }

    if (!response.ok) {
      throw new Error(`CoinEx API HTTP ${response.status}: ${result?.message || response.statusText}`);
    }

    if (result?.code !== 0) {
      throw new Error(`CoinEx API 错误: ${result?.message}`);
    }

    return result;
  }

  /**
   * 生成签名（HMAC SHA256）
   */
  private generateSignature(message: string): string {
    const hmac = createHmac('sha256', this.config.apiSecret);
    hmac.update(message);
    return hmac.digest('hex').toLowerCase();
  }

  /**
   * CoinEx interval mapping
   */
  private toCoinExInterval(interval: string): string {
    const map: Record<string, string> = {
      '1m': '1min',
      '5m': '5min',
      '15m': '15min',
      '30m': '30min',
      '1h': '1hour',
      '4h': '4hour',
      '1d': '1day',
      '1w': '1week',
    };

    return map[interval] || interval;
  }

  /**
   * 解析订单响应
   */
  private parseOrder(data: any): Order {
    return {
      id: `${data.market}:${data.order_id}`,
      symbol: this.fromExchangeSymbol(data.market),
      side: data.side === 'buy' ? 'BUY' : 'SELL',
      type: data.type === 'market' ? 'MARKET' : 'LIMIT',
      quantity: parseFloat(data.amount),
      price: parseFloat(data.price) || 0,
      filled: parseFloat(data.filled) || 0,
      status: this.parseOrderStatus(data.status),
      timestamp: Math.floor(data.created_at / 1000),
    };
  }

  /**
   * 解析订单状态
   */
  private parseOrderStatus(status: string): 'PENDING' | 'FILLED' | 'CANCELLED' {
    switch (status) {
      case 'open':
      case 'part_filled':
        return 'PENDING';
      case 'filled':
        return 'FILLED';
      case 'cancelled':
        return 'CANCELLED';
      default:
        return 'PENDING';
    }
  }

  /**
   * 解析持仓响应
   */
  private parsePosition(data: any): Position {
    return {
      symbol: this.fromExchangeSymbol(data.market),
      side: data.side === 'long' ? 'LONG' : 'SHORT',
      quantity: parseFloat(data.amount),
      entryPrice: parseFloat(data.entry_price),
      unrealizedPnl: parseFloat(data.unrealized_pnl) || 0,
      realizedPnl: parseFloat(data.realized_pnl) || 0,
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
    if (symbol.endsWith('USDT')) {
      return `${symbol.slice(0, -4)}/USDT`;
    }
    return symbol;
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
