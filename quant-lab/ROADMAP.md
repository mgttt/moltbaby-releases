# Quant-Lab 开发路线图

> **版本**: v3.1 (2026-02-17)
> **架构**: Strategy Interface + Backtest/Live Engines
> **当前优先级**: 订单状态机P1 + ndtsdb集成规划

---

## 🎯 当前状态

| 模块 | 完成度 | 说明 |
|------|--------|------|
| **策略接口** | ✅ 100% | Strategy / StrategyContext |
| **回测引擎** | ✅ 100% | BacktestEngine（事件驱动 + 完整指标） |
| **实盘引擎** | ✅ 100% | LiveEngine（WebSocket + Provider + 风控） |
| **QuickJS 沙箱** | ✅ 100% | 策略代码/参数热更新 + 错误隔离 **← P0 完成** |
| **热更新完全形态** | ✅ 100% | SIGUSR1信号触发策略+引擎+库层全量热更新 **← 2026-02-17 完成** |
| **策略池化** | ⏳ 0% | workerpool-lib 集成 **← 等订单状态机P0完成后** |
| **参数-波动率结构研究** | ⏳ 0% | 研究gales参数与波动率的最佳结构形式（不做网格搜索/遗传算法）**← 2026-02-17 总裁指示** |
| **Provider 生态** | ⏳ 40% | Paper ✅ / Binance 📝 / Bybit 📝 |
| **ndtsdb集成** | ⏳ 0% | 时序数据库 **← 2026-02-17 总裁指示：等系统稳定后开始** |
| **测试覆盖** | ⏳ 30% | 基础测试已有，待完善 |
| **文档** | ✅ 80% | README + Provider 指南已有 |
| **订单状态机** | 🔥 P1 | 异常单检测已完成，STATE_MISMATCH=0 **← 2026-02-17 完成** |

---

## 📋 已完成（2026-02-10）

### Phase 1: 核心引擎 ✅
- [x] Strategy 接口定义
- [x] StrategyContext API
- [x] BacktestEngine 实现
  - [x] 仓位管理（LONG/SHORT/FLAT）
  - [x] 订单执行（MARKET/LIMIT + 手续费 + 滑点）
  - [x] 盈亏跟踪（已实现 + 未实现）
  - [x] 权益曲线记录
  - [x] 回测指标（回报/回撤/夏普/胜率/盈亏比）
- [x] LiveEngine 实现
  - [x] WebSocket 架构
  - [x] Provider 集成
  - [x] 风控管理（最大仓位/回撤限制）
  - [x] 状态持久化（可选 KlineDatabase）

### Phase 2: Provider 生态 ⏳
- [x] TradingProvider 接口定义
- [x] PaperTradingProvider（模拟交易，完整实现）
- [ ] BinanceProvider（框架 + TODO）
- [ ] BybitProvider（框架 + TODO）

### Phase 3: 示例策略 ⏳
- [x] SimpleMAStrategy（双均线交叉）
- [x] 回测测试（backtest-simple-ma.ts）
- [x] 实盘测试（live-paper-trading.ts）
- [ ] 更多策略（网格/马丁/趋势跟踪）

---

## 🔥 待完成任务

### 最高优先级（本周）⭐

#### 1. QuickJS 沙箱策略运行器 ✅ **100% 完成**
**目标**：支持 `.js` 策略文件，提升迭代速度

**⚠️ 运行器一致性/稳定性补强（Follow-up / P0）** ✅ **已完成 (2026-02-11)**
- [x] PaperTrade 语义与执行层一致（引入 DRY_RUN 环境变量，默认不触发真实 API）
- [x] 订单闭环：placeOrder 返回真实 orderId（pending→real 映射回写），并定期回推 openOrders/成交到 `st_onOrderUpdate`
- [x] `bridge_cancelOrder` 确认可用（支持 orderId→symbol 自动补齐）
- [x] 网络/代理抖动下的重试与错误分类（指数退避重试 + timeout/SSL EOF 分类）

**完成记录**：
- **提交**: `bb3a83529` (2026-02-11)
- **工期**: 3.5 小时（预估 4-6 小时）
- **测试**: test-papertrade-p0-fixes.ts (8/8 通过)
- **验收**: 所有 P0 问题已修复并验证


**核心优势**：
- ✅ 策略代码热重载（文件变化自动重启，保持状态）
- ✅ **参数热更新**（无需重启沙箱，零停机调参）**← P0 关键利器**
- ✅ 安全隔离（沙箱运行 + 错误隔离）
- ✅ 纯 JS（无需编译 TypeScript）
- ✅ 快速迭代（修改策略/参数立即生效）

**实现任务**：
- [x] QuickJS 沙箱初始化 ✅
- [x] 策略 API 注入（bridge: log/state/price/account/order）✅
- [x] 生命周期适配（st_init/st_heartbeat/st_stop/st_onParamsUpdate）✅
- [x] 状态持久化（bridge_stateGet/Set + JSON 文件）✅
- [x] **策略代码热重载**（hotReload: watchFile + 自动重启）✅
- [x] **参数热更新**（updateParams: 无需重启沙箱）✅ **P0 完成**
- [x] **bridge_placeOrder**（连接 StrategyContext + 队列化异步）✅
- [x] **bridge_cancelOrder**（连接真实撤单 API）✅
- [x] **bridge_getPrice**（缓存 + 实时更新）✅
- [x] **bridge_getPosition**（缓存 + 定期刷新）✅
- [x] **bridge_getAccount**（缓存 + 定期刷新）✅
- [x] **错误隔离与自动恢复**（try-catch + 错误计数 + 自动重启）✅

**完成时间**：2026-02-10  
**提交**: `654b0a69f` (P0 参数热更新) + `89c64b25f` (完整版)  
**测试**: `tests/test-param-hot-update.ts` 全部通过 ✅

**参考**：
- `archived/v2.0-director-worker/worker/strategy-loader.ts` - v2.0 实现
- `archived/v2.0-director-worker/strategies/grid-magnet/grid-magnet.js` - 策略示例

---

#### 2. 策略池化（workerpool-lib 集成）🔥 **P1 - 最高优先级**
**目标**：并行运行多策略实例

**核心价值**：
- 🚀 **并行回测**（100 组参数同时跑 → 8x 加速）
- 🔧 **资源隔离**（每个策略独立 Worker）
- 📊 **结果聚合**（自动找最优参数 + 排行榜）

**实现任务**：
- [ ] BacktestWorker（执行单次回测任务）
  - [ ] Task 定义（strategyId + params + dataRange）
  - [ ] execute() 实现（加载数据 + 运行回测 + 返回指标）
- [ ] StrategyScheduler（基于 workerpool-lib Pool）
  - [ ] runParallelBacktests()（并行提交任务）
  - [ ] 结果收集与排序
- [ ] LiveSwitcher（自动切换实盘参数）
  - [ ] switchParams()（撤单 + 暂停 + 更新 + 恢复）
  - [ ] autoSwitch()（定期优化 + 阈值触发）

**预估工期**：2-3 天  
**依赖**：workerpool-lib 集成  
**参考**：`docs/ARCHITECTURE-ASSESSMENT-HOT-UPDATE.md`

---

---

#### 4. ndtsdb 数据持久化 🔥 **等系统稳定后开始**
**目标**：用更专业的时序数据库替代JSON文件存储

**总裁指示（2026-02-17）**：
- 等策略交易系统稳定后开始应用
- 目的：更专业（当前全部JSON文件，ndtsdb 8.9M ticks/s更适合时序数据）
- 渐进迁移：JSON状态文件并行保留一个阶段
- 优先迁移：tick数据/K线/成交历史/回测数据

**实现任务**：
- [ ] 订单事件写入（gales-event → ndtsdb）
- [ ] 策略状态快照（定期持久化）
- [ ] 盈亏分析查询（SQL 聚合）
- [ ] 回测数据对比（paper vs backtest）

**预估工期**：2-3 天  
**当前状态**：ndtsdb v0.9.0就绪，quant-lab全部JSON文件存储

**参考**：
- `ndtsdb/` - 时序数据库
- `quant-lib/src/storage/database.ts` - KlineDatabase 示例

---

#### 3. 实盘风控增强 ⏸️ 延后
**目标**：保护实盘资金安全

**实现任务**：
- [ ] 最大回撤限制（实时监控 + 自动停止）
- [ ] 紧急停止机制（Ctrl+C / API 触发）
- [ ] 仓位监控告警（超限推送 Telegram）
- [ ] 订单簿监控（防止异常订单）

**预估工期**：0.5-1 天  
**状态**：待 QuickJS 集成完成后推进

---

### 高优先级（本周）

#### 4. 完善 BinanceProvider / BybitProvider
**目标**：让实盘引擎可连接真实交易所

**待实现**：
- [ ] WebSocket K线订阅
- [ ] REST API 订单执行
- [ ] 账户/持仓查询
- [ ] HMAC SHA256 签名
- [ ] 错误处理 + 重连机制

**预估工期**：1-2 天

**参考**：
- `src/providers/paper-trading.ts` - 实现示例
- `quant-lib/src/providers/binance.ts` - REST API 参考
- `src/providers/README.md` - 实现指南

---

#### 2. 策略库扩展
**目标**：提供更多示例策略

**计划策略**：
- [ ] GridStrategy（网格交易）
- [ ] MartingaleStrategy（马丁格尔）
- [ ] TrendFollowingStrategy（趋势跟踪）
- [ ] MeanReversionStrategy（均值回归）

**预估工期**：每个策略 0.5-1 天

---

#### 3. 测试覆盖
**目标**：提升测试覆盖率

**待补充**：
- [ ] BacktestEngine 单元测试
- [ ] LiveEngine 单元测试
- [ ] Provider 单元测试
- [ ] 集成测试（完整回测 + 实盘流程）
- [ ] 性能测试（10K+ bars 回测）

**预估工期**：2-3 天

---

### 中优先级（下周）

#### 4. 回测结果可视化
**目标**：生成可视化回测报告

**功能**：
- [ ] 权益曲线图
- [ ] 回撤曲线图
- [ ] 交易分布图
- [ ] 月度收益表
- [ ] HTML 报告导出

**技术栈**：Chart.js / D3.js

**预估工期**：2-3 天

---

#### 5. 策略参数优化
**目标**：自动寻找最优策略参数

**功能**：
- [ ] 网格搜索
- [ ] 遗传算法
- [ ] 贝叶斯优化
- [ ] 参数敏感性分析

**预估工期**：3-5 天

---

#### 6. 风控增强
**目标**：更完善的风控系统

**功能**：
- [ ] 单日最大亏损限制
- [ ] 单笔最大亏损限制
- [ ] 持仓时间限制
- [ ] 止损/止盈自动执行
- [ ] 杠杆控制

**预估工期**：2-3 天

---

### 低优先级（后续）

#### 7. 多账户管理
**目标**：支持多个交易所账户

**功能**：
- [ ] 账户池管理
- [ ] 资金分配策略
- [ ] 跨账户风险聚合

**预估工期**：3-5 天

---

#### 8. 实时监控
**目标**：实盘运行监控

**功能**：
- [ ] Prometheus metrics 导出
- [ ] Grafana 仪表盘
- [ ] 告警系统（Telegram/Email）
- [ ] 策略健康检查

**预估工期**：3-5 天

---

#### 9. 策略市场
**目标**：策略分享平台

**功能**：
- [ ] 策略发布/订阅
- [ ] 策略版本管理
- [ ] 策略性能排行榜
- [ ] 策略评论/评分

**预估工期**：1-2 周

---

## 🚀 下一步行动

### 本周（2026-02-10 ~ 2026-02-16）
1. ✅ **QuickJS 沙箱完成**（100%，含参数热更新）
2. 🔥 **回测数据源稳定**（P0 - 最高优先级）⭐
   - 多数据源 fallback（Binance → CoinGecko）
   - 数据预填充包（Top 20 币种 2020-2025）
   - 数据下载脚本
   - 数据覆盖率检查
3. 🔥 **策略池化（P1）**（workerpool-lib 集成 + BacktestWorker）
4. 🔥 **参数优化器（P2）**（网格搜索 + 自动切换）
5. ⏳ 完善 Provider（Binance/Bybit WebSocket + REST）

### 下周（2026-02-17 ~ 2026-02-23）
6. 数据质量检查
7. CSV 导出 + Python 可视化
8. 回测结果可视化
9. 补充 GridStrategy 示例
10. 完善测试覆盖
11. 风控增强（实盘监控 + 告警）

---

## 📝 架构演进

### v1.0（已弃用）
- 独立 TreeWorkerPool 实现

### v2.0（已归档）
- 基于 workpool-lib + Director + Worker + QuickJS Sandbox
- 复杂三层架构
- **归档位置**：`archived/v2.0-director-worker/`

### v3.0（当前）⭐
- Strategy Interface + Backtest/Live Engines + Providers
- 简洁两层架构
- 统一回测和实盘代码
- **完成日期**：2026-02-10

---

## 🎓 设计决策

### 为什么放弃 v2.0 架构？
1. **复杂度过高**：Director + Worker + QuickJS 三层，维护成本高
2. **文档不一致**：README 与实际代码不一致
3. **调试困难**：QuickJS 沙盒增加调试难度
4. **性能开销**：沙盒序列化/反序列化开销大

### v3.0 架构优势
1. **简洁**：两层架构，易于理解
2. **统一**：回测和实盘使用相同代码
3. **可测试**：标准 TypeScript，易于单元测试
4. **高性能**：无沙盒开销，直接执行

---

## 📊 里程碑

| 版本 | 目标 | 完成日期 |
|------|------|----------|
| v1.0 | 独立实现 | ✅ 已弃用 |
| v2.0 | workpool-lib 集成 | ✅ 已归档（2026-02-10） |
| v3.0 | Strategy Engine | ✅ 2026-02-10 |
| **v3.1** | **QuickJS 沙箱完整版** | ✅ **2026-02-10** |
| v3.2 | 策略池化 + 参数优化 | ⏳ 2026-02-16 |
| v3.3 | 可视化 + Provider 完善 | ⏳ 2026-02-23 |
| v3.4 | 多账户 + 监控 | ⏳ 2026-03-xx |

---

*最后更新: 2026-02-10*  
*维护者: OpenClaw 🦀*
