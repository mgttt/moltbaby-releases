# GALES MYX 实盘配置卡

**日期**: 2026-02-12
**操盘手**: bot-009
**状态**: 准备中

---

## 1. 基本信息

| 项目 | 值 |
|------|-----|
| 标的 | MYXUSDT |
| 方向 | 做空为主 |
| 账号 | wjcgm@bybit-sub1 |
| 资金 | 1000 USDT |

## 2. 合约信息

| 项目 | 值 |
|------|-----|
| Symbol | MYXUSDT |
| Status | Trading |
| 当前价格 | 3.342 USDT |
| 最小名义价值 | 5 USDT |
| 数量步长 | 1 |
| 价格步长 | 0.001 |

## 3. 策略参数（待 bot-004 更新）

**目标参数**（总裁指令）：
- 升 2% → 沽出 50 USDT（加空仓）
- 跌 4% → 渣入 100 USDT（减空仓/平仓）

**当前状态**：
- ❌ GALES 不支持非对称网格
- ⏳ 等 bot-004 修改

## 4. API 配置

| 项目 | 状态 |
|------|------|
| 账号 ID | wjcgm@bbt-sub1 |
| 配置文件 | ~/.config/quant-lab/accounts.json |
| Testnet | 否（实盘） |
| Proxy | http://127.0.0.1:8890 |
| API 连接 | ✅ 已验证 |

**账户余额**：
- USDT: 1000.00
- 可用: 999.33

## 5. 风控规则

| 规则 | 动作 |
|------|------|
| 每 2h 检查 | 价格偏离网格 > 10% → 警告 |
| 异常停机 | 立即上报 bot-000 |
| 日志记录 | ~/logs/gales-myx.log |

## 6. 启动命令（待参数确认）

```bash
cd /home/devali/moltbaby/quant-lab
bun tools/strategy-cli.ts start ./strategies/gales-asymmetric.js \
  --session gales-myx-live \
  --params '{
    "symbol": "MYXUSDT",
    "gridSpacingUp": 0.02,
    "gridSpacingDown": 0.04,
    "orderSizeUp": 50,
    "orderSizeDown": 100,
    "lean": "negative",
    "simMode": false
  }'
```

## 7. 监控命令

```bash
# 查看运行状态
bun tools/strategy-cli.ts status gales-myx-live

# 查看日志
tmux capture-pane -t gales-myx-live -p | tail -50

# 风控检查
./scripts/gales-monitor.sh MYXUSDT gales-myx-live
```

## 8. 紧急停机

```bash
bun tools/strategy-cli.ts stop gales-myx-live
```

---

**更新日志**：
- 2026-02-12 17:12 - 创建配置卡，等待 API Key 和策略更新
