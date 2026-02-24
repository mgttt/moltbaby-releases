# WeQuant Tushare Provider 使用指南

## 概述

WeQuant Tushare Provider 提供港股分钟线数据（1min/5min/15min/30min/60min），通过 WeQuant 代理访问 Tushare Pro API。集成到 quant-lib 统一数据层，支持批量拉取并写入 ndtsdb。

## 配置

### 1. Token 配置

从 WeQuant 获取 API Token（免费注册）。Token 已存储在 `~/env.jsonl`：

```json
{"wequant@tushare": {
  "type": "quant_data",
  "provider": "wequant",
  "source": "tushare",
  "proxy_url": "https://wequant.fun/api/proxy/tushare",
  "token": "a5ac0833-859b-4034-a9fd-7562f90b6258",
  "proxy": "http://127.0.0.1:8890",
  "notes": "WeQuant Tushare Proxy for HK stock minute data. Rate limit: 2 req/hour for free tier."
}}
```

环境变量方式：
```bash
export WEQUANT_TOKEN="a5ac0833-859b-4034-a9fd-7562f90b6258"
export PROXY_URL="http://127.0.0.1:8890"
```

### 2. 代理设置

默认使用本地代理 `http://127.0.0.1:8890`（Gost）。如需更改，修改环境变量或 env.jsonl 中的 `proxy` 字段。

## 使用方法

### 快速测试

运行测试脚本验证 token 权限：

```bash
cd quant-lib
bun run scripts/test-wequant-tushare.ts
```

输出示例：
```
🧪 WeQuant Tushare Provider 测试

Test 1: 获取 00001.HK (长和) 1分钟 K线
  ✅ 获取成功: 10 条 K线
  最新 K线: { ... }

Test 2: 获取 00700.HK (腾讯) 5分钟 K线
  ✅ 获取成功: 5 条 K线

Test 3: 健康检查
  ✅ 健康状态: 正常

✅ 测试完成
```

### 批量收集数据

使用 `collect-hk-mins.ts` 脚本批量拉取港股分钟线数据并写入 ndtsdb：

```bash
# 单只股票（最近7天 1分钟K线）
bun run scripts/collect-hk-mins.ts --symbol 00001.HK --interval 1m --days 7

# 批量收集（从文件读取股票列表）
echo -e "00001.HK\n00700.HK\n09988.HK" > hk-stocks.txt
bun run scripts/collect-hk-mins.ts --symbol-list hk-stocks.txt --interval 5m --days 30

# 指定输出目录
bun run scripts/collect-hk-mins.ts --symbol 00700.HK --interval 1m --days 30 --output ./data/my-hk-data
```

## 速率限制说明

**重要：Tushare 免费账户每小时仅允许 2 次 API 调用。**

### Provider 内置处理

- `WeQuantTushareProvider` 已内置 `rateLimit()` 方法，自动排队等待
- 当请求达到限制时，程序会等待直到可以发送下一次请求（+5秒缓冲）
- 等待期间会显示剩余时间：`⏳ 速率限制: 等待 XX 分钟 (XXXs)`

### 批量收集策略

收集 N 只股票的分钟线数据需要大约 N/2 小时。建议：

1. **使用 systemd timer 定时执行**：每小时运行一次，每次处理 2 只股票
2. **分批处理**：将大量股票分成多批，每批间隔 30 分钟以上
3. **升级积分**：如需高频使用，可通过 Tushare 任务获取更多积分

### systemd timer 示例

`~/.config/systemd/user/hk-mins-collect.service`:
```ini
[Service]
Type=oneshot
ExecStart=bun run /home/devali/moltbaby/quant-lib/scripts/collect-hk-mins.ts --symbol-list /home/devali/moltbaby/quant-lib/hk-stocks.txt --interval 5m --days 1
WorkingDirectory=/home/devali/moltbaby/quant-lib
```

`~/.config/systemd/user/hk-mins-collect.timer`:
```ini
[Timer]
OnCalendar=hourly

[Install]
WantedBy=timers.target
```

启用：
```bash
systemctl --user daemon-reload
systemctl --user enable hk-mins-collect.timer
systemctl --user start hk-mins-collect.timer
```

## 数据存储

### ndtsdb 表结构

| 字段 | 类型 | 说明 |
|------|------|------|
| symbol | string | 标准化符号（如 "00001/HKD"） |
| timestamp | int64 | 毫秒级 Unix 时间戳 |
| open | float64 | 开盘价 |
| high | float64 | 最高价 |
| low | float64 | 最低价 |
| close | float64 | 收盘价 |
| volume | float64 | 成交量 |
| amount | float64 | 成交额 |

### 文件位置

默认输出目录：`./data/hk-mins/`

文件命名：`{symbol}_{interval}.ndts`（如 `00001.HK_1m.ndts`）

### 更新策略

UPSERT 冲突键：`symbol + timestamp`（自动去重，避免重复数据）

## 故障排除

| 错误信息 | 原因 | 解决方案 |
|---------|------|---------|
| "每小时最多访问该接口2次" | 免费用户速率限制 | 等待1小时或升级积分 |
| "权限不足" | 积分不够或无港股权限 | 完成 Tushare 任务获取积分 |
| "您还没有填写手机" | 账号未完成认证 | 登录 Tushare 官网绑定手机 |
| 返回空数组 | 该时间段无交易数据 | 检查是否为交易日 |
| 代理连接失败 | 代理服务未运行 | 启动 Gost 代理：`gost -L http://127.0.0.1:8890` |

## 代码位置

- Provider: `quant-lib/src/providers/wequant-tushare.ts`
- 测试脚本: `quant-lib/scripts/test-wequant-tushare.ts`
- 收集脚本: `quant-lib/scripts/collect-hk-mins.ts`
- 集成导出: `quant-lib/src/providers/index.ts`

## 注意事项

1. **交易时间**：港股交易日为 09:30-12:00, 13:00-16:00（北京时间）
2. **数据延迟**：Tushare 分钟线数据有约 15 分钟延迟
3. **节假日**：非交易日无数据，collect 脚本会跳过
4. **磁盘空间**：长期收集需注意磁盘占用（每条记录约 64 字节）

## 后续优化建议

1. **积分升级**：获取更多 Tushare 积分提高调用频率
2. **增量更新**：记录最后收集时间，仅拉取新数据
3. **数据压缩**：对历史数据启用 ndtsdb 列压缩
4. **监控告警**：收集失败时发送 Telegram 通知

---
*最后更新：2026-02-23*