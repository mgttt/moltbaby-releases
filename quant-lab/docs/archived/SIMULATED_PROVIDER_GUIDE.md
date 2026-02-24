# SimulatedProvider 使用指南

> **给 bot-004**: 这是快速策略验证工具，可以将 Gales 策略验证从"数小时等待行情"变成"几秒钟完成"。

---

## 🚀 快速开始

### 1. 测试 Gales 策略（推荐场景）

```bash
cd /home/devali/moltbaby/quant-lab

# 场景 1: 区间震荡后下跌（测试 autoRecenter）
bun tests/run-simulated-strategy.ts ./strategies/gales-simple.js \
  --scenario range-then-dump \
  --speed 100

# 场景 2: 正弦波动（测试网格成交）
bun tests/run-simulated-strategy.ts ./strategies/gales-simple.js \
  --scenario sine-wave \
  --speed 100

# 场景 3: 高频振荡（测试订单密集度）
bun tests/run-simulated-strategy.ts ./strategies/gales-simple.js \
  --scenario high-volatility \
  --speed 100
```

### 2. 自定义参数

```bash
# 随机游走（高波动率）
bun tests/run-simulated-strategy.ts ./strategies/gales-simple.js \
  --mode random-walk \
  --volatility 0.02 \
  --speed 50

# 正弦波动（自定义振幅）
bun tests/run-simulated-strategy.ts ./strategies/gales-simple.js \
  --mode sine \
  --speed 200
```

---

## 📊 内置场景说明

| 场景 | 适用场景 | 预期结果 | 时长 (100x) |
|------|---------|---------|------------|
| `range-then-dump` | 测试 autoRecenter | 价格脱离网格后自动重新定位 | 66 秒 |
| `sine-wave` | 测试网格成交 | 买卖订单来回成交 10+ 次 | 60 秒 |
| `slow-drift` | 测试持仓暴露 | 单边持仓累积 | 60 秒 |
| `pump-then-dump` | 测试双向网格 | 先做空后做多 | 42 秒 |
| `gap-down` | 测试跳空 | 异常处理（大幅偏离网格） | 48 秒 |
| `high-volatility` | 测试高频 | 订单频繁挂撤 | 30 秒 |
| `extreme-dump` | 测试风控 | 触发最大持仓限制 | 39 秒 |

---

## 🎯 典型验证流程

### Step 1: 功能验证（快速模式）

```bash
# 正弦波动 200x 加速（3 秒完成）
bun tests/run-simulated-strategy.ts ./strategies/gales-simple.js \
  --scenario sine-wave \
  --speed 200
```

**观察点**:
- ✅ 策略正常启动
- ✅ 网格订单正确挂单
- ✅ 订单正常成交
- ✅ 无错误日志

### Step 2: 边界测试（关键场景）

```bash
# 场景 1: 区间震荡后下跌
bun tests/run-simulated-strategy.ts ./strategies/gales-simple.js \
  --scenario range-then-dump \
  --speed 100
```

**观察点**:
- ✅ 价格脱离网格后是否自动 reposition
- ✅ 旧订单是否正确撤销
- ✅ 新网格是否正确定位

```bash
# 场景 2: 跳空下跌
bun tests/run-simulated-strategy.ts ./strategies/gales-simple.js \
  --scenario gap-down \
  --speed 100
```

**观察点**:
- ✅ 异常价格跳动是否触发风控
- ✅ 持仓是否超出限制
- ✅ 策略是否崩溃

### Step 3: 压力测试（高频场景）

```bash
# 高频振荡 + 1000x 加速
bun tests/run-simulated-strategy.ts ./strategies/gales-simple.js \
  --scenario high-volatility \
  --speed 1000
```

**观察点**:
- ✅ 高频挂撤单是否稳定
- ✅ 内存占用是否正常
- ✅ CPU 占用是否正常

---

## 🔍 调试技巧

### 1. 慢速观察（10x 加速）

```bash
bun tests/run-simulated-strategy.ts ./strategies/gales-simple.js \
  --scenario range-then-dump \
  --speed 10
```

每秒对应真实 10 秒，可以清楚观察策略行为。

### 2. 单步调试（暂不支持，待实现）

```bash
# TODO: 实现 --step 模式
bun tests/run-simulated-strategy.ts ./strategies/gales-simple.js \
  --mode sine \
  --step
```

### 3. 查看价格序列

在代码中添加价格监听：

```typescript
provider.onPrice((price: number) => {
  console.log(`[Price] ${price.toFixed(2)}`);
});
```

### 4. 查看订单事件

在代码中添加订单监听：

```typescript
provider.onOrder((order: any) => {
  console.log(`[Order] ${order.status} ${order.side} ${order.qty} @ ${order.price}`);
});
```

---

## 💡 性能优化建议

### 1. 快速迭代（1000x 加速）

```bash
# 10 分钟场景 → 0.6 秒完成
bun tests/run-simulated-strategy.ts ./strategies/gales-simple.js \
  --scenario sine-wave \
  --speed 1000
```

**适用**: 功能验证、回归测试

### 2. 正常速度（100x 加速）

```bash
# 10 分钟场景 → 6 秒完成
bun tests/run-simulated-strategy.ts ./strategies/gales-simple.js \
  --scenario sine-wave \
  --speed 100
```

**适用**: 边界测试、日志观察

### 3. 慢速观察（10x 加速）

```bash
# 10 分钟场景 → 60 秒完成
bun tests/run-simulated-strategy.ts ./strategies/gales-simple.js \
  --scenario sine-wave \
  --speed 10
```

**适用**: 调试、理解策略行为

---

## 📝 自定义场景示例

创建自定义场景（TypeScript）：

```typescript
import { SimulatedProvider } from './src/providers';
import type { Scenario } from './src/providers';

const myScenario: Scenario = {
  name: 'Custom Test',
  description: '自定义测试场景',
  startPrice: 100,
  phases: [
    // 阶段 1: 区间震荡 3 分钟
    {
      type: 'range',
      durationSec: 180,
      price: 100,
      range: 0.02, // ±2%
    },
    // 阶段 2: 快速拉升 1 分钟 +5%
    {
      type: 'pump',
      durationSec: 60,
      change: 0.05,
    },
    // 阶段 3: 缓慢下跌 5 分钟 -8%
    {
      type: 'dump',
      durationSec: 300,
      change: -0.08,
    },
    // 阶段 4: 新区间震荡
    {
      type: 'range',
      durationSec: 180,
      price: 97,
      range: 0.015,
    },
  ],
};

const provider = new SimulatedProvider({
  mode: 'scenario',
  startPrice: 100,
  scenario: myScenario,
  speed: 100,
});
```

---

## ⚠️ 注意事项

### 1. 与真实行情的差异

| 特性 | SimulatedProvider | 真实行情 |
|------|------------------|---------|
| 订单延迟 | 即时成交 | 网络延迟 |
| 滑点 | 无 | 有 |
| 深度 | 无限 | 有限 |
| 撤单 | 即时 | 延迟 |

**建议**: 用 SimulatedProvider 验证逻辑，用真实行情验证性能。

### 2. 价格生成随机性

场景中有随机噪声，每次运行结果略有不同。这是**正常的**，模拟真实市场的不确定性。

### 3. 时间加速限制

- 太快（>1000x）可能导致事件丢失
- 推荐：功能验证 100x-1000x，调试 10x-50x

---

## 🎁 使用场景对照表

| 你的需求 | 推荐场景 | 加速 |
|---------|---------|------|
| 验证网格成交 | `sine-wave` | 100x |
| 验证 autoRecenter | `range-then-dump` | 100x |
| 验证风控 | `extreme-dump` | 100x |
| 验证高频订单 | `high-volatility` | 100x |
| 调试策略逻辑 | `sine-wave` | 10x |
| 快速回归测试 | 所有场景 | 1000x |

---

## 📞 问题反馈

如果遇到问题：

1. 检查策略文件路径是否正确
2. 检查场景名称是否拼写正确
3. 尝试降低 `speed` 参数观察详细行为
4. 查看完整文档：`src/providers/simulated/README.md`

---

**祝测试顺利！🎉**

—— bot-001
