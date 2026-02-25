/**
 * Knowledge Store Tests
 * Phase 8: ndtsdb知识存储
 * 
 * 至少10个测试，覆盖 insert/query/filter
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { insert, query, close, clearAll, count } from '../src/knowledge/store.ts';
import type { KnowledgeEntry } from '../src/knowledge/schema.ts';

function createEntry(partial: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: partial.id || `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    agentId: partial.agentId || 'bot-000',
    type: partial.type || 'fact',
    tags: partial.tags || ['test'],
    text: partial.text || 'Test knowledge entry',
    createdAt: partial.createdAt || Date.now()
  };
}

describe('Knowledge Store', () => {
  beforeEach(() => {
    clearAll();
  });
  
  afterAll(() => {
    close();
  });

  // Test 1: 基础插入
  test('insert should store a knowledge entry', () => {
    const entry = createEntry();
    insert(entry);
    
    expect(count()).toBe(1);
  });

  // Test 2: 查询所有
  test('query should return all entries when no filter', () => {
    insert(createEntry({ id: 'id1', agentId: 'bot-001' }));
    insert(createEntry({ id: 'id2', agentId: 'bot-002' }));
    
    const results = query();
    
    expect(results.length).toBe(2);
  });

  // Test 3: 按agentId过滤
  test('query should filter by agentId', () => {
    insert(createEntry({ id: 'id1', agentId: 'bot-001' }));
    insert(createEntry({ id: 'id2', agentId: 'bot-002' }));
    insert(createEntry({ id: 'id3', agentId: 'bot-001' }));
    
    const results = query({ agentId: 'bot-001' });
    
    expect(results.length).toBe(2);
    expect(results.every(r => r.agentId === 'bot-001')).toBe(true);
  });

  // Test 4: 按type过滤
  test('query should filter by type', () => {
    insert(createEntry({ id: 'id1', type: 'fact' }));
    insert(createEntry({ id: 'id2', type: 'decision' }));
    insert(createEntry({ id: 'id3', type: 'fact' }));
    insert(createEntry({ id: 'id4', type: 'pitfall' }));
    
    const results = query({ type: 'fact' });
    
    expect(results.length).toBe(2);
    expect(results.every(r => r.type === 'fact')).toBe(true);
  });

  // Test 5: 按tag过滤（单tag）
  test('query should filter by single tag', () => {
    insert(createEntry({ id: 'id1', tags: ['api', 'error'] }));
    insert(createEntry({ id: 'id2', tags: ['ui', 'design'] }));
    insert(createEntry({ id: 'id3', tags: ['api', 'success'] }));
    
    const results = query({ tags: ['api'] });
    
    expect(results.length).toBe(2);
    expect(results.every(r => r.tags.includes('api'))).toBe(true);
  });

  // Test 6: 按tag过滤（多tag）
  test('query should filter by multiple tags (OR logic)', () => {
    insert(createEntry({ id: 'id1', tags: ['api'] }));
    insert(createEntry({ id: 'id2', tags: ['ui'] }));
    insert(createEntry({ id: 'id3', tags: ['database'] }));
    insert(createEntry({ id: 'id4', tags: ['api', 'ui'] }));
    
    const results = query({ tags: ['api', 'ui'] });
    
    expect(results.length).toBe(3);
  });

  // Test 7: 组合过滤
  test('query should support combined filters', () => {
    insert(createEntry({ id: 'id1', agentId: 'bot-001', type: 'fact', tags: ['api'] }));
    insert(createEntry({ id: 'id2', agentId: 'bot-001', type: 'decision', tags: ['api'] }));
    insert(createEntry({ id: 'id3', agentId: 'bot-002', type: 'fact', tags: ['api'] }));
    insert(createEntry({ id: 'id4', agentId: 'bot-001', type: 'fact', tags: ['ui'] }));
    
    const results = query({ agentId: 'bot-001', type: 'fact', tags: ['api'] });
    
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('id1');
  });

  // Test 8: limit限制
  test('query should respect limit', () => {
    for (let i = 0; i < 10; i++) {
      insert(createEntry({ id: `id${i}`, createdAt: Date.now() + i }));
    }
    
    const results = query({ limit: 5 });
    
    expect(results.length).toBe(5);
  });

  // Test 9: 按时间倒序
  test('query should return results in descending order by createdAt', () => {
    insert(createEntry({ id: 'id1', createdAt: 1000 }));
    insert(createEntry({ id: 'id2', createdAt: 3000 }));
    insert(createEntry({ id: 'id3', createdAt: 2000 }));
    
    const results = query();
    
    expect(results[0].id).toBe('id2');
    expect(results[1].id).toBe('id3');
    expect(results[2].id).toBe('id1');
  });

  // Test 10: 所有knowledge types支持
  test('should support all knowledge types', () => {
    const types = ['fact', 'decision', 'pitfall', 'principle'] as const;
    
    types.forEach((type, i) => {
      insert(createEntry({ id: `id${i}`, type }));
    });
    
    types.forEach((type, i) => {
      const results = query({ type });
      expect(results.length).toBe(1);
      expect(results[0].type).toBe(type);
    });
  });

  // Test 11: 空tag过滤返回空结果
  test('query with non-matching tags should return empty', () => {
    insert(createEntry({ id: 'id1', tags: ['api'] }));
    insert(createEntry({ id: 'id2', tags: ['ui'] }));
    
    const results = query({ tags: ['database'] });
    
    expect(results.length).toBe(0);
  });

  // Test 12: 数据完整性验证
  test('inserted entry should have all fields preserved', () => {
    const entry: KnowledgeEntry = {
      id: 'test-id-123',
      agentId: 'bot-00c',
      type: 'pitfall',
      tags: ['performance', 'optimization', 'cache'],
      text: 'Cache invalidation is one of the hardest problems in computer science',
      createdAt: 1700000000000
    };
    
    insert(entry);
    const results = query({ agentId: 'bot-00c' });
    
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(entry.id);
    expect(results[0].agentId).toBe(entry.agentId);
    expect(results[0].type).toBe(entry.type);
    expect(results[0].tags).toEqual(entry.tags);
    expect(results[0].text).toBe(entry.text);
    expect(results[0].createdAt).toBe(entry.createdAt);
  });
});
