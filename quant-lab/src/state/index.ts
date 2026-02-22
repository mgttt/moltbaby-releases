import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * 状态管理器 - 负责策略状态的持久化（JSON 文件）
 * 
 * 每个策略有独立的状态文件：{stateDir}/{strategyId}.json
 */
export class StateManager {
  private stateDir: string;

  /**
   * 创建状态管理器
   * @param stateDir 状态文件保存目录（默认：~/.quant-lab/state/）
   */
  constructor(stateDir?: string) {
    // 默认：~/.quant-lab/state/ （支持环境变量 QUANT_STATE_DIR 覆盖）
    const defaultStateDir = process.env.QUANT_STATE_DIR || 
                           `${process.env.HOME || process.env.USERPROFILE || '.'}/.quant-lab/state`;
    
    this.stateDir = (stateDir || defaultStateDir).replace(/\/$/, ''); // 去除尾部斜杠
  }

  /**
   * 获取状态文件路径
   * @param strategyId 策略 ID
   * @returns 完整文件路径
   */
  private getStatePath(strategyId: string): string {
    return `${this.stateDir}/${strategyId}.json`;
  }

  /**
   * 加载策略状态
   * @param strategyId 策略 ID
   * @returns 状态对象（如果不存在返回空对象）
   */
  async load(strategyId: string): Promise<Record<string, any>> {
    const statePath = this.getStatePath(strategyId);
    
    try {
      const content = await readFile(statePath, 'utf-8');
      const data = JSON.parse(content);
      
      if (typeof data !== 'object' || data === null) {
        console.warn(`[StateManager] Invalid state format for ${strategyId}, using empty state`);
        return {};
      }
      
      return data;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // 文件不存在，返回空状态
        return {};
      }
      
      console.error(`[StateManager] Failed to load state for ${strategyId}: ${error.message}`);
      return {};
    }
  }

  /**
   * 保存策略状态
   * @param strategyId 策略 ID
   * @param state 状态对象
   */
  async save(strategyId: string, state: Record<string, any>): Promise<void> {
    const statePath = this.getStatePath(strategyId);
    
    try {
      // 确保目录存在
      await mkdir(dirname(statePath), { recursive: true });

      // 原子写入：先写 .tmp，再 rename（POSIX 保证原子性，崩溃不会截断 JSON）
      const tmpPath = statePath + '.tmp';
      await writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
      await rename(tmpPath, statePath);
    } catch (error: any) {
      console.error(`[StateManager] Failed to save state for ${strategyId}: ${error.message}`);
      throw new Error(`State save failed: ${error.message}`);
    }
  }

  /**
   * 删除策略状态
   * @param strategyId 策略 ID
   */
  async delete(strategyId: string): Promise<void> {
    const statePath = this.getStatePath(strategyId);
    
    try {
      const tmpPath = statePath + '.tmp';
      await writeFile(tmpPath, '{}', 'utf-8');
      await rename(tmpPath, statePath);
    } catch (error: any) {
      // 忽略错误
    }
  }

  /**
   * 检查状态是否存在
   * @param strategyId 策略 ID
   * @returns 是否存在
   */
  async exists(strategyId: string): Promise<boolean> {
    const statePath = this.getStatePath(strategyId);
    
    try {
      await readFile(statePath, 'utf-8');
      return true;
    } catch {
      return false;
    }
  }
}
