/**
 * position-risk-manager.test.ts - 风险管理集成测试
 * 
 * 测试 LeverageLimiter + PositionReducer 的协同工作
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PositionRiskManager,
  createPositionRiskManager,
  ReducePositionState,
} from './position-risk-manager';

describe('PositionRiskManager 集成测试', () => {
  let manager: PositionRiskManager;
  
  const defaultConfig = {
    symbol: 'BTCUSDT',
    maxLeverage: 5.0,
    maxPositionValue: 100000,
    maxMarginUsage: 80,
    warningLeverage: 3.0,
    reduceLeverage: 3.5,
    targetLeverage: 2.5,
    maxReduceRatio: 0.3,
    reduceCooldownMs: 1000,
  };

  beforeEach(() => {
    manager = createPositionRiskManager(defaultConfig);
  });

  // ==================== 订单检查测试 ====================

  describe('订单风险检查', () => {
    it('安全订单应该被允许', () => {
      const result = manager.checkOrder(0.1, 50000, 10000);
      
      expect(result.allowed).toBe(true);
      expect(result.riskLevel).toBe('SAFE');
    });

    it('杠杆超限订单应该被拒绝', () => {
      // 2 BTC @ 50000 = 100000 USDT，保证金 10000 → 10x 杠杆
      const result = manager.checkOrder(2, 50000, 10000);
      
      expect(result.allowed).toBe(false);
      expect(result.riskLevel).toBe('HARD_LIMIT');
    });

    it('持仓价值超限应该被拒绝', () => {
      // 3 BTC @ 50000 = 150000 USDT > 100000 限制
      const result = manager.checkOrder(3, 50000, 50000);
      
      expect(result.allowed).toBe(false);
      expect(result.riskLevel).toBe('HARD_LIMIT');
    });
  });

  // ==================== 持仓更新与状态流转 ====================

  describe('持仓更新与自动降仓', () => {
    it('正常持仓更新不产生降仓', async () => {
      const result = await manager.updatePosition({
        size: 0.5,
        entryPrice: 50000,
        markPrice: 50000,
        side: 'LONG',
        availableMargin: 10000,
      });

      expect(result.riskCheck.allowed).toBe(true);
      expect(result.reduceInitiated).toBe(false);
      expect(result.riskCheck.riskMetrics.reducerState).toBe(ReducePositionState.IDLE);
    });

    it('杠杆超过3.0进入WARNING状态', async () => {
      // 持仓价值 75000，保证金 15000 → 5x 杠杆
      const result = await manager.updatePosition({
        size: 1.5,
        entryPrice: 50000,
        markPrice: 50000,
        side: 'LONG',
        availableMargin: 15000,
      });

      expect(result.riskCheck.riskLevel).toBe('WARNING');
      expect(result.riskCheck.riskMetrics.reducerState).toBe(ReducePositionState.WARNING);
      expect(result.reduceInitiated).toBe(false);
    });

    it('杠杆超过3.5触发自动降仓', async () => {
      const mockReduceExecutor = vi.fn().mockResolvedValue(true);
      manager.onReduce(mockReduceExecutor);

      // 持仓价值 87500，保证金 17500 → 5x 杠杆 (但在maxLeverage范围内)
      // 实际上我们需要调整参数使得杠杆在3.5-5之间
      // 持仓价值 70000，保证金 10000 → 7x 杠杆 > maxLeverage，会被硬顶拦截
      // 让我们用 0.7 BTC @ 50000 = 35000，保证金 10000 → 3.5x
      
      // 先进入 WARNING
      await manager.updatePosition({
        size: 0.65,
        entryPrice: 50000,
        markPrice: 50000,
        side: 'LONG',
        availableMargin: 10000,
      });

      // 再进入 REDUCE (3.7x 杠杆)
      const result = await manager.updatePosition({
        size: 0.74,
        entryPrice: 50000,
        markPrice: 50000,
        side: 'LONG',
        availableMargin: 10000,
      });

      expect(result.riskCheck.riskLevel).toBe('CRITICAL');
      expect(result.riskCheck.riskMetrics.reducerState).toBe(ReducePositionState.REDUCE);
      expect(result.reduceInitiated).toBe(true);
      expect(mockReduceExecutor).toHaveBeenCalledWith(
        expect.objectContaining({
          reduceQty: expect.any(Number),
          expectedLeverageAfter: expect.any(Number),
        })
      );
    });
  });

  // ==================== 降仓执行回调测试 ====================

  describe('降仓执行回调', () => {
    it('应该调用注册的降仓回调', async () => {
      const mockExecutor = vi.fn().mockResolvedValue(true);
      manager.onReduce(mockExecutor);

      // 进入 WARNING 状态 (0.7 BTC → 3.5x 杠杆)
      await manager.updatePosition({
        size: 0.7,
        entryPrice: 50000,
        markPrice: 50000,
        side: 'LONG',
        availableMargin: 10000,
      });

      // 进入 REDUCE 状态 (0.8 BTC → 4.0x 杠杆 > 3.5)
      await manager.updatePosition({
        size: 0.8,
        entryPrice: 50000,
        markPrice: 50000,
        side: 'LONG',
        availableMargin: 10000,
      });

      expect(mockExecutor).toHaveBeenCalled();
    });

    it('降仓回调失败应该正确处理', async () => {
      const mockExecutor = vi.fn().mockRejectedValue(new Error('Network error'));
      manager.onReduce(mockExecutor);

      // 进入 REDUCE 状态
      await manager.updatePosition({
        size: 0.6,
        entryPrice: 50000,
        markPrice: 50000,
        side: 'LONG',
        availableMargin: 10000,
      });
      
      const result = await manager.updatePosition({
        size: 0.8,
        entryPrice: 50000,
        markPrice: 50000,
        side: 'LONG',
        availableMargin: 10000,
      });

      // 即使有错误，也应该正常返回
      expect(result).toBeDefined();
    });
  });

  // ==================== 状态查询测试 ====================

  describe('状态查询', () => {
    it('应该返回正确的状态信息', async () => {
      await manager.updatePosition({
        size: 1.0,
        entryPrice: 50000,
        markPrice: 50000,
        side: 'LONG',
        availableMargin: 15000,
      });

      const status = manager.getStatus();

      expect(status.symbol).toBe('BTCUSDT');
      expect(status.reducerState).toBeDefined();
      expect(status.position).toBeDefined();
      expect(status.audit).toBeDefined();
    });

    it('应该返回状态机可视化图', () => {
      const diagram = manager.getStateDiagram();
      
      expect(diagram).toContain('IDLE');
      expect(diagram).toContain('WARNING');
      expect(diagram).toContain('REDUCE');
      expect(diagram).toContain('RECOVERY');
    });
  });

  // ==================== 强制降仓测试 ====================

  describe('强制降仓', () => {
    it('forceReduce 应该立即触发降仓', async () => {
      await manager.updatePosition({
        size: 1.0,
        entryPrice: 50000,
        markPrice: 50000,
        side: 'LONG',
        availableMargin: 10000,
      });

      const action = manager.forceReduce('紧急风控测试');

      expect(action).toBeDefined();
      expect(action!.reason).toContain('紧急风控');
    });
  });

  // ==================== 完整流程测试 ====================

  describe('完整风控流程', () => {
    it('全流程: 开单 → 预警 → 降仓 → 恢复', async () => {
      const executions: string[] = [];
      manager.onReduce(async (action) => {
        executions.push(`REDUCE:${action.reduceQty}`);
        // 模拟执行成功
        manager.confirmReduce(action.actionId, {
          executed: true,
          executionPrice: 50000,
          txHash: '0x123abc',
        });
        return true;
      });

      // Step 1: 开仓 - SAFE
      let result = await manager.updatePosition({
        size: 0.3,
        entryPrice: 50000,
        markPrice: 50000,
        side: 'LONG',
        availableMargin: 10000,
      });
      expect(result.riskCheck.riskLevel).toBe('SAFE');

      // Step 2: 加仓到 WARNING
      result = await manager.updatePosition({
        size: 0.7,
        entryPrice: 50000,
        markPrice: 50000,
        side: 'LONG',
        availableMargin: 10000,
      });
      expect(result.riskCheck.riskLevel).toBe('WARNING');

      // Step 3: 继续加仓到 REDUCE
      result = await manager.updatePosition({
        size: 0.9,
        entryPrice: 50000,
        markPrice: 50000,
        side: 'LONG',
        availableMargin: 10000,
      });
      expect(result.riskCheck.riskLevel).toBe('CRITICAL');
      expect(result.reduceInitiated).toBe(true);

      // 等待降仓确认
      await new Promise(resolve => setTimeout(resolve, 10));

      // Step 4: 降仓后应该进入 RECOVERY
      const status = manager.getStatus();
      expect(status.reducerState).toBe(ReducePositionState.RECOVERY);

      // 验证执行记录
      expect(executions).toHaveLength(1);
      expect(executions[0]).toMatch(/^REDUCE:/);
    });
  });
});
