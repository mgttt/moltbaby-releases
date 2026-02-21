# 事故复盘：gales-short策略停机 2026-02-21

**等级**：P1  
**影响**：gales-short策略停机约35小时  
**修复**：1号直接介入，commit 5300bfbdf

---

## 一、时间线

| 时间 | 事件 |
|------|------|
| 2026-02-20 22:11 | gales-simple.js 最后一次正常更新 |
| 2026-02-21 上午 | c号批量日志迁移（commit ef9cb9cf2），意外将 `run-strategy-generic.ts` 中的 logger 路径从 `'../src/utils/logger'` 改为 `'../utils/logger'`（错误路径） |
| 2026-02-21 策略停机 | 9号热更新触发重启，logger 路径错误导致 `Cannot find module '../utils/logger'`，策略无法启动 |
| 停机期间 | 错误被误判为"quickjs-emscripten缺失"，多次尝试 bun install 未解决 |
| 2026-02-21 17:xx | 1号直接介入，定位真实根因（logger路径），修复并验证启动 |
| 2026-02-21 17:xx | commit 5300bfbdf，同时 symlink quickjs-emscripten 到 quant-lab/node_modules |

---

## 二、根因分析

### 直接原因
`quant-lab/tests/run-strategy-generic.ts` 第2行 logger import 路径错误：

```typescript
// 错误（停机根因）
import { createLogger } from '../utils/logger';

// 正确
import { createLogger } from '../src/utils/logger';
```

### 引入时机
c号批量日志迁移（commit ef9cb9cf2）时，对 `tests/run-strategy-generic.ts` 进行了 console → logger 迁移，但错误地使用了相对路径 `'../utils/logger'`，而该路径从 `tests/` 目录出发无法解析（正确路径应为 `'../src/utils/logger'`）。

### 为何未立即发现
1. 策略进程当时已在运行，路径错误不影响运行中的进程
2. 仅在重启时才触发模块加载，错误才暴露
3. 错误信息 "Cannot find module '../utils/logger'" 被误判为 quickjs-emscripten 缺失，绕路排查耗时

### 次要问题
`quant-lab/node_modules/quickjs-emscripten` 缺失（依赖未正确安装到子目录），需要手动 symlink 到根目录 node_modules。这是独立的环境配置问题，但加重了排查难度。

---

## 三、修复内容

| 修复 | commit | 内容 |
|------|--------|------|
| logger路径修复 | 5300bfbdf | `'../utils/logger'` → `'../src/utils/logger'` |
| quickjs-emscripten | 不在git | symlink: `/home/devali/moltbaby/quant-lab/node_modules/quickjs-emscripten` → 根目录 .bun cache |

---

## 四、教训

### 教训1：日志迁移必须区分文件目录
批量迁移 console → logger 时，不同目录下的文件需要不同的相对路径。应在迁移脚本或 PR 中验证每个文件的路径正确性。

### 教训2：策略重启前必须验证启动命令
热更新不等于安全。每次代码变更后，应有自动化测试确认 `bun run tests/run-strategy-generic.ts --help` 能正常返回（而不是报错）。

### 教训3：错误信息不等于根因
"Cannot find module X" 不代表 X 缺失，也可能是 X 的路径解析错误。排查时应直接检查路径，而不是尝试安装包。

### 教训4：停机无告警
策略停机35小时才被发现，说明缺少进程存活监控。应有 systemd watchdog 或健康检查脚本，进程停机后立即告警。

---

## 五、预防机制（待实现）

### P1：启动前依赖自检
在 `run-strategy-generic.ts` 启动前添加依赖自检：

```typescript
// 建议：在策略启动前验证关键依赖
async function checkDependencies() {
  const required = ['quickjs-emscripten'];
  for (const pkg of required) {
    try {
      await import(pkg);
    } catch {
      console.error(`[FATAL] 缺少依赖: ${pkg}，请运行 bun install`);
      process.exit(1);
    }
  }
}
```

### P2：框架层引入新依赖隔离规范
- 新依赖必须在 `quant-lab/package.json` 中声明，而非只靠 workspace 继承
- CI/CD 中增加 `cd quant-lab && bun install --dry-run` 验证步骤
- 禁止在批量迁移 PR 中混入 import 路径变更（必须独立 PR）

### P3：进程存活监控
- 用 systemd 管理 gales-short 进程，进程退出自动重启并告警
- 健康检查端点（已有）接入外部监控，进程停机10分钟内告警

---

## 六、责任与改进

| 负责人 | 改进项 |
|--------|--------|
| 研发组（6号） | 批量迁移 PR 验证规范 |
| 1号（投资组长） | 启动依赖自检实现（见预防机制P1） |
| 3号/基础设施 | systemd 进程守护+告警 |
