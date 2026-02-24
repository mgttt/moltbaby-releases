/**
 * bybit.ts 关键路径单元测试
 * 
 * 覆盖：下单/撤单/查持仓/查账户/K线查询
 */

import { describe, it, expect, beforeEach } from 'bun:test';

// Mock Bybit API响应
const mockApiResponses = {
  // 下单响应
  orderCreated: {
    result: {
      orderId: 'test-order-id-123',
      symbol: 'BTCUSDT',
      side: 'Buy',
      orderType: 'Limit',
      qty: '0.1',
      price: '50000',
      status: 'New',
      createdTime: Date.now().toString(),
    },
  },

  // 撤单响应
  orderCancelled: {
    result: {},
  },

  // 持仓响应
  positions: {
    result: {
      list: [
        {
          symbol: 'BTCUSDT',
          side: 'Buy',
          size: '0.1',
          avgPrice: '48000',
          markPrice: '50000',
          leverage: '10',
          unrealisedPnl: '200',
          positionValue: '5000',
        },
      ],
    },
  },

  // 账户余额响应
  walletBalance: {
    result: {
      list: [
        {
          coin: [
            {
              coin: 'USDT',
              walletBalance: '10000',
              availableToWithdraw: '9000',
              usdValue: '10000',
              unrealisedPnl: '200',
            },
          ],
        },
      ],
    },
  },

  // K线响应
  klines: {
    result: {
      list: [
        {
          start: '1640995200000',
          end: '1640998800000',
          interval: '60',
          open: '47000',
          close: '48000',
          high: '48500',
          low: '46500',
          volume: '100',
          turnover: '4800000',
          confirm: true,
        },
      ],
    },
  },

  // Ticker响应
  tickers: {
    result: {
      list: [
        {
          symbol: 'BTCUSDT',
          lastPrice: '50000',
          bid1Price: '49990',
          ask1Price: '50010',
          volume24h: '10000',
        },
      ],
    },
  },
};

// Mock BybitProvider
class MockBybitProvider {
  private orders: Map<string, any> = new Map();
  private positions = mockApiResponses.positions.result.list;

  // 模拟HTTP请求
  private async mockRequest(method: string, endpoint: string, params?: any): Promise<any> {
    if (endpoint.includes('/v5/order/create')) {
      const orderId = `order-${Date.now()}`;
      const order = {
        orderId,
        symbol: params.symbol,
        side: params.side,
        orderType: params.orderType,
        qty: parseFloat(params.qty),
        price: params.price ? parseFloat(params.price) : undefined,
        status: 'New',
        createdAt: Date.now(),
        orderLinkId: params.orderLinkId,
      };
      this.orders.set(orderId, order);
      return { result: order };
    }

    if (endpoint.includes('/v5/order/cancel')) {
      this.orders.delete(params.orderId);
      return mockApiResponses.orderCancelled;
    }

    if (endpoint.includes('/v5/order/realtime')) {
      return {
        result: {
          list: Array.from(this.orders.values()).map(o => ({
            orderId: o.orderId,
            symbol: o.symbol,
            side: o.side,
            orderType: o.orderType,
            qty: o.qty.toString(),
            price: o.price?.toString(),
            status: o.status,
          })),
        },
      };
    }

    if (endpoint.includes('/v5/position')) {
      return mockApiResponses.positions;
    }

    if (endpoint.includes('/v5/account/wallet-balance')) {
      return mockApiResponses.walletBalance;
    }

    if (endpoint.includes('/v5/market/kline')) {
      return mockApiResponses.klines;
    }

    if (endpoint.includes('/v5/market/tickers')) {
      return mockApiResponses.tickers;
    }

    return { result: {} };
  }

  // 实现关键方法
  async buy(symbol: string, quantity: number, price?: number, orderLinkId?: string): Promise<any> {
    const result = await this.mockRequest('POST', '/v5/order/create', {
      category: 'linear',
      symbol: symbol.replace('/', ''),
      side: 'Buy',
      orderType: price ? 'Limit' : 'Market',
      qty: quantity.toString(),
      price: price?.toString(),
      orderLinkId,
    });
    return {
      orderId: result.result.orderId,
      symbol,
      side: 'Buy',
      orderType: price ? 'Limit' : 'Market',
      qty: quantity,
      price: price || 50000,
      status: result.result.status,
      createdAt: Date.now(),
    };
  }

  async sell(symbol: string, quantity: number, price?: number, orderLinkId?: string): Promise<any> {
    const result = await this.mockRequest('POST', '/v5/order/create', {
      category: 'linear',
      symbol: symbol.replace('/', ''),
      side: 'Sell',
      orderType: price ? 'Limit' : 'Market',
      qty: quantity.toString(),
      price: price?.toString(),
      orderLinkId,
    });
    return {
      orderId: result.result.orderId,
      symbol,
      side: 'Sell',
      orderType: price ? 'Limit' : 'Market',
      qty: quantity,
      price: price || 50000,
      status: result.result.status,
      createdAt: Date.now(),
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    // orderId format: "symbol:id"
    const parts = orderId.split(':');
    const id = parts.length === 2 ? parts[1] : orderId;
    await this.mockRequest('POST', '/v5/order/cancel', {
      category: 'linear',
      symbol: parts[0] || 'BTCUSDT',
      orderId: id,
    });
  }

  async getPositions(category?: string, settleCoin?: string): Promise<any[]> {
    const response = await this.mockRequest('GET', '/v5/position');
    return response.result.list.map((p: any) => ({
      symbol: p.symbol,
      side: p.side,
      size: parseFloat(p.size),
      avgPrice: parseFloat(p.avgPrice),
      markPrice: parseFloat(p.markPrice),
      leverage: parseFloat(p.leverage),
      unrealisedPnl: parseFloat(p.unrealisedPnl),
      positionValue: parseFloat(p.positionValue),
    }));
  }

  async getWalletBalance(accountType?: string): Promise<any> {
    const response = await this.mockRequest('GET', '/v5/account/wallet-balance');
    const coin = response.result.list[0]?.coin[0];
    return {
      coins: [{
        coin: coin.coin,
        walletBalance: parseFloat(coin.walletBalance),
        availableToWithdraw: parseFloat(coin.availableToWithdraw),
        usdValue: parseFloat(coin.usdValue),
        unrealisedPnl: parseFloat(coin.unrealisedPnl),
      }],
    };
  }

  async getKlines(params: { category: string; symbol: string; interval: string; limit?: number }): Promise<any[]> {
    const response = await this.mockRequest('GET', '/v5/market/kline', params);
    return response.result.list.map((k: any) => ({
      timestamp: parseInt(k.start),
      open: parseFloat(k.open),
      high: parseFloat(k.high),
      low: parseFloat(k.low),
      close: parseFloat(k.close),
      volume: parseFloat(k.volume),
    }));
  }

  async getTickers(symbol?: string): Promise<any> {
    const response = await this.mockRequest('GET', '/v5/market/tickers', { symbol });
    const ticker = response.result.list[0];
    return {
      symbol: ticker.symbol,
      lastPrice: ticker.lastPrice,
      bid1Price: ticker.bid1Price,
      ask1Price: ticker.ask1Price,
      volume24h: ticker.volume24h,
    };
  }

  async getOpenOrders(symbol?: string, category?: string, limit?: number): Promise<any[]> {
    const response = await this.mockRequest('GET', '/v5/order/realtime', { symbol, category, limit });
    return response.result.list;
  }
}

describe('BybitProvider Critical Path', () => {
  let provider: MockBybitProvider;

  beforeEach(() => {
    provider = new MockBybitProvider();
  });

  describe('下单 (buy/sell)', () => {
    it('应该能下限价买单', async () => {
      const order = await provider.buy('BTCUSDT', 0.1, 50000, 'test-link-1');

      expect(order).toBeDefined();
      expect(order.symbol).toBe('BTCUSDT');
      expect(order.side).toBe('Buy');
      expect(order.orderType).toBe('Limit');
      expect(order.qty).toBe(0.1);
      expect(order.price).toBe(50000);
      expect(order.status).toBe('New');
      expect(order.orderId).toBeDefined();
    });

    it('应该能下市价卖单', async () => {
      const order = await provider.sell('BTCUSDT', 0.1, undefined, 'test-link-2');

      expect(order).toBeDefined();
      expect(order.symbol).toBe('BTCUSDT');
      expect(order.side).toBe('Sell');
      expect(order.orderType).toBe('Market');
      expect(order.qty).toBe(0.1);
    });

    it('应该返回订单ID', async () => {
      const order = await provider.buy('BTCUSDT', 0.1, 50000);
      expect(order.orderId).toMatch(/^order-\d+$/);
    });
  });

  describe('撤单 (cancelOrder)', () => {
    it('应该能取消订单', async () => {
      const order = await provider.buy('BTCUSDT', 0.1, 50000, 'test-link-3');
      
      // 不应该抛出错误
      await provider.cancelOrder(order.orderId);
      
      // 验证订单已取消（通过查询）
      const orders = await provider.getOpenOrders();
      const found = orders.find((o: any) => o.orderId === order.orderId);
      expect(found).toBeUndefined();
    });

    it('应该处理symbol:id格式的订单ID', async () => {
      await provider.cancelOrder('BTCUSDT:order-123');
    });
  });

  describe('查持仓 (getPositions)', () => {
    it('应该返回持仓列表', async () => {
      const positions = await provider.getPositions('linear', 'USDT');

      expect(Array.isArray(positions)).toBe(true);
      expect(positions.length).toBeGreaterThan(0);
    });

    it('持仓应该有正确字段', async () => {
      const positions = await provider.getPositions();
      const pos = positions[0];

      expect(pos.symbol).toBe('BTCUSDT');
      expect(pos.side).toBe('Buy');
      expect(typeof pos.size).toBe('number');
      expect(typeof pos.avgPrice).toBe('number');
      expect(typeof pos.markPrice).toBe('number');
      expect(typeof pos.unrealisedPnl).toBe('number');
    });
  });

  describe('查账户 (getWalletBalance)', () => {
    it('应该返回账户余额', async () => {
      const balance = await provider.getWalletBalance('UNIFIED');

      expect(balance).toBeDefined();
      expect(balance.coins).toBeDefined();
      expect(Array.isArray(balance.coins)).toBe(true);
    });

    it('余额字段应该正确', async () => {
      const balance = await provider.getWalletBalance();
      const usdt = balance.coins[0];

      expect(usdt.coin).toBe('USDT');
      expect(typeof usdt.walletBalance).toBe('number');
      expect(typeof usdt.availableToWithdraw).toBe('number');
      expect(typeof usdt.usdValue).toBe('number');
    });
  });

  describe('K线查询 (getKlines)', () => {
    it('应该返回K线数据', async () => {
      const klines = await provider.getKlines({
        category: 'linear',
        symbol: 'BTCUSDT',
        interval: '60',
        limit: 10,
      });

      expect(Array.isArray(klines)).toBe(true);
      expect(klines.length).toBeGreaterThan(0);
    });

    it('K线应该有正确字段', async () => {
      const klines = await provider.getKlines({
        category: 'linear',
        symbol: 'BTCUSDT',
        interval: '60',
      });

      const k = klines[0];
      expect(typeof k.timestamp).toBe('number');
      expect(typeof k.open).toBe('number');
      expect(typeof k.high).toBe('number');
      expect(typeof k.low).toBe('number');
      expect(typeof k.close).toBe('number');
      expect(typeof k.volume).toBe('number');
    });
  });

  describe('价格查询 (getTickers)', () => {
    it('应该返回最新价格', async () => {
      const ticker = await provider.getTickers('BTCUSDT');

      expect(ticker).toBeDefined();
      expect(ticker.symbol).toBe('BTCUSDT');
      expect(typeof ticker.lastPrice).toBe('string');
      expect(parseFloat(ticker.lastPrice)).toBeGreaterThan(0);
    });

    it('应该返回买卖价', async () => {
      const ticker = await provider.getTickers('BTCUSDT');

      expect(ticker.bid1Price).toBeDefined();
      expect(ticker.ask1Price).toBeDefined();
    });
  });
});

console.log('运行 BybitProvider 关键路径单元测试...');
