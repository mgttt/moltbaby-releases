# ndtsdb

**N-Dimensional Time Series Database for TypeScript**

高性能嵌入式时序数据库，专为量化交易场景设计。

```
TypeScript · Bun · Columnar Storage · Gorilla Compression · mmap · Zero-Copy
```

## 定位

ndtsdb 是面向 **开发环境** 和 **高频场景** 的 TypeScript SDK：
- Bun 运行时 + 完整类型支持
- C FFI 加速（自动回退纯 JS）
- 列式存储 + Gorilla 压缩
- mmap 全市场回放（3000 品种 @ 8.9M ticks/s）

## 安装

```bash
bun add ndtsdb
```

## 快速开始

### 统一入口（推荐）

```typescript
import { open } from 'ndtsdb';

// 自动检测格式 —— 无需关心底层是 C 格式还是旧 TS 分区格式
const db = open('./data/klines');

console.log('format:', db.format); // 'c-dir' | 'c-file' | 'ts-partitioned'

// 查询全部
const allRows = db.queryAll();

// 按时间范围过滤
const recent = db.query({
  since: Date.now() - 86_400_000, // 最近 24h
  until: Date.now(),
  limit: 1000,
});

db.close();
```

支持三种路径形式：

| 路径示例 | 格式 | 说明 |
|---------|------|------|
| `open('./data/klines/')` | `c-dir` | 目录内含 `YYYY-MM-DD.ndts`（C FFI 写入格式） |
| `open('./data/2024-01-15.ndts')` | `c-file` | 单个 C 格式文件 |
| `open('./data/')` | `ts-partitioned` | 目录内含 `klines-partitioned/`（旧 TS 分区格式） |

### 直接写入

```typescript
import { AppendWriterFFI } from 'ndtsdb';

const writer = new AppendWriterFFI('./data/klines/btc-usdt__1h.ndts', [
  { name: 'timestamp', type: 'int64' },
  { name: 'close', type: 'float64' },
]);

writer.open();
writer.append([{ timestamp: Date.now(), open: 45000, high: 46000, low: 44000, close: 45500, volume: 123 }]);
writer.close();
```

### 列式存储 + 指标

```typescript
import { ColumnarTable, sma } from 'ndtsdb';

const table = new ColumnarTable([
  { name: 'timestamp', type: 'int64' },
  { name: 'price', type: 'float64' },
]);

const avg20 = sma(prices, 20);  // C FFI 加速，200M+/s
```

## 文档

| 文档 | 说明 |
|------|------|
| **[docs/ndtsdb.md](../docs/ndtsdb.md)** | 完整 API 参考与使用指南 |
| **[docs/libndtsdb.md](../docs/libndtsdb.md)** | C 核心库 FFI 接口 |

## 存储格式说明

| 格式 | 写入方 | 文件名模式 | 读取方 |
|------|-------|-----------|-------|
| **C 格式**（推荐） | `AppendWriterFFI` / `ndtsdb-cli` | `YYYY-MM-DD.ndts` | `NdtsDatabase` (FFI) |
| **旧 TS 分区格式** | 旧版 `AppendWriter`（gorilla/delta 压缩） | `klines-partitioned/<interval>/bucket-N.ndts` | `open()` 自动检测（仅无压缩文件可完整读取） |

旧 TS 格式中启用了 `compression.enabled=true` 的文件目前只能通过 `ndtsdb-cli export` 子进程读取，纯 TypeScript 解压暂未实现（跟踪于 [#67](https://github.com/mgttt/botcorp-runtime/issues/67)）。

## 项目关系

```
┌─────────────────────────────────────────┐
│  应用层 (你的策略/工具)                    │
└─────────────┬───────────────────────────┘
              │ bun add ndtsdb
              ▼
┌─────────────────────────────────────────┐
│  ndtsdb (本目录)                         │
│  TypeScript SDK · Bun 运行时              │
│  ColumnarTable / SQL / StreamingIndicators│
└─────────────┬───────────────────────────┘
              │ FFI (dlopen)
              ▼
┌─────────────────────────────────────────┐
│  libndtsdb                              │
│  C 核心库 · Zig 交叉编译                  │
│  ndts.c / ndtsdb_vec.c                   │
└─────────────────────────────────────────┘
```

**注意**: ndtsdb (TS) 与 [ndtsdb-cli](../ndtsdb-cli/) 数据格式已互通（通过 `AppendWriterFFI` 适配层）。

---

**Version**: 0.9.5.0
