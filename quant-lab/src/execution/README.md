# Execution 执行层

> 订单执行、风控与容错处理模块

**版本**: v3.0  
**路径**: `quant-lab/src/execution/`  
**维护**: bot-001/bot-00a

---

## 📋 模块总览

执行层负责订单从发出到成交的全生命周期管理，包括：

- **订单通道管理** - 断线重连、状态同步
- **重试与熔断** - 高可用容错机制
- **风控管理** - 杠杆硬顶、仓位限制
- **订单状态** - CANCEL_RACE防护、状态机

```
┌─────────────────────────────────────────────────────────────┐
│                      Execution 执行层                        │
├─────────────┬─────────────┬─────────────┬───────────────────┤
│   Channel   │Retry Policy │  Circuit    │   Risk Manager    │
│  订单通道   │  重试策略   │  熔断器     │    风险管理       │
├─────────────┼─────────────┼─────────────┼───────────────────┤
│ 断线重连    │ 指数退避    │ 故障隔离    │ 杠杆硬顶          │
│ 状态同步    │ 错误分类    │ 自动恢复    │ 降仓触发          │
│ 配置持久化  │ 99.99% SLA  │ HALF_OPEN   │ 仓位限制          │
└─────────────┴─────────────┴─────────────┴───────────────────┘
```

---

## 🚀 快速开始

### 1. 订单通道（Channel）

```typescript
import { OrderChannel, OrderChannelConfigManager } from './channel';

// 创建配置管理器
const configManager = new OrderChannelConfigManager();

// 创建订单通道
const channel = new OrderChannel({
  channelId: 'bybit-main',
  endpoint: 'wss://stream.bybit.com/v5/public',
  apiKey: 'your-api-key',
});

// 连接并监听状态
await channel.connect({
  onConnect: () => console.log('Connected'),
  onDisconnect: () => console.log('Disconnected'),
  onError: (err) => console.error('Error:', err),
});

// 发送订单（带自动重试）
await channel.sendOrder({
  symbol: 'BTCUSDT',
  side: 'Buy',
  qty: 0.1,
  price: 50000,
});
```

### 2. 重试策略（Retry Policy）

```typescript
import { RetryPolicy, ErrorClassifier } from './retry-policy';

// 创建重试策略
const retryPolicy = new RetryPolicy({
  maxRetries: 5,
  baseDelayMs: 100,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  errorClassifier: ErrorClassifier.createDefault(),
  circuitBreaker: {
    failureThreshold: 5,
    resetTimeout: 30000,
  },
});

// 执行带重试的操作
const result = await retryPolicy.execute(async () => {
  return await exchange.placeOrder(order);
});
```

### 3. 风控管理（Risk Manager）

```typescript
import { createPositionRiskManager } from './position-risk-manager';

// 创建风控管理器
const riskManager = createPositionRiskManager({
  symbol: 'BTCUSDT',
  maxLeverage: 5.0,
  maxPositionValue: 100000,
  maxMarginUsage: 80,
  warningLeverage: 3.0,
  reduceLeverage: 3.5,
  targetLeverage: 2.5,
});

// 注册降仓执行器
riskManager.onReduce(async (action) => {
  console.log(`触发降仓: ${action.reduceQty}`);
  const result = await exchange.reducePosition(action.reduceQty);
  
  riskManager.confirmReduce(action.actionId, {
    executed: result.success,
    executionPrice: result.price,
  });
  
  return result.success;
});

// 更新持仓触发风控检查
const result = await riskManager.updatePosition({
  size: 1.0,
  entryPrice: 50000,
  markPrice: 51000,
  side: 'LONG',
  availableMargin: 15000,
});

if (result.reduceInitiated) {
  console.log('自动降仓已触发');
}
```

---

## 📦 模块清单

| 文件 | 功能 | 状态 | 说明 |
|------|------|------|------|
| `channel.ts` | 订单通道 | ✅ | 断线重连、状态同步 |
| `retry-policy.ts` | 重试策略 | ✅ | 指数退避、99.99% SLA |
| `circuit-breaker.ts` | 熔断器 | ✅ | CLOSED/OPEN/HALF_OPEN |
| `leverage-limiter.ts` | 杠杆硬顶 | ✅ | 最大杠杆限制 |
| `position-reducer.ts` | 降仓状态机 | ✅ | IDLE→WARNING→REDUCE→RECOVERY |
| `position-risk-manager.ts` | 风险集成层 | ✅ | 统一风控入口 |
| `cancel-race-handler.ts` | Cancel Race防护 | ✅ | 零CANCEL_RACE |
| `grid-cleaner.ts` | 网格清理 | ✅ | 残留订单清理 |
| `api-key-manager.ts` | API Key管理 | ✅ | 多Key轮换 |
| `agent.ts` | 执行Agent接口 | ✅ | Agent抽象定义 |
| `execution-agent-impl.ts` | 执行Agent实现 | ✅ | 具体实现 |

---

## 🔧 核心概念

### 1. 订单通道状态机

```
CONNECTED → DISCONNECTED → RECONNECTING → CONNECTED
                ↓
             FAILED (超过最大重试次数)
```

### 2. 熔断器状态机

```
CLOSED (正常)
   ↓ 失败次数 > threshold
OPEN (熔断)
   ↓ 超时后
HALF_OPEN (试探)
   ↓ 成功
CLOSED (恢复)
```

### 3. 降仓状态机

```
IDLE → WARNING (lev > 3.0) → REDUCE (lev > 3.5) → RECOVERY → IDLE
       ↑___________________________________________|
```

### 4. 错误分类

| 错误类型 | 重试策略 | 示例 |
|----------|----------|------|
| 可重试错误 | 指数退避重试 | 网络超时、429限流 |
| 业务错误 | 不重试 | 余额不足、参数错误 |
| 致命错误 | 立即熔断 | API Key失效 |

---

## 📝 配置示例

### 订单通道配置

```json
{
  "channelId": "bybit-main",
  "endpoint": "wss://stream.bybit.com/v5/public",
  "apiKey": "***",
  "lastConnected": 1704067200000,
  "status": "CONNECTED"
}
```

### 重试策略配置

```typescript
{
  maxRetries: 5,
  baseDelayMs: 100,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  jitter: true,
  circuitBreaker: {
    failureThreshold: 5,
    successThreshold: 3,
    resetTimeout: 30000,
  }
}
```

### 风控配置

```typescript
{
  symbol: 'BTCUSDT',
  maxLeverage: 5.0,
  maxPositionValue: 100000,
  maxMarginUsage: 80,
  warningLeverage: 3.0,  // 预警阈值
  reduceLeverage: 3.5,   // 强制降仓阈值
  targetLeverage: 2.5,   // 目标杠杆
  maxReduceRatio: 0.3,   // 单次最大减仓30%
  cooldownMs: 60000,     // 降仓冷却时间
}
```

---

## 🧪 测试

```bash
# 运行所有执行层测试
cd quant-lab
bun test src/execution/*.test.ts

# 单独测试某个模块
bun test src/execution/channel.test.ts
bun test src/execution/retry-policy.test.ts
bun test src/execution/position-reducer.test.ts
```

---

## 📚 相关文档

- [系统架构](../../docs/SYSTEM_OVERVIEW.md)
- [产品说明书](../../docs/PRODUCT_MANUAL.md)
- [策略手册](../../docs/TRADER_MANUAL.md)
- [熔断增强方案](../../docs/CIRCUIT_BREAKER_ENHANCEMENT_PLAN.md)

---

*最后更新: 2026-02-21*
