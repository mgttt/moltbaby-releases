/**
 * symbol-info.ts - 交易品种信息获取
 * 
 * 提供从交易所API获取品种精度、最小变动单位等信息
 */

import { createLogger } from '../utils/logger';
const logger = createLogger('symbol-info');

import type { TradingProvider } from '../providers/paper-trading';

/**
 * 品种信息
 */
export interface SymbolInfo {
  symbol: string;
  priceTick: number;        // 最小价格变动单位
  quantityTick: number;     // 最小数量变动单位
  minQuantity: number;      // 最小下单数量
  maxQuantity: number;      // 最大下单数量
  pricePrecision: number;   // 价格精度（小数位）
  quantityPrecision: number; // 数量精度（小数位）
}

/**
 * 从交易所获取品种信息
 * 
 * @param symbol 交易对，如 'BTCUSDT'
 * @param provider 交易所Provider
 * @returns 品种信息
 */
export async function fetchSymbolInfo(
  symbol: string,
  provider?: TradingProvider
): Promise<SymbolInfo> {
  // 如果提供了provider，尝试从provider获取
  if (provider && 'getSymbolInfo' in provider) {
    // @ts-ignore - 假设provider有这个方法
    const info = await provider.getSymbolInfo(symbol);
    if (info) return info;
  }

  // 默认品种信息映射（常用品种）
  const defaultSymbolInfo: Record<string, SymbolInfo> = {
    'BTCUSDT': {
      symbol: 'BTCUSDT',
      priceTick: 0.1,
      quantityTick: 0.001,
      minQuantity: 0.001,
      maxQuantity: 1000,
      pricePrecision: 1,
      quantityPrecision: 3,
    },
    'ETHUSDT': {
      symbol: 'ETHUSDT',
      priceTick: 0.01,
      quantityTick: 0.01,
      minQuantity: 0.01,
      maxQuantity: 10000,
      pricePrecision: 2,
      quantityPrecision: 2,
    },
    'MYXUSDT': {
      symbol: 'MYXUSDT',
      priceTick: 0.0001,
      quantityTick: 0.1,
      minQuantity: 0.1,
      maxQuantity: 1000000,
      pricePrecision: 4,
      quantityPrecision: 1,
    },
    'SOLUSDT': {
      symbol: 'SOLUSDT',
      priceTick: 0.01,
      quantityTick: 0.01,
      minQuantity: 0.01,
      maxQuantity: 100000,
      pricePrecision: 2,
      quantityPrecision: 2,
    },
  };

  // 返回默认配置或通用配置
  if (defaultSymbolInfo[symbol]) {
    return defaultSymbolInfo[symbol];
  }

  // 根据symbol后缀推测精度
  if (symbol.endsWith('USDT')) {
    // 默认USDT交易对配置
    return {
      symbol,
      priceTick: 0.01,
      quantityTick: 0.01,
      minQuantity: 0.01,
      maxQuantity: 100000,
      pricePrecision: 2,
      quantityPrecision: 2,
    };
  }

  // 最通用配置
  return {
    symbol,
    priceTick: 0.1,
    quantityTick: 0.001,
    minQuantity: 0.001,
    maxQuantity: 100000,
    pricePrecision: 1,
    quantityPrecision: 3,
  };
}

/**
 * 根据价格计算精度合适的价格
 * 
 * @param price 原始价格
 * @param priceTick 最小价格变动单位
 * @returns 格式化后的价格
 */
export function formatPrice(price: number, priceTick: number): number {
  const precision = Math.max(0, Math.ceil(-Math.log10(priceTick)));
  const factor = Math.pow(10, precision);
  return Math.round(price * factor) / factor;
}

/**
 * 根据数量精度格式化数量
 * 
 * @param quantity 原始数量
 * @param quantityTick 最小数量变动单位
 * @returns 格式化后的数量
 */
export function formatQuantity(quantity: number, quantityTick: number): number {
  const precision = Math.max(0, Math.ceil(-Math.log10(quantityTick)));
  const factor = Math.pow(10, precision);
  return Math.floor(quantity * factor) / factor; // 数量向下取整
}

/**
 * 验证订单价格是否符合精度要求
 * 
 * @param price 价格
 * @param priceTick 最小价格变动单位
 * @returns 是否有效
 */
export function isValidPrice(price: number, priceTick: number): boolean {
  const remainder = price % priceTick;
  return remainder < 0.0000001 || Math.abs(remainder - priceTick) < 0.0000001;
}

/**
 * 获取品种的默认配置
 * 
 * @param symbol 交易对
 * @returns 默认品种信息
 */
export function getDefaultSymbolInfo(symbol: string): SymbolInfo {
  return fetchSymbolInfo(symbol);
}
