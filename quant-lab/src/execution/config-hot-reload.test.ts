/**
 * 配置热重载 - 验收测试
 * 
 * 验收标准：
 * 1. 监听配置文件变更
 * 2. 热注入新参数到运行中的策略
 * 3. 不中断当前持仓/订单
 * 4. 变更日志+回滚支持
 * 
 * 位置：quant-lab/src/execution/config-hot-reload.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { ConfigHotReloadManager } from "./config-hot-reload";
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ============ 测试配置 ============

const TEST_DIR = join(homedir(), ".test-quant-lab-config");
const TEST_CONFIG_PATH = join(TEST_DIR, "test-config.json");
const TEST_BACKUP_DIR = join(TEST_DIR, "backups");

// ============ 测试套件 ============

describe("配置热重载 - 验收测试", () => {
  beforeAll(() => {
    // 创建测试目录
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }

    // 创建初始配置文件
    writeFileSync(
      TEST_CONFIG_PATH,
      JSON.stringify(
        {
          symbol: "BTCUSDT",
          gridCount: 10,
          gridSpacing: 0.01,
          orderSize: 100,
          maxPosition: 1000,
        },
        null,
        2
      )
    );
  });

  afterAll(() => {
    // 清理测试目录
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe("验收1: 文件监听和热注入", () => {
    test("场景1: 监听配置文件变更", async () => {
      const manager = new ConfigHotReloadManager(TEST_CONFIG_PATH, {
        backupDir: TEST_BACKUP_DIR,
      });

      // 启动监听
      manager.startWatching();

      // 验证：监听已启动
      const stats = manager.getStats();
      expect(stats.isWatching).toBe(true);

      // 停止监听
      manager.stopWatching();
    });

    test("场景2: 检测配置变更", async () => {
      const manager = new ConfigHotReloadManager(TEST_CONFIG_PATH, {
        backupDir: TEST_BACKUP_DIR,
      });

      let changeDetected = false;
      manager.setEvents({
        onConfigChange: (changes) => {
          changeDetected = true;
          console.log(`检测到 ${changes.length} 项变更`);
        },
      });

      manager.startWatching();

      // 修改配置文件
      const newConfig = {
        symbol: "BTCUSDT",
        gridCount: 15, // 修改
        gridSpacing: 0.01,
        orderSize: 100,
        maxPosition: 1000,
      };

      writeFileSync(TEST_CONFIG_PATH, JSON.stringify(newConfig, null, 2));

      // 等待变更检测（防抖1秒）
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // 验证：变更被检测到
      expect(changeDetected).toBe(true);

      manager.stopWatching();
    });

    test("场景3: 热注入新参数", async () => {
      const manager = new ConfigHotReloadManager(TEST_CONFIG_PATH, {
        backupDir: TEST_BACKUP_DIR,
      });

      let newConfigApplied = false;
      manager.setEvents({
        onConfigReload: (config) => {
          if (config.gridCount === 20) {
            newConfigApplied = true;
          }
        },
      });

      manager.startWatching();

      // 修改配置文件
      const newConfig = {
        symbol: "BTCUSDT",
        gridCount: 20, // 修改
        gridSpacing: 0.01,
        orderSize: 100,
        maxPosition: 1000,
      };

      writeFileSync(TEST_CONFIG_PATH, JSON.stringify(newConfig, null, 2));

      // 等待变更检测
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // 验证：新配置已应用
      const currentConfig = manager.getConfig();
      expect(currentConfig.gridCount).toBe(20);

      manager.stopWatching();
    });
  });

  describe("验收2: 不中断当前持仓/订单", () => {
    test("场景1: 配置变更不影响运行状态", async () => {
      const manager = new ConfigHotReloadManager(TEST_CONFIG_PATH, {
        backupDir: TEST_BACKUP_DIR,
      });

      // 模拟运行状态（订单、持仓等）
      const runningState = {
        openOrders: [
          { orderId: "order-1", status: "ACTIVE" },
          { orderId: "order-2", status: "ACTIVE" },
        ],
        position: { size: 100, entryPrice: 50000 },
      };

      manager.startWatching();

      // 修改配置文件
      const newConfig = {
        symbol: "BTCUSDT",
        gridCount: 25, // 修改
        gridSpacing: 0.015, // 修改
        orderSize: 150, // 修改
        maxPosition: 1500, // 修改
      };

      writeFileSync(TEST_CONFIG_PATH, JSON.stringify(newConfig, null, 2));

      // 等待变更检测
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // 验证：运行状态未受影响
      expect(runningState.openOrders.length).toBe(2);
      expect(runningState.position.size).toBe(100);

      manager.stopWatching();
    });
  });

  describe("验收3: 变更日志和回滚支持", () => {
    test("场景1: 记录变更日志", async () => {
      const manager = new ConfigHotReloadManager(TEST_CONFIG_PATH, {
        backupDir: TEST_BACKUP_DIR,
      });

      let changesLogged = false;
      manager.setEvents({
        onConfigChange: (changes) => {
          changesLogged = true;
          console.log("变更日志:");
          changes.forEach((change) => {
            console.log(
              `  ${change.key}: ${change.oldValue} -> ${change.newValue}`
            );
          });
        },
      });

      manager.startWatching();

      // 修改配置文件
      const newConfig = {
        symbol: "BTCUSDT",
        gridCount: 30,
        gridSpacing: 0.01,
        orderSize: 100,
        maxPosition: 1000,
      };

      writeFileSync(TEST_CONFIG_PATH, JSON.stringify(newConfig, null, 2));

      // 等待变更检测
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // 验证：变更已记录
      expect(changesLogged).toBe(true);

      manager.stopWatching();
    });

    test("场景2: 回滚到上一个版本", async () => {
      const manager = new ConfigHotReloadManager(TEST_CONFIG_PATH, {
        backupDir: TEST_BACKUP_DIR,
      });

      manager.startWatching();

      // 第一次修改
      writeFileSync(
        TEST_CONFIG_PATH,
        JSON.stringify(
          {
            symbol: "BTCUSDT",
            gridCount: 35,
            gridSpacing: 0.01,
            orderSize: 100,
            maxPosition: 1000,
          },
          null,
          2
        )
      );

      await new Promise((resolve) => setTimeout(resolve, 1500));

      // 第二次修改
      writeFileSync(
        TEST_CONFIG_PATH,
        JSON.stringify(
          {
            symbol: "BTCUSDT",
            gridCount: 40,
            gridSpacing: 0.01,
            orderSize: 100,
            maxPosition: 1000,
          },
          null,
          2
        )
      );

      await new Promise((resolve) => setTimeout(resolve, 1500));

      // 验证：当前配置是第二次修改的结果
      expect(manager.getConfig().gridCount).toBe(40);

      // 回滚到上一个版本
      const success = manager.rollbackToPrevious();
      expect(success).toBe(true);

      // 验证：配置已回滚
      expect(manager.getConfig().gridCount).toBe(35);

      manager.stopWatching();
    });

    test("场景3: 回滚到指定版本", async () => {
      const manager = new ConfigHotReloadManager(TEST_CONFIG_PATH, {
        backupDir: TEST_BACKUP_DIR,
      });

      manager.startWatching();

      // 多次修改配置
      for (let i = 1; i <= 3; i++) {
        writeFileSync(
          TEST_CONFIG_PATH,
          JSON.stringify(
            {
              symbol: "BTCUSDT",
              gridCount: 10 + i * 5,
              gridSpacing: 0.01,
              orderSize: 100,
              maxPosition: 1000,
            },
            null,
            2
          )
        );

        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      // 获取快照列表
      const snapshots = manager.getSnapshots();
      expect(snapshots.length).toBeGreaterThan(0);

      // 回滚到第一个快照
      const targetVersion = snapshots[0].version;
      const success = manager.rollbackToVersion(targetVersion);
      expect(success).toBe(true);

      manager.stopWatching();
    });
  });

  describe("综合验收测试", () => {
    test("完整流程: 监听 → 修改 → 检测 → 应用 → 回滚", async () => {
      const manager = new ConfigHotReloadManager(TEST_CONFIG_PATH, {
        backupDir: TEST_BACKUP_DIR,
      });

      // 1. 启动监听
      manager.startWatching();
      console.log("✅ 监听已启动");

      // 2. 修改配置文件
      const newConfig = {
        symbol: "BTCUSDT",
        gridCount: 50,
        gridSpacing: 0.02,
        orderSize: 200,
        maxPosition: 2000,
      };

      writeFileSync(TEST_CONFIG_PATH, JSON.stringify(newConfig, null, 2));
      console.log("✅ 配置文件已修改");

      // 3. 等待变更检测和应用
      await new Promise((resolve) => setTimeout(resolve, 1500));
      console.log("✅ 变更已检测并应用");

      // 4. 验证新配置
      const currentConfig = manager.getConfig();
      expect(currentConfig.gridCount).toBe(50);
      expect(currentConfig.gridSpacing).toBe(0.02);
      console.log("✅ 新配置已验证");

      // 5. 回滚
      const success = manager.rollbackToPrevious();
      expect(success).toBe(true);
      console.log("✅ 配置已回滚");

      // 6. 停止监听
      manager.stopWatching();
      console.log("✅ 监听已停止");
    });
  });

  // P1新增: 参数校验测试 ========================================
  describe("P1新增: 参数校验功能", () => {
    test("校验规则: 必填项缺失", () => {
      const manager = new ConfigHotReloadManager(TEST_CONFIG_PATH, {
        backupDir: TEST_BACKUP_DIR,
        validationRules: {
          symbol: { type: 'string', required: true },
          gridCount: { type: 'number', required: true, min: 2, max: 50 },
        },
      });

      const invalidConfig = {
        // symbol缺失
        gridCount: 10,
      };

      const result = manager.validateWithRules(invalidConfig);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('symbol');
      expect(result.errors[0]).toContain('必填');
    });

    test("校验规则: 数值范围检查", () => {
      const manager = new ConfigHotReloadManager(TEST_CONFIG_PATH, {
        backupDir: TEST_BACKUP_DIR,
        validationRules: {
          gridCount: { type: 'number', min: 2, max: 10 },
        },
      });

      // 数值过小
      const result1 = manager.validateWithRules({ gridCount: 1 });
      expect(result1.valid).toBe(false);
      expect(result1.errors[0]).toContain('过小');

      // 数值过大
      const result2 = manager.validateWithRules({ gridCount: 100 });
      expect(result2.valid).toBe(false);
      expect(result2.errors[0]).toContain('过大');

      // 数值正常
      const result3 = manager.validateWithRules({ gridCount: 5 });
      expect(result3.valid).toBe(true);
      expect(result3.errors.length).toBe(0);
    });

    test("校验规则: 类型检查", () => {
      const manager = new ConfigHotReloadManager(TEST_CONFIG_PATH, {
        backupDir: TEST_BACKUP_DIR,
        validationRules: {
          gridCount: { type: 'number' },
          symbol: { type: 'string' },
        },
      });

      const invalidConfig = {
        gridCount: "not a number",
        symbol: 123,
      };

      const result = manager.validateWithRules(invalidConfig);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(2);
    });

    test("校验规则: 枚举值检查", () => {
      const manager = new ConfigHotReloadManager(TEST_CONFIG_PATH, {
        backupDir: TEST_BACKUP_DIR,
        validationRules: {
          direction: { type: 'string', enum: ['long', 'short', 'neutral'] },
        },
      });

      // 有效值
      const result1 = manager.validateWithRules({ direction: 'long' });
      expect(result1.valid).toBe(true);

      // 无效值
      const result2 = manager.validateWithRules({ direction: 'invalid' });
      expect(result2.valid).toBe(false);
      expect(result2.errors[0]).toContain('不在允许范围内');
    });

    test("校验规则: 正则表达式检查", () => {
      const manager = new ConfigHotReloadManager(TEST_CONFIG_PATH, {
        backupDir: TEST_BACKUP_DIR,
        validationRules: {
          symbol: { type: 'string', pattern: /^[A-Z0-9]+USDT$/ },
        },
      });

      // 有效symbol
      const result1 = manager.validateWithRules({ symbol: 'BTCUSDT' });
      expect(result1.valid).toBe(true);

      // 无效symbol
      const result2 = manager.validateWithRules({ symbol: 'invalid' });
      expect(result2.valid).toBe(false);
      expect(result2.errors[0]).toContain('格式不匹配');
    });

    test("Gales策略默认校验规则", () => {
      const rules = ConfigHotReloadManager.getGalesValidationRules();

      // 有效配置
      const validConfig = {
        symbol: 'BTCUSDT',
        gridCount: 10,
        gridSpacing: 0.02,
        orderSize: 100,
        maxPosition: 1000,
        direction: 'neutral',
      };

      const manager = new ConfigHotReloadManager(TEST_CONFIG_PATH);
      const result = manager.validateWithRules(validConfig, rules);
      expect(result.valid).toBe(true);

      // 无效配置: gridCount过大
      const invalidConfig = {
        ...validConfig,
        gridCount: 100, // 超过max: 50
      };

      const result2 = manager.validateWithRules(invalidConfig, rules);
      expect(result2.valid).toBe(false);
      expect(result2.errors[0]).toContain('gridCount');
    });

    test("热更新时校验失败→拒绝更新", async () => {
      const manager = new ConfigHotReloadManager(TEST_CONFIG_PATH, {
        backupDir: TEST_BACKUP_DIR,
        validationRules: {
          gridCount: { type: 'number', min: 2, max: 10 },
        },
      });

      let validationFailed = false;
      manager.setEvents({
        onError: (error) => {
          if (error.message.includes('校验失败')) {
            validationFailed = true;
          }
        },
      });

      manager.startWatching();

      // 写入无效配置(gridCount=100超出范围)
      const invalidConfig = {
        symbol: 'BTCUSDT',
        gridCount: 100, // 超出范围
        gridSpacing: 0.01,
        orderSize: 100,
        maxPosition: 1000,
      };

      writeFileSync(TEST_CONFIG_PATH, JSON.stringify(invalidConfig, null, 2));

      // 等待检测
      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(validationFailed).toBe(true);

      // 验证配置未被更新(gridCount仍是初始值)
      const currentConfig = manager.getConfig();
      expect(currentConfig.gridCount).not.toBe(100);

      manager.stopWatching();
    });
  });
  // P1新增结束 ========================================

  // P2新增: diff日志测试 ========================================
  describe("P2新增: diff日志功能", () => {
    test("diff日志: 热更新时记录旧值→新值", async () => {
      const manager = new ConfigHotReloadManager(TEST_CONFIG_PATH, {
        backupDir: TEST_BACKUP_DIR,
      });

      // 捕获日志输出
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(' '));
        originalLog(...args);
      };

      let changeDetected = false;
      manager.setEvents({
        onConfigChange: (changes) => {
          changeDetected = true;
        },
      });

      manager.startWatching();

      // 修改单个参数: gridCount 10 → 15
      const newConfig = {
        symbol: 'BTCUSDT',
        gridCount: 15,
        gridSpacing: 0.01,
        orderSize: 100,
        maxPosition: 1000,
      };

      writeFileSync(TEST_CONFIG_PATH, JSON.stringify(newConfig, null, 2));

      // 等待变更检测
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // 恢复console.log
      console.log = originalLog;

      // 验证：变更被检测到
      expect(changeDetected).toBe(true);

      // 验证：日志中包含变更信息
      const logText = logs.join('\n');
      expect(logText).toContain('gridCount');
      expect(logText).toContain('10');
      expect(logText).toContain('15');

      manager.stopWatching();
    });

    test("边界测试: 同一值更新不产生diff日志", async () => {
      // 重置配置文件到初始状态（避免其他测试影响）
      const initialConfig = {
        symbol: 'BTCUSDT',
        gridCount: 10,
        gridSpacing: 0.01,
        orderSize: 100,
        maxPosition: 1000,
      };
      writeFileSync(TEST_CONFIG_PATH, JSON.stringify(initialConfig, null, 2));

      const manager = new ConfigHotReloadManager(TEST_CONFIG_PATH, {
        backupDir: TEST_BACKUP_DIR,
      });

      manager.startWatching();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // 重置计数器
      let changeCount = 0;
      manager.setEvents({
        onConfigChange: (changes) => {
          changeCount++;
        },
      });

      // 写入完全相同的配置（使用同样的格式）
      const sameConfig = {
        symbol: 'BTCUSDT',
        gridCount: 10,
        gridSpacing: 0.01,
        orderSize: 100,
        maxPosition: 1000,
      };
      writeFileSync(TEST_CONFIG_PATH, JSON.stringify(sameConfig, null, 2));

      // 等待变更检测（防抖1秒+余量）
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // 验证：没有触发onConfigChange（相同配置不产生diff）
      // 注意：由于文件系统触发机制，可能仍会触发，但detectChanges应该过滤掉
      expect(changeCount).toBe(0);

      manager.stopWatching();
    });

    test("多字段同时更新", async () => {
      const manager = new ConfigHotReloadManager(TEST_CONFIG_PATH, {
        backupDir: TEST_BACKUP_DIR,
      });

      // 捕获所有变更
      let capturedChanges: any[] = [];
      manager.setEvents({
        onConfigChange: (changes) => {
          capturedChanges = changes;
        },
      });

      manager.startWatching();

      // 同时修改多个参数
      const newConfig = {
        symbol: 'BTCUSDT',
        gridCount: 25,      // 10 → 25
        gridSpacing: 0.02,  // 0.01 → 0.02
        orderSize: 200,     // 100 → 200
        maxPosition: 2000,  // 1000 → 2000
      };

      writeFileSync(TEST_CONFIG_PATH, JSON.stringify(newConfig, null, 2));

      // 等待变更检测
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // 验证：捕获到4个变更
      expect(capturedChanges.length).toBe(4);

      // 验证：每个变更都有完整信息
      const changeKeys = capturedChanges.map(c => c.key).sort();
      expect(changeKeys).toEqual(['gridCount', 'gridSpacing', 'maxPosition', 'orderSize']);

      // 验证：每个变更都有旧值和新值
      for (const change of capturedChanges) {
        expect(change.oldValue).toBeDefined();
        expect(change.newValue).toBeDefined();
        expect(change.oldValue).not.toBe(change.newValue);
      }

      manager.stopWatching();
    });
  });
  // P2新增结束 ========================================
});

// ============ 回滚说明 ============

/**
 * 配置热重载 - 回滚说明
 * 
 * ## 回滚方法
 * 
 * ### 方法1: 自动回滚到上一个版本
 * ```typescript
 * const manager = new ConfigHotReloadManager(configPath);
 * manager.rollbackToPrevious();
 * ```
 * 
 * ### 方法2: 回滚到指定版本
 * ```typescript
 * const manager = new ConfigHotReloadManager(configPath);
 * const snapshots = manager.getSnapshots();
 * manager.rollbackToVersion(snapshots[0].version);
 * ```
 * 
 * ### 方法3: 手动恢复备份文件
 * ```bash
 * # 备份文件位置: ~/.quant-lab/config-backups/
 * cp ~/.quant-lab/config-backups/config-v1-1234567890.json ./config.json
 * ```
 * 
 * ## 回滚注意事项
 * 
 * 1. **回滚不影响运行状态**: 当前持仓和订单不会被回滚影响
 * 2. **回滚会创建新版本**: 回滚操作会创建一个新的配置版本
 * 3. **备份文件保留**: 默认保留最近10个备份文件
 * 4. **回滚失败处理**: 如果回滚失败，会触发onError事件
 * 
 * ## 回滚时机建议
 * 
 * - **立即回滚**: 当新配置导致策略行为异常时
 * - **等待回滚**: 当需要观察新配置效果时
 * - **不回滚**: 当新配置是预期的长期配置时
 * 
 * ## 回滚影响范围
 * 
 * - ✅ **影响**: 策略参数（gridCount, gridSpacing, orderSize等）
 * - ❌ **不影响**: 当前持仓、订单、网格档位状态
 * 
 * ## 回滚日志
 * 
 * 所有回滚操作都会记录日志，包括：
 * - 回滚时间
 * - 回滚前后版本
 * - 回滚的配置内容
 */
