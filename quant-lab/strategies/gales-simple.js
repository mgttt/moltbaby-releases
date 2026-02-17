/**
 * Gales 策略 - QuickJS 简化版
 *
 * 磁铁限价网格策略
 */

// P2修复：持仓差值监控风控（必须在CONFIG之前定义）
let positionDiffState = {
  initialOffset: 0,      // 初始差值/历史遗留仓基准
  lastDiff: 0,           // 上次差值（用于趋势检测）
  diffIncreaseCount: 0,  // 差值连续增大计数
  lastAlertAt: 0,        // 上次告警时间（防抖）
};

// P0修复：execution去重集合（防止重复处理成交）
let processedExecIds = {};

// ================================
// 配置
// ================================

const CONFIG = {
  symbol: 'MYXUSDT',
  gridCount: 5,
  gridSpacing: 0.02,           // 默认网格间距（向后兼容）
  orderSize: 10,               // 默认订单大小（向后兼容）

  // 非对称网格支持（可选，不传时使用 gridSpacing/orderSize）
  gridSpacingUp: 0.01,         // 升方向（Sell）网格间距，止盈紧
  gridSpacingDown: 0.007,      // 跌方向（Buy）网格间距，加仓稍紧，确保在磁铁范围内
  orderSizeUp: 50,             // 升方向（Sell）订单大小，如 50
  orderSizeDown: 100,          // 跌方向（Buy）订单大小，如 100

  maxPosition: 7874,  // 2026-02-15: 总权益10%（78739×0.1），避免触顶，熔断只告警不撤单

  magnetDistance: 0.015,     // 1.5% (P3优化: 减少空窗)
  cancelDistance: 0.01,      // 1%

  // magnetDistance 的补强：默认按 gridSpacing 的比例给一个"相对磁铁范围"，避免长期擦边不触发
  magnetRelativeToGrid: true,
  magnetGridRatio: 0.7,      // magnetDistance 至少达到 gridSpacing*ratio（比如 gridSpacing=1% → magnet≥0.7%）
  priceOffset: 0.0005,
  postOnly: true,
  cooldownSec: 60,           // 60 秒冷却
  maxOrderAgeSec: 300,       // 订单最长存活时间（超时撤单）
  minOrderLifeSec: 30,       // 订单最短存活时间（避免瞬时波动撤单）
  driftConfirmCount: 2,      // 连续 N 次脱离才撤单（防止误撤）

  // 运行时治理
  maxActiveOrders: 5,        // 同时活跃订单上限（防止极端情况下挂满）

  // "不交易"自愈：中心价漂移太远且一段时间无下单时，自动重心
  autoRecenter: true,
  recenterDistance: 0.03,    // 3% 漂移才触发
  recenterCooldownSec: 600,  // 10 分钟最多重心一次
  recenterMinIdleTicks: 30,  // 至少连续 30 个 tick 没有下单行为才允许重心（5s 心跳≈150s）

  // 部分成交处理
  partialFillThreshold: 0.3, // 部分成交达到 30% → 视为本格已成交（撤掉剩余）
  dustFillThreshold: 0.05,   // <5% 的碎片成交 → 建议走清理逻辑（暂只记录）
  hedgeDustFills: true,      // 自动对冲残余风险（不足阈值但有成交）
  maxHedgeSlippagePct: 0.005,// 对冲最大滑点容忍 0.5%

  // 策略方向: 'long' | 'short' | 'neutral'
  // long: 只做多，卖单仅记账（虚仓）
  // short: 只做空，买单仅记账（虚仓）
  // neutral: 双向交易
  direction: 'short',

  // 熔断机制 (P0 修复)
  circuitBreaker: {
    enabled: true,
    maxDrawdown: 0.30,          // 最大回撤 30%
    maxPositionRatio: 0.93,     // 仓位使用率 93%（避免频繁熔断）
    maxPriceDrift: 0.50,        // 价格偏离中心 50%
    cooldownAfterTrip: 600,     // 熔断后冷却 10 分钟
  },

  // 应急方向切换 (P0 修复)
  emergencyDirection: 'auto',  // auto/long/short/neutral

  simMode: true,
};

// 从 ctx.strategy.params 覆盖参数
if (typeof ctx !== 'undefined' && ctx && ctx.strategy && ctx.strategy.params) {
  const rawParams = ctx.strategy.params;
  const p = (typeof rawParams === 'string') ? JSON.parse(rawParams) : rawParams;
  // 防御性检查：symbol 必须是有效字符串
  if (p.symbol && typeof p.symbol === 'string' && p.symbol.length > 0) {
    CONFIG.symbol = p.symbol;
  }
  if (p.gridCount) CONFIG.gridCount = p.gridCount;
  if (p.gridSpacing) CONFIG.gridSpacing = p.gridSpacing;
  if (p.gridSpacingUp !== undefined) CONFIG.gridSpacingUp = p.gridSpacingUp;
  if (p.gridSpacingDown !== undefined) CONFIG.gridSpacingDown = p.gridSpacingDown;
  if (p.orderSize) CONFIG.orderSize = p.orderSize;
  if (p.orderSizeUp !== undefined) CONFIG.orderSizeUp = p.orderSizeUp;
  if (p.orderSizeDown !== undefined) CONFIG.orderSizeDown = p.orderSizeDown;
  if (p.maxPosition) CONFIG.maxPosition = p.maxPosition;
  if (p.magnetDistance) CONFIG.magnetDistance = p.magnetDistance;
  if (p.cancelDistance) CONFIG.cancelDistance = p.cancelDistance;
  if (p.magnetRelativeToGrid !== undefined) CONFIG.magnetRelativeToGrid = p.magnetRelativeToGrid;
  if (p.magnetGridRatio) CONFIG.magnetGridRatio = p.magnetGridRatio;
  if (p.cooldownSec) CONFIG.cooldownSec = p.cooldownSec;
  if (p.maxActiveOrders) CONFIG.maxActiveOrders = p.maxActiveOrders;

  if (p.autoRecenter !== undefined) CONFIG.autoRecenter = p.autoRecenter;
  if (p.recenterDistance) CONFIG.recenterDistance = p.recenterDistance;
  if (p.recenterCooldownSec) CONFIG.recenterCooldownSec = p.recenterCooldownSec;
  if (p.recenterMinIdleTicks) CONFIG.recenterMinIdleTicks = p.recenterMinIdleTicks;

  if (p.simMode !== undefined) CONFIG.simMode = p.simMode;
  if (p.direction) CONFIG.direction = p.direction;
  // P0修复：添加emergencyDirection参数覆盖
  if (p.emergencyDirection) CONFIG.emergencyDirection = p.emergencyDirection;
  // P2修复：添加initialOffset参数覆盖（持仓差值监控）
  // 如果用户传了initialOffset，使用用户值；否则在st_init中自动计算
  if (p.initialOffset !== undefined) {
    CONFIG.initialOffset = p.initialOffset;
    positionDiffState.initialOffset = p.initialOffset;
  } else {
    // 标记为需要自动计算（在st_init中计算）
    CONFIG.initialOffset = null;
  }
}

// ================================
// 状态
// ================================

let state = {
  initialized: false,
  centerPrice: 0,
  lastPrice: 0,
  positionNotional: 0,
  gridLevels: [],
  nextGridId: 1,
  openOrders: [],
  tickCount: 0,

  // 运行统计/自愈相关（持久化）
  lastPlaceTick: 0,        // 上次尝试挂单的 tick（用于判断长期不交易）
  lastRecenterAtMs: 0,     // 上次重心时间
  lastRecenterTick: 0,     // 上次重心发生的 tick
  
  // P0修复：110072根治 - 唯一orderLinkId生成
  runId: 0,                // 本次运行唯一ID
  orderSeq: 0,             // 订单序列号
  
  // P0修复：区分交易所持仓和策略内部持仓
  exchangePosition: 0,     // 交易所总持仓（仅显示，不用于应急切换）
  
  // P2修复：持仓差值监控
  initialOffset: 0,        // 初始差值/历史遗留仓基准
};

// 运行时状态（不持久化）
let runtime = {
  // 仓位超限告警：只在"首次进入超限"时提醒，并做时间节流
  posLimit: {
    buyOver: false,
    sellOver: false,
    lastWarnAtBuy: 0,
    lastWarnAtSell: 0,
  },

  // 活跃单上限告警
  activeOrders: {
    lastWarnAt: 0,
  },
};

// 熔断状态 (P0 修复)
let circuitBreakerState = {
  tripped: false,
  reason: '',
  tripAt: 0,
  highWaterMark: 0,  // 最高权益（用于计算回撤）
  // P1修复：熔断震荡
  recoveryTickCount: 0,  // 连续满足恢复条件的心跳数
  blockedSide: '',       // 熔断中禁止的开仓方向 ('Buy'/'Sell')
};

// 加载状态
function loadState() {
  try {
    const saved = bridge_stateGet('state', 'null');
    if (saved && saved !== 'null') {
      const obj = JSON.parse(saved);
      if (obj && typeof obj === 'object') {
        state = obj;
        // 兼容旧状态缺字段
        if (!state.openOrders) state.openOrders = [];
        if (!state.tickCount) state.tickCount = 0;
        if (!state.gridLevels) state.gridLevels = [];
        if (!state.nextGridId) state.nextGridId = 1;
        if (!state.lastPlaceTick) state.lastPlaceTick = 0;
        if (!state.lastRecenterAtMs) state.lastRecenterAtMs = 0;
        if (!state.lastRecenterTick) state.lastRecenterTick = 0;
        if (!state.runId) state.runId = 0;
        if (!state.orderSeq) state.orderSeq = 0;
        if (!state.exchangePosition) state.exchangePosition = 0;
        // P2修复：加载initialOffset
        if (obj.initialOffset !== undefined) {
          positionDiffState.initialOffset = obj.initialOffset;
        }
      }
    }
  } catch (e) {
    logInfo('Failed to load state: ' + e);
  }
  
  // P2修复v4: tick可能先于st_init执行，立即清空initialOffset避免假告警
  state.initialOffset = 0;
  positionDiffState.initialOffset = 0;
  
  // P0修复：清空execution去重集合，避免重启后历史数据干扰
  processedExecIds = {};
}

// 保存状态
function saveState() {
  bridge_stateSet('state', JSON.stringify(state));
}

// ================================
// 工具函数
// ================================

function logInfo(msg) {
  bridge_log('info', '[Gales] ' + msg);
}

function logWarn(msg) {
  bridge_log('warn', '[Gales] ' + msg);
}

function logError(msg) {
  bridge_log('error', '[Gales] ' + msg);
}

function logDebug(msg) {
  bridge_log('debug', '[Gales] ' + msg);
}

function warnPositionLimit(side, gridId, currentNotional, afterFillNotional) {
  const now = Date.now();
  const intervalMs = 5 * 60 * 1000; // 5 分钟提醒一次足够了

  if (side === 'Buy') {
    if (runtime.posLimit.buyOver && (now - runtime.posLimit.lastWarnAtBuy) < intervalMs) return;
    runtime.posLimit.buyOver = true;
    runtime.posLimit.lastWarnAtBuy = now;
    logWarn('买单 #' + gridId + ' 仓位将超限 (当前=' + currentNotional.toFixed(2) + ' 成交后=' + afterFillNotional.toFixed(2) + ')');
    return;
  }

  if (side === 'Sell') {
    if (runtime.posLimit.sellOver && (now - runtime.posLimit.lastWarnAtSell) < intervalMs) return;
    runtime.posLimit.sellOver = true;
    runtime.posLimit.lastWarnAtSell = now;
    logWarn('卖单 #' + gridId + ' 仓位将超限 (当前=' + currentNotional.toFixed(2) + ' 成交后=' + afterFillNotional.toFixed(2) + ')');
  }
}

// ================================
// P0 修复：辅助函数
// ================================

function hasOnlyActiveSellOrders() {
  if (!state.openOrders || state.openOrders.length === 0) return false;
  let hasActive = false;
  for (let i = 0; i < state.openOrders.length; i++) {
    const o = state.openOrders[i];
    if (!o || o.status === 'Filled' || o.status === 'Canceled') continue;
    if (o.side === 'Buy') return false;  // 有买单，不是纯卖单
    hasActive = true;
  }
  return hasActive;
}

function hasOnlyActiveBuyOrders() {
  if (!state.openOrders || state.openOrders.length === 0) return false;
  let hasActive = false;
  for (let i = 0; i < state.openOrders.length; i++) {
    const o = state.openOrders[i];
    if (!o || o.status === 'Filled' || o.status === 'Canceled') continue;
    if (o.side === 'Sell') return false;  // 有卖单，不是纯买单
    hasActive = true;
  }
  return hasActive;
}

function cancelAllOrders() {
  logWarn('[撤销所有订单] 活跃订单数: ' + countActiveOrders());
  
  for (let i = 0; i < state.gridLevels.length; i++) {
    const g = state.gridLevels[i];
    if (!g) continue;
    if (g.state === 'ACTIVE' && g.orderId) {
      cancelOrder(g);
    }
  }
  
  // 清理已撤销订单（保留成交记录）
  state.openOrders = state.openOrders.filter(function(o) {
    if (!o) return false;
    return o.status !== 'Canceled';
  });
}

// ================================
// P0 修复：熔断检查
// ================================

function checkCircuitBreaker() {
  if (!CONFIG.circuitBreaker || !CONFIG.circuitBreaker.enabled) return false;
  
  const now = Date.now();
  const cb = CONFIG.circuitBreaker;
  
  // 冷却期内检查恢复条件
  if (circuitBreakerState.tripped) {
    const elapsed = (now - circuitBreakerState.tripAt) / 1000;
    if (elapsed < cb.cooldownAfterTrip) {
      return true;  // 仍在冷却期
    }
    
    // P0修复：熔断震荡 - 使用effectivePosition判断恢复条件
    const effectivePos = Math.max(
      Math.abs(state.positionNotional || 0),
      Math.abs(state.exchangePosition || 0)
    );
    const positionRatio = effectivePos / CONFIG.maxPosition;
    if (positionRatio < cb.maxPositionRatio) {
      circuitBreakerState.recoveryTickCount = (circuitBreakerState.recoveryTickCount || 0) + 1;
      if (circuitBreakerState.recoveryTickCount >= 3) {
        // 连续3个心跳满足条件，重置熔断
        circuitBreakerState.tripped = false;
        circuitBreakerState.reason = '';
        circuitBreakerState.recoveryTickCount = 0;
        circuitBreakerState.blockedSide = '';
        // P1修复：恢复时重置highWaterMark为当前仓位，避免震荡循环
        circuitBreakerState.highWaterMark = effectivePos;
        // P1-debug: 打印详细恢复信息
        logInfo('[熔断恢复] 仓位回落，恢复交易' +
                ' | positionRatio=' + (positionRatio * 100).toFixed(2) + '%' +
                ' | effectivePos=' + effectivePos.toFixed(2) +
                ' | positionNotional=' + (state.positionNotional || 0).toFixed(2) +
                ' | exchangePosition=' + (state.exchangePosition || 0).toFixed(2) +
                ' | highWaterMark=' + circuitBreakerState.highWaterMark.toFixed(2));
        return false;
      }
    } else {
      // 不满足条件，重置计数
      circuitBreakerState.recoveryTickCount = 0;
    }
    
    return true;  // 冷却期结束但仓位未回落，继续熔断
  }
  
  // P0修复：熔断机制使用effectivePosition（取策略内部和交易所的较大值）
  const effectivePosition = Math.max(
    Math.abs(state.positionNotional || 0),
    Math.abs(state.exchangePosition || 0)
  );
  
  // 1. 回撤熔断
  if (circuitBreakerState.highWaterMark === 0) {
    // 冷启动：用当前权益初始化，没持仓时跳过回撤检查
    if (effectivePosition === 0) {
      // 没持仓不检查回撤（避免 0/maxPosition = 100% 误触发）
      circuitBreakerState.highWaterMark = 0;
    } else {
      circuitBreakerState.highWaterMark = effectivePosition;
    }
  }
  
  if (effectivePosition > circuitBreakerState.highWaterMark) {
    circuitBreakerState.highWaterMark = effectivePosition;
  }
  
  // highWaterMark 为 0 时跳过回撤检查（没有持仓历史，避免 0 除法误触发）
  if (circuitBreakerState.highWaterMark > 0) {
    const drawdown = (circuitBreakerState.highWaterMark - effectivePosition) / circuitBreakerState.highWaterMark;
    if (drawdown > cb.maxDrawdown) {
      circuitBreakerState.tripped = true;
      circuitBreakerState.reason = '回撤熔断';
      circuitBreakerState.tripAt = now;
      
      // P1-debug: 打印详细熔断信息
      logWarn('[熔断触发-回撤] drawdown=' + (drawdown * 100).toFixed(2) + '%' +
              ' | highWaterMark=' + circuitBreakerState.highWaterMark.toFixed(2) +
              ' | effectivePosition=' + effectivePosition.toFixed(2) +
              ' | positionNotional=' + (state.positionNotional || 0).toFixed(2) +
              ' | exchangePosition=' + (state.exchangePosition || 0).toFixed(2));
      
      // 撤销所有订单
      cancelAllOrders();
      
      return true;
    }
  }
  
  // 2. 仓位熔断（P1修复：告警only不置tripped - bot-009建议）
  const positionRatio = effectivePosition / CONFIG.maxPosition;
  if (positionRatio > cb.maxPositionRatio) {
    // P2修复：熔断告警节流（>=60s或ratio变化>=0.2%才打一次）
    const now = Date.now();
    const lastWarn = circuitBreakerState.lastPositionWarnAt || 0;
    const lastRatio = circuitBreakerState.lastPositionWarnRatio || 0;
    const timeElapsed = now - lastWarn;
    const ratioDiff = Math.abs(positionRatio - lastRatio);
    
    if (timeElapsed >= 60000 || ratioDiff >= 0.002) {
      circuitBreakerState.lastPositionWarnAt = now;
      circuitBreakerState.lastPositionWarnRatio = positionRatio;
      // P1-debug: 打印详细仓位熔断信息
      logWarn('[熔断触发-仓位] positionRatio=' + (positionRatio * 100).toFixed(2) + '%' +
              ' | effectivePosition=' + effectivePosition.toFixed(2) +
              ' | positionNotional=' + (state.positionNotional || 0).toFixed(2) +
              ' | exchangePosition=' + (state.exchangePosition || 0).toFixed(2) +
              ' | maxPosition=' + CONFIG.maxPosition);
    }
    
    // 不触发熔断停止，继续交易
    return false;
  }
  
  // 3. 价格偏离熔断
  if (state.centerPrice > 0) {
    const drift = Math.abs(state.lastPrice - state.centerPrice) / state.centerPrice;
    if (drift > cb.maxPriceDrift) {
      circuitBreakerState.tripped = true;
      circuitBreakerState.reason = '价格偏离熔断';
      circuitBreakerState.tripAt = now;
      
      // P1-debug: 打印详细价格偏离熔断信息
      logWarn('[熔断触发-价格偏离] drift=' + (drift * 100).toFixed(2) + '%' +
              ' | centerPrice=' + state.centerPrice.toFixed(4) +
              ' | lastPrice=' + state.lastPrice.toFixed(4) +
              ' | effectivePosition=' + effectivePosition.toFixed(2));
      
      // 不撤单（价格可能快速恢复），但停止新下单
      return true;
    }
  }
  
  return false;
}

// P2修复：持仓差值监控风控
function checkPositionDiff() {
  const now = Date.now();
  const alertIntervalMs = 5 * 60 * 1000; // 5分钟防抖
  
  // P2修复：方案C独立账本设计 - internal=0时跳过告警（等累积后再监控）
  if (Math.abs(state.positionNotional || 0) < 1) {
    return;  // internal未开始累积，跳过差值监控
  }
  
  // P2修复v2: 计算差值 = |(exchange - initialOffset) - internal|
  // 原公式 diff = |exchange - internal - initialOffset| 在internal累积后仍触发误报
  // 新公式 diff = |(exchange - initialOffset) - internal| 正确反映"新增差异"
  const adjustedExchange = (state.exchangePosition || 0) - (positionDiffState.initialOffset || 0);
  const currentDiff = Math.abs(adjustedExchange - (state.positionNotional || 0));
  
  // 趋势检测：差值是否连续增大
  if (currentDiff > positionDiffState.lastDiff) {
    positionDiffState.diffIncreaseCount++;
  } else {
    positionDiffState.diffIncreaseCount = 0;
  }
  positionDiffState.lastDiff = currentDiff;
  
  // 阈值判断
  const maxPosition = CONFIG.maxPosition || 7874;
  const diffRatio = currentDiff / maxPosition;
  
  // 熔断阈值：3000 USDT 或 30%，且连续3次或5分钟内持续超限
  if (currentDiff > 3000 || diffRatio > 0.30) {
    // P2修复：连续3次或时间窗防抖
    const trendConfirmed = positionDiffState.diffIncreaseCount >= 3;
    const timeWindowExceeded = (now - positionDiffState.lastAlertAt) > alertIntervalMs;
    
    if ((trendConfirmed || timeWindowExceeded) && (now - positionDiffState.lastAlertAt) > 60000) {
      positionDiffState.lastAlertAt = now;
      const msg = '[P2告急] 持仓差值熔断! diff=' + currentDiff.toFixed(2) + 
                  ' (' + (diffRatio * 100).toFixed(1) + '%) | ' +
                  'exchange=' + (state.exchangePosition || 0).toFixed(2) + 
                  ' internal=' + (state.positionNotional || 0).toFixed(2);
      bridge_log('error', '[Gales] ' + msg);  // P0修复：直接用bridge_log
      
      // P2修复：TG通知bot-009、bot-004、bot-001（9号建议：加runId避免延迟消息误判）
      // P0修复：添加direction标识（区分neutral/short实例）
      const directionLabel = CONFIG.direction || 'neutral';
      try {
        if (typeof bridge_tgSend === 'function') {
          bridge_tgSend('9号', '[告急][' + directionLabel + '] 持仓差值熔断! diff=' + currentDiff.toFixed(0) + ' USDT (runId=' + state.runId + ')');
          bridge_tgSend('4号', '[告急][' + directionLabel + '] 持仓差值熔断! 请检查策略代码和quant-lab模块 (runId=' + state.runId + ')');
          bridge_tgSend('1号', '[告急][' + directionLabel + '] 持仓差值熔断! diff=' + currentDiff.toFixed(0) + ' USDT (runId=' + state.runId + ')');
        }
      } catch (e) {
        logWarn('[P2] tg通知失败: ' + e);
      }
      
      // P2修复：只告警不熔断（9号/鲶鱼建议）
      // 持仓差值监控设计为告警only，不置tripped，避免长期熔断中
      logWarn('[P2] 持仓差值告警：仅通知，不触发熔断');
    }
    return;
  }
  
  // 告警阈值：1000 USDT 或 10%，且连续2次
  if (currentDiff > 1000 || diffRatio > 0.10) {
    // P2修复：连续2次防抖
    const trendConfirmed = positionDiffState.diffIncreaseCount >= 2;
    const timeWindowExceeded = (now - positionDiffState.lastAlertAt) > alertIntervalMs;
    
    if ((trendConfirmed || timeWindowExceeded) && (now - positionDiffState.lastAlertAt) > 60000) {
      positionDiffState.lastAlertAt = now;
      const msg = '[P2告警] 持仓差值过大! diff=' + currentDiff.toFixed(2) + 
                  ' (' + (diffRatio * 100).toFixed(1) + '%) | ' +
                  'exchange=' + (state.exchangePosition || 0).toFixed(2) + 
                  ' internal=' + (state.positionNotional || 0).toFixed(2);
      logWarn(msg);
      
      // P2修复：TG通知bot-009和bot-001（9号建议：加runId避免延迟消息误判）
      // P0修复：添加direction标识（区分neutral/short实例）
      const directionLabel = CONFIG.direction || 'neutral';
      try {
        if (typeof bridge_tgSend === 'function') {
          bridge_tgSend('9号', '[告警][' + directionLabel + '] 持仓差值过大: ' + currentDiff.toFixed(0) + ' USDT (runId=' + state.runId + ')');
          bridge_tgSend('1号', '[告警][' + directionLabel + '] 持仓差值过大: ' + currentDiff.toFixed(0) + ' USDT (runId=' + state.runId + ')');
        }
      } catch (e) {
        logWarn('[P2] tg通知失败: ' + e);
      }
    }
  }
}

// ================================
// P0 修复：应急方向切换
// ================================

function checkEmergencyDirectionSwitch() {
  if (CONFIG.emergencyDirection !== 'auto') return;
  
  // 买满仓 → 强制切换到 long 模式（只做多）
  if (state.positionNotional >= CONFIG.maxPosition * 0.9) {
    if (CONFIG.direction !== 'long') {
      logWarn('[应急切换] 买满仓 → long 模式');
      CONFIG.direction = 'long';
      saveState();
    }
  }
  
  // 卖满仓 → 强制切换到 short 模式（只做空）
  if (state.positionNotional <= -CONFIG.maxPosition * 0.9) {
    if (CONFIG.direction !== 'short') {
      logWarn('[应急切换] 卖满仓 → short 模式');
      CONFIG.direction = 'short';
      saveState();
    }
  }
  
  // 仓位回到安全区 → 恢复 neutral
  if (Math.abs(state.positionNotional) < CONFIG.maxPosition * 0.5) {
    if (CONFIG.direction !== 'neutral' && CONFIG.emergencyDirection === 'auto') {
      logInfo('[应急切换] 仓位安全 → neutral 模式');
      CONFIG.direction = 'neutral';
      saveState();
    }
  }
}

// ================================
// 订单管理（sim + 真实共用）
// ================================

function getOpenOrder(orderId) {
  if (!orderId) return null;
  for (let i = 0; i < state.openOrders.length; i++) {
    const o = state.openOrders[i];
    if (o.orderId === orderId) return o;
  }
  return null;
}

function removeOpenOrder(orderId) {
  if (!orderId) return;
  state.openOrders = state.openOrders.filter(function(o) { return o.orderId !== orderId; });
}

function countActiveOrders() {
  if (!state.openOrders) return 0;
  let n = 0;
  for (let i = 0; i < state.openOrders.length; i++) {
    const o = state.openOrders[i];
    if (!o) continue;
    if (o.status === 'Filled' || o.status === 'Canceled') continue;
    n++;
  }
  return n;
}

function calcPendingNotional(side) {
  if (!state.openOrders) return 0;
  let sum = 0;

  for (let i = 0; i < state.openOrders.length; i++) {
    const o = state.openOrders[i];
    if (!o) continue;
    if (o.status === 'Filled' || o.status === 'Canceled') continue;
    if (o.side !== side) continue;

    const qty = o.qty || 0;
    const cum = o.cumQty || 0;
    const remaining = Math.max(0, qty - cum);
    const px = o.price || o.avgPrice || 0;

    sum += remaining * px;
  }

  return sum;
}

function findActiveOrderByGridId(gridId) {
  if (!gridId) return null;
  for (let i = 0; i < state.openOrders.length; i++) {
    const o = state.openOrders[i];
    if (!o) continue;
    if (o.gridId !== gridId) continue;
    if (o.status === 'Filled' || o.status === 'Canceled') continue;
    return o;
  }
  return null;
}

function syncGridFromOrder(grid, order) {
  if (!grid || !order) return;
  grid.state = 'ACTIVE';
  grid.orderId = order.orderId;
  grid.orderLinkId = order.orderLinkId;
  grid.orderPrice = order.price;
  grid.orderQty = order.qty;
  grid.cumQty = order.cumQty || 0;
  grid.avgFillPrice = order.avgPrice || 0;
  grid.createdAt = order.createdAt || grid.createdAt || Date.now();
}

// 修复/对齐 grid <-> openOrders 的一致性，避免重复挂单
function reconcileGridOrderLinks() {
  if (!state.gridLevels || state.gridLevels.length === 0) return;

  // 1) 如果 openOrders 里存在活跃订单，但 grid 却是 IDLE，则纠正为 ACTIVE
  for (let i = 0; i < state.openOrders.length; i++) {
    const o = state.openOrders[i];
    if (!o || !o.gridId) continue;
    if (o.status === 'Filled' || o.status === 'Canceled') continue;

    const g = findGridById(o.gridId);
    if (!g) continue;
    if (g.state !== 'ACTIVE' || g.orderId !== o.orderId) {
      syncGridFromOrder(g, o);
    }
  }

  // 2) 如果 grid 标记 ACTIVE 但找不到订单，则回收为 IDLE
  for (let i = 0; i < state.gridLevels.length; i++) {
    const g = state.gridLevels[i];
    if (!g) continue;
    if (g.state !== 'ACTIVE') continue;

    const o = getOpenOrder(g.orderId);
    if (!o || o.status === 'Filled' || o.status === 'Canceled') {
      g.state = 'IDLE';
      g.orderId = undefined;
      g.orderLinkId = undefined;
      g.orderPrice = undefined;
      g.orderQty = undefined;
    }
  }
}

function updatePositionFromFill(side, fillQty, fillPrice) {
  const notional = fillQty * fillPrice;

  // 方向模式处理
  if (CONFIG.direction === 'long') {
    // 做多模式：Buy 增加仓位，Sell 只是虚仓（对冲/减仓）
    if (side === 'Buy') {
      state.positionNotional += notional;
    } else {
      // Sell 成交只是对冲，记录虚仓但不减少实际仓位
      // 实际由操盘手跨产品对冲
      logDebug('[虚仓] long 模式下 Sell 成交仅记账: -' + notional.toFixed(2));
    }
    return;
  }

  if (CONFIG.direction === 'short') {
    // 做空模式：Sell 增加空仓（更负），Buy 减少空仓（向0靠拢，回补）
    if (side === 'Sell') {
      state.positionNotional -= notional;
    } else {
      // Buy 减少空仓（修复：原来是虚仓逻辑，现在实际影响仓位）
      state.positionNotional += notional;
      logDebug('[减空] short 模式下 Buy 成交减空仓: +' + notional.toFixed(2));
    }
    return;
  }

  // neutral 模式：双向都影响仓位
  if (side === 'Buy') state.positionNotional += notional;
  else state.positionNotional -= notional;
}

// 统一入口：订单状态更新（未来接 WebSocket 时也走这里）
function onOrderUpdate(order) {
  const local = getOpenOrder(order.orderId);
  if (!local) return;

  // 增量成交处理（避免重复累计）
  const prevCum = local.cumQty || 0;
  const nextCum = order.cumQty || 0;
  const delta = nextCum - prevCum;

  local.status = order.status;
  local.cumQty = nextCum;
  local.avgPrice = order.avgPrice || local.avgPrice || local.price;
  local.updatedAt = Date.now();

  if (delta > 0) {
    updatePositionFromFill(local.side, delta, local.avgPrice);
    logInfo('[成交增量] orderId=' + local.orderId + ' +' + delta.toFixed(4) + ' @ ' + local.avgPrice.toFixed(4) + ' | 仓位Notional=' + state.positionNotional.toFixed(2));
  }
}

/**
 * simMode: 模拟成交（用于在 paper trade 中验证部分成交策略）
 */
function simulateFillsIfNeeded() {
  if (!CONFIG.simMode) return;
  if (!state.openOrders || state.openOrders.length === 0) return;

  for (let i = 0; i < state.openOrders.length; i++) {
    const o = state.openOrders[i];
    if (!o || o.status === 'Filled' || o.status === 'Canceled') continue;

    // 限价单成交条件：
    // Buy: 市价 <= 限价
    // Sell: 市价 >= 限价
    const canFill = (o.side === 'Buy')
      ? (state.lastPrice <= o.price)
      : (state.lastPrice >= o.price);

    if (!canFill) continue;

    // 每次心跳最多成交 40% 剩余量（模拟"部分成交"）
    const remaining = o.qty - (o.cumQty || 0);
    if (remaining <= 0) continue;

    const fillQty = Math.min(remaining, o.qty * 0.4);
    const nextCum = (o.cumQty || 0) + fillQty;
    const status = nextCum >= o.qty ? 'Filled' : 'PartiallyFilled';

    onOrderUpdate({
      orderId: o.orderId,
      status: status,
      cumQty: nextCum,
      avgPrice: o.price,
    });
  }
}

function findGridById(gridId) {
  for (let i = 0; i < state.gridLevels.length; i++) {
    if (state.gridLevels[i].id === gridId) return state.gridLevels[i];
  }
  return null;
}

function findGridByOrderLinkId(orderLinkId) {
  for (let i = 0; i < state.gridLevels.length; i++) {
    if (state.gridLevels[i].orderLinkId === orderLinkId) return state.gridLevels[i];
  }
  return null;
}

function recordFill(grid, order, reason) {
  const fillPct = order.qty > 0 ? ((order.cumQty || 0) / order.qty) : 0;
  grid.lastFillPct = fillPct;
  grid.lastFillQty = order.cumQty || 0;
  grid.lastFillPrice = order.avgPrice || order.price;
  grid.lastFillReason = reason;
  grid.lastFillAt = Date.now();
}

/**
 * 增强 2: 对冲残余风险（碎片/不足阈值的部分成交）
 */
function hedgeResidual(grid, order) {
  if (!CONFIG.hedgeDustFills) return;
  if (!order || !order.cumQty || order.cumQty <= 0) return;

  const residualQty = order.cumQty;
  const hedgeSide = (order.side === 'Buy') ? 'Sell' : 'Buy';

  logInfo('[对冲残余] gridId=' + grid.id + ' side=' + hedgeSide + ' qty=' + residualQty.toFixed(4) + ' @ market');

  if (CONFIG.simMode) {
    // simMode: 模拟对冲成交（按当前价）
    updatePositionFromFill(hedgeSide, residualQty, state.lastPrice);
    logInfo('[SIM] 对冲成交 @ ' + state.lastPrice.toFixed(4) + ' | 仓位Notional=' + state.positionNotional.toFixed(2));
    return;
  }

  // 真实下单：市价单对冲
  try {
    // 防御性检查：symbol 必须有效
    if (!CONFIG.symbol || typeof CONFIG.symbol !== 'string' || CONFIG.symbol.length === 0) {
      logError('[hedgeResidual] CONFIG.symbol 无效: ' + CONFIG.symbol);
      throw new Error('Invalid symbol: ' + CONFIG.symbol);
    }

    const hedgeParams = {
      symbol: CONFIG.symbol,
      side: hedgeSide,
      qty: residualQty,
      orderType: 'Market',
    };

    const result = bridge_placeOrder(JSON.stringify(hedgeParams));
    logInfo('✅ 对冲成功: ' + result);
  } catch (e) {
    logWarn('❌ 对冲失败: ' + e);
  }
}

// ACTIVE 网格的风险/策略处理：超时、脱离、部分成交决策
function applyActiveOrderPolicy(grid, distance) {
  const order = getOpenOrder(grid.orderId);
  if (!order) {
    // 订单丢失：直接回到 IDLE
    grid.state = 'IDLE';
    grid.orderId = undefined;
    return;
  }

  // 订单已完全成交：记录并释放网格（允许后续再次交易）
  if (order.status === 'Filled') {
    recordFill(grid, order, 'filled');
    logInfo('[完全成交] gridId=' + grid.id + ' fillQty=' + (order.cumQty || 0).toFixed(4) + ' @ ' + (order.avgPrice || order.price).toFixed(4));
    removeOpenOrder(order.orderId);
    grid.state = 'IDLE';
    grid.orderId = undefined;
    grid.orderLinkId = undefined;
    grid.orderPrice = undefined;
    return;
  }

  // 超时撤单
  const ageSec = (Date.now() - (order.createdAt || Date.now())) / 1000;
  if (ageSec > CONFIG.maxOrderAgeSec) {
    const fillPct = order.qty > 0 ? ((order.cumQty || 0) / order.qty) : 0;
    logWarn('[订单超时] gridId=' + grid.id + ' ageSec=' + ageSec.toFixed(0) + ' fillPct=' + (fillPct * 100).toFixed(1) + '%');

    // 超时：有部分成交也撤掉剩余
    cancelOrder(grid);
    removeOpenOrder(order.orderId);

    if (order.cumQty > 0) {
      recordFill(grid, order, 'timeout');
      // 关键：是否"视为完全成交"？用 partialFillThreshold 判定
      if (fillPct >= CONFIG.partialFillThreshold) {
        logInfo('[超时-部分成交视为完成] gridId=' + grid.id + ' fillPct=' + (fillPct * 100).toFixed(1) + '%');
      } else if (fillPct < CONFIG.dustFillThreshold) {
        logWarn('[超时-碎片成交] gridId=' + grid.id + ' fillPct=' + (fillPct * 100).toFixed(1) + '%');
        // 增强 2: 对冲碎片残余风险
        hedgeResidual(grid, order);
      } else {
        logWarn('[超时-部分成交不足阈值] gridId=' + grid.id + ' fillPct=' + (fillPct * 100).toFixed(1) + '%');
        // 增强 2: 对冲不足阈值的残余风险
        hedgeResidual(grid, order);
      }
    }

    return;
  }

  // 价格脱离撤单（包含"部分成交 + 脱离"的关键场景）
  if (distance > CONFIG.cancelDistance) {
    // 增强 1: 防止瞬时波动撤单 - 检查订单最短存活时间
    if (ageSec < CONFIG.minOrderLifeSec) {
      // 订单还太新，不撤单（避免瞬时波动误撤）
      grid.driftCount = (grid.driftCount || 0);
      return;
    }

    // 增强 1: 连续脱离计数
    grid.driftCount = (grid.driftCount || 0) + 1;

    if (grid.driftCount < CONFIG.driftConfirmCount) {
      // 还未达到连续脱离次数，不撤单
      logDebug('[价格脱离 ' + grid.driftCount + '/' + CONFIG.driftConfirmCount + '] gridId=' + grid.id + ' dist=' + (distance * 100).toFixed(2) + '%');
      return;
    }

    // 达到连续脱离次数，执行撤单
    const fillPct = order.qty > 0 ? ((order.cumQty || 0) / order.qty) : 0;

    if ((order.cumQty || 0) > 0) {
      logWarn('[价格脱离+部分成交] gridId=' + grid.id +
        ' dist=' + (distance * 100).toFixed(2) + '% fillPct=' + (fillPct * 100).toFixed(1) + '% driftCount=' + grid.driftCount);

      // 决策：撤掉剩余（避免长期挂单）
      cancelOrder(grid);
      removeOpenOrder(order.orderId);
      recordFill(grid, order, 'drift');

      // 是否把"这一条 gale"视为完全成交？
      if (fillPct >= CONFIG.partialFillThreshold) {
        logInfo('[部分成交视为完成] gridId=' + grid.id + ' fillPct=' + (fillPct * 100).toFixed(1) + '%');
      } else if (fillPct < CONFIG.dustFillThreshold) {
        logWarn('[碎片成交] gridId=' + grid.id + ' fillPct=' + (fillPct * 100).toFixed(1) + '%（建议后续做碎片清理单）');
        // 增强 2: 对冲碎片残余风险
        hedgeResidual(grid, order);
      } else {
        logWarn('[部分成交不足阈值] gridId=' + grid.id + ' fillPct=' + (fillPct * 100).toFixed(1) + '%');
        // 增强 2: 对冲不足阈值的残余风险
        hedgeResidual(grid, order);
      }
    } else {
      // 无成交：直接撤单
      logInfo('[价格偏离-无成交] gridId=' + grid.id + ' dist=' + (distance * 100).toFixed(2) + '% driftCount=' + grid.driftCount);
      cancelOrder(grid);
      removeOpenOrder(order.orderId);
    }

    // 重置 driftCount
    grid.driftCount = 0;
  } else {
    // 价格回到正常范围，重置连续脱离计数
    if (grid.driftCount > 0) {
      logDebug('[价格回归] gridId=' + grid.id + ' 重置 driftCount');
      grid.driftCount = 0;
    }
  }
}

/**
 * 订单推送回调（为实盘预留：WebSocket 收到订单更新时调用）
 */
function st_onOrderUpdate(orderJson) {
  try {
    logDebug('[DEBUG] st_onOrderUpdate called, raw: ' + typeof orderJson);
    const order = (typeof orderJson === 'string') ? JSON.parse(orderJson) : orderJson;
    logDebug('[DEBUG] parsed order: ' + JSON.stringify(order));
    if (!order || !order.orderId) {
      logDebug('[DEBUG] st_onOrderUpdate early return: no orderId');
      return;
    }

    onOrderUpdate(order);

    // P0 修复：pending → 真实 orderId 映射回写
    let grid = null;
    
    // 优先通过 gridId 定位
    if (order.gridId) {
      grid = findGridById(order.gridId);
    }
    
    // 其次通过 orderLinkId 定位（交易所推送通常带 orderLinkId）
    if (!grid && order.orderLinkId) {
      grid = findGridByOrderLinkId(order.orderLinkId);
      // 补充 gridId 方便后续使用
      if (grid) {
        order.gridId = grid.id;
      }
    }
    
    if (grid) {
      // 关键修复：无论 grid.orderId 是什么，都回写真实 orderId
      // 场景：grid.orderId = pending-xxx → order.orderId = MYXUSDT:12345678
      const oldId = grid.orderId;
      const newId = order.orderId;
      
      if (oldId !== newId) {
        logInfo('[P0] pending → 真实 orderId: ' + oldId + ' → ' + newId + ' (gridId=' + grid.id + ')');
        grid.orderId = newId;
        
        // 同步更新 openOrders 中的 orderId
        const openOrder = state.openOrders.find(o => o.orderId === oldId);
        if (openOrder) {
          openOrder.orderId = newId;
        }
      }
      
      // 让 policy 在下一次 heartbeat 统一处理
      grid.lastExternalUpdateAt = Date.now();
    }

    saveState();
  } catch (e) {
    logWarn('st_onOrderUpdate parse failed: ' + e);
  }
}

/**
 * P0修复：成交明细回调（WebSocket收到execution时调用）
 * 直接更新positionNotional，带execId去重
 */
function st_onExecution(execJson) {
  try {
    const exec = (typeof execJson === 'string') ? JSON.parse(execJson) : execJson;
    if (!exec || !exec.execId) {
      logDebug('[st_onExecution] 无execId，跳过');
      return;
    }

    // execId去重
    if (processedExecIds[exec.execId]) {
      logDebug('[st_onExecution] execId=' + exec.execId + ' 已处理，跳过');
      return;
    }
    processedExecIds[exec.execId] = true;

    // 清理旧execId（保留最近1000个）
    const execIds = Object.keys(processedExecIds);
    if (execIds.length > 1000) {
      execIds.slice(0, execIds.length - 1000).forEach(id => delete processedExecIds[id]);
    }

    const side = exec.side;
    const execQty = parseFloat(exec.execQty || 0);
    const execPrice = parseFloat(exec.execPrice || 0);
    const notional = execQty * execPrice;

    if (execQty <= 0 || execPrice <= 0) {
      logWarn('[st_onExecution] 无效成交数据: qty=' + execQty + ' price=' + execPrice);
      return;
    }

    // 直接更新positionNotional（与updatePositionFromFill相同逻辑）
    if (CONFIG.direction === 'long') {
      if (side === 'Buy') {
        state.positionNotional += notional;
      }
      // Sell在long模式下是虚仓，不更新
    } else if (CONFIG.direction === 'short') {
      if (side === 'Sell') {
        state.positionNotional -= notional;
      } else {
        // Buy减少空仓
        state.positionNotional += notional;
      }
    } else {
      // neutral模式
      if (side === 'Buy') state.positionNotional += notional;
      else state.positionNotional -= notional;
    }

    logInfo('[成交明细] execId=' + exec.execId + ' ' + side + ' ' + execQty.toFixed(4) + ' @ ' + execPrice.toFixed(4) + 
            ' | 仓位Notional=' + state.positionNotional.toFixed(2));

    saveState();
  } catch (e) {
    logWarn('st_onExecution failed: ' + e);
  }
}

/**
 * 心跳日志（每 10 次输出一次）
 */
function logHeartbeat() {
  const activeOrders = state.openOrders.length;
  const nearestGrid = findNearestGrid();

  let msg = '[心跳 #' + state.tickCount + '] 价格: ' + state.lastPrice.toFixed(4);

  if (nearestGrid) {
    const distance = (Math.abs(state.lastPrice - nearestGrid.price) / nearestGrid.price * 100).toFixed(2);
    msg += ' | 最近网格: ' + nearestGrid.side + ' ' + nearestGrid.price.toFixed(4);
    msg += ' (距离 ' + distance + '%)';
  }

  msg += ' | 活跃订单: ' + activeOrders;

  logInfo(msg);
}

/**
 * 找到最近的网格
 */
function findNearestGrid() {
  if (!state.gridLevels || state.gridLevels.length === 0) return null;

  let nearest = state.gridLevels[0];
  let minDistance = Math.abs(state.lastPrice - nearest.price);

  for (let i = 1; i < state.gridLevels.length; i++) {
    const grid = state.gridLevels[i];
    const distance = Math.abs(state.lastPrice - grid.price);
    if (distance < minDistance) {
      minDistance = distance;
      nearest = grid;
    }
  }

  return nearest;
}

/**
 * 打印网格状态
 */
function printGridStatus() {
  logInfo('=== 网格档位 ===');
  logInfo('方向: ' + CONFIG.direction + (CONFIG.direction === 'neutral' ? '' : ' (虚仓仅记账)'));

  // 显示非对称参数
  const spacingDown = CONFIG.gridSpacingDown !== null ? CONFIG.gridSpacingDown : CONFIG.gridSpacing;
  const spacingUp = CONFIG.gridSpacingUp !== null ? CONFIG.gridSpacingUp : CONFIG.gridSpacing;
  const orderSizeDown = CONFIG.orderSizeDown !== null ? CONFIG.orderSizeDown : CONFIG.orderSize;
  const orderSizeUp = CONFIG.orderSizeUp !== null ? CONFIG.orderSizeUp : CONFIG.orderSize;

  const isAsymmetric = (CONFIG.gridSpacingDown !== null || CONFIG.gridSpacingUp !== null ||
                        CONFIG.orderSizeDown !== null || CONFIG.orderSizeUp !== null);

  if (isAsymmetric) {
    logInfo('非对称模式:');
    logInfo('  跌方向: 间距 ' + (spacingDown * 100).toFixed(2) + '%, 单量 ' + orderSizeDown);
    logInfo('  升方向: 间距 ' + (spacingUp * 100).toFixed(2) + '%, 单量 ' + orderSizeUp);
  }

  const buyGrids = state.gridLevels.filter(function(g) { return g.side === 'Buy'; });
  const sellGrids = state.gridLevels.filter(function(g) { return g.side === 'Sell'; });

  logInfo('买单网格 (' + buyGrids.length + ' 个):');
  buyGrids.forEach(function(g) {
    logInfo('  #' + g.id + ' @ ' + g.price.toFixed(4) + ' [' + g.state + ']');
  });

  logInfo('卖单网格 (' + sellGrids.length + ' 个):');
  sellGrids.forEach(function(g) {
    logInfo('  #' + g.id + ' @ ' + g.price.toFixed(4) + ' [' + g.state + ']');
  });

  logInfo('磁铁距离: ' + (CONFIG.magnetDistance * 100).toFixed(2) + '%');
  logInfo('取消距离: ' + (CONFIG.cancelDistance * 100).toFixed(2) + '%');
}

// ================================
// 生命周期函数
// ================================

/**
 * 初始化
 */
function st_init() {
  logDebug('[DEBUG] st_init called');
  logInfo('策略初始化...');
  logInfo('Symbol: ' + CONFIG.symbol);
  logInfo('GridCount: ' + CONFIG.gridCount);
  logInfo('Direction: ' + CONFIG.direction);
  logInfo('SimMode: ' + CONFIG.simMode);

  loadState();

  // P0修复：读取交易所持仓仅用于显示/参考，不覆盖策略内部记账
  try {
    logInfo('[Init] P0 DEBUG: 准备调用 bridge_getPosition, symbol=' + CONFIG.symbol);
    const positionJson = bridge_getPosition(CONFIG.symbol);
    logInfo('[Init] P0 DEBUG: bridge_getPosition 返回: ' + JSON.stringify(positionJson));
    
    if (positionJson === 'null' || positionJson === null || positionJson === undefined || positionJson === '') {
      logInfo('[Init] P0 DEBUG: 检测到空持仓 (null/undefined/empty)');
      logInfo('[Init] 交易所无持仓');
      state.exchangePosition = 0;  // 仅记录交易所持仓，不影响策略内部记账
    } else {
      logInfo('[Init] P0 DEBUG: 开始解析持仓 JSON');
      const position = JSON.parse(positionJson);
      
      logInfo('[Init] 检测到交易所持仓:');
      logInfo('[Init]   symbol: ' + position.symbol);
      logInfo('[Init]   side: ' + position.side);
      logInfo('[Init]   positionNotional: ' + position.positionNotional);
      
      // 记录交易所持仓（仅用于显示和initialOffset计算）
      // 方案C：每个策略维护独立账本，不覆盖策略内部positionNotional
      let exchangePosition = position.positionNotional || 0;
      const isShortSide = position.side === 'Sell' || position.side === 'SHORT' || position.side === 'short';
      if (isShortSide) {
        exchangePosition = -Math.abs(exchangePosition);
      }
      state.exchangePosition = exchangePosition;
      
      logInfo('[Init]   交易所持仓(仅供参考): ' + state.exchangePosition.toFixed(2));
      logInfo('[Init]   策略内部持仓(独立账本): ' + state.positionNotional.toFixed(2));
      logInfo('[Init] ✅ 方案C：策略独立账本，通过订单历史累积positionNotional');
    }
    
    saveState();
  } catch (e) {
    logWarn('[Init] P0 DEBUG: 获取持仓异常: ' + e);
    logWarn('[Init] 获取交易所持仓失败: ' + e);
  }
  
  // P0修复：110072根治 - 生成新的runId
  state.runId = Date.now();
  state.orderSeq = 0;
  logInfo('[Init] P0: 110072根治 - 新runId=' + state.runId + '，orderLinkId将唯一');
  
  // P0修复v5: 新runId强制initialOffset=0，不继承旧值（1号方案）
  // 原因：旧state中的positionNotional可能已过期，重新对齐持仓
  positionDiffState.initialOffset = 0;
  state.initialOffset = 0;
  logInfo('[Init] P0: 新runId强制initialOffset=0，重新对齐持仓');
  
  // 重置positionNotional为0，从当前开始累积（避免旧数据干扰）
  state.positionNotional = 0;
  logInfo('[Init] P0: 重置positionNotional=0，从当前开始累积');
  
  // P2修复：检测遗留订单（鲶鱼建议）
  checkLegacyOrders();
}

// P2修复：检测遗留订单并告警
function checkLegacyOrders() {
  try {
    // P2修复：更强判断，避免刷屏
    const fn = globalThis.bridge_getOpenOrders;
    if (typeof fn !== 'function') {
      logDebug('[P2] bridge_getOpenOrders未定义，跳过遗留订单检测');
      return;
    }
    
    const ordersJson = fn(CONFIG.symbol);
    if (!ordersJson || ordersJson === 'null' || ordersJson === '[]') {
      return; // 无挂单
    }
    
    const orders = JSON.parse(ordersJson);
    if (!Array.isArray(orders) || orders.length === 0) {
      return;
    }
    
    // 筛选遗留订单（orderLinkId以gales-开头但runId不匹配）
    const legacyOrders = orders.filter(o => {
      if (o.orderLinkId && o.orderLinkId.startsWith('gales-')) {
        const parts = o.orderLinkId.split('-');
        if (parts.length >= 2) {
          const orderRunId = parts[1];
          return orderRunId !== String(state.runId);
        }
      }
      return false;
    });
    
    if (legacyOrders.length > 0) {
      // P1修复：去重 - 如果上次已告警过相同的订单列表则不再告警
      const currentLegacyIds = legacyOrders.map(o => o.orderLinkId).sort().join(',');
      const lastLegacyIds = state.lastLegacyOrderIds || '';
      
      // 记录本次告警的订单ID
      state.lastLegacyOrderIds = currentLegacyIds;
      
      // 如果与上次相同则跳过告警
      if (currentLegacyIds === lastLegacyIds && lastLegacyIds !== '') {
        logDebug('[P2] 遗留订单与上次相同，跳过重复告警');
      } else {
        // 构建详细告警信息
        let details = '[P2告警] 发现' + legacyOrders.length + '个遗留订单来自旧run\n';
        details += '当前runId: ' + state.runId + '\n';
        details += '遗留订单详情:\n';
        
        // P3修复：补充mark价格和距离百分比（9号建议）
        const markPrice = state.lastPrice || 0;
        details += '当前mark价格: ' + markPrice.toFixed(4) + '\n';
        
        legacyOrders.forEach((o, idx) => {
          // 鲶鱼建议：交易所返回string需转为Number再toFixed
          const orderPrice = Number(o.price || 0);
          const qty = Number(o.qty || 0);
          const parts = o.orderLinkId.split('-');
          const oldRunId = parts[1] || 'unknown';
          const distancePct = markPrice > 0 ? ((orderPrice - markPrice) / markPrice * 100).toFixed(2) : 'N/A';
          
          details += (idx + 1) + '. orderId=' + (o.orderId || 'unknown') + '\n';
          details += '   orderLinkId=' + o.orderLinkId + '\n';
          details += '   旧runId=' + oldRunId + '\n';
          details += '   side=' + (o.side || 'Unknown') + ' price=' + orderPrice.toFixed(4) + ' qty=' + qty.toFixed(4) + '\n';
          details += '   status=' + (o.status || 'Unknown') + '\n';
          details += '   距离mark: ' + distancePct + '% (mark=' + markPrice.toFixed(4) + ')\n';
        });
        
        details += '建议操作: 请手动检查上述订单是否仍需保留，如不需要请手动撤单';
        
        logWarn(details);
        
        // TG通知bot-009（仅首次告警）
        try {
          if (typeof bridge_tgSend === 'function') {
            const summary = '[告警] 遗留订单: ' + legacyOrders.length + '个来自旧run，请检查是否手动处理';
            bridge_tgSend('9号', summary);
          }
        } catch (e) {
          logWarn('[P2] tg通知失败: ' + e);
        }
      }
      
      state.legacyOrdersAtStartup = legacyOrders.length;
    } else {
      logInfo('[P2] 未检测到遗留订单');
    }
  } catch (e) {
    // 添加详细调试信息
    let debugInfo = '[P2] 检测遗留订单失败: ' + e;
    try {
      debugInfo += ' | typeof e: ' + typeof e;
      debugInfo += ' | e.message: ' + (e.message || 'N/A');
      debugInfo += ' | String(e): ' + String(e).slice(0, 100);
    } catch (debugErr) {}
    logWarn(debugInfo);
  }
}

/**
 * 心跳
 */
function st_heartbeat(tickJson) {
  // QuickJS 传递的是 JSON 字符串
  const tick = (typeof tickJson === 'string') ? JSON.parse(tickJson) : tickJson;

  if (!tick || !tick.price) return;

  state.lastPrice = tick.price;
  state.tickCount = (state.tickCount || 0) + 1;

  // P0止血：临时禁用差值告警（避免噪声）
  // checkPositionDiff();

  // P0 修复：每60心跳更新exchangePosition（从cache读取，cache由QuickJSStrategy.onTick刷新）
  if (state.tickCount % 60 === 0) {
    try {
      const positionJson = bridge_getPosition(CONFIG.symbol);
      if (positionJson && positionJson !== 'null') {
        const position = JSON.parse(positionJson);
        let exchangePosition = position.positionNotional || 0;
        if (position.side === 'SHORT') {
          exchangePosition = -Math.abs(exchangePosition);
        }
        const oldExchange = state.exchangePosition || 0;
        state.exchangePosition = exchangePosition;
        if (Math.abs(exchangePosition - oldExchange) > 10) {
          logInfo('[Position Refresh] 交易所持仓更新: ' + oldExchange.toFixed(2) + ' -> ' + exchangePosition.toFixed(2));
        }
      }
    } catch (e) {
      logWarn('[Position Refresh] 读取失败: ' + e);
    }
  }

  // 首次初始化网格
  if (!state.initialized) {
    state.centerPrice = tick.price;
    initializeGrids();
    state.initialized = true;
    state.lastPlaceTick = state.tickCount;
    logInfo('网格初始化完成，中心价格: ' + state.centerPrice);
    printGridStatus();
    saveState();
    return;
  }

  // ================================
  // P0 修复：熔断检查（最高优先级）
  // ================================
  if (checkCircuitBreaker()) {
    // 熔断中，跳过所有交易逻辑
    if (state.tickCount % 60 === 0) {  // 每 5 分钟提醒一次
      logWarn('[熔断中] 原因: ' + circuitBreakerState.reason + ' | 仓位: ' + state.positionNotional.toFixed(2));
    }
    return;
  }

  // ================================
  // P0 修复：应急方向切换
  // ================================
  checkEmergencyDirectionSwitch();

  // 每 10 次心跳输出一次状态（避免刷屏）
  if (state.tickCount % 10 === 0) {
    logHeartbeat();
  }

  // 修复 grid/openOrders 不一致（避免重复挂单/状态漂移）
  reconcileGridOrderLinks();

  // ================================
  // P0 修复：Auto Recenter + 满仓死锁修复
  // ================================
  if (CONFIG.autoRecenter) {
    const center = state.centerPrice || state.lastPrice;
    const drift = Math.abs(state.lastPrice - center) / center;
    const idleTicks = (state.tickCount || 0) - (state.lastPlaceTick || 0);
    const cooldownOk = (Date.now() - (state.lastRecenterAtMs || 0)) >= (CONFIG.recenterCooldownSec * 1000);
    const noActiveOrders = countActiveOrders() === 0;
    
    // P0 修复：满仓时允许重心
    const fullPositionStuck = (
      (state.positionNotional >= CONFIG.maxPosition && hasOnlyActiveSellOrders()) ||
      (state.positionNotional <= -CONFIG.maxPosition && hasOnlyActiveBuyOrders())
    );

    if (drift >= CONFIG.recenterDistance && 
        idleTicks >= CONFIG.recenterMinIdleTicks && 
        cooldownOk && 
        (noActiveOrders || fullPositionStuck)) {
      
      const reason = fullPositionStuck ? '满仓死锁自动重心' : '自动重心';
      logWarn('[' + reason + '] drift=' + (drift * 100).toFixed(2) + 
              '% idleTicks=' + idleTicks + 
              ' posNotional=' + state.positionNotional.toFixed(2) +
              ' center=' + center.toFixed(4) + ' -> ' + state.lastPrice.toFixed(4));

      // 强制撤销所有订单（包括卖单/买单）
      cancelAllOrders();

      // 重心并重建网格
      state.centerPrice = state.lastPrice;
      initializeGrids();
      state.lastRecenterAtMs = Date.now();
      state.lastRecenterTick = state.tickCount;

      // 视为"有动作"，避免重心后马上再次重心
      state.lastPlaceTick = state.tickCount;

      saveState();
      return;
    }
  }

  // simMode: 先模拟成交，方便在 paper trade 中验证"部分成交"策略
  simulateFillsIfNeeded();

  // 成交/状态更新后再对齐一次
  reconcileGridOrderLinks();

  // P0 修复：磁铁策略 - 只挂最近的一个网格
  // 1. 找到最近的 IDLE 网格
  let nearestGrid = null;
  let minDistance = Infinity;
  
  for (let i = 0; i < state.gridLevels.length; i++) {
    const grid = state.gridLevels[i];
    if (grid.state === 'IDLE') {
      const distance = Math.abs(state.lastPrice - grid.price) / grid.price;
      if (distance < minDistance) {
        minDistance = distance;
        nearestGrid = grid;
      }
    } else if (grid.state === 'ACTIVE') {
      applyActiveOrderPolicy(grid, Math.abs(state.lastPrice - grid.price) / grid.price);
    }
  }
  
  // 2. 只检查最近的一个是否在磁铁范围内
  if (nearestGrid) {
    if (shouldPlaceOrder(nearestGrid, minDistance)) {
      placeOrder(nearestGrid);
    }
  }

  // 心跳末尾持久化（确保部分成交/对冲/撤单等状态不丢）
  saveState();
}

/**
 * 参数热更新（不重启沙箱）
 */
function st_onParamsUpdate(newParamsJson) {
  const newParams = (typeof newParamsJson === 'string') ? JSON.parse(newParamsJson) : newParamsJson;

  logInfo('[Gales] 参数热更新: ' + JSON.stringify(newParams));

  // 更新配置
  if (newParams.gridCount !== undefined) {
    CONFIG.gridCount = newParams.gridCount;
    logInfo('[Gales] 网格数量: ' + CONFIG.gridCount);
  }
  if (newParams.gridSpacing !== undefined) {
    CONFIG.gridSpacing = newParams.gridSpacing;
    logInfo('[Gales] 网格间距: ' + CONFIG.gridSpacing);
  }
  if (newParams.gridSpacingUp !== undefined) {
    CONFIG.gridSpacingUp = newParams.gridSpacingUp;
    logInfo('[Gales] 升方向网格间距: ' + CONFIG.gridSpacingUp);
  }
  if (newParams.gridSpacingDown !== undefined) {
    CONFIG.gridSpacingDown = newParams.gridSpacingDown;
    logInfo('[Gales] 跌方向网格间距: ' + CONFIG.gridSpacingDown);
  }
  if (newParams.orderSize !== undefined) {
    CONFIG.orderSize = newParams.orderSize;
    logInfo('[Gales] 单笔名义: ' + CONFIG.orderSize);
  }
  if (newParams.orderSizeUp !== undefined) {
    CONFIG.orderSizeUp = newParams.orderSizeUp;
    logInfo('[Gales] 升方向订单大小: ' + CONFIG.orderSizeUp);
  }
  if (newParams.orderSizeDown !== undefined) {
    CONFIG.orderSizeDown = newParams.orderSizeDown;
    logInfo('[Gales] 跌方向订单大小: ' + CONFIG.orderSizeDown);
  }
  if (newParams.maxPosition !== undefined) {
    CONFIG.maxPosition = newParams.maxPosition;
    logInfo('[Gales] 最大仓位: ' + CONFIG.maxPosition);
  }
  if (newParams.magnetDistance !== undefined) {
    CONFIG.magnetDistance = newParams.magnetDistance;
    logInfo('[Gales] 磁铁距离: ' + CONFIG.magnetDistance);
  }
  if (newParams.magnetRelativeToGrid !== undefined) {
    CONFIG.magnetRelativeToGrid = newParams.magnetRelativeToGrid;
    logInfo('[Gales] 相对磁铁: ' + CONFIG.magnetRelativeToGrid);
  }
  if (newParams.magnetGridRatio !== undefined) {
    CONFIG.magnetGridRatio = newParams.magnetGridRatio;
    logInfo('[Gales] 磁铁比例: ' + CONFIG.magnetGridRatio);
  }
  if (newParams.cancelDistance !== undefined) {
    CONFIG.cancelDistance = newParams.cancelDistance;
    logInfo('[Gales] 取消距离: ' + CONFIG.cancelDistance);
  }
  if (newParams.cooldownSec !== undefined) {
    CONFIG.cooldownSec = newParams.cooldownSec;
    logInfo('[Gales] 冷却秒数: ' + CONFIG.cooldownSec);
  }
  if (newParams.maxActiveOrders !== undefined) {
    CONFIG.maxActiveOrders = newParams.maxActiveOrders;
    logInfo('[Gales] 最大活跃单: ' + CONFIG.maxActiveOrders);
  }

  if (newParams.autoRecenter !== undefined) {
    CONFIG.autoRecenter = newParams.autoRecenter;
    logInfo('[Gales] 自动重心: ' + CONFIG.autoRecenter);
  }
  if (newParams.recenterDistance !== undefined) {
    CONFIG.recenterDistance = newParams.recenterDistance;
    logInfo('[Gales] 重心触发距离: ' + CONFIG.recenterDistance);
  }
  if (newParams.recenterCooldownSec !== undefined) {
    CONFIG.recenterCooldownSec = newParams.recenterCooldownSec;
    logInfo('[Gales] 重心冷却秒数: ' + CONFIG.recenterCooldownSec);
  }
  if (newParams.recenterMinIdleTicks !== undefined) {
    CONFIG.recenterMinIdleTicks = newParams.recenterMinIdleTicks;
    logInfo('[Gales] 重心最小空闲 ticks: ' + CONFIG.recenterMinIdleTicks);
  }
  if (newParams.direction !== undefined) {
    CONFIG.direction = newParams.direction;
    logInfo('[Gales] 策略方向: ' + CONFIG.direction);
  }
  // symbol 热更新（防御性检查）
  if (newParams.symbol !== undefined) {
    if (newParams.symbol && typeof newParams.symbol === 'string' && newParams.symbol.length > 0) {
      CONFIG.symbol = newParams.symbol;
      logInfo('[Gales] 交易对: ' + CONFIG.symbol);
    } else {
      logWarn('[Gales] 忽略无效的 symbol: ' + newParams.symbol);
    }
  }

  // 重新初始化网格（保持当前价格）
  if (state.initialized) {
    logInfo('[Gales] 重新初始化网格（中心价格: ' + state.lastPrice + '）');
    state.centerPrice = state.lastPrice;
    initializeGrids();
  }

  // 可选：撤销旧订单
  const cancelOldOrders = newParams.cancelOldOrders || false;
  if (cancelOldOrders && state.openOrders.length > 0) {
    logInfo('[Gales] 撤销旧订单: ' + state.openOrders.length + ' 个');
    state.openOrders.forEach(function(order) {
      bridge_cancelOrder(order.orderId);
    });
    state.openOrders = [];
  }

  // 如果要求立刻重心
  if (newParams.forceRecenter) {
    logWarn('[Gales] forceRecenter=true，立即重心');
    state.centerPrice = state.lastPrice;
    initializeGrids();
    state.lastRecenterAtMs = Date.now();
    state.lastRecenterTick = state.tickCount || 0;
  }

  saveState();
  logInfo('[Gales] 参数热更新完成');
}

/**
 * 停止
 */
function st_stop() {
  logInfo('策略停止');
  saveState();
}

// ================================
// 网格管理
// ================================

function initializeGrids() {
  state.gridLevels = [];
  const center = state.centerPrice;

  // 非对称间距（向后兼容：不传时使用 gridSpacing）
  const spacingDown = CONFIG.gridSpacingDown !== null ? CONFIG.gridSpacingDown : CONFIG.gridSpacing;
  const spacingUp = CONFIG.gridSpacingUp !== null ? CONFIG.gridSpacingUp : CONFIG.gridSpacing;

  // 买单网格（跌方向）
  for (let i = 1; i <= CONFIG.gridCount; i++) {
    const price = center * (1 - spacingDown * i);
    state.gridLevels.push({
      id: state.nextGridId++,
      price: price,
      side: 'Buy',
      state: 'IDLE',
      attempts: 0,
      lastTriggerTime: null,
      lastTriggerPrice: null,
      driftCount: 0,
    });
  }

  // 卖单网格（升方向）
  for (let i = 1; i <= CONFIG.gridCount; i++) {
    const price = center * (1 + spacingUp * i);
    state.gridLevels.push({
      id: state.nextGridId++,
      price: price,
      side: 'Sell',
      state: 'IDLE',
      attempts: 0,
      lastTriggerTime: null,
      lastTriggerPrice: null,
      driftCount: 0,
    });
  }

  logInfo('生成网格: ' + state.gridLevels.length + ' 个档位');
  logInfo('  跌方向间距: ' + (spacingDown * 100).toFixed(2) + '%');
  logInfo('  升方向间距: ' + (spacingUp * 100).toFixed(2) + '%');
}

function getEffectiveMagnetDistance() {
  let d = CONFIG.magnetDistance;

  if (CONFIG.magnetRelativeToGrid) {
    const rel = CONFIG.gridSpacing * (CONFIG.magnetGridRatio || 0);
    if (rel > d) d = rel;
  }

  // 避免 magnet >= cancelDistance（否则会出现触发后立刻进入撤单区的尴尬）
  if (CONFIG.cancelDistance && d >= CONFIG.cancelDistance) {
    d = CONFIG.cancelDistance * 0.9;
  }

  return d;
}

function shouldPlaceOrder(grid, distance) {
  const distancePct = (distance * 100).toFixed(2);

  // P0 Debug: 记录 Buy 网格检查
  if (grid.side === 'Buy') {
    logDebug('[P0 DEBUG] shouldPlaceOrder Buy gridId=' + grid.id + ' price=' + grid.price.toFixed(4) + ' distance=' + distancePct + '% state=' + grid.state);
  }

  // 1. 磁铁检查（双向）
  const magnet = getEffectiveMagnetDistance();
  if (distance > magnet) {
    if (grid.side === 'Buy') {
      logDebug('[P0 DEBUG] Buy gridId=' + grid.id + ' 距离超磁铁: ' + distancePct + '% > ' + (magnet*100).toFixed(2) + '%');
    }
    return false;  // 距离太远
  }

  // 2. 活跃订单上限（治理）
  const active = countActiveOrders();
  if (CONFIG.maxActiveOrders > 0 && active >= CONFIG.maxActiveOrders) {
    const now = Date.now();
    if (now - (runtime.activeOrders.lastWarnAt || 0) > 5 * 60 * 1000) {
      runtime.activeOrders.lastWarnAt = now;
      logWarn('[活跃单上限] active=' + active + ' max=' + CONFIG.maxActiveOrders + '，暂停新挂单');
    }
    return false;
  }

  // 3. 冷却时间检查（防止重复触发）
  if (grid.lastTriggerTime) {
    const cooldownMs = CONFIG.cooldownSec * 1000;
    const elapsed = Date.now() - grid.lastTriggerTime;
    if (elapsed < cooldownMs) {
      if (grid.side === 'Buy') {
        logDebug('[P0 DEBUG] Buy gridId=' + grid.id + ' 冷却中: ' + (elapsed/1000).toFixed(1) + 's < ' + CONFIG.cooldownSec + 's');
      }
      return false;  // 冷却中
    }
  }

  // 4. 防重复：如果该 grid 已存在活跃订单（但 grid 状态丢了），则修复并跳过
  const existing = findActiveOrderByGridId(grid.id);
  if (existing) {
    if (grid.side === 'Buy') {
      logDebug('[P0 DEBUG] Buy gridId=' + grid.id + ' 已存在活跃单: ' + existing.orderId);
    }
    syncGridFromOrder(grid, existing);
    return false;
  }

  // 5. 方向检查（总裁决策修改：允许止盈单）
  if (CONFIG.direction === 'long' && grid.side === 'Sell') {
    // long模式：有多仓(>0)时允许Sell止盈，无仓(<=0)时禁止Sell开空
    if (state.positionNotional <= 0) {
      logDebug('[方向限制] long 模式下无多仓时禁止 Sell 开空 gridId=' + grid.id);
      return false;
    }
    // 有多仓时允许Sell止盈（不return false）
  }
  if (CONFIG.direction === 'short' && grid.side === 'Buy') {
    // short模式：有空仓(<0)时允许Buy回补，无仓(>=0)时禁止Buy做多
    if (state.positionNotional >= 0) {
      logDebug('[方向限制] short 模式下无空仓时禁止 Buy 做多 gridId=' + grid.id);
      return false;
    }
    // 有空仓时允许Buy回补（不return false）
  }

  // P1修复：熔断震荡 - 熔断中禁止超限方向开仓
  if (circuitBreakerState.tripped && circuitBreakerState.blockedSide === grid.side) {
    logDebug('[熔断限制] 熔断中禁止' + grid.side + '开仓 gridId=' + grid.id);
    return false;
  }

  // P0修复：仓位检查使用effectivePosition（考虑交易所真实持仓）
  const effectivePos = Math.max(
    Math.abs(state.positionNotional || 0),
    Math.abs(state.exchangePosition || 0)
  );
  const effectivePosSigned = state.exchangePosition || state.positionNotional || 0;
  const orderNotional = CONFIG.orderSize;

  if (grid.side === 'Buy') {
    // short 模式下，Buy 只是虚仓，不限制
    if (CONFIG.direction !== 'short') {
      const pendingBuy = calcPendingNotional('Buy');
      // 使用effectivePosition评估最坏情况
      const afterFill = effectivePosSigned + pendingBuy + orderNotional;
      if (afterFill > CONFIG.maxPosition) {
        warnPositionLimit('Buy', grid.id, effectivePosSigned + pendingBuy, afterFill);
        return false;
      }
    }
    // 回到安全区后，允许下次"再次进入超限"时报警
    runtime.posLimit.buyOver = false;
  }

  if (grid.side === 'Sell') {
    // long 模式下，Sell 只是虚仓，不限制
    if (CONFIG.direction !== 'long') {
      const pendingSell = calcPendingNotional('Sell');
      // 使用effectivePosition评估最坏情况
      const afterFill = effectivePosSigned - pendingSell - orderNotional;
      if (afterFill < -CONFIG.maxPosition) {
        warnPositionLimit('Sell', grid.id, effectivePosSigned - pendingSell, afterFill);
        return false;
      }
    }
    runtime.posLimit.sellOver = false;
  }

  // 6. 通过所有检查，可以触发
  if (grid.side === 'Buy') {
    logInfo('[P0 DEBUG] ✨ Buy gridId=' + grid.id + ' 通过所有检查，即将触发! price=' + grid.price.toFixed(4) + ' distance=' + distancePct + '%');
  }
  logInfo('✨ 触发网格 #' + grid.id + ' ' + grid.side + ' @ ' + grid.price.toFixed(4) + ' (距离 ' + distancePct + '%)');
  return true;
}

function placeOrder(grid) {
  // 双保险：避免重复挂单（grid 状态丢失时常见）
  const existing = findActiveOrderByGridId(grid.id);
  if (existing) {
    syncGridFromOrder(grid, existing);
    return;
  }

  grid.state = 'PLACING';
  grid.attempts++;
  grid.lastTriggerTime = Date.now();
  grid.lastTriggerPrice = state.lastPrice;

  let orderPrice = grid.price;
  if (grid.side === 'Buy') {
    orderPrice = grid.price * (1 - CONFIG.priceOffset);
  } else {
    orderPrice = grid.price * (1 + CONFIG.priceOffset);
  }

  // postOnly 保护
  const priceTick = 0.001;
  if (CONFIG.postOnly) {
    if (grid.side === 'Buy' && orderPrice >= state.lastPrice) {
      orderPrice = state.lastPrice - priceTick;
    } else if (grid.side === 'Sell' && orderPrice <= state.lastPrice) {
      orderPrice = state.lastPrice + priceTick;
    }
  }

  // 非对称订单大小（向后兼容：不传时使用 orderSize）
  const orderSize = grid.side === 'Buy'
    ? (CONFIG.orderSizeDown !== null ? CONFIG.orderSizeDown : CONFIG.orderSize)
    : (CONFIG.orderSizeUp !== null ? CONFIG.orderSizeUp : CONFIG.orderSize);

  const quantity = orderSize / orderPrice;
  // P0修复：110072根治 - 使用runId+序列号生成唯一orderLinkId
  const orderLinkId = 'gales-' + state.runId + '-' + (state.orderSeq++) + '-' + grid.side;

  // 记录"有下单行为"（用于 autoRecenter 判断）
  state.lastPlaceTick = state.tickCount || 0;

  logInfo((CONFIG.simMode ? '[SIM] ' : '') + '挂单 gridId=' + grid.id + ' ' + grid.side + ' ' + quantity.toFixed(4) + ' @ ' + orderPrice.toFixed(4));

  if (CONFIG.simMode) {
    const orderId = 'sim-' + grid.id + '-' + Date.now();

    const order = {
      orderId: orderId,
      orderLinkId: orderLinkId,
      gridId: grid.id,
      side: grid.side,
      price: orderPrice,
      qty: quantity,
      status: 'New',
      cumQty: 0,
      avgPrice: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    state.openOrders.push(order);

    grid.state = 'ACTIVE';
    grid.orderId = orderId;
    grid.orderLinkId = orderLinkId;
    grid.orderPrice = orderPrice;
    grid.orderQty = quantity;
    grid.cumQty = 0;
    grid.avgFillPrice = 0;
    grid.createdAt = order.createdAt;

    saveState();
    return;
  }

  // TODO: 真实下单（通过 bridge_placeOrder）
  try {
    // 防御性检查：symbol 必须有效
    if (!CONFIG.symbol || typeof CONFIG.symbol !== 'string' || CONFIG.symbol.length === 0) {
      logError('[placeOrder] CONFIG.symbol 无效: ' + CONFIG.symbol);
      throw new Error('Invalid symbol: ' + CONFIG.symbol);
    }

    // P0修复：添加reduceOnly字段（neutral只减仓，short允许开空）
    let reduceOnly = false;
    if (CONFIG.direction === 'neutral') {
      // neutral策略：只减仓，不开新仓
      reduceOnly = true;
    } else if (CONFIG.direction === 'short' && grid.side === 'Sell') {
      // short策略开空仓：允许
      reduceOnly = false;
    } else if (CONFIG.direction === 'short' && grid.side === 'Buy') {
      // short策略回补：通常是平仓，但也能是开多（根据设计决定）
      // 目前保持false允许操作，如果需要严格只做空可设为true
      reduceOnly = false;
    }
    
    const params = {
      symbol: CONFIG.symbol,
      side: grid.side,
      qty: quantity,
      price: orderPrice,
      orderLinkId: orderLinkId,
      gridId: grid.id,  // P0 修复：必须传递 gridId（notifyOrderUpdate 依赖）
      reduceOnly: reduceOnly,  // P0修复：添加reduceOnly
    };

    const result = bridge_placeOrder(JSON.stringify(params));
    const order = JSON.parse(result);

    grid.state = 'ACTIVE';
    grid.orderId = order.orderId;
    grid.orderLinkId = orderLinkId;
    grid.orderPrice = orderPrice;
    grid.orderQty = quantity;
    grid.cumQty = 0;
    grid.avgFillPrice = 0;
    grid.createdAt = Date.now();

    // 记录到 openOrders（后续由 st_onOrderUpdate 更新状态）
    state.openOrders.push({
      orderId: grid.orderId,
      orderLinkId: orderLinkId,
      gridId: grid.id,
      side: grid.side,
      price: orderPrice,
      qty: quantity,
      status: 'New',
      cumQty: 0,
      avgPrice: 0,
      createdAt: grid.createdAt,
      updatedAt: grid.createdAt,
    });

    logInfo('✅ 挂单成功 orderId=' + grid.orderId);
    saveState();
  } catch (e) {
    logWarn('❌ 挂单失败: ' + e);
    grid.state = 'IDLE';
  }
}

function cancelOrder(grid) {
  if (!grid.orderId) return;

  const orderId = grid.orderId;

  grid.state = 'CANCELING';

  if (CONFIG.simMode) {
    // 标记订单取消
    const o = getOpenOrder(orderId);
    if (o) {
      o.status = 'Canceled';
      o.updatedAt = Date.now();
    }
    removeOpenOrder(orderId);

    grid.state = 'IDLE';
    grid.orderId = undefined;
    grid.orderLinkId = undefined;
    grid.orderPrice = undefined;
    saveState();
    return;
  }

  // TODO: 真实撤单（通过 bridge_cancelOrder）
  try {
    bridge_cancelOrder(orderId);
    logInfo('✅ 取消订单成功 orderId=' + orderId);

    removeOpenOrder(orderId);

    grid.state = 'IDLE';
    grid.orderId = undefined;
    grid.orderLinkId = undefined;
    grid.orderPrice = undefined;
    saveState();
  } catch (e) {
    logWarn('❌ 取消订单失败: ' + e);
    grid.state = 'IDLE';
  }
}
