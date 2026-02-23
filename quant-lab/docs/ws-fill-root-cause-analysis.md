# WS fill丢失根因分析报告

## 问题现象
MYX急跌期间accountGap反复出现（49.53/98.75/119.91），每次自愈都是在修症状，根因未查。

---

## 1. QuickJSStrategy.ts：WS fill callback 注册位置

**位置**: `quant-lab/src/sandbox/QuickJSStrategy.ts:2296-2326`

```typescript
// P0修复：bridge_onExecution - 成交明细回调
const bridge_onExecution = this.ctx.newFunction('bridge_onExecution', (execJsonHandle) => {
  const execJson = this.ctx!.getString(execJsonHandle);
  // 调用策略的st_onExecution函数
  const fnHandle = this.ctx!.getProp(this.ctx!.global, 'st_onExecution');
  ...
});
```

**结论**: bridge_onExecution已正确注册为JS可调用的函数，供策略调用以通知成交事件。

---

## 2. reconcileOrders：cachedExecutions填充时机与时序

**位置**: `quant-lab/src/sandbox/QuickJSStrategy.ts:1213-1260`

**调用时机**:
- 每60个tick调用一次（约5分钟，tick间隔5秒）
- 在`onTick`中的调用顺序：
  1. `refreshCache(ctx)` - 刷新持仓缓存
  2. `reconcileOrders(ctx)` - 订单对账
  3. `callStrategyFunction('st_heartbeat', ...)` - 心跳

**cachedExecutions填充**:
```typescript
const executions = await (ctx as any).getExecutions();
this.cachedExecutions = executions;  // line 1238
```

**关键发现**: reconcileOrders中的executions**仅用于日志记录和缓存**，并不主动触发`st_onExecution`。注释明确说明：
> "st_onExecution只在实时成交时通过WebSocket回调调用"

---

## 3. refreshCache：position缓存刷新时机与频率

**位置**: `quant-lab/src/sandbox/QuickJSStrategy.ts:1142-1200`

**调用频率**: 每60 tick = 300秒 = **5分钟**

**刷新内容**:
- `cachedAccount` - 账户信息
- `cachedPositions` - 持仓列表（通过`getPositionsAsync()`获取）

**问题**: 5分钟刷新频率太低，MYX急跌期间（可能在几分钟内发生大量成交），position缓存滞后严重。

---

## 4. 核心根因分析

### 4.1 架构时序图

```
时间线: ──────────────────────────────────────────────────────────>

Bybit WS:    ┌─fill─┐  ┌─fill─┐  ┌─fill─┐ (实时推送)
             │  #1  │  │  #2  │  │  #3  │
             └──┬───┘  └──┬───┘  └──┬───┘
                ↓         ↓         ↓
LiveEngine:    ┌─────────────┐ (5秒轮询getOrders)
               │ pollOrders  │
               └──────┬──────┘
                      ↓
QuickJS:             ┌──────────────────────────┐
                     │   onOrder回调(如果有)    │
                     │  但gales-simple未使用    │
                     └──────────────────────────┘
                     
每5分钟:             ┌──────────────────────────┐
                     │   refreshCache(5min)     │
                     │   reconcileOrders(5min)  │
                     └──────────────────────────┘
```

### 4.2 根本问题

**没有WebSocket fill推送机制！**

当前的`BybitProvider`只有：
- public WebSocket: tickers/klines (行情数据)
- 轮询机制: 每5秒pollOrderStatus

**缺少**: private WebSocket订阅`execution`频道（成交实时推送）

### 4.3 数据流断裂点

1. **Bybit发出fill** → 正常
2. **WebSocket推送** → ❌ 未订阅execution频道
3. **LiveEngine感知** → 延迟5秒（轮询）
4. **调用bridge_onExecution** → ❌ 从未调用！
5. **st_onExecution执行** → ❌ 从未执行
6. **positionNotional更新** → ❌ 只能靠reconcileOrders时被动检测

---

## 5. 根因确认

### 确认: ✅ WS fill丢失是主要根因

**证据**:
1. `bridge_onExecution`从未被LiveEngine调用（代码搜索无调用点）
2. BybitProvider未订阅private WebSocket execution频道
3. LiveEngine依赖5秒轮询，而非实时推送
4. gales-simple.js的`st_onExecution`依赖bridge_onExecution调用，但该调用不存在

### 为什么自愈只能修症状

当前自愈机制：
- 检测accountGap > 30 → 强制对齐positionNotional
- 但exchangePosition来自5分钟前的缓存
- 导致两边数据都是"过期"的，对齐后下一周期又出现偏差

---

## 6. 下一步修复方向

### 方案A: 添加WebSocket execution订阅（推荐，根治）

**修改位置**:
1. `BybitProvider`: 添加private WebSocket连接，订阅`execution`频道
2. `LiveEngine`: 收到execution后调用`strategy.onExecution()`
3. `QuickJSStrategy`: onExecution中调用`bridge_onExecution`

**工作量**: 中等（需处理WebSocket认证、重连、消息解析）

**预期效果**: fill事件实时到达，accountGap控制在<5

### 方案B: 降低轮询间隔+优化缓存（临时缓解）

**修改**:
1. `orderPollInterval`: 5000ms → 1000ms
2. `refreshCache`: 每60tick → 每12tick (1分钟)

**工作量**: 小

**预期效果**: accountGap控制在<30（仍有延迟，但可接受）

### 方案C: 订单状态变化时主动刷新（折中）

**修改**:
- 在`pollOrderStatus`检测到订单FILLED时，立即调用`refreshCache`

**工作量**: 小

**预期效果**: fill后1秒内刷新position，accountGap控制在<10

---

## 7. 预计影响

| 方案 | fix后accountGap水平 | 工作量 | 风险 |
|------|-------------------|--------|------|
| A (WebSocket) | <5 | 中 | 需测试稳定性 |
| B (高频轮询) | <30 | 小 | API限流风险 |
| C (事件触发) | <10 | 小 | 低 |

**推荐**: 先实施C（快速见效），再实施A（长期根治）

---

## 8. 补充发现

### 8.1 reconcileOrders和B类自愈的数据源差异

| 机制 | 调用频率 | position来源 | 实时性 |
|------|---------|-------------|--------|
| reconcileOrders | 5分钟 | `getPositionsAsync()` | 5分钟延迟 |
| B类自愈 | 每tick | `state.exchangePosition` | 取决于state更新 |
| 账本对齐(>100) | 每tick | `bridge_getPosition()` | 实时 |

**问题**: 三个机制使用三个不同的数据源，确实存在打架可能。

### 8.2 当前修复(40c25a406)的局限性

将B类自愈限制在30-100范围，确实避免了两个自愈机制同时触发。

但这只是**症状缓解**，fill事件丢失的根因仍未解决。

---

## 结论

**根因确认**: ✅ WebSocket fill实时推送缺失，导致positionNotional更新滞后

**当前状态**: 依赖5分钟轮询检测偏差，然后自愈修正

**修复优先级**:
1. 🔴 高: 实施方案C（订单FILLED时立即刷新position）
2. 🟡 中: 实施方案A（添加execution WebSocket订阅）
3. 🟢 低: 考虑方案B（降低轮询间隔）

---

*报告生成时间: 2026-02-22*
