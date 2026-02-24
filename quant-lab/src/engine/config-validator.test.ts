/**
 * 回测←→实盘参数一致性校验 - 测试覆盖
 * 
 * 验收标准：
 * 1. 读取回测配置
 * 2. 读取实盘配置
 * 3. 对比关键参数（gridSpacing/orderSize/maxPosition/magnetDistance等）
 * 4. 发现偏差→告警+报告
 * 5. CI/CD集成（启动前自动校验）
 * 
 * 位置：quant-lab/src/engine/config-validator.test.ts
 */

import { createLogger } from '../utils/logger';
const logger = createLogger('config-validator.test');

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ConfigValidator, validateBeforeStart } from "./config-validator";
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ============ 测试配置 ============

const TEST_DIR = join(homedir(), ".test-quant-lab-validator");
const BACKTEST_CONFIG_PATH = join(TEST_DIR, "backtest-config.json");
const LIVE_CONFIG_PATH = join(TEST_DIR, "live-config.json");
const REPORT_PATH = join(TEST_DIR, "validation-report.md");

// ============ 测试套件 ============

describe("回测←→实盘参数一致性校验 - 验收测试", () => {
  beforeAll(() => {
    // 创建测试目录
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterAll(() => {
    // 清理测试目录
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe("验收1: 读取回测配置和实盘配置", () => {
    test("场景1: 成功读取配置文件", () => {
      // 创建测试配置文件
      const backtestConfig = {
        symbol: "BTCUSDT",
        gridCount: 10,
        gridSpacing: 0.01,
        orderSize: 100,
        maxPosition: 1000,
        magnetDistance: 0.005,
        cancelDistance: 0.02,
        priceOffset: 0.001,
      };

      const liveConfig = {
        symbol: "BTCUSDT",
        gridCount: 10,
        gridSpacing: 0.01,
        orderSize: 100,
        maxPosition: 1000,
        magnetDistance: 0.005,
        cancelDistance: 0.02,
        priceOffset: 0.001,
      };

      writeFileSync(BACKTEST_CONFIG_PATH, JSON.stringify(backtestConfig, null, 2));
      writeFileSync(LIVE_CONFIG_PATH, JSON.stringify(liveConfig, null, 2));

      const validator = new ConfigValidator({ reportPath: REPORT_PATH });
      const result = validator.validate(BACKTEST_CONFIG_PATH, LIVE_CONFIG_PATH);

      // 验证：成功读取
      expect(result.isValid).toBe(true);
      expect(result.diffs.length).toBe(0);
    });
  });

  describe("验收2: 对比关键参数", () => {
    test("场景1: 参数完全一致", () => {
      const config = {
        symbol: "BTCUSDT",
        gridCount: 10,
        gridSpacing: 0.01,
        orderSize: 100,
        maxPosition: 1000,
        magnetDistance: 0.005,
        cancelDistance: 0.02,
        priceOffset: 0.001,
      };

      writeFileSync(BACKTEST_CONFIG_PATH, JSON.stringify(config, null, 2));
      writeFileSync(LIVE_CONFIG_PATH, JSON.stringify(config, null, 2));

      const validator = new ConfigValidator({ reportPath: REPORT_PATH });
      const result = validator.validate(BACKTEST_CONFIG_PATH, LIVE_CONFIG_PATH);

      // 验证：无差异
      expect(result.isValid).toBe(true);
      expect(result.diffs.length).toBe(0);
    });

    test("场景2: 发现参数偏差", () => {
      const backtestConfig = {
        symbol: "BTCUSDT",
        gridCount: 10,
        gridSpacing: 0.01,
        orderSize: 100,
        maxPosition: 1000,
        magnetDistance: 0.005,
        cancelDistance: 0.02,
        priceOffset: 0.001,
      };

      const liveConfig = {
        symbol: "BTCUSDT",
        gridCount: 15, // 不一致
        gridSpacing: 0.01,
        orderSize: 100,
        maxPosition: 1000,
        magnetDistance: 0.005,
        cancelDistance: 0.02,
        priceOffset: 0.001,
      };

      writeFileSync(BACKTEST_CONFIG_PATH, JSON.stringify(backtestConfig, null, 2));
      writeFileSync(LIVE_CONFIG_PATH, JSON.stringify(liveConfig, null, 2));

      const validator = new ConfigValidator({ reportPath: REPORT_PATH });
      const result = validator.validate(BACKTEST_CONFIG_PATH, LIVE_CONFIG_PATH);

      // 验证：发现差异
      expect(result.isValid).toBe(false);
      expect(result.diffs.length).toBeGreaterThan(0);
      expect(result.diffs.some((d) => d.key === "gridCount")).toBe(true);
    });

    test("场景3: 数值在误差范围内", () => {
      const backtestConfig = {
        symbol: "BTCUSDT",
        gridCount: 10,
        gridSpacing: 0.01,
        orderSize: 100,
        maxPosition: 1000,
        magnetDistance: 0.005,
        cancelDistance: 0.02,
        priceOffset: 0.001,
      };

      const liveConfig = {
        symbol: "BTCUSDT",
        gridCount: 10,
        gridSpacing: 0.0100001, // 在误差范围内
        orderSize: 100,
        maxPosition: 1000,
        magnetDistance: 0.005,
        cancelDistance: 0.02,
        priceOffset: 0.001,
      };

      writeFileSync(BACKTEST_CONFIG_PATH, JSON.stringify(backtestConfig, null, 2));
      writeFileSync(LIVE_CONFIG_PATH, JSON.stringify(liveConfig, null, 2));

      const validator = new ConfigValidator({ reportPath: REPORT_PATH });
      const result = validator.validate(BACKTEST_CONFIG_PATH, LIVE_CONFIG_PATH);

      // 验证：误差范围内，通过
      expect(result.isValid).toBe(true);
    });
  });

  describe("验收3: 发现偏差→告警+报告", () => {
    test("场景1: 生成报告", () => {
      const backtestConfig = {
        symbol: "BTCUSDT",
        gridCount: 10,
        gridSpacing: 0.01,
        orderSize: 100,
        maxPosition: 1000,
        magnetDistance: 0.005,
        cancelDistance: 0.02,
        priceOffset: 0.001,
      };

      const liveConfig = {
        symbol: "BTCUSDT",
        gridCount: 20, // 差异
        gridSpacing: 0.02, // 差异
        orderSize: 200, // 差异
        maxPosition: 1000,
        magnetDistance: 0.005,
        cancelDistance: 0.02,
        priceOffset: 0.001,
      };

      writeFileSync(BACKTEST_CONFIG_PATH, JSON.stringify(backtestConfig, null, 2));
      writeFileSync(LIVE_CONFIG_PATH, JSON.stringify(liveConfig, null, 2));

      const validator = new ConfigValidator({ reportPath: REPORT_PATH });
      const result = validator.validate(BACKTEST_CONFIG_PATH, LIVE_CONFIG_PATH);

      // 验证：报告已生成
      expect(existsSync(REPORT_PATH)).toBe(true);

      const report = readFileSync(REPORT_PATH, "utf-8");
      expect(report).toContain("配置一致性校验报告");
      expect(report).toContain("gridCount");
      expect(report).toContain("gridSpacing");
      expect(report).toContain("orderSize");
    });

    test("场景2: 告警事件触发", () => {
      const backtestConfig = {
        symbol: "BTCUSDT",
        gridCount: 10,
        gridSpacing: 0.01,
        orderSize: 100,
        maxPosition: 1000,
        magnetDistance: 0.005,
        cancelDistance: 0.02,
        priceOffset: 0.001,
      };

      const liveConfig = {
        symbol: "BTCUSDT",
        gridCount: 15,
        gridSpacing: 0.01,
        orderSize: 100,
        maxPosition: 1000,
        magnetDistance: 0.005,
        cancelDistance: 0.02,
        priceOffset: 0.001,
      };

      writeFileSync(BACKTEST_CONFIG_PATH, JSON.stringify(backtestConfig, null, 2));
      writeFileSync(LIVE_CONFIG_PATH, JSON.stringify(liveConfig, null, 2));

      let diffFound = false;
      const validator = new ConfigValidator({ reportPath: REPORT_PATH });
      validator.setEvents({
        onDiffFound: (diff) => {
          diffFound = true;
          logger.info(`差异发现: ${diff.key}`);
        },
      });

      const result = validator.validate(BACKTEST_CONFIG_PATH, LIVE_CONFIG_PATH);

      // 验证：差异事件触发
      expect(diffFound).toBe(true);
    });
  });

  describe("验收4: CI/CD集成（启动前自动校验）", () => {
    test("场景1: 校验通过时允许启动", async () => {
      const config = {
        symbol: "BTCUSDT",
        gridCount: 10,
        gridSpacing: 0.01,
        orderSize: 100,
        maxPosition: 1000,
        magnetDistance: 0.005,
        cancelDistance: 0.02,
        priceOffset: 0.001,
      };

      writeFileSync(BACKTEST_CONFIG_PATH, JSON.stringify(config, null, 2));
      writeFileSync(LIVE_CONFIG_PATH, JSON.stringify(config, null, 2));

      // 验证：校验通过
      const isValid = await validateBeforeStart(
        BACKTEST_CONFIG_PATH,
        LIVE_CONFIG_PATH,
        { reportPath: REPORT_PATH }
      );

      expect(isValid).toBe(true);
    });
  });

  describe("综合验收测试", () => {
    test("完整流程: 读取→对比→告警→报告", async () => {
      const backtestConfig = {
        symbol: "BTCUSDT",
        gridCount: 10,
        gridSpacing: 0.01,
        orderSize: 100,
        maxPosition: 1000,
        magnetDistance: 0.005,
        cancelDistance: 0.02,
        priceOffset: 0.001,
      };

      const liveConfig = {
        symbol: "BTCUSDT",
        gridCount: 12, // 差异
        gridSpacing: 0.015, // 差异
        orderSize: 150, // 差异
        maxPosition: 1000,
        magnetDistance: 0.005,
        cancelDistance: 0.02,
        priceOffset: 0.001,
      };

      writeFileSync(BACKTEST_CONFIG_PATH, JSON.stringify(backtestConfig, null, 2));
      writeFileSync(LIVE_CONFIG_PATH, JSON.stringify(liveConfig, null, 2));

      logger.info("1. 创建配置文件");
      logger.info("2. 执行校验");

      const validator = new ConfigValidator({ reportPath: REPORT_PATH });
      const result = validator.validate(BACKTEST_CONFIG_PATH, LIVE_CONFIG_PATH);

      logger.info(`3. 校验完成: ${result.isValid ? "通过" : "失败"}`);
      logger.info(`4. 差异项: ${result.diffs.length} 个`);

      // 验证：差异发现
      expect(result.isValid).toBe(false);
      expect(result.diffs.length).toBe(3); // gridCount, gridSpacing, orderSize

      // 验证：报告生成
      expect(existsSync(REPORT_PATH)).toBe(true);
      logger.info("5. 报告已生成");
    });
  });
});

// ============ 回滚说明 ============

/**
 * 配置一致性校验 - 回滚说明
 * 
 * ## 功能说明
 * 
 * 1. **读取配置** - 读取回测和实盘配置文件
 * 2. **对比参数** - 对比关键参数（gridSpacing/orderSize/maxPosition等）
 * 3. **发现偏差** - 发现偏差时生成告警和报告
 * 4. **CI/CD集成** - 启动前自动校验，失败时禁止启动
 * 
 * ## 回滚方法
 * 
 * ### 方法1: Git回滚
 * ```bash
 * git revert <commit-hash>
 * ```
 * 
 * ### 方法2: 手动删除
 * ```bash
 * rm quant-lab/src/engine/config-validator.ts
 * rm quant-lab/src/engine/config-validator.test.ts
 * ```
 * 
 * ### 方法3: 禁用校验
 * 在CI/CD配置中移除校验步骤：
 * ```yaml
 * # 移除这一行
 * - bun run validate-config
 * ```
 * 
 * ## 回滚影响
 * 
 * - **回滚后风险**: 回测和实盘参数可能不一致，导致策略表现与预期不符
 * - **建议**: 不建议回滚，除非发现校验逻辑有bug
 * 
 * ## CI/CD集成
 * 
 * 在package.json中添加：
 * ```json
 * {
 *   "scripts": {
 *     "validate-config": "bun run src/engine/validate-config.ts"
 *   }
 * }
 * ```
 * 
 * 在CI/CD流程中添加：
 * ```yaml
 * - name: Validate config consistency
 *   run: bun run validate-config
 * ```
 */
