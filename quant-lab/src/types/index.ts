/**
 * 类型定义索引
 * 
 * 统一导出所有类型定义
 */

// 策略接口（规范化）
export * from './strategy';

// 引擎类型（原有）
export type {
  Order,
  Position,
  Account,
  Tick,
  OrderSide,
  PositionSide,
  OrderStatus,
  BacktestConfig,
  BacktestResult,
  LiveConfig,
  StrategyContext,
  Strategy
} from '../engine/types';

// 遗留类型（兼容）
export type {
  StrategyConfig,
  StrategyResult,
  AccountType,
  AccountInfo,
  AccountConfig,
  QuickJSStrategyContext,
  EngineOptions
} from '../types';
