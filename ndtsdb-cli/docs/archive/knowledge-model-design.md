# 知识记录模型设计 (M4)

> 基于 BotCorp Core Design 第 5.2 节，ndtsdb 作为统一知识引擎的详细设计

---

## 1. 多维知识记录 Schema

### 1.1 核心字段

| 字段 | 类型 | 说明 | 映射到 ndtsdb |
|------|------|------|---------------|
| `timestamp` | int64 | 毫秒 epoch，时间维度 | KlineRow.timestamp |
| `agent_id` | string(32) | 来源 agent，归属维度 | symbol |
| `type` | string(16) | 知识类型：semantic/episodic/procedural/antipattern | interval |
| `embedding[]` | float[] | 语义向量，维度 128-1536 | .ndtv 文件存储 |
| `confidence` | float | 可信度 [0.0, 1.0] | KlineRow.open |
| `references[]` | string[] | 关联记录 ID（因果链） | 扩展字段或单独表 |
| `access_count` | uint32 | 访问热度计数 | KlineRow.high (临时) |
| `decay_rate` | float | 遗忘曲线系数 | KlineRow.close (临时) |

### 1.2 完整 JSON 示例

```json
{
  "timestamp": 1700000000000,
  "agent_id": "bot-006",
  "type": "semantic",
  "confidence": 0.95,
  "embedding": [0.1, 0.2, 0.3, ..., 0.768],
  "content": "COSINE_SIM SQL 查询优化经验",
  "references": ["commit-abc123", "issue-456"],
  "access_count": 42,
  "decay_rate": 0.01,
  "tags": ["sql", "optimization", "vector"]
}
```

### 1.3 存储映射

```
ndtsdb/
├── <agent_id>__<type>.ndtv      # 向量数据（embedding 数组）
│   └── VectorRecord { timestamp, agent_id, type, confidence, embedding_dim, embedding[] }
├── YYYY-MM-DD.ndts              # KlineRow 标记行（索引作用）
│   └── KlineRow { timestamp, open=confidence, high=access_count, close=decay_rate, flags=0x01 }
└── <agent_id>__<type>.meta      # (可选) references/tags 扩展数据
```

---

## 2. 分区策略

### 2.1 分区设计

```
ndtsdb-data/
├── partition-bot-000/          # 0号私有知识
│   ├── bot-000__semantic.ndtv
│   ├── bot-000__episodic.ndtv
│   └── bot-000__procedural.ndtv
├── partition-bot-001/          # 1号私有知识
│   └── bot-001__semantic.ndtv
├── partition-bot-006/          # 6号私有知识
│   └── ...
├── partition-shared/           # 全局共享知识
│   ├── shared__semantic.ndtv   # 通用技巧
│   ├── shared__procedural.ndtv # 操作流程
│   └── shared__episodic.ndtv   # 重大事件
└── partition-antipattern/      # 反模式库（只读 + 审核写入）
    ├── antipattern__procedural.ndtv
    └── antipattern__semantic.ndtv
```

### 2.2 分区访问规则

| 操作 | 规则 | 实现 |
|------|------|------|
| 写入 | 只能写自己的 partition | ndtsdb_open("partition-bot-xxx") |
| 读取 | 可读所有 partition | 遍历所有分区目录，union 查询 |
| 共享 | 显式写入 partition-shared | 需要审批或高 confidence |
| 反模式 | 只读，审核后写入 | 独立权限控制 |

### 2.3 分区路由

```c
// 根据 agent_id 确定分区路径
const char* get_partition_path(const char* agent_id) {
    if (strcmp(agent_id, "shared") == 0) return "partition-shared";
    if (strcmp(agent_id, "antipattern") == 0) return "partition-antipattern";
    static char path[64];
    snprintf(path, sizeof(path), "partition-%s", agent_id);
    return path;
}
```

---

## 3. facts/*.md 导入方案

### 3.1 现有 facts 结构

```
memory/facts/
├── shared.md           # 全局共享知识
├── bot-000.md          # 0号私有
├── bot-001.md
├── ...
└── antipattern.md      # 反模式
```

### 3.2 导入流程

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  解析 .md 文件   │────▶│  生成 embedding  │────▶│  写入 ndtsdb    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
   - 按语义块分割          - 调用 embedding API     - 分区路由
   - 提取 tags/refs        - 1536 维向量            - 双写 ndtv + ndts
   - 识别 agent_id         - 批量生成               - 更新索引
```

### 3.3 导入工具设计

```bash
# 一次性导入
ndtsdb-cli import-facts --from memory/facts/ --to ndtsdb-data/

# 增量同步（对比 mtime）
ndtsdb-cli sync-facts --from memory/facts/ --to ndtsdb-data/ --incremental
```

### 3.4 解析规则

| 标记 | 语义 | 处理 |
|------|------|------|
| `type: semantic` | 知识类型 | 映射到 interval |
| `agent: bot-006` | 来源 | 映射到 agent_id/symbol |
| `refs: [abc, def]` | 关联 | 存入 references 字段 |
| `confidence: 0.9` | 可信度 | 映射到 confidence |
| `tags: [sql, opt]` | 标签 | 辅助 embedding 生成 |

---

## 4. 查询场景举例

### 4.1 按相似度查询（核心场景）

```sql
-- 查找与当前问题最相关的历史经验
SELECT * FROM semantic 
WHERE agent_id = 'bot-006' 
  AND COSINE_SIM(embedding, [0.1, 0.2, ...]) > 0.85
ORDER BY confidence DESC, access_count DESC
LIMIT 5;
```

### 4.2 按 agent 查询

```bash
# 查询 bot-006 的所有 procedural 知识
ndtsdb-cli query --database partition-bot-006 --agent bot-006 --type procedural
```

### 4.3 按时间范围查询

```sql
-- 最近 7 天的 episodic 记忆
SELECT * FROM episodic 
WHERE timestamp > NOW() - 7*24*3600*1000
ORDER BY timestamp DESC;
```

### 4.4 按类型查询

```bash
# 查询所有反模式
ndtsdb-cli query --database partition-antipattern --type procedural
```

### 4.5 复合查询（热度 + 相似度）

```sql
-- 高置信度且热度高的相关知识
SELECT * FROM semantic 
WHERE COSINE_SIM(embedding, $query_vec) > 0.8
  AND confidence > 0.9
  AND access_count > 10
ORDER BY COSINE_SIM(embedding, $query_vec) * confidence DESC;
```

### 4.6 因果链追踪

```sql
-- 根据 references 字段追踪关联
SELECT * FROM semantic 
WHERE agent_id = 'bot-006' 
  AND references CONTAINS 'commit-abc123';
```

---

## 5. 与 mem-save/mem-sleep 集成

### 5.1 现有 mem-save 流程

```
对话内容 ──▶ LLM 提炼 ──▶ JSON 格式 ──▶ facts/*.md 写入
```

### 5.2 集成 ndtsdb 后的新流程

```
对话内容 ──▶ LLM 提炼 ──▶ JSON 格式 ──▶ ┬─▶ facts/*.md (兼容现有)
                                       └─▶ ndtsdb (实时检索)
                                            ├─▶ 生成 embedding
                                            ├─▶ 分区路由
                                            └─▶ 双写 ndtv + ndts
```

### 5.3 mem-save 增强

```typescript
// tools/mem-save/index.ts 增强
async function saveFact(fact: Fact) {
    // 1. 写入原有 .md (兼容)
    await writeToMd(fact);
    
    // 2. 写入 ndtsdb (实时)
    const embedding = await generateEmbedding(fact.content);
    await ndtsdbInsert({
        timestamp: fact.timestamp,
        agent_id: fact.agent_id,
        type: fact.type,
        confidence: fact.confidence,
        embedding: embedding,
        references: fact.references,
        access_count: 0,
        decay_rate: 0.01
    });
}
```

### 5.4 mem-sleep 增强

```typescript
// tools/mem-sleep/index.ts 增强
async function pruneFacts() {
    // 原有：基于时间的 .md 归档
    await archiveOldMdFiles();
    
    // 新增：基于 decay_rate 的 ndtsdb 清理
    const cutoff = Date.now() - 30*24*3600*1000; // 30天
    const lowConfidence = await ndtsdbQuery(`
        SELECT * FROM semantic 
        WHERE timestamp < ${cutoff} 
          AND access_count < 5
          AND confidence < 0.7
    `);
    
    for (const fact of lowConfidence) {
        await ndtsdbDelete(fact);
    }
}
```

### 5.5 双写一致性

| 阶段 | 策略 |
|------|------|
| Phase 1 | 主写 .md，异步同步到 ndtsdb |
| Phase 2 | 主写 ndtsdb，定期导出到 .md |
| Phase 3 | 只写 ndtsdb，.md 仅用于人工审阅 |

---

## 6. 索引与性能优化

### 6.1 当前索引

| 维度 | 索引 | 说明 |
|------|------|------|
| 时间 | KlineRow.timestamp | 原生有序 |
| agent | symbol | 分区隔离 |
| type | interval | 二级分区 |
| 向量 | 无（暴力扫描）| 依赖 COSINE_SIM 函数 |

### 6.2 未来优化

- **HNSW 索引**：大规模向量加速（Phase 3）
- **时间分区**：按天/月自动分片
- **热度缓存**：高频访问记录常驻内存

---

## 7. 实施路线图

| 阶段 | 任务 | 工期 | 依赖 |
|------|------|------|------|
| Phase 1 | facts/*.md → ndtsdb 导入工具 | 1d | M3-P1 完成 |
| Phase 2 | mem-save 双写改造 | 1d | Phase 1 |
| Phase 3 | mem-sleep ndtsdb 清理 | 0.5d | Phase 2 |
| Phase 4 | 查询工具（按相似度/按 agent） | 1d | Phase 3 |
| Phase 5 | 反模式自动提炼流水线 | 2d | Phase 4 |

---

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| embedding 生成延迟 | mem-save 变慢 | 异步队列，不阻塞主流程 |
| ndtsdb 写入失败 | 知识丢失 | 失败回退到 .md，告警重试 |
| 向量维度不匹配 | 查询失败 | 严格校验，拒绝非法维度 |
| 分区磁盘满 | 写入失败 | 监控告警，自动清理冷数据 |

---

## 9. 结论

本设计将 BotCorp 的知识管理从文件系统升级到 ndtsdb 向量数据库：

1. **多维 schema**：时间 + 来源 + 类型 + 语义 + 可信度 + 关联
2. **分区隔离**：私有/共享/反模式，权限清晰
3. **平滑迁移**：facts/*.md 导入 + 双写兼容
4. **丰富查询**：相似度、时间、agent、类型多维度

下一步：实施 Phase 1（导入工具开发）
