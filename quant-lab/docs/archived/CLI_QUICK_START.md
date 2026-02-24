# strategy-cli sim 命令快速上手

> **最新更新**: 2026-02-11 - SimulatedProvider 已集成到 strategy-cli ✅

---

## 🚀 一键测试

现在可以用**统一 CLI 入口**快速测试策略：

```bash
# 之前（旧方式）
bun tests/run-simulated-strategy.ts ./strategies/gales-simple.js --scenario sine-wave

# 现在（新方式）
bun tools/strategy-cli.ts sim ./strategies/gales-simple.js --scenario sine-wave
```

---

## 📋 常用命令

### 1. 快速验证网格成交

```bash
cd /home/devali/moltbaby/quant-lab

bun tools/strategy-cli.ts sim ./strategies/gales-simple.js \
  --scenario sine-wave \
  --speed 100
```

**预期**: 6 秒完成，10-20 次成交

---

### 2. 验证 autoRecenter

```bash
bun tools/strategy-cli.ts sim ./strategies/gales-simple.js \
  --scenario range-then-dump \
  --speed 100
```

**预期**: 66 秒完成，观察价格脱离网格后的处理

---

### 3. 压力测试（高频）

```bash
bun tools/strategy-cli.ts sim ./strategies/gales-simple.js \
  --scenario high-volatility \
  --speed 1000
```

**预期**: 3 秒完成，20-40 次成交

---

### 4. 风控测试（极端行情）

```bash
bun tools/strategy-cli.ts sim ./strategies/gales-simple.js \
  --scenario extreme-dump \
  --speed 100
```

**预期**: 39 秒完成，检查持仓是否超限

---

## 🎯 场景速查表

| 场景 | 命令简写 | 用途 | 时长 (100x) |
|------|---------|------|------------|
| sine-wave | --scenario sine-wave | 网格成交 | 6秒 |
| range-then-dump | --scenario range-then-dump | autoRecenter | 66秒 |
| high-volatility | --scenario high-volatility | 高频测试 | 30秒 |
| extreme-dump | --scenario extreme-dump | 风控测试 | 39秒 |
| gap-down | --scenario gap-down | 跳空测试 | 48秒 |
| pump-then-dump | --scenario pump-then-dump | 双向测试 | 42秒 |
| slow-drift | --scenario slow-drift | 趋势测试 | 60秒 |

---

## 🔧 高级用法

### 调试模式（慢速观察）

```bash
bun tools/strategy-cli.ts sim ./strategies/gales-simple.js \
  --scenario sine-wave \
  --speed 10
```

**说明**: 10x 加速，可以清楚看到每个订单

---

### 随机游走模式

```bash
bun tools/strategy-cli.ts sim ./strategies/gales-simple.js \
  --mode random-walk \
  --volatility 0.02 \
  --speed 50
```

**说明**: 自定义波动率，模拟真实市场随机性

---

### 自定义起始价格

```bash
bun tools/strategy-cli.ts sim ./strategies/gales-simple.js \
  --scenario sine-wave \
  --price 50 \
  --speed 100
```

**说明**: 从 50 美元开始（默认 100）

---

## 📖 查看帮助

```bash
# 查看所有命令
bun tools/strategy-cli.ts --help

# 查看 sim 命令帮助
bun tools/strategy-cli.ts sim --help
```

---

## 💡 实用技巧

### 1. 快速迭代循环

```bash
# 修改策略代码 → 立即验证
while true; do
  bun tools/strategy-cli.ts sim ./strategies/gales-simple.js \
    --scenario sine-wave \
    --speed 1000
  echo "按 Ctrl+C 停止循环，Enter 重新运行"
  read
done
```

---

### 2. 批量测试所有场景

```bash
# 测试所有 7 个场景
for scenario in sine-wave range-then-dump high-volatility extreme-dump gap-down pump-then-dump slow-drift; do
  echo "=== 测试场景: $scenario ==="
  bun tools/strategy-cli.ts sim ./strategies/gales-simple.js \
    --scenario $scenario \
    --speed 1000
  echo ""
done
```

---

### 3. 记录测试结果

```bash
# 输出到文件
bun tools/strategy-cli.ts sim ./strategies/gales-simple.js \
  --scenario sine-wave \
  --speed 100 \
  | tee test-results-$(date +%Y%m%d-%H%M).log
```

---

## 🆚 命令对比

| 任务 | 旧命令 | 新命令 |
|------|--------|--------|
| 模拟测试 | `bun tests/run-simulated-strategy.ts` | `bun tools/strategy-cli.ts sim` |
| Paper Trade | `bun tests/run-gales-quickjs-bybit.ts` | （保持不变） |
| 启动策略 | `bun tests/run-strategy-generic.ts` | `bun tools/strategy-cli.ts start` |

**建议**: 优先使用 `strategy-cli.ts` 统一入口

---

## 🔗 相关文档

- **详细指南**: `SIMULATED_PROVIDER_GUIDE.md`
- **API 文档**: `src/providers/simulated/README.md`
- **场景 DSL**: `src/providers/simulated/scenarios.ts`
- **策略指南**: `STRATEGY_GUIDE.md`

---

## 🎁 下一步

1. **立即开始**: 复制上面的命令，开始测试
2. **观察日志**: 注意订单成交、撤单、reposition 等关键事件
3. **调整参数**: 根据观察结果调整策略参数
4. **切换真实行情**: 验证通过后用 `run-gales-quickjs-bybit.ts`

---

**准备好了吗？开始测试吧！** 🚀

—— bot-001 (2026-02-11)
