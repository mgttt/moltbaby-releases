/**
 * 数据提供者统一导出
 * 
 * 注意：BinanceProvider/BybitProvider已迁移到quant-lab/src/providers/
 * 请从quant-lab导入：
 *   import { BybitProvider } from '../../quant-lab/src/providers/bybit.js';
 *   import { BinanceProvider } from '../../quant-lab/src/providers/binance.js';
 */

export { DataProvider, RestDataProvider, WebSocketDataProvider } from './base.js';
export { BinanceCurlProvider } from './binance-curl.js';
export { BybitCurlProvider } from './bybit-curl.js';
export { TradingViewProvider } from './tradingview.js';
export { WeQuantTushareProvider } from './wequant-tushare.js';

// NOTE: FUTU provider depends on a futu-trader native client that is not present in this repo.
// Import it directly only in environments that have that dependency.
// export { FutuProvider } from './futu.js';

// 已迁移到quant-lab的Provider（保留重导出以兼容历史代码）
// export { BinanceProvider } from './binance.js'; // → quant-lab/src/providers/binance.ts
// export { BybitProvider } from './bybit.js';     // → quant-lab/src/providers/bybit.ts
// export { PaperTradingProvider } from './paper-trading.js'; // → quant-lab/src/providers/paper-trading.ts
