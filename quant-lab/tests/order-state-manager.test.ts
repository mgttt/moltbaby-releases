/**
 * OrderStateManager 单元测试
 * 
 * 覆盖：状态转换、超时检测、clearInterval验证
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { OrderStateManager, OrderStateEnum, AbnormalOrderAlert } from '../src/engine/OrderStateManager';

describe('OrderStateManager', () => {
  let manager: OrderStateManager;

  beforeEach(() => {
    manager = new OrderStateManager();
  });

  afterEach(() => {
    manager.stopDetection();
  });

  describe('基础功能', () => {
    test('应该能注册订单', () => {
      const order = manager.registerOrder({
        orderLinkId: 'test-001',
        state: 'OUTSIDE_MAGNET',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
      });

      expect(order.orderLinkId).toBe('test-001');
      expect(order.state).toBe('OUTSIDE_MAGNET');
      expect(order.createdAt).toBeGreaterThan(0);
      expect(order.lastUpdateAt).toBe(order.createdAt);
    });

    test('应该能更新订单状态', () => {
      manager.registerOrder({
        orderLinkId: 'test-002',
        state: 'OUTSIDE_MAGNET',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
      });

      const result = manager.updateState('test-002', 'SUBMITTING');
      expect(result).toBe(true);

      const order = manager.getOrder('test-002');
      expect(order?.state).toBe('SUBMITTING');
    });

    test('更新不存在订单应该返回false', () => {
      const result = manager.updateState('non-existent', 'SUBMITTING');
      expect(result).toBe(false);
    });

    test('应该能通过orderId更新状态', () => {
      manager.registerOrder({
        orderLinkId: 'test-003',
        state: 'SUBMITTING',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
      });

      manager.setOrderId('test-003', 'exchange-123');
      const result = manager.updateStateByOrderId('exchange-123', 'SUBMITTED');
      
      expect(result).toBe(true);
      expect(manager.getOrder('test-003')?.state).toBe('SUBMITTED');
    });

    test('应该能更新成交数量', () => {
      manager.registerOrder({
        orderLinkId: 'test-004',
        state: 'SUBMITTED',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
      });

      manager.updateFill('test-004', 0.5);
      const order = manager.getOrder('test-004');
      
      expect(order?.filledQty).toBe(0.5);
    });

    test('完全成交应该自动更新状态为FILLED', () => {
      manager.registerOrder({
        orderLinkId: 'test-005',
        state: 'SUBMITTED',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
      });

      manager.updateFill('test-005', 1);
      const order = manager.getOrder('test-005');
      
      expect(order?.filledQty).toBe(1);
      expect(order?.state).toBe('FILLED');
    });
  });

  describe('订单查询', () => {
    beforeEach(() => {
      // 创建多个订单
      manager.registerOrder({
        orderLinkId: 'active-1',
        state: 'SUBMITTED',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
      });
      
      manager.registerOrder({
        orderLinkId: 'active-2',
        state: 'OUTSIDE_MAGNET',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Sell',
        price: 51000,
        qty: 1,
        filledQty: 0,
      });
      
      manager.registerOrder({
        orderLinkId: 'filled-1',
        state: 'FILLED',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 1,
      });
    });

    test('应该能获取所有订单', () => {
      const orders = manager.getAllOrders();
      expect(orders.length).toBe(3);
    });

    test('应该能获取活跃订单（非终态）', () => {
      const activeOrders = manager.getActiveOrders();
      expect(activeOrders.length).toBe(2);
      expect(activeOrders.every(o => o.state !== 'FILLED')).toBe(true);
    });

    test('应该能获取异常单', () => {
      manager.updateState('active-1', 'ABNORMAL');
      const abnormalOrders = manager.getAbnormalOrders();
      expect(abnormalOrders.length).toBe(1);
      expect(abnormalOrders[0].orderLinkId).toBe('active-1');
    });
  });

  describe('超时检测', () => {
    test('应该检测提交超时（30秒）', () => {
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
      setTimeout(() => {
        const order = manager.getOrder('timeout-submit');
        expect(order?.state).toBe('ABNORMAL');
        expect(order?.abnormalReason).toContain('SUBMIT_TIMEOUT');
        expect(alerts.length).toBeGreaterThan(0);
      }, 200);
    });

    test('应该检测挂单超时（10分钟）', () => {
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
      setTimeout(() => {
        const order = manager.getOrder('timeout-hang');
        expect(order?.state).toBe('ABNORMAL');
        expect(order?.abnormalReason).toContain('HANGING_10MIN');
      }, 200);
    });
  });

  describe('定时器管理', () => {
    test('startDetection应该创建定时器', () => {
      manager.startDetection(1000);
      // 内部状态验证
      expect((manager as any).checkInterval).toBeDefined();
    });

    test('stopDetection应该清除定时器', () => {
      manager.startDetection(1000);
      const interval = (manager as any).checkInterval;
      
      manager.stopDetection();
      
      expect((manager as any).checkInterval).toBeUndefined();
    });

    test('重复调用startDetection应该只保留一个定时器', () => {
      manager.startDetection(1000);
      const interval1 = (manager as any).checkInterval;
      
      manager.startDetection(2000);
      const interval2 = (manager as any).checkInterval;
      
      // 应该是不同的定时器（旧的被清除了）
      expect(interval1).not.toBe(interval2);
    });
  });

  describe('统计指标', () => {
    test('应该正确统计总订单数', () => {
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
        state: 'OUTSIDE_MAGNET',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
      });

      const stats = manager.getStats();
      expect(stats.totalOrders).toBe(2);
    });

    test('应该正确统计异常订单数', () => {
      manager.registerOrder({
        orderLinkId: 'stat-abnormal',
        state: 'ABNORMAL',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
        abnormalReason: 'TEST',
      });

      const stats = manager.getStats();
      expect(stats.abnormalOrders).toBe(1);
    });
  });

  describe('清理功能', () => {
    test('应该能清理已完成订单', () => {
      manager.registerOrder({
        orderLinkId: 'cleanup-filled',
        state: 'FILLED',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 1,
      });
      
      manager.registerOrder({
        orderLinkId: 'cleanup-active',
        state: 'SUBMITTED',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
      });

      const cleaned = manager.cleanupCompletedOrders();
      
      expect(cleaned).toBe(1);
      expect(manager.getOrder('cleanup-filled')).toBeUndefined();
      expect(manager.getOrder('cleanup-active')).toBeDefined();
    });

    test('reset应该清空所有数据', () => {
      manager.registerOrder({
        orderLinkId: 'reset-test',
        state: 'SUBMITTED',
        strategyId: 'strategy-1',
        product: 'BTCUSDT',
        side: 'Buy',
        price: 50000,
        qty: 1,
        filledQty: 0,
      });

      manager.reset();

      expect(manager.getAllOrders().length).toBe(0);
      expect(manager.getStats().totalOrders).toBe(0);
    });
  });
});
