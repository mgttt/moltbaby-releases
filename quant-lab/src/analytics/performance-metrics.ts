/**
 * 策略性能指标聚合模块
 * 用途：系统性比较多策略（A/B/C/D参数组），为策略决策提供数据基础
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

export interface StrategyMetrics {
  totalPnl: number;           // 已实现+未实现总盈亏
  unrealizedPnl: number;      // 未实现盈亏
  positionSize: number;       // 当前持仓大小
  fillCount: number;          // 成交次数（方案A后可用）
  maxPositionReached: number; // 历史最大持仓
  avgEntryPrice: number;      // 平均入场价格
  runningHours: number;       // 运行时长（小时）
  healthStatus: 'normal' | 'warning' | 'critical';
}

interface StrategyState {
  positionNotional?: number;
  avgEntryPrice?: number;
  runId?: number;             // 启动时间戳（毫秒）
  accountingPnl?: number;
  riskMetrics?: {
    accountingPnl?: number;
    accountGap?: number;
  };
  // 未来字段（方案A后）
  fillCount?: number;
  maxPositionReached?: number;
}

/**
 * 聚合策略性能指标
 * @param stateFilePath 策略状态文件路径
 * @returns 性能指标对象
 */
export function aggregateStrategyMetrics(stateFilePath: string): StrategyMetrics {
  try {
    const raw = readFileSync(resolve(stateFilePath), 'utf-8');
    const fileData = JSON.parse(raw);
    
    // 状态文件结构：{"state:SYMBOL:DIRECTION": {...actualState...}}
    // 提取第一个key的内容作为实际状态
    const stateKey = Object.keys(fileData)[0];
    const state: StrategyState = stateKey ? fileData[stateKey] : fileData;

    // 基础字段
    const positionSize = state.positionNotional || 0;
    const avgEntryPrice = state.avgEntryPrice || 0;
    
    // PnL计算：优先使用riskMetrics.accountingPnl，回退到state.accountingPnl
    const accountingPnl = state.riskMetrics?.accountingPnl ?? state.accountingPnl ?? 0;
    
    // 未实现盈亏（当前accountingPnl就是未实现）
    const unrealizedPnl = accountingPnl;
    
    // 总盈亏（暂未区分已实现/未实现，统一使用accountingPnl）
    const totalPnl = accountingPnl;

    // 成交次数（方案A后可用，当前默认0）
    const fillCount = (state as any).fillCount || 0;
    
    // 历史最大持仓（若未记录，使用当前持仓）
    const maxPositionReached = (state as any).maxPositionReached || Math.abs(positionSize);

    // 计算运行时长（小时）
    let runningHours = 0;
    if (state.runId) {
      const startTime = state.runId; // runId是启动时的时间戳
      const now = Date.now();
      runningHours = (now - startTime) / (1000 * 60 * 60);
    }

    // 健康状态判断（基于accountGap）
    let healthStatus: StrategyMetrics['healthStatus'] = 'normal';
    const accountGap = state.riskMetrics?.accountGap || 0;
    if (Math.abs(accountGap) > 100) {
      healthStatus = 'critical';
    } else if (Math.abs(accountGap) > 30) {
      healthStatus = 'warning';
    }

    return {
      totalPnl: parseFloat(totalPnl.toFixed(2)),
      unrealizedPnl: parseFloat(unrealizedPnl.toFixed(2)),
      positionSize: parseFloat(positionSize.toFixed(2)),
      fillCount,
      maxPositionReached: parseFloat(maxPositionReached.toFixed(2)),
      avgEntryPrice: parseFloat(avgEntryPrice.toFixed(4)),
      runningHours: parseFloat(runningHours.toFixed(2)),
      healthStatus,
    };
  } catch (error: any) {
    console.error(`[PerformanceMetrics] 加载失败 ${stateFilePath}:`, error.message);
    // 返回零值指标
    return {
      totalPnl: 0,
      unrealizedPnl: 0,
      positionSize: 0,
      fillCount: 0,
      maxPositionReached: 0,
      avgEntryPrice: 0,
      runningHours: 0,
      healthStatus: 'critical',
    };
  }
}

// CLI执行入口
if (require.main === module) {
  const strategyId = process.argv[2] || 'gales-short';
  const stateDir = process.env.QUANT_LAB_STATE_DIR || '/home/devali/.quant-lab/state';
  const stateFile = `${stateDir}/${strategyId}.json`;

  console.log(`[PerformanceMetrics] 分析策略: ${strategyId}`);
  const metrics = aggregateStrategyMetrics(stateFile);
  console.log(JSON.stringify(metrics, null, 2));
}
