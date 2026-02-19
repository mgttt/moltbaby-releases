# Gales 熔断状态量增强实现方案

**版本**: v3.1  
**日期**: 2026-02-19  
**状态**: P0实现 + P1/P2草案  
**验收**: 8号

---

## 🎯 P0: circuitBreaker.active (运行时总开关)

### 实现代码

```javascript
// 1. 熔断状态扩展 (line ~201)
let circuitBreakerState = {
  tripped: false,
  reason: '',
  tripAt: 0,
  highWaterMark: 0,
  recoveryTickCount: 0,
  blockedSide: '',
  
  // P0新增: 运行时熔断总开关 (默认true)
  active: true,
};

// 2. loadState 兼容处理 (line ~212, 在state缺字段处理之后)
if (obj.circuitBreakerState) {
  // 兼容旧数据: 如active未定义, 默认为true
  if (obj.circuitBreakerState.active === undefined) {
    obj.circuitBreakerState.active = true;
    logInfo('[熔断] 兼容旧数据: 设置active=true');
  }
  circuitBreakerState = obj.circuitBreakerState;
}

// 3. checkCircuitBreaker 函数开头 (line ~358)
function checkCircuitBreaker() {
  // P0新增: 运行时总开关检查
  if (!circuitBreakerState.active) {
    logDebug('[熔断检查] 熔断检查已暂停(active=false)');
    return false;
  }
  
  if (!CONFIG.circuitBreaker || !CONFIG.circuitBreaker.enabled) {
    return false;
  }
  // ... 原有逻辑
}

// 4. 运行时控制函数 (新增, line ~270)
function setCircuitBreakerActive(active) {
  const oldValue = circuitBreakerState.active;
  circuitBreakerState.active = !!active;
  if (oldValue !== circuitBreakerState.active) {
    logInfo('[熔断] 运行时开关变更: ' + oldValue + ' -> ' + circuitBreakerState.active);
    saveState();
  }
  return circuitBreakerState.active;
}
```

### 使用方法

```javascript
// 运行时暂停熔断检查
setCircuitBreakerActive(false);

// 运行时恢复熔断检查
setCircuitBreakerActive(true);

// 查询当前状态
logInfo('熔断活跃状态: ' + circuitBreakerState.active);
```

### 迁移说明

| 场景 | 处理 |
|------|------|
| 新部署 | active 默认为 true |
| 旧state升级 | loadState 自动设置 active=true |
| 运行时切换 | 立即生效，不重启策略 |

---

## 🎯 P1: drawdownMode (回撤计算模式)

### 实现草案

```javascript
// 1. CONFIG 扩展 (line ~71)
circuitBreaker: {
  enabled: true,
  maxDrawdown: 0.30,
  maxPositionRatio: 0.93,
  maxPriceDrift: 0.50,
  cooldownAfterTrip: 600,
  
  // P1新增: 回撤计算模式
  drawdownMode: 'hwm',  // 'hwm' | 'entry' | 'off'
  
  // P1新增: 开仓成本基准(用于entry模式)
  entryCost: null,  // 首次开仓时自动设置
}

// 2. circuitBreakerState 扩展
drawdownMode: 'hwm',  // 运行时覆盖CONFIG的副本
entryCost: 0,         // 开仓成本

// 3. 回撤计算逻辑 (line ~425)
function calculateDrawdown(effectivePosition) {
  const mode = circuitBreakerState.drawdownMode || CONFIG.circuitBreaker?.drawdownMode || 'hwm';
  
  switch (mode) {
    case 'hwm':
      // 基于highWaterMark (原有逻辑)
      if (circuitBreakerState.highWaterMark <= 0) return 0;
      return (circuitBreakerState.highWaterMark - effectivePosition) / circuitBreakerState.highWaterMark;
      
    case 'entry':
      // 基于开仓成本
      if (circuitBreakerState.entryCost <= 0) return 0;
      return (circuitBreakerState.entryCost - effectivePosition) / circuitBreakerState.entryCost;
      
    case 'off':
      // 关闭回撤熔断
      return 0;
      
    default:
      return 0;
  }
}

// 4. 首次开仓时记录成本
function recordEntryCost(price, qty) {
  if (circuitBreakerState.entryCost === 0 && qty > 0) {
    circuitBreakerState.entryCost = price * qty;
    logInfo('[熔断] 记录开仓成本: ' + circuitBreakerState.entryCost.toFixed(2));
    saveState();
  }
}
```

### 使用场景

| 模式 | 适用场景 |
|------|----------|
| hwm | 默认，追踪最高权益 |
| entry | 长期持仓，基于开仓成本 |
| off | 极端行情，临时关闭回撤熔断 |

---

## 🎯 P2: hwmResetPolicy (HWM重置策略)

### 实现草案

```javascript
// 1. CONFIG 扩展
hwmResetPolicy: 'onRecovery',  // 'onRecovery' | 'daily' | 'manual'

// 2. circuitBreakerState 扩展
hwmResetPolicy: 'onRecovery',
lastHwmResetAt: 0,  // 上次重置时间(用于daily模式)

// 3. HWM重置逻辑 (line ~385)
function resetHighWaterMark(effectivePos, reason) {
  const policy = circuitBreakerState.hwmResetPolicy || 'onRecovery';
  const now = Date.now();
  
  switch (policy) {
    case 'onRecovery':
      // 恢复时重置 (原有逻辑)
      if (reason === 'recovery') {
        circuitBreakerState.highWaterMark = effectivePos;
        logInfo('[熔断] HWM重置(onRecovery): ' + effectivePos.toFixed(2));
      }
      break;
      
    case 'daily':
      // 每日重置
      const dayStart = new Date().setHours(0,0,0,0);
      if (circuitBreakerState.lastHwmResetAt < dayStart) {
        circuitBreakerState.highWaterMark = effectivePos;
        circuitBreakerState.lastHwmResetAt = now;
        logInfo('[熔断] HWM重置(daily): ' + effectivePos.toFixed(2));
      }
      break;
      
    case 'manual':
      // 手动重置 (需外部调用)
      logInfo('[熔断] HWM重置(manual): 需手动触发');
      break;
  }
  
  saveState();
}

// 4. 手动重置API (新增)
function manualResetHWM(newHWM) {
  if (circuitBreakerState.hwmResetPolicy === 'manual') {
    circuitBreakerState.highWaterMark = newHWM;
    logInfo('[熔断] HWM手动重置: ' + newHWM.toFixed(2));
    saveState();
    return true;
  }
  logWarn('[熔断] HWM手动重置失败: 当前策略非manual模式');
  return false;
}
```

---

## 📋 迁移策略

### 状态字段迁移

| 字段 | 旧数据 | 新数据 | 迁移处理 |
|------|--------|--------|----------|
| active | undefined | true | loadState自动设置 |
| drawdownMode | undefined | 'hwm' | 默认hwm |
| hwmResetPolicy | undefined | 'onRecovery' | 兼容现有行为 |
| entryCost | undefined | 0 | 首次开仓时设置 |
| lastHwmResetAt | undefined | 0 | 首次重置时设置 |

### 配置迁移

```javascript
// 在CONFIG覆盖参数处添加 (line ~118)
if (p.circuitBreaker) {
  if (p.circuitBreaker.drawdownMode) CONFIG.circuitBreaker.drawdownMode = p.circuitBreaker.drawdownMode;
  if (p.circuitBreaker.hwmResetPolicy) CONFIG.circuitBreaker.hwmResetPolicy = p.circuitBreaker.hwmResetPolicy;
  if (p.circuitBreaker.entryCost !== undefined) CONFIG.circuitBreaker.entryCost = p.circuitBreaker.entryCost;
}
```

---

## ✅ 回归清单

### P0 验收 (circuitBreaker.active)

- [ ] 新策略启动，active默认为true
- [ ] 旧state加载，active自动设置为true
- [ ] setCircuitBreakerActive(false) 暂停熔断检查
- [ ] setCircuitBreakerActive(true) 恢复熔断检查
- [ ] 熔断日志显示 active 状态
- [ ] 重启后 active 状态持久化

### P1 验收 (drawdownMode)

- [ ] hwm模式: 基于highWaterMark计算回撤
- [ ] entry模式: 基于开仓成本计算回撤
- [ ] off模式: 回撤熔断不触发
- [ ] 首次开仓记录entryCost
- [ ] 模式切换后立即生效

### P2 验收 (hwmResetPolicy)

- [ ] onRecovery: 恢复时重置HWM
- [ ] daily: 每日首次检查时重置HWM
- [ ] manual: 不自动重置，支持手动重置
- [ ] manualResetHWM() 调用成功/失败

### 兼容性验收

- [ ] 旧策略配置不报错
- [ ] 旧state加载不丢失数据
- [ ] 新字段保存/加载正确

---

## 🚀 执行计划

### Phase 1: P0立即落地 (30分钟)

1. 修改 circuitBreakerState 添加 active (line ~201)
2. 修改 loadState 兼容旧数据 (line ~212)
3. 修改 checkCircuitBreaker 添加开关检查 (line ~358)
4. 添加 setCircuitBreakerActive 函数 (line ~270)
5. 提交 commit

### Phase 2: P1/P2 实现草案提交 (1小时)

1. 完善 drawdownMode 实现草案
2. 完善 hwmResetPolicy 实现草案
3. 编写迁移说明
4. 编写回归清单
5. 提交 PR 供审查

---

**状态**: 方案完成，等待0号/8号审批后执行
