// ============================================================
// ProcessState - 进程状态定义和持久化
//
// 定义进程配置、状态、持久化到 ~/.wp/state/processes.json
// ============================================================

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';

/**
 * 进程配置
 */
export interface ProcessConfig {
  /** 进程名称（唯一标识） */
  name: string;
  /** 脚本路径 */
  script: string;
  /** 命令行参数 */
  args?: string[];
  /** 工作目录 */
  cwd?: string;
  /** 环境变量 */
  env?: Record<string, string>;
  /** 解释器：auto | bun | node | bash | python3 */
  interpreter?: 'auto' | 'bun' | 'node' | 'bash' | 'python3';
  /** 最大重启次数，默认 10 */
  maxRestarts?: number;
  /** 重启间隔基数(ms)，指数退避，默认 1000 */
  restartDelay?: number;
  /** SIGTERM 后多久发 SIGKILL，默认 5000ms */
  killTimeout?: number;
  /** 是否自动重启，默认 true */
  autorestart?: boolean;
  /** 文件变更自动重启的路径 */
  watch?: string[];
  /** 内存上限 MB，超出重启 */
  maxMemory?: number;
  /** 单个日志文件上限，如 "50M" */
  logMaxSize?: string;
  /** 保留几个轮转日志，默认 5 */
  logRetain?: number;
  /** cron 表达式定时重启 */
  cronRestart?: string;
  /** 进程分组 */
  group?: string;
  /** 实例数量（cluster 模式） */
  instances?: number;
}

/**
 * 进程运行状态
 */
export type ProcessStatus = 
  | 'online'      // 运行中
  | 'starting'    // 启动中
  | 'stopping'    // 停止中
  | 'stopped'     // 已停止
  | 'errored'     // 错误（达到重启上限）
  | 'crashed';    // 崩溃待重启

/**
 * 进程状态
 */
export interface ProcessState {
  /** 进程名称 */
  name: string;
  /** 配置 */
  config: ProcessConfig;
  /** PID */
  pid: number | null;
  /** 运行状态 */
  status: ProcessStatus;
  /** 重启次数 */
  restarts: number;
  /** 运行时间 ms */
  uptime: number;
  /** CPU 使用率 % */
  cpu?: number;
  /** 内存使用 bytes */
  memory?: number;
  /** 上次退出码 */
  lastExitCode?: number | null;
  /** 上次退出信号 */
  lastExitSignal?: string | null;
  /** 启动时间 ISO */
  startedAt?: string;
  /** 停止时间 ISO */
  stoppedAt?: string;
  /** 错误信息 */
  error?: string;
  /** 日志文件路径 */
  logFiles?: {
    out: string;
    err: string;
  };
}

/**
 * 全局状态
 */
export interface GlobalState {
  /** 所有进程状态 */
  processes: ProcessState[];
  /** 最后更新时间 */
  updatedAt: string;
  /** 版本 */
  version: string;
}

/**
 * 状态管理器
 */
export class StateManager {
  private baseDir: string;
  private stateFile: string;
  private daemonPidFile: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || join(homedir(), '.wp');
    this.stateFile = join(this.baseDir, 'state', 'processes.json');
    this.daemonPidFile = join(this.baseDir, 'state', 'daemon.pid');
    this.ensureDirs();
  }

  private ensureDirs(): void {
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }
    if (!existsSync(join(this.baseDir, 'state'))) {
      mkdirSync(join(this.baseDir, 'state'), { recursive: true });
    }
    if (!existsSync(join(this.baseDir, 'logs'))) {
      mkdirSync(join(this.baseDir, 'logs'), { recursive: true });
    }
  }

  /**
   * 获取状态文件路径
   */
  getStateFile(): string {
    return this.stateFile;
  }

  /**
   * 获取日志目录
   */
  getLogsDir(): string {
    return join(this.baseDir, 'logs');
  }

  /**
   * 获取 socket 路径
   */
  getSocketPath(): string {
    return join(this.baseDir, 'sock');
  }

  /**
   * 加载全局状态
   */
  loadState(): GlobalState {
    if (!existsSync(this.stateFile)) {
      return {
        processes: [],
        updatedAt: new Date().toISOString(),
        version: '2.0.0',
      };
    }

    try {
      const data = readFileSync(this.stateFile, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      console.error('[StateManager] 加载状态失败:', error);
      return {
        processes: [],
        updatedAt: new Date().toISOString(),
        version: '2.0.0',
      };
    }
  }

  /**
   * 保存全局状态（原子写）
   */
  saveState(state: GlobalState): void {
    state.updatedAt = new Date().toISOString();
    const tmpFile = this.stateFile + '.tmp';
    try {
      // 先写入临时文件
      writeFileSync(tmpFile, JSON.stringify(state, null, 2));
      // 原子rename覆盖原文件
      renameSync(tmpFile, this.stateFile);
    } catch (error) {
      console.error('[StateManager] 保存状态失败:', error);
    }
  }

  /**
   * 获取单个进程状态
   */
  getProcess(name: string): ProcessState | undefined {
    const state = this.loadState();
    return state.processes.find(p => p.name === name);
  }

  /**
   * 保存进程状态
   */
  saveProcess(processState: ProcessState): void {
    const state = this.loadState();
    const index = state.processes.findIndex(p => p.name === processState.name);

    if (index >= 0) {
      state.processes[index] = processState;
    } else {
      state.processes.push(processState);
    }

    this.saveState(state);
  }

  /**
   * 删除进程状态
   */
  deleteProcess(name: string): void {
    const state = this.loadState();
    state.processes = state.processes.filter(p => p.name !== name);
    this.saveState(state);
  }

  /**
   * 列出所有进程
   */
  listProcesses(): ProcessState[] {
    return this.loadState().processes;
  }

  /**
   * 写入 daemon PID
   */
  setDaemonPid(pid: number): void {
    try {
      writeFileSync(this.daemonPidFile, String(pid));
    } catch (error) {
      console.error('[StateManager] 写入 daemon PID 失败:', error);
    }
  }

  /**
   * 读取 daemon PID
   */
  getDaemonPid(): number | null {
    try {
      if (!existsSync(this.daemonPidFile)) return null;
      const data = readFileSync(this.daemonPidFile, 'utf-8').trim();
      const pid = parseInt(data, 10);
      return isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  /**
   * 清除 daemon PID
   */
  clearDaemonPid(): void {
    try {
      if (existsSync(this.daemonPidFile)) {
        writeFileSync(this.daemonPidFile, '');
      }
    } catch (error) {
      console.error('[StateManager] 清除 daemon PID 失败:', error);
    }
  }

  /**
   * 生成日志文件路径
   */
  getLogPaths(name: string): { out: string; err: string } {
    const logsDir = this.getLogsDir();
    return {
      out: join(logsDir, `${name}-out.log`),
      err: join(logsDir, `${name}-err.log`),
    };
  }
}

/**
 * 检测解释器
 */
export function detectInterpreter(script: string): string {
  const ext = script.split('.').pop()?.toLowerCase();
  
  switch (ext) {
    case 'ts':
      return 'bun';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'node';
    case 'sh':
      return 'bash';
    case 'py':
      return 'python3';
    default:
      // 检查 shebang
      try {
        if (existsSync(script)) {
          const content = readFileSync(script, 'utf-8');
          const shebang = content.split('\n')[0];
          if (shebang.startsWith('#!')) {
            if (shebang.includes('bun')) return 'bun';
            if (shebang.includes('node')) return 'node';
            if (shebang.includes('python')) return 'python3';
            if (shebang.includes('bash') || shebang.includes('sh')) return 'bash';
          }
        }
      } catch {}
      
      // 默认可执行文件
      return script;
  }
}

/**
 * 构建命令
 */
export function buildCommand(config: ProcessConfig): { command: string; args: string[] } {
  const interpreter = config.interpreter === 'auto' || !config.interpreter
    ? detectInterpreter(config.script)
    : config.interpreter;

  // 处理脚本路径：绝对路径直接用，相对路径相对于 cwd
  const scriptPath = (() => {
    const cwd = config.cwd || process.cwd();
    if (config.script.startsWith('/')) return config.script;
    return resolve(cwd, config.script);
  })();

  const isBun = typeof (process as any).versions?.bun === 'string';
  const bunPath = isBun ? process.execPath : 'bun';
  const nodePath = !isBun ? process.execPath : 'node';

  switch (interpreter) {
    case 'bun':
      return { command: bunPath, args: ['run', scriptPath, ...(config.args || [])] };
    case 'node':
      return { command: nodePath, args: [scriptPath, ...(config.args || [])] };
    case 'bash':
      return { command: 'bash', args: [scriptPath, ...(config.args || [])] };
    case 'python3':
      return { command: 'python3', args: [scriptPath, ...(config.args || [])] };
    default:
      return { command: scriptPath, args: config.args || [] };
  }
}

export default StateManager;
