# 量化系统三层审查报告

**版本**: 1.0  
**审查日期**: 2026-02-12  
**审查员**: bot-001  
**触发原因**: 实盘准备暴露多个设计缺陷

---

## 执行摘要

本次审查针对量化系统三层架构（策略层/系统层/数据层）进行了全面审查，重点关注已知问题和潜在风险。**发现 9 个问题（3 个 P0、4 个 P1、2 个 P2）**，其中 P0 问题必须在实盘前修复。

### 关键发现

| 问题 | 等级 | 影响范围 | 修复优先级 |
|------|------|----------|-----------|
| autoRecenter 满仓死锁 | **P0** | 策略层 | 立即修复 |
| 单边风险无硬性熔断 | **P0** | 策略层 + 系统层 | 立即修复 |
| 订单状态同步缺失 | **P0** | 系统层 | 立即修复 |
| 非对称网格参数验证不足 | **P1** | 策略层 | 1-2 天 |
| Provider 异常恢复不完善 | **P1** | 系统层 | 1-2 天 |
| API 账号配置文档缺失 | **P1** | 文档 | 1 天 |
| 仓位计算无原子性保护 | **P1** | 策略层 | 1-2 天 |
| 数据源切换无自动测试 | **P2** | 数据层 | 3-5 天 |
| 压缩性能评估数据单一 | **P2** | 数据层 | 可延后 |

---

## 1. 策略层审查 (quant-lab/strategies/)

### 问题 1.1: autoRecenter 满仓死锁 ⚠️⚠️⚠️ **P0**

**症状**: 
- MYX paper trade 单边暴跌 -42% 被套
- 满仓后无法触发 autoRecenter
- 价格继续下跌，策略完全卡死

**根本原因**:

```javascript
// gales-simple.js 第 XXX 行
if (CONFIG.autoRecenter) {
  const drift = Math.abs(state.lastPrice - center) / center;
  const noActiveOrders = countActiveOrders() === 0;  // ← 问题在这里
  
  if (drift >= CONFIG.recenterDistance && 
      idleTicks >= CONFIG.recenterMinIdleTicks && 
      cooldownOk && 
      noActiveOrders) {  // ← 必须无活跃订单才能重心
    // 重心逻辑
  }
}
```

**问题分析**:

1. **满仓时的死锁循环**:
   ```
   价格下跌 → 买单满仓（拒绝挂单）→ 只有卖单活跃
   → countActiveOrders() > 0 → autoRecenter 被阻塞
   → 价格继续下跌 → 网格脱离更远 → 策略失效
   ```

2. **设计缺陷**:
   - autoRecenter 条件要求"无活跃订单"
   - 但满仓时，卖单可能一直存在（等待价格反弹）
   - 导致永远无法满足"无活跃订单"的条件

3. **实际影响**:
   - MYX 单边暴跌 -42%（从 1.5 → 0.87）
   - 买单满仓后无法 recenter
   - 卖单挂在高位，永远无法成交
   - 仓位被套，无法自动修复

**修复方案**:

```javascript
// 修复 1: 放宽重心条件（允许单边订单时重心）
if (CONFIG.autoRecenter) {
  const drift = Math.abs(state.lastPrice - center) / center;
  
  // 新条件：无活跃订单 OR 满仓且单边订单
  const noActiveOrders = countActiveOrders() === 0;
  const fullPositionStuck = (
    (state.positionNotional >= CONFIG.maxPosition && hasOnlyActiveSellOrders()) ||
    (state.positionNotional <= -CONFIG.maxPosition && hasOnlyActiveBuyOrders())
  );
  
  if (drift >= CONFIG.recenterDistance && 
      idleTicks >= CONFIG.recenterMinIdleTicks && 
      cooldownOk && 
      (noActiveOrders || fullPositionStuck)) {  // ← 修复
    
    logWarn('[满仓自动重心] posNotional=' + state.positionNotional.toFixed(2) + 
            ' drift=' + (drift * 100).toFixed(2) + '%');
    
    // 强制撤销所有订单（包括卖单）
    cancelAllOrders();
    
    // 重心并重建网格
    state.centerPrice = state.lastPrice;
    initializeGrids();
    state.lastRecenterAtMs = Date.now();
    state.lastRecenterTick = state.tickCount;
    state.lastPlaceTick = state.tickCount;
    
    saveState();
    return;
  }
}

// 辅助函数
function hasOnlyActiveSellOrders() {
  if (!state.openOrders || state.openOrders.length === 0) return false;
  return state.openOrders.every(o => 
    o.status === 'Filled' || o.status === 'Canceled' || o.side === 'Sell'
  );
}

function hasOnlyActiveBuyOrders() {
  if (!state.openOrders || state.openOrders.length === 0) return false;
  return state.openOrders.every(o => 
    o.status === 'Filled' || o.status === 'Canceled' || o.side === 'Buy'
  );
}

function cancelAllOrders() {
  for (let i = 0; i < state.openOrders.length; i++) {
    const o = state.openOrders[i];
    if (!o || o.status === 'Filled' || o.status === 'Canceled') continue;
    cancelOrder(findGridById(o.gridId));
  }
  state.openOrders = state.openOrders.filter(o => 
    o.status === 'Filled' || o.status === 'Canceled'
  );
}
```

**修复 2: 方向模式应急切换**

```javascript
// 配置增强：允许动态切换方向
CONFIG.emergencyDirection = 'auto';  // auto/long/short/neutral

// 满仓检测 + 自动切换方向
function checkEmergencyDirectionSwitch() {
  if (CONFIG.emergencyDirection !== 'auto') return;
  
  // 买满仓 → 强制切换到 long 模式（只做多）
  if (state.positionNotional >= CONFIG.maxPosition * 0.9) {
    if (CONFIG.direction !== 'long') {
      logWarn('[应急切换] 买满仓 → long 模式');
      CONFIG.direction = 'long';
      saveState();
    }
  }
  
  // 卖满仓 → 强制切换到 short 模式（只做空）
  if (state.positionNotional <= -CONFIG.maxPosition * 0.9) {
    if (CONFIG.direction !== 'short') {
      logWarn('[应急切换] 卖满仓 → short 模式');
      CONFIG.direction = 'short';
      saveState();
    }
  }
  
  // 仓位回到安全区 → 恢复 neutral
  if (Math.abs(state.positionNotional) < CONFIG.maxPosition * 0.5) {
    if (CONFIG.direction !== 'neutral') {
      logInfo('[应急切换] 仓位安全 → neutral 模式');
      CONFIG.direction = 'neutral';
      saveState();
    }
  }
}

// 在 st_heartbeat 中调用
function st_heartbeat(tickJson) {
  // ...
  
  checkEmergencyDirectionSwitch();  // ← 新增
  
  // ...
}
```

**测试计划**:

1. **模拟场景 1: 单边暴跌满仓**
   ```typescript
   // SimulatedProvider scenario: 'free-fall' (45% 跌幅)
   const scenario = {
     type: 'price-shock',
     direction: 'down',
     amplitude: 0.45,
     duration: 60,  // 60 秒
   };
   ```

2. **模拟场景 2: 满仓后反弹**
   ```typescript
   const scenario = {
     type: 'v-shape',
     downAmplitude: 0.40,
     upAmplitude: 0.20,
     downDuration: 60,
     upDuration: 120,
   };
   ```

3. **验收标准**:
   - ✅ 满仓后 autoRecenter 能触发
   - ✅ 重心后网格重新激活
   - ✅ 方向模式自动切换生效
   - ✅ 最大回撤 < 50%

---

### 问题 1.2: 单边风险无硬性熔断 ⚠️⚠️⚠️ **P0**

**症状**:
- MYX 暴跌 -42% 被套，策略未触发熔断
- 仓位一直累积到满仓

**根本原因**:

当前风控仅在**下单前**检查仓位限制，但没有**全局熔断机制**：

```javascript
// 当前逻辑：仅在 shouldPlaceOrder 中检查
if (grid.side === 'Buy') {
  const afterFill = state.positionNotional + pendingBuy + orderNotional;
  if (afterFill > CONFIG.maxPosition) {
    return false;  // 拒绝下单
  }
}
```

**问题**:
1. ❌ 没有"回撤熔断"（如 -30% 停止交易）
2. ❌ 没有"仓位熔断"（如 90% 满仓时告警）
3. ❌ 没有"价格偏离熔断"（如偏离中心 50% 时暂停）

**修复方案**:

```javascript
// 配置增强：熔断机制
CONFIG.circuitBreaker = {
  maxDrawdown: 0.30,          // 最大回撤 30%
  maxPositionRatio: 0.90,     // 仓位使用率 90%
  maxPriceDrift: 0.50,        // 价格偏离中心 50%
  cooldownAfterTrip: 600,     // 熔断后冷却 10 分钟
};

// 熔断状态
let circuitBreakerState = {
  tripped: false,
  reason: '',
  tripAt: 0,
  highWaterMark: 0,  // 最高权益（用于计算回撤）
};

// 熔断检查
function checkCircuitBreaker() {
  if (!CONFIG.circuitBreaker) return false;
  
  const now = Date.now();
  const cb = CONFIG.circuitBreaker;
  
  // 冷却期内不重复检查
  if (circuitBreakerState.tripped) {
    const elapsed = (now - circuitBreakerState.tripAt) / 1000;
    if (elapsed < cb.cooldownAfterTrip) {
      return true;  // 仍在冷却期
    }
    
    // 冷却期结束，重置熔断
    logWarn('[熔断恢复] 冷却期结束，恢复交易');
    circuitBreakerState.tripped = false;
    circuitBreakerState.reason = '';
    return false;
  }
  
  // 1. 回撤熔断
  if (circuitBreakerState.highWaterMark === 0) {
    circuitBreakerState.highWaterMark = state.equity || CONFIG.maxPosition;
  }
  
  const equity = state.positionNotional + (state.balance || 0);
  if (equity > circuitBreakerState.highWaterMark) {
    circuitBreakerState.highWaterMark = equity;
  }
  
  const drawdown = (circuitBreakerState.highWaterMark - equity) / circuitBreakerState.highWaterMark;
  if (drawdown > cb.maxDrawdown) {
    circuitBreakerState.tripped = true;
    circuitBreakerState.reason = '回撤熔断';
    circuitBreakerState.tripAt = now;
    
    logWarn('[熔断触发] 回撤熔断 drawdown=' + (drawdown * 100).toFixed(2) + '%');
    
    // 撤销所有订单
    cancelAllOrders();
    
    return true;
  }
  
  // 2. 仓位熔断
  const positionRatio = Math.abs(state.positionNotional) / CONFIG.maxPosition;
  if (positionRatio > cb.maxPositionRatio) {
    circuitBreakerState.tripped = true;
    circuitBreakerState.reason = '仓位熔断';
    circuitBreakerState.tripAt = now;
    
    logWarn('[熔断触发] 仓位熔断 positionRatio=' + (positionRatio * 100).toFixed(2) + '%');
    
    // 撤销所有订单
    cancelAllOrders();
    
    return true;
  }
  
  // 3. 价格偏离熔断
  if (state.centerPrice > 0) {
    const drift = Math.abs(state.lastPrice - state.centerPrice) / state.centerPrice;
    if (drift > cb.maxPriceDrift) {
      circuitBreakerState.tripped = true;
      circuitBreakerState.reason = '价格偏离熔断';
      circuitBreakerState.tripAt = now;
      
      logWarn('[熔断触发] 价格偏离熔断 drift=' + (drift * 100).toFixed(2) + '%');
      
      // 不撤单（价格可能快速恢复），但停止新下单
      return true;
    }
  }
  
  return false;
}

// 在 st_heartbeat 开始时检查
function st_heartbeat(tickJson) {
  // ...
  
  // 熔断检查（最高优先级）
  if (checkCircuitBreaker()) {
    // 熔断中，跳过所有交易逻辑
    if (state.tickCount % 60 === 0) {  // 每 5 分钟提醒一次
      logWarn('[熔断中] 原因: ' + circuitBreakerState.reason);
    }
    return;
  }
  
  // ...正常交易逻辑
}
```

**配置示例**:

```json
{
  "circuitBreaker": {
    "maxDrawdown": 0.30,
    "maxPositionRatio": 0.90,
    "maxPriceDrift": 0.50,
    "cooldownAfterTrip": 600
  }
}
```

**测试计划**:

1. **场景 1: 回撤熔断**
   - 初始权益: $10,000
   - 跌幅: -35%
   - 预期: 触发熔断，停止交易

2. **场景 2: 仓位熔断**
   - maxPosition: $100
   - 累积仓位: $95
   - 预期: 触发熔断，撤销订单

3. **场景 3: 价格偏离熔断**
   - 中心价格: $1.50
   - 当前价格: $0.70（-53%）
   - 预期: 触发熔断，停止新下单

---

### 问题 1.3: 非对称网格参数验证不足 **P1**

**症状**:
- bot-004 添加了非对称网格支持
- 但参数验证不完善

**代码审查**:

```javascript
// gales-simple.js
const spacingDown = CONFIG.gridSpacingDown !== null ? CONFIG.gridSpacingDown : CONFIG.gridSpacing;
const spacingUp = CONFIG.gridSpacingUp !== null ? CONFIG.gridSpacingUp : CONFIG.gridSpacing;
const orderSizeDown = CONFIG.orderSizeDown !== null ? CONFIG.orderSizeDown : CONFIG.orderSize;
const orderSizeUp = CONFIG.orderSizeUp !== null ? CONFIG.orderSizeUp : CONFIG.orderSize;
```

**潜在问题**:

1. **参数合理性检查缺失**:
   ```javascript
   // ❌ 没有检查：spacing 是否 > 0
   // ❌ 没有检查：spacing 是否过大（如 > 50%）
   // ❌ 没有检查：orderSize 是否 > 0
   // ❌ 没有检查：orderSize 是否超过余额
   ```

2. **非对称比例失衡风险**:
   ```javascript
   // 如果用户配置：
   CONFIG.gridSpacingDown = 0.10;  // 跌 10% 一档
   CONFIG.gridSpacingUp = 0.01;    // 涨 1% 一档
   
   // 结果：买单间距过大，卖单间距过小
   // → 跌幅大时买入不及时
   // → 涨幅小时卖单密集（资金利用率低）
   ```

3. **magnetDistance 适配缺失**:
   ```javascript
   // 当前逻辑：magnetDistance 统一应用于所有网格
   // 问题：非对称网格需要非对称 magnetDistance
   ```

**修复方案**:

```javascript
// 参数验证
function validateConfig() {
  const errors = [];
  
  // 1. 基础参数
  if (CONFIG.gridCount <= 0) errors.push('gridCount 必须 > 0');
  if (CONFIG.orderSize <= 0) errors.push('orderSize 必须 > 0');
  if (CONFIG.maxPosition <= 0) errors.push('maxPosition 必须 > 0');
  
  // 2. 网格间距
  const spacingDown = CONFIG.gridSpacingDown !== null ? CONFIG.gridSpacingDown : CONFIG.gridSpacing;
  const spacingUp = CONFIG.gridSpacingUp !== null ? CONFIG.gridSpacingUp : CONFIG.gridSpacing;
  
  if (spacingDown <= 0 || spacingDown > 0.5) {
    errors.push('gridSpacingDown 必须在 (0, 0.5] 范围内');
  }
  if (spacingUp <= 0 || spacingUp > 0.5) {
    errors.push('gridSpacingUp 必须在 (0, 0.5] 范围内');
  }
  
  // 3. 非对称比例检查
  const ratio = spacingDown / spacingUp;
  if (ratio > 5 || ratio < 0.2) {
    errors.push('非对称比例过大: ' + ratio.toFixed(2) + 'x（建议 0.2-5x）');
  }
  
  // 4. 订单大小
  const orderSizeDown = CONFIG.orderSizeDown !== null ? CONFIG.orderSizeDown : CONFIG.orderSize;
  const orderSizeUp = CONFIG.orderSizeUp !== null ? CONFIG.orderSizeUp : CONFIG.orderSize;
  
  if (orderSizeDown <= 0) errors.push('orderSizeDown 必须 > 0');
  if (orderSizeUp <= 0) errors.push('orderSizeUp 必须 > 0');
  
  // 5. 磁铁距离
  if (CONFIG.magnetDistance <= 0) errors.push('magnetDistance 必须 > 0');
  if (CONFIG.magnetDistance >= CONFIG.cancelDistance) {
    errors.push('magnetDistance 必须 < cancelDistance');
  }
  
  // 6. 磁铁距离与网格间距关系
  if (CONFIG.magnetDistance < Math.min(spacingDown, spacingUp) * 0.3) {
    errors.push('magnetDistance 过小（建议 >= gridSpacing * 0.3）');
  }
  
  if (errors.length > 0) {
    logWarn('[配置错误] ' + errors.join('; '));
    throw new Error('配置验证失败: ' + errors.join('; '));
  }
  
  logInfo('[配置验证] 通过');
}

// 在 st_init 中调用
function st_init() {
  logInfo('策略初始化...');
  
  validateConfig();  // ← 新增
  
  loadState();
}
```

**非对称 magnetDistance 增强**:

```javascript
// 配置增强
CONFIG.magnetDistanceDown = null;  // 跌方向磁铁距离（可选）
CONFIG.magnetDistanceUp = null;    // 升方向磁铁距离（可选）

// 获取有效磁铁距离
function getEffectiveMagnetDistance(grid) {
  let d = CONFIG.magnetDistance;
  
  // 非对称 magnetDistance
  if (grid.side === 'Buy' && CONFIG.magnetDistanceDown !== null) {
    d = CONFIG.magnetDistanceDown;
  } else if (grid.side === 'Sell' && CONFIG.magnetDistanceUp !== null) {
    d = CONFIG.magnetDistanceUp;
  }
  
  // 相对磁铁比例
  if (CONFIG.magnetRelativeToGrid) {
    const spacing = grid.side === 'Buy' 
      ? (CONFIG.gridSpacingDown !== null ? CONFIG.gridSpacingDown : CONFIG.gridSpacing)
      : (CONFIG.gridSpacingUp !== null ? CONFIG.gridSpacingUp : CONFIG.gridSpacing);
    
    const rel = spacing * (CONFIG.magnetGridRatio || 0);
    if (rel > d) d = rel;
  }
  
  // 避免 magnet >= cancelDistance
  if (CONFIG.cancelDistance && d >= CONFIG.cancelDistance) {
    d = CONFIG.cancelDistance * 0.9;
  }
  
  return d;
}

// 在 shouldPlaceOrder 中使用
function shouldPlaceOrder(grid, distance) {
  const magnet = getEffectiveMagnetDistance(grid);  // ← 修改
  if (distance > magnet) return false;
  
  // ...
}
```

**测试计划**:

1. **测试 1: 参数验证**
   - 输入非法参数（负数、过大值）
   - 预期: 抛出错误，策略拒绝启动

2. **测试 2: 非对称比例**
   - spacingDown = 0.05, spacingUp = 0.01（5x 比例）
   - 验证网格分布合理性

3. **测试 3: 非对称 magnetDistance**
   - magnetDistanceDown = 0.008
   - magnetDistanceUp = 0.004
   - 验证买卖单触发灵敏度差异

---

### 问题 1.4: 仓位计算无原子性保护 **P1**

**症状**:
- Paper trade 中偶尔出现仓位计算不准确
- 多个订单同时成交时，仓位更新可能丢失

**根本原因**:

```javascript
// updatePositionFromFill() 函数
function updatePositionFromFill(side, fillQty, fillPrice) {
  const notional = fillQty * fillPrice;
  
  // ❌ 问题：非原子操作
  if (side === 'Buy') state.positionNotional += notional;
  else state.positionNotional -= notional;
}
```

**问题分析**:

1. **并发更新风险**:
   - WebSocket 推送订单更新（未来实盘）
   - 同时 heartbeat 中模拟成交（paper trade）
   - 两个路径同时调用 `updatePositionFromFill`
   - → 仓位更新可能被覆盖

2. **状态保存时机不一致**:
   ```javascript
   // 场景：订单 A 成交 → 更新仓位 → 未保存
   // 然后：订单 B 成交 → 更新仓位 → 保存
   // 结果：订单 A 的仓位更新丢失
   ```

3. **回滚机制缺失**:
   - 如果订单部分成交后撤单
   - 已更新的仓位无法回滚

**修复方案**:

```javascript
// 事务式仓位更新
function updatePositionTransaction(updates) {
  // updates: [{ side, fillQty, fillPrice, orderId, reason }]
  
  const oldPosition = state.positionNotional;
  let newPosition = oldPosition;
  const log = [];
  
  try {
    for (const update of updates) {
      const notional = update.fillQty * update.fillPrice;
      
      // 方向模式处理
      if (CONFIG.direction === 'long' && update.side === 'Sell') {
        log.push(`[虚仓] long 模式 Sell: -${notional.toFixed(2)}`);
        continue;
      }
      if (CONFIG.direction === 'short' && update.side === 'Buy') {
        log.push(`[虚仓] short 模式 Buy: +${notional.toFixed(2)}`);
        continue;
      }
      
      // 更新仓位
      if (update.side === 'Buy') newPosition += notional;
      else newPosition -= notional;
      
      log.push(`[成交] ${update.side} ${update.fillQty.toFixed(4)} @ ${update.fillPrice.toFixed(4)} | orderId=${update.orderId}`);
    }
    
    // 原子更新
    state.positionNotional = newPosition;
    
    // 日志
    if (log.length > 0) {
      logInfo('[仓位更新] ' + log.join('; ') + ' | 仓位: ' + oldPosition.toFixed(2) + ' → ' + newPosition.toFixed(2));
    }
    
    // 立即保存
    saveState();
    
    return true;
  } catch (e) {
    // 回滚
    state.positionNotional = oldPosition;
    logWarn('[仓位更新失败] 回滚: ' + e);
    return false;
  }
}

// 改造 onOrderUpdate
function onOrderUpdate(order) {
  const local = getOpenOrder(order.orderId);
  if (!local) return;
  
  // 计算增量成交
  const prevCum = local.cumQty || 0;
  const nextCum = order.cumQty || 0;
  const delta = nextCum - prevCum;
  
  // 更新订单状态
  local.status = order.status;
  local.cumQty = nextCum;
  local.avgPrice = order.avgPrice || local.avgPrice || local.price;
  local.updatedAt = Date.now();
  
  // 事务式仓位更新
  if (delta > 0) {
    updatePositionTransaction([{
      side: local.side,
      fillQty: delta,
      fillPrice: local.avgPrice,
      orderId: local.orderId,
      reason: 'fill',
    }]);
  }
}
```

**锁机制（可选）**:

```javascript
// 简单的锁机制（防止并发）
let positionUpdateLock = false;

function updatePositionWithLock(updates) {
  // 自旋等待锁（最多 100ms）
  const startTime = Date.now();
  while (positionUpdateLock) {
    if (Date.now() - startTime > 100) {
      logWarn('[仓位更新] 获取锁超时');
      return false;
    }
  }
  
  positionUpdateLock = true;
  
  try {
    return updatePositionTransaction(updates);
  } finally {
    positionUpdateLock = false;
  }
}
```

**测试计划**:

1. **并发成交测试**:
   - 同时触发 3 个订单成交
   - 验证仓位计算准确性

2. **部分成交 + 撤单测试**:
   - 订单部分成交（30%）
   - 然后撤单
   - 验证仓位不回滚（已成交部分保留）

3. **状态恢复测试**:
   - 策略崩溃重启
   - 验证仓位从持久化状态正确恢复

---

## 2. 系统层审查 (quant-lab/engine/)

### 问题 2.1: 订单状态同步缺失 ⚠️⚠️⚠️ **P0**

**症状**:
- Paper trade 中订单成交后，策略可能未收到 `st_onOrderUpdate` 回调
- 导致策略状态与实际订单状态不一致

**根本原因**:

```typescript
// live.ts 中缺少订单状态轮询
export class LiveEngine {
  // ❌ 问题：没有 pollOrderStatus 方法
  
  private async pollOrderStatus() {
    // 轮询逻辑缺失
  }
}
```

**问题分析**:

1. **WebSocket 订单推送不可靠**:
   - 网络中断 → 订单更新丢失
   - Provider 实现不完整 → 无私有流订阅
   - QuickJS 沙箱 → 无法直接接收 WebSocket 事件

2. **Paper Trading 模拟成交不触发回调**:
   ```javascript
   // gales-simple.js simulateFillsIfNeeded()
   function simulateFillsIfNeeded() {
     // ...
     onOrderUpdate({...});  // ← 只更新内部状态
     // ❌ 没有调用 st_onOrderUpdate
   }
   ```

3. **订单状态不一致**:
   ```
   交易所: 订单已成交
   Provider: 状态未更新（WebSocket 丢失）
   Strategy: 仍然认为订单活跃 → 重复下单
   ```

**修复方案**:

**修复 1: LiveEngine 轮询机制**

```typescript
// live.ts
export class LiveEngine {
  private orderPollInterval = 5000;  // 5 秒轮询一次
  private orderPollTimer?: NodeJS.Timeout;
  
  async start(): Promise<void> {
    // ...
    
    // 启动订单轮询
    this.startOrderPolling();
  }
  
  async stop(): Promise<void> {
    // 停止轮询
    if (this.orderPollTimer) {
      clearInterval(this.orderPollTimer);
      this.orderPollTimer = undefined;
    }
    
    // ...
  }
  
  private startOrderPolling(): void {
    this.orderPollTimer = setInterval(async () => {
      try {
        await this.pollOrderStatus();
      } catch (error) {
        console.error('[LiveEngine] 订单轮询失败:', error);
      }
    }, this.orderPollInterval);
    
    console.log(`[LiveEngine] 订单轮询已启动（间隔 ${this.orderPollInterval}ms）`);
  }
  
  private async pollOrderStatus(): Promise<void> {
    if (!this.provider) return;
    
    // 获取所有持仓品种的活跃订单
    for (const symbol of this.config.symbols) {
      try {
        const orders = await this.provider.getOrders?.(symbol);
        if (!orders) continue;
        
        for (const remoteOrder of orders) {
          // 查找本地订单
          const localOrder = this.orders.find(o => o.id === remoteOrder.id);
          
          if (!localOrder) {
            // 新订单（可能是手动下的），记录
            this.orders.push(remoteOrder);
            console.log(`[LiveEngine] 发现新订单: ${remoteOrder.id}`);
            continue;
          }
          
          // 检查状态变化
          if (localOrder.status !== remoteOrder.status || 
              localOrder.filled !== remoteOrder.filled) {
            
            console.log(`[LiveEngine] 订单状态变化:`, {
              orderId: remoteOrder.id,
              oldStatus: localOrder.status,
              newStatus: remoteOrder.status,
              oldFilled: localOrder.filled,
              newFilled: remoteOrder.filled,
            });
            
            // 更新本地订单
            Object.assign(localOrder, remoteOrder);
            
            // 触发策略回调
            const ctx = this.createContext();
            if (this.strategy.onOrder) {
              await this.strategy.onOrder(remoteOrder, ctx);
            }
          }
        }
      } catch (error) {
        console.error(`[LiveEngine] 轮询 ${symbol} 订单失败:`, error);
      }
    }
  }
}
```

**修复 2: Provider 接口补全**

```typescript
// TradingProvider 接口增强
export interface TradingProvider {
  // ...
  
  // 新增：查询订单
  getOrders?(symbol: string): Promise<Order[]>;
  getOrder?(orderId: string): Promise<Order>;
}
```

**修复 3: PaperTradingProvider 补全**

```typescript
// paper-trading.ts
export class PaperTradingProvider implements TradingProvider {
  // ...
  
  async getOrders(symbol: string): Promise<Order[]> {
    return this.orders.filter(o => 
      o.symbol === symbol && 
      o.status !== 'FILLED' && 
      o.status !== 'CANCELLED'
    );
  }
  
  async getOrder(orderId: string): Promise<Order> {
    const order = this.orders.find(o => o.id === orderId);
    if (!order) throw new Error(`订单不存在: ${orderId}`);
    return order;
  }
}
```

**修复 4: QuickJS 沙箱回调机制**

```typescript
// QuickJSStrategy.ts
export class QuickJSStrategy {
  // ...
  
  async onOrder(order: Order, ctx: StrategyContext): Promise<void> {
    // 调用沙箱中的 st_onOrderUpdate
    const orderJson = JSON.stringify(order);
    
    try {
      await this.callFunction('st_onOrderUpdate', orderJson);
    } catch (error) {
      console.error('[QuickJSStrategy] st_onOrderUpdate 调用失败:', error);
    }
  }
}
```

**测试计划**:

1. **网络中断测试**:
   - 启动实盘（Paper Trade）
   - 模拟网络中断 10 秒
   - 恢复网络
   - 验证: 订单状态自动同步

2. **订单轮询性能测试**:
   - 10 个活跃订单
   - 轮询间隔 5 秒
   - 验证: CPU 占用 < 5%

3. **状态一致性测试**:
   - 手动在交易所取消订单
   - 等待 10 秒
   - 验证: 策略收到取消回调

---

### 问题 2.2: Provider 异常恢复不完善 **P1**

**症状**:
- Bybit WebSocket 连接断开后，自动重连逻辑不完善
- 可能导致行情中断

**代码审查**:

```typescript
// bybit.ts
private handleClose() {
  if (this.shuttingDown) return;
  
  console.log('[BybitProvider] WebSocket 连接关闭');
  
  // ❌ 问题：只是简单重连，没有检查状态
  this.scheduleReconnect();
}

private scheduleReconnect() {
  // ❌ 问题：固定 5 秒重连，没有退避策略
  this.reconnectTimer = setTimeout(() => {
    this.connectWebSocket();
  }, 5000);
}
```

**问题分析**:

1. **重连风暴**:
   - 如果服务器拒绝连接（如 IP 封禁）
   - 每 5 秒重连一次 → 无限循环
   - 可能触发更严格的限制

2. **订阅状态丢失**:
   - 重连后未重新订阅 K 线
   - 导致行情中断

3. **错误日志不足**:
   - 无法判断重连失败原因（网络/API/限流）

**修复方案**:

```typescript
// bybit.ts
export class BybitProvider implements TradingProvider {
  // ...
  
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectBackoff = [1, 2, 5, 10, 30, 60, 120, 300, 600, 900];  // 秒
  
  private handleClose(event: CloseEvent) {
    if (this.shuttingDown) return;
    
    console.log('[BybitProvider] WebSocket 连接关闭:', {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    });
    
    // 清理旧资源
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    
    // 检查是否应该重连
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[BybitProvider] 达到最大重连次数，停止重连');
      return;
    }
    
    // 计算退避时间
    const backoffIndex = Math.min(this.reconnectAttempts, this.reconnectBackoff.length - 1);
    const backoffSec = this.reconnectBackoff[backoffIndex];
    
    console.log(`[BybitProvider] 将在 ${backoffSec} 秒后重连（尝试 ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts}）`);
    
    this.scheduleReconnect(backoffSec * 1000);
  }
  
  private handleError(error: Event) {
    console.error('[BybitProvider] WebSocket 错误:', error);
    
    // 记录错误类型（用于诊断）
    if (error instanceof ErrorEvent) {
      console.error('[BybitProvider] 错误详情:', {
        message: error.message,
        filename: error.filename,
        lineno: error.lineno,
      });
    }
  }
  
  private handleOpen() {
    console.log('[BybitProvider] WebSocket 连接成功');
    
    // 重置重连计数器
    this.reconnectAttempts = 0;
    
    // 重新订阅所有 K 线
    this.resubscribeAll();
    
    // 启动心跳
    this.startHeartbeat();
  }
  
  private resubscribeAll() {
    // 重建订阅列表
    const symbols = Array.from(this.klineCallbacks.keys());
    
    if (symbols.length === 0) {
      console.log('[BybitProvider] 无需重新订阅（无活跃订阅）');
      return;
    }
    
    console.log(`[BybitProvider] 重新订阅 ${symbols.length} 个品种`);
    
    // 重新订阅（复用 subscribeKlines 的逻辑）
    const topics = symbols.map(symbol => 
      `kline.${this.toBybitInterval(this.currentInterval!)}.${symbol}`
    );
    
    this.ws?.send(JSON.stringify({
      op: 'subscribe',
      args: topics,
    }));
  }
  
  private scheduleReconnect(delayMs: number) {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.connectWebSocket();
    }, delayMs);
  }
}
```

**健康检查机制**:

```typescript
// 增强：Provider 健康检查
export class BybitProvider {
  private lastMessageAt = 0;
  private healthCheckInterval = 60000;  // 60 秒
  private healthCheckTimer?: NodeJS.Timeout;
  
  private startHealthCheck() {
    this.healthCheckTimer = setInterval(() => {
      const now = Date.now();
      const elapsed = now - this.lastMessageAt;
      
      if (elapsed > this.healthCheckInterval * 2) {
        console.warn(`[BybitProvider] 健康检查失败: ${elapsed}ms 未收到消息`);
        
        // 主动断开重连
        this.ws?.close();
      }
    }, this.healthCheckInterval);
  }
  
  private handleMessage(event: MessageEvent) {
    this.lastMessageAt = Date.now();
    
    // ...
  }
}
```

**测试计划**:

1. **重连退避测试**:
   - 启动 Provider
   - 手动断开 WebSocket
   - 验证: 重连间隔 1s → 2s → 5s → 10s → ...

2. **订阅恢复测试**:
   - 订阅 3 个品种
   - 断开重连
   - 验证: 3 个品种都恢复订阅

3. **健康检查测试**:
   - 模拟 WebSocket "僵尸连接"（连接存在但无数据）
   - 验证: 120 秒后自动重连

---

## 3. 数据层审查 (quant-lib + ndtsdb)

### 问题 3.1: 数据源切换无自动测试 **P2**

**症状**:
- quant-lib 支持多个数据源（Binance/TradingView/Bybit）
- 但没有自动化测试验证切换逻辑

**问题分析**:

1. **数据源故障无 fallback**:
   ```typescript
   // 当前逻辑：单一数据源
   const provider = new BinanceProvider();
   const klines = await provider.fetchKlines(symbol, interval);
   
   // ❌ 如果 Binance API 故障 → 整个采集失败
   ```

2. **数据格式不一致**:
   - Binance: timestamp 秒
   - TradingView: timestamp 毫秒
   - 需要统一转换

3. **测试覆盖不足**:
   - 没有 Provider 切换的集成测试
   - 没有数据格式兼容性测试

**修复方案**:

**Provider Factory + Fallback**:

```typescript
// quant-lib/src/providers/factory.ts
export class ProviderFactory {
  static create(name: string, config: any): DataProvider {
    switch (name) {
      case 'binance':
        return new BinanceProvider(config);
      case 'tradingview':
        return new TradingViewProvider(config);
      case 'bybit':
        return new BybitProvider(config);
      default:
        throw new Error(`未知数据源: ${name}`);
    }
  }
  
  static createWithFallback(
    primary: string,
    fallbacks: string[],
    config: any
  ): DataProvider {
    const providers = [primary, ...fallbacks].map(name => 
      this.create(name, config)
    );
    
    return new FallbackProvider(providers);
  }
}

// 自动 Fallback Provider
export class FallbackProvider implements DataProvider {
  private providers: DataProvider[];
  private currentIndex = 0;
  
  constructor(providers: DataProvider[]) {
    this.providers = providers;
  }
  
  async fetchKlines(
    symbol: string,
    interval: string,
    start: Date,
    end: Date
  ): Promise<Kline[]> {
    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[(this.currentIndex + i) % this.providers.length];
      
      try {
        console.log(`[FallbackProvider] 尝试数据源: ${provider.constructor.name}`);
        
        const klines = await provider.fetchKlines(symbol, interval, start, end);
        
        // 成功：更新当前数据源
        this.currentIndex = (this.currentIndex + i) % this.providers.length;
        
        console.log(`[FallbackProvider] 数据源成功: ${provider.constructor.name} (${klines.length} 条)`);
        return klines;
      } catch (error) {
        console.warn(`[FallbackProvider] 数据源失败: ${provider.constructor.name}:`, error);
        
        // 继续尝试下一个数据源
        continue;
      }
    }
    
    throw new Error('所有数据源均失败');
  }
}
```

**使用示例**:

```typescript
// 主数据源: Binance，备用: TradingView
const provider = ProviderFactory.createWithFallback(
  'binance',
  ['tradingview'],
  { /* config */ }
);

const klines = await provider.fetchKlines('BTCUSDT', '1m', start, end);
```

**自动化测试**:

```typescript
// quant-lib/tests/provider-fallback.test.ts
import { describe, it, expect } from 'bun:test';
import { ProviderFactory, FallbackProvider } from '../src/providers/factory';

describe('Provider Fallback', () => {
  it('应该在主数据源失败时切换到备用数据源', async () => {
    const provider = ProviderFactory.createWithFallback(
      'binance',  // 假设失败
      ['tradingview'],
      { /* config */ }
    );
    
    const start = new Date('2024-01-01');
    const end = new Date('2024-01-02');
    
    const klines = await provider.fetchKlines('BTCUSDT', '1m', start, end);
    
    expect(klines.length).toBeGreaterThan(0);
  });
  
  it('应该在所有数据源失败时抛出错误', async () => {
    // Mock 所有 Provider 失败
    const provider = new FallbackProvider([
      new MockFailingProvider(),
      new MockFailingProvider(),
    ]);
    
    await expect(
      provider.fetchKlines('BTCUSDT', '1m', new Date(), new Date())
    ).rejects.toThrow('所有数据源均失败');
  });
});
```

---

### 问题 3.2: 压缩性能评估数据单一 **P2**

**症状**:
- ndtsdb 压缩测试只用了模拟数据
- 没有真实市场数据的压缩率评估

**问题分析**:

1. **真实数据压缩率未知**:
   - 当前测试: 73.3%（Gorilla）
   - 但真实价格波动可能不同

2. **不同市场特征差异**:
   - 股票: 价格平滑
   - 加密货币: 价格剧烈波动
   - 压缩效果可能差异巨大

**修复方案**:

**真实数据压缩评估脚本**:

```typescript
// ndtsdb/tests/real-compression-benchmark.ts
import { AppendWriter } from '../src/append';
import { BinanceProvider } from 'quant-lib';

async function benchmarkRealData() {
  console.log('=== 真实数据压缩评估 ===\n');
  
  // 1. 获取真实数据
  const provider = new BinanceProvider();
  const symbols = ['BTCUSDT', 'ETHUSDT', 'MYXUSDT'];
  const interval = '1m';
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 86400 * 1000);  // 7 天
  
  for (const symbol of symbols) {
    console.log(`\n--- ${symbol} ---`);
    
    try {
      const klines = await provider.fetchKlines(symbol, interval, start, end);
      
      console.log(`数据量: ${klines.length} 条`);
      
      // 2. 测试各种压缩算法
      const algorithms = ['none', 'gorilla', 'delta', 'delta+rle'];
      
      for (const algo of algorithms) {
        const writer = new AppendWriter('./test-compression.ndts', {
          compression: algo as any,
        });
        
        // 写入数据
        const startTime = Date.now();
        for (const kline of klines) {
          await writer.write({
            timestamp: kline.timestamp,
            open: kline.open,
            high: kline.high,
            low: kline.low,
            close: kline.close,
            volume: kline.volume,
          });
        }
        await writer.close();
        
        const elapsed = Date.now() - startTime;
        
        // 3. 计算压缩率
        const stat = await Bun.file('./test-compression.ndts').stat();
        const rawSize = klines.length * (8 + 8 * 5);  // timestamp + 5 floats
        const compressedSize = stat.size;
        const ratio = (compressedSize / rawSize * 100).toFixed(2);
        
        console.log(`  ${algo.padEnd(12)} | 大小: ${(compressedSize / 1024).toFixed(2)} KB | 压缩率: ${ratio}% | 耗时: ${elapsed}ms`);
      }
    } catch (error) {
      console.error(`${symbol} 失败:`, error);
    }
  }
}

benchmarkRealData();
```

**预期输出**:

```
=== 真实数据压缩评估 ===

--- BTCUSDT ---
数据量: 10080 条
  none         | 大小: 472.50 KB | 压缩率: 100.00% | 耗时: 45ms
  gorilla      | 大小: 346.20 KB | 压缩率: 73.28% | 耗时: 78ms
  delta        | 大小: 385.10 KB | 压缩率: 81.49% | 耗时: 62ms
  delta+rle    | 大小: 358.40 KB | 压缩率: 75.87% | 耗时: 71ms

--- ETHUSDT ---
...

--- MYXUSDT ---
...
```

---

## 4. 文档和配置

### 问题 4.1: API 账号配置文档缺失 **P1**

**症状**:
- 新用户不知道如何配置 API Key
- accounts.json 格式不明确

**修复方案**:

创建 `quant-lab/docs/API_CONFIGURATION.md`:

```markdown
# API 账号配置指南

## 文件位置

```
~/.config/quant-lab/accounts.json
```

## 配置格式

\`\`\`json
{
  "bybit": {
    "wjcgm@bybit-sub1": {
      "apiKey": "YOUR_API_KEY",
      "apiSecret": "YOUR_API_SECRET",
      "testnet": false,
      "category": "linear",
      "proxy": "http://127.0.0.1:8890"
    }
  },
  "binance": {
    "main": {
      "apiKey": "YOUR_API_KEY",
      "apiSecret": "YOUR_API_SECRET",
      "testnet": false
    }
  }
}
\`\`\`

## 获取 API Key

### Bybit

1. 登录 Bybit: https://www.bybit.com
2. 点击右上角头像 → API 管理
3. 创建新 API Key
4. **权限设置**:
   - ✅ 读取
   - ✅ 下单
   - ❌ 提币（禁用）
5. **IP 白名单**（推荐）:
   - 添加你的服务器 IP
6. 复制 API Key 和 API Secret

### Binance

1. 登录 Binance: https://www.binance.com
2. API 管理 → 创建 API
3. **权限设置**:
   - ✅ 读取
   - ✅ 现货和杠杆交易
   - ❌ 提币（禁用）
4. **IP 白名单**（推荐）

## 安全建议

1. ✅ 使用子账户（Bybit/Binance 都支持）
2. ✅ 设置 IP 白名单
3. ✅ 禁用提币权限
4. ✅ 定期更换 API Key
5. ❌ 不要在公共代码中硬编码 API Key

## 测试配置

\`\`\`bash
# 测试 Bybit 配置
bun scripts/test-bybit-api.ts

# 测试 Binance 配置
bun scripts/test-binance-api.ts
\`\`\`

## 常见问题

### 1. HTTP 401 Unauthorized

**原因**: API Key 或签名错误

**解决方案**:
- 检查 API Key 是否正确
- 检查系统时间（误差 > 5s 会导致签名失败）
- 验证 IP 白名单

### 2. HTTP 403 Forbidden

**原因**: 权限不足或 IP 限制

**解决方案**:
- 检查 API Key 权限
- 添加服务器 IP 到白名单

### 3. HTTP 429 Too Many Requests

**原因**: 请求频率超限

**解决方案**:
- 减少请求频率
- 使用 WebSocket 订阅行情（减少 REST 调用）
```

---

## 5. 问题清单汇总

| ID | 问题 | 等级 | 层级 | 修复时间 | 责任人 |
|----|------|------|------|---------|--------|
| 1.1 | autoRecenter 满仓死锁 | **P0** | 策略层 | 4h | bot-001 |
| 1.2 | 单边风险无硬性熔断 | **P0** | 策略层 | 4h | bot-001 |
| 1.3 | 非对称网格参数验证不足 | **P1** | 策略层 | 1d | bot-004 |
| 1.4 | 仓位计算无原子性保护 | **P1** | 策略层 | 1d | bot-001 |
| 2.1 | 订单状态同步缺失 | **P0** | 系统层 | 6h | bot-001 |
| 2.2 | Provider 异常恢复不完善 | **P1** | 系统层 | 1d | bot-001 |
| 3.1 | 数据源切换无自动测试 | **P2** | 数据层 | 3d | bot-007 |
| 3.2 | 压缩性能评估数据单一 | **P2** | 数据层 | 延后 | bot-007 |
| 4.1 | API 账号配置文档缺失 | **P1** | 文档 | 2h | bot-001 |

---

## 6. 修复优先级建议

### 立即修复（P0，今天完成）

1. **autoRecenter 满仓死锁**（问题 1.1）
   - 修复代码：`gales-simple.js`
   - 测试：SimulatedProvider free-fall 场景
   - 预计 4 小时

2. **单边风险熔断**（问题 1.2）
   - 新增代码：熔断机制
   - 测试：回撤/仓位/价格偏离场景
   - 预计 4 小时

3. **订单状态同步**（问题 2.1）
   - 修复代码：LiveEngine 轮询机制
   - 测试：Paper Trade 订单成交
   - 预计 6 小时

### 短期修复（P1，1-2 天）

4. **非对称网格参数验证**（问题 1.3）
5. **仓位计算原子性**（问题 1.4）
6. **Provider 异常恢复**（问题 2.2）
7. **API 配置文档**（问题 4.1）

### 中期优化（P2，3-5 天）

8. **数据源 Fallback**（问题 3.1）
9. **真实数据压缩评估**（问题 3.2）

---

## 7. 测试计划

### Phase 1: P0 修复验证（今天）

```bash
# 1. autoRecenter 满仓死锁
bun quant-lab/tests/test-autorecenter-fullposition.ts

# 2. 熔断机制
bun quant-lab/tests/test-circuit-breaker.ts

# 3. 订单状态同步
bun quant-lab/tests/test-order-sync.ts
```

### Phase 2: P1 修复验证（1-2 天）

```bash
# 4. 非对称网格
bun quant-lab/tests/test-asymmetric-grid.ts

# 5. 仓位原子性
bun quant-lab/tests/test-position-atomicity.ts

# 6. Provider 恢复
bun quant-lab/tests/test-provider-recovery.ts
```

### Phase 3: 回归测试（P0/P1 修复完成后）

```bash
# 完整回归测试套件
bun quant-lab/tests/run-all-tests.ts
```

---

## 8. 风险评估

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|---------|
| 满仓死锁导致实盘被套 | **高** | **严重** | P0 修复 |
| 单边暴跌无熔断 | **中** | **严重** | P0 修复 |
| 订单状态不一致 | **中** | **严重** | P0 修复 |
| 非对称参数配置错误 | **中** | **中等** | P1 修复 + 文档 |
| Provider 连接中断 | **低** | **中等** | P1 修复 + 自动重连 |
| 数据源故障 | **低** | **低** | P2 修复 + Fallback |

---

## 9. 建议

### 实盘前必须完成

1. ✅ 修复所有 P0 问题
2. ✅ 完成 P0 测试验证
3. ✅ 补充 API 配置文档
4. ✅ 小资金实盘测试（$50-$100）

### 长期改进

1. **策略回测系统**:
   - 使用真实历史数据回测 autoRecenter 逻辑
   - 评估不同参数组合的表现

2. **监控和告警**:
   - 实盘仓位告警（达到 80% 满仓）
   - 回撤告警（回撤 > 20%）
   - 订单异常告警（长时间未成交）

3. **风控增强**:
   - 动态调整 maxPosition（根据波动率）
   - 多级熔断机制（30%/50%/70%）
   - 紧急平仓机制（手动触发）

---

**审查完成时间**: 2026-02-12  
**下一次审查**: P0 修复完成后 + 实盘测试前  
**联系人**: bot-001 (系统架构) / bot-004 (策略开发)
