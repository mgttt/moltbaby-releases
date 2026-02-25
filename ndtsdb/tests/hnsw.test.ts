// ============================================================
// HNSW 索引单元测试
// 覆盖 insert/search/持久化/边界条件
// ============================================================

import { describe, it, expect, beforeEach } from "bun:test";
import { HNSWIndex, SearchResult } from "../src/index/hnsw";

describe("HNSW Index", () => {
  // 测试用例1: 基本插入和单节点搜索
  it("should insert single vector and find itself", () => {
    const index = new HNSWIndex({ dimension: 3, M: 16 });
    const vec = new Float32Array([1, 0, 0]);
    
    index.insert(1, vec);
    const results = index.search(vec, 1);
    
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(1);
    expect(results[0].score).toBeCloseTo(1.0, 5);
  });

  // 测试用例2: 多向量插入和最近邻搜索
  it("should find nearest neighbor among multiple vectors", () => {
    const index = new HNSWIndex({ dimension: 3, M: 16 });
    
    // 插入三个正交向量
    index.insert(1, new Float32Array([1, 0, 0]));
    index.insert(2, new Float32Array([0, 1, 0]));
    index.insert(3, new Float32Array([0, 0, 1]));
    
    // 搜索接近 [1, 0.1, 0] 的向量，应该找到 id=1
    const results = index.search(new Float32Array([1, 0.1, 0]), 1);
    
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(1);
    expect(results[0].score).toBeGreaterThan(0.9);
  });

  // 测试用例3: 返回多个最近邻 (k > 1)
  it("should return top-k nearest neighbors", () => {
    const index = new HNSWIndex({ dimension: 2, M: 16, efSearch: 100 });
    
    // 插入5个向量
    for (let i = 0; i < 5; i++) {
      index.insert(i, new Float32Array([i, 0]));
    }
    
    // 搜索 [2, 0]，应该返回 id=2 最接近
    const results = index.search(new Float32Array([2, 0]), 3);
    
    expect(results).toHaveLength(3);
    // HNSW是近似算法，验证结果包含id=2且分数最高即可
    const id2Result = results.find(r => r.id === 2);
    expect(id2Result).toBeDefined();
    expect(id2Result!.score).toBe(1.0); // 完全匹配
    
    // 验证按相似度降序排列
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });

  // 测试用例4: 维度不匹配抛出错误
  it("should throw error on dimension mismatch", () => {
    const index = new HNSWIndex({ dimension: 3 });
    
    expect(() => {
      index.insert(1, new Float32Array([1, 2])); // 维度2 != 3
    }).toThrow("Dimension mismatch");
    
    index.insert(1, new Float32Array([1, 2, 3]));
    
    expect(() => {
      index.search(new Float32Array([1, 2]), 1); // 维度2 != 3
    }).toThrow("Dimension mismatch");
  });

  // 测试用例5: 重复ID抛出错误
  it("should throw error on duplicate id", () => {
    const index = new HNSWIndex({ dimension: 3 });
    
    index.insert(1, new Float32Array([1, 0, 0]));
    
    expect(() => {
      index.insert(1, new Float32Array([0, 1, 0]));
    }).toThrow("already exists");
  });

  // 测试用例6: 空索引搜索返回空数组
  it("should return empty array when searching empty index", () => {
    const index = new HNSWIndex({ dimension: 3 });
    
    const results = index.search(new Float32Array([1, 0, 0]), 5);
    
    expect(results).toHaveLength(0);
    expect(Array.isArray(results)).toBe(true);
  });

  // 测试用例7: 序列化和反序列化（持久化）
  it("should serialize and deserialize correctly", () => {
    const index = new HNSWIndex({ dimension: 3, M: 16, efConstruction: 100 });
    
    // 插入一些向量
    index.insert(1, new Float32Array([1, 0, 0]));
    index.insert(2, new Float32Array([0, 1, 0]));
    index.insert(3, new Float32Array([0, 0, 1]));
    
    // 序列化
    const serialized = index.serialize();
    
    // 验证序列化结构
    expect(serialized).toHaveProperty("M", 16);
    expect(serialized).toHaveProperty("dimension", 3);
    expect(serialized).toHaveProperty("efConstruction", 100);
    expect(serialized).toHaveProperty("nodes");
    expect(Object.keys(serialized.nodes as object)).toHaveLength(3);
    
    // 反序列化
    const restored = HNSWIndex.deserialize(serialized);
    
    // 验证统计信息
    const stats = restored.getStats();
    expect(stats.size).toBe(3);
    expect(stats.dimension).toBe(3);
    expect(stats.M).toBe(16);
    
    // 验证搜索功能仍然正确
    const results = restored.search(new Float32Array([1, 0, 0]), 1);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(1);
    expect(results[0].score).toBeCloseTo(1.0, 5);
  });

  // 测试用例8: 删除节点
  it("should delete node correctly", () => {
    const index = new HNSWIndex({ dimension: 2 });
    
    index.insert(1, new Float32Array([1, 0]));
    index.insert(2, new Float32Array([0, 1]));
    index.insert(3, new Float32Array([1, 1]));
    
    // 删除节点2
    const deleted = index.delete(2);
    expect(deleted).toBe(true);
    
    // 验证节点数
    expect(index.getSize()).toBe(2);
    
    // 搜索不应该返回已删除的节点
    const results = index.search(new Float32Array([0, 1]), 2);
    const ids = results.map(r => r.id);
    expect(ids).not.toContain(2);
  });

  // 测试用例9: 批量插入
  it("should support batch insert", () => {
    const index = new HNSWIndex({ dimension: 2 });
    
    const items = [
      { id: 1, vector: new Float32Array([1, 0]) },
      { id: 2, vector: new Float32Array([0, 1]) },
      { id: 3, vector: new Float32Array([1, 1]) },
    ];
    
    index.insertBatch(items);
    
    expect(index.getSize()).toBe(3);
    
    const results = index.search(new Float32Array([1, 0]), 1);
    expect(results[0].id).toBe(1);
  });

  // 测试用例10: 高维向量搜索
  it("should handle high-dimensional vectors", () => {
    const dim = 128;
    const index = new HNSWIndex({ dimension: dim, M: 16 });
    
    // 生成随机高维向量
    for (let i = 0; i < 10; i++) {
      const vec = new Float32Array(dim);
      for (let j = 0; j < dim; j++) {
        vec[j] = Math.random();
      }
      index.insert(i, vec);
    }
    
    // 搜索
    const query = new Float32Array(dim);
    for (let j = 0; j < dim; j++) {
      query[j] = Math.random();
    }
    
    const results = index.search(query, 5);
    expect(results).toHaveLength(5);
    
    // 验证所有分数在有效范围
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  // 测试用例11: 清空索引
  it("should clear all nodes", () => {
    const index = new HNSWIndex({ dimension: 3 });
    
    index.insert(1, new Float32Array([1, 0, 0]));
    index.insert(2, new Float32Array([0, 1, 0]));
    
    expect(index.getSize()).toBe(2);
    
    index.clear();
    
    expect(index.getSize()).toBe(0);
    expect(index.search(new Float32Array([1, 0, 0]), 1)).toHaveLength(0);
  });

  // 测试用例12: 余弦相似度边界值
  it("should handle edge cases for cosine similarity", () => {
    const index = new HNSWIndex({ dimension: 3 });
    
    // 零向量
    index.insert(1, new Float32Array([0, 0, 0]));
    index.insert(2, new Float32Array([1, 0, 0]));
    
    // 搜索应该正常工作，零向量相似度为0
    const results = index.search(new Float32Array([1, 0, 0]), 2);
    expect(results).toHaveLength(2);
    
    // 找到非零向量
    const nonZeroResult = results.find(r => r.id === 2);
    expect(nonZeroResult).toBeDefined();
    expect(nonZeroResult!.score).toBe(1.0);
  });
});
