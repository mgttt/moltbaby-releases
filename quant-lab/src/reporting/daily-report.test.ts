/**
 * 策略日报生成器 - 测试覆盖
 * 
 * 验收标准：
 * 1. 采集每日数据（下单数/成交数/盈亏/错误计数）
 * 2. 生成结构化日报（JSON+可读文本）
 * 3. 触发方式：每日定时或手动调用
 * 4. 输出：日报文件+可选告警推送
 * 
 * 位置：quant-lab/src/reporting/daily-report.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { DailyReportGenerator, scheduleDailyReport } from "./daily-report";
import { existsSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ============ 测试配置 ============

const TEST_DIR = join(homedir(), ".test-quant-lab-reporting");
const OUTPUT_DIR = join(TEST_DIR, "reports");

// ============ 测试套件 ============

describe("策略日报生成器 - 验收测试", () => {
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

  describe("验收1: 采集每日数据", () => {
    test("场景1: 记录订单事件", () => {
      const generator = new DailyReportGenerator({ outputDir: OUTPUT_DIR });

      // 记录订单事件
      generator.recordOrderEvent("2026-02-21", "GalesStrategy", "BTCUSDT", {
        type: "ORDER_CREATED",
        side: "BUY",
        volume: 0.1,
        price: 50000,
      });

      generator.recordOrderEvent("2026-02-21", "GalesStrategy", "BTCUSDT", {
        type: "ORDER_FILLED",
        side: "BUY",
        volume: 0.1,
        price: 50000,
        commission: 0.5,
      });

      // 获取数据
      const data = generator.getReportData("2026-02-21", "GalesStrategy", "BTCUSDT");

      // 验证：订单统计正确
      expect(data).toBeDefined();
      expect(data?.totalOrders).toBe(2);
      expect(data?.filledOrders).toBe(1);
      expect(data?.totalVolume).toBe(5000); // 0.1 * 50000
    });

    test("场景2: 记录错误事件", () => {
      const generator = new DailyReportGenerator({ outputDir: OUTPUT_DIR });

      // 记录错误事件
      generator.recordErrorEvent("2026-02-21", "GalesStrategy", "BTCUSDT", {
        type: "NETWORK_ERROR",
        message: "连接超时",
      });

      // 获取数据
      const data = generator.getReportData("2026-02-21", "GalesStrategy", "BTCUSDT");

      // 验证：错误统计正确
      expect(data).toBeDefined();
      expect(data?.errorCount).toBe(1);
      expect(data?.errors.length).toBe(1);
      expect(data?.errors[0].type).toBe("NETWORK_ERROR");
    });

    test("场景3: 更新盈亏数据", () => {
      const generator = new DailyReportGenerator({ outputDir: OUTPUT_DIR });

      // 更新盈亏数据
      generator.updatePnlData("2026-02-21", "GalesStrategy", "BTCUSDT", {
        realizedPnl: 100,
        unrealizedPnl: 50,
      });

      // 获取数据
      const data = generator.getReportData("2026-02-21", "GalesStrategy", "BTCUSDT");

      // 验证：盈亏数据正确
      expect(data).toBeDefined();
      expect(data?.realizedPnl).toBe(100);
      expect(data?.unrealizedPnl).toBe(50);
      expect(data?.totalPnl).toBe(150);
    });
  });

  describe("验收2: 生成结构化日报", () => {
    test("场景1: 生成JSON格式日报", () => {
      const generator = new DailyReportGenerator({
        outputDir: OUTPUT_DIR,
        generateJson: true,
        generateText: false,
      });

      // 添加数据
      generator.recordOrderEvent("2026-02-21", "GalesStrategy", "BTCUSDT", {
        type: "ORDER_FILLED",
        side: "BUY",
        volume: 0.1,
        price: 50000,
      });

      // 生成报告
      const report = generator.generateReport("2026-02-21", "GalesStrategy", "BTCUSDT");

      // 验证：报告已生成
      expect(report).toBeDefined();
      expect(report?.date).toBe("2026-02-21");
      expect(report?.strategy).toBe("GalesStrategy");
      expect(report?.symbol).toBe("BTCUSDT");

      // 验证：JSON文件已创建
      const jsonPath = join(OUTPUT_DIR, "daily-report-2026-02-21-GalesStrategy-BTCUSDT.json");
      expect(existsSync(jsonPath)).toBe(true);

      // 验证：JSON内容正确
      const jsonContent = JSON.parse(readFileSync(jsonPath, "utf-8"));
      expect(jsonContent.totalOrders).toBe(1);
      expect(jsonContent.filledOrders).toBe(1);
    });

    test("场景2: 生成文本格式日报", () => {
      const generator = new DailyReportGenerator({
        outputDir: OUTPUT_DIR,
        generateJson: false,
        generateText: true,
      });

      // 添加数据
      generator.recordOrderEvent("2026-02-21", "GalesStrategy", "BTCUSDT", {
        type: "ORDER_FILLED",
        side: "BUY",
        volume: 0.1,
        price: 50000,
      });

      // 生成报告
      const report = generator.generateReport("2026-02-21", "GalesStrategy", "BTCUSDT");

      // 验证：报告已生成
      expect(report).toBeDefined();

      // 验证：文本文件已创建
      const txtPath = join(OUTPUT_DIR, "daily-report-2026-02-21-GalesStrategy-BTCUSDT.txt");
      expect(existsSync(txtPath)).toBe(true);

      // 验证：文本内容正确
      const txtContent = readFileSync(txtPath, "utf-8");
      expect(txtContent).toContain("策略日报");
      expect(txtContent).toContain("2026-02-21");
      expect(txtContent).toContain("GalesStrategy");
      expect(txtContent).toContain("BTCUSDT");
    });
  });

  describe("验收3: 触发方式", () => {
    test("场景1: 手动调用生成日报", () => {
      const generator = new DailyReportGenerator({ outputDir: OUTPUT_DIR });

      // 添加数据
      generator.recordOrderEvent("2026-02-21", "GalesStrategy", "BTCUSDT", {
        type: "ORDER_FILLED",
        side: "BUY",
        volume: 0.1,
        price: 50000,
      });

      // 手动生成报告
      const report = generator.generateReport("2026-02-21", "GalesStrategy", "BTCUSDT");

      // 验证：报告已生成
      expect(report).toBeDefined();
    });

    test("场景2: 生成所有日报", () => {
      const generator = new DailyReportGenerator({ outputDir: OUTPUT_DIR });

      // 添加多个策略的数据
      generator.recordOrderEvent("2026-02-21", "GalesStrategy", "BTCUSDT", {
        type: "ORDER_FILLED",
        side: "BUY",
        volume: 0.1,
        price: 50000,
      });

      generator.recordOrderEvent("2026-02-21", "GridStrategy", "ETHUSDT", {
        type: "ORDER_FILLED",
        side: "SELL",
        volume: 1,
        price: 3000,
      });

      // 生成所有报告
      const reports = generator.generateAllReports();

      // 验证：所有报告已生成
      expect(reports.length).toBe(2);
    });
  });

  describe("验收4: 告警推送", () => {
    test("场景1: 触发最大回撤告警", () => {
      const generator = new DailyReportGenerator({
        outputDir: OUTPUT_DIR,
        pushAlert: true,
        alertThresholds: {
          maxDrawdown: 0.05, // 5%
        },
      });

      // 添加数据
      generator.recordOrderEvent("2026-02-21", "GalesStrategy", "BTCUSDT", {
        type: "ORDER_FILLED",
        side: "BUY",
        volume: 0.1,
        price: 50000,
      });

      // 更新盈亏数据（模拟大回撤）
      const data = generator.getReportData("2026-02-21", "GalesStrategy", "BTCUSDT");
      if (data) {
        data.maxDrawdown = 0.1; // 10%回撤
      }

      let alertTriggered = false;
      generator.setEvents({
        onAlertTriggered: (alert) => {
          if (alert.type === "MAX_DRAWDOWN") {
            alertTriggered = true;
            console.log(`告警触发: ${alert.message}`);
          }
        },
      });

      // 生成报告
      generator.generateReport("2026-02-21", "GalesStrategy", "BTCUSDT");

      // 验证：告警已触发
      expect(alertTriggered).toBe(true);
    });

    test("场景2: 触发错误数告警", () => {
      const generator = new DailyReportGenerator({
        outputDir: OUTPUT_DIR,
        pushAlert: true,
        alertThresholds: {
          errorCount: 3,
        },
      });

      // 添加多个错误
      for (let i = 0; i < 5; i++) {
        generator.recordErrorEvent("2026-02-21", "GalesStrategy", "BTCUSDT", {
          type: "NETWORK_ERROR",
          message: `错误${i}`,
        });
      }

      let alertTriggered = false;
      generator.setEvents({
        onAlertTriggered: (alert) => {
          if (alert.type === "ERROR_COUNT") {
            alertTriggered = true;
            console.log(`告警触发: ${alert.message}`);
          }
        },
      });

      // 生成报告
      generator.generateReport("2026-02-21", "GalesStrategy", "BTCUSDT");

      // 验证：告警已触发
      expect(alertTriggered).toBe(true);
    });
  });

  describe("综合验收测试", () => {
    test("完整流程: 采集→生成→推送", async () => {
      const generator = new DailyReportGenerator({
        outputDir: OUTPUT_DIR,
        pushAlert: true,
        alertThresholds: {
          maxDrawdown: 0.1,
          errorCount: 10,
        },
      });

      console.log("1. 采集订单数据");
      // 模拟一天的交易
      for (let i = 0; i < 10; i++) {
        generator.recordOrderEvent("2026-02-21", "GalesStrategy", "BTCUSDT", {
          type: "ORDER_CREATED",
          side: i % 2 === 0 ? "BUY" : "SELL",
          volume: 0.1,
          price: 50000 + i * 100,
        });

        generator.recordOrderEvent("2026-02-21", "GalesStrategy", "BTCUSDT", {
          type: "ORDER_FILLED",
          side: i % 2 === 0 ? "BUY" : "SELL",
          volume: 0.1,
          price: 50000 + i * 100,
          commission: 0.5,
        });
      }

      console.log("2. 更新盈亏数据");
      generator.updatePnlData("2026-02-21", "GalesStrategy", "BTCUSDT", {
        realizedPnl: 500,
        unrealizedPnl: 200,
      });

      console.log("3. 生成日报");
      const report = generator.generateReport("2026-02-21", "GalesStrategy", "BTCUSDT");

      console.log("4. 验证报告内容");
      expect(report).toBeDefined();
      expect(report?.totalOrders).toBe(10); // 只计算创建的订单，不重复计数
      expect(report?.filledOrders).toBe(10);
      expect(report?.totalPnl).toBe(700);

      console.log("5. 验证文件生成");
      const jsonPath = join(OUTPUT_DIR, "daily-report-2026-02-21-GalesStrategy-BTCUSDT.json");
      const txtPath = join(OUTPUT_DIR, "daily-report-2026-02-21-GalesStrategy-BTCUSDT.txt");
      expect(existsSync(jsonPath)).toBe(true);
      expect(existsSync(txtPath)).toBe(true);

      console.log("✅ 完整流程测试通过");
    });
  });
});

// ============ 回滚说明 ============

/**
 * 策略日报生成器 - 回滚说明
 * 
 * ## 功能说明
 * 
 * 1. **数据采集** - 采集订单、错误、盈亏等数据
 * 2. **报告生成** - 生成JSON和文本格式日报
 * 3. **告警推送** - 支持最大回撤、错误数、亏损告警
 * 4. **定时任务** - 支持每日自动生成
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
 * rm -rf quant-lab/src/reporting/
 * ```
 * 
 * ### 方法3: 禁用定时任务
 * 移除定时任务调用：
 * ```typescript
 * // 移除这一行
 * scheduleDailyReport(generator);
 * ```
 * 
 * ## 回滚影响
 * 
 * - **回滚后影响**: 无法自动生成日报，运营无法了解策略运行情况
 * - **建议**: 不建议回滚，这是重要的运营工具
 * 
 * ## 使用示例
 * 
 * ### 1. 基本使用
 * ```typescript
 * const generator = new DailyReportGenerator();
 * 
 * // 记录订单
 * generator.recordOrderEvent("2026-02-21", "GalesStrategy", "BTCUSDT", {
 *   type: "ORDER_FILLED",
 *   side: "BUY",
 *   volume: 0.1,
 *   price: 50000,
 * });
 * 
 * // 生成报告
 * generator.generateReport("2026-02-21", "GalesStrategy", "BTCUSDT");
 * ```
 * 
 * ### 2. 定时任务
 * ```typescript
 * // 每天0点自动生成
 * scheduleDailyReport(generator, 0, 0);
 * ```
 * 
 * ### 3. 告警配置
 * ```typescript
 * const generator = new DailyReportGenerator({
 *   pushAlert: true,
 *   alertThresholds: {
 *     maxDrawdown: 0.05, // 5%
 *     errorCount: 10,
 *     lossThreshold: 1000, // 1000 USDT
 *   },
 * });
 * ```
 */
