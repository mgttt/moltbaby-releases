// ============================================================
// ProcessManager - 进程生命周期管理
//
// 管理进程的启动、停止、重启、信号发送、自动重启
// 实现指数退避重启、崩溃检测、资源监控
// ============================================================

import { spawn, ChildProcess, type SpawnOptions } from 'child_process';
import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import { resolve } from 'path';
import {
  ProcessConfig,
  ProcessState,
  ProcessStatus,
  StateManager,
  buildCommand,
} from './ProcessState';
import { LogManager } from '../log/LogManager';
import { ResourceMonitor, ResourceUsage } from './ResourceMonitor';

/**
 * 进程事件
 */
export interface ProcessEvents {
  'start': (name: string, pid: number) => void;
  'stop': (name: string, code: number | null, signal: string | null) => void;
  'restart': (name: string, attempt: number) => void;
  'error': (name: string, error: Error) => void;
  'crash': (name: string, exitCode: number) => void;
  'maxRestarts': (name: string) => void;
  'exit': (name: string, code: number | null, signal: string | null) => void;
}

/**
 * 进程实例
 */
interface ProcessInstance {
  config: ProcessConfig;
  state: ProcessState;
  child?: ChildProcess;
  restartTimer?: NodeJS.Timeout;
  monitorTimer?: NodeJS.Timeout;
  startTime: number;
  /** 由 stop() 显式停止，不触发 autorestart */
  intentionallyStopped?: boolean;
  /** 启动完成标志（1秒快速失败检测通过后设为 true） */
  startupCompleted?: boolean;
}

/**
 * 进程管理器
 */
export class ProcessManager extends EventEmitter {
  private stateManager: StateManager;
  private logManager: LogManager;
  private resourceMonitor: ResourceMonitor;
  private processes: Map<string, ProcessInstance> = new Map();
  private isShuttingDown = false;

  constructor(options?: { baseDir?: string }) {
    super();
    this.stateManager = new StateManager(options?.baseDir);
    this.logManager = new LogManager({ 
      logsDir: this.stateManager.getLogsDir() 
    });
    this.resourceMonitor = new ResourceMonitor();
  }

  /**
   * 获取状态管理器
   */
  getStateManager(): StateManager {
    return this.stateManager;
  }

  /**
   * 获取日志管理器
   */
  getLogManager(): LogManager {
    return this.logManager;
  }

  /**
   * 启动进程
   */
  async start(config: ProcessConfig): Promise<ProcessState> {
    const name = config.name;

    // 检查是否已存在
    if (this.processes.has(name)) {
      const existing = this.processes.get(name)!;
      if (existing.state.status === 'online' || existing.state.status === 'starting') {
        throw new Error(`进程 ${name} 已在运行 (PID: ${existing.state.pid})`);
      }
    }

    // 重置状态
    const state: ProcessState = {
      name,
      config,
      pid: null,
      status: 'starting',
      restarts: 0,
      uptime: 0,
      logFiles: this.stateManager.getLogPaths(name),
    };

    this.stateManager.saveProcess(state);

    // 创建实例
    const instance: ProcessInstance = {
      config,
      state,
      startTime: Date.now(),
    };

    this.processes.set(name, instance);

    // 启动
    await this.spawnProcess(instance);

    return instance.state;
  }

  /**
   * 停止进程
   */
  async stop(name: string, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const instance = this.processes.get(name);
    if (!instance) {
      throw new Error(`进程 ${name} 不存在`);
    }

    // 取消待重启
    if (instance.restartTimer) {
      clearTimeout(instance.restartTimer);
      instance.restartTimer = undefined;
    }

    // 停止监控
    if (instance.monitorTimer) {
      clearInterval(instance.monitorTimer);
      instance.monitorTimer = undefined;
    }

    // 标记为显式停止，handleExit 不触发 autorestart
    instance.intentionallyStopped = true;

    // 更新状态
    instance.state.status = 'stopping';
    this.stateManager.saveProcess(instance.state);

    // 发送信号
    if (instance.child && !instance.child.killed && instance.state.pid) {
      try {
        instance.child.kill(signal);

        // 等待进程退出或超时
        const killTimeout = instance.config.killTimeout || 5000;
        await this.waitForExit(instance, killTimeout);

        // 如果还在运行，强制 SIGKILL
        if (instance.child && !instance.child.killed) {
          instance.child.kill('SIGKILL');
        }
      } catch (error) {
        // 进程可能已经退出
      }
    }

    // handleExit() 可能已经通过 exit 事件先行清理（intentionallyStopped 路径）
    // 只在未被 handleExit 清理时再做一次兜底
    if (this.processes.has(name)) {
      instance.state.status = 'stopped';
      instance.state.pid = null;
      instance.state.stoppedAt = new Date().toISOString();
      this.stateManager.saveProcess(instance.state);
      this.logManager.close(name);
      this.processes.delete(name);
    }

    this.emit('stop', name, instance.state.lastExitCode || 0, instance.state.lastExitSignal);
  }

  /**
   * 重启进程
   */
  async restart(name: string): Promise<ProcessState> {
    // If process is currently online (in-memory), stop then start.
    const instance = this.processes.get(name);

    // If it's not in memory (e.g., previously stopped), fall back to persisted state.
    const persisted = this.stateManager.getProcess(name);
    const config = instance?.config || persisted?.config;

    if (!config) {
      throw new Error(`进程 ${name} 不存在`);
    }

    if (instance) {
      await this.stop(name);
      // 短暂延迟后重启
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return this.start(config);
  }

  /**
   * 发送信号
   */
  signal(name: string, signal: NodeJS.Signals): void {
    const instance = this.processes.get(name);
    if (!instance) {
      throw new Error(`进程 ${name} 不存在`);
    }

    if (instance.child && !instance.child.killed && instance.state.pid) {
      try {
        process.kill(instance.state.pid, signal);
      } catch (error) {
        throw new Error(`发送信号失败: ${error}`);
      }
    } else {
      throw new Error(`进程 ${name} 未运行`);
    }
  }

  /**
   * 获取进程状态
   */
  getState(name: string): ProcessState | undefined {
    // 先从内存获取（更实时）
    const instance = this.processes.get(name);
    if (instance) {
      return { ...instance.state };
    }
    // 从文件获取
    return this.stateManager.getProcess(name);
  }

  /**
   * 列出所有进程
   */
  list(): ProcessState[] {
    const states = this.stateManager.listProcesses();
    
    // 合并内存中的实时状态
    for (const state of states) {
      const instance = this.processes.get(state.name);
      if (instance) {
        Object.assign(state, instance.state);
      }
    }

    return states;
  }

  /**
   * 删除进程（停止 + 从列表移除）
   */
  async delete(name: string): Promise<void> {
    const instance = this.processes.get(name);
    if (instance) {
      await this.stop(name);
    }
    
    this.stateManager.deleteProcess(name);
    this.logManager.remove(name);
  }

  /**
   * 停止所有进程（用于 daemon 关闭）
   */
  async stopAll(): Promise<void> {
    this.isShuttingDown = true;
    const names = Array.from(this.processes.keys());
    
    console.log(`[ProcessManager] 正在停止 ${names.length} 个进程...`);

    await Promise.all(names.map(name => 
      this.stop(name).catch(err => {
        console.error(`[ProcessManager] 停止 ${name} 失败:`, err);
      })
    ));

    console.log('[ProcessManager] 所有进程已停止');
  }

  /**
   * 生成子进程
   */
  private async spawnProcess(instance: ProcessInstance): Promise<void> {
    const { config, state } = instance;

    try {
      // 构建命令 - 使用绝对路径
      const { command, args } = buildCommand(config);

      // 准备环境变量
      const env = {
        ...process.env,
        ...config.env,
        WP_PROCESS_NAME: config.name,
        WP_PROCESS_VERSION: '2.0.0',
      };

      // 设置工作目录
      const cwd = config.cwd ? resolve(config.cwd) : process.cwd();

      // 准备日志
      const logStreams = this.logManager.setup(config.name);

      // 启动进程
      const spawnOptions: SpawnOptions = {
        cwd,
        env,
        detached: true,  // 独立进程组，防止父进程 SIGTERM 传播
        stdio: ['ignore', 'pipe', 'pipe'],
      };

      const child = spawn(command, args, spawnOptions);

      instance.child = child;
      state.pid = child.pid || null;
      state.status = 'online';
      state.startedAt = new Date().toISOString();
      state.error = undefined;

      this.stateManager.saveProcess(state);

      // 重定向输出到日志
      child.stdout?.on('data', (data: Buffer) => {
        this.logManager.write(config.name, 'out', data.toString());
      });

      child.stderr?.on('data', (data: Buffer) => {
        this.logManager.write(config.name, 'err', data.toString());
      });

      // 监听退出
      child.on('exit', (code, signal) => {
        this.handleExit(instance, code, signal);
      });

      child.on('error', (error) => {
        this.handleError(instance, error);
      });

      // 启动资源监控
      this.startMonitoring(instance);

      this.emit('start', config.name, child.pid!);

      // 快速失败检测：如果进程在 1 秒内退出，可能是启动失败
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          // 1 秒后还没退出，认为启动成功，标记 startupCompleted
          instance.startupCompleted = true;
          cleanup();
          resolve();
        }, 1000);

        const onExit = (code: number | null) => {
          cleanup();
          reject(new Error(`进程启动失败，退出码: ${code}`));
        };

        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };

        const cleanup = () => {
          clearTimeout(timeout);
          child.removeListener('exit', onExit);
          child.removeListener('error', onError);
        };

        child.once('exit', onExit);
        child.once('error', onError);
      });

    } catch (error) {
      state.status = 'errored';
      state.error = error instanceof Error ? error.message : String(error);
      this.stateManager.saveProcess(state);
      this.emit('error', config.name, error as Error);
      throw error;
    }
  }

  /**
   * 处理进程退出
   */
  private handleExit(
    instance: ProcessInstance,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    const { config, state } = instance;

    // 停止监控
    if (instance.monitorTimer) {
      clearInterval(instance.monitorTimer);
      instance.monitorTimer = undefined;
    }

    // 清理 CPU 缓存
    if (state.pid) {
      this.resourceMonitor.clearCache(state.pid);
    }

    // 更新状态
    state.lastExitCode = code;
    state.lastExitSignal = signal;
    state.status = 'stopped';
    state.pid = null;
    state.stoppedAt = new Date().toISOString();

    // 计算运行时间
    if (state.startedAt) {
      state.uptime = Date.now() - new Date(state.startedAt).getTime();
    }

    this.stateManager.saveProcess(state);

    this.emit('exit', config.name, code, signal);

    // 判断是否重启
    if (this.isShuttingDown) {
      return; // 正在关闭，不重启
    }

    const autorestart = config.autorestart !== false;
    const maxRestarts = config.maxRestarts ?? 10;

    // 显式 stop() 调用 或 autorestart=false → 不重启
    if (!autorestart || instance.intentionallyStopped) {
      this.logManager.close(config.name);
      this.processes.delete(config.name);
      return;
    }

    // 快速失败保护：启动期（1秒内）崩溃由 spawnProcess 的 catch 块处理
    // 避免与 Promise reject 路径竞争
    if (!instance.startupCompleted) {
      this.logManager.close(config.name);
      this.processes.delete(config.name);
      return;
    }

    // 检查重启次数
    if (state.restarts >= maxRestarts) {
      state.status = 'errored';
      state.error = `达到最大重启次数 (${maxRestarts})`;
      this.stateManager.saveProcess(state);
      this.logManager.close(config.name);
      this.processes.delete(config.name);
      this.emit('maxRestarts', config.name);
      return;
    }

    // 指数退避重启
    state.restarts++;
    state.status = 'crashed';
    this.stateManager.saveProcess(state);

    const delay = this.calculateRestartDelay(state.restarts, config.restartDelay);
    
    console.log(`[ProcessManager] ${config.name} 崩溃，${delay}ms 后第 ${state.restarts} 次重启...`);
    this.emit('crash', config.name, code || 1);
    this.emit('restart', config.name, state.restarts);

    instance.restartTimer = setTimeout(() => {
      this.spawnProcess(instance).catch(error => {
        console.error(`[ProcessManager] ${config.name} 重启失败:`, error);
      });
    }, delay);
  }

  /**
   * 处理进程错误
   */
  private handleError(instance: ProcessInstance, error: Error): void {
    console.error(`[ProcessManager] ${instance.config.name} 错误:`, error);
    this.emit('error', instance.config.name, error);
  }

  /**
   * 计算重启延迟（指数退避）
   */
  private calculateRestartDelay(attempt: number, baseDelay?: number): number {
    const base = baseDelay || 1000;
    const maxDelay = 30000; // 最大 30 秒
    const delay = Math.min(base * Math.pow(2, attempt - 1), maxDelay);
    // 添加随机抖动，避免雪崩
    return delay + Math.random() * 1000;
  }

  /**
   * 等待进程退出
   */
  private waitForExit(instance: ProcessInstance, timeout: number): Promise<void> {
    return new Promise((resolve) => {
      if (!instance.child || instance.child.killed) {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        resolve(); // 超时
      }, timeout);

      instance.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * 启动资源监控
   */
  private startMonitoring(instance: ProcessInstance): void {
    const interval = 5000; // 5 秒采集一次

    instance.monitorTimer = setInterval(async () => {
      if (!instance.state.pid || !instance.child) return;

      try {
        const usage = await this.resourceMonitor.getUsage(instance.state.pid);
        if (usage) {
          instance.state.cpu = usage.cpu;
          instance.state.memory = usage.memory;
          this.stateManager.saveProcess(instance.state);

          // 检查内存限制
          const maxMemory = instance.config.maxMemory;
          if (maxMemory && usage.memory > maxMemory * 1024 * 1024) {
            console.log(`[ProcessManager] ${instance.config.name} 内存超限 (${Math.round(usage.memory / 1024 / 1024)}MB > ${maxMemory}MB)，重启...`);
            this.restart(instance.config.name).catch(() => {});
          }
        }
      } catch (error) {
        // 忽略监控错误
      }
    }, interval);
  }
}

export default ProcessManager;
