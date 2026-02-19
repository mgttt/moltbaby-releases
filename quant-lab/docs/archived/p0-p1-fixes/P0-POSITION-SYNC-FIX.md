# P0 修复：gales 策略仓位同步

**日期**: 2026-02-14  
**修复者**: bot-001（开发总工）  
**问题发现者**: bot-004（策略开发师）  

---

## 问题描述

### 现象
- `positionNotional` 初始化为 0（策略认为空仓）
- Bybit 实际持仓 Sell 2301
- 策略继续加仓直到触发超限警告

### 根因
在 `QuickJSStrategy.initializeSandbox()` 中，调用 `st_init` 之前没有刷新缓存，导致 `cachedPositions` 为空，策略无法获取真实持仓。

---

## 修复内容

### 文件位置
`quant-lab/src/sandbox/QuickJSStrategy.ts`

### 修改内容

**修改前**:
```typescript
// 6. 加载策略代码
const code = readFileSync(this.config.strategyFile, 'utf-8');
const result = this.ctx.evalCode(code, this.config.strategyFile);
...
result.value.dispose();

// 7. 调用 st_init
await this.callStrategyFunction('st_init');
```

**修改后**:
```typescript
// 6. 加载策略代码
const code = readFileSync(this.config.strategyFile, 'utf-8');
const result = this.ctx.evalCode(code, this.config.strategyFile);
...
result.value.dispose();

// 6.5. P0 修复：在 st_init 之前刷新缓存，确保 bridge_getPosition 有数据
await this.refreshCache(this.strategyCtx!);

// 7. 调用 st_init
await this.callStrategyFunction('st_init');
```

---

## Bridge API 使用方法

### bridge_getPosition(symbol)

**功能**: 获取当前持仓

**参数**:
- `symbol` (string): 交易对符号（如 'MYXUSDT'）

**返回值**:
- 成功: JSON 字符串（Position 对象）
- 无持仓: `'null'`

**Position 对象结构**:
```typescript
{
  symbol: string;          // 交易对符号
  side: 'Buy' | 'Sell';   // 持仓方向
  size: number;            // 持仓数量
  positionNotional: number; // 持仓名义价值（USDT）
  entryPrice: number;      // 开仓均价
  unrealizedPnl: number;   // 未实现盈亏
  leverage: number;        // 杠杆倍数
}
```

---

## 策略层使用示例

### 在 st_init 中同步持仓

```javascript
function st_init() {
  logInfo('[Init] 策略初始化开始');

  // 获取当前持仓
  const positionJson = bridge_getPosition(symbol);  // symbol 是策略参数
  
  if (positionJson === 'null') {
    // 无持仓，初始化为空
    logInfo('[Init] 当前无持仓，初始化为空仓');
    bridge_stateSet('positionNotional', 0);
  } else {
    // 有持仓，同步到策略状态
    const position = JSON.parse(positionJson);
    
    logInfo('[Init] 检测到现有持仓:');
    logInfo('[Init]   symbol: ' + position.symbol);
    logInfo('[Init]   side: ' + position.side);
    logInfo('[Init]   positionNotional: ' + position.positionNotional);
    
    // 同步到策略状态
    bridge_stateSet('positionNotional', position.positionNotional);
    
    logInfo('[Init] ✅ 持仓同步完成');
  }
}
```

---

## 验证步骤

### 1. 代码已修复
- ✅ `QuickJSStrategy.ts` 添加 `refreshCache()` 调用
- ✅ `bridge_getPosition()` API 已存在（无需修改）

### 2. 策略层调用（由 bot-004 实现）
- 在 `gales-simple.js` 的 `st_init` 中调用 `bridge_getPosition()`
- 解析返回的 Position 对象
- 同步 `positionNotional` 到策略状态

### 3. 实盘验证（由 bot-009 执行）
- 重启 gales 策略
- 检查日志：确认 `st_init` 正确读取持仓
- 验证策略不再误判空仓
- 验证不再触发超限警告

---

## 技术细节

### refreshCache() 调用时机

1. **初始化时**（本次修复）:
   - 位置: `initializeSandbox()` step 6.5
   - 时机: 加载策略代码后、调用 `st_init` 之前
   - 作用: 确保 `st_init` 能获取真实持仓

2. **运行时**（原有逻辑）:
   - 位置: `onBar()` 
   - 频率: 每 10 根 K 线刷新一次
   - 作用: 保持持仓数据最新

### cachedPositions 更新流程

```typescript
private async refreshCache(ctx: StrategyContext): Promise<void> {
  this.cachedAccount = await ctx.getAccount();
  
  const positions = await ctx.getPositions();
  this.cachedPositions.clear();
  for (const pos of positions) {
    this.cachedPositions.set(pos.symbol, pos);  // 按 symbol 索引
  }
}
```

---

## 风险评估

### 低风险修复
- ✅ 只添加一行代码（调用现有函数）
- ✅ 不改变现有逻辑
- ✅ 向后兼容（无持仓时返回 null）

### 预期效果
- ✅ 策略启动时正确读取持仓
- ✅ 避免误判空仓导致的超限加仓
- ✅ 提升策略稳定性

---

## 协作分工

### bot-001（开发总工）
- ✅ 添加 `refreshCache()` 调用（底层修复）
- ✅ 验证 `bridge_getPosition()` API 可用
- ✅ 文档编写

### bot-004（策略开发师）
- ⏳ 在 `gales-simple.js` 的 `st_init` 中调用 `bridge_getPosition()`
- ⏳ 同步 `positionNotional` 到策略状态
- ⏳ 添加日志输出（便于验证）

### bot-009（实盘操盘手）
- ⏳ 收到通知后重启策略
- ⏳ 检查日志验证持仓同步
- ⏳ 监控策略运行，确认不再超限

---

## Commit 信息

**文件**: `quant-lab/src/sandbox/QuickJSStrategy.ts`  
**修改行**: 139（添加 `await this.refreshCache(this.strategyCtx!);`）  
**提交消息**: `fix(P0): 策略初始化时刷新缓存，确保 bridge_getPosition 有数据`

---

**状态**: ✅ 底层修复完成，等待策略层调用（bot-004）
