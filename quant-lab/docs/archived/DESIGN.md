# Quant-Lab 设计文档

> 策略实验室 - 轻量级量化策略执行引擎

---

## 核心理念

**动态语言范式**：
```typescript
result = await eval(code, globals, locals)
```

策略就是代码，配置就是参数，账号就是上下文。

---

## 架构设计

### 1. 目录结构

```
quant-lab/
├── DESIGN.md              # 本文件
├── README.md              # 使用文档
├── strategies/            # 策略代码目录
│   ├── examples/          # 示例策略
│   │   ├── grid-simple.ts
│   │   ├── dca-btc.ts
│   │   └── arbitrage.ts
│   └── active/            # 活跃策略（生产使用）
│       └── .gitkeep
├── pools/                 # 策略池配置
│   ├── pool-dev.jsonl     # 开发环境策略池
│   ├── pool-test.jsonl    # 测试环境策略池
│   └── pool-prod.jsonl    # 生产环境策略池
├── runtime/               # 运行时数据（不提交 Git）
│   ├── state/             # 策略状态持久化
│   ├── logs/              # 策略日志
│   └── metrics/           # 性能指标
├── src/                   # 引擎核心代码（未来实现）
│   ├── engine.ts          # 策略执行引擎
│   ├── pool.ts            # 策略池管理
│   ├── context.ts         # 运行时上下文
│   └── cli.ts             # 命令行工具
└── scripts/               # 工具脚本
    ├── start.ts           # 启动策略
    ├── stop.ts            # 停止策略
    └── monitor.ts         # 监控面板
```

---

## 2. 策略池配置格式

### 单个策略配置

```jsonl
{
  "id": "grid-btc-v1",
  "name": "BTC 网格策略 v1",
  "enabled": true,
  "account": "bybit-test",
  "code": "strategies/active/grid-btc.ts",
  "params": {
    "symbol": "BTC/USDT",
    "grid_spacing": 0.5,
    "max_position_usd": 5000,
    "grid_levels": 10
  },
  "schedule": "*/5 * * * *",  // 每5分钟执行（可选）
  "meta": {
    "author": "devali",
    "created_at": "2026-02-06",
    "risk_level": "medium"
  }
}
```

### 策略池文件示例 (pool-test.jsonl)

```jsonl
{"id":"grid-btc-v1","enabled":true,"account":"bybit-test","code":"strategies/active/grid-btc.ts","params":{"symbol":"BTC/USDT","grid_spacing":0.5}}
{"id":"dca-eth-v1","enabled":false,"account":"bybit-test","code":"strategies/examples/dca-btc.ts","params":{"symbol":"ETH/USDT","interval":"1h"}}
{"id":"arb-bybit-binance","enabled":true,"account":"bybit-test","code":"strategies/active/arbitrage.ts","params":{"pair":"BTC/USDT","threshold":0.003}}
```

---

## 3. 策略代码规范

### 标准策略接口

```typescript
// strategies/active/grid-btc.ts
import type { StrategyContext, StrategyResult } from '@/types';

/**
 * 网格策略 - BTC
 * 
 * 参数：
 * - symbol: 交易对
 * - grid_spacing: 网格间距（%）
 * - max_position_usd: 最大持仓（USD）
 */
export async function run(ctx: StrategyContext): Promise<StrategyResult> {
  const { bybit, logger, params, state } = ctx;
  
  logger.info(`Running grid strategy for ${params.symbol}`);
  
  // 1. 获取当前价格
  const ticker = await bybit.getTicker(params.symbol);
  const currentPrice = ticker.last;
  
  // 2. 获取持仓
  const position = await bybit.getPosition(params.symbol);
  
  // 3. 计算网格
  const grids = calculateGrids(currentPrice, params.grid_spacing, params.grid_levels);
  
  // 4. 执行交易逻辑
  const orders = [];
  for (const grid of grids) {
    if (shouldPlaceOrder(grid, position, params)) {
      const order = await bybit.placeOrder({
        symbol: params.symbol,
        side: grid.side,
        price: grid.price,
        quantity: grid.quantity
      });
      orders.push(order);
    }
  }
  
  // 5. 更新状态
  state.lastPrice = currentPrice;
  state.lastRunAt = Date.now();
  
  return {
    success: true,
    actions: orders.length,
    message: `Placed ${orders.length} orders`,
    data: { orders, grids }
  };
}

// 辅助函数
function calculateGrids(price, spacing, levels) { /* ... */ }
function shouldPlaceOrder(grid, position, params) { /* ... */ }
```

### 运行时上下文 (StrategyContext)

```typescript
interface StrategyContext {
  // API 客户端（根据 account 自动注入）
  bybit: BybitAPI;
  
  // 日志器（自动包含策略 ID）
  logger: Logger;
  
  // 策略参数（来自配置）
  params: Record<string, any>;
  
  // 策略状态（持久化，跨运行保留）
  state: Record<string, any>;
  
  // 元数据
  meta: {
    strategyId: string;
    account: string;
    runCount: number;
    lastRunAt: number;
  };
}
```

### 策略返回值 (StrategyResult)

```typescript
interface StrategyResult {
  success: boolean;
  actions?: number;           // 执行的操作数
  message?: string;           // 简短描述
  data?: Record<string, any>; // 详细数据
  error?: Error;              // 错误信息
}
```

---

## 4. 动态执行引擎设计

### 核心执行流程

```typescript
// src/engine.ts
export class StrategyEngine {
  async runStrategy(config: StrategyConfig): Promise<StrategyResult> {
    // 1. 加载策略代码（动态 import）
    const strategyModule = await this.loadStrategy(config.code);
    
    // 2. 构建运行时上下文
    const context = await this.buildContext(config);
    
    // 3. 执行策略（类似 eval）
    const result = await strategyModule.run(context);
    
    // 4. 持久化状态
    await this.saveState(config.id, context.state);
    
    // 5. 记录日志和指标
    await this.logResult(config.id, result);
    
    return result;
  }
  
  private async loadStrategy(codePath: string) {
    // 动态加载策略模块（支持热重载）
    return await import(codePath + `?t=${Date.now()}`);
  }
  
  private async buildContext(config: StrategyConfig): Promise<StrategyContext> {
    // 根据 account 加载对应的 API 客户端
    const bybit = this.getBybitAPI(config.account);
    
    // 加载持久化状态
    const state = await this.loadState(config.id);
    
    // 构建日志器
    const logger = this.createLogger(config.id);
    
    return {
      bybit,
      logger,
      params: config.params,
      state,
      meta: {
        strategyId: config.id,
        account: config.account,
        runCount: state._runCount || 0,
        lastRunAt: state._lastRunAt || 0
      }
    };
  }
  
  private getBybitAPI(accountName: string): BybitAPI {
    const accountConfig = loadAccount(accountName); // 从 ~/env.jsonl 加载
    
    // 简单的权限检查
    const api = new BybitAPI(accountConfig);
    if (accountConfig.readonly) {
      api.disableTrading(); // 禁用交易方法
    }
    
    return api;
  }
}
```

---

## 5. CLI 工具设计

### 基础命令

```bash
# 启动策略
bun lab start <strategy-id> [--pool=dev|test|prod]

# 停止策略
bun lab stop <strategy-id>

# 列出所有策略
bun lab list [--pool=dev|test|prod] [--status=running|stopped|all]

# 查看策略状态
bun lab status <strategy-id>

# 查看策略日志
bun lab logs <strategy-id> [--tail=100] [--follow]

# 测试策略（模拟运行，不实际交易）
bun lab test <strategy-id> [--dry-run]

# 启用/禁用策略
bun lab enable <strategy-id>
bun lab disable <strategy-id>
```

### 输出示例

```bash
$ bun lab list --pool=test

┌─────────────────────┬─────────┬──────────────┬──────────┬─────────────────┐
│ ID                  │ Status  │ Account      │ Actions  │ Last Run        │
├─────────────────────┼─────────┼──────────────┼──────────┼─────────────────┤
│ grid-btc-v1         │ Running │ bybit-test   │ 12       │ 2 minutes ago   │
│ dca-eth-v1          │ Stopped │ bybit-test   │ -        │ -               │
│ arb-bybit-binance   │ Running │ bybit-test   │ 3        │ 30 seconds ago  │
└─────────────────────┴─────────┴──────────────┴──────────┴─────────────────┘

$ bun lab status grid-btc-v1

Strategy: grid-btc-v1 (BTC 网格策略 v1)
Status: Running
Account: bybit-test
Schedule: */5 * * * * (every 5 minutes)

Last Run:
  Time: 2026-02-06 18:15:32
  Result: Success
  Actions: 12 orders placed
  Duration: 1.2s

State:
  lastPrice: 42350.5
  totalOrders: 156
  totalVolume: $125,000

Performance (24h):
  PnL: +$234.56 (+1.87%)
  Trades: 48
  Win Rate: 62.5%
```

---

## 6. 账号安全机制

### 简化的权限控制

```typescript
// src/context.ts
class BybitAPIWrapper {
  constructor(private config: AccountConfig, private api: BybitAPI) {}
  
  // 读取方法：无限制
  async getTicker(...args) { return this.api.getTicker(...args); }
  async getPosition(...args) { return this.api.getPosition(...args); }
  
  // 交易方法：只读账号拦截
  async placeOrder(...args) {
    if (this.config.readonly) {
      throw new Error(`Account ${this.config.name} is read-only`);
    }
    
    // 检查资金上限
    const exposure = await this.calculateExposure();
    if (exposure > this.config.maxPositionUsd) {
      throw new Error(`Position limit exceeded: $${exposure} > $${this.config.maxPositionUsd}`);
    }
    
    return this.api.placeOrder(...args);
  }
  
  async cancelOrder(...args) {
    if (this.config.readonly) {
      throw new Error(`Account ${this.config.name} is read-only`);
    }
    return this.api.cancelOrder(...args);
  }
}
```

---

## 7. 状态持久化

### 简单的文件系统存储

```typescript
// runtime/state/grid-btc-v1.json
{
  "_runCount": 156,
  "_lastRunAt": 1738867532000,
  "lastPrice": 42350.5,
  "totalOrders": 156,
  "totalVolume": 125000,
  "gridLevels": [
    { "price": 42100, "side": "buy", "filled": true },
    { "price": 42300, "side": "sell", "filled": false }
  ]
}
```

---

## 8. 实施计划

### Phase 1: 核心引擎（1-2天）
- [ ] 策略池加载器 (pool.ts)
- [ ] 运行时上下文构建 (context.ts)
- [ ] 策略执行引擎 (engine.ts)
- [ ] 状态持久化（JSON 文件）

### Phase 2: CLI 工具（1天）
- [ ] 基础命令 (start/stop/list/status)
- [ ] 日志查看
- [ ] 干跑模式 (dry-run)

### Phase 3: 示例策略（1天）
- [ ] 网格策略 (grid-simple.ts)
- [ ] 定投策略 (dca-btc.ts)
- [ ] 套利策略框架 (arbitrage.ts)

### Phase 4: 监控和告警（未来）
- [ ] 实时性能指标
- [ ] Telegram 告警
- [ ] Web 监控面板

---

## 9. 与 quant-lib 的关系

| 功能 | quant-lib | quant-lab |
|------|-----------|-----------|
| 定位 | 数据采集与分析工具库 | 策略执行引擎 |
| 核心 | Providers + Database | Engine + Pool |
| 产物 | K线数据、波动率报告 | 策略执行结果、交易日志 |
| 依赖 | 独立（被 lab 依赖） | 依赖 quant-lib 的 Providers |

**关系**：
```
quant-lab (strategies) 
    ↓ imports
quant-lib (BybitProvider, TradingViewProvider, ...)
    ↓ imports
scripts/lib/env.ts (账号配置加载)
```

---

## 10. 关键设计原则

1. **简单优于复杂**
   - 不需要复杂的 AccountManager
   - 策略就是普通 TypeScript 文件
   - 配置就是 JSONL（人类可读可编辑）

2. **动态优于静态**
   - 策略代码可以热加载（修改立即生效）
   - 运行时注入上下文（account/params/state）
   - 类似 eval 的执行范式

3. **安全优于性能**
   - 账号权限在 API 层检查
   - 资金上限硬编码限制
   - 只读账号无法交易

4. **可观测优于黑盒**
   - 所有操作记录日志
   - 状态持久化可检查
   - CLI 工具可实时查看

---

## 11. API 错误处理策略

### 核心原则

**读写分离处理**：读操作可重试，写操作不重试。

### 读操作（查询类）

- **范围**：查行情、查仓位、查订单、查账户余额
- **错误类型**：SSL 错误、网络超时、连接断开、429 限流
- **处理策略**：自动重试 1 次（exponential backoff）
- **理由**：读操作幂等，重试不会产生副作用

```typescript
async getTicker(symbol: string): Promise<Ticker> {
  return this.retryableRequest(
    () => this.api.getTicker(symbol),
    { maxRetries: 1, backoff: 1000 }
  );
}

async getPosition(symbol: string): Promise<Position> {
  return this.retryableRequest(
    () => this.api.getPosition(symbol),
    { maxRetries: 1, backoff: 1000 }
  );
}
```

### 写操作（交易类）

- **范围**：下单、撤单、改单、转账
- **错误类型**：任何异常（网络、API 错误、业务错误）
- **处理策略**：不重试 → 抛出异常 → 调用者查询实际状态再决策
- **理由**：写操作非幂等，重试可能导致重复下单/撤单

```typescript
async placeOrder(params: OrderParams): Promise<Order> {
  try {
    return await this.api.placeOrder(params); // 不重试
  } catch (error) {
    // 抛出异常，调用者负责处理
    throw new TradingError(
      `Failed to place order: ${error.message}`,
      { cause: error, params }
    );
  }
}

async cancelOrder(orderId: string): Promise<void> {
  try {
    await this.api.cancelOrder(orderId); // 不重试
  } catch (error) {
    throw new TradingError(
      `Failed to cancel order: ${error.message}`,
      { cause: error, orderId }
    );
  }
}
```

### 策略层错误处理范式

```typescript
// ❌ 错误示例：写操作自动重试
async function badExample(ctx: StrategyContext) {
  try {
    await ctx.bybit.placeOrder({ ... });
  } catch (error) {
    // 危险：可能重复下单
    await ctx.bybit.placeOrder({ ... }); 
  }
}

// ✅ 正确示例：异常后查询状态再决策
async function goodExample(ctx: StrategyContext) {
  let order;
  try {
    order = await ctx.bybit.placeOrder({ 
      symbol: 'BTC/USDT',
      side: 'buy',
      price: 42000,
      quantity: 0.01,
      clientOrderId: `grid-${Date.now()}`  // 幂等 ID
    });
  } catch (error) {
    ctx.logger.error(`Place order failed: ${error.message}`);
    
    // 查询订单状态（通过 clientOrderId）
    const existingOrder = await ctx.bybit.getOrderByClientId(
      `grid-${Date.now()}`
    );
    
    if (existingOrder) {
      // 订单已存在（可能是网络延迟）
      ctx.logger.warn(`Order already exists: ${existingOrder.orderId}`);
      order = existingOrder;
    } else {
      // 订单确实没有创建，根据策略决定是否重试
      if (shouldRetry(error)) {
        order = await ctx.bybit.placeOrder({ ... }); // 手动重试
      } else {
        throw error; // 放弃
      }
    }
  }
  
  return order;
}

function shouldRetry(error: Error): boolean {
  // 只重试明确的临时性错误
  const retryableErrors = [
    'ETIMEDOUT',
    'ECONNRESET',
    'RATE_LIMIT',
  ];
  
  return retryableErrors.some(code => error.message.includes(code));
}
```

### 幂等性设计

**最佳实践**：所有写操作使用 `clientOrderId`（客户端生成的唯一 ID）

```typescript
// 策略层生成幂等 ID
const clientOrderId = `${ctx.meta.strategyId}-${Date.now()}-${nonce()}`;

// 下单时传入
await ctx.bybit.placeOrder({
  symbol: 'BTC/USDT',
  side: 'buy',
  price: 42000,
  quantity: 0.01,
  clientOrderId  // 关键：幂等标识
});

// 异常后通过 clientOrderId 查询状态
const order = await ctx.bybit.getOrderByClientId(clientOrderId);
if (order) {
  // 订单已存在，不需要重试
  return order;
}
```

### 错误分类与处理矩阵

| 错误类型 | 读操作 | 写操作 | 示例 |
|---------|--------|--------|------|
| 网络超时 | 重试 1 次 | 不重试，查询状态 | ETIMEDOUT |
| SSL 错误 | 重试 1 次 | 不重试，查询状态 | SSL_ERROR |
| 429 限流 | 重试 1 次（backoff） | 不重试，延迟后手动重试 | RATE_LIMIT |
| 业务错误 | 抛异常 | 抛异常 | INSUFFICIENT_BALANCE |
| 未知错误 | 抛异常 | 抛异常 | - |

### 实现示例（Provider 层）

```typescript
// quant-lib/src/providers/bybit.ts
export class BybitProvider {
  // 读操作：自动重试
  async getTicker(symbol: string): Promise<Ticker> {
    return this.retryableGet('/v5/market/tickers', { symbol });
  }
  
  async getPosition(symbol: string): Promise<Position> {
    return this.retryableGet('/v5/position/list', { symbol });
  }
  
  // 写操作：不重试
  async placeOrder(params: OrderParams): Promise<Order> {
    return this.nonRetryablePost('/v5/order/create', params);
  }
  
  async cancelOrder(orderId: string): Promise<void> {
    return this.nonRetryablePost('/v5/order/cancel', { orderId });
  }
  
  // 内部方法
  private async retryableGet(endpoint: string, params: any): Promise<any> {
    let lastError;
    for (let i = 0; i < 2; i++) { // 最多 2 次（原始 + 重试 1 次）
      try {
        return await this.request('GET', endpoint, params);
      } catch (error) {
        lastError = error;
        if (i === 0 && this.isRetryable(error)) {
          await this.sleep(1000 * (i + 1)); // exponential backoff
          continue;
        }
        break;
      }
    }
    throw lastError;
  }
  
  private async nonRetryablePost(endpoint: string, params: any): Promise<any> {
    return this.request('POST', endpoint, params); // 不重试
  }
  
  private isRetryable(error: Error): boolean {
    const retryableCodes = ['ETIMEDOUT', 'ECONNRESET', 'SSL_ERROR'];
    return retryableCodes.some(code => error.message.includes(code));
  }
}
```

---

**文档版本**: v0.2  
**最后更新**: 2026-02-13  
**状态**: 设计阶段（未实现）
