/**
 * StrategyReloader 单元测试
 * 
 * 测试策略热重载的完整流程
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { StrategyReloader, type StrategyReloadOptions } from '../src/hot-reload/StrategyReloader';
import { StateMigrationEngine } from '../src/hot-reload/StateMigrationEngine';
import type { StrategyContext } from '../src/types/strategy';
import type { Order } from '../src/types/market';

// 模拟QuickJSStrategy
class MockQuickJSStrategy {
  private strategyState = new Map<string, any>();
  private cachedPositions = new Map<string, any>();
  private functionCalls: string[] = [];
  private reloadCalled = false;
  private rollbackCalled = false;

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

  getCachedPositions(): Map<string, any> {
    return this.cachedPositions;
  }

  // 模拟公共API
  async callStrategyFunction(name: string, ...args: any[]): Promise<any> {
    this.functionCalls.push(name);
    
    if (name === 'st_stop') {
      // 正常执行
      return;
    }
    
    if (name === 'st_init') {
      // 模拟st_init会读取_hotReload标志
      const context = args[0];
      return;
    }
    
    return;
  }

  async reload(triggeredBy?: string): Promise<{ success: boolean; oldHash: string; newHash: string; duration: number }> {
    this.reloadCalled = true;
    return {
      success: true,
      oldHash: 'abc123',
      newHash: 'def456',
      duration: 100,
    };
  }

  async rollback(): Promise<{ success: boolean; restoredHash?: string; error?: string; rto: number }> {
    this.rollbackCalled = true;
    return {
      success: true,
      restoredHash: 'abc123',
      rto: 50,
    };
  }

  // 测试辅助方法
  getFunctionCalls(): string[] {
    return [...this.functionCalls];
  }

  wasReloadCalled(): boolean {
    return this.reloadCalled;
  }

  wasRollbackCalled(): boolean {
    return this.rollbackCalled;
  }

  clearFunctionCalls(): void {
    this.functionCalls = [];
  }
}

// 模拟普通StrategyContext
const createMockContext = (overrides?: Partial<StrategyContext>): StrategyContext => ({
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
  ...overrides,
});

describe('StrategyReloader', () => {
  let reloader: StrategyReloader;

  beforeEach(() => {
    reloader = new StrategyReloader();
  });

  describe('reloadStrategy', () => {
    test('应该成功执行热重载流程', async () => {
      const mockStrategy = new MockQuickJSStrategy({
        runId: 12345,
        orderSeq: 100,
        positionNotional: 5000,
        exchangePosition: 5000,
      });

      // 将mockStrategy作为context传递，因为它有serialize需要的API
      const context = mockStrategy as unknown as StrategyContext;
      
      const result = await reloader.reloadStrategy(
        mockStrategy as any,
        context,
        { skipValidation: true } // 跳过验证以简化测试
      );

      expect(result.success).toBe(true);
      expect(result.oldState.runId).toBe(12345);
      expect(result.oldState.orderSeq).toBe(100);
      expect(mockStrategy.wasReloadCalled()).toBe(true);
      
      const calls = mockStrategy.getFunctionCalls();
      expect(calls).toContain('st_stop');
      expect(calls).toContain('st_init');
    });

    test('应该保留runId和orderSeq', async () => {
      const mockStrategy = new MockQuickJSStrategy({
        runId: 99999,
        orderSeq: 500,
      });

      const context = mockStrategy as unknown as StrategyContext;
      
      const result = await reloader.reloadStrategy(
        mockStrategy as any,
        context,
        { skipValidation: true }
      );

      expect(result.success).toBe(true);
      // reloadStrategy内部会调用setRunId/setOrderSeq
      expect(mockStrategy.getRunId()).toBe(99999);
      expect(mockStrategy.getOrderSeq()).toBe(500);
    });

    test('失败时应该回滚', async () => {
      const mockStrategy = new MockQuickJSStrategy({
        runId: 12345,
        orderSeq: 100,
      });

      // 模拟reload失败
      mockStrategy.reload = async () => {
        throw new Error('模拟reload失败');
      };

      const context = mockStrategy as unknown as StrategyContext;
      
      const result = await reloader.reloadStrategy(
        mockStrategy as any,
        context,
        { skipValidation: true }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('模拟reload失败');
      expect(result.rolledBack).toBe(true);
      expect(mockStrategy.wasRollbackCalled()).toBe(true);
    });

    test('应该支持跳过验证选项', async () => {
      const mockStrategy = new MockQuickJSStrategy({
        runId: 12345,
        orderSeq: 100,
      });

      const context = mockStrategy as unknown as StrategyContext;
      
      const result = await reloader.reloadStrategy(
        mockStrategy as any,
        context,
        { skipValidation: true }
      );

      expect(result.success).toBe(true);
      expect(result.newState).toBeDefined();
    });
  });

  describe('validateReload', () => {
    test('应该通过一致的状态验证', async () => {
      const mockStrategy = new MockQuickJSStrategy({
        runId: 12345,
        orderSeq: 100,
        positionNotional: 5000,
        exchangePosition: 5000,
      });

      const context = mockStrategy as unknown as StrategyContext;
      
      // 先执行一次reload获取oldState
      const reloadResult = await reloader.reloadStrategy(
        mockStrategy as any,
        context,
        { skipValidation: true }
      );

      // 验证应该通过（状态未改变）
      const validated = await reloader.validateReload(reloadResult.oldState, context);
      expect(validated).toBe(true);
    });

    test('应该检测runId变化', async () => {
      const mockStrategy = new MockQuickJSStrategy({
        runId: 12345,
        orderSeq: 100,
        positionNotional: 5000,
      });

      const context = mockStrategy as unknown as StrategyContext;
      
      const reloadResult = await reloader.reloadStrategy(
        mockStrategy as any,
        context,
        { skipValidation: true }
      );

      // 模拟状态变化
      mockStrategy.setRunId(99999);

      const validated = await reloader.validateReload(reloadResult.oldState, context);
      expect(validated).toBe(false);
    });

    test('应该检测orderSeq倒退', async () => {
      const mockStrategy = new MockQuickJSStrategy({
        runId: 12345,
        orderSeq: 100,
        positionNotional: 5000,
      });

      const context = mockStrategy as unknown as StrategyContext;
      
      const reloadResult = await reloader.reloadStrategy(
        mockStrategy as any,
        context,
        { skipValidation: true }
      );

      // 模拟orderSeq倒退
      mockStrategy.setOrderSeq(50);

      const validated = await reloader.validateReload(reloadResult.oldState, context);
      expect(validated).toBe(false);
    });
  });

  describe('rollback', () => {
    test('应该成功执行回滚', async () => {
      const mockStrategy = new MockQuickJSStrategy({
        runId: 12345,
        orderSeq: 100,
      });

      const context = mockStrategy as unknown as StrategyContext;
      
      const oldState = {
        runId: 12345,
        orderSeq: 100,
        positionNotional: 5000,
        exchangePosition: 5000,
        pendingOrders: [],
        openOrders: [],
        strategyState: { customKey: 'value' },
        cachedPositions: [],
        snapshotTime: Date.now(),
        snapshotHash: 'test-hash',
      };

      // rollback是private方法，通过reload的失败路径间接测试
      mockStrategy.reload = async () => {
        throw new Error('模拟失败触发回滚');
      };

      const result = await reloader.reloadStrategy(
        mockStrategy as any,
        context,
        { skipValidation: true }
      );

      expect(result.success).toBe(false);
      expect(result.rolledBack).toBe(true);
    });
  });
});
