# NDTSDB-CLI 产品规划文档

**版本**: v0.1.0-draft  
**日期**: 2026-02-18  
**状态**: 需求阶段，待底层架构评估  
**需求方**: 总裁  
**负责组**: 研发组（底层系统 + CLI 工程）

---

## 1. 背景与动机

### 当前状态
- **ndtsdb**: Bun (TypeScript) + libndtsdb (C/Zig FFI)
- **优势**: 开发效率高，生态丰富，团队熟悉
- **劣势**: 依赖 Bun 运行时 (~100MB)，部署不够轻量

### 目标场景
- **数据与智能**: 量化数据存储、边缘计算、嵌入式部署
- **简化部署**: 单二进制文件，零依赖，秒级启动
- **AI 底层预留**: 未来可集成推理引擎（如 llama.cpp）

### 核心洞察
不是替换现有架构，而是**新增产品形态**，满足不同场景：
- **Bun/TS 版**: 开发、高频、复杂业务逻辑
- **CLI/QuickJS 版**: 部署、嵌入式、轻量脚本

---

## 2. 产品定位

### 2.1 与现有系统的关系

```
┌─────────────────────────────────────────────────────────────┐
│                     数据层 (100% 兼容)                        │
│  ┌──────────────┐         ┌──────────────────────────────┐  │
│  │  .ndts 文件   │ ←─────→ │  共享文件格式 (Columnar/Gorilla)│  │
│  └──────────────┘         └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              ↑
        ┌─────────────────────┴─────────────────────┐
        ↓                                           ↓
┌───────────────────┐                    ┌───────────────────┐
│   ndtsdb (Bun/TS)  │                    │ ndtsdb-cli (QJS)  │
│  ───────────────   │                    │  ───────────────  │
│  • 开发环境        │                    │  • 生产部署        │
│  • 高频交易        │    并行兼容         │  • 边缘计算        │
│  • 复杂策略        │    (非迁移)         │  • 嵌入式设备      │
│  • 完整生态        │                    │  • 轻量脚本        │
└───────────────────┘                    └───────────────────┘
        ↑                                           ↑
   Bun Runtime                              QuickJS + libndtsdb
   (~100MB)                                 (~2MB 静态链接)
```

### 2.2 关键原则

1. **零迁移**: 现有 Bun/TS 代码继续维护，不强制迁移
2. **100% 数据兼容**: 两套系统读写同一 .ndts 文件
3. **API 设计镜像**: CLI 的 JS API 与 Bun 版保持一致
4. **性能下沉**: 热路径逻辑逐步下沉到 libndtsdb，JS 层只做编排

---

## 3. 架构设计

### 3.1 技术栈

| 组件 | 技术 | 说明 |
|------|------|------|
| **JS 运行时** | QuickJS | 嵌入式，单文件 ~1MB，ES2020 支持 |
| **核心引擎** | libndtsdb | 现有 C/Zig 库，静态链接 |
| **绑定层** | 手写 C + 绑定生成 | QuickJS ↔ libndtsdb API 映射 |
| **构建系统** | Zig Build / Makefile | 跨平台静态链接 |

### 3.2 模块划分

```
ndtsdb-cli/
├── src/
│   ├── main.c              # CLI 入口，QuickJS 初始化
│   ├── bindings/
│   │   ├── qjs_ndtsdb.c    # QuickJS 绑定（手动）
│   │   └── qjs_ndtsdb.h
│   └── stdlib/             # 嵌入式 JS 标准库
│       ├── fs.js           # 文件操作封装
│       └── console.js      # 日志输出
├── lib/
│   └── libndtsdb.a         # 静态链接库（来自 ndtsdb 项目）
├── scripts/
│   └── example.js          # 示例脚本
├── build.zig               # Zig 构建配置
└── Makefile                # 备选构建
```

### 3.3 核心绑定 API

```c
// C 层暴露给 QuickJS 的 API（最小 MVP）
NDTSDB* ndtsdb_open(const char* path);
void ndtsdb_close(NDTSDB* db);
int ndtsdb_insert(NDTSDB* db, const KlineRow* row);
QueryResult* ndtsdb_query(NDTSDB* db, const Query* q);
void ndtsdb_free_result(QueryResult* r);
```

```javascript
// QuickJS 层暴露给用户的 JS API（与 Bun 版镜像）
import * as ndtsdb from 'ndtsdb';

const db = ndtsdb.open('./data/BTC.ndts');
db.insert({ symbol_id: 'BTC', timestamp: 1700000000000n, open: 100, high: 101, low: 99, close: 100.5, volume: 1000 });

const rows = db.query({ symbol_id: 'BTC', start: 1700000000000n, end: 1700086400000n });
console.log(rows.length);
db.close();
```

---

## 4. 功能范围（MVP）

### Phase 1: 最小可用（v0.1.0）
- [ ] 单二进制文件（Linux x64，静态链接）
- [ ] 基础 CRUD: open/close/insert/query
- [ ] 支持 Kline 数据格式（与现有 100% 兼容）
- [ ] 嵌入式 JS 脚本执行: `ndtsdb-cli script.js`
- [ ] REPL 模式: `ndtsdb-cli`

### Phase 2: 功能补齐（v0.2.0）
- [ ] 流式指标（StreamingSMA/EMA/RSI/MACD/BB）
- [ ] SQL 子集支持（SELECT/WHERE/LIMIT）
- [ ] 批量导入/导出（CSV/JSON）
- [ ] 跨平台分发（职责分离架构）
  
  **设计原则**：可执行程序走cosmocc（一个.com全平台跑）；共享库走zig（天然per-platform绑定）。各司其职。
  
  ```
  分发产物矩阵:
  
  ndtsdb-cli.com                    ← Cosmocc（可执行程序）
  └── 单文件 APE，Linux/macOS/Windows/FreeBSD 直接运行
  
  libndtsdb_{arch}.{ext}            ← Zig Build（共享库）
  ├── libndtsdb_x86_64.so           Linux x86_64
  ├── libndtsdb_x86_64.dylib        macOS x86_64  
  ├── libndtsdb_arm64.dylib         macOS ARM64
  ├── libndtsdb_x86_64.dll          Windows x86_64
  └── libndtsdb_arm64.so            Linux ARM64
  ```
  
  - **ndtsdb-cli 可执行程序 → Cosmocc APE**
    - [x] APE二进制编译通过（3.0MB）✅
    - [x] make cosmo target集成 ✅
    - [x] 功能验证（--help/write-json/query）✅
    - [ ] Podman容器化构建（Dockerfile.cosmocc，CI可复现）
    - [ ] macOS/Windows实机验证
    - 用途：终端用户零配置分发、便携式部署、边缘设备
    - 注：zig build仅用于Linux开发构建（make release → 1.2MB），跨平台分发走cosmocc
  
  - **libndtsdb 共享库 → Zig 交叉编译**
    - [x] Linux x86_64 静态库验证 ✅
    - [ ] 拆分 libndtsdb 为独立共享库（公开API头文件 + .so/.dylib/.dll）
    - [ ] macOS x86_64 / ARM64
    - [ ] Windows x86_64
    - [ ] Linux ARM64
    - [ ] make lib-all target（一次编译所有平台共享库）
    - 用途：FFI绑定（Python/Node/Bun/Go 调用 libndtsdb）、嵌入式集成

### Phase 3: 高级特性（v0.3.0+）
- [ ] 内置 HTTP 服务器模式（轻量 REST API）
- [ ] WebSocket 实时推送
- [ ] 插件系统（动态加载 .so/.dll）
- [ ] AI 底层预留接口（llama.cpp 集成点）

---

## 5. 实施路径

### 阶段 1: 技术预研（1-2 周）
**负责**: 1号（底层）+ 006（工程）

1. **libndtsdb 接口评估**
   - 当前暴露的 C API 清单
   - 哪些功能需要下沉到 libndtsdb
   - FFI 边界设计（值传递 vs 指针传递）

2. **QuickJS 集成验证**
   - 最小 POC: QuickJS + libndtsdb 静态链接
   - 性能基准: insert/query 吞吐 vs Bun 版
   - 内存占用对比

3. **构建系统选型**
   - Zig Build（推荐，统一工具链）
   - 或 CMake + 交叉编译

**交付物**:
- `docs/ndtsdb-cli/poc-report.md` - 预研报告
- `poc/qjs-ndtsdb-minimal/` - 最小可运行示例

### 阶段 2: MVP 开发（2-3 周）
**负责**: 006/007（CLI 工程）

1. 绑定层开发（C + QuickJS API）
2. 嵌入式 JS 标准库（fs, console, timers）
3. 命令行接口（REPL + 脚本模式）
4. 基础测试套件

**交付物**:
- `ndtsdb-cli/src/` - 完整源码
- `ndtsdb-cli/build.zig` - 构建配置
- `ndtsdb-cli/releases/ndtsdb-cli-v0.1.0-linux-x64` - 发布二进制

### 阶段 3: 验证与迭代（1 周）
**负责**: 4号（策略）+ 8号（验收）

1. 与现有 Bun 版数据兼容性测试
2. 性能对比测试（insert/query 吞吐）
3. 实际场景验证（虚拟市场数据生成 → 存储 → 查询）

---

## 6. 与现有 Bun/TS 版的关系

### 6.1 功能对应表

| 功能 | Bun/TS 版 | CLI/QuickJS 版 | 备注 |
|------|-----------|----------------|------|
| 文件格式 | .ndts | .ndts | 100% 兼容 |
| 基础 CRUD | ✅ | MVP | 优先保证 |
| 流式指标 | ✅ | v0.2.0 | 逐步补齐 |
| SQL 查询 | ✅ | v0.2.0 | 逐步补齐 |
| 压缩算法 | Gorilla | Gorilla | 复用 libndtsdb |
| 分区表 | ✅ | ✅ | 复用 libndtsdb |
| TypeScript | ✅ | ❌ (JS only) | 这是 trade-off |
| npm 生态 | ✅ | 内置 stdlib | 受限但有 |

### 6.2 推荐使用场景

**用 Bun/TS 版**:
- 开发阶段，需要 TypeScript 类型检查
- 高频交易，性能敏感
- 复杂业务逻辑，需要 npm 生态
- 团队协作，代码可维护性优先

**用 CLI/QuickJS 版**:
- 生产部署，简化运维
- 边缘设备，资源受限
- 嵌入式场景，需要单二进制
- 轻量脚本，快速自动化

---

## 7. 验收标准

### MVP 验收（v0.1.0）

1. **功能性**
   - [ ] 能读写现有 Bun 版生成的 .ndts 文件
   - [ ] insert 100万条数据不崩溃
   - [ ] query 返回结果与 Bun 版一致

2. **性能**
   - [ ] insert 吞吐 ≥ Bun 版的 50%
   - [ ] query 延迟 ≤ Bun 版的 2 倍
   - [ ] 启动时间 ≤ 10ms

3. **体积**
   - [ ] 单二进制 ≤ 5MB（Linux x64）

4. **兼容性**
   - [ ] 数据文件 100% 互通（Bun ↔ CLI）

---

## 8. 附录

### 8.1 参考资源

- **QuickJS 官方**: https://bellard.org/quickjs/
- **QuickJS 文档**: https://quickjs-ng.github.io/quickjs/
- **现有 libndtsdb**: `../ndtsdb/src/lib/`
- **Bun 版 API 参考**: `../quant-lib/src/storage/ndtsdb.ts`

### 8.2 相关 Issue/PR

- ndtsdb 核心: #1 (libndtsdb FFI 优化)
- 数据格式: #2 (Columnar 存储格式 v1.0)

### 8.3 术语表

| 术语 | 说明 |
|------|------|
| **libndtsdb** | ndtsdb 的 C/Zig 核心库，负责存储引擎 |
| **QuickJS** | Fabrice Bellard 的嵌入式 JS 引擎 |
| **ndtsdb-cli** | 本产品，基于 QuickJS + libndtsdb 的命令行工具 |
| **Bun/TS 版** | 现有的 Bun + TypeScript 实现 |

---

**下一步动作**:
1. 1号评估 libndtsdb 接口，输出 `poc-report.md`
2. 006 搭建 QuickJS + libndtsdb 最小 POC
3. 总裁 review 预研报告，决定是否进入 MVP 开发

**风险**:
- QuickJS 性能可能不满足高频场景（缓解: 热路径下沉到 libndtsdb）
- 绑定层开发工作量可能被低估（缓解: 先做最小 POC 验证）
