/**
 * API Key 管理器单元测试
 * 
 * 测试覆盖：
 * 1. 加载/保存功能
 * 2. Key验证
 * 3. 故障切换
 * 4. 统计功能
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { 
  SecureApiKeyManager, 
  SecureApiKey,
  KeyManagerConfig 
} from '../src/execution/secure-api-key-manager';

describe('SecureApiKeyManager', () => {
  let testDir: string;
  let manager: SecureApiKeyManager;

  beforeEach(() => {
    // 创建临时测试目录
    testDir = join(tmpdir(), `api-key-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    const config: Partial<KeyManagerConfig> = {
      configDir: testDir,
      maxFailCount: 3,
      failCooldownMs: 1000,  // 1秒冷却（测试用）
      autoRotateOnFail: true,
      validateOnLoad: true,
    };

    manager = new SecureApiKeyManager(config);
  });

  afterEach(() => {
    // 清理测试目录
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  // ============ 基础功能测试 ============

  describe('基础功能', () => {
    it('应该正确初始化', () => {
      expect(manager).toBeDefined();
      expect(manager.getActiveKey()).toBeNull();
      expect(manager.getConfigPath()).toBe(join(testDir, 'accounts.json'));
    });

    it('应该能添加Key', () => {
      const key: Omit<SecureApiKey, 'failCount' | 'lastUsed' | 'lastFailed' | 'usageCount'> = {
        id: 'test-key-1',
        exchange: 'bybit',
        apiKey: 'Z3gcRsakDKNPvJ4axr',
        apiSecret: 'WkUM3mOmVPh6R9fvLeAoKxc9GBjllKTIdZHP',
        permissions: ['read', 'trade'],
        isActive: true,
        isPrimary: true,
        priority: 1,
        createdAt: Date.now(),
      };

      const result = manager.addKey(key);
      expect(result).toBe(true);

      const activeKey = manager.getActiveKey();
      expect(activeKey).toBeDefined();
      expect(activeKey?.id).toBe('test-key-1');
    });

    it('应该拒绝无效格式的Key', () => {
      const invalidKey: any = {
        id: 'test',
        exchange: 'bybit',
        apiKey: 'short',  // 太短
        apiSecret: 'also-short',
        permissions: [],
        isActive: true,
        isPrimary: true,
        priority: 1,
        createdAt: Date.now(),
      };

      const result = manager.addKey(invalidKey);
      expect(result).toBe(false);
    });

    it('应该拒绝重复的Key ID', () => {
      const key = {
        id: 'duplicate-id',
        exchange: 'bybit',
        apiKey: 'Z3gcRsakDKNPvJ4axr',
        apiSecret: 'WkUM3mOmVPh6R9fvLeAoKxc9GBjllKTIdZHP',
        permissions: [],
        isActive: true,
        isPrimary: false,
        priority: 1,
        createdAt: Date.now(),
      };

      manager.addKey(key);
      const result = manager.addKey(key);
      expect(result).toBe(false);
    });
  });

  // ============ 多Key管理测试 ============

  describe('多Key管理', () => {
    beforeEach(() => {
      // 添加主Key
      manager.addKey({
        id: 'primary-key',
        exchange: 'bybit',
        apiKey: 'Z3gcRsakDKNPvJ4axr',
        apiSecret: 'WkUM3mOmVPh6R9fvLeAoKxc9GBjllKTIdZHP',
        permissions: ['read', 'trade'],
        isActive: true,
        isPrimary: true,
        priority: 1,
        createdAt: Date.now(),
      });

      // 添加备Key
      manager.addKey({
        id: 'backup-key-1',
        exchange: 'bybit',
        apiKey: 'IyWRZW7tRUtetNn93w',
        apiSecret: 'Az1yOANg2d3r62njagNEkctKStTPMyBCiisv',
        permissions: ['read', 'trade'],
        isActive: true,
        isPrimary: false,
        priority: 2,
        createdAt: Date.now(),
      });

      // 添加低优先级备Key
      manager.addKey({
        id: 'backup-key-2',
        exchange: 'bybit',
        apiKey: 'AbCdEfGhIjKlMnOpQr',
        apiSecret: 'XyZaBcDeFgHiJkLmNoPqRsTuVwXyZaBc',
        permissions: ['read'],
        isActive: true,
        isPrimary: false,
        priority: 3,
        createdAt: Date.now(),
      });
    });

    it('应该正确识别主Key', () => {
      const primary = manager.getPrimaryKey();
      expect(primary?.id).toBe('primary-key');
      expect(primary?.isPrimary).toBe(true);
    });

    it('应该按优先级返回可用Key', () => {
      const keys = manager.getAvailableKeys();
      expect(keys.length).toBe(3);
      expect(keys[0].id).toBe('primary-key');  // 主Key优先
      expect(keys[1].id).toBe('backup-key-1'); // 优先级2
      expect(keys[2].id).toBe('backup-key-2'); // 优先级3
    });

    it('应该能手动切换Key', () => {
      const result = manager.switchToKey('backup-key-1');
      expect(result).toBe(true);

      const active = manager.getActiveKey();
      expect(active?.id).toBe('backup-key-1');
    });

    it('应该能轮询切换到下一个Key', () => {
      // 当前是primary-key
      expect(manager.getActiveKey()?.id).toBe('primary-key');

      // 轮询到backup-key-1
      manager.rotateToNextKey();
      expect(manager.getActiveKey()?.id).toBe('backup-key-1');

      // 轮询到backup-key-2
      manager.rotateToNextKey();
      expect(manager.getActiveKey()?.id).toBe('backup-key-2');

      // 轮询回primary-key
      manager.rotateToNextKey();
      expect(manager.getActiveKey()?.id).toBe('primary-key');
    });

    it('应该拒绝切换到不存在的Key', () => {
      const result = manager.switchToKey('non-existent');
      expect(result).toBe(false);
    });
  });

  // ============ 故障切换测试 ============

  describe('故障切换', () => {
    beforeEach(() => {
      manager.addKey({
        id: 'key-a',
        exchange: 'bybit',
        apiKey: 'Z3gcRsakDKNPvJ4axr',
        apiSecret: 'WkUM3mOmVPh6R9fvLeAoKxc9GBjllKTIdZHP',
        permissions: ['read', 'trade'],
        isActive: true,
        isPrimary: true,
        priority: 1,
        createdAt: Date.now(),
      });

      manager.addKey({
        id: 'key-b',
        exchange: 'bybit',
        apiKey: 'IyWRZW7tRUtetNn93w',
        apiSecret: 'Az1yOANg2d3r62njagNEkctKStTPMyBCiisv',
        permissions: ['read', 'trade'],
        isActive: true,
        isPrimary: false,
        priority: 2,
        createdAt: Date.now(),
      });
    });

    it('应该记录成功使用', () => {
      manager.recordSuccess('key-a');
      
      const stats = manager.getStats();
      const keyAStats = stats.find(s => s.keyId === 'key-a');
      expect(keyAStats?.usageCount).toBe(1);
      expect(keyAStats?.failCount).toBe(0);
      expect(keyAStats?.successRate).toBe(1);
    });

    it('应该记录失败并增加失败计数', () => {
      manager.recordFailure('key-a', 'Network error');
      
      const stats = manager.getStats();
      const keyAStats = stats.find(s => s.keyId === 'key-a');
      expect(keyAStats?.failCount).toBe(1);
      expect(keyAStats?.successRate).toBe(0); // 1 fail, 0 success
    });

    it('应该在连续失败达到阈值时禁用Key', () => {
      // 连续失败3次
      manager.recordFailure('key-a', 'Error 1');
      manager.recordFailure('key-a', 'Error 2');
      
      // 第3次失败应该触发禁用
      const rotated = manager.recordFailure('key-a', 'Error 3');
      expect(rotated).toBe(true);  // 触发了切换

      // key-a应该被禁用
      const stats = manager.getStats();
      const keyAStats = stats.find(s => s.keyId === 'key-a');
      expect(keyAStats?.isActive).toBe(false);
    });

    it('应该在Key禁用时自动切换到备用Key', () => {
      // 当前活跃是key-a
      expect(manager.getActiveKey()?.id).toBe('key-a');

      // 连续失败触发切换
      manager.recordFailure('key-a', 'Error 1');
      manager.recordFailure('key-a', 'Error 2');
      manager.recordFailure('key-a', 'Error 3');

      // 应该切换到key-b
      expect(manager.getActiveKey()?.id).toBe('key-b');
    });

    it('成功使用后应该重置失败计数', () => {
      manager.recordFailure('key-a', 'Error 1');
      manager.recordFailure('key-a', 'Error 2');
      
      // 成功后重置
      manager.recordSuccess('key-a');
      
      const stats = manager.getStats();
      const keyAStats = stats.find(s => s.keyId === 'key-a');
      expect(keyAStats?.failCount).toBe(0);
    });
  });

  // ============ 配置加载测试 ============

  describe('配置加载', () => {
    it('应该从配置文件加载Key', () => {
      const configContent = {
        version: '1.0',
        accounts: [
          {
            id: 'loaded-key-1',
            exchange: 'bybit',
            apiKey: 'Z3gcRsakDKNPvJ4axr',
            apiSecret: 'WkUM3mOmVPh6R9fvLeAoKxc9GBjllKTIdZHP',
            permissions: ['read', 'trade'],
            isActive: true,
            isPrimary: true,
            priority: 1,
            createdAt: Date.now(),
          },
          {
            id: 'loaded-key-2',
            exchange: 'bybit',
            apiKey: 'IyWRZW7tRUtetNn93w',
            apiSecret: 'Az1yOANg2d3r62njagNEkctKStTPMyBCiisv',
            permissions: ['read'],
            isActive: true,
            isPrimary: false,
            priority: 2,
            createdAt: Date.now(),
          },
        ],
      };

      writeFileSync(
        join(testDir, 'accounts.json'),
        JSON.stringify(configContent, null, 2)
      );

      const result = manager.loadFromStore();
      expect(result).toBe(true);

      const activeKey = manager.getActiveKey();
      expect(activeKey?.id).toBe('loaded-key-1');  // 主Key优先

      const availableKeys = manager.getAvailableKeys();
      expect(availableKeys.length).toBe(2);
    });

    it('应该在配置文件不存在时返回false', () => {
      const result = manager.loadFromStore();
      expect(result).toBe(false);
    });

    it('应该跳过格式无效的Key', () => {
      const configContent = {
        version: '1.0',
        accounts: [
          {
            id: 'valid-key',
            exchange: 'bybit',
            apiKey: 'Z3gcRsakDKNPvJ4axr',
            apiSecret: 'WkUM3mOmVPh6R9fvLeAoKxc9GBjllKTIdZHP',
            permissions: ['read'],
            isActive: true,
            isPrimary: true,
            priority: 1,
            createdAt: Date.now(),
          },
          {
            id: 'invalid-key',
            exchange: 'bybit',
            apiKey: 'short',  // 无效
            apiSecret: 'also-short',
            permissions: [],
            isActive: true,
            isPrimary: false,
            priority: 2,
            createdAt: Date.now(),
          },
        ],
      };

      writeFileSync(
        join(testDir, 'accounts.json'),
        JSON.stringify(configContent, null, 2)
      );

      manager.loadFromStore();

      // 只有valid-key应该被加载
      const availableKeys = manager.getAvailableKeys();
      expect(availableKeys.length).toBe(1);
      expect(availableKeys[0].id).toBe('valid-key');
    });

    it('应该能保存配置到文件', () => {
      manager.addKey({
        id: 'save-test-key',
        exchange: 'bybit',
        apiKey: 'Z3gcRsakDKNPvJ4axr',
        apiSecret: 'WkUM3mOmVPh6R9fvLeAoKxc9GBjllKTIdZHP',
        permissions: ['read', 'trade'],
        isActive: true,
        isPrimary: true,
        priority: 1,
        createdAt: Date.now(),
      });

      const result = manager.saveToStore();
      expect(result).toBe(true);

      // 验证文件存在
      expect(existsSync(join(testDir, 'accounts.json'))).toBe(true);
    });
  });

  // ============ 统计功能测试 ============

  describe('统计功能', () => {
    beforeEach(() => {
      manager.addKey({
        id: 'stats-key',
        exchange: 'bybit',
        apiKey: 'Z3gcRsakDKNPvJ4axr',
        apiSecret: 'WkUM3mOmVPh6R9fvLeAoKxc9GBjllKTIdZHP',
        permissions: ['read'],
        isActive: true,
        isPrimary: true,
        priority: 1,
        createdAt: Date.now(),
      });
    });

    it('应该正确计算成功率', () => {
      // 3次成功
      manager.recordSuccess('stats-key');
      manager.recordSuccess('stats-key');
      manager.recordSuccess('stats-key');
      
      // 1次失败
      manager.recordFailure('stats-key');

      const stats = manager.getStats();
      const keyStats = stats.find(s => s.keyId === 'stats-key');
      expect(keyStats?.successRate).toBe(0.75);  // 3/4
    });

    it('应该正确记录使用时间', () => {
      const before = Date.now();
      manager.recordSuccess('stats-key');
      const after = Date.now();

      const stats = manager.getStats();
      const keyStats = stats.find(s => s.keyId === 'stats-key');
      expect(keyStats?.lastUsed).toBeGreaterThanOrEqual(before);
      expect(keyStats?.lastUsed).toBeLessThanOrEqual(after);
    });
  });
});

// ============ 运行测试 ============

console.log('运行 API Key 管理器单元测试...');
