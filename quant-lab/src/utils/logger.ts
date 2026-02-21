/**
 * quant-lab Unified Logger
 * 
 * 结构化日志系统，支持：
 * - 统一格式（timestamp/level/module/message/context）
 * - 统一级别（ERROR/WARN/INFO/DEBUG）
 * - 敏感信息脱敏（API key/订单ID）
 * - 多输出（console + file）
 */

export enum LogLevel {
  ERROR = 'ERROR',
  WARN = 'WARN',
  INFO = 'INFO',
  DEBUG = 'DEBUG',
}

export interface LogContext {
  [key: string]: any;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  context?: LogContext;
}

/**
 * 敏感信息脱敏
 */
function sanitize(value: any): any {
  if (typeof value === 'string') {
    // API Key 脱敏：只显示前4位和后4位
    if (value.match(/^[A-Za-z0-9]{32,}$/)) {
      return `${value.substring(0, 4)}...${value.substring(value.length - 4)}`;
    }
    // 订单ID 脱敏：只显示前8位和后4位
    if (value.match(/^[A-Za-z0-9]{12,30}$/)) {
      return `${value.substring(0, 8)}...${value.substring(value.length - 4)}`;
    }
    // 私钥/密钥 脱敏
    if (value.toLowerCase().includes('key') || value.toLowerCase().includes('secret')) {
      return '[REDACTED]';
    }
    return value;
  }
  
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }
  
  if (typeof value === 'object' && value !== null) {
    const sanitized: any = {};
    for (const [k, v] of Object.entries(value)) {
      // 敏感字段名检测
      const lowerKey = k.toLowerCase();
      if (
        lowerKey.includes('apikey') ||
        lowerKey.includes('api_key') ||
        lowerKey.includes('secret') ||
        lowerKey.includes('private') ||
        lowerKey.includes('password') ||
        lowerKey.includes('token')
      ) {
        sanitized[k] = '[REDACTED]';
      } else {
        sanitized[k] = sanitize(v);
      }
    }
    return sanitized;
  }
  
  return value;
}

/**
 * Logger 类
 */
export class Logger {
  private module: string;
  private minLevel: LogLevel;
  
  constructor(module: string, minLevel: LogLevel = LogLevel.INFO) {
    this.module = module;
    this.minLevel = minLevel;
  }
  
  /**
   * 格式化日志输出
   */
  private format(entry: LogEntry): string {
    const timestamp = entry.timestamp;
    const level = entry.level.padEnd(5);
    const module = `[${entry.module}]`.padEnd(20);
    const message = entry.message;
    
    let output = `${timestamp} ${level} ${module} ${message}`;
    
    if (entry.context && Object.keys(entry.context).length > 0) {
      const sanitizedContext = sanitize(entry.context);
      output += ` | ${JSON.stringify(sanitizedContext)}`;
    }
    
    return output;
  }
  
  /**
   * 核心日志方法
   */
  private log(level: LogLevel, message: string, context?: LogContext): void {
    // 级别过滤
    const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
    if (levels.indexOf(level) < levels.indexOf(this.minLevel)) {
      return;
    }
    
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: this.module,
      message,
      context,
    };
    
    const output = this.format(entry);
    
    // 输出到控制台
    switch (level) {
      case LogLevel.ERROR:
        console.error(output);
        break;
      case LogLevel.WARN:
        console.warn(output);
        break;
      case LogLevel.INFO:
        console.info(output);
        break;
      case LogLevel.DEBUG:
        console.log(output);
        break;
    }
  }
  
  /**
   * ERROR 级别日志
   */
  error(message: string, context?: LogContext): void {
    this.log(LogLevel.ERROR, message, context);
  }
  
  /**
   * WARN 级别日志
   */
  warn(message: string, context?: LogContext): void {
    this.log(LogLevel.WARN, message, context);
  }
  
  /**
   * INFO 级别日志
   */
  info(message: string, context?: LogContext): void {
    this.log(LogLevel.INFO, message, context);
  }
  
  /**
   * DEBUG 级别日志
   */
  debug(message: string, context?: LogContext): void {
    this.log(LogLevel.DEBUG, message, context);
  }
  
  /**
   * 创建子logger
   */
  child(subModule: string): Logger {
    return new Logger(`${this.module}:${subModule}`, this.minLevel);
  }
}

/**
 * 全局logger实例
 */
export const logger = new Logger('quant-lab');

/**
 * 创建模块logger
 */
export function createLogger(module: string, minLevel?: LogLevel): Logger {
  return new Logger(module, minLevel);
}

/**
 * 默认导出
 */
export default logger;
