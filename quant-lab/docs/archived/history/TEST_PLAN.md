# Quant-Lab v2.0 测试计划

> 测试账号: wjcgm@bbt-sub1 (1000 USDT)  
> 日期: 2026-02-08  
> 目标: 验证重构后的系统功能

---

## 测试原则

1. **安全第一**: 1000U 账号，所有交易测试用最小金额
2. **逐级验证**: 从基础到复杂，逐步测试
3. **可回滚**: 每个测试都有明确的恢复步骤
4. **监控**: 实时观察 Dashboard 和日志

---

## 测试阶段

### Phase A: 基础功能测试 (无风险)

#### A1. Director 启动测试

**步骤**:
```bash
# 1. 启动 Director
bun quant-lab/src/director/service.ts

# 2. 检查健康状态
curl http://localhost:8080/health

# 预期输出:
# {"status":"ok","timestamp":"2026-02-08T..."}
```

**验证点**:
- [ ] Director 成功启动
- [ ] HTTP API 响应正常
- [ ] Dashboard 可访问 (http://localhost:8080)

---

#### A2. Worker 注册测试

**步骤**:
```bash
# 启动 Worker，注册到 Director
bun quant-lab/src/worker/start.ts \
  --worker-id=test-worker-001 \
  --region=JP \
  --work-dir=/tmp/quant-lab-test
```

**验证**:
```bash
# 检查 Worker 是否注册
curl http://localhost:8080/api/workers

# 预期看到:
# root
# └── test-worker-001 [leaf, load=0]
```

**验证点**:
- [ ] Worker 成功注册
- [ ] 路径正确显示
- [ ] 状态为 ready

---

#### A3. 系统策略测试 (只读，无风险)

**步骤**:
```bash
# 触发波动率采集（只读操作）
curl -X POST http://localhost:8080/api/tasks/volatility-collector
```

**验证**:
```bash
# 1. 查看策略状态
curl http://localhost:8080/api/strategies

# 2. 检查报告是否生成
ls -la docs/myvol.md

# 3. 查看 Git 状态
git status
```

**验证点**:
- [ ] 策略成功启动
- [ ] 数据正常采集
- [ ] 报告生成并提交

---

#### A4. 持仓查询测试 (只读，无风险)

**步骤**:
```bash
# 触发持仓查询
curl -X POST http://localhost:8080/api/tasks/positions-reporter
```

**验证**:
```bash
# 检查报告
ls -la docs/bybit-positions-latest.md
cat docs/bybit-positions-latest.md
```

**验证点**:
- [ ] 成功查询账号 wjcgm@bbt
- [ ] 报告格式正确
- [ ] Telegram 通知发送成功

---

### Phase B: 策略功能测试 (最小金额)

#### B1. 桥接测试策略 (不交易)

**步骤**:
```bash
# 启动测试策略（只有日志，无交易）
bun quant-lab/src/worker/start.ts \
  --worker-id=test-bridge-worker \
  --region=JP \
  --strategy=quant-lab/strategies/test/bridge-test.ts \
  --strategy-id=bridge-test
```

**验证**:
- [ ] 策略成功加载
- [ ] 心跳正常执行
- [ ] API 调用正常（查询持仓、余额）
- [ ] 日志输出正常

---

#### B2. 网格策略测试 (最小金额)

**准备**:
```bash
# 创建测试配置（最小参数）
cat > /tmp/test-grid-config.json << 'EOF'
{
  "symbol": "1000XUSDT",
  "account": "wjcgm@bbt-sub1",
  "centerPrice": 0,  // 自动获取当前价
  "gridCount": 2,    // 只开2格
  "gridSpacing": 0.05,  // 5%间距
  "basePosition": 10,   // 10 USD/格（最小）
  "maxPositions": 2     // 最多2个持仓
}
EOF
```

**步骤**:
```bash
# 启动网格策略（使用测试配置）
bun quant-lab/src/worker/start.ts \
  --worker-id=grid-test-worker \
  --region=JP \
  --strategy=quant-lab/strategies/grid-martingale/index.ts \
  --strategy-id=grid-test-001
```

**验证**:
- [ ] 策略加载成功
- [ ] 只下了限价单（不会立即成交）
- [ ] 订单金额 ≤ 10 USD
- [ ] 可以在 Bybit 网页看到挂单

**回滚**:
```bash
# 如果出现问题，取消所有订单
curl -X POST http://localhost:8080/api/strategies/grid-test-001/stop
# 或手动在 Bybit 取消
```

---

### Phase C: 故障恢复测试

#### C1. Worker 重启测试

**步骤**:
```bash
# 1. 启动 Worker
bun quant-lab/src/worker/start.ts ...

# 2. 等待策略运行
sleep 30

# 3. 强制停止 Worker
Ctrl+C

# 4. 重新启动 Worker
bun quant-lab/src/worker/start.ts ...
```

**验证**:
- [ ] Worker 重新注册成功
- [ ] 策略状态恢复（如有持久化）
- [ ] 继续正常执行

---

#### C2. Director 重启测试

**步骤**:
```bash
# 1. 启动 Worker
# 2. 停止 Director
# 3. 重新启动 Director
# 4. 检查 Worker 是否重新连接
```

---

### Phase D: 定时任务集成测试

#### D1. 手动触发测试

已包含在 Phase A3, A4

#### D2. 定时触发测试 (等待)

**步骤**:
```bash
# 等待到下一个整点 :08
# 观察 systemd 日志
journalctl --user -f -u quant-lab-volatility.service
```

**验证**:
- [ ] 定时器触发
- [ ] Director API 被调用
- [ ] 策略执行成功

---

## 测试检查清单

### 前置条件
- [ ] Proxy 8890 运行 (日本 IP)
- [ ] env.jsonl 配置正确
- [ ] Git 可以正常提交
- [ ] Telegram 通知正常

### 通过标准
| 测试项 | 通过标准 |
|--------|---------|
| Director 启动 | HTTP API 响应 200 |
| Worker 注册 | Dashboard 显示 Worker |
| 系统策略 | 报告生成并提交 Git |
| 网格策略 | 订单金额 ≤ 10 USD |
| 故障恢复 | 重启后状态恢复 |

### 紧急回滚
如果测试导致异常订单：
```bash
# 1. 停止所有 Worker
pkill -f "quant-lab/src/worker"

# 2. 登录 Bybit 网页手动平仓
# 3. 检查账户余额
```

---

## 测试脚本

```bash
#!/bin/bash
# run-tests.sh - 自动化测试脚本

echo "🧪 Quant-Lab v2.0 Test Suite"
echo "=============================="

# Test 1: Director Health
echo -n "Test 1: Director Health... "
if curl -sf http://localhost:8080/health > /dev/null; then
  echo "✅ PASS"
else
  echo "❌ FAIL"
  exit 1
fi

# Test 2: Worker Registration
echo -n "Test 2: Worker Registration... "
# (需要 Worker 运行)

# Test 3: API Endpoints
echo -n "Test 3: API Endpoints... "
curl -sf http://localhost:8080/api/stats > /dev/null && echo "✅ PASS" || echo "❌ FAIL"

# Test 4: Dashboard
echo -n "Test 4: Dashboard... "
curl -sf http://localhost:8080/ > /dev/null && echo "✅ PASS" || echo "❌ FAIL"

echo ""
echo "✅ All tests passed!"
```

---

## 预期时间

| 阶段 | 预计时间 | 风险 |
|------|---------|------|
| Phase A | 30 分钟 | 低 |
| Phase B | 1 小时 | 中（涉及真实资金）|
| Phase C | 30 分钟 | 低 |
| Phase D | 2 小时（等待定时器）| 低 |

**总计**: 约 4-5 小时

---

准备开始测试？建议按顺序执行 Phase A → B → C → D 🧪
