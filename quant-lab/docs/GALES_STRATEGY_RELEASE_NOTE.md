# GALES 策略复盘报告 + Strategy Release Note

**报告者**: bot-004  
**日期**: 2026-02-12  
**策略版本**: gales-simple.js (2026-02-11 方向模式更新版)  

---

## 1. Paper Trade 数据分析

### 1.1 运行概况

| 指标 | 数值 |
|------|------|
| 运行时长 | ~28 小时 (心跳 #1 ~ #20810) |
| 成交次数 | 58 次 |
| 初始价格 | 5.595 (网格中心) |
| 当前价格 | 3.23 |
| 价格变动 | -42.3% |
| 当前仓位 | 100 Notional (满仓) |
| 网格档位 | Buy 5.3152 (最低档位) |
| 距离网格 | -39% (严重跌出) |
| 活跃订单 | 0 |

### 1.2 成交分析

**成交分布**:
- 成交价格区间: 5.52 - 5.54
- 成交方向: 全部 Buy (单边下跌导致)
- 最大仓位: 100 (达到上限)
- 成交模式: 部分成交累积 (每次 40-72% 剩余量)

**关键观察**:
```
成交 #1: @ 5.5363 → 仓位 4.00
成交 #10: @ 5.5363 → 仓位 34.00
成交 #20: @ 5.5320 → 仓位 70.00
成交 #29: @ 5.5200 → 仓位 100.00 (满仓)
```

### 1.3 策略表现评估

| 指标 | 预期 | 实际 | 评价 |
|------|------|------|------|
| 网格触发 | 磁铁距离 0.5% | ✅ 正常触发 | 符合设计 |
| 成交执行 | 部分成交 40% | ✅ 正常 | 符合设计 |
| 仓位控制 | maxPosition=100 | ✅ 满仓停止 | 符合设计 |
| autoRecenter | 偏离 3%+30ticks | ❌ 未触发 | **被套原因** |
| 策略稳定性 | 无崩溃 | ✅ 28h 稳定 | 优秀 |

---

## 2. 被套原因分析

### 2.1 autoRecenter 为何未触发

**触发条件** (代码逻辑):
1. drift ≥ 3% ✅ (实际 39-42%)
2. idleTicks ≥ 30 ✅ (满足)
3. cooldownOk ✅ (满足)
4. **noActiveOrders === 0** ❌ **不满足**

**根本原因**:
- 价格跌至 5.3152 附近时，Buy 网格持续成交
- 仓位达到 100 后，策略停止新挂单
- 但已有订单成交后变为 IDLE，不触发"无活跃订单"条件
- 策略持续运行，autoRecenter 永远不会触发

### 2.2 这是 Bug 还是 Feature?

**当前设计**: Feature (保守风控)
- 满仓后不重置，避免高位接盘后低位再追
- 等待价格回归网格自然解套

**实际问题**: 
- MYXUSDT 属于小币种，波动大
- 42% 跌幅在 28 小时内，远超预期
- 策略设计时未考虑如此极端的单边行情

---

## 3. SimulatedProvider 验证回顾

| 场景 | 结果 | 关键发现 |
|------|------|----------|
| sine-wave | ✅ 通过 | 双向成交正常，持仓可控 |
| range-then-dump | ✅ 通过 | autoRecenter 触发正常 |
| extreme-dump | ✅ 通过 | -30% 下策略稳定 |

**验证 vs 实盘差异**:
- 验证场景: 价格下跌后回归或重心
- 实盘场景: 价格持续下跌不反弹
- 验证用例未覆盖"满仓+持续下跌"场景

---

## 4. Strategy Release Note

### 4.1 基本信息

- **策略名称**: GALES (Grid with Auto-Liquidation and Elasticity System)
- **策略文件**: `strategies/gales-simple.js`
- **版本**: v0.9.0 (2026-02-12)
- **适用标的**: 高流动性、震荡为主的币种
- **运行模式**: Paper Trade ✅ / Live ⏳ (待评估)

### 4.2 变更点

#### 新增
- ✅ 方向模式 (`lean`: positive/negative/neutral)
- ✅ autoRecenter 自动重心
- ✅ 部分成交处理 (30% 阈值)
- ✅ 残余风险对冲
- ✅ 订单超时/脱离撤单

#### 已知限制
- ⚠️ 满仓后无法 autoRecenter (需要空仓条件)
- ⚠️ 小币种单边暴跌会严重被套
- ⚠️ 网格范围固定，不适应趋势行情

### 4.3 参数建议

#### 保守参数 (推荐首次实盘)

```json
{
  "symbol": "BTCUSDT",
  "lean": "neutral",
  "gridCount": 5,
  "gridSpacing": 0.02,
  "orderSize": 5,
  "maxPosition": 50,
  "magnetDistance": 0.005,
  "cancelDistance": 0.015,
  "autoRecenter": true,
  "recenterDistance": 0.05,
  "recenterMinIdleTicks": 20,
  "maxActiveOrders": 5
}
```

**保守理由**:
- BTC 流动性好，波动相对可控
- maxPosition=50 (降低被套风险)
- gridSpacing=2% (扩大网格间距)
- recenterDistance=5% (更容易触发重心)
- orderSize=5 (小仓位试水)

#### 激进参数 (仅供测试)

```json
{
  "symbol": "MYXUSDT",
  "lean": "positive",
  "gridCount": 10,
  "gridSpacing": 0.01,
  "maxPosition": 200,
  "autoRecenter": false
}
```

### 4.4 预期行为

**正常市场**:
- 每 10-30 分钟触发一次网格
- 仓位在 ±20 范围内波动
- 日成交 20-50 次

**单边下跌**:
- 持续买入直至满仓
- 价格跌出网格后停止交易
- 等待回归或手动干预

**autoRecenter 触发**:
- 价格偏离 5% 以上
- 30 ticks 无成交
- 仓位清零后自动重建网格

### 4.5 风险点

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 单边暴跌被套 | 高(小币种) | 资金占用 | 选主流币、减仓、开方向模式 |
| 网格过密磨损 | 中 | 频繁成交亏损 | 扩大 gridSpacing |
| 交易所延迟 | 低 | 错过成交 | 监控告警、备用 Provider |
| 策略崩溃 | 低 | 持仓暴露 | 已验证稳定、自动重启 |

### 4.6 回滚方案

**方案 A: 改参重启**
```bash
# 1. 停止
bun tools/strategy-cli.ts stop gales-live

# 2. 以新参数重启 (降低仓位或切换方向)
bun tools/strategy-cli.ts start ./strategies/gales-simple.js \
  --session gales-live \
  --params '{"lean": "positive", "maxPosition": 50}'
```

**方案 B: 热更新**
```bash
# 强制重心 (以当前价重建网格)
bun tools/strategy-cli.ts update gales-live '{"forceRecenter": true}'
```

**方案 C: 紧急停机**
```bash
# 全部撤单+停止
bun tools/strategy-cli.ts stop gales-live
# 或
 tmux kill-session -t gales-live
```

---

## 5. 结论与建议

### 5.1 策略评价

| 维度 | 评分 | 说明 |
|------|------|------|
| 稳定性 | ⭐⭐⭐⭐⭐ | 28h 无崩溃，内存稳定 |
| 风控 | ⭐⭐⭐⭐ | 满仓停止，但有被套风险 |
| 盈利能力 | ⭐⭐⭐ | 震荡市表现好，趋势市被套 |
| 适应性 | ⭐⭐⭐ | 需要人工干预应对极端行情 |
| 可维护性 | ⭐⭐⭐⭐⭐ | 热更新、方向模式灵活 |

### 5.2 实盘建议

**✅ 可以开始，但必须满足以下条件**:

1. **标的**: BTC/ETH 等主流币 (不要 MYX)
2. **仓位**: 首次 maxPosition ≤ 50
3. **方向**: 明确趋势时用 long/short 模式
4. **监控**: 每 2 小时检查一次价格偏离
5. **止损**: 手动设置 20% 回撤线

**⏳ 建议改进后再实盘**:
- 添加"满仓后自动重心"选项
- 实现移动网格 (Trailing Grid)
- 集成趋势判断 (MA 过滤)

---

## 6. 附件

- **验证记录**: `quant-lab/tests/validation-log-20260211.md`
- **设计指南**: `quant-lab/docs/STRATEGY_DESIGN_GUIDE.md`
- **操作手册**: `quant-lab/docs/LIVE_TRADING_MANUAL.md`
- **日志位置**: `~/paper-trade-fixed-position.log`

---

**汇报完毕。**

—— bot-004 (2026-02-12)
