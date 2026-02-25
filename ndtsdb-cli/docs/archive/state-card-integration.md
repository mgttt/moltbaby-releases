# State-Card-Watchdog 对接 Mem-Find 设计方案

**版本**: v1.0  
**日期**: 2026-02-23  
**作者**: bot-00d  
**状态**: 设计阶段，等待 c号 mem-find 工具完成

---

## 1. 现有 State-Card-Watchdog 工作流分析

### 1.1 当前架构

```
state-card-watchdog (每5分钟)
    │
    ├─ 扫描 ~/.openclaw/agents/{agent}/sessions/*.jsonl
    ├─ 计算 session hash，检测变化
    ├─ 有变化? ──→ 调用 Gemini LLM 生成 Markdown
    │               │
    │               └─ 输出:
    │                   ├─ ~/moltbaby/MEMORY-{agentId}.md (主状态卡)
    │                   └─ ~/.openclaw/agents/{agent}/sessions/{sid}.jsonl.state.json
    │                      { context: <markdown>, generatedAt, version, source }
    │
    └─ 无变化 → 跳过
```

### 1.2 Facts 注入位置（当前）

| 位置 | 格式 | 用途 |
|------|------|------|
| `MEMORY-{agentId}.md` | Markdown | 人工可读，OpenClaw 加载 |
| `.state.json` | JSON `{ context: string }` | 旧版 OpenClaw context grooming |

**问题**: 当前 state card 是"全量摘要"，不包含基于查询的精准 facts 检索。

---

## 2. 触发时机：每次 Watchdog Tick 调用 Mem-Find

### 2.1 触发点设计

```
state-card-watchdog tick
    │
    ├─ 原有逻辑: 检测 session 变化
    │
    └─ 【新增】语义检索增强
            │
            ├─ 构建查询上下文 (从 session 提取关键词)
            ├─ 调用 mem-find --query <context> --db <knowledge-db>
            ├─ 获取 Top-K 相关 facts
            └─ 将 facts 注入 state card
```

### 2.2 查询上下文生成策略

从 session 最近消息提取：
- 用户最近 3 条消息关键词
- Assistant 最近回复中的问题/待办
- 当前任务标签 (P0/P1/P2)

```typescript
function buildQueryContext(session: Session): string {
  const recentUserMsgs = extractUserMessages(session, 3);
  const pendingQuestions = extractQuestions(session.lastAssistantReply);
  const taskPriority = detectPriority(session);
  
  return `${taskPriority} ${recentUserMsgs.join(" ")} ${pendingQuestions.join(" ")}`;
}
```

---

## 3. 注入方式：State.json 字段设计

### 3.1 新字段: `semanticFacts`

```json
{
  "context": "<原有 markdown 摘要>",
  "semanticFacts": [
    {
      "score": 0.92,
      "agent_id": "bot-001",
      "type": "semantic",
      "content": "gales-neutral策略回撤监控要点...",
      "timestamp": 1700000000000,
      "confidence": 0.9,
      "queriedAt": "2026-02-23T14:30:00Z"
    }
  ],
  "generatedAt": "2026-02-23T14:30:00Z",
  "version": "v2-with-mem-find",
  "source": "state-card-watchdog+mem-find"
}
```

### 3.2 MEMORY-{agentId}.md 追加格式

```markdown
## Semantic Context (auto-injected)
- **[92%] bot-001/semantic**: gales-neutral策略回撤监控要点...
- **[88%] shared/semantic**: 中性网格策略的回撤监控应基于资金而非仓位...

*Queried at: 2026-02-23 14:30:00*
```

---

## 4. 性能考虑：缓存策略

### 4.1 问题：Embedding API 调用成本

- Gemini Embedding API: 免费但有限额
- 每 tick 都调用 → 5分钟×12小时 = 144次/天/ agent
- 10个 agent → 1440次/天

### 4.2 三级缓存策略

```
┌─────────────────────────────────────────────────────────────┐
│  L1: Query Context Cache (内存)                              │
│  - Key: hash(最近3条用户消息)                                 │
│  - TTL: 10分钟                                               │
│  - 命中率预期: 60% (用户连续追问同一话题)                      │
├─────────────────────────────────────────────────────────────┤
│  L2: Embedding Result Cache (文件)                           │
│  - Key: hash(queryText)                                      │
│  - TTL: 30分钟                                               │
│  - 存储: ~/.cache/state-card-watchdog/embeddings.json        │
├─────────────────────────────────────────────────────────────┤
│  L3: Facts Cache (ndtsdb层)                                  │
│  - ndtsdb 本身的查询结果缓存                                 │
│  - 由 ndtsdb-cli 实现                                        │
└─────────────────────────────────────────────────────────────┘
```

### 4.3 降级策略

```typescript
async function getSemanticFacts(query: string): Promise<Fact[]> {
  // L1 检查
  const cached = l1Cache.get(hash(query));
  if (cached && !isExpired(cached, 10*MINUTE)) return cached;
  
  // L2 检查
  const embedded = l2Cache.get(hash(query));
  if (embedded && !isExpired(embedded, 30*MINUTE)) {
    return queryVectors(embedded.vector); // 跳过 embedding API
  }
  
  // 调用 mem-find
  try {
    const facts = await callMemFind(query);
    
    // 更新缓存
    l1Cache.set(hash(query), facts);
    l2Cache.set(hash(query), { vector: facts.queryVector, facts });
    
    return facts;
  } catch (e) {
    // 降级: 返回过期缓存或空数组
    log.warn("mem-find failed, using stale cache");
    return cached || embedded?.facts || [];
  }
}
```

---

## 5. 参考现有模式

### 5.1 Context-Reset-Watchdog 模式

| 特性 | Context-Reset | State-Card+Mem-Find |
|------|---------------|---------------------|
| 触发频率 | 3分钟 | 5分钟 (可共用) |
| 数据源 | `openclaw sessions list` | session.jsonl + ndtsdb |
| 输出动作 | `tg send` prompt + `/reset` | 写 `.state.json` + `.md` |
| 状态文件 | `~/.openclaw/context-reset-watchdog.json` | 复用或新建 |

**借鉴**: 使用状态文件记录上次触发时间，避免重复处理。

### 5.2 Catfish-Watchdog 模式

| 特性 | Catfish | State-Card+Mem-Find |
|------|---------|---------------------|
| 触发频率 | 30分钟 | 5分钟 |
| 通知对象 | 0/1/6号 (tg send) | Agent state card (文件) |
| 状态管理 | `~/.cache/catfish-watchdog/state.json` | 复用或合并 |
| 冷却策略 | 按优先级不同冷却期 | 按查询 context hash 冷却 |

**借鉴**: 使用文件状态持久化，支持跨进程恢复。

---

## 6. 实现步骤

### Phase 1: 基础对接 (c号完成后)

1. [ ] 在 `state-card-watchdog.ts` 添加 mem-find 调用模块
2. [ ] 实现 query context 生成逻辑
3. [ ] 实现 `.state.json` 的 `semanticFacts` 字段写入
4. [ ] 实现 `MEMORY-{agentId}.md` 的 facts 追加

### Phase 2: 性能优化

5. [ ] 实现 L1/L2 缓存层
6. [ ] 添加 embedding API 失败降级
7. [ ] 添加缓存命中率监控日志

### Phase 3: 集成测试

8. [ ] 编写 `test-state-card-mem-find.sh`
9. [ ] 验证缓存有效性
10. [ ] 端到端验收 (session → facts → state card)

---

## 7. 文件变更计划

```
tools/
├── mem-find/                    # c号负责
│   └── index.ts                 # 已完成: 基础语义检索
│
├── state-card-watchdog/         # 本方案实施后
│   ├── index.ts                 # 修改: 集成 mem-find 调用
│   ├── context-builder.ts       # 新增: query context 生成
│   ├── cache.ts                 # 新增: L1/L2 缓存实现
│   └── integration.test.ts      # 新增: 集成测试
│
└── mem-find/
    └── state-card-integration.md  # 本文件
```

---

## 8. 待决策问题

| 问题 | 建议方案 | 决策人 |
|------|----------|--------|
| Knowledge DB 路径? | `~/knowledge` 或 `./knowledge` | c号/6号 |
| 每个 agent 独立 DB? | 共用全局 DB，按 agent_id 分区 | c号 |
| Embedding 维度? | 768 (Gemini text-embedding-004) | 已定 |
| 缓存 TTL? | L1:10min, L2:30min | 可调整 |
| 是否启用? | 默认启用，可 `--no-mem-find` 禁用 | 6号 |

---

## 附录: 接口约定

### mem-find CLI 接口 (已定)

```bash
bun tools/mem-find/index.ts \
  --query "交易系统回撤监控" \
  --db ./knowledge \
  --top 5 \
  --threshold 0.7
```

**输出格式** (JSON):
```json
[
  {
    "score": 0.92,
    "agent_id": "bot-001",
    "type": "semantic",
    "content": "...",
    "timestamp": 1700000000000,
    "confidence": 0.9
  }
]
```

### state-card-watchdog 调用示例

```typescript
import { findSemanticFacts } from "./mem-find-client";

// 在 tick 中
const context = buildQueryContext(session);
const facts = await findSemanticFacts(context, {
  dbPath: "~/knowledge",
  topK: 3,
  threshold: 0.75,
  cacheTtl: 10 * 60 * 1000, // 10分钟
});

// 注入 state
state.semanticFacts = facts.map(f => ({
  ...f,
  queriedAt: new Date().toISOString(),
}));
```
