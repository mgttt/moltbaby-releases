# NDTSDB 百万级 Benchmark 与降维技术调研

## 1. 时序数据库 Benchmark 现状

### 1.1 行业标准 Benchmark 工具

**TSBS (Time Series Benchmark Suite)**
- Timescale 开发的开源 benchmark 框架
- 支持 InfluxDB、TimescaleDB、ClickHouse、VictoriaMetrics 等
- 包含数据生成、写入测试、查询测试三阶段
- 可模拟 DevOps、IoT、金融等场景
- GitHub: timescale/tsbs

**关键指标**
| 指标 | 说明 |
|------|------|
| Ingestion Rate | 每秒写入点数 (points/sec) |
| Query Latency | 查询延迟 (p50/p95/p99) |
| Compression Ratio | 压缩比 |
| Memory Usage | 内存占用 |
| Disk Usage | 磁盘占用 |

### 1.2 百万级性能参考

| 数据库 | 写入性能 | 特点 |
|--------|----------|------|
| ClickHouse | 100万+/秒 | 列式存储，向量化执行 |
| TimescaleDB | 30万/秒 | PostgreSQL 扩展，SQL 兼容 |
| InfluxDB 3.0 | 50万+/秒 | Apache Arrow 底层 |
| VictoriaMetrics | 100万+/秒 | 高压缩比，低资源占用 |

### 1.3 NDTSDB 现状评估

**优势**
- C 语言实现，无 GC 开销
- 内存映射文件，零拷贝读取
- 分区存储，symbol/interval 隔离

**潜在瓶颈**
- 单线程写入（需验证）
- 无压缩（JSON Lines 格式）
- 查询无向量化优化

**建议 Benchmark 方案**
```bash
# 1. 生成 100万条测试数据
./ndtsdb-cli generate --count 1000000 --symbol BTC --interval 1m

# 2. 写入性能测试
./ndtsdb-cli benchmark write --database ./testdb --duration 60s

# 3. 查询性能测试
./ndtsdb-cli benchmark query --database ./testdb --query-type range
```

## 2. 降维技术调研

### 2.1 时序数据降维场景

**为什么需要降维？**
- 高维时间序列可视化困难
- 机器学习特征提取
- 异常检测预处理
- 相似性搜索加速

### 2.2 主流降维算法对比

| 算法 | 类型 | 优点 | 缺点 | 适用场景 |
|------|------|------|------|----------|
| **PCA** | 线性 | 快速、可解释、保留全局结构 | 只能捕捉线性关系 | 预处理、特征提取 |
| **t-SNE** | 非线性 | 优秀的局部结构保留 | 慢、不保留全局结构、随机性 | 可视化 |
| **UMAP** | 非线性 | 快、保留全局+局部结构 | 超参数敏感 | 大规模数据可视化 |
| **SAX** | 符号化 | 时序专用、可解释 | 信息损失大 | 时序分类、异常检测 |
| **PAA** | 分段平均 | 简单快速 | 仅降采样 | 快速预览 |

### 2.3 算法详解

#### PCA (主成分分析)
```
原理：找到数据方差最大的方向，投影到低维空间
复杂度：O(n^2 * m)  n=样本数, m=特征数
适用：特征提取、去噪、可视化(2D/3D)
```

#### t-SNE (t-分布随机邻域嵌入)
```
原理：保留高维空间中点的局部邻域关系
复杂度：O(n^2)，大规模数据需近似(Barnes-Hut)
适用：高维数据可视化
注意：结果随随机种子变化，不用于下游任务
```

#### UMAP (统一流形逼近与投影)
```
原理：基于流形学习和拓扑数据分析
复杂度：O(n^1.14)，比 t-SNE 快 10-100 倍
适用：大规模数据可视化、聚类预处理
优势：保留全局结构，可transform新数据
```

#### SAX (符号聚合近似)
```
原理：PAA + 符号离散化
步骤：
  1. PAA: 将时序分段取平均
  2. 将均值映射到符号(a-z)
结果：字符串表示，适合字符串算法
适用：时序分类、motif 发现
```

### 2.4 NDTSDB 降维集成建议

**方案 A: 内置 PAA 降采样**
```c
// SQL 扩展
SELECT paa(close, 100) FROM BTC_1m WHERE timestamp > now() - 1d;
// 返回 100 个点的分段平均
```

**方案 B: 插件化降维**
```javascript
// JS 插件调用外部库
const umap = require('umap-js');
const embedding = umap.fit(data);
```

**方案 C: 预处理管道**
```bash
# 导出 → 降维 → 导入
./ndtsdb-cli export | ./dim-reduction pca --dims 3 | ./ndtsdb-cli import
```

## 3. 推荐实施路径

### Phase 1: Benchmark 框架 (1-2 天)
1. 实现数据生成器（随机/真实模式）
2. 实现写入 benchmark（吞吐量、延迟）
3. 实现查询 benchmark（范围查询、聚合查询）
4. 输出报告：对比 SQLite/InfluxDB

### Phase 2: 降维 POC (2-3 天)
1. 集成 PAA/SAX 到 ndtsdb-cli
2. 测试 PCA/UMAP JS 绑定
3. 可视化验证（2D/3D 散点图）

### Phase 3: 优化 (持续)
1. 基于 benchmark 结果优化写入路径
2. 评估列式存储、压缩算法
3. 并行查询优化

## 4. 参考资源

- TSBS: https://github.com/timescale/tsbs
- UMAP Paper: https://arxiv.org/abs/1802.03426
- SAX: https://www.cs.ucr.edu/~eamonn/SAX.htm
- Time Series Benchmarks: https://www.timestored.com/data/time-series-database-benchmarks
