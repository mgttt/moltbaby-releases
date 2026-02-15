#!/usr/bin/env bun
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
 *   bun tests/run-strategy-generic.ts ./strategies/gales-simple.js
 *   
 *   # 实盘模式
 *   DRY_RUN=false bun tests/run-strategy-generic.ts ./strategies/gales-simple.js --live
 *   
 *   # Demo Trading 模式
 *   bun tests/run-strategy-generic.ts ./strategies/gales-simple.js --demo '{"symbol":"MYXUSDT"}'
 *   
 *   # 自定义参数
 *   bun tests/run-strategy-generic.ts ./strategies/gales-simple.js --live '{"gridCount":10}' bybit wjcgm@bbt-sub1
 */

import { QuickJSStrategy } from '../src/sandbox/QuickJSStrategy';
import { BybitProvider } from '../src/providers/bybit';
import { BybitStrategyContext } from '../src/contexts/BybitStrategyContext';
import { existsSync } from 'fs';

// ================================
// 参数解析
// ================================

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('用法: run-strategy-generic.ts <strategy-file> [--live] [params-json] [exchange] [account]');
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
  console.error(`策略文件不存在: ${strategyFile}`);
  process.exit(1);
}

// 解析参数
let params;
try {
  params = JSON.parse(paramsJson);
} catch (e) {
  console.error(`参数 JSON 格式错误: ${e}`);
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
    console.error(`无法读取账号配置: ${configPath}`);
    return {};
  }
}

const ACCOUNTS = loadAccounts();

// ================================
// 主流程
// ================================

async function main() {
  console.log('======================================================================');
  console.log('   通用策略启动器');
  console.log('======================================================================\n');

  // 检查 DRY_RUN 环境变量
  const isDryRun = process.env.DRY_RUN !== 'false';

  console.log('[配置]', {
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
      console.error('❌ [P0 fail-fast] --live 模式但 DRY_RUN=true（纸盘）');
      console.error('   如确实需要在live模式使用纸盘，请设置环境变量:');
      console.error('   ALLOW_PAPER_ON_LIVE=true bun tests/run-strategy-generic.ts ...');
      console.error('   否则请设置 DRY_RUN=false 启用真实订单流');
      process.exit(1);
    }
    console.warn('⚠️  [ALLOW_PAPER_ON_LIVE] --live 模式但 DRY_RUN=true，将使用 Paper Trade');
  }

  if (liveMode && !isDryRun) {
    console.warn('🔴 [实盘模式] 连接真实订单流！');
  }

  if (demoMode) {
    console.warn('🟡 [Demo Trading 模式] 使用 api-demo.bybit.com');
  }

  // 1. 初始化交易所连接
  let provider: any;

  if (exchange === 'bybit') {
    if (demoMode) {
      // Demo Trading 模式：使用环境变量中的 Demo API Key
      const demoApiKey = process.env.BYBIT_DEMO_API_KEY;
      const demoApiSecret = process.env.BYBIT_DEMO_API_SECRET;
      
      if (!demoApiKey || !demoApiSecret) {
        console.error('错误: Demo 模式需要设置 BYBIT_DEMO_API_KEY 和 BYBIT_DEMO_API_SECRET 环境变量');
        process.exit(1);
      }

      provider = new BybitProvider({
        apiKey: demoApiKey,
        apiSecret: demoApiSecret,
        demo: true,
        proxy: 'http://127.0.0.1:8890',
        category: 'linear',
      });

      console.log('[Exchange] Bybit Provider 初始化完成 (Demo Trading)\n');
    } else {
      const accountConfig = ACCOUNTS[accountId as keyof typeof ACCOUNTS];
      if (!accountConfig) {
        console.error(`未找到账号配置: ${accountId}`);
        process.exit(1);
      }

      provider = new BybitProvider({
        apiKey: accountConfig.apiKey,
        apiSecret: accountConfig.apiSecret,
        testnet: accountConfig.testnet || false,
        proxy: accountConfig.proxy || 'http://127.0.0.1:8890',
        category: 'linear',
      });

      console.log(`[Exchange] Bybit Provider 初始化完成 (${accountId})\n`);
    }
  } else {
    console.error(`暂不支持的交易所: ${exchange}`);
    process.exit(1);
  }

  // 2. 获取交易对（从参数或默认）
  const symbol = params.symbol || 'MYXUSDT';

  // 3. 创建策略实例
  const strategy = new QuickJSStrategy({
    strategyId: `gales-${symbol}-${Date.now()}`,
    strategyFile,
    params,
    maxRetries: 3,
    retryDelayMs: 5000,
    hotReload: true,  // 启用热重载
  });

  // 4. 创建 BybitStrategyContext 并初始化策略
  console.log('[QuickJS] 创建策略上下文（BybitStrategyContext）...');
  
  const context = new BybitStrategyContext({
    provider,
    symbol,
    qtyStep: 1,      // MYX 规格
    tickSize: 0.001, // MYX 规格
    minQty: 1,       // MYX 规格
  });
  
  console.log('[QuickJS] 初始化沙箱...');
  await strategy.onInit(context);
  console.log('[QuickJS] 策略初始化完成\n');

  if (liveMode && !isDryRun) {
    console.log('🔴 [实盘模式] 订单将发送到交易所\n');
  } else {
    console.log(`⚠️  [Paper Trade] 模拟模式（策略内需实现 simMode 逻辑）\n`);
  }

  console.log('[按 Ctrl+C 停止]\n');

  // 5. 启动心跳循环
  console.log('[QuickJS] 策略启动...');

  let tickCount = 0;

  const heartbeatInterval = setInterval(async () => {
    try {
      tickCount++;

      // 获取真实价格
      const ticker = await provider.getTicker(symbol);
      const price = ticker.lastPrice;

      // 每 10 次心跳输出一次
      if (tickCount % 10 === 0) {
        console.log(`[QuickJS] 心跳 #${tickCount} - 价格: ${price}`);
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
        console.error(`[QuickJS] strategy.onTick 不存在! typeof=${typeof strategy.onTick}`);
      }
    } catch (error: any) {
      console.error(`[QuickJS] 心跳错误: ${error.message}`);
      
      // 错误隔离：不中断循环
      if ((strategy as any).errorCount > 10) {
        console.error(`[QuickJS] 错误次数过多，停止策略`);
        clearInterval(heartbeatInterval);
        process.exit(1);
      }
    }
  }, 5000); // 5 秒心跳

  // 6. 优雅退出
  process.on('SIGINT', async () => {
    console.log('\n[QuickJS] 正在停止策略...');
    clearInterval(heartbeatInterval);

    try {
      await strategy.onStop(context);
      console.log('[QuickJS] 策略已停止');
    } catch (e) {
      console.error('[QuickJS] 停止失败:', e);
    }

    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[QuickJS] 收到 SIGTERM，停止策略...');
    clearInterval(heartbeatInterval);

    try {
      await strategy.onStop(context);
      console.log('[QuickJS] 策略已停止');
    } catch (e) {
      console.error('[QuickJS] 停止失败:', e);
    }

    process.exit(0);
  });
}

main().catch((error) => {
  console.error('[Fatal]', error);
  process.exit(1);
});
