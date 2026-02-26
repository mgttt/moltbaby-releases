# ndtsdb vs ndtsdb-cli 对比文档

**日期**：2026-02-22  
**版本**：ndtsdb v0.9.5.0 | ndtsdb-cli v0.2.2  
**作者**：研发组

---

## 1. 架构对比

| 维度 | ndtsdb (Bun/TS 版) | ndtsdb-cli (QuickJS/C 版) |
|------|-------------------|--------------------------|
| 运行时 | Bun + TypeScript | QuickJS + C |
| 存储格式 | 相同 .ndts 二进制格式 | 相同 .ndts 二进制格式 |
| API 接口 | TS class API | CLI 子命令 |
| 依赖 | Bun（~100MB） | **零依赖**（~5MB） |
| 启动时间 | ~60ms（3000文件冷启） | **<10ms** |
| 进程模型 | 嵌入应用进程 | 独立进程/HTTP服务 |
| 部署方式 | `bun install` | 拷贝单文件即可 |
| 内存占用 | ~50MB | **11MB** |
| 冷启动 | ~60ms | **<10ms** |

---

## 2. 性能对比

### 2.1 写入性能

| 操作 | ndtsdb (Bun) | ndtsdb-cli | 差距 | 原因 |
|------|-------------|------------|------|------|
| 批量写入（ColumnarTable） | **6.9M rows/s** | — | — | ndtsdb-cli 无此接口 |
| 流式 Append（AppendWriter） | **3.3M rows/s** | — | — | 同上 |
| write-json（CLI 场景） | N/A | **862K rows/s** | — | v0.2.1 纯C优化后 |
| native insert（libndts.a） | 3.3M rows/s | 3.3M rows/s | 1x | 共用底层，理论同速 |

**实测数据**（v0.2.1 ReleaseFast）：
- 写入：862K rows/s（write-json）
- 批量写入：3.3M rows/s（ndtsdb_insert_batch）

### 2.2 查询性能

| 操作 | ndtsdb (Bun) | ndtsdb-cli | 差距 | 原因 |
|------|-------------|------------|------|------|
| 全量扫描（C FFI） | **143M rows/s** | — | — | 直接内存，无序列化 |
| query 50k（CLI） | <5ms（估） | **87ms** | ~17x | 进程启动 + JSON 序列化 |
| SMA 计算 | **268M rows/s** | 流式 JS（慢 100x+） | 巨大 | QuickJS vs FFI |
| SQL batch UPSERT | 508K rows/s | — | — | CLI 无 UPSERT |

**实测数据**（v0.2.1）：
- 查询：1.0M rows/s（10k行/10ms）
- 纯C query：87ms → 返回50k行

### 2.3 内存占用

| 指标 | ndtsdb (Bun) | ndtsdb-cli |
|------|-------------|------------|
| 内存基线 | ~50MB | **11MB** |
| 二进制体积 | ~100MB（Bun） | **5.0MB** |
| 冷启动 | ~60ms | **<10ms** |

---

## 3. 功能对比

### 3.1 数据操作

| 功能 | Bun 版 | CLI 版 | 说明 |
|------|--------|--------|------|
| 基础写入 | ✅ | ✅ | — |
| 批量写入 | ✅ | ✅ | v0.2.1 write-json 纯C优化 |
| write-json | ✅ | ✅ | — |
| write-csv | ❌ | ✅ | CLI 独有 |
| UPSERT | ✅ | ❌ | 待实现 |
| DELETE / tombstone | ✅ | ✅ | **v0.2.2 新增** |
| 分区表（PartitionedTable） | ✅ | ✅ | **v0.2.2 新增** |
| WAL | ✅ | ❌ | 待实现 |
| mmap 查询 | ✅ | ❌ | 待实现 |

### 3.2 查询能力

| 功能 | Bun 版 | CLI 版 | 说明 |
|------|--------|--------|------|
| 基础 query | ✅ | ✅ | — |
| SQL SELECT/WHERE/LIMIT | ✅ | ✅ | — |
| SQL GROUP BY / ORDER BY | ✅ | ❌ | 待实现 |
| SQL JOIN | ✅ | ❌ | 待实现 |
| SQL UPSERT / UPDATE | ✅ | ❌ | 待实现 |
| 聚合函数 | ✅ | ❌ | 待实现 |
| 分页（LIMIT/OFFSET） | ✅ | ✅ | — |
| 时间范围过滤 | ✅ | ✅ | — |
| 并发安全 | 文件锁 + 进程锁 | ✅ flock | 见 concurrent-access.md |

### 3.3 技术指标

| 指标 | Bun 版 | CLI 版 | 说明 |
|------|--------|--------|------|
| SMA | ✅ | ✅ | — |
| EMA | ✅ | ✅ | — |
| RSI | ✅ | ✅ | — |
| MACD | ✅ | ✅ | — |
| Bollinger Bands | ✅ | ✅ | — |
| VWAP | ✅ | ❌ | 待实现 |
| ATR | ✅ | ✅ | **v0.2.2 新增，纯C实现** |

### 3.4 运维/部署

| 功能 | Bun 版 | CLI 版 | 说明 |
|------|--------|--------|------|
| HTTP 服务器 | ❌ | ✅ | CLI 独有 |
| WebSocket 推送 | ❌ | ✅ | CLI 独有 |
| REST API | ❌ | ✅ | CLI 独有 |
| 跨平台二进制 | ❌ | 🔄 构建中（cosmocc） | — |
| npm/bun 包发布 | ✅ | N/A | — |

---

## 4. 读写并发

| 维度 | Bun 版 | CLI 版 |
|------|--------|--------|
| 读策略 | 文件锁 + 进程锁 | **无锁**（append-only 天然安全） |
| 写策略 | 进程内 WAL | **flock LOCK_EX**（独占写） |
| 跨进程安全 | 依赖应用层 | ✅ 文件锁保护 |
| 读者性能 | 锁开销 | **最优**（无锁直接读） |
| 并发模型 | 单进程多协程 | 多进程（锁互斥写） |

### 详细说明

**Bun 版**：
- 使用文件锁 + 进程内锁
- WAL 仅保护同进程内崩溃恢复
- 多 Bun 实例同时写有数据撕裂风险

**CLI 版**（见 docs/concurrent-access.md）：
- **读无锁**：append-only 格式，读者看到完整行或看不到
- **写互斥**：flock LOCK_EX 保证写者互斥
- 读者完全无阻塞，性能最优

---

## 5. 适用场景

### ndtsdb（Bun 版）

**适合场景**：
- 嵌入 Bun 应用内使用
- TypeScript/JavaScript 生态
- 高频交易、复杂策略计算
- 需要 ColumnarTable/AppendWriter 批量接口
- 单机单进程应用

**不适合**：
- 无 Bun 环境
- 边缘设备（资源受限）
- Shell 脚本集成
- 跨语言调用

### ndtsdb-cli（C/QuickJS 版）

**适合场景**：
- 运维脚本、Shell 集成
- 边缘部署、资源受限环境
- 跨语言调用（任何语言都能调用 CLI）
- HTTP 服务化（内置 serve 模式）
- 无 Bun 环境

**不适合**：
- 需要极致指标计算性能（QuickJS 慢 100x）
- 复杂 SQL（GROUP BY/JOIN 待实现）
- 事务型应用（无 UPSERT/WAL）

---

## 6. 版本对齐状态

| 版本 | 时间 | Bun 版功能 | CLI 版功能 |
|------|------|-----------|-----------|
| v0.2.0 | 2026-02-20 | 全功能 | 基础读写、SQL、HTTP |
| v0.2.1 | 2026-02-21 | — | **性能优化**（write-json/query 纯C，10x提升） |
| v0.2.2 | 2026-02-22 | — | **DELETE/tombstone**、**partitioned子命令**、**ATR指标** |
| v0.3.0 | 规划中 | — | UPSERT、WAL、mmap、cosmocc |

---

## 7. 总结

**两者核心互补关系**：
- **ndtsdb（Bun）**: 嵌入式高性能、复杂计算
- **ndtsdb-cli（C）**: 部署友好、服务化接口、跨语言

**共享**：同一 `.ndts` 文件格式，数据互通

**选择指南**：
- 用 Bun + 需要批量接口 → **ndtsdb**
- 用其他语言/Shell/边缘部署 → **ndtsdb-cli**
- 需要 HTTP 服务 → **ndtsdb-cli serve**
