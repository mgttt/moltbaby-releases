# ndtsdb-cli

[![ndtsdb-cli CI](https://github.com/openclaw/moltbaby/actions/workflows/ndtsdb-cli-ci.yml/badge.svg)](https://github.com/openclaw/moltbaby/actions/workflows/ndtsdb-cli-ci.yml)

> 基于 QuickJS + libndtsdb 的轻量级 N 维时序数据库命令行工具

## 简介

ndtsdb-cli 是 ndtsdb 的命令行版本，专为生产部署、边缘计算和嵌入式场景设计。

**核心特性**：
- 🚀 **零依赖**：单二进制文件，无需运行时环境
- ⚡ **快速启动**：秒级启动，内存占用低
- 📦 **轻量独立**：完整的C原生实现，不依赖Bun/Node运行时
- 📦 **跨平台**：支持 Linux x86-64/arm64, macOS x86-64/arm64
- 🎯 **轻量脚本**：嵌入式 QuickJS 引擎，ES2020 支持
- 🧠 **向量存储**：原生支持 embedding 存储（M1）
- 🔍 **语义检索**：COSINE_SIM 相似度查询（M2）
- 🌐 **并发 HTTP API**：serve 模式支持多客户端（M3）
- 📚 **知识引擎**：facts 导入 + embedding 生成（M4）

## 平台支持

| 平台 | 架构 | 构建方式 | 状态 |
|------|------|----------|------|
| Linux | x86-64 | make / zig | ✅ 已测试 |
| Linux | arm64 | zig | ✅ 已测试 |
| macOS | x86-64 | make / zig | ⚠️ 代码已适配，待实际测试 |
| macOS | arm64 (M1/M2) | zig | ⚠️ 代码已适配，待实际测试 |

**macOS 兼容性说明**：
- 已添加 `clock_gettime()` 和 `getline()` 兼容层
- 使用 POSIX 标准 socket API（无 epoll 依赖）
- Makefile 自动检测平台并调整链接选项
- 详细分析见 [docs/macos-compatibility.md](docs/macos-compatibility.md)

## 快速开始

### 安装

#### 方式1：下载 APE 二进制（推荐，跨平台）
```bash
# 下载 APE 二进制（Linux/macOS/Windows 通用）
wget https://github.com/your-org/ndtsdb/releases/download/v0.3.0/ndtsdb-cli.com
chmod +x ndtsdb-cli.com

# 直接运行（无需安装）
./ndtsdb-cli.com --help

# 可选：安装到系统 PATH
sudo mv ndtsdb-cli.com /usr/local/bin/ndtsdb-cli
```

#### 方式2：下载 Linux 优化版
```bash
# Linux x86-64 优化版（更小更快）
wget https://github.com/your-org/ndtsdb/releases/download/v0.3.0/ndtsdb-cli-linux-x64
chmod +x ndtsdb-cli-linux-x64
sudo mv ndtsdb-cli-linux-x64 /usr/local/bin/ndtsdb-cli
```

#### 方式3：从源码编译
```bash
# 克隆仓库
git clone https://github.com/your-org/ndtsdb.git
cd ndtsdb/ndtsdb-cli

# 本地开发构建（gcc）
make all                    # 输出 ndtsdb-cli（约 6.3MB，含 debug）

# Release 构建（zig + strip，推荐）
make release                # 输出 dist/ndtsdb-cli（约 1.2MB）
make release-size           # 查看二进制大小

# APE 跨平台构建（cosmocc，单文件跑 Linux/macOS/Windows）
make cosmo                  # 输出 ndtsdb-cli.com（约 3.0MB）
make cosmo-size             # 查看 APE 信息

# Docker 可复现构建（CI 用）
make cosmo-docker           # 容器内编译，输出 ndtsdb-cli-docker.com
bash scripts/ci-build.sh    # CI 完整验证流程
```

**构建产物对比**：

| 方式 | 命令 | 大小 | 用途 |
|------|------|------|------|
| gcc 开发 | `make` | 6.3MB | 本地开发调试 |
| zig release | `make release` | 1.2MB | Linux 生产部署 |
| cosmocc APE | `make cosmo` | 3.0MB | 跨平台分发 |
| docker 构建 | `make cosmo-docker` | 3.4MB | CI/CD 可复现 |

### 基本使用

#### REPL 模式
```bash
./ndtsdb-cli
```

#### 脚本模式
```bash
./ndtsdb-cli scripts/example-basic.js
```

#### 查看版本
```bash
./ndtsdb-cli --version
```

## 快速上手（5 分钟入门）

### 第 1 步：写入数据（write-json）
```bash
# 创建数据库目录
mkdir -p /tmp/mydb

# 写入 K 线数据（JSON Lines 格式）
echo '{"symbol":"BTC","interval":"1h","timestamp":1700000000000,"open":40000,"high":41000,"low":39500,"close":40500,"volume":100}' | \
  ./ndtsdb-cli write-json --database /tmp/mydb

echo '{"symbol":"BTC","interval":"1h","timestamp":1700003600000,"open":40500,"high":42000,"low":40000,"close":41500,"volume":150}' | \
  ./ndtsdb-cli write-json --database /tmp/mydb

echo '{"symbol":"ETH","interval":"1h","timestamp":1700000000000,"open":2000,"high":2100,"low":1950,"close":2050,"volume":500}' | \
  ./ndtsdb-cli write-json --database /tmp/mydb
```

### 第 2 步：查询数据（query）
```bash
# 查询所有数据
./ndtsdb-cli query --database /tmp/mydb --format json

# 查询特定 symbol
./ndtsdb-cli query --database /tmp/mydb --symbol BTC --format json

# 查询 CSV 格式
./ndtsdb-cli query --database /tmp/mydb --format csv
```

### 第 3 步：SQL 分析（sql）
```bash
# 统计每个 symbol 的数据条数
./ndtsdb-cli sql --database /tmp/mydb \
  "SELECT symbol, COUNT(*) as count FROM data GROUP BY symbol"

# 计算平均收盘价
./ndtsdb-cli sql --database /tmp/mydb \
  "SELECT symbol, AVG(close) as avg_close FROM data GROUP BY symbol"

# 时间范围查询
./ndtsdb-cli sql --database /tmp/mydb \
  "SELECT * FROM data WHERE timestamp > 1700003000000 ORDER BY timestamp DESC"
```

### 第 4 步：指标计算（script）
```bash
# 计算 SMA（简单移动平均）
./ndtsdb-cli script --database /tmp/mydb --symbol BTC --interval 1h \
  --indicator sma --period 2

# 计算 EMA（指数移动平均）
./ndtsdb-cli script --database /tmp/mydb --symbol BTC --interval 1h \
  --indicator ema --period 2

# 计算 RSI（相对强弱指数）
./ndtsdb-cli script --database /tmp/mydb --symbol BTC --interval 1h \
  --indicator rsi --period 2
```

**完整流程验证**：
```bash
# 一键验证（复制粘贴执行）
mkdir -p /tmp/demo && \
echo '{"symbol":"BTC","interval":"1h","timestamp":1,"open":100,"high":110,"low":90,"close":105,"volume":1000}' | ./ndtsdb-cli write-json --database /tmp/demo && \
echo '{"symbol":"BTC","interval":"1h","timestamp":2,"open":105,"high":115,"low":100,"close":110,"volume":1200}' | ./ndtsdb-cli write-json --database /tmp/demo && \
./ndtsdb-cli query --database /tmp/demo --format json && \
./ndtsdb-cli sql --database /tmp/demo "SELECT AVG(close) FROM data" && \
./ndtsdb-cli script --database /tmp/demo --symbol BTC --interval 1h --indicator sma --period 2
```

## v1.0 新特性（M1-M4 里程碑）

### M1: 向量存储（Vector Storage）

ndtsdb-cli 原生支持 embedding 向量存储，为 RAG 和语义搜索提供底层支持。

**特性**：
- 独立 `.ndtv` 文件格式存储向量记录
- 支持 float32 embedding 数组（变长）
- 元数据：agent_id, type, timestamp, confidence

**写入向量**：
```bash
# 通过 HTTP API 写入
curl -X POST http://localhost:9099/write-vector \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "bot-006",
    "type": "semantic",
    "timestamp": 1709123456789,
    "confidence": 0.95,
    "embedding": [0.1, 0.2, 0.3, ...]
  }'
```

### M2: 语义检索（Semantic Search）

基于 COSINE_SIM 的向量相似度查询，实现语义级别的知识检索。

**查询语法**：
```sql
-- SQL 方式查询相似向量
SELECT * FROM vectors 
WHERE COSINE_SIM(embedding, [0.1, 0.2, ...]) > 0.8
ORDER BY similarity DESC
LIMIT 10;
```

**HTTP API 方式**：
```bash
# GET /query-vectors 端点
curl "http://localhost:9099/query-vectors?embedding=[0.1,0.2,...]&threshold=0.8&limit=10"

# 可选按 agent_id 过滤
curl "http://localhost:9099/query-vectors?embedding=[...]&agent_id=bot-006"
```

### M2.5: 知识引擎 CLI（Knowledge Engine）

ndtsdb-cli 提供完整的知识库管理命令，支持 embedding 生成、语义搜索和知识库管理。

**1. embed 命令 - 生成 embedding 向量**
```bash
# 使用 TF-IDF 哈希生成文本的 embedding（纯 C 实现，零依赖）
ndtsdb-cli embed --text "Bitcoin is a cryptocurrency" --dim 384
# 输出: [0.0234, -0.1567, 0.0891, ...] (384维)
```

**2. search 命令 - 语义搜索**
```bash
# 在数据库中搜索相似向量
ndtsdb-cli search --database ./knowledge.db \
  --query-vector '[0.1,0.2,0.3,0.4]' \
  --top-k 5 \
  --threshold 0.8

# 输出格式可选 JSON 或 CSV
ndtsdb-cli search -d ./knowledge.db -q '[0.1,0.2,0.3]' -k 10 -f csv
```

**3. facts 命令 - 知识库管理**

*导入知识（JSONL 格式）*：
```bash
# 准备 facts.jsonl 文件（每行一个 JSON 对象）
cat > facts.jsonl << 'EOF'
{"text":"Bitcoin is a cryptocurrency","embedding":[0.1,0.2,0.3,0.4],"tags":["crypto","bitcoin"]}
{"text":"Ethereum supports smart contracts","embedding":[0.2,0.3,0.4,0.5],"tags":["crypto","ethereum"]}
{"text":"Machine learning is a subset of AI","embedding":[0.8,0.7,0.6,0.5],"tags":["ai","ml"]}
EOF

# 导入到知识库
ndtsdb-cli facts import --database ./knowledge.db --input facts.jsonl
```

*列出知识*：
```bash
ndtsdb-cli facts list --database ./knowledge.db
```

*知识库语义搜索*：
```bash
ndtsdb-cli facts search --database ./knowledge.db \
  --query-vector '[0.1,0.2,0.3,0.4]' \
  --top-k 5
```

**JSONL 格式说明**：
- 每行一个独立的 JSON 对象
- 必需字段：`embedding` (float 数组)
- 可选字段：`text` (字符串), `tags` (字符串数组)
- 示例：`{"text":"...","embedding":[0.1,0.2,...],"tags":["tag1"]}`

### M3: 并发 HTTP API（Concurrent HTTP Server）

serve 模式提供完整的 HTTP/WebSocket API，支持多客户端并发访问。

**启动服务器**：
```bash
./ndtsdb-cli serve --database ./data --port 9099
```

**Endpoints**：
| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/symbols` | GET | 列出所有 symbol/interval |
| `/query` | GET | 查询 OHLCV 数据 |
| `/write-json` | POST | 写入 JSON 数据 |
| `/write-vector` | POST | 写入向量记录（M3-P1）|
| `/query-vectors` | GET | 向量相似度查询（M3-P2）|
| `/subscribe` | WS | WebSocket 实时订阅 |

### M4: 知识引擎（Knowledge Engine）

纯C内置知识引擎，零外部依赖。支持 embedding 生成、向量搜索、知识库管理。

**1. 生成 Embedding（纯C TF-IDF hash）**：
```bash
# 生成64维向量
ndtsdb-cli embed --text "量化交易系统" --dim 64
# 输出: {"embedding":[0.123,...]}

# 生成128维向量（推荐，区分度更好）
ndtsdb-cli embed --text "time series database" --dim 128
```

**2. 导入知识库（JSONL 格式）**：
```bash
# 准备 facts.jsonl（每行一条）
echo '{"timestamp":1000,"agent_id":"bot","type":"fact","confidence":0.9,"embedding":[0.1,0.2,0.3]}' > facts.jsonl

# 导入到数据库
ndtsdb-cli facts import --database ./knowledge --input facts.jsonl
```

**3. 列出知识库**：
```bash
ndtsdb-cli facts list --database ./knowledge
ndtsdb-cli facts list --database ./knowledge --tag fact
```

**4. 语义搜索**：
```bash
# 通过 facts search（默认查 facts/embedding 分区）
ndtsdb-cli facts search --database ./knowledge --query-vector '[0.1,0.2,0.3]' --top-k 5

# 通过 search 命令（支持任意分区）
ndtsdb-cli search --database ./knowledge --query-vector '[0.1,0.2,0.3]' --top-k 10 --threshold 0.5

# 端到端：embed → search 管线
VEC=$(ndtsdb-cli embed --text "查找相似内容" --dim 64 | grep -o '\[.*\]')
ndtsdb-cli search --database ./knowledge --query-vector "$VEC" --top-k 5
```

**5. HTTP API 语义搜索**：
```bash
curl "http://localhost:9099/query-vectors?embedding=[0.1,0.2,...]&threshold=0.8&limit=10"
```

## 子命令（CLI Subcommands）

除脚本模式外，ndtsdb-cli 支持内置子命令直接操作数据库：

| 子命令 | 说明 | 版本 |
|--------|------|------|
| `query` | 查询 K 线数据 | v0.2.0 |
| `list` | 列出可用 symbol | v0.2.0 |
| `write-json` | 从 JSON Lines 写入数据 | v0.2.0 |
| `write-csv` | 从 CSV 写入数据 | v0.2.0 |
| `sql` | SQL 查询（WHERE/GROUP BY/HAVING/DISTINCT/BETWEEN/IN/OR/LIKE） | v0.2.0+ |
| `partitioned list/query/write-json` | 目录型数据库管理 | v0.2.2 |
| `delete` | 按 timestamp 软删除 | v0.2.2 |
| `upsert` | 按 timestamp 主键更新写入 | v0.2.2 |
| `sma` | Simple Moving Average 纯C（`--since/--until --format csv/json`） | v0.2.2 |
| `ema` | Exponential Moving Average 纯C | v0.2.2 |
| `atr` | Average True Range 纯C Wilder 平滑 | v0.2.2 |
| `tail` | 查询末尾 N 行（`--n 10 --format csv/json`） | **v0.3.0** |
| `head` | 查询前 N 行（`--n 10 --format csv/json`） | **v0.3.0** |
| `script` | 执行 JS 脚本文件（嵌入式 QuickJS 运行时） | **v0.3.0** |
| `repl` | 交互式 JS Shell（带 ndtsdb 模块） | **v0.3.0** |
| `wal-replay` | WAL 日志重放（崩溃恢复） | v0.3.0 |
| `serve` | HTTP 服务器模式 | v0.2.0 |
| `write-vector` | 写入向量记录（embedding） | **v1.0.0** |
| `query-vectors` | 向量相似度查询（COSINE_SIM） | **v1.0.0** |

### query - 查询 K 线数据

```bash
# 查询所有数据
./ndtsdb-cli query --database ./data/btc

# 按 symbol 过滤（逗号分隔多个）
./ndtsdb-cli query --database ./data/btc --symbols BTCUSDT
./ndtsdb-cli query --database ./data/btc --symbols BTCUSDT,ETHUSDT

# 时间范围过滤（毫秒时间戳）
./ndtsdb-cli query --database ./data/btc --since 1700000000000 --until 1700086400000
./ndtsdb-cli query --database ./data/btc --symbols BTCUSDT --since 1700000000000

# 分页查询
./ndtsdb-cli query --database ./data/btc --limit 10
./ndtsdb-cli query --database ./data/btc --limit 10 --offset 20

# 输出格式选择
./ndtsdb-cli query --database ./data/btc --format json     # 默认，每行一个JSON
./ndtsdb-cli query --database ./data/btc --format csv      # CSV格式，带header
./ndtsdb-cli query --database ./data/btc --format table    # 表格对齐，便于阅读

# 组合使用
./ndtsdb-cli query --database ./data/btc --symbols BTCUSDT --limit 5 --offset 0
./ndtsdb-cli query --database ./data/btc --symbols BTCUSDT --since 1700000000000 --format csv
```

输出格式：
- `json`（默认）：每行一个JSON对象
- `csv`：首行header，逗号分隔，适合导入Excel/pandas
- `table`：空格对齐表格，便于人眼阅读

### list - 列出可用 symbol

```bash
# 列出数据库中所有 symbol/interval 组合
./ndtsdb-cli list --database ./data/btc

# 输出示例:
# [{"symbol":"BTCUSDT","interval":"1h","count":100},{"symbol":"ETHUSDT","interval":"1h","count":50}]

# 空数据库返回 []
./ndtsdb-cli list --database ./data/empty
```

### write-json - 从 JSON Lines 写入数据

从 stdin 读取 JSON Lines 格式数据，写入 native 格式数据库。用于外部程序（如 kline-cli）与 ndtsdb-cli 的格式互通。

```bash
# 基本用法：从 stdin 写入单条数据
echo '{"symbol":"BTCUSDT","interval":"1h","timestamp":1700000000000,"open":42000,"high":42100,"low":41900,"close":42050,"volume":1000}' | \
  ./ndtsdb-cli write-json --database ./data/btc

# 写入多条数据（多行）
cat <<EOF | ./ndtsdb-cli write-json --database ./data/btc
{"symbol":"BTCUSDT","interval":"1h","timestamp":1700000000000,"open":42000,"high":42100,"low":41900,"close":42050,"volume":1000}
{"symbol":"BTCUSDT","interval":"1h","timestamp":1700003600000,"open":42050,"high":42150,"low":41950,"close":42100,"volume":1200}
{"symbol":"ETHUSDT","interval":"1h","timestamp":1700000000000,"open":2200,"high":2210,"low":2190,"close":2205,"volume":5000}
EOF

# 从文件批量导入
jq -c '.[]' data.json | ./ndtsdb-cli write-json --database ./data/imported
```

**输入格式**：每行一个 JSON 对象，必须包含以下字段：
- `symbol`: 交易对（如 `BTCUSDT`）
- `interval`: K线周期（如 `1h`, `5m`, `1d`）
- `timestamp`: 毫秒时间戳（如 `1700000000000`）
- `open`, `high`, `low`, `close`, `volume`: 价格/成交量数据

**场景说明**：
- **与 kline-cli 集成**：kline-cli fetch --format ndtsdb 内部调用 write-json
- **数据迁移**：从其他系统导出 JSON → 用 write-json 导入 native 格式
- **程序化写入**：脚本生成 JSON Lines → 管道写入数据库

**输出**：写入完成后输出插入行数
```
Inserted 3 rows
```

### write-csv - 从 CSV 写入数据

从 stdin 读取 CSV 格式数据，写入 native 格式数据库。CSV 格式与 `query --format csv` 输出对应（列顺序不同）。

```bash
# 基本用法：从 stdin 写入单条数据
echo 'BTCUSDT,1m,1700000000000,30000,30100,29900,30050,100.5' | \
  ./ndtsdb-cli write-csv --database ./data/btc

# 写入多条数据（含header行）
cat <<EOF | ./ndtsdb-cli write-csv --database ./data/btc
symbol,interval,timestamp,open,high,low,close,volume
BTCUSDT,1m,1700000000000,30000,30100,29900,30050,100.5
BTCUSDT,1m,1700003600000,30050,30200,30000,30100,1200
ETHUSDT,1h,1700000000000,2200,2210,2190,2205,5000
EOF

# 从文件批量导入
cat data.csv | ./ndtsdb-cli write-csv --database ./data/imported
```

**输入格式**：CSV 格式，首行可为 header（自动跳过），列顺序：
```
symbol,interval,timestamp,open,high,low,close,volume
```

必需字段：
- `symbol`: 交易对（如 `BTCUSDT`）
- `interval`: K线周期（如 `1h`, `5m`, `1d`）
- `timestamp`: 毫秒时间戳（如 `1700000000000`）
- `open`, `high`, `low`, `close`, `volume`: 价格/成交量数据

**错误处理**：
- 列数不足的行会被跳过，并输出警告
- 解析失败的行会被跳过，并输出警告
- 成功/失败行数会统计输出

**输出**：写入完成后输出行数统计
```
write-csv: 100 rows inserted, 2 errors
```

**场景说明**：
- **与 query --format csv 配合**：`query --format csv` 的结果经转换后可被 `write-csv` 导入
- **从其他系统导入**：Excel/pandas 导出的 CSV → 用 write-csv 导入 native 格式
- **数据迁移**：CSV 格式作为中间交换格式

### write-json 新增标志（v0.2.2）

**--upsert**：按 timestamp 主键更新/插入

```bash
# UPSERT模式：如果timestamp已存在则更新，否则插入
echo '{"symbol":"BTC","interval":"1m","timestamp":1000,"open":100,"high":110,"low":90,"close":105,"volume":1000}' | \
  ./ndtsdb-cli write-json --database ./data/btc --upsert

# 批量UPSERT（多行JSON Lines）
cat <<EOF | ./ndtsdb-cli write-json --database ./data/btc --upsert
{"symbol":"BTC","interval":"1m","timestamp":1000,"open":101,"high":111,"low":91,"close":106,"volume":1100}
{"symbol":"BTC","interval":"1m","timestamp":1001,"open":102,"high":112,"low":92,"close":107,"volume":1200}
EOF
```

**--delete**：写入 tombstone（软删除标记）

```bash
# 通过write-json写入tombstone（volume=-1标记为删除）
echo '{"symbol":"BTC","interval":"1m","timestamp":1000}' | \
  ./ndtsdb-cli write-json --database ./data/btc --delete

# 输出：
# Inserted 1 rows (tombstone)
```

> **注意**：query/partitioned query 自动过滤 tombstone 行（volume < 0）。

### sql - SQL 查询

执行 SQL 子集查询，支持类 SQL 语法过滤数据。

```bash
# 从命令行参数传入 SQL
echo "SELECT symbol,timestamp,close FROM data WHERE symbol='BTCUSDT' LIMIT 10" | \
  ./ndtsdb-cli sql --database ./data/btc

# 或者使用 --query 参数
./ndtsdb-cli sql --database ./data/btc --query "SELECT * FROM data WHERE timestamp > 1700000000000 LIMIT 5"

# 复杂 WHERE 条件
./ndtsdb-cli sql --database ./data/btc --query "SELECT symbol,close FROM data WHERE symbol='BTCUSDT' AND timestamp > 1700000000000 AND timestamp < 1700086400000 LIMIT 100"

# LIMIT OFFSET 分页（v0.2.2）
./ndtsdb-cli sql --database ./data/btc --query "SELECT * FROM data LIMIT 10 OFFSET 20"

# ORDER BY DESC 倒序（v0.2.2）
./ndtsdb-cli sql --database ./data/btc --query "SELECT * FROM data ORDER BY timestamp DESC LIMIT 5"
```

**支持的 SQL 子集**：
- `SELECT <fields>` - 选择字段（`*` 或具体字段名，如 `symbol,timestamp,close`）
- `FROM <table>` - 表名（任意名称，始终查询当前 database）
- `WHERE` 条件：
  - `symbol='xxx'` - 按交易对过滤
  - `timestamp > N` / `timestamp >= N` - 开始时间（毫秒时间戳）
  - `timestamp < N` / `timestamp <= N` - 结束时间（毫秒时间戳）
  - `AND` 组合多个条件
- `LIMIT N` - 限制返回条数
- `LIMIT N OFFSET M` - 分页（v0.2.2）
- `ORDER BY timestamp DESC` - 倒序（v0.2.2）

**输出格式**：JSON Lines（每行一个 JSON 对象）

**示例输出**：
```json
{"symbol":"BTCUSDT","timestamp":1700000000000,"close":30050}
{"symbol":"BTCUSDT","timestamp":1700000060000,"close":30100}
```

**测试**：`tests/integration/test-sql.sh`

### serve - HTTP服务器模式

启动轻量级HTTP服务器，提供REST API和WebSocket实时推送服务。

```bash
# 启动服务器
./ndtsdb-cli serve --database ./data/btc --port 8080

# 后台运行
./ndtsdb-cli serve --database ./data/btc --port 8080 &
```

**HTTP API端点**：

| 方法 | 端点 | 参数 | 说明 |
|------|------|------|------|
| GET | `/health` | - | 健康检查 |
| GET | `/symbols` | - | 列出所有symbol |
| GET | `/query` | `symbol`, `since`, `until`, `limit` | 查询数据 |
| POST | `/write-json` | - | 写入JSON数据 |

**WebSocket端点**：

| 端点 | 参数 | 说明 |
|------|------|------|
| WS | `/subscribe?symbol=SYMBOL&interval=INTERVAL` | 实时数据订阅 |

**WebSocket特性**：
- 每1秒推送最新数据
- 无新数据时发送心跳 `{"type":"heartbeat"}`
- 支持ping/pong保活
- 支持多客户端同时订阅不同symbol

**HTTP使用示例**：

```bash
# 健康检查
curl http://localhost:8080/health
# 输出: {"status":"ok","version":"ndtsdb-cli v0.2.0"}

# 列出所有symbol
curl http://localhost:8080/symbols
# 输出: [{"symbol":"BTCUSDT","interval":"1h","count":100}, ...]

# 查询特定symbol
curl "http://localhost:8080/query?symbol=BTCUSDT"

# 查询特定时间范围
curl "http://localhost:8080/query?symbol=BTCUSDT&since=1700000000000&until=1700086400000"
```

**WebSocket使用示例**：

```bash
# 使用 websocat 订阅实时数据
websocat ws://localhost:8080/subscribe?symbol=BTCUSDT

# 使用 wscat 订阅实时数据
wscat -c ws://localhost:8080/subscribe?symbol=BTCUSDT&interval=1m

# 使用 curl 测试WebSocket握手（仅验证端点）
curl -i -N \
  -H "Upgrade: websocket" \
  -H "Connection: Upgrade" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Version: 13" \
  http://localhost:8080/subscribe?symbol=BTCUSDT
```

**WebSocket消息格式**：

```json
// 连接成功
{"type":"connected","symbol":"BTCUSDT"}

// 数据推送
{"symbol":"BTCUSDT","interval":"1m","timestamp":1700000000000,"open":30000,"high":30100,"low":29900,"close":30050,"volume":100}

// 心跳（无新数据时）
{"type":"heartbeat"}
```

**测试**：`tests/integration/test-serve.sh`, `tests/integration/test-websocket.sh`

### partitioned - 目录型数据库管理（v0.2.2）

管理分区表（目录型数据库），支持多 symbol/interval 的数据组织。

```bash
# 写入目录型数据库（自动按 symbol_interval 分区）
echo '{"symbol":"BTC","interval":"1m","timestamp":1,"open":100,"high":110,"low":90,"close":105,"volume":1000}' | \
  ./ndtsdb-cli partitioned write-json --database /data/partitioned

# 列出所有 symbol/interval 组合
./ndtsdb-cli partitioned list --database /data/partitioned
# 输出示例：
# {"symbol":"BTC","interval":"1m"}
# {"symbol":"ETH","interval":"1m"}

# 查询指定 symbol/interval
./ndtsdb-cli partitioned query --database /data/partitioned --symbol BTC --interval 1m
# 输出示例：
# {"symbol":"BTC","interval":"1m","timestamp":1,"open":100.00000000,...}
```

**适用场景**：
- 多交易对数据管理（BTC/ETH/BNB 等）
- 多时间周期数据（1m/5m/1h/1d 等）
- 与 Bun 版 PartitionedTable API 数据互通

### delete - 软删除（v0.2.2）

按 timestamp 软删除数据（tombstone 机制）。

```bash
# 删除指定 timestamp
./ndtsdb-cli delete --database ./data/btc --symbol BTC --interval 1m --timestamp 1000

# 输出：
# Deleted: symbol=BTC, interval=1m, timestamp=1000
```

**实现原理**：
- 写入一行特殊数据，volume=-1 作为 tombstone 标记
- query/partitioned query 自动过滤 volume < 0 的行
- 数据物理上仍存在，但查询不可见

**或通过 write-json --delete**：
```bash
echo '{"symbol":"BTC","interval":"1m","timestamp":1000}' | \
  ./ndtsdb-cli write-json --database ./data/btc --delete
```

### sma / ema / atr - 技术指标（v0.2.2）

纯C实现的技术指标计算，输出 JSON Lines 格式。

```bash
# SMA（简单移动平均）
./ndtsdb-cli sma --database ./data/btc --symbol BTC --interval 1m --period 20

# EMA（指数移动平均）
./ndtsdb-cli ema --database ./data/btc --symbol BTC --interval 1m --period 20

# ATR（平均真实波幅，Wilder平滑）
./ndtsdb-cli atr --database ./data/btc --symbol BTC --interval 1m --period 14
```

**输出格式**（JSON Lines）：
```json
{"timestamp":20,"sma":105.5}
{"timestamp":21,"sma":106.2}
...
```

**说明**：
- SMA/EMA 从第 `period` 行开始有输出
- ATR 从第 14 行开始有输出（默认 period=14）
- 自动过滤 tombstone 行

---

### tail / head - 首尾 N 行查询（v0.3.0）

```bash
# 最新 10 行（默认）
ndtsdb-cli tail --database ./mydb --symbol BTC --interval 1m

# 最新 5 行，CSV 输出
ndtsdb-cli tail --database ./mydb --symbol BTC --interval 1m --n 5 --format csv

# 最早 3 行
ndtsdb-cli head --database ./mydb --symbol BTC --interval 1m --n 3
```

---

### script - 执行 JS 脚本文件（v0.3.0）

ndtsdb-cli 内嵌完整 QuickJS 运行时，可直接执行任意 `.js` 文件。

```bash
# 基本用法
ndtsdb-cli script my-strategy.js --database ./mydb

# 传额外参数（在脚本中通过 __args 访问）
ndtsdb-cli script strategy.js --database ./mydb ETH 5m
```

**脚本中可用的全局变量：**

```javascript
// ndtsdb  — 完整数据库模块
// __database — --database 参数值
// __args     — 额外参数数组
// __file     — 本脚本路径

const db = ndtsdb.open(__database);
const rows = ndtsdb.queryFiltered(db, ['BTC']);

// 计算均值
const avg = rows.reduce((s, r) => s + Number(r.close), 0) / rows.length;
console.log(`BTC 均价: ${avg.toFixed(2)}`);

ndtsdb.close(db);
```

**特性：**
- 支持 ES Module 语法（`import/export`、`async/await`）
- 零依赖，APE 单文件运行，不需要 node / bun / npm
- 示例脚本见 `examples/script-demo.js`、`examples/simple-strategy.js`

---

### repl - 交互式 JS Shell（v0.3.0）

```bash
# 启动 REPL（自动打开数据库）
ndtsdb-cli repl --database ./mydb

# 无数据库
ndtsdb-cli repl
```

```
ndtsdb-cli REPL v0.3.0 (QuickJS + ndtsdb)
Database: ./mydb  →  globalThis.__db 已打开
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
可用: ndtsdb / __database / __db
命令: .exit .help .symbols .version
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ndtsdb> ndtsdb.queryAll(__db).length
150
ndtsdb> .symbols
BTC@1m: 100 rows
ETH@1m: 50 rows
ndtsdb> ndtsdb.queryFiltered(__db, ['BTC']).slice(-3).map(r => r.close)
[ 105, 106, 107 ]
ndtsdb> .exit
```

**REPL 内置命令：**

| 命令 | 说明 |
|------|------|
| `.exit` / `.quit` | 退出（自动关闭数据库） |
| `.help` | 显示 ndtsdb API 帮助 |
| `.symbols` | 列出所有 symbol/interval 及行数 |
| `.version` | 显示版本 |

---

### sql 增强（v0.3.0）

```bash
# WHERE BETWEEN
ndtsdb-cli sql --database ./mydb --query 'SELECT * FROM data WHERE timestamp BETWEEN 100 AND 200'

# WHERE IN
ndtsdb-cli sql --database ./mydb --query 'SELECT * FROM data WHERE timestamp IN (1, 5, 10)'

# WHERE OR
ndtsdb-cli sql --database ./mydb --query "SELECT * FROM data WHERE symbol = 'BTC' OR symbol = 'ETH'"

# WHERE LIKE
ndtsdb-cli sql --database ./mydb --query "SELECT * FROM data WHERE symbol LIKE 'BTC%'"

# SELECT DISTINCT
ndtsdb-cli sql --database ./mydb --query 'SELECT DISTINCT symbol FROM data'

# 多列 GROUP BY
ndtsdb-cli sql --database ./mydb --query 'SELECT symbol, interval, COUNT(*) FROM data GROUP BY symbol, interval'

# HAVING
ndtsdb-cli sql --database ./mydb --query 'SELECT symbol, COUNT(*) FROM data GROUP BY symbol HAVING COUNT(*) > 100'

# CSV 输出
ndtsdb-cli sql --database ./mydb --query 'SELECT * FROM data LIMIT 10' --format csv
```

---

## 插件系统（Plugin System）

ndtsdb-cli 支持通过插件扩展功能。插件是纯 JavaScript 文件，可以注册自定义函数供用户脚本调用。

### 基本用法

```bash
# 加载插件后运行脚本
./ndtsdb-cli --plugin ./my-plugin.js script.js

# 加载插件后进入REPL（插件函数在REPL中可用）
./ndtsdb-cli --plugin ./my-plugin.js
```

### 插件格式

插件是一个 JavaScript 文件，必须定义 `globalThis.onLoad` 函数：

```javascript
// my-plugin.js
// 必须设置 globalThis.onLoad，ndtsdb-cli 会自动调用

globalThis.onLoad = function(registry) {
  // 注册自定义函数
  registry.register('myFunc', (arg1, arg2) => {
    return arg1 + arg2;
  }, {
    description: 'My custom function',
    author: 'Your Name',
    version: '1.0.0'
  });
  
  // 可以注册多个函数
  registry.register('formatPrice', (price, decimals = 2) => {
    return price.toFixed(decimals);
  });
};
```

### 完整示例

**示例插件**：`examples/my-plugin.js`

```javascript
globalThis.onLoad = function(registry) {
  console.log('[MyPlugin] Initializing...');

  // 注册数学函数
  registry.register('add', (a, b) => a + b, {
    description: 'Add two numbers',
    version: '1.0.0'
  });

  // 注册字符串函数
  registry.register('reverse', (str) => str.split('').reverse().join(''), {
    description: 'Reverse a string',
    version: '1.0.0'
  });

  // 注册数据格式化函数
  registry.register('formatPrice', (price, decimals = 2) => price.toFixed(decimals));
};
```

**使用插件的脚本**：`examples/test-plugin.js`

```javascript
// 调用插件注册的函数
const sum = add(10, 20);
console.log(`add(10, 20) = ${sum}`);  // 输出: 30

const reversed = reverse('BTCUSDT');
console.log(`reverse('BTCUSDT') = '${reversed}'`);  // 输出: 'TDSUCTB'

const price = formatPrice(12345.6789, 4);
console.log(`formatPrice(12345.6789, 4) = ${price}`);  // 输出: 12345.6789
```

**运行**:
```bash
./ndtsdb-cli --plugin examples/my-plugin.js examples/test-plugin.js
```

### API 参考

#### registry.register(name, fn, options)

注册一个函数到全局命名空间。

**参数**:
- `name` (string): 函数名，注册后可通过该名称直接调用
- `fn` (Function): 函数实现
- `options` (Object, optional): 元信息
  - `description`: 函数描述
  - `author`: 作者
  - `version`: 版本号

**示例**:
```javascript
registry.register('multiply', (a, b) => a * b, {
  description: 'Multiply two numbers',
  author: 'Trader',
  version: '1.0.0'
});

// 在脚本中使用
const result = multiply(5, 3);  // 15
```

#### registry.list()

列出所有已注册的函数。

**返回**: 数组，每项包含 `name`, `description`, `author`, `version`

**示例**:
```javascript
const funcs = registry.list();
funcs.forEach(f => {
  console.log(`${f.name}: ${f.description} (v${f.version})`);
});
```

### 最佳实践

1. **函数命名**: 使用描述性名称，避免与内置API冲突
2. **错误处理**: 在插件函数中处理边界情况
3. **文档**: 为每个注册的函数提供描述
4. **命名空间**: 如果插件功能较多，可使用前缀避免冲突（如 `mylib_funcName`）

### 内置插件示例

ndtsdb-cli 自带示例插件，可直接体验：

```bash
./ndtsdb-cli --plugin examples/my-plugin.js
# 在REPL中测试
> add(10, 20)
30
> reverse('BTCUSDT')
TDSUCTB
```

## 流式指标（Streaming Indicators）

ndtsdb-cli 内置流式技术指标库，支持实时计算。

### StreamingSMA - 简单移动平均

```javascript
import { StreamingSMA } from 'stdlib/indicators.js';

// 创建 20 周期 SMA
const sma = new StreamingSMA(20);

// 流式更新
for (const row of data) {
    const value = sma.update(row.close);
    if (value !== null) {
        console.log(`SMA20: ${value.toFixed(2)}`);
    }
}

// 检查状态
console.log(sma.value);    // 当前值或 null
console.log(sma.isReady);  // 是否有足够数据
console.log(sma.count);    // 已接收数据点数

// 重置
sma.reset();
```

**完整示例**：`scripts/example-sma.js`
```bash
# 准备测试数据
cat <<EOF | ./ndtsdb-cli write-csv --database ./data/btc
symbol,interval,timestamp,open,high,low,close,volume
BTCUSDT,1h,1700000000000,42000,42100,41900,42050,1000
EOF

# 运行 SMA 示例
./ndtsdb-cli scripts/example-sma.js --database ./data/btc --symbol BTCUSDT --period 20
```

### StreamingEMA - 指数移动平均

EMA 对近期数据赋予更高权重，比 SMA 更快响应价格变化。

```javascript
// EMA实现（内联，QuickJS单二进制限制）
class StreamingEMA {
    constructor(period = 20) {
        this.period = period;
        this.multiplier = 2 / (period + 1);
        this.reset();
    }
    reset() {
        this._values = [];
        this._sum = 0;
        this._value = null;
        this._initialized = false;
    }
    get value() { return this._value; }
    get isReady() { return this._initialized; }
    update(close) {
        if (!this._initialized) {
            this._values.push(close);
            this._sum += close;
            if (this._values.length === this.period) {
                this._value = this._sum / this.period;  // SMA初始化
                this._initialized = true;
                this._values = [];
            }
        } else {
            // EMA = close × k + prevEMA × (1 - k)
            this._value = close * this.multiplier + this._value * (1 - this.multiplier);
        }
        return this._value;
    }
}

// 使用示例
const ema = new StreamingEMA(20);
for (const row of data) {
    const value = ema.update(row.close);
    if (value !== null) {
        console.log(`EMA20: ${value.toFixed(2)}`);
    }
}
```

**公式**：
- `multiplier = 2 / (period + 1)`
- 前 `period` 个数据用 SMA 初始化
- 后续：`EMA = close × multiplier + prevEMA × (1 - multiplier)`

**示例**：`examples/ema-example.js`
**测试**：`tests/indicators-ema.test.js`（20个测试用例）

### StreamingMACD - MACD 指标

MACD（Moving Average Convergence Divergence）是趋势跟踪动量指标，显示两条EMA之间的关系。

```javascript
import { StreamingMACD } from 'stdlib/indicators.js';

// 创建 MACD(12, 26, 9)
const macd = new StreamingMACD(12, 26, 9);

// 流式更新
for (const row of data) {
    const result = macd.update(row.close);
    if (result !== null) {
        console.log(`MACD: ${result.macd.toFixed(4)}`);
        console.log(`Signal: ${result.signal.toFixed(4)}`);
        console.log(`Histogram: ${result.histogram.toFixed(4)}`);
    }
}

// 检查状态
console.log(macd.value);    // { macd, signal, histogram } 或 null
console.log(macd.isReady);  // 是否有足够数据

// 重置
macd.reset();
```

**算法**：
1. `fastEMA` = EMA(close, fast=12)
2. `slowEMA` = EMA(close, slow=26)
3. `macd` = fastEMA - slowEMA
4. `signal` = EMA(macd, signal=9)
5. `histogram` = macd - signal

**返回值**：对象包含三个值
- `macd`: MACD线值
- `signal`: 信号线值  
- `histogram`: 柱状图值（macd - signal）

**准备条件**：需要 `slow + signal - 1` 个数据点（默认 26+9-1=34 条）

**完整示例**：`scripts/example-macd.js`
```bash
# 运行 MACD 示例
./ndtsdb-cli scripts/example-macd.js --database ./data/btc --symbol BTCUSDT
```

**测试**：`tests/indicators-macd.test.js`（18个测试用例）

### StreamingBB - 布林带（Bollinger Bands）

布林带是波动率指标，由三条线组成：中轨（SMA）、上轨和下轨。价格通常在上下轨之间波动。

```javascript
import { StreamingBB } from 'stdlib/indicators.js';

// 创建 BB(20, 2) - 20周期，2倍标准差
const bb = new StreamingBB(20, 2);

// 流式更新
for (const row of data) {
    const result = bb.update(row.close);
    if (result !== null) {
        console.log(`Upper: ${result.upper.toFixed(2)}`);
        console.log(`Middle: ${result.middle.toFixed(2)}`);
        console.log(`Lower: ${result.lower.toFixed(2)}`);
        console.log(`Bandwidth: ${result.bandwidth.toFixed(4)}`);
        console.log(`%B: ${result.percentB.toFixed(4)}`);
    }
}

// 检查状态
console.log(bb.value);    // { upper, middle, lower, bandwidth, percentB } 或 null
console.log(bb.isReady);  // 是否有足够数据

// 重置
bb.reset();
```

**算法**：
1. `middle` = SMA(close, period=20)
2. `std` = 总体标准差（除以 n，不是 n-1）
3. `upper` = middle + stdDev × std
4. `lower` = middle - stdDev × std
5. `bandwidth` = (upper - lower) / middle
6. `%B` = (close - lower) / (upper - lower)

**返回值**：对象包含五个值
- `upper`: 上轨
- `middle`: 中轨（SMA）
- `lower`: 下轨
- `bandwidth`: 带宽（波动率指标）
- `percentB`: %B位置（0=下轨, 1=上轨, >1=超出上轨, <0=超出下轨）

**准备条件**：需要 `period` 个数据点（默认 20 条）

**完整示例**：`scripts/example-bb.js`
```bash
# 运行 BB 示例
./ndtsdb-cli scripts/example-bb.js --database ./data/btc --symbol BTCUSDT
```

**测试**：`tests/indicators-bb.test.js`（22个测试用例）

### StreamingRSI - 相对强弱指标（Relative Strength Index）

RSI 是动量振荡器，衡量价格变化速度和幅度，范围 0-100。常用于识别超买（>70）超卖（<30）区域。

```javascript
// 内联实现（QuickJS单二进制限制）
class StreamingRSI {
    constructor(period = 14) {
        this.period = period;
        this.reset();
    }
    reset() {
        this._prevClose = null;
        this._gains = [];
        this._losses = [];
        this._avgGain = null;
        this._avgLoss = null;
        this._value = null;
    }
    get value() { return this._value; }
    get isReady() { return this._avgGain !== null; }
    update(close) {
        if (this._prevClose === null) {
            this._prevClose = close;
            return this._value;
        }
        const delta = close - this._prevClose;
        this._prevClose = close;
        const gain = delta > 0 ? delta : 0;
        const loss = delta < 0 ? -delta : 0;
        
        if (this._avgGain === null) {
            this._gains.push(gain);
            this._losses.push(loss);
            if (this._gains.length === this.period) {
                this._avgGain = this._gains.reduce((a, b) => a + b, 0) / this.period;
                this._avgLoss = this._losses.reduce((a, b) => a + b, 0) / this.period;
                this._gains = [];
                this._losses = [];
                this._calculateRSI();
            }
        } else {
            // Wilder's 平滑
            this._avgGain = (this._avgGain * (this.period - 1) + gain) / this.period;
            this._avgLoss = (this._avgLoss * (this.period - 1) + loss) / this.period;
            this._calculateRSI();
        }
        return this._value;
    }
    _calculateRSI() {
        if (this._avgLoss === 0) this._value = 100;
        else { const rs = this._avgGain / this._avgLoss; this._value = 100 - (100 / (1 + rs)); }
    }
}

// 使用示例
const rsi = new StreamingRSI(14);
for (const row of data) {
    const value = rsi.update(row.close);
    if (value !== null) {
        console.log(`RSI14: ${value.toFixed(2)}`);
        if (value > 70) console.log('  超买区域');
        if (value < 30) console.log('  超卖区域');
    }
}
```

**算法（Wilder's 平滑法）**：
1. 计算价格变化：`delta = close - prevClose`
2. `gain = max(delta, 0)`, `loss = max(-delta, 0)`
3. 初始：`avgGain = SMA(gains, period)`, `avgLoss = SMA(losses, period)`
4. 后续：`avgGain = (prevAvgGain × (period-1) + gain) / period`
5. `RS = avgGain / avgLoss`
6. `RSI = 100 - 100/(1+RS)`
7. 边界：`avgLoss=0` → `RSI=100`（持续上涨）

**返回值**：0-100 之间的数值
- `> 70`: 超买区域（可能回调）
- `< 30`: 超卖区域（可能反弹）
- `= 100`: 持续上涨（无下跌）
- `= 0`: 持续下跌（无上涨）

**准备条件**：需要 `period+1` 个数据点（默认 15 条）

**示例**：`examples/rsi-example.js`
**测试**：`tests/indicators-rsi.test.js`（11个测试用例）

## JavaScript API

### REPL 模式下的JS API

在REPL模式或脚本中，可以使用以下JavaScript API：

#### `ndtsdb.open(path: string): number`

查询数据库中的K线数据，支持过滤和分页。

**语法**：
```bash
ndtsdb-cli query --database <path> [--symbols sym1,sym2] [--limit N] [--offset M]
```

**参数**：
- `--database <path>`: 数据库路径（必需）
- `--symbols <list>`: 过滤交易对（可选，逗号分隔，如 `BTCUSDT,ETHUSDT`）
- `--since <timestamp_ms>`: 开始时间戳（毫秒，可选）
- `--until <timestamp_ms>`: 结束时间戳（毫秒，可选）
- `--limit <N>`: 返回条数限制（可选，默认无限制）
- `--offset <M>`: 跳过前M条记录（可选，默认0）
- `--format <json|csv|table>`: 输出格式（可选，默认json）

**示例**：

```bash
# 基本查询：查询所有数据
ndtsdb-cli query --database /data/crypto

# 过滤交易对：只查询BTCUSDT和ETHUSDT
ndtsdb-cli query --database /data/crypto --symbols BTCUSDT,ETHUSDT

# 时间范围过滤：查询指定时间段
ndtsdb-cli query --database /data/crypto --since 1700000000000 --until 1700086400000
ndtsdb-cli query --database /data/crypto --symbols BTCUSDT --since 1700000000000

# 分页查询：第2页，每页100条
ndtsdb-cli query --database /data/crypto --limit 100 --offset 100

# 输出格式：CSV（适合导入Excel/pandas）
ndtsdb-cli query --database /data/crypto --symbols BTCUSDT --format csv
# 输出:
# timestamp,symbol,interval,open,high,low,close,volume
# 1700007200000,BTCUSDT,1h,100.2,100.7,99.7,100.2,1020

# 输出格式：表格（便于人眼阅读）
ndtsdb-cli query --database /data/crypto --limit 3 --format table
# 输出:
# timestamp      symbol   interval  open        high        low         close       volume
# ────────────────────────────────────────────────────────────────────────────────────────────────────
# 1700007200000  BTCUSDT  1h        100.2       100.7       99.7        100.2       1020

# 组合使用：查询BTCUSDT，时间范围，CSV输出
ndtsdb-cli query --database /data/crypto --symbols BTCUSDT --since 1700000000000 --until 1700086400000 --format csv
```

**输出格式**：

- `json`（默认）：每行一个JSON对象
  ```json
  {"symbol":"BTCUSDT","interval":"1h","timestamp":1700000000000,"open":42000.5,"high":42100.0,"low":41900.0,"close":42050.0,"volume":1234.56}
  ```

- `csv`：首行header，逗号分隔
  ```csv
  timestamp,symbol,interval,open,high,low,close,volume
  1700000000000,BTCUSDT,1h,42000.5,42100.0,41900.0,42050.0,1234.56
  ```

- `table`：空格对齐表格，便于人眼阅读
  ```
  timestamp      symbol   interval  open        high        low         close       volume
  ────────────────────────────────────────────────────────────────────────────────────────────────────
  1700000000000  BTCUSDT  1h        42000.5     42100.0     41900.0     42050.0     1234.56
  ```

### list - 列出交易对

列出数据库中所有交易对和周期组合。

**语法**：
```bash
ndtsdb-cli list --database <path>
```

**参数**：
- `--database <path>`: 数据库路径（必需）

**示例**：

```bash
# 列出所有交易对
ndtsdb-cli list --database /data/crypto
# 输出: [{"symbol":"BTCUSDT","interval":"1h","count":100},{"symbol":"ETHUSDT","interval":"1h","count":50}]

# 空数据库
ndtsdb-cli list --database /data/empty
# 输出: []
```

**输出格式**：JSON 数组，每项含 `symbol`/`interval`/`count` 字段

**commit**: 5afb87842（d号实现）

---

## JavaScript API

### REPL 模式下的JS API

在REPL模式或脚本中，可以使用以下JavaScript API：

#### `ndtsdb.open(path: string): number`

## 构建说明

### 依赖项

**必需**：
- gcc 或 clang
- make

**可选**：
- Zig 0.13.0+（跨平台构建）
- Podman（容器化构建）
- readline-dev（REPL 增强）

### 构建目标

```bash
# 默认构建（Linux x86-64）
make all

# 清理
make clean

# 运行测试
make test

# 使用 Zig 构建
zig build

# 使用 Zig 跨平台构建
zig build -Dtarget=x86_64-linux-musl
zig build -Dtarget=x86_64-macos
zig build -Dtarget=aarch64-linux-gnu

# 使用 Podman 容器构建
make build-zig
make build-zig ZIG_FLAGS='-Dtarget=x86_64-linux-gnu -Doptimize=ReleaseFast'
```

### 构建产物

构建完成后，产物位于：
```
zig-out/bin/ndtsdb-cli    # Zig 构建产物
./ndtsdb-cli              # Makefile 构建产物
```

## API 参考

### JavaScript API

ndtsdb-cli 提供 QuickJS 运行时，支持 ES2020 语法。

#### 数据库操作

**注意**：ndtsdb-cli 使用 C 风格 API（函数式调用），而非 OOP 风格。

```javascript
import * as ndtsdb from 'ndtsdb';

// 打开数据库，返回数字句柄
const handle = ndtsdb.open('./data/BTC.ndts');

// 插入数据（C风格API）
ndtsdb.insert(handle, 'BTC', '1h', {
  timestamp: 1700000000000n,
  open: 100.0,
  high: 101.0,
  low: 99.0,
  close: 100.5,
  volume: 1000
});

// 查询数据
const rows = ndtsdb.query(handle, 'BTC', '1h', 1700000000000n, 1700086400000n);

console.log(`查询到 ${rows.length} 条数据`);

// 关闭数据库
ndtsdb.close(handle);
```

### API 函数

#### `ndtsdb.open(path: string): number`
打开或创建数据库文件，返回数据库句柄（数字）。

**参数**：
- `path`: 数据库文件路径（如 `./data/BTC.ndts`）

**返回**：数据库句柄（number）

#### `ndtsdb.insert(handle: number, symbol: string, interval: string, row: KlineRow): number`
插入单条K线数据。

**参数**：
- `handle`: 数据库句柄（由 `ndtsdb.open()` 返回）
- `symbol`: 交易对（如 `'BTCUSDT'`）
- `interval`: K线周期（如 `'1h'`, `'5m'`, `'1d'`）
- `row`: K线数据对象

**KlineRow 结构**：
```typescript
{
  timestamp: number,  // 毫秒时间戳（BigInt 或 Number）
  open: number,       // 开盘价
  high: number,       // 最高价
  low: number,        // 最低价
  close: number,      // 收盘价
  volume: number      // 交易量
}
```

**返回**：`0` 表示成功，`-1` 表示失败

#### `ndtsdb.query(handle: number, symbol: string, interval: string, start: number, end: number, limit?: number): KlineRow[]`
查询K线数据。

**参数**：
- `handle`: 数据库句柄
- `symbol`: 交易对（可选，传`null`查询所有）
- `interval`: K线周期（可选，传`null`查询所有）
- `start`: 开始时间戳（毫秒）
- `end`: 结束时间戳（毫秒）
- `limit`: 可选，返回条数限制（默认1000）

**返回**：KlineRow 数组

**示例**：
```javascript
// 查询特定交易对
const rows = ndtsdb.query(handle, 'BTCUSDT', '1h', 1700000000000n, 1700086400000n, 100);

// 查询所有交易对（使用--symbols过滤）
const allSymbols = ndtsdb.query(handle, null, '1h', 1700000000000n, 1700086400000n);

// 分页查询（limit + offset）
const page1 = ndtsdb.query(handle, 'BTCUSDT', '1h', 1700000000000n, 1700086400000n, 100, 0);
const page2 = ndtsdb.query(handle, 'BTCUSDT', '1h', 1700000000000n, 1700086400000n, 100, 100);
```

#### `ndtsdb.list(handle: number): string[]`
列出数据库中所有交易对和周期组合。

**参数**：
- `handle`: 数据库句柄

**返回**：字符串数组，格式为 `"SYMBOL@INTERVAL"`

**示例**：
```javascript
const symbols = ndtsdb.list(handle);
// 返回: ["BTCUSDT@1h", "ETHUSDT@1h", "BTCUSDT@5m"]

// 过滤特定交易对
const btcIntervals = symbols.filter(s => s.startsWith('BTCUSDT@'));
console.log('BTCUSDT intervals:', btcIntervals);
```

**commit**: 5afb87842（d号实现）

#### `ndtsdb.close(handle: number): void`
关闭数据库。

**参数**：
- `handle`: 数据库句柄

#### 标准库

ndtsdb-cli 内置以下标准库：

- `console.log()`, `console.warn()`, `console.error()`
- `fs.readFile()`, `fs.writeFile()`（基础文件操作）

### REPL 命令

在 REPL 模式下，支持以下命令：

- `.exit` - 退出 REPL
- `.quit` - 退出 REPL
- `.help` - 显示帮助信息

## 示例

查看 `scripts/` 目录获取更多示例：

- `scripts/example-basic.js` - 基础示例（推荐新手）
- `scripts/test.js` - 完整测试套件
- `scripts/bench.js` - 性能基准测试

## 已知问题

### v0.1.0

1. **musl target 限制**
   - 当前静态库（libquickjs.a, libndts.a）针对 glibc 编译
   - musl target 构建需要重新编译静态库
   - 临时方案：使用 gnu target

2. **readline 支持**
   - gnu target 支持 readline（REPL 历史记录）
   - musl target 不支持 readline
   - Windows target 不支持 readline

3. **模块系统**
   - 当前仅支持 ES module 语法
   - CommonJS 不支持

4. **类型系统**
   - 不支持 TypeScript
   - 仅支持 JavaScript

5. **体积优化**
   - 当前二进制约 5-6MB
   - 未优化体积

## 常见问题

### Q: 如何选择安装方式？

**A**: 根据使用场景选择：

| 方式 | 适用场景 | 优点 | 缺点 |
|------|---------|------|------|
| **下载 Release** | 生产环境、快速部署 | 无需编译、即刻可用 | 灵活性低 |
| **Makefile 构建** | Linux 开发环境 | 简单快速 | 仅限 Linux x86-64 |
| **Zig 构建** | 跨平台、定制化 | 支持多平台、可优化 | 需安装 Zig |

**推荐**：
- 生产环境 → 下载 Release
- Linux 开发 → Makefile 构建
- 跨平台/优化 → Zig 构建

### Q: ndtsdb-cli 与 Bun/TS 版本有什么区别？

**A**: 两者功能完全等价，主要区别在部署和性能：

| 特性 | ndtsdb-cli (C) | Bun/TS 版本 |
|------|----------------|------------|
| **运行时** | QuickJS（嵌入式） | Bun（Node.js 兼容） |
| **依赖** | 零依赖单二进制 | 需要 Bun 运行时 |
| **启动速度** | <10ms | ~100-200ms |
| **内存占用** | ~5-10MB | ~30-50MB |
| **存储格式** | libndtsdb（单文件） | PartitionedTable（按天分区） |

> **注意**：CLI版本和Bun版本使用不同的存储格式，各自独立运行，数据文件不互通。如需迁移数据，请使用JSON导出/导入。

**推荐使用场景**：
- **ndtsdb-cli**：生产环境、边缘设备、容器化部署、资源受限环境
- **Bun/TS 版本**：开发调试、数据处理脚本、快速原型

### Q: 数据文件在哪里？

**A**: 当前版本数据存储在指定的 `.ndts` 文件中。你可以在 `ndtsdb.open(path)` 时指定路径。

### Q: 支持哪些K线周期？

**A**: 支持任意周期（1m, 5m, 1h, 1d等），由调用方在 `insert()` 和 `query()` 时通过 `interval` 参数指定。

### Q: 如何迁移现有数据？

**A**: 使用 Bun 版本的 ndtsdb 导出 JSON，然后用 ndtsdb-cli 脚本导入。

### Q: REPL 模式下无法使用上下箭头查看历史命令怎么办？

**A**: 这是因为 readline 支持未启用。解决方法：

1. **使用支持 readline 的构建**
   ```bash
   # Linux/macOS: 使用 gnu target
   zig build -Dtarget=x86_64-linux-gnu
   ```

2. **安装 readline 开发库后重新构建**
   ```bash
   # Ubuntu/Debian
   sudo apt-get install libreadline-dev

   # 重新构建
   make clean && make all
   ```

### Q: 遇到 "library not found for -lquickjs" 怎么办？

**A**: 这是因为缺少静态链接库。解决方法：

```bash
# 检查静态库是否存在
ls -lh ndtsdb-cli/lib/
# 应该看到 libquickjs.a 和 libndts.a

# 如果缺失，需要编译静态库
cd ndtsdb-cli/deps/quickjs
make
cp libquickjs.a ../../lib/
```

### Q: 如何贡献代码？

**A**: 欢迎贡献！请遵循以下流程：

1. Fork 仓库并创建功能分支
2. 编写代码并添加测试
3. 运行测试：`make test`
4. 提交 PR

详细贡献指南请查看 [CONTRIBUTING.md](../CONTRIBUTING.md)

## 开发计划

参见 [NDTSDB-CLI-ROADMAP.md](../ndtsdb/docs/NDTSDB-CLI-ROADMAP.md)

## 性能

ndtsdb-cli 提供出色的性能表现（v0.3.0 百万级数据实测）：

| 指标 | 数值 | 说明 |
|------|------|------|
| **写入吞吐量** | ~191K rows/s | `write-json` 百万级数据 |
| **全量查询** | ~510ms/1M rows | `query` 100万行 |
| **存储效率** | ~58MB/1M rows | 百万条K线数据 |
| **启动时间** | <10ms | 冷启动 |
| **二进制大小** | ~6.2MB | ReleaseFast 构建 |
| **Peak RSS** | ~11MB | 空闲状态 |

> **注意**：百万级数据下性能线性扩展，10倍数据量约10倍查询时间。

详细基准数据和平台对比请查看 **[性能基准报告](docs/benchmark.md)**。

## 性能监控

使用 CI 自动化脚本跟踪性能趋势，及时发现性能回退。

### Quick Start

```bash
# 运行基准测试并保存结果
./scripts/bench-ci.sh

# 查看性能趋势报告
./scripts/bench-report.sh
```

### CI 自动化

`bench-ci.sh` 自动执行以下操作：
1. 运行基准测试 (写入/读取吞吐量)
2. 对比历史记录，检测性能下降 (>10% 告警)
3. 追加结果到 `~/.ndtsdb-cli/bench-history.jsonl`

### 配置

```bash
# 自定义告警阈值 (默认 0.1 = 10%)
export BENCH_ALERT_THRESHOLD=0.15
./scripts/bench-ci.sh
```

### 历史数据格式

```jsonl
{"timestamp":"2026-02-21T06:06:00Z","version":"ndtsdb-cli v0.1.0","write_rows_per_sec":3333333,"read_rows_per_sec":1000000,"binary_size_mb":"5.0M"}
{"timestamp":"2026-02-21T06:06:30Z","version":"ndtsdb-cli v0.1.0","write_rows_per_sec":3100000,"read_rows_per_sec":980000,"binary_size_mb":"5.0M"}
```

### 集成到 CI/CD

```yaml
# .github/workflows/perf.yml 示例
- name: Performance Benchmark
  run: |
    cd ndtsdb-cli
    ./scripts/bench-ci.sh
    ./scripts/bench-report.sh
```

## 贡献

欢迎贡献！请查看 [贡献指南](../CONTRIBUTING.md)

## 许可证

MIT License

## 相关文档

- [FAQ 常见问题](docs/FAQ.md) - 安装、构建、使用、故障排查
- [性能基准报告](docs/benchmark.md) - 详细的性能测试数据

## 相关项目

- [ndtsdb](../ndtsdb/) - N 维时序数据库核心库
- [quant-lib](../quant-lib/) - 量化数据采集库
- [QuickJS](https://bellard.org/quickjs/) - 嵌入式 JavaScript 引擎
