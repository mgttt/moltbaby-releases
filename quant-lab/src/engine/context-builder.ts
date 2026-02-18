import type { QuickJSContext } from 'quickjs-emscripten';
import type { 
  AccountConfig, 
  BybitAPI, 
  Logger, 
  StrategyConfig, 
  Ticker, 
  Position, 
  Order, 
  OrderParams,
  AccountInfo,
  AccountType
} from '../types.js';
import { 
  BybitProvider, 
  PaperTradingProvider,
  type PaperOrder,
  type PaperPosition
} from '../../../quant-lib/src';
import type { ExchangeAPI } from '../../../quant-lib/src';

/**
 * 账号配置加载器
 * 从 ~/env.jsonl 加载账号配置
 *
 * env.jsonl 兼容两种形态：
 * - 严格 JSONL：{"wjcgm@bbt-demo": {...}, ...}
 * - legacy：[{"name":"wjcgm@bbt-demo", ...}]
 * 以及字段兼容：key/secret 或 BYBIT_API_KEY/BYBIT_API_SECRET
 */
function normalizeBybitAccountConfig(raw: any, accountName: string): AccountConfig {
  const cfg: any = {
    ...raw,
    name: raw.name || accountName,
    proxy: raw.proxy,
    readonly: raw.readonly ?? false,
    BYBIT_ENV: raw.BYBIT_ENV,
    maxPositionUsd: raw.maxPositionUsd,
  };

  // 兼容旧字段
  const apiKey = raw.BYBIT_API_KEY || raw.apiKey || raw.key;
  const apiSecret = raw.BYBIT_API_SECRET || raw.apiSecret || raw.secret;

  if (!apiKey || !apiSecret) {
    throw new Error(`[Accounts] Account missing apiKey/apiSecret: ${accountName}`);
  }

  cfg.BYBIT_API_KEY = apiKey;
  cfg.BYBIT_API_SECRET = apiSecret;

  return cfg as AccountConfig;
}

export async function loadAccountConfig(accountName: string): Promise<AccountConfig> {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
  const envPath = `${homeDir}/env.jsonl`;

  try {
    const fs = await import('node:fs/promises');
    const content = await fs.readFile(envPath, 'utf-8');

    // 先尝试加载为严格 JSONL（每行一个对象）
    const lines = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line);

    // 快速路径：逐行 JSON 对象匹配键值
    for (const line of lines) {
      try {
        const block = JSON.parse(line);
        if (block[accountName]) {
          return normalizeBybitAccountConfig(block[accountName], accountName);
        }
      } catch {
        // 非 JSON 行略过
      }
    }

    // 兼容 legacy: 一些行本身是 {name:"...", ...}
    for (const line of lines) {
      try {
        const block = JSON.parse(line);
        if (typeof block === 'object' && block && block.name === accountName) {
          return normalizeBybitAccountConfig(block, accountName);
        }
      } catch {
        // skip
      }
    }

    // 兼容 env.jsonl 存成单个大 object（已通过历史脚本支持）
    try {
      const merged = JSON.parse(content);
      if (merged && typeof merged === 'object') {
        if (merged[accountName]) {
          return normalizeBybitAccountConfig(merged[accountName], accountName);
        }
        for (const v of Object.values(merged)) {
          if (v && typeof v === 'object' && (v as any).name === accountName) {
            return normalizeBybitAccountConfig(v as any, accountName);
          }
        }
      }
    } catch {
      // ignore, fallthrough
    }

    throw new Error(`Account "${accountName}" not found in ${envPath}`);
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      throw new Error(`env.jsonl not found at ${envPath}`);
    }
    throw error;
  }
}

/**
 * 判断账户类型
 */
export function getAccountType(accountName: string): AccountType {
  return accountName.startsWith('paper-') ? 'paper' : 'real';
}

/**
 * 获取账户信息
 */
export async function getAccountInfo(accountName: string): Promise<AccountInfo> {
  const type = getAccountType(accountName);
  
  if (type === 'paper') {
    return {
      type: 'paper',
      name: accountName,
      isReadonly: false
    };
  }
  
  // 真实账户
  const config = await loadAccountConfig(accountName);
  return {
    type: 'real',
    name: accountName,
    isReadonly: config.readonly ?? false
  };
}

/**
 * 创建 API 客户端（Bybit 或 Paper Trading）
 */
export async function createAPIClient(accountName: string): Promise<ExchangeAPI> {
  const type = getAccountType(accountName);
  
  if (type === 'paper') {
    // 模拟交易账户
    const paperName = accountName.replace(/^paper-/, '');
    const paper = new PaperTradingProvider({
      accountName: paperName,
      stateDir: './runtime/paper-state'
    });
    await paper.init();
    
    // 包装为 ExchangeAPI 接口
    return new PaperAPIWrapper(paper);
  }
  
  // 真实账户
  const config = await loadAccountConfig(accountName);
  const bybit = new BybitProvider({
    apiKey: config.BYBIT_API_KEY,
    apiSecret: config.BYBIT_API_SECRET,
    proxy: config.proxy
  });
  
  // 包装为 ExchangeAPI 接口（只读或完全访问）
  return new BybitAPIWrapper(bybit, config);
}

/**
 * Paper Trading API 包装器
 * 适配 PaperTradingProvider 到 ExchangeAPI 接口
 */
class PaperAPIWrapper implements ExchangeAPI {
  constructor(private paper: PaperTradingProvider) {}

  async getPrice(symbol: string): Promise<number> {
    return this.paper.getPrice(symbol);
  }

  async getTicker(symbol: string): Promise<any> {
    return this.paper.getTicker(symbol);
  }

  async getKlines(symbol: string, interval: string, limit?: number): Promise<any[]> {
    return this.paper.getKlines(symbol, interval, limit);
  }

  async placeOrder(params: OrderParams): Promise<any> {
    const result = await this.paper.placeOrder(params);
    if (!result.success) {
      throw new Error(result.error || 'Order failed');
    }
    return this.mapOrder(result.order!);
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    return this.paper.cancelOrder(orderId);
  }

  async getOrder(orderId: string): Promise<any | null> {
    const order = await this.paper.getOrder(orderId);
    return order ? this.mapOrder(order) : null;
  }

  async getActiveOrders(symbol?: string): Promise<any[]> {
    const orders = await this.paper.getActiveOrders(symbol);
    return orders.map(o => this.mapOrder(o));
  }

  async getPosition(symbol: string): Promise<any | null> {
    const pos = await this.paper.getPosition(symbol);
    return pos ? this.mapPosition(pos) : null;
  }

  async getPositions(): Promise<any[]> {
    const positions = await this.paper.getPositions();
    return positions.map(p => this.mapPosition(p));
  }

  async getBalance(coin?: string): Promise<any> {
    return this.paper.getBalance(coin);
  }

  private mapOrder(order: PaperOrder): any {
    return {
      orderId: order.orderId,
      symbol: order.symbol,
      side: order.side,
      orderType: order.orderType,
      qty: order.qty,
      price: order.price,
      status: order.status,
      createdAt: order.createdAt
    };
  }

  private mapPosition(pos: PaperPosition): any {
    return {
      symbol: pos.symbol,
      side: pos.side,
      size: pos.size,
      avgPrice: pos.avgPrice,
      markPrice: pos.markPrice,
      leverage: 1,
      unrealisedPnl: pos.unrealisedPnl,
      positionValue: pos.positionValue
    };
  }
}

/**
 * Bybit API 包装器
 * 适配 BybitProvider 到 ExchangeAPI 接口
 */
class BybitAPIWrapper implements ExchangeAPI {
  constructor(
    private bybit: BybitProvider,
    private config: AccountConfig
  ) {}

  async getPrice(symbol: string): Promise<number> {
    const ticker = await this.bybit.getTickers(symbol);
    return parseFloat(ticker.lastPrice);
  }

  async getTicker(symbol: string): Promise<any> {
    return this.bybit.getTickers(symbol);
  }

  async getKlines(symbol: string, interval: string, limit?: number): Promise<any[]> {
    const formattedSymbol = symbol.replace('/', '');
    return this.bybit.getKlines({
      category: 'linear',
      symbol: formattedSymbol,
      interval,
      limit
    });
  }

  async placeOrder(params: OrderParams): Promise<any> {
    // 检查只读模式
    if (this.config.readonly) {
      throw new Error(`Account ${this.config.name} is read-only`);
    }
    
    // TODO: 实现真实下单
    throw new Error('Real trading not yet implemented in quant-lab');
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    if (this.config.readonly) {
      throw new Error(`Account ${this.config.name} is read-only`);
    }
    
    // TODO: 实现真实撤单
    throw new Error('Real trading not yet implemented in quant-lab');
  }

  async getOrder(orderId: string): Promise<any | null> {
    // TODO: 实现查询订单
    throw new Error('Not yet implemented');
  }

  async getActiveOrders(symbol?: string): Promise<any[]> {
    // TODO: 实现查询活跃订单
    return [];
  }

  async getPosition(symbol: string): Promise<any | null> {
    const positions = await this.bybit.getPositions('linear', 'USDT');
    const pos = positions.find(p => p.symbol === symbol);
    if (!pos) return null;
    
    return {
      symbol: pos.symbol,
      side: pos.side,
      size: pos.size,
      avgPrice: pos.avgPrice,
      markPrice: pos.markPrice,
      leverage: pos.leverage,
      unrealisedPnl: pos.unrealisedPnl,
      positionValue: pos.positionValue
    };
  }

  async getPositions(): Promise<any[]> {
    const positions = await this.bybit.getPositions('linear', 'USDT');
    return positions.map(p => ({
      symbol: p.symbol,
      side: p.side,
      size: p.size,
      avgPrice: p.avgPrice,
      markPrice: p.markPrice,
      leverage: p.leverage,
      unrealisedPnl: p.unrealisedPnl,
      positionValue: p.positionValue
    }));
  }

  async getBalance(coin?: string): Promise<any> {
    const overview = await this.bybit.getWalletBalance('UNIFIED');
    
    if (coin) {
      return overview.coins.find(c => c.coin === coin) || {
        coin,
        walletBalance: 0,
        availableToWithdraw: 0,
        usdValue: 0,
        unrealisedPnl: 0
      };
    }
    
    const balances: Record<string, any> = {};
    for (const c of overview.coins) {
      balances[c.coin] = c;
    }
    return balances;
  }
}

/**
 * QuickJS 上下文构建器
 */
export class ContextBuilder {
  constructor(private vm: QuickJSContext) {}

  /**
   * 注入 Logger
   */
  injectLogger(strategyId: string): void {
    const logger = {
      info: (message: string) => console.log(`[${strategyId}] INFO: ${message}`),
      warn: (message: string) => console.warn(`[${strategyId}] WARN: ${message}`),
      error: (message: string) => console.error(`[${strategyId}] ERROR: ${message}`),
      debug: (message: string) => console.log(`[${strategyId}] DEBUG: ${message}`)
    };

    // 注入到 QuickJS
    const loggerHandle = this.vm.newObject();
    
    for (const [key, fn] of Object.entries(logger)) {
      const fnHandle = this.vm.newFunction(key, (msgHandle) => {
        const msg = this.vm.dump(msgHandle);
        (fn as Function)(msg);
        return { value: this.vm.undefined };
      });
      this.vm.setProp(loggerHandle, key, fnHandle);
      fnHandle.dispose();
    }

    this.vm.setProp(this.vm.global, 'logger', loggerHandle);
    loggerHandle.dispose();
  }

  /**
   * 注入 Bybit API
   */
  async injectBybit(accountName: string): Promise<void> {
    const api = await createAPIClient(accountName);
    
    const bybitHandle = this.vm.newObject();

    // getPrice
    const getPriceHandle = this.vm.newAsyncFunction('getPrice', async (symbolHandle) => {
      const symbol = this.vm.dump(symbolHandle);
      const price = await api.getPrice(symbol);
      return { value: this.vm.newNumber(price) };
    });
    this.vm.setProp(bybitHandle, 'getPrice', getPriceHandle);
    getPriceHandle.dispose();

    // getTicker
    const getTickerHandle = this.vm.newAsyncFunction('getTicker', async (symbolHandle) => {
      const symbol = this.vm.dump(symbolHandle);
      const ticker = await api.getTicker(symbol);
      return { value: this.vm.newString(JSON.stringify(ticker)) };
    });
    this.vm.setProp(bybitHandle, 'getTicker', getTickerHandle);
    getTickerHandle.dispose();

    // placeOrder
    const placeOrderHandle = this.vm.newAsyncFunction('placeOrder', async (paramsHandle) => {
      const params = this.vm.dump(paramsHandle);
      
      // 检查只读模式
      const info = await getAccountInfo(accountName);
      if (info.isReadonly) {
        throw new Error(`Account ${accountName} is read-only`);
      }
      
      const result = await api.placeOrder(params);
      return { value: this.vm.newString(JSON.stringify(result)) };
    });
    this.vm.setProp(bybitHandle, 'placeOrder', placeOrderHandle);
    placeOrderHandle.dispose();

    // getPosition
    const getPositionHandle = this.vm.newAsyncFunction('getPosition', async (symbolHandle) => {
      const symbol = this.vm.dump(symbolHandle);
      const position = await api.getPosition(symbol);
      return { value: this.vm.newString(JSON.stringify(position)) };
    });
    this.vm.setProp(bybitHandle, 'getPosition', getPositionHandle);
    getPositionHandle.dispose();

    this.vm.setProp(this.vm.global, 'bybit', bybitHandle);
    bybitHandle.dispose();
  }

  /**
   * 注入 Params
   */
  injectParams(params: Record<string, any>): void {
    const paramsHandle = this.vm.newObject();
    
    for (const [key, value] of Object.entries(params)) {
      let valueHandle;
      if (typeof value === 'string') {
        valueHandle = this.vm.newString(value);
      } else if (typeof value === 'number') {
        valueHandle = this.vm.newNumber(value);
      } else if (typeof value === 'boolean') {
        valueHandle = value ? this.vm.true : this.vm.false;
      } else if (value === null || value === undefined) {
        valueHandle = this.vm.null;
      } else {
        valueHandle = this.vm.newString(JSON.stringify(value));
      }
      this.vm.setProp(paramsHandle, key, valueHandle);
      valueHandle.dispose();
    }

    this.vm.setProp(this.vm.global, 'params', paramsHandle);
    paramsHandle.dispose();
  }

  /**
   * 注入 State
   */
  injectState(state: Record<string, any>): void {
    const stateHandle = this.vm.newObject();
    
    for (const [key, value] of Object.entries(state)) {
      let valueHandle;
      if (typeof value === 'string') {
        valueHandle = this.vm.newString(value);
      } else if (typeof value === 'number') {
        valueHandle = this.vm.newNumber(value);
      } else if (typeof value === 'boolean') {
        valueHandle = value ? this.vm.true : this.vm.false;
      } else if (Array.isArray(value)) {
        valueHandle = this.vm.newString(JSON.stringify(value));
      } else if (typeof value === 'object') {
        valueHandle = this.vm.newString(JSON.stringify(value));
      } else {
        valueHandle = this.vm.undefined;
      }
      this.vm.setProp(stateHandle, key, valueHandle);
      valueHandle.dispose();
    }

    this.vm.setProp(this.vm.global, 'state', stateHandle);
    stateHandle.dispose();
  }
}

// 导出所有
export { PaperAPIWrapper, BybitAPIWrapper };
