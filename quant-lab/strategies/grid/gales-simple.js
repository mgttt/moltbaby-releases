/**
 * Gales 策略 - QuickJS 简化版
 *
 * 磁铁限价网格策略
 */

// P2修复：持仓差值监控风控（必须在CONFIG之前定义）
let positionDiffState = {
  initialOffset: 0,           // 初始差值/历史遗留仓基准
  lastDiff: 0,                // 上次差值（用于趋势检测）
  diffIncreaseCount: 0,       // 差值连续增大计数
  lastAlertAt: 0,             // 上次告警时间（防抖）
  // [硬拦截最小集] B类: 状态不可置信硬拦截计数
  ledgerGapOverCount: 0,      // 差值>2000U的连续心跳数
  ledgerGapHardblocked: false, // B类硬拦截生效中
  lastHardblockAlertAt: 0,    // 硬拦截告警防抖
};

// P0修复：execution去重集合（防止重复处理成交）
let processedExecIds = {};

// 市场状态检测（ADX趋势强度）
let marketRegimeState = {
  priceHistory: [],           // 价格历史（用于计算ADX）
  currentADX: 0,              // 当前ADX值
  currentRegime: 'RANGING',   // 当前市场状态：RANGING/TRENDING/STRONG_TREND
  adxHistory: [],             // ADX历史记录
  lastRegimeAlertAt: 0,       // 上次状态告警时间（防抖）
  warmupTicks: 0,             // P2修复：ADX冷启动保护计数器
};

/**
 * 每小时定时任务回调
 * 在 st_init 中通过 bridge_scheduleAt('HOURLY', 'st_onHourly') 注册
 */
function st_onHourly() {
  logInfo('[定时] 每小时检查点 - 当前仓位: ' + (state.positionNotional || 0).toFixed(2));
  // 可在此添加定时统计、风险报告、策略状态自检等逻辑
}

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

  maxPosition: 800,  // 2026-02-15: 总权益10%（78739×0.1），避免触顶，熔断只告警不撤单

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

  // P1修复：动态priceTick（切交易对前必须正确配置）
  priceTick: 0.0001,         // MYXUSDT的tick size (Bybit官方: 0.0001)，切交易对时必须修改

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

  // 策略倾向: 'positive' | 'negative' | 'neutral'
  // positive: 做多敞口 — 网格双向挂单，Buy成交计入真实仓位，Sell成交仅记账
  // negative: 做空敞口 — 网格双向挂单，Sell成交计入真实仓位，Buy成交仅减空
  // neutral: 无偏好 — 网格双向挂单，所有成交都影响真实仓位
  lean: 'negative',

  // 熔断机制 (P0 修复)
  circuitBreaker: {
    enabled: true,
    maxDrawdown: 0.40,          // P0修复：恢复40%回撤熔断（原99%相当于禁用）
    maxPositionRatio: 0.93,     // 保留备用（仓位熔断已注释）
    maxPriceDrift: 0.50,        // 保留配置（价格偏离已降级为告警）
    cooldownAfterTrip: 600,     // 熔断后冷却 10 分钟
  },

  // P1新增：杠杆硬顶机制
  leverageHardCap: {
    enabled: true,              // 是否启用杠杆硬顶
    maxLeverage: 3.0,           // 最大杠杆倍数（硬顶阈值）
  },

  // P3新增：拦截逻辑绕过开关（仅用于short策略特殊处理，默认全部禁用以保证安全）
  allowBypassLeverageBlock: false,      // 允许在杠杆硬顶时仍下单（仅警告）
  allowBypassPositionBlock: false,      // 允许在仓位限制时仍下单（仅警告）
  disableAutoRecenterBlockade: false,   // 禁用autoRecenter的追涨追跌拦截

  // 应急方向切换 (P0 修复)
  emergencyLean: 'auto',  // auto/long/short/neutral

  // 市场状态检测（ADX趋势强度）
  enableMarketRegime: false,  // 是否启用市场状态检测
  adxPeriod: 14,              // ADX计算周期
  adxTrendingThreshold: 25,   // 强趋势阈值
  adxStrongTrendThreshold: 40, // 极强趋势阈值
  regimeAlertCooldownSec: 300, // 市场状态告警冷却时间（秒）

  // P1新增：订单超时自动撤单（Freqtrade风格）
  orderTimeoutSec: 3600,      // 默认1小时，挂单超时自动撤销

  // P2新增：ROI时间梯度（Freqtrade风格）
  gridTimeDecay: {
    enabled: false,             // 默认关闭，需要显式开启
    stages: [                   // 时间阶段配置
      { afterMinutes: 60, spacingMultiplier: 0.8 },   // 持仓超60分钟：间距缩小到80%
      { afterMinutes: 120, spacingMultiplier: 0.6 },  // 持仓超120分钟：间距缩小到60%
    ],
  },

  simMode: true,
};

// 从 ctx.strategy.params 覆盖参数
if (typeof ctx !== 'undefined' && ctx && ctx.strategy && ctx.strategy.params) {
  const rawParams = ctx.strategy.params;
  const p = (typeof rawParams === 'string') ? JSON.parse(rawParams) : rawParams;
  logInfo('[DEBUG] 参数解析成功: ' + JSON.stringify({symbol: p.symbol, lean: p.lean || p.direction, gridSpacing: p.gridSpacing}));
  // 防御性检查：symbol 必须是有效字符串
  if (p.symbol && typeof p.symbol === 'string' && p.symbol.length > 0) {
    CONFIG.symbol = p.symbol;
  }
  if (p.gridCount) CONFIG.gridCount = p.gridCount;
  if (p.gridSpacing) CONFIG.gridSpacing = p.gridSpacing;
  
  // 【方案2修复】如果传了gridSpacing但没传Up/Down，自动用gridSpacing覆盖
  if (p.gridSpacing !== undefined) {
    if (p.gridSpacingUp === undefined) CONFIG.gridSpacingUp = p.gridSpacing;
    if (p.gridSpacingDown === undefined) CONFIG.gridSpacingDown = p.gridSpacing;
  }
  if (p.gridSpacingUp !== undefined) CONFIG.gridSpacingUp = p.gridSpacingUp;
  if (p.gridSpacingDown !== undefined) CONFIG.gridSpacingDown = p.gridSpacingDown;
  
  if (p.orderSize) CONFIG.orderSize = p.orderSize;
  
  // 【方案2修复】如果传了orderSize但没传Up/Down，自动用orderSize覆盖
  if (p.orderSize !== undefined) {
    if (p.orderSizeUp === undefined) CONFIG.orderSizeUp = p.orderSize;
    if (p.orderSizeDown === undefined) CONFIG.orderSizeDown = p.orderSize;
  }
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

  // P3新增：拦截逻辑绕过开关
  if (p.allowBypassLeverageBlock !== undefined) CONFIG.allowBypassLeverageBlock = p.allowBypassLeverageBlock;
  if (p.allowBypassPositionBlock !== undefined) CONFIG.allowBypassPositionBlock = p.allowBypassPositionBlock;
  if (p.disableAutoRecenterBlockade !== undefined) CONFIG.disableAutoRecenterBlockade = p.disableAutoRecenterBlockade;

  if (p.simMode !== undefined) CONFIG.simMode = p.simMode;
  if (p.enableMarketRegime !== undefined) CONFIG.enableMarketRegime = p.enableMarketRegime;
  // 【修复】支持lean参数，同时保持direction兼容（含值映射）
  const rawLean = p.lean || p.direction;
  var leanMap = { 'long': 'positive', 'short': 'negative', 'neutral': 'neutral', 'positive': 'positive', 'negative': 'negative' };
  var leanValue = rawLean ? (leanMap[rawLean] || rawLean) : null;
  if (leanValue) CONFIG.lean = leanValue;
  // 【方案1修复】如果传入了lean/direction，默认禁用应急切换，防止覆盖
  if (leanValue && !p.emergencyLean) {
    CONFIG.emergencyLean = 'manual';
    logInfo('[DEBUG] 传入lean/direction=' + leanValue + '，禁用应急切换');
  }
  // P0修复：添加emergencyLean参数覆盖
  if (p.emergencyLean) CONFIG.emergencyLean = p.emergencyLean;
  // P2修复：添加initialOffset参数覆盖（持仓差值监控）
  // 如果用户传了initialOffset，使用用户值；否则在st_init中自动计算
  if (p.initialOffset !== undefined) {
    CONFIG.initialOffset = p.initialOffset;
    positionDiffState.initialOffset = p.initialOffset;
  } else {
    // 标记为需要自动计算（在st_init中计算）
    CONFIG.initialOffset = null;
  }
} else {
  logWarn('[DEBUG] ctx或ctx.strategy.params未定义，使用默认CONFIG');
}

// ================================
// 状态
// ================================

// P0修复：锁定CONFIG关键字段（初始化后不可变）
let LOCKED_SYMBOL = '';
let LOCKED_LEAN = '';
let SESSION_ID = '';

// P1修复：多策略共享账户时账本隔离 - 生成唯一stateKey
function getStateKey() {
  // P0修复：使用锁定后的字段，确保不可变
  const strategyId = LOCKED_SYMBOL + ':' + LOCKED_LEAN;
  return 'state:' + strategyId;
}

function getDedupKey() {
  const strategyId = CONFIG.symbol + ':' + CONFIG.lean;
  return 'dedup:' + strategyId;
}

let state = {
  initialized: false,
  referencePrice: 0,
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
  ledgerRebuildDone: false,
  ledgerRebuildLastTick: 0,

  // P1修复：兜底自愈 - 账本不匹配计数器
  ledgerMismatchCount: 0,  // 连续ledger=mismatch心跳数

  // P0修复：应急方向切换并发锁（防止placeOrder执行中切换方向）
  isPlacingOrder: false,   // 正在下单标志，下单期间禁止方向切换

  // P2修复：撤单异步竞争窗口保护
  isCancellingAll: false, // 正在撤单中标志，防止撤单期间新订单
  cancellingStartTick: 0, // 撤单开始时的tick计数

  // P2修复：avgEntryPrice持久化（解决accountingPnl=0根因）
  avgEntryPrice: 0,        // 加权平均入场价格，每次fill时更新，重启后持久化

  // P2修复：WS fill事件计数器（performance-metrics用）
  fillCount: 0,            // 累计成交次数，st_onExecution中递增

  // 2026-02-19: 风险观测指标（策略内 + 账户级）
  riskMetrics: {
    accountingPosition: 0,                 // 策略记账持仓（USDT notional）
    accountingPnl: 0,                      // 策略记账盈亏（若无账本口径则回退0）
    galesLevel: 0,                         // 当前gales层数（基于网格状态估算）
    exchangePosition: 0,                   // 交易所持仓（该symbol）
    accountTotalPositionNotional: null,    // 账户总持仓（占位，待账户聚合接入）
    accountNetEquity: null,                // 账户净值（占位，待账户聚合接入）
    accountLeverageRatio: null,            // 杠杆比=总持仓/净值
    updatedAt: 0,
  },

  // P0修复：ownerStrategy与实例state key强绑定，禁止运行时覆盖
  ownerStrategy: '',                       // 在st_init中初始化并锁定
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
  highWaterMark: 0,  // 最高权益（用于计算回撤）- [P1修复] 实际用peakNetEq
  peakNetEq: 0,      // [P1修复] 历史最高netEq，用于正确计算回撤
  // P1修复：熔断震荡
  recoveryTickCount: 0,  // 连续满足恢复条件的心跳数
  blockedSide: '',       // 熔断中禁止的开仓方向 ('Buy'/'Sell')
  // P0新增：运行时熔断总开关 (默认true)
  active: true,
  // P1新增：杠杆硬顶阻止新订单标志
  blockNewOrders: false,
  leverageHardCapTriggeredAt: 0,  // 杠杆硬顶触发时间
  // [P2] 仓位比率告警防抖时间戳
  lastPosRatioWarnAt: 0,
  // P2修复：补全缺失的告警防抖字段
  lastPositionWarnAt: 0,
  lastPositionWarnRatio: 0,
  lastDrawdownWarn25At: 0,
  lastDrawdownWarn15At: 0,
};

// [硬拦截最小集] A类: API关键失败计数器（认证/签名/系统级）
// 可恢复错误（余额不足/时效过期）不计入此计数器
let apiCriticalFailState = {
  count: 0,           // 5分钟窗口内关键失败次数
  windowStart: 0,     // 当前窗口开始时间
  lastErrors: [],     // 最近3条错误消息（调试用）
};

// API错误分类：关键(critical)或可恢复(recoverable)
// critical: 认证失败/签名错误/系统级 → 计入A类计数器
// recoverable: 余额不足/时效过期 → 仅告警，不计入A类
function classifyApiError(errMsg) {
  const msg = String(errMsg || '').toLowerCase();
  // 可恢复：余额不足(110007)、时效过期(110001)、订单不存在(110001)
  if (msg.includes('ab not enough') || msg.includes('not enough') ||
      msg.includes('too late to cancel') || msg.includes('order not exists') ||
      msg.includes('110007') || msg.includes('110001')) {
    return 'recoverable';
  }
  // 关键：认证/签名/系统级
  if (msg.includes('invalid sign') || msg.includes('api key') || msg.includes('signature') ||
      msg.includes('10001') || msg.includes('10003') || msg.includes('50000') ||
      msg.includes('auth') || msg.includes('forbidden') || msg.includes('401') ||
      msg.includes('403')) {
    return 'critical';
  }
  // 未知错误：默认可恢复（避免误拦）
  return 'unknown';
}

// 记录API关键失败
function recordApiCriticalFail(errMsg) {
  const now = Date.now();
  const critWindow = 300000; // 5分钟
  if (now - apiCriticalFailState.windowStart > critWindow) {
    apiCriticalFailState.count = 0;
    apiCriticalFailState.windowStart = now;
    apiCriticalFailState.lastErrors = [];
  }
  apiCriticalFailState.count++;
  apiCriticalFailState.lastErrors = [errMsg].concat(apiCriticalFailState.lastErrors).slice(0, 3);
  logWarn('[A类计数] API关键失败 #' + apiCriticalFailState.count + '/3: ' + String(errMsg).slice(0, 100));
}

// 加载状态
function loadState() {
  try {
    const saved = bridge_stateGet(getStateKey(), 'null');
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
        // P2优化：初始化gridId索引Map
        if (!state.ordersByGridId) state.ordersByGridId = {};
        // P2优化：初始化活跃订单计数器
        if (typeof state.activeOrdersCount !== 'number') {
          state.activeOrdersCount = state.openOrders.filter(function(o) {
            return o && o.status !== 'Filled' && o.status !== 'Canceled';
          }).length;
        }
        if (!state.runId) state.runId = 0;
        if (!state.orderSeq) state.orderSeq = 0;
        if (!state.exchangePosition) state.exchangePosition = 0;
        if (!state.riskMetrics) {
          state.riskMetrics = {
            accountingPosition: 0,
            accountingPnl: 0,
            galesLevel: 0,
            exchangePosition: 0,
            accountTotalPositionNotional: null,
            accountNetEquity: null,
            accountLeverageRatio: null,
            updatedAt: 0,
          };
        }
        if (obj.ledgerRebuildDone === undefined) state.ledgerRebuildDone = false;
        if (obj.ledgerRebuildLastTick === undefined) state.ledgerRebuildLastTick = 0;
        // P2修复：撤单标志兼容性
        if (state.isCancellingAll === undefined) state.isCancellingAll = false;
        if (state.cancellingStartTick === undefined) state.cancellingStartTick = 0;

        // P2修复：加载完整positionDiffState（7字段持久化）
        if (obj.positionDiffState) {
          positionDiffState.initialOffset = obj.positionDiffState.initialOffset || 0;
          positionDiffState.lastDiff = obj.positionDiffState.lastDiff || 0;
          positionDiffState.diffIncreaseCount = obj.positionDiffState.diffIncreaseCount || 0;
          positionDiffState.lastAlertAt = obj.positionDiffState.lastAlertAt || 0;
          positionDiffState.ledgerGapOverCount = obj.positionDiffState.ledgerGapOverCount || 0;
          positionDiffState.ledgerGapHardblocked = obj.positionDiffState.ledgerGapHardblocked || false;
          positionDiffState.lastHardblockAlertAt = obj.positionDiffState.lastHardblockAlertAt || 0;
          logInfo('[P2] positionDiffState已加载: initialOffset=' + positionDiffState.initialOffset);
        }
        // 兼容旧数据：单独加载initialOffset
        else if (obj.initialOffset !== undefined) {
          positionDiffState.initialOffset = obj.initialOffset;
        }

        // P0新增：熔断状态兼容旧数据
        if (obj.circuitBreakerState) {
          // P0修复: 恢复circuitBreakerState（包括peakNetEq），防止虚假熔断
          Object.assign(circuitBreakerState, obj.circuitBreakerState);
          
          // 兼容旧数据: 如active未定义, 默认为true
          if (circuitBreakerState.active === undefined) {
            circuitBreakerState.active = true;
            logInfo('[熔断] 兼容旧数据: 设置active=true');
          }
          
          // [hotfix] 重启时重置 highWaterMark=0
          // 原因: hwm 是基于历史会计账本累积值(positionNotional)，跨进程持久化后
          // 与真实仓位口径不匹配，导致重启入金时误触发 D 类回撤拦截
          // 修复: 每次重启强制从 0 重建，由当前真实 effectivePosition 重新确定峰值
          circuitBreakerState.highWaterMark = 0;
          circuitBreakerState.tripped = false;          // 重启后解除熔断
          circuitBreakerState.recoveryTickCount = 0;
          // P1修复：重置杠杆硬顶状态（重启后重新评估）
          circuitBreakerState.blockNewOrders = false;
          circuitBreakerState.leverageHardCapTriggeredAt = 0;
          logInfo('[熔断] 已恢复peakNetEq=' + (circuitBreakerState.peakNetEq || 0) + 
                  ', 重置: highWaterMark=0, tripped=false, blockNewOrders=false');
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

  // P2优化：从openOrders重建gridId索引
  state.ordersByGridId = {};
  state.activeOrdersCount = 0;
  if (state.openOrders && state.openOrders.length > 0) {
    for (let i = 0; i < state.openOrders.length; i++) {
      const o = state.openOrders[i];
      if (o && o.gridId && o.status !== 'Filled' && o.status !== 'Canceled') {
        state.ordersByGridId[o.gridId] = o;
        state.activeOrdersCount++;
      }
    }
    logInfo('[P2优化] 重建ordersByGridId索引: ' + Object.keys(state.ordersByGridId).length + ' 条，活跃订单: ' + state.activeOrdersCount);
  }
}

// 保存状态（P2修复：事务性保存，防止部分写入损坏）
function saveState() {
  try {
    // 1. 同步positionDiffState到state，确保7字段完整持久化
    const positionDiffStateSnapshot = {
      initialOffset: positionDiffState.initialOffset || 0,
      lastDiff: positionDiffState.lastDiff || 0,
      diffIncreaseCount: positionDiffState.diffIncreaseCount || 0,
      lastAlertAt: positionDiffState.lastAlertAt || 0,
      ledgerGapOverCount: positionDiffState.ledgerGapOverCount || 0,
      ledgerGapHardblocked: positionDiffState.ledgerGapHardblocked || false,
      lastHardblockAlertAt: positionDiffState.lastHardblockAlertAt || 0,
    };

    // P2修复: 同步marketRegimeState到state，供对比报告使用
    const marketRegimeSnapshot = {
      currentADX: marketRegimeState.currentADX || 0,
      currentRegime: marketRegimeState.currentRegime || 'RANGING',
      warmupTicks: marketRegimeState.warmupTicks || 0,
      adxHistoryLength: marketRegimeState.adxHistory ? marketRegimeState.adxHistory.length : 0,
      priceHistoryLength: marketRegimeState.priceHistory ? marketRegimeState.priceHistory.length : 0,
    };

    // 2. 数据完整性检查：确保关键字段存在且类型正确
    if (typeof state !== 'object' || state === null) {
      logError('[saveState] 完整性检查失败: state不是有效对象');
      return;
    }

    // P2修复：保存前清理已完成的订单，防止内存泄漏
    if (state.openOrders) {
      state.openOrders = state.openOrders.filter(function(o) {
        return o && o.status !== 'Filled' && o.status !== 'Canceled';
      });
    }

    // 3. 构建待保存数据（添加版本号用于未来兼容）
    const stateToSave = {
      ...state,
      positionDiffState: positionDiffStateSnapshot,
      marketRegimeState: marketRegimeSnapshot,
      circuitBreakerState: circuitBreakerState,  // P0修复: 持久化熔断状态
      _saveVersion: 1,           // 版本号，用于未来兼容
      _saveAt: Date.now(),       // 保存时间戳
    };

    // 4. JSON序列化（在try-catch中，失败则不覆盖）
    let serialized;
    try {
      serialized = JSON.stringify(stateToSave);
    } catch (e) {
      logError('[saveState] JSON序列化失败: ' + e.message);
      return;
    }

    // 5. 反序列化验证（确保数据可恢复）
    try {
      JSON.parse(serialized);
    } catch (e) {
      logError('[saveState] 序列化数据验证失败: ' + e.message);
      return;
    }

    // 6. 原子写入：通过bridge_stateSet保存
    bridge_stateSet(getStateKey(), serialized);

  } catch (e) {
    // 任何错误都不应导致state损坏，记录后优雅失败
    logError('[saveState] 事务性保存失败: ' + e.message);
  }
}

// P2新增：指标缓存（Freqtrade风格 populate_indicators 分离）
let cachedIndicators = {
  adx: 0,
  sma20: 0,
  sma50: 0,
  rsi14: 0,
  timestamp: 0,
  klineCount: 0,
};

/**
 * 指标准备函数（Freqtrade风格）
 * 框架层在每次K线更新时调用，计算指标并存入 cachedIndicators
 *
 * @param {string} klinesJson - JSON格式的K线数据数组 [{timestamp, open, high, low, close, volume}, ...]
 */
function st_prepareIndicators(klinesJson) {
  try {
    const klines = (typeof klinesJson === 'string') ? JSON.parse(klinesJson) : klinesJson;

    if (!Array.isArray(klines) || klines.length < 50) {
      logDebug('[st_prepareIndicators] K线数据不足50根，跳过计算');
      return;
    }

    // 提取收盘价序列
    const closes = klines.map(k => Number(k.close) || 0);
    const highs = klines.map(k => Number(k.high) || 0);
    const lows = klines.map(k => Number(k.low) || 0);

    // 计算SMA
    cachedIndicators.sma20 = calculateSMA(closes, 20);
    cachedIndicators.sma50 = calculateSMA(closes, 50);

    // 计算RSI
    cachedIndicators.rsi14 = calculateRSI(closes, 14);

    // 计算ADX（使用K线数据中的high/low/close）
    cachedIndicators.adx = calculateADXFromKlines(klines, 14);

    cachedIndicators.timestamp = Date.now();
    cachedIndicators.klineCount = klines.length;

    logDebug('[st_prepareIndicators] 指标已更新: ADX=' + cachedIndicators.adx.toFixed(2) +
             ' SMA20=' + cachedIndicators.sma20.toFixed(4) +
             ' RSI=' + cachedIndicators.rsi14.toFixed(2));
  } catch (e) {
    logWarn('[st_prepareIndicators] 计算失败: ' + e);
  }
}

/**
 * 计算SMA（简单移动平均）
 */
function calculateSMA(data, period) {
  if (data.length < period) return 0;
  let sum = 0;
  for (let i = data.length - period; i < data.length; i++) {
    sum += data[i];
  }
  return sum / period;
}

/**
 * 计算RSI（相对强弱指数）
 */
function calculateRSI(closes, period) {
  if (closes.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * 从K线数据计算ADX（专用版本）
 */
function calculateADXFromKlines(klines, period) {
  if (klines.length < period * 2) return 0;

  const dmArray = [];
  for (let i = 1; i < klines.length; i++) {
    const current = klines[i];
    const previous = klines[i - 1];

    const upMove = Number(current.high) - Number(previous.high);
    const downMove = Number(previous.low) - Number(current.low);

    const plusDM = (upMove > downMove && upMove > 0) ? upMove : 0;
    const minusDM = (downMove > upMove && downMove > 0) ? downMove : 0;

    const tr = Math.max(
      Number(current.high) - Number(current.low),
      Math.abs(Number(current.high) - Number(previous.close)),
      Math.abs(Number(current.low) - Number(previous.close))
    );

    dmArray.push({ plusDM, minusDM, tr });
  }

  // 平滑计算
  const smoothedData = [];
  for (let i = period - 1; i < dmArray.length; i++) {
    let sumPlusDM = 0, sumMinusDM = 0, sumTR = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sumPlusDM += dmArray[j].plusDM;
      sumMinusDM += dmArray[j].minusDM;
      sumTR += dmArray[j].tr;
    }
    smoothedData.push({ plusDM: sumPlusDM, minusDM: sumMinusDM, tr: sumTR });
  }

  // 计算DI和DX
  const diArray = [];
  for (const data of smoothedData) {
    const plusDI = (data.tr > 0) ? (data.plusDM / data.tr) * 100 : 0;
    const minusDI = (data.tr > 0) ? (data.minusDM / data.tr) * 100 : 0;
    const diSum = plusDI + minusDI;
    const dx = (diSum > 0) ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
    diArray.push(dx);
  }

  // 计算ADX（DX的平均）
  if (diArray.length < period) return 0;
  let adx = 0;
  for (let i = diArray.length - period; i < diArray.length; i++) {
    adx += diArray[i];
  }
  return adx / period;
}

function setCircuitBreakerActive(active) {
  const oldValue = circuitBreakerState.active;
  circuitBreakerState.active = !!active;
  if (oldValue !== circuitBreakerState.active) {
    logInfo('[熔断] 运行时开关变更: ' + oldValue + ' -> ' + circuitBreakerState.active);
    saveState();
  }
  return circuitBreakerState.active;
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

// ================================
// 市场状态检测（ADX）
// ================================

/**
 * 计算ADX（Average Directional Index）
 *
 * @returns {number} ADX值（0-100）
 */
function calculateADX() {
  const history = marketRegimeState.priceHistory;
  const period = CONFIG.adxPeriod;

  // 数据不足，返回0
  if (history.length < period * 2) {
    return 0;
  }

  // 1. 计算+DM和-DM
  const dmArray = [];
  for (let i = 1; i < history.length; i++) {
    const current = history[i];
    const previous = history[i - 1];

    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;

    const plusDM = (upMove > downMove && upMove > 0) ? upMove : 0;
    const minusDM = (downMove > upMove && downMove > 0) ? downMove : 0;

    // 计算True Range
    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );

    dmArray.push({ plusDM, minusDM, tr });
  }

  // 2. 计算平滑的+DM、-DM和TR
  const smoothedData = [];
  for (let i = period - 1; i < dmArray.length; i++) {
    let sumPlusDM = 0;
    let sumMinusDM = 0;
    let sumTR = 0;

    for (let j = i - period + 1; j <= i; j++) {
      sumPlusDM += dmArray[j].plusDM;
      sumMinusDM += dmArray[j].minusDM;
      sumTR += dmArray[j].tr;
    }

    smoothedData.push({
      plusDM: sumPlusDM,
      minusDM: sumMinusDM,
      tr: sumTR,
    });
  }

  // 3. 计算+DI和-DI
  const diArray = [];
  for (const data of smoothedData) {
    const plusDI = (data.tr > 0) ? (data.plusDM / data.tr) * 100 : 0;
    const minusDI = (data.tr > 0) ? (data.minusDM / data.tr) * 100 : 0;

    // 4. 计算DX（Directional Movement Index）
    const diSum = plusDI + minusDI;
    const dx = (diSum > 0) ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;

    diArray.push({ plusDI, minusDI, dx });
  }

  // 5. 计算ADX（DX的平滑平均）
  if (diArray.length < period) {
    return 0;
  }

  let adx = 0;
  for (let i = diArray.length - period; i < diArray.length; i++) {
    adx += diArray[i].dx;
  }

  adx /= period;

  return adx;
}

/**
 * 判断市场状态
 *
 * @param {number} adx - ADX值
 * @returns {string} 市场状态：RANGING/TRENDING/STRONG_TREND
 */
function determineMarketRegime(adx) {
  if (adx >= CONFIG.adxStrongTrendThreshold) {
    return 'STRONG_TREND';
  } else if (adx >= CONFIG.adxTrendingThreshold) {
    return 'TRENDING';
  } else {
    return 'RANGING';
  }
}

/**
 * 更新市场状态
 *
 * @param {object} tick - tick数据，包含 price, high, low 等字段
 */
function updateMarketRegime(tick) {
  if (!CONFIG.enableMarketRegime) {
    return;
  }

  // P2修复：ADX冷启动保护 - 递减warmupTicks
  if (marketRegimeState.warmupTicks > 0) {
    marketRegimeState.warmupTicks--;
    if (marketRegimeState.warmupTicks === 0) {
      logInfo('[ADX_WARMING] 冷启动完成，ADX恢复正常判断');
    }
  }

  // 1. 更新价格历史
  marketRegimeState.priceHistory.push({
    high: tick.high || tick.price * 1.001,  // 如果没有high，用price*1.001估算
    low: tick.low || tick.price * 0.999,    // 如果没有low，用price*0.999估算
    close: tick.price,
  });

  // 限制历史长度（保留period*3的数据足够计算）
  const maxLength = CONFIG.adxPeriod * 3;
  if (marketRegimeState.priceHistory.length > maxLength) {
    marketRegimeState.priceHistory.shift();
  }

  // 2. 计算ADX
  marketRegimeState.currentADX = calculateADX();

  // 3. 更新ADX历史
  marketRegimeState.adxHistory.push(marketRegimeState.currentADX);
  if (marketRegimeState.adxHistory.length > 100) {
    marketRegimeState.adxHistory.shift();
  }

  // 4. 判断市场状态
  const previousRegime = marketRegimeState.currentRegime;
  marketRegimeState.currentRegime = determineMarketRegime(marketRegimeState.currentADX);

  // 5. 触发告警（带防抖）
  const now = Date.now();
  const cooldownMs = CONFIG.regimeAlertCooldownSec * 1000;

  if (now - marketRegimeState.lastRegimeAlertAt >= cooldownMs) {
    // 状态变化告警
    if (marketRegimeState.currentRegime !== previousRegime) {
      logWarn('📊 市场状态变化: ' + previousRegime + ' → ' + marketRegimeState.currentRegime + ' | ADX=' + marketRegimeState.currentADX.toFixed(2));
      marketRegimeState.lastRegimeAlertAt = now;
    }

    // 强趋势警告（ADX>25）
    if (marketRegimeState.currentRegime === 'TRENDING') {
      logWarn('⚡ 强趋势检测，注意风险！ADX=' + marketRegimeState.currentADX.toFixed(2));
      marketRegimeState.lastRegimeAlertAt = now;
    }

    // 极强趋势警告（ADX>40）
    if (marketRegimeState.currentRegime === 'STRONG_TREND') {
      logWarn('⚠️ 极强趋势检测，建议暂停网格下单！ADX=' + marketRegimeState.currentADX.toFixed(2));
      marketRegimeState.lastRegimeAlertAt = now;
    }
  }
}

/**
 * 检查是否应该暂停网格下单
 *
 * @returns {boolean} true=应该暂停，false=可以继续
 */
function shouldSuspendGridTrading() {
  // P1新增：杠杆硬顶阻止新订单
  if (circuitBreakerState.blockNewOrders) {
    return true;
  }

  if (!CONFIG.enableMarketRegime) {
    return false;
  }

  // P2修复：ADX冷启动保护 - warmup期间强制返回false（不暂停）
  if (marketRegimeState.warmupTicks > 0) {
    return false;
  }

  return marketRegimeState.currentRegime === 'STRONG_TREND';
}

/**
 * 获取当前市场状态描述
 *
 * @returns {string} 市场状态描述
 */
function getMarketRegimeDesc() {
  if (!CONFIG.enableMarketRegime) {
    return '未启用';
  }

  // P2修复：ADX冷启动保护 - warmup期间显示 warming 状态
  if (marketRegimeState.warmupTicks > 0) {
    return '[ADX_WARMING] ' + marketRegimeState.warmupTicks + 'ticks (ADX=' + marketRegimeState.currentADX.toFixed(2) + ')';
  }

  return marketRegimeState.currentRegime + ' (ADX=' + marketRegimeState.currentADX.toFixed(2) + ')';
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
  // P2修复：设置撤单中标志和起始tick，防止异步窗口期间新订单
  state.isCancellingAll = true;
  state.cancellingStartTick = state.tickCount || 0;
  
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
  // 注意：isCancellingAll在st_heartbeat中根据tick计数自动清除
}

// ================================
// P0 修复：熔断检查
// ================================

/**
 * 熔断检查 - 多层防护体系
 *
 * 设计思路：
 * 1. 回撤熔断是最后防线，一旦触发立即停止所有交易
 * 2. 仓位熔断采用"软限制"，仅阻止新开仓，不撤现有单
 * 3. 价格偏离已降级为告警（不拦截），避免误杀正常波动
 * 4. 账本差值硬拦截用于检测策略与交易所状态不一致
 *
 * 恢复机制：
 * - 回撤熔断：需冷却期+连续3个心跳满足恢复条件
 * - 仓位限制：仓位降回阈值以下立即恢复
 *
 * @returns {boolean} true=熔断中（应停止交易），false=正常交易
 */
function checkCircuitBreaker() {
  // P0新增: 运行时总开关检查 - 允许紧急情况下完全禁用熔断检查
  if (!circuitBreakerState.active) {
    logDebug('[熔断检查] 熔断检查已暂停(active=false)');
    return false;
  }

  if (!CONFIG.circuitBreaker || !CONFIG.circuitBreaker.enabled) return false;

  const now = Date.now();
  const cb = CONFIG.circuitBreaker;

  // ===== 冷却期恢复逻辑 =====
  // 为什么需要冷却期：防止熔断后立即恢复又立即触发（震荡）
  // 为什么用effectivePosition：取策略内部和交易所的较大值，防止单方数据异常导致误判
  if (circuitBreakerState.tripped) {
    const elapsed = (now - circuitBreakerState.tripAt) / 1000;
    if (elapsed < cb.cooldownAfterTrip) {
      return true;  // 仍在冷却期，禁止交易
    }

    // P0修复：熔断震荡 - 使用effectivePosition判断恢复条件
    // 为什么用positionRatio < maxPositionRatio：确保仓位确实回落到安全水平
    const effectivePos = Math.max(
      Math.abs(state.positionNotional || 0),
      Math.abs(state.exchangePosition || 0)
    );
    const positionRatio = effectivePos / CONFIG.maxPosition;
    if (positionRatio < cb.maxPositionRatio) {
      // 为什么需要连续3个心跳：防止在阈值附近震荡（触发-恢复-触发循环）
      circuitBreakerState.recoveryTickCount = (circuitBreakerState.recoveryTickCount || 0) + 1;
      if (circuitBreakerState.recoveryTickCount >= 3) {
        // 连续3个心跳满足条件，重置熔断
        circuitBreakerState.tripped = false;
        circuitBreakerState.reason = '';
        circuitBreakerState.recoveryTickCount = 0;
        circuitBreakerState.blockedSide = '';
        // P1修复：恢复时重置highWaterMark为当前仓位
        // 为什么：避免用历史峰值计算新回撤，导致立即再次触发
        circuitBreakerState.highWaterMark = effectivePos;
        // [P1修复] 恢复时重置peakNetEq为当前netEq
        circuitBreakerState.peakNetEq = currentNetEq || circuitBreakerState.peakNetEq;
        logInfo('[熔断恢复] 仓位回落，恢复交易' +
                ' | positionRatio=' + (positionRatio * 100).toFixed(2) + '%' +
                ' | effectivePos=' + effectivePos.toFixed(2) +
                ' | positionNotional=' + (state.positionNotional || 0).toFixed(2) +
                ' | exchangePosition=' + (state.exchangePosition || 0).toFixed(2) +
                ' | highWaterMark=' + circuitBreakerState.highWaterMark.toFixed(2));
        return false;
      }
    } else {
      // 不满足条件，重置计数 - 为什么：确保连续满足条件，非累积
      circuitBreakerState.recoveryTickCount = 0;
    }

    return true;  // 冷却期结束但仓位未回落，继续熔断
  }

  // ===== 回撤熔断检查 =====
  // [P1修复] 改为基于netEq计算回撤，而不是仓位规模
  // 原因：原逻辑用effectivePosition，导致盈利平仓（仓位下降）误触发熔断
  const effectivePosition = Math.max(
    Math.abs(state.positionNotional || 0),
    Math.abs(state.exchangePosition || 0)
  );
  const currentNetEq = state.riskMetrics?.accountNetEquity || state.riskMetrics?.netEq || 0;

  // 冷启动：初始化peakNetEq
  if (circuitBreakerState.peakNetEq === 0 && currentNetEq > 0) {
    circuitBreakerState.peakNetEq = currentNetEq;
    logInfo('[熔断初始化] peakNetEq=' + circuitBreakerState.peakNetEq.toFixed(2));
  }

  // 更新历史最高净值
  if (currentNetEq > circuitBreakerState.peakNetEq) {
    circuitBreakerState.peakNetEq = currentNetEq;
  }

  // peakNetEq > 0 时才计算回撤
  if (circuitBreakerState.peakNetEq > 0) {
    const drawdown = (circuitBreakerState.peakNetEq - currentNetEq) / circuitBreakerState.peakNetEq;
    const ddPct = (drawdown * 100).toFixed(2);
    const ddBase = ' drawdown=' + ddPct + '% | peak=' + circuitBreakerState.peakNetEq.toFixed(2) + ' | netEq=' + currentNetEq.toFixed(2);

    // [硬拦截最小集] D类:账户生存 - 40%最后防线
    // 为什么是40%：基于历史回测，策略在40%回撤后恢复概率极低，保护剩余本金
    if (drawdown > cb.maxDrawdown) {
      circuitBreakerState.tripped = true;
      circuitBreakerState.reason = '回撤熔断';
      circuitBreakerState.tripAt = now;
      logWarn('[熔断触发-回撤]' + ddBase);
      cancelAllOrders();
      try { bridge_tgSend('9号', '[告急][D类硬拦截] 回撤' + ddPct + '%超40%最后防线，已停止开仓 (runId=' + state.runId + ')'); } catch(e){}
      try { bridge_tgSend('1号', '[告急][D类硬拦截] 回撤' + ddPct + '%超40%最后防线 (runId=' + state.runId + ')'); } catch(e){}
      return true;
    }

    // 为什么有25%/15%两级预警：给操作者足够时间干预，避免直接触发硬拦截
    if (drawdown > 0.25) {
      const lastWarn25 = circuitBreakerState.lastDrawdownWarn25At || 0;
      if (now - lastWarn25 > 300000) {  // 5分钟防抖 - 为什么：避免刷屏
        circuitBreakerState.lastDrawdownWarn25At = now;
        logWarn('[告警-回撤25%]' + ddBase + ' (不拦截，继续运行)');
        try { bridge_tgSend('9号', '[告警][回撤>25%] ' + ddPct + '%，注意监控 (runId=' + state.runId + ')'); } catch(e){}
        try { bridge_tgSend('1号', '[告警][回撤>25%] ' + ddPct + '%，注意监控 (runId=' + state.runId + ')'); } catch(e){}
      }
    } else if (drawdown > 0.15) {  // 15%初级告警
      const lastWarn15 = circuitBreakerState.lastDrawdownWarn15At || 0;
      if (now - lastWarn15 > 600000) {  // 10分钟防抖
        circuitBreakerState.lastDrawdownWarn15At = now;
        logWarn('[告警-回撤15%]' + ddBase + ' (不拦截，继续运行)');
        try { bridge_tgSend('9号', '[告警][回撤>15%] ' + ddPct + '%，留意回撤 (runId=' + state.runId + ')'); } catch(e){}
      }
    }
  }

  // 2. 仓位熔断（方案B：恢复但改为限制开仓）
  const positionRatio = effectivePosition / CONFIG.maxPosition;
  if (positionRatio > cb.maxPositionRatio) {
    // P2修复：熔断告警节流（>=60s或ratio变化>=0.2%才打一次）
    const lastWarn = circuitBreakerState.lastPositionWarnAt || 0;
    const lastRatio = circuitBreakerState.lastPositionWarnRatio || 0;
    const timeElapsed = now - lastWarn;
    const ratioDiff = Math.abs(positionRatio - lastRatio);

    if (timeElapsed >= 60000 || ratioDiff >= 0.002) {
      circuitBreakerState.lastPositionWarnAt = now;
      circuitBreakerState.lastPositionWarnRatio = positionRatio;
      // P1-debug: 打印详细仓位熔断信息
      logWarn('[仓位限制触发] positionRatio=' + (positionRatio * 100).toFixed(2) + '%' +
              ' | effectivePosition=' + effectivePosition.toFixed(2) +
              ' | positionNotional=' + (state.positionNotional || 0).toFixed(2) +
              ' | exchangePosition=' + (state.exchangePosition || 0).toFixed(2) +
              ' | maxPosition=' + CONFIG.maxPosition +
              ' | 限制新开仓，不停止策略');
    }

    // 方案B：设置blockNewOrders标志，限制新开仓但不完全停止策略
    circuitBreakerState.blockNewOrders = true;
  } else {
    // 仓位恢复正常，清除blockNewOrders标志
    if (circuitBreakerState.blockNewOrders) {
      logInfo('[仓位限制解除] positionRatio=' + (positionRatio * 100).toFixed(2) + '%，恢复开仓');
      circuitBreakerState.blockNewOrders = false;
    }
  }

  // [P2] 仓位比率告警：galesLevel接近满仓时推送
  const posRatio = effectivePosition / CONFIG.maxPosition;
  if (posRatio > 0.85) {
    const lastPosWarn = circuitBreakerState.lastPosRatioWarnAt || 0;
    if (now - lastPosWarn > 300000) {  // 5分钟防抖
      circuitBreakerState.lastPosRatioWarnAt = now;
      logWarn('[告警-仓位接近满仓] posRatio=' + (posRatio * 100).toFixed(1) + '% (>85%)');
      try { bridge_tgSend('9号', '[告警][仓位接近满仓] posRatio=' + (posRatio * 100).toFixed(1) + '%，galesLevel=' + state.riskMetrics?.galesLevel + ' (runId=' + state.runId + ')'); } catch(e){}
      try { bridge_tgSend('1号', '[告警][仓位接近满仓] posRatio=' + (posRatio * 100).toFixed(1) + '% (runId=' + state.runId + ')'); } catch(e){}
    }
  }

  // 3. 价格偏离 — [硬拦截最小集] 降级为告警（不拦截）
  // 原：drift>50%硬拦截；现：仅告警，允许策略继续运行
  if (state.referencePrice > 0) {
    const drift = Math.abs(state.lastPrice - state.referencePrice) / state.referencePrice;
    const driftPct = (drift * 100).toFixed(2);
    if (drift > 0.30) {  // 30%预警（原50%硬拦截 → 30%告警，不拦）
      const lastDriftWarn = circuitBreakerState.lastDriftWarnAt || 0;
      if (now - lastDriftWarn > 600000) {  // 10分钟防抖
        circuitBreakerState.lastDriftWarnAt = now;
        logWarn('[告警-价格偏离' + driftPct + '%] reference=' + state.referencePrice.toFixed(4) + ' last=' + state.lastPrice.toFixed(4) + ' (不拦截，继续运行)');
        try { bridge_tgSend('9号', '[告警][价格偏离>' + (drift>0.50?'50':'30') + '%] drift=' + driftPct + '% (runId=' + state.runId + ')'); } catch(e){}
      }
    }
  }

  // [硬拦截最小集] B类: 账本↔交易所持仓差值 > 2000U 持续3心跳 → 状态不可置信硬拦截
  // 注意: positionNotional 是会计账本累积值（历史净头寸），不是当前持仓敞口
  // 只有当交易所也显示 >100U 仓位时，才有意义比较（防止会计账本 vs 0 的误触发）
  const ledgerPos = Math.abs(state.positionNotional || 0);
  const exchangePos = Math.abs(state.exchangePosition || 0);
  const adjustedExch = exchangePos - Math.abs(positionDiffState.initialOffset || 0);
  const ledgerGap = Math.abs(adjustedExch - ledgerPos);

  // exchangePos > 100: 交易所确认有实际持仓时才触发（避免 accountingLedger vs 0 的误触发）
  if (exchangePos > 100 && ledgerPos > 1 && ledgerGap > 2000) {  // B类双侧非零才检查
    positionDiffState.ledgerGapOverCount = (positionDiffState.ledgerGapOverCount || 0) + 1;
    if (positionDiffState.ledgerGapOverCount >= 3) {
      // 3个心跳持续超限 → 硬拦截
      if (!positionDiffState.ledgerGapHardblocked) {
        positionDiffState.ledgerGapHardblocked = true;
        logWarn('[硬拦截-B类] 账本差值=' + ledgerGap.toFixed(0) + 'U > 2000U，持续3心跳，停止下单');
        try { bridge_tgSend('9号', '[告急][B类硬拦截] 账本差值' + ledgerGap.toFixed(0) + 'U超限，状态不可置信，停止下单 (runId=' + state.runId + ')'); } catch(e){}
        try { bridge_tgSend('1号', '[告急][B类硬拦截] 账本差值' + ledgerGap.toFixed(0) + 'U超限 (runId=' + state.runId + ')'); } catch(e){}
      }
      return true;
    }
  } else {
    // P0修复：B类硬拦截reset逻辑 - 只有当差值明显回落(<1000U)时才重置计数器
    // 防止在2000U阈值附近波动导致无法触发硬拦截
    if (ledgerGap < 1000) {
      if (positionDiffState.ledgerGapOverCount > 0) {
        logInfo('[B类恢复] 账本差值明显回落至' + ledgerGap.toFixed(0) + 'U < 1000U，重置计数器');
        positionDiffState.ledgerGapOverCount = 0;
      }
      if (positionDiffState.ledgerGapHardblocked) {
        logInfo('[B类恢复] 账本差值回落至' + ledgerGap.toFixed(0) + 'U，解除硬拦截');
        positionDiffState.ledgerGapHardblocked = false;
      }
    } else {
      // 差值在1000-2000U之间，不重置计数器但也不增加
      logDebug('[B类] 账本差值=' + ledgerGap.toFixed(0) + 'U，保持计数器=' + positionDiffState.ledgerGapOverCount);
    }
  }

  // 4. A类: API关键失败计数器检查
  const critWindow = 300000; // 5分钟窗口
  if (apiCriticalFailState.count >= 3) {
    const elapsed = now - apiCriticalFailState.windowStart;
    if (elapsed < critWindow) {
      logWarn('[硬拦截-A类] API关键失败' + apiCriticalFailState.count + '次/' + (elapsed/1000).toFixed(0) + 's，停止下单');
      try { bridge_tgSend('9号', '[告急][A类硬拦截] API关键失败' + apiCriticalFailState.count + '次，停止下单，需人工干预 (runId=' + state.runId + ')'); } catch(e){}
      try { bridge_tgSend('1号', '[告急][A类硬拦截] API关键失败' + apiCriticalFailState.count + '次 (runId=' + state.runId + ')'); } catch(e){}
      return true;
    } else {
      // 窗口过期，重置
      apiCriticalFailState.count = 0;
      apiCriticalFailState.windowStart = now;
    }
  }

  return false;
}

// ================================
// P1新增：杠杆硬顶机制
// ================================

/**
 * 检查杠杆硬顶 - 防止过度杠杆导致爆仓风险
 *
 * 设计思路：
 * 1. 硬顶与熔断不同：硬顶只阻止新订单，不取消现有订单
 * 2. 为什么用accountLeverageRatio：直接反映账户整体杠杆水平，比仓位更直观
 * 3. 恢复阈值用0.9系数：避免在阈值附近震荡（触发-恢复-触发循环）
 *
 * 与熔断的区别：
 * - 熔断：回撤触发，停止所有交易，取消所有订单
 * - 硬顶：杠杆触发，只阻止新订单，保留现有持仓和订单
 *
 * @returns {boolean} true=已触发硬顶（阻止新订单），false=未触发
 */
function checkLeverageHardCap() {
  const lhc = CONFIG.leverageHardCap;

  // 未启用时跳过 - 为什么保留开关：某些策略可能不需要杠杆限制
  if (!lhc || !lhc.enabled) {
    return false;
  }

  const now = Date.now();
  const maxLev = lhc.maxLeverage || 3.0;
  const currentLev = state.riskMetrics?.accountLeverageRatio;

  // 杠杆数据无效时跳过 - 为什么：exchange可能未返回杠杆数据，不能误拦
  if (currentLev === null || currentLev === undefined || !isFinite(currentLev)) {
    return false;
  }

  // ===== 硬顶触发检查 =====
  // 为什么用>=而非>：等于阈值时也应触发，确保不超限
  if (currentLev >= maxLev) {
    // 首次触发时告警 - 为什么检查blockNewOrders：避免重复告警刷屏
    if (!circuitBreakerState.blockNewOrders) {
      circuitBreakerState.blockNewOrders = true;
      circuitBreakerState.leverageHardCapTriggeredAt = now;
      logWarn('[杠杆硬顶触发] 当前杠杆=' + currentLev.toFixed(2) + 'x >= 阈值=' + maxLev.toFixed(2) + 'x，阻止新订单');
      try { bridge_tgSend('9号', '[P1告警][杠杆硬顶] 杠杆=' + currentLev.toFixed(2) + 'x 超阈值=' + maxLev.toFixed(2) + 'x，已阻止新订单 (runId=' + state.runId + ')'); } catch(e){}
      try { bridge_tgSend('1号', '[P1告警][杠杆硬顶] 杠杆=' + currentLev.toFixed(2) + 'x 超阈值 (runId=' + state.runId + ')'); } catch(e){}
    }
    return true;
  }

  // ===== 硬顶恢复检查 =====
  // 为什么检查leverageHardCapTriggeredAt > 0：确保是硬顶触发的block，而非其他原因
  if (circuitBreakerState.blockNewOrders && circuitBreakerState.leverageHardCapTriggeredAt > 0) {
    // 降回阈值以下自动恢复（使用0.9系数避免在阈值附近震荡）
    // 为什么用0.9：如果阈值3.0，恢复阈值2.7，需要降0.3才恢复，避免震荡
    const recoveryThreshold = maxLev * 0.9;
    if (currentLev < recoveryThreshold) {
      circuitBreakerState.blockNewOrders = false;
      circuitBreakerState.leverageHardCapTriggeredAt = 0;
      logInfo('[杠杆硬顶恢复] 当前杠杆=' + currentLev.toFixed(2) + 'x < 恢复阈值=' + recoveryThreshold.toFixed(2) + 'x，恢复新订单');
      try { bridge_tgSend('9号', '[P1恢复][杠杆硬顶] 杠杆=' + currentLev.toFixed(2) + 'x 恢复正常，恢复新订单 (runId=' + state.runId + ')'); } catch(e){}
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
      // P0修复：添加lean标识（区分neutral/negative实例）
      const leanLabel = CONFIG.lean || 'neutral';
      try {
        if (typeof bridge_tgSend === 'function') {
          bridge_tgSend('9号', '[告急][' + leanLabel + '] 持仓差值熔断! diff=' + currentDiff.toFixed(0) + ' USDT (runId=' + state.runId + ')');
          bridge_tgSend('4号', '[告急][' + leanLabel + '] 持仓差值熔断! 请检查策略代码和quant-lab模块 (runId=' + state.runId + ')');
          bridge_tgSend('1号', '[告急][' + leanLabel + '] 持仓差值熔断! diff=' + currentDiff.toFixed(0) + ' USDT (runId=' + state.runId + ')');
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
      // P0修复：添加lean标识（区分neutral/negative实例）
      const leanLabel = CONFIG.lean || 'neutral';
      try {
        if (typeof bridge_tgSend === 'function') {
          bridge_tgSend('9号', '[告警][' + leanLabel + '] 持仓差值过大: ' + currentDiff.toFixed(0) + ' USDT (runId=' + state.runId + ')');
          bridge_tgSend('1号', '[告警][' + leanLabel + '] 持仓差值过大: ' + currentDiff.toFixed(0) + ' USDT (runId=' + state.runId + ')');
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
  if (CONFIG.emergencyLean !== 'auto') return;

  // P0修复：并发保护 - 下单期间禁止方向切换
  if (state.isPlacingOrder) {
    logDebug('[应急切换] 下单进行中，跳过方向切换检查');
    return;
  }

  // 买满仓 → 强制切换到 positive（做多敞口）
  if (state.positionNotional >= CONFIG.maxPosition * 0.9) {
    if (CONFIG.lean !== 'positive') {
      logWarn('[应急切换] 买满仓 → positive 模式');
      CONFIG.lean = 'positive';
      saveState();
    }
  }

  // 卖满仓 → 强制切换到 negative（做空敞口）
  if (state.positionNotional <= -CONFIG.maxPosition * 0.9) {
    if (CONFIG.lean !== 'negative') {
      logWarn('[应急切换] 卖满仓 → negative 模式');
      CONFIG.lean = 'negative';
      saveState();
    }
  }

  // 仓位回到安全区 → 恢复 neutral
  if (Math.abs(state.positionNotional) < CONFIG.maxPosition * 0.5) {
    if (CONFIG.lean !== 'neutral' && CONFIG.emergencyLean === 'auto') {
      logInfo('[应急切换] 仓位安全 → neutral 模式');
      CONFIG.lean = 'neutral';
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

  // P2优化：先找到order获取gridId，再从索引中移除
  const order = getOpenOrder(orderId);
  if (order && order.gridId && state.ordersByGridId) {
    delete state.ordersByGridId[order.gridId];
  }

  // P2优化：同步更新活跃订单计数器（只有活跃订单才减）
  if (order && order.status !== 'Filled' && order.status !== 'Canceled') {
    if (typeof state.activeOrdersCount === 'number' && state.activeOrdersCount > 0) {
      state.activeOrdersCount--;
    }
  }

  state.openOrders = state.openOrders.filter(function(o) { return o.orderId !== orderId; });
}

/**
 * 获取活跃订单数（P2优化：O(1)计数器）
 *
 * 优化思路：
 * - 原实现：O(n)每次遍历计算
 * - 新实现：O(1)直接返回缓存计数器
 * - 维护：增删订单时同步更新state.activeOrdersCount
 *
 * @returns {number} 活跃订单数
 */
function countActiveOrders() {
  // P2优化：使用缓存计数器，避免每次遍历
  if (typeof state.activeOrdersCount === 'number') {
    return state.activeOrdersCount;
  }

  // 兼容：计数器未初始化时降级为遍历计算
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
  // P2优化：优先读取tick缓存（避免重复计算）
  if (!state.tickCache) state.tickCache = {};
  if (!state.tickCache.pendingNotional) state.tickCache.pendingNotional = {};

  // 如果缓存存在，直接返回
  if (state.tickCache.pendingNotional[side] !== undefined) {
    return state.tickCache.pendingNotional[side];
  }

  // 缓存不存在，计算并缓存
  if (!state.openOrders) {
    state.tickCache.pendingNotional[side] = 0;
    return 0;
  }

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

  // 缓存计算结果
  state.tickCache.pendingNotional[side] = sum;
  return sum;
}

/**
 * 通过gridId查找活跃订单（P2优化：O(1)索引查找）
 *
 * 优化思路：
 * - 原实现：O(n)线性遍历
 * - 新实现：O(1) Map索引查找
 * - 维护：openOrders增删时同步更新state.ordersByGridId
 *
 * @param {string} gridId - 网格ID
 * @returns {Object|null} 订单对象或null
 */
function findActiveOrderByGridId(gridId) {
  if (!gridId) return null;

  // P2优化：使用索引Map O(1)查找
  const order = state.ordersByGridId?.[gridId];
  if (order && order.status !== 'Filled' && order.status !== 'Canceled') {
    return order;
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
// P2优化：O(n+m) Set索引替代O(n×m)双重遍历
function reconcileGridOrderLinks() {
  if (!state.gridLevels || state.gridLevels.length === 0) return;

  // ===== 阶段1: 预建索引 O(n+m) =====
  // QuickJS用Object模拟Set（hasOwnProperty O(1)）
  const activeOrderGridIds = {};  // gridId -> true
  const gridById = {};            // gridId -> grid

  // O(n): 收集活跃订单的gridId
  for (let i = 0; i < state.openOrders.length; i++) {
    const o = state.openOrders[i];
    if (o && o.gridId && o.status !== 'Filled' && o.status !== 'Canceled') {
      activeOrderGridIds[o.gridId] = true;
    }
  }

  // O(m): 构建grid索引
  for (let i = 0; i < state.gridLevels.length; i++) {
    const g = state.gridLevels[i];
    if (g && g.id) {
      gridById[g.id] = g;
    }
  }

  // ===== 阶段2: 纠正IDLE grid为ACTIVE O(n) =====
  // openOrders有但grid非ACTIVE -> 纠正为ACTIVE
  for (let i = 0; i < state.openOrders.length; i++) {
    const o = state.openOrders[i];
    if (!o || !o.gridId) continue;
    if (o.status === 'Filled' || o.status === 'Canceled') continue;

    const g = gridById[o.gridId];  // O(1)
    if (!g) continue;
    if (g.state !== 'ACTIVE' || g.orderId !== o.orderId) {
      syncGridFromOrder(g, o);
    }
  }

  // ===== 阶段3: 回收孤立grid为IDLE O(m) =====
  // grid是ACTIVE但openOrders找不到 -> 回收为IDLE
  for (let i = 0; i < state.gridLevels.length; i++) {
    const g = state.gridLevels[i];
    if (!g || g.state !== 'ACTIVE') continue;

    // O(1) Object查找替代O(n)遍历
    if (!activeOrderGridIds[g.id]) {
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
  const oldReference = state.referencePrice;

  // 1. 更新仓位（根据策略倾向）
  if (CONFIG.lean === 'positive') {
    if (side === 'Buy') {
      state.positionNotional += notional;
    } else {
      logDebug('[虚仓] positive 模式下 Sell 成交仅记账: -' + notional.toFixed(2));
    }
  } else if (CONFIG.lean === 'negative') {
    if (side === 'Sell') {
      state.positionNotional -= notional;
    } else {
      state.positionNotional += notional;
      logDebug('[减空] negative 模式下 Buy 成交减空仓: +' + notional.toFixed(2));
    }
  } else {
    // neutral 模式
    if (side === 'Buy') {
      state.positionNotional += notional;
    } else {
      state.positionNotional -= notional;
    }
  }

  // 2. 【核心修复】每次成交都更新基准价格并重新计算网格
  // Buy成交 @ price → referencePrice = price → 重新计算所有 Sell 网格线
  // Sell成交 @ price → referencePrice = price → 重新计算所有 Buy 网格线
  state.referencePrice = fillPrice;
  recalculateGridPrices(oldReference);
  logInfo('[网格重算] 成交后基准更新: ' + oldReference.toFixed(4) + ' -> ' + state.referencePrice.toFixed(4) +
          ' (' + side + ' @ ' + fillPrice.toFixed(4) + ')');
}

// P0新增：重新计算网格价格（保持网格ID和状态不变）
function recalculateGridPrices(oldCenter) {
  if (!state.gridLevels || state.gridLevels.length === 0) return;

  const newReference = state.referencePrice;
  const spacingDown = CONFIG.gridSpacingDown !== null ? CONFIG.gridSpacingDown : CONFIG.gridSpacing;
  const spacingUp = CONFIG.gridSpacingUp !== null ? CONFIG.gridSpacingUp : CONFIG.gridSpacing;

  // 重新计算每个网格的价格
  for (let i = 0; i < state.gridLevels.length; i++) {
    const grid = state.gridLevels[i];
    if (grid.side === 'Buy') {
      // 根据旧center和旧price计算tier（从center往下数第几个）
      // oldPrice = oldCenter * (1 - spacingDown * tier)
      // => tier = (oldCenter - oldPrice) / oldCenter / spacingDown
      const tier = Math.round((oldCenter - grid.price) / oldCenter / spacingDown);
      if (tier > 0) {
        grid.price = newCenter * (1 - spacingDown * tier);
      }
    } else {
      // Sell网格
      // oldPrice = oldCenter * (1 + spacingUp * tier)
      // => tier = (oldPrice - oldCenter) / oldCenter / spacingUp
      const tier = Math.round((grid.price - oldCenter) / oldCenter / spacingUp);
      if (tier > 0) {
        grid.price = newCenter * (1 + spacingUp * tier);
      }
    }
  }

  logInfo('[网格重算] 已更新 ' + state.gridLevels.length + ' 个档位价格，新基准: ' + newCenter.toFixed(4));
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

  // P2优化：订单完成时清理索引并更新计数器
  if ((order.status === 'Filled' || order.status === 'Canceled') && local.gridId && state.ordersByGridId) {
    delete state.ordersByGridId[local.gridId];
    // P2优化：活跃订单计数器减1
    if (typeof state.activeOrdersCount === 'number' && state.activeOrdersCount > 0) {
      state.activeOrdersCount--;
    }
    // P2修复：从openOrders数组中删除已完成订单，防止内存泄漏
    removeOpenOrder(order.orderId);
  }

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

  // 真实下单：市价单对冲（带滑点保护）
  try {
    // 防御性检查：symbol 必须有效
    if (!CONFIG.symbol || typeof CONFIG.symbol !== 'string' || CONFIG.symbol.length === 0) {
      logError('[hedgeResidual] CONFIG.symbol 无效: ' + CONFIG.symbol);
      throw new Error('Invalid symbol: ' + CONFIG.symbol);
    }

    // P1修复：滑点保护 - 检查bid-ask spread
    const bestBidAsk = bridge_getBestBidAsk(CONFIG.symbol);
    const bidAskObj = JSON.parse(bestBidAsk);
    if (bidAskObj.spread && bidAskObj.bid > 0) {
      const spreadPct = bidAskObj.spread / bidAskObj.bid;
      if (spreadPct > CONFIG.maxHedgeSlippagePct) {
        logWarn('[hedgeResidual] 滑点过大，放弃对冲: spread=' + (spreadPct * 100).toFixed(2) +
                '% > max=' + (CONFIG.maxHedgeSlippagePct * 100).toFixed(2) + '%');
        return;
      }
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
    if (CONFIG.lean === 'positive') {
      if (side === 'Buy') {
        state.positionNotional += notional;
      }
      // Sell在long模式下是虚仓，不更新
    } else if (CONFIG.lean === 'negative') {
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

    // P2修复：递增fillCount（performance-metrics用）
    state.fillCount = (state.fillCount || 0) + 1;

    // [P2] WS fill路径：用execution事件实时更新avgEntryPrice
    try {
      const posData = bridge_getPosition(CONFIG.symbol);
      if (posData) {
        const pos = JSON.parse(posData);
        const exchangeEntryPrice = parseFloat(pos.entryPrice || 0);
        const exchangePosQty = parseFloat(pos.quantity || 0);

        // 判断方向是否变化
        const currentSign = Math.sign(state.positionNotional);
        const exchangeSign = Math.sign(exchangePosQty);

        // 仅当方向未变且exchange有有效entryPrice时更新
        if (currentSign !== 0 && exchangeSign !== 0 && currentSign === exchangeSign && exchangeEntryPrice > 0) {
          const oldAvg = state.avgEntryPrice || 0;
          state.avgEntryPrice = exchangeEntryPrice;
          logInfo('[fill更新] avgEntry: ' + oldAvg.toFixed(4) + '→' + state.avgEntryPrice.toFixed(4) +
                  ' execId=' + exec.execId + ' (from exchange)');
        } else {
          logDebug('[fill更新] 跳过: 方向变化或无效entryPrice. currentSign=' + currentSign +
                   ' exchangeSign=' + exchangeSign + ' entryPrice=' + exchangeEntryPrice);
        }
      }
    } catch (e) {
      logWarn('[fill更新] 获取position失败: ' + e);
    }

    // simMode: 记录模拟成交
    if (CONFIG.simMode && typeof bridge_recordSimTrade === 'function') {
      try {
        bridge_recordSimTrade(execPrice, execQty, side, CONFIG.symbol);
        logDebug('[st_onExecution] bridge_recordSimTrade called: price=' + execPrice + ' qty=' + execQty + ' side=' + side + ' symbol=' + CONFIG.symbol);
      } catch (e) {
        logWarn('[st_onExecution] bridge_recordSimTrade failed: ' + e);
      }
    }

    saveState();
  } catch (e) {
    logWarn('st_onExecution failed: ' + e);
  }
}

/**
 * 估算当前 gales 层数（策略内调参指标）
 * 口径：非 IDLE 网格数量；若无则返回0。
 */
function getCurrentGalesLevel() {
  if (!state.gridLevels || state.gridLevels.length === 0) return 0;
  let active = 0;
  for (let i = 0; i < state.gridLevels.length; i++) {
    if (state.gridLevels[i] && state.gridLevels[i].state && state.gridLevels[i].state !== 'IDLE') active++;
  }
  return active;
}

function fmtRisk(v, digits) {
  if (v === null || v === undefined) return 'NA';
  if (typeof v !== 'number' || !isFinite(v)) return 'NA';
  return v.toFixed(digits || 2);
}

/**
 * 更新风险观测指标（策略内 + 账户级）
 * 说明：positionRatio(策略口径)已停用为主风控，仅保留历史代码；
 * 当前优先输出可解释指标，后续接入账户聚合口径再升级熔断。
 */
function updateRiskMetrics(tick) {
  if (!state.riskMetrics) state.riskMetrics = {};

  // 策略内指标
  state.riskMetrics.accountingPosition = state.positionNotional || 0;

  // P2修复：计算 accountingPnl（使用持久化的avgEntryPrice）
  // 基于 positionNotional 和加权平均成本计算
  let accountingPnl = 0;
  const posNotional = state.positionNotional || 0;
  const currentPrice = tick?.price || state.lastPrice || 0;

  if (posNotional !== 0 && currentPrice > 0) {
    // 优先使用持久化的avgEntryPrice
    let avgCost = state.avgEntryPrice || 0;

    // 如果avgEntryPrice不可用，回退到gridLevels计算（兼容性）
    if (avgCost <= 0 && state.gridLevels) {
      let totalCost = 0;
      let totalQty = 0;

      for (let i = 0; i < state.gridLevels.length; i++) {
        const grid = state.gridLevels[i];
        if (grid && grid.lastFillQty > 0 && grid.lastFillPrice > 0) {
          // 只统计与当前持仓方向一致的成交
          const isShort = posNotional < 0;
          const gridIsShort = grid.side === 'Sell';

          if (isShort === gridIsShort) {
            const qty = grid.lastFillQty;
            const price = grid.lastFillPrice;
            totalQty += qty;
            totalCost += qty * price;
          }
        }
      }

      if (totalQty > 0) {
        avgCost = totalCost / totalQty;
        // 同步更新state.avgEntryPrice供下次使用
        state.avgEntryPrice = avgCost;
      }
    }

    if (avgCost > 0) {
      // 空仓 PnL = positionNotional * (avgCost/currentPrice - 1)
      // positionNotional 是负值（如 -197.39），表示空仓名义价值
      const posQty = Math.abs(posNotional) / avgCost; // 持仓数量

      if (posNotional < 0) {
        // Short: PnL = (entryPrice - currentPrice) * qty
        // = (avgCost - currentPrice) * posQty
        accountingPnl = (avgCost - currentPrice) * posQty;
      } else {
        // Long: PnL = (currentPrice - entryPrice) * qty
        accountingPnl = (currentPrice - avgCost) * posQty;
      }
    }
  }

  state.riskMetrics.accountingPnl = accountingPnl;
  state.riskMetrics.galesLevel = getCurrentGalesLevel();
  state.riskMetrics.exchangePosition = state.exchangePosition || 0;
  const accPos = Math.abs(state.riskMetrics.accountingPosition || 0);
  const exPos = Math.abs(state.riskMetrics.exchangePosition || 0);
  // P1修复：ledgerStatus应反映accountGap，不只是单边为零
  const accountGap = Math.abs(accPos - exPos);
  if (exPos > 1 && accPos < 1) {
    state.riskMetrics.ledgerStatus = 'mismatch';
  } else if (accountGap > 100) {
    state.riskMetrics.ledgerStatus = 'ERROR';  // gap>100强制报错
  } else {
    state.riskMetrics.ledgerStatus = 'ok';
  }

  // 账户级指标（优先从tick读取；其次尝试bridge；否则NA）
  let accountPos = null;
  let accountEq = null;
  if (tick && typeof tick === 'object') {
    if (tick.accountTotalPositionNotional !== undefined) accountPos = Number(tick.accountTotalPositionNotional);
    if (tick.accountNetEquity !== undefined) accountEq = Number(tick.accountNetEquity);
  }

  // 账户信息桥接：兼容 equity/netEquity 命名
  if ((accountPos === null || !isFinite(accountPos) || accountEq === null || !isFinite(accountEq)) && typeof bridge_getAccount === 'function') {
    try {
      const accountJson = bridge_getAccount();
      if (accountJson && accountJson !== 'null') {
        const account = JSON.parse(accountJson);
        if (accountPos === null && account && account.totalPositionNotional !== undefined) accountPos = Number(account.totalPositionNotional);
        if (accountEq === null && account) {
          if (account.netEquity !== undefined) accountEq = Number(account.netEquity);
          else if (account.equity !== undefined) accountEq = Number(account.equity);
          else if (account.balance !== undefined) accountEq = Number(account.balance);
        }
      }
    } catch (e) {
      // 静默降级，不影响交易主流程
    }
  }

  // 账户总持仓口径：优先直接字段；否则用全部持仓汇总 |positionNotional|
  if ((accountPos === null || !isFinite(accountPos)) && typeof bridge_getAllPositions === 'function') {
    try {
      const allPosJson = bridge_getAllPositions();
      if (allPosJson && allPosJson !== 'null') {
        const allPos = JSON.parse(allPosJson);
        if (allPos && allPos.length !== undefined) {
          let total = 0;
          for (let i = 0; i < allPos.length; i++) {
            const p = allPos[i] || {};
            const n = Number(p.positionNotional);
            if (isFinite(n)) total += Math.abs(n);
          }
          accountPos = total;
        }
      }
    } catch (e) {
      // 静默降级
    }
  }

  state.riskMetrics.accountTotalPositionNotional = (accountPos !== null && isFinite(accountPos)) ? accountPos : null;
  state.riskMetrics.accountNetEquity = (accountEq !== null && isFinite(accountEq)) ? accountEq : null;
  if (state.riskMetrics.accountNetEquity && state.riskMetrics.accountNetEquity !== 0 && state.riskMetrics.accountTotalPositionNotional !== null) {
    state.riskMetrics.accountLeverageRatio = state.riskMetrics.accountTotalPositionNotional / state.riskMetrics.accountNetEquity;
  } else {
    state.riskMetrics.accountLeverageRatio = null;
  }
  state.riskMetrics.updatedAt = Date.now();
}

/**
 * 统一风险观测日志（默认60秒一次）
 * P1修复：添加accountGap和strategyGap字段
 * P0修复：强制输出非NA字段
 */
function logRiskMetrics() {
  // P0修复：确保riskMetrics已初始化
  if (!state.riskMetrics) {
    state.riskMetrics = {};
  }

  const m = state.riskMetrics;

  // P0修复：强制确保关键字段有值（禁止NA）
  const accountingPos = m.accountingPosition !== undefined ? m.accountingPosition : (state.positionNotional || 0);
  const exchangePos = m.exchangePosition !== undefined ? m.exchangePosition : (state.exchangePosition || 0);

  // P1修复：计算账户锚点gap（neutral作为账户主策略）
  const accountGap = Math.abs(accountingPos - exchangePos);

  // P1修复：策略级gap（用于告警，不阻塞）
  const strategyGap = accountGap;

  // P0修复：ownerStrategy必须使用state中锁定的值（禁止任何运行时重算）
  // 初始化守卫：如果ownerStrategy未设置，记录错误并返回
  if (!state.ownerStrategy) {
    logError('[风险指标] 致命错误：ownerStrategy未初始化，st_init可能未执行');
    return; // 禁止输出不完整的风险指标
  }
  const ownerStrategy = state.ownerStrategy;

  // P0修复：将计算值存回riskMetrics（避免NA）
  m.accountingPosition = accountingPos;
  m.exchangePosition = exchangePos;
  m.accountGap = accountGap;
  m.strategyGap = strategyGap;
  // P0修复：ownerStrategy必须与实例state key一致，禁止覆盖
  m.ownerStrategy = ownerStrategy;

  // P0修复：强制格式化（禁止NA）
  const fmtNum = (v, d) => {
    if (v === null || v === undefined || typeof v !== 'number' || !isFinite(v)) {
      return (0).toFixed(d || 2);
    }
    return v.toFixed(d || 2);
  };

  logInfo('[风险指标] 策略(accountingPos=' + fmtNum(m.accountingPosition, 2) +
          ', accountingPnl=' + fmtNum(m.accountingPnl, 2) +
          ', galesLevel=' + fmtNum(m.galesLevel, 0) +
          ', exchangePos=' + fmtNum(m.exchangePosition, 2) +
          ', ledger=' + (m.ledgerStatus || 'ok') +
          ', accountGap=' + fmtNum(m.accountGap, 2) +
          ', strategyGap=' + fmtNum(m.strategyGap, 2) +
          ', ownerStrategy=' + m.ownerStrategy +
          ') | 账户(totalPos=' + fmtNum(m.accountTotalPositionNotional, 2) +
          ', netEq=' + fmtNum(m.accountNetEquity, 2) +
          ', lev=' + fmtNum(m.accountLeverageRatio, 4) + ')');
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
  logInfo('方向: ' + CONFIG.lean + (CONFIG.lean === 'neutral' ? '' : ' (虚仓仅记账)'));

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
 * P1修复：账本对齐（直接同步交易所持仓）
 * 原因：execution缓存不完整，重建逻辑复杂且易错
 * 方案：启动时直接读取交易所持仓，设置为策略账本初始值
 */
function alignAccountingFromExchange() {
  if (typeof bridge_getPosition !== 'function') {
    logWarn('[账本对齐] bridge_getPosition不可用');
    return { aligned: false, reason: 'bridge_unavailable' };
  }

  try {
    const positionJson = bridge_getPosition(CONFIG.symbol);
    if (!positionJson || positionJson === 'null' || positionJson === 'undefined') {
      logWarn('[账本对齐] 无持仓数据');
      return { aligned: false, reason: 'no_position' };
    }

    const position = JSON.parse(positionJson);
    const exchangePos = position.positionNotional || 0;
    const isShort = position.side === 'Sell' || position.side === 'SHORT';
    const signedExchangePos = isShort ? -Math.abs(exchangePos) : exchangePos;

    // P1简化修复：直接设置账本为交易所持仓（强制同步）
    const oldLedger = state.positionNotional || 0;

    // P2修复：avgEntryPrice周期性同步（仅在方向相同时更新）
    const oldDirection = oldLedger > 0 ? 'positive' : (oldLedger < 0 ? 'negative' : 'none');
    const newDirection = signedExchangePos > 0 ? 'positive' : (signedExchangePos < 0 ? 'negative' : 'none');

    // 获取entryPrice用于后续更新
    const entryPrice = Number(position.entryPrice || 0);

    state.positionNotional = signedExchangePos;

    // 仅在方向相同时更新avgEntryPrice（穿零重置逻辑保持）
    if (oldDirection === newDirection && newDirection !== 'none' && entryPrice > 0) {
      state.avgEntryPrice = entryPrice;
      logInfo('[账本对齐] avgEntryPrice同步: ' + entryPrice.toFixed(4) +
              ' (方向=' + newDirection + ', 旧=' + (state.avgEntryPrice || 0).toFixed(4) + ')');
    }

    // P1修复：不再这里设置initialOffset（由调用方在调用前设置）
    // positionDiffState.initialOffset = 0;
    // state.initialOffset = 0;

    logInfo('[账本对齐] 强制同步: exchangePos=' + signedExchangePos.toFixed(2) +
            ' oldLedger=' + oldLedger.toFixed(2) +
            ' newLedger=' + state.positionNotional.toFixed(2));

    return {
      aligned: true,
      exchangePos: signedExchangePos,
      oldLedger: oldLedger,
      newLedger: state.positionNotional,
      gap: 0
    };
  } catch (e) {
    logWarn('[账本对齐失败] ' + e);
    return { aligned: false, reason: 'error', error: e.message };
  }
}

/**
 * 按策略前缀回放成交，重建策略独立账本（审计日志）
 * 保留用于校验，但主要依赖alignAccountingFromExchange
 */
function rebuildAccountingFromExecutions() {
  // P0修复：使用锁定后的字段，确保不可变
  const leanLabel = LOCKED_LEAN.toLowerCase() || 'neutral';
  const strategyPrefix = 'gales-' + LOCKED_SYMBOL + '-' + leanLabel + '-';

  if (typeof bridge_getExecutions !== 'function') {
    logWarn('[账本重建] bridge_getExecutions 不可用，跳过回放');
    return { rebuilt: false, matched: 0, total: 0 };
  }

  try {
    const executionsJson = bridge_getExecutions();
    if (!executionsJson || executionsJson === 'null') {
      logWarn('[账本重建] 无成交缓存，跳过回放');
      return { rebuilt: false, matched: 0, total: 0 };
    }

    const executions = JSON.parse(executionsJson);
    if (!Array.isArray(executions) || executions.length === 0) {
      logInfo('[账本重建] 成交列表为空，保持现有账本');
      return { rebuilt: false, matched: 0, total: 0 };
    }

    // 时间升序回放，确保累计过程可审计
    executions.sort(function(a, b) { return Number(a.execTime || 0) - Number(b.execTime || 0); });

    let rebuiltNotional = 0;
    let matched = 0;
    const seenExec = {};

    for (let i = 0; i < executions.length; i++) {
      const exec = executions[i] || {};
      const execId = exec.execId;
      const orderLinkId = exec.orderLinkId || '';
      const symbol = exec.symbol || '';

      if (!execId || seenExec[execId]) continue;
      seenExec[execId] = true;

      // P0修复：严格匹配本策略成交（使用ownerStrategy/state key过滤）
      // orderLinkId格式: 'gales-MYXUSDT-short-{runId_last8}-seq-side' (≤45 chars)
      // getStateKey() = 'state:MYXUSDT:short' -> 需要匹配 'gales-MYXUSDT-short-'
      const expectedPrefix = 'gales-' + LOCKED_SYMBOL + '-' + LOCKED_LEAN + '-';
      const isOwnOrder = orderLinkId && orderLinkId.startsWith(expectedPrefix);

      if (!isOwnOrder) continue;

      const side = exec.side;
      const execQty = Number(exec.execQty || 0);
      const execPrice = Number(exec.execPrice || 0);
      const notional = execQty * execPrice;
      if (!isFinite(notional) || notional <= 0) continue;

      if (CONFIG.lean === 'positive') {
        if (side === 'Buy') rebuiltNotional += notional;
      } else if (CONFIG.lean === 'negative') {
        if (side === 'Sell') rebuiltNotional -= notional;
        else rebuiltNotional += notional;
      } else {
        if (side === 'Buy') rebuiltNotional += notional;
        else rebuiltNotional -= notional;
      }

      matched++;
      logInfo('[账本重建] runId=' + state.runId + ' execId=' + execId + ' side=' + side +
              ' qty=' + execQty.toFixed(4) + ' px=' + execPrice.toFixed(4) +
              ' cum=' + rebuiltNotional.toFixed(2));
    }

    if (matched > 0) {
      state.positionNotional = rebuiltNotional;

      // 冷启动avgEntryPrice初始化已移到st_init（v2修复），此处不再重复

      logInfo('[账本重建完成] runId=' + state.runId + ' matched=' + matched + '/' + executions.length +
              ' positionNotional=' + state.positionNotional.toFixed(2) +
              ' prefix=' + strategyPrefix);
      return { rebuilt: true, matched: matched, total: executions.length };
    }

    logWarn('[账本重建] 未匹配到本策略成交（prefix=' + strategyPrefix + '），保留现有账本=' + (state.positionNotional || 0).toFixed(2));
    return { rebuilt: false, matched: 0, total: executions.length };
  } catch (e) {
    logWarn('[账本重建失败] ' + e);
    return { rebuilt: false, matched: 0, total: 0 };
  }
}

/**
 * 初始化
 */
function st_init() {
  logDebug('[DEBUG] st_init called');

  // [硬拦截最小集] 变更6: C类启动校验 - 关键参数完整性检查
  // CONFIG缺失或无效 → 拒绝启动（throw阻止策略运行）
  if (!CONFIG.symbol || typeof CONFIG.symbol !== 'string' || CONFIG.symbol.length === 0) {
    throw new Error('[C类启动校验] CONFIG.symbol 缺失或无效，拒绝启动');
  }
  if (!CONFIG.lean || (CONFIG.lean !== 'neutral' && CONFIG.lean !== 'negative' && CONFIG.lean !== 'positive')) {
    throw new Error('[C类启动校验] CONFIG.lean 缺失或无效(当前:' + CONFIG.lean + ')，拒绝启动');
  }
  if (!CONFIG.maxPosition || CONFIG.maxPosition <= 0) {
    throw new Error('[C类启动校验] CONFIG.maxPosition 缺失或为0，拒绝启动');
  }
  logInfo('[C类启动校验] 通过: symbol=' + CONFIG.symbol + ' lean=' + CONFIG.lean + ' maxPosition=' + CONFIG.maxPosition);

  // P0修复：锁定CONFIG关键字段（初始化后不可变）
  LOCKED_SYMBOL = CONFIG.symbol;
  LOCKED_LEAN = CONFIG.lean;
  SESSION_ID = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);

  logInfo('策略初始化...');
  logInfo('Symbol: ' + LOCKED_SYMBOL + ' [已锁定]');
  logInfo('GridCount: ' + CONFIG.gridCount);
  logInfo('Direction: ' + LOCKED_LEAN + ' [已锁定]');
  logInfo('SimMode: ' + CONFIG.simMode);
  logInfo('SessionId: ' + SESSION_ID);

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
      const isShortSide = position.side === 'Sell' || position.side === 'SHORT' || position.side === 'negative';
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

  // [P2] 冷启动自检报告 - 重启后立即推送策略状态
  try {
    const spacingPct = Math.round((CONFIG.gridSpacing || 0.02) * 100);
    const pos = state.positionNotional || 0;
    const avgEntry = state.avgEntryPrice || 0;
    const maxPos = CONFIG.maxPosition || 0;
    const selfCheckMsg = '[冷启动自检] sym=' + LOCKED_SYMBOL + 
                         ' dir=' + LOCKED_LEAN + 
                         ' pos=' + pos.toFixed(0) + 
                         ' avgEntry=' + avgEntry.toFixed(3) + 
                         ' maxPos=' + maxPos + 
                         ' spacing=' + spacingPct + '%';
    logInfo(selfCheckMsg);
    bridge_tgSend('1号', selfCheckMsg);
  } catch (e) {
    logWarn('[Init] 自检报告发送失败: ' + e);
  }

  // P0修复：110072根治 - 生成新的runId
  state.runId = Date.now();
  state.orderSeq = 0;
  logInfo('[Init] P0: 110072根治 - 新runId=' + state.runId + '，orderLinkId将唯一');

  // P2修复：ADX冷启动保护 - 初始化warmupTicks
  marketRegimeState.warmupTicks = CONFIG.adxPeriod;
  logInfo('[Init] P2: ADX冷启动保护 warmupTicks=' + marketRegimeState.warmupTicks + '（约' + (CONFIG.adxPeriod * 5) + '秒）');

  // P0修复：ownerStrategy与锁定后的CONFIG强绑定，确保不可变
  // 使用 LOCKED_SYMBOL + LOCKED_LEAN + SESSION_ID 确保唯一性
  state.ownerStrategy = 'state:' + LOCKED_SYMBOL + ':' + LOCKED_LEAN + ':' + SESSION_ID;
  logInfo('[Init] P0: ownerStrategy锁定=' + state.ownerStrategy + '（不可变）');

  // P1修复：立即通知bridge新runId（确保tracker同步）
  if (typeof bridge_onRunIdChange === 'function') {
    bridge_onRunIdChange(state.runId);
  }

  // P1修复：initialOffset由下方代码在账本对齐前计算（基于历史持仓差值）
  // positionDiffState.initialOffset = 0;
  // state.initialOffset = 0;
  // logInfo('[Init] 差值监控initialOffset=0（账本由回放重建）');

  // P1修复：从交易所持仓对齐账本（直接同步）
  // 注意：在对齐前计算initialOffset，确保历史差值被正确记录
  let preAlignExchangePos = 0;
  let preAlignLedgerPos = state.positionNotional || 0;
  try {
    const positionJson = bridge_getPosition(CONFIG.symbol);
    if (positionJson && positionJson !== 'null') {
      const position = JSON.parse(positionJson);
      const exchangePos = position.positionNotional || 0;
      const isShort = position.side === 'Sell' || position.side === 'SHORT';
      preAlignExchangePos = isShort ? -Math.abs(exchangePos) : exchangePos;
    }
  } catch (e) {
    logWarn('[Init] 获取交易所持仓失败: ' + e);
  }

  // P1修复：在对齐前计算initialOffset = 交易所持仓 - 策略账本
  // 这样对齐后，差值监控将基于"新增差异"而非历史遗留差异
  const calculatedOffset = preAlignExchangePos - preAlignLedgerPos;
  positionDiffState.initialOffset = calculatedOffset;
  state.initialOffset = calculatedOffset;
  logInfo('[Init] P1: 计算initialOffset=' + calculatedOffset.toFixed(2) +
          ' (exchange=' + preAlignExchangePos.toFixed(2) + ' - ledger=' + preAlignLedgerPos.toFixed(2) + ')');

  // 然后执行账本对齐
  const alignResult = alignAccountingFromExchange();
  if (alignResult.aligned) {
    logInfo('[Init][账本对齐] 强制同步完成: ledger=' + alignResult.newLedger.toFixed(2));
  } else {
    logWarn('[Init][账本对齐失败] ' + (alignResult.reason || 'unknown'));
  }

  // P2修复：冷启动时立即初始化风险指标（避免前几个tick显示NA）
  updateRiskMetrics({});
  logRiskMetrics();

  // P2修复：检测遗留订单（鲶鱼建议）
  checkLegacyOrders();

  // bridge_scheduleAt 示例：注册每小时定时任务
  if (typeof bridge_scheduleAt === 'function') {
    bridge_scheduleAt('HOURLY', 'st_onHourly');
    logInfo('[Init] 已注册每小时定时任务: st_onHourly');
  }

  // P2修复v3：avgEntryPrice冷启动初始化（方案B：使用bridge_getPosition的entryPrice）
  // 问题：bridge_getExecutions()在st_init时返回空数组（cachedExecutions未填充）
  if (state.positionNotional !== 0 && (state.avgEntryPrice || 0) === 0) {
    try {
      const posJson = bridge_getPosition(LOCKED_SYMBOL);
      if (posJson && posJson !== 'null') {
        const pos = JSON.parse(posJson);
        const entryPrice = Number(pos.entryPrice || 0);
        if (entryPrice > 0) {
          state.avgEntryPrice = entryPrice;
          logInfo('[冷启动v3] avgEntryPrice初始化=' + state.avgEntryPrice.toFixed(4) +
                  ' (来自bridge_getPosition entryPrice)');
        }
      }
    } catch (e) {
      logWarn('[冷启动v3] avgEntryPrice初始化失败: ' + e);
    }
  }
}

// ================================
// 遗留订单检测 v3 (dedup+语义分流)
// ================================
// A) dedup: key=symbol+orderLinkId，窗口30min可配，跨runId持久化
// B) 语义分流: reduceOnly/止盈/长期挂单 → 低频监控(不发TG除非超阈值)
//    reduceOnly=false旧run订单 → P2告警但受dedup降频
// C) 全部操作写日志可追溯

const LEGACY_DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30分钟 dedup窗口（可配）
const LEGACY_MONITOR_AGE_THRESHOLD_H = 24;      // 长期挂单age阈值(小时)，超过才升级告警
const LEGACY_MONITOR_COUNT_THRESHOLD = 5;        // 长期挂单数量阈值，超过才告警0号

function checkLegacyOrders() {
  try {
    const fn = globalThis.bridge_getOpenOrders;
    if (typeof fn !== 'function') {
      logDebug('[Legacy] bridge_getOpenOrders未定义，跳过');
      return;
    }

    const ordersJson = fn(CONFIG.symbol);
    if (!ordersJson || ordersJson === 'null' || ordersJson === '[]') {
      return;
    }

    const orders = JSON.parse(ordersJson);
    if (!Array.isArray(orders) || orders.length === 0) {
      return;
    }

    // 筛选遗留订单（orderLinkId以gales-开头但runId不匹配）
    const legacyOrders = orders.filter(function(o) {
      if (o.orderLinkId && o.orderLinkId.startsWith('gales-')) {
        var parts = o.orderLinkId.split('-');
        if (parts.length >= 2) {
          return parts[1] !== String(state.runId);
        }
      }
      return false;
    });

    if (legacyOrders.length === 0) {
      logInfo('[Legacy] 未检测到遗留订单');
      return;
    }

    // --- dedup: 加载持久化记录（跨runId） ---
    var now = Date.now();
    var dedupRecord = {};
    try {
      var saved = bridge_stateGet(getDedupKey(), 'null');
      if (saved && saved !== 'null') {
        dedupRecord = JSON.parse(saved);
      }
    } catch (e) {}

    // 清理过期记录
    for (var dk in dedupRecord) {
      if (now - dedupRecord[dk] > LEGACY_DEDUP_WINDOW_MS) {
        delete dedupRecord[dk];
      }
    }

    // --- 语义分流 ---
    var p2Alerts = [];     // reduceOnly=false旧run订单 → P2
    var monitorOnly = [];  // reduceOnly/止盈/长期挂单 → 低频监控

    legacyOrders.forEach(function(o) {
      var isReduceOnly = o.reduceOnly === true || o.reduceOnly === 'true';
      // 止盈单判断：side与策略倾向相反 或 reduceOnly
      var isTakeProfit = isReduceOnly;
      if (!isTakeProfit && CONFIG.lean === 'negative' && o.side === 'Buy') {
        isTakeProfit = true;
      }
      if (!isTakeProfit && CONFIG.lean === 'positive' && o.side === 'Sell') {
        isTakeProfit = true;
      }

      if (isReduceOnly || isTakeProfit) {
        monitorOnly.push(o);
      } else {
        p2Alerts.push(o);
      }
    });

    // --- 处理P2告警（受dedup降频） ---
    var newP2 = [];
    p2Alerts.forEach(function(o) {
      var dedupKey = CONFIG.symbol + ':' + o.orderLinkId;
      if (!dedupRecord[dedupKey]) {
        newP2.push(o);
        dedupRecord[dedupKey] = now;
        logInfo('[Legacy][P2] 首次告警: ' + o.orderLinkId + ' dedup_key=' + dedupKey);
      } else {
        logDebug('[Legacy][P2] dedup命中/skip send: ' + o.orderLinkId + ' (cached=' + Math.round((now - dedupRecord[dedupKey]) / 1000) + 's ago)');
      }
    });

    // P2 TG告警（仅新的，受dedup）
    if (newP2.length > 0 && typeof bridge_tgSend === 'function') {
      var markPrice = state.lastPrice || 0;
      var oldRunIds = [];
      newP2.forEach(function(o) {
        var parts = o.orderLinkId.split('-');
        var rid = parts[1] || 'unknown';
        if (oldRunIds.indexOf(rid) === -1) oldRunIds.push(rid);
      });

      var summary = '[P2告警] 遗留订单' + newP2.length + '个（旧runId=' + oldRunIds.join(',') + '）runId=' + state.runId;
      newP2.forEach(function(o, idx) {
        var orderPrice = Number(o.price || 0);
        var qty = Number(o.qty || 0);
        var distPct = markPrice > 0 ? ((orderPrice - markPrice) / markPrice * 100).toFixed(2) : 'N/A';
        summary += '\n' + (idx + 1) + '. ' + o.orderLinkId + ' ' + (o.side || '?') + ' ' + orderPrice.toFixed(4) + '×' + qty.toFixed(4) + ' dist=' + distPct + '%';
      });
      summary += '\n建议: 检查是否需保留，不需要请撤单';

      try {
        bridge_tgSend('9号', summary);
        logInfo('[Legacy][P2] bridge_tgSend→9号: ' + newP2.length + '个新告警');
      } catch (e) {
        logWarn('[Legacy][P2] tg通知失败: ' + e);
      }
    } else if (p2Alerts.length > 0 && newP2.length === 0) {
      logDebug('[Legacy][P2] 全部' + p2Alerts.length + '个P2订单dedup命中，skip send');
    }

    // --- 长期挂单监控（低频，默认不打扰） ---
    if (monitorOnly.length > 0) {
      // 记录日志（始终）
      monitorOnly.forEach(function(o) {
        var orderPrice = Number(o.price || 0);
        var isRO = o.reduceOnly === true || o.reduceOnly === 'true';
        logDebug('[Legacy][Monitor] ' + o.orderLinkId + ' reduceOnly=' + isRO + ' side=' + (o.side || '?') + ' price=' + orderPrice.toFixed(4) + ' (旧run止盈/减仓单)');
      });

      // 仅当数量超阈值 或 有超长存活订单时才升级告警
      var needEscalate = monitorOnly.length >= LEGACY_MONITOR_COUNT_THRESHOLD;
      // 注：age判断需要订单创建时间，如交易所不返回createdTime则跳过age检查

      if (needEscalate) {
        var monitorDedupKey = CONFIG.symbol + ':monitor-batch:' + monitorOnly.length;
        if (!dedupRecord[monitorDedupKey]) {
          dedupRecord[monitorDedupKey] = now;
          var msg = '[监控] ' + monitorOnly.length + '个旧run止盈/减仓单仍在挂（超阈值' + LEGACY_MONITOR_COUNT_THRESHOLD + '）';
          monitorOnly.forEach(function(o, idx) {
            msg += '\n' + (idx + 1) + '. ' + o.orderLinkId + ' ' + (o.side || '?') + ' ' + Number(o.price || 0).toFixed(4);
          });
          logWarn(msg);
          if (typeof bridge_tgSend === 'function') {
            try {
              bridge_tgSend('9号', msg);
              logInfo('[Legacy][Monitor] 升级告警→9号（数量超阈值）');
            } catch (e) {}
          }
        } else {
          logDebug('[Legacy][Monitor] 升级告警dedup命中/skip send（' + monitorOnly.length + '个）');
        }
      } else {
        logDebug('[Legacy][Monitor] ' + monitorOnly.length + '个止盈/减仓单（<阈值' + LEGACY_MONITOR_COUNT_THRESHOLD + '），仅记录不告警');
      }
    }

    // --- 保存dedup记录 ---
    try {
      bridge_stateSet(getDedupKey(), JSON.stringify(dedupRecord));
    } catch (e) {}

    state.legacyOrdersAtStartup = legacyOrders.length;
    logInfo('[Legacy] 总计: ' + legacyOrders.length + '个遗留(P2=' + p2Alerts.length + ' monitor=' + monitorOnly.length + ') 新P2告警=' + newP2.length);

  } catch (e) {
    var debugInfo = '[Legacy] 检测失败: ' + e;
    try { debugInfo += ' | ' + String(e).slice(0, 100); } catch (de) {}
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

  // P2优化：清空tickCache（每tick开始时）
  state.tickCache = {};

  // P1修复：恢复差值监控（原P0临时禁用，现重新启用）
  checkPositionDiff();

  // P0 修复：每60心跳更新exchangePosition（从cache读取，cache由QuickJSStrategy.onTick刷新）
  if (state.tickCount % 60 === 0) {
    try {
      // P0修复：使用锁定后的symbol
      const positionJson = bridge_getPosition(LOCKED_SYMBOL);
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

  // 启动后异步对账完成前，周期性重试账本重建（依赖bridge缓存成交）
  if (!state.ledgerRebuildDone && state.tickCount - (state.ledgerRebuildLastTick || 0) >= 12) {
    state.ledgerRebuildLastTick = state.tickCount;
    const rr = rebuildAccountingFromExecutions();
    if (rr.rebuilt) {
      state.ledgerRebuildDone = true;
    }
  }

  // P0修复：每60tick强制账本对齐（防止SSL/网络异常导致账本漂移）
  // [P2] 频率从30tick→60tick，因WS fill已实时更新
  if (state.tickCount % 60 === 0) {
    try {
      // P0修复：使用锁定后的symbol，确保不可变
      const positionJson = bridge_getPosition(LOCKED_SYMBOL);
      if (positionJson && positionJson !== 'null') {
        const position = JSON.parse(positionJson);
        let exchangePos = position.positionNotional || 0;
        if (position.side === 'SHORT' || position.side === 'Sell') {
          exchangePos = -Math.abs(exchangePos);
        }
        const ledgerPos = state.positionNotional || 0;
        const gap = Math.abs(exchangePos - ledgerPos);

        // 风险：强制对齐会覆盖真实成交方向，仅在gap>100U时执行
        if (gap > 100) {
          const oldPos = state.positionNotional;
          state.positionNotional = exchangePos;
          logWarn('[账本对齐] tick=' + state.tickCount + ' gap=' + gap.toFixed(2) + ' > 100, 强制同步: ' + oldPos.toFixed(2) + ' -> ' + exchangePos.toFixed(2));
        } else {
          logDebug('[账本对齐] tick=' + state.tickCount + ' gap=' + gap.toFixed(2) + ' <= 100, 无需同步');
        }
      }
    } catch (e) {
      logWarn('[账本对齐] 失败: ' + e);
    }
  }

  // 市场状态检测（ADX趋势强度）
  updateMarketRegime(tick);
  if (state.tickCount % 12 === 0) {  // 每60秒输出一次市场状态
    logInfo('📊 市场状态: ' + getMarketRegimeDesc());
  }

  // 更新风险指标（不影响主交易流程）
  updateRiskMetrics(tick);
  if (state.tickCount % 12 === 0) { // 约60秒（默认5秒心跳）
    logRiskMetrics();
  }

  // P1修复：兜底自愈 - accountGap超阈值强制账本对齐
  // 注意：simMode下exchangePos = 真实账户持仓（被其他策略污染），不能用于自愈
  if (CONFIG.simMode) {
    // simMode直接重置计数器，不触发自愈
    if (state.ledgerMismatchCount > 0) {
      state.ledgerMismatchCount = 0;
    }
  } else {
    const accountGap = state.riskMetrics?.accountGap || 0;
    // P1修复：B类自愈只在30-100范围触发，>100由账本对齐处理，避免振荡
    if (accountGap > 30 && accountGap <= 100) {
      state.ledgerMismatchCount = (state.ledgerMismatchCount || 0) + 1;
      if (state.ledgerMismatchCount >= 3) {
        // 连续3次心跳超阈值，强制对齐
        const oldPos = state.positionNotional || 0;
        const exchangePos = state.exchangePosition || 0;
        state.positionNotional = exchangePos;
        logWarn('[自愈] accountGap=' + accountGap.toFixed(2) + '超阈值，连续' + state.ledgerMismatchCount + '次心跳，强制对齐 positionNotional=' + oldPos.toFixed(2) + ' -> ' + exchangePos.toFixed(2));
        state.ledgerMismatchCount = 0; // 重置计数器
        saveState();
      }
    } else {
      // 差值正常，重置计数器
      if (state.ledgerMismatchCount > 0) {
        logDebug('[自愈] accountGap回落至' + accountGap.toFixed(2) + '，重置计数器');
        state.ledgerMismatchCount = 0;
      }
    }
  }

  // 首次初始化网格
  if (!state.initialized) {
    state.referencePrice = tick.price;
    initializeGrids();
    state.initialized = true;
    state.lastPlaceTick = state.tickCount;
    logInfo('网格初始化完成，基准价格: ' + state.referencePrice);
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

  // P2修复：撤单异步竞争窗口保护（tick计数器方案）
  if (state.isCancellingAll) {
    // 等待至少5个tick（约25秒）后自动清除
    if ((state.tickCount - state.cancellingStartTick) < 5) {
      logDebug('[撤单中] 跳过本轮心跳，等待撤单完成');
      return;
    }
    state.isCancellingAll = false;
    logInfo('[撤单完成] 冻结结束，恢复正常交易');
  }

  // ================================
  // P1新增：杠杆硬顶检查
  // ================================
  checkLeverageHardCap();

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
    const reference = state.referencePrice || state.lastPrice;
    const drift = Math.abs(state.lastPrice - reference) / reference;
    const idleTicks = (state.tickCount || 0) - (state.lastPlaceTick || 0);
    const cooldownOk = (Date.now() - (state.lastRecenterAtMs || 0)) >= (CONFIG.recenterCooldownSec * 1000);
    const noActiveOrders = countActiveOrders() === 0;

    // P0 修复：满仓时允许重心
    const fullPositionStuck = (
      (state.positionNotional >= CONFIG.maxPosition && hasOnlyActiveSellOrders()) ||
      (state.positionNotional <= -CONFIG.maxPosition && hasOnlyActiveBuyOrders())
    );

    // P1修复：Short策略价格下跌超15%时强制recenter（无视活跃订单）
    const priceDropRatio = (reference - state.lastPrice) / reference;  // 正值表示价格下跌
    const forceRecenterShort = CONFIG.lean === 'negative' && priceDropRatio >= 0.15;

    const shouldRecenter = forceRecenterShort || (
      drift >= CONFIG.recenterDistance &&
      idleTicks >= CONFIG.recenterMinIdleTicks &&
      cooldownOk &&
      (noActiveOrders || fullPositionStuck)
    );

    if (shouldRecenter) {
      // P2修复：方向性保护 - short只允许上移，long只允许下移
      // P3修复：支持 disableAutoRecenterBlockade 绕过此拦截
      // P1修复：强制recenter时跳过方向性保护
      const newReference = state.lastPrice;
      const oldReference = state.referencePrice || state.lastPrice;
      if (!forceRecenterShort && !CONFIG.disableAutoRecenterBlockade) {
        if (CONFIG.lean === 'negative' && newReference < oldReference) {
          logWarn('[autoRecenter拦截] short策略禁止追跌: oldReference=' + oldReference.toFixed(4) + ' newReference=' + newReference.toFixed(4));
          return;
        }
        if (CONFIG.lean === 'positive' && newReference > oldReference) {
          logWarn('[autoRecenter拦截] long策略禁止追涨: oldReference=' + oldReference.toFixed(4) + ' newReference=' + newReference.toFixed(4));
          return;
        }
      } else if (forceRecenterShort) {
        logWarn('[autoRecenter强制] short策略价格下跌超15%，强制recenter: priceDrop=' + (priceDropRatio * 100).toFixed(2) + '%');
      } else {
        logInfo('[autoRecenter] disableAutoRecenterBlockade=true，跳过方向性保护');
      }

      const reason = fullPositionStuck ? '满仓死锁自动重心' : '自动重心';
      logWarn('[' + reason + '] drift=' + (drift * 100).toFixed(2) +
              '% idleTicks=' + idleTicks +
              ' posNotional=' + state.positionNotional.toFixed(2) +
              ' reference=' + reference.toFixed(4) + ' -> ' + state.lastPrice.toFixed(4));

      // 强制撤销所有订单（包括卖单/买单）
      cancelAllOrders();

      // 重心并重建网格
      state.referencePrice = state.lastPrice;
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

  // P1新增：每100心跳写入指标到ndtsdb
  if (state.tickCount % 100 === 0 && typeof bridge_writeMetric === 'function') {
    try {
      bridge_writeMetric('adx', marketRegimeState.currentADX || 0);
      bridge_writeMetric('pnl', state.accountingPnl || 0);
      bridge_writeMetric('position', state.accountingPos || 0);
      // P3新增：更多监控指标
      bridge_writeMetric('open_orders', state.openOrders ? state.openOrders.length : 0);
      bridge_writeMetric('gales_level', state.riskMetrics ? (state.riskMetrics.galesLevel || 0) : 0);
      // equity：优先使用已缓存的账户净值
      const netEq = state.riskMetrics ? state.riskMetrics.accountNetEquity : null;
      bridge_writeMetric('equity', netEq || 0);
    } catch (e) {}
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
    CONFIG.lean = newParams.direction;
    logInfo('[Gales] 策略倾向: ' + CONFIG.lean);
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
    logInfo('[Gales] 重新初始化网格（基准价格: ' + state.lastPrice + '）');
    state.referencePrice = state.lastPrice;
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
    state.referencePrice = state.lastPrice;
    initializeGrids();
    state.lastRecenterAtMs = Date.now();
    state.lastRecenterTick = state.tickCount || 0;
  }

  // P3新增：拦截逻辑绕过开关热更新
  if (newParams.allowBypassLeverageBlock !== undefined) {
    CONFIG.allowBypassLeverageBlock = newParams.allowBypassLeverageBlock;
    logInfo('[Gales] 允许绕过杠杆硬顶: ' + CONFIG.allowBypassLeverageBlock);
  }
  if (newParams.allowBypassPositionBlock !== undefined) {
    CONFIG.allowBypassPositionBlock = newParams.allowBypassPositionBlock;
    logInfo('[Gales] 允许绕过仓位限制: ' + CONFIG.allowBypassPositionBlock);
  }
  if (newParams.disableAutoRecenterBlockade !== undefined) {
    CONFIG.disableAutoRecenterBlockade = newParams.disableAutoRecenterBlockade;
    logInfo('[Gales] 禁用autoRecenter拦截: ' + CONFIG.disableAutoRecenterBlockade);
  }

  saveState();
  logInfo('[Gales] 参数热更新完成');
}

/**
 * P1新增：资金费结算回调
 * Bybit每8小时结算一次（08:00, 16:00, 00:00 UTC）
 *
 * @param {string} feeJson - JSON格式的资金费数据 {symbol, fundingRate, nextFundingTime, timeToFundingMs, estimatedFee}
 */
function st_onFundingFee(feeJson) {
  // 暂时停用（总裁：当前阶段作用不大，框架接口保留）
}

/**
 * P1新增：动态止损回调（Freqtrade风格）
 *
 * @param {string} stoplossJson - JSON格式的止损数据 {position, entryPrice, currentPrice, holdingMinutes, unrealizedPnl, unrealizedPnlPct}
 * @returns {number} 止损阈值（负值表示亏损，正值表示允许回撤比例）
 */

// P3修复：动态止损日志防抖（60秒内相同内容只输出1次）
let stoplossLogCache = {
  key: '',
  lastLogAt: 0,
};

function st_customStoploss(stoplossJson) {
  try {
    const data = (typeof stoplossJson === 'string') ? JSON.parse(stoplossJson) : stoplossJson;
    const { position, entryPrice, currentPrice, holdingMinutes, unrealizedPnl, unrealizedPnlPct } = data;

    // 参数校验
    if (!position || !entryPrice || !currentPrice || holdingMinutes === undefined) {
      logWarn('[st_customStoploss] 参数缺失，使用默认-15%止损');
      return -0.15;
    }

    const pnlPct = unrealizedPnlPct || (unrealizedPnl / (Math.abs(position) * entryPrice));

    // P3修复：防抖辅助函数 - key只用止损类型固定字符串，60秒内同一类型最多输出1次
    function shouldLog(stageKey) {
      const now = Date.now();
      if (stageKey !== stoplossLogCache.key || (now - stoplossLogCache.lastLogAt) > 60000) {
        stoplossLogCache.key = stageKey;
        stoplossLogCache.lastLogAt = now;
        return true;
      }
      return false;
    }

    // 前60分钟：固定-15%止损（最大亏损）
    if (holdingMinutes < 60) {
      if (shouldLog('stoploss_60min_fixed')) {
        logInfo('[动态止损] 前60分钟，固定-15%止损 holding=' + holdingMinutes + 'min pnl=' + (pnlPct * 100).toFixed(2) + '%');
      }
      return -0.15;
    }

    // 盈利>10%后：转-1.5%追踪止损（锁定更多利润）
    if (pnlPct > 0.10) {
      if (shouldLog('stoploss_gt10pct_trailing')) {
        logInfo('[动态止损] 盈利>10%，转-1.5%追踪止损 pnl=' + (pnlPct * 100).toFixed(2) + '%');
      }
      return -0.015;
    }

    // 盈利>5%后：转-3%追踪止损（保护利润）
    if (pnlPct > 0.05) {
      if (shouldLog('stoploss_gt5pct_trailing')) {
        logInfo('[动态止损] 盈利>5%，转-3%追踪止损 pnl=' + (pnlPct * 100).toFixed(2) + '%');
      }
      return -0.03;
    }

    // 默认：-15%止损
    if (shouldLog('stoploss_default')) {
      logInfo('[动态止损] 默认-15%止损 holding=' + holdingMinutes + 'min pnl=' + (pnlPct * 100).toFixed(2) + '%');
    }
    return -0.15;
  } catch (e) {
    logWarn('st_customStoploss failed: ' + e);
    return -0.15; // 出错时返回默认-15%
  }
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
  const reference = state.referencePrice;

  // 非对称间距（向后兼容：不传时使用 gridSpacing）
  const spacingDown = CONFIG.gridSpacingDown !== null ? CONFIG.gridSpacingDown : CONFIG.gridSpacing;
  const spacingUp = CONFIG.gridSpacingUp !== null ? CONFIG.gridSpacingUp : CONFIG.gridSpacing;

  // 买单网格（跌方向）
  for (let i = 1; i <= CONFIG.gridCount; i++) {
    const price = reference * (1 - spacingDown * i);
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
    const price = reference * (1 + spacingUp * i);
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

/**
 * 判断是否应该在该网格下单 - 多层准入检查
 *
 * 设计思路：
 * 1. 为什么分层检查：先检查"是否允许交易"（熔断/ADX/仓位限制），再检查"是否满足条件"（磁铁/冷却/防重）
 * 2. 为什么用effectivePosition：策略账本和交易所数据可能不一致，取较大值防止 underestimation
 * 3. 为什么考虑pending订单：防止并发下单导致超限（已挂但未成交的订单也算入风险敞口）
 *
 * 检查顺序逻辑：
 * 1. 市场状态（ADX极强趋势）→ 2. 熔断限制 → 3. 磁铁距离 → 4. 活跃订单上限 → 5. 冷却时间
 * 6. 防重复 → 7. 方向限制 → 8. 仓位限制
 *
 * 前置条件越严格越先检查，减少无效计算
 *
 * @param {Object} grid - 网格对象
 * @param {number} distance - 当前价格与网格目标价的距离（百分比）
 * @returns {boolean} true=可以下单，false=条件不满足
 */
function shouldPlaceOrder(grid, distance) {
  // ===== P1新增：订单超时检查 =====
  // 超时条件：grid.state==='ACTIVE' && grid.createdAt && (now - grid.createdAt) > orderTimeoutSec*1000
  if (grid.state === 'ACTIVE' && grid.createdAt) {
    const now = Date.now();
    const orderTimeoutMs = (CONFIG.orderTimeoutSec || 3600) * 1000;
    const elapsed = now - grid.createdAt;
    if (elapsed > orderTimeoutMs) {
      logWarn('[OrderTimeout] gridId=' + grid.id + ' 挂单超时 ' + Math.floor(elapsed / 1000) + 's > ' + CONFIG.orderTimeoutSec + 's，自动撤销');
      try {
        if (grid.orderId) {
          bridge_cancelOrder(grid.orderId);
        }
      } catch (e) {
        logWarn('[OrderTimeout] gridId=' + grid.id + ' 撤单失败: ' + e);
      }
      // 重置grid状态
      grid.state = 'IDLE';
      grid.orderId = undefined;
      grid.orderLinkId = undefined;
      grid.orderPrice = undefined;
      return false;
    }
  }

  // P3修复：杠杆硬顶/熔断blockNewOrders - 支持绕过逻辑
  if (circuitBreakerState.blockNewOrders) {
    var blockReason = (circuitBreakerState.leverageHardCapTriggeredAt > 0) ? '杠杆硬顶' : '仓位熔断';
    var isLeverageBlock = (circuitBreakerState.leverageHardCapTriggeredAt > 0);
    var isPositionBlock = !isLeverageBlock;

    // 判断是否应该拦截：如果有对应的绕过开关，只记警告不拦截
    var shouldBlock = true;
    if (isLeverageBlock && CONFIG.allowBypassLeverageBlock) {
      logWarn('[' + blockReason + '] 告警但继续下单 (allowBypassLeverageBlock=true) gridId=' + grid.id);
      shouldBlock = false;
    } else if (isPositionBlock && CONFIG.allowBypassPositionBlock) {
      logWarn('[' + blockReason + '] 告警但继续下单 (allowBypassPositionBlock=true) gridId=' + grid.id);
      shouldBlock = false;
    }

    if (shouldBlock) {
      logWarn('[' + blockReason + '] 禁止新订单 gridId=' + grid.id);
      return false;
    }
  }

  // ADX市场状态检测：极强趋势时暂停下单（仅在enableMarketRegime时生效）
  if (CONFIG.enableMarketRegime && marketRegimeState.currentRegime === 'STRONG_TREND') {
    logWarn('[ADX] 极强趋势，暂停网格下单 gridId=' + grid.id);
    return false;
  }

  const distancePct = (distance * 100).toFixed(2);

  // ===== P2新增：ROI时间梯度检查 =====
  // 根据持仓时间动态调整触发距离，持仓越久越容易触发（强迫快进快出）
  let timeDecayMultiplier = 1.0;
  if (CONFIG.gridTimeDecay?.enabled && grid.createdAt) {
    const now = Date.now();
    const holdingMinutes = Math.floor((now - grid.createdAt) / 60000);

    // 查找适用的stage
    for (const stage of CONFIG.gridTimeDecay.stages) {
      if (holdingMinutes >= stage.afterMinutes) {
        timeDecayMultiplier = stage.spacingMultiplier;
      }
    }

    if (timeDecayMultiplier < 1.0) {
      logDebug('[ROI时间梯度] gridId=' + grid.id + ' 持仓=' + holdingMinutes + 'min 间距倍数=' + timeDecayMultiplier);
    }
  }

  // ===== 1. 磁铁距离检查 =====
  // 为什么需要磁铁：网格策略只在价格接近网格线时挂单，避免远处挂单被瞬时波动触发
  const baseMagnet = getEffectiveMagnetDistance();
  const magnet = baseMagnet * timeDecayMultiplier;  // 应用时间梯度
  if (distance > magnet) {
    return false;  // 距离太远，不在磁铁范围内
  }

  // ===== 2. 活跃订单上限检查 =====
  // 为什么需要上限：极端行情可能触发大量网格同时挂单，导致订单过多难以管理
  const active = countActiveOrders();
  if (CONFIG.maxActiveOrders > 0 && active >= CONFIG.maxActiveOrders) {
    const now = Date.now();
    // 为什么5分钟防抖：避免频繁告警刷屏
    if (now - (runtime.activeOrders.lastWarnAt || 0) > 5 * 60 * 1000) {
      runtime.activeOrders.lastWarnAt = now;
      logWarn('[活跃单上限] active=' + active + ' max=' + CONFIG.maxActiveOrders + '，暂停新挂单');
    }
    return false;
  }

  // ===== 3. 冷却时间检查 =====
  // 为什么需要冷却：防止同一网格被频繁触发（如价格在网格线附近震荡）
  if (grid.lastTriggerTime) {
    const cooldownMs = CONFIG.cooldownSec * 1000;
    const elapsed = Date.now() - grid.lastTriggerTime;
    if (elapsed < cooldownMs) {
      return false;  // 冷却中，防止重复触发
    }
  }

  // ===== 4. 防重复检查 =====
  // 为什么需要：极端情况下grid状态可能丢失，但交易所已有订单，避免重复下单
  const existing = findActiveOrderByGridId(grid.id);
  if (existing) {
    // 状态不一致，同步后跳过
    syncGridFromOrder(grid, existing);
    return false;
  }

  // ===== 5. 方向限制检查 =====
  // 为什么允许止盈单：long模式下有多仓时允许Sell止盈，short模式下有空仓时允许Buy回补
  logInfo('[DEBUG] 方向检查: lean=' + CONFIG.lean + ' grid.side=' + grid.side + ' positionNotional=' + state.positionNotional);
  if (CONFIG.lean === 'positive' && grid.side === 'Sell') {
    // long模式：有多仓(>0)时允许Sell止盈，无仓(<=0)时禁止Sell开空
    if (state.positionNotional <= 0) {
      logInfo('[方向限制] long模式下无多仓，禁止Sell开空 gridId=' + grid.id);
      return false;
    }
    // 有多仓时允许Sell止盈
  }
  if (CONFIG.lean === 'negative' && grid.side === 'Buy') {
    // short模式：有空仓(<0)时允许Buy回补，无仓(>=0)时禁止Buy做多
    if (state.positionNotional >= 0) {
      logInfo('[方向限制] short模式下无空仓，禁止Buy做多 gridId=' + grid.id);
      return false;
    }
    // 有空仓时允许Buy回补
  }

  // P1修复：熔断震荡 - 熔断中禁止超限方向开仓
  if (circuitBreakerState.tripped && circuitBreakerState.blockedSide === grid.side) {
    logDebug('[熔断限制] 熔断中禁止' + grid.side + '开仓 gridId=' + grid.id);
    return false;
  }

  // ===== 6. 仓位限制检查 =====
  // 为什么用effectivePosition：取策略账本和交易所的较大值，防止 underestimation
  // 为什么考虑pending订单：已挂但未成交的订单也算入风险敞口，防止并发超限
  const effectivePos = Math.max(
    Math.abs(state.positionNotional || 0),
    Math.abs(state.exchangePosition || 0)
  );
  const effectivePosSigned = state.exchangePosition || state.positionNotional || 0;
  const orderNotional = CONFIG.orderSize;

  if (grid.side === 'Buy') {
    // negative 模式下，Buy 只是虚仓（平仓），不限制 - 为什么：negative策略的Buy是减少风险
    if (CONFIG.lean !== 'negative') {
      const pendingBuy = calcPendingNotional('Buy');
      // 为什么加pendingBuy：已挂但未成交的Buy订单也算入风险敞口
      const afterFill = effectivePosSigned + pendingBuy + orderNotional;
      if (afterFill > CONFIG.maxPosition) {
        warnPositionLimit('Buy', grid.id, effectivePosSigned + pendingBuy, afterFill);
        return false;
      }
    }
    // 回到安全区后，允许下次"再次进入超限"时报警 - 为什么：防止重复告警
    runtime.posLimit.buyOver = false;
  }

  if (grid.side === 'Sell') {
    // positive 模式下，Sell 只是虚仓（平仓），不限制 - 为什么：positive策略的Sell是减少风险
    if (CONFIG.lean !== 'positive') {
      const pendingSell = calcPendingNotional('Sell');
      const afterFill = effectivePosSigned - pendingSell - orderNotional;
      if (afterFill < -CONFIG.maxPosition) {
        warnPositionLimit('Sell', grid.id, effectivePosSigned - pendingSell, afterFill);
        return false;
      }
    }
    runtime.posLimit.sellOver = false;
  }

  // ===== 通过所有检查 =====
  logInfo('✨ 触发网格 #' + grid.id + ' ' + grid.side + ' @ ' + grid.price.toFixed(4) + ' (距离 ' + distancePct + '%)');
  return true;
}

function placeOrder(grid) {
  // P2修复：撤单期间冻结下单
  if (state.isCancellingAll) {
    logDebug('[placeOrder] 撤单中，跳过下单 gridId=' + grid.id);
    return;
  }
  
  // P0修复：设置并发锁，防止方向切换
  state.isPlacingOrder = true;

    // 双保险：避免重复挂单（grid 状态丢失时常见）
    const existing = findActiveOrderByGridId(grid.id);
    if (existing) {
      syncGridFromOrder(grid, existing);
      state.isPlacingOrder = false;  // 清除锁
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

  // postOnly 保护（P1修复：使用CONFIG.priceTick替代硬编码）
  const priceTick = CONFIG.priceTick || 0.001;
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

  // P2修复：边界条件检查 - orderPrice和quantity必须有效
  if (!orderPrice || orderPrice <= 0 || !isFinite(orderPrice)) {
    logError('[placeOrder] 无效orderPrice: ' + orderPrice + ', grid.price=' + grid.price);
    state.isPlacingOrder = false;
    return;
  }
  if (!quantity || quantity <= 0 || !isFinite(quantity)) {
    logError('[placeOrder] 无效quantity: ' + quantity + ', orderSize=' + orderSize + ', orderPrice=' + orderPrice);
    state.isPlacingOrder = false;
    return;
  }
  // P1修复：110072根治 - orderLinkId加入lean防止跨策略误报
  const leanLabel = CONFIG.lean || 'neutral';
  // P0修复：orderLinkId使用锁定后的字段，确保唯一性
  // fix: Bybit orderLinkId ≤ 45 chars - 去掉 SESSION_ID，runId 取后8位
  // P2修复：使用grid.id+attempts生成确定性orderLinkId，重试时不变
  // 格式: gales-{symbol}-{lean}-{runId_last8}-g{gridId}a{attempt}-{side}
  // 最长: gales-MYXUSDT-neutral-12345678-g10a3-Sell = 44 chars (≤45)
  const _runSuffix = String(state.runId).slice(-8);
  const orderLinkId = ('gales-' + LOCKED_SYMBOL + '-' + LOCKED_LEAN + '-' + _runSuffix + '-g' + grid.id + 'a' + grid.attempts + '-' + grid.side).slice(0, 45);

  // P2修复：幂等性检查 - 查询Bybit是否已有该orderLinkId的订单
  try {
    const fn = globalThis.bridge_getOpenOrders;
    if (typeof fn === 'function') {
      const ordersJson = fn(CONFIG.symbol);
      if (ordersJson && ordersJson !== 'null' && ordersJson !== '[]') {
        const orders = JSON.parse(ordersJson);
        if (Array.isArray(orders)) {
          const existingBybitOrder = orders.find(function(o) {
            return o.orderLinkId === orderLinkId;
          });
          if (existingBybitOrder) {
            // 订单已存在，同步状态并跳过下单
            logInfo('[P2幂等] 订单已存在，同步状态: orderLinkId=' + orderLinkId + ' orderId=' + existingBybitOrder.orderId);
            syncGridFromOrder(grid, existingBybitOrder);
            state.isPlacingOrder = false;
            return;
          }
        }
      }
    }
  } catch (e) {
    logDebug('[P2幂等] 检查已有订单失败: ' + e.message);
    // 继续尝试下单（不阻塞）
  }

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

    // P2优化：同步更新gridId索引
    if (!state.ordersByGridId) state.ordersByGridId = {};
    state.ordersByGridId[grid.id] = order;

    // P2优化：同步更新活跃订单计数器
    if (typeof state.activeOrdersCount !== 'number') state.activeOrdersCount = 0;
    state.activeOrdersCount++;

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

    // 【方案A修复】添加reduceOnly字段
    // neutral: 无偏好 — 网格双向挂单，所有成交都影响真实仓位，不限制
    // short: 允许开空(Sell)，Buy是回补
    // long: 允许开多(Buy)，Sell是止盈
    let reduceOnly = false;
    if (CONFIG.lean === 'neutral') {
      // 【方案A】neutral策略：无偏好，允许开仓
      reduceOnly = false;
    } else if (CONFIG.lean === 'negative' && grid.side === 'Sell') {
      // short策略开空仓：允许
      reduceOnly = false;
    } else if (CONFIG.lean === 'negative' && grid.side === 'Buy') {
      // short策略回补：通常是平仓，但也能是开多（根据设计决定）
      // 目前保持false允许操作，如果需要严格做空敞口可设为true
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
    const newOrder = {
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
    };
    state.openOrders.push(newOrder);

    // P2优化：同步更新gridId索引
    if (!state.ordersByGridId) state.ordersByGridId = {};
    state.ordersByGridId[grid.id] = newOrder;

    // P2优化：同步更新活跃订单计数器
    if (typeof state.activeOrdersCount !== 'number') state.activeOrdersCount = 0;
    state.activeOrdersCount++;

    logInfo('✅ 挂单成功 orderId=' + grid.orderId);
    saveState();
  } catch (e) {
    // [硬拦截最小集] 变更4: 错误分类（A类关键 vs 可恢复）
    const errClass = classifyApiError(e);
    if (errClass === 'critical') {
      // 认证/签名/系统级 → 计入A类计数器（checkCircuitBreaker将触发硬拦截）
      logWarn('❌ 挂单失败[A类-关键]: ' + e);
      recordApiCriticalFail(String(e));
    } else if (errClass === 'recoverable') {
      // 余额不足/时效过期 → 仅告警，等下个tick自动重试
      logWarn('❌ 挂单失败[可恢复]: ' + e);
    } else {
      // 未知 → 记录，不计入A类（避免误拦）
      logWarn('❌ 挂单失败[未知]: ' + e);
    }
    grid.state = 'IDLE';
  } finally {
    // P0修复：清除并发锁
    state.isPlacingOrder = false;
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
