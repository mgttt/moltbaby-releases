// ============================================================
// HNSW (Hierarchical Navigable Small World) 索引
// 原生TypeScript实现，零第三方依赖
// 支持高维向量近似最近邻搜索 (ANN)
// ============================================================

/**
 * HNSW 节点
 * 存储向量数据和多层邻居连接
 */
class HNSWNode {
  id: number;
  vector: Float32Array;
  // 每层连接的邻居节点ID列表
  connections: number[][];

  constructor(id: number, vector: Float32Array, maxLevel: number) {
    this.id = id;
    this.vector = vector;
    this.connections = new Array(maxLevel + 1).fill(null).map(() => []);
  }
}

/**
 * 搜索结果项
 */
export interface SearchResult {
  id: number;
  score: number;  // cosine相似度，范围[0,1]
}

/**
 * 候选节点（用于搜索时的优先队列）
 */
interface Candidate {
  id: number;
  score: number;
}

/**
 * HNSW 索引
 * 基于"Navigable Small World"图结构的近似最近邻搜索
 * 
 * 参数说明：
 * - M: 每层最大邻居数（默认16）
 * - efConstruction: 构建时的搜索宽度（默认200）
 * - efSearch: 搜索时的搜索宽度（默认50）
 * - mL: 层数因子，控制节点层数分布（默认 1/ln(M)）
 */
export class HNSWIndex {
  private M: number;                    // 最大邻居数
  private Mmax: number;                 // 非0层最大邻居数
  private Mmax0: number;                // 第0层最大邻居数 (2*M)
  private efConstruction: number;       // 构建时搜索宽度
  private efSearch: number;             // 搜索时搜索宽度
  private mL: number;                   // 层数因子
  
  private nodes: Map<number, HNSWNode>; // 所有节点
  private entryPoint: number | null;    // 入口节点
  private maxLevel: number;             // 当前最大层数
  private dimension: number;            // 向量维度
  private size: number;                 // 节点数量

  constructor(options: {
    M?: number;
    efConstruction?: number;
    efSearch?: number;
    dimension: number;
  }) {
    this.M = options.M ?? 16;
    this.Mmax = this.M;
    this.Mmax0 = 2 * this.M;
    this.efConstruction = options.efConstruction ?? 200;
    this.efSearch = options.efSearch ?? 50;
    this.mL = 1 / Math.log(this.M);
    
    this.nodes = new Map();
    this.entryPoint = null;
    this.maxLevel = 0;
    this.dimension = options.dimension;
    this.size = 0;
  }

  /**
   * 计算余弦相似度
   * 返回 [0, 1] 范围，1表示完全相同
   */
  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    if (normA === 0 || normB === 0) return 0;
    
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * 随机选择节点层数
   * 使用指数分布，确保高层节点较少
   */
  private randomLevel(): number {
    let level = 0;
    while (Math.random() < this.mL && level < 16) {
      level++;
    }
    return level;
  }

  /**
   * 搜索最近邻（单层）
   * 贪心算法：从入口点开始，逐步向查询向量靠近
   * 
   * @param query 查询向量
   * @param entry 入口节点ID
   * @param level 搜索层
   * @param ef 搜索宽度
   * @returns 最近邻候选列表
   */
  private searchLayer(
    query: Float32Array,
    entry: number,
    level: number,
    ef: number
  ): Candidate[] {
    // 已访问节点集合
    const visited = new Set<number>();
    // 候选集（按相似度排序）
    const candidates: Candidate[] = [];
    // 结果集（最近邻）
    const results: Candidate[] = [];
    
    const entryNode = this.nodes.get(entry)!;
    const entryScore = this.cosineSimilarity(query, entryNode.vector);
    
    visited.add(entry);
    candidates.push({ id: entry, score: entryScore });
    results.push({ id: entry, score: entryScore });
    
    // 按相似度排序（降序）
    const sortDesc = (a: Candidate, b: Candidate) => b.score - a.score;
    
    while (candidates.length > 0) {
      // 取出当前最优候选
      candidates.sort(sortDesc);
      const current = candidates.shift()!;
      
      // 如果当前最优比结果集中最差的还差，结束搜索
      if (results.length >= ef) {
        results.sort(sortDesc);
        if (current.score < results[ef - 1].score) {
          break;
        }
      }
      
      // 遍历当前节点的邻居
      const node = this.nodes.get(current.id)!;
      const neighbors = node.connections[level] || [];
      
      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;
        
        visited.add(neighborId);
        const neighborNode = this.nodes.get(neighborId)!;
        const score = this.cosineSimilarity(query, neighborNode.vector);
        
        // 如果结果集未满，或当前分数比结果集中最差的好，加入
        if (results.length < ef || score > results[results.length - 1].score) {
          candidates.push({ id: neighborId, score });
          results.push({ id: neighborId, score });
          
          // 保持结果集大小为ef
          if (results.length > ef) {
            results.sort(sortDesc);
            results.pop();
          }
        }
      }
    }
    
    return results.sort(sortDesc);
  }

  /**
   * 选择邻居（启发式）
   * 使用简单的最近邻选择策略
   * 
   * @param candidates 候选节点列表
   * @param M 最大邻居数
   * @returns 选中的邻居ID列表
   */
  private selectNeighbors(candidates: Candidate[], M: number): number[] {
    // 按相似度排序，取前M个
    return candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, M)
      .map(c => c.id);
  }

  /**
   * 插入向量
   * 
   * @param id 向量唯一标识
   * @param vector 向量数据（Float32Array）
   */
  insert(id: number, vector: Float32Array): void {
    // 维度检查
    if (vector.length !== this.dimension) {
      throw new Error(`Dimension mismatch: expected ${this.dimension}, got ${vector.length}`);
    }
    
    // ID冲突检查
    if (this.nodes.has(id)) {
      throw new Error(`Node with id ${id} already exists`);
    }
    
    // 第一个节点
    if (this.entryPoint === null) {
      const level = 0;
      const node = new HNSWNode(id, vector.slice(), level);
      this.nodes.set(id, node);
      this.entryPoint = id;
      this.maxLevel = 0;
      this.size++;
      return;
    }
    
    // 确定新节点层数
    const newLevel = this.randomLevel();
    const node = new HNSWNode(id, vector.slice(), newLevel);
    this.nodes.set(id, node);
    
    // 从入口点开始，逐层向下搜索
    let currentEntry = this.entryPoint;
    
    // 如果新节点层数高于当前最大层，更新入口点
    if (newLevel > this.maxLevel) {
      this.maxLevel = newLevel;
      this.entryPoint = id;
    }
    
    // 从最高层向下搜索
    for (let level = this.maxLevel; level > newLevel; level--) {
      const result = this.searchLayer(vector, currentEntry, level, 1);
      if (result.length > 0) {
        currentEntry = result[0].id;
      }
    }
    
    // 在新节点层数及以下建立连接
    for (let level = Math.min(newLevel, this.maxLevel); level >= 0; level--) {
      const ef = level === 0 ? this.efConstruction : Math.max(this.M, this.efConstruction);
      const candidates = this.searchLayer(vector, currentEntry, level, ef);
      
      // 选择邻居
      const Mmax = level === 0 ? this.Mmax0 : this.Mmax;
      const neighbors = this.selectNeighbors(candidates, this.M);
      
      // 建立双向连接
      node.connections[level] = neighbors;
      
      for (const neighborId of neighbors) {
        const neighbor = this.nodes.get(neighborId)!;
        // 确保邻居的connections数组有足够长度
        while (neighbor.connections.length <= level) {
          neighbor.connections.push([]);
        }
        if (!neighbor.connections[level].includes(id)) {
          neighbor.connections[level].push(id);
          
          // 如果邻居连接数超过限制，修剪
          if (neighbor.connections[level].length > Mmax) {
            // 重新计算与邻居的连接相似度
            const neighborCandidates: Candidate[] = neighbor.connections[level].map(nid => {
              const n = this.nodes.get(nid)!;
              return {
                id: nid,
                score: this.cosineSimilarity(neighbor.vector, n.vector)
              };
            });
            neighbor.connections[level] = this.selectNeighbors(neighborCandidates, Mmax);
          }
        }
      }
      
      // 更新入口点为当前层最近的节点
      if (candidates.length > 0) {
        currentEntry = candidates[0].id;
      }
    }
    
    this.size++;
  }

  /**
   * 搜索K近邻
   * 
   * @param vector 查询向量
   * @param k 返回结果数量
   * @returns 最近邻列表（按相似度降序）
   */
  search(vector: Float32Array, k: number): SearchResult[] {
    // 维度检查
    if (vector.length !== this.dimension) {
      throw new Error(`Dimension mismatch: expected ${this.dimension}, got ${vector.length}`);
    }
    
    // 空索引检查
    if (this.entryPoint === null || this.size === 0) {
      return [];
    }
    
    // 调整k
    k = Math.min(k, this.size);
    
    // 从入口点开始，逐层向下搜索
    let currentEntry = this.entryPoint;
    
    // 从最高层向下搜索到第1层
    for (let level = this.maxLevel; level >= 1; level--) {
      const result = this.searchLayer(vector, currentEntry, level, 1);
      if (result.length > 0) {
        currentEntry = result[0].id;
      }
    }
    
    // 在第0层进行完整搜索
    const results = this.searchLayer(vector, currentEntry, 0, Math.max(k, this.efSearch));
    
    // 返回前k个结果
    return results
      .slice(0, k)
      .map(r => ({ id: r.id, score: r.score }));
  }

  /**
   * 批量插入（优化版本）
   * 对于大量数据，可以先用少量efConstruction构建，再调整
   * 
   * @param items 待插入的向量列表
   */
  insertBatch(items: { id: number; vector: Float32Array }[]): void {
    for (const item of items) {
      this.insert(item.id, item.vector);
    }
  }

  /**
   * 删除节点
   * 注意：HNSW的删除是软删除，需要重建连接
   * 
   * @param id 节点ID
   * @returns 是否成功删除
   */
  delete(id: number): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;
    
    // 从所有邻居的连接中移除该节点
    for (let level = 0; level <= this.maxLevel; level++) {
      const neighbors = node.connections[level] || [];
      for (const neighborId of neighbors) {
        const neighbor = this.nodes.get(neighborId);
        if (neighbor) {
          neighbor.connections[level] = neighbor.connections[level].filter(nid => nid !== id);
        }
      }
    }
    
    // 如果删除的是入口点，需要更新
    if (this.entryPoint === id) {
      // 找一个新的入口点（层数最高的节点）
      let newEntry: number | null = null;
      let maxLevel = -1;
      
      for (const [nodeId, node] of this.nodes) {
        if (nodeId !== id && node.connections.length > maxLevel) {
          maxLevel = node.connections.length;
          newEntry = nodeId;
        }
      }
      
      this.entryPoint = newEntry;
      this.maxLevel = Math.max(0, maxLevel - 1);
    }
    
    this.nodes.delete(id);
    this.size--;
    
    return true;
  }

  /**
   * 获取索引统计信息
   */
  getStats(): {
    size: number;
    dimension: number;
    maxLevel: number;
    M: number;
    efConstruction: number;
    efSearch: number;
  } {
    return {
      size: this.size,
      dimension: this.dimension,
      maxLevel: this.maxLevel,
      M: this.M,
      efConstruction: this.efConstruction,
      efSearch: this.efSearch
    };
  }

  /**
   * 获取节点数量
   */
  getSize(): number {
    return this.size;
  }

  /**
   * 清空索引
   */
  clear(): void {
    this.nodes.clear();
    this.entryPoint = null;
    this.maxLevel = 0;
    this.size = 0;
  }

  /**
   * 序列化索引到JSON
   * 注意：对于大规模数据，建议使用二进制格式
   */
  serialize(): object {
    const nodes: Record<number, { vector: number[]; connections: number[][] }> = {};
    
    for (const [id, node] of this.nodes) {
      nodes[id] = {
        vector: Array.from(node.vector),
        connections: node.connections
      };
    }
    
    return {
      M: this.M,
      efConstruction: this.efConstruction,
      efSearch: this.efSearch,
      dimension: this.dimension,
      entryPoint: this.entryPoint,
      maxLevel: this.maxLevel,
      size: this.size,
      nodes
    };
  }

  /**
   * 从JSON反序列化索引
   */
  static deserialize(data: any): HNSWIndex {
    const index = new HNSWIndex({
      M: data.M,
      efConstruction: data.efConstruction,
      efSearch: data.efSearch,
      dimension: data.dimension
    });
    
    index.entryPoint = data.entryPoint;
    index.maxLevel = data.maxLevel;
    index.size = data.size;
    
    for (const [id, nodeData] of Object.entries(data.nodes)) {
      const node = new HNSWNode(
        parseInt(id),
        new Float32Array(nodeData.vector as number[]),
        nodeData.connections.length - 1
      );
      node.connections = nodeData.connections as number[][];
      index.nodes.set(parseInt(id), node);
    }
    
    return index;
  }

  /**
   * 二进制序列化格式：
   * Header (32 bytes):
   *   - magic: 4 bytes "HNSW"
   *   - version: 4 bytes uint32
   *   - M: 4 bytes uint32
   *   - efConstruction: 4 bytes uint32
   *   - efSearch: 4 bytes uint32
   *   - dimension: 4 bytes uint32
   *   - entryPoint: 4 bytes int32 (-1 for null)
   *   - maxLevel: 4 bytes uint32
   *   - size: 4 bytes uint32
   * 
   * Nodes section:
   *   For each node:
   *     - id: 4 bytes uint32
   *     - numLevels: 4 bytes uint32
   *     - vector: dimension * 4 bytes (float32)
   *     - For each level:
   *       - numConnections: 4 bytes uint32
   *       - connections: numConnections * 4 bytes (uint32)
   */

  /**
   * 序列化索引到二进制格式
   * 比JSON更快、更紧凑，适合大规模数据
   */
  serializeBinary(): Uint8Array {
    // 计算总大小
    let totalSize = 32; // Header
    
    for (const [id, node] of this.nodes) {
      totalSize += 8; // id + numLevels
      totalSize += this.dimension * 4; // vector
      for (let level = 0; level < node.connections.length; level++) {
        totalSize += 4; // numConnections count
        const connections = node.connections[level];
        if (connections) {
          totalSize += connections.length * 4; // connections data
        }
      }
    }
    
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    const uint8View = new Uint8Array(buffer);
    let offset = 0;
    
    // Write header
    const magic = new TextEncoder().encode("HNSW");
    uint8View.set(magic, offset);
    offset += 4;
    
    view.setUint32(offset, 1, true); offset += 4; // version
    view.setUint32(offset, this.M, true); offset += 4;
    view.setUint32(offset, this.efConstruction, true); offset += 4;
    view.setUint32(offset, this.efSearch, true); offset += 4;
    view.setUint32(offset, this.dimension, true); offset += 4;
    view.setInt32(offset, this.entryPoint ?? -1, true); offset += 4;
    view.setUint32(offset, this.maxLevel, true); offset += 4;
    view.setUint32(offset, this.size, true); offset += 4;
    
    // Write nodes
    for (const [id, node] of this.nodes) {
      view.setUint32(offset, id, true); offset += 4;
      view.setUint32(offset, node.connections.length, true); offset += 4;
      
      // Write vector
      const floatView = new Float32Array(buffer, offset, this.dimension);
      floatView.set(node.vector);
      offset += this.dimension * 4;
      
      // Write connections for each level
      for (let level = 0; level < node.connections.length; level++) {
        const connections = node.connections[level];
        if (connections) {
          view.setUint32(offset, connections.length, true); offset += 4;
          for (const connId of connections) {
            view.setUint32(offset, connId, true); offset += 4;
          }
        } else {
          view.setUint32(offset, 0, true); offset += 4;
        }
      }
    }
    
    return uint8View;
  }

  /**
   * 从二进制格式反序列化索引
   */
  static deserializeBinary(data: Uint8Array): HNSWIndex {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 0;
    
    // Read header
    const magic = new TextDecoder().decode(data.slice(0, 4));
    if (magic !== "HNSW") {
      throw new Error("Invalid binary format: wrong magic number");
    }
    offset += 4;
    
    const version = view.getUint32(offset, true); offset += 4;
    if (version !== 1) {
      throw new Error(`Unsupported binary format version: ${version}`);
    }
    
    const M = view.getUint32(offset, true); offset += 4;
    const efConstruction = view.getUint32(offset, true); offset += 4;
    const efSearch = view.getUint32(offset, true); offset += 4;
    const dimension = view.getUint32(offset, true); offset += 4;
    const entryPoint = view.getInt32(offset, true); offset += 4;
    const maxLevel = view.getUint32(offset, true); offset += 4;
    const size = view.getUint32(offset, true); offset += 4;
    
    const index = new HNSWIndex({
      M,
      efConstruction,
      efSearch,
      dimension
    });
    
    index.entryPoint = entryPoint >= 0 ? entryPoint : null;
    index.maxLevel = maxLevel;
    index.size = size;
    
    // Read nodes
    for (let i = 0; i < size; i++) {
      const id = view.getUint32(offset, true); offset += 4;
      const numLevels = view.getUint32(offset, true); offset += 4;
      
      // Read vector
      const vector = new Float32Array(data.buffer, data.byteOffset + offset, dimension);
      offset += dimension * 4;
      
      const node = new HNSWNode(id, new Float32Array(vector), numLevels - 1);
      
      // Read connections for each level
      for (let level = 0; level < numLevels; level++) {
        const numConnections = view.getUint32(offset, true); offset += 4;
        const connections: number[] = [];
        
        for (let j = 0; j < numConnections; j++) {
          connections.push(view.getUint32(offset, true));
          offset += 4;
        }
        
        node.connections[level] = connections;
      }
      
      index.nodes.set(id, node);
    }
    
    return index;
  }
}

// 默认导出
export default HNSWIndex;
