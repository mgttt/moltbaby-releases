# facts 命令回归测试与 mem-find 集成策略

## 测试目标

验证 facts 命令增强功能（time_decay, dedup, archive）的正确性，并结合 mem-find 知识库管理策略。

## 测试架构

```
┌─────────────────────────────────────────────────────────────┐
│                     回归测试层                               │
├─────────────────────────────────────────────────────────────┤
│  test-facts-enhancements.sh                                  │
│  ├── 基础功能测试 (write/import/list/search)                │
│  ├── time_decay 测试 (--half-life, --show-raw)              │
│  ├── dedup 测试 (--threshold, --dry-run)                    │
│  ├── archive 测试 (--before, --validity)                    │
│  └── 边界测试                                               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     mem-find 集成层                          │
├─────────────────────────────────────────────────────────────┤
│  策略:                                                       │
│  1. mem-find 发现重复知识 → facts dedup --threshold 0.9     │
│  2. mem-find 发现过时知识 → facts archive --before -30d     │
│  3. mem-find 推荐相关性   → facts decay --half-life 7d      │
└─────────────────────────────────────────────────────────────┘
```

## 运行测试

```bash
cd ndtsdb-cli

# 构建 CLI
zig build

# 运行回归测试
bash tests/test-facts-enhancements.sh
```

## mem-find 集成场景

### 场景1: 重复知识检测

```bash
# mem-find 发现潜在重复
mem-find --query "量化策略" --limit 20

# facts dedup 精确检测
ndtsdb-cli facts dedup -d ./kb --threshold 0.90 --dry-run

# 确认后执行去重
ndtsdb-cli facts dedup -d ./kb --threshold 0.90
```

### 场景2: 过时知识归档

```bash
# mem-find 发现旧知识占比过高
mem-find stats --by-month

# facts archive 预览归档
ndtsdb-cli facts archive -d ./kb --before -90d --dry-run

# 执行归档
ndtsdb-cli facts archive -d ./kb --before -90d
```

### 场景3: 时间衰减搜索

```bash
# mem-find 推荐近期知识
mem-find --query "策略更新" --recency-boost

# facts decay 精确搜索
ndtsdb-cli facts decay -d ./kb -q "策略更新" --half-life 7d --top-k 10
```

## 测试数据约定

| 字段 | 说明 |
|------|------|
| agent_id | 模拟不同 bot: bot-001 ~ bot-010 |
| type | semantic / episodic / procedural |
| validity | permanent / mutable / transient |
| ts | 时间戳，用于 decay 和 archive |

## CI 集成

```yaml
# .github/workflows/test-facts.yml
- name: Run facts enhancement tests
  run: |
    cd ndtsdb-cli
    zig build
    bash tests/test-facts-enhancements.sh
```
