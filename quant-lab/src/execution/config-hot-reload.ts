/**
 * 配置热重载 - 策略参数无需重启即时生效
 * 
 * 功能：
 * 1. 监听配置文件变更（fs.watch）
 * 2. 热注入新参数到运行中的策略
 * 3. 不中断当前持仓/订单
 * 4. 变更日志+回滚支持
 * 
 * 位置：quant-lab/src/execution/config-hot-reload.ts
 */

import { watch, readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

// ============ 类型定义 ============

/**
 * 参数校验规则
 */
export interface ValidationRule {
  type: 'number' | 'string' | 'boolean' | 'array';
  required?: boolean;
  min?: number;           // 数值最小值
  max?: number;           // 数值最大值
  minLength?: number;     // 字符串最小长度
  maxLength?: number;     // 字符串最大长度
  pattern?: RegExp;       // 字符串正则匹配
  enum?: any[];           // 枚举值
  custom?: (value: any) => boolean | string; // 自定义校验，返回true通过，字符串为错误信息
}

/**
 * 校验规则集合
 */
export type ValidationRules = Record<string, ValidationRule>;

/**
 * 校验结果
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ConfigChange {
  key: string;
  oldValue: any;
  newValue: any;
  timestamp: number;
}

export interface ConfigChangeRecord extends ConfigChange {
  version: number;  // P2新增：变更时的版本号
}

export interface ConfigSnapshot {
  config: Record<string, any>;
  timestamp: number;
  version: number;
}

export interface ConfigHotReloadEvents {
  onConfigChange: (changes: ConfigChange[]) => void;
  onConfigReload: (config: Record<string, any>) => void;
  onError: (error: Error) => void;
  onRollback: (snapshot: ConfigSnapshot) => void;
}

export interface HotReloadOptions {
  watchPath?: string;
  backupDir?: string;
  maxBackups?: number;
  validateConfig?: (config: Record<string, any>) => boolean | ValidationResult;
  validationRules?: ValidationRules; // P1新增：参数校验规则
  onValidationFail?: (errors: string[]) => void; // P1新增：校验失败回调
}

// ============ 配置热重载管理器 ============

export class ConfigHotReloadManager {
  private configPath: string;
  private config: Record<string, any> = {};
  private watcher: any = null;
  private backupDir: string;
  private maxBackups: number;
  private validateConfig?: (config: Record<string, any>) => boolean | ValidationResult;
  private validationRules?: ValidationRules; // P1新增
  private onValidationFail?: (errors: string[]) => void; // P1新增
  private events: Partial<ConfigHotReloadEvents> = {};
  private snapshots: ConfigSnapshot[] = [];
  // P2新增：配置变更历史（最多10条）
  private configHistory: ConfigChangeRecord[] = [];
  private readonly MAX_HISTORY_SIZE = 10;
  private currentVersion: number = 0;
  private isReloading: boolean = false;
  private lastReloadTime: number = 0;

  constructor(configPath: string, options?: HotReloadOptions) {
    this.configPath = configPath;
    this.backupDir = options?.backupDir || join(homedir(), ".quant-lab", "config-backups");
    this.maxBackups = options?.maxBackups || 10;
    this.validateConfig = options?.validateConfig;
    this.validationRules = options?.validationRules; // P1新增
    this.onValidationFail = options?.onValidationFail; // P1新增

    // 确保备份目录存在
    if (!existsSync(this.backupDir)) {
      mkdirSync(this.backupDir, { recursive: true });
    }

    // 加载初始配置
    this.loadConfig();
  }

  /**
   * 设置事件回调
   */
  setEvents(events: Partial<ConfigHotReloadEvents>): void {
    this.events = { ...this.events, ...events };
  }

  // P1新增: 参数校验方法 ========================================

  /**
   * 使用规则校验配置
   * @param config 待校验配置
   * @param rules 校验规则
   * @returns 校验结果
   */
  validateWithRules(config: Record<string, any>, rules?: ValidationRules): ValidationResult {
    const validationRules = rules || this.validationRules;
    if (!validationRules) {
      return { valid: true, errors: [] };
    }

    const errors: string[] = [];

    for (const [key, rule] of Object.entries(validationRules)) {
      const value = config[key];

      // 必填检查
      if (rule.required && (value === undefined || value === null)) {
        errors.push(`[校验失败] ${key}: 必填项缺失`);
        continue;
      }

      // 未提供且非必填，跳过
      if (value === undefined || value === null) {
        continue;
      }

      // 类型检查
      if (rule.type) {
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        if (actualType !== rule.type) {
          errors.push(`[校验失败] ${key}: 类型错误，期望 ${rule.type}，实际 ${actualType}`);
          continue;
        }
      }

      // 数值范围检查
      if (rule.type === 'number') {
        if (rule.min !== undefined && value < rule.min) {
          errors.push(`[校验失败] ${key}: 数值过小，最小值 ${rule.min}，实际 ${value}`);
        }
        if (rule.max !== undefined && value > rule.max) {
          errors.push(`[校验失败] ${key}: 数值过大，最大值 ${rule.max}，实际 ${value}`);
        }
      }

      // 字符串长度检查
      if (rule.type === 'string') {
        if (rule.minLength !== undefined && value.length < rule.minLength) {
          errors.push(`[校验失败] ${key}: 字符串过短，最小长度 ${rule.minLength}，实际 ${value.length}`);
        }
        if (rule.maxLength !== undefined && value.length > rule.maxLength) {
          errors.push(`[校验失败] ${key}: 字符串过长，最大长度 ${rule.maxLength}，实际 ${value.length}`);
        }
        if (rule.pattern && !rule.pattern.test(value)) {
          errors.push(`[校验失败] ${key}: 格式不匹配，期望 ${rule.pattern}`);
        }
      }

      // 枚举检查
      if (rule.enum && !rule.enum.includes(value)) {
        errors.push(`[校验失败] ${key}: 值不在允许范围内，期望 ${rule.enum.join(', ')}，实际 ${value}`);
      }

      // 自定义校验
      if (rule.custom) {
        const customResult = rule.custom(value);
        if (customResult !== true) {
          errors.push(`[校验失败] ${key}: ${typeof customResult === 'string' ? customResult : '自定义校验失败'}`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * 策略参数默认校验规则 (Gales策略)
   */
  static getGalesValidationRules(): ValidationRules {
    return {
      symbol: {
        type: 'string',
        required: true,
        pattern: /^[A-Z0-9]+USDT$/,
      },
      gridCount: {
        type: 'number',
        required: true,
        min: 2,
        max: 50,
      },
      gridSpacing: {
        type: 'number',
        required: true,
        min: 0.001,
        max: 0.5,
      },
      gridSpacingUp: {
        type: 'number',
        min: 0.001,
        max: 0.5,
      },
      gridSpacingDown: {
        type: 'number',
        min: 0.001,
        max: 0.5,
      },
      orderSize: {
        type: 'number',
        required: true,
        min: 1,
        max: 100000,
      },
      orderSizeUp: {
        type: 'number',
        min: 1,
        max: 100000,
      },
      orderSizeDown: {
        type: 'number',
        min: 1,
        max: 100000,
      },
      maxPosition: {
        type: 'number',
        required: true,
        min: 10,
        max: 1000000,
      },
      direction: {
        type: 'string',
        required: true,
        enum: ['long', 'short', 'neutral'],
      },
      magnetDistance: {
        type: 'number',
        min: 0.001,
        max: 0.1,
      },
      cancelDistance: {
        type: 'number',
        min: 0.001,
        max: 0.1,
      },
      cooldownSec: {
        type: 'number',
        min: 0,
        max: 3600,
      },
      maxActiveOrders: {
        type: 'number',
        min: 1,
        max: 100,
      },
      autoRecenter: {
        type: 'boolean',
      },
      recenterDistance: {
        type: 'number',
        min: 0.01,
        max: 0.5,
      },
      simMode: {
        type: 'boolean',
      },
    };
  }

  // P1新增结束 ========================================

  /**
   * 加载配置
   */
  private loadConfig(): void {
    try {
      if (existsSync(this.configPath)) {
        const content = readFileSync(this.configPath, "utf-8");
        this.config = JSON.parse(content);
        this.currentVersion++;
        this.log(`[ConfigHotReload] 配置已加载，版本: ${this.currentVersion}`);
      } else {
        this.log(`[ConfigHotReload] 配置文件不存在: ${this.configPath}`);
      }
    } catch (error: any) {
      this.log(`[ConfigHotReload] 加载配置失败: ${error.message}`);
      this.events.onError?.(error);
    }
  }

  /**
   * 启动监听
   */
  startWatching(): void {
    if (this.watcher) {
      this.log("[ConfigHotReload] 监听已启动");
      return;
    }

    this.log(`[ConfigHotReload] 开始监听配置文件: ${this.configPath}`);

    this.watcher = watch(this.configPath, (eventType, filename) => {
      if (eventType === "change") {
        this.log(`[ConfigHotReload] 检测到配置文件变更: ${filename}`);
        this.handleConfigChange();
      }
    });

    this.watcher.on("error", (error: Error) => {
      this.log(`[ConfigHotReload] 监听错误: ${error.message}`);
      this.events.onError?.(error);
    });

    this.log("[ConfigHotReload] 监听已启动");
  }

  /**
   * 停止监听
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      this.log("[ConfigHotReload] 监听已停止");
    }
  }

  /**
   * 处理配置变更
   */
  private handleConfigChange(): void {
    // 防抖：避免短时间内多次触发
    const now = Date.now();
    if (now - this.lastReloadTime < 1000) {
      this.log("[ConfigHotReload] 防抖：忽略快速变更");
      return;
    }

    if (this.isReloading) {
      this.log("[ConfigHotReload] 正在重载中，跳过");
      return;
    }

    this.isReloading = true;
    this.lastReloadTime = now;

    try {
      // 1. 读取新配置
      const newConfig = this.readConfigFile();

      // 2. 验证配置 (P1增强: 支持规则校验和自定义校验)
      let validationErrors: string[] = [];

      // 2.1 规则校验
      const ruleValidation = this.validateWithRules(newConfig);
      if (!ruleValidation.valid) {
        validationErrors.push(...ruleValidation.errors);
      }

      // 2.2 自定义校验
      if (this.validateConfig) {
        const customResult = this.validateConfig(newConfig);
        if (typeof customResult === 'boolean') {
          if (!customResult) {
            validationErrors.push('[自定义校验失败]');
          }
        } else if (!customResult.valid) {
          validationErrors.push(...customResult.errors);
        }
      }

      // 2.3 校验失败处理
      if (validationErrors.length > 0) {
        this.log(`[ConfigHotReload] ❌ 配置校验失败，拒绝更新:`);
        validationErrors.forEach(err => this.log(`  ${err}`));

        // 触发校验失败回调
        this.onValidationFail?.(validationErrors);

        // 发送告警事件
        const error = new Error(`配置校验失败: ${validationErrors.join('; ')}`);
        this.events.onError?.(error);

        this.isReloading = false;
        return;
      }

      // 3. 检测变更
      const changes = this.detectChanges(this.config, newConfig);

      if (changes.length === 0) {
        this.log("[ConfigHotReload] 无实际变更，跳过");
        this.isReloading = false;
        return;
      }

      // 4. 创建快照（备份）
      const snapshot = this.createSnapshot(this.config);
      this.snapshots.push(snapshot);
      this.saveBackup(snapshot);

      // 5. 应用新配置
      this.config = newConfig;
      this.currentVersion++;

      // 5.1 记录变更详情（运维审计）
      this.log(`[ConfigHotReload] ✅ 配置已重载，版本: ${this.currentVersion}, 变更: ${changes.length} 项`);
      for (const change of changes) {
        const oldVal = typeof change.oldValue === 'object' ? JSON.stringify(change.oldValue) : change.oldValue;
        const newVal = typeof change.newValue === 'object' ? JSON.stringify(change.newValue) : change.newValue;
        this.log(`  - ${change.key}: ${oldVal} → ${newVal}`);
      }

      // P2新增：记录到配置变更历史
      this.recordConfigHistory(changes);

      // 6. 触发事件
      this.events.onConfigChange?.(changes);
      this.events.onConfigReload?.(this.config);

      // 7. 清理旧备份
      this.cleanupOldBackups();
    } catch (error: any) {
      this.log(`[ConfigHotReload] ❌ 配置重载失败: ${error.message}`);
      this.events.onError?.(error);
    } finally {
      this.isReloading = false;
    }
  }

  /**
   * 读取配置文件
   */
  private readConfigFile(): Record<string, any> {
    const content = readFileSync(this.configPath, "utf-8");
    return JSON.parse(content);
  }

  /**
   * 检测配置变更
   */
  private detectChanges(
    oldConfig: Record<string, any>,
    newConfig: Record<string, any>
  ): ConfigChange[] {
    const changes: ConfigChange[] = [];
    const allKeys = new Set([...Object.keys(oldConfig), ...Object.keys(newConfig)]);

    for (const key of allKeys) {
      const oldValue = oldConfig[key];
      const newValue = newConfig[key];

      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        changes.push({
          key,
          oldValue,
          newValue,
          timestamp: Date.now(),
        });
      }
    }

    return changes;
  }

  /**
   * 创建快照
   */
  private createSnapshot(config: Record<string, any>): ConfigSnapshot {
    return {
      config: { ...config },
      timestamp: Date.now(),
      version: this.currentVersion,
    };
  }

  /**
   * 保存备份
   */
  private saveBackup(snapshot: ConfigSnapshot): void {
    const backupPath = join(
      this.backupDir,
      `config-v${snapshot.version}-${snapshot.timestamp}.json`
    );

    writeFileSync(backupPath, JSON.stringify(snapshot, null, 2));
    this.log(`[ConfigHotReload] 备份已保存: ${backupPath}`);
  }

  /**
   * 清理旧备份
   */
  private cleanupOldBackups(): void {
    if (this.snapshots.length > this.maxBackups) {
      const toRemove = this.snapshots.splice(0, this.snapshots.length - this.maxBackups);
      
      for (const snapshot of toRemove) {
        const backupPath = join(
          this.backupDir,
          `config-v${snapshot.version}-${snapshot.timestamp}.json`
        );
        
        if (existsSync(backupPath)) {
          const { unlinkSync } = require("fs");
          unlinkSync(backupPath);
          this.log(`[ConfigHotReload] 清理旧备份: ${backupPath}`);
        }
      }
    }
  }

  /**
   * 回滚到指定版本
   */
  rollbackToVersion(version: number): boolean {
    const snapshot = this.snapshots.find((s) => s.version === version);

    if (!snapshot) {
      this.log(`[ConfigHotReload] 未找到版本 ${version} 的快照`);
      return false;
    }

    try {
      // 恢复配置
      this.config = { ...snapshot.config };
      this.currentVersion++;

      // 写回配置文件
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));

      this.log(`[ConfigHotReload] 已回滚到版本 ${version}`);
      this.events.onRollback?.(snapshot);
      this.events.onConfigReload?.(this.config);

      return true;
    } catch (error: any) {
      this.log(`[ConfigHotReload] 回滚失败: ${error.message}`);
      this.events.onError?.(error);
      return false;
    }
  }

  /**
   * 回滚到上一个版本
   */
  rollbackToPrevious(): boolean {
    if (this.snapshots.length < 2) {
      this.log("[ConfigHotReload] 没有可回滚的版本");
      return false;
    }

    const previousSnapshot = this.snapshots[this.snapshots.length - 2];
    return this.rollbackToVersion(previousSnapshot.version);
  }

  /**
   * 获取当前配置
   */
  getConfig(): Record<string, any> {
    return { ...this.config };
  }

  /**
   * 获取配置值
   */
  get<T = any>(key: string, defaultValue?: T): T {
    return this.config[key] !== undefined ? this.config[key] : defaultValue as T;
  }

  /**
   * 设置配置值（手动更新）
   */
  set(key: string, value: any): void {
    // 创建快照
    const snapshot = this.createSnapshot(this.config);
    this.snapshots.push(snapshot);
    this.saveBackup(snapshot);

    // 更新配置
    this.config[key] = value;
    this.currentVersion++;

    // 写回文件
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));

    this.log(`[ConfigHotReload] 配置已更新: ${key} = ${value}`);
    this.events.onConfigReload?.(this.config);
  }

  /**
   * 获取快照列表
   */
  getSnapshots(): ConfigSnapshot[] {
    return [...this.snapshots];
  }

  /**
   * 获取当前版本
   */
  getCurrentVersion(): number {
    return this.currentVersion;
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    version: number;
    snapshotCount: number;
    lastReloadTime: number;
    isWatching: boolean;
  } {
    return {
      version: this.currentVersion,
      snapshotCount: this.snapshots.length,
      lastReloadTime: this.lastReloadTime,
      isWatching: this.watcher !== null,
    };
  }

  // P2新增：配置变更历史管理 ========================================

  /**
   * 记录配置变更历史
   */
  private recordConfigHistory(changes: ConfigChange[]): void {
    const now = Date.now();
    for (const change of changes) {
      this.configHistory.push({
        key: change.key,
        oldValue: change.oldValue,
        newValue: change.newValue,
        timestamp: now,
        version: this.currentVersion,
      });
    }

    // 限制历史记录数量（最多10条）
    if (this.configHistory.length > this.MAX_HISTORY_SIZE) {
      this.configHistory = this.configHistory.slice(-this.MAX_HISTORY_SIZE);
    }

    this.log(`[ConfigHotReload] 已记录 ${changes.length} 项变更到历史 (共 ${this.configHistory.length} 条)`);
  }

  /**
   * 获取配置变更历史
   */
  getConfigHistory(): ConfigChangeRecord[] {
    return [...this.configHistory];
  }

  /**
   * 清除配置变更历史
   */
  clearConfigHistory(): void {
    this.configHistory = [];
    this.log('[ConfigHotReload] 配置变更历史已清除');
  }

  // P2新增结束 ========================================

  /**
   * 日志
   */
  private log(message: string, ...args: any[]): void {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`, ...args);
  }
}

// ============ 导出 ============

export default ConfigHotReloadManager;
