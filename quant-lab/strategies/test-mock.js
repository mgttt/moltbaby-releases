// 简单测试策略 - 验证mock下单
function onInit() {
  logInfo('[TestStrategy] onInit called');
}

function onTick(ctx) {
  const price = ctx.price;
  
  // 每100个tick下一次单
  if (typeof globalThis.tickCount === 'undefined') {
    globalThis.tickCount = 0;
  }
  globalThis.tickCount++;
  
  if (globalThis.tickCount % 100 === 0) {
    logInfo('[TestStrategy] 尝试下单 #' + globalThis.tickCount);
    const result = bridge_placeOrder(JSON.stringify({
      symbol: 'BTCUSDT',
      side: 'Buy',
      price: price * 0.99,
      qty: 100
    }));
    logInfo('[TestStrategy] 下单结果: ' + result);
  }
}

function logInfo(msg) {
  if (typeof console !== 'undefined') {
    console.log(msg);
  }
}
