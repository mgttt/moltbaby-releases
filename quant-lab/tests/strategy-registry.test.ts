/**
 * StrategyRegistry 单元测试
 * 
 * 测试全局策略注册表的功能
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { StrategyRegistry } from '../src/hot-reload/StrategyRegistry';

// 模拟QuickJSStrategy
class MockQuickJSStrategy {
  readonly strategyId: string;
  
  constructor(id: string) {
    this.strategyId = id;
  }
}

describe('StrategyRegistry', () => {
  beforeEach(() => {
    // 每个测试前清空注册表
    StrategyRegistry.clear();
    StrategyRegistry.setAutoRegister(true);
  });

  describe('注册 (register)', () => {
    test('应该成功注册策略', () => {
      const strategy = new MockQuickJSStrategy('test-strategy-1') as any;
      
      const result = StrategyRegistry.register('test-strategy-1', strategy);
      
      expect(result).toBe(true);
      expect(StrategyRegistry.has('test-strategy-1')).toBe(true);
      expect(StrategyRegistry.size()).toBe(1);
    });

    test('同一个实例应该支持幂等注册', () => {
      const strategy = new MockQuickJSStrategy('test-strategy-1') as any;
      
      const result1 = StrategyRegistry.register('test-strategy-1', strategy);
      const result2 = StrategyRegistry.register('test-strategy-1', strategy);
      
      expect(result1).toBe(true);
      expect(result2).toBe(true);
      expect(StrategyRegistry.size()).toBe(1);
    });

    test('不同实例相同ID应该注册失败', () => {
      const strategy1 = new MockQuickJSStrategy('test-strategy-1') as any;
      const strategy2 = new MockQuickJSStrategy('test-strategy-1') as any;
      
      const result1 = StrategyRegistry.register('test-strategy-1', strategy1);
      const result2 = StrategyRegistry.register('test-strategy-1', strategy2);
      
      expect(result1).toBe(true);
      expect(result2).toBe(false);
      expect(StrategyRegistry.size()).toBe(1);
    });

    test('空ID应该抛出错误', () => {
      const strategy = new MockQuickJSStrategy('') as any;
      
      expect(() => {
        StrategyRegistry.register('', strategy);
      }).toThrow('strategyId必须是非空字符串');
    });

    test('应该支持多个策略注册', () => {
      const strategy1 = new MockQuickJSStrategy('strategy-1') as any;
      const strategy2 = new MockQuickJSStrategy('strategy-2') as any;
      const strategy3 = new MockQuickJSStrategy('strategy-3') as any;
      
      StrategyRegistry.register('strategy-1', strategy1);
      StrategyRegistry.register('strategy-2', strategy2);
      StrategyRegistry.register('strategy-3', strategy3);
      
      expect(StrategyRegistry.size()).toBe(3);
      expect(StrategyRegistry.getAllIds()).toContain('strategy-1');
      expect(StrategyRegistry.getAllIds()).toContain('strategy-2');
      expect(StrategyRegistry.getAllIds()).toContain('strategy-3');
    });
  });

  describe('获取 (get)', () => {
    test('应该能获取已注册的策略', () => {
      const strategy = new MockQuickJSStrategy('test-strategy') as any;
      StrategyRegistry.register('test-strategy', strategy);
      
      const retrieved = StrategyRegistry.get('test-strategy');
      
      expect(retrieved).toBe(strategy);
    });

    test('获取不存在的策略应该返回undefined', () => {
      const retrieved = StrategyRegistry.get('non-existent');
      
      expect(retrieved).toBeUndefined();
    });
  });

  describe('检查 (has)', () => {
    test('应该能检查策略是否已注册', () => {
      const strategy = new MockQuickJSStrategy('test-strategy') as any;
      
      expect(StrategyRegistry.has('test-strategy')).toBe(false);
      
      StrategyRegistry.register('test-strategy', strategy);
      
      expect(StrategyRegistry.has('test-strategy')).toBe(true);
    });
  });

  describe('注销 (unregister)', () => {
    test('应该能注销已注册的策略', () => {
      const strategy = new MockQuickJSStrategy('test-strategy') as any;
      StrategyRegistry.register('test-strategy', strategy);
      
      const result = StrategyRegistry.unregister('test-strategy');
      
      expect(result).toBe(true);
      expect(StrategyRegistry.has('test-strategy')).toBe(false);
      expect(StrategyRegistry.size()).toBe(0);
    });

    test('注销不存在的策略应该返回false', () => {
      const result = StrategyRegistry.unregister('non-existent');
      
      expect(result).toBe(false);
    });
  });

  describe('清空 (clear)', () => {
    test('应该能清空所有注册', () => {
      const strategy1 = new MockQuickJSStrategy('strategy-1') as any;
      const strategy2 = new MockQuickJSStrategy('strategy-2') as any;
      
      StrategyRegistry.register('strategy-1', strategy1);
      StrategyRegistry.register('strategy-2', strategy2);
      
      StrategyRegistry.clear();
      
      expect(StrategyRegistry.size()).toBe(0);
      expect(StrategyRegistry.has('strategy-1')).toBe(false);
      expect(StrategyRegistry.has('strategy-2')).toBe(false);
    });
  });

  describe('自动注册控制', () => {
    test('应该能启用/禁用自动注册', () => {
      expect(StrategyRegistry.isAutoRegisterEnabled()).toBe(true);
      
      StrategyRegistry.setAutoRegister(false);
      
      expect(StrategyRegistry.isAutoRegisterEnabled()).toBe(false);
      
      StrategyRegistry.setAutoRegister(true);
      
      expect(StrategyRegistry.isAutoRegisterEnabled()).toBe(true);
    });
  });

  describe('注册信息 (getEntry)', () => {
    test('应该能获取注册信息', () => {
      const strategy = new MockQuickJSStrategy('test-strategy') as any;
      const beforeRegister = Date.now();
      
      StrategyRegistry.register('test-strategy', strategy);
      
      const entry = StrategyRegistry.getEntry('test-strategy');
      
      expect(entry).toBeDefined();
      expect(entry?.strategyId).toBe('test-strategy');
      expect(entry?.registeredAt).toBeGreaterThanOrEqual(beforeRegister);
      expect(entry?.registeredAt).toBeLessThanOrEqual(Date.now());
    });

    test('获取不存在的注册信息应该返回undefined', () => {
      const entry = StrategyRegistry.getEntry('non-existent');
      
      expect(entry).toBeUndefined();
    });
  });

  describe('并发场景（异步竞态测试）', () => {
    test('快速连续注册同一ID应该正确处理', async () => {
      const strategy = new MockQuickJSStrategy('race-strategy') as any;
      
      // 模拟并发注册尝试
      const promises = [
        Promise.resolve(StrategyRegistry.register('race-strategy', strategy)),
        Promise.resolve(StrategyRegistry.register('race-strategy', strategy)),
        Promise.resolve(StrategyRegistry.register('race-strategy', strategy)),
      ];
      
      const results = await Promise.all(promises);
      
      // 第一个应该成功，幂等的也应该成功
      expect(results.filter(r => r).length).toBeGreaterThanOrEqual(1);
      expect(StrategyRegistry.size()).toBe(1);
    });

    test('注册后立即获取应该正确', () => {
      const strategy = new MockQuickJSStrategy('immediate-strategy') as any;
      
      StrategyRegistry.register('immediate-strategy', strategy);
      const retrieved = StrategyRegistry.get('immediate-strategy');
      
      expect(retrieved).toBe(strategy);
    });
  });
});
