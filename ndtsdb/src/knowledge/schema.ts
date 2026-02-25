/**
 * Knowledge Entry Schema
 * Phase 8: ndtsdb知识存储
 */

export interface KnowledgeEntry {
  id: string;        // nanoid
  agentId: string;   // bot-000 等
  type: string;      // fact/decision/pitfall/principle
  tags: string[];
  text: string;
  createdAt: number; // timestamp ms
}

export type KnowledgeType = 'fact' | 'decision' | 'pitfall' | 'principle';

export const VALID_KNOWLEDGE_TYPES: KnowledgeType[] = ['fact', 'decision', 'pitfall', 'principle'];

export interface QueryFilter {
  agentId?: string;
  type?: string;
  tags?: string[];
  limit?: number;
}
