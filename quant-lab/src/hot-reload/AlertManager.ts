/**
 * 告警管理器
 * 
 * 职责：
 * - 告警必达（鲶鱼要求#7）
 * - 多渠道告警（tg send + 日志）
 */

import { createLogger } from '../utils/logger';
const logger = createLogger('AlertManager');

import { execFileSync } from 'child_process';
import type { ReloadResult } from './HotReloadManager';

export interface AlertConfig {
  enableTg?: boolean;
  tgTarget?: string; // tg send目标（如'bot-000'或'总裁'）
}

export class AlertManager {
  private config: AlertConfig;

  constructor(config: AlertConfig = {}) {
    this.config = {
      enableTg: true,
      tgTarget: 'bot-000',
      ...config,
    };
  }

  /**
   * 发送热更新成功告警
   */
  async alertSuccess(result: ReloadResult): Promise<void> {
    const message = this.formatSuccessMessage(result);
    
    // 控制台输出
    logger.info(message);
    
    // Telegram告警
    if (this.config.enableTg) {
      await this.sendTgAlert(message);
    }
  }

  /**
   * 发送热更新失败告警
   */
  async alertFailure(result: ReloadResult): Promise<void> {
    const message = this.formatFailureMessage(result);
    
    // 控制台输出
    logger.error(message);
    
    // Telegram告警（失败时强制发送）
    await this.sendTgAlert(message, true);
  }

  /**
   * 发送门闸检查失败告警
   */
  async alertGateFailed(strategyId: string, failedChecks: string[]): Promise<void> {
    const message = `【热更新门闸检查失败】
策略ID: ${strategyId}
失败项: ${failedChecks.join(', ')}
状态: 未执行热更新
建议: 检查失败项后重试`;

    logger.warn(message);
    
    if (this.config.enableTg) {
      await this.sendTgAlert(message);
    }
  }

  /**
   * 格式化成功消息
   */
  private formatSuccessMessage(result: ReloadResult): string {
    const lines = [
      '【热更新成功】',
      `策略ID: ${result.strategyId}`,
      `目标: ${result.target}`,
      `耗时: ${(result.duration / 1000).toFixed(2)}秒`,
    ];

    if (result.snapshot) {
      const s = result.snapshot;
      lines.push('');
      lines.push('状态保持:');
      lines.push(`- runId: ${s.state.runId || 'N/A'} ✅（保留）`);
      lines.push(`- 持仓: ${s.position || 'N/A'} ✅（保持）`);
      lines.push(`- 订单: ${s.openOrders.length}个 ✅（一致）`);
      lines.push(`- hash: ${s.hash.substring(0, 8)}...`);
    }

    return lines.join('\n');
  }

  /**
   * 格式化失败消息
   */
  private formatFailureMessage(result: ReloadResult): string {
    const lines = [
      '【热更新失败】',
      `策略ID: ${result.strategyId}`,
      `目标: ${result.target}`,
      `错误: ${result.error}`,
      `耗时: ${(result.duration / 1000).toFixed(2)}秒`,
    ];

    if (result.snapshot) {
      lines.push('');
      lines.push('已回滚 ✅');
      lines.push('策略继续运行 ✅');
    }

    return lines.join('\n');
  }

  /**
   * 发送Telegram告警
   * 
   * D项修复（鲶鱼建议）：用execFileSync避免shell引号问题
   */
  private async sendTgAlert(message: string, force: boolean = false): Promise<void> {
    if (!this.config.enableTg && !force) {
      return;
    }

    // 2026-02-23 总裁指令：严禁策略系统直接调用tg-cli发信息（消息风暴防护）
    // 硬禁用：所有告警仅记日志，不发tg
    logger.warn(`[AlertManager][tg硬禁用] ${message.slice(0, 200)}`);
    return;

    // === 以下代码保留但不执行，等总裁解禁后恢复 ===
    // 分级告警：STRATEGY_ALERT_LEVEL控制 (CRITICAL/WARNING/ALL/NONE)
    // 向后兼容：STRATEGY_TG_ENABLED=1 等价于 ALL
    const alertLevel = process.env.STRATEGY_TG_ENABLED === '1' ? 'ALL' : (process.env.STRATEGY_ALERT_LEVEL || 'CRITICAL');

    // NONE: 全部禁用
    if (alertLevel === 'NONE') {
      return;
    }

    // CRITICAL: 只放行[告急]标签
    if (alertLevel === 'CRITICAL' && !message.includes('[告急]')) {
      logger.warn(`[AlertManager][降级] ${message.slice(0, 100)}`);
      return;
    }

    // WARNING: 放行[告急]+[告警]+[P1告警]
    if (alertLevel === 'WARNING' &&
        !message.includes('[告急]') &&
        !message.includes('[告警]') &&
        !message.includes('[P1告警]')) {
      logger.warn(`[AlertManager][降级] ${message.slice(0, 100)}`);
      return;
    }

    // 通过过滤→执行tg-cli发送
    try {
      const target = this.config.tgTarget || 'bot-000';
      
      // D项修复：使用execFileSync，避免shell引号问题
      execFileSync('tg', ['send!', 'bot-001', target, message], {
        encoding: 'utf-8',
        stdio: 'ignore', // 忽略输出，避免干扰
      });
    } catch (error: any) {
      logger.error(`[AlertManager] Telegram告警发送失败:`, error.message);
    }
  }
}
