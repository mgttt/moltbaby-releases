// ============================================================
// 技术指标计算单元测试
// ============================================================

import { describe, it, expect } from 'bun:test';
import { sma, ema, rsi, macd, bollingerBands, atr } from '../../../quant-lib/src/indicators/indicators';

describe('Indicators - SMA', () => {
  it('应该正确计算简单移动平均', () => {
    const prices = [10, 11, 12, 13, 14];
    const result = sma(prices, 3);
    
    // 前 period-1 个值应该是 NaN
    expect(Number.isNaN(result[0])).toBe(true);
    expect(Number.isNaN(result[1])).toBe(true);
    
    // (10+11+12)/3 = 11
    expect(result[2]).toBe(11);
    
    // (11+12+13)/3 = 12
    expect(result[3]).toBe(12);
    
    // (12+13+14)/3 = 13
    expect(result[4]).toBe(13);
  });

  it('应该处理数据长度小于周期的情况', () => {
    const prices = [10, 11];
    const result = sma(prices, 5);
    
    expect(Number.isNaN(result[0])).toBe(true);
    expect(Number.isNaN(result[1])).toBe(true);
  });

  it('应该处理空数组', () => {
    const result = sma([], 3);
    expect(result.length).toBe(0);
  });

  it('应该正确计算5周期SMA', () => {
    const prices = [10, 20, 30, 40, 50, 60, 70, 80];
    const result = sma(prices, 5);
    
    // (10+20+30+40+50)/5 = 30
    expect(result[4]).toBe(30);
    
    // (20+30+40+50+60)/5 = 40
    expect(result[5]).toBe(40);
    
    // (30+40+50+60+70)/5 = 50
    expect(result[6]).toBe(50);
    
    // (40+50+60+70+80)/5 = 60
    expect(result[7]).toBe(60);
  });
});

describe('Indicators - EMA', () => {
  it('应该正确计算指数移动平均', () => {
    const prices = [10, 11, 12, 13, 14];
    const result = ema(prices, 3);
    
    // 前 period-1 个值应该是 NaN
    expect(Number.isNaN(result[0])).toBe(true);
    expect(Number.isNaN(result[1])).toBe(true);
    
    // 第一个有效EMA等于同周期的SMA
    // (10+11+12)/3 = 11
    expect(result[2]).toBeCloseTo(11, 1);
    
    // multiplier = 2/(3+1) = 0.5
    // EMA[3] = (13 - 11) * 0.5 + 11 = 12
    expect(result[3]).toBeCloseTo(12, 1);
    
    // EMA[4] = (14 - 12) * 0.5 + 12 = 13
    expect(result[4]).toBeCloseTo(13, 1);
  });

  it('应该比SMA对新数据更敏感', () => {
    const prices = [50, 50, 50, 50, 100];
    const smaResult = sma(prices, 4);
    const emaResult = ema(prices, 4);
    
    // 最后一个值，EMA应该比SMA更接近最新价格
    expect(emaResult[4]).toBeGreaterThan(smaResult[4]);
  });

  it('应该处理价格不变的情况', () => {
    const prices = [100, 100, 100, 100, 100];
    const result = ema(prices, 3);
    
    expect(result[2]).toBe(100);
    expect(result[3]).toBe(100);
    expect(result[4]).toBe(100);
  });

  it('应该处理价格持续上升的情况', () => {
    const prices = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const result = ema(prices, 5);
    
    // EMA应该呈上升趋势
    for (let i = 6; i < result.length - 1; i++) {
      expect(result[i + 1]).toBeGreaterThan(result[i]);
    }
  });
});

describe('Indicators - RSI', () => {
  it('应该正确计算RSI', () => {
    // 使用标准测试数据
    const prices = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 
      45.84, 46.08, 46.14, 45.89, 46.03, 45.61, 46.28, 46.28,
      46.00, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71
    ];
    const result = rsi(prices, 14);
    
    // 前 period-1 个值应该是 NaN，第14个是第一个有效值
    for (let i = 0; i < 14; i++) {
      expect(Number.isNaN(result[i])).toBe(true);
    }
    
    // RSI应该在0-100之间
    for (let i = 15; i < result.length; i++) {
      expect(result[i]).toBeGreaterThanOrEqual(0);
      expect(result[i]).toBeLessThanOrEqual(100);
    }
  });

  it('应该在持续上涨时接近100', () => {
    const prices = [];
    let price = 100;
    for (let i = 0; i < 20; i++) {
      prices.push(price);
      price += 10;
    }
    
    const result = rsi(prices, 14);
    const lastRsi = result[result.length - 1];
    
    // 持续上涨后，RSI应该较高（接近超买）
    expect(lastRsi).toBeGreaterThan(70);
  });

  it('应该在持续下跌时接近0', () => {
    const prices = [];
    let price = 200;
    for (let i = 0; i < 20; i++) {
      prices.push(price);
      price -= 10;
    }
    
    const result = rsi(prices, 14);
    const lastRsi = result[result.length - 1];
    
    // 持续下跌后，RSI应该较低（接近超卖）
    expect(lastRsi).toBeLessThan(30);
  });

  it('应该处理波动行情', () => {
    const prices = [50, 51, 50, 51, 50, 51, 50, 51, 50, 51];
    const result = rsi(prices, 5);
    
    // 在波动行情中，RSI应该在中间区域
    const validRsi = result.filter(v => !Number.isNaN(v));
    expect(validRsi.length).toBeGreaterThan(0);
    
    for (const rsi of validRsi) {
      expect(rsi).toBeGreaterThan(30);
      expect(rsi).toBeLessThan(70);
    }
  });
});

describe('Indicators - MACD', () => {
  it('应该正确计算MACD组件', () => {
    const prices = [];
    for (let i = 0; i < 50; i++) {
      // 模拟上升趋势
      prices.push(100 + i * 2 + Math.sin(i) * 10);
    }
    
    const result = macd(prices, 12, 26, 9);
    
    expect(result.macd).toBeDefined();
    expect(result.signal).toBeDefined();
    expect(result.histogram).toBeDefined();
    
    expect(result.macd.length).toBe(prices.length);
    expect(result.signal.length).toBe(prices.length);
    expect(result.histogram.length).toBe(prices.length);
  });

  it('应该正确计算MACD柱状图', () => {
    const prices = [];
    for (let i = 0; i < 50; i++) {
      prices.push(100 + Math.sin(i / 5) * 20);
    }
    
    const result = macd(prices, 12, 26, 9);
    
    // 柱状图 = MACD - Signal
    for (let i = 0; i < prices.length; i++) {
      if (!Number.isNaN(result.histogram[i]) && 
          !Number.isNaN(result.macd[i]) && 
          !Number.isNaN(result.signal[i])) {
        expect(result.histogram[i]).toBeCloseTo(
          result.macd[i] - result.signal[i], 
          5
        );
      }
    }
  });

  it('应该在金叉时MACD上穿Signal', () => {
    // 模拟一个明确的金叉场景
    const prices = [];
    let price = 100;
    
    // 前20个价格：下跌趋势
    for (let i = 0; i < 20; i++) {
      prices.push(price);
      price -= 2;
    }
    
    // 后30个价格：上涨趋势
    for (let i = 0; i < 30; i++) {
      prices.push(price);
      price += 3;
    }
    
    const result = macd(prices, 12, 26, 9);
    
    // 在上升趋势后期，MACD应该在Signal之上
    const lastIdx = result.macd.length - 1;
    expect(result.macd[lastIdx]).toBeGreaterThan(result.signal[lastIdx]);
  });
});

describe('Indicators - Bollinger Bands', () => {
  it('应该正确计算布林带', () => {
    const prices = [];
    for (let i = 0; i < 30; i++) {
      prices.push(100 + Math.random() * 20 - 10);
    }
    
    const result = bollingerBands(prices, 20, 2);
    
    expect(result.upper).toBeDefined();
    expect(result.middle).toBeDefined();
    expect(result.lower).toBeDefined();
    
    expect(result.upper.length).toBe(prices.length);
    expect(result.middle.length).toBe(prices.length);
    expect(result.lower.length).toBe(prices.length);
  });

  it('应该满足 upper > middle > lower', () => {
    const prices = [];
    for (let i = 0; i < 30; i++) {
      prices.push(100 + Math.random() * 20);
    }
    
    const result = bollingerBands(prices, 20, 2);
    
    for (let i = 20; i < prices.length; i++) {
      expect(result.upper[i]).toBeGreaterThan(result.middle[i]);
      expect(result.middle[i]).toBeGreaterThan(result.lower[i]);
    }
  });

  it('middle应该等于SMA', () => {
    const prices = [];
    for (let i = 0; i < 30; i++) {
      prices.push(100 + i);
    }
    
    const bbResult = bollingerBands(prices, 20, 2);
    const smaResult = sma(prices, 20);
    
    for (let i = 19; i < prices.length; i++) {
      expect(bbResult.middle[i]).toBe(smaResult[i]);
    }
  });
});

describe('Indicators - ATR', () => {
  it('应该正确计算ATR', () => {
    // 生成模拟K线数据
    const highs = [];
    const lows = [];
    const closes = [];
    
    let price = 100;
    for (let i = 0; i < 30; i++) {
      const volatility = 5 + Math.random() * 10;
      const high = price + volatility;
      const low = price - volatility;
      const close = price + (Math.random() - 0.5) * volatility * 2;
      
      highs.push(high);
      lows.push(low);
      closes.push(close);
      price = close;
    }
    
    const result = atr(highs, lows, closes, 14);
    
    expect(result.length).toBe(highs.length);
    
    // ATR应该是正数
    for (let i = 14; i < result.length; i++) {
      expect(result[i]).toBeGreaterThan(0);
    }
  });

  it('应该在波动大时ATR较高', () => {
    // 高波动数据
    const highVolHighs = [110, 115, 120, 118, 125];
    const highVolLows = [95, 90, 85, 88, 82];
    const highVolCloses = [100, 105, 110, 108, 115];
    
    // 低波动数据
    const lowVolHighs = [102, 103, 101, 102, 103];
    const lowVolLows = [98, 97, 99, 98, 97];
    const lowVolCloses = [100, 100, 100, 100, 100];
    
    const highVolAtr = atr(highVolHighs, highVolLows, highVolCloses, 3);
    const lowVolAtr = atr(lowVolHighs, lowVolLows, lowVolCloses, 3);
    
    // 最后一个有效值比较
    const highVolLast = highVolAtr[highVolAtr.length - 1];
    const lowVolLast = lowVolAtr[lowVolAtr.length - 1];
    
    expect(highVolLast).toBeGreaterThan(lowVolLast);
  });
});

describe('Indicators - 边界情况', () => {
  it('应该处理单元素数组', () => {
    const prices = [100];
    const smaResult = sma(prices, 3);
    const emaResult = ema(prices, 3);
    
    expect(smaResult.length).toBe(1);
    expect(Number.isNaN(smaResult[0])).toBe(true);
    expect(Number.isNaN(emaResult[0])).toBe(true);
  });

  it('应该处理包含零的数组', () => {
    const prices = [0, 10, 20, 30, 40];
    const result = sma(prices, 3);
    
    expect(result[2]).toBe(10); // (0+10+20)/3
    expect(result[3]).toBe(20); // (10+20+30)/3
  });

  it('应该处理负数价格', () => {
    const prices = [-10, -5, 0, 5, 10];
    const result = sma(prices, 3);
    
    expect(result[2]).toBe(-5); // (-10-5+0)/3
    expect(result[3]).toBe(0);  // (-5+0+5)/3
  });
});
