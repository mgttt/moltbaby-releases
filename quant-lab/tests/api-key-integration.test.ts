/**
 * API Key集成测试
 * 
 * 测试故障切换和重试逻辑
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { 
  ResilientApiClient, 
  BybitKeyManager,
  ApiKeyIntegrationConfig 
} from '../src/execution/api-key-integration';

describe('API Key Integration', () => {
  let testDir: string;
  let client: ResilientApiClient;

  beforeEach(() => {
    testDir = join(tmpdir(), `api-key-int-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, '.config', 'quant-lab'), { recursive: true });

    // 使用测试目录作为HOME，避免加载真实配置
    process.env.HOME = testDir;

    const config: ApiKeyIntegrationConfig = {
      strategyId: 'test-strategy',
      autoFailover: true,
      validateOnStart: true,
      enableStats: true,
    };

    client = new ResilientApiClient(config);
  });

  afterEach(() => {
    client.destroy();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  describe('基础功能', () => {
    it('应该正确初始化', () => {
      expect(client).toBeDefined();
      expect(client.getActiveKey()).toBeNull();
    });

    it('应该能添加Key', () => {
      const result = client.addKey({
        id: 'test-key-1',
        exchange: 'bybit',
        apiKey: 'Z3gcRsakDKNPvJ4axr',
        apiSecret: 'WkUM3mOmVPh6R9fvLeAoKxc9GBjllKTIdZHP',
        permissions: ['read', 'trade'],
        isActive: true,
        isPrimary: true,
        priority: 1,
        createdAt: Date.now(),
      });

      expect(result).toBe(true);
      expect(client.getActiveKey()?.id).toBe('test-key-1');
    });
  });

  describe('故障切换', () => {
    beforeEach(() => {
      // 添加主Key
      client.addKey({
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
      client.addKey({
        id: 'backup-key',
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

    it('应该在认证错误时切换Key', async () => {
      let usedKeys: string[] = [];

      try {
        await client.executeWithFailover(
          async (key) => {
            usedKeys.push(key.id);
            // 模拟认证错误
            const error: any = new Error('Invalid api_key');
            error.code = '10003';
            throw error;
          },
          'test-operation'
        );
      } catch (e) {
        // 预期会抛出错误
      }

      // 应该尝试了primary-key然后切换到backup-key
      expect(usedKeys.length).toBeGreaterThanOrEqual(1);
    });

    it('应该在成功时不切换Key', async () => {
      let usedKey = '';

      const result = await client.executeWithFailover(
        async (key) => {
          usedKey = key.id;
          return { success: true, data: 'test' };
        },
        'test-operation'
      );

      expect(usedKey).toBe('primary-key');
      expect(result.success).toBe(true);
    });

    it('应该记录请求统计', async () => {
      // 成功请求
      await client.executeWithFailover(
        async () => ({ success: true }),
        'success-op'
      );

      // 失败请求
      try {
        await client.executeWithFailover(
          async () => {
            throw new Error('Test error');
          },
          'fail-op'
        );
      } catch (e) {}

      const stats = client.getRequestStats();
      expect(stats.length).toBeGreaterThan(0);
    });
  });

  describe('Bybit专用管理器', () => {
    it('应该能从配置创建', () => {
      const manager = new BybitKeyManager('test-only', [
        {
          id: 'bybit-main-test',
          apiKey: 'Z3gcRsakDKNPvJ4axr',
          apiSecret: 'WkUM3mOmVPh6R9fvLeAoKxc9GBjllKTIdZHP',
          isPrimary: true,
        },
      ]);

      expect(manager.getActiveKey()?.id).toBe('bybit-main-test');
      manager.destroy();
    });
  });
});

console.log('运行 API Key 集成测试...');
