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

```typescript
import { ColumnarTable, sma, MmapMergeStream } from 'ndtsdb';

// 列式存储
const table = new ColumnarTable([
  { name: 'timestamp', type: 'int64' },
  { name: 'price', type: 'float64' },
]);

// C FFI 加速指标
const avg20 = sma(prices, 20);  // 200M+/s
```

## 文档

| 文档 | 说明 |
|------|------|
| **[docs/ndtsdb.md](../docs/ndtsdb.md)** | 完整 API 参考与使用指南 |
| **[docs/libndtsdb.md](../docs/libndtsdb.md)** | C 核心库 FFI 接口 |

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

**注意**: ndtsdb (TS) 与 [ndtsdb-cli](../ndtsdb-cli/) **数据格式不同**，不互通。

---

**Version**: 0.9.5.0
