/**
 * strategy-health.test.ts - 策略健康状态机测试套件
 *
 * 测试覆盖:
 * - 状态转换测试
 * - 健康指标评估
 * - 自动恢复逻辑
 * - 告警触发
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  StrategyHealthStateMachine,
  StrategyHealthState,
  createStrategyHealthStateMachine,
} from './strategy-health';

describe('StrategyHealthStateMachine', () => {
  const defaultConfig = {
    strategyId: 'test-strategy',
    sessionId: 'test-session',
    thresholds: {
      maxErrorRate: 0.1,
      maxLatency: 1000,
      heartbeatTimeout: 30000,
      maxConsecutiveErrors: 3,
      maxConsecutiveSlowResponses: 3,
      degradedRecoveryThreshold: {
        maxErrorRate: 0.05,
        maxLatency: 500,
        minHealthyDuration: 10000,
      },
    },
    autoRecovery: true,
    maxRecoveryAttempts: 3,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==================== 单元测试: 初始化 ====================

  describe('初始化', () => {
    it('应该以INIT状态初始化', () => {
      const health = createStrategyHealthStateMachine(defaultConfig);
      expect(health.getState()).toBe(StrategyHealthState.INIT);
    });

    it('应该有默认健康指标', () => {
      const health = createStrategyHealthStateMachine(defaultConfig);
      const metrics = health.getMetrics();

      expect(metrics.errorRate).toBe(0);
      expect(metrics.avgLatency).toBe(0);
      expect(metrics.connectionStatus).toBe('disconnected');
    });
  });

  // ==================== 单元测试: 状态转换 ====================

  describe('状态转换', () => {
    it('start()应该进入PREFLIGHT状态', () => {
      const health = createStrategyHealthStateMachine(defaultConfig);
      health.start();

      expect(health.getState()).toBe(StrategyHealthState.PREFLIGHT);
      health.stop();
    });

    it('连接成功后应该从PREFLIGHT进入RUNNING', () => {
      const health = createStrategyHealthStateMachine(defaultConfig);
      health.start();

      health.updateMetrics({ connectionStatus: 'connected' });

      expect(health.getState()).toBe(StrategyHealthState.RUNNING);
      health.stop();
    });

    it('连续错误应该从RUNNING进入DEGRADED', () => {
      const health = createStrategyHealthStateMachine(defaultConfig);
      health.start();
      health.updateMetrics({ connectionStatus: 'connected' });

      // 记录3次连续错误
      health.recordError();
      health.recordError();
      health.recordError();

      expect(health.getState()).toBe(StrategyHealthState.DEGRADED);
      health.stop();
    });

    it('stop()应该进入STOPPED状态', () => {
      const health = createStrategyHealthStateMachine(defaultConfig);
      health.start();
      health.stop();

      expect(health.getState()).toBe(StrategyHealthState.STOPPED);
    });

    it('严重错误应该进入ERROR状态', () => {
      const health = createStrategyHealthStateMachine(defaultConfig);
      health.start();
      health.updateMetrics({ connectionStatus: 'connected' });

      // 记录6次连续错误 (3*2)
      for (let i = 0; i < 6; i++) {
        health.recordError();
      }

      expect(health.getState()).toBe(StrategyHealthState.ERROR);
      health.stop();
    });
  });

  // ==================== 单元测试: 健康指标 ====================

  describe('健康指标', () => {
    it('记录心跳应该重置连续错误', () => {
      const health = createStrategyHealthStateMachine(defaultConfig);
      health.start();

      health.recordError();
      health.recordError();
      expect(health.getMetrics().consecutiveErrors).toBe(2);

      health.recordHeartbeat();
      expect(health.getMetrics().consecutiveErrors).toBe(0);

      health.stop();
    });

    it('慢响应应该增加连续慢响应计数', () => {
      const health = createStrategyHealthStateMachine(defaultConfig);
      health.start();

      health.recordLatency(500); // 正常
      expect(health.getMetrics().consecutiveSlowResponses).toBe(0);

      health.recordLatency(1500); // 超过1000ms阈值
      expect(health.getMetrics().consecutiveSlowResponses).toBe(1);

      health.stop();
    });

    it('正常响应应该重置连续慢响应', () => {
      const health = createStrategyHealthStateMachine(defaultConfig);
      health.start();

      health.recordLatency(1500);
      health.recordLatency(1500);
      expect(health.getMetrics().consecutiveSlowResponses).toBe(2);

      health.recordLatency(500); // 正常
      expect(health.getMetrics().consecutiveSlowResponses).toBe(0);

      health.stop();
    });

    it('更新指标应该正确合并', () => {
      const health = createStrategyHealthStateMachine(defaultConfig);

      health.updateMetrics({ errorRate: 0.05 });
      expect(health.getMetrics().errorRate).toBe(0.05);

      health.updateMetrics({ avgLatency: 100 });
      expect(health.getMetrics().avgLatency).toBe(100);
      expect(health.getMetrics().errorRate).toBe(0.05); // 保持不变
    });
  });

  // ==================== 单元测试: 健康检查 ====================

  describe('健康检查', () => {
    it('健康状态应该返回healthy=true', () => {
      const health = createStrategyHealthStateMachine(defaultConfig);
      health.start();
      health.updateMetrics({ connectionStatus: 'connected' });

      const result = health.performHealthCheck();

      expect(result.healthy).toBe(true);
      expect(result.state).toBe(StrategyHealthState.RUNNING);

      health.stop();
    });

    it('心跳超时应该返回healthy=false', async () => {
      const health = createStrategyHealthStateMachine(defaultConfig);
      health.start();

      // 设置心跳超时
      health.updateMetrics({
        lastHeartbeat: Date.now() - 60000, // 60秒前
        connectionStatus: 'connected',
      });

      const result = health.performHealthCheck();

      // 只要检测到心跳超时问题即可
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.healthy).toBe(false);

      health.stop();
    });

    it('高错误率应该返回healthy=false', async () => {
      const health = createStrategyHealthStateMachine(defaultConfig);
      health.start();
      
      health.updateMetrics({ 
        connectionStatus: 'connected',
        errorRate: 0.15 // 超过0.1阈值
      });
      
      const result = health.performHealthCheck();
      
      // 检测到错误率问题
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.healthy).toBe(false);
      
      health.stop();
    });

    it('应该提供恢复建议', () => {
      const health = createStrategyHealthStateMachine(defaultConfig);
      health.start();
      health.updateMetrics({
        connectionStatus: 'connected',
        errorRate: 0.15
      });

      const result = health.performHealthCheck();

      expect(result.recommendations.length).toBeGreaterThan(0);

      health.stop();
    });
  });

  // ==================== 单元测试: 自动恢复 ====================

  describe('自动恢复', () => {
    it('满足恢复条件应该从DEGRADED恢复', async () => {
      const health = createStrategyHealthStateMachine({
        ...defaultConfig,
        thresholds: {
          ...defaultConfig.thresholds,
          degradedRecoveryThreshold: {
            maxErrorRate: 0.05,
            maxLatency: 500,
            minHealthyDuration: 50, // 缩短为50ms
          },
        },
      });
      health.start();
      health.updateMetrics({ connectionStatus: 'connected' });

      // 进入DEGRADED
      for (let i = 0; i < 3; i++) {
        health.recordError();
      }
      expect(health.getState()).toBe(StrategyHealthState.DEGRADED);

      // 等待满足恢复持续时间
      await new Promise(resolve => setTimeout(resolve, 100));

      // 恢复正常指标并触发心跳
      health.updateMetrics({
        errorRate: 0.01,
        avgLatency: 100,
      });
      health.recordHeartbeat();

      expect(health.getState()).toBe(StrategyHealthState.RUNNING);

      health.stop();
    });

    it('禁用自动恢复时不应该恢复', () => {
      const health = createStrategyHealthStateMachine({
        ...defaultConfig,
        autoRecovery: false,
      });
      health.start();
      health.updateMetrics({ connectionStatus: 'connected' });

      for (let i = 0; i < 3; i++) {
        health.recordError();
      }

      health.recordHeartbeat();

      // 仍然保持DEGRADED
      expect(health.getState()).toBe(StrategyHealthState.DEGRADED);

      health.stop();
    });

    it('超过最大恢复次数应该进入ERROR', async () => {
      const health = createStrategyHealthStateMachine({
        ...defaultConfig,
        maxRecoveryAttempts: 1,
        thresholds: {
          ...defaultConfig.thresholds,
          degradedRecoveryThreshold: {
            maxErrorRate: 0.05,
            maxLatency: 500,
            minHealthyDuration: 50, // 缩短为50ms
          },
        },
      });
      health.start();
      health.updateMetrics({ connectionStatus: 'connected' });

      // 第一次降级
      for (let i = 0; i < 3; i++) health.recordError();
      expect(health.getState()).toBe(StrategyHealthState.DEGRADED);

      // 等待并恢复
      await new Promise(resolve => setTimeout(resolve, 100));
      health.updateMetrics({ errorRate: 0.01 });
      health.recordHeartbeat();
      expect(health.getState()).toBe(StrategyHealthState.RUNNING);

      // 第二次降级
      for (let i = 0; i < 3; i++) health.recordError();
      expect(health.getState()).toBe(StrategyHealthState.DEGRADED);

      // 尝试恢复但次数超限
      await new Promise(resolve => setTimeout(resolve, 100));
      health.recordHeartbeat();

      expect(health.getState()).toBe(StrategyHealthState.ERROR);

      health.stop();
    });
  });

  // ==================== 单元测试: 告警功能 ====================

  describe('告警功能', () => {
    it('状态变更应该触发告警回调', () => {
      const stateChangeCallback = vi.fn().mockResolvedValue(undefined);
      const health = createStrategyHealthStateMachine({
        ...defaultConfig,
        alertConfig: {
          enabled: true,
          onStateChange: stateChangeCallback,
        },
      });

      health.start();
      expect(stateChangeCallback).toHaveBeenCalledWith(
        StrategyHealthState.INIT,
        StrategyHealthState.PREFLIGHT,
        expect.any(String)
      );

      health.stop();
    });

    it('降级应该触发降级告警', () => {
      const degradedCallback = vi.fn().mockResolvedValue(undefined);
      const health = createStrategyHealthStateMachine({
        ...defaultConfig,
        alertConfig: {
          enabled: true,
          onDegraded: degradedCallback,
        },
      });

      health.start();
      health.updateMetrics({ connectionStatus: 'connected' });

      for (let i = 0; i < 3; i++) {
        health.recordError();
      }

      expect(degradedCallback).toHaveBeenCalled();

      health.stop();
    });

    it('禁用告警时不应该触发', () => {
      const stateChangeCallback = vi.fn().mockResolvedValue(undefined);
      const health = createStrategyHealthStateMachine({
        ...defaultConfig,
        alertConfig: {
          enabled: false,
          onStateChange: stateChangeCallback,
        },
      });

      health.start();

      expect(stateChangeCallback).not.toHaveBeenCalled();

      health.stop();
    });
  });

  // ==================== 单元测试: 事件监听 ====================

  describe('事件监听', () => {
    it('应该触发started事件', () => {
      const handler = vi.fn();
      const health = createStrategyHealthStateMachine(defaultConfig);

      health.on('health:started', handler);
      health.start();

      expect(handler).toHaveBeenCalled();

      health.stop();
    });

    it('应该触发stopped事件', () => {
      const handler = vi.fn();
      const health = createStrategyHealthStateMachine(defaultConfig);

      health.start();
      health.on('health:stopped', handler);
      health.stop();

      expect(handler).toHaveBeenCalled();
    });

    it('应该触发state:changed事件', () => {
      const handler = vi.fn();
      const health = createStrategyHealthStateMachine(defaultConfig);

      health.on('state:changed', handler);
      health.start();

      expect(handler).toHaveBeenCalled();

      health.stop();
    });

    it('应该触发特定状态事件', () => {
      const runningHandler = vi.fn();
      const health = createStrategyHealthStateMachine(defaultConfig);

      health.on('state:running', runningHandler);
      health.start();
      health.updateMetrics({ connectionStatus: 'connected' });

      expect(runningHandler).toHaveBeenCalled();

      health.stop();
    });
  });

  // ==================== 单元测试: 报告生成 ====================

  describe('报告生成', () => {
    it('应该生成健康报告', () => {
      const health = createStrategyHealthStateMachine(defaultConfig);
      health.start();

      const report = health.generateReport();

      expect(report).toContain('策略健康状态报告');
      expect(report).toContain('test-strategy');
      expect(report).toContain('PREFLIGHT');

      health.stop();
    });

    it('报告应该包含状态转换历史', () => {
      const health = createStrategyHealthStateMachine(defaultConfig);
      health.start();
      health.updateMetrics({ connectionStatus: 'connected' });
      health.stop();

      const report = health.generateReport();

      expect(report).toContain('状态转换历史');
    });
  });

  // ==================== 单元测试: 状态转换历史 ====================

  describe('状态转换历史', () => {
    it('应该记录所有状态转换', () => {
      const health = createStrategyHealthStateMachine(defaultConfig);

      health.start();
      health.updateMetrics({ connectionStatus: 'connected' });
      health.stop();

      const transitions = health.getTransitions();
      expect(transitions.length).toBeGreaterThanOrEqual(2);
      expect(transitions[0].from).toBe(StrategyHealthState.INIT);
      expect(transitions[0].to).toBe(StrategyHealthState.PREFLIGHT);
    });
  });

  // ==================== 边界条件测试 ====================

  describe('边界条件', () => {
    it('重复start不应该创建多个定时器', () => {
      const health = createStrategyHealthStateMachine(defaultConfig);

      health.start();
      health.start(); // 重复调用

      // 应该只创建一个定时器，不会报错
      expect(health.getState()).toBe(StrategyHealthState.PREFLIGHT);

      health.stop();
    });

    it('未start就stop不应该报错', () => {
      const health = createStrategyHealthStateMachine(defaultConfig);

      expect(() => health.stop()).not.toThrow();
    });

    it('状态相同不应该重复触发事件', () => {
      const handler = vi.fn();
      const health = createStrategyHealthStateMachine(defaultConfig);

      health.on('state:changed', handler);
      health.start();
      health.start(); // 重复，状态不变

      // 应该只触发一次
      const callCount = handler.mock.calls.filter(
        call => call[0].to === StrategyHealthState.PREFLIGHT
      ).length;
      expect(callCount).toBe(1);

      health.stop();
    });
  });

  // ==================== 性能测试 ====================

  describe('性能测试', () => {
    it('1000次状态检查应该在100ms内完成', () => {
      const health = createStrategyHealthStateMachine(defaultConfig);
      health.start();

      const start = Date.now();
      for (let i = 0; i < 1000; i++) {
        health.performHealthCheck();
      }
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(100);

      health.stop();
    });
  });

  // ==================== 场景测试 ====================

  describe('完整场景测试', () => {
    it('正常启动-运行-停止流程', () => {
      const health = createStrategyHealthStateMachine(defaultConfig);
      const stateHistory: string[] = [];

      health.on('state:changed', (transition) => {
        stateHistory.push(`${transition.from}→${transition.to}`);
      });

      // 启动
      health.start();
      expect(health.getState()).toBe(StrategyHealthState.PREFLIGHT);

      // 连接成功
      health.updateMetrics({ connectionStatus: 'connected' });
      expect(health.getState()).toBe(StrategyHealthState.RUNNING);

      // 运行中记录心跳
      health.recordHeartbeat();
      expect(health.getMetrics().consecutiveErrors).toBe(0);

      // 停止
      health.stop();
      expect(health.getState()).toBe(StrategyHealthState.STOPPED);

      // 验证状态历史
      expect(stateHistory).toContain('INIT→PREFLIGHT');
      expect(stateHistory).toContain('PREFLIGHT→RUNNING');
      expect(stateHistory).toContain('RUNNING→STOPPED');
    });

    it('启动-异常-降级-恢复流程', async () => {
      const health = createStrategyHealthStateMachine(defaultConfig);

      health.start();
      health.updateMetrics({ connectionStatus: 'connected' });
      expect(health.getState()).toBe(StrategyHealthState.RUNNING);

      // 模拟异常
      for (let i = 0; i < 3; i++) {
        health.recordError();
      }
      expect(health.getState()).toBe(StrategyHealthState.DEGRADED);

      // 模拟恢复
      await new Promise(resolve => setTimeout(resolve, 100));
      health.updateMetrics({
        errorRate: 0.01,
      });
      health.recordHeartbeat();

      expect(health.getState()).toBe(StrategyHealthState.RUNNING);

      health.stop();
    });
  });
});
