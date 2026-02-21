# 框架层改进集成文档

## 概述

本文档描述如何将三个框架层改进模块集成到策略启动流程中：

1. **PreflightCheck** - 启动前置检查
2. **GlobalRiskAggregator** - 全局风险聚合器
3. **StrategyHealthStateMachine** - 策略健康状态机

## 模块关系图

```
┌─────────────────────────────────────────────────────────────────┐
│                      策略启动流程                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  1. PreflightCheck                                              │
│     ├── 持仓合规校验                                             │
│     ├── 账户状态校验                                             │
│     └── 参数完整性校验                                           │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │ FAILED                        │ PASSED
              ▼                               ▼
      ┌──────────────┐          ┌─────────────────────────────────┐
      │ 阻止启动      │          │ 2. GlobalRiskAggregator         │
      │ 发送告警      │          │    ├── 检查全局杠杆限制          │
      │              │          │    ├── 检查策略数量限制          │
      └──────────────┘          │    └── 注册策略                  │
                                └─────────────────────────────────┘
                                                  │
                    ┌─────────────────────────────┴─────────────────────────────┐
                    │ REJECTED                                                  │ REGISTERED
                    ▼                                                           ▼
            ┌──────────────┐                                    ┌─────────────────────────────────┐
            │ 阻止启动      │                                    │ 3. StrategyHealthStateMachine   │
            │ 发送告警      │                                    │    ├── 启动健康检查定时器        │
            └──────────────┘                                    │    ├── 监控错误率/延迟           │
                                                                │    └── DEGRADED自动恢复          │
                                                                └─────────────────────────────────┘
                                                                                  │
                                                                    ┌───────────┼───────────┐
                                                                    ▼           ▼           ▼
                                                               RUNNING    DEGRADED    ERROR
```

## 集成点说明

### 集成点1: 策略启动前 (run-strategy-generic.ts)

在创建 `QuickJSStrategy` 实例**之前**集成 PreflightCheck 和 GlobalRiskAggregator：

```typescript
// 位置: quant-lab/tests/run-strategy-generic.ts
// 在 "3. 创建策略实例" 之前

// ========== 框架层改进集成 ==========

// 1. 全局风险聚合器（单例）
const riskAggregator = getGlobalRiskAggregator({
  limits: {
    maxTotalLeverage: 10,
    maxTotalPositionValue: 100000,
    maxTotalMarginUsage: 50000,
    maxStrategyCount: 5,
  },
  alertConfig: {
    enabled: true,
    onViolation: async (result) => {
      logger.error('[GlobalRisk] 风险违规:', result.violations);
      // 发送TG告警
    },
  },
});

// 2. 启动前置检查
const preflightChecker = createPreflightChecker({
  strategyId: `gales-${symbol}-${direction}`,
  sessionId: Date.now().toString(),
  positionCheck: {
    symbol,
    maxPosition: params.maxPosition || 1000,
    currentPosition: await provider.getPosition?.(symbol) || 0,
    side: direction === 'long' ? 'LONG' : direction === 'short' ? 'SHORT' : 'NEUTRAL',
  },
  accountCheck: {
    minBalance: 100,
    currentBalance: await provider.getBalance?.() || 0,
    requiredPermissions: ['order:write', 'position:read'],
    currentPermissions: ['order:write', 'position:read'], // 从provider获取
  },
  parameterCheck: {
    requiredParams: ['symbol', 'gridCount', 'gridSpacing'],
    providedParams: params,
  },
}, {
  enabled: true,
  onFailure: async (result) => {
    logger.error('[Preflight] 检查失败:', result);
    // 发送TG告警
  },
});

// 执行前置检查
const preflightPassed = await preflightChecker.run();
if (!preflightPassed) {
  logger.error('[Preflight] 启动前置检查未通过，停止启动');
  process.exit(1);
}

// 3. 检查全局风险限制
const riskCheckResult = riskAggregator.checkNewStrategy({
  strategyId: `gales-${symbol}-${direction}`,
  sessionId: Date.now().toString(),
  symbol,
  side: direction === 'long' ? 'LONG' : direction === 'short' ? 'SHORT' : 'NEUTRAL',
  positionSize: 0, // 新策略初始持仓为0
  positionValue: 0,
  leverage: 1,
  marginUsed: 0,
  timestamp: Date.now(),
});

if (!riskCheckResult.allowed) {
  logger.error('[GlobalRisk] 全局风险检查未通过:', riskCheckResult.violations);
  process.exit(1);
}

// 注册策略到全局风险聚合器
await riskAggregator.registerStrategy({
  strategyId: `gales-${symbol}-${direction}`,
  sessionId: Date.now().toString(),
  symbol,
  side: direction === 'long' ? 'LONG' : direction === 'short' ? 'SHORT' : 'NEUTRAL',
  positionSize: 0,
  positionValue: 0,
  leverage: 1,
  marginUsed: 0,
  timestamp: Date.now(),
});
```

### 集成点2: 策略启动后 (run-strategy-generic.ts)

在策略初始化成功后集成 StrategyHealthStateMachine：

```typescript
// 位置: quant-lab/tests/run-strategy-generic.ts
// 在 "4. 创建 BybitStrategyContext 并初始化策略" 之后

// ========== 策略健康状态机 ==========

const healthMonitor = createStrategyHealthStateMachine({
  strategyId: `gales-${symbol}-${direction}`,
  sessionId: Date.now().toString(),
  thresholds: {
    maxErrorRate: 0.1,           // 10%错误率阈值
    maxLatency: 5000,            // 5秒延迟阈值
    heartbeatTimeout: 30000,     // 30秒心跳超时
    maxConsecutiveErrors: 5,     // 5次连续错误降级
    maxConsecutiveSlowResponses: 3,
    degradedRecoveryThreshold: {
      maxErrorRate: 0.05,
      maxLatency: 2000,
      minHealthyDuration: 60000, // 60秒健康持续才恢复
    },
  },
  autoRecovery: true,
  maxRecoveryAttempts: 3,
  alertConfig: {
    enabled: true,
    onStateChange: async (oldState, newState, reason) => {
      logger.warn(`[Health] 状态变更: ${oldState} → ${newState} | ${reason}`);
      // 发送TG告警
    },
    onDegraded: async (metrics) => {
      logger.warn('[Health] 策略降级:', metrics);
    },
    onError: async (error) => {
      logger.error('[Health] 策略错误:', error);
    },
  },
});

// 启动健康监控
healthMonitor.start();

// 在心跳循环中更新健康指标
heartbeatInterval = setInterval(async () => {
  const startTime = Date.now();
  try {
    // ... 原有心跳逻辑 ...
    
    // 记录成功心跳
    healthMonitor.recordHeartbeat();
    
  } catch (error: any) {
    // 记录错误
    healthMonitor.recordError(error);
    logger.error(`[QuickJS] 心跳错误: ${error.message}`);
  }
  
  // 记录延迟
  const latency = Date.now() - startTime;
  healthMonitor.recordLatency(latency);
  
}, 5000);
```

### 集成点3: 策略停止时 (run-strategy-generic.ts)

在 SIGINT/SIGTERM 处理中清理资源：

```typescript
process.on('SIGINT', async () => {
  // ... 原有逻辑 ...
  
  // 停止健康监控
  healthMonitor.stop();
  
  // 从全局风险聚合器注销
  riskAggregator.unregisterStrategy(`gales-${symbol}-${direction}`);
  
  // ... 原有逻辑 ...
});
```

## 完整集成示例

见 `examples/run-strategy-with-framework.ts`

## API参考

### PreflightChecker

```typescript
// 创建检查器
const checker = createPreflightChecker(config, alertConfig);

// 执行检查
const passed = await checker.run();

// 获取结果
const result = checker.getResult();

// 生成报告
const report = checker.generateReport();
```

### GlobalRiskAggregator

```typescript
// 获取单例实例
const aggregator = getGlobalRiskAggregator(config);

// 注册策略
const allowed = await aggregator.registerStrategy(snapshot);

// 更新风险快照
aggregator.updateStrategySnapshot(strategyId, partialSnapshot);

// 注销策略
aggregator.unregisterStrategy(strategyId);

// 获取全局状态
const state = aggregator.getGlobalState();

// 获取风险视图
const view = aggregator.getRiskView();

// 生成报告
const report = aggregator.generateReport();
```

### StrategyHealthStateMachine

```typescript
// 创建状态机
const health = createStrategyHealthStateMachine(config);

// 启动监控
health.start();

// 记录心跳
health.recordHeartbeat();

// 记录错误
health.recordError(error);

// 记录延迟
health.recordLatency(latency);

// 获取状态
const state = health.getState();

// 获取指标
const metrics = health.getMetrics();

// 执行健康检查
const result = health.performHealthCheck();

// 生成报告
const report = health.generateReport();

// 停止监控
health.stop();
```

## 事件监听

三个模块都继承自 EventEmitter，可以监听以下事件：

### PreflightChecker
- `check:started` - 检查开始
- `check:passed` - 检查通过
- `check:failed` - 检查失败
- `check:error` - 检查异常
- `alert:sent` - 告警已发送
- `alert:error` - 告警发送失败

### GlobalRiskAggregator
- `strategy:registered` - 策略注册成功
- `strategy:rejected` - 策略注册被拒绝
- `strategy:updated` - 策略风险快照更新
- `strategy:unregistered` - 策略注销
- `risk:limit_exceeded` - 风险限制超限
- `alert:sent` - 告警已发送

### StrategyHealthStateMachine
- `health:started` - 健康监控启动
- `health:stopped` - 健康监控停止
- `health:checked` - 健康检查执行
- `state:changed` - 状态变更
- `state:running` - 进入RUNNING状态
- `state:degraded` - 进入DEGRADED状态
- `state:error` - 进入ERROR状态

## 测试

```bash
# 测试启动前置检查
bun test src/execution/preflight-check.test.ts

# 测试全局风险聚合器
bun test src/execution/risk-aggregator.test.ts

# 测试策略健康状态机
bun test src/execution/strategy-health.test.ts
```

## 提交记录

- 框架层改进: `32eb251c0`
- priceTick修复: `c8b06e0c4`
