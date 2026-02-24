/**
 * API Key管理集成模块
 * 
 * 将SecureApiKeyManager与BybitProvider集成
 * 提供故障自动切换功能
 */

import { SecureApiKeyManager, SecureApiKey } from './secure-api-key-manager';
import { createLogger } from '../utils/logger';
import { env } from '../config/env';

const logger = createLogger('APIKeyIntegration');

// ============ 集成配置 ============

export interface ApiKeyIntegrationConfig {
  strategyId: string;
  defaultAccountId?: string;
  autoFailover: boolean;
  validateOnStart: boolean;
  enableStats: boolean;
}

// ============ 带故障切换的API调用包装器 ============

export class ResilientApiClient {
  private keyManager: SecureApiKeyManager;
  private config: ApiKeyIntegrationConfig;
  private requestStats: Map<string, { success: number; fail: number }> = new Map();

  constructor(config: ApiKeyIntegrationConfig) {
    this.config = config;
    
    this.keyManager = new SecureApiKeyManager({
      configDir: `${env.HOME}/.config/quant-lab`,
      maxFailCount: 3,
      failCooldownMs: 60000,
      autoRotateOnFail: config.autoFailover,
      validateOnLoad: true,
      enableStats: config.enableStats,
    });

    // 加载已有配置
    this.keyManager.loadFromStore();

    logger.info(`[ResilientApiClient] 初始化完成: ${config.strategyId}`);
    logger.info(`[ResilientApiClient] 自动故障切换: ${config.autoFailover}`);
  }

  /**
   * 获取当前活跃Key
   */
  getActiveKey(): SecureApiKey | null {
    return this.keyManager.getActiveKey();
  }

  /**
   * 获取KeyManager实例（高级用法）
   */
  getKeyManager(): SecureApiKeyManager {
    return this.keyManager;
  }

  /**
   * 添加API Key
   */
  addKey(key: Omit<SecureApiKey, 'failCount' | 'lastUsed' | 'lastFailed' | 'usageCount'>): boolean {
    return this.keyManager.addKey(key);
  }

  /**
   * 带故障切换的API请求包装器
   * 
   * @param requestFn 实际执行请求的函数
   * @param operationName 操作名称（用于日志）
   * @returns 请求结果
   */
  async executeWithFailover<T>(
    requestFn: (key: SecureApiKey) => Promise<T>,
    operationName: string
  ): Promise<T> {
    const key = this.keyManager.getActiveKey();
    
    if (!key) {
      throw new Error('没有可用的API Key');
    }

    try {
      logger.debug(`[ResilientApiClient] 执行 ${operationName} 使用Key: ${key.id}`);
      
      const result = await requestFn(key);
      
      // 记录成功
      this.keyManager.recordSuccess(key.id);
      this.recordRequestStats(key.id, true);
      
      return result;
    } catch (error: any) {
      // 分析错误类型
      const shouldFailover = this.shouldFailover(error);
      
      logger.warn(`[ResilientApiClient] ${operationName} 失败: ${error.message}`);
      logger.warn(`[ResilientApiClient] Key: ${key.id}, 应切换: ${shouldFailover}`);
      
      if (shouldFailover) {
        // 记录失败并触发切换
        const rotated = this.keyManager.recordFailure(key.id, error.message);
        
        if (rotated) {
          logger.info(`[ResilientApiClient] 已自动切换到备用Key`);
          
          // 使用新Key重试
          const newKey = this.keyManager.getActiveKey();
          if (newKey) {
            logger.info(`[ResilientApiClient] 使用新Key ${newKey.id} 重试 ${operationName}`);
            return await requestFn(newKey);
          }
        }
      } else {
        // 不切换Key的错误，仅记录
        this.keyManager.recordFailure(key.id, error.message);
      }
      
      this.recordRequestStats(key.id, false);
      throw error;
    }
  }

  /**
   * 判断是否应该触发故障切换
   */
  private shouldFailover(error: any): boolean {
    const message = error.message?.toLowerCase() || '';
    const code = error.code || '';

    // 认证错误 - 必须切换
    if (
      message.includes('invalid api key') ||
      message.includes('api key error') ||
      message.includes('invalid signature') ||
      code === '10003' ||  // Bybit: Invalid api_key
      code === '10004'     // Bybit: Invalid signature
    ) {
      return true;
    }

    // 权限错误 - 必须切换
    if (
      message.includes('permission denied') ||
      message.includes('unauthorized') ||
      code === '10005'     // Bybit: Permission denied
    ) {
      return true;
    }

    // IP限制 - 必须切换
    if (
      message.includes('ip') ||
      code === '10010'     // Bybit: IP restrictions
    ) {
      return true;
    }

    // 限流错误 - 可选切换（如果配置了多个Key可以分散负载）
    if (
      message.includes('rate limit') ||
      message.includes('too many requests') ||
      code === '10006' ||  // Bybit: Rate limit
      code === 429
    ) {
      // 只有配置了多个Key才切换
      return this.keyManager.getAvailableKeys().length > 1;
    }

    // 网络错误 - 不切换Key，可能是临时网络问题
    // 但连续失败会由SecureApiKeyManager处理
    return false;
  }

  /**
   * 记录请求统计
   */
  private recordRequestStats(keyId: string, success: boolean): void {
    const stats = this.requestStats.get(keyId) || { success: 0, fail: 0 };
    if (success) {
      stats.success++;
    } else {
      stats.fail++;
    }
    this.requestStats.set(keyId, stats);
  }

  /**
   * 获取请求统计
   */
  getRequestStats(): Array<{
    keyId: string;
    success: number;
    fail: number;
    successRate: number;
  }> {
    return Array.from(this.requestStats.entries()).map(([keyId, stats]) => ({
      keyId,
      success: stats.success,
      fail: stats.fail,
      successRate: stats.success + stats.fail > 0 
        ? stats.success / (stats.success + stats.fail) 
        : 1,
    }));
  }

  /**
   * 手动切换到下一个Key
   */
  rotateKey(): boolean {
    return this.keyManager.rotateToNextKey();
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return this.keyManager.getStats();
  }

  /**
   * 保存配置
   */
  saveConfig(): boolean {
    return this.keyManager.saveToStore();
  }

  /**
   * 销毁（清理资源）
   */
  destroy(): void {
    // 保存最终状态
    this.saveConfig();
    logger.info(`[ResilientApiClient] 已销毁: ${this.config.strategyId}`);
  }
}

// ============ Bybit专用集成 ============

export interface BybitApiKeyConfig {
  id: string;
  apiKey: string;
  apiSecret: string;
  testnet?: boolean;
  isPrimary?: boolean;
}

/**
 * Bybit API Key集成管理器
 */
export class BybitKeyManager extends ResilientApiClient {
  constructor(strategyId: string, keys?: BybitApiKeyConfig[]) {
    super({
      strategyId,
      autoFailover: true,
      validateOnStart: true,
      enableStats: true,
    });

    // 如果提供了keys，添加到管理器
    if (keys) {
      for (const key of keys) {
        this.addKey({
          id: key.id,
          exchange: 'bybit',
          apiKey: key.apiKey,
          apiSecret: key.apiSecret,
          permissions: ['read', 'trade'],
          isActive: true,
          isPrimary: key.isPrimary ?? false,
          priority: key.isPrimary ? 1 : 2,
          createdAt: Date.now(),
        });
      }
    }
  }

  /**
   * 从配置文件加载Bybit Keys
   */
  static fromConfigFile(strategyId: string): BybitKeyManager {
    const manager = new BybitKeyManager(strategyId);
    manager.getKeyManager().loadFromStore();
    return manager;
  }
}

// ============ 导出 ============

export type { SecureApiKey } from './secure-api-key-manager';
export { SecureApiKeyManager } from './secure-api-key-manager';
export default ResilientApiClient;
