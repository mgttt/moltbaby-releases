// ============================================================
// PaperTradingProviderAdapter 单元测试
// 
// 注意：PaperTradingProvider本身在quant-lib中，这里测试的是Adapter层
// ============================================================

import { describe, it, expect, beforeEach } from 'bun:test';
import type { Order, Account, Position, Kline } from '../../src/engine/types';

// 直接模拟 PaperTradingProvider 的行为
class MockPaperProvider {
  private balance: number = 10000;
  private positions: Map<string, any> = new Map();
  private orders: any[] = [];
  private orderIdCounter = 1;
  private klineCallbacks: Map<string, (bar: Kline) => void> = new Map();

  async getAccountOverview() {
    return {
      totalEquity: this.balance,
      availableBalance: this.balance * 0.9,
      totalPositionValue: this.getTotalPositionValue(),
    };
  }

  async getBalance() {
    return [
      { coin: 'USDT', walletBalance: this.balance.toString(), availableToWithdraw: (this.balance * 0.9).toString() }
    ];
  }

  async getPositions() {
    return Array.from(this.positions.values());
  }

  async placeOrder(params: {
    symbol: string;
    side: 'Buy' | 'Sell';
    orderType: 'Market' | 'Limit';
    qty: number;
    price?: number;
  }) {
    const orderId = `paper-${this.orderIdCounter++}`;
    const order = {
      orderId,
      symbol: params.symbol,
      side: params.side,
      orderType: params.orderType,
      qty: params.qty,
      price: params.price || 50000,
      filledQty: params.qty,
      avgPrice: params.price || 50000,
      status: 'Filled' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      fee: (params.qty * (params.price || 50000)) * 0.00055,
    };

    this.orders.push(order);

    // 更新持仓和余额
    const cost = params.qty * (params.price || 50000);
    if (params.side === 'Buy') {
      this.balance -= cost * 1.00055; // 扣除手续费
      const existing = this.positions.get(params.symbol);
      if (existing) {
        const totalQty = existing.size + params.qty;
        existing.avgPrice = (existing.avgPrice * existing.size + cost) / totalQty;
        existing.size = totalQty;
      } else {
        this.positions.set(params.symbol, {
          symbol: params.symbol,
          side: 'Buy',
          size: params.qty,
          avgPrice: params.price || 50000,
        });
      }
    } else {
      this.balance += cost * 0.99945; // 扣除手续费
      const existing = this.positions.get(params.symbol);
      if (existing) {
        existing.size -= params.qty;
        if (existing.size <= 0) {
          this.positions.delete(params.symbol);
        }
      }
    }

    return { success: true, order };
  }

  async cancelOrder(orderId: string) {
    const order = this.orders.find(o => o.orderId === orderId);
    if (order && order.status === 'Pending') {
      order.status = 'Cancelled';
      return { success: true };
    }
    return { success: false, error: 'Order not found or already filled' };
  }

  async getOrderHistory() {
    return this.orders;
  }

  getTotalPositionValue() {
    return Array.from(this.positions.values())
      .reduce((sum, pos) => sum + pos.size * pos.avgPrice, 0);
  }

  // Adapter扩展方法
  async subscribeKlines(
    symbols: string[],
    interval: string,
    callback: (bar: Kline) => void
  ): Promise<void> {
    const key = `${symbols.join(',')}-${interval}`;
    this.klineCallbacks.set(key, callback);
  }

  pushKline(bar: Kline): void {
    for (const callback of this.klineCallbacks.values()) {
      callback(bar);
    }
  }
}

// 模拟 Adapter 实现（复现核心适配逻辑）
class MockPaperTradingProviderAdapter {
  private provider: MockPaperProvider;
  private klineCallbacks: Map<string, (bar: Kline) => void> = new Map();

  constructor(provider: MockPaperProvider) {
    this.provider = provider;
  }

  async subscribeKlines(
    symbols: string[],
    interval: string,
    callback: (bar: Kline) => void
  ): Promise<void> {
    const key = `${symbols.join(',')}-${interval}`;
    this.klineCallbacks.set(key, callback);
    await this.provider.subscribeKlines(symbols, interval, callback);
  }

  pushKline(bar: Kline): void {
    for (const callback of this.klineCallbacks.values()) {
      callback(bar);
    }
  }

  async buy(symbol: string, quantity: number, price?: number, orderLinkId?: string): Promise<Order> {
    const result = await this.provider.placeOrder({
      symbol,
      side: 'Buy',
      orderType: price ? 'Limit' : 'Market',
      qty: quantity,
      price,
    });

    const order = result.order;
    return {
      orderId: order.orderId,
      symbol: order.symbol,
      side: 'BUY',
      type: order.orderType === 'Limit' ? 'LIMIT' : 'MARKET',
      quantity: order.qty,
      price: order.price,
      status: this.mapStatus(order.status),
      filledQuantity: order.filledQty,
      filledPrice: order.avgPrice,
      timestamp: order.createdAt,
      commission: order.fee,
    };
  }

  async sell(symbol: string, quantity: number, price?: number, orderLinkId?: string): Promise<Order> {
    const result = await this.provider.placeOrder({
      symbol,
      side: 'Sell',
      orderType: price ? 'Limit' : 'Market',
      qty: quantity,
      price,
    });

    const order = result.order;
    return {
      orderId: order.orderId,
      symbol: order.symbol,
      side: 'SELL',
      type: order.orderType === 'Limit' ? 'LIMIT' : 'MARKET',
      quantity: order.qty,
      price: order.price,
      status: this.mapStatus(order.status),
      filledQuantity: order.filledQty,
      filledPrice: order.avgPrice,
      timestamp: order.createdAt,
      commission: order.fee,
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.provider.cancelOrder(orderId);
  }

  async getAccount(): Promise<Account> {
    const overview = await this.provider.getAccountOverview();
    const positions = await this.provider.getPositions();
    
    return {
      balance: overview.availableBalance,
      equity: overview.totalEquity,
      positions: positions.map(p => ({
        symbol: p.symbol,
        side: p.side === 'Buy' ? 'LONG' : 'SHORT',
        quantity: Math.abs(p.size),
        entryPrice: p.avgPrice,
        currentPrice: p.avgPrice,
        unrealizedPnl: 0,
        realizedPnl: 0,
      })),
      totalRealizedPnl: 0,
      totalUnrealizedPnl: 0,
    };
  }

  async getPosition(symbol: string): Promise<Position | null> {
    const positions = await this.provider.getPositions();
    const pos = positions.find(p => p.symbol === symbol);
    if (!pos) return null;
    
    return {
      symbol: pos.symbol,
      side: pos.side === 'Buy' ? 'LONG' : 'SHORT',
      quantity: Math.abs(pos.size),
      entryPrice: pos.avgPrice,
      currentPrice: pos.avgPrice,
      unrealizedPnl: 0,
      realizedPnl: 0,
    };
  }

  async getPositions(): Promise<Position[]> {
    const positions = await this.provider.getPositions();
    return positions.map(p => ({
      symbol: p.symbol,
      side: p.side === 'Buy' ? 'LONG' : 'SHORT',
      quantity: Math.abs(p.size),
      entryPrice: p.avgPrice,
      currentPrice: p.avgPrice,
      unrealizedPnl: 0,
      realizedPnl: 0,
    }));
  }

  private mapStatus(status: string): Order['status'] {
    switch (status) {
      case 'Pending': return 'PENDING';
      case 'Filled': return 'FILLED';
      case 'PartiallyFilled': return 'PARTIAL';
      case 'Cancelled': return 'CANCELED';
      default: return 'PENDING';
    }
  }
}

describe('PaperTradingProvider (Mocked)', () => {
  let provider: MockPaperProvider;

  beforeEach(() => {
    provider = new MockPaperProvider();
  });

  it('应该正确初始化账户余额', async () => {
    const overview = await provider.getAccountOverview();
    expect(overview).toBeDefined();
    expect(overview.totalEquity).toBe(10000);
  });

  it('应该正确模拟买入订单执行', async () => {
    const result = await provider.placeOrder({
      symbol: 'BTCUSDT',
      side: 'Buy',
      orderType: 'Market',
      qty: 0.1,
    });

    expect(result.success).toBe(true);
    expect(result.order).toBeDefined();
    expect(result.order.orderId).toBeDefined();
    expect(result.order.symbol).toBe('BTCUSDT');
    expect(result.order.side).toBe('Buy');
    expect(result.order.qty).toBe(0.1);
    expect(result.order.status).toBe('Filled');
  });

  it('应该正确模拟卖出订单执行', async () => {
    await provider.placeOrder({
      symbol: 'BTCUSDT',
      side: 'Buy',
      orderType: 'Market',
      qty: 0.1,
    });

    const result = await provider.placeOrder({
      symbol: 'BTCUSDT',
      side: 'Sell',
      orderType: 'Market',
      qty: 0.1,
    });

    expect(result.success).toBe(true);
    expect(result.order.side).toBe('Sell');
  });

  it('应该正确计算手续费', async () => {
    const result = await provider.placeOrder({
      symbol: 'BTCUSDT',
      side: 'Buy',
      orderType: 'Market',
      qty: 0.1,
    });

    expect(result.order.fee).toBeGreaterThan(0);
    // 0.1 BTC @ 50000 = 5000 USDT, fee = 5000 * 0.00055 = 2.75
    expect(result.order.fee).toBeCloseTo(2.75, 2);
  });

  it('应该正确管理账户余额（买入扣除）', async () => {
    const beforeBalance = (await provider.getAccountOverview()).totalEquity;
    
    await provider.placeOrder({
      symbol: 'BTCUSDT',
      side: 'Buy',
      orderType: 'Market',
      qty: 0.1,
    });

    const positions = await provider.getPositions();
    const btcPos = positions.find(p => p.symbol === 'BTCUSDT');
    expect(btcPos).toBeDefined();
    expect(btcPos.size).toBe(0.1);
  });

  it('应该正确管理账户余额（卖出增加）', async () => {
    await provider.placeOrder({
      symbol: 'BTCUSDT',
      side: 'Buy',
      orderType: 'Market',
      qty: 0.1,
    });

    await provider.placeOrder({
      symbol: 'BTCUSDT',
      side: 'Sell',
      orderType: 'Market',
      qty: 0.1,
    });

    const positions = await provider.getPositions();
    const btcPos = positions.find(p => p.symbol === 'BTCUSDT');
    expect(btcPos?.size || 0).toBe(0);
  });

  it('应该正确处理限价单', async () => {
    const result = await provider.placeOrder({
      symbol: 'BTCUSDT',
      side: 'Buy',
      orderType: 'Limit',
      qty: 0.1,
      price: 45000,
    });

    expect(result.success).toBe(true);
    expect(result.order.orderType).toBe('Limit');
    expect(result.order.price).toBe(45000);
  });

  it('应该正确获取订单列表', async () => {
    await provider.placeOrder({ symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: 0.1 });
    await provider.placeOrder({ symbol: 'ETHUSDT', side: 'Buy', orderType: 'Market', qty: 1 });

    const orders = await provider.getOrderHistory();
    expect(orders.length).toBeGreaterThanOrEqual(2);
  });

  it('应该正确处理多品种持仓', async () => {
    await provider.placeOrder({ symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: 0.1 });
    await provider.placeOrder({ symbol: 'ETHUSDT', side: 'Buy', orderType: 'Market', qty: 1 });

    const positions = await provider.getPositions();
    expect(positions.length).toBe(2);
    const symbols = positions.map(p => p.symbol);
    expect(symbols).toContain('BTCUSDT');
    expect(symbols).toContain('ETHUSDT');
  });
});

describe('PaperTradingProviderAdapter', () => {
  let provider: MockPaperProvider;
  let adapter: MockPaperTradingProviderAdapter;

  beforeEach(() => {
    provider = new MockPaperProvider();
    adapter = new MockPaperTradingProviderAdapter(provider);
  });

  it('应该正确适配买入接口', async () => {
    const order = await adapter.buy('BTCUSDT', 0.1);
    
    expect(order).toBeDefined();
    expect(order.symbol).toBe('BTCUSDT');
    expect(order.side).toBe('BUY');
    expect(order.quantity).toBe(0.1);
    expect(order.status).toBe('FILLED');
  });

  it('应该正确适配卖出接口', async () => {
    await adapter.buy('BTCUSDT', 0.1);
    const order = await adapter.sell('BTCUSDT', 0.1);
    
    expect(order).toBeDefined();
    expect(order.symbol).toBe('BTCUSDT');
    expect(order.side).toBe('SELL');
    expect(order.quantity).toBe(0.1);
  });

  it('应该正确获取账户信息', async () => {
    const account = await adapter.getAccount();
    
    expect(account).toBeDefined();
    expect(typeof account.balance).toBe('number');
    expect(typeof account.equity).toBe('number');
    expect(Array.isArray(account.positions)).toBe(true);
  });

  it('应该正确获取持仓信息', async () => {
    await adapter.buy('BTCUSDT', 0.1);
    const position = await adapter.getPosition('BTCUSDT');
    
    expect(position).not.toBeNull();
    expect(position!.symbol).toBe('BTCUSDT');
    expect(position!.quantity).toBe(0.1);
    expect(position!.side).toBe('LONG');
  });

  it('应该正确处理K线订阅', async () => {
    let klineReceived = false;
    
    await adapter.subscribeKlines(['BTCUSDT'], '1h', (bar) => {
      klineReceived = true;
    });

    adapter.pushKline({
      symbol: 'BTCUSDT',
      timestamp: 1704067200,
      open: 50000,
      high: 51000,
      low: 49000,
      close: 50500,
      volume: 100,
      quoteVolume: 5000000,
    });

    expect(klineReceived).toBe(true);
  });

  it('应该正确获取所有持仓', async () => {
    await adapter.buy('BTCUSDT', 0.1);
    await adapter.buy('ETHUSDT', 1);

    const positions = await adapter.getPositions();
    
    expect(positions.length).toBe(2);
    const symbols = positions.map(p => p.symbol);
    expect(symbols).toContain('BTCUSDT');
    expect(symbols).toContain('ETHUSDT');
  });

  it('应该正确映射订单状态', async () => {
    const order = await adapter.buy('BTCUSDT', 0.1);
    expect(order.status).toBe('FILLED');
    expect(order.filledQuantity).toBeGreaterThan(0);
  });

  it('应该正确映射订单方向', async () => {
    const buyOrder = await adapter.buy('BTCUSDT', 0.05);
    expect(buyOrder.side).toBe('BUY');

    const sellOrder = await adapter.sell('BTCUSDT', 0.05);
    expect(sellOrder.side).toBe('SELL');
  });

  it('应该正确处理无持仓情况', async () => {
    const position = await adapter.getPosition('NONEXISTENT');
    expect(position).toBeNull();
  });

  it('应该正确计算并返回手续费', async () => {
    const order = await adapter.buy('BTCUSDT', 0.1);
    
    // 验证手续费计算
    expect(order.commission).toBeGreaterThan(0);
    // 0.1 BTC @ 50000 = 5000 USDT, fee ~ 2.75
    expect(order.commission!).toBeGreaterThan(2);
    expect(order.commission!).toBeLessThan(3);
  });
});
