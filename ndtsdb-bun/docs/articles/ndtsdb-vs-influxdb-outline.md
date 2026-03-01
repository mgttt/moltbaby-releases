# 文章大纲: ndtsdb vs InfluxDB — 嵌入式时序数据库对比

> 目标平台: 掘金、Dev.to、Medium
> 预计字数: 2000-3000 字
> 目标读者: 后端开发者、IoT 开发者、量化开发者

---

## 标题候选

1. "ndtsdb vs InfluxDB: 嵌入式时序数据库的新选择"
2. "告别 InfluxDB 部署烦恼：TypeScript 原生时序数据库 ndtsdb"
3. "2026 年嵌入式时序数据库对比：ndtsdb 能否替代 InfluxDB？"

---

## 文章结构

### 1. 开篇 Hook (100字)

**问题场景**:
- "你是否遇到过这种情况：只是想存储一些时序数据，却要部署一整套 InfluxDB 服务？"
- "为一个边缘设备的传感器数据，真的需要 500MB+ 内存的数据库吗？"

**引出主题**:
- 介绍 ndtsdb：为嵌入式场景设计的时序数据库
- 不是要"取代" InfluxDB，而是提供另一种选择

---

### 2. 场景分析：什么时候需要嵌入式 TSDB？ (300字)

**适合嵌入式 TSDB 的场景**:
| 场景 | 特点 | 例子 |
|------|------|------|
| 边缘计算 | 资源受限、离线运行 | IoT 网关、工控机 |
| 桌面应用 | 不想要外部依赖 | 监控工具、交易软件 |
| 开发测试 | 快速启动、零配置 | 单元测试、原型开发 |
| Serverless | 冷启动敏感 | Lambda、Edge Functions |

**不适合的场景**（诚实地说）:
- 需要集群/高可用
- 数据量 > 100GB
- 需要复杂的数据保留策略

---

### 3. 核心对比表格 (200字)

| 维度 | ndtsdb | InfluxDB OSS |
|------|--------|--------------|
| **部署方式** | 嵌入式（import 即用） | 独立服务 |
| **语言** | TypeScript/Bun 原生 | Go |
| **冷启动** | ~60ms | ~秒级 |
| **内存占用** | ~50MB (1M rows) | ~500MB+ |
| **依赖** | 零 | 需要独立进程 |
| **查询语言** | SQL | Flux / InfluxQL |
| **压缩** | Gorilla | 自研 |
| **集群** | ❌ 单机 | ✅ 支持 |
| **生态** | 新兴 | 成熟 |

---

### 4. Benchmark 数据 (400字)

**测试环境**:
- 硬件：M2 MacBook Pro / Linux x64
- 数据：100万条 OHLCV tick 数据
- 场景：单机嵌入式

**写入性能**:
```
ndtsdb:   8.9M ticks/sec (批量)
InfluxDB: ~100K points/sec (通过 HTTP API)
```
*注：InfluxDB 通过网络 API，ndtsdb 是进程内调用，不完全可比*

**查询性能**:
```
简单查询 (SELECT * LIMIT 1000):
  ndtsdb:   0.5ms
  InfluxDB: 5-10ms

聚合查询 (GROUP BY hour):
  ndtsdb:   2ms
  InfluxDB: 10-50ms
```

**冷启动**:
```
ndtsdb:   60ms (3000 symbols)
InfluxDB: 2-5s
```

**图表**: 柱状图对比（用 Mermaid 或截图）

---

### 5. 代码对比 (300字)

**InfluxDB 方式**:
```bash
# 1. 安装 InfluxDB
brew install influxdb

# 2. 启动服务
influxd

# 3. 代码连接
```
```typescript
import { InfluxDB, Point } from '@influxdata/influxdb-client';

const client = new InfluxDB({ url: 'http://localhost:8086', token: '...' });
const writeApi = client.getWriteApi('org', 'bucket');

// 写入
const point = new Point('temperature')
  .tag('location', 'room1')
  .floatField('value', 23.5);
writeApi.writePoint(point);

// 查询 (Flux)
const query = `from(bucket: "my-bucket") |> range(start: -1h)`;
```

**ndtsdb 方式**:
```typescript
import { NDTSEngine } from 'ndtsdb';

// 零配置启动
const db = new NDTSEngine('./data');

// 写入
db.append('temperature:room1', { ts: Date.now(), value: 23.5 });

// 查询 (SQL)
const result = db.query(`
  SELECT * FROM "temperature:room1" 
  WHERE ts > ${Date.now() - 3600000}
`);
```

**对比点**:
- 代码行数：ndtsdb 更少
- 依赖复杂度：ndtsdb 无外部服务
- 学习曲线：SQL vs Flux

---

### 6. 实际应用场景 (300字)

**场景 1: IoT 边缘网关**
```
问题：树莓派上运行，内存只有 1GB，需要本地存储传感器数据
InfluxDB：内存占用过大，启动慢
ndtsdb：50MB 内存，60ms 启动，完美适配
```

**场景 2: Electron 桌面应用**
```
问题：开发一个本地监控工具，不想让用户安装额外服务
InfluxDB：需要捆绑 InfluxDB 或要求用户自己装
ndtsdb：打包进 Electron，用户无感知
```

**场景 3: 量化回测系统**
```
问题：需要快速加载历史 K 线数据进行回测
InfluxDB：冷启动慢，影响开发效率
ndtsdb：亚秒级加载 3000 个交易对
```

---

### 7. 什么时候选 InfluxDB？ (200字)

**诚实地推荐 InfluxDB 的场景**:
- ✅ 需要高可用集群
- ✅ 数据量超过 100GB
- ✅ 需要完善的数据保留策略
- ✅ 团队已熟悉 Flux 生态
- ✅ 需要企业支持

**ndtsdb 目前的局限**:
- ❌ 无集群支持
- ❌ 无内置数据过期
- ❌ 生态还在建设中
- ❌ 仅支持 TypeScript/JavaScript

---

### 8. 总结 & CTA (150字)

**一句话总结**:
> ndtsdb 不是 InfluxDB 的替代品，而是嵌入式场景的最佳选择。

**适用判断流程**:
```
需要时序数据库？
  ├── 集群/高可用？ → InfluxDB / TimescaleDB
  └── 单机/嵌入式？
        ├── TypeScript 项目？ → ndtsdb ⭐
        └── 其他语言？ → SQLite + 手写
```

**CTA**:
- GitHub: [链接]
- 文档: [链接]
- "觉得有用？给个 Star ⭐"

---

## 配图清单

1. 对比表格截图
2. Benchmark 柱状图
3. 代码对比截图（左右分栏）
4. 决策流程图
5. 项目 Logo

---

## SEO 关键词

- 时序数据库对比
- InfluxDB 替代
- 嵌入式数据库
- TypeScript 数据库
- IoT 数据存储
- 边缘计算数据库

---

## 发布计划

| 平台 | 格式调整 | 预计发布 |
|------|----------|----------|
| 掘金 | 中文，加沸点互动 | Week 2 |
| Dev.to | 英文 | Week 2 |
| Medium | 英文，付费墙后 | Week 3 |
| 知乎 | 中文，问答引流 | Week 3 |

---

## 下一步

1. [ ] 跑 benchmark 获取真实数据
2. [ ] 填充代码示例
3. [ ] 制作配图
4. [ ] 写正文
5. [ ] 内部 review
6. [ ] 发布
