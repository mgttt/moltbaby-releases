#!/usr/bin/env bun
/**
 * Quant-Lab CLI v3 - PM2 风格
 * 
 * 命令：
 *   qlab start [name]          启动实例
 *   qlab stop [name]           停止实例
 *   qlab restart [name]        重启实例
 *   qlab reload [name]         重载配置
 *   qlab delete <name>         删除实例
 *   qlab list                  列出实例
 *   qlab show <name>           显示详情
 *   qlab logs [name] [lines]   查看日志
 *   qlab monit                 监控面板
 *   qlab set <name> <k> <v>    设置环境变量
 * 
 * 配置：
 *   --config <path>            指定配置文件 (默认 ecosystem.config.js)
 */

import { createLogger } from './utils/logger';
const logger = createLogger('CLI');

import { StrategyConfigManager } from '../src/strategy/ConfigManager';
import { resolve } from 'path';

const HELP = `
Quant-Lab CLI v3.0 - PM2 Style Process Manager

Usage: qlab <command> [options]

Commands:
  start [name] [--config path]     启动策略实例
  stop [name]                      停止策略实例
  restart [name] [--update-env]    重启策略实例
  reload [name]                    重载配置（不重启）
  delete <name>                    删除策略实例
  list                             列出所有实例
  show <name>                      显示实例详情
  logs [name] [lines]              查看日志（默认50行）
  monit                            实时监控面板
  set <name> <key> <value>         设置环境变量

Options:
  --config, -c <path>              配置文件路径 (默认: ecosystem.config.js)
  --update-env                     重启时更新环境变量
  --lines, -n <number>             日志行数

Examples:
  # 启动所有实例
  qlab start
  
  # 启动特定实例
  qlab start grid-martingale-sub1
  
  # 使用指定配置
  qlab start --config ./my-config.js
  
  # 查看日志
  qlab logs grid-martingale-sub1 100
  
  # 设置环境变量
  qlab set grid-martingale-sub1 HTTP_PROXY http://127.0.0.1:8890
  
  # 监控面板
  qlab monit
`;

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    logger.info(HELP);
    process.exit(0);
  }
  
  const command = args[0];
  const restArgs = args.slice(1);
  
  // 解析选项
  const configIdx = restArgs.findIndex(a => a === '--config' || a === '-c');
  const configPath = configIdx !== -1 ? restArgs[configIdx + 1] : './ecosystem.config.js';
  
  const updateEnv = restArgs.includes('--update-env');
  
  const linesIdx = restArgs.findIndex(a => a === '--lines' || a === '-n');
  const lines = linesIdx !== -1 ? parseInt(restArgs[linesIdx + 1]) : 50;
  
  // 移除选项后的参数
  const positionalArgs = restArgs.filter((_, i) => {
    if (i === configIdx || i === configIdx + 1) return false;
    if (i === linesIdx || i === linesIdx + 1) return false;
    if (restArgs[i] === '--update-env') return false;
    return true;
  });
  
  // 创建管理器
  const manager = new StrategyConfigManager(resolve(configPath));
  
  switch (command) {
    case 'start': {
      const name = positionalArgs[0];
      await manager.start(name);
      break;
    }
    
    case 'stop': {
      const name = positionalArgs[0];
      await manager.stop(name);
      break;
    }
    
    case 'restart': {
      const name = positionalArgs[0];
      await manager.restart(name, updateEnv);
      break;
    }
    
    case 'reload': {
      const name = positionalArgs[0];
      await manager.reload(name);
      break;
    }
    
    case 'delete': {
      const name = positionalArgs[0];
      if (!name) {
        logger.error('Usage: qlab delete <name>');
        process.exit(1);
      }
      await manager.delete(name);
      break;
    }
    
    case 'list':
    case 'ls': {
      const instances = manager.list();
      
      if (instances.length === 0) {
        logger.info('No running instances');
        return;
      }
      
      logger.info('┌────────────────────────┬──────────┬──────────┬────────────┬──────────┐');
      logger.info('│ Name                   │ Status   │ Uptime   │ Restarts   │ Memory   │');
      logger.info('├────────────────────────┼──────────┼──────────┼────────────┼──────────┤');
      
      for (const inst of instances) {
        const uptime = formatUptime(Date.now() - inst.started_at);
        const memory = 'N/A'; // TODO: get memory usage
        logger.info(
          "│ " + inst.name.padEnd(22) + " │ ${inst.status.padEnd(8)} │ ${uptime.padEnd(8)} │ ${inst.restart_count.toString().padEnd(10)} │ ${memory.padEnd(8)} │"
        );
      }
      
      logger.info('└────────────────────────┴──────────┴──────────┴────────────┴──────────┘');
      break;
    }
    
    case 'show':
    case 'describe': {
      const name = positionalArgs[0];
      if (!name) {
        logger.error('Usage: qlab show <name>');
        process.exit(1);
      }
      
      const inst = manager.describe(name);
      if (!inst) {
        logger.error("Instance " + name + " not found");
        process.exit(1);
      }
      
      logger.info('Instance Details');
      logger.info('================');
      logger.info("Name:        " + inst.name + "");
      logger.info("Status:      " + inst.status + "");
      logger.info("PID:         " + inst.pid);
      logger.info("Uptime:      " + formatUptime(Date.now() - inst.started_at));
      logger.info("Restarts:    " + inst.restart_count);
      logger.info("Script:      " + inst.config.script);
      logger.info("Log File:    " + inst.config.log_file);
      logger.info('');
      logger.info('Environment Variables:');
      for (const [key, value] of Object.entries(inst.env)) {
        if (key.includes('KEY') || key.includes('SECRET')) {
          logger.info('  ' + key + '=***');
        } else {
          logger.info('  ' + key + '=' + value);
        }
      }
      break;
    }
    
    case 'logs': {
      const name = positionalArgs[0];
      const numLines = positionalArgs[1] ? parseInt(positionalArgs[1]) : lines;
      
      if (!name) {
        logger.error('Usage: qlab logs <name> [lines]');
        process.exit(1);
      }
      
      const logContent = await manager.logs(name, numLines);
      logger.info(logContent);
      break;
    }
    
    case 'monit': {
      manager.monit();
      break;
    }
    
    case 'set': {
      const [name, key, value] = positionalArgs;
      if (!name || !key || !value) {
        logger.error('Usage: qlab set <name> <key> <value>');
        process.exit(1);
      }
      
      await manager.setEnv(name, key, value);
      logger.info('Set ' + name + ' environment: ' + key + '=' + value);
      logger.info('Note: Changes will take effect on next restart');
      break;
    }
    
    default:
      logger.error('Unknown command: ' + command);
      logger.info(HELP);
      process.exit(1);
  }
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return "" + days + "d" + (hours % 24) + "h";
  if (hours > 0) return "" + hours + "h" + (minutes % 60) + "m";
  if (minutes > 0) return "" + minutes + "m" + (seconds % 60) + "s";
  return "" + seconds + "s";
}

main().catch((err) => logger.error(err));
