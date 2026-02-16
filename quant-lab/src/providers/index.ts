// ============================================================
// Trading Providers 统一导出
// ============================================================
//
// 所有真实交易所providers已迁移到quant-lib（单一真源）
// 直接从quant-lib导入：
//   import { BybitProvider } from '../../quant-lib/src/providers/bybit';
//   import { BinanceProvider } from '../../quant-lib/src/providers/binance';
//   import { PaperTradingProvider } from '../../quant-lib/src/providers/paper-trading';
//   import { CoinExProvider } from '../../quant-lib/src/providers/coinex';
//   import { HTXProvider } from '../../quant-lib/src/providers/htx';
//
// quant-lab/providers只保留策略模拟器（仅用于测试）
// ============================================================

export { SimulatedProvider } from './simulated';
export type { SimulatedProviderConfig } from './simulated';

export { SCENARIOS } from './simulated/scenarios';
export type { Scenario, ScenarioPhase } from './simulated/scenarios';
