# quickjs-backtest 0笔交易根因分析报告

## 问题现象
quickjs-backtest运行后输出0笔交易，策略未实际执行买卖。

## 根因分析

### 1. bridge_placeOrder调用链路

```
gaels-simple.js st_heartbeat()
  → bridge_placeOrder(params)  // JS层调用
    → QuickJSStrategy.ctx.global.bridge_placeOrder  // QuickJS绑定
      → BybitProvider.placeOrder()  // 真实交易所API
```

**问题**：`bridge_placeOrder`在QuickJSStrategy内部绑定到真实的BybitProvider，而非backtest的mock order book。

### 2. 代码位置

**QuickJSStrategy.ts:1837-1892**
```typescript
const bridge_placeOrder = this.ctx.newFunction('bridge_placeOrder', (paramsHandle) => {
  // ...解析参数...
  // 调用真实的orderQueue.placeOrder → BybitProvider
});
this.ctx.setProp(this.ctx.global, 'bridge_placeOrder', bridge_placeOrder);
```

### 3. 为什么0笔交易

1. backtest创建了一个mock context（createMockContext）
2. 但策略JS代码调用的是全局的`bridge_placeOrder`，不是mock context的方法
3. QuickJSStrategy在初始化时已经将`bridge_placeOrder`绑定到BybitProvider
4. 即使mock context有placeOrder方法，策略也不会调用它

## 解决方案

### 方案A：QuickJSStrategy添加overrideBridge方法（推荐）

**修改QuickJSStrategy.ts：**
```typescript
/**
 * [P2] 覆盖bridge函数（用于回测mock）
 */
overrideBridge(name: string, fn: Function): void {
  if (!this.ctx) return;
  
  const bridgeFn = this.ctx.newFunction(name, (...args) => {
    return fn(...args);
  });
  this.ctx.setProp(this.ctx.global, name, bridgeFn);
  bridgeFn.dispose();
}
```

**quickjs-backtest.ts使用：**
```typescript
// 在QuickJSStrategy初始化后
this.strategy.overrideBridge('bridge_placeOrder', (paramsJson) => {
  const params = JSON.parse(paramsJson);
  // 将订单推入backtest的this.orders[]
  this.orders.push({...});
  return JSON.stringify({ success: true, orderId: '...' });
});
```

### 方案B：在quickjs-backtest中重新注册bridge（快速hack）

**风险**：需要在QuickJSStrategy初始化完成后执行，且需要访问private ctx。

```typescript
// 通过反射访问private ctx（不推荐，可能破坏封装）
const ctx = (this.strategy as any).ctx;
if (ctx) {
  const mockPlaceOrder = ctx.newFunction('bridge_placeOrder', ...);
  ctx.setProp(ctx.global, 'bridge_placeOrder', mockPlaceOrder);
}
```

### 方案C：添加策略配置参数（侵入性较大）

修改QuickJSStrategyConfig添加mock模式：
```typescript
interface QuickJSStrategyConfig {
  // ...
  mockMode?: boolean;
  mockPlaceOrder?: (params: any) => any;
}
```

在QuickJSStrategy.onInit时根据配置选择绑定真实或mock实现。

## 推荐方案

**方案A**：添加`overrideBridge`方法
- 优点：清晰、可维护、不破坏封装
- 工作量：小（QuickJSStrategy添加~10行代码）
- 适用：不仅回测，也便于其他测试场景

## 实施建议

1. 给QuickJSStrategy添加`overrideBridge`公共方法
2. quickjs-backtest在initialize()中调用overrideBridge覆盖placeOrder/cancelOrder
3. mock实现将订单推入backtest的this.orders[]
4. 在processKline中检查订单成交

## 当前状态

- quickjs-backtest框架层正确✅
- bridge函数绑定问题已定位✅
- 需要QuickJSStrategy层支持mock覆盖
