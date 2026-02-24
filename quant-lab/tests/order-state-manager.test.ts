/**
 * OrderStateManager 单元测试 (T9)
 * 
 * 覆盖：状态转换(New→Active→Filled/Cancelled)、超时检测、stop()后clearInterval验证
 * 测试用例数：≥6个
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
});
