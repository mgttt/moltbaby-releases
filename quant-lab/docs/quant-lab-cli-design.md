# quant-lab-cli 设计文档

## 背景

- **wp-cli.ts**: TypeScript CLI，通过 Daemon IPC 管理策略进程
- **目标用户**: 9号（实盘操盘手），不接触 TS 层
- **目标**: 轻量 CLI 工具，策略配置下沉到纯 JS 文件

## 接口设计

```bash
quant-lab-cli start gales-short configs/gales-short.js    # 启动策略
quant-lab-cli stop gales-short                             # 停止策略
quant-lab-cli status                                       # 全局状态
quant-lab-cli status gales-short                           # 单策略状态
```

## Config 格式

```javascript
// configs/gales-short.js
module.exports = {
  symbol: 'BTCUSDT',
  interval: '1m',
  leverage: 5,
  maxPositionUsdt: 100,
  // 其他策略参数...
};
```

## 架构选型

**选项 A**: quant-lab-cli 是 bun 脚本，解析 JS config，调 wp-cli.ts 命令
- ✅ 最简单，复用现有 wp-cli.ts 逻辑
- ✅ 无需改动 workpool-lib
- ⚠️ 依赖 bun wp-cli.ts 可用

**选项 B**: 独立 TS 文件，直接 import workpool-lib Daemon
- ✅ 更直接控制
- ⚠️ 需要维护两套 Daemon 调用逻辑

**决策**: 采用 **选项 A**（简单优先，复用现有基础设施）

## 实现方案

```
quant-lab-cli.ts
    ├── parseConfig(filePath) → StrategySpec
    ├── cmdStart(name, configFile)
    │       └── exec(`bun wp-cli.ts start ${name}`)
    ├── cmdStop(name)
    │       └── exec(`bun wp-cli.ts stop ${name}`)
    └── cmdStatus(name?)
            └── exec(`bun wp-cli.ts status ${name}`)
```

### 关键映射

quant-lab-cli 的 `start` 命令需要：
1. 读取 JS config 文件
2. 将 config → StrategySpec
3. **动态注册策略**到 STRATEGY_REGISTRY（内存中）
4. 调用 `wp-cli.ts start <name>`

### 动态注册策略

由于 wp-cli.ts 使用 STRATEGY_REGISTRY 查找策略，quant-lab-cli 需要：
- 方案1: 修改 strategy-process-adapter.ts 支持动态注册
- 方案2: quant-lab-cli 直接操作 Daemon IPC（绕过 wp-cli.ts）

**原型阶段采用方案2**: quant-lab-cli 直接 import Daemon，构建 ProcessConfig 并发送 IPC 命令。

## 文件位置

- 设计文档: `quant-lab/docs/quant-lab-cli-design.md`
- CLI 原型: `quant-lab/bin/quant-lab-cli.ts`
- 配置示例: `quant-lab/configs/gales-short.js`

## 验收标准

1. `quant-lab-cli start gales-short configs/gales-short.js` 能真正启动策略
2. `quant-lab-cli status` 显示策略状态
3. `quant-lab-cli stop gales-short` 停止策略
