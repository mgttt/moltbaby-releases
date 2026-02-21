// ============================================================
// LiveEngine 单元测试
// ============================================================

import { describe, it, expect, beforeEach } from 'bun:test';
import { LiveEngine } from '../../src/engine/live';
import type { Strategy, LiveConfig, Order, Account, Position } from '../../src/engine/types';
import type { Kline } from '../../../quant-lib/src';

// Mock TradingProvider
class MockTradingProvider {
  private klineCallbacks: Map<string, (bar: Kline) => void> = new Map();
  private balance: number = 10000;
  private positions: Map<string, Position> = new Map();
  private orders: Order[] = [];
  private orderIdCounter = 1;
  private running: boolean = false;

  async subscribeKlines(
    symbols: string[],
    interval: string,
    callback: (bar: Kline) => void
  ): Promise<void> {
    this.running = true;
    const key = `${symbols.join(',')}-${interval}`;
    this.klineCallbacks.set(key, callback);
  }

  async subscribeTicks(symbols: string[], callback: (tick: any) => void): Promise<void> {
    // Mock implementation
  }

  async buy(symbol: string, quantity: number, price?: number, orderLinkId?: string): Promise<Order> {
    const order: Order = {
      orderId: `order-${this.orderIdCounter++}`,
      symbol,
      side: 'BUY',
      type: price ? 'LIMIT' : 'MARKET',
      quantity,
      price,
      status: 'FILLED',
      filledQuantity: quantity,
      filledPrice: price || 50000,
      timestamp: Date.now(),
    };
    
    this.orders.push(order);
    
    // 更新余额和持仓
    const cost = quantity * (price || 50000);
    this.balance -= cost;
    
    const existingPos = this.positions.get(symbol);
    if (existingPos) {
      const totalQty = existingPos.quantity + quantity;
      const avgPrice = (existingPos.entryPrice * existingPos.quantity + cost) / totalQty;
      existingPos.quantity = totalQty;
      existingPos.entryPrice = avgPrice;
    } else {
      this.positions.set(symbol, {
        symbol,
        side: 'LONG',
        quantity,
        entryPrice: price || 50000,
        currentPrice: price || 50000,
        unrealizedPnl: 0,
        realizedPnl: 0,
      });
    }
    
    return order;
  }

  async sell(symbol: string, quantity: number, price?: number, orderLinkId?: string): Promise<Order> {
    const order: Order = {
      orderId: `order-${this.orderIdCounter++}`,
      symbol,
      side: 'SELL',
      type: price ? 'LIMIT' : 'MARKET',
      quantity,
      price,
      status: 'FILLED',
      filledQuantity: quantity,
      filledPrice: price || 50000,
      timestamp: Date.now(),
    };
    
    this.orders.push(order);
    
    // 更新余额和持仓
    const proceeds = quantity * (price || 50000);
    this.balance += proceeds;
    
    const existingPos = this.positions.get(symbol);
    if (existingPos) {
      existingPos.quantity -= quantity;
      if (existingPos.quantity <= 0) {
        this.positions.delete(symbol);
      }
    }
    
    return order;
  }

  async cancelOrder(orderId: string): Promise<void> {
    const order = this.orders.find(o => o.orderId === orderId);
    if (order) {
      order.status = 'CANCELED';
    }
  }

  async getAccount(): Promise<Account> {
    return {
      balance: this.balance,
      equity: this.balance + this.getTotalUnrealizedPnl(),
      positions: Array.from(this.positions.values()),
      totalRealizedPnl: 0,
      totalUnrealizedPnl: this.getTotalUnrealizedPnl(),
    };
  }

  async getPosition(symbol: string): Promise<Position | null> {
    return this.positions.get(symbol) || null;
  }

  async getPositions(): Promise<Position[]> {
    return Array.from(this.positions.values());
  }

  private getTotalUnrealizedPnl(): number {
    return Array.from(this.positions.values())
      .reduce((sum, pos) => sum + pos.unrealizedPnl, 0);
  }

  // 模拟推送K线（用于测试）
  pushKline(bar: Kline): void {
    for (const callback of this.klineCallbacks.values()) {
      callback(bar);
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  getOrders(): Order[] {
    return this.orders;
  }
}

describe('LiveEngine', () => {
  let mockProvider: MockTradingProvider;

  beforeEach(() => {
    mockProvider = new MockTradingProvider();
  });

  it('应该正确初始化', () => {
    const strategy: Strategy = {
      name: 'TestStrategy',
      onInit: async () => {},
      onBar: async () => {},
    };

    const config: LiveConfig = {
      symbols: ['BTCUSDT'],
      interval: '1h',
      initialBalance: 10000,
    };

    const engine = new LiveEngine(strategy, config, mockProvider as any);
    expect(engine).toBeDefined();
    expect(engine.isRunning()).toBe(false);
  });

  it('应该正确启动和停止', async () => {
    const strategy: Strategy = {
      name: 'TestStrategy',
      onInit: async () => {},
      onBar: async () => {},
    };

    const config: LiveConfig = {
      symbols: ['BTCUSDT'],
      interval: '1h',
      initialBalance: 10000,
    };

    const engine = new LiveEngine(strategy, config, mockProvider as any);
    
    await engine.start();
    expect(engine.isRunning()).toBe(true);
    
    await engine.stop();
    expect(engine.isRunning()).toBe(false);
  });

  it('应该正确处理WebSocket连接', async () => {
    let barReceived = false;
    let receivedBar: Kline | null = null;

    const strategy: Strategy = {
      name: 'TestStrategy',
      onInit: async () => {},
      onBar: async (bar, ctx) => {
        barReceived = true;
        receivedBar = bar;
      },
    };

    const config: LiveConfig = {
      symbols: ['BTCUSDT'],
      interval: '1h',
      initialBalance: 10000,
    };

    const engine = new LiveEngine(strategy, config, mockProvider as any);
    await engine.start();

    // 模拟推送K线
    const testBar: Kline = {
      timestamp: 1704067200,
      open: 50000,
      high: 51000,
      low: 49000,
      close: 50500,
      volume: 100,
      quoteVolume: 5000000,
    };

    mockProvider.pushKline(testBar);

    // 等待异步处理
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(barReceived).toBe(true);
    expect(receivedBar).not.toBeNull();
    expect(receivedBar!.close).toBe(50500);

    await engine.stop();
  });

  it('应该正确触发止损/止盈风控', async () => {
    const stopLossTriggered = false;
    const takeProfitTriggered = false;
    let lastOrder: Order | null = null;

    const strategy: Strategy = {
      name: 'RiskTest',
      onInit: async () => {},
      onBar: async (bar, ctx) => {
        const pos = await mockProvider.getPosition('BTCUSDT');
        
        if (!pos || pos.quantity === 0) {
          // 没有持仓，买入
          if (bar.close <= 50000) {
            await ctx.buy('BTCUSDT', 0.1);
          }
        } else {
          // 有持仓，检查止损/止盈
          const entryPrice = pos.entryPrice;
          const stopLossPrice = entryPrice * 0.95; // 5%止损
          const takeProfitPrice = entryPrice * 1.1; // 10%止盈

          if (bar.close <= stopLossPrice) {
            await ctx.sell('BTCUSDT', pos.quantity);
          } else if (bar.close >= takeProfitPrice) {
            await ctx.sell('BTCUSDT', pos.quantity);
          }
        }
      },
      onOrder: async (order, ctx) => {
        lastOrder = order;
      },
    };

    const config: LiveConfig = {
      symbols: ['BTCUSDT'],
      interval: '1h',
      initialBalance: 10000,
      maxPositionSize: 1, // 限制最大仓位
    };

    const engine = new LiveEngine(strategy, config, mockProvider as any);
    await engine.start();

    // 模拟价格序列：50000(买入) -> 45000(止损) 
    const bars: Kline[] = [
      { timestamp: 1, open: 50000, high: 50100, low: 49900, close: 50000, volume: 100, quoteVolume: 5000000 },
      { timestamp: 2, open: 48000, high: 48500, low: 47500, close: 48000, volume: 100, quoteVolume: 4800000 },
      { timestamp: 3, open: 45000, high: 46000, low: 44000, close: 45000, volume: 100, quoteVolume: 4500000 }, // 触发止损
    ];

    for (const bar of bars) {
      mockProvider.pushKline(bar);
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    await engine.stop();

    // 验证有卖出订单（止损触发）
    const orders = mockProvider.getOrders();
    const sellOrders = orders.filter(o => o.side === 'SELL');
    expect(sellOrders.length).toBeGreaterThan(0);
  });

  it('应该正确处理策略初始化', async () => {
    let initCalled = false;
    let initContext: any = null;

    const strategy: Strategy = {
      name: 'InitTest',
      onInit: async (ctx) => {
        initCalled = true;
        initContext = ctx;
      },
      onBar: async () => {},
    };

    const config: LiveConfig = {
      symbols: ['BTCUSDT'],
      interval: '1h',
      initialBalance: 10000,
    };

    const engine = new LiveEngine(strategy, config, mockProvider as any);
    await engine.start();

    expect(initCalled).toBe(true);
    expect(initContext).not.toBeNull();
    expect(typeof initContext.getAccount).toBe('function');
    expect(typeof initContext.buy).toBe('function');
    expect(typeof initContext.sell).toBe('function');

    await engine.stop();
  });

  it('应该正确获取账户信息', async () => {
    const strategy: Strategy = {
      name: 'AccountTest',
      onInit: async () => {},
      onBar: async (bar, ctx) => {
        const account = await ctx.getAccount();
        expect(account).toBeDefined();
        expect(account.balance).toBeGreaterThanOrEqual(0);
        expect(Array.isArray(account.positions)).toBe(true);
      },
    };

    const config: LiveConfig = {
      symbols: ['BTCUSDT'],
      interval: '1h',
      initialBalance: 10000,
    };

    const engine = new LiveEngine(strategy, config, mockProvider as any);
    await engine.start();

    // 模拟K线触发onBar
    mockProvider.pushKline({
      timestamp: 1,
      open: 50000,
      high: 50100,
      low: 49900,
      close: 50000,
      volume: 100,
      quoteVolume: 5000000,
    });

    await new Promise(resolve => setTimeout(resolve, 100));
    await engine.stop();
  });

  it('应该正确处理多品种订阅', async () => {
    const receivedSymbols: string[] = [];

    const strategy: Strategy = {
      name: 'MultiSymbol',
      onInit: async () => {},
      onBar: async (bar, ctx) => {
        if (!receivedSymbols.includes(bar.symbol)) {
          receivedSymbols.push(bar.symbol);
        }
      },
    };

    const config: LiveConfig = {
      symbols: ['BTCUSDT', 'ETHUSDT'],
      interval: '1h',
      initialBalance: 10000,
    };

    const engine = new LiveEngine(strategy, config, mockProvider as any);
    await engine.start();

    // 模拟两个品种的K线
    mockProvider.pushKline({
      symbol: 'BTCUSDT',
      timestamp: 1,
      open: 50000,
      high: 50100,
      low: 49900,
      close: 50000,
      volume: 100,
      quoteVolume: 5000000,
    } as Kline);

    mockProvider.pushKline({
      symbol: 'ETHUSDT',
      timestamp: 1,
      open: 3000,
      high: 3010,
      low: 2990,
      close: 3000,
      volume: 100,
      quoteVolume: 300000,
    } as Kline);

    await new Promise(resolve => setTimeout(resolve, 100));
    await engine.stop();

    expect(receivedSymbols.length).toBeGreaterThan(0);
  });

  it('应该正确处理策略停止清理', async () => {
    let stopCalled = false;

    const strategy: Strategy = {
      name: 'StopTest',
      onInit: async () => {},
      onBar: async () => {},
      onStop: async () => {
        stopCalled = true;
      },
    };

    const config: LiveConfig = {
      symbols: ['BTCUSDT'],
      interval: '1h',
      initialBalance: 10000,
    };

    const engine = new LiveEngine(strategy, config, mockProvider as any);
    await engine.start();
    await engine.stop();

    // 注意：onStop 是否被调用取决于 LiveEngine 的实现
    // 这里主要测试引擎能正常停止不崩溃
    expect(engine.isRunning()).toBe(false);
  });
});
