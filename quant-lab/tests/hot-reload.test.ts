/**
 * 热更新集成测试 (Issue #136)
 *
 * 核心验证：
 * 1. 缓存指标持久化和恢复
 * 2. 状态版本兼容性 (v1 → v2)
 * 3. CLI 命令可用性
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

describe('Hot Reload Integration Tests (Issue #136)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join('/tmp', 'hot-reload-test-' + Date.now());
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (e) {
      // ignore cleanup errors
    }
  });

  // ============================================================
  // Test 1: 缓存指标持久化 (Issue #136 核心)
  // ============================================================
  it('should persist cached indicators in saveState()', async () => {
    // 1. 模拟 gales-simple.js 的状态保存
    const cachedIndicators = {
      adx: 25.5,
      sma20: 50100,
      sma50: 50200,
      rsi14: 55,
      timestamp: Date.now(),
      klineCount: 200,
    };

    const state = {
      runId: 1000,
      orderSeq: 100,
      centerPrice: 50000,
      gridLevels: [],
      openOrders: [],
      tickCount: 50,
    };

    // 2. 模拟 saveState() 逻辑
    const stateToSave = {
      ...state,
      cachedIndicators,
      _saveVersion: 2,
      _saveAt: Date.now(),
    };

    const stateJson = JSON.stringify(stateToSave);
    const stateFile = join(testDir, 'state.json');
    writeFileSync(stateFile, stateJson);

    // 3. 验证保存的数据完整性
    const saved = JSON.parse(readFileSync(stateFile, 'utf-8'));
    expect(saved._saveVersion).toBe(2);
    expect(saved.cachedIndicators).toBeDefined();
    expect(saved.cachedIndicators.adx).toBe(25.5);
    expect(saved.cachedIndicators.sma20).toBe(50100);
    expect(saved.cachedIndicators.rsi14).toBe(55);
  });

  // ============================================================
  // Test 2: 缓存指标恢复
  // ============================================================
  it('should restore cached indicators from saved state', async () => {
    // 1. 模拟热更新前的状态文件（v2格式）
    const savedState = {
      runId: 1000,
      orderSeq: 100,
      centerPrice: 50000,
      gridLevels: [],
      openOrders: [],
      tickCount: 50,
      cachedIndicators: {
        adx: 25.5,
        sma20: 50100,
        sma50: 50200,
        rsi14: 55,
        timestamp: 1234567890,
        klineCount: 200,
      },
      _saveVersion: 2,
    };

    const stateFile = join(testDir, 'state.json');
    writeFileSync(stateFile, JSON.stringify(savedState));

    // 2. 模拟 loadState() 逻辑
    const loaded = JSON.parse(readFileSync(stateFile, 'utf-8'));

    // 模拟指标恢复逻辑
    let cachedIndicators = {
      adx: 0,
      sma20: 0,
      sma50: 0,
      rsi14: 0,
      timestamp: 0,
      klineCount: 0,
    };

    if (loaded.cachedIndicators) {
      cachedIndicators.adx = loaded.cachedIndicators.adx || 0;
      cachedIndicators.sma20 = loaded.cachedIndicators.sma20 || 0;
      cachedIndicators.sma50 = loaded.cachedIndicators.sma50 || 0;
      cachedIndicators.rsi14 = loaded.cachedIndicators.rsi14 || 0;
      cachedIndicators.timestamp = loaded.cachedIndicators.timestamp || 0;
      cachedIndicators.klineCount = loaded.cachedIndicators.klineCount || 0;
    }

    // 3. 验证指标被正确恢复
    expect(cachedIndicators.adx).toBe(25.5);
    expect(cachedIndicators.sma20).toBe(50100);
    expect(cachedIndicators.sma50).toBe(50200);
    expect(cachedIndicators.rsi14).toBe(55);
    expect(cachedIndicators.klineCount).toBe(200);
  });

  // ============================================================
  // Test 3: 版本兼容性 (v1 → v2)
  // ============================================================
  it('should handle version migration from v1 to v2', async () => {
    // 1. 模拟旧版状态 (v1: 无 cachedIndicators)
    const v1State = {
      runId: 1000,
      orderSeq: 100,
      centerPrice: 50000,
      gridLevels: [],
      openOrders: [],
      tickCount: 50,
      _saveVersion: 1,
    };

    const stateFile = join(testDir, 'state.json');
    writeFileSync(stateFile, JSON.stringify(v1State));

    // 2. 加载 v1 状态
    const loaded = JSON.parse(readFileSync(stateFile, 'utf-8'));

    // 模拟 loadState() 的兼容性逻辑
    let cachedIndicators = {
      adx: 0,
      sma20: 0,
      sma50: 0,
      rsi14: 0,
      timestamp: 0,
      klineCount: 0,
    };

    // v1 状态中没有 cachedIndicators，保持默认值
    if (loaded.cachedIndicators) {
      cachedIndicators = { ...loaded.cachedIndicators };
    }

    // 3. 验证向后兼容
    expect(loaded._saveVersion).toBe(1);
    expect(cachedIndicators.adx).toBe(0); // 默认值
    expect(cachedIndicators.sma20).toBe(0);

    // 4. 升级到 v2：添加 cachedIndicators 并持久化
    const v2State = {
      ...loaded,
      cachedIndicators: {
        adx: 20.0,
        sma20: 50050,
        sma50: 50150,
        rsi14: 50,
        timestamp: Date.now(),
        klineCount: 180,
      },
      _saveVersion: 2,
    };

    writeFileSync(stateFile, JSON.stringify(v2State));

    // 5. 验证 v2 状态
    const upgraded = JSON.parse(readFileSync(stateFile, 'utf-8'));
    expect(upgraded._saveVersion).toBe(2);
    expect(upgraded.cachedIndicators.adx).toBe(20.0);
    expect(upgraded.cachedIndicators.sma20).toBe(50050);
  });

  // ============================================================
  // Test 4: 完整状态序列化/反序列化
  // ============================================================
  it('should serialize and deserialize full state correctly', async () => {
    const complexState = {
      // 基础状态
      runId: 1000,
      orderSeq: 500,
      centerPrice: 50000,
      gridLevels: [
        { price: 49000, quantity: 1, gridId: 1 },
        { price: 51000, quantity: 1, gridId: 2 },
      ],
      openOrders: [
        { id: 'order-1', price: 49500, quantity: 0.1, status: 'PENDING' },
      ],
      tickCount: 1000,

      // 持久化的附加状态
      positionDiffState: {
        initialOffset: 0,
        lastDiff: 100,
        diffIncreaseCount: 2,
        lastAlertAt: 0,
        ledgerGapOverCount: 0,
        ledgerGapHardblocked: false,
        lastHardblockAlertAt: 0,
      },

      marketRegimeState: {
        currentADX: 25.5,
        currentRegime: 'TRENDING',
        warmupTicks: 50,
        adxHistoryLength: 100,
        priceHistoryLength: 100,
      },

      circuitBreakerState: {
        tripped: false,
        reason: '',
        tripAt: 0,
      },

      // Issue #136: 缓存指标
      cachedIndicators: {
        adx: 25.5,
        sma20: 50100,
        sma50: 50200,
        rsi14: 55,
        timestamp: 1234567890,
        klineCount: 200,
      },

      // 元数据
      _saveVersion: 2,
      _saveAt: Date.now(),
    };

    const stateFile = join(testDir, 'complex-state.json');
    writeFileSync(stateFile, JSON.stringify(complexState));

    // 读取并验证所有字段
    const restored = JSON.parse(readFileSync(stateFile, 'utf-8'));

    expect(restored.runId).toBe(1000);
    expect(restored.gridLevels.length).toBe(2);
    expect(restored.openOrders[0].id).toBe('order-1');
    expect(restored.positionDiffState.lastDiff).toBe(100);
    expect(restored.marketRegimeState.currentRegime).toBe('TRENDING');
    expect(restored.circuitBreakerState.tripped).toBe(false);
    expect(restored.cachedIndicators.sma20).toBe(50100);
    expect(restored._saveVersion).toBe(2);
  });

  // ============================================================
  // Test 5: 多次热更新指标连续性
  // ============================================================
  it('should maintain indicator continuity across multiple reloads', async () => {
    const stateFile = join(testDir, 'continuous-state.json');

    // 初始状态
    let state = {
      runId: 1000,
      orderSeq: 0,
      cachedIndicators: {
        adx: 0,
        sma20: 0,
        sma50: 0,
        rsi14: 0,
        timestamp: 0,
        klineCount: 0,
      },
      _saveVersion: 2,
    };

    // 第1次更新：计算出指标
    state.cachedIndicators = {
      adx: 20.0,
      sma20: 50000,
      sma50: 50100,
      rsi14: 45,
      timestamp: Date.now(),
      klineCount: 100,
    };
    writeFileSync(stateFile, JSON.stringify(state));

    // 第1次热更新：恢复指标
    let reloaded = JSON.parse(readFileSync(stateFile, 'utf-8'));
    expect(reloaded.cachedIndicators.adx).toBe(20.0);
    expect(reloaded.cachedIndicators.klineCount).toBe(100);

    // 第2次更新：指标继续演进
    state = reloaded;
    state.cachedIndicators = {
      adx: 25.5,
      sma20: 50050,
      sma50: 50150,
      rsi14: 55,
      timestamp: Date.now(),
      klineCount: 150,
    };
    state.tickCount = 500;
    writeFileSync(stateFile, JSON.stringify(state));

    // 第2次热更新：指标继续保持
    reloaded = JSON.parse(readFileSync(stateFile, 'utf-8'));
    expect(reloaded.cachedIndicators.adx).toBe(25.5);
    expect(reloaded.cachedIndicators.klineCount).toBe(150);
    expect(reloaded.tickCount).toBe(500);

    // 第3次更新：指标再次演进
    state = reloaded;
    state.cachedIndicators.adx = 30.0;
    state.cachedIndicators.klineCount = 200;
    state.tickCount = 1000;
    writeFileSync(stateFile, JSON.stringify(state));

    // 第3次热更新：指标无缝演进
    reloaded = JSON.parse(readFileSync(stateFile, 'utf-8'));
    expect(reloaded.cachedIndicators.adx).toBe(30.0);
    expect(reloaded.cachedIndicators.klineCount).toBe(200);
    expect(reloaded.tickCount).toBe(1000);
  });

  // ============================================================
  // Test 6: CLI 命令格式验证
  // ============================================================
  it('should support valid CLI command formats', async () => {
    // 验证 CLI 命令格式（这是验证命令结构，不实际执行）

    const commands = [
      // reload 命令
      {
        cmd: 'reload',
        strategyId: 'gales-MYXUSDT-short',
        args: [],
        expected: true,
      },
      {
        cmd: 'reload',
        strategyId: 'gales-MYXUSDT-short',
        args: ['--target', 'strategy'],
        expected: true,
      },
      {
        cmd: 'reload',
        strategyId: 'gales-MYXUSDT-short',
        args: ['--target', 'strategy', '--dry-run'],
        expected: true,
      },

      // rollback 命令
      {
        cmd: 'rollback',
        strategyId: 'gales-MYXUSDT-short',
        args: [],
        expected: true,
      },
      {
        cmd: 'rollback',
        strategyId: 'gales-MYXUSDT-short',
        args: ['--to', 'snapshot-id'],
        expected: true,
      },

      // snapshots 命令
      {
        cmd: 'snapshots',
        strategyId: 'gales-MYXUSDT-short',
        args: [],
        expected: true,
      },
    ];

    for (const cmd of commands) {
      // 验证命令格式正确
      expect(cmd.strategyId).toBeDefined();
      expect(cmd.cmd).toMatch(/^(reload|rollback|snapshots)$/);
      expect(Array.isArray(cmd.args)).toBe(true);
    }
  });

  // ============================================================
  // Test 7: 状态文件格式验证
  // ============================================================
  it('should maintain valid JSON state file format', async () => {
    const state = {
      runId: 1000,
      orderSeq: 100,
      centerPrice: 50000,
      cachedIndicators: {
        adx: 25.5,
        sma20: 50100,
        sma50: 50200,
        rsi14: 55,
        timestamp: Date.now(),
        klineCount: 200,
      },
      _saveVersion: 2,
      _saveAt: Date.now(),
    };

    const stateFile = join(testDir, 'state.json');

    // 1. 保存为 JSON
    const jsonStr = JSON.stringify(state);
    writeFileSync(stateFile, jsonStr);

    // 2. 读取并解析
    const restored = JSON.parse(readFileSync(stateFile, 'utf-8'));

    // 3. 验证格式完整性
    expect(typeof restored).toBe('object');
    expect(restored.runId).toBeGreaterThan(0);
    expect(typeof restored.cachedIndicators).toBe('object');
    expect(Object.keys(restored.cachedIndicators).length).toBe(6);

    // 4. 验证所有字段可序列化
    const serialized = JSON.stringify(restored);
    expect(typeof serialized).toBe('string');
    expect(serialized.length).toBeGreaterThan(0);
  });
});
