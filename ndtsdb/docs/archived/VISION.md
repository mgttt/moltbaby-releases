# ndtsdb 产品愿景 (Vision)

**目标**: 超越 DuckDB/ClickHouse，成为时序智能引擎的标杆  
**核心定位**: 金融级实时决策基础设施  
**版本**: v1.0-vision (2026-02-18)

---

## 1. 野心宣言

### 1.1 为什么不是另一个 DuckDB/ClickHouse

| 维度 | DuckDB | ClickHouse | **ndtsdb 野心** |
|------|--------|------------|-----------------|
| **核心定位** | 嵌入式 OLAP | 分布式 OLAP | **时序智能引擎 (TSI Engine)** |
| **主攻场景** | 通用分析 | 海量日志/BI | **金融实时决策 + AI 驱动** |
| **时序原生** | ⚠️ 附加功能 | ❌ 非原生 | ✅ **金融语义内置 (OHLCV/Tick/撮合)** |
| **实时计算** | ❌ 外部处理 | ❌ 外部处理 | ✅ **StreamingIndicators 内置** |
| **AI 集成** | ❌ 无 | ❌ 无 | ✅ **向量化存储 + 推理引擎接口** |
| **部署形态** | ✅ 可嵌入 | ❌ 服务器集群 | ✅ **单文件 → 分布式无缝扩展** |
| **启动速度** | ~100ms | ~秒级 | ✅ **毫秒级冷启动** |

### 1.2 终极目标

> **"从云到端，一套引擎"**

- **云端**: 分布式集群，PB 级时序数据，实时 AI 推理
- **边缘**: 单文件嵌入式，毫秒启动，离线自治
- **终端**: 浏览器/WebAssembly，客户端计算

---

## 2. 技术差异化护城河

### 2.1 金融语义原生 (Financial-Native)

不是用通用 SQL 模拟金融场景，而是**金融场景内置**:

```sql
-- 标准 SQL: 通用但繁琐
SELECT 
  symbol,
  time_bucket('1h', timestamp) as hour,
  first(open),
  max(high),
  min(low),
  last(close),
  sum(volume)
FROM ticks
GROUP BY symbol, hour;

-- ndtsdb 扩展 SQL: 金融语义原生
SELECT OHLCV(symbol, '1h') FROM ticks;

-- 内置金融函数
SELECT LATEST_ON(symbol, timestamp) FROM order_book;  -- 最新快照
SELECT ASOF JOIN(price, signal) ON timestamp;          -- 撮合对齐
SELECT REPLAY(symbol, 'tick', '2024-01-01', '2024-01-02'); -- 逐笔回放
```

**内置金融类型**:
- `Tick`: (timestamp, price, volume, side)
- `OHLCV`: (open, high, low, close, volume)
- `OrderBook`: (bids[], asks[], timestamp)
- `Trade`: (timestamp, price, qty, buyer, seller)

### 2.2 实时流智能 (Real-Time Intelligence)

存储即计算，不只是存数据:

```sql
-- 实时指标流（增量计算，不重新扫描历史）
CREATE STREAM btc_indicators AS
SELECT 
  timestamp,
  close,
  SMA(close, 14) as sma14,           -- 流式增量计算
  EMA(close, 12) as ema12,
  RSI(close, 14) as rsi14,
  MACD(close, 12, 26, 9) as macd,
  BOLLINGER(close, 20, 2) as bb
FROM btc_ticks
EMIT WITH DELAY '1s';               -- 1秒延迟触发

-- AI 推理接口（预留）
CREATE MODEL predictor AS ...;       -- 加载 ONNX/ggml 模型
SELECT PREDICT(predictor, features) FROM realtime_stream;
```

**流式指标引擎** (StreamingIndicators):
- SMA/EMA/RSI/MACD/BB: O(1) 增量更新
- 多品种并行: 3000+ symbols @ 8.9M ticks/sec
- 零内存拷贝: mmap + SIMD 加速

### 2.3 边缘自治 (Edge Autonomy)

**单文件部署**:
```bash
# 云端
ndtsdb-server --cluster --nodes 10 --shards 100

# 边缘（单文件 ~5MB）
./ndtsdb-cli --data ./local.ndts --query "SELECT * FROM ticks"

# 终端（WebAssembly）
const db = await Ndtsdb.load('./data.ndts');  // 浏览器内运行
```

**统一架构**:
- 单机 → 分布式: 数据分片算法一致
- 在线 → 离线: 同一套查询语法
- 云端 → 边缘: 文件格式 100% 兼容

---

## 3. SQL 策略: 通用 + 扩展

### 3.1 原则

**通用 SQL 兼容** (为了客户体验):
- ✅ 标准 SQL: SELECT/FROM/WHERE/JOIN/GROUP BY/ORDER BY
- ✅ 窗口函数: ROW_NUMBER/RANK/LEAD/LAG
- ✅ 聚合函数: SUM/AVG/MIN/MAX/COUNT
- ✅ 子查询、CTE、UNION

**扩展 SQL 增强** (为了差异化):
- 🚀 时序函数: `time_bucket()`, `SAMPLE BY`, `LATEST ON`
- 🚀 金融函数: `OHLCV()`, `ASOF JOIN`, `REPLAY()`
- 🚀 流式语法: `CREATE STREAM`, `EMIT WITH DELAY`
- 🚀 AI 接口: `CREATE MODEL`, `PREDICT()`

### 3.2 设计哲学

```sql
-- 客户可以用标准 SQL（零学习成本）
SELECT * FROM ticks WHERE symbol = 'BTC' AND timestamp > now() - INTERVAL '1 day';

-- 进阶后用扩展 SQL（性能/功能提升）
SELECT OHLCV(symbol, '1h') FROM ticks 
WHERE timestamp > now() - INTERVAL '1 day'
SAMPLE BY '1h';  -- 自动聚合，比 GROUP BY 快 10x
```

**平滑升级路径**:
1. **Day 1**: 用标准 SQL，数据迁移零成本
2. **Day 2**: 用扩展 SQL，性能提升 10x
3. **Day 3**: 用流式 SQL，实时智能决策

---

## 4. 分布式架构

### 4.1 设计目标

不是「先单机后分布式」的补丁，而是**分布式原生**:

```
┌─────────────────────────────────────────────────────────────┐
│                     分布式协调层 (Coordinator)               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Node 1   │  │ Node 2   │  │ Node 3   │  │ Node N   │   │
│  │ (Shard)  │  │ (Shard)  │  │ (Shard)  │  │ (Shard)  │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       └──────────────┴──────────────┴──────────────┘       │
│                         │                                  │
│                    统一查询层                               │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 分布式特性

| 特性 | 单机版 | 分布式版 | 实现方式 |
|------|--------|----------|----------|
| **数据分片** | 哈希/时间分区 | 一致性哈希 | 同构分片算法 |
| **查询路由** | 本地执行 | 分布式执行计划 | Coordinator 优化 |
| **流式聚合** | 本地滑动窗口 | 分布式窗口 | 水位线对齐 |
| **AI 推理** | 本地模型 | 分布式模型服务 | 模型分片 + 聚合 |
| **边缘同步** | 文件复制 | 增量同步 | Raft/WAL |

**分布式 SQL 示例**:
```sql
-- 自动路由到对应分片
SELECT * FROM ticks WHERE symbol = 'BTC';  -- 单分片查询

-- 跨分片聚合（Coordinator 自动处理）
SELECT symbol, OHLCV(symbol, '1h') 
FROM ticks 
WHERE timestamp > now() - INTERVAL '1 day'
GROUP BY symbol;  -- 跨 100 个分片并行执行
```

### 4.3 云边端一体

```
云端 (Cloud)              边缘 (Edge)              终端 (Device)
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│ 分布式集群    │◄───────►│ 边缘节点      │◄───────►│ 嵌入式设备    │
│  • PB 级存储  │  同步   │  • 本地缓存   │  下发   │  • 离线推理   │
│  • 实时训练   │         │  • 实时决策   │         │  • 秒级启动   │
│  • 全局模型   │         │  • 边缘模型   │         │  • 模型量化   │
└──────────────┘         └──────────────┘         └──────────────┘
      │                        │                        │
      └────────────────────────┴────────────────────────┘
                         统一 SQL 语法
                      统一文件格式 (.ndts)
                    统一 API (TypeScript/JS/C)
```

---

## 5. 发展路线图

### Phase 1: 单机卓越 (当前 → 2026-Q2)
- ✅ 列式存储 + 压缩
- ✅ SQL 引擎 + 窗口函数
- ✅ 流式指标 (SMA/EMA/RSI/MACD/BB)
- ✅ mmap + Zero-Copy 回放
- 🔄 金融语义 SQL 扩展
- 🔄 真实场景验证 (高并发/压缩率/稳定性)

### Phase 2: 边缘就绪 (2026-Q3)
- ndtsdb-cli (QuickJS + libndtsdb 静态链接)
- WebAssembly 支持 (浏览器运行)
- 边缘-云同步协议
- 嵌入式 AI 推理接口 (ONNX Runtime)

### Phase 3: 分布式 (2026-Q4)
- 分布式协调器
- 自动分片 + 负载均衡
- 分布式流式聚合
- 多租户隔离

### Phase 4: 智能引擎 (2027)
- 内置 AI 训练 (联邦学习)
- 向量化执行引擎
- GPU 加速 (CUDA/Metal)
- 自优化查询引擎 (AI-based optimizer)

---

## 6. 总结

**ndtsdb 不是又一个数据库，而是时序智能的基础设施**:

1. **金融语义原生**: 懂 OHLCV，不只是存浮点数
2. **实时流智能**: 存储即计算，指标内置
3. **边缘自治**: 单文件毫秒启动，云边端统一
4. **SQL 双轨**: 通用 SQL 零成本迁移，扩展 SQL 10x 性能
5. **分布式原生**: 不是补丁，是架构设计

> **"从存储到决策，一套引擎。"**

---

**参考**:
- DuckDB: https://duckdb.org/
- ClickHouse: https://clickhouse.com/
- InfluxDB IOx: https://www.influxdata.com/
- QuestDB: https://questdb.io/
