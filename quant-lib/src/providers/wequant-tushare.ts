/**
 * WeQuant Tushare Proxy 数据提供者
 * 
 * 提供港股分钟线数据（1min/5min/15min/30min/60min）
 * 通过 WeQuant 代理访问 Tushare Pro API
 * 
 * ## 配置信息（见 ~/env.jsonl）
 * ```json
 * {"wequant@tushare": {
 *   "type": "quant_data",
 *   "provider": "wequant",
 *   "source": "tushare",
 *   "proxy_url": "https://wequant.fun/api/proxy/tushare",
 *   "token": "a5ac0833-859b-4034-a9fd-7562f90b6258",
 *   "proxy": "http://127.0.0.1:8890"
 * }}
 * ```
 * 
 * ## 探索过程 & 踩坑记录
 * 
 * ### 1. 速率限制（重要！）
 * - **免费用户限制**: 每小时 2 次调用（不是每分钟！）
 * - 首次测试时发现：连续调用 2 次后，第 3 次报错 "每小时最多访问该接口2次"
 * - Provider 已内置速率限制器（`rateLimit()`），自动排队等待
 * - 批量获取大量数据时会非常慢，建议：
 *   - 使用 systemd timer 定时分批次拉取
 *   - 或升级 Tushare 积分获取更多额度
 * 
 * ### 2. 接口格式
 * - 端点: POST https://wequant.fun/api/proxy/tushare
 * - 请求体: `{api_name: "hk_mins", token: "...", params: {...}}`
 * - 无需使用 Tushare SDK，纯 HTTP POST 即可
 * 
 * ### 3. 数据范围
 * - 港股分钟线接口: `hk_mins`
 * - 单次最大返回: 8000 条
 * - 支持频率: 1min, 5min, 15min, 30min, 60min
 * - 时间格式: "YYYY-MM-DD HH:MM:SS"（注意是北京时间）
 * 
 * ### 4. 权限要求
 * - 需要 Tushare Pro 账号（免费注册）
 * - 港股分钟线需要 120 积分（通过邀请等任务获取）
 * - 积分详情: https://tushare.pro/document/1?doc_id=108
 * 
 * ### 5. 股票代码格式
 * - Tushare 格式: `00001.HK` (5位数字.HK)
 * - Provider 内部标准化: `00001/HKD`
 * - 支持自动转换
 * 
 * ## 使用示例
 * 
 * ```typescript
 * import { WeQuantTushareProvider } from 'quant-lib/providers';
 * 
 * const provider = new WeQuantTushareProvider({
 *   token: 'a5ac0833-859b-4034-a9fd-7562f90b6258',
 *   proxy: 'http://127.0.0.1:8890',
 *   timeout: 60,
 * });
 * 
 * // 获取单只股票 1 分钟 K 线
 * const klines = await provider.getKlines({
 *   symbol: '00001.HK',  // 长和
 *   interval: '1m',
 *   limit: 1000,
 *   startTime: Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60, // 7天前
 * });
 * 
 * // 获取腾讯 5 分钟 K 线
 * const klines = await provider.getKlines({
 *   symbol: '00700.HK',
 *   interval: '5m',
 *   limit: 500,
 * });
 * ```
 * 
 * ## ndtsdb 集成
 * 
 * 批量收集脚本位于: `quant-lib/scripts/collect-hk-mins.ts`
 * 
 * ```bash
 * # 单只股票
 * bun run scripts/collect-hk-mins.ts --symbol 00001.HK --interval 1m --days 7
 * 
 * # 批量收集（受限于每小时2次，建议用 systemd timer 定时执行）
 * bun run scripts/collect-hk-mins.ts --symbol-list ./hk-stocks.txt --interval 5m --days 30
 * ```
 * 
 * ## 数据存储格式
 * 
 * ndtsdb 表结构:
 * - symbol: string (标准化格式如 "00001/HKD")
 * - timestamp: int64 (毫秒级 Unix 时间戳)
 * - open, high, low, close: float64
 * - volume: float64 (成交量)
 * - amount: float64 (成交额)
 * 
 * UPSERT 冲突键: symbol + timestamp（避免重复数据）
 * 
 * ## 故障排查
 * 
 * | 错误信息 | 原因 | 解决方案 |
 * |---------|------|---------|
 * | "每小时最多访问该接口2次" | 免费用户速率限制 | 等待1小时或升级积分 |
 * | "权限不足" | 积分不够或无港股权限 | 完成 Tushare 任务获取积分 |
 * | "您还没有填写手机" | 账号未完成认证 | 登录 Tushare 官网绑定手机 |
 * | 返回空数组 | 该时间段无交易数据 | 检查是否为交易日 |
 */

import { $ } from 'bun';
import { RestDataProvider } from './base.js';
import type { Kline, KlineQuery } from '../types/kline.js';
import type { ProviderConfig, Exchange, AssetType } from '../types/common.js';
import { NetworkError, RateLimitError } from '../types/common.js';

export interface WeQuantTushareConfig extends Partial<ProviderConfig> {
  /** WeQuant API Token（必需） */
  token: string;
  
  /** 代理地址（可选） */
  proxy?: string;
  
  /** 超时时间（秒，默认30秒） */
  timeout?: number;
  
  /** API 基础 URL */
  baseUrl?: string;
}

/** Tushare API 响应格式 */
interface TushareResponse {
  code: number;
  msg: string;
  data: {
    fields: string[];
    items: any[][];
  };
}

/** 港股分钟线原始数据 */
interface HKMinRaw {
  ts_code: string;
  trade_time: string;
  open: number;
  close: number;
  high: number;
  low: number;
  vol: number;
  amount: number;
}

export class WeQuantTushareProvider extends RestDataProvider {
  private baseUrl: string;
  private token: string;
  private proxy?: string;
  private timeout: number;
  
  // 速率限制控制
  private requestTimestamps: number[] = [];
  private readonly maxRequestsPerHour = 3600;  // 付费版：每小时3600次（每秒1次）
  private readonly minRequestInterval = 1000;  // 最小间隔1秒

  constructor(config: WeQuantTushareConfig) {
    super({
      name: 'WeQuantTushare',
      ...config
    });

    this.baseUrl = config.baseUrl || 'https://wequant.fun/api/proxy/tushare';
    this.token = config.token;
    this.proxy = config.proxy;
    this.timeout = config.timeout || 30;

    console.log(`  🔌 WeQuant Tushare Provider 初始化`);
    console.log(`  ⏱️  速率限制: 付费版 ${this.minRequestInterval}ms 间隔`);
    if (this.proxy) {
      console.log(`  🌐 使用代理: ${this.proxy}`);
    }
  }
  
  /**
   * 等待直到可以发送请求（速率限制）
   */
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    
    // 清理超过 1 小时的记录
    this.requestTimestamps = this.requestTimestamps.filter(ts => ts > oneHourAgo);
    
    // 如果已经达到每小时限制，等待
    if (this.requestTimestamps.length >= this.maxRequestsPerHour) {
      const oldestRequest = this.requestTimestamps[0];
      const waitTime = oldestRequest + 60 * 60 * 1000 - now + 5000; // +5s buffer
      const waitMinutes = Math.ceil(waitTime / 60000);
      console.log(`  ⏳ 速率限制: 等待 ${waitMinutes} 分钟 (${Math.ceil(waitTime / 1000)}s)`);
      await this.delay(waitTime);
      return this.rateLimit(); // 递归检查
    }
    
    // 检查最小间隔（付费版1秒）
    if (this.requestTimestamps.length > 0) {
      const lastRequest = this.requestTimestamps[this.requestTimestamps.length - 1];
      const timeSinceLastRequest = now - lastRequest;
      if (timeSinceLastRequest < this.minRequestInterval) {
        const waitTime = this.minRequestInterval - timeSinceLastRequest;
        await this.delay(waitTime);
        return this.rateLimit(); // 递归检查
      }
    }
    
    // 记录本次请求时间
    this.requestTimestamps.push(now);
  }

  get name(): string {
    return 'WeQuantTushare';
  }

  get supportedExchanges(): Exchange[] {
    return ['HKEX'];  // 港股
  }

  get supportedAssetTypes(): AssetType[] {
    return ['stock'];
  }

  /**
   * 获取 K 线数据（港股分钟线）
   * 
   * 注意：Tushare 港股分钟线接口限制：
   * - 单次最大 8000 条
   * - 每小时最多 2 次调用（免费用户）
   * - 需要通过日期循环获取大量数据
   * 
   * @param query - K线查询参数
   * @returns K线数组
   */
  async getKlines(query: KlineQuery): Promise<Kline[]> {
    const { symbol, interval, limit = 8000, startTime, endTime } = query;

    // 转换时间间隔格式
    const freq = this.convertInterval(interval);

    // 转换股票代码格式
    const tsCode = this.toExchangeSymbol(symbol);

    // 转换时间格式
    const startDate = startTime ? this.formatDateTime(startTime) : undefined;
    const endDate = endTime ? this.formatDateTime(endTime) : undefined;

    // 如果 limit > 8000，需要分批获取
    if (limit > 8000) {
      return this.getKlinesBatched(tsCode, freq, limit, startTime, endTime);
    }

    return this.fetchHKMins(tsCode, freq, limit, startDate, endDate);
  }

  /**
   * 分批获取大量 K 线数据
   * 
   * 策略：
   * 1. 估算每天产生的 K 线数量（根据 interval）
   * 2. 每次请求估算需要的时间范围
   * 3. 自动 rateLimit 控制请求频率
   */
  private async getKlinesBatched(
    tsCode: string,
    freq: string,
    limit: number,
    startTime?: number,
    endTime?: number
  ): Promise<Kline[]> {
    const allKlines: Kline[] = [];
    let remaining = limit;

    // 默认获取最近 30 天的数据
    let currentEndTime = endTime || Math.floor(Date.now() / 1000);

    while (remaining > 0 && currentEndTime > (startTime || 0)) {
      const batchSize = Math.min(remaining, 8000);

      // 估算时间范围（港股每天约 4 小时交易时间）
      // 1min: 240 条/天, 5min: 48 条/天, 15min: 16 条/天, 30min: 8 条/天, 60min: 4 条/天
      const barsPerDay = this.getBarsPerDay(freq);
      const daysNeeded = Math.ceil(batchSize / barsPerDay) + 1;

      const batchStartTime = Math.max(
        currentEndTime - daysNeeded * 24 * 60 * 60,
        startTime || 0
      );

      const batchStartDate = this.formatDateTime(batchStartTime);
      const batchEndDate = this.formatDateTime(currentEndTime);

      const batch = await this.fetchHKMins(
        tsCode, 
        freq, 
        batchSize, 
        batchStartDate, 
        batchEndDate
      );

      if (batch.length === 0) break;

      allKlines.push(...batch);
      remaining -= batch.length;

      // 更新结束时间为最早一条数据的时间
      const earliestTs = Math.min(...batch.map(k => Math.floor(k.timestamp / 1000)));
      currentEndTime = Math.floor(earliestTs / 1000) - 60; // 往前一分钟

      // rateLimit 会自动处理请求间隔（每小时2次限制）
    }

    // 按时间排序
    return allKlines.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * 获取每根 K 线代表的天数（港股约 4 小时交易时间）
   */
  private getBarsPerDay(freq: string): number {
    const map: Record<string, number> = {
      '1min': 240,   // 09:30-12:00, 13:00-16:00 ≈ 4小时
      '5min': 48,
      '15min': 16,
      '30min': 8,
      '60min': 4
    };
    return map[freq] || 240;
  }

  /**
   * 调用 Tushare 港股分钟线接口
   * 
   * 注意：此函数会自动处理速率限制，调用前无需手动检查
   */
  private async fetchHKMins(
    tsCode: string,
    freq: string,
    limit: number,
    startDate?: string,
    endDate?: string
  ): Promise<Kline[]> {
    // 速率限制检查
    await this.rateLimit();

    const params: Record<string, any> = {
      api_name: 'hk_mins',
      token: this.token,
      params: {
        ts_code: tsCode,
        freq: freq
      },
      fields: ''
    };

    if (startDate) {
      params.params.start_date = startDate;
    }
    if (endDate) {
      params.params.end_date = endDate;
    }

    try {
      const payload = JSON.stringify(params);

      // 构建 curl 命令（Bun 的 fetch 不支持代理，使用 curl）
      let curlCmd = [
        'curl', '-s', '--max-time', String(this.timeout),
        '-X', 'POST',
        '-H', 'Content-Type: application/json',
        '-d', payload
      ];

      if (this.proxy) {
        curlCmd.push('--proxy', this.proxy);
      }

      curlCmd.push(this.baseUrl);

      const response = await $`${curlCmd}`.text();

      const data: TushareResponse = JSON.parse(response);

      if (data.code !== 0) {
        if (data.msg?.includes('权限')) {
          throw new Error(`Tushare API 权限不足: ${data.msg}`);
        }
        if (data.msg?.includes('积分')) {
          throw new RateLimitError(`Tushare API 积分不足: ${data.msg}`);
        }
        throw new Error(`Tushare API error ${data.code}: ${data.msg}`);
      }

      if (!data.data || !data.data.items) {
        return [];
      }

      // 解析数据
      const items = data.data.items;
      const fields = data.data.fields;

      const rawData: HKMinRaw[] = items.map((item: any[]) => {
        const row: any = {};
        fields.forEach((field, i) => {
          row[field] = item[i];
        });
        return row as HKMinRaw;
      });

      return this.transformKlines(rawData, freq);

    } catch (error: any) {
      if (error.message?.includes('积分') || error.message?.includes('每小时')) {
        throw new RateLimitError(`Tushare API 限流: ${error.message}`);
      }
      throw new NetworkError(`获取 ${tsCode} K线失败: ${error.message}`, error);
    }
  }

  /**
   * 转换 K 线数据为标准格式
   */
  private transformKlines(rawData: HKMinRaw[], interval: string): Kline[] {
    return rawData.map(row => {
      const normalized = this.normalizeSymbol(row.ts_code);
      const [base, quote] = normalized.split('/');

      // 解析交易时间（北京时间）
      // trade_time 格式: "2023-03-13 16:10:00"
      const tradeTime = new Date(row.trade_time.replace(' ', 'T') + '+08:00');
      const timestamp = tradeTime.getTime();

      return {
        symbol: normalized,
        exchange: 'HKEX' as Exchange,
        baseCurrency: base,
        quoteCurrency: quote,
        interval,
        timestamp,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.vol,
        quoteVolume: row.amount,
        trades: 0,  // Tushare 不提供成交笔数
        takerBuyVolume: 0,
        takerBuyQuoteVolume: 0
      };
    });
  }

  /**
   * 转换时间间隔格式
   * 
   * 支持输入：1m, 5m, 15m, 30m, 1h, 60m
   * 转换为：1min, 5min, 15min, 30min, 60min
   */
  private convertInterval(interval: string): string {
    const map: Record<string, string> = {
      '1m': '1min',
      '5m': '5min',
      '15m': '15min',
      '30m': '30min',
      '1h': '60min',
      '60m': '60min'
    };

    const result = map[interval];
    if (!result) {
      throw new Error(`不支持的 interval: ${interval}，港股分钟线支持: 1m, 5m, 15m, 30m, 1h`);
    }
    return result;
  }

  /**
   * 标准化符号：00001.HK → 00001/HKD
   */
  normalizeSymbol(symbol: string): string {
    if (symbol.includes('/')) return symbol;

    // 处理 00001.HK 格式
    if (symbol.endsWith('.HK')) {
      const code = symbol.replace('.HK', '');
      return `${code}/HKD`;
    }

    return `${symbol}/HKD`;
  }

  /**
   * 转换为交易所符号：00001/HKD → 00001.HK
   */
  toExchangeSymbol(symbol: string): string {
    return symbol.replace('/HKD', '.HK').replace('/HK', '.HK');
  }

  /**
   * 格式化时间戳为 Tushare 格式
   * 
   * 输出格式: "YYYY-MM-DD HH:MM:SS"
   */
  private formatDateTime(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    const second = String(date.getSeconds()).padStart(2, '0');

    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
  }

  /**
   * 检查符号是否支持（港股）
   */
  async isSymbolSupported(symbol: string): Promise<boolean> {
    // 检查是否是港股格式
    return symbol.endsWith('.HK') || symbol.endsWith('/HKD');
  }

  /**
   * 健康检查（港股专用）
   * 
   * 使用 00001.HK (长和) 作为测试标的
   */
  async healthCheck(): Promise<boolean> {
    try {
      const klines = await this.getKlines({
        symbol: '00001.HK',
        interval: '1m',
        limit: 1,
        startTime: Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60,
      });
      return klines.length > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * 延迟函数
   */
  protected delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Dummy implementation (curl-based provider)
   */
  protected async request<T = any>(
    method: string,
    endpoint: string,
    params?: Record<string, any>,
    data?: any
  ): Promise<T> {
    throw new Error('request() not implemented - use curl directly');
  }

  protected buildUrl(endpoint: string, params?: Record<string, any>): string {
    return this.baseUrl;
  }
}
