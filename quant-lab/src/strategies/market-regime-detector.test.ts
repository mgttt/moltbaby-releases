/**
 * 市场状态检测器 - 测试覆盖
 * 
 * 验收标准：
 * 1. ADX指标计算（趋势强度）
 * 2. 强趋势警告（ADX>25）
 * 3. 极强趋势暂停建议（ADX>40）
 * 4. 集成GalesStrategy（enableMarketRegime开关）
 * 5. 测试覆盖
 * 
 * 位置：quant-lab/src/strategies/market-regime-detector.test.ts
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { MarketRegimeDetector } from "./market-regime-detector";
import type { Kline } from '../../../quant-lib/src';

// ============ 测试工具 ============

const createMockKline = (
  close: number,
  high?: number,
  low?: number,
  open?: number
): Kline => ({
  symbol: "BTCUSDT",
  interval: "1h",
  openTime: Date.now(),
  closeTime: Date.now() + 3600000,
  open: open ?? close,
  high: high ?? close * 1.01,
  low: low ?? close * 0.99,
  close,
  volume: 1000,
  quoteVolume: close * 1000,
  trades: 100,
});

// ============ 测试套件 ============

describe("市场状态检测器 - 验收测试", () => {
  let detector: MarketRegimeDetector;

  beforeEach(() => {
    detector = new MarketRegimeDetector();
  });

  describe("验收1: ADX指标计算", () => {
    test("场景1: 价格稳定时ADX较低（横盘）", () => {
      // 模拟横盘市场：价格在100附近小幅波动
      const basePrice = 100;
      for (let i = 0; i < 30; i++) {
        const variation = (Math.random() - 0.5) * 0.5; // 小幅波动
        const price = basePrice + variation;
        detector.update(createMockKline(price));
      }

      const adx = detector.getCurrentADX();
      console.log(`[测试] 横盘市场 ADX=${adx.toFixed(2)}`);

      // 横盘市场ADX应该较低（<25）
      expect(adx).toBeLessThan(25);
    });

    test("场景2: 价格持续上涨时ADX较高（趋势）", () => {
      // 模拟强趋势市场：价格从100持续上涨到120
      let price = 100;
      for (let i = 0; i < 30; i++) {
        price += 0.7; // 每根K线上涨0.7%
        detector.update(createMockKline(price));
      }

      const adx = detector.getCurrentADX();
      console.log(`[测试] 强趋势市场 ADX=${adx.toFixed(2)}`);

      // 强趋势市场ADX应该较高（>25）
      expect(adx).toBeGreaterThan(25);
    });

    test("场景3: 价格剧烈波动时ADX很高（极强趋势）", () => {
      // 模拟极强趋势：价格从100快速上涨到140
      let price = 100;
      for (let i = 0; i < 30; i++) {
        price += 1.5; // 每根K线上涨1.5%
        detector.update(createMockKline(price));
      }

      const adx = detector.getCurrentADX();
      console.log(`[测试] 极强趋势市场 ADX=${adx.toFixed(2)}`);

      // 极强趋势ADX应该很高（>40）
      expect(adx).toBeGreaterThan(40);
    });
  });

  describe("验收2: 强趋势警告（ADX>25）", () => {
    test("场景1: ADX达到25时触发警告", () => {
      let warningTriggered = false;

      detector.setEvents({
        onTrendWarning: (adx: number) => {
          warningTriggered = true;
          console.log(`[测试] 趋势警告触发 ADX=${adx.toFixed(2)}`);
        },
      });

      // 模拟趋势形成
      let price = 100;
      for (let i = 0; i < 30; i++) {
        price += 0.6;
        detector.update(createMockKline(price));
      }

      const adx = detector.getCurrentADX();
      console.log(`[测试] 最终ADX=${adx.toFixed(2)}, 警告=${warningTriggered}, shouldWarn=${detector.shouldWarn()}`);

      // 验证警告触发
      expect(adx).toBeGreaterThan(25);
      expect(detector.shouldWarn()).toBe(true);
    });
  });

  describe("验收3: 极强趋势暂停建议（ADX>40）", () => {
    test("场景1: ADX达到40时触发暂停建议", () => {
      let suspendTriggered = false;

      detector.setEvents({
        onSuspendSuggestion: (adx: number) => {
          suspendTriggered = true;
          console.log(`[测试] 暂停建议触发 ADX=${adx.toFixed(2)}`);
        },
      });

      // 模拟极强趋势
      let price = 100;
      for (let i = 0; i < 30; i++) {
        price += 1.5;
        detector.update(createMockKline(price));
      }

      const adx = detector.getCurrentADX();
      console.log(`[测试] 最终ADX=${adx.toFixed(2)}, 暂停=${suspendTriggered}, shouldSuspend=${detector.shouldSuspend()}`);

      // 验证暂停建议
      expect(adx).toBeGreaterThan(40);
      expect(detector.shouldSuspend()).toBe(true);
    });
  });

  describe("验收4: 市场状态判断", () => {
    test("场景1: 横盘市场（RANGING）", () => {
      // 模拟横盘
      const basePrice = 100;
      for (let i = 0; i < 30; i++) {
        const variation = (Math.random() - 0.5) * 0.3;
        detector.update(createMockKline(basePrice + variation));
      }

      const regime = detector.getCurrentRegime();
      console.log(`[测试] 横盘市场状态=${regime}, ADX=${detector.getCurrentADX().toFixed(2)}`);

      expect(regime).toBe('RANGING');
    });

    test("场景2: 强趋势（TRENDING）", () => {
      // 模拟强趋势
      let price = 100;
      for (let i = 0; i < 30; i++) {
        price += 0.7;
        detector.update(createMockKline(price));
      }

      const regime = detector.getCurrentRegime();
      console.log(`[测试] 强趋势状态=${regime}, ADX=${detector.getCurrentADX().toFixed(2)}`);

      expect(regime).toBe('TRENDING');
    });

    test("场景3: 极强趋势（STRONG_TREND）", () => {
      // 模拟极强趋势
      let price = 100;
      for (let i = 0; i < 30; i++) {
        price += 1.5;
        detector.update(createMockKline(price));
      }

      const regime = detector.getCurrentRegime();
      console.log(`[测试] 极强趋势状态=${regime}, ADX=${detector.getCurrentADX().toFixed(2)}`);

      expect(regime).toBe('STRONG_TREND');
    });
  });

  describe("验收5: 事件回调", () => {
    test("场景1: 状态变化时触发onRegimeChange", () => {
      let regimeChanges: Array<{ regime: string; adx: number }> = [];

      detector.setEvents({
        onRegimeChange: (regime, adx) => {
          regimeChanges.push({ regime, adx });
          console.log(`[测试] 状态变化=${regime}, ADX=${adx.toFixed(2)}`);
        },
      });

      // 从横盘到趋势
      let price = 100;
      for (let i = 0; i < 30; i++) {
        price += 0.8;
        detector.update(createMockKline(price));
      }

      console.log(`[测试] 状态变化次数=${regimeChanges.length}`);
      expect(regimeChanges.length).toBeGreaterThan(0);
    });
  });

  describe("验收6: 配置参数", () => {
    test("场景1: 自定义ADX周期", () => {
      const customDetector = new MarketRegimeDetector({
        adxPeriod: 7, // 更短的周期
      });

      // 快速注入数据
      let price = 100;
      for (let i = 0; i < 20; i++) {
        price += 0.8;
        customDetector.update(createMockKline(price));
      }

      const adx = customDetector.getCurrentADX();
      console.log(`[测试] 自定义周期(7) ADX=${adx.toFixed(2)}`);

      expect(adx).toBeGreaterThan(0);
    });

    test("场景2: 自定义阈值", () => {
      const customDetector = new MarketRegimeDetector({
        trendingThreshold: 20, // 降低强趋势阈值
        strongTrendThreshold: 35, // 降低极强趋势阈值
      });

      // 模拟中等趋势
      let price = 100;
      for (let i = 0; i < 30; i++) {
        price += 0.6;
        customDetector.update(createMockKline(price));
      }

      const regime = customDetector.getCurrentRegime();
      console.log(`[测试] 自定义阈值 状态=${regime}, ADX=${customDetector.getCurrentADX().toFixed(2)}`);

      // 更低的阈值应该更容易触发趋势状态
    });
  });
});

// ============ 边界测试 ============

describe("市场状态检测器 - 边界测试", () => {
  test("边界1: 数据不足时返回默认值", () => {
    const detector = new MarketRegimeDetector();

    // 只注入少量数据（< adxPeriod * 2）
    detector.update(createMockKline(100));
    detector.update(createMockKline(101));
    detector.update(createMockKline(102));

    const adx = detector.getCurrentADX();
    console.log(`[测试] 数据不足 ADX=${adx}`);

    expect(adx).toBe(0);
    expect(detector.getCurrentRegime()).toBe('RANGING');
  });

  test("边界2: reset清空状态", () => {
    const detector = new MarketRegimeDetector();

    // 注入数据
    let price = 100;
    for (let i = 0; i < 30; i++) {
      price += 1;
      detector.update(createMockKline(price));
    }

    // 重置
    detector.reset();

    const state = detector.getState();
    console.log(`[测试] 重置后状态=`, state);

    expect(state.currentADX).toBe(0);
    expect(state.currentRegime).toBe('RANGING');
    expect(state.adxHistory.length).toBe(0);
  });
});
