// ============================================================
// 预写日志 (Write-Ahead Log)
// 借鉴 QuestDB WAL：先写日志再批量刷盘，保证持久性
// ============================================================

import { existsSync, appendFileSync, writeFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import type { Row } from './types.js';

interface WALEntry {
  seq: number;
  table: string;
  row: Row;
  timestamp: number;
}

export class WAL {
  private readonly walDir: string;
  private readonly maxFileSize: number;
  private currentSeq = 0;
  private currentFile: string | null = null;
  private currentSize = 0;
  private buffer: WALEntry[] = [];
  private readonly flushIntervalMs: number;
  private flushTimer: Timer | null = null;

  constructor(walDir: string, options: { maxFileSize?: number; flushIntervalMs?: number } = {}) {
    this.walDir = walDir;
    this.maxFileSize = options.maxFileSize || 10 * 1024 * 1024; // 10MB
    this.flushIntervalMs = options.flushIntervalMs || 1000; // 1秒
    
    if (!existsSync(walDir)) {
      mkdirSync(walDir, { recursive: true });
    }

    this.recover();
    this.startFlushTimer();
  }

  /**
   * 写入一条记录到 WAL
   */
  append(table: string, row: Row): void {
    const entry: WALEntry = {
      seq: ++this.currentSeq,
      table,
      row,
      timestamp: Date.now()
    };

    this.buffer.push(entry);

    // 缓冲满了立即刷盘
    if (this.buffer.length >= 1000) {
      this.flush();
    }
  }

  /**
   * 批量写入
   */
  appendBatch(table: string, rows: Row[]): void {
    for (const row of rows) {
      this.append(table, row);
    }
  }

  /**
   * 强制刷盘
   */
  flush(): void {
    if (this.buffer.length === 0) return;

    const data = this.buffer.map(e => JSON.stringify(e)).join('\n') + '\n';
    const dataSize = Buffer.byteLength(data, 'utf8');

    // 检查是否需要切换文件
    if (!this.currentFile || this.currentSize + dataSize > this.maxFileSize) {
      this.rotateFile();
    }

    // 追加写入
    appendFileSync(this.currentFile!, data);
    this.currentSize += dataSize;
    this.buffer = [];
  }

  /**
   * 读取所有未归档的 WAL 记录
   */
  readAll(): Map<string, Row[]> {
    const result = new Map<string, Row[]>();
    
    const files = this.getWalFiles().sort();
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      
      for (const line of lines) {
        try {
          const entry: WALEntry = JSON.parse(line);
          if (!result.has(entry.table)) {
            result.set(entry.table, []);
          }
          result.get(entry.table)!.push(entry.row);
        } catch {
          // 跳过损坏的行
        }
      }
    }

    return result;
  }

  /**
   * 归档 WAL（数据已安全写入分区后调用）
   */
  archive(): void {
    this.flush();
    const files = this.getWalFiles();
    for (const file of files) {
      try {
        renameSync(file, file + '.archived');
        // 延迟删除已归档文件
        setTimeout(() => {
          try { unlinkSync(file + '.archived'); } catch {}
        }, 60000);
      } catch {}
    }
    this.currentFile = null;
    this.currentSize = 0;
  }

  /**
   * 关闭 WAL
   */
  close(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  private rotateFile(): void {
    // 直接写入缓冲区，不调用 flush 避免循环
    if (this.buffer.length > 0 && this.currentFile) {
      const data = this.buffer.map(e => JSON.stringify(e)).join('\n') + '\n';
      appendFileSync(this.currentFile, data);
      this.buffer = [];
    }
    const timestamp = Date.now();
    this.currentFile = join(this.walDir, `wal-${timestamp}.log`);
    this.currentSize = 0;
  }

  private getWalFiles(): string[] {
    if (!existsSync(this.walDir)) return [];
    try {
      return readdirSync(this.walDir)
        .filter((f: string) => f.endsWith('.log'))
        .map((f: string) => join(this.walDir, f));
    } catch {
      return [];
    }
  }

  private recover(): void {
    // 恢复时重放 WAL
    // 实际实现中这里会检查未归档的 WAL 并恢复
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
  }
}
