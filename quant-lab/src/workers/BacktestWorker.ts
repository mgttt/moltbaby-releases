// ============================================================
// BacktestWorker - 回测工作节点
//
// 执行单次回测任务，封装在 Worker 接口中供 Pool 调度
// ============================================================

import { KlineDatabase } from '../../../quant-lib/src';
import { QuickJSStrategy } from '../sandbox/QuickJSStrategy';
import { BacktestEngine } from '../engine/backtest';
import type { BacktestConfig } from '../engine/types';

/**
 * 回测任务定义
 */
export interface BacktestTask {
  /** 任务唯一ID */
  taskId: string;
  /** 策略ID */
  strategyId: string;
  /** 策略文件路径 */
  strategyFile: string;
  /** 策略参数 */
  params: Record<string, any>;
  /** 数据范围 */
  dataRange: {
    symbol: string;
    interval?: string;
    start: number;  // timestamp
    end: number;    // timestamp
  };
  /** 回测配置 */
  backtestConfig?: Partial<BacktestConfig>;
}

/**
 * 回测结果
 */
export interface BacktestResult {
  /** 任务ID */
  taskId: string;
  /** 使用的参数 */
  params: Record<string, any>;
  /** 回测指标 */
  metrics: {
    totalReturn: number;
    sharpe: number;
    maxDrawdown: number;
    winRate: number;
    profitFactor: number;
    trades: number;
  };
  /** 详细结果 */
  details?: {
    equityCurve: Array<{ timestamp: number; equity: number }>;
    trades: any[];
    orders: any[];
  };
  /** 执行信息 */
  execution: {
    startTime: string;
    endTime: string;
    durationMs: number;
    barsProcessed: number;
  };
  /** 错误信息 */
  error?: string;
}

/**
 * 回测工作节点
 *
 * 封装单次回测执行逻辑，可被 Pool 调度并行运行
 */
export class BacktestWorker {
  private workerId: string;
  private dataDir: string;

  constructor(options?: { workerId?: string; dataDir?: string }) {
    this.workerId = options?.workerId || `backtest-worker-${Date.now()}`;
    this.dataDir = options?.dataDir || './data';
  }

  /**
   * 执行回测任务
   */
  async execute(task: BacktestTask): Promise<BacktestResult> {
    const execStart = Date.now();
    const startTime = new Date().toISOString();

    console.log(`[BacktestWorker ${this.workerId}] 开始任务: ${task.taskId}`);
    console.log(`  策略: ${task.strategyId}`);
    console.log(`  参数:`, task.params);

    try {
      // 1. 加载历史数据
      const database = new KlineDatabase(this.dataDir);
      const bars = await database.query({
        symbol: task.dataRange.symbol,
        interval: task.dataRange.interval || '1h',
        startTime: task.dataRange.start,
        endTime: task.dataRange.end,
      });

      if (bars.length === 0) {
        throw new Error(`没有找到数据: ${task.dataRange.symbol} (${task.dataRange.start} ~ ${task.dataRange.end})`);
      }

      console.log(`  加载 K线: ${bars.length} 条`);

      // 2. 创建策略实例
      const strategy = new QuickJSStrategy({
        strategyId: task.strategyId,
        strategyFile: task.strategyFile,
        params: task.params,
        stateDir: `./state/${task.taskId}`,
        timeoutMs: 30000,
      });

      // 3. 创建回测引擎
      const config: BacktestConfig = {
        symbols: [task.dataRange.symbol],
        interval: task.dataRange.interval || '1h',
        startTime: task.dataRange.start,
        endTime: task.dataRange.end,
        initialBalance: task.backtestConfig?.initialBalance || 10000,
        maxPositionSize: task.backtestConfig?.maxPositionSize || 1.0,
        feeRate: task.backtestConfig?.feeRate || 0.001,
        slippage: task.backtestConfig?.slippage || 0.0005,
        enableMargin: task.backtestConfig?.enableMargin || false,
        leverage: task.backtestConfig?.leverage || 1,
      };

      const engine = new BacktestEngine(database, strategy, config);

      // 4. 运行回测
      const result = await engine.run();

      const execEnd = Date.now();
      const endTime = new Date().toISOString();

      // 5. 构造返回结果
      const backtestResult: BacktestResult = {
        taskId: task.taskId,
        params: task.params,
        metrics: {
          totalReturn: result.totalReturn,
          sharpe: result.sharpe,
          maxDrawdown: result.maxDrawdown,
          winRate: result.winRate,
          profitFactor: result.profitFactor || 0,
          trades: result.trades.length,
        },
        details: {
          equityCurve: result.equityCurve,
          trades: result.trades,
          orders: result.orders,
        },
        execution: {
          startTime,
          endTime,
          durationMs: execEnd - execStart,
          barsProcessed: bars.length,
        },
      };

      console.log(`[BacktestWorker ${this.workerId}] 任务完成: ${task.taskId}`);
      console.log(`  收益: ${(result.totalReturn * 100).toFixed(2)}%`);
      console.log(`  Sharpe: ${result.sharpe.toFixed(2)}`);
      console.log(`  耗时: ${backtestResult.execution.durationMs}ms`);

      return backtestResult;

    } catch (error) {
      const execEnd = Date.now();
      const endTime = new Date().toISOString();

      console.error(`[BacktestWorker ${this.workerId}] 任务失败: ${task.taskId}`, error);

      return {
        taskId: task.taskId,
        params: task.params,
        metrics: {
          totalReturn: 0,
          sharpe: 0,
          maxDrawdown: 0,
          winRate: 0,
          profitFactor: 0,
          trades: 0,
        },
        execution: {
          startTime,
          endTime,
          durationMs: execEnd - execStart,
          barsProcessed: 0,
        },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 获取 Worker ID
   */
  getId(): string {
    return this.workerId;
  }
}

export default BacktestWorker;
