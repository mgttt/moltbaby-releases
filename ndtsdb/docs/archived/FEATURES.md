# ndtsdb Features

> **版本**: v0.9.4.3 (2026-02-11)  
> **Scope / Non-goals**: 见 `docs/SCOPE.md`

本文档列出 **ndtsdb 引擎本体**已具备的主要能力（用于发布仓库/产品说明）。

---

## 🎯 核心特性概览

| 特性 | 状态 | 性能 |
|------|------|------|
| **列式存储** | ✅ | 6.9M writes/s |
| **增量写入** | ✅ | 3.3M rows/s |
| **压缩算法** | ✅ | Delta/RLE/Gorilla |
| **SQL 引擎** | ✅ | JOIN/子查询/聚合/窗口函数 |
| **索引** | ✅ | BTree + 复合索引 |
| **分区表** | ✅ | 时间/哈希/范围分区 |
| **流式聚合** | ✅ | SMA/EMA/StdDev/Min/Max |
| **C SIMD** | ✅ | 143M rows/s (8 平台) |
| **测试覆盖** | ✅ | 79/79 tests pass |

---

## 1. Compression Algorithms

ndtsdb 提供多种压缩算法，适用于不同数据类型和模式：

### Gorilla Compression
- **用途**：浮点数时序数据（价格、指标等）
- **算法**：Delta-of-Delta + XOR（Facebook 开源）
- **压缩率**：20-30%（真实浮点数），97%（常量值）
- **类型**：float64
- **实现**：纯 TypeScript（GorillaEncoder）
- **注意**：对随机浮点数压缩率较低（~20%），但对平滑/重复数据效果好

### Delta Encoding
- **用途**：单调递增序列（timestamp, ID）
- **算法**：存储相邻值差值（Varint 编码）
- **压缩率**：75%（等间隔序列）
- **类型**：int64, int32

### Delta-of-Delta
- **用途**：等间隔时间序列（固定周期采样）
- **算法**：存储差值的差值
- **压缩率**：>90%（等间隔）

### RLE (Run-Length Encoding)
- **用途**：重复值多的序列（状态、symbol ID）
- **算法**：游程编码（value + count）
- **压缩率**：>95%（高重复率数据）

**当前集成状态**：
- ✅ 压缩算法已实现（compression.ts）+ 基准测试
- ✅ **已集成到 AppendWriter 文件格式**（可选开关，向后兼容旧文件）

### AppendWriter 启用压缩
```ts
const writer = new AppendWriter(path, columns, {
  compression: {
    enabled: true,
    algorithms: {
      timestamp: 'delta',    // int64: 单调递增 → Delta
      price: 'gorilla',      // float64: 浮点数 → Gorilla
      symbol_id: 'rle',      // int32: 重复值 → RLE
    },
  },
});
```
- **支持算法**：
  - `delta`：int64/int32 单调递增序列
  - `rle`：int32 重复值序列
  - `gorilla`：float64 浮点数时序数据
  - `none`：不压缩
- **文件格式**：
  - 压缩启用时：chunk 写入为 `rowCount + (colLen+colData)*N + crc32`
  - 未启用压缩：保持旧格式（固定列长），读取端自动兼容
- **自动选择**：不指定 algorithms 时，自动选择最优算法
  - int64 → delta
  - int32 → delta
  - float64 → gorilla

---

## 2. Partitioned Tables

**自动分区**：按时间/symbol/hash 自动分区，提升大表查询性能。

### 分区策略
- **时间分区**：按 day/month/year 自动分区（如 K线数据按日分区）
- **范围分区**：按数值范围分区
- **哈希分区**：按列值哈希分桶（均匀分布）

### 使用示例
```typescript
const table = new PartitionedTable(
  '/data/klines',
  [{ name: 'timestamp', type: 'int64' }, { name: 'price', type: 'float64' }],
  { type: 'time', column: 'timestamp', interval: 'day' } // 按天分区
);

// 写入自动分区
table.append([
  { timestamp: 1704153600000n, price: 100.5 },
  { timestamp: 1704240000000n, price: 101.2 },
]);

// 跨分区查询
const results = table.query(row => row.price > 100);
```

### 特性
- ✅ 自动分区文件管理（写入时选择/创建分区）
- ✅ 跨分区查询合并
- ✅ 分区元数据（行数、边界信息）
- ✅ WHERE 时间范围优化 v1：`query(filter, {min,max})` 提前过滤分区扫描（按分区 label 推断范围）
- ✅ **SQL 集成**：`queryPartitionedTableToColumnar()`自动提取 WHERE 时间范围并转换为内存表供 SQL 执行

### SQL 集成示例
```typescript
const partitionedTable = new PartitionedTable(...);
const sql = "SELECT * FROM t WHERE timestamp >= 1000";
const parsed = new SQLParser().parse(sql);

// 自动提取时间范围 + 优化分区扫描 + 转换为 ColumnarTable
const table = queryPartitionedTableToColumnar(partitionedTable, parsed.data.whereExpr);

// 注册并执行 SQL
executor.registerTable('t', table);
const result = executor.execute(parsed);
```

---

## 3. Streaming Aggregation

**增量窗口计算**：实时指标计算，无需全量重算。

### 支持的聚合器
- **StreamingSMA**：滑动平均
- **StreamingEMA**：指数移动平均
- **StreamingStdDev**：滑动标准差
- **StreamingMin/Max**：滑动最小/最大值
- **StreamingAggregator**：多指标组合计算

### 使用示例
```typescript
const sma = new StreamingSMA(20); // 20-period SMA

// 实时添加新数据
const avgPrice1 = sma.add(100.5);
const avgPrice2 = sma.add(101.2);
// ...

// 多指标计算
const agg = new StreamingAggregator();
agg.addAggregator('sma', new StreamingSMA(20));
agg.addAggregator('ema', new StreamingEMA(12));
agg.addAggregator('stddev', new StreamingStdDev(20));

const metrics = agg.add(100.5); // { sma: ..., ema: ..., stddev: ... }
```

### 应用场景
- 实时监控仪表盘
- 在线交易系统指标
- 动态警报触发
- 流式数据处理

---

## 4. High-Performance Queries

### getMax() API + 内存索引缓存

**问题**：查询最新时间戳等聚合值时需要全表扫描（O(n)）

**解决方案**：
1. **内存索引缓存**（哈希分区专用）
   - 结构：`partitionLabel → hashValue → column → maxValue`
   - 写入时自动维护（O(1) 更新）
   - 查询时 O(1) 返回缓存值

2. **partitionHint 定位**
   - 哈希分区：直接定位到对应 bucket
   - 时间分区：只扫描最新分区

**性能**：
- 30个symbol查询最新时间戳：**300秒 → 0.37ms**（810,000x 加速）
- 单次查询：**10秒 → 0.01ms**（1,000,000x 加速）

**使用示例**：
```typescript
// PartitionedTable API
const maxValue = table.getMax(
  'timestamp',                    // 列名
  row => row.symbol_id === 123,   // 过滤条件
  { symbol_id: 123 }              // partitionHint（定位 bucket）
);

// KlineDatabase API
const maxTs = await db.getMaxTimestamp('BTC/USDT', '1m');
// 性能：~0.01ms（O(1) 查询）
```

**索引一致性**：
```typescript
// 插入后立即查询，自动更新索引
await db.insertKlines([newKline]);
const ts = await db.getMaxTimestamp(symbol, interval);
// ts === newKline.timestamp ✅
```

---

### query() 提前退出优化

**问题**：全表扫描，即使 `limit=1` 也遍历所有行

**解决方案**：
1. **limit 参数**：找到 N 条后立即返回
2. **reverse 参数**：倒序扫描（查最新数据更高效）
3. **跨分区提前退出**：达到 limit 后停止扫描

**性能**：
- `limit=10`：**3.7x 加速**
- `reverse+limit=1`（查最新）：**4.4x 加速**

**使用示例**：
```typescript
// 查询最新 10 条
const latest = table.query(
  row => row.symbol_id === 123,
  { reverse: true, limit: 10 }
);

// 查询最新一条（最常用）
const latest = table.query(
  row => row.symbol_id === 123,
  { reverse: true, limit: 1 }
);

// 时间范围 + limit
const rows = table.query(
  row => row.symbol_id === 123,
  {
    timeRange: { min: startTs, max: endTs },
    limit: 100
  }
);
```

**应用场景**：
- 增量数据拉取（查最新时间戳）
- 实时监控（查最新状态）
- 分页查询
- Top-N 查询

---

### 分区裁剪优化

**问题**：时间范围查询返回超出范围的数据

**解决方案**：
1. **分区级裁剪**：只扫描时间范围内的分区（已有功能）
2. **行级过滤**：检查每行的 timestamp 是否在范围内（v0.9.4.3 修复）

**性能**：
- 3天查询（3个分区）：**6.1x 加速**（vs 全表扫描）
- 1天查询（1个分区）：**6.1x 加速**
- 时间范围准确性：**严格匹配**

**使用示例**：
```typescript
// 时间范围查询（自动分区裁剪 + 行级过滤）
const rows = table.query(
  row => row.symbol_id === 123,
  {
    timeRange: {
      min: BigInt(startTime),
      max: BigInt(endTime)  // 不含 endTime（左闭右开区间）
    }
  }
);

// 结合 limit（常见：查最近 N 条）
const recent = table.query(
  row => row.symbol_id === 123,
  {
    timeRange: {
      min: BigInt(Date.now() - 7 * 86400_000) // 最近 7 天
    },
    reverse: true,
    limit: 100
  }
);
```

**注意事项**：
- 时间范围是**左闭右开区间**：`[min, max)`
- 仅时间分区表支持分区级裁剪
- 哈希/范围分区表会退化为全表扫描（但仍会做行级过滤）

---

## 5. Storage Engine

### AppendWriter (DLv2)
- chunked append-only
- header + per-chunk CRC32（固定 4KB header 预留空间）
- reopen & append 无需重写
- **列压缩（可选）**：压缩启用时 chunk 使用变长列格式（colLen + colData），读取端自动解压
  - int64: delta
  - int32: delta / rle
  - float64: 暂未集成（后续可接 Gorilla）
- **String 持久化**：字典编码（string → int32 id），存储在 header.stringDicts
- **Tombstone 删除**：`deleteWhereWithTombstone`（O(1) 标记 + 延迟 compact）
  - 独立 .tomb 文件（RoaringBitmap 压缩存储已删除行号）
  - `compact()` 清理 tombstone + 重写文件
  - `readAllFiltered()` 自动过滤已删除行
- **自动 compact**：多触发条件，close 时自动清理 + 合并 chunk
  - `autoCompact`: true/false（默认 false）
  - 触发条件（任一满足即触发）：
    - `compactThreshold`: tombstone 比例（默认 0.2 = 20%）
    - `compactMaxAgeMs`: 最大未 compact 时间（默认 24h）
    - `compactMaxFileSize`: 最大文件大小（默认 100MB）
    - `compactMaxChunks`: 最大 chunk 数量（默认 1000）
    - `compactMaxWrites`: 累计写入行数（默认 100k）
  - `compactMinRows`: 1000（最小行数阈值，避免小表频繁 compact）
- **rewrite/compact**：`rewrite/deleteWhere/updateWhere`（写 tmp + 原子替换，向后兼容）

### ColumnarTable
- 内存列式表
- 数值列使用 TypedArray
- **string 列支持持久化**（字典编码，透明存储为 int32 id）

### SymbolTable
- 字典编码：string → int

---

## 2. Query / Analytics

### 2.1 SQL 子集

- SELECT / FROM（单表 + JOIN）
- WHERE（括号优先级 + AND/OR/NOT；基础比较 + LIKE + IN）
- JOIN（INNER/LEFT；ON 目前支持等值 + AND 链）
- ORDER BY（列名 / alias / ordinal(ORDER BY 1) / 标量表达式；多 key 支持 ASC/DESC）
- LIMIT / OFFSET
- GROUP BY（基础聚合）
- HAVING（GROUP BY 后过滤；支持 alias/标量表达式条件）
- CTE / WITH（materialize 临时表）
- 子查询（FROM (SELECT ...) 派生表；WHERE col IN (SELECT ...)）
- CREATE TABLE / INSERT / UPSERT

### 2.2 标量表达式（SQLite/DuckDB 常用子集）

- 运算符：`+ - * / %`、括号
- 字符串拼接：`||`
- 常用函数：`ROUND/SQRT/ABS/LN/LOG/EXP/POW(MIN/MAX)`

### 2.2.1 聚合函数

**支持的聚合函数**：
- `COUNT(*)` / `COUNT(column)` - 统计行数
- `SUM(column)` - 求和
- `AVG(column)` - 平均值
- `MIN(column)` / `MAX(column)` - 最小/最大值
- `STDDEV(column)` / `VARIANCE(column)` - 标准差/方差
- `FIRST(column)` / `LAST(column)` - 首/末值

**使用场景**：
1. **GROUP BY 聚合**：`SELECT symbol, AVG(close) FROM ticks GROUP BY symbol`
2. **整体聚合**（v0.9.3.10 新增）：`SELECT AVG(close), SUM(volume) FROM ticks`
   - 无 GROUP BY 时，自动将所有行作为一个组进行聚合
   - 返回单行结果

### 2.3 窗口函数

支持 `... OVER (PARTITION BY ... ORDER BY ... ROWS BETWEEN N PRECEDING AND CURRENT ROW)`：
- `STDDEV/VARIANCE`
- `COUNT/SUM/AVG/MIN/MAX`
- `ROW_NUMBER`

#### Inline Window
- 支持表达式中嵌套窗口函数，例如：
  - `STDDEV(close) OVER (...) / price * 100`

#### PARTITION BY fast-path
- 专门优化模式：`CTE + PARTITION BY + ROW_NUMBER + WHERE rn = 1`
- 用于“每分区只取最后一行 + 多个窗口指标”的典型时序报表场景

---

## 3. Time-series Extensions

- `sampleBy()` / `ohlcv()`
- `latestOn()`
- `movingAverage()` / `exponentialMovingAverage()` / `rollingStdDev()`

---

## 4. Native Acceleration (libndts)

- 可选 native 加速（8 平台预编译）
- 自动 JS fallback（无原生库/非 Bun 环境也可运行）

---

## 5. Index（索引）

- **BTree 索引**：数值列（timestamp/price 等）范围查询加速
- **复合索引**：多列组合查询加速（如 (symbol, timestamp) 或 (region, city, timestamp)）
  - 嵌套 Map + BTree 结构（支持 N 列）
  - 支持前缀精确匹配 + 最后一列范围查询
  - 自动维护（appendBatch 时更新）
- **SQL 自动优化**：WHERE 条件自动使用索引（> / < / >= / <= / =）
  - N 列复合索引前缀匹配（如 WHERE a='x' AND b='y' AND c>=100 自动使用 (a,b,c) 索引）
  - 最优索引选择（多个索引可用时，选择匹配列数最多的）
- **API**：
  - 单列：createIndex / dropIndex / queryIndex / hasIndex
  - 复合：createCompositeIndex / dropCompositeIndex / queryCompositeIndex / hasCompositeIndex
