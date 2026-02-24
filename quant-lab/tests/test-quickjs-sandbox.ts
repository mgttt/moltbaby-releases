#!/usr/bin/env bun
/**
 * QuickJS 沙箱基础测试（不依赖 Engine）
 */

import { readFileSync } from 'fs';
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';

async function main() {
  console.log('='.repeat(70));
  console.log('   QuickJS 沙箱基础测试');
  console.log('='.repeat(70));
  console.log();

  // 1. 创建 VM
  console.log('[1] 创建 QuickJS VM...');
  const vm = await getQuickJS();
  console.log('✅ VM 创建成功');

  // 2. 创建上下文
  console.log('\n[2] 创建上下文...');
  const ctx = vm.newContext({
    interruptHandler: shouldInterruptAfterDeadline(Date.now() + 60000),
  });
  console.log('✅ 上下文创建成功');

  // 3. 注入 bridge 函数
  console.log('\n[3] 注入 bridge 函数...');
  
  // bridge_log
  const bridge_log = ctx.newFunction('bridge_log', (levelHandle, messageHandle) => {
    const level = ctx.getString(levelHandle);
    const message = ctx.getString(messageHandle);
    console.log(`[Strategy][${level}] ${message}`);
  });
  ctx.setProp(ctx.global, 'bridge_log', bridge_log);
  bridge_log.dispose();

  // bridge_stateGet/Set (简化版)
  const state = new Map<string, any>();
  
  const bridge_stateGet = ctx.newFunction('bridge_stateGet', (keyHandle, defaultHandle) => {
    const key = ctx.getString(keyHandle);
    const defaultValue = ctx.getString(defaultHandle);
    const value = state.get(key);
    return ctx.newString(value !== undefined ? JSON.stringify(value) : defaultValue);
  });
  ctx.setProp(ctx.global, 'bridge_stateGet', bridge_stateGet);
  bridge_stateGet.dispose();

  const bridge_stateSet = ctx.newFunction('bridge_stateSet', (keyHandle, valueHandle) => {
    const key = ctx.getString(keyHandle);
    const valueJson = ctx.getString(valueHandle);
    state.set(key, JSON.parse(valueJson));
  });
  ctx.setProp(ctx.global, 'bridge_stateSet', bridge_stateSet);
  bridge_stateSet.dispose();

  // bridge_getPrice
  let currentPrice = 5.717;
  const bridge_getPrice = ctx.newFunction('bridge_getPrice', (symbolHandle) => {
    const symbol = ctx.getString(symbolHandle);
    return ctx.newString(JSON.stringify({ price: currentPrice, symbol }));
  });
  ctx.setProp(ctx.global, 'bridge_getPrice', bridge_getPrice);
  bridge_getPrice.dispose();

  // bridge_getAccount
  const bridge_getAccount = ctx.newFunction('bridge_getAccount', () => {
    return ctx.newString(JSON.stringify({
      balance: 1000,
      equity: 1000,
      availableMargin: 1000,
    }));
  });
  ctx.setProp(ctx.global, 'bridge_getAccount', bridge_getAccount);
  bridge_getAccount.dispose();

  // bridge_getPosition
  const bridge_getPosition = ctx.newFunction('bridge_getPosition', (symbolHandle) => {
    const symbol = ctx.getString(symbolHandle);
    return ctx.newString('null'); // 无持仓
  });
  ctx.setProp(ctx.global, 'bridge_getPosition', bridge_getPosition);
  bridge_getPosition.dispose();

  // bridge_placeOrder
  const bridge_placeOrder = ctx.newFunction('bridge_placeOrder', (paramsHandle) => {
    const paramsJson = ctx.getString(paramsHandle);
    console.log('[bridge] placeOrder:', paramsJson);
    return ctx.newString(JSON.stringify({ orderId: 'sim-' + Date.now(), status: 'pending' }));
  });
  ctx.setProp(ctx.global, 'bridge_placeOrder', bridge_placeOrder);
  bridge_placeOrder.dispose();

  // bridge_cancelOrder
  const bridge_cancelOrder = ctx.newFunction('bridge_cancelOrder', (orderIdHandle) => {
    const orderId = ctx.getString(orderIdHandle);
    console.log('[bridge] cancelOrder:', orderId);
  });
  ctx.setProp(ctx.global, 'bridge_cancelOrder', bridge_cancelOrder);
  bridge_cancelOrder.dispose();

  console.log('✅ Bridge 函数注入完成');

  // 4. 注入 ctx.strategy.params
  console.log('\n[4] 注入策略参数...');
  const ctxHandle = ctx.newObject();
  const strategyHandle = ctx.newObject();
  const paramsHandle = ctx.newString(JSON.stringify({
    symbol: 'MYXUSDT',
    gridCount: 3,
    simMode: true,
  }));

  ctx.setProp(strategyHandle, 'id', ctx.newString('test-strategy'));
  ctx.setProp(strategyHandle, 'params', paramsHandle);
  ctx.setProp(ctxHandle, 'strategy', strategyHandle);
  ctx.setProp(ctx.global, 'ctx', ctxHandle);

  ctxHandle.dispose();
  strategyHandle.dispose();
  paramsHandle.dispose();

  console.log('✅ 参数注入完成');

  // 5. 加载策略代码
  console.log('\n[5] 加载策略代码...');
  const code = readFileSync('./strategies/grid/gales-simple.js', 'utf-8');
  const result = ctx.evalCode(code, 'gales-simple.js');

  if (result.error) {
    const error = ctx.dump(result.error);
    result.error.dispose();
    throw new Error(`策略代码执行失败: ${JSON.stringify(error)}`);
  }
  result.value.dispose();
  console.log('✅ 策略代码加载成功');

  // 6. 调用 st_init
  console.log('\n[6] 调用 st_init...');
  const initFn = ctx.getProp(ctx.global, 'st_init');
  const initResult = ctx.callFunction(initFn, ctx.undefined);
  initFn.dispose();
  
  if (initResult.error) {
    const error = ctx.dump(initResult.error);
    initResult.error.dispose();
    throw new Error(`st_init 失败: ${JSON.stringify(error)}`);
  }
  initResult.value.dispose();
  console.log('✅ st_init 执行成功');

  // 7. 模拟心跳
  console.log('\n[7] 模拟心跳（推送3次 tick）...');
  const heartbeatFn = ctx.getProp(ctx.global, 'st_heartbeat');

  for (let i = 0; i < 3; i++) {
    const tick = {
      count: i + 1,
      timestamp: Math.floor(Date.now() / 1000),
      price: 5.717 + (Math.random() - 0.5) * 0.01,
      volume: 1000,
    };

    const tickHandle = ctx.newString(JSON.stringify(tick));
    const hbResult = ctx.callFunction(heartbeatFn, ctx.undefined, tickHandle);
    tickHandle.dispose();

    if (hbResult.error) {
      const error = ctx.dump(hbResult.error);
      hbResult.error.dispose();
      console.error(`st_heartbeat 失败: ${JSON.stringify(error)}`);
    } else {
      hbResult.value.dispose();
      console.log(`✅ 心跳 ${i + 1} 执行成功`);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  heartbeatFn.dispose();

  // 8. 调用 st_stop
  console.log('\n[8] 调用 st_stop...');
  const stopFn = ctx.getProp(ctx.global, 'st_stop');
  const stopResult = ctx.callFunction(stopFn, ctx.undefined);
  stopFn.dispose();

  if (stopResult.error) {
    const error = ctx.dump(stopResult.error);
    stopResult.error.dispose();
    console.error(`st_stop 失败: ${JSON.stringify(error)}`);
  } else {
    stopResult.value.dispose();
    console.log('✅ st_stop 执行成功');
  }

  // 9. 清理
  console.log('\n[9] 清理资源...');
  ctx.dispose();
  // vm 不需要手动 dispose（自动回收）
  console.log('✅ 资源清理完成');

  console.log('\n' + '='.repeat(70));
  console.log('✅ QuickJS 沙箱测试成功！');
  console.log('='.repeat(70));
}

main().catch((error) => {
  console.error('\n❌ 测试失败:', error);
  process.exit(1);
});
