# Gales 策略压力测试文档

## 概述

本文档描述 Gales 网格策略的压力测试场景和验证步骤，确保策略在极端市场条件和异常情况下仍能稳定运行。

## 1. 高频心跳压力场景（快速价格波动）

### 测试目的
验证策略在高频价格变动下的处理能力和性能表现。

### 测试环境
```bash
# 使用模拟模式运行
bun tests/run-strategy-generic.ts ./strategies/gales-simple.js --demo '{"symbol":"MYXUSDT"}' bybit wjcgm@bbt-sub1
```

### 测试步骤

#### 1.1 基础高频测试
```javascript
// 修改心跳间隔为100ms（原5000ms）
const heartbeatInterval = setInterval(async () => {
  // ... 心跳逻辑
}, 100); // 100ms = 10次/秒
```

**验证点**：
- [ ] 策略无内存泄漏
- [ ] CPU占用率 < 50%
- [ ] 无未捕获异常

#### 1.2 价格闪崩/闪涨模拟
```javascript
// 模拟价格快速变化
const priceScenarios = [
  { type: 'flash_crash', drop: 0.10, duration: 5000 },  // 10%闪崩
  { type: 'flash_pump', rise: 0.15, duration: 3000 },   // 15%闪涨
  { type: 'whiplash', moves: [-0.05, 0.05, -0.03, 0.03] }, // 来回鞭打
];
```

**验证点**：
- [ ] 熔断机制正确触发
- [ ] 网格订单正确取消/重建
- [ ] 仓位计算准确

#### 1.3 极端波动率测试
```javascript
// 模拟高频大幅波动
for (let i = 0; i < 1000; i++) {
  const volatility = 0.05 + Math.random() * 0.10; // 5-15%波动
  const direction = Math.random() > 0.5 ? 1 : -1;
  price = price * (1 + direction * volatility);
  // 触发心跳
  await strategy.onTick({ price, timestamp: Date.now() }, context);
}
```

**预期结果**：
- 策略运行稳定，无崩溃
- 熔断机制按预期触发
- 日志无ERROR级别错误

---

## 2. 熔断触发/恢复测试步骤

### 测试目的
验证回撤熔断机制在高频场景下的正确性。

### 测试配置
```javascript
const CONFIG = {
  circuitBreaker: {
    enabled: true,
    maxDrawdown: 0.40,      // 40%回撤熔断
    cooldownAfterTrip: 600, // 10分钟冷却
  }
};
```

### 测试步骤

#### 2.1 回撤熔断触发测试
```bash
# 步骤1: 启动策略并建立持仓
DRY_RUN=false bun tests/run-strategy-generic.ts ./strategies/gales-simple.js --live '{"symbol":"MYXUSDT"}' bybit wjcgm@bbt-sub1

# 步骤2: 模拟价格下跌40%
# 观察日志应出现:
# [熔断触发-回撤] drawdown=40.01% | hwm=10000.00 | pos=5999.00
```

**验证点**：
- [ ] `circuitBreakerState.tripped = true`
- [ ] `circuitBreakerState.reason = '回撤熔断'`
- [ ] 所有活跃订单被取消
- [ ] TG告警已发送给9号和1号

#### 2.2 熔断冷却期测试
```javascript
// 模拟冷却期内尝试下单
const cb = circuitBreakerState;
assert(cb.tripped === true);
assert((Date.now() - cb.tripAt) / 1000 < 600); // < 10分钟
// 尝试下单应该被拒绝
```

**验证点**：
- [ ] 冷却期内`checkCircuitBreaker()`返回true
- [ ] 新订单被阻止
- [ ] 每5分钟输出一次熔断提醒日志

#### 2.3 熔断自动恢复测试
```javascript
// 模拟冷却期结束且仓位恢复
circuitBreakerState.tripAt = Date.now() - 601 * 1000; // 601秒前触发
effectivePosition = highWaterMark * 0.5; // 仓位降至50%

// 检查恢复
const result = checkCircuitBreaker();
assert(result === false); // 熔断已解除
assert(circuitBreakerState.tripped === false);
assert(circuitBreakerState.recoveryTickCount === 0);
```

**验证点**：
- [ ] 连续3个心跳满足恢复条件后自动恢复
- [ ] `highWaterMark`重置为当前仓位
- [ ] TG通知"熔断恢复"

---

## 3. 杠杆硬顶触发测试

### 测试目的
验证杠杆硬顶机制在accountLeverageRatio超限时的正确行为。

### 测试配置
```javascript
const CONFIG = {
  leverageHardCap: {
    enabled: true,
    maxLeverage: 3.0,  // 3倍杠杆硬顶
  }
};
```

### 测试步骤

#### 3.1 硬顶触发测试
```javascript
// 模拟杠杆达到3.0x
state.riskMetrics.accountLeverageRatio = 3.1;

// 触发检查
checkLeverageHardCap();

// 验证
assert(circuitBreakerState.blockNewOrders === true);
assert(circuitBreakerState.leverageHardCapTriggeredAt > 0);
```

**验证点**：
- [ ] `blockNewOrders`设置为true
- [ ] 日志输出:`[杠杆硬顶触发] 当前杠杆=3.10x >= 阈值=3.00x`
- [ ] TG告警已发送

#### 3.2 硬顶阻止下单测试
```javascript
// 硬顶状态下尝试下单
const shouldSuspend = shouldSuspendGridTrading();
assert(shouldSuspend === true);
```

**验证点**：
- [ ] `shouldSuspendGridTrading()`返回true
- [ ] `processPendingOrders()`跳过后续逻辑
- [ ] 现有持仓和订单不受影响

#### 3.3 硬顶自动恢复测试
```javascript
// 模拟杠杆降至2.5x（恢复阈值=3.0*0.9=2.7x）
state.riskMetrics.accountLeverageRatio = 2.5;

// 触发检查
checkLeverageHardCap();

// 验证恢复
assert(circuitBreakerState.blockNewOrders === false);
assert(circuitBreakerState.leverageHardCapTriggeredAt === 0);
```

**验证点**：
- [ ] 杠杆<2.7x时自动恢复
- [ ] 日志输出:`[杠杆硬顶恢复]`
- [ ] 新订单恢复正常

---

## 4. 网格重置场景

### 测试目的
验证网格重置功能在各种条件下的正确性。

### 测试场景

#### 4.1 自动重心重置
```javascript
// 触发条件：
// 1. autoRecenter: true
// 2. 中心价漂移 > recenterDistance (3%)
// 3. 连续30个tick无下单
// 4. 超过recenterCooldownSec (10分钟)

state.centerPrice = 100;
state.lastPrice = 104; // 漂移4%
state.lastPlaceTick = state.tickCount - 35; // 35个tick前下单
state.lastRecenterAtMs = Date.now() - 11 * 60 * 1000; // 11分钟前
```

**验证点**：
- [ ] `autoRecenter()`被触发
- [ ] 网格中心价更新为当前价
- [ ] 所有活跃订单被取消
- [ ] 新网格重新建立

#### 4.2 手动方向切换
```javascript
// 从short切换为neutral
CONFIG.direction = 'neutral';

// 触发应急方向切换
checkEmergencyDirectionSwitch();
```

**验证点**：
- [ ] 持仓方向正确调整
- [ ] 网格方向正确翻转
- [ ] 状态持久化到state

#### 4.3 紧急熔断后重置
```bash
# 1. 触发熔断
kill -SIGUSR1 <PID>  # 热更新时可能触发

# 2. 检查状态
# circuitBreakerState.tripped应重置

# 3. 验证网格重建
# 网格应基于当前价格重新建立
```

---

## 5. 进程重启状态恢复验证

### 测试目的
验证策略重启后状态正确恢复，无数据丢失或状态不一致。

### 测试步骤

#### 5.1 正常重启恢复
```bash
# 步骤1: 运行策略一段时间建立状态
bun tests/run-strategy-generic.ts ./strategies/gales-simple.js --live ...

# 步骤2: 记录关键状态
# - runId
# - positionNotional
# - gridLevels状态
# - openOrders

# 步骤3: 优雅停止 (Ctrl+C或SIGTERM)

# 步骤4: 重新启动
# 验证state从持久化加载
```

**验证点**：
- [ ] `loadState()`成功加载state
- [ ] `positionNotional`恢复正确
- [ ] `gridLevels`状态恢复
- [ ] `circuitBreakerState`重置（highWaterMark=0, tripped=false）
- [ ] `orderSeq`继续累加（不重复）

#### 5.2 异常中断恢复
```bash
# 步骤1: 运行策略

# 步骤2: 强制kill (模拟崩溃)
kill -9 <PID>

# 步骤3: 重新启动
# 检查日志中是否有[saveState]事务性保存失败的记录
```

**验证点**：
- [ ] 最近一次`saveState()`的数据已持久化
- [ ] 无数据损坏（JSON可解析）
- [ ]  gracefully降级到初始状态（如持久化损坏）

#### 5.3 多字段状态一致性
```javascript
// 验证以下字段恢复一致性
const criticalFields = [
  'positionNotional',
  'exchangePosition',
  'totalProfit',
  'gridLevels',
  'openOrders',
  'circuitBreakerState',
  'positionDiffState', // P2新增
];
```

**验证点**：
- [ ] 所有关键字段值合理（非null/undefined/NaN）
- [ ] `positionDiffState`7字段完整恢复
- [ ] `riskMetrics`重新计算正确

#### 5.4 重启后orderLinkId唯一性
```bash
# 验证重启后orderLinkId不会与重启前冲突
# orderLinkId格式: gales-{symbol}-{direction}-{runId}-g{gridId}a{attempt}-{side}
# runId变化确保唯一性
```

**验证点**：
- [ ] 新runId与旧runId不同
- [ ] 遗留订单检测正确识别旧run订单
- [ ] 新订单orderLinkId无重复

---

## 自动化测试脚本

```bash
#!/bin/bash
# stress-test.sh - Gales策略压力测试套件

echo "=== Gales策略压力测试 ==="

# 测试1: 高频心跳
echo "[TEST 1] 高频心跳压力测试..."
bun tests/stress-test-high-frequency.ts

# 测试2: 熔断触发/恢复
echo "[TEST 2] 熔断触发/恢复测试..."
bun tests/stress-test-circuit-breaker.ts

# 测试3: 杠杆硬顶
echo "[TEST 3] 杠杆硬顶测试..."
bun tests/stress-test-leverage-cap.ts

# 测试4: 网格重置
echo "[TEST 4] 网格重置测试..."
bun tests/stress-test-grid-reset.ts

# 测试5: 进程重启
echo "[TEST 5] 进程重启状态恢复测试..."
bun tests/stress-test-restart-recovery.ts

echo "=== 测试完成 ==="
```

---

## 预期性能指标

| 场景 | 指标 | 预期值 |
|-----|------|--------|
| 高频心跳 | CPU占用 | < 50% |
| 高频心跳 | 内存增长 | < 10MB/小时 |
| 熔断恢复 | 恢复延迟 | < 15秒（3个心跳） |
| 状态恢复 | 加载时间 | < 100ms |
| 网格重建 | 重建时间 | < 500ms |

---

*文档版本: 2025-02-21*  
*对应代码: quant-lab/strategies/gales-simple.js*
