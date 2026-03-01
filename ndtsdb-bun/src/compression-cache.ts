// ============================================================
// 透明解压缓存层 - L1正则增强版
// 磁盘存 .ndts.zst 压缩文件，首次读取时解压到缓存目录，
// 后续直接 mmap 缓存文件，实现对上层完全透明。
// 
// 增强功能：
// - L1正则增强：W-TinyLFU 替换策略 + 访问频率追踪
// - 缓存监测体系：详细统计、告警、热力图
// ============================================================

import { existsSync, mkdirSync, statSync, unlinkSync, readdirSync, renameSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, basename } from 'path';
import { zstdDecompressSync } from 'zlib';
import { CacheMonitor, CacheMetrics } from './cache-monitor.js';

const DEFAULT_CACHE_DIR = '/tmp/ndts-cache';
const DEFAULT_MAX_CACHE_MB = 2048; // 2GB

/**
 * 缓存项元数据（L1正则增强）
 */
interface CacheEntry {
  path: string;
  size: number;
  lastAccess: number;
  accessCount: number;      // 访问次数（用于频率统计）
  frequency: number;        // W-TinyLFU 频率计数
  createdAt: number;        // 创建时间
  lastAccessWindow: number; // 上次访问窗口（用于滑动窗口）
}

/**
 * W-TinyLFU 频率窗口配置
 */
interface WTinyLFUConfig {
  windowSize: number;       // 窗口大小（访问次数）
  decayFactor: number;      // 衰减因子
}

/**
 * 透明解压缓存管理器（单例）- L1正则增强版
 *
 * 使用流程：
 *   const resolved = CompressionCache.resolve('/data/BTCUSDT.ndts');
 *   // resolved 是可以直接 mmap 的原始二进制文件路径
 *   //  - 如果原始 .ndts 存在 → 直接返回原路径
 *   //  - 如果只有 .ndts.zst  → 解压到缓存 → 返回缓存路径
 */
export class CompressionCache {
  private static instance: CompressionCache | null = null;

  private cacheDir: string;
  private maxCacheBytes: number;
  private entries: Map<string, CacheEntry> = new Map();
  
  // L1正则增强：W-TinyLFU
  private wTinyLFU: WTinyLFUConfig = {
    windowSize: 100,
    decayFactor: 0.9
  };
  private accessWindow: number = 0;  // 当前访问窗口计数
  private windowCounter: number = 0; // 窗口切换计数器
  
  // 缓存监测
  private monitor: CacheMonitor;
  private evictionCount: number = 0;
  private evictedBytes: number = 0;

  private constructor(cacheDir: string, maxCacheMB: number) {
    this.cacheDir = cacheDir;
    this.maxCacheBytes = maxCacheMB * 1024 * 1024;
    mkdirSync(this.cacheDir, { recursive: true });
    this.scanExisting();
    
    // 初始化监测器
    this.monitor = CacheMonitor.getInstance(cacheDir);
  }

  static getInstance(
    cacheDir: string = DEFAULT_CACHE_DIR,
    maxCacheMB: number = DEFAULT_MAX_CACHE_MB,
  ): CompressionCache {
    if (!CompressionCache.instance) {
      CompressionCache.instance = new CompressionCache(cacheDir, maxCacheMB);
    }
    return CompressionCache.instance;
  }

  /** 测试用：重置单例 */
  static resetInstance(): void {
    CompressionCache.instance = null;
    CacheMonitor.resetInstance();
  }

  /**
   * 核心方法：给定一个 .ndts 路径，返回可直接 mmap 的文件路径。
   *
   * 探测优先级：
   *   1. path 本身存在（原始 .ndts）→ 直接返回
   *   2. path + '.zst' 存在          → 解压到缓存 → 返回缓存路径
   *   3. 都不存在                     → 抛异常
   */
  resolve(path: string): string {
    const startTime = Date.now();
    
    // 1) 原始文件存在 → 最快路径，直接返回
    if (existsSync(path)) {
      const latency = Date.now() - startTime;
      this.monitor.recordHit(path, 0, latency); // 视为命中（无IO）
      return path;
    }

    // 2) 压缩文件？
    const zstPath = path.endsWith('.zst') ? path : path + '.zst';
    if (existsSync(zstPath)) {
      const result = this.ensureDecompressed(zstPath, startTime);
      return result;
    }

    // 3) 都不存在
    throw new Error(`File not found: ${path} (also tried ${zstPath})`);
  }

  /**
   * 探测一个 symbol 的实际文件路径（给 MmapPool.init 用）
   * 返回 { path, compressed } 或 null
   */
  static probe(basePath: string, symbol: string): { path: string; compressed: boolean } | null {
    const raw = join(basePath, `${symbol}.ndts`);
    if (existsSync(raw)) return { path: raw, compressed: false };

    const zst = join(basePath, `${symbol}.ndts.zst`);
    if (existsSync(zst)) return { path: raw, compressed: true }; // 返回 .ndts 路径，resolve() 会找到 .zst

    return null;
  }

  // ─── 内部实现 ───────────────────────────────────────

  private ensureDecompressed(zstPath: string, startTime: number): string {
    const cacheKey = this.getCacheKey(zstPath);
    const cachePath = join(this.cacheDir, cacheKey + '.raw');

    // 缓存命中？
    const existing = this.entries.get(cacheKey);
    if (existing && existsSync(existing.path)) {
      // 检查源文件是否比缓存更新
      const srcMtime = statSync(zstPath).mtimeMs;
      const cacheMtime = statSync(existing.path).mtimeMs;
      if (cacheMtime >= srcMtime) {
        // L1正则增强：更新访问统计
        this.updateAccessStats(cacheKey);
        
        const latency = Date.now() - startTime;
        const size = existing.size;
        this.monitor.recordHit(cacheKey, size, latency);
        
        return existing.path;
      }
      // 源文件更新了，删旧缓存重新解压
      this.removeEntry(cacheKey);
    }

    // 缓存未命中 → 解压
    const decompressStart = Date.now();
    this.evictIfNeeded();
    this.decompress(zstPath, cachePath);

    // 登记
    const size = statSync(cachePath).size;
    const now = Date.now();
    this.entries.set(cacheKey, {
      path: cachePath,
      size,
      lastAccess: now,
      accessCount: 1,
      frequency: 1,
      createdAt: now,
      lastAccessWindow: this.accessWindow
    });
    
    const latency = Date.now() - startTime;
    this.monitor.recordMiss(cacheKey, size, latency);

    return cachePath;
  }

  /**
   * L1正则增强：更新访问统计（W-TinyLFU）
   */
  private updateAccessStats(cacheKey: string): void {
    const entry = this.entries.get(cacheKey);
    if (!entry) return;

    const now = Date.now();
    entry.lastAccess = now;
    entry.accessCount++;

    // W-TinyLFU：滑动窗口频率计数
    this.windowCounter++;
    if (this.windowCounter >= this.wTinyLFU.windowSize) {
      // 窗口切换：衰减所有频率计数
      this.accessWindow++;
      this.windowCounter = 0;
      for (const e of this.entries.values()) {
        e.frequency = Math.floor(e.frequency * this.wTinyLFU.decayFactor);
      }
    }

    // 增加当前项频率
    entry.frequency++;
    entry.lastAccessWindow = this.accessWindow;
  }

  /**
   * 生成缓存 key：基于文件路径 + mtime 的 hash
   * 保证同一个文件修改后缓存自动失效
   */
  private getCacheKey(zstPath: string): string {
    const st = statSync(zstPath);
    const input = `${zstPath}:${st.mtimeMs}:${st.size}`;
    return createHash('md5').update(input).digest('hex');
  }

  /**
   * 原子解压：先写临时文件，成功后 rename
   * 避免并发读到半成品
   * 使用 Bun/Node 内置 zstd（无系统依赖）
   */
  private decompress(zstPath: string, cachePath: string): void {
    const tmpPath = cachePath + `.tmp.${process.pid}`;
    try {
      const compressed = readFileSync(zstPath);
      const decompressed = zstdDecompressSync(compressed);
      writeFileSync(tmpPath, decompressed);
      renameSync(tmpPath, cachePath);
    } catch (e: any) {
      // 清理临时文件
      try { unlinkSync(tmpPath); } catch {}
      throw new Error(`Failed to decompress ${zstPath}: ${e.message}`);
    }
  }

  /**
   * L1正则增强：W-TinyLFU + LRU 混合淘汰策略
   * 
   * 策略：
   * 1. 优先淘汰 frequency 低的（低频访问）
   * 2. frequency 相同，淘汰 lastAccess 老的
   * 3. 删除到80%水位
   */
  private evictIfNeeded(): void {
    let totalSize = 0;
    for (const entry of this.entries.values()) {
      totalSize += entry.size;
    }

    if (totalSize <= this.maxCacheBytes) return;

    // L1正则增强：按 W-TinyLFU 排序
    // 优先级：frequency 升序，然后 lastAccess 升序
    const sorted = [...this.entries.entries()]
      .sort((a, b) => {
        const freqDiff = a[1].frequency - b[1].frequency;
        if (freqDiff !== 0) return freqDiff;
        return a[1].lastAccess - b[1].lastAccess;
      });

    for (const [key, entry] of sorted) {
      if (totalSize <= this.maxCacheBytes * 0.8) break; // 删到80%水位
      this.removeEntry(key);
      this.evictionCount++;
      this.evictedBytes += entry.size;
      totalSize -= entry.size;
    }
  }

  private removeEntry(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      try { unlinkSync(entry.path); } catch {}
      this.entries.delete(key);
    }
  }

  /**
   * 启动时扫描缓存目录，恢复 entries（重启后缓存仍可用）
   */
  private scanExisting(): void {
    try {
      const files = readdirSync(this.cacheDir);
      for (const file of files) {
        if (!file.endsWith('.raw')) continue;
        const fullPath = join(this.cacheDir, file);
        try {
          const st = statSync(fullPath);
          const key = file.replace('.raw', '');
          this.entries.set(key, {
            path: fullPath,
            size: st.size,
            lastAccess: st.atimeMs,
            accessCount: 0,
            frequency: 0,
            createdAt: st.birthtimeMs,
            lastAccessWindow: 0
          });
        } catch {}
      }
    } catch {}
  }

  // ─── 监测接口 ───────────────────────────────────────

  /** 获取缓存统计 */
  getStats(): { entries: number; totalMB: number; maxMB: number } {
    let totalSize = 0;
    for (const entry of this.entries.values()) {
      totalSize += entry.size;
    }
    return {
      entries: this.entries.size,
      totalMB: Math.round(totalSize / 1024 / 1024 * 100) / 100,
      maxMB: this.maxCacheBytes / 1024 / 1024,
    };
  }

  /**
   * 获取详细缓存统计（含监测数据）
   */
  getDetailedStats(): CacheMetrics & { 
    wTinyLFU: { window: number; counter: number };
    evictions: number;
    evictedMB: number;
  } {
    let totalSize = 0;
    for (const entry of this.entries.values()) {
      totalSize += entry.size;
    }
    
    const metrics = this.monitor.getMetrics(
      this.entries.size,
      totalSize,
      this.maxCacheBytes
    );
    
    // 补充淘汰统计
    metrics.evictions = this.evictionCount;
    metrics.evictedBytes = this.evictedBytes;
    
    return {
      ...metrics,
      wTinyLFU: {
        window: this.accessWindow,
        counter: this.windowCounter
      },
      evictions: this.evictionCount,
      evictedMB: Math.round(this.evictedBytes / 1024 / 1024 * 100) / 100
    };
  }

  /**
   * 获取缓存访问热力图
   */
  getHeatMap(buckets: number = 24): { hour: number; hits: number; misses: number }[] {
    return this.monitor.getHeatMap(buckets);
  }

  /**
   * 获取热点数据
   */
  getHotKeys(topN: number = 10): { key: string; accesses: number; hitRate: number }[] {
    // 合并本地访问统计和监测器统计
    const localStats = [...this.entries.entries()]
      .map(([key, entry]) => ({
        key,
        accesses: entry.accessCount,
        hitRate: entry.accessCount > 0 ? 1 : 0 // 本地缓存总是命中
      }))
      .sort((a, b) => b.accesses - a.accesses)
      .slice(0, topN);
    
    return localStats;
  }

  /**
   * 检查并获取告警
   */
  checkAlerts(): import('./cache-monitor.js').CacheAlert[] {
    let totalSize = 0;
    for (const entry of this.entries.values()) {
      totalSize += entry.size;
    }
    
    const metrics = this.monitor.getMetrics(
      this.entries.size,
      totalSize,
      this.maxCacheBytes
    );
    
    return this.monitor.checkAlerts(metrics);
  }

  /**
   * 生成监控报告
   */
  generateReport(): string {
    let totalSize = 0;
    for (const entry of this.entries.values()) {
      totalSize += entry.size;
    }
    
    const baseReport = this.monitor.generateReport(
      this.entries.size,
      totalSize,
      this.maxCacheBytes
    );
    
    const detailedStats = this.getDetailedStats();
    
    const extraLines = [
      '',
      '--- W-TinyLFU Stats ---',
      `Current Window: ${detailedStats.wTinyLFU.window}`,
      `Window Counter: ${detailedStats.wTinyLFU.counter}/${this.wTinyLFU.windowSize}`,
      '',
      '--- Eviction Stats ---',
      `Total Evictions: ${detailedStats.evictions}`,
      `Evicted Size: ${detailedStats.evictedMB}MB`,
    ];
    
    return baseReport + '\n' + extraLines.join('\n');
  }

  /** 清空全部缓存 */
  clear(): void {
    for (const [key] of this.entries) {
      this.removeEntry(key);
    }
    this.evictionCount = 0;
    this.evictedBytes = 0;
  }
}
