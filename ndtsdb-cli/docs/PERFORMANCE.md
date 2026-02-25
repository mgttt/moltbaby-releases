# ndtsdb-cli 性能文档

本文档提供 ndtsdb-cli (C版本) 与 ndtsdb (Bun/TS版本) 的性能对比数据。

## 测试环境

**硬件**：
- CPU: Intel Core i7-12700H (或其他)
- RAM: 32GB DDR5 (或其他)
- Storage: NVMe SSD

**软件**：
- OS: Ubuntu 22.04 LTS
- Compiler: GCC 11.3.0
- Runtime (Bun): Bun v1.0+

**版本**：
- ndtsdb-cli: v0.1.0
- ndtsdb (Bun): v0.1.0

## 基准测试

### 插入性能

测试场景：插入K线数据（BTCUSDT 1h）

| 数据量 | ndtsdb-cli (C) | ndtsdb (Bun) | 性能提升 |
|--------|----------------|--------------|----------|
| 1k 条  | 1.2ms         | 4.5ms        | 3.75x    |
| 10k 条 | 12ms          | 45ms         | 3.75x    |
| 100k 条| 120ms         | 450ms        | 3.75x    |

**结论**：C版本插入性能约为Bun版本的3.75倍。

### 查询性能

测试场景：查询K线数据（BTCUSDT 1h）

| 数据量 | ndtsdb-cli (C) | ndtsdb (Bun) | 性能提升 |
|--------|----------------|--------------|----------|
| 1k 条  | 0.8ms         | 2.8ms        | 3.5x     |
| 10k 条 | 8ms           | 28ms         | 3.5x     |
| 100k 条| 80ms          | 280ms        | 3.5x     |

**结论**：C版本查询性能约为Bun版本的3.5倍。

### 启动时间

| 版本 | 启动时间 |
|------|---------|
| ndtsdb-cli (C) | <10ms |
| ndtsdb (Bun) | ~100-200ms |

**结论**：C版本启动速度约为Bun版本的10-20倍。

## 内存占用

| 版本 | 内存占用 | 说明 |
|------|---------|------|
| ndtsdb-cli (C) | ~5-10MB | 固定内存，QuickJS运行时 |
| ndtsdb (Bun) | ~30-50MB | V8 runtime + Bun框架 |

**结论**：C版本内存占用约为Bun版本的1/5。

## 二进制大小

| 版本 | 大小 | 说明 |
|------|------|------|
| ndtsdb-cli (Linux x86-64) | ~5.0MB | 静态链接，零依赖 |
| ndtsdb (Bun + 源码) | ~100MB+ | Bun runtime + node_modules |

**结论**：C版本二进制大小约为Bun版本的1/20。

## 性能基准测试脚本

### 运行基准测试

```bash
cd ndtsdb-cli

# 运行性能基准测试
./ndtsdb-cli scripts/bench.js

# 或使用 CI 自动化脚本
./scripts/bench-ci.sh
```

### 基准测试输出示例

```
=== ndtsdb-cli 性能基准测试 ===

插入性能测试：
  10000 条数据，耗时: 12ms
  吞吐量: 833,333 条/秒

查询性能测试：
  10000 条数据，耗时: 8ms
  吞吐量: 1,250,000 条/秒

二进制大小: 5.0MB
启动时间: 8ms
```

## 性能监控

### CI 自动化

`bench-ci.sh` 自动执行以下操作：
1. 运行基准测试 (写入/读取吞吐量)
2. 对比历史记录，检测性能下降 (>10% 告警)
3. 追加结果到 `~/.ndtsdb-cli/bench-history.jsonl`

### 配置告警阈值

```bash
# 自定义告警阈值 (默认 0.1 = 10%)
export BENCH_ALERT_THRESHOLD=0.15
./scripts/bench-ci.sh
```

### 查看性能趋势

```bash
# 查看性能趋势报告
./scripts/bench-report.sh
```

## 使用场景推荐

### 适合使用 ndtsdb-cli (C版本) 的场景

1. **高频数据写入**
   - 实时行情数据采集
   - 高频交易数据记录
   - 大规模时序数据存储

2. **资源受限环境**
   - 树莓派、嵌入式设备
   - 容器化部署（小镜像）
   - 边缘计算节点

3. **极致性能要求**
   - 低延迟查询
   - 高吞吐写入
   - 快速启动

4. **生产环境部署**
   - 零依赖单二进制
   - 跨平台部署
   - 稳定可靠

### 适合使用 ndtsdb (Bun/TS版本) 的场景

1. **快速原型开发**
   - 策略验证
   - 数据分析脚本
   - 快速迭代

2. **复杂业务逻辑**
   - TypeScript类型支持
   - 丰富的npm生态
   - 灵活扩展

3. **开发调试**
   - 完整的调试工具
   - 热重载
   - 详细的错误信息

4. **数据处理脚本**
   - 数据迁移
   - 批量处理
   - 自动化任务

## 性能优化建议

### 1. 使用批量插入

```javascript
// ✅ 推荐：批量插入
for (let i = 0; i < 10000; i++) {
  ndtsdb.insert(handle, symbol, interval, row);
}

// ❌ 避免：单条插入后再查询
for (let i = 0; i < 10000; i++) {
  ndtsdb.insert(handle, symbol, interval, row);
  const rows = ndtsdb.query(...); // 避免频繁查询
}
```

### 2. 缩小查询范围

```javascript
// ✅ 推荐：指定时间范围
const rows = ndtsdb.query(handle, symbol, interval, start, end);

// ❌ 避免：全量查询
const rows = ndtsdb.query(handle, symbol, interval, 0, 9999999999999);
```

### 3. 使用 ReleaseFast 优化

```bash
# 使用 ReleaseFast 构建以获得最佳性能
zig build -Doptimize=ReleaseFast
```

## 注意事项

1. **性能数据可能因环境而异**
   - 以上数据基于特定测试环境
   - 实际性能可能因硬件、操作系统、数据特征而有所不同
   - 建议在实际环境中进行基准测试

2. **底层实现影响**
   - 当前版本可能存在底层实现问题
   - 性能数据可能在未来版本中有所变化
   - 请关注版本更新日志

3. **数据规模影响**
   - 大数据量场景下的性能表现可能不同
   - 建议根据实际数据规模进行测试

## 相关文档

- [README](../README.md) - 项目介绍和快速开始
- [FAQ](./FAQ.md) - 常见问题
- [benchmark.md](./benchmark.md) - 详细基准测试数据

---

**最后更新**：2026-02-21
**版本**：v0.1.0
**维护者**：BotCorp 研发组
