# Quant-Lab - 策略运行时引擎

> **版本**: v3.0 (2026-02-19)  
> **核心**: Strategy Interface + Backtest/Live Engines + Trading Providers

统一的量化策略回测和实盘引擎，支持事件驱动架构和多交易所。

---

## 📖 核心文档（一跳到达）

| 文档 | 说明 | 必读人群 | 链接 |
|------|------|----------|------|
| **快速开始** | 5分钟上手指南 | 新手必读 | [→ 查看](./docs/QUICKSTART.md) |
| **产品说明书** | 功能介绍、部署指南 | 所有人 | [→ 查看](./docs/PRODUCT_MANUAL.md) |
| **策略操盘手册** | 策略开发、实盘操作 | 操盘手/开发者 | [→ 查看](./docs/TRADER_MANUAL.md) |
| **开发路线图** | 版本规划、迭代计划 | 开发者 | [→ 查看](./docs/ROADMAP.md) |
| **系统架构** | 架构总览、模块关系 | 架构师 | [→ 查看](./docs/SYSTEM_OVERVIEW.md) |
| **技术架构** | 详细技术设计 | 开发者 | [→ 查看](./ARCHITECTURE.md) |

---

## 🎯 核心特性

- ✅ **统一策略接口**：回测和实盘使用相同代码
- ✅ **事件驱动**：`onInit` / `onBar` / `onTick` / `onOrder` / `onStop`
- ✅ **回测引擎**：历史数据回放 + 完整指标（回报/回撤/夏普/胜率/盈亏比）
- ✅ **实盘引擎**：WebSocket 订阅 + Provider 集成 + 风控管理
- ✅ **Trading Providers**：Paper（模拟）✅ / Binance 📝 / Bybit 📝
- ✅ **仓位管理**：LONG/SHORT/FLAT + 开/加/减/平/反手
- ✅ **风控**：最大仓位 + 最大回撤限制 + 自动停止

---

## 🏗️ 架构

```
Strategy 接口 (统一代码)
    ├── BacktestEngine (历史回测)
    │   ├── 事件驱动回放
    │   ├── 仓位管理 (LONG/SHORT/FLAT)
    │   ├── 订单执行 (MARKET/LIMIT + 手续费 + 滑点)
    │   ├── 盈亏跟踪 (已实现 + 未实现)
    │   ├── 权益曲线记录
    │   └── 回测指标 (回报/回撤/夏普/胜率/盈亏比)
    │
    └── LiveEngine (实盘交易)
        ├── WebSocket K线订阅
        ├── Provider 集成 (可选)
        ├── 订单执行
        ├── 风控管理 (最大仓位/回撤限制)
        └── 状态持久化

TradingProvider (交易所适配器)
    ├── PaperTradingProvider ✅ (模拟交易)
    ├── BinanceProvider 📝 (Binance 现货)
    └── BybitProvider 📝 (Bybit 合约)
```

---

## 🚀 快速开始

### 1. 策略接口

```typescript
import type { Strategy, StrategyContext } from 'quant-lab';
import type { Kline } from 'quant-lib';

class MyStrategy implements Strategy {
  name = 'MyStrategy';
  
  async onInit(ctx: StrategyContext): Promise<void> {
    ctx.log('策略初始化');
  }
  
  async onBar(bar: Kline, ctx: StrategyContext): Promise<void> {
    // 策略逻辑
    const account = ctx.getAccount();
    const position = ctx.getPosition(bar.symbol);
    
    // 买入/卖出
    if (/* 买入条件 */) {
      await ctx.buy(bar.symbol, quantity);
    }
    
    if (/* 卖出条件 */) {
      await ctx.sell(bar.symbol, quantity);
    }
  }
}
```

**StrategyContext API**：
- `getAccount()` - 获取账户信息
- `getPosition(symbol)` - 获取持仓
- `buy(symbol, quantity, price?)` - 买入
- `sell(symbol, quantity, price?)` - 卖出
- `getLastBar(symbol)` - 获取最新 K线
- `getBars(symbol, limit)` - 获取历史 K线
- `log(message, level?)` - 日志输出

---

### 2. 回测

```typescript
import { BacktestEngine } from 'quant-lab';
import { KlineDatabase } from 'quant-lib';

const db = new KlineDatabase({ path: './data/ndtsdb' });
await db.init();

const config = {
  initialBalance: 10000,
  symbols: ['BTC/USDT'],
  interval: '1d',
  startTime: 1672531200, // 2023-01-01
  endTime: 1704067200,   // 2024-01-01
  commission: 0.001,      // 0.1%
  slippage: 0.0005,       // 0.05%
};

const strategy = new MyStrategy();
const engine = new BacktestEngine(db, strategy, config);

const result = await engine.run();

console.log(`总回报: ${(result.totalReturn * 100).toFixed(2)}%`);
console.log(`最大回撤: ${(result.maxDrawdown * 100).toFixed(2)}%`);
console.log(`胜率: ${(result.winRate * 100).toFixed(2)}%`);
```

---

### 3. 实盘（模拟交易）

```typescript
import { LiveEngine } from 'quant-lab';
import { PaperTradingProvider } from 'quant-lab';

const provider = new PaperTradingProvider({
  initialBalance: 10000,
  commission: 0.001,
  slippage: 0.0005,
});

const config = {
  symbols: ['BTC/USDT'],
  interval: '1d',
  maxPositionSize: 1.0,    // 最大持仓 1 BTC
  maxDrawdown: 0.20,       // 最大回撤 20%
};

const strategy = new MyStrategy();
const engine = new LiveEngine(strategy, config, provider);

await engine.start();

// Provider 会推送 K线
// 策略会自动执行

// 停止
await engine.stop();
```

---

### 4. 实盘（真实交易所）

```typescript
import { BinanceProvider } from 'quant-lab';

const provider = new BinanceProvider({
  apiKey: 'YOUR_API_KEY',
  apiSecret: 'YOUR_API_SECRET',
  testnet: true,  // 使用测试网
});

const engine = new LiveEngine(strategy, config, provider);
await engine.start();

// Provider 会自动订阅 K线 + 执行订单
```

**注意**：BinanceProvider / BybitProvider 目前是框架代码（标注 TODO），需要实现 WebSocket + REST API。参考 `src/providers/README.md`。

---

## 📁 项目结构

```
quant-lab/
├── src/
│   ├── engine/
│   │   ├── types.ts          # 类型定义
│   │   ├── backtest.ts       # 回测引擎
│   │   ├── live.ts           # 实盘引擎
│   │   └── index.ts          # 统一导出
│   └── providers/
│       ├── paper-trading.ts  # ✅ 模拟交易（完整）
│       ├── binance.ts        # 📝 Binance（框架 + TODO）
│       ├── bybit.ts          # 📝 Bybit（框架 + TODO）
│       ├── index.ts          # 导出
│       └── README.md         # 实现指南
│
├── tests/
│   ├── backtest-simple-ma.ts      # 回测示例（双均线）
│   ├── live-simple-ma.ts          # 实盘示例（无 Provider）
│   ├── live-paper-trading.ts     # 实盘示例（Paper Provider）
│   └── generate-test-data.ts     # 测试数据生成
│
├── archived/
│   └── v2.0-director-worker/     # 旧架构归档
│
├── README.md                       # 本文件
└── ROADMAP.md                      # 开发路线图
```

---

## 📊 示例策略

### SimpleMAStrategy（双均线交叉）

- 快线：MA5
- 慢线：MA20
- 金叉买入：`fast > slow && prevFast <= prevSlow`
- 死叉卖出：`fast < slow && prevFast >= prevSlow`

**测试文件**：
- `tests/backtest-simple-ma.ts` - 回测
- `tests/live-paper-trading.ts` - 实盘（Paper）

---

## 🔌 Trading Providers

| Provider | 状态 | 功能 | 文档 |
|----------|------|------|------|
| **PaperTradingProvider** | ✅ **完整** | 模拟交易（手续费 + 滑点） | `src/providers/README.md` |
| **BinanceProvider** | 📝 **框架** | Binance 现货（需实现 API） | `src/providers/binance.ts` |
| **BybitProvider** | 📝 **框架** | Bybit 合约（需实现 API） | `src/providers/bybit.ts` |

**实现 Provider**：参考 `src/providers/README.md` 和 `paper-trading.ts`。

---

## 🎓 与旧架构的区别

### 旧架构（v2.0，已归档）

```
Director Service + Worker Pool + QuickJS Sandbox
```

- 复杂的三层架构
- 策略运行在 QuickJS 沙盒中
- 需要 HTTP API + Worker 管理
- 配置复杂

### 新架构（v3.0，当前）

```
Strategy Interface + Backtest/Live Engines + Providers
```

- 简洁的两层架构
- 策略直接实现 TypeScript 接口
- 统一的回测和实盘代码
- 易于测试和调试

**迁移指南**：参考 `archived/v2.0-director-worker/README.md`

---

## 📖 完整文档索引

### 入门文档
| 文档 | 说明 | 路径 |
|------|------|------|
| 快速开始 | 5分钟上手指南 | [`docs/QUICKSTART.md`](./docs/QUICKSTART.md) |
| 产品说明书 | 功能介绍、部署指南、Gales策略 | [`docs/PRODUCT_MANUAL.md`](./docs/PRODUCT_MANUAL.md) |
| 策略操盘手册 | 策略开发、实盘操作、配置卡 | [`docs/TRADER_MANUAL.md`](./docs/TRADER_MANUAL.md) |

### 架构文档
| 文档 | 说明 | 路径 |
|------|------|------|
| 系统架构总览 | 全局架构、数据流 | [`docs/SYSTEM_OVERVIEW.md`](./docs/SYSTEM_OVERVIEW.md) |
| 技术架构 | v3.0详细设计 | [`ARCHITECTURE.md`](./ARCHITECTURE.md) |
| 目录结构 | 项目结构说明 | [`DIRECTORY_STRUCTURE.md`](./DIRECTORY_STRUCTURE.md) |
| 设计文档 | 轻量级引擎设计 | [`DESIGN.md`](./DESIGN.md) |

### 模块文档
| 模块 | 说明 | 路径 |
|------|------|------|
| 引擎层 | 回测/实盘引擎 | [`src/engine/README.md`](./src/engine/README.md) |
| 执行层 | 订单通道、风控、熔断 | [`src/execution/README.md`](./src/execution/README.md) |
| Providers | 交易所适配 | [`src/providers/README.md`](./src/providers/README.md) |
| 测试脚本 | 测试说明 | [`tests/README.md`](./tests/README.md) |

### 路线图与规划
| 文档 | 说明 | 路径 |
|------|------|------|
| 开发路线图 | v3.0路线图 | [`docs/ROADMAP.md`](./docs/ROADMAP.md) |
| 进化路线图 | P0-P4详细规划 | [`docs/EVOLUTION_ROADMAP.md`](./docs/EVOLUTION_ROADMAP.md) |

### 策略与运维
| 文档 | 说明 | 路径 |
|------|------|------|
| 策略开发指南 | QuickJS策略编写 | [`STRATEGY_GUIDE.md`](./STRATEGY_GUIDE.md) |
| Gales策略复盘 | Paper Trade分析 | [`docs/GALES_STRATEGY_RELEASE_NOTE.md`](./docs/GALES_STRATEGY_RELEASE_NOTE.md) |
| 熔断增强方案 | P0/P1/P2实现 | [`docs/CIRCUIT_BREAKER_ENHANCEMENT_PLAN.md`](./docs/CIRCUIT_BREAKER_ENHANCEMENT_PLAN.md) |

---

## 🤝 贡献

欢迎贡献代码！优先级：
1. 实现 BinanceProvider / BybitProvider（WebSocket + REST API）
2. 补充示例策略（网格/马丁/趋势跟踪等）
3. 完善测试覆盖
4. 添加策略可视化

---

## 📄 License

MIT

---

*维护者: OpenClaw 🦀*  
*版本: v3.0 (2026-02-10)*
