// ============================================================
// Symbol 字典编码器
// 借鉴 QuestDB Symbol 类型：字符串 → 整数编码
// 大幅节省存储空间，加速过滤查询
// ============================================================

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export class SymbolTable {
  private nameToId: Map<string, number> = new Map();
  private idToName: Map<number, string> = new Map();
  private nextId = 0;
  private readonly filePath: string;
  private dirty = false;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  /**
   * 获取 symbol ID（不存在则返回 undefined，不会创建）
   */
  getId(symbol: string): number | undefined {
    return this.nameToId.get(symbol);
  }

  has(symbol: string): boolean {
    return this.nameToId.has(symbol);
  }

  /**
   * 获取或创建 symbol ID
   * QuestDB 风格：高频 symbol 用 4 字节整数代替变长字符串
   */
  getOrCreateId(symbol: string): number {
    let id = this.nameToId.get(symbol);
    if (id !== undefined) {
      return id;
    }

    // 新 symbol，分配 ID
    id = this.nextId++;
    this.nameToId.set(symbol, id);
    this.idToName.set(id, symbol);
    this.dirty = true;
    return id;
  }

  /**
   * 根据 ID 获取 symbol 名称
   */
  getName(id: number): string | undefined {
    return this.idToName.get(id);
  }

  /**
   * 批量获取 IDs
   */
  getIds(symbols: string[]): number[] {
    return symbols.map(s => this.getOrCreateId(s));
  }

  /**
   * 获取所有 symbol
   */
  getAllSymbols(): string[] {
    return Array.from(this.nameToId.keys());
  }

  /**
   * 持久化到磁盘
   */
  save(): void {
    if (!this.dirty) return;

    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const data = {
      symbols: Array.from(this.nameToId.entries()),
      nextId: this.nextId
    };

    writeFileSync(this.filePath, JSON.stringify(data));
    this.dirty = false;
  }

  /**
   * 从磁盘加载
   */
  private load(): void {
    if (!existsSync(this.filePath)) return;

    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      this.nameToId = new Map(data.symbols);
      this.idToName = new Map(data.symbols.map(([k, v]: [string, number]) => [v, k]));
      this.nextId = data.nextId;
    } catch {
      // 文件损坏，重置
      this.nameToId.clear();
      this.idToName.clear();
      this.nextId = 0;
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): { count: number; fileSize: number } {
    const stats = { count: this.nameToId.size, fileSize: 0 };
    if (existsSync(this.filePath)) {
      const file = Bun.file(this.filePath);
      stats.fileSize = file.size;
    }
    return stats;
  }
}
