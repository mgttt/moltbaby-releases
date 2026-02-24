/**
 * 回测←→实盘参数一致性校验
 * 
 * 功能：
 * 1. 读取回测配置（backtest config）
 * 2. 读取实盘配置（live config）
 * 3. 对比关键参数（gridSpacing/orderSize/maxPosition/magnetDistance等）
 * 4. 发现偏差→告警+报告
 * 5. CI/CD集成（启动前自动校验）
 * 
 * 位置：quant-lab/src/engine/config-validator.ts
 */

import { createLogger } from '../utils/logger';
const logger = createLogger('config-validator');

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

// ============ 类型定义 ============

export interface ConfigDiff {
  key: string;
  backtestValue: any;
  liveValue: any;
  diffType: "TYPE_MISMATCH" | "VALUE_DIFF" | "MISSING_IN_BACKTEST" | "MISSING_IN_LIVE";
  severity: "ERROR" | "WARNING" | "INFO";
}

export interface ValidationResult {
  isValid: boolean;
  diffs: ConfigDiff[];
  timestamp: number;
  backtestConfigPath: string;
  liveConfigPath: string;
}

export interface ValidationOptions {
  // 需要校验的关键参数
  criticalKeys?: string[];
  
  // 允许的误差范围（用于数值比较）
  tolerance?: Record<string, number>;
  
  // 是否严格模式（发现任何差异都失败）
  strict?: boolean;
  
  // 输出报告路径
  reportPath?: string;
}

export interface ConfigValidatorEvents {
  onValidationStart: (backtestPath: string, livePath: string) => void;
  onValidationComplete: (result: ValidationResult) => void;
  onDiffFound: (diff: ConfigDiff) => void;
  onError: (error: Error) => void;
}

// ============ 配置校验器 ============

export class ConfigValidator {
  private criticalKeys: string[];
  private tolerance: Record<string, number>;
  private strict: boolean;
  private reportPath?: string;
  private events: Partial<ConfigValidatorEvents> = {};

  constructor(options?: ValidationOptions) {
    this.criticalKeys = options?.criticalKeys || [
      "symbol",
      "gridCount",
      "gridSpacing",
      "orderSize",
      "maxPosition",
      "magnetDistance",
      "cancelDistance",
      "priceOffset",
      "postOnly",
      "orderTimeout",
    ];

    this.tolerance = options?.tolerance || {
      gridSpacing: 0.0001, // 0.01% 误差
      orderSize: 1, // 1 USDT 误差
      maxPosition: 10, // 10 USDT 误差
      magnetDistance: 0.0001, // 0.01% 误差
      cancelDistance: 0.0001, // 0.01% 误差
      priceOffset: 0.0001, // 0.01% 误差
    };

    this.strict = options?.strict ?? false;
    this.reportPath = options?.reportPath;
  }

  /**
   * 设置事件回调
   */
  setEvents(events: Partial<ConfigValidatorEvents>): void {
    this.events = { ...this.events, ...events };
  }

  /**
   * 校验配置一致性
   */
  validate(
    backtestConfigPath: string,
    liveConfigPath: string
  ): ValidationResult {
    this.log(
      `[ConfigValidator] 开始校验配置一致性: ${backtestConfigPath} vs ${liveConfigPath}`
    );
    this.events.onValidationStart?.(backtestConfigPath, liveConfigPath);

    const diffs: ConfigDiff[] = [];

    try {
      // 1. 读取配置文件
      const backtestConfig = this.loadConfig(backtestConfigPath);
      const liveConfig = this.loadConfig(liveConfigPath);

      if (!backtestConfig) {
        diffs.push({
          key: "BACKTEST_CONFIG",
          backtestValue: null,
          liveValue: null,
          diffType: "MISSING_IN_BACKTEST",
          severity: "ERROR",
        });
      }

      if (!liveConfig) {
        diffs.push({
          key: "LIVE_CONFIG",
          backtestValue: null,
          liveValue: null,
          diffType: "MISSING_IN_LIVE",
          severity: "ERROR",
        });
      }

      if (!backtestConfig || !liveConfig) {
        const result: ValidationResult = {
          isValid: false,
          diffs,
          timestamp: Date.now(),
          backtestConfigPath,
          liveConfigPath,
        };

        this.events.onValidationComplete?.(result);
        this.saveReport(result);
        return result;
      }

      // 2. 对比关键参数
      for (const key of this.criticalKeys) {
        const diff = this.compareKey(
          key,
          backtestConfig[key],
          liveConfig[key]
        );

        if (diff) {
          diffs.push(diff);
          this.events.onDiffFound?.(diff);
        }
      }

      // 3. 判断是否有效
      const isValid = this.strict
        ? diffs.length === 0
        : !diffs.some((d) => d.severity === "ERROR");

      const result: ValidationResult = {
        isValid,
        diffs,
        timestamp: Date.now(),
        backtestConfigPath,
        liveConfigPath,
      };

      this.log(
        `[ConfigValidator] 校验完成: ${isValid ? "通过" : "失败"}, 差异: ${diffs.length} 项`
      );
      this.events.onValidationComplete?.(result);

      // 4. 保存报告
      this.saveReport(result);

      return result;
    } catch (error: any) {
      this.log(`[ConfigValidator] 校验失败: ${error.message}`);
      this.events.onError?.(error);

      const result: ValidationResult = {
        isValid: false,
        diffs: [
          {
            key: "VALIDATION_ERROR",
            backtestValue: null,
            liveValue: null,
            diffType: "MISSING_IN_BACKTEST",
            severity: "ERROR",
          },
        ],
        timestamp: Date.now(),
        backtestConfigPath,
        liveConfigPath,
      };

      this.events.onValidationComplete?.(result);
      this.saveReport(result);
      return result;
    }
  }

  /**
   * 加载配置文件
   */
  private loadConfig(path: string): Record<string, any> | null {
    try {
      if (!existsSync(path)) {
        this.log(`[ConfigValidator] 配置文件不存在: ${path}`);
        return null;
      }

      const content = readFileSync(path, "utf-8");
      return JSON.parse(content);
    } catch (error: any) {
      this.log(`[ConfigValidator] 加载配置失败: ${path}, 错误: ${error.message}`);
      return null;
    }
  }

  /**
   * 对比单个参数
   */
  private compareKey(
    key: string,
    backtestValue: any,
    liveValue: any
  ): ConfigDiff | null {
    // 1. 类型检查
    if (typeof backtestValue !== typeof liveValue) {
      return {
        key,
        backtestValue,
        liveValue,
        diffType: "TYPE_MISMATCH",
        severity: "ERROR",
      };
    }

    // 2. 缺失检查
    if (backtestValue === undefined && liveValue !== undefined) {
      return {
        key,
        backtestValue,
        liveValue,
        diffType: "MISSING_IN_BACKTEST",
        severity: "WARNING",
      };
    }

    if (backtestValue !== undefined && liveValue === undefined) {
      return {
        key,
        backtestValue,
        liveValue,
        diffType: "MISSING_IN_LIVE",
        severity: "WARNING",
      };
    }

    // 3. 值比较
    if (typeof backtestValue === "number" && typeof liveValue === "number") {
      const tolerance = this.tolerance[key] || 0;
      const diff = Math.abs(backtestValue - liveValue);

      if (diff > tolerance) {
        return {
          key,
          backtestValue,
          liveValue,
          diffType: "VALUE_DIFF",
          severity: diff > tolerance * 10 ? "ERROR" : "WARNING",
        };
      }
    } else {
      if (backtestValue !== liveValue) {
        return {
          key,
          backtestValue,
          liveValue,
          diffType: "VALUE_DIFF",
          severity: "ERROR",
        };
      }
    }

    return null;
  }

  /**
   * 保存报告
   */
  private saveReport(result: ValidationResult): void {
    if (!this.reportPath) return;

    try {
      const dir = dirname(this.reportPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const report = this.generateReport(result);
      writeFileSync(this.reportPath, report);
      this.log(`[ConfigValidator] 报告已保存: ${this.reportPath}`);
    } catch (error: any) {
      this.log(`[ConfigValidator] 保存报告失败: ${error.message}`);
    }
  }

  /**
   * 生成报告
   */
  private generateReport(result: ValidationResult): string {
    const timestamp = new Date(result.timestamp).toISOString();

    let report = `# 配置一致性校验报告

**生成时间**: ${timestamp}  
**回测配置**: ${result.backtestConfigPath}  
**实盘配置**: ${result.liveConfigPath}  
**校验结果**: ${result.isValid ? "✅ 通过" : "❌ 失败"}

---

## 差异详情

`;

    if (result.diffs.length === 0) {
      report += `✅ **无差异发现**\n\n`;
    } else {
      result.diffs.forEach((diff, index) => {
        report += `### ${index + 1}. ${diff.key}\n\n`;
        report += `- **类型**: ${diff.diffType}\n`;
        report += `- **严重性**: ${diff.severity}\n`;
        report += `- **回测值**: ${JSON.stringify(diff.backtestValue)}\n`;
        report += `- **实盘值**: ${JSON.stringify(diff.liveValue)}\n\n`;
      });
    }

    report += `---

## 建议

`;

    if (result.isValid) {
      report += `✅ 配置一致性校验通过，可以安全启动策略。\n`;
    } else {
      report += `❌ 配置存在差异，请检查并修复后再启动策略。\n\n`;
      report += `### 修复步骤\n\n`;
      report += `1. 检查回测配置: ${result.backtestConfigPath}\n`;
      report += `2. 检查实盘配置: ${result.liveConfigPath}\n`;
      report += `3. 对比差异项并修改\n`;
      report += `4. 重新运行校验\n`;
    }

    report += `---

**报告生成时间**: ${timestamp}
`;

    return report;
  }

  /**
   * 获取统计信息
   */
  getStats(result: ValidationResult): {
    total: number;
    errors: number;
    warnings: number;
    infos: number;
  } {
    return {
      total: result.diffs.length,
      errors: result.diffs.filter((d) => d.severity === "ERROR").length,
      warnings: result.diffs.filter((d) => d.severity === "WARNING").length,
      infos: result.diffs.filter((d) => d.severity === "INFO").length,
    };
  }

  /**
   * 日志
   */
  private log(message: string, ...args: any[]): void {
    const timestamp = new Date().toISOString();
    logger.info(`[${timestamp}] ${message}`, ...args);
  }
}

/**
 * CI/CD集成：启动前自动校验
 */
export async function validateBeforeStart(
  backtestConfigPath: string,
  liveConfigPath: string,
  options?: ValidationOptions
): Promise<boolean> {
  const validator = new ConfigValidator(options);
  const result = validator.validate(backtestConfigPath, liveConfigPath);

  if (!result.isValid) {
    logger.error("❌ 配置一致性校验失败，禁止启动策略！");
    logger.error(`差异项: ${result.diffs.length} 个`);

    result.diffs.forEach((diff) => {
      logger.error(
        `  - ${diff.key}: ${diff.diffType} (${diff.severity})`
      );
    });

    process.exit(1);
  }

  logger.info("✅ 配置一致性校验通过，允许启动策略");
  return true;
}

// ============ 导出 ============

export default ConfigValidator;
