# kline-cli ↔ ndtsdb-cli 集成使用指南

本文档说明如何将 `kline-cli`（K线采集）和 `ndtsdb-cli`（存储+分析）配合使用，构建完整的实时数据处理流水线。

## 目录

- [工具定位](#工具定位)
- [快速开始](#快速开始)
- [工作流示例](#工作流示例)
- [HTTP 服务器模式](#http-服务器模式)
- [常用命令参考](#常用命令参考)
- [最佳实践](#最佳实践)

---

## 工具定位

| 工具 | 定位 | 输入 | 输出 |
|------|------|------|------|
| **kline-cli** | K线数据采集 | 交易所 WebSocket/API | JSON Lines |
| **ndtsdb-cli** | 存储+查询+分析 | JSON Lines | JSON/CSV/Table |

**协作模式**：

```
交易所 API/WebSocket
        ↓
   [kline-cli] ──JSON Lines──→ [ndtsdb-cli write-json] ──→ ndtsdb 数据库
                                                            ↓
                                              [ndtsdb-cli query/serve] ──→ 分析/可视化
```

---

## 快速开始

### 1. 安装两个工具

```bash
# ndtsdb-cli
cd ndtsdb-cli && make all && sudo make install

# kline-cli
cd kline-cli && bun install && bun link
```

### 2. 采集并存储（一条命令）

```bash
# 采集 BTCUSDT 1m K线，存入 ndtsdb
kline-cli fetch --symbol BTCUSDT --interval 1m | \
  ndtsdb-cli write-json --database ./data/crypto
```

### 3. 查询并分析

```bash
# 查询最近的数据
ndtsdb-cli query --database ./data/crypto --symbols BTCUSDT --limit 10 --format table
```

---

## 工作流示例

### 示例 A: 采集 → 存储 → 计算 SMA

**完整流程**：

```bash
# Step 1: 采集历史 K 线
kline-cli fetch --symbol BTCUSDT --interval 1h --limit 100 > klines.jsonl

# Step 2: 存入 ndtsdb
cat klines.jsonl | ndtsdb-cli write-json --database ./data/crypto

# Step 3: 查询并计算 SMA
ndtsdb-cli scripts/calc-sma.js --database ./data/crypto --symbol BTCUSDT --period 20
```

**calc-sma.js**：

```javascript
// scripts/calc-sma.js
import * as ndtsdb from 'ndtsdb';
import { StreamingSMA } from 'stdlib/indicators.js';

const db = ndtsdb.open(process.env.DATABASE_PATH || './data/crypto/');
const data = ndtsdb.queryFiltered(db, [process.env.SYMBOL || 'BTCUSDT']);

const sma = new StreamingSMA(parseInt(process.env.PERIOD) || 20);

console.log(`Calculating SMA-${process.env.PERIOD || 20} for ${process.env.SYMBOL || 'BTCUSDT'}`);
console.log('Timestamp             Close     SMA');
console.log('─'.repeat(50));

for (const row of data) {
  const value = sma.update(row.close);
  if (value !== null) {
    console.log(`${row.timestamp}  ${row.close.toFixed(2).padStart(8)}  ${value.toFixed(2).padStart(8)}`);
  }
}

ndtsdb.close(db);
```

---

### 示例 B: 实时采集 → 实时推送

**架构**：

```
[Binance WebSocket] → [kline-cli subscribe] → [ndtsdb-cli serve /write-json]
                                                    ↓
                                            [WebSocket 客户端]
```

**启动服务**：

```bash
# Terminal 1: 启动 ndtsdb HTTP 服务器
ndtsdb-cli serve --database ./data/crypto --port 8080

# Terminal 2: 启动实时采集（推送到 HTTP）
kline-cli subscribe --symbol BTCUSDT --interval 1m | \
  while read line; do
    curl -s -X POST http://localhost:8080/write-json \
      -H "Content-Type: application/json" \
      -d "$line"
  done

# Terminal 3: WebSocket 客户端订阅
websocat "ws://localhost:8080/subscribe?symbol=BTCUSDT&interval=1m"
```

---

### 示例 C: 批量采集多币种

```bash
# 批量采集多个交易对
for symbol in BTCUSDT ETHUSDT SOLUSDT; do
  echo "Fetching $symbol..."
  kline-cli fetch --symbol $symbol --interval 1h --limit 500 | \
    ndtsdb-cli write-json --database ./data/crypto
done

# 查询所有币种
ndtsdb-cli list --database ./data/crypto

# 查询特定币种
ndtsdb-cli query --database ./data/crypto --symbols BTCUSDT,ETHUSDT --limit 10
```

---

## HTTP 服务器模式

### 架构图

```
                    ┌─────────────────────┐
                    │   外部消费者         │
                    │  (Python/JS/Excel)  │
                    └──────────┬──────────┘
                               │ HTTP/WebSocket
                    ┌──────────▼──────────┐
                    │  ndtsdb-cli serve   │
                    │    (port 8080)      │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
     ┌────────▼──────┐ ┌──────▼──────┐ ┌───────▼───────┐
     │   kline-cli   │ │  手动导入   │ │   其他数据源  │
     │  (实时采集)   │ │  (CSV/JSON) │ │   (API 调用)  │
     └───────────────┘ └─────────────┘ └───────────────┘
```

### 启动服务器

```bash
# 启动 HTTP + WebSocket 服务器
ndtsdb-cli serve --database ./data/crypto --port 8080

# 后台运行
nohup ndtsdb-cli serve --database ./data/crypto --port 8080 > server.log 2>&1 &
```

### API 端点

| 端点 | 方法 | 说明 | 示例 |
|------|------|------|------|
| `/health` | GET | 健康检查 | `curl http://localhost:8080/health` |
| `/symbols` | GET | 列出所有币种 | `curl http://localhost:8080/symbols` |
| `/query` | GET | 查询数据 | `curl "http://localhost:8080/query?symbol=BTCUSDT&limit=10"` |
| `/write-json` | POST | 写入数据 | `curl -X POST -d '{"..."}' http://localhost:8080/write-json` |
| `/subscribe` | WS | 实时订阅 | `websocat "ws://localhost:8080/subscribe?symbol=BTCUSDT"` |

### 外部消费示例

**Python**：

```python
import requests
import json

# 查询数据
resp = requests.get('http://localhost:8080/query', params={
    'symbol': 'BTCUSDT',
    'limit': 100
})

for line in resp.text.strip().split('\n'):
    data = json.loads(line)
    print(f"Time: {data['timestamp']}, Close: {data['close']}")

# 写入数据
resp = requests.post('http://localhost:8080/write-json', json={
    'symbol': 'BTCUSDT',
    'interval': '1m',
    'timestamp': 1700000000000,
    'open': 30000, 'high': 30100, 'low': 29900, 'close': 30050, 'volume': 100
})
print(resp.json())  # {"inserted": 1, "errors": 0}
```

**JavaScript**：

```javascript
// 查询数据
const resp = await fetch('http://localhost:8080/query?symbol=BTCUSDT&limit=100');
const text = await resp.text();
const rows = text.trim().split('\n').map(JSON.parse);

// WebSocket 实时订阅
const ws = new WebSocket('ws://localhost:8080/subscribe?symbol=BTCUSDT&interval=1m');
ws.onmessage = (e) => console.log(JSON.parse(e.data));
```

---

## 常用命令参考

### 数据采集

```bash
# 采集单币种（JSON Lines 输出）
kline-cli fetch --symbol BTCUSDT --interval 1m --limit 500

# 采集并存入 ndtsdb（pipe 模式）
kline-cli fetch --symbol BTCUSDT --interval 1m | \
  ndtsdb-cli write-json --database ./data/crypto

# 实时订阅
kline-cli subscribe --symbol BTCUSDT --interval 1m
```

### 数据存储

```bash
# 从 JSON Lines 写入
cat data.jsonl | ndtsdb-cli write-json --database ./data/crypto

# 从 CSV 写入
cat data.csv | ndtsdb-cli write-csv --database ./data/crypto

# 通过 HTTP 写入
curl -X POST http://localhost:8080/write-json \
  -H "Content-Type: application/json" \
  -d '{"symbol":"BTCUSDT","interval":"1m",...}'
```

### 数据查询

```bash
# 基本查询
ndtsdb-cli query --database ./data/crypto --symbols BTCUSDT --limit 100

# 时间范围
ndtsdb-cli query --database ./data/crypto --symbols BTCUSDT \
  --since 1700000000000 --until 1700086400000

# 分页
ndtsdb-cli query --database ./data/crypto --limit 100 --offset 200

# 格式选择
ndtsdb-cli query --database ./data/crypto --format csv > export.csv
ndtsdb-cli query --database ./data/crypto --format table

# SQL 查询
ndtsdb-cli sql --database ./data/crypto --query "SELECT * FROM data WHERE symbol='BTCUSDT' LIMIT 100"
```

### 服务器

```bash
# 启动 HTTP 服务器
ndtsdb-cli serve --database ./data/crypto --port 8080

# 后台运行
nohup ndtsdb-cli serve --database ./data/crypto --port 8080 &

# 健康检查
curl http://localhost:8080/health
```

---

## 最佳实践

### 1. 数据目录结构

```
data/
├── crypto/
│   ├── btc/          # BTC 相关数据
│   ├── eth/          # ETH 相关数据
│   └── all/          # 全部数据（多币种）
└── stocks/
    └── us/
```

### 2. 命名约定

```bash
# 数据库路径包含交易所和周期
./data/crypto/binance-1m/
./data/crypto/binance-1h/
./data/crypto/okx-1m/
```

### 3. 定时采集

```bash
# crontab 示例：每小时采集一次
0 * * * * kline-cli fetch --symbol BTCUSDT --interval 1h --limit 100 | ndtsdb-cli write-json --database /data/crypto
```

### 4. 备份策略

```bash
# 每日备份
0 2 * * * tar czf /backup/crypto-$(date +\%Y\%m\%d).tar.gz /data/crypto/
```

### 5. 性能优化

- **批量写入**：一次写入多条，减少进程启动开销
- **使用 symbols 过滤**：5 倍性能提升
- **限制查询范围**：使用 `--since`/`--until` 和 `--limit`

---

## 故障排查

### kline-cli 输出为空

```bash
# 检查网络连接
curl -I https://api.binance.com

# 检查 symbol 格式（需要大写）
kline-cli fetch --symbol btcusdt  # ❌
kline-cli fetch --symbol BTCUSDT  # ✅
```

### ndtsdb-cli 写入失败

```bash
# 检查 JSON 格式
cat data.jsonl | head -3

# 手动测试
echo '{"symbol":"TEST","interval":"1m","timestamp":1700000000000,"open":1,"high":2,"low":0,"close":1.5,"volume":100}' | \
  ndtsdb-cli write-json --database ./data/test
```

### HTTP 服务器无响应

```bash
# 检查端口
lsof -i :8080

# 检查进程
ps aux | grep ndtsdb-cli

# 查看日志
tail -f server.log
```

---

## 相关文档

- [kline-cli README](../../kline-cli/README.md)
- [ndtsdb-cli README](../README.md)
- [ndtsdb-cli FAQ](FAQ.md)
- [ndtsdb-cli 故障排查](troubleshooting.md)

---

**最后更新**：2026-02-22  
**版本**：v0.2.0
