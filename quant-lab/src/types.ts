import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten';

// Re-export types from quant-lib for consistency
export type { 
  ExchangeAPI as BybitAPI,
  Ticker,
  Position,
  OrderParams,
  OrderResult as Order,
  StrategyLogger as Logger,
  StrategyContext,
  StrategyResult
} from '../../../quant-lib/src';

// Import types for local use
import type { 
  ExchangeAPI as BybitAPI,
  Ticker,
  Position,
  OrderParams,
  OrderResult as Order,
  StrategyLogger as Logger
} from '../../../quant-lib/src';

/**
 * 策略配置
 */
export interface StrategyConfig {
  /** 策略唯一标识 */
  id: string;
  
  /** 策略名称 */
  name?: string;
  
  /** 是否启用 */
  enabled: boolean;
  
  /** 
   * 账号名称
   * - 以 "paper-" 开头：使用模拟交易（如 "paper-demo"）
   * - 其他：从 ~/env.jsonl 加载真实账号配置
   */
  account: string;
  
  /** 策略代码路径 */
  code: string;
  
  /** 策略参数 */
  params: Record<string, any>;
  
  /** 调度表达式（可选，cron 格式） */
  schedule?: string;
  
  /** 元数据 */
  meta?: {
    author?: string;
    created_at?: string;
    risk_level?: 'none' | 'low' | 'medium' | 'high';
    [key: string]: any;
  };
}

/**
 * 策略执行结果
 */
export interface StrategyResult {
  /** 是否成功 */
  success: boolean;
  
  /** 执行的操作数（可选） */
  actions?: number;
  
  /** 简短描述（可选） */
  message?: string;
  
  /** 详细数据（可选） */
  data?: Record<string, any>;
  
  /** 错误信息（失败时） */
  error?: string;
  
  /** 执行耗时（毫秒） */
  duration?: number;
}

/**
 * 账户类型
 */
export type AccountType = 'real' | 'paper';

/**
 * 账户信息
 */
export interface AccountInfo {
  type: AccountType;
  name: string;
  isReadonly: boolean;
}

/**
 * 账号配置
 */
export interface AccountConfig {
  /** 账号名称 */
  name: string;
  
  /** Bybit API Key */
  BYBIT_API_KEY: string;
  
  /** Bybit API Secret */
  BYBIT_API_SECRET: string;
  
  /** 环境标识 */
  BYBIT_ENV?: 'dev' | 'test' | 'prod';
  
  /** 是否只读 */
  readonly?: boolean;
  
  /** 最大持仓上限（USD） */
  maxPositionUsd?: number;
  
  /** 代理地址 */
  proxy?: string;
}

/**
 * QuickJS 策略上下文（注入到 VM）
 */
export interface QuickJSStrategyContext {
  bybit: BybitAPI;
  logger: Logger;
  params: Record<string, any>;
  state: Record<string, any>;
}

/**
 * 引擎选项
 */
export interface EngineOptions {
  /** 状态保存目录 */
  stateDir?: string;
  
  /** 日志输出目录 */
  logDir?: string;
  
  /** 是否启用调试模式 */
  debug?: boolean;
}
