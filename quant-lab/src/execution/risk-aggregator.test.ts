/**
 * risk-aggregator.test.ts - 全局风险聚合器测试套件
 * 
 * 测试覆盖:
 * - 单元测试: 策略注册/注销/更新
 * - 集成测试: 全局限制检查
 * - 边界条件: 超限/警告/并发
 */

import { createLogger } from '../utils/logger';
const logger = createLogger('risk-aggregator.test');

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  GlobalRiskAggregator,
  createGlobalRiskAggregator,
  resetGlobalRiskAggregator,
  getGlobalRiskAggregator,
} from './risk-aggregator';

describe('GlobalRiskAggregator', () => {
  const defaultLimits = {
    maxTotalLeverage: 10,
    maxTotalPositionValue: 100000,
    maxTotalMarginUsage: 80000,
    maxStrategyCount: 5,
  };

  const createSnapshot = (id: string, value: number, leverage: number) => ({
    strategyId: id,
    sessionId: `${id}-session`,
    symbol: 'BTCUSDT',
    side: 'LONG' as const,
    positionSize: 1,
    positionValue: value,
    leverage,
    marginUsed: value / leverage,
    timestamp: Date.now(),
  });

  beforeEach(() => {
    resetGlobalRiskAggregator();
  });

  // ==================== 单元测试: 初始化 ====================

  describe('初始化', () => {
    it('应该正确初始化', () => {
      const aggregator = createGlobalRiskAggregator({ limits: defaultLimits });
      expect(aggregator).toBeDefined();
      
      const state = aggregator.getGlobalState();
      expect(state.strategyCount).toBe(0);
      expect(state.totalPositionValue).toBe(0);
    });

    it('单例模式应该工作', () => {
      const aggregator1 = getGlobalRiskAggregator({ limits: defaultLimits });
      const aggregator2 = getGlobalRiskAggregator();
      expect(aggregator1).toBe(aggregator2);
    });
  });

  // ==================== 单元测试: 策略注册 ====================

  describe('策略注册', () => {
    it('首个策略应该注册成功', async () => {
      const aggregator = createGlobalRiskAggregator({ limits: defaultLimits });
      const snapshot = createSnapshot('strategy-1', 10000, 2);

      const result = await aggregator.registerStrategy(snapshot);
      expect(result).toBe(true);
      
      const state = aggregator.getGlobalState();
      expect(state.strategyCount).toBe(1);
      expect(state.totalPositionValue).toBe(10000);
    });

    it('多个策略应该累计计算', async () => {
      const aggregator = createGlobalRiskAggregator({ limits: defaultLimits });

      await aggregator.registerStrategy(createSnapshot('s1', 10000, 2));
      await aggregator.registerStrategy(createSnapshot('s2', 15000, 3));
      await aggregator.registerStrategy(createSnapshot('s3', 5000, 1));

      const state = aggregator.getGlobalState();
      expect(state.strategyCount).toBe(3);
      expect(state.totalPositionValue).toBe(30000);
      expect(state.totalLeverage).toBe(6); // 2+3+1
    });

    it('超过策略数量限制应该拒绝', async () => {
      const aggregator = createGlobalRiskAggregator({
        limits: { ...defaultLimits, maxStrategyCount: 2 },
      });

      await aggregator.registerStrategy(createSnapshot('s1', 1000, 1));
      await aggregator.registerStrategy(createSnapshot('s2', 1000, 1));
      
      const result = await aggregator.registerStrategy(createSnapshot('s3', 1000, 1));
      expect(result).toBe(false);
    });

    it('超过总持仓限制应该拒绝', async () => {
      const aggregator = createGlobalRiskAggregator({
        limits: { ...defaultLimits, maxTotalPositionValue: 15000 },
      });

      await aggregator.registerStrategy(createSnapshot('s1', 10000, 2));
      
      // s2会使总值达到25000，超过15000限制
      const result = await aggregator.registerStrategy(createSnapshot('s2', 15000, 2));
      expect(result).toBe(false);
    });

    it('超过总杠杆限制应该拒绝', async () => {
      const aggregator = createGlobalRiskAggregator({
        limits: { ...defaultLimits, maxTotalLeverage: 5 },
      });

      await aggregator.registerStrategy(createSnapshot('s1', 10000, 3));
      
      // s2会使杠杆达到3+3=6，超过5限制
      const result = await aggregator.registerStrategy(createSnapshot('s2', 10000, 3));
      expect(result).toBe(false);
    });
  });

  // ==================== 单元测试: 策略注销 ====================

  describe('策略注销', () => {
    it('注销策略应该减少计数', async () => {
      const aggregator = createGlobalRiskAggregator({ limits: defaultLimits });

      await aggregator.registerStrategy(createSnapshot('s1', 10000, 2));
      await aggregator.registerStrategy(createSnapshot('s2', 15000, 3));
      
      aggregator.unregisterStrategy('s1');
      
      const state = aggregator.getGlobalState();
      expect(state.strategyCount).toBe(1);
      expect(state.totalPositionValue).toBe(15000);
    });

    it('注销不存在策略应该静默处理', () => {
      const aggregator = createGlobalRiskAggregator({ limits: defaultLimits });
      
      // 不应该抛出异常
      expect(() => aggregator.unregisterStrategy('non-existent')).not.toThrow();
    });
  });

  // ==================== 单元测试: 策略更新 ====================

  describe('策略更新', () => {
    it('更新持仓应该重新计算总量', async () => {
      const aggregator = createGlobalRiskAggregator({ limits: defaultLimits });

      await aggregator.registerStrategy(createSnapshot('s1', 10000, 2));
      
      aggregator.updateStrategySnapshot('s1', {
        positionValue: 20000,
        leverage: 4,
      });
      
      const state = aggregator.getGlobalState();
      expect(state.totalPositionValue).toBe(20000);
      expect(state.totalLeverage).toBe(4);
    });

    it('更新后超限应该触发告警', async () => {
      const alertHandler = vi.fn();
      const aggregator = createGlobalRiskAggregator({
        limits: { ...defaultLimits, maxTotalPositionValue: 25000 },
      });

      aggregator.on('risk:limit_exceeded', alertHandler);

      // 先注册两个策略，总值15000
      await aggregator.registerStrategy(createSnapshot('s1', 10000, 2));
      await aggregator.registerStrategy(createSnapshot('s2', 5000, 1));

      // 更新s1使总值达到30000，超过25000限制
      aggregator.updateStrategySnapshot('s1', { positionValue: 25000 });

      expect(alertHandler).toHaveBeenCalled();
    });

    it('更新不存在策略应该警告', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const aggregator = createGlobalRiskAggregator({ limits: defaultLimits });

      aggregator.updateStrategySnapshot('non-existent', { positionValue: 1000 });
      
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('策略不存在'));
      consoleSpy.mockRestore();
    });
  });

  // ==================== 单元测试: 风险视图 ====================

  describe('风险视图', () => {
    it('应该返回正确的风险视图', async () => {
      const aggregator = createGlobalRiskAggregator({ limits: defaultLimits });

      await aggregator.registerStrategy(createSnapshot('s1', 30000, 2));
      await aggregator.registerStrategy(createSnapshot('s2', 20000, 3));

      const view = aggregator.getRiskView();
      
      expect(view.summary.totalPositionValue).toBe(50000);
      expect(view.summary.totalLeverage).toBe(5);
      expect(view.summary.strategyCount).toBe(2);
      
      expect(view.utilization.positionValuePct).toBe(50); // 50000/100000
      expect(view.utilization.leveragePct).toBe(50); // 5/10
      expect(view.strategies).toHaveLength(2);
    });

    it('SAFE状态应该正确', async () => {
      const aggregator = createGlobalRiskAggregator({ limits: defaultLimits });
      await aggregator.registerStrategy(createSnapshot('s1', 10000, 2));

      const view = aggregator.getRiskView();
      expect(view.status).toBe('SAFE');
    });

    it('WARNING状态应该正确', async () => {
      const aggregator = createGlobalRiskAggregator({ limits: defaultLimits });
      // 杠杆8x/10x = 80%
      await aggregator.registerStrategy(createSnapshot('s1', 50000, 8));

      const view = aggregator.getRiskView();
      expect(view.status).toBe('WARNING');
    });

    it('CRITICAL状态应该正确', async () => {
      const aggregator = createGlobalRiskAggregator({ 
        limits: { ...defaultLimits, maxTotalLeverage: 12 } // 稍微放宽以便测试
      });
      // 注册两个策略，总杠杆10x (正好WARNING边界)
      await aggregator.registerStrategy(createSnapshot('s1', 40000, 6));
      await aggregator.registerStrategy(createSnapshot('s2', 20000, 4));
      
      // 更新使杠杆增加
      aggregator.updateStrategySnapshot('s1', { leverage: 9 });

      const view = aggregator.getRiskView();
      expect(view.status).toBe('CRITICAL');
    });
  });

  // ==================== 单元测试: 预检功能 ====================

  describe('预检功能(checkNewStrategy)', () => {
    it('应该正确预检新策略', async () => {
      const aggregator = createGlobalRiskAggregator({ limits: defaultLimits });
      await aggregator.registerStrategy(createSnapshot('s1', 10000, 2));

      const result = aggregator.checkNewStrategy(createSnapshot('s2', 5000, 2));
      
      expect(result.allowed).toBe(true);
      expect(result.currentState.totalPositionValue).toBe(15000);
    });

    it('预检超限应该返回拒绝', async () => {
      const aggregator = createGlobalRiskAggregator({
        limits: { ...defaultLimits, maxTotalPositionValue: 15000 },
      });
      await aggregator.registerStrategy(createSnapshot('s1', 10000, 2));

      const result = aggregator.checkNewStrategy(createSnapshot('s2', 10000, 2));
      
      expect(result.allowed).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
    });

    it('预检应该包含警告', async () => {
      const aggregator = createGlobalRiskAggregator({ limits: defaultLimits });
      // 添加4个策略，接近5个限制
      for (let i = 1; i <= 4; i++) {
        await aggregator.registerStrategy(createSnapshot(`s${i}`, 1000, 1));
      }

      const result = aggregator.checkNewStrategy(createSnapshot('new', 1000, 1));
      
      expect(result.allowed).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('策略数量接近上限');
    });
  });

  // ==================== 单元测试: 报告生成 ====================

  describe('报告生成', () => {
    it('应该生成风险报告', async () => {
      const aggregator = createGlobalRiskAggregator({ limits: defaultLimits });
      await aggregator.registerStrategy(createSnapshot('gales-myx', 5000, 2));

      const report = aggregator.generateReport();
      
      expect(report).toContain('全局风险聚合器报告');
      expect(report).toContain('gales-myx');
      expect(report).toContain('BTCUSDT');
    });
  });

  // ==================== 单元测试: 告警功能 ====================

  describe('告警功能', () => {
    it('应该触发告警回调', async () => {
      const alertCallback = vi.fn().mockResolvedValue(undefined);
      const aggregator = createGlobalRiskAggregator({
        limits: { ...defaultLimits, maxStrategyCount: 1 },
        alertConfig: {
          enabled: true,
          onViolation: alertCallback,
        },
      });

      await aggregator.registerStrategy(createSnapshot('s1', 1000, 1));
      await aggregator.registerStrategy(createSnapshot('s2', 1000, 1)); // 应该触发告警

      expect(alertCallback).toHaveBeenCalled();
    });

    it('禁用告警时不应该触发', async () => {
      const alertCallback = vi.fn().mockResolvedValue(undefined);
      const aggregator = createGlobalRiskAggregator({
        limits: { ...defaultLimits, maxStrategyCount: 1 },
        alertConfig: {
          enabled: false,
          onViolation: alertCallback,
        },
      });

      await aggregator.registerStrategy(createSnapshot('s1', 1000, 1));
      await aggregator.registerStrategy(createSnapshot('s2', 1000, 1));

      expect(alertCallback).not.toHaveBeenCalled();
    });
  });

  // ==================== 单元测试: 事件监听 ====================

  describe('事件监听', () => {
    it('应该触发registered事件', async () => {
      const handler = vi.fn();
      const aggregator = createGlobalRiskAggregator({ limits: defaultLimits });
      
      aggregator.on('strategy:registered', handler);
      await aggregator.registerStrategy(createSnapshot('s1', 1000, 1));

      expect(handler).toHaveBeenCalled();
    });

    it('应该触发rejected事件', async () => {
      const handler = vi.fn();
      const aggregator = createGlobalRiskAggregator({
        limits: { ...defaultLimits, maxStrategyCount: 0 },
      });
      
      aggregator.on('strategy:rejected', handler);
      await aggregator.registerStrategy(createSnapshot('s1', 1000, 1));

      expect(handler).toHaveBeenCalled();
    });

    it('应该触发unregistered事件', async () => {
      const handler = vi.fn();
      const aggregator = createGlobalRiskAggregator({ limits: defaultLimits });
      
      await aggregator.registerStrategy(createSnapshot('s1', 1000, 1));
      aggregator.on('strategy:unregistered', handler);
      aggregator.unregisterStrategy('s1');

      expect(handler).toHaveBeenCalled();
    });
  });

  // ==================== 边界条件测试 ====================

  describe('边界条件', () => {
    it('空状态应该正确', () => {
      const aggregator = createGlobalRiskAggregator({ limits: defaultLimits });
      const view = aggregator.getRiskView();
      
      expect(view.summary.strategyCount).toBe(0);
      expect(view.status).toBe('SAFE');
    });

    it('正好达到限制应该允许', async () => {
      const aggregator = createGlobalRiskAggregator({
        limits: { ...defaultLimits, maxTotalPositionValue: 10000 },
      });

      const result = await aggregator.registerStrategy(createSnapshot('s1', 10000, 2));
      expect(result).toBe(true);
    });

    it('正好超过限制应该拒绝', async () => {
      const aggregator = createGlobalRiskAggregator({
        limits: { ...defaultLimits, maxTotalPositionValue: 10000 },
      });

      const result = await aggregator.registerStrategy(createSnapshot('s1', 10001, 2));
      expect(result).toBe(false);
    });

    it('零值应该正确处理', async () => {
      const aggregator = createGlobalRiskAggregator({ limits: defaultLimits });
      const result = await aggregator.registerStrategy(createSnapshot('s1', 0, 0));
      
      expect(result).toBe(true);
      const state = aggregator.getGlobalState();
      expect(state.totalPositionValue).toBe(0);
    });
  });

  // ==================== 性能测试 ====================

  describe('性能测试', () => {
    it('100次注册应该在100ms内完成', async () => {
      const aggregator = createGlobalRiskAggregator({ limits: defaultLimits });

      const start = Date.now();
      for (let i = 0; i < 100; i++) {
        await aggregator.registerStrategy(createSnapshot(`s${i}`, 100, 1));
        aggregator.unregisterStrategy(`s${i}`);
      }
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(100);
    });
  });

  // ==================== 集成测试: 场景模拟 ====================

  describe('场景模拟', () => {
    it('gales-neutral + gales-short 场景', async () => {
      const aggregator = createGlobalRiskAggregator({
        limits: {
          maxTotalLeverage: 8,      // 保守限制
          maxTotalPositionValue: 50000,
          maxTotalMarginUsage: 40000,
          maxStrategyCount: 3,
        },
      });

      // gales-neutral: 杠杆2x，持仓15000
      const neutralResult = await aggregator.registerStrategy({
        strategyId: 'gales-neutral',
        sessionId: 'neutral-001',
        symbol: 'BTCUSDT',
        side: 'NEUTRAL',
        positionSize: 0.3,
        positionValue: 15000,
        leverage: 2,
        marginUsed: 7500,
        timestamp: Date.now(),
      });
      expect(neutralResult).toBe(true);

      // gales-short: 杠杆3x，持仓10000
      const shortResult = await aggregator.registerStrategy({
        strategyId: 'gales-short',
        sessionId: 'short-001',
        symbol: 'BTCUSDT',
        side: 'SHORT',
        positionSize: 0.2,
        positionValue: 10000,
        leverage: 3,
        marginUsed: 3333,
        timestamp: Date.now(),
      });
      expect(shortResult).toBe(true);

      // 验证总状态
      const view = aggregator.getRiskView();
      expect(view.summary.totalLeverage).toBe(5); // 2+3
      expect(view.summary.totalPositionValue).toBe(25000);
      expect(view.status).toBe('SAFE');

      // 尝试添加第三个策略使杠杆达到8x（正好达到限制）
      const thirdResult = await aggregator.registerStrategy({
        strategyId: 'gales-long',
        sessionId: 'long-001',
        symbol: 'BTCUSDT',
        side: 'LONG',
        positionSize: 0.2,
        positionValue: 10000,
        leverage: 3, // 5+3=8，正好达到限制
        marginUsed: 3333,
        timestamp: Date.now(),
      });
      expect(thirdResult).toBe(true);

      // 第四个策略应该被拒绝
      const fourthResult = await aggregator.registerStrategy({
        strategyId: 'gales-grid',
        sessionId: 'grid-001',
        symbol: 'BTCUSDT',
        side: 'NEUTRAL',
        positionSize: 0.1,
        positionValue: 5000,
        leverage: 2, // 8+2=10 > 8
        marginUsed: 2500,
        timestamp: Date.now(),
      });
      expect(fourthResult).toBe(false);
    });
  });
});
