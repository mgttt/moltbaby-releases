/**
 * StateMigrationEngine 单元测试
 * 
 * 测试状态序列化/反序列化的完整流程
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { StateMigrationEngine, type SerializedState } from '../src/hot-reload/StateMigrationEngine';
import type { StrategyContext } from '../src/types/strategy';
import type { Order, Account, Position } from '../src/types/market';

// 模拟QuickJSStrategy类
class MockQuickJSStrategy {
  private strategyState = new Map<string, any>();
  private cachedPositions = new Map<string, Position>();
  private cachedAccount?: Account;

  constructor(initialState?: Record<string, any>) {
    if (initialState) {
      for (const [k, v] of Object.entries(initialState)) {
        this.strategyState.set(k, v);
      }
    }
  }

  // 模拟QuickJSStrategy API
  getRunId(): number {
    return this.strategyState.get('runId') || 0;
  }

  setRunId(runId: number): void {
    this.strategyState.set('runId', runId);
  }

  getOrderSeq(): number {
    return this.strategyState.get('orderSeq') || 0;
  }

  setOrderSeq(orderSeq: number): void {
    this.strategyState.set('orderSeq', orderSeq);
  }

  getStrategyState(key: string): any {
    return this.strategyState.get(key);
  }

  setStrategyState(key: string, value: any): void {
    this.strategyState.set(key, value);
  }

  getAllStrategyState(): Record<string, any> {
    return Object.fromEntries(this.strategyState.entries());
  }

  getCachedAccount(): Account | undefined {
    return this.cachedAccount;
  }

  setCachedAccount(account: Account): void {
    this.cachedAccount = account;
  }

  getCachedPositions(): Map<string, Position> {
    return this.cachedPositions;
  }

  addCachedPosition(position: Position): void {
    this.cachedPositions.set(position.symbol, position);
  }
}

// 模拟普通StrategyContext（无热重载API）
const mockStrategyContext: StrategyContext = {
  getAccount: () => ({ balance: 10000, equity: 10000, availableMargin: 10000, positions: [] }),
  getPosition: () => null,
  getAllPositions: () => [],
  buy: async () => ({ id: '1', symbol: 'TEST', side: 'BUY', qty: 1, price: 100, status: 'PENDING' } as Order),
  sell: async () => ({ id: '2', symbol: 'TEST', side: 'SELL', qty: 1, price: 100, status: 'PENDING' } as Order),
  cancelOrder: async () => {},
  getLastBar: () => null,
  getBars: () => [],
  log: () => {},
  logInfo: () => {},
  logWarn: () => {},
  logError: () => {},
};

describe('StateMigrationEngine', () => {
  let engine: StateMigrationEngine;

  beforeEach(() => {
    engine = new StateMigrationEngine();
  });

  describe('序列化 (serialize)', () => {
    test('应该从QuickJSStrategy正确序列化状态', async () => {
      const mockStrategy = new MockQuickJSStrategy({
        runId: 12345,
        orderSeq: 100,
        positionNotional: 5000,
        exchangePosition: 5000,
        pendingOrders: [{ symbol: 'BTCUSDT', side: 'Buy', qty: 0.1 }],
        customKey: 'customValue',
      });

      const account: Account = {
        balance: 10000,
        equity: 10500,
        availableMargin: 9000,
        positions: [],
      };
      mockStrategy.setCachedAccount(account);

      const position: Position = {
        symbol: 'BTCUSDT',
        quantity: 0.1,
        entryPrice: 50000,
        currentPrice: 50500,
        unrealizedPnl: 50,
        side: 'LONG',
      };
      mockStrategy.addCachedPosition(position);

      // 模拟Provider
      const mockProvider = {
        getOpenOrders: async () => [
          { id: 'order1', symbol: 'BTCUSDT', side: 'Buy', qty: 0.1, price: 50000, status: 'OPEN' },
        ] as Order[],
      };

      const state = await engine.serialize(
        mockStrategy as unknown as StrategyContext,
        'test-strategy',
        mockProvider
      );

      expect(state.runId).toBe(12345);
      expect(state.orderSeq).toBe(100);
      expect(state.positionNotional).toBe(5000);
      expect(state.exchangePosition).toBe(5000);
      expect(state.pendingOrders).toHaveLength(1);
      expect(state.strategyState.customKey).toBe('customValue');
      expect(state.cachedAccount?.balance).toBe(10000);
      expect(state.cachedPositions).toHaveLength(1);
      expect(state.openOrders).toHaveLength(1);
      expect(state.strategyId).toBe('test-strategy');
      expect(state.snapshotHash).not.toBe('');
    });

    test('空状态应该返回默认值', async () => {
      const mockStrategy = new MockQuickJSStrategy();

      const state = await engine.serialize(mockStrategy as unknown as StrategyContext);

      expect(state.runId).toBe(0);
      expect(state.orderSeq).toBe(0);
      expect(state.pendingOrders).toHaveLength(0);
      expect(state.openOrders).toHaveLength(0);
    });
  });

  describe('反序列化 (deserialize)', () => {
    test('应该正确恢复状态到QuickJSStrategy', async () => {
      const originalState: SerializedState = {
        runId: 12345,
        orderSeq: 100,
        positionNotional: 5000,
        exchangePosition: 5000,
        pendingOrders: [{ symbol: 'BTCUSDT', side: 'Buy', qty: 0.1, orderLinkId: 'test-1' }],
        openOrders: [],
        strategyState: { customKey: 'customValue', anotherKey: 42 },
        cachedPositions: [],
        snapshotTime: Date.now(),
        snapshotHash: '', // 会在序列化时计算
        strategyId: 'test-strategy',
      };

      // 计算正确的hash
      const hash = (engine as any).hashState(originalState);
      originalState.snapshotHash = hash;

      const newStrategy = new MockQuickJSStrategy();

      await engine.deserialize(originalState, newStrategy as unknown as StrategyContext);

      expect(newStrategy.getRunId()).toBe(12345);
      expect(newStrategy.getOrderSeq()).toBe(100);
      expect(newStrategy.getStrategyState('customKey')).toBe('customValue');
      expect(newStrategy.getStrategyState('anotherKey')).toBe(42);
    });

    test('hash不匹配应该抛出错误', async () => {
      const corruptedState: SerializedState = {
        runId: 12345,
        orderSeq: 100,
        positionNotional: 5000,
        exchangePosition: 5000,
        pendingOrders: [],
        openOrders: [],
        strategyState: {},
        cachedPositions: [],
        snapshotTime: Date.now(),
        snapshotHash: 'invalid-hash',
      };

      const newStrategy = new MockQuickJSStrategy();

      await expect(
        engine.deserialize(corruptedState, newStrategy as unknown as StrategyContext)
      ).rejects.toThrow('状态hash不匹配');
    });

    test('零值runId和orderSeq不应该调用setter', async () => {
      const state: SerializedState = {
        runId: 0,
        orderSeq: 0,
        positionNotional: 0,
        exchangePosition: 0,
        pendingOrders: [],
        openOrders: [],
        strategyState: { someKey: 'value' },
        cachedPositions: [],
        snapshotTime: Date.now(),
        snapshotHash: '',
      };

      // 计算hash
      state.snapshotHash = (engine as any).hashState(state);

      const newStrategy = new MockQuickJSStrategy();

      await engine.deserialize(state, newStrategy as unknown as StrategyContext);

      expect(newStrategy.getRunId()).toBe(0);
      expect(newStrategy.getOrderSeq()).toBe(0);
      expect(newStrategy.getStrategyState('someKey')).toBe('value');
    });
  });

  describe('对账功能', () => {
    test('订单对账应该检测缺失订单', async () => {
      const oldOrders: Order[] = [
        { id: '1', symbol: 'BTCUSDT', side: 'Buy', qty: 0.1, price: 50000, status: 'OPEN' },
        { id: '2', symbol: 'BTCUSDT', side: 'Sell', qty: 0.1, price: 51000, status: 'OPEN' },
      ] as Order[];

      const newOrders: Order[] = [
        { id: '1', symbol: 'BTCUSDT', side: 'Buy', qty: 0.1, price: 50000, status: 'OPEN' },
      ] as Order[];

      const result = await engine.reconcileOrders(oldOrders, newOrders);

      expect(result.passed).toBe(false);
      expect(result.diff?.missing).toHaveLength(1);
      expect(result.diff?.missing[0].id).toBe('2');
    });

    test('订单对账应该通过一致订单', async () => {
      const orders: Order[] = [
        { id: '1', symbol: 'BTCUSDT', side: 'Buy', qty: 0.1, price: 50000, status: 'OPEN' },
      ] as Order[];

      const result = await engine.reconcileOrders(orders, orders);

      expect(result.passed).toBe(true);
    });

    test('持仓对账应该在阈值内通过', async () => {
      const result = await engine.reconcilePosition(1000, 1005);

      expect(result.passed).toBe(true);
    });

    test('持仓对账应该检测大额差异', async () => {
      const result = await engine.reconcilePosition(1000, 1100);

      expect(result.passed).toBe(false);
      expect(result.diff?.diff).toBe(100);
    });
  });
});
