# P1: Bybit Position side 映射分析报告

**日期**: 2026-02-15  
**分析者**: bot-001  

---

## 官方文档确认

### Bybit V5 Position API 字段定义

**来源**: https://bybit-exchange.github.io/docs/v5/position

#### side 字段
```
side: Position side
- "Buy": long (做多持仓)
- "Sell": short (做空持仓)  
- "": empty position (空仓，size=0 时)
```

#### size 字段
```
size: Position size, always positive
- Linear 合约（USDT 本位）: 币数量（如 1 BTC, 1386 MYX）
- 总是正数
```

#### positionValue 字段
```
positionValue: Position value
- 计算方式: size × markPrice
- 单位: USDT（Linear 合约）
```

#### unrealisedPnl 字段
```
unrealisedPnl: Unrealised PnL
- 做多: (markPrice - avgPrice) × size
- 做空: (avgPrice - markPrice) × size
```

---

## 数据矛盾分析

### 9号日志数据（Bybit API 返回）
```
symbol: MYXUSDT
side: Buy  ← 做多
positionIdx: 0  ← 单向持仓
size: 1386  ← 币数量（MYX）
positionValue: 3298.18 USDT
unrealisedPnl: -114.96 USDT  ← 亏损
markPrice: 2.35182（从日志推测）
```

### "实际持仓报告"数据
```
MYXUSDT Sell 2301
avg 5.43, mark 2.30
做空亏损
```

---

## 矛盾点诊断

### 1. side 矛盾
- **API**: `side=Buy`（做多）
- **报告**: `Sell`（做空）

**可能原因**:
1. API 返回的是历史持仓（已平仓）
2. "报告"看的是订单方向，而非持仓方向
3. Hedge Mode 有多条持仓记录，API 只返回了一条

### 2. size 矛盾
- **API**: `size=1386`
- **报告**: `2301`

**可能原因**:
1. `2301` 是 positionValue（USDT 价值），而非 size
2. `2301` 是另一条持仓记录的 size
3. 时间差导致数据不一致

### 3. 盈亏矛盾
**如果 avgPrice=5.43, markPrice=2.30, size=1386**:

做多（Buy）理论亏损:
```
unrealisedPnl = (2.30 - 5.43) × 1386 = -4336.18 USDT
```

但 API 返回:
```
unrealisedPnl = -114.96 USDT
```

**差异巨大**: -114.96 vs -4336.18

**可能原因**:
1. **avgPrice 不是 5.43**（最可能！）
   - 如果 unrealisedPnl = -114.96, size=1386:
   - (markPrice - avgPrice) × 1386 = -114.96
   - avgPrice = markPrice + 114.96/1386
   - avgPrice ≈ 2.30 + 0.083 = 2.38 USDT
   - **与报告的 5.43 完全不符！**

2. **size 单位理解有误**（不太可能）
   - Linear 合约的 size 就是币数量

3. **数据来源不一致**（时间差）

---

## 关键发现

### 验证计算（基于 API 数据）

如果 API 数据正确：
```
size = 1386 MYX
markPrice = 2.35182 USDT
positionValue = 1386 × 2.35182 ≈ 3259.62 USDT
```

实际 API 返回:
```
positionValue = 3298.18 USDT
```

**差异**: 3298.18 - 3259.62 = 38.56 USDT

**解释**: 可能 markPrice 略有不同，或 positionValue 包含其他因素

### 反推 avgPrice

如果 `unrealisedPnl = -114.96`, `size = 1386`:
```
-114.96 = (markPrice - avgPrice) × 1386
avgPrice = markPrice + 114.96 / 1386
avgPrice ≈ 2.35182 + 0.0829 ≈ 2.43 USDT
```

**结论**: avgPrice 应该接近 **2.43 USDT**，而非报告的 **5.43 USDT**！

---

## 假设验证

### 假设: "报告" 数据来源有误

**可能性**:
1. "avg 5.43" 是另一个交易对的数据（如 BTCUSDT）
2. "Sell 2301" 是订单历史，而非持仓
3. 报告看的是错误的账户或时间点

### 假设: Bybit API 返回多条持仓

**可能性**:
- Hedge Mode 下，可能有 Buy 侧和 Sell 侧两条持仓
- API 筛选条件（`size > 0`）只返回了一条

### 假设: avgPrice 字段缺失导致误读

**可能性**:
- API 响应中的 avgPrice 被其他值（如 5.43）误读
- 需要打印完整的 raw data 确认

---

## 修复建议

### 1. 打印完整 API 响应（已实现）

**文件**: `quant-lab/src/providers/bybit.ts`

**新增日志**:
```typescript
console.log(`[BybitProvider] parsePosition raw data:`, {
  symbol: data.symbol,
  side: data.side,
  size: data.size,
  positionIdx: data.positionIdx,
  avgPrice: data.avgPrice,  // ← 关键！
  markPrice: data.markPrice,
  positionValue: data.positionValue,
  unrealisedPnl: data.unrealisedPnl,
});
```

### 2. 验证 side 映射逻辑

**当前逻辑**（符合官方文档）:
```typescript
const side = data.side === 'Buy' ? 'LONG' : 'SHORT';
```

**官方定义**:
- `side=Buy` → long（做多）✅
- `side=Sell` → short（做空）✅

**结论**: 映射逻辑**正确**

### 3. 处理边界 case

**空仓情况**:
```typescript
const side = data.side === 'Buy' ? 'LONG' 
           : data.side === 'Sell' ? 'SHORT' 
           : 'FLAT';  // side="" 时返回 FLAT
```

### 4. 验证多条持仓

**检查 getPositions() 是否返回多条**:
```typescript
// 已添加日志
console.log('[BybitProvider] getPositions raw response (first 3):');
result.result.list.slice(0, 3).forEach((p: any, i: number) => {
  console.log(`  [${i}] symbol=${p.symbol}, side=${p.side}, size=${p.size}, positionIdx=${p.positionIdx}`);
});
```

---

## 待确认问题

### 1. "实际持仓报告" 的来源
- 从哪里获取的？（网页？另一个 API？）
- "Sell 2301" 的具体含义？

### 2. avgPrice 的真实值
- API 返回的 avgPrice 是多少？
- 是否接近 2.43 而非 5.43？

### 3. 是否有多条持仓
- getPositions() 完整响应有几条记录？
- 是否有 Sell 侧的持仓？

---

## 结论

### 官方文档确认
- `side` 字段定义明确：Buy = long, Sell = short
- 当前映射逻辑**符合官方定义**
- Linear 合约 `size` 单位是币数量

### 矛盾根源推测
1. **最可能**: "实际持仓报告"数据来源有误或理解有偏差
2. **次可能**: avgPrice 不是 5.43，而是接近 2.43
3. **需排查**: 是否有多条持仓记录

### 下一步
1. bot-009 提供完整的 raw data 日志（包括 avgPrice）
2. 确认 getPositions() 返回的记录数
3. 确认"实际持仓报告"的数据来源

---

**状态**: 文档已查阅，映射逻辑确认正确，等待完整日志数据进一步诊断
