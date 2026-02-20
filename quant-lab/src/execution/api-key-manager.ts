/**
 * API Key 管理框架
 * 
 * 功能：
 * 1. API Key 轮换/备用
 * 2. API Key 验证
 * 3. 权限管理
 * 
 * 位置：quant-lab/src/execution/api-key-manager.ts
 * 协作模式：b号搭框架，a号填业务逻辑
 */

// ============ 类型定义 ============

export interface ApiKey {
  id: string;
  key: string;
  secret: string;
  permissions: string[];
  isActive: boolean;
  lastUsed: number;
  usageCount: number;
  createdAt: number;
  expiresAt?: number;
}

export interface ApiKeyConfig {
  rotationInterval: number; // 轮换间隔（毫秒）
  maxUsageCount: number; // 最大使用次数
  enableAutoRotation: boolean; // 是否自动轮换
}

export interface ApiKeyManagerEvents {
  onKeyRotated: (oldKeyId: string, newKeyId: string) => void;
  onKeyExpired: (keyId: string) => void;
  onKeyInvalid: (keyId: string, error: Error) => void;
  onError: (error: Error) => void;
}

// ============ API Key 管理器 ============

export class ApiKeyManager {
  private keys: Map<string, ApiKey> = new Map();
  private activeKeyId: string | null = null;
  private config: ApiKeyConfig;
  private events: Partial<ApiKeyManagerEvents> = {};

  constructor(config?: Partial<ApiKeyConfig>) {
    this.config = {
      rotationInterval: 24 * 60 * 60 * 1000, // 24小时
      maxUsageCount: 10000,
      enableAutoRotation: true,
      ...config,
    };

    console.log("[ApiKeyManager] 初始化 API Key 管理器");
    console.log(`[ApiKeyManager] 轮换间隔: ${this.config.rotationInterval}ms`);
    console.log(`[ApiKeyManager] 最大使用次数: ${this.config.maxUsageCount}`);
  }

  /**
   * 设置事件回调
   */
  setEvents(events: Partial<ApiKeyManagerEvents>): void {
    this.events = { ...this.events, ...events };
  }

  /**
   * 添加 API Key
   */
  addKey(key: ApiKey): void {
    this.keys.set(key.id, key);
    console.log(`[ApiKeyManager] 添加 API Key: ${key.id}`);

    // 如果没有活跃的 Key，设置为活跃
    if (!this.activeKeyId) {
      this.activeKeyId = key.id;
      console.log(`[ApiKeyManager] 设置为活跃 Key: ${key.id}`);
    }
  }

  /**
   * 获取当前活跃的 API Key
   */
  getActiveKey(): ApiKey | null {
    if (!this.activeKeyId) {
      console.warn("[ApiKeyManager] 没有活跃的 API Key");
      return null;
    }

    const key = this.keys.get(this.activeKeyId);
    if (!key) {
      console.error(`[ApiKeyManager] 活跃 Key 不存在: ${this.activeKeyId}`);
      return null;
    }

    return key;
  }

  /**
   * 轮换到下一个 API Key
   */
  rotateKey(): string | null {
    const currentKey = this.getActiveKey();
    if (!currentKey) {
      return null;
    }

    // 查找下一个可用的 Key
    const availableKeys = Array.from(this.keys.values()).filter(
      (k) => k.id !== currentKey.id && k.isActive
    );

    if (availableKeys.length === 0) {
      console.warn("[ApiKeyManager] 没有可用的备用 Key");
      return null;
    }

    // 选择下一个 Key（简单轮询）
    const nextKey = availableKeys[0];
    const oldKeyId = this.activeKeyId;
    this.activeKeyId = nextKey.id;

    console.log(`[ApiKeyManager] 轮换 Key: ${oldKeyId} -> ${nextKey.id}`);
    this.events.onKeyRotated?.(oldKeyId!, nextKey.id);

    return nextKey.id;
  }

  /**
   * 验证 API Key
   */
  async validateKey(keyId: string): Promise<boolean> {
    console.log(`[ApiKeyManager] 验证 Key: ${keyId}`);

    const key = this.keys.get(keyId);
    if (!key) {
      console.error(`[ApiKeyManager] Key 不存在: ${keyId}`);
      this.events.onKeyInvalid?.(keyId, new Error("Key not found"));
      return false;
    }

    // TODO: a号填充实际的验证逻辑
    // 例如：调用交易所 API 验证权限
    
    // 临时实现：简单检查
    const isValid = key.isActive && key.key && key.secret;

    if (!isValid) {
      console.warn(`[ApiKeyManager] Key 无效: ${keyId}`);
      this.events.onKeyInvalid?.(keyId, new Error("Key invalid"));
    }

    return isValid;
  }

  /**
   * 记录 Key 使用
   */
  recordUsage(keyId: string): void {
    const key = this.keys.get(keyId);
    if (!key) {
      return;
    }

    key.usageCount++;
    key.lastUsed = Date.now();

    // 检查是否需要轮换
    if (
      this.config.enableAutoRotation &&
      key.usageCount >= this.config.maxUsageCount
    ) {
      console.log(`[ApiKeyManager] Key 达到最大使用次数，自动轮换: ${keyId}`);
      this.rotateKey();
    }
  }

  /**
   * 检查 Key 是否过期
   */
  checkExpiration(): void {
    const now = Date.now();

    for (const [id, key] of this.keys) {
      if (key.expiresAt && now > key.expiresAt) {
        console.warn(`[ApiKeyManager] Key 已过期: ${id}`);
        key.isActive = false;
        this.events.onKeyExpired?.(id);

        // 如果是活跃 Key，自动轮换
        if (this.activeKeyId === id) {
          this.rotateKey();
        }
      }
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalKeys: number;
    activeKeys: number;
    currentKeyId: string | null;
    totalUsage: number;
  } {
    return {
      totalKeys: this.keys.size,
      activeKeys: Array.from(this.keys.values()).filter((k) => k.isActive)
        .length,
      currentKeyId: this.activeKeyId,
      totalUsage: Array.from(this.keys.values()).reduce(
        (sum, k) => sum + k.usageCount,
        0
      ),
    };
  }

  /**
   * 获取所有 Key
   */
  getAllKeys(): ApiKey[] {
    return Array.from(this.keys.values());
  }

  /**
   * 删除 Key
   */
  removeKey(keyId: string): boolean {
    if (this.activeKeyId === keyId) {
      console.warn(`[ApiKeyManager] 不能删除活跃的 Key: ${keyId}`);
      return false;
    }

    const deleted = this.keys.delete(keyId);
    if (deleted) {
      console.log(`[ApiKeyManager] 删除 Key: ${keyId}`);
    }

    return deleted;
  }
}

// ============ 导出 ============

export default ApiKeyManager;
