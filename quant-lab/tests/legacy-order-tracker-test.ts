/**
 * LegacyOrderTracker 单元测试 - 模拟遗留订单消警流程
 * 运行: bun run tests/legacy-order-tracker-test.ts
 */

import { LegacyOrderTracker } from '../src/engine/LegacyOrderTracker';

async function main() {
  console.log('=== LegacyOrderTracker 单元测试 ===\n');
  
  // 测试1: 基础遗留订单检测 + RESOLVED
  {
    const oldRunIdPrefix = '1771334';
    const tracker = new LegacyOrderTracker(oldRunIdPrefix, 'gales-MYXUSDT-neutral', {
      dedupWindowMs: 2 * 60 * 60 * 1000,
      resolveThreshold: 3,
      tgTarget: 'bot-001'
    });

    console.log('--- 测试1: 基础遗留订单检测 + RESOLVED ---');
    
    // 第1次：发现遗留订单
    const orders1 = [
      { orderLinkId: `gales-neutral-${oldRunIdPrefix}000-0-Sell`, reduceOnly: false },
      { orderLinkId: 'gales-neutral-1771373601046-1-Sell', reduceOnly: false },
    ];
    tracker.check(orders1);

    // 第2-4次：触发 RESOLVED
    const orders2 = [{ orderLinkId: 'gales-neutral-1771373601046-1-Sell', reduceOnly: false }];
    tracker.check(orders2);
    tracker.check(orders2);
    const alerts = tracker.check(orders2);
    
    console.log('RESOLVED事件:', alerts.filter(a => a.type === 'LEGACY_RESOLVED').map(a => a.message));
  }

  // 测试2: reduceOnly 分流
  {
    console.log('\n--- 测试2: reduceOnly 分流 ---');
    const tracker = new LegacyOrderTracker('1771373601046', 'gales-MYXUSDT-short');
    const orders = [{ orderLinkId: 'gales-short-1771254127243-99-Buy', reduceOnly: true }];
    const alerts = tracker.check(orders);
    console.log('reduceOnly告警类型:', alerts.map(a => a.type));
    console.log(alerts[0]?.type === 'LONG_LIVED_INFO' ? '✅ PASS' : '❌ FAIL');
  }

  // 测试3: 跨策略隔离（neutral不会把short订单当遗留）
  {
    console.log('\n--- 测试3: 跨策略隔离 ---');
    const neutralTracker = new LegacyOrderTracker('1771373', 'gales-MYXUSDT-neutral');
    
    // 混合订单：neutral + short
    const mixedOrders = [
      { orderLinkId: 'gales-neutral-1771373601046-13-Sell', reduceOnly: false },
      { orderLinkId: 'gales-short-1771373613375-12-Sell', reduceOnly: false },
    ];
    
    const alerts = neutralTracker.check(mixedOrders);
    const shortAlert = alerts.find(a => a.orderLinkId.includes('short'));
    
    console.log('检测到的告警:', alerts.map(a => a.orderLinkId));
    console.log(!shortAlert ? '✅ PASS: short订单被正确忽略' : '❌ FAIL: short被误识别');
  }

  console.log('\n=== 全部测试完成 ===');
}

main().catch(console.error);
