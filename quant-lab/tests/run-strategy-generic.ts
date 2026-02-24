#!/usr/bin/env bun

// ================================
// 【P1】启动前依赖自检（防止停机35h）
// ================================
function runDependencyCheck(): void {
  const errors: string[] = [];

  // 1. 检查 quickjs-emscripten 是否可 import
  try {
    require.resolve('quickjs-emscripten');
  } catch (e) {
    errors.push('❌ 依赖缺失: quickjs-emscripten 无法解析');
  }

  // 2. 检查关键 logger 路径是否解析成功
  try {
    require.resolve('../src/utils/logger');
  } catch (e) {
    errors.push('❌ 依赖缺失: ../src/utils/logger 无法解析');
  }

  if (errors.length > 0) {
    console.error('[DEPENDENCY_CHECK_FAILED] 启动前依赖自检失败:');
    errors.forEach(err => console.error(`  ${err}`));
    console.error('[DEPENDENCY_CHECK_FAILED] 请运行: cd quant-lab && bun install');
    process.exit(1);
  }
}

// 立即执行依赖检查
runDependencyCheck();

import { createLogger } from '../src/utils/logger';
const logger = createLogger('RUN_STRATEGY_GENERIC');
/**
 * 通用策略启动器
 * 
 * 用法:
 *   bun tests/run-strategy-generic.ts <strategy-file> [--live] [--demo] [params-json] [exchange] [account]
 * 
 * 参数:
 *   --live          实盘模式（连接真实订单流；需环境变量 DRY_RUN=false）
 *   --demo          Demo Trading 模式（使用 api-demo.bybit.com）
 *   params-json     策略参数 JSON（默认 {}）
 *   exchange        交易所（默认 bybit）
 *   account         账号别名（默认 wjcgm@bbt-sub1）
 * 
 * 示例:
 *   # Paper Trade（默认）
 *   bun tests/run-strategy-generic.ts ./strategies/grid/gales-simple.js
 *   
 *   # 实盘模式
 *   DRY_RUN=false bun tests/run-strategy-generic.ts ./strategies/grid/gales-simple.js --live
 *   
 *   # Demo Trading 模式
 *   bun tests/run-strategy-generic.ts ./strategies/grid/gales-simple.js --demo '{"symbol":"MYXUSDT"}'
 *   
 *   # 自定义参数
 *   bun tests/run-strategy-generic.ts ./strategies/grid/gales-simple.js --live '{"gridCount":10}' bybit wjcgm@bbt-sub1
 */

import { QuickJSStrategy } from '../legacy/QuickJSStrategy';
import { BybitProvider } from '../src/providers/bybit.js';
import { BybitStrategyContext } from '../src/contexts/BybitStrategyContext';
import { existsSync } from 'fs';
import { hotReloadAPI } from '../src/api/hot-reload-api';

// ================================
// 参数解析
// ================================

const args = process.argv.slice(2);

if (args.length === 0) {
  logger.error('用法: run-strategy-generic.ts <strategy-file> [--live] [params-json] [exchange] [account]');
  process.exit(1);
}

const strategyFile = args[0];
let liveMode = false;
let demoMode = false;
let argIdx = 1;

// 检查 --live 和 --demo 参数
if (args[1] === '--live') {
  liveMode = true;
  argIdx = 2;
} else if (args[1] === '--demo') {
  demoMode = true;
  argIdx = 2;
}

const paramsJson = args[argIdx] || '{}';
const exchange = args[argIdx + 1];
const accountId = args[argIdx + 2];

// P1修复：删除默认账号，强制传参
if (!exchange) {
  throw new Error('Missing required argument: exchange. Usage: bun run-strategy-generic.ts <strategy> [--live <params>] <exchange> <accountId>');
}
if (!accountId) {
  throw new Error('Missing required argument: accountId. Usage: bun run-strategy-generic.ts <strategy> [--live <params>] <exchange> <accountId>');
}

// 验证策略文件
if (!existsSync(strategyFile)) {
  logger.error(`策略文件不存在: ${strategyFile}`);
  process.exit(1);
}

// 解析参数
let params;
try {
  params = JSON.parse(paramsJson);
} catch (e) {
  logger.error(`参数 JSON 格式错误: ${e}`);
  process.exit(1);
}

// ================================
// 交易所配置（从 ~/.config/quant-lab/accounts.json 读取）
// ================================

function loadAccounts(): Record<string, any> {
  const configPath = `${process.env.HOME}/.config/quant-lab/accounts.json`;
  try {
    const accounts = JSON.parse(require('fs').readFileSync(configPath, 'utf-8'));
    const map: Record<string, any> = {};
    for (const acc of accounts) {
      map[acc.id] = acc;
    }
    return map;
  } catch (e) {
    logger.error(`无法读取账号配置: ${configPath}`);
    return {};
  }
}

const ACCOUNTS = loadAccounts();

// ================================
// 主流程
// ================================

async function main() {
  logger.info('======================================================================');
  logger.info('   通用策略启动器');
  logger.info('======================================================================\n');

  // 检查 DRY_RUN 环境变量
  const isDryRun = process.env.DRY_RUN !== 'false';

  logger.info('[配置]', {
    strategyFile,
    params,
    exchange,
    accountId,
    liveMode,
    demoMode,
    isDryRun,
  });

  // P0修复：fail-fast检查，防止误启纸盘冒充实盘
  if (liveMode && isDryRun) {
    const allowPaperOnLive = process.env.ALLOW_PAPER_ON_LIVE === 'true';
    if (!allowPaperOnLive) {
      logger.error('❌ [P0 fail-fast] --live 模式但 DRY_RUN=true（纸盘）');
      logger.error('   如确实需要在live模式使用纸盘，请设置环境变量:');
      logger.error('   ALLOW_PAPER_ON_LIVE=true bun tests/run-strategy-generic.ts ...');
      logger.error('   否则请设置 DRY_RUN=false 启用真实订单流');
      process.exit(1);
    }
    logger.warn('⚠️  [ALLOW_PAPER_ON_LIVE] --live 模式但 DRY_RUN=true，将使用 Paper Trade');
  }

  if (liveMode && !isDryRun) {
    logger.warn('🔴 [实盘模式] 连接真实订单流！');
  }

  if (demoMode) {
    logger.warn('🟡 [Demo Trading 模式] 使用 api-demo.bybit.com');
  }

  // 1. 初始化交易所连接
  let provider: any;

  if (exchange === 'bybit') {
    if (demoMode) {
      // Demo Trading 模式：使用环境变量中的 Demo API Key
      const demoApiKey = process.env.BYBIT_DEMO_API_KEY;
      const demoApiSecret = process.env.BYBIT_DEMO_API_SECRET;
      
      if (!demoApiKey || !demoApiSecret) {
        logger.error('错误: Demo 模式需要设置 BYBIT_DEMO_API_KEY 和 BYBIT_DEMO_API_SECRET 环境变量');
        process.exit(1);
      }

      provider = new BybitProvider({
        apiKey: demoApiKey,
        apiSecret: demoApiSecret,
        demo: true,
        proxy: 'http://127.0.0.1:8890',
        category: 'linear',
        // Phase 1: ndtsdb状态持久化配置
        stateDir: process.env.HOME + '/.quant-lib',
        runId: Date.now().toString(),
      });

      logger.info('[Exchange] Bybit Provider 初始化完成 (Demo Trading)\n');
    } else {
      const accountConfig = ACCOUNTS[accountId as keyof typeof ACCOUNTS];
      if (!accountConfig) {
        logger.error(`未找到账号配置: ${accountId}`);
        process.exit(1);
      }

      provider = new BybitProvider({
        apiKey: accountConfig.apiKey,
        apiSecret: accountConfig.apiSecret,
        testnet: accountConfig.testnet || false,
        proxy: accountConfig.proxy || 'http://127.0.0.1:8890',
        category: 'linear',
        // Phase 1: ndtsdb状态持久化配置
        stateDir: process.env.HOME + '/.quant-lib',
        runId: Date.now().toString(),
      });

      logger.info(`[Exchange] Bybit Provider 初始化完成 (${accountId})\n`);
    }
  } else {
    logger.error(`暂不支持的交易所: ${exchange}`);
    process.exit(1);
  }

  // 2. 获取交易对（从参数或默认）
  const symbol = params.symbol || 'MYXUSDT';

  // 3. 创建策略实例
  // P0修复：使用固定strategyId（symbol+direction）而非Date.now()
  // 确保重启后能加载到相同的state文件
  const direction = params.direction || 'neutral';
  const strategy = new QuickJSStrategy({
    strategyId: params.strategyId || `gales-${symbol}-${direction}`,
    strategyFile,
    params,
    maxRetries: 3,
    retryDelayMs: 5000,
    hotReload: false,  // Day2: 默认禁用自动watch，热更新通过显式API触发
  });

  // 4. 创建 BybitStrategyContext 并初始化策略
  logger.info('[QuickJS] 创建策略上下文（BybitStrategyContext）...');
  
  const context = new BybitStrategyContext({
    provider,
    symbol,
    qtyStep: 1,      // MYX 规格
    tickSize: 0.001, // MYX 规格
    minQty: 1,       // MYX 规格
  });
  
  logger.info('[QuickJS] 初始化沙箱...');
  await strategy.onInit(context);
  logger.info('[QuickJS] 策略初始化完成\n');

  // [P1] 启动execution WebSocket订阅（根治accountGap）
  if (provider.subscribeExecutions && strategy.onExecution) {
    logger.info('[QuickJS] 启动 execution 实时订阅...');
    await provider.subscribeExecutions(async (exec) => {
      logger.info(`[QuickJS] 收到 execution: execId=${exec.execId}, orderLinkId=${exec.orderLinkId}`);
      await strategy.onExecution!(exec);
    });
    logger.info('[QuickJS] execution 订阅已启动\n');
  }

  // P1修复: 热更新HTTP API端口分配策略
  // - RELOAD_API_PORT=0: 禁用HTTP server（live默认）
  // - RELOAD_API_PORT未设置: live模式禁用，paper模式启用动态端口
  // - RELOAD_API_PORT显式指定: 使用指定端口
  const strategyId = params.strategyId || `gales-${symbol}-${direction}`;
  let apiPort: number;
  
  if (process.env.RELOAD_API_PORT === '0') {
    // 显式禁用
    apiPort = 0;
    logger.info('[HotReloadAPI] HTTP服务已禁用 (RELOAD_API_PORT=0)');
  } else if (process.env.RELOAD_API_PORT) {
    // 显式指定端口
    apiPort = parseInt(process.env.RELOAD_API_PORT);
  } else if (liveMode && !isDryRun) {
    // Live模式默认禁用（避免端口冲突）
    apiPort = 0;
    logger.info('[HotReloadAPI] Live模式默认禁用HTTP服务（避免端口冲突）');
    logger.info('[HotReloadAPI] 如需启用，请设置 RELOAD_API_PORT=<port>');
  } else {
    // Paper模式: 使用策略派生端口（避免冲突）
    // 端口范围: 10000-65535，基于strategyId哈希
    const hash = strategyId.split('').reduce((a, b) => { a = ((a << 5) - a) + b.charCodeAt(0); return a & a; }, 0);
    apiPort = 10000 + (Math.abs(hash) % 55535);
  }
  
  if (apiPort > 0) {
    try {
      hotReloadAPI.registerStrategy(strategyId, strategy);
      await hotReloadAPI.start(apiPort);
      logger.info(`[HotReloadAPI] 热更新服务已启动: http://127.0.0.1:${apiPort}`);
      logger.info(`[HotReloadAPI] 策略ID: ${strategyId}`);
      logger.info(`[HotReloadAPI] 可用命令:`);
      logger.info(`  curl -X POST http://127.0.0.1:${apiPort}/api/v1/reload -H "Content-Type: application/json" -d '{"strategyId":"${strategyId}","target":"strategy"}'`);
      logger.info(`  curl -X POST http://127.0.0.1:${apiPort}/api/v1/rollback -H "Content-Type: application/json" -d '{"strategyId":"${strategyId}"}'`);
    } catch (error: any) {
      logger.warn(`[HotReloadAPI] 启动失败: ${error.message}`);
    }
  }
  logger.info('');

  if (liveMode && !isDryRun) {
    logger.info('🔴 [实盘模式] 订单将发送到交易所\n');
  } else {
    logger.info(`⚠️  [Paper Trade] 模拟模式（策略内需实现 simMode 逻辑）\n`);
  }

  logger.info('[按 Ctrl+C 停止]\n');

  // P0修复：添加退出日志（诊断#350消失问题）
  const startTime = Date.now();
  process.on('exit', (code) => {
    const runtime = Math.floor((Date.now() - startTime) / 1000);
    logger.info(`[QuickJS] [EXIT] 进程退出 code=${code}, tickCount=${tickCount}, runtime=${runtime}s`);
  });

  process.on('beforeExit', (code) => {
    const runtime = Math.floor((Date.now() - startTime) / 1000);
    logger.info(`[QuickJS] [BEFORE_EXIT] 即将退出 code=${code}, tickCount=${tickCount}, runtime=${runtime}s`);
  });

  // P1修复：未捕获异常处理（防止静默损坏策略状态）
  process.on('unhandledRejection', (reason, promise) => {
    logger.error(`[FATAL] unhandledRejection: ${reason instanceof Error ? reason.stack : reason}`);
    // 不强制退出，记录后继续运行，避免打断持仓中的策略
  });

  process.on('uncaughtException', (err) => {
    logger.error(`[FATAL] uncaughtException: ${err.stack || err.message}`);
    // 未捕获同步异常通常不可恢复，记录后优雅退出
    process.exit(1);
  });

  // 5. 启动心跳循环
  logger.info('[QuickJS] 策略启动...');

  let tickCount = 0;

  const heartbeatInterval = setInterval(async () => {
    try {
      tickCount++;

      // 获取真实价格
      const ticker = await provider.getTicker(symbol);
      const price = ticker.lastPrice;

      // P0修复：加强心跳日志（诊断#350消失问题）
      const runtime = Math.floor((Date.now() - startTime) / 1000);
      if (tickCount >= 345 && tickCount <= 355) {
        // 心跳#345-#355详细日志
        logger.info(`[QuickJS] [CRITICAL] 心跳 #${tickCount} - 价格: ${price}, runtime: ${runtime}s`);
      } else if (tickCount % 10 === 0) {
        // 每 10 次心跳输出一次
        logger.info(`[QuickJS] 心跳 #${tickCount} - 价格: ${price}, runtime: ${runtime}s`);
      }

      // 构造 tick
      const tick = {
        count: tickCount,
        timestamp: Math.floor(Date.now() / 1000),
        price,
        volume: ticker.volume24h || 1000,
      };

      // 更新 K线缓存
      if (context) {
        context.updateBar({
          timestamp: tick.timestamp,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: tick.volume,
        });
      }

      // 调用策略 onTick（内部会调 st_heartbeat + processPendingOrders）
      if (typeof strategy.onTick === 'function') {
        await strategy.onTick(tick, context);
      } else {
        logger.error(`[QuickJS] strategy.onTick 不存在! typeof=${typeof strategy.onTick}`);
      }
    } catch (error: any) {
      logger.error(`[QuickJS] 心跳错误: ${error.message}`);
      
      // 错误隔离：不中断循环
      if ((strategy as any).errorCount > 10) {
        logger.error(`[QuickJS] 错误次数过多，停止策略`);
        clearInterval(heartbeatInterval);
        process.exit(1);
      }
    }
  }, 5000); // 5 秒心跳

  // 6. 优雅退出
  process.on('SIGINT', async () => {
    const runtime = Math.floor((Date.now() - startTime) / 1000);
    logger.info(`\n[QuickJS] [SIGINT] 收到 SIGINT 信号，停止策略... tickCount=${tickCount}, runtime=${runtime}s`);
    clearInterval(heartbeatInterval);

    try {
      // Day2: 停止热更新HTTP API服务
      await hotReloadAPI.stop();
      logger.info('[HotReloadAPI] 服务已停止');
      
      await strategy.onStop(context);
      logger.info('[QuickJS] 策略已停止');
    } catch (e) {
      logger.error('[QuickJS] 停止失败:', e);
    }

    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    const runtime = Math.floor((Date.now() - startTime) / 1000);
    logger.info(`\nQuickJS] [SIGTERM] 收到 SIGTERM 信号，停止策略... tickCount=${tickCount}, runtime=${runtime}s`);
    clearInterval(heartbeatInterval);

    try {
      // Day2: 停止热更新HTTP API服务
      await hotReloadAPI.stop();
      logger.info('[HotReloadAPI] 服务已停止');
      
      await strategy.onStop(context);
      logger.info('[QuickJS] 策略已停止');
    } catch (e) {
      logger.error('[QuickJS] 停止失败:', e);
    }

    process.exit(0);
  });

  // Day2: 热更新signal处理
  process.on('SIGUSR1', async () => {
    logger.info(`\n[QuickJS] [SIGUSR1] 收到热更新信号，触发热重载...`);
    try {
      // 热更新策略层（使用新的reload方法）
      const result = await (strategy as any).reload('SIGUSR1');
      if (result.success) {
        logger.info(`[QuickJS] [SIGUSR1] 热更新完成 ✅ (${result.duration}ms)`);
        logger.info(`[QuickJS] [SIGUSR1] hash: ${result.oldHash} → ${result.newHash}`);
      } else {
        logger.error(`[QuickJS] [SIGUSR1] 热更新失败: ${result.error}`);
      }
    } catch (e) {
      logger.error('[QuickJS] 热更新失败:', e);
    }
  });
}

main().catch((error) => {
  logger.error('[Fatal]', error);
  process.exit(1);
});
