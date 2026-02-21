# Quant-Lab 快速上手

> 5分钟从零开始运行你的第一个策略

**版本**: v3.0  
**难度**: ⭐ 入门  
**预计时间**: 5-10分钟

---

## 🎯 目标

完成本指南后，你将：
- ✅ 了解 Quant-Lab 的基本架构
- ✅ 运行一个简单的回测
- ✅ 运行 Paper Trading 模拟实盘
- ✅ 理解策略开发的基本流程

---

## 📋 前置准备

### 1. 安装 Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. 克隆仓库

```bash
git clone <repo-url> quant-lab
cd quant-lab
bun install
```

### 3. 准备数据（回测用）

```bash
# 生成测试数据（BTC/USDT 365天日线）
bun tests/generate-test-data.ts
```

---

## 🚀 第一步：运行回测（3分钟）

我们使用内置的双均线策略进行回测。

### 1.1 查看策略

```typescript
// strategies/examples/simple-ma.ts
export class SimpleMAStrategy implements Strategy {
  name = 'SimpleMA';
  
  async onBar(bar: Kline, ctx: StrategyContext): Promise<void> {
    const bars = ctx.getBars(bar.symbol, 20);
    if (bars.length < 20) return;
    
    // 计算MA5和MA20
    const ma5 = this.calculateMA(bars.slice(-5));
    const ma20 = this.calculateMA(bars.slice(-20));
    
    // 金叉买入
    if (ma5 > ma20 && this.prevMa5 <= this.prevMa20) {
      await ctx.buy(bar.symbol, 0.1);
    }
    
    // 死叉卖出
    if (ma5 < ma20 && this.prevMa5 >= this.prevMa20) {
      await ctx.sell(bar.symbol, 0.1);
    }
    
    this.prevMa5 = ma5;
    this.prevMa20 = ma20;
  }
}
```

### 1.2 运行回测

```bash
cd quant-lab
bun tests/backtest-simple-ma.ts
```

### 1.3 查看结果

```
========================================
           回测结果
========================================
总回报: 23.45%
最大回撤: 8.32%
夏普比率: 1.85
胜率: 58.3%
总交易次数: 42
========================================
```

**🎉 恭喜！你的第一个回测运行成功！**

---

## 🚀 第二步：运行 Paper Trading（3分钟）

Paper Trading 使用真实行情数据，但模拟订单执行，零风险测试策略。

### 2.1 启动 Paper Trading

```bash
bun tests/live-paper-trading.ts
```

### 2.2 观察输出

```
[PaperTrading] 初始化完成
初始资金: 10000 USDT

[SimpleMA] 策略初始化
[LiveEngine] 开始运行...

[PaperTrading] K线更新: BTC/USDT @ 50000
[SimpleMA] MA5=50200 MA20=49800 金叉信号，买入 0.1 BTC
[PaperTrading] 模拟订单成交: Buy 0.1 BTC @ 50000

[PaperTrading] K线更新: BTC/USDT @ 51000
账户权益: 10050 USDT (+0.5%)
```

按 `Ctrl+C` 停止。

---

## 🚀 第三步：编写你的策略（5分钟）

### 3.1 创建策略文件

```bash
mkdir -p quant-lab/strategies/my-first
cat > quant-lab/strategies/my-first/index.ts << 'EOF'
import type { Strategy, StrategyContext, Kline } from 'quant-lab';

export class MyFirstStrategy implements Strategy {
  name = 'MyFirstStrategy';
  private entryPrice = 0;
  
  async onInit(ctx: StrategyContext): Promise<void> {
    ctx.log('我的第一个策略启动！');
  }
  
  async onBar(bar: Kline, ctx: StrategyContext): Promise<void> {
    const position = ctx.getPosition(bar.symbol);
    
    // 简单的网格策略：价格下跌5%买入，上涨5%卖出
    if (!position && bar.close < bar.open * 0.95) {
      await ctx.buy(bar.symbol, 0.1);
      this.entryPrice = bar.close;
    }
    
    if (position && bar.close > this.entryPrice * 1.05) {
      await ctx.sell(bar.symbol, position.size);
    }
  }
  
  async onStop(ctx: StrategyContext): Promise<void> {
    ctx.log('策略停止');
  }
}
EOF
```

### 3.2 创建回测脚本

```bash
cat > quant-lab/tests/backtest-my-first.ts << 'EOF'
import { BacktestEngine } from '../src/engine/backtest';
import { KlineDatabase } from '../../quant-lib/src';
import { MyFirstStrategy } from '../strategies/my-first';

async function main() {
  const db = new KlineDatabase({ path: './data/ndtsdb' });
  await db.init();
  
  const strategy = new MyFirstStrategy();
  const engine = new BacktestEngine(db, strategy, {
    initialBalance: 10000,
    symbols: ['BTC/USDT'],
    interval: '1d',
    startTime: new Date('2024-01-01').getTime() / 1000,
    endTime: new Date('2024-06-01').getTime() / 1000,
    commission: 0.001,
    slippage: 0.0005,
  });
  
  const result = await engine.run();
  
  console.log('总回报:', (result.totalReturn * 100).toFixed(2) + '%');
  console.log('最大回撤:', (result.maxDrawdown * 100).toFixed(2) + '%');
}

main().catch(console.error);
EOF
```

### 3.3 运行你的策略

```bash
bun tests/backtest-my-first.ts
```

---

## 📚 下一步

### 深入学习

| 文档 | 内容 | 难度 |
|------|------|------|
| [策略手册](./TRADER_MANUAL.md) | 完整策略开发指南 | ⭐⭐⭐ |
| [系统架构](./SYSTEM_OVERVIEW.md) | 架构详细说明 | ⭐⭐⭐ |
| [产品说明书](./PRODUCT_MANUAL.md) | 部署和运维 | ⭐⭐ |

### 示例策略

```bash
# 网格策略
quant-lab/strategies/grid-martingale/

# 马丁策略  
quant-lab/strategies/short-martingale/

# 系统策略
quant-lab/strategies/system/volatility-collector.ts
```

### CLI 工具

```bash
# 查看策略状态
bun tools/strategy-cli.ts status my-strategy

# 停止策略
bun tools/strategy-cli.ts stop my-strategy

# 查看帮助
bun tools/strategy-cli.ts --help
```

---

## ❓ 常见问题

### Q: 回测结果不准确？

A: 检查以下几点：
- 数据质量：确保 K 线数据完整
- 手续费：设置合理的 commission
- 滑点：设置合理的 slippage
- 复盘：对比实际成交价格

### Q: Paper Trading 和实盘有什么区别？

A: 主要区别：
| 方面 | Paper Trading | 实盘 |
|------|---------------|------|
| 行情 | 真实 | 真实 |
| 订单 | 模拟撮合 | 真实撮合 |
| 资金 | 虚拟 | 真实 |
| 风险 | 零 | 有 |

### Q: 如何连接真实交易所？

A: 需要：
1. 申请 API Key
2. 配置 `~/.config/quant-lab/accounts.json`
3. 使用 `BybitProvider` 或 `BinanceProvider`
4. **⚠️ 小资金测试，务必谨慎**

---

## 🆘 获取帮助

遇到问题？

- 📖 查看完整文档：[docs/](./)
- 💬 联系技术支持：@bot-001
- 🐛 提交问题：GitHub Issues

---

**恭喜完成快速上手！** 🎉

现在你可以：
- ✅ 运行回测验证策略
- ✅ 使用 Paper Trading 零风险测试
- ✅ 编写自己的策略

下一步：[策略手册](./TRADER_MANUAL.md)

---

*最后更新: 2026-02-21*
