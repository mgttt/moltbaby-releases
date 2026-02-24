# Quant-Lab 产品说明书

**版本**: v3.0  
**日期**: 2026-02-19  
**适用**: 策略开发者、操盘手、运维

---

## 📖 产品定位

Quant-Lab 是统一的量化策略运行时引擎，支持回测与实盘无缝切换。

**核心能力**:
- 策略一次编写，回测/实盘两用
- 事件驱动架构（Init/Tick/Bar/Order/Stop）
- 多交易所适配（Paper/Binance/Bybit）
- 内置风控（仓位/回撤/熔断）

---

## 🚀 快速部署

### 1. 环境准备
```bash
# 安装 Bun
curl -fsSL https://bun.sh/install | bash

# 克隆仓库
git clone <repo> quant-lab
cd quant-lab
bun install
```

### 2. 策略配置
```typescript
// strategies/my-strategy.js
const CONFIG = {
  symbol: 'BTCUSDT',
  lean: 'neutral',  // positive/negative/neutral (仓位倾向)
  gridSpacing: 0.02,
  orderSize: 100,
  maxPosition: 10000,
};
```

### 3. 启动实盘
```bash
bun tools/strategy-cli.ts start ./strategies/my-strategy.js \
  --session my-strategy-live \
  --live
```

---

## 📊 Gales 策略发布说明

### v3.0 核心特性
- **非对称网格**: 支持不同间距/订单大小（多空分离）
- **磁铁机制**: 价格回归时自动触发网格
- **熔断保护**: 回撤/仓位/偏离多重熔断
- **自愈机制**: 长期无交易自动重心

### 配置示例
```javascript
{
  symbol: 'MYXUSDT',
  lean: 'negative',
  gridSpacingUp: 0.02,      // 上升方向间距
  gridSpacingDown: 0.04,    // 下降方向间距
  orderSizeUp: 50,          // 上升订单大小
  orderSizeDown: 100,       // 下降订单大小
  maxPosition: 7874,        // 最大仓位限制
  magnetDistance: 0.015,    // 磁铁触发距离
}
```

### 实盘配置
见 `docs/LIVE_GALES_MYX_CONFIG.md`（详细配置卡）

---

## 🔧 运维指南

### 监控指标
- 仓位使用率: `positionRatio < 93%`
- 回撤限制: `maxDrawdown < 30%`
- 熔断状态: `circuitBreaker.tripped`

### 常见操作
```bash
# 查看状态
bun tools/strategy-cli.ts status <session>

# 停止策略
bun tools/strategy-cli.ts stop <session>

# 查看日志
tail -f logs/<session>.log
```

### 紧急停机
```bash
# 优雅停机（保存状态）
bun tools/strategy-cli.ts stop <session>

# 强制停机（kill进程）
pkill -f "strategy-cli.*<session>"
```

---

## 📁 相关文档

- [策略开发手册](./TRADER_MANUAL.md)
- [开发路线图](./ROADMAP.md)
- [系统架构](./SYSTEM_OVERVIEW.md)
- [实盘配置卡](./LIVE_GALES_MYX_CONFIG.md)

---

*最后更新: 2026-02-19*
