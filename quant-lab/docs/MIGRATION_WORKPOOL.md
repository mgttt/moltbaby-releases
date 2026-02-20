# quant-lab → workpool-lib 迁移设计文档

**日期**: 2026-02-20  
**负责人**: 1号  
**评审**: 6号  
**验收**: 8号  

---

## 1. 现状分析

### 1.1 当前架构 (systemd 直接管理)

```
quant-lab/
├── strategies/
│   └── gales-simple.js       # 策略代码
├── tests/
│   └── run-strategy-generic.ts  # 启动器
└── (无进程池管理层)

systemd 服务:
- gales-neutral.service  →  bun run-strategy-generic.ts gales-simple.js
- gales-short.service    →  bun run-strategy-generic.ts gales-simple.js

管理方式:
- systemctl start/stop/restart/status
- 日志: ~/logs/gales-myx-live-*.log
- 自动重启: systemd Restart=always
```

### 1.2 问题

1. **无统一进程池**: 每个策略独立 systemd 服务，难以统一管理
2. **生命周期分散**: 启动、停止、监控逻辑分散在 systemd 配置中
3. **状态不透明**: 需通过 systemctl 查询，无程序化接口
4. **资源协调困难**: 难以实现策略间资源分配、优先级调度

---

## 2. 目标架构 (workpool-lib 统一管理)

```
quant-lab/
├── strategies/
│   └── gales-simple.js
├── adapters/
│   ├── ndtsdb-process-manager.js    # 现有 NDTSDB 适配器
│   └── strategy-process-adapter.ts  # 【重写】策略规格 → ProcessConfig 转换
│                                    #         + checkHealthByLog 僵尸检测
├── bin/
│   └── wp-cli.ts                    # 【重写】Daemon IPC 客户端
├── legacy/                          # 【归档】原 systemd 配置
│   └── systemd/
│       ├── gales-neutral.service
│       ├── gales-short.service
│       └── MIGRATION_NOTE.md
└── docs/
    └── MIGRATION_WORKPOOL.md        # 本文档

@moltbaby/workpool-lib 集成:
- Daemon: 持久后台进程，托管 ProcessManager（detached spawn）
- ProcessManager: 策略进程生命周期（autorestart, state persistence）
- StateManager: 持久化到 ~/.wp/state/processes.json（跨进程查询）
- LogManager: 统一日志 ~/.wp/logs/<name>-out.log
- IPC: wp-cli ↔ Daemon Unix socket 通信

调用链:
  wp-cli.ts  →  Daemon.sendCommand()  →  IPCServer  →  ProcessManager.start()
                                                      →  spawnProcess (detached)
```

### 2.1 架构说明

| 层 | 组件 | 职责 |
|---|---|---|
| CLI | `bin/wp-cli.ts` | 解析命令，发送 IPC，显示结果 |
| Adapter | `adapters/strategy-process-adapter.ts` | StrategySpec → ProcessConfig 转换；checkHealthByLog |
| Daemon | `workpool-lib/Daemon` | 持久化进程管理，接收 IPC 命令 |
| ProcessManager | `workpool-lib/ProcessManager` | 进程启动/停止/重启，状态持久化 |
| StateManager | `workpool-lib/StateManager` | `~/.wp/state/processes.json` 读写 |

---

## 3. 接口映射

| 原接口 (systemd) | 新接口 (workpool-lib) | 说明 |
|-----------------|----------------------|------|
| `systemctl start gales-neutral` | `wp start gales-neutral` | 启动策略 |
| `systemctl stop gales-neutral` | `wp stop gales-neutral` | 停止策略 |
| `systemctl restart gales-neutral` | `wp restart gales-neutral` | 重启策略 |
| `systemctl status gales-neutral` | `wp status gales-neutral` | 查询状态 |
| `journalctl -u gales-neutral` | `wp logs gales-neutral` | 查看日志 |
| 无 | `wp list` | 列出所有策略 |
| 无 | `wp health` | 健康检查 |

---

## 4. 迁移步骤

### Phase 1: 核心适配器开发 (45分钟)

1. **StrategyProcessAdapter** (`adapters/strategy-process-adapter.ts`)
   - 封装 bun 进程启动
   - 实现启动/停止/重启逻辑
   - 捕获 stdout/stderr 日志

2. **StrategyWorker** (`workers/strategy-worker.ts`)
   - 定义策略 Worker 类型
   - 实现心跳上报
   - 状态流转: IDLE → STARTING → RUNNING → STOPPING → STOPPED

3. **CLI 入口** (`wp-cli.ts`)
   - start/stop/restart/status/logs/list 命令

### Phase 2: 集成与替换 (30分钟)

1. 修改 gales-simple.js 支持 workpool 生命周期信号
2. 创建迁移脚本: `scripts/migrate-to-workpool.sh`
3. 归档原 systemd 配置到 `legacy/systemd/`

### Phase 3: 验证 (15分钟)

1. 本地单策略启动测试
2. 异常重启场景测试
3. 回滚测试

---

## 5. 回滚方案

### 5.1 开关设计

```typescript
// config/workpool-migration.ts
export const MIGRATION_CONFIG = {
  // 全局开关
  enabled: process.env.USE_WORKPOOL !== 'false',
  
  // 单策略开关
  strategies: {
    'gales-neutral': process.env.GALES_NEUTRAL_USE_WORKPOOL !== 'false',
    'gales-short': process.env.GALES_SHORT_USE_WORKPOOL !== 'false',
  },
  
  // 回退到 systemd 的阈值
  fallbackThreshold: {
    maxRestartFailures: 3,      // 连续重启失败3次回退
    maxHealthCheckFailures: 5,  // 健康检查失败5次回退
  }
};
```

### 5.2 回滚命令

```bash
# 方式1: 环境变量临时禁用（已废弃，使用 daemon stop 代替）
# USE_WORKPOOL=false wp start gales-neutral

# 方式2: 全局回滚到 systemd（推荐）
./scripts/rollback-to-systemd.sh

# 方式3: 代码级回滚（还原 workpool 迁移 commits）
git revert b095dfb28   # 初始迁移 commit
# 如有后续 commit 也需一并 revert（git log --oneline 查询）
```

---

## 6. 验证脚本

```bash
#!/bin/bash
# scripts/verify-workpool-migration.sh

echo "=== Workpool 迁移验证 ==="

# 1. 单策略启动测试
echo "[测试1] 单策略启动..."
wp start gales-neutral --dry-run
wp status gales-neutral | grep "RUNNING" && echo "✅ 启动成功" || echo "❌ 启动失败"

# 2. 异常重启测试
echo "[测试2] 异常重启..."
kill -9 $(wp pid gales-neutral)
sleep 2
wp status gales-neutral | grep "RUNNING" && echo "✅ 自动重启成功" || echo "❌ 自动重启失败"

# 3. 停止测试
echo "[测试3] 停止..."
wp stop gales-neutral
wp status gales-neutral | grep "STOPPED" && echo "✅ 停止成功" || echo "❌ 停止失败"

# 4. 健康检查
echo "[测试4] 健康检查..."
wp health && echo "✅ 健康检查通过" || echo "❌ 健康检查失败"

echo "=== 验证完成 ==="
```

---

## 7. 风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|-----|------|------|---------|
| workpool 启动失败 | 中 | 高 | 自动回退到 systemd |
| 日志丢失 | 低 | 中 | 双写日志（workpool + 原路径）|
| 状态不一致 | 中 | 高 | 心跳检测 + 自动修复 |
| 性能下降 | 低 | 低 | 监控 tick 耗时 |

---

## 8. 验收清单

- [ ] 迁移设计文档完成
- [ ] StrategyProcessAdapter 实现
- [ ] CLI 命令可用 (start/stop/restart/status/logs/list/health)
- [ ] 原 systemd 配置归档到 legacy/
- [ ] 回滚开关与命令测试通过
- [ ] 本地验证脚本输出正常
- [ ] 6号评审通过
- [ ] 8号验收通过

---

**下一步**: 开始 Phase 1 开发