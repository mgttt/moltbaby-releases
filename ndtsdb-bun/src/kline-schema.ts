/**
 * kline-schema.ts — 共享 K线列定义，确保所有组件使用一致的 10 列结构
 *
 * 使用场景：
 * - ndtsdb-provider.ts (quant-lib)
 * - BarCacheLayer.ts (quant-lab)
 * - 任何需要写入/读取 K线数据的地方
 *
 * 注意：修改此文件会影响存储格式，需要同步更新 C 库和 FFI 层
 */

export interface ColumnDef {
  name: string;
  type: 'int64' | 'float64' | 'int32' | 'string';
}

/** 标准 K线 10 列定义 —— 与 ndtsdb-provider 和 BarCacheLayer 对齐 */
export const KLINE_COLUMNS: ColumnDef[] = [
  { name: 'timestamp',           type: 'int64'  },
  { name: 'open',                type: 'float64' },
  { name: 'high',                type: 'float64' },
  { name: 'low',                 type: 'float64' },
  { name: 'close',               type: 'float64' },
  { name: 'volume',              type: 'float64' },
  { name: 'quoteVolume',         type: 'float64' },
  { name: 'trades',              type: 'int32'   },
  { name: 'takerBuyVolume',      type: 'float64' },
  { name: 'takerBuyQuoteVolume', type: 'float64' },
] as const;

/** 列名数组（用于快速校验） */
export const KLINE_COLUMN_NAMES = KLINE_COLUMNS.map(c => c.name);

/** 校验行数据是否包含所有必需的列 */
export function validateKlineRow(row: Record<string, any>): string[] {
  const missing: string[] = [];
  for (const col of KLINE_COLUMNS) {
    if (!(col.name in row)) {
      missing.push(col.name);
    }
  }
  return missing;
}

/** 创建完整的 K线行对象（填充默认值） */
export function createKlineRow(partial: Partial<Record<string, any>>): Record<string, any> {
  return {
    timestamp:           partial.timestamp ?? 0n,
    open:                partial.open ?? 0,
    high:                partial.high ?? 0,
    low:                 partial.low ?? 0,
    close:               partial.close ?? 0,
    volume:              partial.volume ?? 0,
    quoteVolume:         partial.quoteVolume ?? 0,
    trades:              partial.trades ?? 0,
    takerBuyVolume:      partial.takerBuyVolume ?? 0,
    takerBuyQuoteVolume: partial.takerBuyQuoteVolume ?? 0,
    flags:               partial.flags ?? 0,
  };
}
