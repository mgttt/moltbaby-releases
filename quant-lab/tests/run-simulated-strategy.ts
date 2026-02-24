#!/usr/bin/env bun
/**
 * SimulatedProvider 策略运行器
 * 
 * 用法:
 *   # 使用内置场景
 *   bun tests/run-simulated-strategy.ts <strategy.js> --scenario range-then-dump --speed 100
 * 
 *   # 使用随机游走
 *   bun tests/run-simulated-strategy.ts <strategy.js> --mode random-walk --speed 50
 * 
 *   # 单步调试
 *   bun tests/run-simulated-strategy.ts <strategy.js> --mode sine --step
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';
import { SimulatedProvider, SCENARIOS } from '../src/providers';
import type { SimulatedProviderConfig } from '../src/providers';

// ============================================================
// 命令行参数解析
// ============================================================

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  showHelp();
  process.exit(0);
}

const strategyFile = args[0];

let mode: 'random-walk' | 'sine' | 'trend' | 'scenario' = 'scenario';
let scenarioName = 'range-then-dump';
let speed = 100;
let stepMode = false;
let onceMode = false;
let startPrice = 100;
let volatility = 0.01;
let amplitude = 0.03;
let trendRate = 0.0001;

// 解析参数
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--scenario' && i + 1 < args.length) {
    mode = 'scenario';
    scenarioName = args[i + 1];
    i++;
  } else if (args[i] === '--mode' && i + 1 < args.length) {
    mode = args[i + 1] as any;
    i++;
  } else if (args[i] === '--speed' && i + 1 < args.length) {
    speed = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--step') {
    stepMode = true;
  } else if (args[i] === '--once') {
    onceMode = true;
  } else if (args[i] === '--price' && i + 1 < args.length) {
    startPrice = parseFloat(args[i + 1]);
    i++;
  } else if (args[i] === '--volatility' && i + 1 < args.length) {
    volatility = parseFloat(args[i + 1]);
    i++;
  }
}

// 验证策略文件
const fullPath = resolve(strategyFile);
if (!existsSync(fullPath)) {
  console.error(`策略文件不存在: ${fullPath}`);
  process.exit(1);
}

// 验证场景
if (mode === 'scenario' && !SCENARIOS[scenarioName]) {
  console.error(`未知场景: ${scenarioName}`);
  console.log(`可用场景: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(1);
}

// ============================================================
// QuickJS 策略引擎
// ============================================================

class QuickJSSimulatedEngine {
  private vm?: Awaited<ReturnType<typeof getQuickJS>>;
  private ctx?: any;
  private provider: SimulatedProvider;
  private strategyFile: string;
  private running = false;
  private state = new Map<string, any>();
  private tickCount = 0;
  private orderIdMap = new Map<string, string>(); // pending → real
  private orderSymbolMap = new Map<string, string>(); // orderId → symbol

  constructor(provider: SimulatedProvider, strategyFile: string) {
    this.provider = provider;
    this.strategyFile = strategyFile;
  }

  async initialize() {
    console.log('[QuickJS] 初始化沙箱...');

    // 创建 VM
    this.vm = await getQuickJS();

    // 创建上下文
    this.ctx = this.vm.newContext({
      interruptHandler: shouldInterruptAfterDeadline(Date.now() + 60000),
    });

    // 注入 bridge API
    this.injectBridge();

    // 加载策略代码
    const code = readFileSync(this.strategyFile, 'utf-8');
    const result = this.ctx.evalCode(code, this.strategyFile);

    if (result.error) {
      const error = this.ctx.dump(result.error);
      result.error.dispose();
      throw new Error(`策略代码执行失败: ${JSON.stringify(error)}`);
    }
    result.value.dispose();

    console.log('[QuickJS] 策略代码加载成功');

    // 调用 st_init
    await this.callFunction('st_init');
    console.log('[QuickJS] 策略初始化完成');
  }

  private injectBridge() {
    // bridge_log
    const bridge_log = this.ctx.newFunction('bridge_log', (levelHandle: any, messageHandle: any) => {
      const level = this.ctx.getString(levelHandle);
      const message = this.ctx.getString(messageHandle);
      console.log(`[Strategy][${level}] ${message}`);
    });
    this.ctx.setProp(this.ctx.global, 'bridge_log', bridge_log);
    bridge_log.dispose();

    // bridge_stateGet/Set
    const bridge_stateGet = this.ctx.newFunction('bridge_stateGet', (keyHandle: any, defaultHandle: any) => {
      const key = this.ctx.getString(keyHandle);
      const defaultValue = this.ctx.getString(defaultHandle);
      const value = this.state.get(key);
      return this.ctx.newString(value !== undefined ? JSON.stringify(value) : defaultValue);
    });
    this.ctx.setProp(this.ctx.global, 'bridge_stateGet', bridge_stateGet);
    bridge_stateGet.dispose();

    const bridge_stateSet = this.ctx.newFunction('bridge_stateSet', (keyHandle: any, valueHandle: any) => {
      const key = this.ctx.getString(keyHandle);
      const valueJson = this.ctx.getString(valueHandle);
      this.state.set(key, JSON.parse(valueJson));
    });
    this.ctx.setProp(this.ctx.global, 'bridge_stateSet', bridge_stateSet);
    bridge_stateSet.dispose();

    // bridge_getPrice
    const bridge_getPrice = this.ctx.newFunction('bridge_getPrice', (symbolHandle: any) => {
      const symbol = this.ctx.getString(symbolHandle);
      const price = this.provider.getCurrentPrice();
      return this.ctx.newString(JSON.stringify({ price, symbol }));
    });
    this.ctx.setProp(this.ctx.global, 'bridge_getPrice', bridge_getPrice);
    bridge_getPrice.dispose();

    // bridge_placeOrder
    const bridge_placeOrder = this.ctx.newFunction('bridge_placeOrder', (paramsHandle: any) => {
      const paramsJson = this.ctx.getString(paramsHandle);
      const params = JSON.parse(paramsJson);
      
      const pendingId = 'pending-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      
      console.log(`[bridge] placeOrder:`, params);
      
      // 调用 Provider 下单
      this.provider.placeOrder(params)
        .then(result => {
          console.log(`[bridge] 下单成功:`, result);
          this.orderIdMap.set(pendingId, result.orderId);
          this.orderSymbolMap.set(result.orderId, params.symbol);
        })
        .catch(err => console.error(`[bridge] 下单失败:`, err.message));
      
      return this.ctx.newString(JSON.stringify({ orderId: pendingId, status: 'pending' }));
    });
    this.ctx.setProp(this.ctx.global, 'bridge_placeOrder', bridge_placeOrder);
    bridge_placeOrder.dispose();

    // bridge_cancelOrder
    const bridge_cancelOrder = this.ctx.newFunction('bridge_cancelOrder', (orderIdHandle: any) => {
      const orderId = this.ctx.getString(orderIdHandle);
      
      let realOrderId = orderId;
      if (orderId.startsWith('pending-')) {
        realOrderId = this.orderIdMap.get(orderId) || orderId;
      }
      
      const symbol = this.orderSymbolMap.get(realOrderId) || 'SIM/USDT';
      
      console.log(`[bridge] cancelOrder: ${realOrderId} (${symbol})`);
      
      this.provider.cancelOrder(symbol, realOrderId)
        .then(() => {
          console.log(`[bridge] 撤单成功: ${realOrderId}`);
          this.orderSymbolMap.delete(realOrderId);
        })
        .catch(err => console.error(`[bridge] 撤单失败:`, err.message));
      
      return this.ctx.newString(JSON.stringify({ success: true, orderId: realOrderId }));
    });
    this.ctx.setProp(this.ctx.global, 'bridge_cancelOrder', bridge_cancelOrder);
    bridge_cancelOrder.dispose();

    // 注入 ctx.strategy.params
    const ctxHandle = this.ctx.newObject();
    const strategyHandle = this.ctx.newObject();
    const paramsHandle = this.ctx.newString(JSON.stringify({
      symbol: 'SIM/USDT',
      gridCount: 5,
      simMode: false,
    }));

    this.ctx.setProp(strategyHandle, 'id', this.ctx.newString('simulated-test'));
    this.ctx.setProp(strategyHandle, 'params', paramsHandle);
    this.ctx.setProp(ctxHandle, 'strategy', strategyHandle);
    this.ctx.setProp(this.ctx.global, 'ctx', ctxHandle);

    ctxHandle.dispose();
    strategyHandle.dispose();
    paramsHandle.dispose();
  }

  async start() {
    this.running = true;
    console.log('[QuickJS] 策略启动...');

    // 监听订单成交
    this.provider.onOrder((order: any) => {
      console.log(`[QuickJS] 订单更新:`, order);
      this.callFunction('st_onOrderUpdate', order).catch(() => {});
    });

    // 监听价格变化
    this.provider.onPrice((price: number) => {
      this.tickCount++;
      
      // 每 10 个 tick 调用一次心跳
      if (this.tickCount % 10 === 0) {
        const tick = {
          count: this.tickCount,
          timestamp: Math.floor(Date.now() / 1000),
          price,
          volume: 1000,
        };
        
        this.callFunction('st_heartbeat', tick).catch(err => {
          console.error('[QuickJS] 心跳错误:', err.message);
        });
      }
    });

    // 启动 Provider
    this.provider.start();
  }

  stop() {
    this.running = false;
    this.provider.stop();
    console.log('[QuickJS] 策略停止');

    // 调用 st_stop
    this.callFunction('st_stop').catch(() => {});

    // 清理
    if (this.ctx) {
      this.ctx.dispose();
      this.ctx = undefined;
    }
  }

  private async callFunction(name: string, ...args: any[]): Promise<any> {
    if (!this.ctx) return;

    const fnHandle = this.ctx.getProp(this.ctx.global, name);
    const fnType = this.ctx.typeof(fnHandle);

    if (fnType !== 'function') {
      fnHandle.dispose();
      return;
    }

    const argHandles = args.map((arg: any) => this.ctx.newString(JSON.stringify(arg)));
    const result = this.ctx.callFunction(fnHandle, this.ctx.undefined, ...argHandles);

    fnHandle.dispose();
    argHandles.forEach((h: any) => h.dispose());

    if (result.error) {
      const error = this.ctx.dump(result.error);
      result.error.dispose();
      throw new Error(`策略函数 ${name} 执行失败: ${JSON.stringify(error)}`);
    }

    const value = this.ctx.dump(result.value);
    result.value.dispose();

    return value;
  }
}

// ============================================================
// 主程序
// ============================================================

async function main() {
  console.log('='.repeat(70));
  console.log(`   SimulatedProvider 策略测试`);
  console.log('='.repeat(70));
  console.log();

  // 配置 Provider
  const config: SimulatedProviderConfig = {
    mode,
    startPrice,
    speed,
    tickIntervalMs: 1000,
    symbol: 'SIM/USDT',
  };

  if (mode === 'scenario') {
    const scenario = SCENARIOS[scenarioName];
    config.scenario = scenario;
    console.log(`[场景] ${scenario.name}`);
    console.log(`  描述: ${scenario.description}`);
    console.log(`  阶段数: ${scenario.phases.length}`);
  } else if (mode === 'random-walk') {
    config.volatility = volatility;
  } else if (mode === 'sine') {
    config.amplitude = amplitude;
  } else if (mode === 'trend') {
    config.trendRate = trendRate;
  }

  console.log();
  console.log('[配置]', {
    mode,
    startPrice,
    speed: `${speed}x`,
    stepMode,
    onceMode,
  });
  console.log();

  // 创建 Provider
  const provider = new SimulatedProvider(config);

  // 创建策略引擎
  const engine = new QuickJSSimulatedEngine(provider, fullPath);

  // 初始化
  await engine.initialize();

  console.log();
  console.log('[按 Ctrl+C 停止]');
  console.log();

  // 启动
  await engine.start();

  // onceMode: 场景完成后自动停止
  if (onceMode) {
    let completedTicks = 0;
    const maxTicks = 1000; // 最多运行 1000 ticks
    
    provider.onPrice(() => {
      completedTicks++;
      if (completedTicks >= maxTicks) {
        console.log('\n[场景完成] 自动停止...');
        engine.stop();
        process.exit(0);
      }
    });
  }

  // 优雅停止
  process.on('SIGINT', () => {
    console.log('\n[停止] 清理中...');
    engine.stop();
    process.exit(0);
  });

  // 阻塞
  await new Promise(() => {});
}

function showHelp() {
  console.log(`
用法:
  bun tests/run-simulated-strategy.ts <strategy.js> [options]

选项:
  --scenario <name>    使用内置场景（默认: range-then-dump）
  --mode <mode>        模式: random-walk/sine/trend/scenario（默认: scenario）
  --speed <number>     时间倍速（默认: 100）
  --price <number>     起始价格（默认: 100）
  --volatility <num>   波动率（random-walk 模式，默认: 0.01）
  --step               单步调试模式
  --once               场景完成后自动停止（不循环）

内置场景:
  ${Object.keys(SCENARIOS).map(k => `  ${k.padEnd(20)} - ${SCENARIOS[k].description}`).join('\n  ')}

示例:
  # 使用内置场景
  bun tests/run-simulated-strategy.ts ./strategies/grid/gales-simple.js --scenario range-then-dump --speed 100

  # 使用随机游走
  bun tests/run-simulated-strategy.ts ./strategies/grid/gales-simple.js --mode random-walk --speed 50

  # 正弦波动
  bun tests/run-simulated-strategy.ts ./strategies/grid/gales-simple.js --mode sine --speed 200
`);
}

// 启动
main().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});
