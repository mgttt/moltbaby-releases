# Quant-Lab 产品路线图

**版本**: v4.0  
**日期**: 2026-02-21  
**状态**: Phase 2 实盘稳定化阶段

---

## 📊 当前实盘状态（2026-02-21）

| 组 | 品种 | 模式 | ADX | 状态 |
|----|------|------|-----|------|
| A（实盘） | MYXUSDT short | live | ✅开 | systemd守护，heart#3800+ |
| B（纸盘） | MYXUSDT short | sim | ❌关 | ADX效果对照 |
| C（纸盘） | NEARUSDT short | sim | ❌关 | 保守参数测试 |
| D（纸盘） | NEARUSDT short | sim | ❌关 | 激进参数测试 |

---

## 🎯 Phase 2: 实盘稳定化（进行中）

### 已完成（2026-02-21）

| 类别 | 功能 | commit |
|------|------|--------|
| **P0修复** | 并发锁/语法错误/logger路径/ADX集成 | 82e004c01等 |
| **P1修复** | 差值监控/熔断恢复/竞态防护/杠杆硬顶/依赖自检 | 98b5d9eec等 |
| **P2优化** | 持久化/事务性/幂等性/参数版本管理 | 708277bf6等 |
| **性能** | Map索引(300x)/计数缓存/Set重组(28-66x)/tick缓存 | d5e9720bb等 |
| **基础设施** | systemd守护/OPERATIONS手册/TESTING文档 | service文件等 |
| **实验** | 四组A/B/C/D对比矩阵启动 | — |

### 进行中

| 优先级 | 功能 | 负责 | 说明 |
|--------|------|------|------|
| P1 | 纸盘B/C/D systemd守护 | a号 | 裸进程→有守护 |
| P1 | 统一监控脚本gales-watch.sh | b号 | 四组一屏对比 |

---

## 🚀 Phase 3: 可观测性（下一阶段）

### 3.1 策略PnL追踪（高价值）

**问题**：simMode下accountingPnl=0，无法比较A/B/C/D组真实表现。

**方案**：
- 基于成交记录(onOrderUpdate Filled)计算模拟PnL
- 累计PnL = Σ(成交均价差 × 成交量)
- 每组输出：总成交量/下单次数/模拟PnL/最大回撤

**价值**：量化ADX拦截的机会成本vs保护收益，指导参数决策。

### 3.2 统一监控面板（中等价值）

**方案**：
- `scripts/gales-watch.sh`：watch实时刷新四组关键指标
- Telegram日报：每日PnL/下单次数/ADX触发次数汇总
- 阈值告警：PnL回撤>X%/杠杆>Y/连续0成交超Z分钟

### 3.3 关键指标持久化（中等价值）

**方案**：
- 每次心跳写metrics到ndtsdb（心跳时间/ADX/杠杆/持仓/PnL）
- 支持历史查询：策略运行多少时间/ADX拦截多少次/损失多少机会

---

## 🚀 Phase 4: 多品种扩展（中期）

### 4.1 NEARUSDT 实盘扩展

**前提条件**：
- C/D纸盘运行≥7天，参数收敛
- A组实盘稳定运行≥30天，无P0事故
- NEAR账户资金就绪

**候选参数**（基于纸盘数据决策）：
- 保守C组参数 vs 激进D组参数，选表现更好的
- ADX是否开启：基于B vs A对比数据决定

### 4.2 多方向策略（long/short自适应）

**问题**：当前策略方向固定（手动配置short/neutral）。

**方案**：
- 趋势判断模块：ADX方向+EMA斜率→自动切换long/short
- 或：同时运行long+short（账本已隔离），市场状态决定哪边更激进

### 4.3 多账户支持

**当前**：单账户wjcgm@bbt-sub1
**目标**：多账户同策略（资金分散）或多账户多策略（风险隔离）

---

## 🚀 Phase 5: 策略智能化（长期）

### 5.1 参数自动优化

**方案**：
- 基于C/D/B纸盘历史数据，Bayesian优化gridSpacing/magnetDistance
- 优化目标：PnL/最大回撤比（Calmar Ratio）

### 5.2 回测引擎集成

**现状**：quant-lab有BacktestEngine，但未与gales-simple.js集成
**目标**：
- gales-simple.js在QuickJS沙箱中跑历史回测
- 输出：历史PnL曲线/参数敏感性分析

### 5.3 市场状态识别增强

**现状**：ADX单指标RANGING/TRENDING/STRONG_TREND
**增强**：
- 波动率聚类（低波动/中波动/高波动）→ 不同网格间距
- 成交量异常检测 → 提前预警大行情
- 资金费率感知 → 调整持仓方向偏好

---

## ⚡ 快赢清单（下次编排优先）

| 功能 | 难度 | 价值 | 说明 |
|------|------|------|------|
| simMode PnL模拟计算 | 低 | 高 | 改gales-simple.js约50行 |
| Telegram日报脚本 | 低 | 高 | cron + tg send |
| gales-watch.sh | 低 | 中 | b号进行中 |
| ndtsdb指标持久化 | 中 | 高 | 需要ndtsdb写接口 |
| NEAR实盘扩展 | 中 | 高 | 等纸盘数据支撑 |
| 参数回测框架 | 高 | 高 | 基础设施较多 |

---

## 📁 相关文档

- [运维手册](./OPERATIONS.md)
- [测试文档](./TESTING.md)
- [压力测试](./stress-test.md)
- [ADX指标](./indicators/indicator_adx.md)
- [性能分析](../reports/perf-analysis.md)
- [事故复盘](./incidents/)

---

*最后更新: 2026-02-21 by bot-001（投资组长）*

---

## ⚡ Bridge API 增强计划（2026-02-21 新增）

### 背景
当前QuickJSStrategy暴露15个bridge函数，但缺失对策略决策最关键的数据类接口。

### Phase 3.4 Bridge扩展（按ROI排序）

| Bridge | 类型 | 价值 | 说明 |
|--------|------|------|------|
| `bridge_getIndicator(name,data,params)` | 指标计算 | ⭐⭐⭐⭐⭐ | 复用quant-lib的sma/ema/rsi/macd/bb/atr，策略JS无需自实现 |
| `bridge_getFundingRate(symbol)` | 市场数据 | ⭐⭐⭐⭐ | 永续合约资金费率，方向选择+反转信号 |
| `bridge_getBestBidAsk(symbol)` | 市场数据 | ⭐⭐⭐⭐ | 实时bid/ask/spread，流动性判断+滑点估算 |
| `bridge_amendOrder(id,price,qty)` | 执行 | ⭐⭐⭐ | 直接改单，减少撤+下的时间窗口风险 |
| `bridge_cancelAllOrders(symbol?)` | 执行 | ⭐⭐⭐ | 批量撤单，紧急场景效率 |
| `bridge_recordSimTrade(price,qty,side)` | 可观测 | ⭐⭐⭐ | simMode模拟PnL，支持A/B/C/D对比 |
| `bridge_getMultiKlines([{symbol,interval}])` | 数据 | ⭐⭐ | 多品种批量K线，配对交易基础 |

### 价值说明
- **bridge_getIndicator**: quant-lib已有全套指标，暴露后gales-simple.js的ADX 100行可简化为10行调用
- **bridge_getFundingRate**: 永续合约资金费率是隐形的"方向税"，感知它才能优化持仓方向
- **bridge_getBestBidAsk**: 流动性枯竭时挂单会变成错误价格的成交，需要实时spread保护

---

## 📚 参考JoinQuant设计的缺口分析（2026-02-21）

### 核心差距（按价值排序）

**1. st_onFundingFee() 资金费率事件（P1，永续合约特有）**
- Bybit永续合约每8小时收取资金费率（通常00:00/08:00/16:00 UTC）
- 资金费率收取前是调仓/减仓的关键时间点
- 策略JS应能注册此回调：`function st_onFundingFee(feeData)`
- 实现：框架层计算下次收取时间，在心跳里检测并触发

**2. bridge_orderToTarget(side, targetNotional) 目标仓位下单（P1）**
- JQ的order_target_value核心价值：策略只说"我要多少仓"，框架算差值
- 当前gales-simple.js要自己计算 current vs target，容易漂移
- 实现：框架层读当前持仓，自动计算需买/卖多少，下单

**3. 绩效指标模块（P2）**
- Sharpe Ratio / Max Drawdown / Win Rate / Calmar Ratio
- 配合bridge_recordSimTrade，对比A/B/C/D组客观表现
- 实现：新建 src/api/metrics-api.ts，基于simTrades计算

**4. before_trading_start 等价接口（P2）**
- 加密货币24h连续交易，但资金费率/结算时间点是特殊节点
- 改为：`st_onSchedule(scheduleType)` 可注册定时任务
  - 'FUNDING'（资金费率时间）
  - 'DAILY_OPEN'（UTC 00:00）
  - 'HOURLY'（每小时）

**5. 统一Portfolio接口（P3）**
- 当前每个策略自维护state.positionNotional
- 多品种扩展时会混乱
- 目标：bridge_getPortfolio() → {positions:{[symbol]:{notional,avgCost,unrealizedPnl}}, totalEquity, leverage}

---

## 📚 三平台对标缺口（QuantConnect + Freqtrade + JoinQuant）2026-02-21

### 三平台核心设计思路

| 平台 | 核心设计哲学 |
|------|------------|
| JoinQuant | 生命周期事件 + 目标仓位下单（order_target系列）|
| QuantConnect | 事件驱动 + 模块化架构（Alpha/Risk/Execution分层）|
| Freqtrade | 信号标注 + 可插拔钩子（custom_stoploss/ROI表）|

### 高价值缺口（三平台对标后新发现）

**P1: 订单超时自动撤单 `orderTimeoutSec`（Freqtrade）**
- 当前：网格订单可能挂很久无成交，占用仓位额度
- Freqtrade：`unfilledtimeout.entry/exit` 自动撤销超时未成交订单
- 实现：CONFIG.orderTimeoutSec，每次心跳检查openOrders中挂单时长，超时→自动cancel
- 价值：减少"僵尸订单"，解放仓位额度

**P1: 动态止损回调 `st_customStoploss()`（Freqtrade）**
- 当前：只有硬仓位熔断，没有基于持仓盈亏的止损
- Freqtrade：custom_stoploss(pair, current_rate, open_rate, current_profit, trade_age_minutes)
- 实现：框架层计算持仓平均成本和当前盈亏，每心跳调用策略JS的st_customStoploss()
- 价值：策略可实现"盈利转追踪止损"逻辑，避免大回撤

**P1: 通用定时任务 `bridge_scheduleAt(cron, callback)`（QuantConnect）**
- 当前：只有st_onFundingFee特定时间点
- QuantConnect：Schedule.On(DateRules, TimeRules, action)任意时间调度
- 实现：允许策略JS注册cron表达式（简化版：每小时/每天等），框架层按时触发
- 价值：策略可自主安排：日终清网格/每小时重算参数/每天汇报日PnL

**P2: ROI时间梯度表（Freqtrade）**
- Freqtrade：minimal_roi = {"0": 0.05, "30": 0.03, "120": 0.01}
- 含义：持仓时间越久，目标收益阈值越低（快进快出优先）
- 对网格策略应用：网格触发距离可以随持仓时长动态收窄（持仓越久越激进平仓）
- 实现：CONFIG.gridTimeDecay，每tick检查各grid持仓时长，超时后降低触发距离

**P2: populate_indicators分离（Freqtrade）**
- 当前：指标计算在st_heartbeat心跳里混合，耦合度高
- Freqtrade：populate_indicators在K线准备好后独立调用
- 实现：新增st_prepareIndicators(klinesJson)，框架在每次心跳前调用，结果缓存到tickCache
- 价值：指标计算逻辑与交易逻辑解耦，更清晰

**P3: 策略实例UUID + displayName**
- 当前：策略用硬编码名（如gales-short）作为唯一标识，改名需要停服务+改systemd+改监控
- 设计：每个策略实例分配UUID作为内部标识，displayName作为人读标签
  - UUID：系统层使用（systemd service名、日志文件、状态持久化路径、orderLinkId前缀）
  - displayName：展示层使用（监控面板、告警消息、CLI列表、日报）
  - 改名 = 只改displayName，零停机零风险
- 实现：策略注册时自动生成UUID，配置文件增加displayName字段
- 迁移：现有策略自动以当前名作为UUID和displayName（向后兼容）

**P3: Alpha/Execution分层架构（QuantConnect）**
- QuantConnect：Alpha Model生成信号 → Portfolio Construction → Execution Model执行
- 对我们：策略JS = Alpha Model；框架TS = Execution Model；Bridge = 信号传递层
- 价值：多策略信号聚合（多个Alpha共享一个Execution），多品种组合管理基础

