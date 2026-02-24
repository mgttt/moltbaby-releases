# Quant-Lab 目录结构

> 重构后的完整目录结构  
> 日期: 2026-02-08

```
quant-lab/
├── README.md                      # 项目说明
├── package.json                   # 依赖配置
│
├── src/                           # 源代码
│   ├── index.ts                   # 主入口
│   │
│   ├── pool/                      # 资源池
│   │   ├── StrategyPool.ts       # 策略池（包装 StrategyEngine）
│   │   └── index.ts              # 模块导出
│   │
│   ├── director/                  # 调度器
│   │   ├── director.ts           # Director 类
│   │   ├── service.ts            # HTTP API 服务
│   │   └── index.ts              # 模块导出
│   │
│   ├── worker/                    # Worker
│   │   ├── lifecycle.ts          # Worker 生命周期
│   │   ├── pool-integration.ts   # Worker 注册到 Pool
│   │   ├── strategy-loader.ts    # 策略加载器
│   │   ├── api-pool.ts           # API 连接池
│   │   ├── log-buffer.ts         # 日志缓冲
│   │   ├── bridge/               # QuickJS 桥接
│   │   │   └── index.ts
│   │   └── types.ts              # 类型定义
│   │
│   ├── quickjs/                   # QuickJS 集成
│   │   └── context.ts            # QuickJSContext
│   │
│   ├── config/                    # 配置
│   │   └── accounts.ts           # 账号配置
│   │
│   └── monitoring/               # 监控
│       └── index.ts              # 状态导出
│
├── strategies/                   # 策略
│   ├── test/                     # 测试策略
│   │   └── bridge-test.ts
│   ├── short-martingale/         # 短马丁策略
│   │   └── index.ts
│   ├── grid-martingale/          # 网格策略
│   │   └── index.ts
│   └── system/                   # 系统策略（定时任务）
       ├── volatility-collector.ts # 波动率采集
       └── positions-reporter.ts   # 持仓报告
│
├── dashboard/                    # 监控面板 (NEW)
│   ├── package.json
│   ├── public/
│   │   └── index.html            # 前端页面
│   └── src/
│       └── server.ts             # 可选：独立服务器
│
├── cli/                          # 命令行工具
│   └── quant-lab.ts              # CLI 入口
│
├── tests/                        # 测试
│   ├── e2e/                      # 端到端测试
│   │   └── run.ts
│   └── live/                     # 真实账号测试
│       └── run.ts
│
├── docs/                         # 文档
│   ├── IMPLEMENTATION-v2.md      # 实施计划
│   ├── tree-worker-pool.md       # 树状 Worker 设计
│   └── ...
│
└── data/                         # 运行时数据
    └── state/                    # 状态文件
```

## 依赖关系

```
quant-lab
├── depends on: quant-lib
│   ├── exchange/                 # BybitClient, BinanceClient
│   ├── scheduling/               # StrategyEngine
│   ├── storage/                  # KlineDatabase
│   └── utils/                    # ConfigManager, Logger
│
└── depends on: workpool-lib (via quant-lib)
    └── TreeEngine                # 树状资源调度
```

## 关键文件说明

### 核心类

| 文件 | 类 | 职责 |
|------|-----|------|
| `src/pool/StrategyPool.ts` | StrategyPool | 包装 StrategyEngine，提供 quant-lab 特定功能 |
| `src/director/director.ts` | Director | 策略调度管理 |
| `src/director/service.ts` | - | HTTP API 服务 (Port 8080) |
| `src/worker/lifecycle.ts` | - | Worker 生命周期管理 |
| `src/worker/strategy-loader.ts` | - | 加载策略到 QuickJS |

### 策略

| 路径 | 类型 | 说明 |
|------|------|------|
| `strategies/system/volatility-collector.ts` | 系统策略 | 每小时采集波动率 |
| `strategies/system/positions-reporter.ts` | 系统策略 | 每小时查询持仓 |
| `strategies/short-martingale/index.ts` | 交易策略 | 短马丁策略 |
| `strategies/grid-martingale/index.ts` | 交易策略 | 网格策略 |

## 运行时流程

```
1. Director 启动
   └── src/director/service.ts
       ├── 注册系统 Worker
       ├── 注册定时策略 (Cron)
       └── 启动 HTTP 服务

2. 定时任务触发 (systemd)
   └── shell script
       └── curl http://localhost:8080/api/tasks/:name
           └── Director.scheduleStrategy()
               └── Worker 执行策略

3. 手动触发策略
   └── Dashboard 或 CLI
       └── POST /api/tasks/:name
           └── Director.scheduleStrategy()
```

## 外部依赖

| 依赖 | 来源 | 用途 |
|------|------|------|
| `quant-lib` | workspace | 量化库 |
| `workpool-lib` | workspace (via quant-lib) | 资源调度 |
| `DuckDB` | npm | 数据存储 |
| `QuickJS` | npm | 策略沙箱 |

## 配置文件

| 文件 | 说明 |
|------|------|
| `~/env.jsonl` | API 密钥配置 |
| `~/.config/quant/accounts.json` | 账号配置 (新格式) |
| `systemd/*.service` | 服务配置 |
| `systemd/*.timer` | 定时器配置 |
