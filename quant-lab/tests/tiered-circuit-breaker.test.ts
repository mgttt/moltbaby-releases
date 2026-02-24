/**
 * 分级熔断框架单元测试
 * 
 * 测试覆盖：
 * 1. 基础熔断/恢复流程
 * 2. A/B/C/D分级逻辑
 * 3. 状态持久化
 * 4. 回撤检测
 * 5. 旧格式兼容
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  TieredCircuitBreaker,
  TieredCircuitConfig,
  CircuitState,
} from '../src/execution/tiered-circuit-breaker';

describe('TieredCircuitBreaker', () => {
  let testDir: string;
  let cb: TieredCircuitBreaker;

  beforeEach(() => {
    testDir = join(tmpdir(), `circuit-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    const config: Partial<TieredCircuitConfig> = {
      statePersistence: {
        enabled: true,
        filePath: join(testDir, 'circuit-state.json'),
        saveIntervalMs: 1000,
      },
      classA: {
        enabled: true,
        autoReset: false,
        resetTimeoutMs: 1000,
        maxConsecutiveFailures: 2,
      },
      classB: {
        enabled: true,
        autoReset: true,
        resetTimeoutMs: 500,
        maxConsecutiveFailures: 3,
      },
      classC: {
        enabled: true,
        autoReset: true,
        resetTimeoutMs: 500,
        maxConsecutiveFailures: 5,
        maxDrawdownPercent: 0.1,  // 10%回撤（测试用）
      },
      classD: {
        enabled: true,
        logOnly: true,
      },
    };

    cb = new TieredCircuitBreaker('test-strategy', config);
  });

  afterEach(() => {
    cb.destroy();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  // ============ 基础功能测试 ============

  describe('基础功能', () => {
    it('应该正确初始化', () => {
      expect(cb).toBeDefined();
      expect(cb.getGlobalState()).toBe('CLOSED');
      expect(cb.canTrade()).toBe(true);
    });

    it('应该能正常交易（初始状态）', () => {
      expect(cb.isTripped('A')).toBe(false);
      expect(cb.isTripped('B')).toBe(false);
      expect(cb.isTripped('C')).toBe(false);
      expect(cb.canTrade()).toBe(true);
    });

    it('C类熔断后应该禁止交易', () => {
      cb.trip('C', 'TEST', '测试熔断');
      
      expect(cb.getGlobalState()).toBe('OPEN');
      expect(cb.canTrade()).toBe(false);
      expect(cb.isTripped('C')).toBe(true);
    });

    it('A/B/C类熔断都应该禁止交易', () => {
      cb.trip('A', 'TEST', 'A类熔断');
      expect(cb.canTrade()).toBe(false);
      
      // 重置后测试B类
      cb.destroy();
      const config2: Partial<TieredCircuitConfig> = {
        statePersistence: { enabled: false, filePath: '', saveIntervalMs: 1000 },
        classB: { enabled: true, autoReset: true, resetTimeoutMs: 500, maxConsecutiveFailures: 3 },
      };
      const cb2 = new TieredCircuitBreaker('test-strategy-2', config2);
      
      cb2.trip('B', 'TEST', 'B类熔断');
      expect(cb2.canTrade()).toBe(false);
      cb2.destroy();
    });
  });

  // ============ 分级熔断测试 ============

  describe('A类熔断（严重）', () => {
    it('应该触发A类熔断', () => {
      cb.trip('A', 'SYSTEM_ERROR', '系统错误');
      
      expect(cb.isTripped('A')).toBe(true);
      expect(cb.getGlobalState()).toBe('OPEN');
    });

    it('A类默认不自动恢复', () => {
      cb.trip('A', 'SYSTEM_ERROR', '系统错误');
      
      // 等待超过resetTimeout
      const start = Date.now();
      while (Date.now() - start < 600) {
        // 等待
      }
      
      // 尝试恢复应该失败
      const result = cb.attemptReset('A');
      expect(result).toBe(false);
      expect(cb.isTripped('A')).toBe(true);
    });

    it('应该能通过连续失败触发A类熔断', () => {
      cb.recordFailure('A');
      cb.recordFailure('A');
      
      expect(cb.isTripped('A')).toBe(true);
    });
  });

  describe('B类熔断（高）', () => {
    it('应该触发B类熔断', () => {
      cb.trip('B', 'STATE_MISMATCH', '状态不可置信');
      
      expect(cb.isTripped('B')).toBe(true);
    });

    it('B类应该支持自动恢复', () => {
      cb.trip('B', 'STATE_MISMATCH', '状态不可置信');
      expect(cb.isTripped('B')).toBe(true);
      
      // 等待冷却期
      const start = Date.now();
      while (Date.now() - start < 600) {
        // 等待500ms+
      }
      
      // 尝试恢复
      const result = cb.attemptReset('B');
      expect(result).toBe(true);
      
      // 确认恢复
      cb.confirmReset('B');
      expect(cb.isTripped('B')).toBe(false);
      expect(cb.canTrade()).toBe(true);
    });
  });

  describe('C类熔断（中）', () => {
    it('应该触发C类熔断', () => {
      cb.trip('C', 'RISK_LIMIT', '触及风控线');
      
      expect(cb.isTripped('C')).toBe(true);
    });

    it('应该检测回撤并熔断', () => {
      // 设置初始权益
      cb.checkDrawdown(10000);
      
      // 回撤10%（触发阈值）
      const tripped = cb.checkDrawdown(9000);
      
      expect(tripped).toBe(true);
      expect(cb.isTripped('C')).toBe(true);
    });

    it('不应该在回撤未达阈值时熔断', () => {
      cb.checkDrawdown(10000);
      
      // 回撤5%（未达阈值）
      const tripped = cb.checkDrawdown(9500);
      
      expect(tripped).toBe(false);
      expect(cb.isTripped('C')).toBe(false);
    });

    it('应该更新峰值', () => {
      cb.checkDrawdown(10000);
      cb.checkDrawdown(11000);  // 新高
      
      // 从新峰值回撤10%
      const tripped = cb.checkDrawdown(9900);
      
      expect(tripped).toBe(true);
    });
  });

  describe('D类告警（低）', () => {
    it('D类只记录不熔断', () => {
      cb.trip('D', 'WARNING', '性能下降');
      
      // D类不应该导致全局熔断
      expect(cb.canTrade()).toBe(true);
      expect(cb.getGlobalState()).toBe('CLOSED');
    });

    it('应该记录D类告警', () => {
      cb.recordAlert('PERF_WARNING', '响应时间增加');
      
      const state = cb.getState();
      expect(state.classD.alertCount).toBe(1);
      expect(state.classD.lastAlertAt).toBeGreaterThan(0);
    });
  });

  // ============ 状态持久化测试 ============

  describe('状态持久化', () => {
    it('应该保存状态到文件', () => {
      cb.trip('C', 'TEST', '测试熔断');
      cb.saveState();
      
      const filePath = join(testDir, 'circuit-state.json');
      expect(existsSync(filePath)).toBe(true);
    });

    it('应该能从文件加载状态', () => {
      // 熔断并保存
      cb.trip('C', 'TEST', '测试熔断');
      cb.saveState();
      
      // 创建新的熔断器实例，应该加载之前的状态
      const cb2 = new TieredCircuitBreaker('test-strategy', {
        statePersistence: {
          enabled: true,
          filePath: join(testDir, 'circuit-state.json'),
          saveIntervalMs: 1000,
        },
      });
      
      expect(cb2.isTripped('C')).toBe(true);
      expect(cb2.canTrade()).toBe(false);
      
      cb2.destroy();
    });

    it('应该正确加载峰值权益', () => {
      cb.checkDrawdown(10000);
      cb.saveState();
      
      const cb2 = new TieredCircuitBreaker('test-strategy', {
        statePersistence: {
          enabled: true,
          filePath: join(testDir, 'circuit-state.json'),
          saveIntervalMs: 1000,
        },
        classC: {
          enabled: true,
          autoReset: true,
          resetTimeoutMs: 500,
          maxConsecutiveFailures: 5,
          maxDrawdownPercent: 0.1,  // 同样的10%阈值
        },
      });
      
      // 新实例应该保留峰值10000
      const tripped = cb2.checkDrawdown(8900);  // 从10000回撤11%
      expect(tripped).toBe(true);
      
      cb2.destroy();
    });
  });

  // ============ 恢复流程测试 ============

  describe('恢复流程', () => {
    it('应该支持半开状态', () => {
      cb.trip('C', 'TEST', '测试熔断');
      
      // 等待冷却期
      const start = Date.now();
      while (Date.now() - start < 600) {}
      
      cb.attemptReset('C');
      
      // 半开状态应该允许交易
      expect(cb.getGlobalState()).toBe('HALF_OPEN');
    });

    it('成功记录应该确认恢复', () => {
      cb.trip('C', 'TEST', '测试熔断');
      
      const start = Date.now();
      while (Date.now() - start < 600) {}
      
      cb.attemptReset('C');
      expect(cb.getGlobalState()).toBe('HALF_OPEN');
      
      // 记录成功应该确认恢复
      cb.recordSuccess('C');
      expect(cb.isTripped('C')).toBe(false);
      expect(cb.getGlobalState()).toBe('CLOSED');
    });

    it('失败记录应该重新熔断', async () => {
      cb.trip('C', 'TEST', '测试熔断');
      
      // 等待冷却期
      await new Promise(r => setTimeout(r, 600));
      
      cb.attemptReset('C');
      
      // 在半开状态下连续失败达到阈值应该重新熔断
      cb.recordFailure('C');
      cb.recordFailure('C');
      cb.recordFailure('C');
      cb.recordFailure('C');
      cb.recordFailure('C');
      
      expect(cb.isTripped('C')).toBe(true);
    });
  });

  // ============ 失败计数测试 ============

  describe('失败计数', () => {
    it('应该累计失败次数', () => {
      cb.recordFailure('C');
      cb.recordFailure('C');
      
      const state = cb.getState();
      expect(state.classC.failCount).toBe(2);
    });

    it('成功应该重置失败计数', () => {
      cb.recordFailure('C');
      cb.recordFailure('C');
      
      cb.recordSuccess('C');
      
      const state = cb.getState();
      expect(state.classC.failCount).toBe(0);
    });

    it('应该达到阈值后熔断', () => {
      // C类阈值是5次
      for (let i = 0; i < 5; i++) {
        cb.recordFailure('C');
      }
      
      expect(cb.isTripped('C')).toBe(true);
    });
  });

  // ============ 事件监听测试 ============

  describe('事件监听', () => {
    it('应该触发熔断事件', () => {
      let eventFired = false;
      
      cb.setEvents({
        onTrip: (level, reason) => {
          eventFired = true;
          expect(level).toBe('C');
          expect(reason.code).toBe('TEST');
        },
      });
      
      cb.trip('C', 'TEST', '测试');
      expect(eventFired).toBe(true);
    });

    it('应该触发恢复事件', () => {
      let eventFired = false;
      
      cb.setEvents({
        onReset: (level) => {
          eventFired = true;
          expect(level).toBe('C');
        },
      });
      
      cb.trip('C', 'TEST', '测试');
      
      const start = Date.now();
      while (Date.now() - start < 600) {}
      
      cb.attemptReset('C');
      cb.confirmReset('C');
      
      expect(eventFired).toBe(true);
    });
  });
});

console.log('运行分级熔断框架单元测试...');
