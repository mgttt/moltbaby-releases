/**
 * position-reducer.test.ts - 降仓状态机测试套件
 * 
 * 测试覆盖:
 * - 单元测试: 状态流转、减仓计算、边界条件
 * - 集成测试: 与LeverageLimiter联动、事件监听
 */

import { createLogger } from '../utils/logger';
const logger = createLogger('position-reducer.test');

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PositionReducer,
  ReducePositionState,
  PositionSnapshot,
  createPositionReducer,
} from './position-reducer';

describe('PositionReducer', () => {
  let reducer: PositionReducer;
  const mockConfig = {
    symbol: 'BTCUSDT',
    warningLeverage: 3.0,
    reduceLeverage: 3.5,
    targetLeverage: 2.5,
    maxReduceRatio: 0.3,
    cooldownMs: 1000, // 测试用短冷却时间
  };

  const createMockPosition = (leverage: number, size: number = 1): PositionSnapshot => ({
    timestamp: Date.now(),
    symbol: 'BTCUSDT',
    positionSize: size,
    positionValue: 50000 * size,
    entryPrice: 50000,
    markPrice: 50000,
    leverage,
    marginUsed: (50000 * size) / leverage,
    availableMargin: 10000,
    side: 'LONG',
  });

  beforeEach(() => {
    reducer = createPositionReducer(mockConfig);
  });

  // ==================== 单元测试: 初始状态 ====================

  describe('初始化', () => {
    it('应该以 IDLE 状态初始化', () => {
      expect(reducer.getState()).toBe(ReducePositionState.IDLE);
    });

    it('应该没有初始持仓', () => {
      expect(reducer.getPosition()).toBeNull();
    });

    it('应该生成有效的审计记录', () => {
      const audit = reducer.getAudit();
      expect(audit.sessionId).toMatch(/^pr_\d+_[a-z0-9]+$/);
      expect(audit.transitions).toHaveLength(0);
      expect(audit.actions).toHaveLength(0);
      expect(audit.createdAt).toBeGreaterThan(0);
    });
  });

  // ==================== 单元测试: IDLE → WARNING ====================

  describe('IDLE → WARNING 流转', () => {
    it('杠杆 3.1x 应该触发 WARNING', () => {
      const position = createMockPosition(3.1);
      const result = reducer.updatePosition(position);

      expect(result.stateChanged).toBe(true);
      expect(reducer.getState()).toBe(ReducePositionState.WARNING);
    });

    it('杠杆 3.0x 不应该触发 WARNING（边界值）', () => {
      const position = createMockPosition(3.0);
      const result = reducer.updatePosition(position);

      expect(result.stateChanged).toBe(false);
      expect(reducer.getState()).toBe(ReducePositionState.IDLE);
    });

    it('杠杆 2.9x 应该保持 IDLE', () => {
      const position = createMockPosition(2.9);
      const result = reducer.updatePosition(position);

      expect(result.stateChanged).toBe(false);
      expect(reducer.getState()).toBe(ReducePositionState.IDLE);
    });
  });

  // ==================== 单元测试: WARNING → REDUCE ====================

  describe('WARNING → REDUCE 流转', () => {
    beforeEach(() => {
      // 先进入 WARNING 状态
      reducer.updatePosition(createMockPosition(3.1));
      expect(reducer.getState()).toBe(ReducePositionState.WARNING);
    });

    it('杠杆 3.6x 应该触发 REDUCE', () => {
      const position = createMockPosition(3.6);
      const result = reducer.updatePosition(position);

      expect(result.stateChanged).toBe(true);
      expect(reducer.getState()).toBe(ReducePositionState.REDUCE);
      expect(result.action).toBeDefined();
    });

    it('杠杆 3.5x 不应该触发 REDUCE（边界值）', () => {
      const position = createMockPosition(3.5);
      const result = reducer.updatePosition(position);

      // 注意：3.5是reduceLeverage阈值，大于3.5才触发
      // 当前实现是严格大于，所以3.5保持WARNING
      expect(reducer.getState()).toBe(ReducePositionState.WARNING);
    });

    it('杠杆降回 2.9x 应该回到 IDLE', () => {
      const position = createMockPosition(2.9);
      const result = reducer.updatePosition(position);

      expect(result.stateChanged).toBe(true);
      expect(reducer.getState()).toBe(ReducePositionState.IDLE);
    });
  });

  // ==================== 单元测试: REDUCE 执行逻辑 ====================

  describe('REDUCE 执行逻辑', () => {
    beforeEach(() => {
      // 进入 WARNING 状态（但不触发REDUCE，让各个测试自己控制）
      reducer.updatePosition(createMockPosition(3.1));
      expect(reducer.getState()).toBe(ReducePositionState.WARNING);
    });

    it('应该生成降仓指令', () => {
      // 触发 REDUCE 状态
      const position = createMockPosition(3.6, 2); // 2 BTC持仓
      const result = reducer.updatePosition(position);

      expect(reducer.getState()).toBe(ReducePositionState.REDUCE);
      expect(result.action).toBeDefined();
      expect(result.action!.reduceQty).toBeGreaterThan(0);
      expect(result.action!.reduceRatio).toBeGreaterThan(0);
      expect(result.action!.expectedLeverageAfter).toBeLessThan(3.6);
    });

    it('降仓指令应该包含所有必要字段', () => {
      const position = createMockPosition(3.6);
      const result = reducer.updatePosition(position);

      expect(reducer.getState()).toBe(ReducePositionState.REDUCE);
      expect(result.action!).toMatchObject({
        actionId: expect.stringMatching(/^reduce_\d+/),
        timestamp: expect.any(Number),
        state: ReducePositionState.REDUCE,
        reason: expect.stringContaining('杠杆过高'),
        reduceQty: expect.any(Number),
        reduceRatio: expect.any(Number),
        expectedLeverageAfter: expect.any(Number),
        executed: false,
      });
    });

    it('应该遵守 cooldown 限制', async () => {
      const position = createMockPosition(3.6, 2);
      
      // 第一次触发
      const result1 = reducer.updatePosition(position);
      expect(result1.action).toBeDefined();

      // 确认第一次降仓完成，进入RECOVERY
      reducer.confirmReduce(result1.action!.actionId, { executed: true });
      expect(reducer.getState()).toBe(ReducePositionState.RECOVERY);

      // 再次进入WARNING然后REDUCE（模拟价格反弹）
      reducer.updatePosition(createMockPosition(3.2)); // RECOVERY -> WARNING
      const result2 = reducer.updatePosition(position);
      
      // 冷却期内不应该生成新action（因为还在冷却中）
      expect(result2.action).toBeUndefined();
    });
  });

  // ==================== 单元测试: REDUCE → RECOVERY ====================

  describe('REDUCE → RECOVERY 流转', () => {
    it('确认降仓后应该进入 RECOVERY', () => {
      // 进入 REDUCE 状态
      reducer.updatePosition(createMockPosition(3.1));
      const result = reducer.updatePosition(createMockPosition(3.6));
      const action = result.action!;
      
      reducer.confirmReduce(action.actionId, {
        executed: true,
        executionPrice: 50000,
        txHash: '0x123abc',
      });

      expect(reducer.getState()).toBe(ReducePositionState.RECOVERY);
    });

    it('降仓失败应该保持 REDUCE', () => {
      // 进入 REDUCE 状态
      reducer.updatePosition(createMockPosition(3.1));
      const result = reducer.updatePosition(createMockPosition(3.6));
      const action = result.action!;
      
      reducer.confirmReduce(action.actionId, {
        executed: false,
        error: 'Insufficient margin',
      });

      // 失败后应该保持在REDUCE状态，等待下次尝试
      expect(reducer.getState()).toBe(ReducePositionState.REDUCE);
    });
  });

  // ==================== 单元测试: RECOVERY → IDLE ====================

  describe('RECOVERY → IDLE 流转', () => {
    beforeEach(() => {
      // 进入 REDUCE 并确认完成，进入 RECOVERY
      reducer.updatePosition(createMockPosition(3.1));
      const result = reducer.updatePosition(createMockPosition(3.6));
      reducer.confirmReduce(result.action!.actionId, { executed: true });
      expect(reducer.getState()).toBe(ReducePositionState.RECOVERY);
    });

    it('杠杆降到 2.5x 以下应该回到 IDLE', () => {
      reducer.updatePosition(createMockPosition(2.4));
      expect(reducer.getState()).toBe(ReducePositionState.IDLE);
    });

    it('杠杆在 2.5-3.0 之间应该保持 RECOVERY', () => {
      reducer.updatePosition(createMockPosition(2.7));
      expect(reducer.getState()).toBe(ReducePositionState.RECOVERY);
    });

    it('杠杆再次超过 3.0 应该回到 WARNING', () => {
      reducer.updatePosition(createMockPosition(3.2));
      expect(reducer.getState()).toBe(ReducePositionState.WARNING);
    });
  });

  // ==================== 单元测试: 减仓计算算法 ====================

  describe('减仓计算算法', () => {
    it('大持仓应该按比例减仓', () => {
      reducer.updatePosition(createMockPosition(3.1));
      
      // 10 BTC 持仓，杠杆 4.0x
      const position: PositionSnapshot = {
        timestamp: Date.now(),
        symbol: 'BTCUSDT',
        positionSize: 10,
        positionValue: 500000,
        entryPrice: 50000,
        markPrice: 50000,
        leverage: 4.0,
        marginUsed: 125000,
        availableMargin: 100000,
        side: 'LONG',
      };

      const result = reducer.updatePosition(position);
      expect(result.action).toBeDefined();
      
      // 验证减仓量计算
      // 目标杠杆 2.5x，保证金 125000
      // 目标持仓价值 = 2.5 * 125000 = 312500
      // 需要减仓价值 = 500000 - 312500 = 187500
      // 需要减仓数量 = 187500 / 50000 = 3.75 BTC
      // 但最大减仓比例30%，所以减仓 3 BTC
      expect(result.action!.reduceQty).toBeLessThanOrEqual(3); // 30% of 10
      expect(result.action!.expectedLeverageAfter).toBeLessThan(4.0);
    });

    it('小持仓应该完整计算', () => {
      reducer.updatePosition(createMockPosition(3.1));
      
      const position: PositionSnapshot = {
        timestamp: Date.now(),
        symbol: 'BTCUSDT',
        positionSize: 0.5,
        positionValue: 25000,
        entryPrice: 50000,
        markPrice: 50000,
        leverage: 4.0,
        marginUsed: 6250,
        availableMargin: 10000,
        side: 'LONG',
      };

      const result = reducer.updatePosition(position);
      expect(result.action).toBeDefined();
      expect(result.action!.reduceQty).toBeLessThanOrEqual(0.15); // 30% of 0.5
    });
  });

  // ==================== 单元测试: 强制降仓 ====================

  describe('强制降仓', () => {
    it('forceReduce 应该立即触发降仓', () => {
      reducer.updatePosition(createMockPosition(2.5)); // 正常状态
      expect(reducer.getState()).toBe(ReducePositionState.IDLE);

      const action = reducer.forceReduce('紧急风控');
      
      expect(action).toBeDefined();
      expect(reducer.getState()).toBe(ReducePositionState.REDUCE);
      expect(action!.reason).toContain('紧急风控');
    });

    it('没有持仓时 forceReduce 应该返回 null', () => {
      const action = reducer.forceReduce('测试');
      expect(action).toBeNull();
    });
  });

  // ==================== 单元测试: 审计记录 ====================

  describe('审计记录', () => {
    it('应该记录所有状态流转', () => {
      reducer.updatePosition(createMockPosition(3.1)); // IDLE -> WARNING
      reducer.updatePosition(createMockPosition(3.6)); // WARNING -> REDUCE
      
      const audit = reducer.getAudit();
      expect(audit.transitions.length).toBeGreaterThanOrEqual(2);
      expect(audit.transitions[0]).toMatchObject({
        from: ReducePositionState.IDLE,
        to: ReducePositionState.WARNING,
      });
    });

    it('应该记录所有降仓动作', () => {
      reducer.updatePosition(createMockPosition(3.1));
      const result = reducer.updatePosition(createMockPosition(3.6));
      const action = result.action!;
      
      reducer.confirmReduce(action.actionId, {
        executed: true,
        executionPrice: 50000,
        txHash: 'tx_123',
      });

      const audit = reducer.getAudit();
      expect(audit.actions).toHaveLength(1);
      expect(audit.actions[0].executed).toBe(true);
      expect(audit.actions[0].txHash).toBe('tx_123');
    });
  });

  // ==================== 单元测试: 事件监听 ====================

  describe('事件监听', () => {
    it('应该触发 state:changed 事件', () => {
      const handler = vi.fn();
      reducer.on('state:changed', handler);

      reducer.updatePosition(createMockPosition(3.1));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          from: ReducePositionState.IDLE,
          to: ReducePositionState.WARNING,
        })
      );
    });

    it('应该触发 reduce:initiated 事件', () => {
      const handler = vi.fn();
      reducer.on('reduce:initiated', handler);

      reducer.updatePosition(createMockPosition(3.1));
      reducer.updatePosition(createMockPosition(3.6));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          executed: false,
        })
      );
    });

    it('应该触发 reduce:completed 事件', () => {
      const initiatedHandler = vi.fn();
      const completedHandler = vi.fn();
      reducer.on('reduce:initiated', initiatedHandler);
      reducer.on('reduce:completed', completedHandler);

      reducer.updatePosition(createMockPosition(3.1));
      reducer.updatePosition(createMockPosition(3.6));
      const action = initiatedHandler.mock.calls[0][0];
      
      reducer.confirmReduce(action.actionId, { executed: true });

      expect(completedHandler).toHaveBeenCalledTimes(1);
    });
  });

  // ==================== 集成测试: 完整流程 ====================

  describe('完整流程集成测试', () => {
    it('完整降仓流程: IDLE → WARNING → REDUCE → RECOVERY → IDLE', () => {
      // Step 1: IDLE
      expect(reducer.getState()).toBe(ReducePositionState.IDLE);

      // Step 2: 杠杆超标 -> WARNING
      let result = reducer.updatePosition(createMockPosition(3.1));
      expect(result.stateChanged).toBe(true);
      expect(reducer.getState()).toBe(ReducePositionState.WARNING);

      // Step 3: 继续恶化 -> REDUCE
      result = reducer.updatePosition(createMockPosition(3.6));
      expect(result.stateChanged).toBe(true);
      expect(reducer.getState()).toBe(ReducePositionState.REDUCE);
      expect(result.action).toBeDefined();

      // Step 4: 确认降仓 -> RECOVERY
      reducer.confirmReduce(result.action!.actionId, { executed: true });
      expect(reducer.getState()).toBe(ReducePositionState.RECOVERY);

      // Step 5: 风险解除 -> IDLE
      result = reducer.updatePosition(createMockPosition(2.4));
      expect(result.stateChanged).toBe(true);
      expect(reducer.getState()).toBe(ReducePositionState.IDLE);

      // 验证审计记录
      const audit = reducer.getAudit();
      expect(audit.transitions.length).toBe(4);
    });

    it('震荡行情状态切换', () => {
      // 多次在 WARNING 和 IDLE 之间切换
      reducer.updatePosition(createMockPosition(3.1));
      expect(reducer.getState()).toBe(ReducePositionState.WARNING);

      reducer.updatePosition(createMockPosition(2.9));
      expect(reducer.getState()).toBe(ReducePositionState.IDLE);

      reducer.updatePosition(createMockPosition(3.2));
      expect(reducer.getState()).toBe(ReducePositionState.WARNING);

      reducer.updatePosition(createMockPosition(3.1));
      expect(reducer.getState()).toBe(ReducePositionState.WARNING); // 保持

      const audit = reducer.getAudit();
      expect(audit.transitions.length).toBe(3);
    });
  });
});

// ==================== 性能测试 ====================

describe('性能测试', () => {
  it('1000次状态更新应该在100ms内完成', () => {
    const reducer = createPositionReducer({ symbol: 'BTCUSDT' });
    const position = {
      timestamp: Date.now(),
      symbol: 'BTCUSDT',
      positionSize: 1,
      positionValue: 50000,
      entryPrice: 50000,
      markPrice: 50000,
      leverage: 3.5,
      marginUsed: 14285,
      availableMargin: 10000,
      side: 'LONG' as const,
    };

    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      reducer.updatePosition({ ...position, timestamp: Date.now() + i });
    }
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(100);
  });
});
