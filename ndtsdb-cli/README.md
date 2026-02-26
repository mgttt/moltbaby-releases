# ndtsdb-cli

**N-Dimensional Time Series Database CLI**

跨平台时序数据库命令行工具。单文件 APE (Actually Portable Executable)，零依赖。

```
C · QuickJS · Cosmocc APE · 零依赖 · <3MB
```

## 定位

ndtsdb-cli 是面向 **生产部署** 和 **边缘计算** 的轻量级 CLI：
- 单文件可执行程序（Linux/macOS/Windows/FreeBSD 通用）
- 零运行时依赖
- QuickJS 嵌入式脚本引擎
- 复用 libndts 核心代码（静态链接）

## 下载

```bash
wget https://.../ndtsdb-cli.com
chmod +x ndtsdb-cli.com
./ndtsdb-cli.com --help
```

## 快速开始

```bash
# 写入数据
echo '{"symbol":"BTC","interval":"1h","timestamp":1700000000000,...}' | \
  ./ndtsdb-cli.com write-json --database ./db

# SQL 查询
./ndtsdb-cli.com sql --database ./db \
  --query "SELECT symbol, AVG(close) FROM data GROUP BY symbol"

# JS 脚本
./ndtsdb-cli.com script strategy.js --database ./db

# REPL
./ndtsdb-cli.com repl --database ./db
```

## 文档

| 文档 | 说明 |
|------|------|
| **[docs/ndtsdb-cli.md](../docs/ndtsdb-cli.md)** | 完整 CLI 参考与使用指南 |
| **[docs/libndtsdb.md](../docs/libndtsdb.md)** | C 核心库接口 |

## 构建

```bash
# 正式构建 (Podman + Cosmocc)
make cosmo-docker

# 输出: ndtsdb-cli.com (APE 跨平台二进制, ~3MB)
```

## 项目关系

```
┌─────────────────────────────────────────┐
│  ndtsdb-cli (本目录)                     │
│  CLI 工具 · Cosmocc APE                  │
│  QuickJS + libndts (静态链接)             │
└─────────────┬───────────────────────────┘
              │ 静态链接
              ▼
┌─────────────────────────────────────────┐
│  libndtsdb (来自 ../ndtsdb/native/)       │
│  C 核心库 · ndts.c / ndtsdb_vec.c         │
└─────────────────────────────────────────┘
```

**注意**: ndtsdb-cli 与 [ndtsdb](../ndtsdb/) (Bun/TS 版) **数据格式不同**，不互通。

## 已归档文档

历史设计文档已移至 `docs/archive/`：
- API.md / FAQ.md / KNOWLEDGE.md / ...

---

**Version**: 0.2.0
