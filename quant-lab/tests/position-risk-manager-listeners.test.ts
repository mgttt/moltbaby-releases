/**
 * position-risk-manager 事件监听器测试
 * 
 * 验证T7修复：事件监听器内存泄漏
 */

import { describe, test, expect } from 'bun:test';
import { PositionRiskManager } from '../src/execution/position-risk-manager';
import { PositionReducer } from '../src/execution/position-reducer';

describe('PositionRiskManager 事件监听器', () => {
  test('创建后应该有3个事件监听器', () => {
    const manager = new PositionRiskManager({
      symbol: 'BTCUSDT',
      maxLeverage: 5,
      maxPositionValue: 10000,
      maxMarginUsage: 80,
    });

    // 获取reducer的监听器数量
    const reducer = (manager as any).reducer as PositionReducer;
    const listenerCount = reducer.listenerCount('reduce:initiated') + 
                          reducer.listenerCount('reduce:completed') + 
                          reducer.listenerCount('reduce:failed');
    
    expect(listenerCount).toBe(3);
    
    // 清理
    manager.destroy();
  });

  test('destroy后应该移除所有事件监听器', () => {
    const manager = new PositionRiskManager({
      symbol: 'BTCUSDT',
      maxLeverage: 5,
      maxPositionValue: 10000,
      maxMarginUsage: 80,
    });

    // 销毁前检查
    const reducer = (manager as any).reducer as PositionReducer;
    
    // 调用destroy
    manager.destroy();

    // 验证监听器已移除
    expect(reducer.listenerCount('reduce:initiated')).toBe(0);
    expect(reducer.listenerCount('reduce:completed')).toBe(0);
    expect(reducer.listenerCount('reduce:failed')).toBe(0);
  });

  test('多次创建销毁不应该累积监听器', () => {
    const reducers: PositionReducer[] = [];
    
    // 创建10个manager并销毁
    for (let i = 0; i < 10; i++) {
      const manager = new PositionRiskManager({
        symbol: 'BTCUSDT',
        maxLeverage: 5,
        maxPositionValue: 10000,
        maxMarginUsage: 80,
      });
      
      reducers.push((manager as any).reducer);
      manager.destroy();
    }

    // 所有reducer都应该没有监听器
    for (const reducer of reducers) {
      expect(reducer.listenerCount('reduce:initiated')).toBe(0);
      expect(reducer.listenerCount('reduce:completed')).toBe(0);
      expect(reducer.listenerCount('reduce:failed')).toBe(0);
    }
  });
});
