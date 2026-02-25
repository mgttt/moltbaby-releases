# KNOWLEDGE.md — 知识库系统文档

> 本文档描述 BotCorp 知识库系统的完整架构：`mem-*` 工具链、`ndtsdb-cli` 向量存储后端、Embedding 方案及切换指南。

---

## 目录

1. [架构概览](#架构概览)
2. [工具链速查](#工具链速查)
3. [ndtsdb-cli facts 子命令](#ndtsdb-cli-facts-子命令)
4. [Embedding 方案](#embedding-方案)
5. [去重策略](#去重策略)
6. [切换 Embedding 方案](#切换-embedding-方案)
7. [数据文件布局](#数据文件布局)
8. [环境变量](#环境变量)
9. [常见问题](#常见问题)

---

## 架构概览

```
Agent (bot-xxx)
    │
    ├─ mem-save  ──→  Google Gemini Embedding API  ──→  float[512]
    │                                                        │
    │                                                  ndtsdb-cli facts write
    │                                                  ├── .ndtv (向量)
    │                                                  └── facts-text.jsonl (原文)
    │
    ├─ mem-find  ──→  Google Gemini Embedding API  ──→  float[512]  (query)
    │                                                        │
    │                                                  ndtsdb-cli facts search (余弦相似度)
    │                                                        │
    │                                               返回 [{rank, similarity, text, ...}]
    │
    └─ mem-clean ──→  直接操作 facts-text.jsonl (去重/清洗)
                      --vacuum: 重新生成所有向量
```

**关键设计决策**：
- `ndtsdb-cli` 是纯 C 的 APE（跨平台可执行）二进制，负责向量存储和余弦相似度检索
- Embedding 生成在 **TS 层**（`mem-save`/`mem-find`）进行，通过 `--embed-vector` / `--query-vector` 传给 ndtsdb-cli
- C 层的内置 TF-IDF（`cmd_embed.c`）**仅作 fallback**，正式使用不走这条路
- 原文存储在 `facts-text.jsonl` sidecar，向量存储在 `.ndtv` 文件

---

## 工具链速查

| 工具 | 路径 | 功能 |
|------|------|------|
| `mem-save` | `tools/mem-save/index.ts` | 写入知识（去重、调 Gemini 生成向量） |
| `mem-find` | `tools/mem-find/index.ts` | 语义搜索（调 Gemini 生成 query 向量） |
| `mem-clean` | `tools/mem-clean/index.ts` | 清洗知识库（去重、清过期、全量重建） |
| `mem-recall` | `tools/mem-recall/index.ts` | 恢复上一段 session 的任务上下文 |
| `mem-sleep` | `tools/mem-sleep/index.ts` | 夜间整理（episodic → semantic 提炼） |
| `ndtsdb-cli.com` | `ndtsdb-cli/ndtsdb-cli.com` | APE 后端（向量存储/检索） |

### mem-save 常用命令

```bash
# 单条写入
bun tools/mem-save/index.ts --text "内容" --type semantic --validity mutable --scope bot-006 --key my-key

# 批量写入（JSON array from stdin）
echo '[{"text":"...","agent_id":"bot-006","type":"semantic","validity":"mutable","scope":"bot-006"}]' \
  | bun tools/mem-save/index.ts --batch

# 查看知识库内容
bun tools/mem-save/index.ts --list

# 环境检查
bun tools/mem-save/index.ts --test
```

### mem-find 常用命令

```bash
# 语义搜索
bun tools/mem-find/index.ts --query "gales策略实盘"

# 指定返回条数和阈值
bun tools/mem-find/index.ts --query "API错误处理" --top-k 10 --threshold 0.5

# 按 agent 过滤
bun tools/mem-find/index.ts --query "交易策略" --agent-id bot-001

# JSON 输出
bun tools/mem-find/index.ts --query "..." --json
```

### mem-clean 常用命令

```bash
# 统计现状
bun tools/mem-clean/index.ts --stats

# 去重（dry-run 预览）
bun tools/mem-clean/index.ts --dedup --dry-run
bun tools/mem-clean/index.ts --dedup

# 清除超过 7 天的 transient 条目
bun tools/mem-clean/index.ts --prune --transient-days 7

# 清除某 agent 的所有 transient
bun tools/mem-clean/index.ts --expire --agent-id bot-009

# 全量重建（dedup + 重新生成所有向量，耗时！）
bun tools/mem-clean/index.ts --vacuum --dry-run   # 先预览
bun tools/mem-clean/index.ts --vacuum
```

---

## ndtsdb-cli facts 子命令

```bash
# 写入（通常通过 mem-save 调用，不直接使用）
sh ndtsdb-cli.com facts write \
  --database ~/knowledge \
  --text "内容" \
  --agent-id bot-006 \
  --type semantic \
  --validity mutable \
  --scope bot-006 \
  --dim 512 \
  --embed-vector '[0.01,0.02,...]'   # 预计算向量，跳过 C 层 TF-IDF

# 搜索（通常通过 mem-find 调用）
sh ndtsdb-cli.com facts search \
  --database ~/knowledge \
  --query-vector '[0.01,0.02,...]' \
  --top-k 5 \
  --threshold 0.3 \
  --dim 512 \
  --json

# 列出所有条目
sh ndtsdb-cli.com facts list --database ~/knowledge

# 按 agent 列出
sh ndtsdb-cli.com facts list --database ~/knowledge --agent-id bot-006

# 批量导入 JSONL（compact format，无空格）
sh ndtsdb-cli.com facts import \
  --database ~/knowledge \
  --input /tmp/facts.jsonl \
  --dim 512
```

**重要**：APE 文件有 MZ 头，Linux 不能直接 execve，必须通过 `sh ndtsdb-cli.com` 调用。

---

## Embedding 方案

### 当前方案：Google Gemini Embedding API

| 属性 | 值 |
|------|-----|
| 模型 | `gemini-embedding-001` |
| 输出维度 | 3072（截断到 512 存储） |
| API 端点 | `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent` |
| Key 来源 | `~/env.jsonl` → `gemini@api.key` |
| 截断后归一化 | 是（L2 norm） |
| 成本 | 按 token 计费（当前账号 partnernetsoftware@gmail.com） |

**为什么截断 3072 → 512？**
ndtsdb-cli 的向量存储上限是 512 维（硬编码），Gemini 输出 3072 维。截断低维依然有效，因为 Gemini embedding 的高维分量信息密度递减，前 512 维已包含主要语义信息。L2 归一化后余弦相似度仍然可靠。

**实际搜索效果**（对比 TF-IDF 64 维）：
- TF-IDF：`gales策略实盘` → context-reset-watchdog 77.9%（无关）
- Gemini：`gales策略实盘` → gales实盘执行口径 86.4%（精准）

### Fallback：C 层 TF-IDF（已废弃用于正式场景）

`ndtsdb-cli/src/cmd_embed.c` 中内置 TF-IDF hash trick（MurmurHash3，支持中文 UTF-8 分词）。

**不再用于正式 Embedding 的原因**：
- TF-IDF 是词频统计，无法理解语义（"gales" vs "实盘" 词汇不重叠 → 无法匹配）
- 64 维哈希向量碰撞率高（不相关文本可能相似度 >75%）
- 无跨语言对齐能力

**仍保留 TF-IDF 的原因**：
- ndtsdb-cli `facts write` 不带 `--embed-vector` 时的最后 fallback（离线场景）
- `embed` 子命令仍可独立使用做轻量文本特征

---

## 去重策略

`mem-save` 写入前自动去重，**无需调用方手动处理**：

1. 启动时加载 `facts-text.jsonl` 构建内存索引（`Set<key>` + `Set<textHash>`）
2. 每次写入检查：
   - 有 `key` → 按 key 去重（相同 key 跳过）
   - 无 `key` → 按 text MD5 hash 去重（相同内容跳过）
3. 批量模式（`--batch`）在同一批内也做去重（先到先得）

**注意**：去重只在 **TS 层 + sidecar** 层面生效。ndtsdb-cli C 层不做去重（每次 write 都是新 insert）。

如果直接调 `sh ndtsdb-cli.com facts write` 跳过 mem-save，则不享受去重保护。

---

## 切换 Embedding 方案

**未来可能的替代方案**：

| 方案 | 优点 | 缺点 | 切换成本 |
|------|------|------|---------|
| Google Gemini（当前） | 质量好、中文强 | 按 token 付费、依赖外网 | — |
| Ollama 本地模型（如 nomic-embed-text） | 零成本、无外网依赖 | 需要 GPU/CPU 资源、dim=768 | 中 |
| OpenAI text-embedding-3-small | 质量好 | 付费、需要梯子 | 低 |
| BGE-M3（本地） | 多语言强、开源 | 需要 Python 环境 | 中 |

**切换步骤**（任何方案）：

1. 修改 `tools/mem-save/index.ts` 和 `tools/mem-find/index.ts` 中的 `getEmbedding()` 函数
2. 更新 `MEM_DIM`（如从 512 改为 768）
3. **必须对所有现有数据重新生成向量**（否则新旧向量不兼容）：
   ```bash
   # 用新方案重建知识库
   bun tools/mem-clean/index.ts --vacuum
   # vacuum 会：清除所有 .ndtv → 重新调 getEmbedding() → 重写所有向量
   ```
4. 更新本文档记录新方案

**⚠️ 重要**：不同 Embedding 模型的向量**不可混存**。混存会导致余弦相似度计算结果失去意义（向量空间不同）。切换前必须先 vacuum 全量重建。

---

## 数据文件布局

```
~/knowledge/                        ← KNOWLEDGE_DB
├── facts-text.jsonl                ← 原文 sidecar（每行一条 JSON）
│   格式: {"ts":1772026460,...,"text":"...","agent_id":"bot-006","type":"semantic","validity":"mutable","scope":"bot-006","key":""}
│
├── {scope}__{type}.ndtv            ← 向量文件（每个 scope+type 一个文件）
│   示例: bot-006__semantic.ndtv
│         shared__semantic.ndtv
│         bot-001__episodic.ndtv
│   格式: 二进制 float32 数组 + 元数据（timestamp, agent_id, confidence）
│
├── facts-text.jsonl.bak            ← mem-clean 操作前的自动备份
└── *.ndtv.vacuum-bak               ← --vacuum 前的备份
```

**facts-text.jsonl** 是检索的基础：
- `facts search` 返回 ts 列表 → 在 sidecar 中按 ts 线性查找 → 返回 text
- 如果 sidecar 条目被删除，即使 .ndtv 中还有向量，也不会出现在搜索结果中

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `KNOWLEDGE_DB` | `~/knowledge` | 知识库目录 |
| `WORKSPACE` | `/home/devali/moltbaby` | 项目根目录 |
| `NDTSDB_CLI` | `$WORKSPACE/ndtsdb-cli/ndtsdb-cli.com` | APE 二进制路径 |
| `MEM_DIM` | `512` | Embedding 维度（写入和搜索必须一致） |
| `GEMINI_API_KEY` | 从 `~/env.jsonl` 读取 | 覆盖 env.jsonl 中的 key |

---

## 常见问题

### Q: 搜索结果不相关，相似度虚高

**A**: 知识库中可能混有旧的 TF-IDF 向量（64 维）和新的 Gemini 向量（512 维）。维度不匹配时 ndtsdb-cli 会跳过该条目，但维度恰好相同的不同方案向量会产生无意义的相似度。

检查：
```bash
bun tools/mem-clean/index.ts --stats   # 看条目数
bun tools/mem-find/index.ts --test     # 验证 DIM 配置
```

解决：`bun tools/mem-clean/index.ts --vacuum` 全量重建。

### Q: vacuum 太慢（几百条 × API 调用）

**A**: 每条都要调 Gemini API，484 条约需 5-10 分钟。建议后台运行：
```bash
tmux new-session -d -s vacuum 'cd ~/moltbaby && bun tools/mem-clean/index.ts --vacuum 2>&1 | tee /tmp/vacuum.log'
tmux attach -t vacuum   # 查看进度
```

### Q: 写入时 "embed failed: Gemini API error 429"

**A**: API 限流。Gemini Embedding API 有 QPS 限制。可降低批量写入速度（在 `mem-save/index.ts` 的 batch 循环中加 sleep），或分批写入。

### Q: 重复 key 报错还是跳过？

**A**: 跳过（`action: "skipped"`），不报错，不计入失败数。

### Q: 直接调 ndtsdb-cli 写入的条目，mem-find 能搜到吗？

**A**: 能，但前提是 `--dim` 与 `MEM_DIM=512` 一致，且写入的向量是 Gemini 向量（不是 TF-IDF）。直接调时不经过 mem-save 去重，需自行保证不重复。

### Q: serve 子命令在哪？

**A**: 已禁用（`serve` 返回 error，不接受连接）。知识库通过 CLI 工具操作，不需要 HTTP server 模式。详见 `ndtsdb-cli/src/cmd_serve.c`。

---

## 历史记录

| 日期 | 变更 |
|------|------|
| 2026-02-21 | 初始：TF-IDF 64 维 embedding，mem-save/find 直接调 ndtsdb-cli |
| 2026-02-25 | 重构：换用 Google Gemini embedding-001（512 维截断），mem-save 加去重索引，mem-find 改用 --query-vector，新增 mem-clean 工具 |
