/**
 * SQL 聚合函数测试
 */

import { describe, it, expect } from 'bun:test';
import { ColumnarTable } from '../src/columnar';
import { SQLParser } from '../src/sql/parser';
import { SQLExecutor } from '../src/sql/executor';

describe('SQL Aggregation Functions', () => {
  const table = new ColumnarTable([
    { name: 'symbol', type: 'string' },
    { name: 'timestamp', type: 'int64' },
    { name: 'close', type: 'float64' },
    { name: 'volume', type: 'float64' },
  ]);

  // 添加测试数据：10 行
  const rows = [];
  for (let i = 0; i < 10; i++) {
    rows.push({
      symbol: i < 5 ? 'BTC' : 'ETH',
      timestamp: BigInt(1000 + i),
      close: 100 + i * 10,
      volume: 1000 + i * 100,
    });
  }
  table.appendBatch(rows);

  const parser = new SQLParser();
  const executor = new SQLExecutor();
  executor.registerTable('ticks', table);

  it('should support COUNT(*)', () => {
    const sql = 'SELECT COUNT(*) as cnt FROM ticks';
    const parsed = parser.parse(sql);
    const result = executor.execute(parsed);

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].cnt).toBe(10);
  });

  it('should support SUM(volume)', () => {
    const sql = 'SELECT SUM(volume) as total_volume FROM ticks';
    const parsed = parser.parse(sql);
    const result = executor.execute(parsed);

    console.log('SUM(volume) result:', result.rows);
    expect(result.rows.length).toBe(1);
    
    // 1000 + 1100 + 1200 + ... + 1900 = 10*1000 + (0+1+2+...+9)*100 = 10000 + 45*100 = 14500
    expect(result.rows[0].total_volume).toBe(14500);
  });

  it('should support AVG(close)', () => {
    const sql = 'SELECT AVG(close) as avg_close FROM ticks';
    const parsed = parser.parse(sql);
    const result = executor.execute(parsed);

    console.log('AVG(close) result:', result.rows);
    expect(result.rows.length).toBe(1);
    
    // 100 + 110 + 120 + ... + 190 = 10*100 + (0+10+20+...+90) = 1000 + 450 = 1450
    // avg = 1450 / 10 = 145
    expect(result.rows[0].avg_close).toBe(145);
  });

  it('should support GROUP BY with AVG', () => {
    const sql = 'SELECT symbol, AVG(close) as avg_close FROM ticks GROUP BY symbol';
    const parsed = parser.parse(sql);
    const result = executor.execute(parsed);

    console.log('GROUP BY AVG result:', result.rows);
    expect(result.rows.length).toBe(2);

    // BTC: rows 0-4 (close: 100, 110, 120, 130, 140) avg = 120
    // ETH: rows 5-9 (close: 150, 160, 170, 180, 190) avg = 170
    const btc = result.rows.find((r: any) => r.symbol === 'BTC');
    const eth = result.rows.find((r: any) => r.symbol === 'ETH');

    expect(btc?.avg_close).toBe(120);
    expect(eth?.avg_close).toBe(170);
  });
});
