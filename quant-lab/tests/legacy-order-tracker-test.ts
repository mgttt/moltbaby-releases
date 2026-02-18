/**
 * LegacyOrderTracker 单元测试 - 模拟遗留订单消警流程
 * 运行: bun test/legacy-order-tracker-test.ts
 */

import { LegacyOrderTracker } from '../src/engine/LegacyOrderTracker';

async function main() {
  console.log('=== LegacyOrderTracker 单元测试 ===\n');
  
  // 使用一个"旧" runId
  const oldRunIdPrefix = '1771334'; // 模拟前缀
  const tracker = new LegacyOrderTracker(oldRunIdPrefix, {
    dedupWindowMs: 2 * 60 * 60 * 1000, // 2h
    resolveThreshold: 3, // 连续3次检测不到则消警
    tgTarget: 'bot-001' // 不发真实TG，只打日志
  });

  console.log(`初始化完成，runId=${oldRunIdPrefix}\n`);

  // 模拟场景：交易所返回订单列表（包含一个旧run的订单）
  // 第1次检测：旧订单存在（当前runId是1771254，所以1771334开头的订单是"旧"的）
  console.log('--- 第1次检测：发现遗留订单 ---');
  const oldRunId = '1771334'; // 旧runId前缀
  const orders1 = [
    { orderLinkId: `gales-${oldRunId}000-0-Sell`, reduceOnly: false }, // 旧run订单
    { orderLinkId: 'gales-1771373601046-1-Sell', reduceOnly: false }, // 新run订单
  ];
  const alerts1 = tracker.check(orders1);
  for (const alert of alerts1) {
    console.log(`[ALERT] ${alert.message}`);
  }
  console.log(`当前状态:`, tracker.getStatus());

  // 第2次检测：旧订单消失了（新run订单还在）
  console.log('\n--- 第2次检测：旧订单消失 ---');
  const orders2 = [
    { orderLinkId: 'gales-1771373601046-1-Sell', reduceOnly: false }, // 只有新run订单，旧订单不见了
  ];
  const alerts2 = tracker.check(orders2);
  for (const alert of alerts2) {
    console.log(`[ALERT] ${alert.message}`);
  }
  console.log(`当前状态:`, tracker.getStatus());

  // 第3次检测：仍然没有旧订单（missingCount应为2）
  console.log('\n--- 第3次检测：仍未出现（missingCount=2）---');
  const alerts3 = tracker.check(orders2);
  for (const alert of alerts3) {
    console.log(`[ALERT] ${alert.message}`);
  }
  console.log(`当前状态:`, tracker.getStatus());

  // 第4次检测：应该触发 RESOLVED
  console.log('\n--- 第4次检测：触发 RESOLVED（missingCount=3）---');
  const alerts4 = tracker.check(orders2);
  for (const alert of alerts4) {
    console.log(`[ALERT] ${alert.message}`);
    if (alert.type === 'LEGACY_RESOLVED') {
      console.log('✅ RESOLVED 事件已触发！');
      console.log('   期望字段: orderLinkId, lastSeenAt, confirm=3');
    }
  }
  console.log(`当前状态:`, tracker.getStatus());

  // 第5次检测：验证去重（2h内不应再告警）
  console.log('\n--- 第5次检测：验证去重（不应再告警）---');
  const alerts5 = tracker.check(orders2);
  for (const alert of alerts5) {
    console.log(`[ALERT] ${alert.message}`);
  }
  if (alerts5.length === 0) {
    console.log('✅ 去重生效！2h内未重复告警');
  }

  // 测试 reduceOnly 分流
  console.log('\n\n=== 测试 reduceOnly 分流 ===');
  const tracker2 = new LegacyOrderTracker('1771373601046', {
    resolveThreshold: 3,
    tgTarget: 'bot-001'
  });

  // 模拟 reduceOnly 订单（应该走低频 Info 通道）
  const ordersWithReduceOnly = [
    { orderLinkId: 'gales-1771254127243-99-Buy', reduceOnly: true }, // reduceOnly
  ];
  const alertsReduceOnly = tracker2.check(ordersWithReduceOnly);
  for (const alert of alertsReduceOnly) {
    console.log(`[ALERT] ${alert.message}`);
    if (alert.type === 'LONG_LIVED_INFO') {
      console.log('✅ reduceOnly 走低频 Info 通道（非告警）');
    }
  }

  console.log('\n=== 测试完成 ===');
}

main().catch(console.error);
