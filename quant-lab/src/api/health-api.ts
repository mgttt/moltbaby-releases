/**
 * 健康检查与监控 API
 * 
 * 端点:
 *   GET /health     - 存活检查（服务状态+依赖检查）
 *   GET /metrics    - 性能指标（吞吐量/延迟/错误率）
 *   GET /status     - 运行状态（策略运行状态+仓位）
 * 
 * 权限控制:
 *   - 仅127.0.0.1可访问
 *   - 审计日志记录所有请求
 */

import { createLogger } from '../utils/logger';
const logger = createLogger('health-api');

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

// 兼容获取home目录
function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || '/tmp';
}

// ================================
// 类型定义
// ================================

export interface HealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
  version: string;
  uptime: number;
  dependencies: {
    ndtsdb: boolean;
    quickjs: boolean;
    bybit?: boolean;
  };
  checks: {
    memory: { used: number; total: number; percentage: number };
    disk?: { used: number; total: number; percentage: number };
  };
}

export interface MetricsData {
  timestamp: string;
  throughput: {
    ordersPerSecond: number;
    quotesPerSecond: number;
  };
  latency: {
    p50: number;
    p95: number;
    p99: number;
  };
  errors: {
    rate: number;
    total: number;
    byType: Record<string, number>;
  };
  period: string;
}

export interface StrategyStatus {
  strategyId: string;
  state: 'running' | 'paused' | 'stopped' | 'error';
  position: {
    side: 'long' | 'short' | 'neutral';
    size: number;
    entryPrice: number;
    unrealizedPnl: number;
  };
  performance: {
    totalPnl: number;
    winRate: number;
    tradesCount: number;
  };
  lastUpdate: string;
}

export interface SystemStatus {
  timestamp: string;
  version: string;
  mode: 'paper' | 'live';
  strategies: StrategyStatus[];
  activeOrders: number;
  pendingOrders: number;
  riskLevel: 'low' | 'medium' | 'high';
}

interface AuditLog {
  timestamp: string;
  method: string;
  path: string;
  clientIp: string;
  result: 'success' | 'failure';
  error?: string;
  durationMs: number;
}

// ================================
// 审计日志
// ================================

function writeAuditLog(log: AuditLog) {
  const auditDir = join(getHomeDir(), '.quant-lab', 'audit');
  const logFile = join(auditDir, 'health-api.log');
  
  try {
    if (!existsSync(auditDir)) {
      mkdirSync(auditDir, { recursive: true });
    }
    
    const line = JSON.stringify(log) + '\n';
    appendFileSync(logFile, line);
  } catch (error) {
    logger.error('[HealthAPI] 审计日志写入失败:', error);
  }
}

// ================================
// 指标收集器
// ================================

class MetricsCollector {
  private orders: number = 0;
  private quotes: number = 0;
  private errors: Record<string, number> = {};
  private latencies: number[] = [];
  private startTime: number = Date.now();

  recordOrder() { this.orders++; }
  recordQuote() { this.quotes++; }
  recordError(type: string) { this.errors[type] = (this.errors[type] || 0) + 1; }
  recordLatency(ms: number) { this.latencies.push(ms); }

  getMetrics(periodSeconds: number = 60): MetricsData {
    const now = Date.now();
    const periodStart = now - periodSeconds * 1000;
    
    // 计算百分位数
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;

    const totalErrors = Object.values(this.errors).reduce((a, b) => a + b, 0);
    const total = this.orders + this.quotes + totalErrors;
    const errorRate = total > 0 ? (totalErrors / total) * 100 : 0;

    return {
      timestamp: new Date().toISOString(),
      throughput: {
        ordersPerSecond: Number((this.orders / periodSeconds).toFixed(2)),
        quotesPerSecond: Number((this.quotes / periodSeconds).toFixed(2)),
      },
      latency: { p50, p95, p99 },
      errors: {
        rate: Number(errorRate.toFixed(2)),
        total: totalErrors,
        byType: { ...this.errors },
      },
      period: `${periodSeconds}s`,
    };
  }

  reset() {
    this.orders = 0;
    this.quotes = 0;
    this.errors = {};
    this.latencies = [];
    this.startTime = Date.now();
  }
}

// ================================
// 健康检查 API
// ================================

export class HealthAPI {
  private server?: Server;
  private metrics: MetricsCollector = new MetricsCollector();
  private strategyStates = new Map<string, StrategyStatus>();
  private version: string = '0.1.0';
  private startTime: number = Date.now();

  /**
   * 启动HTTP服务
   */
  start(port = 9091): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.listen(port, '127.0.0.1', () => {
        logger.info(`[HealthAPI] HTTP服务启动: http://127.0.0.1:${port}`);
        logger.info(`[HealthAPI] 仅本机可访问 (127.0.0.1)`);
        resolve();
      });
    });
  }

  /**
   * 注册策略状态
   */
  registerStrategy(status: StrategyStatus) {
    this.strategyStates.set(status.strategyId, status);
  }

  /**
   * 更新策略状态
   */
  updateStrategy(strategyId: string, updates: Partial<StrategyStatus>) {
    const existing = this.strategyStates.get(strategyId);
    if (existing) {
      this.strategyStates.set(strategyId, { ...existing, ...updates });
    }
  }

  /**
   * 处理请求
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse) {
    const startTime = Date.now();
    const clientIp = req.socket.remoteAddress || 'unknown';
    
    // 权限检查
    if (clientIp !== '127.0.0.1' && clientIp !== '::1' && !clientIp.startsWith('::ffff:127.')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: Local access only' }));
      return;
    }

    const method = req.method || 'GET';
    const path = req.url || '/';
    
    try {
      let result: any;
      let statusCode = 200;

      switch (path) {
        case '/health':
          result = this.getHealth();
          if (result.status === 'unhealthy') statusCode = 503;
          break;
        
        case '/metrics':
          result = this.getMetrics();
          break;
        
        case '/status':
          result = this.getStatus();
          break;
        
        default:
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not Found', available: ['/health', '/metrics', '/status'] }));
          return;
      }

      const duration = Date.now() - startTime;

      writeAuditLog({
        timestamp: new Date().toISOString(),
        method,
        path,
        clientIp,
        result: 'success',
        durationMs: duration,
      });

      res.writeHead(statusCode, { 
        'Content-Type': 'application/json',
        'X-Response-Time': `${duration}ms`,
      });
      res.end(JSON.stringify(result, null, 2));

    } catch (error: any) {
      const duration = Date.now() - startTime;
      
      writeAuditLog({
        timestamp: new Date().toISOString(),
        method,
        path,
        clientIp,
        result: 'failure',
        error: error.message,
        durationMs: duration,
      });

      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        status: 'error',
        message: error.message,
      }));
    }
  }

  /**
   * 获取健康状态
   */
  private getHealth(): HealthStatus {
    const memUsage = process.memoryUsage();
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);

    // 检查依赖
    const checks = {
      ndtsdb: this.checkNDTSDB(),
      quickjs: true, // QuickJS 嵌入在进程中
      bybit: this.checkBybit(),
    };

    const allHealthy = Object.values(checks).every(v => v);
    const status = allHealthy ? 'healthy' : 'degraded';

    return {
      status,
      timestamp: new Date().toISOString(),
      version: this.version,
      uptime,
      dependencies: checks,
      checks: {
        memory: {
          used: Math.floor(memUsage.heapUsed / 1024 / 1024),
          total: Math.floor(memUsage.heapTotal / 1024 / 1024),
          percentage: Math.floor((memUsage.heapUsed / memUsage.heapTotal) * 100),
        },
      },
    };
  }

  /**
   * 检查 NDTSDB
   */
  private checkNDTSDB(): boolean {
    try {
      // 检查数据目录是否存在
      const dataDir = join(getHomeDir(), '.quant-lab', 'data');
      return existsSync(dataDir);
    } catch {
      return false;
    }
  }

  /**
   * 检查 Bybit 连接
   */
  private checkBybit(): boolean {
    // 简化检查：检查环境变量或配置
    return !!(process.env.BYBIT_API_KEY || process.env.BYBIT_KEY);
  }

  /**
   * 获取性能指标
   */
  private getMetrics(): MetricsData {
    return this.metrics.getMetrics();
  }

  /**
   * 获取系统状态
   */
  private getStatus(): SystemStatus {
    const strategies = Array.from(this.strategyStates.values());
    const activeOrders = strategies.reduce((sum, s) => sum + (s.state === 'running' ? 1 : 0), 0);
    const pendingOrders = strategies.filter(s => s.state === 'running').length;

    // 计算风险等级
    let riskLevel: 'low' | 'medium' | 'high' = 'low';
    const totalPnl = strategies.reduce((sum, s) => sum + s.performance.totalPnl, 0);
    if (totalPnl < -1000) riskLevel = 'high';
    else if (totalPnl < -100) riskLevel = 'medium';

    return {
      timestamp: new Date().toISOString(),
      version: this.version,
      mode: process.env.LIVE_TRADING === '1' ? 'live' : 'paper',
      strategies,
      activeOrders,
      pendingOrders,
      riskLevel,
    };
  }

  /**
   * 停止服务
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info('[HealthAPI] HTTP服务已停止');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  // 指标记录方法（供外部调用）
  recordOrder() { this.metrics.recordOrder(); }
  recordQuote() { this.metrics.recordQuote(); }
  recordError(type: string) { this.metrics.recordError(type); }
  recordLatency(ms: number) { this.metrics.recordLatency(ms); }
}

// 导出单例
export const healthAPI = new HealthAPI();
export default HealthAPI;
