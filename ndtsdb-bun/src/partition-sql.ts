// ============================================================
// PartitionedTable 与 SQL 集成
// 从 SQL WHERE 条件中提取时间范围，优化分区扫描
// ============================================================

import { PartitionedTable } from './partition.js';
import { ColumnarTable } from './columnar.js';
import type { SQLWhereExpr, SQLCondition } from './sql/parser.js';

/**
 * 从 WHERE 表达式中提取时间范围
 */
export function extractTimeRange(
  whereExpr: SQLWhereExpr | undefined,
  timeColumn: string
): { min?: number | bigint; max?: number | bigint } | null {
  if (!whereExpr) return null;

  const range: { min?: number | bigint; max?: number | bigint } = {};

  const extract = (expr: SQLWhereExpr): void => {
    if (expr.type === 'pred') {
      if (expr.pred.column === timeColumn) {
        const value = expr.pred.value;
        const numValue = typeof value === 'bigint' ? value : (typeof value === 'number' ? value : Number(value));

        switch (expr.pred.operator) {
          case '>=':
          case '>':
            if (range.min === undefined || numValue > range.min) {
              range.min = expr.pred.operator === '>' ? numValue : numValue;
            }
            break;
          case '<=':
          case '<':
            if (range.max === undefined || numValue < range.max) {
              range.max = expr.pred.operator === '<' ? numValue : numValue;
            }
            break;
          case '=':
            range.min = numValue;
            range.max = numValue;
            break;
        }
      }
    } else if (expr.type === 'and') {
      extract(expr.left);
      extract(expr.right);
    }
    // OR / NOT 暂不处理（保守策略：全扫描）
  };

  extract(whereExpr);

  return Object.keys(range).length > 0 ? range : null;
}

/**
 * 从 legacy WHERE 条件中提取时间范围
 */
export function extractTimeRangeLegacy(
  whereConditions: SQLCondition[] | undefined,
  timeColumn: string
): { min?: number | bigint; max?: number | bigint } | null {
  if (!whereConditions || whereConditions.length === 0) return null;

  const range: { min?: number | bigint; max?: number | bigint } = {};

  for (const cond of whereConditions) {
    if (cond.column === timeColumn) {
      const value = cond.value;
      const numValue = typeof value === 'bigint' ? value : (typeof value === 'number' ? value : Number(value));

      switch (cond.operator) {
        case '>=':
        case '>':
          if (range.min === undefined || numValue > range.min) {
            range.min = numValue;
          }
          break;
        case '<=':
        case '<':
          if (range.max === undefined || numValue < range.max) {
            range.max = numValue;
          }
          break;
        case '=':
          range.min = numValue;
          range.max = numValue;
          break;
      }
    }
  }

  return Object.keys(range).length > 0 ? range : null;
}

/**
 * 查询 PartitionedTable 并转换为 ColumnarTable（用于 SQL 执行）
 * 
 * @param partitionedTable 分区表
 * @param whereExpr WHERE 表达式（可选，用于提取时间范围）
 * @param timeColumn 时间列名（默认 'timestamp'）
 * @returns ColumnarTable（内存表，可注册到 SQLExecutor）
 */
export function queryPartitionedTableToColumnar(
  partitionedTable: PartitionedTable,
  whereExpr?: SQLWhereExpr,
  timeColumn: string = 'timestamp'
): ColumnarTable {
  // 提取时间范围
  const timeRange = extractTimeRange(whereExpr, timeColumn);

  // 查询分区表
  const rows = partitionedTable.query(undefined, timeRange ?? undefined);

  // 转换为 ColumnarTable
  if (rows.length === 0) {
    // 空表：从分区表的列定义推断
    const partitions = partitionedTable.getPartitions();
    if (partitions.length === 0) {
      throw new Error('PartitionedTable is empty, cannot infer schema');
    }
    // TODO: 从分区表获取列定义（暂时返回空表）
    throw new Error('Empty result from PartitionedTable (schema inference not implemented)');
  }

  // 从第一行推断列定义
  const firstRow = rows[0];
  const columns: Array<{ name: string; type: string }> = [];
  for (const [name, value] of Object.entries(firstRow)) {
    let type: string;
    if (typeof value === 'bigint') type = 'int64';
    else if (typeof value === 'number') type = 'float64';
    else if (typeof value === 'string') type = 'string';
    else type = 'int32'; // fallback
    columns.push({ name, type });
  }

  const table = new ColumnarTable(columns);
  table.appendBatch(rows as any);
  return table;
}
