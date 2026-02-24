/**
 * API Key 安全存储管理器
 * 
 * 功能：
 * 1. 从安全位置加载API Key（~/.config/quant-lab/accounts.json）
 * 2. 支持主Key + 多备Key配置
 * 3. 运行时Key验证和故障切换
 * 4. 使用统计和监控
 */

import { createLogger } from '../utils/logger';
const logger = createLogger('secure-api-key-manager');

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

// ============ 类型定义 ============

export interface SecureApiKey {
  id: string;
  exchange: string;
  apiKey: string;
  apiSecret: string;
  permissions: string[];
  isActive: boolean;
  isPrimary: boolean;      // 是否为主Key
  priority: number;        // 优先级（数字越小优先级越高）
  failCount: number;       // 连续失败次数
  lastUsed: number;
  lastFailed: number;
  usageCount: number;
  createdAt: number;
  expiresAt?: number;
  rateLimit?: {
    requestsPerSecond: number;
    requestsPerMinute: number;
  };
}

export interface ApiKeyStore {
  version: string;
  accounts: SecureApiKey[];
}

export interface KeyManagerConfig {
  configDir: string;
  maxFailCount: number;           // 最大连续失败次数，超过则切换
  failCooldownMs: number;         // 失败后冷却时间
  autoRotateOnFail: boolean;      // 失败时自动轮换
  validateOnLoad: boolean;        // 加载时验证Key格式
  enableStats: boolean;           // 启用使用统计
}

export interface KeyValidationResult {
  valid: boolean;
  keyId: string;
  error?: string;
  permissions?: string[];
}

export interface KeyStats {
  keyId: string;
  isPrimary: boolean;
  isActive: boolean;
  usageCount: number;
  failCount: number;
  successRate: number;
  lastUsed: number;
  lastFailed: number;
}

// ============ 安全存储路径 ============

const DEFAULT_CONFIG_DIR = join(homedir(), '.config', 'quant-lab');
const ACCOUNTS_FILE = 'accounts.json';

// ============ API Key 管理器 ============

export class SecureApiKeyManager {
  private keys: Map<string, SecureApiKey> = new Map();
  private activeKeyId: string | null = null;
  private primaryKeyId: string | null = null;
  private config: KeyManagerConfig;
  private configPath: string;
  private stats: Map<string, { success: number; fail: number }> = new Map();

  constructor(config?: Partial<KeyManagerConfig>) {
    this.config = {
      configDir: DEFAULT_CONFIG_DIR,
      maxFailCount: 3,
      failCooldownMs: 60000,      // 1分钟冷却
      autoRotateOnFail: true,
      validateOnLoad: true,
      enableStats: true,
      ...config,
    };

    this.configPath = join(this.config.configDir, ACCOUNTS_FILE);
    
    logger.info("[SecureApiKeyManager] 初始化 API Key 管理器");
    logger.info(`[SecureApiKeyManager] 配置目录: ${this.config.configDir}`);
    logger.info(`[SecureApiKeyManager] 最大失败次数: ${this.config.maxFailCount}`);
    logger.info(`[SecureApiKeyManager] 自动故障切换: ${this.config.autoRotateOnFail}`);
  }

  /**
   * 从安全存储加载API Key
   */
  loadFromStore(): boolean {
    try {
      if (!existsSync(this.configPath)) {
        logger.warn(`[SecureApiKeyManager] 配置文件不存在: ${this.configPath}`);
        return false;
      }

      const content = readFileSync(this.configPath, 'utf-8');
      const store: ApiKeyStore = JSON.parse(content);

      if (!store.accounts || !Array.isArray(store.accounts)) {
        logger.error('[SecureApiKeyManager] 配置文件格式错误');
        return false;
      }

      logger.info(`[SecureApiKeyManager] 加载 ${store.accounts.length} 个API Key`);

      for (const account of store.accounts) {
        // 验证Key格式
        if (this.config.validateOnLoad) {
          const validation = this.validateKeyFormat(account);
          if (!validation.valid) {
            logger.warn(`[SecureApiKeyManager] Key格式无效，跳过: ${account.id} - ${validation.error}`);
            continue;
          }
        }

        this.keys.set(account.id, {
          ...account,
          failCount: account.failCount || 0,
          lastUsed: account.lastUsed || 0,
          lastFailed: account.lastFailed || 0,
          usageCount: account.usageCount || 0,
        });

        // 记录主Key
        if (account.isPrimary && account.isActive) {
          this.primaryKeyId = account.id;
        }
      }

      // 选择活跃Key（优先级：主Key > 优先级数字最小 > 第一个可用）
      this.selectActiveKey();

      logger.info(`[SecureApiKeyManager] 成功加载 ${this.keys.size} 个Key`);
      logger.info(`[SecureApiKeyManager] 主Key: ${this.primaryKeyId || '无'}`);
      logger.info(`[SecureApiKeyManager] 活跃Key: ${this.activeKeyId || '无'}`);

      return true;
    } catch (error: any) {
      logger.error(`[SecureApiKeyManager] 加载失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 保存到安全存储
   */
  saveToStore(): boolean {
    try {
      // 确保目录存在
      if (!existsSync(this.config.configDir)) {
        mkdirSync(this.config.configDir, { recursive: true });
      }

      const store: ApiKeyStore = {
        version: '1.0',
        accounts: Array.from(this.keys.values()),
      };

      writeFileSync(this.configPath, JSON.stringify(store, null, 2));
      logger.info(`[SecureApiKeyManager] 已保存到: ${this.configPath}`);
      return true;
    } catch (error: any) {
      logger.error(`[SecureApiKeyManager] 保存失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 验证Key格式（本地验证，不调用API）
   */
  validateKeyFormat(key: SecureApiKey): KeyValidationResult {
    // 1. ID验证
    if (!key.id || key.id.length < 3) {
      return { valid: false, keyId: key.id, error: 'ID太短' };
    }

    // 2. API Key格式验证（Bybit格式：16-32位字母数字）
    if (!key.apiKey || !/^[a-zA-Z0-9_-]{16,64}$/.test(key.apiKey)) {
      return { valid: false, keyId: key.id, error: 'API Key格式无效' };
    }

    // 3. API Secret验证
    if (!key.apiSecret || key.apiSecret.length < 32) {
      return { valid: false, keyId: key.id, error: 'API Secret太短' };
    }

    // 4. 交易所验证
    const validExchanges = ['bybit', 'binance', 'okx'];
    if (!key.exchange || !validExchanges.includes(key.exchange)) {
      return { valid: false, keyId: key.id, error: '不支持的交易所' };
    }

    return { valid: true, keyId: key.id, permissions: key.permissions };
  }

  /**
   * 选择活跃Key
   */
  private selectActiveKey(): void {
    // 1. 优先使用主Key（如果可用）
    if (this.primaryKeyId) {
      const primary = this.keys.get(this.primaryKeyId);
      if (primary && primary.isActive && this.isKeyAvailable(primary)) {
        this.activeKeyId = this.primaryKeyId;
        return;
      }
    }

    // 2. 按优先级选择可用的Key
    const availableKeys = Array.from(this.keys.values())
      .filter(k => k.isActive && this.isKeyAvailable(k))
      .sort((a, b) => a.priority - b.priority);

    if (availableKeys.length > 0) {
      this.activeKeyId = availableKeys[0].id;
    }
  }

  /**
   * 检查Key是否可用（冷却期检查）
   */
  private isKeyAvailable(key: SecureApiKey): boolean {
    // 检查是否处于冷却期
    if (key.lastFailed > 0) {
      const cooldownElapsed = Date.now() - key.lastFailed;
      if (cooldownElapsed < this.config.failCooldownMs) {
        return false;
      }
    }
    return true;
  }

  /**
   * 获取当前活跃Key
   */
  getActiveKey(): SecureApiKey | null {
    if (!this.activeKeyId) {
      return null;
    }
    return this.keys.get(this.activeKeyId) || null;
  }

  /**
   * 获取主Key
   */
  getPrimaryKey(): SecureApiKey | null {
    if (!this.primaryKeyId) {
      return null;
    }
    return this.keys.get(this.primaryKeyId) || null;
  }

  /**
   * 获取所有可用Key（按优先级排序）
   */
  getAvailableKeys(): SecureApiKey[] {
    return Array.from(this.keys.values())
      .filter(k => k.isActive)
      .sort((a, b) => {
        // 主Key优先
        if (a.isPrimary !== b.isPrimary) {
          return a.isPrimary ? -1 : 1;
        }
        // 然后按优先级
        return a.priority - b.priority;
      });
  }

  /**
   * 记录成功使用
   */
  recordSuccess(keyId: string): void {
    const key = this.keys.get(keyId);
    if (!key) return;

    key.usageCount++;
    key.lastUsed = Date.now();
    key.failCount = 0;  // 重置失败计数

    if (this.config.enableStats) {
      const stats = this.stats.get(keyId) || { success: 0, fail: 0 };
      stats.success++;
      this.stats.set(keyId, stats);
    }
  }

  /**
   * 记录失败（触发故障切换）
   */
  recordFailure(keyId: string, error?: string): boolean {
    const key = this.keys.get(keyId);
    if (!key) return false;

    key.failCount++;
    key.lastFailed = Date.now();

    if (this.config.enableStats) {
      const stats = this.stats.get(keyId) || { success: 0, fail: 0 };
      stats.fail++;
      this.stats.set(keyId, stats);
    }

    logger.warn(`[SecureApiKeyManager] Key失败: ${keyId} (连续${key.failCount}次)`);

    // 如果超过最大失败次数，禁用该Key并切换
    if (key.failCount >= this.config.maxFailCount) {
      logger.error(`[SecureApiKeyManager] Key超过最大失败次数，禁用: ${keyId}`);
      key.isActive = false;

      // 如果是当前活跃Key，自动切换
      if (this.activeKeyId === keyId && this.config.autoRotateOnFail) {
        return this.rotateToNextKey();
      }
    }

    return false;
  }

  /**
   * 手动切换到下一个可用Key
   */
  rotateToNextKey(): boolean {
    const availableKeys = this.getAvailableKeys();
    
    if (availableKeys.length === 0) {
      logger.error('[SecureApiKeyManager] 没有可用的Key');
      this.activeKeyId = null;
      return false;
    }

    // 找到当前Key的下一个
    const currentIndex = availableKeys.findIndex(k => k.id === this.activeKeyId);
    const nextIndex = (currentIndex + 1) % availableKeys.length;
    const nextKey = availableKeys[nextIndex];

    const oldKeyId = this.activeKeyId;
    this.activeKeyId = nextKey.id;

    logger.info(`[SecureApiKeyManager] 切换Key: ${oldKeyId} -> ${nextKey.id}`);
    return true;
  }

  /**
   * 强制切换到指定Key
   */
  switchToKey(keyId: string): boolean {
    const key = this.keys.get(keyId);
    if (!key) {
      logger.error(`[SecureApiKeyManager] Key不存在: ${keyId}`);
      return false;
    }
    if (!key.isActive) {
      logger.error(`[SecureApiKeyManager] Key未激活: ${keyId}`);
      return false;
    }

    const oldKeyId = this.activeKeyId;
    this.activeKeyId = keyId;
    
    logger.info(`[SecureApiKeyManager] 强制切换Key: ${oldKeyId} -> ${keyId}`);
    return true;
  }

  /**
   * 获取统计信息
   */
  getStats(): KeyStats[] {
    return Array.from(this.keys.values()).map(key => {
      const stats = this.stats.get(key.id) || { success: 0, fail: 0 };
      const total = stats.success + stats.fail;
      return {
        keyId: key.id,
        isPrimary: key.isPrimary,
        isActive: key.isActive,
        usageCount: key.usageCount,
        failCount: key.failCount,
        successRate: total > 0 ? stats.success / total : 1,
        lastUsed: key.lastUsed,
        lastFailed: key.lastFailed,
      };
    });
  }

  /**
   * 添加新Key
   */
  addKey(key: Omit<SecureApiKey, 'failCount' | 'lastUsed' | 'lastFailed' | 'usageCount'>): boolean {
    // 检查ID是否已存在
    if (this.keys.has(key.id)) {
      logger.error(`[SecureApiKeyManager] Key已存在: ${key.id}`);
      return false;
    }

    // 验证格式
    const validation = this.validateKeyFormat(key as SecureApiKey);
    if (!validation.valid) {
      logger.error(`[SecureApiKeyManager] Key格式无效: ${validation.error}`);
      return false;
    }

    const newKey: SecureApiKey = {
      ...key,
      failCount: 0,
      lastUsed: 0,
      lastFailed: 0,
      usageCount: 0,
    };

    this.keys.set(key.id, newKey);

    // 如果是主Key，更新primaryKeyId
    if (key.isPrimary) {
      // 取消其他Key的主Key状态
      for (const k of this.keys.values()) {
        if (k.id !== key.id) {
          k.isPrimary = false;
        }
      }
      this.primaryKeyId = key.id;
    }

    logger.info(`[SecureApiKeyManager] 添加Key: ${key.id}`);
    
    // 如果没有活跃Key，设置为活跃
    if (!this.activeKeyId && key.isActive) {
      this.activeKeyId = key.id;
    }

    return true;
  }

  /**
   * 删除Key
   */
  removeKey(keyId: string): boolean {
    if (!this.keys.has(keyId)) {
      return false;
    }

    // 不能删除当前活跃Key
    if (this.activeKeyId === keyId) {
      logger.error(`[SecureApiKeyManager] 不能删除当前活跃Key: ${keyId}`);
      return false;
    }

    this.keys.delete(keyId);
    
    if (this.primaryKeyId === keyId) {
      this.primaryKeyId = null;
    }

    logger.info(`[SecureApiKeyManager] 删除Key: ${keyId}`);
    return true;
  }

  /**
   * 获取配置路径
   */
  getConfigPath(): string {
    return this.configPath;
  }
}

// ============ 导出 ============

export type { SecureApiKey };
export default SecureApiKeyManager;
