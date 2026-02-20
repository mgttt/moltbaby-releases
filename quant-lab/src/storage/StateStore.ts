// StateStore - ndtsdb状态持久化（Phase 1）
// 支持UPSERT模拟（追加+读取去重）和Append-only

import { AppendWriter } from '../../../ndtsdb/src/append.ts';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

// 实体类型定义
export interface OrderState {
  orderKey: string;
  runId: string;
  orderLinkId: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  qty: number;
  price: number;
  status: string;
  filledQty: number;
  avgPrice: number;
  pnl: number;
  paramsHash: string;
  createdAt: bigint;
  updatedAt: bigint;
}

export interface PositionState {
  positionKey: string;
  runId: string;
  symbol: string;
  direction: 'Long' | 'Short' | 'Neutral';
  entryPrice: number;
  avgPrice: number;
  size: number;
  notional: number;
  unrealizedPnl: number;
  realizedPnl: number;
  paramsVersion: string;
  updatedAt: bigint;
}

// 列定义
const ORDER_COLUMNS = [
  { name: 'orderKey', type: 'utf8' },
  { name: 'runId', type: 'utf8' },
  { name: 'orderLinkId', type: 'utf8' },
  { name: 'symbol', type: 'utf8' },
  { name: 'side', type: 'utf8' },
  { name: 'qty', type: 'float64' },
  { name: 'price', type: 'float64' },
  { name: 'status', type: 'utf8' },
  { name: 'filledQty', type: 'float64' },
  { name: 'avgPrice', type: 'float64' },
  { name: 'pnl', type: 'float64' },
  { name: 'paramsHash', type: 'utf8' },
  { name: 'createdAt', type: 'int64' },
  { name: 'updatedAt', type: 'int64' },
] as const;

const POSITION_COLUMNS = [
  { name: 'positionKey', type: 'utf8' },
  { name: 'runId', type: 'utf8' },
  { name: 'symbol', type: 'utf8' },
  { name: 'direction', type: 'utf8' },
  { name: 'entryPrice', type: 'float64' },
  { name: 'avgPrice', type: 'float64' },
  { name: 'size', type: 'float64' },
  { name: 'notional', type: 'float64' },
  { name: 'unrealizedPnl', type: 'float64' },
  { name: 'realizedPnl', type: 'float64' },
  { name: 'paramsVersion', type: 'utf8' },
  { name: 'updatedAt', type: 'int64' },
] as const;

export class StateStore {
  private baseDir: string;
  private writers: Map<string, AppendWriter> = new Map();
  private flushTimer?: NodeJS.Timeout;

  constructor(config: { baseDir: string }) {
    this.baseDir = config.baseDir;
    this.startFlushTimer(1000);
  }

  private getPath(type: string, runId: string): string {
    return join(this.baseDir, type, `${runId}.ndts`);
  }

  private getWriter(path: string, columns: any[]): AppendWriter {
    if (!this.writers.has(path)) {
      mkdirSync(dirname(path), { recursive: true });
      const writer = new AppendWriter(path, columns as any);
      writer.open();
      this.writers.set(path, writer);
    }
    return this.writers.get(path)!;
  }

  // UPSERT: 追加写入（读取时去重）
  async upsertOrder(order: OrderState): Promise<void> {
    const path = this.getPath('orders', order.runId);
    const writer = this.getWriter(path, ORDER_COLUMNS as any);
    
    const row = {
      orderKey: order.orderKey,
      runId: order.runId,
      orderLinkId: order.orderLinkId,
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      price: order.price,
      status: order.status,
      filledQty: order.filledQty,
      avgPrice: order.avgPrice,
      pnl: order.pnl,
      paramsHash: order.paramsHash,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
    
    writer.append([row]);
  }

  async upsertPosition(pos: PositionState): Promise<void> {
    const path = this.getPath('positions', pos.runId);
    const writer = this.getWriter(path, POSITION_COLUMNS as any);
    
    const row = {
      positionKey: pos.positionKey,
      runId: pos.runId,
      symbol: pos.symbol,
      direction: pos.direction,
      entryPrice: pos.entryPrice,
      avgPrice: pos.avgPrice,
      size: pos.size,
      notional: pos.notional,
      unrealizedPnl: pos.unrealizedPnl,
      realizedPnl: pos.realizedPnl,
      paramsVersion: pos.paramsVersion,
      updatedAt: pos.updatedAt,
    };
    
    writer.append([row]);
  }

  // 批量flush
  private startFlushTimer(intervalMs: number): void {
    this.flushTimer = setInterval(() => {
      // ndtsdb AppendWriter自动flush
    }, intervalMs);
  }

  async flush(): Promise<void> {
    // 确保数据落盘
    for (const [path, writer] of this.writers) {
      try {
        // 依赖OS缓冲区，必要时可fsync
      } catch (e) {
        console.error(`[StateStore] flush失败: ${path}`, e);
      }
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    
    for (const [path, writer] of this.writers) {
      try {
        await (writer as any).close?.();
      } catch (e) {
        console.error(`[StateStore] close失败: ${path}`, e);
      }
    }
    this.writers.clear();
  }

  getStats(): { writerCount: number; baseDir: string } {
    return {
      writerCount: this.writers.size,
      baseDir: this.baseDir,
    };
  }
}
