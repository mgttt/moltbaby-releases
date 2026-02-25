# CHANGELOG

所有显著变更均记录于此文件。  
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

---

## [Unreleased] - 2026-02-24

### 知识引擎（纯C内置）

- **`embed` 命令**：TF-IDF hash trick 生成 embedding 向量
  - 多 hash 种子 + unigram/bigram，64/128 维
  - 零外部依赖，无需 API 调用
- **`search` 命令**：向量相似度搜索
  - 余弦相似度 top-k 排序
  - 支持 --threshold, --symbol, --interval, --format csv
- **`facts` 子命令**：知识库管理
  - `facts import` - 从 JSONL 文件批量导入
  - `facts list` - 列出知识库条目（支持 --tag 过滤）
  - `facts search` - 语义搜索（委托给 search 命令）

### 测试

- **测试套件 9→11**：新增 test-embed.sh（6项）+ test-knowledge.sh（7项）
- 全部纯 bash 实现，零外部依赖（不依赖 python3）
- embed→search 端到端管线测试

### 构建系统

- **多构建方式支持**
  - `make` - gcc 开发构建（6.3MB，含 debug）
  - `make release` - zig + strip（1.2MB，Linux 生产）
  - `make cosmo` - cosmocc APE（3.0MB，跨平台）
  - `make cosmo-docker` - Docker 可复现构建（CI/CD）
  - `scripts/ci-build.sh` - CI 自动化验证脚本

- **APE 跨平台二进制**（Actually Portable Executable）
  - 单文件跑 Linux / macOS / Windows / FreeBSD
  - 无需重新编译，同一二进制多平台运行
  - 大小：3.0-3.4MB

### 文档

- **README.md 完整重构**
  - 安装说明：下载 APE / Linux 优化版 / 源码编译
  - 快速上手：4 步走完（write-json → query → sql → script）
  - 构建对比表：5 种构建方式一目了然

### Bug 修复

- **cosmo-docker 回归修复**：不再删除主 ndtsdb-cli 二进制

### 新增功能

- **embed 命令**：纯 C 实现 TF-IDF 哈希生成 embedding
  - 零依赖，无需外部 API
  - 用法：`ndtsdb-cli embed --text "..." --dim 384`

- **search 命令**：语义搜索 CLI
  - 基于 COSINE_SIM 相似度计算
  - 支持 `--query-vector`, `--top-k`, `--threshold`, `--format`
  - 用法：`ndtsdb-cli search -d ./db -q '[0.1,0.2,...]' -k 5`

- **facts 命令**：知识库管理
  - `facts import`：从 JSONL 导入知识（解析 embedding 写入向量存储）
  - `facts list`：列出知识库中的所有条目
  - `facts search`：在知识库中语义搜索
  - JSONL 格式：`{"text":"...","embedding":[...],"tags":[...]}`

- **测试套件增强**
  - 新增 `test-knowledge.sh`：7 项知识引擎测试（embed/search/facts）
  - 集成到 `run-all.sh`，总测试数达 11 项
  - 全部测试通过

---

## [v1.0.0-beta] - 2026-02-23

### M4: 知识引擎（Knowledge Engine）

- **facts 导入工具**（M4-P1）：`scripts/import-facts.js`
  - 解析 `memory/facts/*.md` 文件
  - 批量写入 ndtsdb 向量存储
  - 支持 dry-run 预览模式
  
- **embedding 生成工具**（M4-P2）：`scripts/generate-embeddings.js`
  - 集成 Gemini text-embedding-004 API
  - 为 facts 自动生成 768 维 embedding
  - 通过 HTTP API 写入 ndtsdb

### M3: 并发 HTTP API（Concurrent Server）

- **GET /health 纯C迁移**（M3-P3）
  - 移除 JavaScript 依赖，改用纯C实现
  - 提升响应速度和稳定性
  - 返回：`{"status":"ok","version":"...","uptime_seconds":...}`

- **POST /write-vector**（M4-P1）：向量写入端点
  - 支持 agent_id, type, timestamp, confidence, embedding
  - 自动创建 `.ndtv` 向量文件
  
- **GET /query-vectors**（M3-P2）：向量相似度查询端点
  - COSINE_SIM 计算
  - 支持 threshold, limit, agent_id 过滤
  - 返回按相似度排序的 JSON 数组

### M2: 语义检索（Semantic Search）

- **COSINE_SIM SQL 函数**：`COSINE_SIM(embedding, [...]) > threshold`
  - SQL 层向量相似度计算
  - 支持 WHERE 过滤 + ORDER BY 排序
  - 端到端测试覆盖

### M1: 向量存储（Vector Storage）

- **原生向量支持**：`.ndtv` 文件格式
  - 文件头：magic + version + record_count
  - 记录：定长头 + 变长 embedding（float32 数组）
  - C API：`ndtsdb_insert_vector`, `ndtsdb_query_vectors`

### 工程

- **SQL GroupBy 修复**：修复 GROUP BY 聚合逻辑错误
  - 解决返回 BTC=8 而非 BTC=4,ETH=4 的问题
  - 根因：ResultRow 结构解析错误

- **DELETE 功能修复**：实现真正的数据删除
  - 修复 tombstone 软删除失效问题
  - ndtsdb_insert 添加 timestamp 去重和 volume<0 处理逻辑
  - 支持 UPSERT（相同 timestamp 自动更新）

- **集成测试加固**：14项测试 100% 通过率
  - 修复 query/list 错误处理（缺 --database 参数时报错）
  - 修复 write-csv 自动创建数据库目录
  - 添加百万级 benchmark 测试（tests/bench/bench.sh）
  - v0.2.2 回归测试：19/19 通过
  - v0.3.0 回归测试：112/112 通过

- 版本号更新至 **v1.0.0-beta**
- README.md 新增 M1-M4 完整文档

---

## [v0.3.14] - 2026-02-23

### 新增

- **子命令级 --help 统一完善**：所有子命令支持 `ndtsdb-cli <cmd> --help`
  - 格式统一：Usage + 参数说明 + 示例
  - 覆盖子命令：write-json, write-csv, export, merge, resample, query, sql, tail, head, count, info, sma, ema, atr, vwap, obv, rsi, bollinger, macd, script, repl, serve, delete, wal-replay

### 工程

- 版本号统一更新至 **v0.3.14**

---

## [v0.3.13] - 2026-02-23

### 新增

- **serve HTTP API 集成测试**（C-27）：4 cases 覆盖全部 endpoints
  - `GET /health` → `{"status":"ok"}`
  - `GET /symbols` → symbol 列表
  - `GET /query?symbol=BTC` → OHLCV JSON Lines
  - `POST /write-json` → `{"inserted":1}`

### 工程

- 集成测试扩展至 **94 cases**，全通

---

## [v0.3.12] - 2026-02-23

### 新增

- **`script --watch` 模式**：DB 变化驱动重跑（D-23）
  - `ndtsdb-cli script strategy.js --database DB --watch [--interval 2000]`
  - 用 `stat()` 监测 DB 目录 mtime，有变化时自动重跑脚本
  - 打印 `[watch] Watching database: ... (interval: Nms)` 启动提示
  - Ctrl+C 优雅退出

### 工程

- 集成测试扩展至 **90 cases**，全通

---

## [v0.3.11] - 2026-02-23

### 新增

- **`resample` 子命令**：OHLCV 多周期合成（C-26）
  - `ndtsdb-cli resample --database DB --symbol BTC --from 1m --to 5m [--output DB2]`
  - 支持：1m→5m(N=5) / 1m→15m(N=15) / 1m→1h(N=60) / 5m→1h(N=12) 等任意倍数
  - OHLCV 规则：open=首根 / high=max / low=min / close=末根 / volume=sum
  - 输出：默认 JSONL 到 stdout，`--output DB2` 写入目标数据库
  - 验证：30根1m → 6根5m，volume=5000 ✓
- **ndtsdb.h v0.4.0 API 注释**：全函数 Doxygen 注释、结构体字段说明、约束文档

### 工程

- 集成测试扩展至 **89 cases**，全通

---

## [v0.3.10] - 2026-02-23

### 修复

- **SQL IN 字符串值**：`WHERE symbol IN ('BTC','ETH')` 之前引号未剥离导致匹配失败
  - 修复：`filter.values` 解析时检测 `'` / `"` 包裹并 `slice(1,-1)` 剥离
  - 影响：任意字符串字段的 IN 过滤现在正常工作

---

## [v0.3.9] - 2026-02-23

### 新增

- **tools/benchmark.sh**：6项性能基准脚本（write/query/SQL聚合/SMA/tail/export）
  - 5000行样本：write-json 312K/s，query 278K/s，SMA-20 553K/s，export 238K/s
- **examples/correlation-analysis.js**：多品种 Pearson 相关性矩阵脚本（script 子命令）

### 修复

- **write-json Python3 JSON 兼容**：timestamp 解析不跳前导空格
  - `python3 json.dumps()` 默认格式为 `"timestamp": 1`（冒号后有空格）
  - 原字符数字循环不处理空格导致 `timestamp=0`，全部写入错误分区
  - 修复：digit-loop 前加 `while(*p==' '||*p=='\t') p++`
- **测试脚本回归**：c号 编辑意外删除 239 行断言，恢复到 D-21 版本（86/0）

---

## [v0.3.8] - 2026-02-23

### 新增

- **`--version` / `version` 子命令**：显示版本号 + 功能集概述
- **`--help` 完整重写**：分类展示所有子命令（Data I/O / Query / Indicators / Scripting）
  - 每个子命令含参数说明和使用示例
- **tests/integration/test-v0.3.0.sh**：测试数量从 68 扩展至 **86 cases**（含边界测试）

---

## [v0.3.7] - 2026-02-22

### 新增

- **SQL CORR(field1, field2)**：Pearson 相关系数聚合函数
  - `SELECT CORR(close, volume) AS corr FROM data WHERE symbol='BTC'`
  - 完全正相关 → `corr=1.0`，独立 `corrMatch` 解析（两参数语法）

---

## [v0.3.6] - 2026-02-22

### 新增

- **SQL STDDEV / VARIANCE**：总体标准差与方差聚合
  - `SELECT STDDEV(close), VARIANCE(close) FROM data WHERE symbol='BTC'`
- **SQL PERCENTILE(field, p)**：百分位数聚合（线性插值）
  - `SELECT PERCENTILE(close, 50) AS median FROM data WHERE symbol='BTC'`
- **export --format csv (-F csv)**：带表头 CSV 导出
  - 表头：`symbol,interval,timestamp,open,high,low,close,volume`

### 修复

- **aggMatch 未定义**：d号 D-19 插入 `percMatch` 块时漏了 `const aggMatch = aggRegex.exec(field)`
- **P2 quant-lab state 原子写**：4文件从 `writeFileSync` 改为 `write+rename`
  - `QuickJSStrategy.flushState()` / `state/index.ts save()+delete()` / `paper-trading.saveState()` / `HotReloadManager` 回滚

---

## [v0.3.1] - 2026-02-22

### 新增

**新子命令**
- `count` — 纯C行数统计，无SQL开销
  - `ndtsdb-cli count --database <db> [--symbol sym] [--interval intv]`
  - 过滤 tombstone（volume<0），输出 JSON Lines
- `info` — series 元信息（count + 时间范围）
  - 每行输出 `{symbol, interval, count, first, last}`
  - first/last 为 Unix 毫秒时间戳

**SQL 增强**
- `COUNT(DISTINCT field)` — 聚合去重计数
- `LAG(field, offset=1) AS alias` — 前 N 行滑窗（null 填充边界）
- `LEAD(field, offset=1) AS alias` — 后 N 行滑窗（null 填充边界）
- `smartSplit()` — 括号深度感知的字段分割，修复 `LAG(close,1)` 被逗号拆断的问题

**script 指标库**（注入到 `globalThis.ndtsdb`）
- `ndtsdb.sma(rows, period)` → `[{timestamp, value}]`
- `ndtsdb.ema(rows, period)` → `[{timestamp, value}]`
- `ndtsdb.atr(rows, period)` → `[{timestamp, value}]`
- `ndtsdb.bollinger(rows, period, mult=2)` → `[{timestamp, mid, upper, lower, std}]`
- `ndtsdb.rsi(rows, period=14)` → `[{timestamp, value}]`

### 修复

- **D-14 frozen namespace**：`ndtsdb` 是 ES module namespace（`Object.isFrozen=true`），
  直接赋属性静默失败。改为 `Object.assign({}, globalThis.ndtsdb)` 创建可写副本，
  追加指标后替换 `globalThis.ndtsdb`
- **D-14/C-14 重复声明**：c号 C-14 commit 未删旧版 indicators_src，导致 redefinition error
- **D-15 缺失步骤**：d号 D-15 commit 缺少外层 else 闭合 `}` 和 window function 执行步骤

### 工程

- 集成测试套件 `test-v0.3.0.sh` 扩展至 **50 cases**，全通
- 示例文件整理：`examples/d14-indicators-demo.js`、`examples/indicators-test.js`

---

## [v0.3.0] - 2026-02-22

### 新增

**SQL 功能**
- `WHERE BETWEEN lo AND hi` — 数值范围过滤
- `WHERE field IN (a, b, c)` — 集合过滤
- `WHERE expr1 OR expr2` — 复合 OR 条件
- `WHERE field LIKE 'pattern%'` — 通配符模式匹配（`%` 多字符，`_` 单字符）
- `WHERE NOT condition` — 取反过滤
- `SELECT DISTINCT field` — 去重查询
- `GROUP BY col1, col2` — 多列分组（原只支持单列）
- `HAVING condition` — 分组后过滤（已含 COUNT/SUM/AVG/MIN/MAX）
- `--format csv` — 所有查询子命令支持 CSV 输出（含 header）

**新子命令**
- `tail` — 查询末尾 N 行，支持 `--n`（默认10）和 `--format csv/json`
- `head` — 查询前 N 行，支持 `--n`（默认10）和 `--format csv/json`
- `script` — **嵌入式 JS 运行时**：直接执行 `.js` 脚本文件
  - 全局注入：`ndtsdb`、`__database`、`__args`、`__file`
  - 支持 ES Module（`import/export`、`async/await`）
  - 零依赖，APE 单文件运行
- `repl` — **交互式 JS Shell**，带 ndtsdb 模块
  - `--database` 自动打开数据库，`__db` 即可使用
  - 内置命令：`.symbols`、`.help`、`.version`、`.exit`
  - readline 历史支持
- `wal-replay` — WAL 日志重放（崩溃后恢复未提交写入）

**WAL（写前日志）**
- 每次 `write-json` 自动写 WAL（`$DB/.wal.log`）
- WAL checkpoint：committed 字节标记，正常写入后 replay=0 行
- WAL 格式：`[magic(4B)][symbol(32B)][interval(16B)][row_count(4B)][KlineRow*n][committed(1B)]`

**指标增强**
- `sma`、`ema`、`atr` 新增 `--since <ts>` / `--until <ts>` 时间范围过滤
- 默认输出改为 **JSON Lines**（`{"timestamp":...,"sma":...}`）
- `--format csv` 输出带 header 的 CSV

**示例脚本**
- `examples/script-demo.js` — 数据库概览（行数、symbol 统计、均价）
- `examples/simple-strategy.js` — 双均线策略示例

### 修复

- SMA/EMA/ATR 输出格式回归（d号 828b123c9 将默认输出改为 CSV，本版修复为 JSON）
- SQL `split(",")` C 字符串 quote 破坏 snprintf 格式串导致所有 SQL 查询挂掉（`split(",")` → `split(',')`)
- SQL WHERE OR/LIKE 时 symbol 预过滤丢失数据（改为 `queryAll` 后再 `applyWhere`）
- SQL `applyWhere` 缺少 LIKE filter handler（已补 `filter.type === 'LIKE'` 分支）
- `partitioned` 子命令中未使用的 `daemon_mode` 变量编译错误

### 工程

- 集成测试套件 `tests/integration/test-v0.3.0.sh`（38 cases，0 failed）
- `test-v0.2.2.sh` 二进制路径改为 `zig-out/bin/ndtsdb-cli`（避免 root binary 被误删）
- ROADMAP.md 架构愿景：libndtsdb → ndtsdb-ts 路线图

---

## [v0.2.2] - 2026-02-22

### 新增

- **SQL GROUP BY / ORDER BY / HAVING**（聚合查询）
- **SQL LIMIT / OFFSET**（分页）
- **SQL 聚合函数**：COUNT / SUM / AVG / MIN / MAX
- **StreamingVWAP** 指标
- **SMA / EMA** 纯 C 实现（替代 QuickJS 慢路径，**1.45M rows/s**）
- **ATR** 纯 C Wilder 平滑（默认 period=14）
- **DELETE / tombstone 软删除**（`volume=-1.0` 标记）
- **UPSERT**（`--upsert` 标志，按 timestamp 主键更新）
- **partitioned 子命令**（`list/query/write-json`，目录型数据库）
- **ndtsdb_list_symbols() API**
- **ndtsdb_clear() API**
- **cosmocc APE 跨平台构建**（748KB，Linux/macOS/Windows 单一二进制）
- **GitHub Actions CI 矩阵**（ubuntu + macos，Zig 0.13.0）

### 性能基准（v0.2.2）

| 操作 | 速度 |
|------|------|
| write-json | 820K rows/s |
| query | 578K rows/s |
| SMA(period=20) | 1.45M rows/s |

---

## [v0.2.1] - 2026-02-21

### 性能优化（纯C重写核心路径）

- **write-json**：100K → 862K rows/s（**8.6x 提升**）
- **query**：1100ms → 87ms（**12.6x 提升**）
- 原理：QuickJS JSON.parse → 纯C手动解析

---

## [v0.2.0] - 2026-02-20

### 新增（初始版本）

- `write-json` / `write-csv`：JSON Lines / CSV 写入
- `query`：时间范围、symbol 过滤查询
- `sql`：SQL SELECT / WHERE / LIMIT
- `sma` / `ema` / `atr`（QuickJS 版，后在 v0.2.2 改为纯C）
- `serve`：HTTP / WebSocket 服务器
- `list`：列出数据库中所有 symbol/interval
- QuickJS 嵌入运行时（ES2020）
- Zig 构建系统
- 跨进程文件锁（flock）

## [v0.3.4] - 2026-02-22

### Added
- `export` subcommand: dump database as JSON Lines compatible with `write-json`
  - `--output <file>` for file export, stdout by default
  - `--symbol` / `--interval` filters
  - Tombstone filtering (volume < 0)
- SQL `strftime(timestamp, format) AS alias` time formatting
  - Supports `%Y`, `%m`, `%d`, `%H`, `%M`
  - Compatible with `GROUP BY strftime(...)` for time bucketing
- `tools/ingest-binance.ts`: Binance K-line data ingestion (incremental `--watch` mode)
- `tools/ingest-bybit.ts`: Bybit K-line data ingestion (proxy-aware)

### Fixed
- MACD signal EMA: macdLine `{value}` → `{close}` conversion before EMA call

### Tests
- 59 integration cases, 0 failed


## [v0.3.5] - 2026-02-22

### Added
- `merge` subcommand: copy data across databases
  - `--from <src>` / `--to <dst>` / `--symbol` / `--interval` filters
  - Tombstone-filtered, correct deduplication
- SQL `FIRST(field)` / `LAST(field)` aggregates with `AS` alias support

### Fixed
- **merge double-write bug**: ndtsdb uses a global `g_symbols` table; opening two databases
  simultaneously mixes their data. Fixed with sequential open/close (Phase 1: read from source,
  Phase 2: write to target). Row count no longer doubles.
- `--symbol` filter in `merge` now correctly excludes other symbols

### Tests
- 59 integration cases, 0 failed


## [v0.3.6] - 2026-02-22

### Added
- SQL `STDDEV(field)` / `VARIANCE(field)` aggregates (population std deviation)
- SQL `PERCENTILE(field, p)` aggregate (linear interpolation, p ∈ [0,100])
- `export --format csv`: CSV output with header row

### Fixed
- `aggMatch` undefined runtime error caused by D-19 PERCENTILE integration conflict
  (missing `const aggMatch = aggRegex.exec(field)` before `else if (aggMatch)`)

### Tests
- 59 integration cases, 0 failed


## [v0.3.7] - 2026-02-22

### Added
- SQL `CORR(field1, field2)` aggregate: Pearson correlation coefficient [-1, 1]
- `docs/trading-workflow.md`: full live-trading analysis guide for operators

### Tests
- 68 integration cases, 0 failed (added STDDEV/VARIANCE/PERCENTILE/FIRST/LAST assertions)

