// ============================================================
// IPC - Unix Socket JSON Line Protocol
//
// Protocol:
// - client sends one JSON per line: { id, action, payload }
// - server replies one JSON per line: { id, ok, data?, error? }
// ============================================================

import net from 'net';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface IPCRequest {
  id: string;
  action: string;
  payload?: any;
}

export interface IPCResponse {
  id: string;
  ok: boolean;
  data?: any;
  error?: string;
}

export class IPCServer {
  private socketPath: string;
  private server?: net.Server;
  onRequest?: (req: IPCRequest) => Promise<IPCResponse> | IPCResponse;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async start(): Promise<void> {
    // ensure parent dir
    const dir = dirname(this.socketPath);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {}

    // remove old socket
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch {}
    }

    this.server = net.createServer((socket) => this.handleClient(socket));

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketPath, () => resolve());
    });
  }

  close(): void {
    try {
      this.server?.close();
    } catch {}

    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch {}
    }
  }

  private handleClient(socket: net.Socket): void {
    socket.setEncoding('utf-8');

    let buffer = '';

    socket.on('data', async (chunk: string) => {
      buffer += chunk;

      while (true) {
        const idx = buffer.indexOf('\n');
        if (idx === -1) break;

        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);

        if (!line) continue;

        let req: IPCRequest;
        try {
          req = JSON.parse(line);
        } catch (e) {
          const resp: IPCResponse = { id: 'unknown', ok: false, error: 'invalid json' };
          socket.write(JSON.stringify(resp) + '\n');
          continue;
        }

        // run handler
        try {
          const handler = this.onRequest;
          if (!handler) {
            socket.write(JSON.stringify({ id: req.id, ok: false, error: 'no handler' }) + '\n');
            continue;
          }

          const resp = await handler(req);
          socket.write(JSON.stringify(resp) + '\n');
        } catch (e) {
          const resp: IPCResponse = { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
          socket.write(JSON.stringify(resp) + '\n');
        }
      }
    });

    socket.on('error', () => {
      // ignore
    });
  }
}

export class IPCClient {
  private socketPath: string;
  private socket?: net.Socket;
  private buffer = '';
  private pending = new Map<string, { resolve: (r: IPCResponse) => void; reject: (e: any) => void }>();

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;

    this.socket = net.createConnection(this.socketPath);
    this.socket.setEncoding('utf-8');

    this.socket.on('data', (chunk: string) => this.onData(chunk));
    this.socket.on('error', (err) => {
      // reject all pending
      for (const [id, p] of this.pending) {
        p.reject(err);
      }
      this.pending.clear();
    });

    await new Promise<void>((resolve, reject) => {
      this.socket!.once('connect', () => resolve());
      this.socket!.once('error', reject);
    });
  }

  async send(req: IPCRequest, timeoutMs = 10000): Promise<IPCResponse> {
    await this.connect();

    const payload = JSON.stringify(req) + '\n';

    const respP = new Promise<IPCResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        reject(new Error(`IPC timeout: ${req.action} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(req.id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject:  (e) => { clearTimeout(timer); reject(e); },
      });
    });

    this.socket!.write(payload);

    return respP;
  }

  close(): void {
    try {
      this.socket?.end();
      this.socket?.destroy();
    } catch {}
  }

  private onData(chunk: string): void {
    this.buffer += chunk;

    while (true) {
      const idx = this.buffer.indexOf('\n');
      if (idx === -1) break;

      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);

      if (!line) continue;

      let resp: IPCResponse;
      try {
        resp = JSON.parse(line);
      } catch {
        continue;
      }

      const pending = this.pending.get(resp.id);
      if (pending) {
        this.pending.delete(resp.id);
        pending.resolve(resp);
      }
    }
  }
}

export default IPCServer;
