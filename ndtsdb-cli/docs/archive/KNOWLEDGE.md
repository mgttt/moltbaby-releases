# KNOWLEDGE.md — 知识库系统文档

> BotCorp 知识库系统完整参考：`mem-*` 工具链、`ndtsdb-cli` 向量存储后端、API 模型配置及切换指南。

---

## 目录

1. [架构概览](#架构概览)
2. [工具链速查](#工具链速查)
3. [API 模型配置](#api-模型配置)
4. [环境变量](#环境变量)
5. [ndtsdb-cli facts 子命令](#ndtsdb-cli-facts-子命令)
6. [去重策略](#去重策略)
7. [删除机制](#删除机制)
8. [切换模型](#切换模型)
9. [数据文件布局](#数据文件布局)
10. [常见问题](#常见问题)
11. [历史记录](#历史记录)

---

## 架构概览

```
Agent (bot-xxx)
    │
    ├─ mem-save  ──→  OpenRouter /v1/embeddings  ──→  float[1536]
    │                 (text-embedding-3-small)              │
    │                                               ndtsdb-cli facts write
    │                                               ├── .ndtv (向量文件)
    │                                               └── facts-text.jsonl (原文 sidecar)
    │
    ├─ mem-find  ──→  OpenRouter /v1/embeddings  ──→  float[1536]  (query)
    │                 (text-embedding-3-small)              │
    │                                               ndtsdb-cli facts search
    │                                               (余弦相似度，返回 top-k)
    │
    └─ mem-clean ──→  规则清理：直接操作 facts-text.jsonl
                      AI 清理：OpenRouter /v1/chat (gpt-4o-mini) 判断是否保留
                      --vacuum：重新生成所有向量（耗时）
```

**关键设计决策**：
- `ndtsdb-cli` 是纯 C 的 APE 二进制（跨平台），负责向量存储和余弦相似度检索，支持 dim ≤ 2048
- Embedding 生成在 **TS 层**进行，通过 `--embed-vector` / `--query-vector` 传给 ndtsdb-cli，绕过 C 层内置的 TF-IDF
- 原文存储在 `facts-text.jsonl` sidecar，向量存储在 `.ndtv` 文件
- 所有 API 调用统一走 **OpenRouter**，单一 key 管理，无 429 限流问题
- 公共 API 逻辑集中在 `tools/mem-shared/index.ts`，三个工具均 import 它

---

## 工具链速查

| 工具 | 路径 | 功能 |
|------|------|------|
| `mem-save` | `tools/mem-save/index.ts` | 写入知识（去重 + embedding 写入向量库） |
| `mem-find` | `tools/mem-find/index.ts` | 语义搜索（embedding 相似度检索） |
| `mem-clean` | `tools/mem-clean/index.ts` | 规则清洗 + AI 辅助裁剪 + 全量重建 |
| `mem-recall` | `tools/mem-recall/index.ts` | 恢复上一段 session 的任务上下文 |
| `mem-shared` | `tools/mem-shared/index.ts` | 公共模块（getEmbedding / callLLM / 配置） |
| `ndtsdb-cli.com` | `ndtsdb-cli/ndtsdb-cli.com` | APE 后端（向量存储/检索） |

### mem-save

```bash
# 单条写入
bun tools/mem-save/index.ts --text "内容" --type semantic --validity mutable \
  --scope bot-006 --agent-id bot-006 --key my-key

# 批量写入（JSON array from stdin）
echo '[{"text":"...","agent_id":"bot-006","type":"semantic","validity":"mutable","scope":"bot-006"}]' \
  | bun tools/mem-save/index.ts --batch

# 列出知识库内容
bun tools/mem-save/index.ts --list [--agent-id bot-006]

# 环境检查（验证 API key、ndtsdb-cli、去重索引）
bun tools/mem-save/index.ts --test
```

### mem-find

```bash
# 语义搜索
bun tools/mem-find/index.ts --query "gales策略实盘"

# 调整参数
bun tools/mem-find/index.ts --query "API错误处理" --top-k 10 --threshold 0.5

# 按 agent 过滤
bun tools/mem-find/index.ts --query "交易策略" --agent-id bot-001

# JSON 输出（供程序调用）
bun tools/mem-find/index.ts --query "..." --json

# 环境检查
bun tools/mem-find/index.ts --test
```

### mem-clean

```bash
# 统计知识库现状
bun tools/mem-clean/index.ts --stats

# 规则清洗（零 API 成本）
bun tools/mem-clean/index.ts --dedup [--dry-run]                   # 按 text hash 去重
bun tools/mem-clean/index.ts --prune [--transient-days 7]          # 清除超期 transient
bun tools/mem-clean/index.ts --expire [--agent-id bot-009]         # 清除全部 transient
bun tools/mem-clean/index.ts --vacuum [--dry-run]                  # 物理重建（耗时）

# AI 辅助清洗（调 gpt-4o-mini）
bun tools/mem-clean/index.ts --ai-prune [--agent-id bot-006] [--batch-size 20] [--dry-run]
bun tools/mem-clean/index.ts --consolidate [--agent-id bot-006] [--dry-run]
```

---

## API 模型配置

所有 API 调用走 **OpenRouter**，统一使用 `openrouter@api` key（`~/env.jsonl`）。

### 当前默认模型

| 用途 | 模型 | 价格 | 维度 |
|------|------|------|------|
| **Embedding**（mem-save / mem-find / vacuum） | `openai/text-embedding-3-small` | $0.02 / M token | 1536 |
| **LLM 文本判断**（mem-clean --ai-prune / --consolidate） | `openai/gpt-4o-mini` | $0.15 / M input token | — |

### 为什么选这两个

**text-embedding-3-small**：
- OpenRouter 有原生 `/v1/embeddings` 端点，与 OpenAI 兼容
- 中英文双语强，$0.02/M token（484 条历史数据约 $0.001）
- dim=1536，比之前 Google 截断 512 维更完整，语义更准确
- 走 OpenRouter 无 429 限流，稳定

**gpt-4o-mini**：
- JSON 模式稳定（`response_format: {type: "json_object"}`），不会出现 reasoning 模型的 content 空问题
- $0.15/M input，500 条 ai-prune 约 $0.01
- 中文理解良好，判断"这条知识是否有价值"准确率高

**被否决的候选**（供参考）：
- `z-ai/glm-4.7-flash`、`z-ai/glm-4.5-air:free`、`minimax/minimax-m2.5`：均为 reasoning 模型，content 字段永远空，无法用于 JSON 输出
- `Google gemini-embedding-001`：曾是 embedding 方案，偶发 429，且需要独立 Google API key
- `Google gemini-2.0-flash`：曾用于 ai-prune，同样偶发 429

---

## 环境变量

所有变量定义在 `tools/mem-shared/index.ts`，三个工具统一读取。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OPENROUTER_KEY` | 从 `~/env.jsonl` `openrouter@api.key` 读取 | OpenRouter API key |
| `EMBED_MODEL` | `openai/text-embedding-3-small` | Embedding 模型 |
| `LLM_MODEL` | `openai/gpt-4o-mini` | LLM 模型（ai-prune / consolidate） |
| `MEM_DIM` | `1536` | Embedding 维度（写入和搜索必须一致，0=不截断） |
| `OPENROUTER_BASE` | `https://openrouter.ai/api/v1` | API base URL |
| `KNOWLEDGE_DB` | `~/knowledge` | 知识库目录 |
| `WORKSPACE` | `/home/devali/moltbaby` | 项目根目录 |
| `NDTSDB_CLI` | `$WORKSPACE/ndtsdb-cli/ndtsdb-cli.com` | APE 二进制路径 |

---

## ndtsdb-cli facts 子命令

```bash
# 写入（通常通过 mem-save 调用）
sh ndtsdb-cli.com facts write \
  --database ~/knowledge \
  --text "内容" \
  --agent-id bot-006 \
  --type semantic \          # semantic | episodic | procedural
  --validity mutable \       # permanent | mutable | transient
  --scope bot-006 \
  --dim 1536 \
  --embed-vector '[0.01,0.02,...]'   # 预计算向量，跳过 C 层 TF-IDF
  [--key my-dedup-key]

# 搜索（通常通过 mem-find 调用）
sh ndtsdb-cli.com facts search \
  --database ~/knowledge \
  --query-vector '[0.01,0.02,...]' \
  --top-k 5 \
  --threshold 0.3 \
  --dim 1536 \
  --json

# 列出所有条目
sh ndtsdb-cli.com facts list --database ~/knowledge [--agent-id bot-006]

# 批量导入 JSONL（compact format，冒号后无空格）
sh ndtsdb-cli.com facts import \
  --database ~/knowledge \
  --input /tmp/facts.jsonl \
  --dim 1536
```

**重要**：APE 文件有 MZ 头，Linux 不能直接 execve，必须通过 `sh ndtsdb-cli.com` 调用。

当前 ndtsdb-cli 支持 `--dim` 范围：1 ~ 2048。

---

## 去重策略

`mem-save` 写入前自动去重，**调用方无需处理**：

1. 启动时加载 `facts-text.jsonl` 构建内存索引（`Set<key>` + `Set<textMD5>`）
2. 每次写入检查：
   - 有 `key` → 按 key 去重（相同 key 直接跳过）
   - 无 `key` → 按 text MD5 去重（相同内容跳过）
3. 批量模式内同一批也去重（先到先得）

**注意**：直接调 `sh ndtsdb-cli.com facts write` 绕过 mem-save 则无去重保护。

---

## 删除机制

| 操作 | sidecar 变化 | .ndtv 向量 | 搜索结果 |
|------|------------|-----------|---------|
| `--dedup` / `--prune` / `--expire` / `--ai-prune` | ✅ 删除记录 | ❌ 孤儿留存 | 立即消失（sidecar 无记录则跳过） |
| `--vacuum` | ✅ 重建 | ✅ 物理删除 | 彻底清除，空间释放 |

**推荐定时策略（systemd timer）**：
- 每天 03:00：`bun tools/mem-clean/index.ts --ai-prune && --dedup --prune`（AI 裁剪 + 规则清理）
- 每周一 03:30：`bun tools/mem-clean/index.ts --vacuum`（物理重建，释放孤儿向量空间）

---

## 切换模型

### 切换 LLM（ai-prune / consolidate）

只需改环境变量，无需重建知识库：

```bash
# 临时切换（单次运行）
LLM_MODEL=minimax/minimax-m2.5 bun tools/mem-clean/index.ts --ai-prune --dry-run

# 永久切换：在 shell profile 或 systemd 环境中设置
export LLM_MODEL=openai/gpt-4o   # 升级到 gpt-4o（更贵但更准）
```

**注意**：reasoning 模型（GLM-4.7-flash、minimax 等）的 `content` 字段为空，会触发
`LLM returned empty content` 错误。LLM_MODEL 只能用非 reasoning 的 chat 模型。

### 切换 Embedding 模型

**⚠️ 切换必须重建知识库**（不同模型的向量空间不兼容，混存导致相似度计算无意义）：

```bash
# 1. 设置新模型和维度
export EMBED_MODEL=openai/text-embedding-3-large
export MEM_DIM=3072

# 2. 重建（耗时，建议后台运行）
nohup bun tools/mem-clean/index.ts --vacuum > /tmp/vacuum.log 2>&1 &
tail -f /tmp/vacuum.log

# 3. 验证
bun tools/mem-find/index.ts --test
bun tools/mem-find/index.ts --query "gales策略实盘"
```

**候选 embedding 模型**（via OpenRouter `/v1/embeddings`）：

| 模型 | 维度 | 价格/M | 适用场景 |
|------|------|--------|---------|
| `openai/text-embedding-3-small`（当前） | 1536 | $0.02 | 默认，性价比最高 |
| `openai/text-embedding-3-large` | 3072 | $0.13 | 需要更高精度时 |
| `openai/text-embedding-ada-002` | 1536 | $0.10 | 兼容旧项目 |

本地方案（无 API 成本，需要本地部署）：
- `ollama nomic-embed-text`：dim=768，需要修改 `getEmbedding()` 调用 `localhost:11434`
- `BGE-M3`（HuggingFace）：dim=1024，多语言强，需要 Python 环境

---

## 数据文件布局

```
~/knowledge/                         ← KNOWLEDGE_DB
├── facts-text.jsonl                 ← 原文 sidecar（每行一条 JSON）
│   格式: {"ts":1772026460,"text":"...","agent_id":"bot-006",
│          "type":"semantic","validity":"mutable","scope":"bot-006","key":""}
│
├── {scope}__{type}.ndtv             ← 向量文件（每个 scope+type 一个文件）
│   示例: shared__semantic.ndtv
│         bot-006__semantic.ndtv
│         bot-001__episodic.ndtv
│   格式: 二进制 float32（dim=1536）+ 元数据（ts, agent_id, confidence）
│
├── facts-text.jsonl.bak             ← mem-clean 规则操作前的自动备份
└── *.ndtv.vacuum-bak                ← --vacuum 前的备份
```

**facts-text.jsonl 是检索的枢纽**：
- `facts search` 返回 ts 列表 → 在 sidecar 中按 ts 查找 → 返回 text
- sidecar 无记录的 ts → 搜索结果中不出现（即使 .ndtv 中有向量）
- 因此"逻辑删除" = 从 sidecar 删条目，立即生效，无需动 .ndtv

---

## 常见问题

### Q: 搜索返回 "No results found"

排查顺序：
1. `bun tools/mem-find/index.ts --test` 验证配置
2. `bun tools/mem-clean/index.ts --stats` 确认知识库有数据
3. 降低阈值：`--threshold 0.2`（默认 0.3）
4. 如果近期切换过 EMBED_MODEL 或 MEM_DIM，必须重建：`--vacuum`

### Q: 搜索结果不相关

向量空间不匹配。知识库中存有旧维度的向量（如 512 维 Gemini 向量）而查询用的是新向量（1536 维）。运行 `--vacuum` 重建。

### Q: vacuum 太慢

484 条 × API 调用约 3-5 分钟。建议：
```bash
nohup bun tools/mem-clean/index.ts --vacuum > /tmp/vacuum.log 2>&1 &
tail -f /tmp/vacuum.log
```

### Q: ai-prune 报 "LLM returned empty content"

LLM_MODEL 设置了 reasoning 模型（如 GLM、minimax）。这类模型把输出放在 `reasoning` 字段，`content` 为空。换回 `openai/gpt-4o-mini` 或其他非 reasoning chat 模型。

### Q: 直接调 ndtsdb-cli 写入的条目能搜到吗？

能，但需要 `--dim 1536`（与 MEM_DIM 一致），且传入的向量必须是 text-embedding-3-small 的向量。TF-IDF fallback 的向量与 OpenAI 向量空间不兼容，搜不到。

### Q: serve 子命令在哪？

已永久禁用（返回 error）。知识库通过 CLI 操作，不需要 HTTP server 模式。

---

## 历史记录

| 日期 | 变更 |
|------|------|
| 2026-02-21 | 初始：TF-IDF 64 维，直接调 ndtsdb-cli，无去重 |
| 2026-02-25 | 重构：Google Gemini embedding-001（512 维截断），mem-save 加去重，mem-clean 新增 |
| 2026-02-25 | 迁移：全面切换 OpenRouter（text-embedding-3-small dim=1536 + gpt-4o-mini），废弃 Google API；ndtsdb-cli dim 上限从 512 扩展到 2048；mem-shared 抽取公共模块；mem-sleep 归档，AI 清洗并入 mem-clean |

---

## 路线图：知识切片架构

> 当前 484 条是基础，后续按 BotCorp 多维度扩展。

### 设计方向

**双层切片模型**：

```
原始数据（大切片，raw）
  ├── 完整 session 日志
  ├── 完整代码文件/PR diff
  ├── 完整实盘记录
  └── 外部文档/研究报告
          │
          ▼ 摘要/提炼（LLM）
小切片（摘要，用于向量化索引）
  ├── 单条 fact（当前 484 条）
  ├── 代码模块功能摘要
  ├── 会话关键决策摘要
  └── 实盘事件摘要
```

**维度规划**（待设计）：

| 维度 | 大切片来源 | 小切片形式 | agent 归属 |
|------|-----------|-----------|-----------|
| 技术决策 | PR/commit message、设计文档 | 决策+理由+影响范围 | bot-006/shared |
| 交易策略 | 回测报告、实盘日志 | 策略参数+效果摘要 | bot-001/bot-009 |
| 踩坑经验 | session 日志、错误日志 | 问题+根因+解法 | 对应 bot |
| 系统配置 | openclaw.json、systemd 配置 | 当前值+变更原因 | shared |
| 市场知识 | K线数据分析、研报 | 规律+置信度 | bot-001 |
| 公司知识 | AGENTS.md、IDENTITY.md | 规则+角色+流程 | shared |

**待解决的问题**：
- 大切片存储位置（ndtsdb 时序部分？还是单独文件？）
- 大切片 → 小切片的自动化流水线（mem-sleep --consolidate 是雏形）
- 向量索引与原文的双向关联（当前 sidecar 只存小切片文本）
- 多粒度检索：先小切片定位，再按需拉大切片原文

**注**：此为规划，尚未实现。待总裁/0号确认方向后设计具体方案。
