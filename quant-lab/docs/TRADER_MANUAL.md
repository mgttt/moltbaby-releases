# Quant-Lab 策略与操盘手册

**版本**: v3.0  
**日期**: 2026-02-19  
**适用**: 策略开发者、实盘操盘手

---

## 🎯 策略开发指南

### 策略接口
```typescript
interface Strategy {
  onInit(): void;           // 初始化
  onTick(tick: Tick): void; //  Tick处理
  onBar(bar: Bar): void;    // K线处理
  onOrder(order: Order): void; // 订单回调
  onStop(): void;           // 停止
}
```

### 最小示例
```javascript
function onInit() {
  logInfo('策略初始化');
  state.centerPrice = 100;
}

function onTick(tick) {
  if (tick.price > state.centerPrice * 1.02) {
    placeOrder({ side: 'Sell', qty: 100 });
  }
}

function onStop() {
  logInfo('策略停止');
  saveState();
}
```

### 状态持久化
```javascript
// 保存状态
saveState();

// 加载状态（自动在onInit前调用）
loadState();
```

---

## 📈 实盘操作手册

### 启动前检查清单
- [ ] 配置文件已审核（symbol/lean/maxPosition）
- [ ] API Key 权限确认（下单/查询/持仓）
- [ ] 资金充足（保证金 > maxPosition × 2）
- [ ] 测试网验证通过（如适用）

### 启动流程
```bash
# 1. 检查配置
cat configs/my-strategy.json

# 2. 启动策略
bun tools/strategy-cli.ts start ./strategies/my-strategy.js \
  --session my-strategy-live \
  --params '{"symbol":"BTCUSDT","lean":"neutral"}' \
  --live

# 3. 验证启动
bun tools/strategy-cli.ts status my-strategy-live
```

### 监控要点
| 指标 | 正常范围 | 异常处理 |
|------|----------|----------|
| 仓位使用率 | < 93% | 减仓或停策略 |
| 回撤 | < 30% | 检查熔断状态 |
| 订单响应 | < 1s | 检查网络/API |
| 持仓偏差 | < 1% | 等待账本对齐 |

### 紧急处理
**熔断触发**:
1. 查看熔断原因: `logs/<session>.log | grep "熔断"`
2. 等待自动恢复（默认10分钟）
3. 或手动重启: `stop → start`

**持仓异常**:
1. 对比交易所持仓与策略日志
2. 如偏差 > 1%，检查是否有外部操作
3. 联系技术支持（0号/1号）

---

## 🎮 MYXUSDT 实盘配置卡

### 策略参数
```json
{
  "symbol": "MYXUSDT",
  "lean": "negative",
  "gridSpacingUp": 0.02,
  "gridSpacingDown": 0.04,
  "orderSizeUp": 50,
  "orderSizeDown": 100,
  "maxPosition": 7874,
  "magnetDistance": 0.015,
  "emergencyDirection": "manual"
}
```

### 账户信息
- 标的: MYXUSDT
- 方向: 做空为主
- 账号: wjcgm@bybit-sub1
- 资金: 1000 USDT

### 风控规则
- 每2h检查价格偏离
- 异常停机立即上报0号
- 日志记录: ~/logs/gales-myx.log

### 启动命令
```bash
bun tools/strategy-cli.ts start ./strategies/gales-simple.js \
  --session gales-myx-live \
  --params '{"symbol":"MYXUSDT","lean":"negative",...}' \
  --live
```

---

## 🔍 故障排查

### 常见问题

**Q: 策略启动后立即停止？**
A: 检查:
1. API Key 是否有效
2. 配置文件路径是否正确
3. 参数 JSON 格式是否正确

**Q: 订单未成交？**
A: 检查:
1. 价格是否远离市场价（>5%）
2. 账户资金是否充足
3. 是否触发风控限制

**Q: 持仓显示不正确？**
A: 检查:
1. 是否有其他策略/人工操作同账户
2. 账本重建是否完成（重启后30s）
3. 联系1号检查 state key 隔离

---

## 📞 联系方式

| 角色 | 职责 | 联系 |
|------|------|------|
| 0号 | 总协调/异常升级 | @bot-000 |
| 1号 | 底层系统/账本修复 | @bot-001 |
| 4号 | 策略开发 | @bot-004 |
| 8号 | 验收/风控 | @bot-008 |
| 9号 | 实盘操盘 | @bot-009 |

---

## 📁 相关文档

- [产品说明书](./PRODUCT_MANUAL.md)
- [开发路线图](./ROADMAP.md)
- [系统架构](./SYSTEM_OVERVIEW.md)

---

*最后更新: 2026-02-19*
