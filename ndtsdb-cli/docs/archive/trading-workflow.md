# ndtsdb-cli 实盘分析工作流

> v0.3.6+ | 面向9号（实盘操盘手）的使用指南

---

## 1. 数据接入

### 从 Binance 拉取 K 线

```bash
# 首次全量拉取（近 1000 根 1m K 线）
bun tools/ingest-binance.ts \
  --symbol BTCUSDT \
  --interval 1m \
  --database ./data/btc \
  --proxy http://127.0.0.1:8890   # 阿里云需代理

# 持续增量更新（每 60 秒拉一次）
bun tools/ingest-binance.ts \
  --symbol BTCUSDT \
  --interval 1m \
  --database ./data/btc \
  --proxy http://127.0.0.1:8890 \
  --watch 60
```

### 验证数据

```bash
# 查看数据库元信息
./zig-out/bin/ndtsdb-cli info --database ./data/btc

# 查看最近 5 行
./zig-out/bin/ndtsdb-cli tail --database ./data/btc --symbol BTCUSDT --interval 1m --n 5
```

---

## 2. 快速指标计算

```bash
# SMA 20
./zig-out/bin/ndtsdb-cli sma --database ./data/btc \
  --symbol BTCUSDT --interval 1m --period 20

# EMA 12
./zig-out/bin/ndtsdb-cli ema --database ./data/btc \
  --symbol BTCUSDT --interval 1m --period 12

# ATR 14（波动率）
./zig-out/bin/ndtsdb-cli atr --database ./data/btc \
  --symbol BTCUSDT --interval 1m --period 14

# 输出 CSV
./zig-out/bin/ndtsdb-cli sma --database ./data/btc \
  --symbol BTCUSDT --interval 1m --period 20 --format csv
```

---

## 3. SQL 分析

```bash
DB=./data/btc
CLI=./zig-out/bin/ndtsdb-cli

# 最新10根K线
$CLI sql --database $DB --query \
  "SELECT timestamp, close, volume FROM data WHERE symbol='BTCUSDT' ORDER BY timestamp DESC LIMIT 10"

# 按小时分组统计
$CLI sql --database $DB --query \
  "SELECT strftime(timestamp,'%Y-%m-%d %H') AS hour, 
          FIRST(close) AS open, 
          MAX(close) AS high, 
          MIN(close) AS low, 
          LAST(close) AS close, 
          SUM(volume) AS volume 
   FROM data WHERE symbol='BTCUSDT' 
   GROUP BY hour 
   ORDER BY hour DESC LIMIT 24"

# 计算每小时波动率
$CLI sql --database $DB --query \
  "SELECT strftime(timestamp,'%Y-%m-%d %H') AS hour,
          STDDEV(close) AS volatility
   FROM data WHERE symbol='BTCUSDT'
   GROUP BY hour
   ORDER BY volatility DESC
   LIMIT 10"

# 价格区间分布
$CLI sql --database $DB --query \
  "SELECT MIN(close) AS low, 
          PERCENTILE(close,25) AS p25,
          PERCENTILE(close,50) AS median,
          PERCENTILE(close,75) AS p75,
          MAX(close) AS high
   FROM data WHERE symbol='BTCUSDT'"
```

---

## 4. JS 策略脚本（推荐方式）

```javascript
// examples/live-scanner.js
const db = ndtsdb.open(__database);
const rows = ndtsdb.queryFiltered(db, ['BTCUSDT']);
ndtsdb.close(db);

// 计算指标
const sma20 = ndtsdb.sma(rows, 20);
const ema12 = ndtsdb.ema(rows, 12);
const ema26 = ndtsdb.ema(rows, 26);
const bb = ndtsdb.bollinger(rows, 20, 2);
const rsi = ndtsdb.rsi(rows, 14);
const macd = ndtsdb.macd(rows, 12, 26, 9);

// 获取最新信号
const last = rows[rows.length - 1];
const lastRsi = rsi[rsi.length - 1];
const lastBb = bb[bb.length - 1];
const lastMacd = macd[macd.length - 1];

const signal = {
  timestamp: new Date(last.timestamp).toISOString(),
  close: last.close,
  rsi: lastRsi?.value?.toFixed(2),
  bb_upper: lastBb?.upper?.toFixed(2),
  bb_lower: lastBb?.lower?.toFixed(2),
  macd: lastMacd?.macd?.toFixed(4),
  macd_signal: lastMacd?.signal?.toFixed(4),
  macd_hist: lastMacd?.hist?.toFixed(4),
};

// 信号判断
if (lastRsi?.value < 30 && last.close < lastBb?.lower) {
  signal.alert = 'OVERSOLD';
} else if (lastRsi?.value > 70 && last.close > lastBb?.upper) {
  signal.alert = 'OVERBOUGHT';
} else {
  signal.alert = 'NEUTRAL';
}

console.log(JSON.stringify(signal));
```

### 运行方式

```bash
# 单次运行
./zig-out/bin/ndtsdb-cli script examples/live-scanner.js --database ./data/btc

# 每60秒自动重跑（实盘监控）
./zig-out/bin/ndtsdb-cli script examples/live-scanner.js \
  --database ./data/btc \
  --repeat 60
```

---

## 5. 多品种扫描

```bash
# 写入多个品种
for SYM in BTCUSDT ETHUSDT SOLUSDT; do
  bun tools/ingest-binance.ts \
    --symbol $SYM \
    --interval 15m \
    --database ./data/multi \
    --proxy http://127.0.0.1:8890
done

# SQL 跨品种对比
./zig-out/bin/ndtsdb-cli sql --database ./data/multi --query \
  "SELECT symbol, LAST(close) AS price, STDDEV(close) AS vol_std
   FROM data
   GROUP BY symbol
   ORDER BY vol_std DESC"
```

---

## 6. 数据管理

```bash
# 导出备份
./zig-out/bin/ndtsdb-cli export --database ./data/btc --output btc_backup.jsonl

# 导出 CSV 用于 Excel
./zig-out/bin/ndtsdb-cli export --database ./data/btc \
  --symbol BTCUSDT --interval 1m \
  --format csv --output btc_1m.csv

# 合并数据库
./zig-out/bin/ndtsdb-cli merge --from ./data/btc_old --to ./data/btc_new

# 统计各品种数据量
./zig-out/bin/ndtsdb-cli count --database ./data/multi
```

---

## 7. 常用子命令速查

| 命令 | 功能 | 关键参数 |
|------|------|---------|
| `write-json` | 写入 JSONL 数据 | `--database` |
| `query` | 查询原始行 | `--symbol --interval --since --until` |
| `sql` | SQL 分析 | `--query "SELECT..."` |
| `tail/head` | 末尾/开头 N 行 | `--n 10` |
| `info` | 数据元信息 | `--symbol` |
| `count` | 行数统计 | `--symbol --interval` |
| `sma/ema/atr` | 纯C指标 | `--period --format csv` |
| `script` | JS 策略脚本 | `--repeat N` |
| `export` | 导出 JSONL/CSV | `--format csv --output` |
| `merge` | 跨DB合并 | `--from --to` |

---

## 8. 已验证的 SQL 聚合函数

```sql
SELECT
  COUNT(*),          -- 行数
  SUM(volume),       -- 总量
  AVG(close),        -- 均值
  MIN(low),          -- 最低
  MAX(high),         -- 最高
  FIRST(close),      -- 第一个 close
  LAST(close),       -- 最后一个 close
  STDDEV(close),     -- 标准差
  VARIANCE(close),   -- 方差
  PERCENTILE(close, 50)  -- 中位数
FROM data WHERE symbol='BTCUSDT'
```

---

*更多示例见 `examples/` 目录。*
