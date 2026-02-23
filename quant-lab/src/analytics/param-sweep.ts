#!/usr/bin/env bun
/**
 * 策略参数扫描工具 (Param Sweep)
 * 
 * 基于 BacktestEngine，并行运行多组参数回测，输出排名表
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
 *   --workers   并行工作数 (默认: 4)
 *   --output    输出文件路径 (默认: stdout)
 * 
 * 示例:
 *   bun run param-sweep.ts --symbol MYXUSDT --days 30 --spacing 0.01,0.02 --orderSize 50,100
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { Worker } from 'worker_threads';
import os from 'os';
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

interface WorkerTask {
  id: number;
  params: ParamSet;
  symbol: string;
  days: number;
  interval: string;
  dbPath: string;
}

interface WorkerResult {
  id: number;
  success: boolean;
  result?: SweepResult;
  error?: string;
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
  let workers = Math.min(4, os.cpus().length);
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
      case '--workers':
        workers = parseInt(args[++i], 10);
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
    workers,
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
  --workers   并行工作数 (默认: 4)
  --output    输出文件路径 (默认: stdout)

示例:
  bun run param-sweep.ts --symbol MYXUSDT --days 30
  bun run param-sweep.ts --symbol BTCUSDT --days 60 --spacing 0.005,0.01,0.015
`);
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
): Promise<{ startTime: number; endTime: number; count: number }> {
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - days * 24 * 60 * 60;

  // 检查数据库中是否有足够数据
  const existing = await db.queryKlines(symbol, interval, startTime, endTime);
  
  if (existing.length < days * 0.8) {
    console.log(`[ParamSweep] 数据库中 ${symbol} ${interval} 数据不足 (${existing.length} 条)，尝试从交易所拉取...`);
    
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
      
      // 存入数据库
      await db.insertKlines(symbol, interval, klines);
      console.log(`[ParamSweep] 成功拉取并存储 ${klines.length} 条K线数据`);
    } catch (e) {
      console.warn(`[ParamSweep] 拉取数据失败: ${e}`);
    }
  }

  const finalData = await db.queryKlines(symbol, interval, startTime, endTime);
  return { startTime, endTime, count: finalData.length };
}

// ============================================================
// Worker 线程代码（字符串形式，用于动态创建 Worker）
// ============================================================

const workerCode = `
const { parentPort, workerData } = require('worker_threads');
const { KlineDatabase } = require('../../../quant-lib/src');

async function runBacktest(task) {
  const { params, symbol, days, interval, dbPath } = task;
  
  try {
    // 加载数据库
    const db = new KlineDatabase(dbPath);
    
    const endTime = Math.floor(Date.now() / 1000);
    const startTime = endTime - days * 24 * 60 * 60;
    
    // 查询K线数据
    const klines = await db.queryKlines(symbol, interval, startTime, endTime);
    
    if (klines.length === 0) {
      throw new Error('No kline data available');
    }
    
    // 简化版回测逻辑（网格策略模拟）
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
    const prices = klines.map(k => k.close);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    
    const gridLines: number[] = [];
    let price = minPrice;
    while (price <= maxPrice * 1.1) {
      gridLines.push(price);
      price = price * (1 + params.spacing);
    }
    
    let lastGridIndex: number | null = null;
    const feeRate = 0.0006; // 0.06% 手续费
    
    for (let i = 1; i < klines.length; i++) {
      const prevPrice = klines[i - 1].close;
      const currPrice = klines[i].close;
      
      // 检查穿越的网格线
      for (let j = 0; j < gridLines.length; j++) {
        const gridPrice = gridLines[j];
        
        // 价格穿越网格线
        if ((prevPrice <= gridPrice && currPrice >= gridPrice) ||
            (prevPrice >= gridPrice && currPrice <= gridPrice)) {
          
          // 避免重复触发同一网格
          if (lastGridIndex !== null && Math.abs(j - lastGridIndex) < 1) {
            continue;
          }
          
          // 确定方向
          const isUp = currPrice > prevPrice;
          const side = isUp ? 'SELL' : 'BUY';
          
          // 计算数量
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
              const entryCost = qty * gridPrice; // 简化为同价买入
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
      
      // 计算权益和回撤
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
    
    // 计算指标
    const finalEquity = equityCurve[equityCurve.length - 1] || initialCapital;
    const totalReturn = (finalEquity - initialCapital) / initialCapital;
    const annualizedReturn = totalReturn * (365 / days);
    
    // 计算夏普比率（简化）
    const returns: number[] = [];
    for (let i = 1; i < equityCurve.length; i++) {
      returns.push((equityCurve[i] - equityCurve[i-1]) / equityCurve[i-1]);
    }
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length || 0;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length || 0;
    const stdDev = Math.sqrt(variance) || 1;
    const sharpeRatio = avgReturn / stdDev * Math.sqrt(365 * 24); // 小时数据年化
    
    // 胜率
    const winRate = trades > 0 ? winningTrades / trades : 0;
    
    // 盈亏比
    const profitFactor = losingAmount > 0 ? winningAmount / losingAmount : 0;
    
    await db.close();
    
    return {
      params,
      sharpeRatio: isFinite(sharpeRatio) ? sharpeRatio : 0,
      totalPnL: totalPnL,
      maxDrawdown: maxDrawdown,
      winRate: winRate,
      totalTrades: trades,
      annualizedReturn: annualizedReturn,
      profitFactor: isFinite(profitFactor) ? profitFactor : 0,
    };
  } catch (error) {
    throw error;
  }
}

if (parentPort) {
  parentPort.once('message', async (task) => {
    try {
      const result = await runBacktest(task);
      parentPort.postMessage({ id: task.id, success: true, result });
    } catch (error) {
      parentPort.postMessage({ 
        id: task.id, 
        success: false, 
        error: error instanceof Error ? error.message : String(error) 
      });
    }
  });
}
`;

// ============================================================
// 并行回测执行
// ============================================================

async function runParallelBacktests(
  combinations: ParamSet[],
  symbol: string,
  days: number,
  interval: string,
  dbPath: string,
  maxWorkers: number
): Promise<SweepResult[]> {
  const results: SweepResult[] = [];
  const tasks: WorkerTask[] = combinations.map((params, index) => ({
    id: index,
    params,
    symbol,
    days,
    interval,
    dbPath,
  }));

  // 创建 Worker 池
  const workers: Worker[] = [];
  const workerPromises: Promise<void>[] = [];

  for (let i = 0; i < maxWorkers; i++) {
    const worker = new Worker(workerCode, { eval: true });
    workers.push(worker);
  }

  console.log(`[ParamSweep] 启动 ${maxWorkers} 个 Worker 线程`);
  console.log(`[ParamSweep] 总共 ${tasks.length} 组参数待测试`);
  console.log('');

  // 分配任务
  let taskIndex = 0;
  let completed = 0;
  let failed = 0;

  const processTask = async (worker: Worker): Promise<void> => {
    while (taskIndex < tasks.length) {
      const task = tasks[taskIndex++];
      
      const result = await new Promise<WorkerResult>((resolve) => {
        worker.once('message', resolve);
        worker.postMessage(task);
      });

      if (result.success && result.result) {
        results.push(result.result);
        completed++;
        console.log(`[${completed}/${tasks.length}] spacing=${task.params.spacing.toFixed(3)} orderSize=${task.params.orderSize.toString().padStart(3)} → Sharpe=${result.result.sharpeRatio.toFixed(2)} PnL=${result.result.totalPnL.toFixed(2)} maxDD=${(result.result.maxDrawdown * 100).toFixed(1)}% winRate=${(result.result.winRate * 100).toFixed(1)}%`);
      } else {
        failed++;
        console.warn(`[${taskIndex}/${tasks.length}] spacing=${task.params.spacing} orderSize=${task.params.orderSize} → 失败: ${result.error}`);
      }
    }
  };

  // 启动所有 Worker
  for (const worker of workers) {
    workerPromises.push(processTask(worker));
  }

  // 等待所有任务完成
  await Promise.all(workerPromises);

  // 清理 Worker
  for (const worker of workers) {
    await worker.terminate();
  }

  console.log('');
  console.log(`[ParamSweep] 完成: ${completed} 成功, ${failed} 失败`);
  
  return results;
}

// ============================================================
// 串行回测（Worker 不可用时的 fallback）
// ============================================================

async function runSerialBacktests(
  combinations: ParamSet[],
  symbol: string,
  days: number,
  interval: string,
  db: KlineDatabase
): Promise<SweepResult[]> {
  const results: SweepResult[] = [];
  
  console.log(`[ParamSweep] 使用串行模式（Worker 不可用）`);
  console.log(`[ParamSweep] 总共 ${combinations.length} 组参数待测试`);
  console.log('');

  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - days * 24 * 60 * 60;
  const klines = await db.queryKlines(symbol, interval, startTime, endTime);

  if (klines.length === 0) {
    throw new Error('No kline data available for backtest');
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
  console.log(`并行度: ${args.workers}`);
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
    console.log(`[ParamSweep] 数据准备完成: ${dataInfo.count} 条K线`);
    console.log('');

    // 执行回测
    let results: SweepResult[];
    
    try {
      // 尝试并行模式
      results = await runParallelBacktests(
        combinations,
        args.symbol,
        args.days,
        args.interval,
        dbPath,
        args.workers
      );
    } catch (e) {
      console.warn(`[ParamSweep] Worker 模式失败，切换到串行模式: ${e}`);
      results = await runSerialBacktests(combinations, args.symbol, args.days, args.interval, db);
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
