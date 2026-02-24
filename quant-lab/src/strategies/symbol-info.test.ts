/**
 * symbol-info.test.ts - 品种信息工具测试
 */

import { createLogger } from '../utils/logger';
const logger = createLogger('symbol-info.test');

import { describe, it, expect } from 'vitest';
import {
  fetchSymbolInfo,
  formatPrice,
  formatQuantity,
  isValidPrice,
} from './symbol-info';

describe('symbol-info', () => {
  describe('fetchSymbolInfo', () => {
    it('应该返回BTCUSDT的默认配置', async () => {
      const info = await fetchSymbolInfo('BTCUSDT');
      expect(info.symbol).toBe('BTCUSDT');
      expect(info.priceTick).toBe(0.1);
      expect(info.pricePrecision).toBe(1);
    });

    it('应该返回ETHUSDT的默认配置', async () => {
      const info = await fetchSymbolInfo('ETHUSDT');
      expect(info.symbol).toBe('ETHUSDT');
      expect(info.priceTick).toBe(0.01);
      expect(info.pricePrecision).toBe(2);
    });

    it('应该返回MYXUSDT的默认配置', async () => {
      const info = await fetchSymbolInfo('MYXUSDT');
      expect(info.symbol).toBe('MYXUSDT');
      expect(info.priceTick).toBe(0.0001);
      expect(info.pricePrecision).toBe(4);
    });

    it('未知USDT品种应该返回通用配置', async () => {
      const info = await fetchSymbolInfo('UNKNOWNUSDT');
      expect(info.symbol).toBe('UNKNOWNUSDT');
      expect(info.priceTick).toBe(0.01);
    });

    it('非USDT品种应该返回通用配置', async () => {
      const info = await fetchSymbolInfo('BTCETH');
      expect(info.symbol).toBe('BTCETH');
      expect(info.priceTick).toBe(0.1);
    });
  });

  describe('formatPrice', () => {
    it('应该按priceTick格式化价格', () => {
      expect(formatPrice(50000.123, 0.1)).toBe(50000.1);
      expect(formatPrice(50000.123, 0.01)).toBe(50000.12);
      expect(formatPrice(50000.123, 0.001)).toBe(50000.123);
    });

    it('应该正确处理整数tick', () => {
      expect(formatPrice(50000.5, 1)).toBe(50001);
      expect(formatPrice(50000.4, 1)).toBe(50000);
    });

    it('应该处理很小的priceTick', () => {
      expect(formatPrice(0.123456, 0.0001)).toBe(0.1235);
      expect(formatPrice(0.123456, 0.00001)).toBe(0.12346);
    });
  });

  describe('formatQuantity', () => {
    it('应该按quantityTick格式化数量（向下取整）', () => {
      expect(formatQuantity(1.234, 0.001)).toBe(1.234);
      expect(formatQuantity(1.2349, 0.001)).toBe(1.234);
      expect(formatQuantity(1.999, 0.01)).toBe(1.99);
    });

    it('应该正确处理整数tick', () => {
      expect(formatQuantity(1.9, 1)).toBe(1);
      expect(formatQuantity(2.1, 1)).toBe(2);
    });
  });

  describe('isValidPrice', () => {
    it('应该验证价格是否符合tick要求', () => {
      expect(isValidPrice(50000.1, 0.1)).toBe(true);
      expect(isValidPrice(50000.15, 0.1)).toBe(false);
      expect(isValidPrice(50000.01, 0.01)).toBe(true);
      expect(isValidPrice(50000.001, 0.01)).toBe(false);
    });

    it('应该处理整数tick', () => {
      expect(isValidPrice(50000, 1)).toBe(true);
      expect(isValidPrice(50000.5, 1)).toBe(false);
    });
  });
});
