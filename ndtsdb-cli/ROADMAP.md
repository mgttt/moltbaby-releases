# ndtsdb-cli 路线图

**项目**：ndtsdb-cli  
**当前版本**：v0.2.2（稳定）/ v0.3.0（开发中）  
**最后更新**：2026-02-22  

---

## 架构愿景

```
现在（v0.3.x）
─────────────────────────────────
ndtsdb-cli（单二进制，QuickJS 嵌入）
  └── libndtsdb（静态链接，ndts.c + ndtsdb.h）

过渡（v0.4~0.5，API 冻结后）
─────────────────────────────────
libndtsdb.so / libndtsdb.a   ← 独立发布，稳定 ABI
      ↑                ↑
 ndtsdb-ts          ndtsdb-cli
（Bun FFI / TS 绑定）  （QuickJS 一体，APE 单文件）

长期（v1.0）
─────────────────────────────────
libndtsdb  ←  各语言生态自由接入
  Python ctypes / Go CGO / Rust bindgen / ndtsdb-ts / ndtsdb-cli
```

**分层原则**：
- **C 层**（libndtsdb）：数据读写、指标计算、性能热路径
- **JS 层**（QuickJS in CLI）：SQL 解析、策略逻辑、胶水代码
- **API 冻结时机**：v0.3.0 打标签后做评估，函数签名稳定后加 `NDTSDB_VERSION_MAJOR`，再做语言绑定

---

## 已发布版本

### v0.2.2（当前稳定）- 2026-02-22

**SQL 增强**：
- ✅ SQL GROUP BY / ORDER BY / HAVING
- ✅ SQL LIMIT / OFFSET
- ✅ SQL 聚合函数：COUNT / SUM / AVG / MIN / MAX
- ✅ StreamingVWAP

**指标**：
- ✅ SMA / EMA 纯C实现（period 参数，JSON Lines 输出）
- ✅ ATR 纯C Wilder 平滑（默认 period=14）

**存储**：
- ✅ DELETE / tombstone 软删除（`volume=-1.0` 标记）
- ✅ UPSERT（`--upsert` 标志，ndtsdb_clear API）
- ✅ WAL 框架（magic=0x57414C44，`$DB/.wal.log`）
- ✅ WAL checkpoint（committed 字节标记，wal-replay 子命令）

**分区**：
- ✅ partitioned 子命令（list / query / write-json）
- ✅ ndtsdb_list_symbols() API

**工程**：
- ✅ GitHub Actions CI 矩阵（ubuntu + macos，Zig 0.13.0）
- ✅ cosmocc APE 跨平台二进制（748KB，Linux/macOS/Windows）
- ✅ 集成测试套件 test-v0.2.2.sh（19 cases）

**性能基准**：write 820K/s，query 578K/s，SMA 1.45M/s

---

## 开发中版本

### v0.3.0 - 目标：2026-02-底

**已完成**：
- ✅ SQL WHERE BETWEEN / IN
- ✅ SQL HAVING
- ✅ SQL DISTINCT
- ✅ SQL 多列 GROUP BY
- ✅ SQL --format csv（所有查询子命令）
- ✅ tail 子命令（纯C，末尾 N 行，--format csv/json）
- ✅ head 子命令（纯C，前 N 行）
- ✅ SMA / EMA / ATR --since / --until 时间过滤
- ✅ **script 子命令**（嵌入式 JS 运行时，见下）
- ✅ 集成测试套件 test-v0.3.0.sh（31 cases）

**进行中**：
- 🔄 SQL WHERE OR 条件（C-11）
- 🔄 SQL WHERE LIKE 模式匹配（D-13）

**script 子命令**（v0.3.0 亮点）：
```bash
ndtsdb-cli script strategy.js --database ./mydb [extra args...]
```
- QuickJS 直接执行任意 `.js` / ES Module 文件
- 全局注入：`ndtsdb`（完整模块）/ `__database` / `__args` / `__file`
- 支持 async/await、Promise、import/export
- 零依赖，APE 单文件运行，不需要 node / bun / npm
- 用途：策略脚本、数据分析、ETL、自动化任务

---

## 规划中版本

### v0.4.0 - 目标：2026-Q2

**API 冻结 & 库化**：
- 📋 ndtsdb.h API 审查，定版 `NDTSDB_VERSION_MAJOR = 1`
- 📋 libndtsdb 独立构建（`zig build lib` 输出 `.so` / `.a`）
- 📋 CMake / pkg-config 支持，方便其他语言接入

**SQL 继续扩展**：
- 📋 SQL JOIN（多 symbol 关联，如 BTC/ETH 价差）
- 📋 SQL 子查询
- 📋 SQL 窗口函数（ROW_NUMBER / LAG / LEAD）
- 📋 SQL NOT / EXISTS

**script 生态扩展**：
- 📋 `ndtsdb.sma(data, period)` — JS 可直接调用 C 指标函数
- 📋 `ndtsdb.bollinger(data, period, std)` 等
- 📋 `--watch` 模式：新数据写入时自动重跑脚本（事件驱动）

**可靠性**：
- 📋 事务：BEGIN / COMMIT / ROLLBACK
- 📋 数据库快照 / 备份恢复

---

### v0.5.0 - 目标：2026-Q3

**语言绑定**（libndtsdb API 稳定后）：
- 📋 **ndtsdb-ts**：Bun FFI 绑定，TypeScript 类型定义
- 📋 **Python**：ctypes / cffi 封装
- 📋 **Go**：CGO 封装
- 📋 Node.js N-API（可选，Bun 优先）

**性能**：
- 📋 mmap 查询（零拷贝大数据集扫描，评估中）
- 📋 列式存储压缩
- 📋 并行多核扫描

**运维**：
- 📋 Prometheus metrics 导出
- 📋 Grafana 数据源插件

---

### v1.0.0 - 生产就绪

- libndtsdb 稳定 ABI，语义化版本
- ndtsdb-cli SQL 功能对标嵌入式 SQLite
- 多语言绑定生态完整
- 分布式扩展（raft 共识，可选模块）
- 企业级特性（RBAC、审计日志）

---

## 贡献指南

**优先级标签**：
- 🔴 **P0**：阻塞性 bug，立即修复
- 🔴 **P1**：核心功能缺口，当前版本必须完成
- 🟡 **P2**：功能补齐，下版本规划
- 🟠 **P3**：高级特性，长期规划

---

## 参考

- [ndtsdb_vs.md](./ndtsdb_vs.md)：与 Bun 版功能对比
- [docs/benchmark.md](./docs/benchmark.md)：性能基准
- [docs/concurrent-access.md](./docs/concurrent-access.md)：并发设计
- [docs/API.md](./docs/API.md)：API 参考
