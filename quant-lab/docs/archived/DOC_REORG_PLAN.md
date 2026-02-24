# Quant-Lab 文档重构清单

**日期**: 2026-02-19  
**负责人**: 4号  
**验收**: 8号

---

## 📊 现状统计

```
quant-lab/docs/          16个文件
docs/archived/           14个文件（已归档）
根目录                   4个文件
```

---

## 🗂️ 重构方案

### 一、核心文档集（保留 + 优化）

| 文档 | 操作 | 说明 |
|------|------|------|
| **产品说明书** | 新建 | 合并 LIVE_TRADING_MANUAL + GAALES_RELEASE_NOTE |
| **策略与操盘手册** | 新建 | 合并 STRATEGY_DESIGN_GUIDE + LIVE_GALES_MYX_CONFIG |
| **开发路线图** | 保留优化 | EVOLUTION_ROADMAP 精简，链接到核心文档 |
| SYSTEM_OVERVIEW | 保留 | 系统架构总览（主入口）|
| ARCHITECTURE.md | 保留 | 技术架构详细说明 |
| README.md | 更新 | 作为目录索引，一跳到核心文档 |

### 二、合并重复文档

| 主文档 | 被合并 | 合并后位置 |
|--------|--------|-----------|
| 产品说明书 (新) | LIVE_TRADING_MANUAL.md | docs/PRODUCT_MANUAL.md |
| | GAALES_STRATEGY_RELEASE_NOTE.md | |
| 策略与操盘手册 (新) | STRATEGY_DESIGN_GUIDE.md | docs/TRADER_MANUAL.md |
| | LIVE_GALES_MYX_CONFIG.md | |
| EVOLUTION_ROADMAP (精简) | STRATEGY_EVOLUTION_ROADMAP.md | docs/ROADMAP.md |
| ARCHITECTURE-SUMMARY | 合并到 ARCHITECTURE.md | 删除 |

### 三、归档过期/历史文档

移动到 `docs/archived/` 并加迁移说明：

| 文档 | 归档原因 |
|------|----------|
| P0-POSITION-SYNC-FIX.md | P0 已修复，历史记录 |
| P1-BYBIT-POSITION-FINAL-DIAGNOSIS.md | P1 已修复，历史记录 |
| P1-BYBIT-POSITION-SIDE-ANALYSIS.md | P1 已修复，历史记录 |
| SYSTEM_REVIEW.md | 大版本 review，已过期 |
| TEST_PLAN.md | 测试计划，已执行 |
| team_algotrade.md | 团队文档，非核心 |

### 四、README 目录索引结构

```
# Quant-Lab - 策略运行时引擎

## 📖 核心文档（一跳到达）

| 文档 | 说明 | 链接 |
|------|------|------|
| [产品说明书](./docs/PRODUCT_MANUAL.md) | 功能介绍、部署指南 | 必读 |
| [策略与操盘手册](./docs/TRADER_MANUAL.md) | 策略开发、实盘操作 | 操盘手必读 |
| [开发路线图](./docs/ROADMAP.md) | 版本规划、迭代计划 | 开发者必读 |
| [系统架构](./docs/SYSTEM_OVERVIEW.md) | 架构总览、模块关系 | 架构师必读 |

## 🚀 快速开始
- ...

## 📁 完整文档索引
- ...
```

---

## ✅ 执行步骤

1. **新建合并文档** (30min)
   - [ ] docs/PRODUCT_MANUAL.md
   - [ ] docs/TRADER_MANUAL.md
   - [ ] docs/ROADMAP.md (精简)

2. **更新 README.md** (15min)
   - [ ] 添加核心文档表格
   - [ ] 添加文档导航

3. **归档文档** (15min)
   - [ ] 移动 P0/P1 诊断文档到 archived/
   - [ ] 添加迁移说明 (MOVED_TO: xxx)

4. **清理旧文档** (10min)
   - [ ] 删除已合并的重复文档

---

## 🎯 验收标准

- [ ] 1. 核心文档集 <= 5 个（产品/操盘/路线图/架构/README）
- [ ] 2. README 一跳到核心文档（表格链接）
- [ ] 3. 过期文档归档并加迁移说明
- [ ] 4. 无重复内容（全文搜索关键词不重复）

---

请确认清单后执行。
