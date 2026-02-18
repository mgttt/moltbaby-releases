// ============================================================
// Trading Providers 统一导出
// ============================================================
// 
// 架构说明：
// - quant-lib/providers: 基础数据Provider（Kline数据获取）
// - quant-lab/providers: 交易Provider（下单/持仓/账户管理）
// 
// 注意：BinanceProvider/BybitProvider/PaperTradingProvider已迁移到此目录
// 原因：它们依赖quant-lab/engine/的交易引擎类型（TradingProvider等）
// ============================================================

// 模拟Provider（测试用）
export { SimulatedProvider } from './simulated.js';
export type { SimulatedProviderConfig } from './simulated.js';
export { SCENARIOS } from './simulated/scenarios.js';
export type { Scenario, ScenarioPhase } from './simulated/scenarios.js';

// 真实交易所Provider（已迁移到quant-lab）
export { BinanceProvider } from './binance.js';
export type { BinanceProviderConfig } from './binance.js';

export { BybitProvider } from './bybit.js';
export type { BybitProviderConfig } from './bybit.js';

// export { PaperTradingProvider } from './paper-trading.js';
// export type { 
//   PaperTradingConfig,
//   PaperOrder,
//   PaperPosition,
//   PaperTrade,
//   PaperAccountState,
//   PlaceOrderParams,
//   PlaceOrderResult,
//   EquityPoint,
//   PaperStats
// } from './paper-trading.js';
