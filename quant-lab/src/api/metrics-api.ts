/**
 * 绩效指标 HTTP API
 *
 * 仅监听127.0.0.1
 *
 * 端点:
 *   GET /api/v1/metrics - 获取绩效指标数据
 *
 * 绩效指标:
 *   - WinRate: 胜率（盈利交易数/总交易数）
 *   - MaxDrawdown: 最大回撤（最大累计亏损峰值）
 *   - SharpeRatio: 夏普比率（风险调整后收益）
 *   - TotalPnl: 总盈亏
 *   - TradeCount: 交易次数
 *   - AvgPnl: 平均盈亏
 *
 * 权限控制:
 *   - 仅127.0.0.1可访问
 *   - 审计日志记录所有请求
 */

import { createLogger } from '../utils/logger';
nimport { env } from '../config/env';
const logger = createLogger('metrics-api');

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import type { QuickJSStrategy } from '../legacy/QuickJSStrategy';

// 兼容获取home目录
function getHomeDir(): string {
  return env.HOME;
}

// ================================
// 类型定义
// ================================

export interface MetricsData {
  strategyId: string;
  timestamp: string;
  
  // 交易统计
  tradeCount: number;
  winCount: number;
  lossCount: number;
  
  // 盈亏统计
  totalPnl: number;
  avgPnl: number;
  maxWin: number;
  maxLoss: number;
  
  // 风险指标
  winRate: number; // 胜率（0-1）
  maxDrawdown: number; // 最大回撤（0-1）
  sharpeRatio: number; // 夏普比率
  
  // 持仓信息
  currentPosition?: {
    symbol: string;
    side: 'LONG' | 'SHORT' | 'FLAT';
    qty: number;
    avgPrice: number;
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
  const logFile = join(auditDir, 'metrics-api.log');

  try {
    if (!existsSync(auditDir)) {
      mkdirSync(auditDir, { recursive: true });
    }

    const line = JSON.stringify(log) + '\n';
    appendFileSync(logFile, line);
  } catch (error) {
    logger.error('[MetricsAPI] 审计日志写入失败:', error);
  }
}

// ================================
// 绩效指标计算器
// ================================

class MetricsCalculator {
  /**
   * 计算绩效指标
   */
  static calculateMetrics(
    strategyId: string,
    simTrades: Array<{
      price: number;
      qty: number;
      side: 'BUY' | 'SELL';
      symbol: string;
      timestamp: number;
      pnl: number;
    }>,
    simPosition?: {
      symbol: string;
      side: 'LONG' | 'SHORT' | 'FLAT';
      qty: number;
      avgPrice: number;
    }
  ): MetricsData {
    const tradeCount = simTrades.length;
    
    // 基础统计
    const winCount = simTrades.filter(t => t.pnl > 0).length;
    const lossCount = simTrades.filter(t => t.pnl < 0).length;
    const totalPnl = simTrades.reduce((sum, t) => sum + t.pnl, 0);
    const avgPnl = tradeCount > 0 ? totalPnl / tradeCount : 0;
    const maxWin = simTrades.length > 0 ? Math.max(...simTrades.map(t => t.pnl)) : 0;
    const maxLoss = simTrades.length > 0 ? Math.min(...simTrades.map(t => t.pnl)) : 0;
    
    // 胜率
    const winRate = tradeCount > 0 ? winCount / tradeCount : 0;
    
    // 最大回撤
    const maxDrawdown = this.calculateMaxDrawdown(simTrades);
    
    // 夏普比率
    const sharpeRatio = this.calculateSharpeRatio(simTrades);
    
    return {
      strategyId,
      timestamp: new Date().toISOString(),
      tradeCount,
      winCount,
      lossCount,
      totalPnl,
      avgPnl,
      maxWin,
      maxLoss,
      winRate,
      maxDrawdown,
      sharpeRatio,
      currentPosition: simPosition,
    };
  }
  
  /**
   * 计算最大回撤
   * 最大回撤 = (峰值 - 谷值) / 峰值
   */
  private static calculateMaxDrawdown(
    simTrades: Array<{ pnl: number; timestamp: number }>
  ): number {
    if (simTrades.length === 0) return 0;
    
    // 按时间排序（确保时间序列）
    const sorted = [...simTrades].sort((a, b) => a.timestamp - b.timestamp);
    
    // 计算累计盈亏曲线
    let cumulative = 0;
    let peak = 0;
    let maxDrawdown = 0;
    
    for (const trade of sorted) {
      cumulative += trade.pnl;
      
      // 更新峰值
      if (cumulative > peak) {
        peak = cumulative;
      }
      
      // 计算当前回撤
      if (peak > 0) {
        const drawdown = (peak - cumulative) / peak;
        if (drawdown > maxDrawdown) {
          maxDrawdown = drawdown;
        }
      }
    }
    
    return maxDrawdown;
  }
  
  /**
   * 计算夏普比率
   * Sharpe Ratio = (平均收益率 - 无风险利率) / 收益率标准差
   * 简化：无风险利率 = 0，收益率 = pnl / price
   */
  private static calculateSharpeRatio(
    simTrades: Array<{ pnl: number; price: number; timestamp: number }>
  ): number {
    if (simTrades.length < 2) return 0;
    
    // 计算每笔交易的收益率
    const returns = simTrades
      .filter(t => t.price > 0)
      .map(t => t.pnl / t.price);
    
    if (returns.length < 2) return 0;
    
    // 平均收益率
    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    
    // 收益率标准差
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    
    // 夏普比率（年化因子：假设每笔交易间隔约1小时，一年8760小时）
    // 这里简化为不年化，直接返回
    return stdDev > 0 ? avgReturn / stdDev : 0;
  }
}

// ================================
// 绩效指标 API
// ================================

class MetricsAPI {
  private server?: Server;
  private strategyMap = new Map<string, QuickJSStrategy>();  // strategyId -> QuickJSStrategy

  /**
   * 注册策略实例
   */
  registerStrategy(strategyId: string, strategy: QuickJSStrategy) {
    this.strategyMap.set(strategyId, strategy);
    logger.info(`[MetricsAPI] 注册策略: ${strategyId}`);
  }

  /**
   * 注销策略实例
   */
  unregisterStrategy(strategyId: string) {
    this.strategyMap.delete(strategyId);
    logger.info(`[MetricsAPI] 注销策略: ${strategyId}`);
  }

  /**
   * 启动HTTP服务
   */
  start(port = 9092): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res);
      });

      // 仅监听127.0.0.1
      this.server.listen(port, '127.0.0.1', () => {
        logger.info(`[MetricsAPI] HTTP服务启动: http://127.0.0.1:${port}`);
        logger.info(`[MetricsAPI] 仅本机可访问 (127.0.0.1)`);
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
          case 'GET /api/v1/metrics':
            result = this.handleGetMetrics(requestData);
            break;

          default:
            // 带query参数的路由单独处理
            if (method === 'GET' && path.startsWith('/api/v1/metrics/timeseries')) {
              const url = new URL(path, 'http://localhost');
              const name = url.searchParams.get('name') || 'adx';
              const limit = parseInt(url.searchParams.get('limit') || '100', 10);
              const strategyId = url.searchParams.get('strategyId');
              result = this.handleGetTimeseries({ name, limit, strategyId });
              break;
            }
          // fallthrough to 404
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
   * 获取绩效指标数据
   */
  private handleGetMetrics(request: { strategyId?: string }): any {
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
      const metrics = MetricsCalculator.calculateMetrics(
        strategyId,
        data.simTrades || [],
        data.simPosition
      );

      return {
        success: true,
        ...metrics,
      };
    } else {
      // 获取所有策略
      const allMetrics: Record<string, MetricsData> = {};
      for (const [sid, strategy] of this.strategyMap.entries()) {
        const data = strategy.getSimPnlData();
        allMetrics[sid] = MetricsCalculator.calculateMetrics(
          sid,
          data.simTrades || [],
          data.simPosition
        );
      }

      return {
        success: true,
        strategies: allMetrics,
        count: this.strategyMap.size,
      };
    }
  }

  /**
   * 获取时序指标（最近N条）
   */
  private handleGetTimeseries({ name, limit, strategyId }: { name: string; limit: number; strategyId?: string | null }): any {
    const results: Array<{ timestamp: number; value: number; strategyId: string }> = [];

    for (const [sid, strategy] of this.strategyMap.entries()) {
      if (strategyId && sid !== strategyId) continue;
      const table = (strategy as any).getMetricsTable?.();
      if (!table) continue;
      const rows: any[] = table.filter?.((row: any) => row.name === name) || [];
      for (const row of rows) {
        results.push({ timestamp: Number(row.timestamp), value: Number(row.value), strategyId: sid });
      }
    }

    // 按时间升序，取最近N条
    results.sort((a, b) => a.timestamp - b.timestamp);
    const sliced = results.slice(-limit);

    return { success: true, name, data: sliced, count: sliced.length };
  }

  /**
   * 停止服务
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info('[MetricsAPI] HTTP服务已停止');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

// 导出单例
export const metricsAPI = new MetricsAPI();
export { MetricsAPI };
