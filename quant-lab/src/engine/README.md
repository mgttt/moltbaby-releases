# Engine 引擎层

> 策略回测与实盘执行引擎

**版本**: v3.0  
**路径**: `quant-lab/src/engine/`  
**维护**: bot-001/bot-00a

---

## 📋 模块总览

引擎层提供策略运行的两种核心模式：

- **BacktestEngine** - 历史数据回测，验证策略表现
- **LiveEngine** - 实盘交易，连接真实交易所

两者共享相同的策略接口，实现"一套代码，回测实盘两用"。

```
┌─────────────────────────────────────────────────────────────┐
│                      Engine 引擎层                           │
├───────────────────────────────┬─────────────────────────────┤
│      BacktestEngine           │      LiveEngine             │
│        回测引擎                │        实盘引擎             │
├───────────────────────────────┼─────────────────────────────┤
│ • 历史数据回放                │ • WebSocket行情订阅         │
│ • 模拟订单撮合                │ • 真实订单执行              │
│ • 盈亏计算                    │ • 订单状态回推              │
│ • 性能指标                    │ • 风控管理                  │
│ • 权益曲线                    │ • 状态持久化                │
└───────────────────────────────┴─────────────────────────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │   Strategy 策略   │
                    │  (统一接口)       │
                    └───────────────────┘
```

---

## 🚀 快速开始

### 1. 回测引擎

```typescript
import { BacktestEngine } from './engine/backtest';
import { KlineDatabase } from '../../quant-lib/src';
import { MyStrategy } from '../strategies/my-strategy';

// 1. 初始化数据库
const db = new KlineDatabase({ path: './data/ndtsdb' });
await db.init();

// 2. 配置回测
const config = {
  initialBalance: 10000,
  symbols: ['BTC/USDT'],
  interval: '1d',
  startTime: new Date('2024-01-01').getTime() / 1000,
  endTime: new Date('2024-12-31').getTime() / 1000,
  commission: 0.001,   // 0.1% 手续费
  slippage: 0.0005,    // 0.05% 滑点
};

// 3. 创建策略和引擎
const strategy = new MyStrategy();
const engine = new BacktestEngine(db, strategy, config);

// 4. 运行回测
const result = await engine.run();

// 5. 查看结果
console.log(`总回报: ${(result.totalReturn * 100).toFixed(2)}%`);
console.log(`最大回撤: ${(result.maxDrawdown * 100).toFixed(2)}%`);
console.log(`夏普比率: ${result.sharpeRatio.toFixed(2)}`);
console.log(`胜率: ${(result.winRate * 100).toFixed(2)}%`);
```

### 2. 实盘引擎（Paper Trading）

```typescript
import { LiveEngine } from './engine/live';
import { PaperTradingProvider } from '../providers/paper-trading';
import { MyStrategy } from '../strategies/my-strategy';

// 1. 创建模拟交易Provider
const provider = new PaperTradingProvider({
  initialBalance: 10000,
  commission: 0.001,
  slippage: 0.0005,
});

// 2. 配置实盘
const config = {
  symbols: ['BTC/USDT'],
  interval: '1d',
  maxPositionSize: 1.0,    // 最大持仓 1 BTC
  maxDrawdown: 0.20,       // 最大回撤 20%
};

// 3. 创建策略和引擎
const strategy = new MyStrategy();
const engine = new LiveEngine(strategy, config, provider);

// 4. 启动实盘
await engine.start();

// 5. 模拟推送K线（测试用）
await provider.pushKline({
  symbol: 'BTC/USDT',
  timestamp: Date.now() / 1000,
  open: 50000,
  high: 51000,
  low: 49500,
  close: 50500,
  volume: 1000,
});

// 6. 停止
await engine.stop();
```

### 3. 实盘引擎（真实交易所）

```typescript
import { LiveEngine } from './engine/live';
import { BybitProvider } from '../providers/bybit';

// 1. 创建真实交易所Provider
const provider = new BybitProvider({
  apiKey: 'YOUR_API_KEY',
  apiSecret: 'YOUR_API_SECRET',
  testnet: true,  // 使用测试网
});

// 2. 创建引擎并启动
const engine = new LiveEngine(strategy, config, provider);
await engine.start();

// Provider 会自动订阅行情并执行订单
```

---

## 📦 模块清单

| 文件 | 功能 | 说明 |
|------|------|------|
| `backtest.ts` | 回测引擎 | 历史数据回放、模拟撮合 |
| `live.ts` | 实盘引擎 | WebSocket订阅、真实订单 |
| `types.ts` | 类型定义 | 策略接口、配置类型 |
| `context-builder.ts` | 上下文构建 | StrategyContext构建 |
| `OrderStateManager.ts` | 订单状态管理 | 订单生命周期管理 |

---

## 🔧 策略接口

策略需实现以下接口：

```typescript
interface Strategy {
  name: string;
  
  // 初始化
  onInit(ctx: StrategyContext): Promise<void>;
  
  // K线回调（回测和实盘共用）
  onBar(bar: Kline, ctx: StrategyContext): Promise<void>;
  
  // Tick回调（仅实盘）
  onTick?(tick: Tick, ctx: StrategyContext): Promise<void>;
  
  // 订单状态回调
  onOrder?(order: Order, ctx: StrategyContext): Promise<void>;
  
  // 停止
  onStop(ctx: StrategyContext): Promise<void>;
}
```

### StrategyContext API

```typescript
interface StrategyContext {
  // 账户信息
  getAccount(): Account;
  
  // 持仓查询
  getPosition(symbol: string): Position | null;
  getPositions(): Position[];
  
  // 下单
  buy(symbol: string, quantity: number, price?: number): Promise<Order>;
  sell(symbol: string, quantity: number, price?: number): Promise<Order>;
  
  // 撤单
  cancelOrder(orderId: string): Promise<void>;
  
  // 数据查询
  getLastBar(symbol: string): Kline | null;
  getBars(symbol: string, limit: number): Kline[];
  
  // 日志
  log(message: string, level?: 'info' | 'warn' | 'error'): void;
}
```

---

## 📊 回测结果

```typescript
interface BacktestResult {
  // 基本指标
  totalReturn: number;        // 总回报率
  annualizedReturn: number;   // 年化回报率
  maxDrawdown: number;        // 最大回撤
  
  // 风险指标
  sharpeRatio: number;        // 夏普比率
  sortinoRatio: number;       // 索提诺比率
  volatility: number;         // 波动率
  
  // 交易指标
  winRate: number;            // 胜率
  profitFactor: number;       // 盈亏比
  totalTrades: number;        // 总交易次数
  
  // 权益曲线
  equityCurve: Array<{
    timestamp: number;
    equity: number;
  }>;
  
  // 交易记录
  trades: TradeRecord[];
}
```

---

## 🔌 TradingProvider 接口

连接交易所需实现：

```typescript
interface TradingProvider {
  // WebSocket订阅
  subscribeKlines(
    symbols: string[], 
    interval: string, 
    callback: (bar: Kline) => void
  ): Promise<void>;
  
  // 订单执行
  buy(symbol: string, qty: number, price?: number): Promise<Order>;
  sell(symbol: string, qty: number, price?: number): Promise<Order>;
  cancelOrder(orderId: string): Promise<void>;
  
  // 账户查询
  getAccount(): Promise<Account>;
  getPosition(symbol: string): Promise<Position | null>;
}
```

### 现有Provider

| Provider | 状态 | 用途 |
|----------|------|------|
| `PaperTradingProvider` | ✅ | 模拟交易，测试用 |
| `BybitProvider` | ✅ | Bybit合约实盘 |
| `BinanceProvider` | 📝 | Binance现货（框架） |

---

## 📝 配置示例

### 回测配置

```typescript
const backtestConfig = {
  initialBalance: 10000,      // 初始资金
  symbols: ['BTC/USDT'],      // 交易对
  interval: '1h',             // K线周期
  startTime: 1704067200,      // 开始时间戳
  endTime: 1735689600,        // 结束时间戳
  commission: 0.001,          // 手续费
  slippage: 0.0005,           // 滑点
};
```

### 实盘配置

```typescript
const liveConfig = {
  symbols: ['BTC/USDT'],
  interval: '1m',
  maxPositionSize: 1.0,       // 最大持仓
  maxDrawdown: 0.20,          // 最大回撤20%
  riskLimits: {
    maxLeverage: 5,           // 最大杠杆
    maxMarginUsage: 0.8,      // 最大保证金使用率
  },
};
```

---

## 🧪 测试

```bash
# 运行回测示例
cd quant-lab
bun tests/backtest-simple-ma.ts

# 运行Paper Trading示例
bun tests/live-paper-trading.ts

# 运行实盘示例（需谨慎）
bun tests/run-gales-live.ts
```

---

## 📚 相关文档

- [执行层](../execution/README.md)
- [Providers](../providers/README.md)
- [系统架构](../../docs/SYSTEM_OVERVIEW.md)
- [策略手册](../../docs/TRADER_MANUAL.md)

---

*最后更新: 2026-02-21*
