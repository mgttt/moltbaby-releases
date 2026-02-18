import { ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Kline } from '../../../quant-lib/src';

export type KlineStoreOptions = {
  dbPath: string;
  binaryPath?: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  fallbackEnabled?: boolean;
};

export interface KlineStoreStats {
  totalOps: number;
  successOps: number;
  failedOps: number;
  retriedOps: number;
  timeoutOps: number;
  fallbackOps: number;
}

type QueryOptions = {
  symbol?: string;
  interval?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
};

interface RpcResponse {
  id: number;
  ok: boolean;
  result?: any;
  error?: string;
}

class RpcError extends Error {}

class QjsRpcProcess {
  private proc?: ChildProcess;
  private reqId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: RpcResponse) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private ready = false;
  private booted = false;

  private readonly options: Required<Pick<KlineStoreOptions, 'requestTimeoutMs'>>;

  constructor(
    private readonly binaryPath: string,
    options?: Pick<KlineStoreOptions, 'requestTimeoutMs'>
  ) {
    this.options = {
      requestTimeoutMs: options?.requestTimeoutMs ?? 3000,
    };
  }

  async start(): Promise<void> {
    if (this.proc) return;

    this.proc = spawn(this.binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
      },
    });

    if (!this.proc.stdout || !this.proc.stdin) {
      throw new Error('qjs-rpc process stdio unavailable');
    }

    const rl = createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => {
      let payload: RpcResponse | null = null;
      try {
        payload = JSON.parse(line) as RpcResponse;
      } catch {
        return;
      }

      const req = this.pending.get(payload.id);
      if (!req) return;
      clearTimeout(req.timer);
      this.pending.delete(payload.id);
      req.resolve(payload);
    });

    this.proc.stderr?.on('data', () => {
      // keep stderr for debug only
    });

    this.ready = true;
    this.booted = true;
  }

  isReady(): boolean {
    return this.ready && !!this.proc?.pid;
  }

  async stop(): Promise<void> {
    if (!this.proc) return;

    for (const [id, item] of this.pending) {
      clearTimeout(item.timer);
      item.reject(new Error(`rpc process closing (id=${id})`));
      this.pending.delete(id);
    }

    this.proc.stdin?.end();
    await new Promise((resolve) => this.proc?.once('exit', resolve));

    this.proc = undefined;
    this.ready = false;
    this.booted = false;
  }

  async request(op: string, params: Record<string, unknown>): Promise<RpcResponse> {
    if (!this.isReady() || !this.proc?.stdin) {
      throw new RpcError('rpc not ready');
    }

    const id = this.reqId++;
    const msg = JSON.stringify({ id, op, ...params }) + '\n';

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`rpc timeout id=${id} op=${op}`));
      }, this.options.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin!.write(msg);
    });
  }

  getBooted(): boolean {
    return this.booted;
  }
}

function toTs(tsOrDate: number | undefined): number | undefined {
  if (tsOrDate == null) return undefined;
  return tsOrDate;
}

export class NdtsdbRpcKlineStore {
  private client?: QjsRpcProcess;
  private dbId?: number;
  private opened = false;
  private fallback = false;

  private stats: KlineStoreStats = {
    totalOps: 0,
    successOps: 0,
    failedOps: 0,
    retriedOps: 0,
    timeoutOps: 0,
    fallbackOps: 0,
  };

  constructor(private readonly options: KlineStoreOptions) {
    const dataDir = options.dbPath || join(process.cwd(), '.quant-lab/ndtsdb-rpc');
    this.options = {
      dbPath: dataDir,
      binaryPath: options.binaryPath ?? join(process.cwd(), '..', 'ndtsdb', 'docs', 'poc', 'qjs-ndtsdb-rpc'),
      requestTimeoutMs: options.requestTimeoutMs ?? 3000,
      maxRetries: options.maxRetries ?? 3,
      retryDelayMs: options.retryDelayMs ?? 120,
      fallbackEnabled: options.fallbackEnabled ?? true,
    };
    
    // 兼容不带二进制时的错误定位
    if (!existsSync(this.options.binaryPath)) {
      throw new Error(`qjs-rpc binary not found: ${this.options.binaryPath}`);
    }
  }

  async init(): Promise<void> {
    if (this.opened) return;

    this.client = new QjsRpcProcess(this.options.binaryPath, {
      requestTimeoutMs: this.options.requestTimeoutMs,
    });

    await this.client.start();

    if (!this.client.getBooted()) {
      throw new Error('rpc process boot failed');
    }

    const resp = await this.withRetry('open', () => this.client!.request('open', { path: this.options.dbPath }));
    this.dbId = resp.result as number;
    this.opened = true;
  }

  async close(): Promise<void> {
    if (!this.opened || !this.client || this.dbId == null) return;

    await this.withRetry('close', () => this.client!.request('close', { db: this.dbId! })).catch(() => {
      // close 失败不阻塞下线
    });

    await this.client.stop();
    this.opened = false;
    this.dbId = undefined;
  }

  async insertKlines(klines: Kline[]): Promise<number> {
    if (klines.length === 0) return 0;

    if (!this.opened || this.fallback) {
      if (this.fallback) {
        this.stats.fallbackOps += klines.length;
      }
      this.stats.totalOps += 1;
      if (this.fallback) return 0;
      throw new Error('rpc store not ready');
    }

    await this.executeBatch(klines);
    this.stats.totalOps += 1;
    this.stats.successOps += 1;
    return klines.length;
  }

  async upsertKlines(klines: Kline[]): Promise<number> {
    return this.insertKlines(klines);
  }

  async queryKlines(options: QueryOptions): Promise<Kline[]> {
    if (!this.opened || this.fallback) {
      return [];
    }

    const symbol = options.symbol;
    const interval = options.interval;
    if (!symbol || !interval) return [];

    const start = toTs(options.startTime) ?? 0;
    const end = toTs(options.endTime) ?? Number.MAX_SAFE_INTEGER;
    const limit = options.limit ?? 5000;

    const resp = await this.withRetry('query', () =>
      this.client!.request('query', {
        db: this.dbId,
        symbol,
        interval,
        start,
        end,
        limit,
      })
    );

    const rows = Array.isArray(resp.result) ? resp.result : [];
    return rows
      .map((row: any) => ({
        symbol,
        exchange: 'UNKNOWN',
        baseCurrency: 'UNKNOWN',
        quoteCurrency: 'UNKNOWN',
        interval,
        timestamp: Number(row.timestamp),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
      }))
      .filter((row: Kline) => {
        if (start != null && row.timestamp < start) return false;
        if (end != null && row.timestamp > end) return false;
        return true;
      })
      .slice(0, limit);
  }

  async getKline(symbol: string, interval: string, timestamp: number): Promise<Kline | null> {
    const rows = await this.queryKlines({
      symbol,
      interval,
      start: timestamp,
      end: timestamp,
      limit: 1,
    });
    return rows[0] || null;
  }

  async getLatestKline(symbol: string, interval: string): Promise<Kline | null> {
    const rows = await this.queryKlines({ symbol, interval, limit: 1 });
    return rows[rows.length - 1] || null;
  }

  getStats(): KlineStoreStats {
    return { ...this.stats };
  }

  private async executeBatch(klines: Kline[]): Promise<void> {
    await Promise.all(
      klines.map((kline) =>
        this.withRetry('insert', () =>
          this.client!.request('insert', {
            db: this.dbId,
            symbol: kline.symbol,
            interval: kline.interval,
            timestamp: kline.timestamp,
            open: kline.open,
            high: kline.high,
            low: kline.low,
            close: kline.close,
            volume: kline.volume,
          })
        ),
      )
    );
  }

  private async withRetry<T>(label: string, fn: () => Promise<RpcResponse>): Promise<RpcResponse> {
    let attempt = 0;
    let lastErr: Error | null = null;

    while (attempt < this.options.maxRetries) {
      attempt += 1;
      this.stats.totalOps += 1;
      try {
        const resp = await fn();
        if (!resp.ok) {
          throw new Error(resp.error || `${label} failed`);
        }

        this.stats.successOps += 1;
        return resp;
      } catch (err: any) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (String(lastErr.message).includes('timeout')) {
          this.stats.timeoutOps += 1;
        }
        if (attempt < this.options.maxRetries) {
          this.stats.retriedOps += 1;
          await new Promise((r) => setTimeout(r, this.options.retryDelayMs * attempt));
          continue;
        }

        this.stats.failedOps += 1;
        if (this.options.fallbackEnabled) {
          this.fallback = true;
          this.stats.fallbackOps += 1;
          console.warn(`[NdtsdbRpcKlineStore] fallback to noop after ${label} failed: ${lastErr.message}`);
          return {
            id: 0,
            ok: true,
            result: null,
          } as RpcResponse;
        }

        throw lastErr;
      }
    }

    throw lastErr || new Error(`${label} failed`);
  }
}
