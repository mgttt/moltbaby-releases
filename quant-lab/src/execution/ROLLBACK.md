# 降仓触发状态机 - 回滚说明

## 文件清单

| 文件 | 用途 | 回滚操作 |
|------|------|----------|
| `quant-lab/src/execution/position-reducer.ts` | 降仓状态机核心 | 删除或恢复上一版本 |
| `quant-lab/src/execution/position-reducer.test.ts` | 单元测试 | 删除 |
| `quant-lab/src/execution/position-risk-manager.ts` | 集成层 | 删除或恢复上一版本 |
| `quant-lab/src/execution/position-risk-manager.test.ts` | 集成测试 | 删除 |

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
rm quant-lab/src/execution/position-reducer.ts
rm quant-lab/src/execution/position-reducer.test.ts
rm quant-lab/src/execution/position-risk-manager.ts
rm quant-lab/src/execution/position-risk-manager.test.ts
```

## 状态机说明

```
IDLE → WARNING → REDUCE → RECOVERY → IDLE
       ↑___________________________|
```

### 触发条件
- **IDLE → WARNING**: 杠杆 > 3.0x
- **WARNING → REDUCE**: 杠杆 > 3.5x
- **REDUCE → RECOVERY**: 降仓执行完成
- **RECOVERY → IDLE**: 杠杆 ≤ 2.5x
- **WARNING → IDLE**: 杠杆 ≤ 3.0x

### 配置参数
```typescript
{
  warningLeverage: 3.0,   // 预警阈值
  reduceLeverage: 3.5,    // 强制降仓阈值
  targetLeverage: 2.5,    // 目标杠杆
  maxReduceRatio: 0.3,    // 单次最大减仓30%
  cooldownMs: 60000,      // 降仓冷却时间60秒
}
```

## 验证命令

```bash
# 编译检查
cd quant-lab
bun tsc --noEmit src/execution/position-reducer.ts

# 运行测试
bun test src/execution/position-reducer.test.ts
bun test src/execution/position-risk-manager.test.ts
```

## 集成使用

```typescript
import { createPositionRiskManager } from './position-risk-manager';

const manager = createPositionRiskManager({
  symbol: 'BTCUSDT',
  maxLeverage: 5.0,
  maxPositionValue: 100000,
  maxMarginUsage: 80,
  warningLeverage: 3.0,
  reduceLeverage: 3.5,
  targetLeverage: 2.5,
  maxReduceRatio: 0.3,
  reduceCooldownMs: 60000,
});

// 注册降仓执行器
manager.onReduce(async (action) => {
  // 执行实际减仓
  const result = await exchange.reducePosition(action.reduceQty);
  
  // 确认结果
  manager.confirmReduce(action.actionId, {
    executed: result.success,
    executionPrice: result.price,
    txHash: result.orderId,
  });
  
  return result.success;
});

// 更新持仓触发状态机
const result = await manager.updatePosition({
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

## 审计日志

所有状态流转和降仓动作都会记录在 `audit` 对象中：

```typescript
const audit = manager.getStatus().audit;
// audit.transitions: 状态流转历史
// audit.actions: 降仓动作历史（含执行结果）
```

## 紧急回滚场景

1. **降仓逻辑错误**: 立即调用 `manager.reset()` 重置状态机
2. **误触发降仓**: 通过 confirmReduce 标记为失败，系统会自动重试
3. **完全禁用**: 不注册 `onReduce` 回调，状态机仅记录不执行
