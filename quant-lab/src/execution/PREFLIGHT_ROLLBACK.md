# 启动前置检查 - 回滚说明

**模块**: preflight-check.ts  
**创建日期**: 2026-02-21  
**P1紧急修复**

---

## 文件清单

| 文件 | 用途 | 回滚操作 |
|------|------|----------|
| `src/execution/preflight-check.ts` | 核心实现 | 删除或恢复上一版本 |
| `src/execution/preflight-check.test.ts` | 单元测试 | 删除 |
| `src/execution/PREFLIGHT_ROLLBACK.md` | 本回滚说明 | 删除 |

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
rm quant-lab/src/execution/preflight-check.ts
rm quant-lab/src/execution/preflight-check.test.ts
rm quant-lab/src/execution/PREFLIGHT_ROLLBACK.md
```

---

## 功能说明

启动前置检查（Pre-flight Check）在策略启动前执行以下检查：

### 1. 持仓合规校验
```typescript
positionCheck: {
  symbol: string;          // 交易对
  maxPosition: number;     // 最大持仓限制
  currentPosition: number; // 当前持仓
  side: 'LONG' | 'SHORT' | 'NEUTRAL';
}
```

**检查逻辑**:
- 当前持仓 < 最大限制 → 通过
- 当前持仓 ≥ 最大限制 → 失败（拒绝启动）
- 90%以上接近限制 → 警告但不阻止

### 2. 账户状态校验
```typescript
accountCheck: {
  minBalance: number;           // 最小余额要求
  currentBalance: number;       // 当前余额
  requiredPermissions: string[]; // 所需权限
  currentPermissions: string[]; // 当前权限
}
```

**检查逻辑**:
- 余额 ≥ 最低要求 → 通过
- 余额 < 最低要求 → 失败
- 检查所有必需权限是否具备

### 3. 参数校验
```typescript
parameterCheck: {
  requiredParams: string[];     // 必需参数列表
  providedParams: Record<string, any>; // 提供的参数
  paramValidators?: Record<string, (value: any) => boolean>; // 验证器
}
```

**检查逻辑**:
- 所有必需参数存在 → 通过
- 缺少参数 → 失败
- 自定义验证器验证 → 失败时拒绝

---

## 使用示例

### 基础使用

```typescript
import { createPreflightChecker } from './preflight-check';

const checker = createPreflightChecker({
  strategyId: 'gales-myx',
  sessionId: 'gales-myx-001',
  positionCheck: {
    symbol: 'MYXUSDT',
    maxPosition: 7874,
    currentPosition: 7500,  // 当前持仓
    side: 'SHORT',
  },
  accountCheck: {
    minBalance: 1000,
    currentBalance: 2000,
    requiredPermissions: ['trade', 'read'],
    currentPermissions: ['trade', 'read'],
  },
  parameterCheck: {
    requiredParams: ['symbol', 'direction', 'maxPosition'],
    providedParams: {
      symbol: 'MYXUSDT',
      direction: 'short',
      maxPosition: 7874,
    },
  },
}, {
  enabled: true,
  onFailure: async (result) => {
    // 发送告警到Telegram
    await sendTelegramAlert(`策略启动检查失败: ${JSON.stringify(result)}`);
  },
});

// 执行检查
const canStart = await checker.run();
if (!canStart) {
  console.error('启动前置检查失败，拒绝启动策略');
  process.exit(1);
}

// 正常启动策略
await startStrategy();
```

### 在策略启动流程中集成

```typescript
// 在策略启动脚本中添加
async function startStrategyWithPreflight() {
  // 1. 获取当前持仓
  const currentPosition = await getCurrentPosition('MYXUSDT');
  
  // 2. 获取账户信息
  const account = await getAccountInfo();
  
  // 3. 执行前置检查
  const checker = createPreflightChecker({
    strategyId: 'gales-myx',
    sessionId: `gales-myx-${Date.now()}`,
    positionCheck: {
      symbol: 'MYXUSDT',
      maxPosition: CONFIG.maxPosition,
      currentPosition,
      side: CONFIG.direction,
    },
    accountCheck: {
      minBalance: 1000,
      currentBalance: account.balance,
      requiredPermissions: ['trade'],
      currentPermissions: account.permissions,
    },
  });
  
  const canStart = await checker.run();
  if (!canStart) {
    console.error(checker.generateReport());
    throw new Error('启动前置检查失败');
  }
  
  // 4. 检查通过，启动策略
  await strategy.start();
}
```

---

## 验证命令

```bash
# 编译检查
cd quant-lab
bun tsc --noEmit src/execution/preflight-check.ts

# 运行测试
bun test src/execution/preflight-check.test.ts

# 运行特定测试
bun test src/execution/preflight-check.test.ts -t "持仓检查"
```

---

## 事件监听

```typescript
const checker = createPreflightChecker(config);

checker.on('check:started', ({ timestamp }) => {
  console.log('检查开始:', timestamp);
});

checker.on('check:passed', (result) => {
  console.log('检查通过:', result);
});

checker.on('check:failed', (result) => {
  console.error('检查失败:', result);
});

checker.on('alert:sent', ({ result }) => {
  console.log('告警已发送');
});
```

---

## 紧急回滚场景

1. **检查逻辑错误导致无法启动**:
   ```bash
   # 临时禁用检查，立即回滚
   git reset --hard HEAD~1
   # 或使用 --force 参数绕过检查（不推荐）
   ```

2. **误报导致策略无法启动**:
   ```typescript
   // 临时调整阈值
   positionCheck: {
     maxPosition: originalMax * 1.5,  // 临时放宽
     // ...
   }
   ```

3. **检查耗时过长**:
   ```typescript
   // 移除耗时的自定义检查
   customChecks: []  // 清空自定义检查
   ```

---

## 测试覆盖

| 测试类型 | 数量 | 覆盖率 |
|----------|------|--------|
| 持仓检查 | 5项 | 100% |
| 账户检查 | 5项 | 100% |
| 参数检查 | 6项 | 100% |
| 集成测试 | 4项 | 100% |
| 告警测试 | 2项 | 100% |
| 事件测试 | 3项 | 100% |
| 边界测试 | 5项 | 100% |
| **总计** | **30项** | **100%** |

---

*创建日期: 2026-02-21*  
*P1紧急修复 - 防止策略启动时历史持仓超限导致静默失败*
