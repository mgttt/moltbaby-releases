/**
 * 策略日报生成器
 * 
 * 功能：
 * 1. 采集每日数据（下单数/成交数/盈亏/错误计数）
 * 2. 生成结构化日报（JSON+可读文本）
 * 3. 触发方式：每日定时或手动调用
 * 4. 输出：日报文件+可选告警推送
 * 
 * 位置：quant-lab/src/reporting/daily-report.ts
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

// ============ 类型定义 ============

export interface DailyReportData {
  date: string; // YYYY-MM-DD
  strategy: string;
  symbol: string;
  
  // 订单统计
  totalOrders: number;
  filledOrders: number;
  cancelledOrders: number;
  pendingOrders: number;
  
  // 成交统计
  totalVolume: number; // 总成交量（USDT）
  buyVolume: number; // 买入量
  sellVolume: number; // 卖出量
  
  // 盈亏统计
  realizedPnl: number; // 已实现盈亏
  unrealizedPnl: number; // 未实现盈亏
  totalPnl: number; // 总盈亏
  commission: number; // 手续费
  
  // 错误统计
  errorCount: number;
  errors: Array<{
    time: number;
    type: string;
    message: string;
  }>;
  
  // 其他
  maxDrawdown: number; // 最大回撤
  sharpeRatio?: number; // 夏普比率
  winRate: number; // 胜率
  
  // 时间戳
  generatedAt: number;
}

export interface DailyReportOptions {
  // 输出目录
  outputDir?: string;
  
  // 是否生成JSON格式
  generateJson?: boolean;
  
  // 是否生成文本格式
  generateText?: boolean;
  
  // 是否推送告警
  pushAlert?: boolean;
  
  // 告警阈值
  alertThresholds?: {
    maxDrawdown?: number; // 最大回撤阈值
    errorCount?: number; // 错误数阈值
    lossThreshold?: number; // 亏损阈值
  };
}

export interface DailyReportEvents {
  onReportGenerated: (report: DailyReportData) => void;
  onAlertTriggered: (alert: { type: string; message: string; report: DailyReportData }) => void;
  onError: (error: Error) => void;
}

// ============ 日报生成器 ============

export class DailyReportGenerator {
  private outputDir: string;
  private generateJson: boolean;
  private generateText: boolean;
  private pushAlert: boolean;
  private alertThresholds: DailyReportOptions["alertThresholds"];
  private events: Partial<DailyReportEvents> = {};
  
  // 运行时数据收集
  private dailyData: Map<string, DailyReportData> = new Map();

  constructor(options?: DailyReportOptions) {
    this.outputDir = options?.outputDir || join(homedir(), ".quant-lab", "reports");
    this.generateJson = options?.generateJson ?? true;
    this.generateText = options?.generateText ?? true;
    this.pushAlert = options?.pushAlert ?? false;
    this.alertThresholds = options?.alertThresholds || {};
    
    // 确保输出目录存在
    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * 设置事件回调
   */
  setEvents(events: Partial<DailyReportEvents>): void {
    this.events = { ...this.events, ...events };
  }

  /**
   * 记录订单事件
   */
  recordOrderEvent(
    date: string,
    strategy: string,
    symbol: string,
    event: {
      type: "ORDER_CREATED" | "ORDER_FILLED" | "ORDER_CANCELLED";
      side: "BUY" | "SELL";
      volume: number;
      price: number;
      commission?: number;
    }
  ): void {
    const key = `${date}-${strategy}-${symbol}`;
    let data = this.dailyData.get(key);
    
    if (!data) {
      data = this.createEmptyReport(date, strategy, symbol);
      this.dailyData.set(key, data);
    }
    
    switch (event.type) {
      case "ORDER_CREATED":
        data.totalOrders++;
        data.pendingOrders++;
        break;
        
      case "ORDER_FILLED":
        data.pendingOrders--;
        data.filledOrders++;
        data.totalVolume += event.volume * event.price;
        
        if (event.side === "BUY") {
          data.buyVolume += event.volume * event.price;
        } else {
          data.sellVolume += event.volume * event.price;
        }
        
        if (event.commission) {
          data.commission += event.commission;
        }
        break;
        
      case "ORDER_CANCELLED":
        data.pendingOrders--;
        data.cancelledOrders++;
        break;
    }
    
    data.generatedAt = Date.now();
  }

  /**
   * 记录错误事件
   */
  recordErrorEvent(
    date: string,
    strategy: string,
    symbol: string,
    error: {
      type: string;
      message: string;
    }
  ): void {
    const key = `${date}-${strategy}-${symbol}`;
    let data = this.dailyData.get(key);
    
    if (!data) {
      data = this.createEmptyReport(date, strategy, symbol);
      this.dailyData.set(key, data);
    }
    
    data.errorCount++;
    data.errors.push({
      time: Date.now(),
      type: error.type,
      message: error.message,
    });
    
    data.generatedAt = Date.now();
  }

  /**
   * 更新盈亏数据
   */
  updatePnlData(
    date: string,
    strategy: string,
    symbol: string,
    pnl: {
      realizedPnl: number;
      unrealizedPnl: number;
    }
  ): void {
    const key = `${date}-${strategy}-${symbol}`;
    let data = this.dailyData.get(key);
    
    if (!data) {
      data = this.createEmptyReport(date, strategy, symbol);
      this.dailyData.set(key, data);
    }
    
    data.realizedPnl = pnl.realizedPnl;
    data.unrealizedPnl = pnl.unrealizedPnl;
    data.totalPnl = pnl.realizedPnl + pnl.unrealizedPnl;
    data.generatedAt = Date.now();
  }

  /**
   * 生成日报
   */
  generateReport(date: string, strategy: string, symbol: string): DailyReportData | null {
    const key = `${date}-${strategy}-${symbol}`;
    const data = this.dailyData.get(key);
    
    if (!data) {
      this.log(`[DailyReport] 未找到数据: ${key}`);
      return null;
    }
    
    // 计算胜率
    if (data.filledOrders > 0) {
      const winCount = data.errors.filter((e) => e.type === "WIN").length;
      data.winRate = winCount / data.filledOrders;
    }
    
    // 生成JSON格式
    if (this.generateJson) {
      this.generateJsonReport(data);
    }
    
    // 生成文本格式
    if (this.generateText) {
      this.generateTextReport(data);
    }
    
    // 检查告警
    if (this.pushAlert) {
      this.checkAlerts(data);
    }
    
    this.log(`[DailyReport] 日报已生成: ${key}`);
    this.events.onReportGenerated?.(data);
    
    return data;
  }

  /**
   * 生成所有日报
   */
  generateAllReports(): DailyReportData[] {
    const reports: DailyReportData[] = [];
    
    for (const [key, data] of this.dailyData) {
      const report = this.generateReport(data.date, data.strategy, data.symbol);
      if (report) {
        reports.push(report);
      }
    }
    
    return reports;
  }

  /**
   * 创建空日报
   */
  private createEmptyReport(date: string, strategy: string, symbol: string): DailyReportData {
    return {
      date,
      strategy,
      symbol,
      totalOrders: 0,
      filledOrders: 0,
      cancelledOrders: 0,
      pendingOrders: 0,
      totalVolume: 0,
      buyVolume: 0,
      sellVolume: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      totalPnl: 0,
      commission: 0,
      errorCount: 0,
      errors: [],
      maxDrawdown: 0,
      winRate: 0,
      generatedAt: Date.now(),
    };
  }

  /**
   * 生成JSON格式报告
   */
  private generateJsonReport(data: DailyReportData): void {
    const filename = `daily-report-${data.date}-${data.strategy}-${data.symbol}.json`;
    const filepath = join(this.outputDir, filename);
    
    writeFileSync(filepath, JSON.stringify(data, null, 2));
    this.log(`[DailyReport] JSON报告已保存: ${filepath}`);
  }

  /**
   * 生成文本格式报告
   */
  private generateTextReport(data: DailyReportData): void {
    const filename = `daily-report-${data.date}-${data.strategy}-${data.symbol}.txt`;
    const filepath = join(this.outputDir, filename);
    
    const report = this.formatTextReport(data);
    writeFileSync(filepath, report);
    this.log(`[DailyReport] 文本报告已保存: ${filepath}`);
  }

  /**
   * 格式化文本报告
   */
  private formatTextReport(data: DailyReportData): string {
    const timestamp = new Date(data.generatedAt).toISOString();
    
    return `# 策略日报

**日期**: ${data.date}  
**策略**: ${data.strategy}  
**交易对**: ${data.symbol}  
**生成时间**: ${timestamp}

---

## 订单统计

- **总订单数**: ${data.totalOrders}
- **已成交**: ${data.filledOrders}
- **已取消**: ${data.cancelledOrders}
- **待成交**: ${data.pendingOrders}

---

## 成交统计

- **总成交量**: ${data.totalVolume.toFixed(2)} USDT
- **买入量**: ${data.buyVolume.toFixed(2)} USDT
- **卖出量**: ${data.sellVolume.toFixed(2)} USDT

---

## 盈亏统计

- **已实现盈亏**: ${data.realizedPnl.toFixed(2)} USDT
- **未实现盈亏**: ${data.unrealizedPnl.toFixed(2)} USDT
- **总盈亏**: ${data.totalPnl.toFixed(2)} USDT
- **手续费**: ${data.commission.toFixed(2)} USDT

---

## 风险指标

- **最大回撤**: ${(data.maxDrawdown * 100).toFixed(2)}%
- **胜率**: ${(data.winRate * 100).toFixed(2)}%
${data.sharpeRatio ? `- **夏普比率**: ${data.sharpeRatio.toFixed(2)}` : ""}

---

## 错误统计

- **错误数**: ${data.errorCount}

${data.errors.length > 0 ? `### 错误详情

${data.errors.map((e, i) => `${i + 1}. [${new Date(e.time).toISOString()}] ${e.type}: ${e.message}`).join("\n")}` : "✅ 无错误"}

---

**报告生成时间**: ${timestamp}
`;
  }

  /**
   * 检查告警
   */
  private checkAlerts(data: DailyReportData): void {
    const alerts: Array<{ type: string; message: string }> = [];
    
    // 检查最大回撤
    if (
      this.alertThresholds?.maxDrawdown &&
      data.maxDrawdown > this.alertThresholds.maxDrawdown
    ) {
      alerts.push({
        type: "MAX_DRAWDOWN",
        message: `最大回撤超阈值: ${(data.maxDrawdown * 100).toFixed(2)}% > ${(this.alertThresholds.maxDrawdown * 100).toFixed(2)}%`,
      });
    }
    
    // 检查错误数
    if (
      this.alertThresholds?.errorCount &&
      data.errorCount > this.alertThresholds.errorCount
    ) {
      alerts.push({
        type: "ERROR_COUNT",
        message: `错误数超阈值: ${data.errorCount} > ${this.alertThresholds.errorCount}`,
      });
    }
    
    // 检查亏损
    if (
      this.alertThresholds?.lossThreshold &&
      data.totalPnl < -this.alertThresholds.lossThreshold
    ) {
      alerts.push({
        type: "LOSS_THRESHOLD",
        message: `亏损超阈值: ${data.totalPnl.toFixed(2)} < -${this.alertThresholds.lossThreshold}`,
      });
    }
    
    // 触发告警
    for (const alert of alerts) {
      this.log(`[DailyReport] 告警: ${alert.type} - ${alert.message}`);
      this.events.onAlertTriggered?.({ ...alert, report: data });
    }
  }

  /**
   * 获取日报数据
   */
  getReportData(date: string, strategy: string, symbol: string): DailyReportData | undefined {
    const key = `${date}-${strategy}-${symbol}`;
    return this.dailyData.get(key);
  }

  /**
   * 获取所有日报数据
   */
  getAllReportData(): DailyReportData[] {
    return Array.from(this.dailyData.values());
  }

  /**
   * 清理历史数据
   */
  cleanupOldData(maxDays: number = 30): number {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - maxDays);
    const cutoffStr = cutoffDate.toISOString().split("T")[0];
    
    let cleaned = 0;
    for (const [key, data] of this.dailyData) {
      if (data.date < cutoffStr) {
        this.dailyData.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      this.log(`[DailyReport] 清理历史数据: ${cleaned} 个`);
    }
    
    return cleaned;
  }

  /**
   * 日志
   */
  private log(message: string, ...args: any[]): void {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`, ...args);
  }
}

/**
 * 定时任务：每日生成日报
 */
export function scheduleDailyReport(
  generator: DailyReportGenerator,
  hour: number = 0, // 每天0点
  minute: number = 0
): NodeJS.Timeout {
  const now = new Date();
  const target = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hour,
    minute,
    0
  );
  
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }
  
  const delay = target.getTime() - now.getTime();
  
  this.log(`[DailyReport] 定时任务已调度: ${target.toISOString()}`);
  
  return setTimeout(() => {
    // 生成昨天的日报
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split("T")[0];
    
    generator.generateAllReports();
    
    // 递归调度下一次
    scheduleDailyReport(generator, hour, minute);
  }, delay);
}

// ============ 导出 ============

export default DailyReportGenerator;
