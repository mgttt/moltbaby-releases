// ============================================================
// HTX (Huobi) Trading Provider - 连接 HTX 交易所
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
 * HTX 配置
 */
export interface HTXProviderConfig {
  apiKey: string;
  apiSecret: string;
  testnet?: boolean;
  proxy?: string;
}

/**
 * HTX (Huobi) Trading Provider
 */
export class HTXProvider implements TradingProvider {
  private config: HTXProviderConfig;
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

  constructor(config: HTXProviderConfig) {
    this.config = config;

    // HTX USDT Margined Contracts
    this.baseUrl = 'https://api.hbdm.com';
    this.wsUrl = 'wss://api.hbdm.com/linear-swap-ws';

    if (config.proxy) {
      this.proxyAgent = new ProxyAgent(config.proxy);
      console.log(`[HTXProvider] 使用代理: ${config.proxy}`);
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
      const htxInterval = this.toHTXInterval(interval);
      return {
        sub: `market.${symbol}.kline.${htxInterval}`,
        id: `kline_${symbol}`,
      };
    });

    // 连接 WebSocket
    await this.connectWebSocket(topics);
  }

  /**
   * 连接 WebSocket
   */
  private async connectWebSocket(topics: any[]): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.isConnecting) return;
    this.isConnecting = true;

    try {
      console.log(`[HTXProvider] 连接 WebSocket: ${this.wsUrl}`);

      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        console.log(`[HTXProvider] WebSocket 已连接`);
        this.isConnecting = false;

        // 订阅主题
        for (const topic of topics) {
          this.ws!.send(JSON.stringify(topic));
        }

        this.startHeartbeat();
      };

      this.ws.onmessage = async (event) => {
        try {
          // HTX uses gzip compression
          const data = JSON.parse(event.data as string);
          this.handleMessage(data);
        } catch (error) {
          console.error(`[HTXProvider] 解析消息失败:`, error);
        }
      };

      this.ws.onerror = (error) => {
        console.error(`[HTXProvider] WebSocket 错误:`, error);
        this.isConnecting = false;
      };

      this.ws.onclose = () => {
        if (this.shuttingDown) return;
        console.log(`[HTXProvider] WebSocket 已断开，5秒后重连...`);
        this.isConnecting = false;
        this.stopHeartbeat();
        this.scheduleReconnect(topics);
      };
    } catch (error) {
      console.error(`[HTXProvider] 连接失败:`, error);
      this.isConnecting = false;
      this.scheduleReconnect(topics);
    }
  }

  /**
   * 处理 WebSocket 消息
   */
  private handleMessage(data: any): void {
    // 响应 Ping
    if (data.ping) {
      this.ws?.send(JSON.stringify({ pong: data.ping }));
      return;
    }

    // K线消息 (待实现具体格式)
    if (data.ch && data.ch.includes('kline')) {
      // TODO: 解析 HTX K线数据格式
      console.log('[HTXProvider] K线更新:', data);
    }
  }

  /**
   * 心跳机制
   */
  private startHeartbeat(): void {
    // HTX uses ping from server, we just need to keep connection alive
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws) return;
      if (this.ws.readyState !== WebSocket.OPEN) return;
      // no-op (server sends ping)
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
  private scheduleReconnect(topics: any[]): void {
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
      contract_code: this.toExchangeSymbol(symbol),
      client_order_id: Date.now(),
      direction: 'buy',
      offset: 'open',
      volume: quantity,
      lever_rate: 10,
      order_price_type: price ? 'limit' : 'optimal_5',
    };

    if (price) {
      params.price = price;
    }

    const result = await this.request('POST', '/linear-swap-api/v1/swap_order', params);

    return this.parseOrder(result.data);
  }

  /**
   * 卖出
   */
  async sell(symbol: string, quantity: number, price?: number): Promise<Order> {
    const params: Record<string, any> = {
      contract_code: this.toExchangeSymbol(symbol),
      client_order_id: Date.now(),
      direction: 'sell',
      offset: 'close',
      volume: quantity,
      lever_rate: 10,
      order_price_type: price ? 'limit' : 'optimal_5',
    };

    if (price) {
      params.price = price;
    }

    const result = await this.request('POST', '/linear-swap-api/v1/swap_order', params);

    return this.parseOrder(result.data);
  }

  /**
   * 取消订单
   */
  async cancelOrder(orderId: string): Promise<void> {
    const [symbol, id] = orderId.split(':');
    await this.request('POST', '/linear-swap-api/v1/swap_cancel', {
      contract_code: symbol,
      order_id: id,
    });
  }

  /**
   * 获取账户信息
   */
  async getAccount(): Promise<Account> {
    const result = await this.request('POST', '/linear-swap-api/v1/swap_account_info', {});

    let balance = 0;
    let equity = 0;

    if (result.data && result.data.length > 0) {
      const account = result.data[0];
      equity = parseFloat(account.margin_balance || '0');
      balance = parseFloat(account.margin_available || '0');
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
      contract_code: this.toExchangeSymbol(symbol),
    };

    const result = await this.request('POST', '/linear-swap-api/v1/swap_position_info', params);

    if (result.data && result.data.length > 0) {
      return this.parsePosition(result.data[0]);
    }

    return null;
  }

  /**
   * 获取所有持仓
   */
  async getPositions(): Promise<Position[]> {
    const result = await this.request('POST', '/linear-swap-api/v1/swap_position_info', {});

    if (!result.data) {
      return [];
    }

    return result.data
      .filter((p: any) => parseFloat(p.volume) > 0)
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
    const timestamp = new Date().toISOString().replace(/\.\d{3}/, '');

    // HTX uses query string for authentication
    const authParams = {
      AccessKeyId: this.config.apiKey,
      SignatureMethod: 'HmacSHA256',
      SignatureVersion: '2',
      Timestamp: timestamp,
    };

    // Combine params
    const allParams = { ...authParams, ...params };

    // Build query string (sorted)
    const queryString = Object.entries(allParams)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');

    // Generate signature
    const signString = `${method}\napi.hbdm.com\n${endpoint}\n${queryString}`;
    const signature = this.generateSignature(signString);

    // Build URL
    const url = `${this.baseUrl}${endpoint}?${queryString}&Signature=${encodeURIComponent(signature)}`;

    const options: any = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'quant-lab/3.0',
      },
    };

    if (method === 'POST' && Object.keys(params).length > 0) {
      options.body = JSON.stringify(params);
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
        throw new Error(`HTX API HTTP ${response.status}: ${text.slice(0, 300)}`);
      }
      throw new Error(`HTX API 响应不是 JSON: ${text.slice(0, 300)}`);
    }

    if (!response.ok) {
      throw new Error(`HTX API HTTP ${response.status}: ${result?.err_msg || response.statusText}`);
    }

    if (result?.status !== 'ok') {
      throw new Error(`HTX API 错误: ${result?.err_msg}`);
    }

    return result;
  }

  /**
   * 生成签名（HMAC SHA256）
   */
  private generateSignature(message: string): string {
    const hmac = createHmac('sha256', this.config.apiSecret);
    hmac.update(message);
    return hmac.digest('base64');
  }

  /**
   * HTX interval mapping
   */
  private toHTXInterval(interval: string): string {
    const map: Record<string, string> = {
      '1m': '1min',
      '5m': '5min',
      '15m': '15min',
      '30m': '30min',
      '1h': '60min',
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
      id: `${data.contract_code}:${data.order_id}`,
      symbol: this.fromExchangeSymbol(data.contract_code),
      side: data.direction === 'buy' ? 'BUY' : 'SELL',
      type: data.order_price_type === 'limit' ? 'LIMIT' : 'MARKET',
      quantity: parseFloat(data.volume),
      price: parseFloat(data.price) || 0,
      filled: parseFloat(data.trade_volume) || 0,
      status: this.parseOrderStatus(data.status),
      timestamp: Math.floor(data.created_at / 1000),
    };
  }

  /**
   * 解析订单状态
   */
  private parseOrderStatus(status: number): 'PENDING' | 'FILLED' | 'CANCELLED' {
    switch (status) {
      case 3: // submitted
      case 4: // partial filled
        return 'PENDING';
      case 6: // filled
        return 'FILLED';
      case 7: // cancelled
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
      symbol: this.fromExchangeSymbol(data.contract_code),
      side: data.direction === 'buy' ? 'LONG' : 'SHORT',
      quantity: parseFloat(data.volume),
      entryPrice: parseFloat(data.cost_open),
      unrealizedPnl: parseFloat(data.profit_unreal) || 0,
      realizedPnl: parseFloat(data.profit) || 0,
    };
  }

  /**
   * 转换符号格式：BTC/USDT → BTC-USDT
   */
  private toExchangeSymbol(symbol: string): string {
    return symbol.replace('/', '-').toUpperCase();
  }

  /**
   * 转换符号格式：BTC-USDT → BTC/USDT
   */
  private fromExchangeSymbol(symbol: string): string {
    if (symbol.includes('-')) {
      return symbol.replace('-', '/');
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
