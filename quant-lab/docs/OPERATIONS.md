# Quant-Lab 运维操作手册

> **版本**: v1.0 (2026-02-21)  
> **适用范围**: 策略运行监控、故障处理、紧急操作

---

## 目录

1. [启动/停止/重启策略](#1-启动停止重启策略)
2. [健康检查](#2-健康检查)
3. [告警响应手册](#3-告警响应手册)
4. [紧急平仓步骤](#4-紧急平仓步骤)
5. [日志查看/故障排查](#5-日志查看故障排查)
6. [回滚流程](#6-回滚流程)

---

## 1. 启动/停止/重启策略

### 1.1 策略启动

#### Paper Trade 模式（默认）

```bash
cd /home/devali/moltbaby/quant-lab

# 基础启动
bun tests/run-strategy-generic.ts ./strategies/gales-simple.js \
  '{"symbol":"MYXUSDT","gridCount":5,"gridSpacing":0.02}' \
  bybit wjcgm@bbt-sub1

# 带方向参数
bun tests/run-strategy-generic.ts ./strategies/gales-simple.js \
  '{"symbol":"MYXUSDT","lean":"negative","gridCount":5}' \
  bybit wjcgm@bbt-sub1
```

#### Live 实盘模式

```bash
# 关键：必须设置 DRY_RUN=false
DRY_RUN=false bun tests/run-strategy-generic.ts \
  ./strategies/gales-simple.js --live \
  '{"symbol":"MYXUSDT","gridCount":5}' \
  bybit wjcgm@bbt-sub1
```

**⚠️ 重要安全机制**：
- `--live` + `DRY_RUN=true`（默认）= **启动失败**（fail-fast保护）
- 如需在live模式使用paper trade，必须设置：`ALLOW_PAPER_ON_LIVE=true`

#### Demo Trading 模式

```bash
# 使用 Bybit Demo 环境
bun tests/run-strategy-generic.ts \
  ./strategies/gales-simple.js --demo \
  '{"symbol":"MYXUSDT"}'

# 需要环境变量
export BYBIT_DEMO_API_KEY="your_key"
export BYBIT_DEMO_API_SECRET="your_secret"
```

### 1.2 策略停止

#### 正常停止（推荐）

```bash
# 在策略运行终端按 Ctrl+C
# 会自动执行优雅停机：
# 1. 停止心跳循环
# 2. 取消所有挂单
# 3. 保存状态
# 4. 退出进程
```

#### 强制停止（紧急）

```bash
# 查找策略进程
ps aux | grep "run-strategy-generic"

# 强制终止
kill -9 <PID>

# 或批量终止所有策略
pkill -f "run-strategy-generic"
```

### 1.3 策略重启

```bash
# 1. 停止现有策略
Ctrl+C

# 2. 等待 5 秒确保资源释放
sleep 5

# 3. 重新启动
bun tests/run-strategy-generic.ts ...
```

### 1.4 常用参数说明

| 参数 | 说明 | 示例 |
|------|------|------|
| `symbol` | 交易对 | `"MYXUSDT"`, `"BTCUSDT"` |
| `gridCount` | 网格数量 | `5`, `10` |
| `gridSpacing` | 网格间距 | `0.02` (2%) |
| `lean | 仓位倾向 | `"positive"`, `"negative"`, `"neutral"`` |
| `maxPosition` | 最大仓位(USDT) | `800`, `1000` |
| `magnetDistance` | 磁铁距离 | `0.015` (1.5%) |
| `cancelDistance` | 取消距离 | `0.01` (1%) |
| `autoRecenter` | 自动重心 | `true`, `false` |
| `simMode` | 模拟模式 | `true` (不真下单) |

---

## 2. 健康检查

### 2.1 健康检查端点

启动策略时自动启动 HTTP 健康检查服务（默认端口动态分配）：

```bash
# 查看健康状态
curl http://127.0.0.1:<port>/health

# 查看性能指标
curl http://127.0.0.1:<port>/metrics

# 查看运行状态
curl http://127.0.0.1:<port>/status
```

**注意**：仅本机可访问（127.0.0.1），外部访问返回 403

### 2.2 端口分配规则

| 模式 | 默认行为 | 环境变量控制 |
|------|----------|-------------|
| Live | 禁用 HTTP 服务 | `RELOAD_API_PORT=9090` 强制启用 |
| Paper | 动态端口（10000-65535） | `RELOAD_API_PORT=0` 禁用 |

### 2.3 指标含义

#### /health 响应

```json
{
  "status": "healthy",        // healthy/unhealthy/degraded
  "timestamp": "2026-02-21T08:00:00Z",
  "uptime": 3600,             // 运行秒数
  "dependencies": {
    "ndtsdb": true,           // 数据存储状态
    "quickjs": true,          // QuickJS 沙箱状态
    "bybit": true             // Bybit 连接状态
  },
  "checks": {
    "memory": {
      "used": 512,            // MB
      "total": 1024,
      "percentage": 50
    }
  }
}
```

#### /metrics 响应

```json
{
  "throughput": {
    "ordersPerSecond": 2.5,
    "quotesPerSecond": 10.0
  },
  "latency": {
    "p50": 50,                // 中位数延迟(ms)
    "p95": 100,               // 95分位延迟
    "p99": 200                // 99分位延迟
  },
  "errors": {
    "rate": 0.5,              // 错误率(%)
    "total": 10,
    "byType": {
      "CANCEL_RACE": 2,
      "GRID_TIMEOUT": 3
    }
  }
}
```

### 2.4 状态解读

| 状态 | 含义 | 处理建议 |
|------|------|----------|
| `healthy` | 一切正常 | 继续监控 |
| `degraded` | 性能下降 | 关注延迟/错误率，准备扩容 |
| `unhealthy` | 服务异常 | 立即检查日志，考虑重启 |

---

## 3. 告警响应手册

### 3.1 403 错误（权限不足）

**现象**：
```
[BybitProvider] 下单失败: 403 Forbidden
```

**处理步骤**：
1. 检查 API Key 权限
   ```bash
   # 查看账号配置
cat ~/.config/quant-lab/accounts.json | jq '.[] | {id, permissions}'
   ```
2. 确认 API Key 有 `order:write` 和 `position:read` 权限
3. 如权限不足，在 Bybit 后台重新生成 API Key
4. 更新配置后重启策略

### 3.2 GRID_TIMEOUT（网格超时）

**现象**：
```
[GridCleaner] 订单超时: order-xxx, 已存活 65秒
[GridCleaner] 自动取消超时订单
```

**处理步骤**：
1. **自动处理**：系统已自动取消超时订单，通常无需人工干预
2. **检查频率**：如频繁出现（>10次/小时），检查网络连接
3. **调整阈值**：如需要，修改 `maxOrderAgeSec` 参数
   ```javascript
   // gales-simple.js 配置
   CONFIG.maxOrderAgeSec = 120;  // 默认 300秒
   ```

### 3.3 CANCEL_RACE（撤单竞态）

**现象**：
```
[CancelRaceHandler] 检测到重复撤单: order-xxx
[CancelRaceHandler] order not exists (110001)，标记为已取消
```

**处理步骤**：
1. **正常现象**：这是系统正常处理竞态条件，无需干预
2. **自动恢复**：系统会重新同步订单状态
3. **如持续出现**：检查策略日志中的 `orderLinkId` 是否重复
4. **紧急处理**：如影响交易，可重启策略

### 3.4 持仓差值告警

**现象**：
```
[告急][B类硬拦截] 账本差值=2500U > 2000U，停止下单
```

**处理步骤**：
1. **立即停止**：策略已自动停止下单，保持冷静
2. **检查仓位**：
   ```bash
   # 查看交易所实际持仓
   curl -s "http://127.0.0.1:<port>/status" | jq '.strategies[0].position'
   ```
3. **人工核对**：
   - 登录 Bybit 查看实际持仓
   - 对比策略显示的持仓
4. **决策**：
   - 如差值可接受（历史遗留仓位），记录后继续运行
   - 如差值异常，执行[紧急平仓](#4-紧急平仓步骤)

### 3.5 API 关键失败

**现象**：
```
[告急][A类硬拦截] API关键失败5次/300s，停止下单
```

**处理步骤**：
1. **立即停止**：策略已自动停止，不要强行重启
2. **检查网络**：
   ```bash
   ping api.bybit.com
   curl -I https://api.bybit.com/v5/market/time
   ```
3. **检查代理**：
   ```bash
   curl -x http://127.0.0.1:8890 https://api.bybit.com/v5/market/time
   ```
4. **检查 API 限制**：是否触发频率限制
5. **等待恢复**：通常 5-10 分钟后自动恢复
6. **人工介入**：如 30 分钟未恢复，联系运维

### 3.6 回撤熔断

**现象**：
```
[告急][D类硬拦截] 回撤45%超40%最后防线，已停止开仓
```

**处理步骤**：
1. **确认回撤**：查看策略盈亏状态
2. **自动保护**：策略已停止开仓，现有持仓保留
3. **人工决策**：
   - 如市场极端行情，考虑手动平仓止损
   - 如策略逻辑正常，等待市场恢复后自动恢复
4. **恢复交易**：
   ```javascript
   // 在策略参数中重置 highWaterMark
   CONFIG.initialOffset = currentPosition;
   ```

---

## 4. 紧急平仓步骤

### 4.1 情况评估

**触发条件**：
- 持仓差值 > 5000 USDT 且持续扩大
- 交易所持仓方向与策略预期相反
- 市场剧烈波动导致巨额浮亏
- 系统故障无法恢复

### 4.2 紧急平仓流程

#### 步骤 1: 停止策略

```bash
# 在策略运行终端
Ctrl+C

# 或强制终止
pkill -f "run-strategy-generic"
```

#### 步骤 2: 确认交易所持仓

```bash
# 使用 Bybit CLI 查看持仓
cd /home/devali/moltbaby/quant-lab
bun scripts/run-strategy.ts
```

或登录 Bybit 网页/App 查看。

#### 步骤 3: 手动平仓

**通过 Bybit 网页/App**：
1. 登录 Bybit
2. 进入持仓页面
3. 点击对应交易对的"平仓"按钮
4. 选择市价平仓（快速）或限价平仓（可控滑点）

**通过 CLI**（如已配置）：
```bash
# 示例：市价平仓 BTCUSDT
# 需根据实际情况调整
```

#### 步骤 4: 确认平仓完成

```bash
# 再次检查持仓
bun scripts/run-strategy.ts
```

确保 `positions` 数组为空或 size 为 0。

#### 步骤 5: 记录事件

```bash
# 记录到运维日志
echo "$(date): 紧急平仓 - 原因: XXX, 交易对: XXX, 盈亏: XXX" \
  >> ~/.quant-lab/logs/emergency.log
```

### 4.3 平仓后检查清单

- [ ] 交易所持仓为 0
- [ ] 所有挂单已取消
- [ ] 记录平仓原因和盈亏
- [ ] 通知相关人员
- [ ] 评估是否重启策略

---

## 5. 日志查看/故障排查

### 5.1 日志位置

| 类型 | 路径 | 说明 |
|------|------|------|
| 策略日志 | `~/.quant-lab/logs/` | 按策略名分类 |
| 审计日志 | `~/.quant-lab/audit/` | API 调用记录 |
| 状态文件 | `~/.quant-lab/state/` | 策略持久化状态 |
| 队列文件 | `~/.quant-lab/` | 重试队列等 |

### 5.2 实时查看日志

```bash
# 查看最新策略日志
tail -f ~/.quant-lab/logs/gales-dev.log

# 查看所有日志（合并）
tail -f ~/.quant-lab/logs/combined.log

# 查看带时间戳的实时输出
bun tests/run-strategy-generic.ts ... 2>&1 | tee -a ~/strategy-$(date +%Y%m%d).log
```

### 5.3 搜索特定错误

```bash
# 搜索 CANCEL_RACE 错误
grep "CANCEL_RACE" ~/.quant-lab/logs/gales-dev.log

# 搜索所有 ERROR 级别日志
grep "ERROR" ~/.quant-lab/logs/combined.log | tail -20

# 搜索特定订单
grep "order-xxx" ~/.quant-lab/logs/*.log
```

### 5.4 常见故障排查

#### 策略无法启动

```bash
# 1. 检查参数 JSON 格式
echo '{"symbol":"MYXUSDT"}' | jq .  # 验证 JSON

# 2. 检查策略文件存在
ls -la /home/devali/moltbaby/quant-lab/strategies/gales-simple.js

# 3. 检查账号配置
cat ~/.config/quant-lab/accounts.json | jq '.[] | .id'

# 4. 检查端口占用
lsof -i :9090  # 如指定了固定端口
```

#### 心跳停止

**现象**：日志不再更新，无新心跳输出。

**排查**：
```bash
# 1. 检查进程是否存在
ps aux | grep "run-strategy-generic"

# 2. 检查资源使用
top -p <PID>

# 3. 检查最后日志
tail -50 ~/.quant-lab/logs/gales-dev.log

# 4. 检查网络连接
netstat -an | grep ESTABLISHED
```

**处理**：如进程存在但无心跳，发送 SIGTERM 优雅重启：
```bash
kill -TERM <PID>
# 等待 10 秒后重新启动
```

#### 订单不成交

**排查**：
1. 检查 `magnetDistance` 是否过大
2. 检查 `postOnly` 设置（为 true 时不会吃单）
3. 检查价格偏移 `priceOffset`
4. 查看日志中的订单状态

```bash
grep "订单" ~/.quant-lab/logs/gales-dev.log | tail -20
```

---

## 6. 回滚流程

### 6.1 按 Commit 回滚

#### 查看提交历史

```bash
cd /home/devali/moltbaby/quant-lab
git log --oneline -20
```

#### 回滚到特定版本

```bash
# 1. 确认当前状态
git status

# 2. 回滚到指定 commit（示例：abc1234）
git reset --hard abc1234

# 3. 或创建回滚 commit（推荐，保留历史）
git revert abc1234

# 4. 如使用 revert，需提交
# git revert 会自动创建 commit
```

#### 回滚策略文件

```bash
# 仅回滚单个文件到某版本
git checkout abc1234 -- strategies/gales-simple.js

# 提交回滚
git commit -m "rollback: gales-simple.js to abc1234"
```

### 6.2 紧急回滚清单

**场景**：新部署版本出现严重问题，需立即回滚。

```bash
# 1. 停止策略
pkill -f "run-strategy-generic"

# 2. 回滚代码
cd /home/devali/moltbaby/quant-lab
git reset --hard <last-good-commit>

# 3. 清理状态（必要时）
rm -rf ~/.quant-lab/state/gales-*

# 4. 重启策略
bun tests/run-strategy-generic.ts ...

# 5. 验证运行
tail -f ~/.quant-lab/logs/gales-dev.log
```

### 6.3 备份策略

```bash
# 备份当前策略状态
cp -r ~/.quant-lab/state ~/state-backup-$(date +%Y%m%d)

# 备份策略文件
cp strategies/gales-simple.js strategies/gales-simple.js.backup

# 备份配置
cp ~/.config/quant-lab/accounts.json ~/accounts-backup.json
```

---

## 附录

### A. 快速命令参考

```bash
# 启动策略（Paper）
bun tests/run-strategy-generic.ts ./strategies/gales-simple.js \
  '{"symbol":"MYXUSDT"}' bybit wjcgm@bbt-sub1

# 启动策略（Live）
DRY_RUN=false bun tests/run-strategy-generic.ts \
  ./strategies/gales-simple.js --live \
  '{"symbol":"MYXUSDT"}' bybit wjcgm@bbt-sub1

# 健康检查
curl http://127.0.0.1:9090/health

# 查看日志
tail -f ~/.quant-lab/logs/gales-dev.log

# 搜索错误
grep ERROR ~/.quant-lab/logs/combined.log

# 停止策略
pkill -f "run-strategy-generic"

# 回滚
git reset --hard <commit>
```

### B. 联系信息

| 角色 | Telegram | 职责 |
|------|----------|------|
| 实盘操盘手 | @bot-009 | 实时监控、紧急操作 |
| 投资组长 | @bot-001 | 策略决策、风险审批 |
| 技术组长 | @bot-006 | 技术故障处理 |

### C. 版本历史

| 版本 | 日期 | 更新内容 |
|------|------|----------|
| v1.0 | 2026-02-21 | 初始版本 |

---

**文档维护**: bot-00a  
**最后更新**: 2026-02-21
