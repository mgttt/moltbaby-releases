# Quant-Lib - 量化数据工具库

高性能、统一的加密货币市场数据采集与分析工具库

> ⚠️ **Binance API 地区限制**: 如遇 HTTP 451 错误，请查看 [PROXY_SETUP.md](./PROXY_SETUP.md) 配置代理或使用 TradingView/FUTU Provider
> 
> ⚠️ **TradingView 登录模式**: Pro账号(wjhk2020@icloud.com) 2FA短信当前接收不稳定，预计 2026-03-04 后恢复测试。暂用匿名模式。

## 🎯 项目特点

### 性能优势
- **10-12倍速度提升**：首次采集（30币×49天）仅需58秒 vs 旧版10-12分钟
- **批量插入优化**：DuckDB批量VALUES插入，性能提升10-50倍
- **智能并发**：批量并发采集（4个/批），串行写入避免锁冲突

### 技术架构
- **双数据源策略**：Binance REST API（优先，快速稳定）+ TradingView WebSocket（备用，全币种）
- **统一Schema**：扩展字段支持（quote_volume、trades、taker_buy等）
- **自动化流程**：增量采集 → 波动率计算 → 报告生成 → Git推送

### 核心功能
- ✅ 30个精选加密货币实时监控
- ✅ 多周期波动率分析（1/2/4/14/25/49天）
- ✅ 15分钟K线数据，49天历史深度
- ✅ 自动发布到 GitHub Pages
- ✅ 每小时自动更新

## 📁 项目结构

```
quant-lib/
├── src/                    # 核心源代码
│   ├── providers/          # 数据提供者
│   │   ├── base.ts         # Provider抽象基类
│   │   ├── binance.ts      # Binance REST API（加密货币）✅
│   │   ├── tradingview.ts  # TradingView WebSocket（全市场）✅
│   │   └── futu.ts         # FUTU 港美股（开发中）🚧
│   ├── storage/            # 数据存储
│   │   └── database.ts     # DuckDB封装（批量优化）
│   └── types/              # TypeScript类型定义
│       ├── common.ts       # 通用类型
│       └── kline.ts        # K线数据类型
│
├── scripts/                # 自动化脚本
│   ├── collect-volatility-data.ts    # 数据采集（并发+增量）
│   ├── calculate-volatility.ts       # 波动率计算
│   └── update-volatility.sh          # 完整流程（采集→计算→推送）
│
├── data/                   # 数据目录
│   └── klines.duckdb       # DuckDB数据库（~11MB）
│
├── examples/               # 示例代码
│   ├── basic.ts            # 基础使用
│   ├── full-pipeline.ts    # 完整流程
│   └── tradingview.ts      # TradingView示例
│
└── README.md               # 本文件
```

## 🚀 快速开始

### 安装依赖
```bash
bun install
```

### 首次采集（49天历史数据）
```bash
bash scripts/update-volatility.sh
```
预计耗时：~60秒（30个币种 × 4704条K线）

### 增量采集（每小时）
```bash
bash scripts/update-volatility.sh
```
预计耗时：~20-30秒（只拉取新数据）

### 查看结果
生成的报告位于：`../docs/myvol.md`

在线查看：https://mgttt.github.io/moltbaby/myvol.html

## 💻 核心模块

### 1. Binance Provider
```typescript
import { BinanceProvider } from './src/providers/binance';

const binance = new BinanceProvider({ proxy: 'http://127.0.0.1:8890' });
const klines = await binance.getKlines({
  symbol: 'BTC/USDT',
  interval: '15m',
  limit: 4704  // 自动分批拉取（每批1000）
});
```

**特点**：
- 完全免费，无需API密钥
- 自动分页支持（>1000条自动分批）
- 速率限制宽松（1200次/分钟）

### 2. TradingView Provider
```typescript
import { TradingViewProvider } from './src/providers/tradingview';

const tv = new TradingViewProvider({ proxy: 'http://127.0.0.1:8890' });
await tv.connect();  // 匿名模式（免登录）

const klines = await tv.getKlines({
  symbol: 'BYBIT:BTCUSDT',
  interval: '15',
  limit: 300
});

await tv.disconnect();  // 正确断开（不会重连循环）
```

**特点**：
- 支持登录模式（Pro账号）和匿名模式（免费）
- 自动fallback机制（登录失败自动切换匿名）
- WebSocket连接管理（自动重连，正确断开）

### 3. FUTU Provider 🚧

```typescript
import { FutuProvider } from './src/providers/futu';

const futu = new FutuProvider({ host: '127.0.0.1', port: 11111 });

// TODO: 实现中
const klines = await futu.getKlines({
  symbol: '700/HKD',    // 腾讯控股
  interval: '1d',
  limit: 100
});
```

**状态**：🚧 开发中（基础骨架已完成）

**支持市场**：
- 港股（HKEX）- TODO
- 美股（NASDAQ/NYSE）- TODO
- A股（SSE/SZSE）- TODO

**TODO 列表**：
- [ ] 符号映射（HK.00700 ↔ 700/HKD）
- [ ] 数据格式转换
- [ ] 时间周期映射
- [ ] API 额度监控
- [ ] gRPC 协议客户端（长期优化）

**参考文档**：
- [FUTU.md](../FUTU.md) - 完整 API 文档
- [futu-trader/](../futu-trader/) - TypeScript 客户端实现

### 4. KlineDatabase
```typescript
import { KlineDatabase } from './src/storage/database';

const db = new KlineDatabase('./data/klines.duckdb');
await db.connect();

// 批量插入（自动优化）
await db.upsertKlines(klines);  // 500条/批，自动UPSERT

// 查询波动率
const ranking = await db.getVolatilityRanking(30);

await db.close();
```

**特点**：
- 批量VALUES插入（10-50倍性能）
- 自动UPSERT（避免重复）
- 内置波动率视图

## 📊 数据统计

### 当前覆盖
- **币种数**：30个精选加密货币
- **数据量**：141,316条K线（截至2026-01-31）
- **时间跨度**：49天历史 + 每小时增量
- **数据库大小**：11MB

### 币种列表
BTC, ETH, NEAR, LINK, UNI, MNT, OP, EIGEN, ARB, POL, TON, SUI, LTC, TIA, X, APT, SOL, AVAX, LDO, XLM, XRP, DOT, ADA, CATI, XAUT, DOGE, SAND, GMX, SEI, BNB

## ⚙️ 配置说明

### 环境变量
```bash
# 可选：指定数据库路径
export DB_PATH=/path/to/klines.duckdb

# 可选：代理服务器
export PROXY=http://127.0.0.1:8890
```

### 定时任务
已配置每小时自动运行（19:52 HKT起）：
- 增量采集30个币种
- 计算多周期波动率
- 生成 `docs/myvol.md`
- Git commit + push
- 自动发布到 GitHub Pages

## 🔧 性能优化细节

### 1. 批量并发采集
```typescript
// 并发采集（网络IO并行）
const batchResults = await Promise.all(
  batch.map(symbol => binance.getKlines(...))
);

// 串行写入（避免DuckDB锁冲突）
for (const result of batchResults) {
  await db.upsertKlines(result.klines);
}
```

### 2. 批量VALUES插入
```typescript
// ❌ 旧版：逐行INSERT（4704次SQL解析 + fsync）
for (const kline of klines) {
  await conn.exec(`INSERT INTO klines VALUES (...)`);
}

// ✅ 新版：批量VALUES（10次SQL，500条/批）
const values = klines.slice(0, 500).map(k => `(...)`).join(',');
await conn.exec(`INSERT INTO klines VALUES ${values}`);
```

### 3. 智能增量拉取
```typescript
// 检查最新时间戳
const latestTs = await db.getLatestTimestamp(symbol, interval);

// 计算需要拉取的K线数量
const barsNeeded = latestTs 
  ? calculateIncremental(latestTs)  // 增量：~100条
  : 4704;  // 首次：49天完整历史
```

## 📈 性能对比

| 指标 | 旧版 (tv-iv-collector) | 新版 (quant-lib) | 提升 |
|------|------------------------|------------------|------|
| 首次采集（30币×49天） | 10-12分钟 | **58秒** | **10-12倍** |
| 增量采集（1小时） | 1-2分钟 | **~20秒** | **3-6倍** |
| 数据库写入 | 逐行INSERT | 批量VALUES（500/批） | **10-50倍** |
| 进程稳定性 | 偶尔卡住 | ✅ 100%正常退出 | 完美 |
| Git自动提交 | ❌ 无 | ✅ 有 | 全自动化 |

## 🐛 已知问题与解决

### TradingView WebSocket重连循环
**问题**：`disconnect()` 后仍然自动重连，导致进程卡住

**解决**：
```typescript
protected shouldReconnect: boolean = true;

disconnect() {
  this.shouldReconnect = false;  // 阻止重连
  this.ws.close();
}

attemptReconnect() {
  if (!this.shouldReconnect) return;  // 检查标志
  // ... 重连逻辑
}
```

### Binance并发速率限制
**问题**：BATCH_SIZE=8时触发429错误

**解决**：降低批大小到4，增加批次间延迟2秒

### DuckDB并发锁冲突
**问题**：多线程同时写入导致事务冲突

**解决**：并发采集数据，串行写入数据库

## 📝 开发日志

### 2026-01-31 - 初始版本
- ✅ 从 tv-iv-collector 完整迁移
- ✅ 性能优化（10-12倍提升）
- ✅ 新增6个币种（XAUT、DOGE、SAND、GMX、SEI、BNB）
- ✅ Git自动提交集成
- ✅ 时区统一为香港时间（HKT）

## 🔗 相关链接

- **在线报告**：https://mgttt.github.io/moltbaby/myvol.html
- **GitHub仓库**：https://github.com/mgttt/moltbaby
- **旧版归档**：`../archive/tv-iv-collector/`

## 📄 许可证

MIT

---

**维护者**：OpenClaw (AI Agent) 🦀  
**最后更新**：2026-01-31
