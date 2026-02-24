// ============================================================
// StrategyScheduler - 策略调度器
//
// 基于 workpool-lib 实现并行回测调度
// 管理 Worker 池，分发任务，收集结果
// ============================================================

import { Pool, FileStore, createWorker, createTask, type Task } from '@moltbaby/workpool-lib';
import { BacktestWorker, BacktestTask, BacktestResult } from '../workers/BacktestWorker';

/**
 * 调度器配置
 */
export interface StrategySchedulerConfig {
  /** 最大 Worker 数 */
  maxWorkers: number;
  /** 数据目录 */
  dataDir?: string;
  /** IPC 存储目录 */
  poolDir?: string;
  /** 任务超时（分钟） */
  taskTimeoutMinutes?: number;
}

/**
 * 任务状态跟踪
 */
interface TaskState {
  taskId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: BacktestResult;
  error?: string;
}

/**
 * 策略调度器
 *
 * 管理 BacktestWorker 池，并行执行多个回测任务
 */
export class StrategyScheduler {
  private config: Required<StrategySchedulerConfig>;
  private pool: Pool;
  private workers: Map<string, BacktestWorker> = new Map();
  private taskStates: Map<string, TaskState> = new Map();
  private running = false;

  constructor(config: StrategySchedulerConfig) {
    this.config = {
      dataDir: './data',
      poolDir: '.workpool/backtest',
      taskTimeoutMinutes: 10,
      ...config,
    };

    // 初始化 Pool
    const store = new FileStore(this.config.poolDir);
    this.pool = new Pool(store);

    logger.info(`[StrategyScheduler] 初始化完成`);
    logger.info(`  最大 Workers: ${this.config.maxWorkers}`);
    logger.info(`  工作池目录: ${this.config.poolDir}`);
  }

  /**
   * 启动调度器，注册 Workers
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.info('[StrategyScheduler] 已经启动');
      return;
    }

    logger.info(`[StrategyScheduler] 启动中...`);

    // 注册 Workers 到 Pool
    for (let i = 0; i < this.config.maxWorkers; i++) {
      const workerId = `backtest-worker-${i}`;
      const worker = new BacktestWorker({
        workerId,
        dataDir: this.config.dataDir,
      });

      this.workers.set(workerId, worker);

      // 注册到 Pool
      const poolWorker = createWorker(workerId, 'strategy', {
        capacity: 1,
        skills: ['backtest'],
        status: 'idle',
        load: 0,
      });

      this.pool.registerWorker(poolWorker);
      logger.info(`  注册 Worker: ${workerId}`);
    }

    this.running = true;
    logger.info(`[StrategyScheduler] 启动完成，${this.workers.size} 个 Worker 就绪`);
  }

  /**
   * 提交单个回测任务
   */
  async submitTask(task: BacktestTask): Promise<string> {
    const taskId = task.taskId || `backtest-task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // 创建 Pool Task
    const poolTask = createTask(taskId, 'backtest', task, 'strategy-scheduler', {
      requirements: {
        skills: ['backtest'],
        minCapacity: 1,
      },
      priority: 50,
      timeoutAt: new Date(Date.now() + this.config.taskTimeoutMinutes * 60000).toISOString(),
    });

    // 提交到 Pool
    this.pool.submitTask(poolTask);

    // 跟踪状态
    this.taskStates.set(taskId, {
      taskId,
      status: 'pending',
    });

    logger.info(`[StrategyScheduler] 提交任务: ${taskId}`);
    return taskId;
  }

  /**
   * 批量提交回测任务
   */
  async submitTasks(tasks: BacktestTask[]): Promise<string[]> {
    const taskIds: string[] = [];
    for (const task of tasks) {
      const taskId = await this.submitTask(task);
      taskIds.push(taskId);
    }
    return taskIds;
  }

  /**
   * 等待单个任务完成
   */
  async awaitResult(taskId: string, pollIntervalMs = 100): Promise<BacktestResult> {
    return new Promise((resolve, reject) => {
      const checkResult = () => {
        const poolTask = this.pool.getTask(taskId);

        if (!poolTask) {
          reject(new Error(`任务不存在: ${taskId}`));
          return;
        }

        // 检查任务状态
        if (poolTask.status === 'done' || poolTask.status === 'failed') {
          const result = poolTask.result as BacktestResult | undefined;

          if (poolTask.error || !result) {
            reject(new Error(poolTask.error || '任务失败，无结果'));
          } else {
            resolve(result);
          }
          return;
        }

        // 如果任务未分配，尝试调度
        if (poolTask.status === 'pending') {
          this.tryExecuteTask(poolTask);
        }

        // 继续轮询
        setTimeout(checkResult, pollIntervalMs);
      };

      checkResult();
    });
  }

  /**
   * 等待所有任务完成
   */
  async awaitAllResults(taskIds: string[]): Promise<BacktestResult[]> {
    logger.info(`[StrategyScheduler] 等待 ${taskIds.length} 个任务完成...`);

    const results = await Promise.all(
      taskIds.map(id => this.awaitResult(id))
    );

    logger.info(`[StrategyScheduler] 所有任务完成`);
    return results;
  }

  /**
   * 并行运行多个回测任务
   *
   * 简化接口：提交 + 等待一步完成
   */
  async runParallelBacktests(tasks: BacktestTask[]): Promise<BacktestResult[]> {
    // 1. 提交所有任务
    const taskIds = await this.submitTasks(tasks);

    // 2. 启动执行循环（如果没有运行）
    if (!this.running) {
      await this.start();
    }

    // 3. 启动任务处理循环
    this.startProcessingLoop();

    // 4. 等待所有结果
    const results = await this.awaitAllResults(taskIds);

    return results;
  }

  /**
   * 启动任务处理循环
   */
  private startProcessingLoop(): void {
    if (!this.running) return;

    const processTasks = () => {
      if (!this.running) return;

      // 获取所有待处理任务
      const pendingTasks = this.pool.listTasks({ status: 'pending' });

      for (const task of pendingTasks) {
        this.tryExecuteTask(task);
      }

      // 继续循环
      setTimeout(processTasks, 50);
    };

    processTasks();
  }

  /**
   * 尝试执行任务
   */
  private async tryExecuteTask(poolTask: Task): Promise<void> {
    // 分配 Worker
    const allocated = this.pool.allocate(poolTask.id);
    if (!allocated) {
      return; // 没有可用 Worker
    }

    // 获取分配的 Worker
    const updatedTask = this.pool.getTask(poolTask.id);
    if (!updatedTask || !updatedTask.meta.assignee) {
      return;
    }

    const workerId = updatedTask.meta.assignee;
    const worker = this.workers.get(workerId);

    if (!worker) {
      this.pool.failTask(poolTask.id, `Worker 不存在: ${workerId}`);
      return;
    }

    // 标记任务开始
    this.pool.startTask(poolTask.id);

    // 更新本地状态
    this.taskStates.set(poolTask.id, {
      taskId: poolTask.id,
      status: 'running',
    });

    // 执行任务
    try {
      const backtestTask = poolTask.payload as BacktestTask;
      const result = await worker.execute(backtestTask);

      // 标记完成
      this.pool.completeTask(poolTask.id, result);

      this.taskStates.set(poolTask.id, {
        taskId: poolTask.id,
        status: result.error ? 'failed' : 'completed',
        result,
        error: result.error,
      });

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.pool.failTask(poolTask.id, errorMsg);

      this.taskStates.set(poolTask.id, {
        taskId: poolTask.id,
        status: 'failed',
        error: errorMsg,
      });
    }
  }

  /**
   * 获取任务状态
   */
  getTaskStatus(taskId: string): TaskState | undefined {
    return this.taskStates.get(taskId);
  }

  /**
   * 获取所有任务状态
   */
  getAllTaskStatuses(): TaskState[] {
    return Array.from(this.taskStates.values());
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return this.pool.getStats();
  }

  /**
   * 停止调度器
   */
  async shutdown(): Promise<void> {
    logger.info('[StrategyScheduler] 正在关闭...');
    this.running = false;

    // 停止所有 Worker
    for (const [workerId, worker] of this.workers) {
      logger.info(`  停止 Worker: ${workerId}`);
    }

    this.workers.clear();
    this.taskStates.clear();

    logger.info('[StrategyScheduler] 已关闭');
  }
}

export default StrategyScheduler;
