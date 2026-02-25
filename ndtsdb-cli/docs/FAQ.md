# ndtsdb-cli 常见问题解答

本文档整理了用户在使用 ndtsdb-cli 过程中遇到的常见问题及其解决方法。

## 目录

- [安装问题](#安装问题)
- [构建问题](#构建问题)
- [使用问题](#使用问题)
- [HTTP 服务器](#http-服务器)
- [WebSocket 实时推送](#websocket-实时推送)
- [流式指标](#流式指标)
- [SQL 查询](#sql-查询)
- [插件系统](#插件系统)
- [故障排查](#故障排查)

---

## 安装问题

### Q: 安装时提示 `readline/readline.h: No such file or directory` 怎么办？

**A**: 这是因为缺少 readline 开发库。readline 是可选依赖，用于增强 REPL 模式的体验。

**解决方法**：

1. **安装 readline 开发库**（推荐）

   ```bash
   # Ubuntu/Debian
   sudo apt-get install libreadline-dev

   # macOS
   brew install readline
   ```

2. **禁用 readline**（快速方案）

   ```bash
   # 使用 musl target（无 readline）
   zig build -Dtarget=x86_64-linux-musl
   ```

---

### Q: 如何选择合适的安装方式？

**A**: ndtsdb-cli 提供三种安装方式：

| 方式 | 适用场景 | 优点 | 缺点 |
|------|---------|------|------|
| **下载 Release** | 生产环境 | 无需编译 | 灵活性低 |
| **Makefile 构建** | Linux 开发 | 简单快速 | 仅限 Linux x86-64 |
| **Zig 构建** | 跨平台 | 支持多平台 | 需安装 Zig |

**推荐**：
- 生产环境 → 下载 Release
- Linux 开发 → `make all`
- macOS → `zig build -Dtarget=x86_64-macos` 或 `aarch64-macos`

---

## 构建问题

### Q: macOS 如何构建 ndtsdb-cli？

**A**: v0.2.0 已完全支持 macOS，两种方式：

**方式1: Makefile（推荐）**

```bash
# macOS 自动禁用静态链接
make all
```

**方式2: Zig 跨平台构建**

```bash
# Intel Mac
zig build -Dtarget=x86_64-macos -Doptimize=ReleaseFast

# Apple Silicon (M1/M2/M3)
zig build -Dtarget=aarch64-macos -Doptimize=ReleaseFast
```

**注意**：macOS 已添加 `clock_gettime` 和 `getline` 兼容层，无需额外配置。

---

### Q: 使用 Zig 构建时提示 `library not found for -lquickjs` 怎么办？

**A**: 缺少静态链接库。检查并编译：

```bash
# 检查静态库
ls -lh ndtsdb-cli/lib/
# 应该看到 libquickjs.a 和 libndts.a

# 如果缺失，从 Release 下载或手动编译
```

---

### Q: 跨平台编译时如何选择 target？

**A**: 常用 target 对照表：

| 目标平台 | Zig Target | 备注 |
|---------|-----------|------|
| Linux x86-64 | `x86_64-linux-gnu` | 推荐，支持 readline |
| Linux ARM64 | `aarch64-linux-gnu` | 树莓派 |
| macOS Intel | `x86_64-macos` | v0.2.0+ 完全支持 |
| macOS Apple Silicon | `aarch64-macos` | M1/M2/M3 |

---

## 使用问题

### Q: ndtsdb-cli 与 Bun/TS 版本的 ndtsdb 有什么区别？

**A**: 两者功能等价，主要区别在部署：

| 特性 | ndtsdb-cli | Bun/TS 版本 |
|------|-----------|------------|
| **运行时** | QuickJS | Bun |
| **依赖** | 零依赖 | 需要 Bun |
| **启动** | <10ms | ~100ms |
| **内存** | ~5-10MB | ~30-50MB |

**推荐**：
- **ndtsdb-cli**：生产部署、边缘计算
- **Bun/TS**：开发调试、数据处理

---

### Q: 如何在 JavaScript 脚本中使用 ndtsdb-cli？

**A**: 使用 ES2020 模块语法：

```javascript
import * as ndtsdb from 'ndtsdb';

// 打开数据库
const db = ndtsdb.open('./data/BTC.ndts');

// 插入数据
ndtsdb.insert(db, 'BTCUSDT', '1h', {
  timestamp: 1700000000000n,  // BigInt
  open: 100.0,
  high: 101.0,
  low: 99.0,
  close: 100.5,
  volume: 1000
});

// 查询数据
const rows = ndtsdb.queryFiltered(db, ['BTCUSDT']);

// 关闭数据库
ndtsdb.close(db);
```

---

## HTTP 服务器

### Q: 如何启动 HTTP 服务器？

**A**: 使用 `serve` 子命令：

```bash
# 基本启动
./ndtsdb-cli serve --database ./data/btc

# 指定端口
./ndtsdb-cli serve --database ./data/btc --port 8080

# 后台运行
./ndtsdb-cli serve --database ./data/btc --port 8080 &
```

**API 端点**：

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/symbols` | 列出所有 symbol |
| GET | `/query?symbol=BTCUSDT&limit=10` | 查询数据 |
| POST | `/write-json` | 写入数据 |

**示例**：

```bash
# 健康检查
curl http://localhost:8080/health

# 查询数据
curl "http://localhost:8080/query?symbol=BTCUSDT&limit=10"

# 写入数据
curl -X POST http://localhost:8080/write-json \
  -H "Content-Type: application/json" \
  -d '{"symbol":"BTCUSDT","interval":"1m","timestamp":1700000000000,"open":30000,"high":30100,"low":29900,"close":30050,"volume":100}'
```

---

### Q: HTTP 服务器端口被占用怎么办？

**A**: 两种解决方法：

1. **换一个端口**

   ```bash
   ./ndtsdb-cli serve --database ./data/btc --port 8081
   ```

2. **查找并关闭占用端口的进程**

   ```bash
   # 查找占用 8080 端口的进程
   lsof -i :8080
   
   # 关闭进程
   kill -9 <PID>
   ```

---

## WebSocket 实时推送

### Q: WebSocket 如何订阅？示例命令？

**A**: 使用 `/subscribe` 端点，支持实时数据推送：

**浏览器示例**：

```javascript
const ws = new WebSocket('ws://localhost:8080/subscribe?symbol=BTCUSDT&interval=1m');

ws.onopen = () => console.log('Connected');

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Received:', data);
};

ws.onerror = (error) => console.error('Error:', error);
```

**命令行示例**（需要 websocat）：

```bash
# 安装 websocat
cargo install websocat

# 订阅 BTCUSDT
websocat "ws://localhost:8080/subscribe?symbol=BTCUSDT&interval=1m"
```

**Python 示例**：

```python
import socket
import hashlib
import base64

# WebSocket 握手
key = base64.b64encode(b'random-key').decode()
request = (
    f"GET /subscribe?symbol=BTCUSDT&interval=1m HTTP/1.1\r\n"
    f"Host: localhost:8080\r\n"
    f"Upgrade: websocket\r\n"
    f"Connection: Upgrade\r\n"
    f"Sec-WebSocket-Key: {key}\r\n"
    f"Sec-WebSocket-Version: 13\r\n\r\n"
)

sock = socket.socket()
sock.connect(('localhost', 8080))
sock.send(request.encode())

# 读取响应
response = sock.recv(4096)
print("Handshake:", response.decode())
```

**消息格式**：

```json
// 连接确认
{"type":"connected","symbol":"BTCUSDT","interval":"1m"}

// 数据推送
{"symbol":"BTCUSDT","interval":"1m","timestamp":1700000001000,"open":30050,"high":30200,"low":30000,"close":30100,"volume":200}

// 心跳（无新数据时）
{"type":"heartbeat"}
```

---

## 流式指标

### Q: 如何使用流式指标（SMA/EMA/RSI/MACD/BB）？

**A**: ndtsdb-cli 内置流式指标库，支持实时计算：

```javascript
import { StreamingSMA, StreamingEMA, StreamingRSI, StreamingMACD, StreamingBB } from 'stdlib/indicators.js';

// SMA - 简单移动平均
const sma = new StreamingSMA(20);
for (const row of data) {
  const value = sma.update(row.close);
  if (value !== null) console.log(`SMA20: ${value.toFixed(2)}`);
}

// EMA - 指数移动平均
const ema = new StreamingEMA(20);
const value = ema.update(close);

// RSI - 相对强弱指标
const rsi = new StreamingRSI(14);
const value = rsi.update(close);
// > 70 超买，< 30 超卖

// MACD
const macd = new StreamingMACD(12, 26, 9);
const result = macd.update(close);
// result = { macd, signal, histogram }

// BB - 布林带
const bb = new StreamingBB(20, 2);
const result = bb.update(close);
// result = { upper, middle, lower, bandwidth, percentB }
```

**状态检查**：

```javascript
console.log(sma.value);    // 当前值
console.log(sma.isReady);  // 是否有足够数据
console.log(sma.count);    // 已接收数据点数
```

---

## SQL 查询

### Q: 如何使用 SQL 查询数据？

**A**: 使用 `sql` 子命令：

```bash
# 基本查询
./ndtsdb-cli sql --database ./data/btc --query "SELECT * FROM data LIMIT 10"

# 条件查询
./ndtsdb-cli sql --database ./data/btc --query "SELECT symbol,close FROM data WHERE symbol='BTCUSDT' AND timestamp > 1700000000000 LIMIT 100"

# 从 stdin 读取 SQL
echo "SELECT * FROM data LIMIT 10" | ./ndtsdb-cli sql --database ./data/btc
```

**支持的 SQL 语法**：

```sql
-- 基本查询
SELECT * FROM data
SELECT symbol, timestamp, close FROM data

-- WHERE 条件
WHERE symbol='BTCUSDT'
WHERE timestamp > 1700000000000
WHERE timestamp >= 1700000000000 AND timestamp < 1700086400000
WHERE symbol='BTCUSDT' AND timestamp > 1700000000000

-- LIMIT
LIMIT 100
```

**输出格式**：JSON Lines（每行一个 JSON 对象）

---

### Q: SQL 语法错误怎么办？

**A**: 常见错误和正确写法：

| 错误 | 原因 | 正确写法 |
|------|------|----------|
| `DELETE FROM data` | 不支持 DELETE | 仅支持 SELECT |
| `WHERE timestamp > '2024-01-01'` | 需要数字时间戳 | `WHERE timestamp > 1704067200000` |
| `WHERE symbol=BTCUSDT` | 字符串需要引号 | `WHERE symbol='BTCUSDT'` |
| `ORDER BY timestamp` | 不支持 ORDER BY | 数据已按时间排序 |

---

## 插件系统

### Q: 如何写插件？最小示例？

**A**: 插件是一个 JS 文件，通过 `--plugin` 加载：

**插件文件** (`my-plugin.js`)：

```javascript
// 最小插件示例
function onLoad(registry) {
  // 注册全局函数
  registry.register('myFunction', (a, b) => {
    return a + b;
  });
  
  // 或直接挂载到 globalThis
  globalThis.myHelper = (data) => {
    console.log('Helper called with:', data);
    return data.length;
  };
}

// 导出
globalThis.onLoad = onLoad;
```

**使用插件**：

```bash
# 加载插件并执行脚本
./ndtsdb-cli --plugin ./my-plugin.js my-script.js

# 在脚本中使用
# my-script.js
const result = myFunction(1, 2);  // 3
const count = myHelper([1, 2, 3]);  // 3
```

**高级插件示例**：

```javascript
// metrics-plugin.js
function onLoad(registry) {
  const metrics = {};
  
  registry.register('recordMetric', (name, value) => {
    metrics[name] = value;
  });
  
  registry.register('getMetrics', () => {
    return JSON.stringify(metrics);
  });
}

globalThis.onLoad = onLoad;
```

---

## 故障排查

### Q: 运行时出现段错误 (Segmentation Fault) 怎么办？

**A**: 按以下步骤排查：

1. **确认版本**：`./ndtsdb-cli --version`（需要 v0.2.0+）
2. **检查数据库文件**：`ls -lh ./data/`
3. **重新构建**：`make clean && make all`
4. **检查资源**：`free -h` 和 `df -h`

---

### Q: `Error: --database is required` 错误？

**A**: 必须指定 `--database` 参数：

```bash
# ❌ 错误
./ndtsdb-cli query

# ✅ 正确
./ndtsdb-cli query --database ./data/btc
```

---

### Q: `Error: --database path cannot be empty` 错误？

**A**: 路径不能为空字符串：

```bash
# ❌ 错误
./ndtsdb-cli query --database ""

# ✅ 正确
./ndtsdb-cli query --database ./data/btc
```

---

### Q: WebSocket 握手失败怎么办？

**A**: 常见原因：

1. **服务器未启动**：先运行 `serve` 命令
2. **端口错误**：确认端口号匹配
3. **路径错误**：使用 `/subscribe?symbol=XXX`
4. **版本问题**：确保 v0.2.0+

```bash
# 正确的 WebSocket URL
ws://localhost:8080/subscribe?symbol=BTCUSDT&interval=1m
```

---

## 未找到答案？

如果您的问题未在本文档中找到答案，请：

1. 查看 [README](../README.md)
2. 查看 [故障排查指南](troubleshooting.md)
3. 查看示例代码：`scripts/` 目录
4. 提交 Issue: https://github.com/your-org/ndtsdb/issues

---

**最后更新**：2026-02-22  
**版本**：v0.2.0
