/**
 * OrderStateManager 单元测试 (T9)
 * 
 * 覆盖：
 * 1. 状态转换(New→Active→Filled/Cancelled)
 * 2. 超时检测
 * 3. stop()后clearInterval验证
 * 4. 异常回滚测试（超时/部分成交cancel/网络断连）
 * 5. Mock Exchange Adapter集成
 * 
 * 测试用例数：≥20个
 * 覆盖率目标：≥80%
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { OrderStateManager, OrderStateEnum, AbnormalOrderAlert } from '../src/engine/OrderStateManager';
import { MockExchangeAdapter, MockMode } from '../src/engine/__mocks__/mock-exchange-adapter';

describe('OrderStateManager', () => {
  let manager: OrderStateManager;
  let mockExchange: MockExchangeAdapter;

  beforeEach(() => {
    manager = new OrderStateManager();
    mockExchange = new MockExchangeAdapter({ mode: 'normal' });
  });

  afterEach(() => {
    manager.stopDetection();
    manager.reset();
    mockExchange.reset();
  });

  // ==========================================
  // 测试用例1: 状态转换 New → Active → Filled
  // ==========================================
  describe('状态转换: New → Active → Filled', () => {
    test('订单应该从OUTSIDE_MAGNET转换到SUBMITTING再到SUBMITTED最后FILLED', () => {
      // Step 1: 注册订单（New状态）
      const order = manager.registerOrder({
        orderLinkId: 'state-flow-001',
        state: 'OUTSIDE_MAGNET',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
      });
      expect(order.state).toBe('OUTSIDE_MAGNET');

      // Step 2: 转换为SUBMITTING（Active状态）
      manager.updateState('state-flow-001', 'SUBMITTING');
      let updatedOrder = manager.getOrder('state-flow-001');
      expect(updatedOrder?.state).toBe('SUBMITTING');

      // Step 3: 转换为SUBMITTED（Active状态）
      manager.updateState('state-flow-001', 'SUBMITTED');
      updatedOrder = manager.getOrder('state-flow-001');
      expect(updatedOrder?.state).toBe('SUBMITTED');
      expect(updatedOrder?.submittedAt).toBeDefined();

      // Step 4: 成交转换为FILLED（终态）
      manager.updateFill('state-flow-001', 1);
      updatedOrder = manager.getOrder('state-flow-001');
      expect(updatedOrder?.state).toBe('FILLED');
      expect(updatedOrder?.filledQty).toBe(1);
    });
  });

  // ==========================================
  // 测试用例2: 状态转换 New → Active → Cancelled
  // ==========================================
  describe('状态转换: New → Active → Cancelled', () => {
    test('订单应该从OUTSIDE_MAGNET转换到SUBMITTING再到SUBMITTED最后CANCELLED', () => {
      // Step 1: 注册订单（New状态）
      const order = manager.registerOrder({
        orderLinkId: 'state-flow-002',
        state: 'OUTSIDE_MAGNET',
        strategyId: 'strategy-1',
        product: 'ETHUSDT',
        side: 'Sell',
        price: 3000,
        qty: 2,
        filledQty: 0,
      });
      expect(order.state).toBe('OUTSIDE_MAGNET');

      // Step 2: 转换为SUBMITTING（Active状态）
      manager.updateState('state-flow-002', 'SUBMITTING');
      let updatedOrder = manager.getOrder('state-flow-002');
      expect(updatedOrder?.state).toBe('SUBMITTING');

      // Step 3: 转换为SUBMITTED（Active状态）
      manager.updateState('state-flow-002', 'SUBMITTED');
      updatedOrder = manager.getOrder('state-flow-002');
      expect(updatedOrder?.state).toBe('SUBMITTED');

      // Step 4: 撤单转换为CANCELLED（终态）
      manager.updateState('state-flow-002', 'CANCELLED');
      updatedOrder = manager.getOrder('state-flow-002');
      expect(updatedOrder?.state).toBe('CANCELLED');
    });
  });

  // ==========================================
  // 测试用例3: 提交超时检测（30秒）
  // ==========================================
  describe('超时检测: 提交超时（30秒）', () => {
    test('SUBMITTING状态超过30秒应该被标记为ABNORMAL', async () => {
      const alerts: AbnormalOrderAlert[] = [];
      manager.onAlert((alert) => alerts.push(alert));

      // 模拟31秒前创建的订单
      const oldOrder = manager.registerOrder({
        orderLinkId: 'timeout-submit',
        state: 'SUBMITTING',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
      });
      
      // 手动修改创建时间为31秒前
      (oldOrder as any).createdAt = Date.now() - 31000;

      // 启动检测
      manager.startDetection(100);
      
      // 等待检测执行
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const order = manager.getOrder('timeout-submit');
      expect(order?.state).toBe('ABNORMAL');
      expect(order?.abnormalReason).toContain('SUBMIT_TIMEOUT');
      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts[0].reason).toBe('SUBMIT_TIMEOUT');
    });
  });

  // ==========================================
  // 测试用例4: 挂单超时检测（10分钟）
  // ==========================================
  describe('超时检测: 挂单超时（10分钟）', () => {
    test('SUBMITTED状态超过10分钟应该被标记为ABNORMAL', async () => {
      const alerts: AbnormalOrderAlert[] = [];
      manager.onAlert((alert) => alerts.push(alert));

      // 模拟11分钟前提交的订单
      const oldOrder = manager.registerOrder({
        orderLinkId: 'timeout-hang',
        state: 'SUBMITTED',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
        submittedAt: Date.now() - 11 * 60 * 1000,
      });
      
      // 手动修改创建时间
      (oldOrder as any).createdAt = Date.now() - 11 * 60 * 1000;

      // 启动检测
      manager.startDetection(100);
      
      // 等待检测执行
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const order = manager.getOrder('timeout-hang');
      expect(order?.state).toBe('ABNORMAL');
      expect(order?.abnormalReason).toContain('HANGING_10MIN');
      expect(alerts.length).toBeGreaterThan(0);
    });
  });

  // ==========================================
  // 测试用例5: 5分钟无成交警告
  // ==========================================
  describe('超时检测: 5分钟无成交警告', () => {
    test('SUBMITTED状态5分钟无成交应该发送警告', async () => {
      // 模拟6分钟前提交的订单，无成交
      const oldOrder = manager.registerOrder({
        orderLinkId: 'warning-5min',
        state: 'SUBMITTED',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
        submittedAt: Date.now() - 6 * 60 * 1000,
      });
      
      // 手动修改创建时间
      (oldOrder as any).createdAt = Date.now() - 6 * 60 * 1000;

      // 启动检测
      manager.startDetection(100);
      
      // 等待检测执行
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const order = manager.getOrder('warning-5min');
      // 状态应该仍然是SUBMITTED（只是警告，不是异常）
      expect(order?.state).toBe('SUBMITTED');
      // 警告标记应该被设置
      expect(order?.timeoutWarningSent).toBe(true);
    });
  });

  // ==========================================
  // 测试用例6: stopDetection后clearInterval验证
  // ==========================================
  describe('定时器管理: stop()后clearInterval验证', () => {
    test('stopDetection应该清除定时器且checkInterval变为undefined', () => {
      // 启动检测
      manager.startDetection(1000);
      
      // 验证定时器已创建
      const intervalBefore = (manager as any).checkInterval;
      expect(intervalBefore).toBeDefined();
      
      // 停止检测
      manager.stopDetection();
      
      // 验证定时器已清除
      const intervalAfter = (manager as any).checkInterval;
      expect(intervalAfter).toBeUndefined();
    });

    test('重复调用stopDetection不应该报错', () => {
      manager.startDetection(1000);
      manager.stopDetection();
      
      // 第二次调用不应该抛出错误
      expect(() => manager.stopDetection()).not.toThrow();
      
      // 验证状态
      expect((manager as any).checkInterval).toBeUndefined();
    });

    test('startDetection重复调用应该清除旧定时器并创建新定时器', () => {
      manager.startDetection(1000);
      const interval1 = (manager as any).checkInterval;
      
      // 再次调用应该创建新定时器
      manager.startDetection(2000);
      const interval2 = (manager as any).checkInterval;
      
      // 应该是不同的定时器引用
      expect(interval1).not.toBe(interval2);
      
      manager.stopDetection();
      expect((manager as any).checkInterval).toBeUndefined();
    });
  });

  // ==========================================
  // 测试用例7: 部分成交后完全成交
  // ==========================================
  describe('状态转换: 部分成交后完全成交', () => {
    test('订单部分成交后最终完全成交', () => {
      manager.registerOrder({
        orderLinkId: 'partial-fill',
        state: 'SUBMITTED',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 2,
        filledQty: 0,
      });

      // 部分成交
      manager.updateFill('partial-fill', 0.5);
      let order = manager.getOrder('partial-fill');
      expect(order?.filledQty).toBe(0.5);
      expect(order?.state).toBe('SUBMITTED'); // 未完全成交，状态不变

      // 更多成交
      manager.updateFill('partial-fill', 1.5);
      order = manager.getOrder('partial-fill');
      expect(order?.filledQty).toBe(1.5);
      expect(order?.state).toBe('SUBMITTED'); // 仍未完全成交

      // 完全成交
      manager.updateFill('partial-fill', 2);
      order = manager.getOrder('partial-fill');
      expect(order?.filledQty).toBe(2);
      expect(order?.state).toBe('FILLED'); // 完全成交，状态变为FILLED
    });
  });

  // ==========================================
  // 测试用例8: 状态一致性检查
  // ==========================================
  describe('状态一致性检查', () => {
    test('应该能检测策略状态和交易所状态不一致', () => {
      const order = manager.registerOrder({
        orderLinkId: 'consistency-test',
        state: 'SUBMITTED',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
      });

      // 策略状态是SUBMITTED，交易所状态是Filled -> 不一致
      const result1 = manager.checkStateConsistency(order, 'Filled');
      expect(result1.consistent).toBe(false);
      expect(result1.reason).toContain('状态不一致');

      // 策略状态是SUBMITTED，交易所状态是New -> 一致
      const result2 = manager.checkStateConsistency(order, 'New');
      expect(result2.consistent).toBe(true);

      // 策略状态是FILLED，交易所状态是Filled -> 一致
      const filledOrder = { ...order, state: 'FILLED' as OrderStateEnum };
      const result3 = manager.checkStateConsistency(filledOrder, 'Filled');
      expect(result3.consistent).toBe(true);
    });
  });

  // ==========================================
  // 测试用例9: 通过orderId更新状态
  // ==========================================
  describe('P1修复: 通过orderId更新状态', () => {
    test('应该能通过orderId更新订单状态', () => {
      manager.registerOrder({
        orderLinkId: 'by-order-id',
        state: 'SUBMITTING',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
      });

      // 设置orderId映射
      manager.setOrderId('by-order-id', 'exchange-456');
      
      // 通过orderId更新状态
      const result = manager.updateStateByOrderId('exchange-456', 'SUBMITTED');
      expect(result).toBe(true);
      
      const order = manager.getOrder('by-order-id');
      expect(order?.state).toBe('SUBMITTED');
    });

    test('不存在的orderId应该返回false', () => {
      const result = manager.updateStateByOrderId('non-existent-id', 'SUBMITTED');
      expect(result).toBe(false);
    });
  });

  // ==========================================
  // 测试用例10: 统计指标
  // ==========================================
  describe('统计指标', () => {
    test('应该正确统计订单数据', () => {
      // 注册3个订单
      manager.registerOrder({
        orderLinkId: 'stat-1',
        state: 'OUTSIDE_MAGNET',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
      });
      
      manager.registerOrder({
        orderLinkId: 'stat-2',
        state: 'SUBMITTED',
        strategyId: 'strategy-1',
        product: 'ETHUSDT',
        side: 'Sell',
        price: 3000,
        qty: 1,
        filledQty: 0,
      });

      manager.registerOrder({
        orderLinkId: 'stat-3',
        state: 'ABNORMAL',
        strategyId: 'strategy-1',
        product: 'SOLUSDT',
        side: 'Buy',
        price: 100,
        qty: 10,
        filledQty: 0,
        abnormalReason: 'TEST',
      });

      const stats = manager.getStats();
      expect(stats.totalOrders).toBe(3);
      expect(stats.abnormalOrders).toBe(1);
      expect(stats.activeOrders).toBe(2); // OUTSIDE_MAGNET和SUBMITTED是活跃状态
    });
  });

  // ==========================================
  // 测试用例11-13: Mock Exchange Adapter集成
  // ==========================================
  describe('Mock Exchange Adapter集成', () => {
    test('正常模式：提交订单并查询状态', async () => {
      mockExchange.setMode('normal');
      
      const order = await mockExchange.submitOrder({
        orderLinkId: 'mock-normal-001',
        symbol: 'BTCUSDT',
        side: 'Buy',
        type: 'Limit',
        qty: 1,
        price: 50000,
      });
      
      expect(order.status).toBe('New');
      expect(order.filledQty).toBe(0);
      
      const queried = await mockExchange.getOrderStatus('mock-normal-001');
      expect(queried).not.toBeNull();
      expect(queried?.orderId).toBe(order.orderId);
    });

    test('超时模式：提交订单应该超时', async () => {
      mockExchange.setMode('timeout');
      
      try {
        await mockExchange.submitOrder({
          orderLinkId: 'mock-timeout-001',
          symbol: 'BTCUSDT',
          side: 'Buy',
          type: 'Limit',
          qty: 1,
          price: 50000,
        });
        expect(false).toBe(true); // 不应该执行到这里
      } catch (error: any) {
        expect(error.code).toBe('ETIMEDOUT');
        expect(error.message).toContain('timeout');
      }
    });

    test('错误模式：提交订单应该失败', async () => {
      mockExchange.setMode('error');
      
      let errorCount = 0;
      // 多次尝试，应该至少有一次失败
      for (let i = 0; i < 10; i++) {
        try {
          await mockExchange.submitOrder({
            orderLinkId: `mock-error-${i}`,
            symbol: 'BTCUSDT',
            side: 'Buy',
            type: 'Limit',
            qty: 1,
            price: 50000,
          });
        } catch (error: any) {
          errorCount++;
          expect(error.code).toBe('110001');
        }
      }
      expect(errorCount).toBeGreaterThan(0);
    });

    test('部分成交模式：订单应该部分成交', async () => {
      mockExchange.setMode('partial_fill', { partialFillRate: 0.5 });
      
      const order = await mockExchange.submitOrder({
        orderLinkId: 'mock-partial-001',
        symbol: 'BTCUSDT',
        side: 'Buy',
        type: 'Limit',
        qty: 1,
        price: 50000,
      });
      
      expect(order.status).toBe('PartiallyFilled');
      expect(order.filledQty).toBe(0.5);
    });

    test('网络断连模式：应该抛出网络错误', async () => {
      mockExchange.setMode('network_disconnect', { disconnectDurationMs: 100 });
      
      try {
        await mockExchange.submitOrder({
          orderLinkId: 'mock-disconnect-001',
          symbol: 'BTCUSDT',
          side: 'Buy',
          type: 'Limit',
          qty: 1,
          price: 50000,
        });
        expect(false).toBe(true); // 不应该执行到这里
      } catch (error: any) {
        expect(error.code).toBe('ECONNRESET');
      }
      
      // 等待恢复后应该可以正常提交
      await new Promise(resolve => setTimeout(resolve, 150));
      mockExchange.reconnect();
      
      const order = await mockExchange.submitOrder({
        orderLinkId: 'mock-reconnect-001',
        symbol: 'BTCUSDT',
        side: 'Buy',
        type: 'Limit',
        qty: 1,
        price: 50000,
      });
      
      expect(order.status).toBe('New');
    });
  });

  // ==========================================
  // 测试用例14-16: 异常回滚 - 提交超时
  // ==========================================
  describe('异常回滚: 提交超时', () => {
    test('SUBMITTING状态订单可以回滚到SUBMIT_FAILED', () => {
      manager.registerOrder({
        orderLinkId: 'rollback-submit-001',
        state: 'SUBMITTING',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
      });

      const result = manager.rollbackSubmitTimeout('rollback-submit-001');
      expect(result).toBe(true);
      
      const order = manager.getOrder('rollback-submit-001');
      expect(order?.state).toBe('SUBMIT_FAILED');
    });

    test('ABNORMAL(SUBMIT_TIMEOUT)状态订单可以回滚', () => {
      manager.registerOrder({
        orderLinkId: 'rollback-submit-002',
        state: 'ABNORMAL',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
        abnormalReason: 'SUBMIT_TIMEOUT',
      });

      const result = manager.rollbackSubmitTimeout('rollback-submit-002');
      expect(result).toBe(true);
      
      const order = manager.getOrder('rollback-submit-002');
      expect(order?.state).toBe('SUBMIT_FAILED');
    });

    test('非SUBMITTING状态订单不能回滚', () => {
      manager.registerOrder({
        orderLinkId: 'rollback-submit-003',
        state: 'SUBMITTED',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
      });

      const result = manager.rollbackSubmitTimeout('rollback-submit-003');
      expect(result).toBe(false);
      
      const order = manager.getOrder('rollback-submit-003');
      expect(order?.state).toBe('SUBMITTED'); // 状态不变
    });

    test('不存在的订单不能回滚', () => {
      const result = manager.rollbackSubmitTimeout('non-existent');
      expect(result).toBe(false);
    });
  });

  // ==========================================
  // 测试用例17-19: 异常回滚 - 部分成交后撤单
  // ==========================================
  describe('异常回滚: 部分成交后撤单', () => {
    test('部分成交订单回滚应该返回残余数量', () => {
      manager.registerOrder({
        orderLinkId: 'rollback-partial-001',
        state: 'SUBMITTED',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 2,
        filledQty: 0,
      });

      const result = manager.rollbackPartialFill('rollback-partial-001', 0.5);
      
      expect(result.success).toBe(true);
      expect(result.remainingQty).toBe(1.5);
      
      const order = manager.getOrder('rollback-partial-001');
      expect(order?.state).toBe('CANCELLED');
      expect(order?.abnormalReason).toContain('PARTIAL_FILL_CANCELLED');
    });

    test('完全成交订单回滚应该标记为FILLED', () => {
      manager.registerOrder({
        orderLinkId: 'rollback-partial-002',
        state: 'SUBMITTED',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
      });

      const result = manager.rollbackPartialFill('rollback-partial-002', 1);
      
      expect(result.success).toBe(true);
      expect(result.remainingQty).toBe(0);
      
      const order = manager.getOrder('rollback-partial-002');
      expect(order?.state).toBe('FILLED');
    });

    test('不存在的订单回滚应该失败', () => {
      const result = manager.rollbackPartialFill('non-existent', 0.5);
      expect(result.success).toBe(false);
      expect(result.remainingQty).toBe(0);
    });
  });

  // ==========================================
  // 测试用例20-23: 异常回滚 - 网络断连恢复
  // ==========================================
  describe('异常回滚: 网络断连恢复', () => {
    test('网络恢复后应该同步已成交订单', async () => {
      manager.registerOrder({
        orderLinkId: 'rollback-network-001',
        state: 'SUBMITTED',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
      });

      const result = await manager.rollbackNetworkDisconnect(
        'rollback-network-001',
        async () => ({ status: 'Filled', filledQty: 1 })
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe('synced');
      
      const order = manager.getOrder('rollback-network-001');
      expect(order?.state).toBe('FILLED');
      expect(order?.filledQty).toBe(1);
    });

    test('网络恢复后应该同步已撤单订单', async () => {
      manager.registerOrder({
        orderLinkId: 'rollback-network-002',
        state: 'SUBMITTED',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
      });

      const result = await manager.rollbackNetworkDisconnect(
        'rollback-network-002',
        async () => ({ status: 'Cancelled', filledQty: 0 })
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe('cancelled');
      
      const order = manager.getOrder('rollback-network-002');
      expect(order?.state).toBe('CANCELLED');
    });

    test('网络恢复后应该同步部分成交订单', async () => {
      manager.registerOrder({
        orderLinkId: 'rollback-network-003',
        state: 'SUBMITTED',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 2,
        filledQty: 0,
      });

      const result = await manager.rollbackNetworkDisconnect(
        'rollback-network-003',
        async () => ({ status: 'PartiallyFilled', filledQty: 0.5 })
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe('synced');
      
      const order = manager.getOrder('rollback-network-003');
      expect(order?.state).toBe('SUBMITTED');
      expect(order?.filledQty).toBe(0.5);
    });

    test('交易所无记录且SUBMITTING状态应该标记为失败', async () => {
      manager.registerOrder({
        orderLinkId: 'rollback-network-004',
        state: 'SUBMITTING',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
      });

      const result = await manager.rollbackNetworkDisconnect(
        'rollback-network-004',
        async () => null
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe('synced');
      
      const order = manager.getOrder('rollback-network-004');
      expect(order?.state).toBe('SUBMIT_FAILED');
    });

    test('查询失败应该返回失败状态', async () => {
      manager.registerOrder({
        orderLinkId: 'rollback-network-005',
        state: 'SUBMITTED',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
      });

      const result = await manager.rollbackNetworkDisconnect(
        'rollback-network-005',
        async () => { throw new Error('Network error'); }
      );

      expect(result.success).toBe(false);
      expect(result.action).toBe('failed');
    });
  });

  // ==========================================
  // 测试用例24-25: 批量回滚
  // ==========================================
  describe('批量回滚', () => {
    test('应该批量处理需要回滚的订单', async () => {
      // 创建需要回滚的订单
      const order1 = manager.registerOrder({
        orderLinkId: 'batch-rollback-001',
        state: 'SUBMITTING',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
      });
      (order1 as any).createdAt = Date.now() - 35000; // 35秒前

      const order2 = manager.registerOrder({
        orderLinkId: 'batch-rollback-002',
        state: 'ABNORMAL',
        strategyId: 'strategy-1',
        product: 'ETHUSDT',
        side: 'Sell',
        price: 3000,
        qty: 2,
        filledQty: 0,
        abnormalReason: 'SUBMIT_TIMEOUT',
      });

      // 创建一个不需要回滚的订单
      manager.registerOrder({
        orderLinkId: 'batch-rollback-normal',
        state: 'SUBMITTED',
        strategyId: 'strategy-1',
        product: 'SOLUSDT',
        side: 'Buy',
        price: 100,
        qty: 10,
        filledQty: 0,
      });

      const result = await manager.batchRollback({
        onSubmitTimeout: async (order) => true,
      });

      expect(result.total).toBe(2); // 只有2个需要回滚
      expect(result.success).toBe(2);
      expect(result.failed).toBe(0);
    });

    test('getOrdersNeedingRollback应该返回正确的订单', () => {
      // 创建需要回滚的订单（SUBMITTING超时）
      const order1 = manager.registerOrder({
        orderLinkId: 'need-rollback-001',
        state: 'SUBMITTING',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
      });
      (order1 as any).createdAt = Date.now() - 35000;

      // 创建ABNORMAL订单
      manager.registerOrder({
        orderLinkId: 'need-rollback-002',
        state: 'ABNORMAL',
        strategyId: 'strategy-1',
        product: 'ETHUSDT',
        side: 'Sell',
        price: 3000,
        qty: 2,
        filledQty: 0,
        abnormalReason: 'HANGING_10MIN',
      });

      // 创建正常订单
      manager.registerOrder({
        orderLinkId: 'normal-order',
        state: 'SUBMITTED',
        strategyId: 'strategy-1',
        product: 'SOLUSDT',
        side: 'Buy',
        price: 100,
        qty: 10,
        filledQty: 0,
      });

      const orders = manager.getOrdersNeedingRollback();
      expect(orders.length).toBe(2);
      expect(orders.map(o => o.orderLinkId).sort()).toEqual(['need-rollback-001', 'need-rollback-002']);
    });
  });

  // ==========================================
  // 测试用例26-27: Mock Exchange统计信息
  // ==========================================
  describe('Mock Exchange统计信息', () => {
    test('应该正确统计Mock请求', async () => {
      mockExchange.setMode('normal');
      
      await mockExchange.submitOrder({
        orderLinkId: 'stats-001',
        symbol: 'BTCUSDT',
        side: 'Buy',
        type: 'Limit',
        qty: 1,
        price: 50000,
      });

      await mockExchange.getOrderStatus('stats-001');
      await mockExchange.cancelOrder('stats-001');

      const stats = mockExchange.getStats();
      expect(stats.totalOrders).toBe(1);
      expect(stats.totalRequests).toBe(3);
      expect(stats.successRate).toBe(1);
      expect(stats.isConnected).toBe(true);
    });

    test('应该记录请求日志', async () => {
      mockExchange.clearRequestLog();
      mockExchange.setMode('timeout');
      
      try {
        await mockExchange.submitOrder({
          orderLinkId: 'log-001',
          symbol: 'BTCUSDT',
          side: 'Buy',
          type: 'Limit',
          qty: 1,
          price: 50000,
        });
      } catch (e) {
        // 预期超时
      }

      const log = mockExchange.getRequestLog();
      expect(log.length).toBe(1);
      expect(log[0].method).toBe('submitOrder');
      expect(log[0].success).toBe(false);
      expect(log[0].error).toContain('timeout');
    });
  });

  // ==========================================
  // 测试用例28: 综合场景 - 完整异常回滚流程
  // ==========================================
  describe('综合场景: 完整异常回滚流程', () => {
    test('订单超时 -> 标记异常 -> 回滚 -> 验证', async () => {
      const alerts: AbnormalOrderAlert[] = [];
      manager.onAlert((alert) => alerts.push(alert));

      // Step 1: 注册订单并进入SUBMITTING状态
      const order = manager.registerOrder({
        orderLinkId: 'integration-001',
        state: 'SUBMITTING',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
      });

      // Step 2: 模拟超时（35秒前创建）
      (order as any).createdAt = Date.now() - 35000;

      // Step 3: 启动检测，订单应该被标记为异常
      manager.startDetection(100);
      await new Promise(resolve => setTimeout(resolve, 200));

      const abnormalOrder = manager.getOrder('integration-001');
      expect(abnormalOrder?.state).toBe('ABNORMAL');
      expect(abnormalOrder?.abnormalReason).toBe('SUBMIT_TIMEOUT');
      expect(alerts.length).toBe(1);

      // Step 4: 执行回滚
      const rollbackResult = manager.rollbackSubmitTimeout('integration-001');
      expect(rollbackResult).toBe(true);

      // Step 5: 验证最终状态
      const finalOrder = manager.getOrder('integration-001');
      expect(finalOrder?.state).toBe('SUBMIT_FAILED');
    });

    test('部分成交场景: 提交 -> 部分成交 -> 撤单 -> 回滚', async () => {
      // Step 1: 在Mock交易所提交订单
      mockExchange.setMode('partial_fill', { partialFillRate: 0.5 });
      
      const mockOrder = await mockExchange.submitOrder({
        orderLinkId: 'integration-partial-001',
        symbol: 'BTCUSDT',
        side: 'Buy',
        type: 'Limit',
        qty: 2,
        price: 50000,
      });

      expect(mockOrder.status).toBe('PartiallyFilled');
      expect(mockOrder.filledQty).toBe(1);

      // Step 2: 在OSM注册订单
      manager.registerOrder({
        orderLinkId: 'integration-partial-001',
        state: 'SUBMITTED',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 2,
        filledQty: 0,
      });

      // Step 3: 执行撤单
      await mockExchange.cancelOrder('integration-partial-001');

      // Step 4: 执行回滚
      const rollbackResult = manager.rollbackPartialFill('integration-partial-001', 1);
      
      expect(rollbackResult.success).toBe(true);
      expect(rollbackResult.remainingQty).toBe(1);

      // Step 5: 验证最终状态
      const finalOrder = manager.getOrder('integration-partial-001');
      expect(finalOrder?.state).toBe('CANCELLED');
      expect(finalOrder?.filledQty).toBe(1);
      expect(finalOrder?.abnormalReason).toContain('PARTIAL_FILL_CANCELLED');
    });

    test('网络断连场景: 提交 -> 断连 -> 恢复 -> 同步', async () => {
      // Step 1: 在OSM注册订单
      manager.registerOrder({
        orderLinkId: 'integration-network-001',
        state: 'SUBMITTING',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
      });

      // Step 2: 模拟网络断连
      mockExchange.setMode('network_disconnect', { disconnectDurationMs: 50 });

      // Step 3: 尝试提交（应该失败）
      try {
        await mockExchange.submitOrder({
          orderLinkId: 'integration-network-001',
          symbol: 'BTCUSDT',
          side: 'Buy',
          type: 'Limit',
          qty: 1,
          price: 50000,
        });
        expect(false).toBe(true);
      } catch (error: any) {
        expect(error.code).toBe('ECONNRESET');
      }

      // Step 4: 等待网络恢复并模拟交易所订单已成交
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // 先在Mock中创建订单（模拟交易所实际已成交）
      mockExchange.reconnect();
      mockExchange.setMode('normal');
      
      const exchangeOrder = await mockExchange.submitOrder({
        orderLinkId: 'integration-network-001',
        symbol: 'BTCUSDT',
        side: 'Buy',
        type: 'Limit',
        qty: 1,
        price: 50000,
      });
      
      // 模拟完全成交
      mockExchange.simulateFill('integration-network-001', 1);

      // Step 5: 执行网络断连回滚
      const rollbackResult = await manager.rollbackNetworkDisconnect(
        'integration-network-001',
        async () => {
          const order = await mockExchange.getOrderStatus('integration-network-001');
          if (!order) return null;
          return {
            status: order.status,
            filledQty: order.filledQty,
          };
        }
      );

      expect(rollbackResult.success).toBe(true);
      expect(rollbackResult.action).toBe('synced');

      // Step 6: 验证最终状态
      const finalOrder = manager.getOrder('integration-network-001');
      expect(finalOrder?.state).toBe('FILLED');
      expect(finalOrder?.filledQty).toBe(1);
    });
  });
});
