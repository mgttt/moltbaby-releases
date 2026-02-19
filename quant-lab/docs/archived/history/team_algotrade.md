# team_algotrade.md

> Moltbaby / Quant-Lab Algo Trading Team Playbook
>
> 目标：在“策略 JS 化（QuickJS）快速迭代”的前提下，把策略开发、底层架构、实盘操盘三条线分清楚，减少扯皮与误操作。
>
> 说明：这是一个**可演进文档**，先用起来；随着实盘经验再收敛规则。

---

## 1) 团队角色与边界

### bot-004（策略层 / Strategy Owner）
**负责什么**（Owner）：
- QuickJS 策略代码：`quant-lab/strategies/*.js`
- 策略参数体系与默认值、热更新字段（`ctx.strategy.params` / `st_onParamsUpdate`）
- 策略状态机与风控逻辑（挂单/撤单/部分成交处理/自愈机制等）
- Paper Trade 观察与复盘：产出“预期行为 vs 实际行为”差异分析

**不负责**：
- 交易所连接稳定性、订单回推、底层 bridge 合约实现、日志系统/持久化引擎

**交付物**：
- Strategy Release Note（见第 3 节）
- 可复现实验（最小化参数 + 观察窗口 + 预期输出）

---

### bot-001（底层架构 / Infra Owner）
**负责什么**（Owner）：
- QuickJS runner / bridge API 合约的稳定性与一致性
- Provider / 交易所连接、重试、代理、WS/REST、订单/成交回推链路
- 状态持久化、日志/指标、性能与可靠性

**不负责**：
- 策略逻辑正确性（参数、状态机、交易决策）

**交付物**：
- Roadmap 项与修复 PR
- Infra 版本说明（breaking change 必须显式标记）

---

### bot-009（实盘操盘 / Live Operator）
**负责什么**（Owner）：
- 策略上线/停机/重启/回滚
- 参数热更新（按 Release Note 执行），观察实盘行为
- 风控与应急：异常撤单、降频、切换到安全参数、关闭策略
- 运行日报与事件记录（用于反哺策略）

**不负责**：
- 大改策略代码、改底层实现

**交付物**：
- Live Run Log（当日运行摘要）
- Incident Report（见第 4 节模板）

---

## 2) 协作流程（建议）

### 阶段 A：策略开发（bot-004）
- 改策略 JS（小步快跑）
- 自测：QuickJS sandbox 单测 / 参数热更新测试（至少不崩）
- 在 papertrade 环境观察：
  - 是否能触发挂单
  - 是否会重复挂单/撤单
  - 日志是否可读（不过载）

### 阶段 B：Paper Trade 验证（bot-004 主导）
- 目标：给出“策略是否具备上线价值”的结论
- 输出：Release Note + 推荐参数 + 风险点 + 回滚方式

### 阶段 C：准备实盘（bot-009 接手）
- 按 Release Note 执行上线/参数
- 开启监控与告警
- 如遇异常：按模板反馈给 bot-004 / bot-001

### 阶段 D：复盘迭代
- bot-009 提供实盘事件
- bot-004 做策略迭代
- bot-001（如涉及底层）修 infra

---

## 3) Strategy Release Note（bot-004 输出）

每次准备给 bot-009 上线/改参时，至少包含以下信息：

### 3.1 基本信息
- 策略名称：
- 策略文件：
- 版本标识（commit/hash 或日期）：
- 适用标的（symbol）：
- 运行模式：paper / live（明确）

### 3.2 变更点（What changed）
- 新增：
- 修改：
- 删除：
- 破坏性变更（Breaking）：

### 3.3 参数建议（Recommended params）
- gridCount / gridSpacing
- magnetDistance（含相对磁铁规则，如有）
- cancelDistance
- orderSize / maxPosition
- maxActiveOrders
- autoRecenter：开关 + 阈值

### 3.4 预期行为（Expected behavior）
- 正常市场波动下：大概多久会触发一次挂单？
- 触发后：多久会撤单/成交（期望）？
- 仓位接近上限时：应该看到什么日志/行为？

### 3.5 风险点（Known risks）
- 已知会触发但可接受的噪声
- 已知不做的事情（例如：不处理某类碎片成交）

### 3.6 回滚与紧急停止
- 回滚到哪个版本/参数
- 紧急停机步骤（tmux session / CLI）

---

## 4) Incident Report 模板（bot-009 → bot-004/bot-001）

当出现“策略行为不符合预期、风险事件、交易异常”时，按这个格式发：

- 时间（含时区）：
- 策略版本（commit/hash 或文件 mtime）：
- symbol：
- 价格区间（异常前后）：
- 账户/环境（proxy/region）：
- 现象摘要（1 句话）：
- 关键日志片段（贴 30~100 行）：
- 当前 state 摘要：
  - centerPrice / lastPrice
  - activeOrders 数
  - positionNotional
  - 触发的风控/自愈（如 recenter）
- 已采取动作：停机/改参/撤单/回滚

---

## 5) 底层问题上报规则（bot-004）

只要发现“不是策略逻辑能解决”的问题：
- 先写任务卡到 `tasks/inbox/`（描述现象、影响、验收标准、相关文件）
- 同步到对应库 ROADMAP
- 再交由你安排 bot-001（或其他 bot）处理
