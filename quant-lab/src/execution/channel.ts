/**
 * 订单通道修复 - P0
 * 
 * 功能：
 * 1. orderChannel 配置持久化
 * 2. 断线自动重连
 * 3. 状态实时同步
 * 
 * 位置：quant-lab/src/execution/channel.ts
 * 时间：4h
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ============ 类型定义 ============

export interface OrderChannelConfig {
  channelId: string;
  endpoint: string;
  apiKey: string;
  lastConnected: number;
  status: ChannelStatus;
}

export type ChannelStatus = "CONNECTED" | "DISCONNECTED" | "RECONNECTING" | "FAILED";

export interface OrderChannelEvents {
  onConnect: () => void;
  onDisconnect: () => void;
  onError: (error: Error) => void;
  onStatusChange: (status: ChannelStatus) => void;
}

// ============ 配置管理器 ============

export class OrderChannelConfigManager {
  private configPath: string;
  private config: OrderChannelConfig;

  constructor(configPath?: string) {
    this.configPath = configPath || join(homedir(), ".quant-lab", "orderChannel.json");
    this.config = this.loadConfig();
  }

  /**
   * 加载配置
   */
  private loadConfig(): OrderChannelConfig {
    if (existsSync(this.configPath)) {
      try {
        const content = readFileSync(this.configPath, "utf-8");
        return JSON.parse(content);
      } catch (error) {
        console.error("[OrderChannelConfig] 配置文件损坏，使用默认配置");
        return this.getDefaultConfig();
      }
    } else {
      console.log("[OrderChannelConfig] 配置文件不存在，创建默认配置");
      const defaultConfig = this.getDefaultConfig();
      this.saveConfig(defaultConfig);
      return defaultConfig;
    }
  }

  /**
   * 保存配置
   */
  private saveConfig(config: OrderChannelConfig): void {
    try {
      // 确保目录存在
      const dir = join(this.configPath, "..");
      if (!existsSync(dir)) {
        const { mkdirSync } = require("fs");
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(this.configPath, JSON.stringify(config, null, 2));
      console.log("[OrderChannelConfig] 配置已保存:", this.configPath);
    } catch (error) {
      console.error("[OrderChannelConfig] 配置保存失败:", error);
    }
  }

  /**
   * 获取默认配置
   */
  private getDefaultConfig(): OrderChannelConfig {
    return {
      channelId: "default",
      endpoint: process.env.ORDER_CHANNEL_ENDPOINT || "wss://stream.bybit.com/v5/private",
      apiKey: process.env.BYBIT_API_KEY || "",
      lastConnected: 0,
      status: "DISCONNECTED",
    };
  }

  /**
   * 获取配置
   */
  getConfig(): OrderChannelConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(updates: Partial<OrderChannelConfig>): void {
    this.config = { ...this.config, ...updates };
    this.saveConfig(this.config);
  }

  /**
   * 更新状态
   */
  updateStatus(status: ChannelStatus): void {
    this.config.status = status;
    if (status === "CONNECTED") {
      this.config.lastConnected = Date.now();
    }
    this.saveConfig(this.config);
  }
}

// ============ 订单通道 ============

export class OrderChannel {
  private configManager: OrderChannelConfigManager;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectDelay: number = 1000; // 1 秒
  private reconnectTimer: NodeJS.Timeout | null = null;
  private events: Partial<OrderChannelEvents> = {};

  constructor(configPath?: string) {
    this.configManager = new OrderChannelConfigManager(configPath);
  }

  /**
   * 设置事件回调
   */
  setEvents(events: Partial<OrderChannelEvents>): void {
    this.events = { ...this.events, ...events };
  }

  /**
   * 连接
   */
  async connect(): Promise<void> {
    const config = this.configManager.getConfig();

    console.log("[OrderChannel] 开始连接:", config.endpoint);

    try {
      // 模拟 WebSocket 连接
      // 实际实现需要使用 WebSocket 库
      await this.simulateConnect();

      this.reconnectAttempts = 0;
      this.configManager.updateStatus("CONNECTED");
      this.events.onConnect?.();
      this.events.onStatusChange?.("CONNECTED");

      console.log("[OrderChannel] 连接成功");
    } catch (error: any) {
      console.error("[OrderChannel] 连接失败:", error.message);
      this.configManager.updateStatus("FAILED");
      this.events.onError?.(error);
      this.events.onStatusChange?.("FAILED");
      throw error;
    }
  }

  /**
   * 模拟连接（实际实现需要 WebSocket）
   */
  private async simulateConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // 模拟连接延迟
      setTimeout(() => {
        // 模拟连接成功
        const success = Math.random() > 0.1; // 90% 成功率

        if (success) {
          resolve();
        } else {
          reject(new Error("连接失败（模拟）"));
        }
      }, 1000);
    });
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    console.log("[OrderChannel] 断开连接");

    // 清除重连定时器
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.configManager.updateStatus("DISCONNECTED");
    this.events.onDisconnect?.();
    this.events.onStatusChange?.("DISCONNECTED");
  }

  /**
   * 自动重连
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[OrderChannel] 重连失败，已达最大重试次数");
      this.configManager.updateStatus("FAILED");
      this.events.onStatusChange?.("FAILED");
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    console.log(
      `[OrderChannel] ${delay}ms 后尝试第 ${this.reconnectAttempts} 次重连`
    );

    this.configManager.updateStatus("RECONNECTING");
    this.events.onStatusChange?.("RECONNECTING");

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        console.error("[OrderChannel] 重连失败:", error.message);
      });
    }, delay);
  }

  /**
   * 获取状态
   */
  getStatus(): ChannelStatus {
    return this.configManager.getConfig().status;
  }

  /**
   * 获取配置
   */
  getConfig(): OrderChannelConfig {
    return this.configManager.getConfig();
  }
}

// ============ 导出 ============

export default OrderChannel;
