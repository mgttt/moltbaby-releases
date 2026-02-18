// ndtsdb-rpc-client.js: QuickJS 策略使用的 ndtsdb RPC 客户端
// 通过子进程调用 qjs-ndtsdb-rpc，避免内嵌模块 segfault

class NdtsdbRpcClient {
  constructor(rpcPath = './docs/poc/qjs-ndtsdb-rpc') {
    this.rpcPath = rpcPath;
    this.proc = null;
    this.pendingId = 1;
    this.responses = new Map();
    this.buffer = '';
  }

  async start() {
    // 启动 RPC 进程
    const { spawn } = await import('node:child_process');
    
    this.proc = spawn(this.rpcPath, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let idx = this.buffer.indexOf('\n');
      while (idx >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        
        if (line) {
          try {
            const json = JSON.parse(line);
            const resolver = this.responses.get(json.id);
            if (resolver) {
              resolver(json);
              this.responses.delete(json.id);
            }
          } catch {}
        }
        idx = this.buffer.indexOf('\n');
      }
    });

    await new Promise((resolve, reject) => {
      this.proc.once('spawn', resolve);
      this.proc.once('error', reject);
      setTimeout(() => reject(new Error('rpc spawn timeout')), 5000);
    });
  }

  async send(op, params) {
    return new Promise((resolve, reject) => {
      const id = this.pendingId++;
      const req = JSON.stringify({ id, op, ...params }) + '\n';
      
      const timer = setTimeout(() => {
        this.responses.delete(id);
        reject(new Error(`rpc timeout: ${op}`));
      }, 5000);

      this.responses.set(id, (resp) => {
        clearTimeout(timer);
        if (resp.ok) resolve(resp.result);
        else reject(new Error(resp.error));
      });

      this.proc.stdin.write(req);
    });
  }

  async open(path) {
    return this.send('open', { path });
  }

  async close(db) {
    return this.send('close', { db });
  }

  async insert(db, symbol, interval, row) {
    return this.send('insert', { db, symbol, interval, ...row });
  }

  async query(db, symbol, interval, start, end, limit) {
    return this.send('query', { db, symbol, interval, start, end, limit });
  }

  async stop() {
    if (this.proc) {
      this.proc.stdin.end();
      await new Promise(r => this.proc.once('exit', r));
      this.proc = null;
    }
  }
}

// QuickJS 兼容导出
if (typeof module !== 'undefined') {
  module.exports = { NdtsdbRpcClient };
}

// ESM 导出
export { NdtsdbRpcClient };
