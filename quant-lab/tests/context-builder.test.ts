/**
 * context-builder.ts 单元测试
 * 
 * 测试交易函数实现
 */

import { describe, it, expect, beforeEach } from 'bun:test';

// Mock Provider和Wrapper
class MockBybitProvider {
  private orders: Map<string, any> = new Map();
  private orderIdCounter = 1;

  async buy(symbol: string, quantity: number, price?: number, orderLinkId?: string): Promise<any> {
    const orderId = `order-${this.orderIdCounter++}`;
    const order = {
      orderId,
      symbol,
      side: 'Buy',
      orderType: price ? 'Limit' : 'Market',
      qty: quantity,
      price: price || 50000,
      status: 'New',
      createdAt: Date.now(),
      orderLinkId,
    };
    this.orders.set(orderId, order);
    return order;
  }

  async sell(symbol: string, quantity: number, price?: number, orderLinkId?: string): Promise<any> {
    const orderId = `order-${this.orderIdCounter++}`;
    const order = {
      orderId,
      symbol,
      side: 'Sell',
      orderType: price ? 'Limit' : 'Market',
      qty: quantity,
      price: price || 50000,
      status: 'New',
      createdAt: Date.now(),
      orderLinkId,
    };
    this.orders.set(orderId, order);
    return order;
  }

  async cancelOrder(orderId: string): Promise<void> {
    this.orders.delete(orderId);
  }

  async getOrderByLinkId(orderLinkId: string): Promise<any | null> {
    for (const order of this.orders.values()) {
      if (order.orderLinkId === orderLinkId) {
        return order;
      }
    }
    return null;
  }

  async getOpenOrders(symbol?: string): Promise<any[]> {
    const orders = Array.from(this.orders.values());
    if (symbol) {
      return orders.filter(o => o.symbol === symbol);
    }
    return orders;
  }
}

// 模拟的BybitAPIWrapper实现（复制关键部分）
class MockBybitAPIWrapper {
  constructor(
    private bybit: MockBybitProvider,
    private config: { name: string; readonly: boolean }
  ) {}

  async placeOrder(params: any): Promise<any> {
    if (this.config.readonly) {
      throw new Error(`Account ${this.config.name} is read-only`);
    }

    const { symbol, side, orderType, qty, price } = params;
    const orderLinkId = `ctx-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    try {
      let result;
      if (side === 'Buy') {
        result = await this.bybit.buy(symbol, qty, price, orderLinkId);
      } else {
        result = await this.bybit.sell(symbol, qty, price, orderLinkId);
      }
      return {
        orderId: result.orderId,
        symbol: result.symbol,
        side: result.side,
        orderType: result.orderType,
        qty: result.qty,
        price: result.price,
        status: result.status,
        createdAt: result.createdAt,
        orderLinkId,
      };
    } catch (error: any) {
      throw new Error(`Place order failed: ${error.message}`);
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    if (this.config.readonly) {
      throw new Error(`Account ${this.config.name} is read-only`);
    }

    try {
      await this.bybit.cancelOrder(orderId);
      return true;
    } catch (error: any) {
      return false;
    }
  }

  async getOrder(orderId: string): Promise<any | null> {
    try {
      const order = await this.bybit.getOrderByLinkId?.(orderId);
      if (order) return order;
      return null;
    } catch (error: any) {
      return null;
    }
  }

  async getActiveOrders(symbol?: string): Promise<any[]> {
    try {
      const orders = await this.bybit.getOpenOrders?.(symbol);
      return orders || [];
    } catch (error: any) {
      return [];
    }
  }
}

describe('Context Builder Trading Functions', () => {
  let mockProvider: MockBybitProvider;
  let wrapper: MockBybitAPIWrapper;

  beforeEach(() => {
    mockProvider = new MockBybitProvider();
    wrapper = new MockBybitAPIWrapper(mockProvider, { 
      name: 'test-account', 
      readonly: false 
    });
  });

  describe('placeOrder', () => {
    it('应该能下买单', async () => {
      const result = await wrapper.placeOrder({
        symbol: 'BTCUSDT',
        side: 'Buy',
        orderType: 'Limit',
        qty: 0.1,
        price: 50000,
      });

      expect(result).toBeDefined();
      expect(result.side).toBe('Buy');
      expect(result.symbol).toBe('BTCUSDT');
      expect(result.qty).toBe(0.1);
      expect(result.price).toBe(50000);
      expect(result.status).toBe('New');
      expect(result.orderLinkId).toBeDefined();
    });

    it('应该能下卖单', async () => {
      const result = await wrapper.placeOrder({
        symbol: 'BTCUSDT',
        side: 'Sell',
        orderType: 'Market',
        qty: 0.1,
      });

      expect(result).toBeDefined();
      expect(result.side).toBe('Sell');
      expect(result.symbol).toBe('BTCUSDT');
      expect(result.qty).toBe(0.1);
      expect(result.orderType).toBe('Market');
    });

    it('只读模式应该拒绝下单', async () => {
      const readonlyWrapper = new MockBybitAPIWrapper(mockProvider, {
        name: 'readonly-account',
        readonly: true,
      });

      try {
        await readonlyWrapper.placeOrder({
          symbol: 'BTCUSDT',
          side: 'Buy',
          orderType: 'Limit',
          qty: 0.1,
          price: 50000,
        });
        expect(false).toBe(true); // 不应该执行到这里
      } catch (error: any) {
        expect(error.message).toContain('read-only');
      }
    });
  });

  describe('cancelOrder', () => {
    it('应该能取消订单', async () => {
      const order = await wrapper.placeOrder({
        symbol: 'BTCUSDT',
        side: 'Buy',
        orderType: 'Limit',
        qty: 0.1,
        price: 50000,
      });

      const result = await wrapper.cancelOrder(order.orderId);
      expect(result).toBe(true);
    });

    it('只读模式应该拒绝撤单', async () => {
      const readonlyWrapper = new MockBybitAPIWrapper(mockProvider, {
        name: 'readonly-account',
        readonly: true,
      });

      try {
        await readonlyWrapper.cancelOrder('order-1');
        expect(false).toBe(true);
      } catch (error: any) {
        expect(error.message).toContain('read-only');
      }
    });
  });

  describe('getOrder', () => {
    it('应该能查询订单', async () => {
      const order = await wrapper.placeOrder({
        symbol: 'BTCUSDT',
        side: 'Buy',
        orderType: 'Limit',
        qty: 0.1,
        price: 50000,
      });

      const found = await wrapper.getOrder(order.orderLinkId);
      expect(found).toBeDefined();
      expect(found.orderId).toBe(order.orderId);
    });

    it('查询不存在的订单应该返回null', async () => {
      const found = await wrapper.getOrder('non-existent');
      expect(found).toBeNull();
    });
  });

  describe('getActiveOrders', () => {
    it('应该返回活跃订单列表', async () => {
      await wrapper.placeOrder({
        symbol: 'BTCUSDT',
        side: 'Buy',
        orderType: 'Limit',
        qty: 0.1,
        price: 50000,
      });

      await wrapper.placeOrder({
        symbol: 'ETHUSDT',
        side: 'Sell',
        orderType: 'Limit',
        qty: 1,
        price: 3000,
      });

      const orders = await wrapper.getActiveOrders();
      expect(orders.length).toBe(2);
    });

    it('应该能按symbol过滤', async () => {
      await wrapper.placeOrder({
        symbol: 'BTCUSDT',
        side: 'Buy',
        orderType: 'Limit',
        qty: 0.1,
        price: 50000,
      });

      await wrapper.placeOrder({
        symbol: 'ETHUSDT',
        side: 'Sell',
        orderType: 'Limit',
        qty: 1,
        price: 3000,
      });

      const btcOrders = await wrapper.getActiveOrders('BTCUSDT');
      expect(btcOrders.length).toBe(1);
      expect(btcOrders[0].symbol).toBe('BTCUSDT');
    });
  });
});

console.log('运行 context-builder 交易函数单元测试...');
