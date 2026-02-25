/**
 * Knowledge Store Implementation
 * Phase 8: ndtsdb知识存储
 * 
 * SQLite存储，路径 ~/.botcorp/knowledge.db
 */

import { Database } from 'bun:sqlite';
import type { KnowledgeEntry, QueryFilter } from './schema.ts';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DB_DIR = join(homedir(), '.botcorp');
const DB_PATH = join(DB_DIR, 'knowledge.db');

let db: Database | null = null;

function getDb(): Database {
  if (!db) {
    mkdirSync(DB_DIR, { recursive: true });
    db = new Database(DB_PATH);
    initSchema();
  }
  return db;
}

function initSchema(): void {
  const database = getDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS knowledge (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      tags TEXT NOT NULL,  -- JSON array
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    
    CREATE INDEX IF NOT EXISTS idx_knowledge_agent ON knowledge(agent_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge(type);
    CREATE INDEX IF NOT EXISTS idx_knowledge_created ON knowledge(created_at);
  `);
}

export function insert(entry: KnowledgeEntry): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO knowledge (id, agent_id, type, tags, text, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    entry.id,
    entry.agentId,
    entry.type,
    JSON.stringify(entry.tags),
    entry.text,
    entry.createdAt
  );
}

export function query(filter: QueryFilter = {}): KnowledgeEntry[] {
  const database = getDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  
  if (filter.agentId !== undefined) {
    conditions.push('agent_id = ?');
    params.push(filter.agentId);
  }
  
  if (filter.type !== undefined) {
    conditions.push('type = ?');
    params.push(filter.type);
  }
  
  if (filter.tags !== undefined && filter.tags.length > 0) {
    // LIKE匹配任意tag
    const tagConditions = filter.tags.map(() => 'tags LIKE ?').join(' OR ');
    conditions.push(`(${tagConditions})`);
    filter.tags.forEach(tag => {
      params.push(`%"${tag}"%`);
    });
  }
  
  let sql = 'SELECT * FROM knowledge';
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY created_at DESC';
  
  if (filter.limit !== undefined && filter.limit > 0) {
    sql += ' LIMIT ?';
    params.push(filter.limit);
  }
  
  const stmt = database.prepare(sql);
  const rows = stmt.all(...params) as Array<{
    id: string;
    agent_id: string;
    type: string;
    tags: string;
    text: string;
    created_at: number;
  }>;
  
  return rows.map(row => ({
    id: row.id,
    agentId: row.agent_id,
    type: row.type,
    tags: JSON.parse(row.tags) as string[],
    text: row.text,
    createdAt: row.created_at
  }));
}

export function close(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// 测试辅助函数：清空表
export function clearAll(): void {
  const database = getDb();
  database.exec('DELETE FROM knowledge');
}

// 获取总数
export function count(): number {
  const database = getDb();
  const result = database.query('SELECT COUNT(*) as count FROM knowledge').get() as { count: number };
  return result.count;
}
