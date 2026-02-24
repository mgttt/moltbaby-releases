/**
 * StrategyRegistry - 全局策略注册表
 * 
 * 职责：
 * - 管理所有QuickJSStrategy实例的全局注册
 * - 支持热重载管理器通过ID查找策略实例
 * - 提供线程安全的注册/注销/查询操作（Bun单线程但需防异步竞态）
 * 
 * 使用模式：
 *   // 策略初始化时自动注册
 *   StrategyRegistry.register(strategyId, this);
 *   
 *   // 热重载管理器查找策略
 *   const strategy = StrategyRegistry.get(strategyId);
 *   if (strategy) {
 *     await strategy.reload();
 *   }
 */

import { createLogger } from '../utils/logger';
const logger = createLogger('StrategyRegistry');

import type { QuickJSStrategy } from '../legacy/QuickJSStrategy';

// 注册表条目
interface RegistryEntry {
  strategy: QuickJSStrategy;
  registeredAt: number;
  strategyId: string;
}

/**
 * 全局策略注册表（单例）
 * 
 * 线程安全设计（Bun环境）：
 * - Bun是单线程的，但async操作可能导致回调交错
 * - 使用简单的Map操作（非原子操作但在JS单线程下安全）
 * - 注册/注销操作是同步的，避免async竞态
 */
class StrategyRegistryImpl {
  private registry = new Map<string, RegistryEntry>();
  private autoRegisterEnabled = true;

  /**
   * 注册策略实例
   * 
   * @param strategyId 策略唯一标识
   * @param strategy QuickJSStrategy实例
   * @returns 是否注册成功（false表示ID已被占用）
   */
  register(strategyId: string, strategy: QuickJSStrategy): boolean {
    if (!strategyId || typeof strategyId !== 'string') {
      throw new Error('StrategyRegistry.register: strategyId必须是非空字符串');
    }

    // 检查是否已存在
    if (this.registry.has(strategyId)) {
      const existing = this.registry.get(strategyId)!;
      // 如果是同一个实例，允许重复注册（幂等）
      if (existing.strategy === strategy) {
        logger.info(`[StrategyRegistry] 策略 ${strategyId} 已注册（幂等）`);
        return true;
      }
      
      logger.warn(`[StrategyRegistry] 策略ID冲突: ${strategyId}`);
      logger.warn(`  已存在: ${existing.registeredAt}`);
      logger.warn(`  新注册被拒绝`);
      return false;
    }

    // 注册新策略
    const entry: RegistryEntry = {
      strategy,
      registeredAt: Date.now(),
      strategyId,
    };

    this.registry.set(strategyId, entry);
    logger.info(`[StrategyRegistry] 策略已注册: ${strategyId}`);
    
    return true;
  }

  /**
   * 注销策略实例
   * 
   * @param strategyId 策略唯一标识
   * @returns 是否注销成功
   */
  unregister(strategyId: string): boolean {
    if (!this.registry.has(strategyId)) {
      logger.warn(`[StrategyRegistry] 尝试注销不存在的策略: ${strategyId}`);
      return false;
    }

    this.registry.delete(strategyId);
    logger.info(`[StrategyRegistry] 策略已注销: ${strategyId}`);
    return true;
  }

  /**
   * 获取策略实例
   * 
   * @param strategyId 策略唯一标识
   * @returns QuickJSStrategy实例或undefined
   */
  get(strategyId: string): QuickJSStrategy | undefined {
    const entry = this.registry.get(strategyId);
    return entry?.strategy;
  }

  /**
   * 检查策略是否已注册
   * 
   * @param strategyId 策略唯一标识
   * @returns 是否已注册
   */
  has(strategyId: string): boolean {
    return this.registry.has(strategyId);
  }

  /**
   * 获取所有已注册的策略ID
   * 
   * @returns 策略ID数组
   */
  getAllIds(): string[] {
    return Array.from(this.registry.keys());
  }

  /**
   * 获取注册数量
   * 
   * @returns 已注册策略数量
   */
  size(): number {
    return this.registry.size;
  }

  /**
   * 清空注册表
   * 
   * 警告：仅在测试或完全重置时使用
   */
  clear(): void {
    const count = this.registry.size;
    this.registry.clear();
    logger.info(`[StrategyRegistry] 注册表已清空，共 ${count} 个策略`);
  }

  /**
   * 启用/禁用自动注册
   * 
   * 当禁用时，QuickJSStrategy.onInit不会自动注册
   * 
   * @param enabled 是否启用
   */
  setAutoRegister(enabled: boolean): void {
    this.autoRegisterEnabled = enabled;
    logger.info(`[StrategyRegistry] 自动注册已${enabled ? '启用' : '禁用'}`);
  }

  /**
   * 获取自动注册状态
   * 
   * @returns 是否启用自动注册
   */
  isAutoRegisterEnabled(): boolean {
    return this.autoRegisterEnabled;
  }

  /**
   * 获取注册信息
   * 
   * @param strategyId 策略唯一标识
   * @returns 注册信息或undefined
   */
  getEntry(strategyId: string): { strategyId: string; registeredAt: number } | undefined {
    const entry = this.registry.get(strategyId);
    if (!entry) return undefined;
    
    return {
      strategyId: entry.strategyId,
      registeredAt: entry.registeredAt,
    };
  }

  /**
   * 打印注册表状态（调试用）
   */
  debug(): void {
    logger.info('[StrategyRegistry] ========== 注册表状态 ==========');
    logger.info(`  总数: ${this.registry.size}`);
    
    for (const [id, entry] of this.registry) {
      logger.info(`  - ${id}: 注册于 ${new Date(entry.registeredAt).toISOString()}`);
    }
    
    logger.info('[StrategyRegistry] =================================');
  }
}

// 导出单例实例
export const StrategyRegistry = new StrategyRegistryImpl();

// 默认导出
export default StrategyRegistry;
