# ndtsdb-cli 故障排查指南

本文档提供常见错误的诊断和解决方法。

## 目录

- [启动错误](#启动错误)
- [数据库错误](#数据库错误)
- [HTTP 服务器错误](#http-服务器错误)
- [WebSocket 错误](#websocket-错误)
- [SQL 错误](#sql-错误)
- [性能问题](#性能问题)

---

## 启动错误

### `Error: --database is required`

**原因**：未指定数据库路径。

**解决**：

```bash
# 所有子命令都需要 --database
./ndtsdb-cli query --database ./data/btc
./ndtsdb-cli list --database ./data/btc
./ndtsdb-cli write-csv --database ./data/btc
./ndtsdb-cli sql --database ./data/btc --query "SELECT * FROM data"
./ndtsdb-cli serve --database ./data/btc
```

---

### `Error: --database path cannot be empty`

**原因**：数据库路径为空字符串。

**解决**：

```bash
# ❌ 错误
./ndtsdb-cli query --database ""

# ✅ 正确
./ndtsdb-cli query --database ./data/btc
```

---

### `library not found for -lquickjs`

**原因**：缺少静态链接库。

**解决**：

```bash
# 检查静态库
ls -lh lib/
# 应该看到 libquickjs.a 和 libndts.a

# 如果缺失，从 Release 下载或重新编译
```

---

## 数据库错误

### 数据库文件损坏

**症状**：读取时报错或数据不完整。

**诊断**：

```bash
# 检查文件大小
ls -lh ./data/btc

# 尝试 list 命令
./ndtsdb-cli list --database ./data/btc
```

**解决**：

1. **自动恢复**：ndtsdb 会尝试自动恢复
2. **从备份恢复**：`cp backup.ndts data.ndts`
3. **重建**：从原始数据源重新导入

---

### 写入失败

**症状**：`write-csv` 或 `write-json` 无数据写入。

**诊断**：

```bash
# 检查输入格式
cat data.csv | head -3

# 检查输出
echo 'test' | ./ndtsdb-cli write-csv --database ./data/btc
```

**常见原因**：

| 错误 | 原因 | 解决 |
|------|------|------|
| `insufficient columns` | CSV 列数不足 | 检查 CSV 格式 |
| `missing required fields` | 缺少必需字段 | 添加 symbol/interval/timestamp |
| `Parse error` | JSON 格式错误 | 检查 JSON 语法 |

**正确格式**：

```csv
symbol,interval,timestamp,open,high,low,close,volume
BTCUSDT,1m,1700000000000,30000,30100,29900,30050,100
```

```json
{"symbol":"BTCUSDT","interval":"1m","timestamp":1700000000000,"open":30000,"high":30100,"low":29900,"close":30050,"volume":100}
```

---

## HTTP 服务器错误

### 端口被占用

**错误信息**：`Error: Failed to bind to port 8080`

**诊断**：

```bash
# 查找占用端口的进程
lsof -i :8080

# 或
netstat -tlnp | grep 8080
```

**解决**：

```bash
# 方法1: 换端口
./ndtsdb-cli serve --database ./data/btc --port 8081

# 方法2: 关闭占用进程
kill -9 <PID>
```

---

### 连接被拒绝

**错误信息**：`Connection refused`

**诊断**：

```bash
# 检查服务器是否运行
ps aux | grep ndtsdb-cli

# 检查端口
curl http://localhost:8080/health
```

**解决**：

1. 确认服务器已启动
2. 确认端口号正确
3. 检查防火墙设置

---

### 404 Not Found

**错误信息**：`{"error": "Not found"}`

**诊断**：

```bash
# 检查端点
curl http://localhost:8080/health     # 应该返回 ok
curl http://localhost:8080/symbols    # 列出 symbols
curl http://localhost:8080/query      # 查询数据
```

**解决**：使用正确的 API 端点：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/symbols` | GET | 列出 symbols |
| `/query` | GET | 查询数据 |
| `/write-json` | POST | 写入数据 |
| `/subscribe` | WS | WebSocket 订阅 |

---

## WebSocket 错误

### 握手失败

**症状**：WebSocket 连接立即断开。

**诊断**：

```bash
# 测试 HTTP 健康检查
curl http://localhost:8080/health

# 测试 WebSocket 握手
echo -e "GET /subscribe?symbol=BTCUSDT HTTP/1.1\r\nHost: localhost:8080\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n" | nc localhost 8080
```

**期望响应**：

```
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: ...
```

**常见错误**：

| 响应码 | 原因 | 解决 |
|--------|------|------|
| 400 | 请求格式错误 | 检查 WebSocket 握手头 |
| 404 | 路径错误 | 使用 `/subscribe?symbol=XXX` |
| 无响应 | 服务器未启动 | 启动 `serve` |

---

### 无消息接收

**症状**：连接成功但没有数据推送。

**诊断**：

```bash
# 检查数据库是否有数据
./ndtsdb-cli list --database ./data/btc

# 写入测试数据
echo '{"symbol":"BTCUSDT","interval":"1m","timestamp":1700000000000,"open":30000,"high":30100,"low":29900,"close":30050,"volume":100}' | ./ndtsdb-cli write-json --database ./data/btc
```

**解决**：

1. 确保数据库有匹配 symbol 的数据
2. 等待心跳消息（每秒一次）
3. 写入新数据触发推送

---

## SQL 错误

### `Invalid SQL: expected SELECT ... FROM`

**原因**：SQL 语法错误或不支持的语句。

**不支持的语句**：

```sql
-- ❌ 不支持
DELETE FROM data
UPDATE data SET close=100
INSERT INTO data VALUES (...)
DROP TABLE data
```

**正确写法**：

```sql
-- ✅ 支持
SELECT * FROM data
SELECT symbol, close FROM data
SELECT * FROM data WHERE symbol='BTCUSDT'
SELECT * FROM data WHERE timestamp > 1700000000000
SELECT * FROM data WHERE symbol='BTCUSDT' AND timestamp > 1700000000000 LIMIT 100
```

---

### `timestamp > '2024-01-01'` 错误

**原因**：timestamp 需要数字，不是字符串。

**解决**：

```sql
-- ❌ 错误
WHERE timestamp > '2024-01-01'

-- ✅ 正确（毫秒时间戳）
WHERE timestamp > 1704067200000
```

---

### `symbol=BTCUSDT` 错误

**原因**：字符串值需要引号。

**解决**：

```sql
-- ❌ 错误
WHERE symbol=BTCUSDT

-- ✅ 正确
WHERE symbol='BTCUSDT'
```

---

## 性能问题

### 查询慢

**诊断**：

```bash
# 测试查询时间
time ./ndtsdb-cli query --database ./data/btc --format json > /dev/null
```

**优化方法**：

1. **使用 --symbols 过滤**

   ```bash
   # ❌ 慢：全量扫描
   ./ndtsdb-cli query --database ./data/btc
   
   # ✅ 快：native 层过滤（5倍提升）
   ./ndtsdb-cli query --database ./data/btc --symbols BTCUSDT
   ```

2. **使用 --limit 分页**

   ```bash
   ./ndtsdb-cli query --database ./data/btc --limit 100
   ```

3. **使用时间范围**

   ```bash
   ./ndtsdb-cli query --database ./data/btc --since 1700000000000 --until 1700086400000
   ```

---

### 写入慢

**诊断**：

```bash
# 测试写入速度
time cat data.csv | ./ndtsdb-cli write-csv --database ./data/btc
```

**优化方法**：

1. **批量写入**：一次性写入多行，避免多次启动
2. **使用 --format csv**：比 JSON 更快解析

---

### 内存占用高

**诊断**：

```bash
# 检查内存
ps aux | grep ndtsdb-cli
```

**解决**：

1. 使用 `--limit` 限制返回数量
2. 分批查询大数据集
3. 使用流式处理（`--format json` 逐行输出）

---

## 调试技巧

### 启用详细输出

```bash
# 使用 console.log 调试
./ndtsdb-cli -e "
import * as ndtsdb from 'ndtsdb';
console.log('Opening database...');
const db = ndtsdb.open('./data/btc');
console.log('Querying...');
const rows = ndtsdb.queryAll(db);
console.log('Found:', rows.length, 'rows');
"
```

### 检查数据

```bash
# 列出所有 symbols
./ndtsdb-cli list --database ./data/btc

# 查询前几条
./ndtsdb-cli query --database ./data/btc --limit 5 --format table
```

### 测试 HTTP

```bash
# 健康检查
curl -v http://localhost:8080/health

# 查询
curl -v "http://localhost:8080/query?symbol=BTCUSDT&limit=5"
```

---

## 获取帮助

如果以上方法都无法解决问题：

1. 查看 [FAQ](FAQ.md)
2. 查看 [README](../README.md)
3. 查看示例代码：`scripts/` 目录
4. 提交 Issue: https://github.com/your-org/ndtsdb/issues

**提交 Issue 时请包含**：

- ndtsdb-cli 版本：`./ndtsdb-cli --version`
- 操作系统和架构
- 完整的错误信息
- 复现步骤
- 相关日志

---

**最后更新**：2026-02-22  
**版本**：v0.2.0
