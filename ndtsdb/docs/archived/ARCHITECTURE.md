# ndtsdb Architecture

## 技术栈

| 层 | 技术 | 用途 |
|---|---|---|
| **Runtime** | Bun | 高性能 JS 运行时，原生 FFI、mmap 支持 |
| **语言** | TypeScript | 核心逻辑，类型安全 |
| **原生加速** | C + SIMD | 向量化过滤/聚合，8 平台交叉编译 |
| **FFI** | Bun FFI (dlopen) | 零开销调用 C 函数，无需 N-API |
| **交叉编译** | Zig CC | 一套源码编译 Linux/macOS/Windows × x64/ARM64 |
| **内存映射** | mmap (Bun.mmap) | 虚拟地址映射，OS 管理页缓存 |
| **零拷贝** | TypedArray views | ArrayBuffer 上的视图，无 memcpy |
| **压缩** | Gorilla 编码 | 时序专用：Delta-of-Delta + XOR |
| **索引** | Roaring Bitmap + B-Tree | 低基数过滤 + 范围查询 |
| **SQL** | 手写递归下降解析器 | 零依赖，<500 行 |
| **存储** | 列式二进制 | 8 字节对齐，TypedArray 直接映射 |

---

## 数据流

```
写入路径:
  appendBatch() → TypedArray 列缓冲区 → 8字节对齐二进制文件
                                          ↑ Gorilla 压缩 (可选)

读取路径 (单产品):
  loadFromFile() → ArrayBuffer → TypedArray view (zero-copy)
                                   ↓
                              C FFI SIMD 过滤/聚合 → 143M rows/s

读取路径 (全市场回放):
  3000 文件 → Bun.mmap → 虚拟地址空间 (~300GB)
                            ↓ OS 页缓存 (物理内存 1-2GB)
                        TypedArray view (zero-copy)
                            ↓
                        K-way merge (时间戳对齐)
                            ↓
                        策略引擎 onTick()
```

---

## 存储格式

### 二进制列式文件 (.ndts)

```
┌──────────────────────────────┐
│  4 bytes: header length (LE) │
│  N bytes: JSON header        │
│    { version, rowCount,      │
│      columns: [{name,type}] }│
│  P bytes: padding (8-align)  │  ← 确保 TypedArray 对齐
├──────────────────────────────┤
│  Column 0: int64[] (时间戳)   │  连续内存，SIMD 友好
│  Column 1: float64[] (价格)   │
│  Column 2: int32[] (成交量)   │
│  ...                         │
└──────────────────────────────┘
```

**设计要点**:
- 8 字节对齐：BigInt64Array / Float64Array 直接映射
- JSON header：灵活扩展，解析开销可忽略
- 列连续存储：缓存行友好，SIMD 向量化

### Per-Symbol 分区

```
data/
├── BTCUSDT.ndts     # 每个产品一个文件
├── ETHUSDT.ndts     # 高频写入无锁冲突
├── AAPL.ndts        # 文件级隔离，单点故障不扩散
└── ...              # 3000+ 文件
```

---

## 模块架构

```
┌─────────────────────────────────────────────────────┐
│                    应用层                             │
│  策略回测 · 数据分析 · 实时监控                        │
└────────┬────────────────────────────────┬────────────┘
         │                                │
┌────────▼────────┐              ┌────────▼────────────┐
│   SQL 引擎       │              │   全市场回放          │
│   parser.ts     │              │   MmapMergeStream   │
│   executor.ts   │              │   SmartPrefetcher   │
└────────┬────────┘              └────────┬────────────┘
         │                                │
┌────────▼────────────────────────────────▼────────────┐
│                  核心存储层                            │
│  ColumnarTable · Compression · Index · Parallel      │
└────────┬───────────────┬────────────────┬────────────┘
         │               │                │
┌────────▼────┐  ┌───────▼──────┐  ┌──────▼───────────┐
│  Bun FFI    │  │  Bun.mmap    │  │  Cloud Storage   │
│  C SIMD     │  │  zero-copy   │  │  S3/MinIO 分层    │
└─────────────┘  └──────────────┘  └──────────────────┘
```

---

## 加速层

### C FFI SIMD

6 平台预编译库，Zig 交叉编译：

| 平台 | 文件 | 大小 |
|------|------|------|
| Linux x64 | `libsimd-linux-x64.so` | 12 KB |
| Linux ARM64 | `libsimd-linux-arm64.so` | 12 KB |
| Linux musl x64 | `libsimd-linux-musl-x64.so` | 11 KB |
| macOS x64 | `libsimd-macos-x64.dylib` | 17 KB |
| macOS ARM64 | `libsimd-macos-arm64.dylib` | 50 KB |
| Windows x64 | `libsimd-windows-x64.dll` | 147 KB |

关键函数：
- `simd_filter_f64_gt/lt/eq` — 向量化过滤
- `simd_sum_f64` — 向量化求和
- `simd_min/max_f64` — 向量化极值

---

## mmap + Zero-Copy

```
                     虚拟地址空间 (~300GB)
                    ┌─────────────────────┐
                    │  file1 mapped pages  │  ← Bun.mmap()
                    │  file2 mapped pages  │
                    │  ...                 │
                    │  file3000 mapped     │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   OS Page Cache     │  ← 自动 LRU
                    │   物理内存 1-2GB     │     热数据驻留
                    └──────────┬──────────┘     冷数据换出
                               │
                    ┌──────────▼──────────┐
                    │  TypedArray view    │  ← new Float64Array(buf, off, len)
                    │  零拷贝，零分配      │     只是指针 + 长度
                    └─────────────────────┘
```

**关键 API**:
- `Bun.mmap(path)` → Uint8Array (内存映射)
- `new Float64Array(buffer, offset, length)` → 零拷贝视图
- `madvise(MADV_WILLNEED)` → 预读提示
- `madvise(MADV_DONTNEED)` → 释放提示

---

## 索引系统

### Roaring Bitmap

适用于低基数列（交易所、产品类型）：
- 位图压缩，空间效率高
- AND/OR/XOR 集合运算
- O(1) 成员测试

### B-Tree

适用于范围查询（价格区间、时间范围）：
- O(log n) 查找
- 范围扫描高效
- 支持前缀匹配

---

## 压缩

### Gorilla 编码

Facebook 论文 (2015) 的 TypeScript 实现：

| 数据类型 | 编码方式 | 压缩率 |
|---------|---------|--------|
| 时间戳 | Delta-of-Delta | 90-95% |
| 浮点数 | XOR | 70-90% |

**原理**: 时序数据相邻值变化小 → delta 编码 → 前导零压缩

---

## SQL 引擎

零依赖手写递归下降解析器：

```sql
SELECT symbol, AVG(price), MAX(volume)
FROM trades
WHERE timestamp > 1707312000000
  AND price > 100
GROUP BY symbol
ORDER BY AVG(price) DESC
LIMIT 10
```

支持：
- SELECT / INSERT / CREATE TABLE
- WHERE（AND/OR/比较运算）
- GROUP BY / ORDER BY / LIMIT
- 聚合：COUNT / SUM / AVG / MIN / MAX

---

## 性能指标

| 操作 | 速度 | 实现 |
|------|------|------|
| 写入 | 6.9M rows/s | TypedArray 批量写入 |
| 扫描 (JS) | 45M rows/s | TypedArray 遍历 |
| 扫描 (C FFI) | 143M rows/s | SIMD 向量化 |
| 求和 (C FFI) | 1,162M rows/s | SIMD 累加 |
| SQL 查询 | 5.9M rows/s | 解析 + 执行 |
| 压缩率 | 70-95% | Gorilla |
| 3000 文件加载 | ~10ms | mmap 映射 |
| 物理内存 | 1-2GB | mmap 按需加载 |

---

## 业界对标

| 能力 | ndtsdb | QuestDB | ClickHouse | kdb+ |
|------|----------|---------|------------|------|
| 语言 | TS + C FFI | Java + C++ | C++ | q |
| SIMD | ✅ C FFI | ✅ JIT | ✅ | ✅ |
| mmap | ✅ Bun.mmap | ✅ | ✅ | ✅ |
| zero-copy | ✅ TypedArray | ✅ | ✅ | ✅ |
| ASOF JOIN | ✅ MergeStream | ✅ 原生 | ❌ | ✅ |
| SQL | ✅ 子集 | ✅ 完整 | ✅ 完整 | ❌ (q语言) |
| 压缩 | ✅ Gorilla | ✅ | ✅ LZ4/ZSTD | ✅ |
| 索引 | ✅ Bitmap+BTree | ✅ | ✅ 稀疏 | ✅ |
| 零依赖部署 | ✅ | ❌ 服务 | ❌ 集群 | ❌ 服务 |
| 代码量 | <1MB | ~100MB | ~1GB | N/A |
| 部署 | `bun run` | Docker | 集群 | 商业授权 |
