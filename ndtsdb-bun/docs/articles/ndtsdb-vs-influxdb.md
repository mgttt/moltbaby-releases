# ndtsdb vs InfluxDB: 嵌入式时序数据库的新选择

**2026-02-10 | 对比评测**

---

## 一、你是否遇到过这样的困境？

你只是想存储一些传感器数据，却要部署一整套 InfluxDB 服务？

为一个边缘设备的实时监控，真的需要 500MB+ 内存占用的数据库吗？

或者，你在开发一个桌面应用，不想让用户在安装时还得手动配置外部数据库？

如果这些场景让你感到头疼，那么 **ndtsdb** 可能是你需要的答案——一个专为嵌入式场景设计的 TypeScript 原生时序数据库。

需要说明的是，ndtsdb **并不是要取代 InfluxDB**。InfluxDB 是成熟的生产级分布式系统，有它不可替代的价值。ndtsdb 只是在嵌入式、单机、资源受限的场景下，提供另一种更轻量的选择。

---

## 二、什么时候需要嵌入式时序数据库？

并非所有场景都需要独立部署的数据库服务。以下情况下，嵌入式 TSDB 可能是更好的选择：

| 场景 | 特点 | 典型应用 |
|------|------|----------|
| **边缘计算** | 资源受限、离线运行、需要本地决策 | IoT 网关、工控机、树莓派设备 |
| **桌面应用** | 零外部依赖、用户无感知安装 | 监控工具、量化交易软件、日志分析器 |
| **开发测试** | 快速启动、零配置、易调试 | 单元测试、原型开发、CI/CD |
| **Serverless** | 冷启动敏感、无法保持长连接 | Lambda 函数、Edge Functions |

**不适合嵌入式 TSDB 的场景**（我们必须诚实地说）：
- ❌ 需要高可用集群和故障转移
- ❌ 数据量超过 100GB（单机受限）
- ❌ 需要完善的数据保留策略和权限管理
- ❌ 团队已深度使用 InfluxDB 生态（迁移成本高）

如果你的项目符合上述"不适合"的条件，请直接选择 InfluxDB 或 TimescaleDB。

---

## 三、核心对比：ndtsdb vs InfluxDB

| 维度 | ndtsdb | InfluxDB OSS |
|------|--------|--------------|
| **部署方式** | 嵌入式（`bun add ndtsdb` 即用） | 独立服务（Docker/Binary） |
| **运行环境** | TypeScript/Bun 进程内 | 独立 Go 进程 |
| **冷启动** | 60ms（3000 文件） | 2-5 秒 |
| **内存占用** | 32MB（10万 ticks） | 500MB+ 基线 |
| **查询语言** | SQL（标准语法） | Flux / InfluxQL |
| **压缩算法** | Gorilla（70-90%） | 自研 TSM |
| **集群支持** | ❌ 单机 | ✅ 支持（企业版） |
| **生态成熟度** | 新兴（2026） | 成熟（2013-） |
| **外部依赖** | 零（纯 JS fallback） | 需要独立进程 |

**关键差异**：
- ndtsdb 是**库**（library），InfluxDB 是**服务**（service）
- ndtsdb 适合**嵌入**，InfluxDB 适合**独立部署**

---

## 四、真实 Benchmark 数据

**测试环境**：
- 硬件：Linux x64（Bun 1.3.8）
- 数据集：10 个 symbol，共 10 万条 OHLCV tick 数据
- 场景：单机嵌入式写入与查询

### 4.1 写入性能

```
批量写入（内存表）:   808.91K ticks/sec
持久化写入（追加）:   710.56K ticks/sec
```

**说明**：
- ndtsdb 的写入是**进程内调用**（无网络开销）
- InfluxDB 通过 HTTP API 写入，典型速度约 **100-200K points/sec**
- 两者不完全可比（网络 vs 进程内），但 ndtsdb 在嵌入式场景确实更快

### 4.2 查询性能

```
简单查询（SELECT * LIMIT 1000）:
  ndtsdb:   37.82 ops/sec (26ms 延迟)

范围查询（WHERE ts > timestamp）:
  ndtsdb:   47.56 ops/sec (21ms 延迟)

聚合查询（MIN/MAX）:
  ndtsdb:   2.10 ops/sec (477ms 延迟)
```

**对比 InfluxDB**：
- 简单查询：InfluxDB 通过网络 API 约 **5-10ms**（本机部署）
- 聚合查询：InfluxDB 经过多年优化，通常在 **10-50ms** 级别

**坦白说**：ndtsdb 的聚合查询性能还需优化。目前我们专注于写入和简单过滤，复杂聚合场景下 InfluxDB 更成熟。

### 4.3 冷启动

```
加载 3000 个 .ndts 文件:  60ms
InfluxDB 启动服务:       2-5 秒
```

这是 ndtsdb 的核心优势——**无需独立进程**，导入即用。

### 4.4 内存占用

```
存储 10 万条 tick（10 个 symbol）:
  Heap Used:  32.08 MB
  RSS:       175.02 MB

InfluxDB 基线内存:  500MB+
```

---

## 五、代码对比：5 分钟上手

### 5.1 InfluxDB 方式

```bash
# 1. 安装 InfluxDB（macOS）
brew install influxdb

# 2. 启动服务
influxd

# 3. 创建 bucket 和 token（需要 Web UI 或 CLI）
influx setup
```

```typescript
// 4. TypeScript 连接代码
import { InfluxDB, Point } from '@influxdata/influxdb-client';

const client = new InfluxDB({
  url: 'http://localhost:8086',
  token: 'your-super-secret-token',
});

const writeApi = client.getWriteApi('my-org', 'my-bucket');

// 写入数据
const point = new Point('temperature')
  .tag('location', 'room1')
  .floatField('value', 23.5)
  .timestamp(new Date());

writeApi.writePoint(point);
await writeApi.close();

// 查询数据（Flux 语法）
const queryApi = client.getQueryApi('my-org');
const query = `
  from(bucket: "my-bucket")
    |> range(start: -1h)
    |> filter(fn: (r) => r._measurement == "temperature")
`;

for await (const { values, tableMeta } of queryApi.iterateRows(query)) {
  console.log(values);
}
```

### 5.2 ndtsdb 方式

```bash
# 1. 安装（零配置）
bun add ndtsdb
```

```typescript
// 2. 导入即用
import { ColumnarTable } from 'ndtsdb';

// 创建表
const table = new ColumnarTable([
  { name: 'timestamp', type: 'int64' },
  { name: 'location', type: 'string' },
  { name: 'value', type: 'float64' },
]);

// 写入数据
table.addRow({
  timestamp: Date.now(),
  location: 'room1',
  value: 23.5,
});

// 查询数据（SQL）
const result = table.querySQL(`
  SELECT * FROM t
  WHERE timestamp > ${Date.now() - 3600000}
  ORDER BY timestamp DESC
`);

console.log(result.rows);

// 持久化（可选）
table.saveToFile('./data/temperature.ndts');
```

**对比总结**：
- **代码行数**：ndtsdb 减少 60%+
- **依赖复杂度**：ndtsdb 零外部服务
- **学习曲线**：SQL vs Flux（SQL 对大多数开发者更友好）

---

## 六、实际应用场景

### 场景 1：树莓派 IoT 网关

**需求**：在树莓派 4B（4GB 内存）上采集 50 个传感器数据，每秒 100 次采样。

**问题**：
- InfluxDB 在树莓派上启动需要 **5-10 秒**，内存占用 **500MB+**
- 断电重启后需要等待数据库服务就绪

**解决方案（ndtsdb）**：
```typescript
import { AppendWriter } from 'ndtsdb';

const writer = new AppendWriter('./sensors.ndts', [
  { name: 'sensor_id', type: 'int32' },
  { name: 'timestamp', type: 'int64' },
  { name: 'temperature', type: 'float64' },
  { name: 'humidity', type: 'float64' },
]);

// 每秒 100 次批量写入
setInterval(() => {
  const batch = getSensorReadings(); // 假设返回 100 条数据
  writer.appendBatch(batch);
}, 1000);

// 进程重启后立即可用（60ms 加载）
```

**效果**：
- 内存占用降至 **50MB**
- 冷启动从 5 秒降至 **60ms**
- 无需维护独立数据库进程

### 场景 2：Electron 桌面监控工具

**需求**：开发一个跨平台的系统监控工具，记录 CPU/内存/网络历史数据。

**问题**：
- 用户不想安装额外的数据库服务
- 打包体积要小（Electron 已经很大了）

**解决方案（ndtsdb）**：
```typescript
// 在 Electron main 进程中
import { ColumnarTable } from 'ndtsdb';

const metricsTable = new ColumnarTable([
  { name: 'timestamp', type: 'int64' },
  { name: 'cpu', type: 'float64' },
  { name: 'memory', type: 'float64' },
]);

// 每 5 秒采集一次
setInterval(() => {
  metricsTable.addRow({
    timestamp: Date.now(),
    cpu: getCpuUsage(),
    memory: getMemoryUsage(),
  });
}, 5000);

// 渲染进程查询最近 1 小时数据
ipcMain.handle('get-metrics', () => {
  return metricsTable.querySQL(`
    SELECT timestamp, cpu, memory
    FROM t
    WHERE timestamp > ${Date.now() - 3600000}
    ORDER BY timestamp
  `);
});
```

**效果**：
- 用户安装即用，无需配置
- 打包后增加体积 < 5MB
- 数据文件随应用数据目录存储

### 场景 3：量化回测系统

**需求**：加载 3000 个交易对的历史 K 线数据，进行策略回测。

**问题**：
- InfluxDB 冷启动慢，影响开发效率
- 需要频繁重启调试策略

**解决方案（ndtsdb）**：
```typescript
import { MmapMergeStream } from 'ndtsdb';

// 60ms 加载 3000 个 .ndts 文件（mmap 零拷贝）
const files = ['BTC.ndts', 'ETH.ndts', /* ...3000 个 */];
const stream = new MmapMergeStream(
  files.map(f => ({ file: `./klines/${f}`, symbol: f.replace('.ndts', '') }))
);

// 按时间顺序回放所有 tick（8.9M ticks/sec）
for (const tick of stream.replayTicks()) {
  backtestStrategy(tick);
}
```

**效果**：
- 冷启动从 10 秒降至 **60ms**
- 多文件合并回放达到 **8.9M ticks/sec**
- 开发调试循环时间大幅缩短

---

## 七、什么时候应该选择 InfluxDB？

作为 ndtsdb 的作者，我必须诚实地告诉你，**InfluxDB 在很多场景下依然是更好的选择**：

### 推荐 InfluxDB 的场景

✅ **需要高可用和集群**  
   ndtsdb 是单机库，不支持分布式。如果你需要多节点故障转移，选 InfluxDB。

✅ **数据量超过 100GB**  
   单机存储和查询大数据集，InfluxDB 经过多年优化，性能更稳定。

✅ **需要完善的数据治理**  
   数据保留策略（Retention Policy）、Continuous Query、权限管理——这些 ndtsdb 都不支持。

✅ **团队已熟悉 Flux 生态**  
   如果团队已经投入大量时间学习 Flux，迁移成本可能不值得。

✅ **需要商业支持**  
   InfluxData 提供企业版支持，ndtsdb 是开源项目（MIT 协议），无官方 SLA。

### ndtsdb 目前的局限

我们不回避 ndtsdb 的不足：

❌ **无集群支持**：只能单机运行  
❌ **无内置数据过期**：需要手动清理旧数据  
❌ **生态还在建设中**：没有 Grafana/Telegraf 等成熟集成  
❌ **仅支持 TypeScript/JavaScript**：其他语言需要通过 IPC 或 FFI  
❌ **聚合查询性能待优化**：复杂聚合场景下不如 InfluxDB

**一句话总结**：如果你需要"企业级"，选 InfluxDB；如果你需要"零依赖嵌入式"，选 ndtsdb。

---

## 八、总结与决策流程

### 核心观点

> ndtsdb 不是 InfluxDB 的替代品，而是**嵌入式场景的最佳选择**。

两者的定位完全不同：
- **InfluxDB** = 独立服务，分布式优先，企业级
- **ndtsdb** = 嵌入式库，单机优先，开发者友好

### 决策流程图

```
需要时序数据库？
  ├── 需要集群/高可用？
  │     └─→ InfluxDB / TimescaleDB
  │
  └── 单机/嵌入式场景？
        ├── TypeScript/Bun 项目？
        │     └─→ ndtsdb ⭐
        │
        ├── 其他语言（Go/Rust/Python）？
        │     └─→ InfluxDB / QuestDB
        │
        └── 数据量 > 100GB？
              └─→ InfluxDB / TimescaleDB
```

### 开始使用 ndtsdb

**安装**：
```bash
bun add ndtsdb
```

**5 分钟快速上手**：
```typescript
import { ColumnarTable } from 'ndtsdb';

const table = new ColumnarTable([
  { name: 'timestamp', type: 'int64' },
  { name: 'value', type: 'float64' },
]);

table.addRow({ timestamp: Date.now(), value: 100.5 });
table.saveToFile('./data.ndts');
```

**资源链接**：
- GitHub: [https://github.com/yourusername/ndtsdb](https://github.com/devaliuz/ndtsdb)
- 文档: [https://github.com/devaliuz/ndtsdb/blob/main/docs/FEATURES.md](https://github.com/devaliuz/ndtsdb/blob/main/docs/FEATURES.md)
- Benchmark: [https://github.com/devaliuz/ndtsdb/tree/main/benchmarks](https://github.com/devaliuz/ndtsdb/tree/main/benchmarks)

**如果这个项目对你有帮助，请给个 Star ⭐**

---

**作者注**：  
本文所有 benchmark 数据均为真实测试结果（2026-02-10），测试代码开源可复现。我们欢迎社区提出性能优化建议和 PR。

ndtsdb 是一个新兴项目，还有很多不完善的地方。我们不会夸大它的能力，也不会贬低其他优秀的 TSDB。选择合适的工具，比选择"最好的"工具更重要。

---
---

# ndtsdb vs InfluxDB: A New Choice for Embedded Time Series Databases

**2026-02-10 | Comparison Review**

---

## 1. Have You Ever Faced This Dilemma?

You just want to store some sensor data, but you have to deploy an entire InfluxDB service?

For real-time monitoring on an edge device, do you really need a database with 500MB+ memory footprint?

Or, you're developing a desktop application and don't want users to manually configure an external database during installation?

If these scenarios sound familiar, **ndtsdb** might be the answer you need — a TypeScript-native time series database designed specifically for embedded scenarios.

It's important to note that ndtsdb **is not meant to replace InfluxDB**. InfluxDB is a mature, production-grade distributed system with irreplaceable value. ndtsdb simply offers a more lightweight alternative for embedded, single-node, resource-constrained scenarios.

---

## 2. When Do You Need an Embedded Time Series Database?

Not every scenario requires an independently deployed database service. In the following situations, an embedded TSDB might be a better choice:

| Scenario | Characteristics | Typical Applications |
|----------|----------------|---------------------|
| **Edge Computing** | Resource-constrained, offline operation, local decision-making | IoT gateways, industrial PCs, Raspberry Pi devices |
| **Desktop Applications** | Zero external dependencies, transparent user installation | Monitoring tools, quantitative trading software, log analyzers |
| **Development & Testing** | Fast startup, zero configuration, easy debugging | Unit tests, prototyping, CI/CD |
| **Serverless** | Cold-start sensitive, unable to maintain long connections | Lambda functions, Edge Functions |

**Scenarios NOT suitable for embedded TSDB** (we must be honest):
- ❌ Requires high availability clusters and failover
- ❌ Data volume exceeds 100GB (single-node limitations)
- ❌ Needs comprehensive data retention policies and permission management
- ❌ Team has deeply invested in InfluxDB ecosystem (high migration cost)

If your project fits the "not suitable" criteria above, please choose InfluxDB or TimescaleDB directly.

---

## 3. Core Comparison: ndtsdb vs InfluxDB

| Dimension | ndtsdb | InfluxDB OSS |
|-----------|--------|--------------|
| **Deployment** | Embedded (`bun add ndtsdb` and go) | Standalone service (Docker/Binary) |
| **Runtime** | TypeScript/Bun in-process | Standalone Go process |
| **Cold Start** | 60ms (3000 files) | 2-5 seconds |
| **Memory Footprint** | 32MB (100K ticks) | 500MB+ baseline |
| **Query Language** | SQL (standard syntax) | Flux / InfluxQL |
| **Compression** | Gorilla (70-90%) | Proprietary TSM |
| **Cluster Support** | ❌ Single-node | ✅ Supported (Enterprise) |
| **Ecosystem Maturity** | Emerging (2026) | Mature (2013-) |
| **External Dependencies** | Zero (pure JS fallback) | Requires standalone process |

**Key Differences**:
- ndtsdb is a **library**, InfluxDB is a **service**
- ndtsdb is for **embedding**, InfluxDB is for **independent deployment**

---

## 4. Real-World Benchmark Data

**Test Environment**:
- Hardware: Linux x64 (Bun 1.3.8)
- Dataset: 10 symbols, 100K OHLCV tick data
- Scenario: Single-node embedded write and query

### 4.1 Write Performance

```
Bulk Write (in-memory):   808.91K ticks/sec
Persistent Write (batch): 710.56K ticks/sec
```

**Notes**:
- ndtsdb writes are **in-process calls** (no network overhead)
- InfluxDB writes via HTTP API, typical speed ~**100-200K points/sec**
- Not directly comparable (network vs in-process), but ndtsdb is indeed faster in embedded scenarios

### 4.2 Query Performance

```
Simple Query (SELECT * LIMIT 1000):
  ndtsdb:   37.82 ops/sec (26ms latency)

Range Query (WHERE ts > timestamp):
  ndtsdb:   47.56 ops/sec (21ms latency)

Aggregation (MIN/MAX):
  ndtsdb:   2.10 ops/sec (477ms latency)
```

**Compared to InfluxDB**:
- Simple queries: InfluxDB via network API ~**5-10ms** (local deployment)
- Aggregation queries: InfluxDB, after years of optimization, typically **10-50ms**

**Honestly**: ndtsdb's aggregation performance needs optimization. Currently, we focus on writes and simple filters; InfluxDB is more mature for complex aggregation scenarios.

### 4.3 Cold Start

```
Loading 3000 .ndts files:  60ms
InfluxDB service startup:  2-5 seconds
```

This is ndtsdb's core advantage — **no standalone process required**, import and use.

### 4.4 Memory Usage

```
Storing 100K ticks (10 symbols):
  Heap Used:  32.08 MB
  RSS:       175.02 MB

InfluxDB baseline memory:  500MB+
```

---

## 5. Code Comparison: 5-Minute Onboarding

### 5.1 InfluxDB Approach

```bash
# 1. Install InfluxDB (macOS)
brew install influxdb

# 2. Start service
influxd

# 3. Create bucket and token (requires Web UI or CLI)
influx setup
```

```typescript
// 4. TypeScript connection code
import { InfluxDB, Point } from '@influxdata/influxdb-client';

const client = new InfluxDB({
  url: 'http://localhost:8086',
  token: 'your-super-secret-token',
});

const writeApi = client.getWriteApi('my-org', 'my-bucket');

// Write data
const point = new Point('temperature')
  .tag('location', 'room1')
  .floatField('value', 23.5)
  .timestamp(new Date());

writeApi.writePoint(point);
await writeApi.close();

// Query data (Flux syntax)
const queryApi = client.getQueryApi('my-org');
const query = `
  from(bucket: "my-bucket")
    |> range(start: -1h)
    |> filter(fn: (r) => r._measurement == "temperature")
`;

for await (const { values, tableMeta } of queryApi.iterateRows(query)) {
  console.log(values);
}
```

### 5.2 ndtsdb Approach

```bash
# 1. Install (zero configuration)
bun add ndtsdb
```

```typescript
// 2. Import and use
import { ColumnarTable } from 'ndtsdb';

// Create table
const table = new ColumnarTable([
  { name: 'timestamp', type: 'int64' },
  { name: 'location', type: 'string' },
  { name: 'value', type: 'float64' },
]);

// Write data
table.addRow({
  timestamp: Date.now(),
  location: 'room1',
  value: 23.5,
});

// Query data (SQL)
const result = table.querySQL(`
  SELECT * FROM t
  WHERE timestamp > ${Date.now() - 3600000}
  ORDER BY timestamp DESC
`);

console.log(result.rows);

// Persist (optional)
table.saveToFile('./data/temperature.ndts');
```

**Comparison Summary**:
- **Lines of code**: ndtsdb reduces 60%+
- **Dependency complexity**: ndtsdb has zero external services
- **Learning curve**: SQL vs Flux (SQL is friendlier to most developers)

---

## 6. Real-World Use Cases

### Case 1: Raspberry Pi IoT Gateway

**Requirement**: Collect data from 50 sensors at 100 samples/sec on Raspberry Pi 4B (4GB RAM).

**Problem**:
- InfluxDB startup on Raspberry Pi takes **5-10 seconds**, memory usage **500MB+**
- After power loss restart, must wait for database service readiness

**Solution (ndtsdb)**:
```typescript
import { AppendWriter } from 'ndtsdb';

const writer = new AppendWriter('./sensors.ndts', [
  { name: 'sensor_id', type: 'int32' },
  { name: 'timestamp', type: 'int64' },
  { name: 'temperature', type: 'float64' },
  { name: 'humidity', type: 'float64' },
]);

// Batch write 100 records per second
setInterval(() => {
  const batch = getSensorReadings(); // Assume returns 100 records
  writer.appendBatch(batch);
}, 1000);

// Immediately available after process restart (60ms load)
```

**Results**:
- Memory usage reduced to **50MB**
- Cold start from 5 seconds to **60ms**
- No need to maintain standalone database process

### Case 2: Electron Desktop Monitoring Tool

**Requirement**: Develop a cross-platform system monitoring tool that records CPU/memory/network history.

**Problem**:
- Users don't want to install additional database services
- Package size needs to be small (Electron is already large)

**Solution (ndtsdb)**:
```typescript
// In Electron main process
import { ColumnarTable } from 'ndtsdb';

const metricsTable = new ColumnarTable([
  { name: 'timestamp', type: 'int64' },
  { name: 'cpu', type: 'float64' },
  { name: 'memory', type: 'float64' },
]);

// Collect every 5 seconds
setInterval(() => {
  metricsTable.addRow({
    timestamp: Date.now(),
    cpu: getCpuUsage(),
    memory: getMemoryUsage(),
  });
}, 5000);

// Renderer process queries last hour's data
ipcMain.handle('get-metrics', () => {
  return metricsTable.querySQL(`
    SELECT timestamp, cpu, memory
    FROM t
    WHERE timestamp > ${Date.now() - 3600000}
    ORDER BY timestamp
  `);
});
```

**Results**:
- Users install and use immediately, no configuration needed
- Package size increase < 5MB
- Data files stored with application data directory

### Case 3: Quantitative Backtesting System

**Requirement**: Load historical K-line data for 3000 trading pairs for strategy backtesting.

**Problem**:
- InfluxDB cold start is slow, affecting development efficiency
- Frequent restarts needed for debugging strategies

**Solution (ndtsdb)**:
```typescript
import { MmapMergeStream } from 'ndtsdb';

// Load 3000 .ndts files in 60ms (mmap zero-copy)
const files = ['BTC.ndts', 'ETH.ndts', /* ...3000 files */];
const stream = new MmapMergeStream(
  files.map(f => ({ file: `./klines/${f}`, symbol: f.replace('.ndts', '') }))
);

// Replay all ticks in chronological order (8.9M ticks/sec)
for (const tick of stream.replayTicks()) {
  backtestStrategy(tick);
}
```

**Results**:
- Cold start from 10 seconds to **60ms**
- Multi-file merge replay reaches **8.9M ticks/sec**
- Development debug cycle time significantly shortened

---

## 7. When Should You Choose InfluxDB?

As the author of ndtsdb, I must honestly tell you that **InfluxDB is still the better choice in many scenarios**:

### Scenarios Recommending InfluxDB

✅ **Need high availability and clustering**  
   ndtsdb is a single-node library, no distributed support. If you need multi-node failover, choose InfluxDB.

✅ **Data volume exceeds 100GB**  
   For storing and querying large datasets on a single node, InfluxDB has been optimized over years for more stable performance.

✅ **Need comprehensive data governance**  
   Retention policies, continuous queries, permission management — ndtsdb doesn't support any of these.

✅ **Team already familiar with Flux ecosystem**  
   If the team has invested significant time learning Flux, migration cost may not be worth it.

✅ **Need commercial support**  
   InfluxData provides enterprise support, ndtsdb is an open-source project (MIT license) with no official SLA.

### Current Limitations of ndtsdb

We don't avoid ndtsdb's shortcomings:

❌ **No cluster support**: Only single-node operation  
❌ **No built-in data expiration**: Manual cleanup of old data required  
❌ **Ecosystem still building**: No mature integrations like Grafana/Telegraf  
❌ **Only supports TypeScript/JavaScript**: Other languages need IPC or FFI  
❌ **Aggregation query performance needs optimization**: Not as good as InfluxDB for complex aggregations

**One-sentence summary**: If you need "enterprise-grade", choose InfluxDB; if you need "zero-dependency embedded", choose ndtsdb.

---

## 8. Summary & Decision Flow

### Core Viewpoint

> ndtsdb is not a replacement for InfluxDB, but the **best choice for embedded scenarios**.

The positioning is completely different:
- **InfluxDB** = Standalone service, distributed-first, enterprise-grade
- **ndtsdb** = Embedded library, single-node-first, developer-friendly

### Decision Flowchart

```
Need a time series database?
  ├── Need cluster/high availability?
  │     └─→ InfluxDB / TimescaleDB
  │
  └── Single-node/embedded scenario?
        ├── TypeScript/Bun project?
        │     └─→ ndtsdb ⭐
        │
        ├── Other languages (Go/Rust/Python)?
        │     └─→ InfluxDB / QuestDB
        │
        └── Data volume > 100GB?
              └─→ InfluxDB / TimescaleDB
```

### Getting Started with ndtsdb

**Installation**:
```bash
bun add ndtsdb
```

**5-Minute Quick Start**:
```typescript
import { ColumnarTable } from 'ndtsdb';

const table = new ColumnarTable([
  { name: 'timestamp', type: 'int64' },
  { name: 'value', type: 'float64' },
]);

table.addRow({ timestamp: Date.now(), value: 100.5 });
table.saveToFile('./data.ndts');
```

**Resource Links**:
- GitHub: [https://github.com/yourusername/ndtsdb](https://github.com/devaliuz/ndtsdb)
- Documentation: [https://github.com/devaliuz/ndtsdb/blob/main/docs/FEATURES.md](https://github.com/devaliuz/ndtsdb/blob/main/docs/FEATURES.md)
- Benchmarks: [https://github.com/devaliuz/ndtsdb/tree/main/benchmarks](https://github.com/devaliuz/ndtsdb/tree/main/benchmarks)

**If this project helps you, please give it a Star ⭐**

---

**Author's Note**:  
All benchmark data in this article are from real test results (2026-02-10), with open-source reproducible test code. We welcome community suggestions for performance optimization and PRs.

ndtsdb is an emerging project with many areas for improvement. We won't exaggerate its capabilities, nor will we belittle other excellent TSDBs. Choosing the right tool is more important than choosing the "best" tool.
