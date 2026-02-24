/**
 * 环境变量统一配置
 * 
 * 职责：
 * - 集中管理所有process.env访问
 * - 提供类型安全的环境变量接口
 * - 统一默认值处理
 * - 方便测试时mock
 * 
 * 使用方式：
 *   import { env } from './env';
 *   const apiKey = env.BYBIT_API_KEY;
 */

/**
 * 获取用户主目录
 */
function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || '/tmp';
}

/**
 * 环境变量配置对象
 */
export const env = {
  // ========== 系统路径 ==========
  /** 用户主目录 */
  get HOME() {
    return getHomeDir();
  },

  // ========== 量化实验室配置 ==========
  /** 状态目录 */
  get QUANT_STATE_DIR() {
    return process.env.QUANT_STATE_DIR || `${getHomeDir()}/.quant-lab/state`;
  },

  /** 配置目录 */
  get QUANT_CONFIG_DIR() {
    return process.env.QUANT_CONFIG_DIR || `${getHomeDir()}/.config/quant-lab`;
  },

  /** 账户配置文件路径 */
  get QUANT_LAB_ACCOUNTS() {
    return process.env.QUANT_LAB_ACCOUNTS || `${getHomeDir()}/.config/quant-lab/accounts.json`;
  },

  /** 性能指标状态目录 */
  get QUANT_LAB_STATE_DIR() {
    return process.env.QUANT_LAB_STATE_DIR || '/home/devali/.quant-lab/state';
  },

  // ========== Bybit API配置 ==========
  /** Bybit API Key */
  get BYBIT_API_KEY() {
    return process.env.BYBIT_API_KEY || '';
  },

  /** Bybit API Secret */
  get BYBIT_API_SECRET() {
    return process.env.BYBIT_API_SECRET || '';
  },

  /** Bybit Key (别名) */
  get BYBIT_KEY() {
    return process.env.BYBIT_KEY || '';
  },

  /** 代理服务器 */
  get PROXY() {
    return process.env.PROXY || '';
  },

  /** 订单通道端点 */
  get ORDER_CHANNEL_ENDPOINT() {
    return process.env.ORDER_CHANNEL_ENDPOINT || 'wss://stream.bybit.com/v5/private';
  },

  // ========== 功能开关 ==========
  /** 是否禁用Bar缓存 */
  get DISABLE_BAR_CACHE() {
    return process.env.DISABLE_BAR_CACHE === '1';
  },

  /** 是否启用实盘交易 */
  get LIVE_TRADING() {
    return process.env.LIVE_TRADING === '1';
  },

  /** 策略告警级别 */
  get STRATEGY_ALERT_LEVEL() {
    return process.env.STRATEGY_ALERT_LEVEL || 'CRITICAL';
  },

  /** 是否启用Telegram策略告警 */
  get STRATEGY_TG_ENABLED() {
    return process.env.STRATEGY_TG_ENABLED === '1';
  },

  // ========== ndtsdb配置 ==========
  /** ndtsdb环境变量（透传） */
  get ndtsdbEnv() {
    return process.env;
  },
} as const;

/**
 * 检查Bybit API是否已配置
 */
export function hasBybitApiKey(): boolean {
  return !!(env.BYBIT_API_KEY || env.BYBIT_KEY);
}

/**
 * 获取交易模式
 */
export function getTradingMode(): 'live' | 'paper' {
  return env.LIVE_TRADING ? 'live' : 'paper';
}

// 默认导出
export default env;
