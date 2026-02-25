// ============================================================
// plugin-registry.js - ndtsdb-cli 插件注册中心
// ============================================================

/**
 * PluginRegistry - 插件注册表
 * 
 * 允许插件向全局注册自定义函数，供用户脚本调用。
 */

class PluginRegistry {
  constructor() {
    this.functions = new Map();
    this.plugins = [];
  }

  /**
   * 注册一个函数到全局命名空间
   * @param {string} name - 函数名
   * @param {Function} fn - 函数实现
   * @param {Object} options - 可选配置
   */
  register(name, fn, options = {}) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('Plugin register: name must be a non-empty string');
    }
    if (typeof fn !== 'function') {
      throw new Error('Plugin register: fn must be a function');
    }
    
    this.functions.set(name, {
      fn,
      options: {
        description: options.description || '',
        author: options.author || '',
        version: options.version || '1.0.0',
        ...options
      }
    });

    // 同时注册到 globalThis，方便用户直接调用
    globalThis[name] = fn;
    
    return this;
  }

  /**
   * 获取已注册的函数
   * @param {string} name - 函数名
   * @returns {Function|null}
   */
  get(name) {
    const entry = this.functions.get(name);
    return entry ? entry.fn : null;
  }

  /**
   * 检查函数是否已注册
   * @param {string} name - 函数名
   * @returns {boolean}
   */
  has(name) {
    return this.functions.has(name);
  }

  /**
   * 注销一个函数
   * @param {string} name - 函数名
   */
  unregister(name) {
    this.functions.delete(name);
    if (globalThis[name]) {
      delete globalThis[name];
    }
  }

  /**
   * 列出所有已注册的函数
   * @returns {Array<{name: string, description: string, author: string, version: string}>
   */
  list() {
    const result = [];
    for (const [name, entry] of this.functions) {
      result.push({
        name,
        ...entry.options
      });
    }
    return result;
  }

  /**
   * 清空所有注册的函数
   */
  clear() {
    for (const name of this.functions.keys()) {
      if (globalThis[name]) {
        delete globalThis[name];
      }
    }
    this.functions.clear();
    this.plugins = [];
  }
}

// 创建全局单例
const registry = new PluginRegistry();
globalThis.PluginRegistry = PluginRegistry;
globalThis.registry = registry;
