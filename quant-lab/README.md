# Quant-Lab — 量化策略运行时引擎

> **版本**: v3.1 (2026-02-23)
> **核心**: Gales策略引擎 + 回测/实盘双模 + QuickJS沙箱 + Bybit集成

---

## 📖 文档导航

| 文档 | 说明 | 链接 |
|------|------|------|
| 快速开始 | 5分钟上手 | [→ QUICKSTART](./docs/QUICKSTART.md) |
| 产品说明书 | 功能与部署 | [→ PRODUCT_MANUAL](./docs/PRODUCT_MANUAL.md) |
| 操盘手册 | 策略开发与实盘操作 | [→ TRADER_MANUAL](./docs/TRADER_MANUAL.md) |
| 系统架构 | 三层架构总览 | [→ SYSTEM_OVERVIEW](./docs/SYSTEM_OVERVIEW.md) |
| 运维手册 | 部署、监控、故障排查 | [→ OPERATIONS](./docs/OPERATIONS.md) |

---

## 🎯 核心特性

- **Gales策略引擎**：网格 + 马丁格尔混合策略，支持三种倾向模式
- **QuickJS沙箱**：策略运行在隔离沙箱中，崩溃不影响系统
- **回测引擎**：历史数据回放 + 爆仓保护 + 完整指标
- **实盘引擎**：WebSocket行情 + Bybit REST/WS集成 + 风控
- **分级熔断**：A/B/C/D四级熔断框架，状态持久化
- **API Key管理**：多Key故障切换，自动负载分散
- **策略热重载**：运行时更新策略代码，状态无损迁移
- **参数扫描**：param-sweep批量回测，自动参数优化

---

## 🏗️ 架构

```
┌─────────────────────────────────────────────┐
│              策略层 (Strategy Layer)          │
│  strategies/grid/gales-simple.js             │
│  strategies/examples/ma-cross-strategy.ts    │
│                                              │
│  生命周期: st_init → st_heartbeat → st_stop  │
│  Bridge API: bridge_buy/sell/cancel/log/...  │
│                                              │
│  倾向模式 (lean):                            │
│    positive  — 仓位趋向正值（做多敞口）      │
│    negative  — 仓位趋向负值（做空敞口）      │
│    neutral   — 所有成交都影响真实仓位        │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────┴──────────────────────────┐
│              系统层 (System Layer)            │
│                                              │
│  QuickJS沙箱     策略热重载    分级熔断       │
│  (sandbox/)      (hot-reload/) (execution/)  │
│                                              │
│  BacktestEngine  LiveEngine    API Key管理    │
│  (engine/)       (engine/)     (execution/)  │
│                                              │
│  统一日志 (logger)  统一类型 (types/)         │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────┴──────────────────────────┐
│              数据层 (Data Layer)              │
│                                              │
│  BybitProvider (REST + WebSocket)             │
│  PaperTradingProvider (模拟)                  │
│  ndtsdb (时序数据库)                          │
│  quant-lib (K线数据采集)                      │
└─────────────────────────────────────────────┘
```

---

## 📁 项目结构

```
quant-lab/
├── src/
│   ├── engine/           # 回测引擎 + 实盘引擎
│   ├── execution/        # 订单执行、熔断、API Key、风控
│   ├── hot-reload/       # 策略热重载、状态迁移、注册表
│   ├── providers/        # Bybit/Paper 交易所适配
│   ├── sandbox/          # QuickJS 沙箱运行器
│   ├── types/            # 统一类型定义 (IStrategy等)
│   ├── analytics/        # 性能指标、对比报告
│   ├── reporting/        # 日报生成
│   ├── cache/            # K线缓存层
│   └── utils/            # 统一日志等工具
├── strategies/
│   ├── grid/             # Gales网格策略
│   ├── examples/         # 示例策略
│   ├── test/             # 测试策略
│   └── system/           # 系统策略
├── legacy/               # QuickJS遗留代码（归档）
├── tests/                # 单元测试 + 集成测试
├── scripts/              # 运维脚本
└── docs/                 # 详细文档
```

---

## 🔧 Gales 策略配置

### 倾向模式 (lean)

Gales是**网格+马丁格尔混合策略**，始终双向挂单（Buy+Sell）。`lean`参数决定成交后的仓位计算方式：

| lean值 | 含义 | Buy成交 | Sell成交 |
|--------|------|---------|----------|
| `positive` | 做多敞口 | 增加真实仓位 | 仅记账（虚仓） |
| `negative` | 做空敞口 | 仅减空仓 | 增加真实空仓 |
| `neutral` | 无偏好 | 增加仓位 | 减少仓位 |

**注意**：网格订单始终双向生成，`lean`不影响挂单方向，只影响成交后的仓位归属。

### 应急切换 (emergencyLean)

| 值 | 行为 |
|----|------|
| `auto` | 满仓自动切换（买满→positive，卖满→negative，回安全区→neutral） |
| `manual` | 不自动切换，保持初始lean |

### 分级熔断

| 级别 | 严重度 | 行为 | 自动恢复 |
|------|--------|------|----------|
| A | 严重 | API关键失败 → 停止交易 | 否（需人工） |
| B | 高 | 状态异常 → 限制交易 | 10分钟 |
| C | 中 | 回撤触发 → 限制开仓 | 5分钟 |
| D | 低 | 告警记录 → 不阻断 | - |

---

## 🧪 回测引擎

### 特性
- 爆仓保护：equity ≤ 0 时强制平仓结束回测
- maxDrawdown上限100%（不输出不合理数字）
- 参数注入：BacktestConfig.params → 策略CONFIG覆盖
- 方向验证：不同lean下PnL计算正确分离

### 参数扫描
```bash
bun quant-lab/scripts/param-sweep.ts \
  --strategy strategies/grid/gales-simple.js \
  --output results.json
```

---

## 📊 测试覆盖

| 模块 | 测试数 | 覆盖 |
|------|--------|------|
| 分级熔断 (tiered-circuit-breaker) | 26 | ✅ |
| API Key管理 (secure-api-key-manager) | 6 | ✅ |
| 策略热重载 (state-migration + reloader + registry) | 33 | ✅ |
| context-builder交易函数 | 9 | ✅ |
| Bybit关键路径 | 13 | ✅ |
| 回测爆仓保护 | 4 | ✅ |
| neutral方向修复 | 3 | ✅ |

---

## 📋 近期更新 (v3.1, 2026-02-23)

### 新增
- **IStrategy接口**：规范化策略生命周期（430行类型定义）
- **分级熔断框架**：A/B/C/D四级，替换旧circuitBreaker
- **API Key管理器**：多Key故障切换 + 冷却恢复
- **策略热重载**：完整状态迁移（serialize→reload→deserialize→validate）
- **示例策略**：双均线交叉策略（IStrategy接口示例）
- **回测爆仓保护**：equity≤0强制平仓，maxDD cap 100%

### 修复
- equity计算bug（balance不更新/positionNotional重复/unrealizedPnL符号）
- neutral方向reduceOnly误设为true
- cancelAllOrders异步竞争窗口
- placeOrder边界条件
- 重复gales-simple.js文件清理

### 改进
- 日志统一化：600+处console替换为logger
- 目录结构规范化：legacy/strategies/src/分离
- context-builder交易函数实现（buy/sell/cancel/query）

---

## 📄 License

MIT

---

*维护者: 投资组 (bot-001)*
*引擎版本: v3.1 (2026-02-23)*
