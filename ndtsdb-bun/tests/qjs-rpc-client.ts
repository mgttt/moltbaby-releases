import { spawn } from 'node:child_process';
import { once } from 'node:events';

interface RpcResponse {
  id: number;
  ok: boolean;
  result?: any;
  error?: string;
}

export class QjsNdtsdbRpcClient {
  private readonly proc = spawn('./docs/poc/qjs-ndtsdb-rpc', {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      LC_ALL: 'C',
    },
  });

  private readonly responses = new Map<number, (resp: RpcResponse) => void>();
  private pendingId = 1;
  private readonly buffer = {
    stdout: '',
    stderr: '',
  };

  private ready = (async () => {
    if (!this.proc.stdout) {
      throw new Error('rpc stdout missing');
    }

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buffer.stdout += String(chunk);
      let idx = this.buffer.stdout.indexOf('\n');
      while (idx >= 0) {
        const line = this.buffer.stdout.slice(0, idx).trim();
        this.buffer.stdout = this.buffer.stdout.slice(idx + 1);
        if (!line) {
          idx = this.buffer.stdout.indexOf('\n');
          continue;
        }

        try {
          const json = JSON.parse(line) as RpcResponse;
          const resolver = this.responses.get(json.id);
          if (resolver) {
            resolver(json);
            this.responses.delete(json.id);
          }
        } catch {
          // ignore parse noise
        }

        idx = this.buffer.stdout.indexOf('\n');
      }
    });

    this.proc.stderr?.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      this.buffer.stderr += String(chunk);
    });

    await once(this.proc, 'spawn');
  })();

  private async send(op: string, params: Record<string, unknown>) {
    await this.ready;

    const id = this.pendingId++;
    const req = JSON.stringify({ id, op, ...params }) + '\n';

    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.responses.delete(id);
        reject(new Error(`rpc timeout id=${id} op=${op}`));
      }, 2000);

      this.responses.set(id, (resp) => {
        clearTimeout(timer);
        resolve(resp);
      });

      if (!this.proc.stdin) {
        reject(new Error('rpc stdin missing'));
        return;
      }
      this.proc.stdin.write(req);
    });
  }

  async open(path: string) {
    const resp = await this.send('open', { path });
    if (!resp.ok) throw new Error(resp.error || 'open failed');
    return Number(resp.result);
  }

  async close(db: number) {
    const resp = await this.send('close', { db });
    if (!resp.ok) throw new Error(resp.error || 'close failed');
  }

  async insert(params: {
    db: number;
    symbol: string;
    interval: string;
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }) {
    const resp = await this.send('insert', params);
    if (!resp.ok) throw new Error(resp.error || 'insert failed');
  }

  async query(params: {
    db: number;
    symbol: string;
    interval: string;
    start: number;
    end: number;
    limit: number;
  }) {
    const resp = await this.send('query', params);
    if (!resp.ok) throw new Error(resp.error || 'query failed');
    return resp.result as Array<any>;
  }

  async closeProcess() {
    this.proc.stdin?.end();
    await once(this.proc, 'exit');
  }
}
