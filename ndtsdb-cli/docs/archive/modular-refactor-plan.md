# ndtsdb-cli main.c 模块化拆分方案

## 1. 现状分析

### 1.1 文件规模
- **总行数**: 5209 行
- **子命令数**: 26 个独立子命令
- **核心问题**: 单文件过大，编译慢，协作冲突多，难以维护

### 1.2 功能区块统计

| 区块 | 行数范围 | 行数 | 说明 |
|------|----------|------|------|
| Preamble (headers) | 1-85 | 85 | 头文件包含、跨平台兼容层 |
| WebSocket 支持 | 116-538 | 422 | ws_frame 结构、握手、收发 |
| C stdlib 函数 | 539-902 | 363 | bridge_xxx JS 绑定函数 |
| **Data I/O** ||||
| write-csv | 1392-1469 | 77 | CSV 写入 |
| write-json | 1470-1811 | 341 | JSON 写入 |
| delete | 2126-2197 | 71 | Tombstone 软删除 |
| export | 3978-4050 | 72 | 数据导出 |
| **Query** ||||
| query | 1181-1340 | 159 | 基础查询 |
| list | 1341-1391 | 50 | 列表面询 |
| partitioned | 1812-2125 | 313 | 分区操作 |
| tail | 3395-3514 | 119 | 尾部查询 |
| head | 3515-3631 | 116 | 头部查询 |
| count | 4051-4116 | 65 | 计数查询 |
| info | 4117-4182 | 65 | 数据库信息 |
| **Indicators** ||||
| sma | 2326-2442 | 116 | SMA 指标 |
| vwap | 2443-2556 | 113 | VWAP 指标 |
| ema | 2557-2680 | 123 | EMA 指标 |
| atr | 2681-2819 | 138 | ATR 指标 |
| obv | 2820-2933 | 113 | OBV 指标 |
| rsi | 2934-3084 | 150 | RSI 指标 |
| macd | 3085-3238 | 153 | MACD 指标 |
| bollinger | 3239-3394 | 155 | 布林带指标 |
| **SQL/Advanced** ||||
| sql | 4303-4736 | 433 | SQL 解析执行 |
| merge | 4737-4886 | 149 | 数据库合并 |
| resample | 4887-~5000 | 320 | 重采样 |
| **Scripting** ||||
| serve | 903-1180 | 277 | HTTP 服务 |
| script | 3632-3977 | 345 | JS 脚本执行 |
| repl | 4183-4302 | 119 | 交互式 REPL |
| wal-replay | 2198-2325 | 127 | WAL 回放 |

### 1.3 耦合分析

**高耦合区块**:
1. **WebSocket (422行)**: 被 `serve` 子命令独占使用，但定义在全局
2. **C stdlib (363行)**: 被 `script` 和 `serve` 共享
3. **SQL engine (433行)**: 自包含，但解析逻辑与 query 有重叠

**低耦合区块**:
1. **Indicators (1061行总计)**: 每个指标完全独立，仅依赖 query_all
2. **write-csv/write-json**: 独立，仅依赖 core API

---

## 2. 拆分方案

### 2.1 目标文件结构

```
src/
├── main.c                 # 入口 + 命令分发（约 300 行）
├── common.h               # 共享头文件
├── common.c               # 共享工具函数
├── compat.h               # 跨平台兼容层
├── ws.h / ws.c            # WebSocket 支持
├── qjs_bridge.h / .c      # QuickJS 绑定
├── cmd_io.c               # write-csv, write-json, export, delete
├── cmd_query.c            # query, list, head, tail, count, info
├── cmd_partitioned.c      # partitioned 子命令
├── cmd_indicators.c       # sma, vwap, ema, atr, obv, rsi, macd, bollinger
├── cmd_sql.c              # sql, merge, resample
├── cmd_serve.c            # serve (HTTP + WebSocket)
├── cmd_script.c           # script, repl
└── wal.c                  # wal-replay
```

### 2.2 各模块职责

#### main.c (约 300 行)
```c
// 仅保留：
// - main() 函数
// - 命令行解析框架
// - 子命令分发 switch-case
// - help 文本
```

#### cmd_io.c (约 550 行)
```c
// write-csv, write-json, export, delete
// 依赖: common.h, ndtsdb.h
// 共享: 批量写入工具函数
```

#### cmd_query.c (约 450 行)
```c
// query, list, head, tail, count, info
// 依赖: common.h, ndtsdb.h
// 共享: query_all + 过滤逻辑
```

#### cmd_partitioned.c (约 320 行)
```c
// partitioned list/query/write-json
// 依赖: common.h, ndtsdb.h
// 注意: 可能依赖 cmd_query 的部分逻辑
```

#### cmd_indicators.c (约 1100 行)
```c
// 所有技术指标: sma, vwap, ema, atr, obv, rsi, macd, bollinger
// 依赖: common.h, ndtsdb.h, <math.h>
// 共享: 价格数据获取工具函数 (fetch_closes)
```

#### cmd_sql.c (约 900 行)
```c
// sql, merge, resample
// 依赖: common.h, ndtsdb.h
// 注意: SQL 解析器保持内联
```

#### cmd_serve.c (约 700 行)
```c
// serve 子命令
// 依赖: common.h, ws.h, qjs_bridge.h
// 包含: HTTP 服务 + WebSocket
```

#### cmd_script.c (约 470 行)
```c
// script, repl
// 依赖: common.h, qjs_bridge.h
```

#### common.h / common.c (约 200 行)
```c
// 共享类型定义
// ndtsdb_open/read/close 包装函数
// 错误处理宏
// 时间戳工具函数
```

#### ws.h / ws.c (约 450 行)
```c
// WebSocket 帧结构
// ws_send, ws_recv
// HTTP 升级握手
```

#### qjs_bridge.h / .c (约 380 行)
```c
// QuickJS 绑定函数
// bridge_xxx 系列
```

#### wal.c (约 130 行)
```c
// wal-replay
// 依赖: common.h
```

---

## 3. 公共头文件设计

### common.h
```c
#ifndef COMMON_H
#define COMMON_H

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <stdint.h>
#include "ndtsdb.h"

// 版本号
#define NDTSDB_CLI_VERSION "0.3.8"

// 错误处理宏
#define CHECK(cond, msg) if (!(cond)) { fprintf(stderr, "Error: %s\n", msg); goto cleanup; }

// 数据库包装函数
NDTSDB* db_open_or_exit(const char* path);
QueryResult* db_query_all_or_exit(NDTSDB* db);

// 结果行类型 (原 ResultRow)
typedef struct {
    KlineRow row;
    char symbol[32];
    char interval[16];
} ResultRow;

// 过滤后的数据点
typedef struct {
    double* closes;
    double* highs;
    double* lows;
    double* volumes;
    int64_t* timestamps;
    int count;
} PriceData;

// 提取过滤后的价格数据
PriceData fetch_price_data(NDTSDB* db, const char* symbol, const char* interval, 
                           int64_t since, int64_t until);
void free_price_data(PriceData* data);

// 输出格式化
void print_json_row(FILE* out, ResultRow* row);
void print_csv_header(FILE* out);

#endif
```

---

## 4. 构建系统集成

### 4.1 build.zig 改动

```zig
const exe = b.addExecutable(.{
    .name = "ndtsdb-cli",
    .root_source_file = b.path("src/main.c"),
    .target = target,
    .optimize = optimize,
});

// 新增源文件列表
const sources = &.{
    "src/common.c",
    "src/ws.c",
    "src/qjs_bridge.c",
    "src/cmd_io.c",
    "src/cmd_query.c",
    "src/cmd_partitioned.c",
    "src/cmd_indicators.c",
    "src/cmd_sql.c",
    "src/cmd_serve.c",
    "src/cmd_script.c",
    "src/wal.c",
    // ... 原有 ndtsdb, quickjs 等
};

for (sources) |src| {
    exe.addCSourceFile(.{ .file = b.path(src), .flags = cflags });
}
```

### 4.2 Makefile 改动

```makefile
SOURCES = src/main.c \
          src/common.c src/ws.c src/qjs_bridge.c \
          src/cmd_io.c src/cmd_query.c src/cmd_partitioned.c \
          src/cmd_indicators.c src/cmd_sql.c \
          src/cmd_serve.c src/cmd_script.c src/wal.c

OBJS = $(SOURCES:.c=.o)

ndtsdb-cli: $(OBJS)
    $(CC) $(OBJS) -o $@ $(LDFLAGS)
```

---

## 5. 风险评估与拆分顺序

### 5.1 风险等级

| 模块 | 风险 | 原因 |
|------|------|------|
| cmd_indicators | 低 | 完全独立，仅依赖标准库和 core API |
| cmd_io | 低 | 独立，变更频率低 |
| cmd_query | 中 | 被 partitioned、indicators 依赖 |
| cmd_sql | 中 | SQL 解析逻辑复杂，需仔细提取 |
| cmd_serve | 高 | 依赖 WebSocket 和 qjs_bridge |
| main.c | 高 | 分发逻辑改动影响所有命令 |

### 5.2 推荐拆分顺序

**Phase 1: 低风险模块** (2-3 天)
1. 提取 common.h / common.c
2. 拆分 cmd_indicators.c (8 个指标)
3. 拆分 cmd_io.c

**Phase 2: 核心模块** (2-3 天)
4. 拆分 cmd_query.c
5. 拆分 cmd_partitioned.c
6. 拆分 cmd_sql.c

**Phase 3: 复杂模块** (2-3 天)
7. 拆分 ws.h / ws.c
8. 拆分 qjs_bridge.h / .c
9. 拆分 cmd_serve.c
10. 拆分 cmd_script.c

**Phase 4: 收尾** (1 天)
11. 精简 main.c
12. 更新构建脚本
13. 全量测试

---

## 6. 工期估算

| 阶段 | 模块 | 预估工时 | 备注 |
|------|------|----------|------|
| P1 | common.h/c | 2h | 提取共享代码 |
| P1 | cmd_indicators.c | 4h | 8 个指标一起移动 |
| P1 | cmd_io.c | 2h | 包含 export/delete |
| P2 | cmd_query.c | 3h | 需处理依赖 |
| P2 | cmd_partitioned.c | 2h | 依赖 cmd_query 的工具函数 |
| P2 | cmd_sql.c | 4h | SQL 解析器保持完整 |
| P3 | ws.h/c | 3h | WebSocket 独立 |
| P3 | qjs_bridge.h/c | 3h | QJS 绑定独立 |
| P3 | cmd_serve.c | 3h | 整合 ws 和 qjs_bridge |
| P3 | cmd_script.c | 2h | script + repl |
| P3 | wal.c | 1h | 简单独立 |
| P4 | main.c 精简 | 2h | 移除已拆分代码 |
| P4 | 构建脚本更新 | 2h | build.zig + Makefile |
| P4 | 测试验证 | 3h | 107 项集成测试 |
| **总计** | | **36h (~5 人天)** | |

### 6.1 里程碑

- **Day 1**: Phase 1 完成，indicators + io 拆分完成
- **Day 3**: Phase 2 完成，query + sql 拆分完成
- **Day 5**: Phase 3 完成，serve + script 拆分完成
- **Day 6**: Phase 4 完成，测试全部通过

---

## 7. 验证标准

拆分完成后需验证：

1. **功能验证**: `./test-v0.3.0.sh` 107 项测试全部通过
2. **编译验证**: `zig build` 和 `make` 都成功
3. **性能验证**: 指标计算速度无退化
4. **代码行数**: main.c < 500 行，单模块 < 1200 行

---

## 8. 参考资料

- 当前 main.c: 5209 行, 26 个子命令
- 目标结构: 13 个文件，平均 400 行/文件
- 关键依赖链: main → cmd_* → common ← ws/qjs_bridge
