// ============================================================
// SmartPrefetcher - 智能预读策略
// 滑动窗口 + madvise 预读
// ============================================================

import { MmapPool, MADV_WILLNEED, MADV_DONTNEED } from './pool.js';

/**
 * 智能预读器
 * 管理活跃数据窗口，自动预读和释放
 */
export class SmartPrefetcher {
  private pool: MmapPool;
  private activeWindow: Set<string> = new Set();
  private windowSize: number;
  private lookahead: number;

  constructor(pool: MmapPool, options: { windowSize?: number; lookahead?: number } = {}) {
    this.pool = pool;
    this.windowSize = options.windowSize || 50;  // 当前位置前后50个
    this.lookahead = options.lookahead || 100;   // 预读未来100个
  }

  /**
   * 滑动窗口预读
   * @param allSymbols 所有产品列表
   * @param currentIndex 当前位置
   */
  slideWindow(allSymbols: string[], currentIndex: number): void {
    // 确定活跃窗口
    const windowStart = Math.max(0, currentIndex - this.windowSize);
    const windowEnd = Math.min(allSymbols.length, currentIndex + this.lookahead);
    const windowSymbols = allSymbols.slice(windowStart, windowEnd);

    // 新增到窗口的产品：预读
    for (const symbol of windowSymbols) {
      if (!this.activeWindow.has(symbol)) {
        this.pool.advise(symbol, MADV_WILLNEED);
        this.activeWindow.add(symbol);
      }
    }

    // 离开窗口的产品：释放
    for (const symbol of this.activeWindow) {
      if (!windowSymbols.includes(symbol)) {
        this.pool.advise(symbol, MADV_DONTNEED);
        this.activeWindow.delete(symbol);
      }
    }
  }

  /**
   * 预读指定产品列表
   */
  prefetchBatch(symbols: string[], columns: string[]): void {
    for (const symbol of symbols) {
      this.pool.prefetch(symbol, columns);
    }
  }

  /**
   * 获取当前活跃窗口大小
   */
  getActiveWindowSize(): number {
    return this.activeWindow.size;
  }

  /**
   * 获取活跃产品列表
   */
  getActiveSymbols(): string[] {
    return Array.from(this.activeWindow);
  }

  /**
   * 清空活跃窗口
   */
  clear(): void {
    for (const symbol of this.activeWindow) {
      this.pool.advise(symbol, MADV_DONTNEED);
    }
    this.activeWindow.clear();
  }
}

/**
 * 渐进式加载器
 * 分批加载大量产品，避免内存峰值
 */
export class ProgressiveLoader {
  private pool: MmapPool;
  private batchSize: number;
  private loaded: Set<string> = new Set();

  constructor(pool: MmapPool, batchSize: number = 100) {
    this.pool = pool;
    this.batchSize = batchSize;
  }

  /**
   * 渐进式加载
   * @param symbols 所有产品
   * @param onProgress 进度回调 (loaded, total)
   */
  async load(
    symbols: string[],
    onProgress?: (loaded: number, total: number) => void
  ): Promise<void> {
    const total = symbols.length;

    for (let i = 0; i < total; i += this.batchSize) {
      const batch = symbols.slice(i, i + this.batchSize);
      
      // 加载批次
      for (const symbol of batch) {
        // 预读关键列
        this.pool.prefetch(symbol, ['timestamp', 'price', 'volume']);
        this.loaded.add(symbol);
      }

      // 进度回调
      if (onProgress) {
        onProgress(Math.min(i + this.batchSize, total), total);
      }

      // 给事件循环一个机会处理其他任务
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  /**
   * 获取已加载数量
   */
  getLoadedCount(): number {
    return this.loaded.size;
  }
}
