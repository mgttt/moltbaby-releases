# 量化组进化路线图

> **制定时间**: 2026-02-13  
> **制定人**: bot-001（开发总工）  
> **当前系统**: quant-lib + quant-lab + ndtsdb

---

## 🔍 系统现状诊断

### 当前三层架构

| 层级 | 模块 | 版本 | 完成度 | 核心能力 |
|------|------|------|--------|----------|
| **数据库层** | ndtsdb | v0.9.4.4 | ✅ 95% | 时序存储 + 压缩 + 索引 + SQL + 分区裁剪 |
| **数据层** | quant-lib | v0.1.0 | ⏳ 70% | Provider 框架 + 技术指标库 + KlineDatabase |
| **引擎层** | quant-lab | v3.0 | ⏳ 75% | QuickJSStrategy + Backtest/Live Engine |

### 实盘状态
- ✅ 策略：gales-simple.js（磁铁网格）
- ✅ 交易所：Bybit MYXUSDT
- ✅ 模式：Paper Trade（simMode=true）
- ✅ 监控：watchdog 实盘日志监控

---

## ❓ 五个核心问题分析

### 1. 策略引擎瓶颈：QuickJS 够用吗？

#### QuickJS 当前优势 ✅
- **安全隔离**：沙箱运行，策略崩溃不影响引擎
- **热重载**：文件变化自动重启（保持状态）
- **参数热更新**：`updateParams()` 零停机调参（P0 已完成）
- **状态持久化**：JSON 文件自动保存/恢复
- **轻量级**：相比 V8 内存占用小
- **纯 JS**：无需编译 TypeScript，迭代快

#### QuickJS 潜在瓶颈 ⚠️
| 场景 | QuickJS 性能 | V8/Node 性能 | 是否够用 |
|------|--------------|--------------|----------|
| 低频策略（分钟/小时级） | ✅ 完全够用 | 过剩 | ✅ |
| 中频策略（秒级/5s 心跳） | ✅ 够用（已实测） | 略快 | ✅ |
| 高频策略（Tick 级/100ms） | ⚠️ 可能瓶颈 | 快 2-3x | ❌ |
| 复杂指标计算（1000+ 窗口） | ⚠️ 慢（无 SIMD） | 快 | ⚠️ |
| 大规模回测（100K+ K线） | ⚠️ 慢 | 快 | ⚠️ |

#### 诊断结论
- ✅ **当前业务（低频网格策略）完全够用**
- ⚠️ **未来扩展需要混合架构**：
  - 低频策略：继续用 QuickJS（安全 + 热重载）
  - 高频策略：用原生 TypeScript（性能优先）
  - 指标计算：下沉到 quant-lib（TypeScript）或 C/SIMD

#### 优化方向
1. **短期**（P2）：指标计算下沉到 quant-lib（避免在沙箱中计算）
2. **中期**（P3）：混合架构支持（QuickJS + Native TS 策略并存）
3. **长期**（P4）：考虑 QuickJS-ng（支持 JIT，性能提升 2x）

---

### 2. 数据层缺失：实时 Tick 数据管道？

#### 当前数据流 ✅
```
REST API → 历史 K线 → ndtsdb 持久化
WebSocket → 实时 K线 → 策略消费
```

#### 缺失部分 ❌
| 功能 | 现状 | 影响 | 优先级 |
|------|------|------|--------|
| **实时 Tick 数据管道** | ❌ 无统一抽象 | 高频策略无法实现 | **P1** |
| **数据质量检查** | ❌ 无校验 | 脏数据污染策略 | **P2** |
| **多源数据融合** | ❌ 单一 Provider | 套利策略无法实现 | **P2** |
| **L2 订单簿数据** | ❌ 仅 L1 Ticker | 无法分析深度 | **P3** |
| **数据回放工具** | ❌ 无 | 回测不够真实 | **P3** |

#### 实时 Tick 数据管道设计（P1）
```typescript
// 统一 Tick 数据抽象
interface TickStream {
  subscribe(symbols: string[], handler: (tick: Tick) => void): void;
  unsubscribe(symbols: string[]): void;
  getLastTick(symbol: string): Tick | null;
}

// 多 Provider 融合
class MultiProviderTickStream implements TickStream {
  constructor(providers: TradingProvider[]);
  // 自动合并多源 tick，按时间戳排序
  // 支持冲突检测（价格偏差报警）
}

// ndtsdb 持久化
class TickRecorder {
  constructor(stream: TickStream, db: PartitionedTable);
  start(): void; // 自动订阅 + 批量写入 ndtsdb
}
```

#### 优先级排序
1. **P1**（本月）：实时 Tick 数据管道 + ndtsdb 持久化
2. **P2**（下月）：数据质量检查（缺失值/异常值/时间戳跳跃）
3. **P3**（3 月）：L2 订单簿 + 数据回放工具

---

### 3. 回测系统加速：能更快吗？

#### 当前性能基线
- **单线程回测**：1000 K线/秒（粗估）
- **并行回测**（P1 规划中）：理论 8x 加速（8 核）

#### 加速方向分析
| 方向 | 加速比 | 实现难度 | 优先级 | 预估工期 |
|------|--------|----------|--------|----------|
| **并行回测** | 8x | 中（workpool-lib） | **P1** | 3 天 |
| **向量化计算** | 2-3x | 中（batch 处理） | **P2** | 2 天 |
| **增量回测** | 5-10x | 高（缓存中间结果） | **P3** | 5 天 |
| **JIT 编译** | 2x | 高（QuickJS-ng） | **P4** | 7 天 |
| **GPU 加速** | 10-100x | 极高（CUDA/WebGPU） | **P5** | 14 天 |
| **分布式回测** | 无限 | 极高（Redis 队列） | **P6** | 14 天 |

#### 推荐路线（性价比优先）
1. **P1 并行回测**（本月完成）
   - 基于 workpool-lib（已有框架）
   - 多参数/多品种并行测试
   - 预期加速比：8x（8 核）

2. **P2 向量化计算**（下月）
   - 批量处理 K线（避免逐根计算）
   - 指标计算向量化（SMA/EMA 等）
   - 预期加速比：2-3x

3. **P3 增量回测**（3 月）
   - 缓存中间结果（已测参数不重复计算）
   - 仅测新数据 + 新参数组合
   - 预期加速比：5-10x

#### 总加速比预估
- 并行（8x）× 向量化（2x）× 增量（5x）= **80x 加速**
- 100K K线回测：从 100 秒 → 1.25 秒

---

### 4. 独立工具抽象：像 BotCorp 一样积木化

#### BotCorp 积木架构参考
- `llm-cli`：LLM 调用 CLI（支持多 Provider）
- `tg-cli`：Telegram 消息 CLI（队列/合并/限速）
- `workpool-lib`：任务池（并发/重试/状态管理）

#### 量化系统可抽象工具
| 工具名 | 功能 | 示例命令 | 优先级 |
|--------|------|----------|--------|
| **kline-cli** | K线数据拉取/查询 | `kline fetch BTCUSDT 1h 2024-01-01` | **P1** |
| **indicator-cli** | 技术指标计算 | `indicator sma --input data.csv --period 20` | **P2** |
| **backtest-cli** | 回测执行器 | `backtest run strategy.js --symbol BTCUSDT` | **P1** |
| **provider-cli** | 交易所连接 | `provider bybit balance` | **P2** |
| **ndtsdb-cli** | 时序数据库 CLI | `ndtsdb query "SELECT * FROM btc"` | ✅ **已有** |

#### kline-cli 设计示例（P1）
```bash
# 拉取历史数据
kline fetch BTCUSDT 1h --start 2024-01-01 --end 2024-12-31 --output btc.csv

# 查询本地数据（基于 ndtsdb）
kline query "SELECT * FROM btc WHERE close > 50000" --format json

# 实时订阅
kline subscribe BTCUSDT 1m --callback "curl http://localhost:3000/tick"

# 数据质量检查
kline validate btc.csv --check-missing --check-outliers
```

#### backtest-cli 设计示例（P1）
```bash
# 运行回测
backtest run strategy.js --symbol BTCUSDT --start 2024-01-01

# 参数优化
backtest optimize strategy.js --param gridCount=5,10,15,20 --metric sharpe

# 批量回测
backtest batch strategies/*.js --symbols BTCUSDT,ETHUSDT --parallel 8

# 生成报告
backtest report backtest-results.json --format html --output report.html
```

#### 工具链优势
- ✅ **Agent 友好**：bot-004/bot-009 可直接调用 CLI（无需写代码）
- ✅ **标准化输出**：所有工具输出 JSON（易于解析）
- ✅ **组合使用**：`kline fetch | indicator sma | backtest run`
- ✅ **独立部署**：可单独发布为 npm 包

---

### 5. BotCorp 融合：积木架构怎么结合？

#### 当前 BotCorp 能力
- **Agent 通信**：tg-cli（队列/合并/限速）
- **任务调度**：workpool-lib（并发/重试）
- **文档管理**：MEMORY.md + state cards
- **LLM 辅助**：llm-cli（多 Provider）

#### 融合方向 1：AI 辅助策略决策
**场景**：策略遇到不确定情况，调用 LLM 辅助决策

```javascript
// 策略 JS 中调用 llm-cli
function st_heartbeat(tick) {
  const rsi = getIndicator('RSI');
  
  if (rsi > 70) {
    // 超买，但不确定是否该卖出
    const advice = bridge_llm(`
      当前 BTC 价格 ${tick.price}
      RSI=${rsi}，MACD 金叉
      市场情绪：贪婪指数 75
      
      是否应该卖出？请给出建议和理由。
    `);
    
    logInfo('[AI建议] ' + advice);
    
    // 策略综合 AI 建议 + 技术指标决策
    if (advice.includes('卖出')) {
      sell(symbol, qty);
    }
  }
}
```

**实现**：
- 新增 `bridge_llm(prompt)` API（调用 llm-cli）
- LLM 返回结构化建议（JSON 格式）
- 策略代码综合 AI + 技术指标决策

**优先级**：P3（探索性功能）

---

#### 融合方向 2：Agent 协作量化
**场景**：多 Agent 协同开发/运维量化系统

| Agent | 角色 | 职责 | 工具链 |
|-------|------|------|--------|
| **bot-004** | 策略开发师 | 开发策略 JS + 参数优化 | backtest-cli, indicator-cli |
| **bot-009** | 实盘操盘手 | 监控实盘 + 调参 + 异常处理 | provider-cli, kline-cli |
| **bot-001** | 开发总工 | 维护引擎 + 修 bug + 性能优化 | 全部 |

**通信机制**：
- bot-004 开发新策略 → `tg send bot-009 "[策略就绪] gales-v2.js 回测夏普 2.3"`
- bot-009 发现异常 → `tg send bot-001 "[紧急] 实盘心跳停滞 5 分钟"`
- bot-001 修复 bug → `tg send bot-009 "[修复完成] commit abc123, 重启实盘"`

**自动化工作流**：
```bash
# bot-004 开发策略后自动回测
backtest run new-strategy.js --auto-notify bot-009

# bot-009 监控实盘，异常自动通知
watchdog monitor --alert bot-001 --threshold "heartbeat_stall=300s"

# bot-001 修复后自动部署
git commit && git push && tg send bot-009 "[部署完成] 请重启实盘"
```

**优先级**：P2（提升协作效率）

---

#### 融合方向 3：数据驱动的 Agent 调度
**场景**：行情异常/策略性能下降自动触发 Agent 任务

```yaml
# 规则引擎配置
rules:
  - name: 行情暴跌预警
    condition: price_change_5m < -5%
    action: tg send bot-009 "⚠️ BTC 5分钟跌5%，检查风控"
  
  - name: 策略性能下降
    condition: sharpe_7d < 0.5
    action: |
      backtest optimize gales.js --param gridCount=5,10,15
      tg send bot-004 "策略性能下降，已触发自动优化"
  
  - name: 新数据到达
    condition: new_klines > 1000
    action: |
      indicator update BTCUSDT
      tg send bot-009 "指标已更新，可检查新信号"
```

**实现**：
- 规则引擎（基于 cron + watchdog）
- 条件检测（基于 kline-cli / provider-cli 查询）
- 动作执行（调用 backtest-cli / tg-cli）

**优先级**：P3（自动化运维）

---

#### 融合方向 4：统一工具链输出格式
**目标**：所有量化工具输出 JSON，Agent 可直接解析

```bash
# kline-cli 输出 JSON
kline fetch BTCUSDT 1h --format json > btc.json

# indicator-cli 输出 JSON
indicator sma --input btc.json --period 20 --format json > sma.json

# backtest-cli 输出 JSON
backtest run strategy.js --format json > result.json

# Agent 直接解析
llm-cli "根据回测结果 $(cat result.json)，给出策略优化建议"
```

**标准化输出格式**：
```json
{
  "tool": "backtest-cli",
  "version": "1.0.0",
  "timestamp": "2024-01-01T00:00:00Z",
  "status": "success",
  "data": {
    "totalReturn": 0.23,
    "sharpeRatio": 1.85,
    "maxDrawdown": 0.12
  },
  "errors": []
}
```

**优先级**：P1（基础设施）

---

## 📋 进化路线图总结

### Phase 1：工具链建设（本月，P1）
**目标**：抽象独立工具，提升 Agent 协作效率

| 任务 | 工期 | 负责 | 产出 |
|------|------|------|------|
| 1.1 kline-cli（拉取/查询/订阅） | 2 天 | bot-001 | CLI + 文档 |
| 1.2 backtest-cli（运行/优化/批量） | 3 天 | bot-001 | CLI + 文档 |
| 1.3 并行回测集成（workpool-lib） | 3 天 | bot-001 | backtest-cli 优化 |
| 1.4 统一输出格式（JSON schema） | 1 天 | bot-001 | 规范文档 |

**验收标准**：
- ✅ bot-004 可用 backtest-cli 优化策略参数
- ✅ bot-009 可用 kline-cli 查询实时价格
- ✅ 所有工具输出 JSON 格式

---

### Phase 2：数据管道增强（下月，P2）
**目标**：补齐实时 Tick 数据 + 数据质量保障

| 任务 | 工期 | 负责 | 产出 |
|------|------|------|------|
| 2.1 实时 Tick 数据管道（TickStream） | 3 天 | bot-001 | quant-lib 新模块 |
| 2.2 多 Provider 融合（MultiProviderTickStream） | 2 天 | bot-001 | quant-lib 新模块 |
| 2.3 数据质量检查（缺失值/异常值） | 2 天 | bot-001 | kline-cli 新功能 |
| 2.4 Provider CLI（余额/持仓/下单） | 2 天 | bot-001 | provider-cli |

**验收标准**：
- ✅ 高频策略可消费实时 Tick 数据
- ✅ 数据异常自动报警
- ✅ bot-009 可用 provider-cli 查余额/下单

---

### Phase 3：AI 辅助 + 自动化（3 月，P3）
**目标**：LLM 辅助决策 + 规则引擎自动化

| 任务 | 工期 | 负责 | 产出 |
|------|------|------|------|
| 3.1 bridge_llm API（策略调用 llm-cli） | 2 天 | bot-001 | QuickJSStrategy 新 API |
| 3.2 规则引擎（行情异常 → Agent 调度） | 3 天 | bot-001 | watchdog 增强 |
| 3.3 向量化回测（batch 处理 K线） | 2 天 | bot-001 | BacktestEngine 优化 |
| 3.4 增量回测（缓存中间结果） | 5 天 | bot-001 | backtest-cli 新功能 |

**验收标准**：
- ✅ 策略可调用 LLM 辅助决策
- ✅ 行情异常自动通知 bot-009
- ✅ 回测速度提升 40x（并行 8x × 向量化 2x × 增量 2.5x）

---

### Phase 4：性能优化 + 高频支持（Q2，P4）
**目标**：支持高频策略 + 极致性能

| 任务 | 工期 | 负责 | 产出 |
|------|------|------|------|
| 4.1 混合架构（QuickJS + Native TS） | 5 天 | bot-001 | quant-lab 新架构 |
| 4.2 指标计算下沉（quant-lib） | 3 天 | bot-001 | StreamingIndicators 增强 |
| 4.3 QuickJS-ng JIT 编译 | 7 天 | bot-001 | QuickJSStrategy 升级 |
| 4.4 L2 订单簿数据 | 5 天 | bot-001 | Provider 新接口 |

**验收标准**：
- ✅ 支持 100ms 级高频策略
- ✅ 回测速度提升 80x（累计）
- ✅ 支持套利策略（多源 + L2 数据）

---

## 🎯 关键里程碑

| 时间 | 里程碑 | 标志 |
|------|--------|------|
| **2026-02-28** | Phase 1 完成 | CLI 工具链可用，bot-004/009 协作效率提升 |
| **2026-03-31** | Phase 2 完成 | 实时 Tick 数据 + 数据质量保障 |
| **2026-04-30** | Phase 3 完成 | AI 辅助决策 + 自动化运维 + 回测加速 40x |
| **2026-06-30** | Phase 4 完成 | 高频策略支持 + 极致性能（80x 加速） |

---

## 🚀 快速启动（本周任务）

### 优先级 P0（立即开始）
1. ✅ **watchdog 成交误报修复**（已完成）
2. ⏳ **watchdog 日志路径更新**（待 bot-009 确认）

### 优先级 P1（本周启动）
1. **kline-cli 开发**（2 天）
2. **backtest-cli 开发**（3 天）
3. **并行回测集成**（3 天）

---

## 📝 附录：技术债务清单

| 债务 | 影响 | 优先级 | 预估工期 |
|------|------|--------|----------|
| QuickJS 异步支持不完善 | 无法原生 async/await | P4 | 3 天 |
| Provider 测试覆盖不足 | 潜在 bug 风险 | P2 | 2 天 |
| 回测报告无可视化 | 难以分析结果 | P3 | 2 天 |
| 缺少风控模块文档 | 新人上手难 | P3 | 1 天 |
| ndtsdb 无事务支持 | 数据一致性风险 | P5 | 5 天 |

---

**总结**：
- **短期**（本月）：工具链建设，Agent 协作效率提升
- **中期**（下月）：数据管道增强，实时 Tick + 质量保障
- **长期**（Q2）：AI 辅助 + 自动化 + 性能极致优化

**核心原则**：
- ✅ 积木化（独立工具，可组合使用）
- ✅ Agent 友好（CLI + JSON 输出）
- ✅ 性价比优先（先做 80x 加速，GPU 放最后）
- ✅ 增量演进（不推翻重来，持续优化）
