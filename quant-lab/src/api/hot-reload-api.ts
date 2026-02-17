/**
 * 热更新HTTP API
 * 
 * 仅监听127.0.0.1，支持HTTP和Unix Socket两种方式
 * 
 * 端点:
 *   POST /api/v1/reload     - 触发热更新
 *   POST /api/v1/rollback   - 触发回滚
 *   GET  /api/v1/snapshots  - 获取快照列表
 *   GET  /api/v1/status     - 获取状态
 * 
 * 权限控制:
 *   - 仅127.0.0.1可访问
 *   - 审计日志记录所有请求
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { HotReloadManager } from '../hot-reload/HotReloadManager';

// 兼容获取home目录
function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || '/tmp';
}

// ================================
// 类型定义
// ================================

interface ReloadRequest {
  strategyId: string;
  target: 'strategy' | 'module' | 'provider' | 'all';
  dryRun?: boolean;
  force?: boolean;
}

interface ReloadResult {
  success: boolean;
  strategyId: string;
  target: string;
  duration: number;
  error?: string;
  snapshot?: {
    timestamp: number;
    hash: string;
  };
}

interface AuditLog {
  timestamp: string;
  method: string;
  path: string;
  clientIp: string;
  request: any;
  result: 'success' | 'failure';
  error?: string;
  durationMs: number;
}

// ================================
// 审计日志
// ================================

function writeAuditLog(log: AuditLog) {
  const auditDir = join(getHomeDir(), '.quant-lab', 'audit');
  const logFile = join(auditDir, 'reload-api.log');
  
  try {
    if (!existsSync(auditDir)) {
      mkdirSync(auditDir, { recursive: true });
    }
    
    const line = JSON.stringify(log) + '\n';
    const existing = existsSync(logFile) ? readFileSync(logFile, 'utf-8') : '';
    writeFileSync(logFile, existing + line);
  } catch (error) {
    console.error('[HotReloadAPI] 审计日志写入失败:', error);
  }
}

// ================================
// 热更新管理器
// ================================

class HotReloadAPI {
  private server?: Server;
  private manager: HotReloadManager;
  private strategyMap = new Map<string, any>();  // strategyId -> QuickJSStrategy

  constructor() {
    this.manager = new HotReloadManager();
  }

  /**
   * 注册策略实例
   */
  registerStrategy(strategyId: string, strategy: any) {
    this.strategyMap.set(strategyId, strategy);
    console.log(`[HotReloadAPI] 注册策略: ${strategyId}`);
  }

  /**
   * 启动HTTP服务
   */
  start(port = 9090): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res);
      });

      // 仅监听127.0.0.1
      this.server.listen(port, '127.0.0.1', () => {
        console.log(`[HotReloadAPI] HTTP服务启动: http://127.0.0.1:${port}`);
        console.log(`[HotReloadAPI] 仅本机可访问 (127.0.0.1)`);
        resolve();
      });
    });
  }

  /**
   * 处理请求
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse) {
    const startTime = Date.now();
    const clientIp = req.socket.remoteAddress || 'unknown';
    
    // 权限检查：仅允许127.0.0.1
    if (clientIp !== '127.0.0.1' && clientIp !== '::1' && !clientIp.startsWith('::ffff:127.')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: Local access only' }));
      return;
    }

    // 解析请求体
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      const method = req.method || 'GET';
      const path = req.url || '/';
      
      try {
        let requestData: any = {};
        if (body) {
          requestData = JSON.parse(body);
        }

        let result: any;

        switch (`${method} ${path}`) {
          case 'POST /api/v1/reload':
            result = await this.handleReload(requestData);
            break;
          
          case 'POST /api/v1/rollback':
            result = await this.handleRollback(requestData);
            break;
          
          case 'GET /api/v1/snapshots':
            result = this.handleListSnapshots(requestData);
            break;
          
          case 'GET /api/v1/status':
            result = this.handleStatus(requestData);
            break;
          
          default:
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not Found' }));
            return;
        }

        const duration = Date.now() - startTime;

        // 写审计日志
        writeAuditLog({
          timestamp: new Date().toISOString(),
          method,
          path,
          clientIp,
          request: requestData,
          result: result.success ? 'success' : 'failure',
          error: result.error,
          durationMs: duration,
        });

        res.writeHead(result.success ? 200 : 400, { 
          'Content-Type': 'application/json',
          'X-Response-Time': `${duration}ms`,
        });
        res.end(JSON.stringify(result));

      } catch (error: any) {
        const duration = Date.now() - startTime;
        
        writeAuditLog({
          timestamp: new Date().toISOString(),
          method,
          path,
          clientIp,
          request: body,
          result: 'failure',
          error: error.message,
          durationMs: duration,
        });

        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: false, 
          error: error.message,
        }));
      }
    });
  }

  /**
   * 处理热更新请求
   */
  private async handleReload(request: ReloadRequest): Promise<ReloadResult> {
    const { strategyId, target = 'strategy', dryRun = false, force = false } = request;
    
    console.log(`[HotReloadAPI] 热更新请求: ${strategyId}, target=${target}`);
    
    // 获取策略实例
    const strategy = this.strategyMap.get(strategyId);
    if (!strategy) {
      return {
        success: false,
        strategyId,
        target,
        duration: 0,
        error: `Strategy not found: ${strategyId}`,
      };
    }

    const startTime = Date.now();

    try {
      if (target === 'strategy') {
        // 调用策略的reload方法
        await strategy.reload();
      } else {
        // 其他目标通过HotReloadManager
        const result = await this.manager.reload(strategyId, { target, dryRun, force });
        
        if (!result.success) {
          return {
            success: false,
            strategyId,
            target,
            duration: Date.now() - startTime,
            error: result.error,
          };
        }
      }

      const duration = Date.now() - startTime;
      
      return {
        success: true,
        strategyId,
        target,
        duration,
        snapshot: {
          timestamp: Date.now(),
          hash: this.generateHash(),
        },
      };

    } catch (error: any) {
      return {
        success: false,
        strategyId,
        target,
        duration: Date.now() - startTime,
        error: error.message,
      };
    }
  }

  /**
   * 处理回滚请求
   */
  private async handleRollback(request: { strategyId: string; toSnapshotId?: string }): Promise<ReloadResult> {
    const { strategyId, toSnapshotId } = request;
    
    console.log(`[HotReloadAPI] 回滚请求: ${strategyId}, to=${toSnapshotId || 'previous'}`);
    
    const strategy = this.strategyMap.get(strategyId);
    if (!strategy) {
      return {
        success: false,
        strategyId,
        target: 'rollback',
        duration: 0,
        error: `Strategy not found: ${strategyId}`,
      };
    }

    const startTime = Date.now();

    try {
      // 获取快照
      let snapshot: any;
      
      if (toSnapshotId) {
        // 指定快照
        snapshot = this.loadSnapshot(toSnapshotId);
      } else {
        // 上一版本
        snapshot = this.getPreviousSnapshot(strategyId);
      }

      if (!snapshot) {
        return {
          success: false,
          strategyId,
          target: 'rollback',
          duration: Date.now() - startTime,
          error: 'No snapshot available for rollback',
        };
      }

      // 执行回滚
      await strategy.restoreSnapshot(snapshot);

      return {
        success: true,
        strategyId,
        target: 'rollback',
        duration: Date.now() - startTime,
        snapshot: {
          timestamp: snapshot.timestamp,
          hash: snapshot.hash,
        },
      };

    } catch (error: any) {
      return {
        success: false,
        strategyId,
        target: 'rollback',
        duration: Date.now() - startTime,
        error: error.message,
      };
    }
  }

  /**
   * 获取快照列表
   */
  private handleListSnapshots(request: { strategyId: string }): any {
    const { strategyId } = request;
    const snapshotDir = join(getHomeDir(), '.quant-lab', 'snapshots');
    
    const snapshots: any[] = [];
    
    try {
      if (existsSync(snapshotDir)) {
        const files = require('fs').readdirSync(snapshotDir);
        for (const file of files) {
          if (file.startsWith(`${strategyId}-`) && file.endsWith('.json')) {
            const path = join(snapshotDir, file);
            const content = readFileSync(path, 'utf-8');
            const data = JSON.parse(content);
            
            snapshots.push({
              id: file.replace('.json', ''),
              strategyId,
              timestamp: data.timestamp,
              hash: data.hash,
            });
          }
        }
      }
    } catch (error) {
      console.error('[HotReloadAPI] 读取快照失败:', error);
    }
    
    return {
      success: true,
      strategyId,
      snapshots: snapshots.sort((a, b) => b.timestamp - a.timestamp),
    };
  }

  /**
   * 获取状态
   */
  private handleStatus(request: { strategyId: string }): any {
    const { strategyId } = request;
    const strategy = this.strategyMap.get(strategyId);
    
    return {
      success: true,
      strategyId,
      registered: !!strategy,
      reloadAvailable: !!strategy?.reload,
    };
  }

  /**
   * 生成简单hash
   */
  private generateHash(): string {
    return Math.random().toString(36).substring(2, 15);
  }

  /**
   * 加载快照
   */
  private loadSnapshot(snapshotId: string): any {
    const snapshotDir = join(getHomeDir(), '.quant-lab', 'snapshots');
    const path = join(snapshotDir, `${snapshotId}.json`);
    
    if (!existsSync(path)) {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }
    
    return JSON.parse(readFileSync(path, 'utf-8'));
  }

  /**
   * 获取上一版本快照
   */
  private getPreviousSnapshot(strategyId: string): any {
    const snapshotDir = join(getHomeDir(), '.quant-lab', 'snapshots');
    
    if (!existsSync(snapshotDir)) {
      return null;
    }
    
    const files = require('fs').readdirSync(snapshotDir)
      .filter((f: string) => f.startsWith(`${strategyId}-`) && f.endsWith('.json'))
      .sort()
      .reverse();
    
    if (files.length < 2) {
      return null;  // 至少需要2个快照才能回滚到"上一版"
    }
    
    // 返回倒数第二个（上一版）
    const path = join(snapshotDir, files[1]);
    return JSON.parse(readFileSync(path, 'utf-8'));
  }

  /**
   * 停止服务
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('[HotReloadAPI] HTTP服务已停止');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

// 导出单例
export const hotReloadAPI = new HotReloadAPI();
export { HotReloadAPI };
