# Moltbaby Products - Official Releases

自动同步的发布仓库 - 包含多个产品的源码

## 📦 产品列表

### 1. ndtsdb
**N-Dimensional Time Series Database** — 多维时序数据库

```bash
bun add github:mgttt/ndtsdb-releases#ndtsdb
```

- 高性能嵌入式时序数据库
- Tick 8.9M/s, Snapshot 487K/s
- 8 平台预编译（lnx/osx/win × x86/arm）

### 2. ndtsdb-cli
**NDTS CLI** — C 命令行工具 + 嵌入库

```bash
# 从 releases 目录获取预编译二进制
# 或自行编译：make / zig build
```

- 轻量 C 实现，可嵌入 Python/Node/Rust
- 支持 embed / facts / indicators 子命令
- APE 跨平台可执行（Linux/macOS/Windows）

### 3. quant-lib
**量化工具库** — 数据 + 指标 + 存储

```bash
bun add github:mgttt/ndtsdb-releases#quant-lib
```

- KlineDatabase（基于 ndtsdb）
- 技术指标库（SMA/EMA/MACD/RSI/Bollinger...）
- Provider（Binance/Bybit/TradingView）

### 3. quant-lab
**策略引擎** — 回测 + 实盘 + QuickJS 沙箱

```bash
bun add github:mgttt/ndtsdb-releases#quant-lab
```

- BacktestEngine（事件驱动回测）
- LiveEngine（实盘引擎 + 风控）
- QuickJS 沙箱（热重载 + 错误隔离）

### 4. workerpool-lib
**资源编排框架** — 调度 + 池化 + 生命周期

```bash
bun add github:mgttt/ndtsdb-releases#workerpool-lib
```

- 通用资源编排（AI Agent/容器/会话）
- Task/Worker/Pool/Scheduler 抽象
- Daemon/Cron/Hybrid 模式

---

## 🔒 安全性

✅ 本仓库所有代码已通过自动安全检查：
- 无硬编码 API keys/secrets
- 无敏感配置文件
- 排除 data/node_modules/.env 等目录

---

## 📝 许可

MIT License

---

⚠️ **注意**: 此仓库为自动发布，不接受 PR; 有需求请提 issue
