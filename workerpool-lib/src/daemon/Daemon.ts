// ============================================================
// Daemon - 守护进程管理
//
// 后台进程管理，负责：
// 1. 启动/停止 daemon
// 2. 管理子进程生命周期（通过 ProcessManager）
// 3. 接收 CLI 命令（通过 IPC）
// ============================================================

import { spawn } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { StateManager } from '../process/ProcessState';
import { ProcessManager } from '../process/ProcessManager';
import { IPCServer, type IPCRequest, type IPCResponse, IPCClient } from './IPC';

/**
 * Daemon 配置
 */
export interface DaemonConfig {
  /** 基础目录 */
  baseDir?: string;
  /** IPC socket 路径 */
  socketPath?: string;
  /** PID 文件路径 */
  pidFile?: string;
  /** 是否自动恢复进程 */
  autoRestore?: boolean;
}

/**
 * Daemon 状态
 */
export interface DaemonState {
  pid: number;
  startedAt: string;
  version: string;
}

/**
 * Daemon 管理器
 */
export class Daemon {
  private config: Required<DaemonConfig>;
  private stateManager: StateManager;
  private processManager?: ProcessManager;
  private ipcServer?: IPCServer;
  private isRunning = false;

  constructor(config?: DaemonConfig) {
    const baseDir = config?.baseDir || join(homedir(), '.wp');
    
    this.config = {
      baseDir,
      socketPath: config?.socketPath || join(baseDir, 'sock'),
      pidFile: config?.pidFile || join(baseDir, 'state', 'daemon.pid'),
      autoRestore: config?.autoRestore ?? true,
    };

    this.stateManager = new StateManager(baseDir);
  }

  /**
   * 检查 daemon 是否正在运行
   */
  isDaemonRunning(): boolean {
    const pid = this.getPid();
    if (!pid) return false;

    try {
      // 发送信号 0 检查进程是否存在
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 获取 daemon PID
   */
  getPid(): number | null {
    return this.stateManager.getDaemonPid();
  }

  /**
   * 启动 daemon（后台运行）
   */
  async start(): Promise<void> {
    // 检查是否已在运行
    if (this.isDaemonRunning()) {
      console.log('[Daemon] 已在运行');
      return;
    }

    console.log('[Daemon] 启动中...');

    // 使用 spawn 启动后台进程（推荐入口：Server.ts）
    const serverEntry = fileURLToPath(new URL('./Server.ts', import.meta.url));

    const child = spawn(process.execPath, [serverEntry], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: {
        ...process.env,
        WP_DAEMON: '1',
        WP_BASE_DIR: this.config.baseDir,
      },
    });

    child.unref();

    // 等待 daemon 启动
    await this.waitForDaemon(5000);

    console.log(`[Daemon] 已启动 (PID: ${this.getPid()})`);
  }

  /**
   * 停止 daemon
   */
  async stop(): Promise<void> {
    const pid = this.getPid();
    if (!pid) {
      console.log('[Daemon] 未运行');
      return;
    }

    console.log('[Daemon] 停止中...');

    // 发送停止命令（优雅）
    try {
      await this.sendCommand({ action: 'shutdown', payload: {} });
    } catch {
      // 如果 IPC 失败，直接杀进程
    }

    // 等待进程退出
    await this.waitForExit(pid, 5000);

    // 强制清理
    if (this.isDaemonRunning()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }

    this.stateManager.clearDaemonPid();
    console.log('[Daemon] 已停止');
  }

  /**
   * 运行 daemon（在后台进程中调用）
   */
  async run(): Promise<void> {
    if (process.env.WP_DAEMON !== '1') {
      throw new Error('只能在 daemon 进程中调用 run()');
    }

    // 写入 PID
    const pid = process.pid;
    this.stateManager.setDaemonPid(pid);

    console.log(`[Daemon] 运行中 (PID: ${pid})`);

    // 初始化 ProcessManager
    this.processManager = new ProcessManager({ baseDir: this.config.baseDir });

    // 恢复之前管理的进程
    if (this.config.autoRestore) {
      await this.restoreProcesses();
    }

    // 启动 IPC 服务器
    this.ipcServer = new IPCServer(this.config.socketPath);
    this.ipcServer.onRequest = (req) => this.handleRequest(req);
    await this.ipcServer.start();

    this.isRunning = true;

    // 处理信号
    process.on('SIGTERM', () => this.handleShutdown());
    process.on('SIGINT', () => this.handleShutdown());

    // 保持运行
    await new Promise(() => {});
  }

  /**
   * 发送命令到 daemon
   */
  async sendCommand(request: Omit<IPCRequest, 'id'>): Promise<IPCResponse> {
    if (!this.isDaemonRunning()) {
      throw new Error('daemon 未运行');
    }

    const client = new IPCClient(this.config.socketPath);
    
    try {
      return await client.send({ ...request, id: generateId() });
    } finally {
      client.close();
    }
  }

  /**
   * 处理 IPC 请求
   */
  private async handleRequest(req: IPCRequest): Promise<IPCResponse> {
    if (!this.processManager) {
      return { id: req.id, ok: false, error: 'ProcessManager 未初始化' };
    }

    try {
      switch (req.action) {
        case 'ping':
          return { id: req.id, ok: true, data: { pid: process.pid } };

        case 'list':
          return { id: req.id, ok: true, data: this.processManager.list() };

        case 'start':
          const startResult = await this.processManager.start(req.payload.config);
          return { id: req.id, ok: true, data: startResult };

        case 'stop':
          await this.processManager.stop(req.payload.name, req.payload.signal);
          return { id: req.id, ok: true };

        case 'restart':
          const restartResult = await this.processManager.restart(req.payload.name);
          return { id: req.id, ok: true, data: restartResult };

        case 'delete':
          await this.processManager.delete(req.payload.name);
          return { id: req.id, ok: true };

        case 'status':
          const status = this.processManager.getState(req.payload.name);
          return { id: req.id, ok: true, data: status };

        case 'logs':
          const logManager = this.processManager.getLogManager();
          const logs = logManager.tail(req.payload.name, req.payload.lines || 50, req.payload.type);
          return { id: req.id, ok: true, data: logs };

        case 'signal':
          this.processManager.signal(req.payload.name, req.payload.signal);
          return { id: req.id, ok: true };

        case 'shutdown':
          this.handleShutdown();
          return { id: req.id, ok: true };

        default:
          return { id: req.id, ok: false, error: `未知命令: ${req.action}` };
      }
    } catch (error) {
      return {
        id: req.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 恢复之前管理的进程
   * 参数来源：strategy-process-adapter（单一来源），而非 processes.json
   */
  private async restoreProcesses(): Promise<void> {
    const processes = this.stateManager.listProcesses();
    console.log(`[Daemon] 恢复 ${processes.length} 个进程...`);

    // 动态加载 adapter（避免编译时循环依赖）
    let STRATEGY_REGISTRY: Record<string, any> = {};
    let buildProcessConfig: (spec: any) => any = () => ({});
    try {
      const adapterModule = await import('../../../quant-lab/adapters/strategy-process-adapter.js');
      STRATEGY_REGISTRY = adapterModule.STRATEGY_REGISTRY || {};
      buildProcessConfig = adapterModule.buildProcessConfig || (() => ({}));
    } catch (error) {
      console.warn('[Daemon] 无法加载 adapter，进程恢复只会重建旧配置:', error);
    }

    for (const proc of processes) {
      // 只恢复之前是 online 的进程
      if (proc.status === 'online' || proc.status === 'starting') {
        console.log(`  恢复: ${proc.name}`);
        try {
          // 优先从 adapter 读取新参数；如果 adapter 不可用，使用旧参数（向后兼容）
          let config = proc.config;
          const spec = STRATEGY_REGISTRY[proc.name];
          if (spec) {
            config = buildProcessConfig(spec);
            console.log(`    使用 adapter 新参数`);
          }
          await this.processManager!.start(config);
        } catch (error) {
          console.error(`  恢复失败: ${proc.name}`, error);
        }
      }
    }
  }

  /**
   * 处理关闭
   */
  private async handleShutdown(): Promise<void> {
    console.log('[Daemon] 正在关闭...');
    this.isRunning = false;

    // 停止所有子进程
    if (this.processManager) {
      await this.processManager.stopAll();
    }

    // 关闭 IPC 服务器
    if (this.ipcServer) {
      this.ipcServer.close();
    }

    // 清理 PID 文件
    this.stateManager.clearDaemonPid();

    console.log('[Daemon] 已关闭');
    process.exit(0);
  }

  /**
   * 等待 daemon 启动
   */
  private async waitForDaemon(timeout: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (this.isDaemonRunning()) {
        return;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('daemon 启动超时');
  }

  /**
   * 等待进程退出
   */
  private async waitForExit(pid: number, timeout: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        process.kill(pid, 0);
      } catch {
        return; // 进程已退出
      }
      await new Promise(r => setTimeout(r, 100));
    }
  }
}

/**
 * 生成请求 ID
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export default Daemon;
