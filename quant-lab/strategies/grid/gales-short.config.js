// configs/gales-short.js
// 示例策略配置 - Gales Short 策略

module.exports = {
  symbol: 'MYXUSDT',
  interval: '1m',
  leverage: 5,
  maxPositionUsdt: 3000,
  lean: 'negative',

  // 网格参数
  gridSpacingUp: 0.02,
  gridSpacingDown: 0.02,
  orderSizeUp: 50,
  orderSizeDown: 25,
  magnetDistance: 0.01,

  // 模拟模式
  simMode: false,

  // 账户
  account: 'wjcgm@bbt-sub1',

  // 紧急倾向控制
  emergencyLean: 'manual',

  // P0修复：生产场景允许关闭追涨追跌拦截（短仓防止追跌停摆）
  disableAutoRecenterBlockade: true,
};
