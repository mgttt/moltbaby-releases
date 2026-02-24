# Gales策略集成测试指南

## 1. 模拟模式测试（simMode）

### 1.1 启用模拟模式

**配置方法**：

在策略配置文件中设置：
```json
{
  "symbol": "BTCUSDT",
  "simMode": true,
  ...
}
```

或通过环境变量：
```bash
export SIM_MODE=true
```

**默认值**：`simMode: true`（默认启用模拟模式）

### 1.2 模拟模式功能

**核心功能**：
- ✅ **不发送真实订单**：订单只在内存中模拟，不发送到交易所
- ✅ **模拟成交**：根据当前市场价格模拟订单成交
- ✅ **部分成交**：每次心跳最多成交40%剩余量（模拟真实市场行为）
- ✅ **模拟对冲**：在模拟模式下自动对冲持仓
- ✅ **日志标记**：所有模拟操作日志以 `[SIM]` 前缀标记

**适用场景**：
- 策略逻辑验证
- 参数调优
- 风控机制测试
- 回归测试

### 1.3 运行模拟测试

**步骤1：准备配置文件**

创建 `config-paper.json`：
```json
{
  "symbol": "BTCUSDT",
  "simMode": true,
  "gridCount": 10,
  "gridSpacing": 0.01,
  "orderSize": 100,
  "maxPosition": 1000,
  "lean": "neutral",
  
  "enableMarketRegime": true,
  "adxPeriod": 14,
  "adxTrendingThreshold": 25,
  "adxStrongTrendThreshold": 40,
  
  "circuitBreaker": {
    "maxDrawdown": 0.40,
    "maxPositionRatio": 0.93,
    "cooldownAfterTrip": 600
  },
  
  "leverageHardCap": {
    "enabled": true,
    "maxLeverage": 3.0
  }
}
```

**步骤2：运行策略**

```bash
cd quant-lab
bun run strategies/gales-simple.js --config config-paper.json
```

**步骤3：观察日志**

查看模拟模式日志：
```
[SIM] 挂单 gridId=1 Buy 0.0010 @ 50000.0000
[SIM] 模拟成交 gridId=1 Buy 0.0004 @ 50000.0000 (40%)
[SIM] 模拟对冲成交 gridId=1 Sell 0.0004 @ 50010.0000
```

**步骤4：验证风控机制**

观察日志中的风控触发：
```
[MarketRegime] STRONG_TREND (ADX=45.30)
[Warning] Strong trend detected, suspending grid trading
[CircuitBreaker] 触发熔断: 回撤 42% > 阈值 40%
[LeverageHardCap] 杠杆硬顶触发: 3.2 > 3.0
```

### 1.4 模拟模式验证清单

- [ ] 策略正常启动（无错误日志）
- [ ] 网格订单正常生成（`[SIM] 挂单` 日志）
- [ ] 模拟成交正常（`[SIM] 模拟成交` 日志）
- [ ] 仓位计算正确（检查日志中的仓位信息）
- [ ] 风控机制正常（ADX/熔断/杠杆硬顶）
- [ ] 日志完整（包含所有关键操作）

---

## 2. 关键风控场景测试

### 2.1 ADX趋势强度测试

**测试目标**：验证ADX趋势检测功能，确保在强趋势中暂停网格交易。

**配置参数**：
```json
{
  "enableMarketRegime": true,
  "adxPeriod": 14,
  "adxTrendingThreshold": 25,
  "adxStrongTrendThreshold": 40
}
```

**手动触发方法**：

1. **准备强趋势市场数据**：
   - 使用历史数据回放（需要外部工具）
   - 或在真实强趋势市场中观察

2. **观察日志**：
```
[MarketRegime] RANGING (ADX=18.50)       # 横盘，正常网格
[MarketRegime] TRENDING (ADX=32.10)      # 趋势形成，警告
[MarketRegime] STRONG_TREND (ADX=45.30)  # 强趋势，暂停网格
```

3. **验证暂停逻辑**：
```
[Warning] Strong trend detected, suspending grid trading
[Grid] Skipping order placement (suspended)
```

**验证检查点**：
- [ ] ADX值正常计算（0-100范围）
- [ ] ADX < 25: 正常网格交易
- [ ] ADX ≥ 25: 日志警告，继续交易
- [ ] ADX ≥ 40: 暂停网格交易，不再放置新订单
- [ ] ADX回落 < 40: 恢复网格交易

**测试用例**：

```bash
# 场景1：横盘市场（ADX < 25）
# 预期：正常网格交易，双向挂单

# 场景2：趋势形成（25 ≤ ADX < 40）
# 预期：警告日志，继续网格交易

# 场景3：强趋势（ADX ≥ 40）
# 预期：暂停网格，不再放置新订单

# 场景4：趋势减弱（ADX回落 < 40）
# 预期：恢复网格交易
```

### 2.2 杠杆硬顶测试

**测试目标**：验证杠杆硬顶机制，防止杠杆过高导致爆仓风险。

**配置参数**：
```json
{
  "leverageHardCap": {
    "enabled": true,
    "maxLeverage": 3.0
  }
}
```

**手动触发方法**：

1. **模拟高杠杆场景**：
   - 在模拟模式（simMode: true）下运行
   - 配置较大的订单大小（orderSize）
   - 配置较小的maxPosition（容易触顶）

2. **观察日志**：
```
[LeverageHardCap] 杠杆硬顶触发: 3.2 > 3.0
[LeverageHardCap] 阻止新订单: side=Buy leverageRatio=3.2
[LeverageHardCap] 触发时间: 2026-02-21T12:00:00Z
```

3. **验证阻止逻辑**：
```
[Grid] Skipping order: leverage hard cap triggered
```

**验证检查点**：
- [ ] 杠杆计算正确（总持仓/净值）
- [ ] 杠杆 < 3.0: 正常交易
- [ ] 杠杆 ≥ 3.0: 阻止新订单
- [ ] 日志记录触发时间和杠杆值
- [ ] 杠杆回落后自动恢复

**测试用例**：

```bash
# 场景1：杠杆低于阈值（leverage < 3.0）
# 预期：正常交易，不触发硬顶

# 场景2：杠杆达到阈值（leverage ≥ 3.0）
# 预期：触发硬顶，阻止新订单

# 场景3：杠杆回落后（leverage < 3.0）
# 预期：恢复交易
```

### 2.3 仓位熔断测试

**测试目标**：验证仓位熔断机制，防止大幅回撤导致重大损失。

**配置参数**：
```json
{
  "circuitBreaker": {
    "maxDrawdown": 0.40,
    "maxPositionRatio": 0.93,
    "cooldownAfterTrip": 600
  }
}
```

**手动触发方法**：

1. **模拟大幅回撤场景**：
   - 在模拟模式下运行
   - 配置较小的maxPosition（容易触发回撤）
   - 或使用历史大跌数据回放

2. **观察日志**：
```
[CircuitBreaker] 触发熔断: 回撤 42% > 阈值 40%
[CircuitBreaker] 熔断原因: maxDrawdown exceeded
[CircuitBreaker] 冷却期: 600 秒
[CircuitBreaker] 熔断触发时间: 2026-02-21T12:00:00Z
```

3. **验证熔断逻辑**：
```
[Warning] Circuit breaker tripped, suspending trading
[Grid] Skipping order: circuit breaker active
```

4. **验证恢复逻辑**（冷却期后）：
```
[CircuitBreaker] 熔断恢复: 冷却期结束
[CircuitBreaker] 仓位回落至安全水平: positionRatio=0.85
[Info] Resuming grid trading
```

**验证检查点**：
- [ ] 回撤计算正确（从最高权益计算）
- [ ] 回撤 < 40%: 正常交易
- [ ] 回撤 ≥ 40%: 触发熔断
- [ ] 冷却期600秒内：不恢复交易
- [ ] 冷却期后+仓位回落：恢复交易
- [ ] 日志记录触发时间和回撤值

**测试用例**：

```bash
# 场景1：回撤低于阈值（drawdown < 40%）
# 预期：正常交易，不触发熔断

# 场景2：回撤达到阈值（drawdown ≥ 40%）
# 预期：触发熔断，暂停所有交易

# 场景3：冷却期内（600秒内）
# 预期：熔断状态保持，不恢复交易

# 场景4：冷却期后+仓位回落
# 预期：熔断解除，恢复交易

# 场景5：冷却期后+仓位未回落
# 预期：熔断保持，等待仓位回落
```

---

## 3. 健康端点测试

### 3.1 端点说明

**HealthAPI服务**：
- **默认端口**：9091
- **绑定地址**：127.0.0.1（仅本机访问）
- **权限控制**：仅127.0.0.1可访问
- **审计日志**：记录所有请求

**可用端点**：
- `GET /health` - 存活检查（服务状态+依赖检查）
- `GET /metrics` - 性能指标（吞吐量/延迟/错误率）
- `GET /status` - 运行状态（策略运行状态+仓位）

### 3.2 启动HealthAPI

**在策略中集成HealthAPI**：

```javascript
import { healthAPI } from './src/api/health-api';

// 启动HealthAPI
await healthAPI.start(9091);

// 注册策略状态
healthAPI.registerStrategy({
  strategyId: 'gales-btcusdt',
  state: 'running',
  position: {
    side: 'neutral',
    size: 0,
    entryPrice: 0,
    unrealizedPnl: 0,
  },
  performance: {
    totalPnl: 0,
    winRate: 0,
    tradesCount: 0,
  },
  lastUpdate: new Date().toISOString(),
});
```

### 3.3 测试/health端点

**功能**：检查服务健康状态

**curl测试**：
```bash
curl http://127.0.0.1:9091/health
```

**预期响应**（healthy）：
```json
{
  "status": "healthy",
  "timestamp": "2026-02-21T12:00:00.000Z",
  "version": "0.1.0",
  "uptime": 3600,
  "dependencies": {
    "ndtsdb": true,
    "quickjs": true,
    "bybit": true
  },
  "checks": {
    "memory": {
      "used": 50,
      "total": 100,
      "percentage": 50
    }
  }
}
```

**预期响应**（unhealthy，HTTP 503）：
```json
{
  "status": "unhealthy",
  "timestamp": "2026-02-21T12:00:00.000Z",
  "version": "0.1.0",
  "uptime": 3600,
  "dependencies": {
    "ndtsdb": false,
    "quickjs": true,
    "bybit": false
  },
  "checks": {
    "memory": {
      "used": 90,
      "total": 100,
      "percentage": 90
    }
  }
}
```

**验证检查点**：
- [ ] 返回HTTP 200（healthy）或503（unhealthy）
- [ ] status字段为"healthy"/"unhealthy"/"degraded"
- [ ] dependencies字段包含ndtsdb/quickjs/bybit检查结果
- [ ] checks字段包含内存使用情况
- [ ] uptime字段正确（秒数）
- [ ] version字段正确

### 3.4 测试/metrics端点

**功能**：获取性能指标

**curl测试**：
```bash
curl http://127.0.0.1:9091/metrics
```

**预期响应**：
```json
{
  "timestamp": "2026-02-21T12:00:00.000Z",
  "throughput": {
    "ordersPerSecond": 1.5,
    "quotesPerSecond": 10.2
  },
  "latency": {
    "p50": 50,
    "p95": 120,
    "p99": 200
  },
  "errors": {
    "rate": 0.5,
    "total": 10,
    "byType": {
      "network": 5,
      "validation": 3,
      "other": 2
    }
  },
  "period": "60s"
}
```

**验证检查点**：
- [ ] 返回HTTP 200
- [ ] throughput字段包含ordersPerSecond/quotesPerSecond
- [ ] latency字段包含p50/p95/p99（毫秒）
- [ ] errors字段包含rate/total/byType
- [ ] period字段显示统计周期

### 3.5 测试/status端点

**功能**：获取系统运行状态

**curl测试**：
```bash
curl http://127.0.0.1:9091/status
```

**预期响应**：
```json
{
  "timestamp": "2026-02-21T12:00:00.000Z",
  "version": "0.1.0",
  "mode": "paper",
  "strategies": [
    {
      "strategyId": "gales-btcusdt",
      "state": "running",
      "position": {
        "side": "long",
        "size": 0.5,
        "entryPrice": 50000,
        "unrealizedPnl": 100
      },
      "performance": {
        "totalPnl": 500,
        "winRate": 0.6,
        "tradesCount": 100
      },
      "lastUpdate": "2026-02-21T12:00:00.000Z"
    }
  ],
  "activeOrders": 5,
  "pendingOrders": 2,
  "riskLevel": "low"
}
```

**验证检查点**：
- [ ] 返回HTTP 200
- [ ] mode字段为"paper"或"live"
- [ ] strategies数组包含所有注册的策略
- [ ] 每个策略包含strategyId/state/position/performance
- [ ] activeOrders/pendingOrders数量正确
- [ ] riskLevel为"low"/"medium"/"high"

### 3.6 权限测试

**测试非法访问**（非127.0.0.1）：

```bash
# 从其他机器访问（应该失败）
curl http://<服务器IP>:9091/health

# 预期响应（HTTP 403）：
{
  "error": "Forbidden: Local access only"
}
```

**验证检查点**：
- [ ] 非本机访问返回HTTP 403
- [ ] 本机访问（127.0.0.1）正常

### 3.7 审计日志检查

**查看审计日志**：
```bash
cat ~/.quant-lab/audit/health-api.log
```

**日志格式**（每行一个JSON对象）：
```json
{
  "timestamp": "2026-02-21T12:00:00.000Z",
  "method": "GET",
  "path": "/health",
  "clientIp": "127.0.0.1",
  "result": "success",
  "durationMs": 5
}
```

**验证检查点**：
- [ ] 审计日志文件存在
- [ ] 每次请求都有日志记录
- [ ] 包含timestamp/method/path/clientIp/result/durationMs
- [ ] result字段为"success"或"failure"

---

## 4. 常见问题排查

### 4.1 策略无法启动

**症状**：
```
Error: Cannot find module 'xxx'
Error: Configuration file not found
Error: Invalid configuration
```

**排查步骤**：

1. **检查依赖安装**：
```bash
cd quant-lab
bun install
```

2. **检查配置文件**：
```bash
# 确认配置文件存在
ls -la config.json

# 验证JSON格式
cat config.json | jq .
```

3. **检查环境变量**：
```bash
# 确认API密钥已配置
env | grep BYBIT
```

4. **查看详细错误日志**：
```bash
# 启用DEBUG模式
DEBUG=* bun run strategies/gales-simple.js --config config.json
```

**常见原因**：
- ❌ 依赖未安装（运行`bun install`）
- ❌ 配置文件路径错误
- ❌ 配置JSON格式错误（使用jq验证）
- ❌ 环境变量未设置（API密钥）

### 4.2 模拟模式不生效

**症状**：
```
[错误] 订单发送失败: API错误
（应该看到 [SIM] 前缀，但实际没有）
```

**排查步骤**：

1. **确认simMode配置**：
```bash
# 检查配置文件
cat config.json | grep simMode
```

2. **检查配置加载**：
```bash
# 查看启动日志
grep "SimMode" <日志文件>
```

预期输出：
```
SimMode: true
```

**常见原因**：
- ❌ 配置文件中simMode设置为false
- ❌ 配置未正确加载（检查启动参数）
- ❌ 配置文件格式错误

### 4.3 ADX未触发暂停

**症状**：
```
[MarketRegime] STRONG_TREND (ADX=45.30)
（但仍在放置订单）
```

**排查步骤**：

1. **确认enableMarketRegime配置**：
```bash
cat config.json | grep enableMarketRegime
```

2. **检查shouldSuspendGridTrading逻辑**：
```bash
# 查看日志中的暂停判断
grep "shouldSuspendGridTrading\|suspending" <日志文件>
```

3. **验证ADX计算**：
```bash
# 查看ADX历史
grep "currentADX" <日志文件>
```

**常见原因**：
- ❌ enableMarketRegime设置为false
- ❌ ADX计算错误（价格历史不足）
- ❌ shouldSuspendGridTrading函数逻辑错误

### 4.4 熔断机制不触发

**症状**：
```
回撤超过40%，但策略继续交易
```

**排查步骤**：

1. **检查熔断配置**：
```bash
cat config.json | grep -A5 "circuitBreaker"
```

2. **查看熔断状态**：
```bash
# 查看熔断日志
grep "CircuitBreaker" <日志文件>
```

3. **检查回撤计算**：
```bash
# 查看回撤值
grep "drawdown\|Drawdown" <日志文件>
```

**常见原因**：
- ❌ maxDrawdown设置为0.99（相当于禁用）
- ❌ 回撤计算错误（检查highWaterMark）
- ❌ 熔断状态未持久化（重启后丢失）

### 4.5 杠杆硬顶不生效

**症状**：
```
杠杆超过3.0，但仍在开新仓
```

**排查步骤**：

1. **检查杠杆硬顶配置**：
```bash
cat config.json | grep -A3 "leverageHardCap"
```

2. **查看杠杆计算**：
```bash
# 查看杠杆日志
grep "leverage\|Leverage" <日志文件>
```

3. **检查杠杆计算公式**：
```javascript
// 杠杆 = 总持仓 / 净值
accountLeverageRatio = 总持仓 / 净值
```

**常见原因**：
- ❌ leverageHardCap.enabled设置为false
- ❌ 杠杆计算错误（检查持仓和净值）
- ❌ maxLeverage设置过大

### 4.6 HealthAPI无法访问

**症状**：
```
curl: (7) Failed to connect to 127.0.0.1 port 9091
```

**排查步骤**：

1. **确认HealthAPI已启动**：
```bash
# 查看进程
ps aux | grep gales-simple

# 查看端口
netstat -tlnp | grep 9091
```

2. **检查启动日志**：
```bash
grep "HealthAPI" <日志文件>
```

预期输出：
```
[HealthAPI] HTTP服务启动: http://127.0.0.1:9091
```

3. **测试连接**：
```bash
curl -v http://127.0.0.1:9091/health
```

**常见原因**：
- ❌ HealthAPI未启动（检查代码集成）
- ❌ 端口被占用（使用`netstat`检查）
- ❌ 防火墙阻止（检查iptables）
- ❌ 绑定地址错误（应该是127.0.0.1，不是0.0.0.0）

### 4.7 日志缺失或不完整

**症状**：
```
关键操作没有日志记录
```

**排查步骤**：

1. **检查日志级别**：
```bash
# 查看日志配置
grep "logLevel\|LOG_LEVEL" config.json
```

2. **检查日志文件**：
```bash
# 查看日志文件
ls -lh ~/.quant-lab/logs/
```

3. **查看磁盘空间**：
```bash
df -h
```

**常见原因**：
- ❌ 日志级别设置过高（只记录ERROR）
- ❌ 磁盘空间不足
- ❌ 日志文件权限问题
- ❌ 日志输出被重定向

### 4.8 性能问题

**症状**：
```
策略响应缓慢，CPU/内存占用高
```

**排查步骤**：

1. **检查资源使用**：
```bash
# CPU和内存
top -p $(pgrep -f gales-simple)

# 内存详情
ps aux | grep gales-simple
```

2. **检查/metrics端点**：
```bash
curl http://127.0.0.1:9091/metrics | jq .
```

3. **分析性能瓶颈**：
```bash
# 查看延迟分布
grep "latency\|duration" <日志文件>
```

**常见原因**：
- ❌ 网格档位过多（gridCount过大）
- ❌ 日志输出过多（降低日志级别）
- ❌ 内存泄漏（重启策略）
- ❌ 事件循环阻塞（检查同步操作）

---

## 5. 测试清单

### 5.1 启动测试

- [ ] 策略正常启动（无错误日志）
- [ ] 配置文件正确加载
- [ ] 依赖服务正常（NDTSDB/QuickJS/Bybit）
- [ ] HealthAPI启动成功（端口9091监听）

### 5.2 模拟模式测试

- [ ] simMode=true生效
- [ ] 订单只在内存中模拟
- [ ] 模拟成交正常
- [ ] 日志包含[SIM]前缀

### 5.3 风控测试

- [ ] ADX计算正确
- [ ] ADX ≥ 40暂停网格
- [ ] 杠杆硬顶触发正常
- [ ] 仓位熔断触发正常
- [ ] 冷却期后自动恢复

### 5.4 健康端点测试

- [ ] /health返回正确状态
- [ ] /metrics返回性能指标
- [ ] /status返回运行状态
- [ ] 权限控制生效（仅127.0.0.1）
- [ ] 审计日志正常记录

### 5.5 长期运行测试

- [ ] 24小时无崩溃
- [ ] 内存稳定（无泄漏）
- [ ] 日志完整
- [ ] 风控机制正常触发

---

## 6. 参考资料

- [ADX指标文档](./indicators/indicator_adx.md)
- [配置热重载文档](../src/execution/config-hot-reload.ts)
- [HealthAPI实现](../src/api/health-api.ts)
- [HealthAPI测试](../src/api/health-api.test.ts)
