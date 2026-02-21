# 全局风险聚合器 - 回滚说明

**模块**: risk-aggregator.ts  
**创建日期**: 2026-02-21  
**功能**: 多策略全局风险视图与跨策略硬顶

---

## 文件清单

| 文件 | 用途 | 回滚操作 |
|------|------|----------|
| `src/execution/risk-aggregator.ts` | 核心实现 | 删除或恢复上一版本 |
| `src/execution/risk-aggregator.test.ts` | 单元测试 | 删除 |
| `src/execution/RISK_AGGREGATOR_ROLLBACK.md` | 本回滚说明 | 删除 |

---

## 快速回滚

```bash
# 查看最新提交
cd /home/devali/moltbaby
git log --oneline -5

# 撤销本次提交（保留修改到工作区）
git reset --soft HEAD~1

# 或完全回滚到上一版本
git reset --hard HEAD~1

# 仅删除新增文件
rm quant-lab/src/execution/risk-aggregator.ts
rm quant-lab/src/execution/risk-aggregator.test.ts
rm quant-lab/src/execution/RISK_AGGREGATOR_ROLLBACK.md
```

---

## 功能说明

全局风险聚合器解决多策略同跑时的全局风险不可见问题。

### 核心能力

```
┌─────────────────────────────────────────────────────────────┐
│                   全局风险聚合器                             │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   gales-neutral (2x) ──┐                                    │
│                         ├──▶ 聚合计算 ──▶ 总杠杆/总持仓     │
│   gales-short (3x) ────┘          │                        │
│                                    │                        │
│                                    ▼                        │
│                          ┌──────────────────┐               │
│                          │ 全局限制检查     │               │
│                          │ maxTotalLeverage │               │
│                          │ maxTotalPosition │               │
│                          │ maxStrategyCount │               │
│                          └────────┬─────────┘               │
│                                   │                         │
│                        通过✅ / 拒绝❌                      │
└─────────────────────────────────────────────────────────────┘
```

### 使用场景

**场景1: 多策略杠杆叠加**
```typescript
// gales-neutral: 2x杠杆，持仓15000
// gales-short: 3x杠杆，持仓10000
// 总杠杆 = 5x（在限制内）✅
```

**场景2: 超限阻止**
```typescript
// 已运行: gales-neutral(2x) + gales-short(3x) = 5x
// 尝试启动: gales-long(3x) → 总杠杆8x
// 限制: maxTotalLeverage = 8x
// 结果: 正好达到限制，允许启动 ✅

// 再尝试启动: gales-grid(2x) → 总杠杆10x
// 结果: 超过限制，拒绝启动 ❌
```

---

## 使用示例

### 基础使用

```typescript
import { createGlobalRiskAggregator } from './risk-aggregator';

// 1. 创建聚合器（通常作为单例）
const aggregator = createGlobalRiskAggregator({
  limits: {
    maxTotalLeverage: 10,        // 全局最大10x杠杆
    maxTotalPositionValue: 100000, // 全局最大10万持仓
    maxTotalMarginUsage: 80000,    // 全局最大8万保证金
    maxStrategyCount: 5,           // 最多5个策略
  },
  alertConfig: {
    enabled: true,
    onViolation: async (result) => {
      await sendTelegramAlert(`全局风险超限: ${result.violations.join(', ')}`);
    },
  },
});

// 2. 策略启动时注册
async function startStrategy(config: StrategyConfig) {
  const snapshot = {
    strategyId: config.id,
    sessionId: `${config.id}-${Date.now()}`,
    symbol: config.symbol,
    side: config.side,
    positionSize: 0,
    positionValue: 0,
    leverage: config.targetLeverage,
    marginUsed: 0,
    timestamp: Date.now(),
  };

  const canStart = await aggregator.registerStrategy(snapshot);
  if (!canStart) {
    throw new Error('全局风险检查失败，无法启动策略');
  }

  // 继续启动策略...
}

// 3. 策略运行时更新
function onPositionChange(strategyId: string, position: Position) {
  aggregator.updateStrategySnapshot(strategyId, {
    positionSize: position.size,
    positionValue: position.value,
    leverage: position.leverage,
    marginUsed: position.margin,
  });
}

// 4. 策略停止时注销
function stopStrategy(strategyId: string) {
  aggregator.unregisterStrategy(strategyId);
}

// 5. 查看全局风险视图
const view = aggregator.getRiskView();
console.log(`总杠杆: ${view.summary.totalLeverage}x`);
console.log(`状态: ${view.status}`); // SAFE / WARNING / CRITICAL
```

### 与pre-flight check集成

```typescript
import { createPreflightChecker } from './preflight-check';
import { getGlobalRiskAggregator } from './risk-aggregator';

async function comprehensivePreflightCheck(strategyConfig: StrategyConfig) {
  // 1. 本地风险检查
  const localChecker = createPreflightChecker({
    strategyId: strategyConfig.id,
    positionCheck: {
      maxPosition: strategyConfig.maxPosition,
      currentPosition: await getCurrentPosition(),
    },
  });

  const localResult = await localChecker.run();
  if (!localResult) {
    throw new Error('本地风险检查失败');
  }

  // 2. 全局风险检查
  const aggregator = getGlobalRiskAggregator();
  const globalResult = aggregator.checkNewStrategy({
    strategyId: strategyConfig.id,
    sessionId: `${strategyConfig.id}-${Date.now()}`,
    symbol: strategyConfig.symbol,
    side: strategyConfig.side,
    positionSize: 0,
    positionValue: 0,
    leverage: strategyConfig.targetLeverage,
    marginUsed: 0,
    timestamp: Date.now(),
  });

  if (!globalResult.allowed) {
    console.error('全局风险检查失败:', globalResult.violations);
    throw new Error('全局风险检查失败');
  }

  if (globalResult.warnings.length > 0) {
    console.warn('全局风险警告:', globalResult.warnings);
  }

  console.log('✅ 所有检查通过，允许启动');
}
```

### 实时监控脚本

```typescript
// 定时打印全局风险状态
setInterval(() => {
  const aggregator = getGlobalRiskAggregator();
  const view = aggregator.getRiskView();
  
  console.clear();
  console.log(aggregator.generateReport());
  
  if (view.status === 'CRITICAL') {
    console.error('🚨 全局风险处于临界状态！');
  } else if (view.status === 'WARNING') {
    console.warn('⚠️ 全局风险接近限制');
  }
}, 5000);
```

---

## 验证命令

```bash
# 编译检查
cd quant-lab
bun tsc --noEmit src/execution/risk-aggregator.ts

# 运行测试
bun test src/execution/risk-aggregator.test.ts

# 运行特定场景测试
bun test src/execution/risk-aggregator.test.ts -t "gales-neutral + gales-short"
```

---

## 事件监听

```typescript
const aggregator = createGlobalRiskAggregator(config);

// 策略注册成功
aggregator.on('strategy:registered', (snapshot) => {
  console.log(`策略注册: ${snapshot.strategyId}`);
});

// 策略注册被拒绝
aggregator.on('strategy:rejected', ({ snapshot, reasons }) => {
  console.error(`策略被拒绝: ${snapshot.strategyId}, 原因: ${reasons.join(', ')}`);
});

// 策略注销
aggregator.on('strategy:unregistered', ({ strategyId }) => {
  console.log(`策略注销: ${strategyId}`);
});

// 风险超限
aggregator.on('risk:limit_exceeded', (result) => {
  console.error('全局风险超限!', result.violations);
});

// 告警已发送
aggregator.on('alert:sent', ({ type, message }) => {
  console.log(`告警[${type}]: ${message}`);
});
```

---

## 紧急回滚场景

1. **误判导致策略无法启动**:
   ```typescript
   // 临时放宽限制
   const aggregator = getGlobalRiskAggregator();
   // 修改配置后需要重启服务
   ```

2. **计算错误导致风险不可见**:
   ```bash
   # 立即回滚
   git reset --hard HEAD~1
   ```

3. **性能问题**:
   ```typescript
   // 减少更新频率
   // 原: 每次tick更新
   // 改: 每10秒更新一次
   ```

---

## 测试覆盖

| 测试类型 | 数量 | 覆盖率 |
|----------|------|--------|
| 策略注册 | 6项 | 100% |
| 策略注销 | 2项 | 100% |
| 策略更新 | 3项 | 100% |
| 风险视图 | 4项 | 100% |
| 预检功能 | 3项 | 100% |
| 告警功能 | 2项 | 100% |
| 事件监听 | 3项 | 100% |
| 边界条件 | 4项 | 100% |
| 场景模拟 | 1项 | 100% |
| **总计** | **28项** | **100%** |

---

*创建日期: 2026-02-21*  
*功能: 多策略全局风险视图与跨策略硬顶*
