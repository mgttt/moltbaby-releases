/**
 * Bybit REST API 数据提供者
 * 
 * 特点：
 * - ✅ 官方 V5 API，稳定可靠
 * - ✅ 支持代理（CloudFront 地区限制需使用代理）
 * - ✅ 支持现货余额和合约持仓查询
 */

import type { ProviderConfig } from '../types/common';
import { NetworkError, AuthError } from '../types/common';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

export interface BybitProviderConfig extends Partial<ProviderConfig> {
  /** API Key */
  apiKey: string;
  
  /** API Secret */
  apiSecret: string;
  
  /** 代理地址（可选，默认 http://127.0.0.1:8890） */
  proxy?: string;
  
  /** API 基础 URL（默认 https://api.bybit.com） */
  baseUrl?: string;
  
  /** 超时时间（毫秒，默认10秒） */
  timeout?: number;
}

/** 钱包余额响应 */
export interface WalletBalanceResponse {
  retCode: number;
  retMsg: string;
  result: {
    list: Array<{
      accountType: string;
      totalEquity: string;
      totalWalletBalance: string;
      totalAvailableBalance: string;
      totalPerpUPL: string;
      totalInitialMargin: string;
      totalMaintenanceMargin: string;
      coin: Array<{
        coin: string;
        walletBalance: string;
        availableToWithdraw: string;
        usdValue: string;
        unrealisedPnl: string;
      }>;
    }>;
  };
}

/** 持仓响应 */
export interface PositionResponse {
  retCode: number;
  retMsg: string;
  result: {
    list: Array<{
      symbol: string;
      side: string;
      size: string;
      avgPrice: string;
      markPrice: string;
      leverage: string;
      unrealisedPnl: string;
      cumRealisedPnl: string;
      positionValue: string;
      liqPrice: string;
    }>;
  };
}

/** 币种余额 */
export interface CoinBalance {
  coin: string;
  walletBalance: number;
  availableToWithdraw: number;
  usdValue: number;
  unrealisedPnl: number;
}

/** 合约持仓 */
export interface Position {
  symbol: string;
  side: string;
  size: number;
  avgPrice: number;
  markPrice: number;
  leverage: number;
  unrealisedPnl: number;
  cumRealisedPnl: number;
  positionValue: number;
  liqPrice: number;
}

/** 账户概览 */
export interface AccountOverview {
  accountType: string;
  totalEquity: number;
  totalWalletBalance: number;
  totalAvailableBalance: number;
  totalPerpUPL: number;
  totalInitialMargin: number;
  totalMaintenanceMargin: number;
  coins: CoinBalance[];
}

export class BybitProvider {
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;
  private proxyUrl: string;
  private proxyAgent?: InstanceType<typeof ProxyAgent>;
  private timeout: number;
  
  constructor(config: BybitProviderConfig) {
    if (!config.apiKey || !config.apiSecret) {
      throw new Error('BybitProvider requires apiKey and apiSecret');
    }
    
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.baseUrl = config.baseUrl || 'https://api.bybit.com';
    this.proxyUrl = config.proxy || 'http://127.0.0.1:8890';
    this.timeout = config.timeout || 10000;
    
    // 创建 ProxyAgent
    this.proxyAgent = new ProxyAgent(this.proxyUrl);
  }
  
  get name(): string {
    return 'Bybit';
  }
  
  /**
   * 获取钱包余额（UTA / Account Wallet Balance）
   *
   * Bybit V5 文档：`GET /v5/account/wallet-balance` 仅支持 `accountType=UNIFIED`。
   * Funding 等其他钱包请使用 Asset 相关接口（例如 all-balance）。
   */
  async getWalletBalance(accountType: 'UNIFIED' = 'UNIFIED'): Promise<AccountOverview> {
    const data = await this.signedRequest<WalletBalanceResponse>(
      'GET',
      '/v5/account/wallet-balance',
      { accountType }
    );
    
    if (data.retCode !== 0) {
      throw new AuthError(`Bybit API Error [${data.retCode}]: ${data.retMsg}`);
    }
    
    const account = data.result.list[0];
    if (!account) {
      return {
        accountType,
        totalEquity: 0,
        totalWalletBalance: 0,
        totalAvailableBalance: 0,
        totalPerpUPL: 0,
        totalInitialMargin: 0,
        totalMaintenanceMargin: 0,
        coins: []
      };
    }
    
    return {
      accountType,
      totalEquity: parseFloat(account.totalEquity) || 0,
      totalWalletBalance: parseFloat(account.totalWalletBalance) || 0,
      totalAvailableBalance: parseFloat(account.totalAvailableBalance) || 0,
      totalPerpUPL: parseFloat(account.totalPerpUPL) || 0,
      totalInitialMargin: parseFloat(account.totalInitialMargin) || 0,
      totalMaintenanceMargin: parseFloat(account.totalMaintenanceMargin) || 0,
      coins: (account.coin || [])
        .filter(c => parseFloat(c.walletBalance) > 0)
        .map(c => ({
          coin: c.coin,
          walletBalance: parseFloat(c.walletBalance) || 0,
          availableToWithdraw: parseFloat(c.availableToWithdraw) || 0,
          usdValue: parseFloat(c.usdValue) || 0,
          unrealisedPnl: parseFloat(c.unrealisedPnl) || 0
        }))
        .sort((a, b) => b.usdValue - a.usdValue)
    };
  }
  
  /**
   * 获取合约持仓
   * @param category 合约类型: linear | inverse
   * @param settleCoin 结算币种（可选，如 USDT）
   */
  async getPositions(
    category: 'linear' | 'inverse' = 'linear',
    settleCoin?: string
  ): Promise<Position[]> {
    const params: Record<string, string> = { category };
    if (settleCoin) {
      params.settleCoin = settleCoin;
    }
    
    const data = await this.signedRequest<PositionResponse>(
      'GET',
      '/v5/position/list',
      params
    );
    
    if (data.retCode !== 0) {
      throw new AuthError(`Bybit API Error [${data.retCode}]: ${data.retMsg}`);
    }
    
    return (data.result.list || [])
      .filter(p => parseFloat(p.size) !== 0)
      .map(p => ({
        symbol: p.symbol,
        side: p.side,
        size: parseFloat(p.size) || 0,
        avgPrice: parseFloat(p.avgPrice) || 0,
        markPrice: parseFloat(p.markPrice) || 0,
        leverage: parseFloat(p.leverage) || 1,
        unrealisedPnl: parseFloat(p.unrealisedPnl) || 0,
        cumRealisedPnl: parseFloat(p.cumRealisedPnl) || 0,
        positionValue: parseFloat(p.positionValue) || 0,
        liqPrice: parseFloat(p.liqPrice) || 0
      }))
      .sort((a, b) => b.unrealisedPnl - a.unrealisedPnl);
  }
  
  /**
   * P2修复：获取未完成订单（订单闭环对账 - bot-009/鲶鱼建议）
   * @param symbol 交易对
   * @param category 类别
   * @param limit 返回数量限制
   */
  async getOpenOrders(
    symbol?: string,
    category: 'linear' | 'inverse' | 'spot' = 'linear',
    limit: number = 50
  ): Promise<any[]> {
    const params: Record<string, string> = { 
      category,
      limit: limit.toString()
    };
    if (symbol) {
      params.symbol = symbol;
    } else {
      // P1修复：Bybit API要求至少传symbol/settleCoin/baseCoin之一（bot-009发现）
      // linear永续合约默认使用USDT作为settleCoin
      if (category === 'linear') {
        params.settleCoin = 'USDT';
      } else if (category === 'spot') {
        params.baseCoin = 'USDT';
      }
    }
    
    const data = await this.signedRequest<any>(
      'GET',
      '/v5/order/realtime',
      params
    );
    
    if (data.retCode !== 0) {
      throw new AuthError(`Bybit API Error [${data.retCode}]: ${data.retMsg}`);
    }
    
    console.log(`[BybitProvider] getOpenOrders: ${(data.result.list || []).length} 个未完成订单`);
    return data.result.list || [];
  }

  /**
   * P2修复：获取成交记录（订单闭环对账 - bot-009/鲶鱼建议）
   * @param symbol 交易对
   * @param category 类别
   * @param limit 返回数量限制
   * @param startTime 开始时间（毫秒时间戳）
   */
  async getExecutions(
    symbol?: string,
    category: 'linear' | 'inverse' | 'spot' = 'linear',
    limit: number = 50,
    startTime?: number
  ): Promise<any[]> {
    const params: Record<string, string> = { 
      category,
      limit: limit.toString()
    };
    if (symbol) {
      params.symbol = symbol;
    }
    if (startTime) {
      params.startTime = startTime.toString();
    }
    
    const data = await this.signedRequest<any>(
      'GET',
      '/v5/execution/list',
      params
    );
    
    if (data.retCode !== 0) {
      throw new AuthError(`Bybit API Error [${data.retCode}]: ${data.retMsg}`);
    }
    
    console.log(`[BybitProvider] getExecutions: ${(data.result.list || []).length} 个成交记录`);
    return data.result.list || [];
  }

  /**
   * 获取最新行情（公开 API，无需签名）
   * @param symbol 交易对，如 BTCUSDT
   * @param category 类别: spot | linear | inverse
   */
  async getTickers(symbol?: string, category: 'spot' | 'linear' | 'inverse' = 'linear'): Promise<any> {
    const params: Record<string, string> = { category };
    if (symbol) {
      params.symbol = symbol;
    }
    
    return this.publicRequest('GET', '/v5/market/tickers', params);
  }
  
  /**
   * 获取 K 线数据（公开 API）
   */
  async getKlines(params: {
    category: 'spot' | 'linear' | 'inverse';
    symbol: string;
    interval: string;
    limit?: number;
    start?: number;
    end?: number;
  }): Promise<any[]> {
    const query: Record<string, string> = {
      category: params.category,
      symbol: params.symbol,
      interval: params.interval
    };
    
    if (params.limit) query.limit = params.limit.toString();
    if (params.start) query.start = params.start.toString();
    if (params.end) query.end = params.end.toString();
    
    const data = await this.publicRequest<any>('GET', '/v5/market/kline', query);
    
    if (data.retCode !== 0) {
      throw new Error(`Bybit API Error [${data.retCode}]: ${data.retMsg}`);
    }
    
    return data.result?.list || [];
  }
  
  /**
   * 获取完整持仓概览（UNIFIED 钱包 + 合约）
   */
  async getFullPortfolio(): Promise<{
    unified: AccountOverview;
    positions: Position[];
    timestamp: string;
  }> {
    const [unified, positions] = await Promise.all([
      this.getWalletBalance('UNIFIED'),
      this.getPositions('linear', 'USDT')
    ]);

    return {
      unified,
      positions,
      timestamp: new Date().toISOString()
    };
  }
  
  /**
   * 生成 API 签名
   */
  private generateSignature(timestamp: string, queryString: string): string {
    const recvWindow = '5000';
    const signStr = timestamp + this.apiKey + recvWindow + queryString;
    return crypto.createHmac('sha256', this.apiSecret).update(signStr).digest('hex');
  }
  
  /**
   * 发送签名请求
   */
  private async signedRequest<T>(
    method: string,
    endpoint: string,
    params?: Record<string, string>
  ): Promise<T> {
    // NOTE: In this environment, undici ProxyAgent may not work with our local proxy,
    // and requests can still hit CloudFront region blocks (403 HTML).
    // We attempt undici first, then fall back to curl when we detect the CloudFront block page.

    const timestamp = Date.now().toString();
    const recvWindow = '5000';
    
    // 构建查询字符串（按字母排序）
    const queryString = params
      ? Object.entries(params)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
          .join('&')
      : '';
    
    // 生成签名
    const signStr = timestamp + this.apiKey + recvWindow + queryString;
    const signature = crypto.createHmac('sha256', this.apiSecret).update(signStr).digest('hex');
    
    // 构建 URL
    const url = queryString
      ? `${this.baseUrl}${endpoint}?${queryString}`
      : `${this.baseUrl}${endpoint}`;
    
    // 构建请求选项
    const options: Parameters<typeof undiciFetch>[1] = {
      method,
      headers: {
        'X-BAPI-API-KEY': this.apiKey,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': recvWindow,
        'X-BAPI-SIGN': signature,
        'Content-Type': 'application/json',
        'User-Agent': 'QuantLib/1.0'
      }
    };
    
    // 设置代理
    if (this.proxyAgent) {
      options.dispatcher = this.proxyAgent;
    }
    
    // 设置超时
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    options.signal = controller.signal;
    
    try {
      const response = await undiciFetch(url, options);
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const isCloudFrontBlock =
          response.status === 403 &&
          body.includes('The request could not be satisfied');

        if (isCloudFrontBlock) {
          // Fallback to curl with explicit --proxy.
          return this.signedRequestViaCurl<T>(method, url, {
            'X-BAPI-API-KEY': this.apiKey,
            'X-BAPI-TIMESTAMP': timestamp,
            'X-BAPI-RECV-WINDOW': recvWindow,
            'X-BAPI-SIGN': signature,
            'Content-Type': 'application/json',
            'User-Agent': 'QuantLib/1.0',
          });
        }

        const error: any = new Error(
          `HTTP ${response.status}: ${response.statusText}${body ? ` | body: ${body.slice(0, 200)}` : ''}`
        );
        error.statusCode = response.status;
        throw error;
      }

      return (await response.json()) as T;
    } catch (error: any) {
      clearTimeout(timeoutId);
      
      if (error.name === 'AbortError') {
        throw new NetworkError(`请求超时 (${this.timeout}ms)`);
      }
      
      if (error.statusCode === 401 || error.statusCode === 403) {
        throw new AuthError(`认证失败: ${error.message}`);
      }
      
      throw new NetworkError(`Bybit API 请求失败: ${error.message}`, error);
    }
  }

  /**
   * 发送公开请求（无需签名）
   * 公开 API 也可能有区域限制，使用 curl fallback
   */
  private async publicRequest<T>(
    method: string,
    endpoint: string,
    params?: Record<string, string>
  ): Promise<T> {
    // 构建查询字符串
    const queryString = params
      ? Object.entries(params)
          .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
          .join('&')
      : '';
    
    const url = queryString
      ? `${this.baseUrl}${endpoint}?${queryString}`
      : `${this.baseUrl}${endpoint}`;
    
    // 使用 curl fallback（代理支持更好）
    return this.publicRequestViaCurl<T>(url);
  }

  /**
   * 使用 curl 发送公开请求（更好的代理支持）
   */
  private publicRequestViaCurl<T>(url: string): T {
    const args: string[] = ['-sS', '-L'];
    
    if (this.proxyUrl) {
      args.push('--proxy', this.proxyUrl);
    }
    
    args.push('-H', 'Content-Type: application/json');
    args.push('-H', 'User-Agent: QuantLib/1.0');
    args.push(url);

    try {
      const out = execFileSync('curl', args, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: this.timeout
      });
      
      return JSON.parse(out) as T;
    } catch (error: any) {
      // P2改进：详细错误信息（bot-003建议）
      const stderr = error.stderr?.toString() || '';
      const exitCode = error.status || error.code || 'unknown';
      
      // 分类错误
      let errorType = 'unknown';
      let errorDetail = '';
      
      if (error.message?.includes('timeout') || stderr.includes('timeout')) {
        errorType = 'timeout';
        errorDetail = `请求超时 (${this.timeout}ms)`;
      } else if (exitCode === 7 || stderr.includes('Failed to connect') || stderr.includes('Could not resolve proxy')) {
        errorType = 'proxy';
        errorDetail = `代理连接失败 (proxy=${this.proxyUrl})`;
      } else if (exitCode === 35 || stderr.includes('SSL') || stderr.includes('unexpected eof')) {
        errorType = 'ssl';
        errorDetail = `SSL连接错误 (exit=${exitCode})`;
      } else if (exitCode === 28) {
        errorType = 'timeout';
        errorDetail = `curl超时 (exit=${exitCode})`;
      } else if (stderr.includes('503') || stderr.includes('Service Unavailable')) {
        errorType = 'bybit_503';
        errorDetail = 'Bybit服务不可用(503)';
      } else {
        errorDetail = `未知错误 (exit=${exitCode})`;
      }
      
      console.error(`[BybitProvider] Curl请求失败:`);
      console.error(`  类型: ${errorType}`);
      console.error(`  详情: ${errorDetail}`);
      console.error(`  命令: curl ${args.join(' ')}`);
      console.error(`  exit code: ${exitCode}`);
      console.error(`  stderr: ${stderr}`);
      
      throw new NetworkError(`Bybit API 请求失败 [${errorType}]: ${errorDetail}`, error);
    }
  }

  private signedRequestViaCurl<T>(
    method: string,
    url: string,
    headers: Record<string, string>
  ): T {
    // Only GET is needed for the endpoints we use right now.
    if (method !== 'GET') {
      throw new Error(`curl fallback only supports GET (got ${method})`);
    }

    const args: string[] = ['-sS'];
    if (this.proxyUrl) {
      args.push('--proxy', this.proxyUrl);
    }

    for (const [k, v] of Object.entries(headers)) {
      args.push('-H', `${k}: ${v}`);
    }

    args.push(url);

    try {
      const out = execFileSync('curl', args, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      return JSON.parse(out) as T;
    } catch (error: any) {
      // P2改进：详细错误信息（bot-003建议）
      const stderr = error.stderr?.toString() || '';
      const exitCode = error.status || error.code || 'unknown';
      
      // 分类错误
      let errorType = 'unknown';
      let errorDetail = '';
      
      if (exitCode === 7 || stderr.includes('Failed to connect') || stderr.includes('Could not resolve proxy')) {
        errorType = 'proxy';
        errorDetail = `代理连接失败 (proxy=${this.proxyUrl})`;
      } else if (exitCode === 35 || stderr.includes('SSL') || stderr.includes('unexpected eof')) {
        errorType = 'ssl';
        errorDetail = `SSL连接错误 (exit=${exitCode})`;
      } else if (exitCode === 28) {
        errorType = 'timeout';
        errorDetail = `curl超时 (exit=${exitCode})`;
      } else if (stderr.includes('503') || stderr.includes('Service Unavailable')) {
        errorType = 'bybit_503';
        errorDetail = 'Bybit服务不可用(503)';
      } else {
        errorDetail = `未知错误 (exit=${exitCode})`;
      }
      
      console.error(`[BybitProvider] Curl请求失败 (signed):`);
      console.error(`  类型: ${errorType}`);
      console.error(`  详情: ${errorDetail}`);
      console.error(`  命令: curl ${args.join(' ')}`);
      console.error(`  exit code: ${exitCode}`);
      console.error(`  stderr: ${stderr}`);
      
      throw new NetworkError(`Bybit API 请求失败 (signed) [${errorType}]: ${errorDetail}`, error);
    }
  }
}
