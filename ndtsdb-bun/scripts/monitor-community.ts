#!/usr/bin/env bun
/**
 * ndtsdb Community Monitor
 * 
 * 监控 GitHub / HackerNews / Reddit 上的时序数据库讨论
 * 
 * 用法:
 *   bun run scripts/monitor-community.ts
 *   bun run scripts/monitor-community.ts --dry-run
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const STATE_FILE = './data/monitor-state.json';
const OUTPUT_FILE = './data/monitor-results.json';

interface MonitorState {
  lastRun: string;
  processedIds: string[];
}

interface DiscussionItem {
  id: string;
  source: 'github' | 'hackernews' | 'reddit';
  title: string;
  url: string;
  createdAt: string;
  relevanceScore: number;
  keywords: string[];
}

// ============================================================
// 关键词配置
// ============================================================

const KEYWORDS = {
  primary: [
    'time series database',
    'tsdb',
    'timeseries',
    'time-series',
  ],
  secondary: [
    'embedded database',
    'typescript database',
    'iot data',
    'sensor data',
    'tick data',
    'financial data',
    'kline',
    'candlestick',
    'influxdb alternative',
    'timescaledb alternative',
  ],
  competitors: [
    'influxdb',
    'timescaledb',
    'questdb',
    'tdengine',
    'clickhouse time series',
  ],
};

// ============================================================
// GitHub Search
// ============================================================

async function searchGitHubDiscussions(): Promise<DiscussionItem[]> {
  const results: DiscussionItem[] = [];
  
  // Search GitHub Issues/Discussions
  const queries = [
    'time series database embedded',
    'typescript tsdb',
    'influxdb embedded alternative',
  ];

  for (const query of queries) {
    try {
      const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}+created:>=${getDateWeekAgo()}&sort=created&order=desc&per_page=10`;
      const resp = await fetch(url, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'ndtsdb-monitor',
        },
      });

      if (!resp.ok) {
        console.log(`GitHub API error: ${resp.status}`);
        continue;
      }

      const data = await resp.json();
      for (const item of data.items || []) {
        const keywords = findMatchingKeywords(item.title + ' ' + (item.body || ''));
        if (keywords.length > 0) {
          results.push({
            id: `github-${item.id}`,
            source: 'github',
            title: item.title,
            url: item.html_url,
            createdAt: item.created_at,
            relevanceScore: keywords.length,
            keywords,
          });
        }
      }
    } catch (e) {
      console.log(`GitHub search error: ${e}`);
    }
  }

  return results;
}

// ============================================================
// HackerNews Search (Algolia API)
// ============================================================

async function searchHackerNews(): Promise<DiscussionItem[]> {
  const results: DiscussionItem[] = [];
  
  const queries = [
    'time series database',
    'tsdb',
    'influxdb',
  ];

  for (const query of queries) {
    try {
      const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=story&numericFilters=created_at_i>${getTimestampWeekAgo()}`;
      const resp = await fetch(url);

      if (!resp.ok) continue;

      const data = await resp.json();
      for (const item of data.hits || []) {
        const keywords = findMatchingKeywords(item.title + ' ' + (item.story_text || ''));
        if (keywords.length > 0) {
          results.push({
            id: `hn-${item.objectID}`,
            source: 'hackernews',
            title: item.title,
            url: `https://news.ycombinator.com/item?id=${item.objectID}`,
            createdAt: new Date(item.created_at_i * 1000).toISOString(),
            relevanceScore: keywords.length,
            keywords,
          });
        }
      }
    } catch (e) {
      console.log(`HN search error: ${e}`);
    }
  }

  return results;
}

// ============================================================
// Reddit Search (via JSON API)
// ============================================================

async function searchReddit(): Promise<DiscussionItem[]> {
  const results: DiscussionItem[] = [];
  
  const subreddits = ['database', 'typescript', 'node', 'iot'];
  const query = 'time series database';

  for (const subreddit of subreddits) {
    try {
      const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${encodeURIComponent(query)}&sort=new&t=week&limit=10`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'ndtsdb-monitor/1.0' },
      });

      if (!resp.ok) continue;

      const data = await resp.json();
      for (const child of data.data?.children || []) {
        const item = child.data;
        const keywords = findMatchingKeywords(item.title + ' ' + (item.selftext || ''));
        if (keywords.length > 0) {
          results.push({
            id: `reddit-${item.id}`,
            source: 'reddit',
            title: item.title,
            url: `https://reddit.com${item.permalink}`,
            createdAt: new Date(item.created_utc * 1000).toISOString(),
            relevanceScore: keywords.length,
            keywords,
          });
        }
      }
    } catch (e) {
      console.log(`Reddit search error: ${e}`);
    }
  }

  return results;
}

// ============================================================
// 工具函数
// ============================================================

function getDateWeekAgo(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().split('T')[0];
}

function getTimestampWeekAgo(): number {
  return Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
}

function findMatchingKeywords(text: string): string[] {
  const lowerText = text.toLowerCase();
  const matched: string[] = [];
  
  for (const kw of [...KEYWORDS.primary, ...KEYWORDS.secondary, ...KEYWORDS.competitors]) {
    if (lowerText.includes(kw.toLowerCase())) {
      matched.push(kw);
    }
  }
  
  return [...new Set(matched)];
}

function loadState(): MonitorState {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  }
  return { lastRun: '', processedIds: [] };
}

function saveState(state: MonitorState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// 主函数
// ============================================================

async function main() {
  console.log('🔍 ndtsdb Community Monitor\n');
  console.log('=' .repeat(60));

  const isDryRun = process.argv.includes('--dry-run');
  const state = loadState();
  
  console.log(`Last run: ${state.lastRun || 'never'}`);
  console.log(`Processed: ${state.processedIds.length} items\n`);

  // 并行搜索
  const [githubResults, hnResults, redditResults] = await Promise.all([
    searchGitHubDiscussions(),
    searchHackerNews(),
    searchReddit(),
  ]);

  const allResults = [...githubResults, ...hnResults, ...redditResults];
  
  // 过滤已处理的
  const newResults = allResults.filter(r => !state.processedIds.includes(r.id));
  
  // 按相关度排序
  newResults.sort((a, b) => b.relevanceScore - a.relevanceScore);

  console.log(`\n📊 Results:`);
  console.log(`  GitHub:     ${githubResults.length} items`);
  console.log(`  HackerNews: ${hnResults.length} items`);
  console.log(`  Reddit:     ${redditResults.length} items`);
  console.log(`  New:        ${newResults.length} items\n`);

  if (newResults.length > 0) {
    console.log('=' .repeat(60));
    console.log('🆕 New Discussions:\n');
    
    for (const item of newResults.slice(0, 10)) {
      console.log(`[${item.source.toUpperCase()}] ${item.title}`);
      console.log(`  URL: ${item.url}`);
      console.log(`  Keywords: ${item.keywords.join(', ')}`);
      console.log(`  Score: ${item.relevanceScore}`);
      console.log();
    }
  }

  // 保存结果
  if (!isDryRun) {
    state.lastRun = new Date().toISOString();
    state.processedIds = [...state.processedIds, ...newResults.map(r => r.id)].slice(-1000);
    saveState(state);
    
    writeFileSync(OUTPUT_FILE, JSON.stringify({
      timestamp: new Date().toISOString(),
      results: newResults,
    }, null, 2));
    
    console.log(`\n✅ State saved to ${STATE_FILE}`);
    console.log(`📄 Results saved to ${OUTPUT_FILE}`);
  } else {
    console.log('\n🔸 Dry run - state not saved');
  }

  // 返回高相关度的新讨论（供外部调用）
  return newResults.filter(r => r.relevanceScore >= 2);
}

main().catch(console.error);
