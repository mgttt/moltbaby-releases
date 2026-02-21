# ADX 指标文档

## 1. ADX 指标原理

### 1.1 概述

ADX（Average Directional Index，平均趋向指数）由 J. Welles Wilder 开发，用于衡量市场趋势的强度，而不关心趋势方向。

**ADX 值解读：**
- **0-20**: 趋势很弱或无明显趋势（横盘）
- **20-25**: 趋势开始形成
- **25-40**: 强趋势
- **40-60**: 极强趋势
- **60+**: 极端趋势（罕见）

### 1.2 计算公式

#### 第一步：计算 +DM 和 -DM

```
+DM = 今日高点 - 昨日高点（如果为正且大于 |今日低点 - 昨日低点|）
-DM = 昨日低点 - 今日低点（如果为正且大于 |今日高点 - 昨日高点|）
```

#### 第二步：计算 True Range (TR)

```
TR = max(
  今日高点 - 今日低点,
  |今日高点 - 昨日收盘价|,
  |今日低点 - 昨日收盘价|
)
```

#### 第三步：平滑计算 +DI 和 -DI

```
+DI = (+DM 的 N 期平滑和 / TR 的 N 期平滑和) × 100
-DI = (-DM 的 N 期平滑和 / TR 的 N 期平滑和) × 100
```

#### 第四步：计算 DX（Directional Movement Index）

```
DX = |+DI - (-DI)| / (+DI + (-DI)) × 100
```

#### 第五步：计算 ADX

```
ADX = DX 的 N 期平滑平均值
```

> 标准周期 N = 14

## 2. Gales 策略中的作用

### 2.1 市场状态分类

Gales 策略使用 ADX 将市场状态分为三类：

| 市场状态 | ADX 范围 | 策略行为 |
|---------|---------|---------|
| **RANGING** (横盘) | ADX < 25 | 正常执行网格交易 |
| **TRENDING** (趋势) | 25 ≤ ADX < 40 | 记录警告，继续交易但提高警惕 |
| **STRONG_TREND** (强趋势) | ADX ≥ 40 | 暂停网格下单，避免逆势加仓 |

### 2.2 为什么需要 ADX

**网格策略的弱点：**
- 在横盘市场表现优异（高抛低吸）
- 在强趋势市场会不断逆势加仓，导致巨额亏损

**ADX 的保护作用：**
- 检测到强趋势时暂停开新网格
- 避免在单边行情中不断逆势加仓
- 保留现有持仓，仅暂停新订单

## 3. shouldSuspendGridTrading() 集成逻辑

### 3.1 核心函数

```javascript
function shouldSuspendGridTrading() {
  if (!CONFIG.enableMarketRegime) {
    return false;
  }

  return marketRegimeState.currentRegime === 'STRONG_TREND';
}
```

### 3.2 调用位置

在 `processPendingOrders()` 函数中，每次考虑下单前检查：

```javascript
if (shouldSuspendGridTrading()) {
  // 强趋势期间暂停开新单
  return;
}
```

### 3.3 行为说明

- **暂停范围**: 仅暂停新开网格订单
- **不影响**: 现有订单管理、成交处理、平仓逻辑
- **恢复条件**: ADX 降至 40 以下自动恢复

## 4. 参数配置

### 4.1 配置项说明

```javascript
const CONFIG = {
  // 市场状态检测（ADX趋势强度）
  enableMarketRegime: true,      // 是否启用市场状态检测
  adxPeriod: 14,                 // ADX计算周期（标准值14）
  adxTrendingThreshold: 25,      // 强趋势阈值
  adxStrongTrendThreshold: 40,   // 极强趋势阈值
  regimeAlertCooldownSec: 300,   // 市场状态告警冷却时间（秒）
};
```

### 4.2 参数调优建议

| 参数 | 默认值 | 调优建议 |
|-----|-------|---------|
| `adxPeriod` | 14 | 减小周期使指标更敏感，增大周期更平滑 |
| `adxTrendingThreshold` | 25 | 网格策略建议 20-30 |
| `adxStrongTrendThreshold` | 40 | 暂停交易的阈值，建议 35-50 |

### 4.3 禁用 ADX 检测

如需完全禁用市场状态检测：

```javascript
enableMarketRegime: false
```

## 5. 使用示例

### 5.1 基础配置

```javascript
// 启用 ADX 检测，使用默认参数
const CONFIG = {
  enableMarketRegime: true,
  adxPeriod: 14,
  adxTrendingThreshold: 25,
  adxStrongTrendThreshold: 40,
  regimeAlertCooldownSec: 300,
};
```

### 5.2 保守配置（更早暂停）

```javascript
// 更早检测趋势，更保守的交易策略
const CONFIG = {
  enableMarketRegime: true,
  adxPeriod: 10,                 // 更敏感
  adxTrendingThreshold: 20,      // 更早警告
  adxStrongTrendThreshold: 35,   // 更早暂停
  regimeAlertCooldownSec: 300,
};
```

### 5.3 激进配置（更晚暂停）

```javascript
// 容忍更强趋势，适合高波动市场
const CONFIG = {
  enableMarketRegime: true,
  adxPeriod: 20,                 // 更平滑
  adxTrendingThreshold: 30,      // 更高警告阈值
  adxStrongTrendThreshold: 50,   // 更高暂停阈值
  regimeAlertCooldownSec: 300,
};
```

### 5.4 运行时状态查询

```javascript
// 获取当前市场状态描述
function getMarketRegimeDesc() {
  if (!CONFIG.enableMarketRegime) {
    return '未启用';
  }
  return marketRegimeState.currentRegime + ' (ADX=' + marketRegimeState.currentADX.toFixed(2) + ')';
}

// 示例输出：
// "RANGING (ADX=18.52)"      - 横盘，正常交易
// "TRENDING (ADX=32.15)"     - 趋势，提高警惕
// "STRONG_TREND (ADX=45.80)" - 强趋势，暂停新单
```

## 6. 日志输出示例

```
📊 市场状态变化: RANGING → TRENDING | ADX=28.35
⚡ 强趋势检测，注意风险！ADX=28.35
📊 市场状态变化: TRENDING → STRONG_TREND | ADX=42.18
⚠️ 极强趋势检测，建议暂停网格下单！ADX=42.18
📊 市场状态变化: STRONG_TREND → TRENDING | ADX=35.62
```

## 7. 注意事项

1. **数据需求**: ADX 计算需要至少 `adxPeriod * 2` 个价格数据点才会产生有效值
2. **滞后性**: ADX 是滞后指标，趋势开始后才会升高
3. **不判断方向**: ADX 只衡量趋势强度，不判断上涨或下跌
4. **结合使用**: 建议配合其他指标（如持仓差值监控）使用

---

*文档版本: 2025-02-21*  
*对应代码: quant-lab/strategies/gales-simple.js*
