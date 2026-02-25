#!/usr/bin/env bun
/**
 * ndtsdb 数据完整性检查工具
 * 
 * 用法: bun ndtsdb-cli/scripts/data-integrity-check.js --db <path> --symbol <symbol>
 * 
 * 检查项:
 * 1. 时间序列连续性（无缺失/乱序）
 * 2. OHLCV 逻辑合法性
 * 3. 无重复时间戳
 * 
 * 输出: JSON报告到 stdout
 * 退出码: 0=通过, 1=有异常
 */

import { spawn } from 'child_process';
import { parseArgs } from 'util';

// ============= CLI 参数解析 =============
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    db: { type: 'string', short: 'd' },
    symbol: { type: 'string', short: 's', default: 'BTCUSDT' },
    interval: { type: 'string', short: 'i', default: '1h' },
  },
  strict: true,
  allowPositionals: false,
});

if (!values.db) {
  console.error('Usage: bun data-integrity-check.js --db <path> [--symbol <symbol>] [--interval <interval>]');
  process.exit(1);
}

const dbPath = values.db;
const symbol = values.symbol;
const interval = values.interval;

// ============= 执行 SQL 查询 =============
async function runSqlQuery(query) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      './zig-out/bin/ndtsdb-cli',
      ['sql', '--database', dbPath, '--query', query, '--format', 'json'],
      { cwd: '/home/devali/moltbaby/ndtsdb-cli' }
    );

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data; });
    proc.stderr.on('data', (data) => { stderr += data; });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`SQL query failed: ${stderr}`));
      } else {
        try {
          // Parse JSON Lines format (one JSON object per line)
          const lines = stdout.trim().split('\n').filter(line => line.trim());
          const results = lines.map(line => JSON.parse(line));
          resolve(results);
        } catch (e) {
          reject(new Error(`Failed to parse JSON: ${e.message}`));
        }
      }
    });
  });
}

// ============= 检查逻辑 =============
async function runIntegrityCheck() {
  const report = {
    database: dbPath,
    symbol: symbol,
    interval: interval,
    timestamp: new Date().toISOString(),
    total_rows: 0,
    errors_count: 0,
    error_details: [],
  };

  try {
    // 1. 获取总行数
    const countResult = await runSqlQuery(`SELECT COUNT(*) as count FROM ${symbol} WHERE interval = '${interval}'`);
    report.total_rows = countResult[0]?.count || 0;

    if (report.total_rows === 0) {
      report.error_details.push({
        type: 'WARNING',
        message: `No data found for ${symbol} ${interval}`,
      });
      return report;
    }

    // 2. 获取所有数据进行检查
    const rows = await runSqlQuery(
      `SELECT timestamp, open, high, low, close, volume FROM ${symbol} ` +
      `WHERE interval = '${interval}' ORDER BY timestamp ASC`
    );

    // 3. 检查重复时间戳
    const timestamps = rows.map(r => r.timestamp);
    const uniqueTimestamps = new Set(timestamps);
    if (uniqueTimestamps.size !== timestamps.length) {
      const seen = new Set();
      const duplicates = [];
      for (const ts of timestamps) {
        if (seen.has(ts)) {
          duplicates.push(ts);
        }
        seen.add(ts);
      }
      report.errors_count++;
      report.error_details.push({
        type: 'DUPLICATE_TIMESTAMP',
        message: `Found ${duplicates.length} duplicate timestamps`,
        samples: duplicates.slice(0, 5),
      });
    }

    // 4. 检查乱序（理论上按timestamp排序后不会有乱序，但双重检查）
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].timestamp <= rows[i - 1].timestamp) {
        report.errors_count++;
        report.error_details.push({
          type: 'OUT_OF_ORDER',
          message: `Row ${i} timestamp ${rows[i].timestamp} <= previous ${rows[i - 1].timestamp}`,
          index: i,
          current: rows[i].timestamp,
          previous: rows[i - 1].timestamp,
        });
        break; // 只报告第一个
      }
    }

    // 5. 检查时间连续性（假设固定间隔）
    if (rows.length >= 2) {
      const expectedInterval = rows[1].timestamp - rows[0].timestamp;
      const gaps = [];
      for (let i = 1; i < rows.length; i++) {
        const actualInterval = rows[i].timestamp - rows[i - 1].timestamp;
        if (actualInterval !== expectedInterval) {
          gaps.push({
            index: i,
            from: rows[i - 1].timestamp,
            to: rows[i].timestamp,
            expected: expectedInterval,
            actual: actualInterval,
          });
        }
      }
      if (gaps.length > 0) {
        report.errors_count++;
        report.error_details.push({
          type: 'DISCONTINUITY',
          message: `Found ${gaps.length} gaps in time series (expected interval: ${expectedInterval}ms)`,
          samples: gaps.slice(0, 5),
        });
      }
    }

    // 6. OHLCV 逻辑检查
    const ohlcvErrors = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      
      // 6.1 high >= max(open, close, low)
      // 6.2 low <= min(open, close, high)
      // 6.3 high >= low
      
      const maxPrice = Math.max(row.open, row.close, row.low);
      const minPrice = Math.min(row.open, row.close, row.high);
      
      if (row.high < maxPrice) {
        ohlcvErrors.push({
          index: i,
          timestamp: row.timestamp,
          field: 'high',
          issue: 'high < max(open, close, low)',
          values: { high: row.high, open: row.open, close: row.close, low: row.low },
        });
      }
      
      if (row.low > minPrice) {
        ohlcvErrors.push({
          index: i,
          timestamp: row.timestamp,
          field: 'low',
          issue: 'low > min(open, close, high)',
          values: { low: row.low, open: row.open, close: row.close, high: row.high },
        });
      }
      
      if (row.high < row.low) {
        ohlcvErrors.push({
          index: i,
          timestamp: row.timestamp,
          field: 'high/low',
          issue: 'high < low',
          values: { high: row.high, low: row.low },
        });
      }
      
      // 6.4 volume >= 0
      if (row.volume < 0) {
        ohlcvErrors.push({
          index: i,
          timestamp: row.timestamp,
          field: 'volume',
          issue: 'volume < 0',
          value: row.volume,
        });
      }
      
      // 6.5 价格 > 0
      if (row.open <= 0 || row.high <= 0 || row.low <= 0 || row.close <= 0) {
        ohlcvErrors.push({
          index: i,
          timestamp: row.timestamp,
          field: 'price',
          issue: 'non-positive price',
          values: { open: row.open, high: row.high, low: row.low, close: row.close },
        });
      }
    }

    if (ohlcvErrors.length > 0) {
      report.errors_count++;
      report.error_details.push({
        type: 'OHLCV_VIOLATION',
        message: `Found ${ohlcvErrors.length} OHLCV logic violations`,
        samples: ohlcvErrors.slice(0, 5),
      });
    }

  } catch (error) {
    report.errors_count++;
    report.error_details.push({
      type: 'ERROR',
      message: error.message,
    });
  }

  return report;
}

// ============= 主程序 =============
const report = await runIntegrityCheck();

// 输出 JSON 报告
console.log(JSON.stringify(report, null, 2));

// 设置退出码
process.exit(report.errors_count === 0 ? 0 : 1);
