#!/usr/bin/env bun
/**
 * 策略参数扫描工具 (Param Sweep)
 *
 * 基于 BacktestEngine，串行运行多组参数回测，输出排名表
 *
 * 用法:
 *   bun run param-sweep.ts --symbol MYXUSDT --days 30
 *
 * 参数:
 *   --symbol    交易品种 (默认: MYXUSDT)
 *   --days      回测天数 (默认: 30)
 *   --interval  K线周期 (默认: 1h)
 *   --spacing   网格间距范围，逗号分隔 (默认: 0.01,0.015,0.02,0.025,0.03)
 *   --orderSize 订单大小范围，逗号分隔 (默认: 25,50,75,100)
 *   --output    输出文件路径 (默认: stdout)
 *
 * 示例:
 *   bun run param-sweep.ts --symbol MYXUSDT --days 30 --spacing 0.01,0.02 --orderSize 50,100
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { KlineDatabase } from '../../../quant-lib/src';
import { QuickJSBacktestEngine } from '../engine/quickjs-backtest';

// ============================================================
// 类型定义
// ============================================================

interface ParamSet {
  spacing: number;
  orderSize: number;
  magnetDistance: number;  // [P1] 新增磁铁距离参数
}

interface SweepResult {
  params: ParamSet;
  sharpeRatio: number;
  totalPnL: number;
  maxDrawdown: number;
  winRate: number;
  totalTrades: number;
  annualizedReturn: number;
  profitFactor: number;
}

// ============================================================
// 命令行参数解析
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  let symbol = 'MYXUSDT';
  let days = 30;
  let interval = '1h';
  let spacingRange = '0.01,0.015,0.02,0.025,0.03';
  let orderSizeRange = '25,50,75,100';
  let magnetDistanceRange = '0.01,0.015,0.02';  // [P1] 新增magnetDistance参数
  let output: string | undefined;
  let direction = 'neutral';  // [P2] 新增direction参数
  let proxy: string | undefined;  // [P2] 新增proxy参数

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--symbol':
        symbol = args[++i];
        break;
      case '--days':
        days = parseInt(args[++i], 10);
        break;
      case '--interval':
        interval = args[++i];
        break;
      case '--spacing':
        spacingRange = args[++i];
        break;
      case '--orderSize':
        orderSizeRange = args[++i];
        break;
      case '--magnetDistance':  // [P1] 处理magnetDistance参数
        magnetDistanceRange = args[++i];
        break;
      case '--output':
      case '-o':
        output = args[++i];
        break;
      case '--direction':  // [P2] 处理direction参数
        direction = args[++i];
        break;
      case '--proxy':  // [P2] 处理proxy参数
        proxy = args[++i];
        break;
    }
  }

  const spacings = spacingRange.split(',').map(s => parseFloat(s.trim()));
  const orderSizes = orderSizeRange.split(',').map(s => parseInt(s.trim(), 10));
  const magnetDistances = magnetDistanceRange.split(',').map(s => parseFloat(s.trim()));  // [P1] 解析magnetDistance

  return {
    symbol,
    days,
    interval,
    spacings,
    orderSizes,
    magnetDistances,  // [P1] 新增
    output,
    direction,
    proxy,
  };
}

function showHelp() {
  console.log(`
策略参数扫描工具 (Param Sweep)

用法:
  bun run param-sweep.ts --symbol MYXUSDT --days 30

参数:
  --symbol         交易品种 (默认: MYXUSDT)
  --days           回测天数 (默认: 30)
  --interval       K线周期 (默认: 1h)
  --spacing        网格间距范围，逗号分隔 (默认: 0.01,0.015,0.02,0.025,0.03)
  --orderSize      订单大小范围，逗号分隔 (默认: 25,50,75,100)
  --magnetDistance 磁铁距离范围，逗号分隔 (默认: 0.01,0.015,0.02)  [P1新增]
  --direction      策略方向 (默认: neutral, 可选: long/short/neutral)
  --proxy          代理服务器 (默认: http://127.0.0.1:8890)
  --output         输出文件路径，支持.json格式 (默认: stdout)

示例:
  bun run param-sweep.ts --symbol MYXUSDT --days 30
  bun run param-sweep.ts --symbol BTCUSDT --days 60 --spacing 0.005,0.01,0.015
  bun run param-sweep.ts --symbol MYXUSDT --days 3 --direction short --proxy http://127.0.0.1:8890 --output /tmp/results.json
`);
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 标准化交易对符号：MYXUSDT → MYX/USDT
 * 与 BybitCurlProvider.normalizeSymbol 保持一致
 */
function normalizeSymbol(symbol: string): string {
  if (symbol.includes('/')) return symbol;

  if (symbol.endsWith('USDT')) {
    const base = symbol.replace('USDT', '');
    return `${base}/USDT`;
  }

  if (symbol.endsWith('USD')) {
    const base = symbol.replace('USD', '');
    return `${base}/USD`;
  }

  return `${symbol}/USDT`;
}

// ============================================================
// 参数组合生成
// ============================================================

function generateParamCombinations(spacings: number[], orderSizes: number[], magnetDistances: number[]): ParamSet[] {
  const combinations: ParamSet[] = [];
  for (const spacing of spacings) {
    for (const orderSize of orderSizes) {
      for (const magnetDistance of magnetDistances) {  // [P1] 新增magnetDistance维度
        combinations.push({ spacing, orderSize, magnetDistance });
      }
    }
  }
  return combinations;
}

// ============================================================
// 数据准备
// ============================================================

async function prepareData(
  db: KlineDatabase,
  symbol: string,
  interval: string,
  days: number
): Promise<{ startTime: number; endTime: number; count: number; dataAvailable: boolean }> {
  const endTimeSec = Math.floor(Date.now() / 1000);
  const startTimeSec = endTimeSec - days * 24 * 60 * 60;
  const normalizedSymbol = normalizeSymbol(symbol);

  // 检查数据库中是否有足够数据（时间戳转换为毫秒）
  const existing = await db.queryKlines({
    symbol: normalizedSymbol,
    interval,
    startTime: startTimeSec * 1000,
    endTime: endTimeSec * 1000,
  });

  if (existing.length < days * 0.8) {
    console.log(`[ParamSweep] 数据库中 ${normalizedSymbol} ${interval} 数据不足 (${existing.length} 条)，尝试从交易所拉取...`);

    // 尝试从 Bybit 拉取数据
    try {
      const { BybitCurlProvider } = await import('../../../quant-lib/src/providers/bybit-curl');
      const provider = new BybitCurlProvider({
        proxy: 'http://127.0.0.1:8890',
        timeout: 30,
        category: 'linear',
      });

      const limit = Math.min(days * 24, 1000); // 最多1000条
      const klines = await provider.getKlines({ symbol, interval, limit });

      // 存入数据库（klines已包含normalized symbol和interval属性）
      await db.insertKlines(klines);
      console.log(`[ParamSweep] 成功拉取并存储 ${klines.length} 条K线数据`);
    } catch (e) {
      console.warn(`[ParamSweep] 拉取数据失败: ${e}`);
    }
  }

  // 查询最终数据（时间戳转换为毫秒）
  const finalData = await db.queryKlines({
    symbol: normalizedSymbol,
    interval,
    startTime: startTimeSec * 1000,
    endTime: endTimeSec * 1000,
  });
  const dataAvailable = finalData.length >= days * 0.5; // 至少50%数据才算可用

  if (!dataAvailable) {
    console.warn(`[ParamSweep] 警告: 仅获取到 ${finalData.length} 条K线，不足以进行有效回测`);
  }

  return { startTime: startTimeSec, endTime: endTimeSec, count: finalData.length, dataAvailable };
}

// ============================================================
// 串行回测执行（使用 QuickJSBacktestEngine）
// ============================================================

async function runSerialBacktests(
  combinations: ParamSet[],
  symbol: string,
  days: number,
  interval: string,
  db: KlineDatabase,
  dbPath: string,
  direction: string = 'neutral',  // [P2] 新增direction参数
  proxy?: string  // [P2] 新增proxy参数
): Promise<SweepResult[]> {
  const results: SweepResult[] = [];

  console.log(`[ParamSweep] 使用 QuickJSBacktestEngine 串行模式`);
  console.log(`[ParamSweep] 总共 ${combinations.length} 组参数待测试`);
  console.log('');

  // 计算日期范围
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
  const fromDate = startDate.toISOString().split('T')[0];
  const toDate = endDate.toISOString().split('T')[0];

  // 检查数据可用性
  const endTimeSec = Math.floor(Date.now() / 1000);
  const startTimeSec = endTimeSec - days * 24 * 60 * 60;
  const normalizedSymbol = normalizeSymbol(symbol);
  const klines = await db.queryKlines({
    symbol: normalizedSymbol,
    interval,
    startTime: startTimeSec * 1000,
    endTime: endTimeSec * 1000,
  });

  if (klines.length === 0) {
    console.warn('[ParamSweep] 警告: 没有可用的K线数据');
    return results;
  }

  console.log(`[ParamSweep] 数据范围: ${fromDate} ~ ${toDate} (${klines.length} 条K线)`);
  console.log('');

  // 遍历参数组合，每组使用 QuickJSBacktestEngine 运行
  // 第1个engine会从Bybit拉取+存到quant-lab/data/klines.db，后续复用本地缓存
  for (let i = 0; i < combinations.length; i++) {
    const params = combinations[i];

    try {
      // 创建 QuickJSBacktestEngine 实例（都传proxy，第1个拉取，后续复用缓存）
      const engine = new QuickJSBacktestEngine({
        strategyPath: 'strategies/gales-simple.js',
        symbol: normalizedSymbol,
        from: fromDate,
        to: toDate,
        interval: '1m',
        initialBalance: 10000,
        direction: direction,  // [P2] 使用传入的direction参数
        proxy: proxy || 'http://127.0.0.1:8890',  // [P2] 使用传入的proxy参数
        dbPath,
      });

      // 初始化引擎（第1个会拉取数据，后续直接读缓存）
      await engine.initialize();

      // [P2] 覆盖策略参数 - 通过修改策略的 params
      // 注意：QuickJSBacktestEngine 在 initialize 时创建策略，我们需要在 initialize 后修改策略参数
      // 通过策略实例的 params 属性覆盖
      const strategy = (engine as any).strategy;
      if (strategy && strategy.config && strategy.config.params) {
        strategy.config.params.gridSpacing = params.spacing;
        strategy.config.params.orderSize = params.orderSize;
        strategy.config.params.magnetDistance = params.magnetDistance;  // [P1] 覆盖magnetDistance
        strategy.config.params.gridSpacingUp = params.spacing;
        strategy.config.params.gridSpacingDown = params.spacing;
        strategy.config.params.orderSizeUp = params.orderSize;
        strategy.config.params.orderSizeDown = params.orderSize;
      }

      // 运行回测
      const backtestResult = await engine.run();

      // [P1] 清理资源，释放 QuickJS VM 内存
      await engine.cleanup();

      // 转换为 SweepResult 格式
      const result: SweepResult = {
        params,
        sharpeRatio: backtestResult.sharpeRatio || 0,
        totalPnL: (backtestResult.finalBalance - backtestResult.initialBalance),
        maxDrawdown: backtestResult.maxDrawdown || 0,
        winRate: backtestResult.totalTrades > 0
          ? backtestResult.winningTrades / backtestResult.totalTrades
          : 0,
        totalTrades: backtestResult.totalTrades,
        annualizedReturn: backtestResult.totalReturn * (365 / days),
        profitFactor: backtestResult.winningTrades > 0 && backtestResult.losingTrades > 0
          ? (backtestResult.winningTrades / backtestResult.totalTrades) / (backtestResult.losingTrades / backtestResult.totalTrades)
          : 0,
      };

      results.push(result);
      console.log(`[${i + 1}/${combinations.length}] spacing=${params.spacing.toFixed(3)} orderSize=${params.orderSize.toString().padStart(3)} magnet=${params.magnetDistance.toFixed(3)} → Sharpe=${result.sharpeRatio.toFixed(2)} PnL=${result.totalPnL.toFixed(2)} maxDD=${(result.maxDrawdown * 100).toFixed(1)}% winRate=${(result.winRate * 100).toFixed(1)}%`);
    } catch (e) {
      console.warn(`[${i + 1}/${combinations.length}] spacing=${params.spacing} orderSize=${params.orderSize} magnet=${params.magnetDistance} → 失败: ${e}`);
    }
  }

  return results;
}

// ============================================================
// 结果输出
// ============================================================

function formatResultsTable(results: SweepResult[]): string {
  // 按 Sharpe 排序
  const sorted = [...results].sort((a, b) => b.sharpeRatio - a.sharpeRatio);

  const lines: string[] = [];
  lines.push('='.repeat(100));
  lines.push('                           参数扫描结果排名表 (按 Sharpe 排序)');
  lines.push('='.repeat(110));
  lines.push('');
  lines.push('排名 | spacing | orderSize | magnetDist | Sharpe |   PnL   | maxDD  | winRate | trades | annRet | profitFactor');
  lines.push('-----|---------|-----------|------------|--------|---------|--------|---------|--------|--------|------------');

  sorted.forEach((r, i) => {
    const rank = (i + 1).toString().padStart(2);
    const spacing = r.params.spacing.toFixed(3).padStart(7);
    const orderSize = r.params.orderSize.toString().padStart(9);
    const magnetDist = r.params.magnetDistance.toFixed(3).padStart(10);
    const sharpe = r.sharpeRatio.toFixed(2).padStart(6);
    const pnl = r.totalPnL.toFixed(2).padStart(7);
    const maxDD = (r.maxDrawdown * 100).toFixed(1).padStart(5) + '%';
    const winRate = (r.winRate * 100).toFixed(1).padStart(6) + '%';
    const trades = r.totalTrades.toString().padStart(6);
    const annRet = (r.annualizedReturn * 100).toFixed(1).padStart(6) + '%';
    const pf = r.profitFactor.toFixed(2).padStart(10);

    lines.push(`${rank}   | ${spacing} | ${orderSize} | ${magnetDist} | ${sharpe} | ${pnl} | ${maxDD} | ${winRate} | ${trades} | ${annRet} | ${pf}`);
  });

  lines.push('');
  lines.push('='.repeat(110));

  // 最佳参数
  if (sorted.length > 0) {
    const best = sorted[0];
    lines.push('');
    lines.push('🏆 最佳参数组合:');
    lines.push(`   spacing: ${best.params.spacing}`);
    lines.push(`   orderSize: ${best.params.orderSize}`);
    lines.push(`   magnetDistance: ${best.params.magnetDistance}`);
    lines.push(`   Sharpe: ${best.sharpeRatio.toFixed(2)}`);
    lines.push(`   总收益: ${best.totalPnL.toFixed(2)} USDT`);
    lines.push(`   最大回撤: ${(best.maxDrawdown * 100).toFixed(1)}%`);
    lines.push(`   胜率: ${(best.winRate * 100).toFixed(1)}%`);
  }

  return lines.join('\n');
}

function formatResultsCSV(results: SweepResult[]): string {
  const lines: string[] = [];
  lines.push('rank,spacing,orderSize,magnetDistance,sharpeRatio,totalPnL,maxDrawdown,winRate,totalTrades,annualizedReturn,profitFactor');

  const sorted = [...results].sort((a, b) => b.sharpeRatio - a.sharpeRatio);
  sorted.forEach((r, i) => {
    lines.push(`${i + 1},${r.params.spacing},${r.params.orderSize},${r.params.magnetDistance},${r.sharpeRatio},${r.totalPnL},${r.maxDrawdown},${r.winRate},${r.totalTrades},${r.annualizedReturn},${r.profitFactor}`);
  });

  return lines.join('\n');
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  const args = parseArgs();

  console.log('='.repeat(60));
  console.log('          策略参数扫描工具 (Param Sweep)');
  console.log('='.repeat(60));
  console.log('');
  console.log(`交易品种: ${args.symbol}`);
  console.log(`回测周期: ${args.days} 天`);
  console.log(`K线间隔: ${args.interval}`);
  console.log(`网格间距: [${args.spacings.join(', ')}]`);
  console.log(`订单大小: [${args.orderSizes.join(', ')}]`);
  console.log(`磁铁距离: [${args.magnetDistances.join(', ')}]`);  // [P1] 新增
  console.log(`参数组合: ${args.spacings.length * args.orderSizes.length * args.magnetDistances.length} 组`);  // [P1] 更新计算
  console.log('');

  // 生成参数组合
  const combinations = generateParamCombinations(args.spacings, args.orderSizes, args.magnetDistances);  // [P1] 传递magnetDistances

  // 初始化数据库
  const dbPath = resolve(process.cwd(), 'data', 'klines.db');
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }
  const db = new KlineDatabase(dbPath);

  try {
    // 准备数据
    console.log('[ParamSweep] 准备数据...');
    const dataInfo = await prepareData(db, args.symbol, args.interval, args.days);

    if (!dataInfo.dataAvailable) {
      console.log('');
      console.log('[ParamSweep] ⚠️ 数据不足，无法继续回测');
      console.log(`[ParamSweep] 仅获取到 ${dataInfo.count} 条K线，需要至少 ${Math.floor(args.days * 24 * 0.5)} 条`);
      console.log('[ParamSweep] 建议: 检查数据库连接或尝试其他交易品种');
      return;
    }

    console.log(`[ParamSweep] 数据准备完成: ${dataInfo.count} 条K线`);
    console.log('');

    // 执行回测
    const results = await runSerialBacktests(combinations, args.symbol, args.days, args.interval, db, dbPath, args.direction, args.proxy);

    if (results.length === 0) {
      console.log('');
      console.log('[ParamSweep] ⚠️ 没有成功完成任何回测');
      return;
    }

    // 输出结果
    const tableOutput = formatResultsTable(results);
    const csvOutput = formatResultsCSV(results);

    if (args.output) {
      const outputPath = resolve(args.output);
      const outputDir = dirname(outputPath);
      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
      }

      // [P2] 根据文件扩展名判断输出格式
      if (outputPath.endsWith('.json')) {
        // JSON格式 - 直接序列化 SweepResult[]
        writeFileSync(outputPath, JSON.stringify(results, null, 2));
        console.log('');
        console.log(`[ParamSweep] JSON结果已保存: ${outputPath}`);
      } else {
        // 文本和 CSV 格式
        writeFileSync(outputPath, tableOutput);
        writeFileSync(outputPath.replace(/\.txt$/, '.csv').replace(/\.md$/, '.csv'), csvOutput);
        console.log('');
        console.log(`[ParamSweep] 结果已保存: ${outputPath}`);
      }
    } else {
      console.log('');
      console.log(tableOutput);
    }

    // 输出 CSV 到 stdout（方便管道处理）
    console.log('');
    console.log('--- CSV 格式 ---');
    console.log(csvOutput);

  } finally {
    await db.close();
  }
}

main().catch(err => {
  console.error('[ParamSweep] 错误:', err);
  process.exit(1);
});
