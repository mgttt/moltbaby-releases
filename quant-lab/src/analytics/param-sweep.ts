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

// ============================================================
// 类型定义
// ============================================================

interface ParamSet {
  spacing: number;
  orderSize: number;
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
  let output: string | undefined;

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
      case '--output':
      case '-o':
        output = args[++i];
        break;
    }
  }

  const spacings = spacingRange.split(',').map(s => parseFloat(s.trim()));
  const orderSizes = orderSizeRange.split(',').map(s => parseInt(s.trim(), 10));

  return {
    symbol,
    days,
    interval,
    spacings,
    orderSizes,
    output,
  };
}

function showHelp() {
  console.log(`
策略参数扫描工具 (Param Sweep)

用法:
  bun run param-sweep.ts --symbol MYXUSDT --days 30

参数:
  --symbol    交易品种 (默认: MYXUSDT)
  --days      回测天数 (默认: 30)
  --interval  K线周期 (默认: 1h)
  --spacing   网格间距范围，逗号分隔 (默认: 0.01,0.015,0.02,0.025,0.03)
  --orderSize 订单大小范围，逗号分隔 (默认: 25,50,75,100)
  --output    输出文件路径 (默认: stdout)

示例:
  bun run param-sweep.ts --symbol MYXUSDT --days 30
  bun run param-sweep.ts --symbol BTCUSDT --days 60 --spacing 0.005,0.01,0.015
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

function generateParamCombinations(spacings: number[], orderSizes: number[]): ParamSet[] {
  const combinations: ParamSet[] = [];
  for (const spacing of spacings) {
    for (const orderSize of orderSizes) {
      combinations.push({ spacing, orderSize });
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
// 单组参数回测
// ============================================================

async function runSingleBacktest(
  params: ParamSet,
  klines: any[],
  days: number
): Promise<SweepResult> {
  const initialCapital = 10000;
  let capital = initialCapital;
  let position = 0;
  let maxCapital = initialCapital;
  let maxDrawdown = 0;
  let trades = 0;
  let winningTrades = 0;
  let totalPnL = 0;
  let winningAmount = 0;
  let losingAmount = 0;

  const equityCurve: number[] = [];

  // 生成网格线
  const prices = klines.map((k: any) => k.close);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);

  const gridLines: number[] = [];
  let price = minPrice;
  while (price <= maxPrice * 1.1) {
    gridLines.push(price);
    price = price * (1 + params.spacing);
  }

  let lastGridIndex: number | null = null;
  const feeRate = 0.0006;

  for (let i = 1; i < klines.length; i++) {
    const prevPrice = klines[i - 1].close;
    const currPrice = klines[i].close;

    for (let j = 0; j < gridLines.length; j++) {
      const gridPrice = gridLines[j];

      if ((prevPrice <= gridPrice && currPrice >= gridPrice) ||
          (prevPrice >= gridPrice && currPrice <= gridPrice)) {

        if (lastGridIndex !== null && Math.abs(j - lastGridIndex) < 1) {
          continue;
        }

        const isUp = currPrice > prevPrice;
        const side = isUp ? 'SELL' : 'BUY';
        const qty = params.orderSize / gridPrice;

        if (side === 'BUY') {
          const cost = qty * gridPrice * (1 + feeRate);
          if (capital >= cost) {
            capital -= cost;
            position += qty;
            trades++;
            lastGridIndex = j;
          }
        } else {
          if (position >= qty) {
            const revenue = qty * gridPrice * (1 - feeRate);
            const entryCost = qty * gridPrice;
            const pnl = revenue - entryCost * (1 + feeRate);

            capital += revenue;
            position -= qty;
            trades++;
            totalPnL += pnl;

            if (pnl > 0) {
              winningTrades++;
              winningAmount += pnl;
            } else {
              losingAmount += Math.abs(pnl);
            }

            lastGridIndex = j;
          }
        }
      }
    }

    const equity = capital + position * currPrice;
    equityCurve.push(equity);

    if (equity > maxCapital) {
      maxCapital = equity;
    }

    const drawdown = (maxCapital - equity) / maxCapital;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  const finalEquity = equityCurve[equityCurve.length - 1] || initialCapital;
  const totalReturn = (finalEquity - initialCapital) / initialCapital;
  const annualizedReturn = totalReturn * (365 / days);

  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    returns.push((equityCurve[i] - equityCurve[i - 1]) / equityCurve[i - 1]);
  }
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length || 0;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length || 0;
  const stdDev = Math.sqrt(variance) || 1;
  const sharpeRatio = avgReturn / stdDev * Math.sqrt(365 * 24);

  const winRate = trades > 0 ? winningTrades / trades : 0;
  const profitFactor = losingAmount > 0 ? winningAmount / losingAmount : 0;

  return {
    params,
    sharpeRatio: isFinite(sharpeRatio) ? sharpeRatio : 0,
    totalPnL,
    maxDrawdown,
    winRate,
    totalTrades: trades,
    annualizedReturn,
    profitFactor: isFinite(profitFactor) ? profitFactor : 0,
  };
}

// ============================================================
// 串行回测执行
// ============================================================

async function runSerialBacktests(
  combinations: ParamSet[],
  symbol: string,
  days: number,
  interval: string,
  db: KlineDatabase
): Promise<SweepResult[]> {
  const results: SweepResult[] = [];
  
  console.log(`[ParamSweep] 使用串行模式`);
  console.log(`[ParamSweep] 总共 ${combinations.length} 组参数待测试`);
  console.log('');

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

  for (let i = 0; i < combinations.length; i++) {
    const params = combinations[i];
    
    try {
      const result = await runSingleBacktest(params, klines, days);
      results.push(result);
      console.log(`[${i + 1}/${combinations.length}] spacing=${params.spacing.toFixed(3)} orderSize=${params.orderSize.toString().padStart(3)} → Sharpe=${result.sharpeRatio.toFixed(2)} PnL=${result.totalPnL.toFixed(2)} maxDD=${(result.maxDrawdown * 100).toFixed(1)}% winRate=${(result.winRate * 100).toFixed(1)}%`);
    } catch (e) {
      console.warn(`[${i + 1}/${combinations.length}] spacing=${params.spacing} orderSize=${params.orderSize} → 失败: ${e}`);
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
  lines.push('='.repeat(100));
  lines.push('');
  lines.push('排名 | spacing | orderSize | Sharpe |   PnL   | maxDD  | winRate | trades | annRet | profitFactor');
  lines.push('-----|---------|-----------|--------|---------|--------|---------|--------|--------|------------');

  sorted.forEach((r, i) => {
    const rank = (i + 1).toString().padStart(2);
    const spacing = r.params.spacing.toFixed(3).padStart(7);
    const orderSize = r.params.orderSize.toString().padStart(9);
    const sharpe = r.sharpeRatio.toFixed(2).padStart(6);
    const pnl = r.totalPnL.toFixed(2).padStart(7);
    const maxDD = (r.maxDrawdown * 100).toFixed(1).padStart(5) + '%';
    const winRate = (r.winRate * 100).toFixed(1).padStart(6) + '%';
    const trades = r.totalTrades.toString().padStart(6);
    const annRet = (r.annualizedReturn * 100).toFixed(1).padStart(6) + '%';
    const pf = r.profitFactor.toFixed(2).padStart(10);

    lines.push(`${rank}   | ${spacing} | ${orderSize} | ${sharpe} | ${pnl} | ${maxDD} | ${winRate} | ${trades} | ${annRet} | ${pf}`);
  });

  lines.push('');
  lines.push('='.repeat(100));
  
  // 最佳参数
  if (sorted.length > 0) {
    const best = sorted[0];
    lines.push('');
    lines.push('🏆 最佳参数组合:');
    lines.push(`   spacing: ${best.params.spacing}`);
    lines.push(`   orderSize: ${best.params.orderSize}`);
    lines.push(`   Sharpe: ${best.sharpeRatio.toFixed(2)}`);
    lines.push(`   总收益: ${best.totalPnL.toFixed(2)} USDT`);
    lines.push(`   最大回撤: ${(best.maxDrawdown * 100).toFixed(1)}%`);
    lines.push(`   胜率: ${(best.winRate * 100).toFixed(1)}%`);
  }

  return lines.join('\n');
}

function formatResultsCSV(results: SweepResult[]): string {
  const lines: string[] = [];
  lines.push('rank,spacing,orderSize,sharpeRatio,totalPnL,maxDrawdown,winRate,totalTrades,annualizedReturn,profitFactor');

  const sorted = [...results].sort((a, b) => b.sharpeRatio - a.sharpeRatio);
  sorted.forEach((r, i) => {
    lines.push(`${i + 1},${r.params.spacing},${r.params.orderSize},${r.sharpeRatio},${r.totalPnL},${r.maxDrawdown},${r.winRate},${r.totalTrades},${r.annualizedReturn},${r.profitFactor}`);
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
  console.log(`参数组合: ${args.spacings.length * args.orderSizes.length} 组`);
  console.log('');

  // 生成参数组合
  const combinations = generateParamCombinations(args.spacings, args.orderSizes);

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
    const results = await runSerialBacktests(combinations, args.symbol, args.days, args.interval, db);
    
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
      
      // 同时输出文本和 CSV
      writeFileSync(outputPath, tableOutput);
      writeFileSync(outputPath.replace(/\.txt$/, '.csv').replace(/\.md$/, '.csv'), csvOutput);
      console.log('');
      console.log(`[ParamSweep] 结果已保存: ${outputPath}`);
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
