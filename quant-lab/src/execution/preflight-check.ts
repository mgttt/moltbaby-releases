/**
 * preflight-check.ts - 启动前置检查（Pre-flight Check）
 * 
 * P1紧急修复：策略启动前进行合规性检查，防止历史持仓超限后静默失败
 * 
 * 背景：策略启动时无pre-flight check，导致历史持仓超限后新策略静默失败30分钟无人知晓
 */

import { EventEmitter } from 'events';

// ==================== 类型定义 ====================

export enum PreflightCheckStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  PASSED = 'PASSED',
  FAILED = 'FAILED',
}

export interface PositionCheckConfig {
  symbol: string;
  maxPosition: number;          // 最大持仓限制
  currentPosition: number;      // 当前持仓
  side: 'LONG' | 'SHORT' | 'NEUTRAL';
}

export interface AccountCheckConfig {
  minBalance: number;           // 最小余额要求
  currentBalance: number;       // 当前余额
  requiredPermissions: string[]; // 所需权限
  currentPermissions: string[]; // 当前权限
}

export interface ParameterCheckConfig {
  requiredParams: string[];     // 必需参数列表
  providedParams: Record<string, any>; // 提供的参数
  paramValidators?: Record<string, (value: any) => boolean>; // 参数验证器
}

export interface PreflightCheckConfig {
  strategyId: string;
  sessionId: string;
  positionCheck?: PositionCheckConfig;
  accountCheck?: AccountCheckConfig;
  parameterCheck?: ParameterCheckConfig;
  customChecks?: Array<() => Promise<{ passed: boolean; reason?: string }>>;
}

export interface PreflightCheckResult {
  status: PreflightCheckStatus;
  timestamp: number;
  checks: {
    position?: { passed: boolean; reason?: string };
    account?: { passed: boolean; reason?: string };
    parameters?: { passed: boolean; reason?: string };
    custom?: Array<{ passed: boolean; reason?: string }>;
  };
  summary: {
    totalChecks: number;
    passedChecks: number;
    failedChecks: number;
  };
}

export interface PreflightAlertConfig {
  enabled: boolean;
  tgChatId?: string;
  onFailure?: (result: PreflightCheckResult) => Promise<void>;
}

// ==================== 启动前置检查器 ====================

export class PreflightChecker extends EventEmitter {
  private config: PreflightCheckConfig;
  private alertConfig: PreflightAlertConfig;
  private result: PreflightCheckResult | null = null;

  constructor(
    config: PreflightCheckConfig,
    alertConfig: PreflightAlertConfig = { enabled: true }
  ) {
    super();
    this.config = config;
    this.alertConfig = alertConfig;
    
    console.log(`[PreflightChecker] 初始化 [${config.strategyId}/${config.sessionId}]`);
  }

  /**
   * 执行完整的前置检查
   * 
   * @returns 检查结果，全部通过返回true，否则false
   */
  async run(): Promise<boolean> {
    const startTime = Date.now();
    
    this.emit('check:started', { timestamp: startTime });
    
    const result: PreflightCheckResult = {
      status: PreflightCheckStatus.RUNNING,
      timestamp: startTime,
      checks: {},
      summary: {
        totalChecks: 0,
        passedChecks: 0,
        failedChecks: 0,
      },
    };

    try {
      // 1. 持仓合规校验
      if (this.config.positionCheck) {
        result.checks.position = await this.checkPosition();
        result.summary.totalChecks++;
        if (result.checks.position.passed) {
          result.summary.passedChecks++;
        } else {
          result.summary.failedChecks++;
          console.error(`[PreflightChecker] ❌ 持仓检查失败: ${result.checks.position.reason}`);
        }
      }

      // 2. 账户状态校验
      if (this.config.accountCheck) {
        result.checks.account = await this.checkAccount();
        result.summary.totalChecks++;
        if (result.checks.account.passed) {
          result.summary.passedChecks++;
        } else {
          result.summary.failedChecks++;
          console.error(`[PreflightChecker] ❌ 账户检查失败: ${result.checks.account.reason}`);
        }
      }

      // 3. 参数校验
      if (this.config.parameterCheck) {
        result.checks.parameters = await this.checkParameters();
        result.summary.totalChecks++;
        if (result.checks.parameters.passed) {
          result.summary.passedChecks++;
        } else {
          result.summary.failedChecks++;
          console.error(`[PreflightChecker] ❌ 参数检查失败: ${result.checks.parameters.reason}`);
        }
      }

      // 4. 自定义检查
      if (this.config.customChecks && this.config.customChecks.length > 0) {
        result.checks.custom = [];
        for (const check of this.config.customChecks) {
          const checkResult = await check();
          result.checks.custom.push(checkResult);
          result.summary.totalChecks++;
          if (checkResult.passed) {
            result.summary.passedChecks++;
          } else {
            result.summary.failedChecks++;
            console.error(`[PreflightChecker] ❌ 自定义检查失败: ${checkResult.reason}`);
          }
        }
      }

      // 确定最终状态
      if (result.summary.failedChecks === 0) {
        result.status = PreflightCheckStatus.PASSED;
        console.log(`[PreflightChecker] ✅ 全部检查通过 (${result.summary.totalChecks}项)`);
        this.emit('check:passed', result);
      } else {
        result.status = PreflightCheckStatus.FAILED;
        console.error(`[PreflightChecker] ❌ 检查失败: ${result.summary.failedChecks}/${result.summary.totalChecks}项未通过`);
        
        // 发送告警
        await this.sendAlert(result);
        this.emit('check:failed', result);
      }

      this.result = result;
      return result.status === PreflightCheckStatus.PASSED;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[PreflightChecker] ❌ 检查异常: ${errorMessage}`);
      
      result.status = PreflightCheckStatus.FAILED;
      result.summary.failedChecks++;
      
      await this.sendAlert(result, errorMessage);
      this.emit('check:error', error);
      
      this.result = result;
      return false;
    }
  }

  /**
   * 获取检查结果
   */
  getResult(): PreflightCheckResult | null {
    return this.result;
  }

  /**
   * 生成检查报告（用于日志记录）
   */
  generateReport(): string {
    if (!this.result) {
      return '[PreflightChecker] 尚未执行检查';
    }

    const lines = [
      '========================================',
      '        启动前置检查报告',
      '========================================',
      `策略ID: ${this.config.strategyId}`,
      `会话ID: ${this.config.sessionId}`,
      `检查时间: ${new Date(this.result.timestamp).toISOString()}`,
      `状态: ${this.result.status}`,
      '',
      `总计: ${this.result.summary.totalChecks}项`,
      `通过: ${this.result.summary.passedChecks}项`,
      `失败: ${this.result.summary.failedChecks}项`,
      '',
    ];

    // 持仓检查详情
    if (this.result.checks.position) {
      lines.push(`[持仓检查] ${this.result.checks.position.passed ? '✅' : '❌'}`);
      if (this.result.checks.position.reason) {
        lines.push(`  原因: ${this.result.checks.position.reason}`);
      }
      if (this.config.positionCheck) {
        lines.push(`  当前: ${this.config.positionCheck.currentPosition}`);
        lines.push(`  限制: ${this.config.positionCheck.maxPosition}`);
      }
      lines.push('');
    }

    // 账户检查详情
    if (this.result.checks.account) {
      lines.push(`[账户检查] ${this.result.checks.account.passed ? '✅' : '❌'}`);
      if (this.result.checks.account.reason) {
        lines.push(`  原因: ${this.result.checks.account.reason}`);
      }
      lines.push('');
    }

    // 参数检查详情
    if (this.result.checks.parameters) {
      lines.push(`[参数检查] ${this.result.checks.parameters.passed ? '✅' : '❌'}`);
      if (this.result.checks.parameters.reason) {
        lines.push(`  原因: ${this.result.checks.parameters.reason}`);
      }
      lines.push('');
    }

    // 自定义检查详情
    if (this.result.checks.custom) {
      this.result.checks.custom.forEach((check, index) => {
        lines.push(`[自定义检查${index + 1}] ${check.passed ? '✅' : '❌'}`);
        if (check.reason) {
          lines.push(`  原因: ${check.reason}`);
        }
      });
      lines.push('');
    }

    lines.push('========================================');

    return lines.join('\n');
  }

  // ==================== 私有检查方法 ====================

  /**
   * 持仓合规校验
   * 检查当前持仓是否超过最大限制
   */
  private async checkPosition(): Promise<{ passed: boolean; reason?: string }> {
    const config = this.config.positionCheck!;
    
    console.log(`[PreflightChecker] 🔍 持仓检查: ${config.currentPosition}/${config.maxPosition}`);

    // 检查是否超限
    if (config.currentPosition > config.maxPosition) {
      return {
        passed: false,
        reason: `持仓超限: 当前${config.currentPosition} > 限制${config.maxPosition}`,
      };
    }

    // 检查是否接近限制（警告阈值90%）
    const warningThreshold = config.maxPosition * 0.9;
    if (config.currentPosition > warningThreshold) {
      console.warn(`[PreflightChecker] ⚠️ 持仓接近限制: ${config.currentPosition}/${config.maxPosition} (${((config.currentPosition/config.maxPosition)*100).toFixed(1)}%)`);
      // 警告但不阻止启动
    }

    return { passed: true };
  }

  /**
   * 账户状态校验
   * 检查余额和权限
   */
  private async checkAccount(): Promise<{ passed: boolean; reason?: string }> {
    const config = this.config.accountCheck!;
    
    console.log(`[PreflightChecker] 🔍 账户检查: 余额${config.currentBalance}/${config.minBalance}`);

    // 检查余额
    if (config.currentBalance < config.minBalance) {
      return {
        passed: false,
        reason: `余额不足: 当前${config.currentBalance} < 最低要求${config.minBalance}`,
      };
    }

    // 检查权限
    if (config.requiredPermissions && config.requiredPermissions.length > 0) {
      const missingPermissions = config.requiredPermissions.filter(
        perm => !config.currentPermissions.includes(perm)
      );
      
      if (missingPermissions.length > 0) {
        return {
          passed: false,
          reason: `权限不足: 缺少 ${missingPermissions.join(', ')}`,
        };
      }
    }

    return { passed: true };
  }

  /**
   * 参数校验
   * 检查必需参数是否完整且有效
   */
  private async checkParameters(): Promise<{ passed: boolean; reason?: string }> {
    const config = this.config.parameterCheck!;
    
    console.log(`[PreflightChecker] 🔍 参数检查: ${Object.keys(config.providedParams).length}项`);

    // 检查必需参数是否存在
    const missingParams = config.requiredParams.filter(
      param => config.providedParams[param] === undefined
    );
    
    if (missingParams.length > 0) {
      return {
        passed: false,
        reason: `缺少必需参数: ${missingParams.join(', ')}`,
      };
    }

    // 执行自定义参数验证
    if (config.paramValidators) {
      for (const [param, validator] of Object.entries(config.paramValidators)) {
        const value = config.providedParams[param];
        if (value !== undefined && !validator(value)) {
          return {
            passed: false,
            reason: `参数验证失败: ${param}=${value}`,
          };
        }
      }
    }

    return { passed: true };
  }

  /**
   * 发送告警
   */
  private async sendAlert(result: PreflightCheckResult, errorMessage?: string): Promise<void> {
    if (!this.alertConfig.enabled) {
      return;
    }

    try {
      // 调用自定义告警回调
      if (this.alertConfig.onFailure) {
        await this.alertConfig.onFailure(result);
      }

      // 输出告警日志
      const report = this.generateReport();
      console.error(`[PreflightChecker] 🚨 启动前置检查失败告警:\n${report}`);
      
      // 触发告警事件
      this.emit('alert:sent', { result, errorMessage });

    } catch (alertError) {
      console.error(`[PreflightChecker] ❌ 告警发送失败:`, alertError);
      this.emit('alert:error', alertError);
    }
  }
}

// ==================== 工厂函数 ====================

export function createPreflightChecker(
  config: PreflightCheckConfig,
  alertConfig?: PreflightAlertConfig
): PreflightChecker {
  return new PreflightChecker(config, alertConfig);
}

// ==================== 默认导出 ====================

export default PreflightChecker;
