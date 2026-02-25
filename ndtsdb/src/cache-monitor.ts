// ============================================================
// 缓存监测体系 - 点3实现
// 提供详细的缓存性能监控、统计和告警
// ============================================================

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * 缓存访问记录
 */
export interface CacheAccessRecord {
  key: string;
  timestamp: number;
  hit: boolean;
  size: number;
  latencyMs: number;
}

/**
 * 缓存统计指标
 */
export interface CacheMetrics {
  // 基础统计
  totalRequests: number;
  hits: number;
  misses: number;
  hitRate: number;
  
  // 流量统计
  totalBytesRead: number;
  totalBytesFromCache: number;
  cacheEfficiency: number; // 从缓存读取的比例
  
  // 性能统计
  avgLatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  
  // 容量统计
  currentEntries: number;
  currentSizeMB: number;
  maxSizeMB: number;
  utilizationRate: number;
  
  // 淘汰统计
  evictions: number;
  evictedBytes: number;
  
  // 时间窗口
  windowStart: number;
  windowEnd: number;
}

/**
 * 缓存告警配置
 */
export interface CacheAlertConfig {
  minHitRate: number;        // 命中率低于此值触发告警 (默认 0.5)
  maxLatencyMs: number;      // 平均延迟高于此值触发告警 (默认 100)
  maxUtilization: number;    // 利用率高于此值触发告警 (默认 0.9)
  minEfficiency: number;     // 缓存效率低于此值触发告警 (默认 0.3)
}

/**
 * 缓存告警
 */
export interface CacheAlert {
  type: 'low_hit_rate' | 'high_latency' | 'high_utilization' | 'low_efficiency';
  severity: 'warning' | 'critical';
  message: string;
  value: number;
  threshold: number;
  timestamp: number;
}

/**
 * 缓存监测器 - 单例
 */
export class CacheMonitor {
  private static instance: CacheMonitor | null = null;
  
  private records: CacheAccessRecord[] = [];
  private maxRecords: number = 10000;
  private metricsWindowMs: number = 60000; // 1分钟窗口
  
  private alertConfig: CacheAlertConfig;
  private alerts: CacheAlert[] = [];
  private maxAlerts: number = 100;
  
  private statsPath: string;
  private persistInterval: NodeJS.Timeout | null = null;
  
  private constructor(
    dataDir: string = '/tmp/ndts-cache',
    alertConfig?: Partial<CacheAlertConfig>
  ) {
    this.statsPath = join(dataDir, '.cache-stats.json');
    this.alertConfig = {
      minHitRate: 0.5,
      maxLatencyMs: 100,
      maxUtilization: 0.9,
      minEfficiency: 0.3,
      ...alertConfig
    };
    
    // 加载持久化统计
    this.loadStats();
    
    // 启动定期持久化
    this.startPersistence();
  }
  
  static getInstance(
    dataDir?: string,
    alertConfig?: Partial<CacheAlertConfig>
  ): CacheMonitor {
    if (!CacheMonitor.instance) {
      CacheMonitor.instance = new CacheMonitor(dataDir, alertConfig);
    }
    return CacheMonitor.instance;
  }
  
  /** 测试用：重置单例 */
  static resetInstance(): void {
    if (CacheMonitor.instance) {
      CacheMonitor.instance.stopPersistence();
    }
    CacheMonitor.instance = null;
  }
  
  /**
   * 记录缓存访问
   */
  recordAccess(record: CacheAccessRecord): void {
    this.records.push(record);
    
    // 限制记录数量
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
    
    // 清理过期记录
    this.cleanupOldRecords();
  }
  
  /**
   * 记录缓存命中
   */
  recordHit(key: string, size: number, latencyMs: number): void {
    this.recordAccess({
      key,
      timestamp: Date.now(),
      hit: true,
      size,
      latencyMs
    });
  }
  
  /**
   * 记录缓存未命中
   */
  recordMiss(key: string, size: number, latencyMs: number): void {
    this.recordAccess({
      key,
      timestamp: Date.now(),
      hit: false,
      size,
      latencyMs
    });
  }
  
  /**
   * 获取当前统计指标
   */
  getMetrics(currentEntries: number, currentSizeBytes: number, maxSizeBytes: number): CacheMetrics {
    const now = Date.now();
    const windowStart = now - this.metricsWindowMs;
    
    // 过滤时间窗口内的记录
    const windowRecords = this.records.filter(r => r.timestamp >= windowStart);
    
    const hits = windowRecords.filter(r => r.hit);
    const misses = windowRecords.filter(r => !r.hit);
    
    const totalRequests = windowRecords.length;
    const hitCount = hits.length;
    const missCount = misses.length;
    
    // 计算命中率
    const hitRate = totalRequests > 0 ? hitCount / totalRequests : 0;
    
    // 计算流量
    const totalBytesRead = windowRecords.reduce((sum, r) => sum + r.size, 0);
    const totalBytesFromCache = hits.reduce((sum, r) => sum + r.size, 0);
    const cacheEfficiency = totalBytesRead > 0 ? totalBytesFromCache / totalBytesRead : 0;
    
    // 计算延迟统计
    const latencies = windowRecords.map(r => r.latencyMs).sort((a, b) => a - b);
    const avgLatencyMs = latencies.length > 0 
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length 
      : 0;
    const p95LatencyMs = this.percentile(latencies, 0.95);
    const p99LatencyMs = this.percentile(latencies, 0.99);
    
    // 容量统计
    const currentSizeMB = currentSizeBytes / 1024 / 1024;
    const maxSizeMB = maxSizeBytes / 1024 / 1024;
    const utilizationRate = maxSizeBytes > 0 ? currentSizeBytes / maxSizeBytes : 0;
    
    return {
      totalRequests,
      hits: hitCount,
      misses: missCount,
      hitRate,
      totalBytesRead,
      totalBytesFromCache,
      cacheEfficiency,
      avgLatencyMs,
      p95LatencyMs,
      p99LatencyMs,
      currentEntries,
      currentSizeMB: Math.round(currentSizeMB * 100) / 100,
      maxSizeMB: Math.round(maxSizeMB * 100) / 100,
      utilizationRate: Math.round(utilizationRate * 1000) / 1000,
      evictions: 0, // 由 CompressionCache 提供
      evictedBytes: 0,
      windowStart,
      windowEnd: now
    };
  }
  
  /**
   * 检查并生成告警
   */
  checkAlerts(metrics: CacheMetrics): CacheAlert[] {
    const newAlerts: CacheAlert[] = [];
    const now = Date.now();
    
    // 命中率告警
    if (metrics.hitRate < this.alertConfig.minHitRate && metrics.totalRequests > 10) {
      newAlerts.push({
        type: 'low_hit_rate',
        severity: metrics.hitRate < 0.3 ? 'critical' : 'warning',
        message: `Cache hit rate ${(metrics.hitRate * 100).toFixed(1)}% below threshold ${(this.alertConfig.minHitRate * 100).toFixed(1)}%`,
        value: metrics.hitRate,
        threshold: this.alertConfig.minHitRate,
        timestamp: now
      });
    }
    
    // 延迟告警
    if (metrics.avgLatencyMs > this.alertConfig.maxLatencyMs) {
      newAlerts.push({
        type: 'high_latency',
        severity: metrics.avgLatencyMs > 500 ? 'critical' : 'warning',
        message: `Cache avg latency ${metrics.avgLatencyMs.toFixed(1)}ms above threshold ${this.alertConfig.maxLatencyMs}ms`,
        value: metrics.avgLatencyMs,
        threshold: this.alertConfig.maxLatencyMs,
        timestamp: now
      });
    }
    
    // 利用率告警
    if (metrics.utilizationRate > this.alertConfig.maxUtilization) {
      newAlerts.push({
        type: 'high_utilization',
        severity: metrics.utilizationRate > 0.95 ? 'critical' : 'warning',
        message: `Cache utilization ${(metrics.utilizationRate * 100).toFixed(1)}% above threshold ${(this.alertConfig.maxUtilization * 100).toFixed(1)}%`,
        value: metrics.utilizationRate,
        threshold: this.alertConfig.maxUtilization,
        timestamp: now
      });
    }
    
    // 效率告警
    if (metrics.cacheEfficiency < this.alertConfig.minEfficiency && metrics.totalRequests > 10) {
      newAlerts.push({
        type: 'low_efficiency',
        severity: 'warning',
        message: `Cache efficiency ${(metrics.cacheEfficiency * 100).toFixed(1)}% below threshold ${(this.alertConfig.minEfficiency * 100).toFixed(1)}%`,
        value: metrics.cacheEfficiency,
        threshold: this.alertConfig.minEfficiency,
        timestamp: now
      });
    }
    
    // 保存告警
    this.alerts.push(...newAlerts);
    if (this.alerts.length > this.maxAlerts) {
      this.alerts = this.alerts.slice(-this.maxAlerts);
    }
    
    return newAlerts;
  }
  
  /**
   * 获取所有告警
   */
  getAlerts(since?: number): CacheAlert[] {
    if (since) {
      return this.alerts.filter(a => a.timestamp >= since);
    }
    return [...this.alerts];
  }
  
  /**
   * 清除告警
   */
  clearAlerts(): void {
    this.alerts = [];
  }
  
  /**
   * 获取访问热力图（按时间分布）
   */
  getHeatMap(buckets: number = 24): { hour: number; hits: number; misses: number }[] {
    const now = Date.now();
    const oneHour = 3600000;
    const heatMap: { hour: number; hits: number; misses: number }[] = [];
    
    for (let i = 0; i < buckets; i++) {
      const hourStart = now - (buckets - i) * oneHour;
      const hourEnd = hourStart + oneHour;
      
      const hourRecords = this.records.filter(
        r => r.timestamp >= hourStart && r.timestamp < hourEnd
      );
      
      heatMap.push({
        hour: new Date(hourStart).getHours(),
        hits: hourRecords.filter(r => r.hit).length,
        misses: hourRecords.filter(r => !r.hit).length
      });
    }
    
    return heatMap;
  }
  
  /**
   * 获取热点数据（访问频率最高的key）
   */
  getHotKeys(topN: number = 10): { key: string; accesses: number; hitRate: number }[] {
    const keyStats = new Map<string, { accesses: number; hits: number }>();
    
    for (const record of this.records) {
      const stats = keyStats.get(record.key) || { accesses: 0, hits: 0 };
      stats.accesses++;
      if (record.hit) stats.hits++;
      keyStats.set(record.key, stats);
    }
    
    return Array.from(keyStats.entries())
      .map(([key, stats]) => ({
        key,
        accesses: stats.accesses,
        hitRate: stats.accesses > 0 ? stats.hits / stats.accesses : 0
      }))
      .sort((a, b) => b.accesses - a.accesses)
      .slice(0, topN);
  }
  
  /**
   * 持久化统计到磁盘
   */
  private persistStats(): void {
    try {
      const data = {
        records: this.records.slice(-1000), // 只保留最近1000条
        alerts: this.alerts,
        savedAt: Date.now()
      };
      writeFileSync(this.statsPath, JSON.stringify(data, null, 2));
    } catch (e) {
      // 忽略持久化错误
    }
  }
  
  /**
   * 加载持久化统计
   */
  private loadStats(): void {
    try {
      if (existsSync(this.statsPath)) {
        const data = JSON.parse(readFileSync(this.statsPath, 'utf-8'));
        this.records = data.records || [];
        this.alerts = data.alerts || [];
      }
    } catch (e) {
      // 忽略加载错误
    }
  }
  
  /**
   * 启动定期持久化
   */
  private startPersistence(): void {
    this.persistInterval = setInterval(() => {
      this.persistStats();
    }, 60000); // 每分钟持久化
  }
  
  /**
   * 停止定期持久化
   */
  private stopPersistence(): void {
    if (this.persistInterval) {
      clearInterval(this.persistInterval);
      this.persistInterval = null;
    }
  }
  
  /**
   * 清理过期记录
   */
  private cleanupOldRecords(): void {
    const cutoff = Date.now() - this.metricsWindowMs * 2; // 保留2个窗口
    const idx = this.records.findIndex(r => r.timestamp >= cutoff);
    if (idx > 0) {
      this.records = this.records.slice(idx);
    }
  }
  
  /**
   * 计算百分位数
   */
  private percentile(sortedArray: number[], p: number): number {
    if (sortedArray.length === 0) return 0;
    const index = Math.ceil(sortedArray.length * p) - 1;
    return sortedArray[Math.max(0, index)];
  }
  
  /**
   * 生成监控报告
   */
  generateReport(currentEntries: number, currentSizeBytes: number, maxSizeBytes: number): string {
    const metrics = this.getMetrics(currentEntries, currentSizeBytes, maxSizeBytes);
    const hotKeys = this.getHotKeys(5);
    const alerts = this.checkAlerts(metrics);
    
    const lines = [
      '=== NDTS Cache Monitor Report ===',
      `Generated: ${new Date().toISOString()}`,
      '',
      '--- Performance ---',
      `Hit Rate: ${(metrics.hitRate * 100).toFixed(2)}% (${metrics.hits}/${metrics.totalRequests})`,
      `Avg Latency: ${metrics.avgLatencyMs.toFixed(2)}ms`,
      `P95 Latency: ${metrics.p95LatencyMs.toFixed(2)}ms`,
      `P99 Latency: ${metrics.p99LatencyMs.toFixed(2)}ms`,
      '',
      '--- Capacity ---',
      `Entries: ${metrics.currentEntries}`,
      `Size: ${metrics.currentSizeMB.toFixed(2)}MB / ${metrics.maxSizeMB.toFixed(2)}MB`,
      `Utilization: ${(metrics.utilizationRate * 100).toFixed(2)}%`,
      '',
      '--- Efficiency ---',
      `Cache Efficiency: ${(metrics.cacheEfficiency * 100).toFixed(2)}%`,
      `Bytes from Cache: ${(metrics.totalBytesFromCache / 1024 / 1024).toFixed(2)}MB`,
      `Total Bytes Read: ${(metrics.totalBytesRead / 1024 / 1024).toFixed(2)}MB`,
      '',
      '--- Hot Keys (Top 5) ---',
      ...hotKeys.map((k, i) => `${i + 1}. ${k.key}: ${k.accesses} accesses (${(k.hitRate * 100).toFixed(1)}% hit)`),
      '',
      '--- Active Alerts ---',
      ...(alerts.length > 0 
        ? alerts.map(a => `[${a.severity.toUpperCase()}] ${a.type}: ${a.message}`)
        : ['No active alerts'])
    ];
    
    return lines.join('\n');
  }
}
