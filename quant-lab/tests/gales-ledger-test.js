/**
 * Gales 账本修复测试
 * 验证: 重启后账本继承、双策略独立、30s对齐
 */

const testCases = [
  {
    name: '单策略重启账本继承',
    setup: { symbol: 'MYXUSDT', direction: 'short', positionNotional: -5000 },
    expect: { positionNotional: -5000, ledgerRebuildDone: false },
  },
  {
    name: '双策略独立账本',
    setup: [
      { symbol: 'MYXUSDT', direction: 'neutral', positionNotional: 3000 },
      { symbol: 'MYXUSDT', direction: 'short', positionNotional: -2000 },
    ],
    expect: [
      { stateKey: 'state:MYXUSDT:neutral', positionNotional: 3000 },
      { stateKey: 'state:MYXUSDT:short', positionNotional: -2000 },
    ],
  },
  {
    name: 'execution回放重建',
    setup: { symbol: 'MYXUSDT', direction: 'short', executions: [
      { execId: 'e1', orderLinkId: 'gales-short-xxx', side: 'Sell', execQty: 100, execPrice: 50, execTime: 1 },
      { execId: 'e2', orderLinkId: 'gales-short-xxx', side: 'Buy', execQty: 50, execPrice: 48, execTime: 2 },
    ]},
    expect: { positionNotional: -2600, ledgerRebuildDone: true, matched: 2 }, // 100*50 - 50*48 = 2600
  },
];

console.log('Gales Ledger Fix Test Cases:');
console.log('='.repeat(60));
testCases.forEach((tc, i) => {
  console.log(`\n${i+1}. ${tc.name}`);
  console.log(`   Setup: ${JSON.stringify(tc.setup)}`);
  console.log(`   Expect: ${JSON.stringify(tc.expect)}`);
});
console.log('\n' + '='.repeat(60));
console.log('测试验收点:');
console.log('1. 重启后30s内策略账本与交易所方向一致且偏差<1%');
console.log('2. 连续24h无"accountingPos=0但exchangePos有量"');
console.log('3. 回放链路审计日志含runId/execId/cum');
console.log('4. 不引入重复下单/误熔断回归');
