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

export interface ConfigChange {
  key: string;
  oldValue: any;
  newValue: any;
  timestamp: number;
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
  validateConfig?: (config: Record<string, any>) => boolean;
}

// ============ 配置热重载管理器 ============

export class ConfigHotReloadManager {
  private configPath: string;
  private config: Record<string, any> = {};
  private watcher: any = null;
  private backupDir: string;
  private maxBackups: number;
  private validateConfig?: (config: Record<string, any>) => boolean;
  private events: Partial<ConfigHotReloadEvents> = {};
  private snapshots: ConfigSnapshot[] = [];
  private currentVersion: number = 0;
  private isReloading: boolean = false;
  private lastReloadTime: number = 0;

  constructor(configPath: string, options?: HotReloadOptions) {
    this.configPath = configPath;
    this.backupDir = options?.backupDir || join(homedir(), ".quant-lab", "config-backups");
    this.maxBackups = options?.maxBackups || 10;
    this.validateConfig = options?.validateConfig;

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

      // 2. 验证配置
      if (this.validateConfig && !this.validateConfig(newConfig)) {
        throw new Error("配置验证失败");
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

      // 6. 触发事件
      this.log(`[ConfigHotReload] 配置已重载，版本: ${this.currentVersion}, 变更: ${changes.length} 项`);
      this.events.onConfigChange?.(changes);
      this.events.onConfigReload?.(this.config);

      // 7. 清理旧备份
      this.cleanupOldBackups();
    } catch (error: any) {
      this.log(`[ConfigHotReload] 配置重载失败: ${error.message}`);
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
