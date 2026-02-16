// ============================================================
// start command - 启动进程
// ============================================================

import type { Daemon } from '../../daemon/Daemon';
import type { ProcessConfig } from '../../process/ProcessState';

export async function startCommand(
  args: string[],
  options: Record<string, string | boolean>,
  daemon: Daemon
): Promise<void> {
  const script = args[0];
  if (!script) {
    console.error('错误: 请指定脚本路径');
    console.error('用法: wp start <script> [options]');
    process.exit(1);
  }

  // 解析配置
  const name = (options.name as string) || script.split('/').pop()!.replace(/\.[^.]+$/, '');
  const instances = options.instances ? parseInt(options.instances as string, 10) : 1;
  
  const config: ProcessConfig = {
    name,
    script,
    interpreter: (options.interpreter as 'auto' | 'bun' | 'node' | 'bash' | 'python3') || 'auto',
    cwd: (options.cwd as string) || process.cwd(),
    args: args.slice(1),
    maxRestarts: options['max-restarts'] ? parseInt(options['max-restarts'] as string, 10) : 10,
    autorestart: options['no-autorestart'] !== true,
    maxMemory: options['max-memory'] ? parseInt(options['max-memory'] as string, 10) : undefined,
    group: (options.group as string) || undefined,
  };

  // Cluster 模式：启动多个实例
  if (instances > 1) {
    console.log(`[wp] 启动 ${instances} 个实例...`);
    for (let i = 0; i < instances; i++) {
      const instanceName = i === 0 ? name : `${name}-${i}`;
      const instanceConfig = { ...config, name: instanceName };
      
      try {
        const result = await daemon.sendCommand({
          action: 'start',
          payload: { config: instanceConfig },
        });

        if (result.ok) {
          console.log(`[wp] 已启动: ${instanceName} (PID: ${result.data?.pid})`);
        } else {
          console.error(`[wp] 启动失败: ${instanceName} - ${result.error}`);
        }
      } catch (err) {
        console.error(`[wp] 启动失败: ${instanceName}`, err);
      }
    }
    return;
  }

  // 解析环境变量 --env KEY=VAL（支持多次指定，会合并）
  if (options.env) {
    const envList = Array.isArray(options.env) ? options.env : [options.env];
    for (const envStr of envList as string[]) {
      const [key, ...valParts] = envStr.split('=');
      const val = valParts.join('=');
      if (key && val !== undefined) {
        config.env = { ...config.env, [key]: val };
      }
    }
  }

  console.log(`[wp] 启动进程: ${config.name}`);
  
  try {
    const result = await daemon.sendCommand({
      action: 'start',
      payload: { config },
    });

    if (result.ok) {
      console.log(`[wp] 进程已启动: ${result.data?.pid}`);
    } else {
      console.error(`[wp] 启动失败: ${result.error}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`[wp] 启动失败: ${err}`);
    process.exit(1);
  }
}
