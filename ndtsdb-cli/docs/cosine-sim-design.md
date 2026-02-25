# COSINE_SIM SQL 函数设计文档

**版本**: v0.1-draft  
**作者**: c号  
**日期**: 2026-02-23  
**状态**: M2 预研

---

## 1. SQL 语法设计

### 1.1 基础用法

```sql
SELECT * FROM vectors 
WHERE COSINE_SIM(embedding, [0.1, 0.2, 0.3, ...]) > 0.8
```

**参数**:
- `embedding`: 字段名（VectorRecord.embedding）
- `[0.1, 0.2, ...]`: 查询向量（JavaScript 数组字面量）
- `> 0.8`: 阈值条件（支持 `>`, `>=`, `<`, `<=`, `=`）

### 1.2 扩展用法

```sql
-- 返回相似度值
SELECT timestamp, agent_id, 
       COSINE_SIM(embedding, [0.1, 0.2]) AS similarity
FROM vectors
WHERE similarity > 0.8
ORDER BY similarity DESC
LIMIT 10
```

```sql
-- 结合时间过滤
SELECT * FROM vectors
WHERE timestamp >= 1700000000000
  AND COSINE_SIM(embedding, [0.1, 0.2]) > 0.9
```

### 1.3 语法约束

- `COSINE_SIM()` 只能用于 WHERE 子句或 SELECT 投影
- 查询向量必须是常量数组（不支持字段引用，如 `COSINE_SIM(a.emb, b.emb)`）
- 维度自动检测（查询向量维度必须匹配记录 embedding_dim）
- 返回值范围 `[-1, 1]`（cosine 距离），实际语义向量通常 `[0, 1]`

---

## 2. 现有 SQL Engine 扩展点分析

### 2.1 当前执行流程（cmd_sql.c）

```
[SQL 字符串]
    ↓
parseSQL(sql)  ← 解析为 AST（纯 JS，运行在 QuickJS）
    ↓
ndtsdb.query*()  ← 调用 C 层 native API 获取数据
    ↓
applyWhere()  ← JS 层过滤（BETWEEN/IN/LIKE/OR/NOT）
    ↓
executeAggregation()  ← 聚合（COUNT/SUM/AVG/...）
    ↓
filterFields()  ← 字段投影
    ↓
executeOrderBy() + LIMIT/OFFSET
    ↓
[输出 JSON/CSV]
```

### 2.2 扩展点定位

**方案 A: 在 `applyWhere()` 中注入 COSINE_SIM 过滤**

修改位置: `cmd_sql.c` 第 201 行 `function applyWhere(data, filter, whereClause)`

```javascript
// 新增 filter.type === 'COSINE_SIM'
if (filter.type === 'COSINE_SIM') {
    const { field, query_vector, threshold, operator } = filter;
    return data.filter(row => {
        const sim = cosine_sim(row[field], query_vector);
        return operator === '>' ? sim > threshold :
               operator === '>=' ? sim >= threshold :
               operator === '<' ? sim < threshold :
               operator === '<=' ? sim <= threshold :
               sim === threshold;
    });
}
```

**方案 B: parseSQL 解析 COSINE_SIM() 为特殊 filter**

修改位置: `cmd_sql.c` 第 82 行 `function parseSQL(sql)`

在 WHERE 子句解析时检测 `COSINE_SIM()` 函数调用，提取参数并存入 `parsed.where.filter`：

```javascript
const cosineMatch = whereClause.match(
    /COSINE_SIM\s*\(\s*(\w+)\s*,\s*\[([^\]]+)\]\s*\)\s*([><=]+)\s*([\d.]+)/i
);
if (cosineMatch) {
    result.where.filter = {
        type: 'COSINE_SIM',
        field: cosineMatch[1],  // 'embedding'
        query_vector: cosineMatch[2].split(',').map(x => parseFloat(x.trim())),
        operator: cosineMatch[3],  // '>', '>=', etc.
        threshold: parseFloat(cosineMatch[4])
    };
}
```

**推荐**: 方案 B（解析时提取）+ 方案 A（执行时过滤）组合。

### 2.3 需要新增的 JS 函数

在 `cmd_sql.c` SQL 脚本注入前添加：

```javascript
function cosine_sim(vec_a, vec_b) {
    if (!vec_a || !vec_b) return 0;
    if (vec_a.length !== vec_b.length) return 0;
    let dot = 0, norm_a = 0, norm_b = 0;
    for (let i = 0; i < vec_a.length; i++) {
        dot += vec_a[i] * vec_b[i];
        norm_a += vec_a[i] * vec_a[i];
        norm_b += vec_b[i] * vec_b[i];
    }
    if (norm_a === 0 || norm_b === 0) return 0;
    return dot / (Math.sqrt(norm_a) * Math.sqrt(norm_b));
}
```

### 2.4 Native C 层接口（已就绪）

d号正在对接的 M1-B 将暴露：
```javascript
// 在 QuickJS 中可用
import * as ndtsdb from 'ndtsdb';
const vectors = ndtsdb.queryVectors(db, 'BTC', '1m');
// 返回: [{ timestamp, agent_id, type, confidence, embedding: [0.1, 0.2, ...] }]
```

SQL 引擎需要区分查询目标：
- `FROM klines` → 调用 `ndtsdb.query*()`
- `FROM vectors` → 调用 `ndtsdb.queryVectors()`

**扩展点**: `parseSQL()` 中解析 `FROM` 子句，根据表名路由不同的 native API。

---

## 3. 暴力扫描算法

### 3.1 伪代码

```javascript
function bruteforce_cosine_search(db, symbol, interval, query_vec, threshold) {
    // 1. 读取所有 VectorRecord（C 层）
    const records = ndtsdb.queryVectors(db, symbol, interval);
    
    // 2. 计算相似度并过滤
    const results = [];
    for (const rec of records) {
        const sim = cosine_sim(rec.embedding, query_vec);
        if (sim > threshold) {
            results.push({ ...rec, similarity: sim });
        }
    }
    
    // 3. 排序（可选）
    results.sort((a, b) => b.similarity - a.similarity);
    
    return results;
}
```

### 3.2 复杂度分析

- **时间**: `O(N × D)` 其中 `N` = 记录数，`D` = embedding 维度
  - 每条记录：点积 `D` 次乘法，`D` 次加法，2 次开方，1 次除法
  - 总计：`N × (3D + 3)` 次浮点运算

- **空间**: `O(N × D)` （存储所有 embedding 在内存）

### 3.3 优化点

1. **Early stopping**: 阈值过滤后立即丢弃，不累积低分结果
2. **SIMD**: 在 C 层用 AVX2/SSE 加速点积计算（QuickJS 中无法使用）
3. **Batch norm cache**: 预计算每个 embedding 的模长（存储在 VectorRecord.flags 中）

---

## 4. 性能预估

### 4.1 测试场景

- **数据规模**: 10,000 条 VectorRecord
- **Embedding 维度**: 768 (BERT/Sentence-BERT 标准)
- **查询阈值**: 0.8
- **硬件**: Intel i7 (3.5 GHz, AVX2)

### 4.2 计算量估算

- 单次 cosine 计算：`768 × 3 + 3 = 2307` 次浮点运算
- 总计算量：`10,000 × 2307 = 23,070,000` 次运算

### 4.3 耗时预估

**纯 JS (QuickJS) 实现**:
- QuickJS 性能约为 V8 的 1/10
- 估算：`23M ops / (3.5 GHz × 0.1 效率) ≈ 66 ms`

**C 层实现（AVX2 优化后）**:
- AVX2 可同时处理 8 个 float32（256-bit）
- 点积加速：`768 / 8 = 96` 次 SIMD 指令
- 总耗时：`10,000 × 96 × 4 cycles / 3.5 GHz ≈ 1.1 ms`

**实测参考** (OpenAI CLIP):
- 10K × 512D embedding 暴力扫描：~5ms (C++ + AVX2)
- 结论：768D × 10K 在 **10ms 级别可接受**

### 4.4 瓶颈分析

| 环节 | 耗时占比 | 优化方向 |
|------|---------|---------|
| 读取 VectorRecord（C → JS） | 30% | 减少跨语言拷贝，使用 ArrayBuffer 共享内存 |
| Cosine 计算（JS 循环） | 60% | 移至 C 层，用 SIMD 加速 |
| 结果过滤/排序（JS） | 10% | JS 层足够快 |

**优化建议**: 在 C 层实现 `ndtsdb_cosine_search()` 直接返回过滤后的结果，避免传输所有 embedding 到 JS。

---

## 5. HNSW 索引预留接口

### 5.1 为什么需要 HNSW

暴力扫描在 **N < 100K** 时可接受，但向量数据库通常需要支持：
- 百万级 embedding 检索
- 亚秒级查询响应（< 50ms）

**HNSW** (Hierarchical Navigable Small World):
- 时间复杂度：`O(log N)` (近似)
- 空间复杂度：`O(N × M)` (M 为邻居数，通常 16-32)
- 插入时间：`O(M × log N)`

### 5.2 预留接口设计

```c
/* ndtsdb_vector.h */

/**
 * HNSWIndex — HNSW 索引句柄（不透明类型）
 */
typedef struct HNSWIndex HNSWIndex;

/**
 * ndtsdb_build_hnsw_index — 为现有 VectorRecord 构建 HNSW 索引
 *
 * @param db           数据库句柄
 * @param symbol       分区 symbol
 * @param interval     分区 interval
 * @param M            邻居数（推荐 16）
 * @param ef_construct 构建参数（推荐 200）
 * @return             HNSWIndex* (堆分配)，失败返回 NULL
 */
HNSWIndex* ndtsdb_build_hnsw_index(NDTSDB* db,
                                   const char* symbol,
                                   const char* interval,
                                   int M,
                                   int ef_construct);

/**
 * ndtsdb_hnsw_search — 基于 HNSW 索引的 K-NN 搜索
 *
 * @param index        HNSW 索引句柄
 * @param query_vec    查询向量
 * @param dim          向量维度
 * @param k            返回 Top-K 结果
 * @param ef_search    搜索精度（推荐 50-200）
 * @return             VectorQueryResult*（按相似度降序）
 */
VectorQueryResult* ndtsdb_hnsw_search(HNSWIndex* index,
                                      const float* query_vec,
                                      int dim,
                                      int k,
                                      int ef_search);

/**
 * ndtsdb_free_hnsw_index — 释放 HNSW 索引
 */
void ndtsdb_free_hnsw_index(HNSWIndex* index);
```

### 5.3 SQL 语法扩展（未来）

```sql
-- 自动使用 HNSW 索引（如果存在）
SELECT * FROM vectors
WHERE COSINE_SIM(embedding, [...]) > 0.8
ORDER BY similarity DESC
LIMIT 10
WITH INDEX hnsw;  -- 可选：显式指定索引

-- 创建索引（DDL 扩展）
CREATE INDEX hnsw_idx ON vectors(embedding)
USING HNSW (M=16, ef_construct=200);
```

### 5.4 实现优先级

1. **M2 (本期)**: 暴力扫描，验证语法和 API
2. **M3**: C 层 SIMD 优化 cosine 计算
3. **M4**: HNSW 索引（引入 hnswlib 或自实现）
4. **M5**: 索引持久化（.ndti 文件）

---

## 6. 实现路线图

### Phase 1: M2 验证（本期）
- [ ] `parseSQL()` 解析 `COSINE_SIM()`
- [ ] `applyWhere()` 支持 COSINE_SIM 过滤
- [ ] 编写测试：10条记录 × 4D embedding
- [ ] 性能测试：1000条 × 128D

### Phase 2: M3 优化
- [ ] C 层实现 `ndtsdb_cosine_search()`
- [ ] AVX2/NEON SIMD 加速
- [ ] Benchmark: 10K × 768D < 10ms

### Phase 3: M4 索引
- [ ] 集成 hnswlib (C++)
- [ ] 索引构建 API
- [ ] 索引持久化

### Phase 4: M5 生产化
- [ ] 自动索引选择（cost-based）
- [ ] 索引统计信息
- [ ] 并行搜索（多线程）

---

## 7. 风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| QuickJS 性能瓶颈 | 高 | 中 | 早期移至 C 层实现 |
| 维度不匹配错误 | 中 | 低 | 运行时检查 + 错误信息 |
| HNSW 集成复杂度 | 中 | 高 | 先用 hnswlib，避免自实现 |
| 索引持久化格式兼容 | 低 | 中 | 版本化 .ndti 文件 |

---

## 8. 参考资料

- [Efficient and robust approximate nearest neighbor search using Hierarchical Navigable Small World graphs](https://arxiv.org/abs/1603.09320)
- [hnswlib: Header-only C++ HNSW implementation](https://github.com/nmslib/hnswlib)
- [FAISS: A library for efficient similarity search](https://github.com/facebookresearch/faiss)
- [Sentence-BERT: 768D semantic embeddings](https://www.sbert.net/)

---

**下一步**: 等 d号完成 M1-B native 绑定后，基于本设计实现 M2 暴力扫描版本。
