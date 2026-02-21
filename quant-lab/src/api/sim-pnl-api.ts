/**
 * 模拟PnL HTTP API
 *
 * 仅监听127.0.0.1
 *
 * 端点:
 *   GET  /api/v1/sim/pnl        - 获取模拟PnL数据
 *   POST /api/v1/sim/pnl/reset  - 重置模拟PnL数据
 *
 * 权限控制:
 *   - 仅127.0.0.1可访问
 *   - 审计日志记录所有请求
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { QuickJSStrategy } from '../sandbox/QuickJSStrategy';

// 兼容获取home目录
function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || '/tmp';
}

// ================================
// 类型定义
// ================================

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
  const logFile = join(auditDir, 'sim-pnl-api.log');

  try {
    if (!existsSync(auditDir)) {
      mkdirSync(auditDir, { recursive: true });
    }

    const line = JSON.stringify(log) + '\n';
    const existing = existsSync(logFile) ? readFileSync(logFile, 'utf-8') : '';
    writeFileSync(logFile, existing + line);
  } catch (error) {
    console.error('[SimPnlAPI] 审计日志写入失败:', error);
  }
}

// ================================
// 模拟PnL API
// ================================

class SimPnlAPI {
  private server?: Server;
  private strategyMap = new Map<string, QuickJSStrategy>();  // strategyId -> QuickJSStrategy

  /**
   * 注册策略实例
   */
  registerStrategy(strategyId: string, strategy: QuickJSStrategy) {
    this.strategyMap.set(strategyId, strategy);
    console.log(`[SimPnlAPI] 注册策略: ${strategyId}`);
  }

  /**
   * 注销策略实例
   */
  unregisterStrategy(strategyId: string) {
    this.strategyMap.delete(strategyId);
    console.log(`[SimPnlAPI] 注销策略: ${strategyId}`);
  }

  /**
   * 启动HTTP服务
   */
  start(port = 9091): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res);
      });

      // 仅监听127.0.0.1
      this.server.listen(port, '127.0.0.1', () => {
        console.log(`[SimPnlAPI] HTTP服务启动: http://127.0.0.1:${port}`);
        console.log(`[SimPnlAPI] 仅本机可访问 (127.0.0.1)`);
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
          case 'GET /api/v1/sim/pnl':
            result = this.handleGetPnl(requestData);
            break;

          case 'POST /api/v1/sim/pnl/reset':
            result = this.handleResetPnl(requestData);
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
   * 获取PnL数据
   */
  private handleGetPnl(request: { strategyId?: string }): any {
    const { strategyId } = request;

    if (strategyId) {
      // 获取指定策略
      const strategy = this.strategyMap.get(strategyId);
      if (!strategy) {
        return {
          success: false,
          error: `Strategy not found: ${strategyId}`,
        };
      }

      const data = strategy.getSimPnlData();
      return {
        success: true,
        strategyId,
        ...data,
      };
    } else {
      // 获取所有策略
      const allData: Record<string, any> = {};
      for (const [sid, strategy] of this.strategyMap.entries()) {
        allData[sid] = strategy.getSimPnlData();
      }

      return {
        success: true,
        strategies: allData,
        count: this.strategyMap.size,
      };
    }
  }

  /**
   * 重置PnL数据
   */
  private handleResetPnl(request: { strategyId?: string }): any {
    const { strategyId } = request;

    if (strategyId) {
      // 重置指定策略
      const strategy = this.strategyMap.get(strategyId);
      if (!strategy) {
        return {
          success: false,
          error: `Strategy not found: ${strategyId}`,
        };
      }

      strategy.resetSimPnl();
      return {
        success: true,
        strategyId,
        message: 'PnL data reset successfully',
      };
    } else {
      // 重置所有策略
      for (const strategy of this.strategyMap.values()) {
        strategy.resetSimPnl();
      }

      return {
        success: true,
        message: `All ${this.strategyMap.size} strategies PnL data reset`,
      };
    }
  }

  /**
   * 停止服务
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('[SimPnlAPI] HTTP服务已停止');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

// 导出单例
export const simPnlAPI = new SimPnlAPI();
export { SimPnlAPI };
