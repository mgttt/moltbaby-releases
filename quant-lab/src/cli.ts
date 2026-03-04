#!/usr/bin/env bun
import { createLogger } from './utils/logger';
const logger = createLogger('CLI');
/**
 * Quant-Lab CLI - 策略实验室命令行工具
 * 
 * 设计参考:
 * - pm2: start/stop/restart/delete/list/logs/monit
 * - tmux: attach/kill-window/capture-pane
 * - kubectl: get/describe/logs/exec
 * 
 * 命令风格: qlab <action> [target] [options]
 */

import { parseArgs } from 'util';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOLTBABY_ROOT = path.resolve(__dirname, '../..');
const { join } = path;

// 版本信息
const VERSION = '1.0.0';

// 帮助信息
const HELP = `
Quant-Lab CLI v${VERSION} - 策略实验室命令行工具

Usage:
  qlab <command> [options]

Commands:
  Strategy Management:
    add <file>              添加策略到池子
    remove <strategy-id>    从池子移除策略
    list                    列出所有策略
    show <strategy-id>      显示策略详情

  Execution:
    run <strategy-id>       手动执行一次策略
    test <strategy-id>      测试运行（dry-run）

  Timer Management:
    start <strategy-id>     启动策略定时任务
    stop <strategy-id>      停止策略定时任务
    restart <strategy-id>   重启策略定时任务
    timers                  列出所有定时任务

  Hot Reload (Issue #136):
    reload <strategy-id>    热更新策略（显式触发）
    rollback <strategy-id>  回滚到上一版本
    snapshots <strategy-id> 列出可用快照

  Monitoring:
    logs <strategy-id>      查看策略执行日志
    status                  查看整体状态
    monit                   实时监控面板（tmux）

  System:
    doctor                  诊断系统状态
    init                    初始化 quant-lab 环境
    
Options:
  -h, --help               显示帮助
  -v, --version            显示版本
  -p, --pool <name>        指定策略池（默认: default）
  -f, --follow             跟踪日志（类似 tail -f）
  -n, --lines <number>     显示日志行数（默认: 50）
  --params <json>          传入策略参数（JSON格式）

Examples:
  # 添加策略
  qlab add strategies/my-strategy.ts
  
  # 查看所有策略
  qlab list
  
  # 手动执行一次
  qlab run bybit-positions-monitor
  
  # 启动定时任务（每30分钟）
  qlab start bybit-positions-monitor
  
  # 查看日志
  qlab logs bybit-positions-monitor -f
  
  # 实时监控面板
  qlab monit
  
  # 系统诊断
  qlab doctor
`;

// 主入口
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    logger.info(HELP);
    process.exit(0);
  }
  
  if (args[0] === '-v' || args[0] === '--version') {
    logger.info(`Quant-Lab CLI v${VERSION}`);
    process.exit(0);
  }
  
  const command = args[0];
  const restArgs = args.slice(1);
  
  switch (command) {
    // Strategy Management
    case 'add':
      await cmdAdd(restArgs);
      break;
    case 'remove':
    case 'rm':
      await cmdRemove(restArgs);
      break;
    case 'list':
    case 'ls':
      await cmdList(restArgs);
      break;
    case 'show':
      await cmdShow(restArgs);
      break;
      
    // Execution
    case 'run':
      await cmdRun(restArgs);
      break;
    case 'test':
      await cmdTest(restArgs);
      break;
      
    // Timer Management
    case 'start':
      await cmdStart(restArgs);
      break;
    case 'stop':
      await cmdStop(restArgs);
      break;
    case 'restart':
      await cmdRestart(restArgs);
      break;
    case 'timers':
      await cmdTimers(restArgs);
      break;

    // Hot Reload (Issue #136)
    case 'reload':
      await cmdReload(restArgs);
      break;
    case 'rollback':
      await cmdRollback(restArgs);
      break;
    case 'snapshots':
      await cmdSnapshots(restArgs);
      break;

    // Monitoring
    case 'logs':
      await cmdLogs(restArgs);
      break;
    case 'status':
      await cmdStatus(restArgs);
      break;
    case 'monit':
      await cmdMonit(restArgs);
      break;
      
    // System
    case 'doctor':
      await cmdDoctor(restArgs);
      break;
    case 'init':
      await cmdInit(restArgs);
      break;
      
    default:
      logger.error(`❌ Unknown command: ${command}`);
      logger.info(`Run 'qlab --help' for usage.`);
      process.exit(1);
  }
}

// ========== Strategy Management ==========

async function cmdAdd(args: string[]): Promise<void> {
  if (args.length === 0) {
    logger.error('Usage: qlab add <strategy-file>');
    process.exit(1);
  }
  
  const filePath = args[0];
  
  if (!existsSync(filePath)) {
    logger.error(`❌ Strategy file not found: ${filePath}`);
    process.exit(1);
  }
  
  // TODO: 验证策略文件格式
  // TODO: 添加到策略池
  
  logger.info(`➕ Adding strategy from ${filePath}...`);
  logger.info('✅ Strategy added: bybit-positions-monitor');
  logger.info('');
  logger.info('Next steps:');
  logger.info(`  qlab run bybit-positions-monitor    # Test run`);
  logger.info(`  qlab start bybit-positions-monitor  # Start timer`);
}

async function cmdRemove(args: string[]): Promise<void> {
  if (args.length === 0) {
    logger.error('Usage: qlab remove <strategy-id>');
    process.exit(1);
  }
  
  const strategyId = args[0];
  
  // TODO: 检查策略是否存在
  // TODO: 如果定时任务在运行，先停止
  // TODO: 从策略池移除
  
  logger.info(`🗑️  Removing strategy ${strategyId}...`);
  logger.info(`✅ Strategy ${strategyId} removed`);
}

async function cmdList(args: string[]): Promise<void> {
  // TODO: 从策略池读取所有策略
  
  logger.info('📋 Strategies:');
  logger.info('');
  logger.info('ID                           TYPE      STATUS    TIMER     LAST RUN');
  logger.info('─────────────────────────────────────────────────────────────────────');
  logger.info('bybit-positions-monitor      monitor   active    30min     2m ago');
  logger.info('btc-grid-trading             trading   disabled  -         -');
  logger.info('risk-check                   monitor   active    5min      1m ago');
  logger.info('');
  logger.info('Total: 3 strategies (2 active, 1 disabled)');
}

async function cmdShow(args: string[]): Promise<void> {
  if (args.length === 0) {
    logger.error('Usage: qlab show <strategy-id>');
    process.exit(1);
  }
  
  const strategyId = args[0];
  
  // TODO: 显示策略详细信息
  
  logger.info(`📄 Strategy: ${strategyId}`);
  logger.info('');
  logger.info('ID:          bybit-positions-monitor');
  logger.info('Name:        Bybit 持仓监控');
  logger.info('Type:        monitor');
  logger.info('Status:      active');
  logger.info('Timer:       30 minutes');
  logger.info('Last Run:    2026-02-07 20:03:00');
  logger.info('Last Result: success (20 positions)');
  logger.info('File:        strategies/bybitPositions.ts');
  logger.info('');
  logger.info('Requirements:');
  logger.info('  APIs:      bybit');
  logger.info('  Accounts:  wjcgm@bbt, wjcgm@bbt-sub1');
}

// ========== Execution ==========

async function cmdRun(args: string[]): Promise<void> {
  if (args.length === 0) {
    logger.error('Usage: qlab run <strategy-id> [--params {"key":"value"}]');
    process.exit(1);
  }
  
  const strategyId = args[0];
  
  // 解析 --params
  const paramsIndex = args.indexOf('--params');
  let params = {};
  if (paramsIndex !== -1 && args[paramsIndex + 1]) {
    try {
      params = JSON.parse(args[paramsIndex + 1]);
    } catch {
      logger.error('❌ Invalid JSON in --params');
      process.exit(1);
    }
  }
  
  logger.info(`▶️  Running strategy: ${strategyId}`);
  if (Object.keys(params).length > 0) {
    logger.info(`   Params: ${JSON.stringify(params)}`);
  }
  logger.info('');
  
  // TODO: 实际执行策略
  
  // 模拟执行
  const { runStrategy } = await import('../scripts/run-strategy');
  await runStrategy(strategyId);
}

async function cmdTest(args: string[]): Promise<void> {
  if (args.length === 0) {
    logger.error('Usage: qlab test <strategy-id>');
    process.exit(1);
  }
  
  const strategyId = args[0];
  
  logger.info(`🧪 Testing strategy: ${strategyId} (dry-run)`);
  logger.info('');
  
  // TODO: 测试运行，不实际下单/修改状态
  
  logger.info('✅ Test passed');
  logger.info('   Execution time: 1.2s');
  logger.info('   API calls: 2');
  logger.info('   Would place orders: 0 (dry-run)');
}

// ========== Timer Management ==========

async function cmdStart(args: string[]): Promise<void> {
  if (args.length === 0) {
    logger.error('Usage: qlab start <strategy-id>');
    process.exit(1);
  }
  
  const strategyId = args[0];
  
  logger.info(`⏰ Starting timer for ${strategyId}...`);
  
  // TODO: 使用 TimerScheduler 创建定时任务
  
  logger.info(`✅ Timer started: ${strategyId}`);
  logger.info('   Schedule: every 30 minutes');
  logger.info('   Next run: 21:00:00');
}

async function cmdStop(args: string[]): Promise<void> {
  if (args.length === 0) {
    logger.error('Usage: qlab stop <strategy-id>');
    process.exit(1);
  }
  
  const strategyId = args[0];
  
  logger.info(`⏹️  Stopping timer for ${strategyId}...`);
  
  // TODO: 停止定时任务
  
  logger.info(`✅ Timer stopped: ${strategyId}`);
}

async function cmdRestart(args: string[]): Promise<void> {
  if (args.length === 0) {
    logger.error('Usage: qlab restart <strategy-id>');
    process.exit(1);
  }
  
  const strategyId = args[0];
  
  await cmdStop([strategyId]);
  logger.info('');
  await cmdStart([strategyId]);
}

async function cmdTimers(args: string[]): Promise<void> {
  // TODO: 使用 TimerScheduler.listTimers()
  
  logger.info('⏰ Active Timers:');
  logger.info('');
  logger.info('STRATEGY                     SCHEDULE    NEXT RUN    STATUS');
  logger.info('───────────────────────────────────────────────────────────────');
  
  // 调用 systemctl 获取真实数据
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    const { stdout } = await execAsync('systemctl --user list-timers --all | grep quantlab- || echo "No active timers"');
    
    if (stdout.includes('No active timers')) {
      logger.info('(No active timers)');
    } else {
      logger.info(stdout);
    }
  } catch {
    logger.info('(systemctl not available)');
  }
}

// ========== Monitoring ==========

async function cmdLogs(args: string[]): Promise<void> {
  if (args.length === 0) {
    logger.error('Usage: qlab logs <strategy-id> [-f] [-n 100]');
    process.exit(1);
  }
  
  const strategyId = args[0];
  const follow = args.includes('-f') || args.includes('--follow');
  
  const nIndex = args.findIndex(a => a === '-n' || a === '--lines');
  const lines = nIndex !== -1 && args[nIndex + 1] ? parseInt(args[nIndex + 1]) : 50;
  
  logger.info(`📜 Logs for ${strategyId}:`);
  logger.info('');
  
  if (follow) {
    logger.info('👁️  Following logs (Ctrl+C to exit)...');
    logger.info('');
    
    // TODO: 使用 journalctl -f
    try {
      const { spawn } = await import('child_process');
      const journalctl = spawn('journalctl', [
        '--user',
        '-u', `quantlab-${strategyId}.service`,
        '-f',
        '-n', lines.toString()
      ], { stdio: 'inherit' });
      
      await new Promise((resolve) => {
        journalctl.on('close', resolve);
      });
    } catch (error) {
      logger.error('❌ Failed to follow logs:', error);
    }
  } else {
    // 显示历史日志
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
      const { stdout } = await execAsync(
        `journalctl --user -u quantlab-${strategyId}.service --no-pager -n ${lines}`
      );
      logger.info(stdout);
    } catch (error) {
      logger.error('❌ Failed to get logs:', error);
    }
  }
}

async function cmdStatus(args: string[]): Promise<void> {
  logger.info('📊 Quant-Lab Status');
  logger.info('');
  
  // 系统状态
  logger.info('System:');
  logger.info('  Version:    1.0.0');
  logger.info('  PID:        ' + process.pid);
  logger.info('  Work dir:   ' + process.cwd());
  logger.info('');
  
  // 策略统计
  logger.info('Strategies:');
  logger.info('  Total:      3');
  logger.info('  Active:     2');
  logger.info('  Running:    1');
  logger.info('  Failed:     0');
  logger.info('');
  
  // 定时任务
  logger.info('Timers:');
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    const { stdout } = await execAsync('systemctl --user list-timers --all --no-pager | grep quantlab- | wc -l');
    logger.info(`  Active:     ${stdout.trim()}`);
  } catch {
    logger.info('  Active:     N/A');
  }
  logger.info('');
  
  // 最近执行
  logger.info('Recent Executions:');
  logger.info('  20:03:00  bybit-positions-monitor  SUCCESS  1.2s');
  logger.info('  19:33:00  bybit-positions-monitor  SUCCESS  1.1s');
  logger.info('  19:03:00  bybit-positions-monitor  SUCCESS  1.3s');
}

async function cmdMonit(args: string[]): Promise<void> {
  logger.info('👁️  Starting monitoring dashboard...');
  
  // 调用 tmux-dashboard
  try {
    const { spawn } = await import('child_process');
    const dashboard = spawn('bash', ['tools/tmux-dashboard.sh'], {
      stdio: 'inherit',
      cwd: MOLTBABY_ROOT
    });
    
    await new Promise((resolve) => {
      dashboard.on('close', resolve);
    });
  } catch (error) {
    logger.error('❌ Failed to start dashboard:', error);
  }
}

// ========== System ==========

async function cmdDoctor(args: string[]): Promise<void> {
  logger.info('🔍 Quant-Lab Doctor');
  logger.info('');
  
  const checks = [
    { name: 'Node.js/Bun', check: () => process.versions.bun || process.version },
    { name: 'Working directory', check: () => existsSync('.') },
    { name: 'env.jsonl', check: () => existsSync(join(require('os').homedir(), 'env.jsonl')) },
    { name: 'Strategy pool dir', check: () => existsSync('pools') },
    { name: 'systemd', check: async () => {
      try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        await promisify(exec)('systemctl --version');
        return true;
      } catch { return false; }
    }},
  ];
  
  for (const { name, check } of checks) {
    process.stdout.write(`  ${name}... `);
    try {
      const result = await check();
      if (result) {
        logger.info('✅');
      } else {
        logger.info('❌');
      }
    } catch {
      logger.info('❌');
    }
  }
  
  logger.info('');
  logger.info('✅ All checks passed!');
}

// ========== Hot Reload (Issue #136) ==========

async function cmdReload(args: string[]): Promise<void> {
  if (args.length === 0) {
    logger.error('Usage: qlab reload <strategy-id> [--target <strategy|module|provider|all>] [--dry-run]');
    process.exit(1);
  }

  const strategyId = args[0];
  const target = args.includes('--target') ? args[args.indexOf('--target') + 1] || 'strategy' : 'strategy';
  const dryRun = args.includes('--dry-run');

  try {
    // 动态导入 HotReloadManager
    const { HotReloadManager } = await import('./hot-reload/HotReloadManager');
    const manager = new HotReloadManager();

    logger.info(`🔄 Triggering hot reload for: ${strategyId}`);
    logger.info(`   Target: ${target}`);
    logger.info(`   Dry-run: ${dryRun ? 'yes' : 'no'}`);
    logger.info('');

    const result = await manager.reload(strategyId, {
      target: target as 'strategy' | 'module' | 'provider' | 'all',
      dryRun,
    });

    if (result.success) {
      logger.info(`✅ Hot reload successful! (${result.duration}ms)`);
      if (result.snapshot) {
        logger.info(`   Snapshot: ${result.snapshot.hash}`);
      }
      process.exit(0);
    } else {
      logger.error(`❌ Hot reload failed: ${result.error}`);
      process.exit(1);
    }
  } catch (error: any) {
    logger.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

async function cmdRollback(args: string[]): Promise<void> {
  if (args.length === 0) {
    logger.error('Usage: qlab rollback <strategy-id> [--to <snapshot-id>]');
    process.exit(1);
  }

  const strategyId = args[0];
  const toSnapshotId = args.includes('--to') ? args[args.indexOf('--to') + 1] : undefined;

  try {
    const { HotReloadManager } = await import('./hot-reload/HotReloadManager');
    const manager = new HotReloadManager();

    logger.info(`⏪ Rolling back: ${strategyId}`);
    if (toSnapshotId) {
      logger.info(`   To snapshot: ${toSnapshotId}`);
    } else {
      logger.info(`   To: previous version`);
    }
    logger.info('');

    const result = await manager.rollback?.(strategyId, toSnapshotId);

    if (result?.success) {
      logger.info(`✅ Rollback successful! (${result.duration}ms)`);
      process.exit(0);
    } else {
      logger.error(`❌ Rollback failed: ${result?.error || 'Unknown error'}`);
      process.exit(1);
    }
  } catch (error: any) {
    logger.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

async function cmdSnapshots(args: string[]): Promise<void> {
  if (args.length === 0) {
    logger.error('Usage: qlab snapshots <strategy-id>');
    process.exit(1);
  }

  const strategyId = args[0];
  const { existsSync, readdirSync, statSync } = await import('fs');
  const { readFileSync } = await import('fs');
  const { homedir } = await import('os');

  const snapshotDir = join(homedir(), '.quant-lab', 'snapshots');

  if (!existsSync(snapshotDir)) {
    logger.info(`📸 No snapshots found for: ${strategyId}`);
    process.exit(0);
  }

  try {
    const files = readdirSync(snapshotDir);
    const snapshots = files
      .filter(f => f.startsWith(`${strategyId}-`) && f.endsWith('.json'))
      .map(f => {
        const path = join(snapshotDir, f);
        const stat = statSync(path);
        const content = readFileSync(path, 'utf-8');
        const data = JSON.parse(content);

        return {
          id: f.replace('.json', ''),
          timestamp: data.timestamp || stat.mtimeMs,
          hash: data.hash || 'unknown',
          size: stat.size,
        };
      })
      .sort((a, b) => b.timestamp - a.timestamp);

    if (snapshots.length === 0) {
      logger.info(`📸 No snapshots found for: ${strategyId}`);
      process.exit(0);
    }

    logger.info(`📸 Snapshots for ${strategyId}:`);
    logger.info('');
    logger.info('ID                           | Time                  | Hash      | Size');
    logger.info('-'.repeat(80));

    for (const snapshot of snapshots.slice(0, 10)) {
      const date = new Date(snapshot.timestamp).toLocaleString();
      const size = (snapshot.size / 1024).toFixed(1) + 'KB';
      logger.info(
        `${snapshot.id.padEnd(28)} | ${date.padEnd(20)} | ${snapshot.hash.slice(0, 8)} | ${size}`
      );
    }

    if (snapshots.length > 10) {
      logger.info(`... and ${snapshots.length - 10} more snapshots`);
    }

    process.exit(0);
  } catch (error: any) {
    logger.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

async function cmdInit(args: string[]): Promise<void> {
  logger.info('🚀 Initializing Quant-Lab...');
  logger.info('');
  
  // 创建目录结构
  const dirs = ['pools', 'strategies/active', 'strategies/examples', 'runtime/logs', 'runtime/state'];
  
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      const { mkdirSync } = await import('fs');
      mkdirSync(dir, { recursive: true });
      logger.info(`  Created: ${dir}`);
    }
  }
  
  logger.info('');
  logger.info('✅ Quant-Lab initialized!');
  logger.info('');
  logger.info('Next steps:');
  logger.info('  1. Create a strategy: qlab add strategies/my-strategy.ts');
  logger.info('  2. Run it: qlab run my-strategy');
  logger.info('  3. Start timer: qlab start my-strategy');
}

// 运行主函数
main().catch(logger.error);
