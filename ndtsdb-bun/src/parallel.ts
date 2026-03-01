// ============================================================
// Worker 并行查询引擎
// 利用多核 CPU 加速大数据集查询
// ============================================================

import { ColumnarTable } from './columnar.js';

// 查询任务
interface QueryTask {
  tableData: ArrayBuffer;
  columnNames: string[];
  columnTypes: string[];
  startRow: number;
  endRow: number;
  whereCondition?: { column: string; operator: string; value: number };
}

// 查询结果
interface QueryResult {
  rowIndices: number[];
  partialSums: Record<string, number>;
  partialCounts: Record<string, number>;
}

/**
 * 并行查询管理器
 */
export class ParallelQueryEngine {
  private workerCount: number;
  private workers: Worker[] = [];
  private taskQueue: Array<{ task: QueryTask; resolve: (result: QueryResult) => void }> = [];
  private busyWorkers: Set<number> = new Set();

  constructor(workerCount: number = navigator.hardwareConcurrency || 4) {
    this.workerCount = workerCount;
    this.initWorkers();
  }

  /**
   * 初始化 Worker 池
   */
  private initWorkers(): void {
    for (let i = 0; i < this.workerCount; i++) {
      const worker = new Worker(new URL('./query-worker.ts', import.meta.url));
      
      worker.onmessage = (e: MessageEvent) => {
        const { workerId, result } = e.data;
        this.busyWorkers.delete(workerId);
        this.processQueue();
      };

      this.workers.push(worker);
    }
  }

  /**
   * 执行并行查询
   */
  async queryParallel(
    table: ColumnarTable,
    options: {
      where?: { column: string; operator: string; value: number };
      aggregate?: { column: string; op: 'sum' | 'count' | 'avg' | 'min' | 'max' }[];
    }
  ): Promise<{ rowIndices: number[]; aggregates?: Record<string, number> }> {
    const rowCount = table.getRowCount();
    const chunkSize = Math.ceil(rowCount / this.workerCount);

    // 准备任务
    const tasks: QueryTask[] = [];
    for (let i = 0; i < this.workerCount; i++) {
      const startRow = i * chunkSize;
      const endRow = Math.min((i + 1) * chunkSize, rowCount);
      
      tasks.push({
        tableData: this.serializeTable(table),
        columnNames: table.getColumnNames(),
        columnTypes: [], // 从表获取
        startRow,
        endRow,
        whereCondition: options.where,
      });
    }

    // 并行执行
    const results = await Promise.all(
      tasks.map((task, index) => this.executeOnWorker(index, task))
    );

    // 合并结果
    const allIndices: number[] = [];
    const aggregates: Record<string, { sum: number; count: number; min: number; max: number }> = {};

    for (const result of results) {
      allIndices.push(...result.rowIndices);

      // 合并聚合结果
      for (const [col, sum] of Object.entries(result.partialSums)) {
        if (!aggregates[col]) {
          aggregates[col] = { sum: 0, count: 0, min: Infinity, max: -Infinity };
        }
        aggregates[col].sum += sum;
      }

      for (const [col, count] of Object.entries(result.partialCounts)) {
        if (!aggregates[col]) {
          aggregates[col] = { sum: 0, count: 0, min: Infinity, max: -Infinity };
        }
        aggregates[col].count += count;
      }
    }

    // 计算最终聚合值
    const finalAggregates: Record<string, number> = {};
    if (options.aggregate) {
      for (const agg of options.aggregate) {
        const data = aggregates[agg.column];
        if (data) {
          switch (agg.op) {
            case 'sum':
              finalAggregates[`${agg.column}_sum`] = data.sum;
              break;
            case 'count':
              finalAggregates[`${agg.column}_count`] = data.count;
              break;
            case 'avg':
              finalAggregates[`${agg.column}_avg`] = data.sum / data.count;
              break;
          }
        }
      }
    }

    return {
      rowIndices: allIndices.sort((a, b) => a - b),
      aggregates: finalAggregates,
    };
  }

  /**
   * 在 Worker 上执行任务
   */
  private executeOnWorker(workerId: number, task: QueryTask): Promise<QueryResult> {
    return new Promise((resolve) => {
      this.taskQueue.push({ task, resolve });
      this.processQueue();
    });
  }

  /**
   * 处理任务队列
   */
  private processQueue(): void {
    while (this.taskQueue.length > 0) {
      const availableWorker = this.findAvailableWorker();
      if (availableWorker === -1) break;

      const { task, resolve } = this.taskQueue.shift()!;
      this.busyWorkers.add(availableWorker);

      this.workers[availableWorker].postMessage({
        workerId: availableWorker,
        task,
      });

      // 简化：实际应该通过 onmessage 回调
      setTimeout(() => {
        resolve(this.simulateWorkerTask(task));
      }, 0);
    }
  }

  /**
   * 查找可用 Worker
   */
  private findAvailableWorker(): number {
    for (let i = 0; i < this.workerCount; i++) {
      if (!this.busyWorkers.has(i)) {
        return i;
      }
    }
    return -1;
  }

  /**
   * 模拟 Worker 任务（实际应在 Worker 线程执行）
   */
  private simulateWorkerTask(task: QueryTask): QueryResult {
    const rowIndices: number[] = [];
    const partialSums: Record<string, number> = {};
    const partialCounts: Record<string, number> = {};

    // 这里应该反序列化 tableData 并执行查询
    // 简化实现
    for (let i = task.startRow; i < task.endRow; i++) {
      rowIndices.push(i);
    }

    return { rowIndices, partialSums, partialCounts };
  }

  /**
   * 序列化表数据
   */
  private serializeTable(table: ColumnarTable): ArrayBuffer {
    // 简化：实际应该序列化所有列数据
    return new ArrayBuffer(0);
  }

  /**
   * 关闭 Worker 池
   */
  terminate(): void {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
  }
}

/**
 * 简化版并行扫描（不依赖 Worker，使用 Promise.all）
 */
export async function parallelScan<T>(
  array: T[],
  predicate: (item: T, index: number) => boolean,
  workerCount: number = 4
): Promise<number[]> {
  const chunkSize = Math.ceil(array.length / workerCount);
  const chunks: Promise<number[]>[] = [];

  for (let i = 0; i < workerCount; i++) {
    const start = i * chunkSize;
    const end = Math.min((i + 1) * chunkSize, array.length);

    chunks.push(
      new Promise((resolve) => {
        const indices: number[] = [];
        for (let j = start; j < end; j++) {
          if (predicate(array[j], j)) {
            indices.push(j);
          }
        }
        resolve(indices);
      })
    );
  }

  const results = await Promise.all(chunks);
  return results.flat().sort((a, b) => a - b);
}

/**
 * 并行聚合
 */
export async function parallelAggregate(
  array: Float64Array,
  workerCount: number = 4
): Promise<{ sum: number; min: number; max: number; avg: number; count: number }> {
  const chunkSize = Math.ceil(array.length / workerCount);
  const chunks: Promise<{ sum: number; min: number; max: number; count: number }>[] = [];

  for (let i = 0; i < workerCount; i++) {
    const start = i * chunkSize;
    const end = Math.min((i + 1) * chunkSize, array.length);

    chunks.push(
      new Promise((resolve) => {
        let sum = 0;
        let min = Infinity;
        let max = -Infinity;
        let count = 0;

        for (let j = start; j < end; j++) {
          const val = array[j];
          sum += val;
          if (val < min) min = val;
          if (val > max) max = val;
          count++;
        }

        resolve({ sum, min, max, count });
      })
    );
  }

  const results = await Promise.all(chunks);

  // 合并结果
  let totalSum = 0;
  let totalMin = Infinity;
  let totalMax = -Infinity;
  let totalCount = 0;

  for (const r of results) {
    totalSum += r.sum;
    if (r.min < totalMin) totalMin = r.min;
    if (r.max > totalMax) totalMax = r.max;
    totalCount += r.count;
  }

  return {
    sum: totalSum,
    min: totalMin,
    max: totalMax,
    avg: totalSum / totalCount,
    count: totalCount,
  };
}
